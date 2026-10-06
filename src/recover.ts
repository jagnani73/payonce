import { getAvailableMinor } from "./airwallex/balances.js";
import {
  findOrCreateDemoBeneficiary,
  type Beneficiary,
} from "./airwallex/beneficiaries.js";
import { AirwallexClient } from "./airwallex/client.js";
import { simulateTransfer } from "./airwallex/simulation.js";
import {
  getTransfer,
  waitForTransfer,
  type Transfer,
} from "./airwallex/transfers.js";
import {
  bindingOf,
  changedFields,
  termsFor,
  type ApprovalTerms,
} from "./approval.js";
import { originalStateOf, resendCanFix } from "./assess.js";
import { decide } from "./decide.js";
import type { Decision, Incident } from "./incident.js";
import {
  DuplicatePaymentError,
  Ledger,
  LEDGER_PATH,
  type Approval,
  type Attempt,
  type AttemptKind,
  type Obligation,
} from "./ledger.js";
import { toMajor, toMinor } from "./money.js";
import { sendAttempt, syncTransfer } from "./payments.js";

const SUPPLIER: string = "Example Supplier LLC";
const CURRENCY: string = "USD";
const AMOUNT_MINOR: number = 400_000;
const RESERVE_FLOOR_MINOR: number = 100_000_000;
const DEFAULT_FAILURE_TYPE: string = "CHANNEL_TIMEOUT";

interface Assessment {
  original: Transfer;
  decision: Decision;
}

function log(message: string): void {
  console.log(message);
}

function newInvoiceId(): string {
  return `INV-${Date.now().toString().slice(-6)}`;
}

function describe(transfer: Transfer): string {
  const failure: string =
    transfer.failure?.code === undefined
      ? ""
      : `, ${transfer.failure.code} ${transfer.failure.message ?? ""}`.trimEnd();
  return `${transfer.short_reference_id} ${transfer.status}${failure}`;
}

async function assess(
  client: AirwallexClient,
  obligation: Obligation,
  originalId: string,
): Promise<Assessment> {
  const original: Transfer = await getTransfer(client, originalId);
  const incident: Incident = {
    invoiceId: obligation.invoiceId,
    supplier: obligation.supplier,
    currency: obligation.currency,
    amountMinor: obligation.amountMinor,
    transferFeeMinor: toMinor(original.fee_amount),
    originalState: originalStateOf(original),
    resendCanFix: resendCanFix(original),
    supplierAsksForNewBankDetails: false,
    evidenceConflicts: false,
    availableBalanceMinor: await getAvailableMinor(client, obligation.currency),
    reserveFloorMinor: RESERVE_FLOOR_MINOR,
  };
  const decision: Decision = decide(incident);
  log(`  original ${describe(original)}`);
  log(`  decision: ${decision.action} (${decision.reason})`);
  return { original, decision };
}

// Opening the attempt takes the duplicate lock, so this throws if the invoice
// already has a live payment.
async function pay(
  client: AirwallexClient,
  ledger: Ledger,
  obligation: Obligation,
  kind: AttemptKind,
): Promise<Transfer> {
  const attempt: Attempt = ledger.openAttempt(obligation.invoiceId, kind);
  const created: Transfer = await sendAttempt(client, ledger, obligation, attempt);
  // The simulator rejects a transition until the transfer has left SCHEDULED.
  await waitForTransfer(
    client,
    created.id,
    (transfer: Transfer): boolean => transfer.status !== "SCHEDULED",
  );
  await simulateTransfer(client, created.id, "SENT");
  return syncTransfer(client, ledger, created.id);
}

async function replaceAndSettle(
  client: AirwallexClient,
  ledger: Ledger,
  obligation: Obligation,
  originalId: string,
): Promise<void> {
  const replacement: Transfer = await pay(client, ledger, obligation, "replacement");
  await simulateTransfer(client, replacement.id, "PAID");
  log(`  original ${describe(await syncTransfer(client, ledger, originalId))}`);
  log(`  replacement ${describe(await syncTransfer(client, ledger, replacement.id))}`);
  log(`  incident ${ledger.settle(obligation.invoiceId) ? "closed" : "still open"}`);
  log(
    `  available ${toMajor(await getAvailableMinor(client, obligation.currency))} ${obligation.currency}`,
  );
}

// A replacement is only on offer when the original has failed. Any other
// escalation has no payment a person could approve yet.
function escalate(
  ledger: Ledger,
  obligation: Obligation,
  assessment: Assessment,
): void {
  ledger.escalate(obligation.invoiceId);
  if (originalStateOf(assessment.original) !== "failed") {
    log(`  ${obligation.invoiceId} is waiting on a person`);
    return;
  }

  const terms: ApprovalTerms = termsFor(
    obligation,
    assessment.original,
    assessment.decision,
  );
  const binding: string = bindingOf(terms);
  const latest: Approval | undefined = ledger.latestApproval(obligation.invoiceId);
  if (latest?.state !== "requested" || latest.binding !== binding) {
    ledger.requestApproval(obligation.invoiceId, binding, JSON.stringify(terms));
  }
  log(`  ${obligation.invoiceId} is waiting on a person. To approve a replacement:`);
  log(`  pnpm approve ${obligation.invoiceId} <name>`);
}

async function continueEscalated(
  client: AirwallexClient,
  ledger: Ledger,
  obligation: Obligation,
  originalId: string,
): Promise<void> {
  const assessment: Assessment = await assess(client, obligation, originalId);
  if (assessment.decision.action === "replace") {
    log("  the policy now allows a replacement");
    await replaceAndSettle(client, ledger, obligation, originalId);
    return;
  }

  const approval: Approval | undefined = ledger.latestApproval(obligation.invoiceId);
  if (approval?.state !== "approved") {
    escalate(ledger, obligation, assessment);
    return;
  }

  const current: ApprovalTerms = termsFor(
    obligation,
    assessment.original,
    assessment.decision,
  );
  if (bindingOf(current) !== approval.binding) {
    const approved: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
    ledger.setApprovalState(approval.id, "void");
    log(
      `  approval by ${approval.approver} is void: ${changedFields(approved, current).join(", ")} changed`,
    );
    escalate(ledger, obligation, assessment);
    return;
  }

  // One approval covers one attempt, so it is spent before the payment is tried.
  ledger.setApprovalState(approval.id, "used");
  log(`  approved by ${approval.approver}, terms unchanged. Sending the replacement`);
  await replaceAndSettle(client, ledger, obligation, originalId);
}

// A second run for the same invoice never pays on its own. It retries an attempt
// that has no transfer yet under its original request_id, reports what exists,
// and acts on an escalated invoice only when a matching approval is on file.
async function resume(
  client: AirwallexClient,
  ledger: Ledger,
  obligation: Obligation,
): Promise<void> {
  log(`${obligation.invoiceId} is already in the ledger`);
  let originalId: string | null = null;
  const lines: string[] = [];
  for (const attempt of ledger.attempts(obligation.invoiceId)) {
    const transfer: Transfer =
      attempt.transferId === null
        ? await sendAttempt(client, ledger, obligation, attempt)
        : await syncTransfer(client, ledger, attempt.transferId);
    if (attempt.kind === "original") {
      originalId = transfer.id;
    }
    lines.push(`  ${attempt.kind} ${describe(transfer)}`);
  }

  if (ledger.settle(obligation.invoiceId)) {
    lines.forEach(log);
    log("  incident closed. No new payment sent");
    return;
  }
  if (obligation.state === "escalated" && originalId !== null) {
    await continueEscalated(client, ledger, obligation, originalId);
    return;
  }
  lines.forEach(log);
  log("  incident still open. No new payment sent");
}

async function main(): Promise<void> {
  const failureType: string = process.argv[2] ?? DEFAULT_FAILURE_TYPE;
  const invoiceId: string = process.argv[3] ?? newInvoiceId();
  const client: AirwallexClient = AirwallexClient.fromEnv();
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  const beneficiary: Beneficiary = await findOrCreateDemoBeneficiary(client);
  const obligation: Obligation = ledger.openObligation({
    invoiceId,
    supplier: SUPPLIER,
    beneficiaryId: beneficiary.id,
    currency: CURRENCY,
    amountMinor: AMOUNT_MINOR,
  });

  if (ledger.attempts(invoiceId).length > 0) {
    await resume(client, ledger, obligation);
    return;
  }

  log(`1. Pay ${invoiceId}: ${toMajor(AMOUNT_MINOR)} ${CURRENCY} to ${SUPPLIER}`);
  const original: Transfer = await pay(client, ledger, obligation, "original");

  log("2. Supplier reports nothing arrived");
  await assess(client, obligation, original.id);

  log(`3. Bank outcome arrives: ${failureType}`);
  await simulateTransfer(client, original.id, "FAILED", failureType);
  await syncTransfer(client, ledger, original.id);
  const assessment: Assessment = await assess(client, obligation, original.id);

  if (assessment.decision.action !== "replace") {
    log("4. No replacement sent");
    escalate(ledger, obligation, assessment);
    return;
  }

  log("4. Send the replacement under a new request_id");
  await replaceAndSettle(client, ledger, obligation, original.id);

  log("5. Try to pay the same invoice again");
  try {
    ledger.openAttempt(invoiceId, "replacement");
    log("  a second payment was allowed");
  } catch (error: unknown) {
    if (!(error instanceof DuplicatePaymentError)) {
      throw error;
    }
    log(`  refused: ${error.message}`);
  }
}

await main();

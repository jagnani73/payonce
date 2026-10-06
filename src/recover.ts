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
import { originalStateOf, resendCanFix } from "./assess.js";
import { decide } from "./decide.js";
import type { Decision, Incident } from "./incident.js";
import {
  DuplicatePaymentError,
  Ledger,
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
const LEDGER_PATH: string = "payonce.db";

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
): Promise<Decision> {
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
  return decision;
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

// A second run for the same invoice never pays again. It retries an attempt that
// has no transfer yet under its original request_id, then reports what exists.
async function resume(
  client: AirwallexClient,
  ledger: Ledger,
  obligation: Obligation,
): Promise<void> {
  log(`${obligation.invoiceId} is already in the ledger. No new payment sent`);
  for (const attempt of ledger.attempts(obligation.invoiceId)) {
    const transfer: Transfer =
      attempt.transferId === null
        ? await sendAttempt(client, ledger, obligation, attempt)
        : await syncTransfer(client, ledger, attempt.transferId);
    log(`  ${attempt.kind} ${describe(transfer)}`);
  }
  if (ledger.settle(obligation.invoiceId)) {
    log("  incident closed");
    return;
  }
  log(`  incident ${obligation.state === "escalated" ? "waiting on a person" : "still open"}`);
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
  const decision: Decision = await assess(client, obligation, original.id);

  if (decision.action !== "replace") {
    ledger.escalate(invoiceId);
    log(`4. No replacement sent. ${invoiceId} is waiting on a person`);
    return;
  }

  log("4. Send the replacement under a new request_id");
  const replacement: Transfer = await pay(client, ledger, obligation, "replacement");
  await simulateTransfer(client, replacement.id, "PAID");

  log("5. Outcome");
  log(`  original ${describe(await syncTransfer(client, ledger, original.id))}`);
  log(`  replacement ${describe(await syncTransfer(client, ledger, replacement.id))}`);
  log(`  incident ${ledger.settle(invoiceId) ? "closed" : "still open"}`);
  log(
    `  available ${toMajor(await getAvailableMinor(client, CURRENCY))} ${CURRENCY}`,
  );

  log("6. Try to pay the same invoice again");
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

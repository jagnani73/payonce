import { getAvailableMinor } from "./airwallex/balances.js";
import {
  DE_SWIFT_SUPPLIER,
  US_LOCAL_SUPPLIER,
  findOrCreateBeneficiary,
  type Beneficiary,
  type BeneficiarySpec,
} from "./airwallex/beneficiaries.js";
import type { AirwallexClient } from "./airwallex/client.js";
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
import {
  loadEmails,
  unverifiedSenders,
  type EmailFindings,
  type EmailReader,
  type SupplierEmail,
} from "./emails.js";
import type { Decision, Incident } from "./incident.js";
import {
  DuplicatePaymentError,
  type Approval,
  type Attempt,
  type AttemptKind,
  type EventKind,
  type Ledger,
  type LedgerEvent,
  type Obligation,
  type TransferMethod,
} from "./ledger.js";
import { formatMoney, toMinor } from "./money.js";
import { sendAttempt, syncTransfer } from "./payments.js";

const AMPLE_RESERVE_MINOR: number = 100_000_000;
const SUPPLIER_DOMAIN: string = "example-supplier.test";

export interface ScenarioDef {
  id: string;
  label: string;
  supplier: string;
  beneficiary: BeneficiarySpec;
  currency: string;
  amountMinor: number;
  transferMethod: TransferMethod;
  // The transfer fee the scenario expects. When set, the reserve floor is placed
  // so that one payment fits and a second fee is what breaches it.
  tightReserveFeeMinor: number | null;
}

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "usd-local",
    label: "USD, local transfer",
    supplier: "Example Supplier LLC",
    beneficiary: US_LOCAL_SUPPLIER,
    currency: "USD",
    amountMinor: 400_000,
    transferMethod: "LOCAL",
    tightReserveFeeMinor: null,
  },
  {
    id: "eur-swift",
    label: "EUR, SWIFT transfer",
    supplier: "Example Supplier GmbH",
    beneficiary: DE_SWIFT_SUPPLIER,
    currency: "EUR",
    amountMinor: 400_000,
    transferMethod: "SWIFT",
    tightReserveFeeMinor: null,
  },
  {
    id: "eur-swift-low-reserve",
    label: "EUR, SWIFT transfer, cash near the reserve floor",
    supplier: "Example Supplier GmbH",
    beneficiary: DE_SWIFT_SUPPLIER,
    currency: "EUR",
    amountMinor: 400_000,
    transferMethod: "SWIFT",
    tightReserveFeeMinor: 1_391,
  },
];

export const DEFAULT_SCENARIO: string = "usd-local";

// What the reader found, plus the sender check done in code.
interface StoredFindings extends EmailFindings {
  unverifiedSenders?: string[];
}

const NO_FINDINGS: StoredFindings = {
  claimsNonReceipt: false,
  asksForNewBankDetails: false,
  summary: "no emails on file",
  unverifiedSenders: [],
};

export interface Engine {
  client: AirwallexClient;
  ledger: Ledger;
  reader: EmailReader;
}

export interface Scenario {
  failureType: string;
  emailsName: string;
}

interface Assessment {
  original: Transfer;
  findings: StoredFindings;
  decision: Decision;
}

export function newInvoiceId(): string {
  return `INV-${Date.now().toString().slice(-6)}`;
}

// Adds a line to the incident's timeline and prints it. A line identical to the
// previous one is skipped, so running an invoice again does not repeat itself.
function note(
  ledger: Ledger,
  invoiceId: string,
  kind: EventKind,
  message: string,
): void {
  const last: LedgerEvent | undefined = ledger.events(invoiceId).at(-1);
  if (last?.kind === kind && last.message === message) {
    return;
  }
  ledger.addEvent(invoiceId, kind, message);
  console.log(`  ${kind.padEnd(8)} ${message}`);
}

function describe(transfer: Transfer): string {
  const failure: string =
    transfer.failure?.code === undefined
      ? ""
      : `, ${transfer.failure.code} ${transfer.failure.message ?? ""}`.trimEnd();
  return `${transfer.short_reference_id} ${transfer.status}${failure}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function money(obligation: Obligation): string {
  return formatMoney(obligation.amountMinor, obligation.currency);
}

// Stores new supplier emails, checks their senders against the domain on file,
// then reads the whole thread once and keeps the findings so later runs see the
// same result.
async function receive(
  engine: Engine,
  obligation: Obligation,
  emails: SupplierEmail[],
): Promise<void> {
  if (emails.length === 0) {
    return;
  }
  const invoiceId: string = obligation.invoiceId;
  engine.ledger.addEmails(invoiceId, emails);
  for (const email of emails) {
    note(engine.ledger, invoiceId, "email", `Email from ${email.from}: ${email.subject}`);
  }
  for (const sender of unverifiedSenders(emails, obligation.supplierDomain)) {
    note(
      engine.ledger,
      invoiceId,
      "warning",
      `Sender ${sender} does not match the supplier's domain on file (${obligation.supplierDomain})`,
    );
  }

  const thread: SupplierEmail[] = engine.ledger.emails(invoiceId);
  const findings: StoredFindings = {
    ...(await engine.reader.read(thread)),
    unverifiedSenders: unverifiedSenders(thread, obligation.supplierDomain),
  };
  engine.ledger.saveFindings(invoiceId, JSON.stringify(findings));
  note(engine.ledger, invoiceId, "email", `Emails read: ${findings.summary}`);
}

function findingsFor(ledger: Ledger, invoiceId: string): StoredFindings {
  const stored: string | undefined = ledger.findings(invoiceId);
  return stored === undefined ? NO_FINDINGS : (JSON.parse(stored) as StoredFindings);
}

// The email evidence a person sees and approves against.
function evidenceSummary(findings: StoredFindings): string {
  const senders: string[] = findings.unverifiedSenders ?? [];
  return senders.length === 0
    ? findings.summary
    : `${findings.summary}, sender ${senders.join(", ")} does not match the supplier on file`;
}

async function assess(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<Assessment> {
  const original: Transfer = await getTransfer(engine.client, originalId);
  const findings: StoredFindings = findingsFor(engine.ledger, obligation.invoiceId);
  const feeMinor: number = toMinor(original.fee_amount);
  const availableMinor: number = await getAvailableMinor(
    engine.client,
    obligation.currency,
  );
  const incident: Incident = {
    invoiceId: obligation.invoiceId,
    supplier: obligation.supplier,
    currency: obligation.currency,
    amountMinor: obligation.amountMinor,
    transferFeeMinor: feeMinor,
    originalState: originalStateOf(original),
    resendCanFix: resendCanFix(original),
    supplierAsksForNewBankDetails: findings.asksForNewBankDetails,
    emailFromUnverifiedSender: (findings.unverifiedSenders ?? []).length > 0,
    evidenceConflicts: false,
    availableBalanceMinor: availableMinor,
    reserveFloorMinor: obligation.reserveFloorMinor,
  };

  // A failed transfer keeps its fee, so a replacement pays the fee a second time.
  if (incident.originalState === "failed" && feeMinor > 0) {
    const costMinor: number = obligation.amountMinor + feeMinor;
    const afterMinor: number = availableMinor - costMinor;
    const currency: string = obligation.currency;
    note(
      engine.ledger,
      obligation.invoiceId,
      afterMinor < obligation.reserveFloorMinor ? "warning" : "payment",
      `A replacement costs ${formatMoney(costMinor, currency)} with a second ${formatMoney(feeMinor, currency)} transfer fee. Cash after it: ${formatMoney(afterMinor, currency)}, reserve floor ${formatMoney(obligation.reserveFloorMinor, currency)}`,
    );
  }

  const decision: Decision = decide(incident);
  note(
    engine.ledger,
    obligation.invoiceId,
    "decision",
    `${capitalise(decision.action)}: ${decision.reason}`,
  );
  return { original, findings, decision };
}

// Opening the attempt takes the duplicate lock, so this throws if the invoice
// already has a live payment.
async function pay(
  engine: Engine,
  obligation: Obligation,
  kind: AttemptKind,
): Promise<Transfer> {
  const attempt: Attempt = engine.ledger.openAttempt(obligation.invoiceId, kind);
  const created: Transfer = await sendAttempt(
    engine.client,
    engine.ledger,
    obligation,
    attempt,
  );
  // The simulator rejects a transition until the transfer has left SCHEDULED.
  await waitForTransfer(
    engine.client,
    created.id,
    (transfer: Transfer): boolean => transfer.status !== "SCHEDULED",
  );
  await simulateTransfer(engine.client, created.id, "SENT");
  const sent: Transfer = await syncTransfer(engine.client, engine.ledger, created.id);
  const fee: string =
    sent.fee_amount > 0
      ? `, plus a ${formatMoney(toMinor(sent.fee_amount), obligation.currency)} transfer fee`
      : "";
  note(
    engine.ledger,
    obligation.invoiceId,
    "payment",
    `${capitalise(kind)} ${sent.short_reference_id} sent: ${money(obligation)} to ${obligation.supplier}${fee}`,
  );
  return sent;
}

function close(engine: Engine, invoiceId: string): boolean {
  if (!engine.ledger.settle(invoiceId)) {
    return false;
  }
  const replaced: boolean = engine.ledger
    .attempts(invoiceId)
    .some((attempt: Attempt): boolean => attempt.kind === "replacement");
  note(
    engine.ledger,
    invoiceId,
    "closed",
    replaced
      ? "Incident closed: the original failed and one replacement was paid"
      : "Incident closed: the original payment arrived",
  );
  return true;
}

async function replaceAndSettle(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<void> {
  const replacement: Transfer = await pay(engine, obligation, "replacement");
  await simulateTransfer(engine.client, replacement.id, "PAID");
  await syncTransfer(engine.client, engine.ledger, originalId);
  const paid: Transfer = await syncTransfer(
    engine.client,
    engine.ledger,
    replacement.id,
  );
  note(engine.ledger, obligation.invoiceId, "bank", `Replacement ${describe(paid)}`);
  close(engine, obligation.invoiceId);
}

function termsOf(obligation: Obligation, assessment: Assessment): ApprovalTerms {
  return termsFor(
    obligation,
    assessment.original,
    assessment.decision,
    evidenceSummary(assessment.findings),
  );
}

// A replacement is only on offer when the original has failed, and it goes to the
// beneficiary on file. Any other escalation has no payment a person could approve yet.
function escalate(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
): void {
  engine.ledger.escalate(obligation.invoiceId);
  if (originalStateOf(assessment.original) !== "failed") {
    note(engine.ledger, obligation.invoiceId, "approval", "Waiting on a person");
    return;
  }

  const terms: ApprovalTerms = termsOf(obligation, assessment);
  const binding: string = bindingOf(terms);
  const latest: Approval | undefined = engine.ledger.latestApproval(
    obligation.invoiceId,
  );
  if (latest?.state !== "requested" || latest.binding !== binding) {
    engine.ledger.requestApproval(
      obligation.invoiceId,
      binding,
      JSON.stringify(terms),
    );
  }
  note(
    engine.ledger,
    obligation.invoiceId,
    "approval",
    `Waiting on a person to approve ${money(obligation)} to ${terms.payTo} (the account on file)`,
  );
}

async function continueEscalated(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<void> {
  const assessment: Assessment = await assess(engine, obligation, originalId);
  if (assessment.decision.action === "replace") {
    await replaceAndSettle(engine, obligation, originalId);
    return;
  }

  const approval: Approval | undefined = engine.ledger.latestApproval(
    obligation.invoiceId,
  );
  if (approval?.state !== "approved") {
    escalate(engine, obligation, assessment);
    return;
  }

  const current: ApprovalTerms = termsOf(obligation, assessment);
  if (bindingOf(current) !== approval.binding) {
    const approved: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
    engine.ledger.setApprovalState(approval.id, "void");
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      `Approval by ${approval.approver} is void: ${changedFields(approved, current).join(", ")} changed`,
    );
    escalate(engine, obligation, assessment);
    return;
  }

  // One approval covers one attempt, so it is spent before the payment is tried.
  engine.ledger.setApprovalState(approval.id, "used");
  note(
    engine.ledger,
    obligation.invoiceId,
    "approval",
    `Approval by ${approval.approver} matches the current terms`,
  );
  await replaceAndSettle(engine, obligation, originalId);
}

// Picks up an invoice that already has payments. It never pays on its own: it
// retries an attempt that has no transfer yet under its original request_id,
// syncs the rest, and acts on an escalated invoice only when a matching approval
// is on file.
export async function resumeIncident(
  engine: Engine,
  invoiceId: string,
): Promise<void> {
  const obligation: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (obligation === undefined) {
    throw new Error(`${invoiceId} is not in the ledger`);
  }

  let originalId: string | null = null;
  for (const attempt of engine.ledger.attempts(invoiceId)) {
    const transfer: Transfer =
      attempt.transferId === null
        ? await sendAttempt(engine.client, engine.ledger, obligation, attempt)
        : await syncTransfer(engine.client, engine.ledger, attempt.transferId);
    if (attempt.kind === "original") {
      originalId = transfer.id;
    }
    console.log(`  ${attempt.kind} ${describe(transfer)}`);
  }

  if (close(engine, invoiceId)) {
    return;
  }
  if (obligation.state === "escalated" && originalId !== null) {
    await continueEscalated(engine, obligation, originalId);
  }
}

// Records a person's approval of the replacement an escalated invoice is waiting on.
export function approveReplacement(
  ledger: Ledger,
  invoiceId: string,
  approver: string,
): ApprovalTerms {
  const approval: Approval | undefined = ledger.latestApproval(invoiceId);
  if (approval === undefined || approval.state !== "requested") {
    throw new Error(`No approval is waiting for ${invoiceId}`);
  }
  const terms: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  ledger.setApprovalState(approval.id, "approved", approver);
  note(
    ledger,
    invoiceId,
    "approval",
    `Approved by ${approver}: ${formatMoney(terms.amountMinor, terms.currency)} to ${terms.payTo} (the account on file)`,
  );
  return terms;
}

// Records the demo invoice as an obligation to the scenario's supplier.
export async function openScenario(
  engine: Engine,
  invoiceId: string,
  scenarioId: string,
): Promise<Obligation> {
  const def: ScenarioDef | undefined = SCENARIOS.find(
    (scenario: ScenarioDef): boolean => scenario.id === scenarioId,
  );
  if (def === undefined) {
    throw new Error(`Unknown scenario ${scenarioId}`);
  }
  const beneficiary: Beneficiary = await findOrCreateBeneficiary(
    engine.client,
    def.beneficiary,
  );
  const reserveFloorMinor: number =
    def.tightReserveFeeMinor === null
      ? AMPLE_RESERVE_MINOR
      : (await getAvailableMinor(engine.client, def.currency)) -
        def.amountMinor -
        Math.round(def.tightReserveFeeMinor * 1.5);
  return engine.ledger.openObligation({
    invoiceId,
    supplier: def.supplier,
    supplierDomain: SUPPLIER_DOMAIN,
    beneficiaryId: beneficiary.id,
    currency: def.currency,
    amountMinor: def.amountMinor,
    transferMethod: def.transferMethod,
    reserveFloorMinor,
  });
}

// The scripted sandbox incident: pay an invoice, let the supplier write in while
// the transfer is in flight, fail the transfer, then act on the decision. The
// first email of the thread arrives before the bank outcome, the rest with it.
export async function runScenario(
  engine: Engine,
  obligation: Obligation,
  scenario: Scenario,
): Promise<void> {
  const invoiceId: string = obligation.invoiceId;
  const thread: SupplierEmail[] = loadEmails(scenario.emailsName, invoiceId);

  const original: Transfer = await pay(engine, obligation, "original");

  await receive(engine, obligation, thread.slice(0, 1));
  await assess(engine, obligation, original.id);

  await simulateTransfer(engine.client, original.id, "FAILED", scenario.failureType);
  const failed: Transfer = await syncTransfer(
    engine.client,
    engine.ledger,
    original.id,
  );
  note(engine.ledger, invoiceId, "bank", `Original ${describe(failed)}`);
  await receive(engine, obligation, thread.slice(1));
  const assessment: Assessment = await assess(engine, obligation, original.id);

  if (assessment.decision.action !== "replace") {
    escalate(engine, obligation, assessment);
    return;
  }

  await replaceAndSettle(engine, obligation, original.id);

  // Shows the lock holding: a second payment for a settled invoice is refused.
  try {
    engine.ledger.openAttempt(invoiceId, "replacement");
    note(engine.ledger, invoiceId, "error", "A second payment was allowed");
  } catch (error: unknown) {
    if (!(error instanceof DuplicatePaymentError)) {
      throw error;
    }
    note(engine.ledger, invoiceId, "lock", `Second payment refused: ${error.message}`);
  }
}

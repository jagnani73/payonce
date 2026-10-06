import { randomInt } from "node:crypto";
import { getAvailableMinor } from "./airwallex/balances.js";
import {
  DE_SWIFT_SUPPLIER,
  US_LOCAL_SUPPLIER,
  findOrCreateBeneficiary,
  getBankDetails,
  type Beneficiary,
  type BeneficiarySpec,
} from "./airwallex/beneficiaries.js";
import type { AirwallexClient } from "./airwallex/client.js";
import { simulateTransfer } from "./airwallex/simulation.js";
import {
  getTransfer,
  waitForTransfer,
  type Transfer,
  type TransferBankDetails,
} from "./airwallex/transfers.js";
import {
  bindingOf,
  changedFields,
  termsFor,
  type ApprovalTerms,
} from "./approval.js";
import { originalStateOf, resendCanFix, sameBankDetails } from "./assess.js";
import { decide } from "./decide.js";
import {
  loadEmails,
  unverifiedSenders,
  type EmailFindings,
  type EmailReader,
  type SupplierEmail,
} from "./emails.js";
import type { Decision, Incident, OriginalTransferState } from "./incident.js";
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
import { sendAttempt, syncTransfer, wasRejected } from "./payments.js";

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
    label: "EUR, SWIFT, low cash reserve",
    supplier: "Example Supplier GmbH",
    beneficiary: DE_SWIFT_SUPPLIER,
    currency: "EUR",
    amountMinor: 400_000,
    transferMethod: "SWIFT",
    tightReserveFeeMinor: 1_391,
  },
];

export const DEFAULT_SCENARIO: string = "usd-local";
export const DEFAULT_EMAILS: string = "nothing-arrived";

// What the reader found. unverifiedSenders is kept for display; the policy works
// the sender check out again from the stored emails. unread marks a thread the
// reader failed on.
interface StoredFindings extends EmailFindings {
  unverifiedSenders?: string[];
  unread?: boolean;
}

const NO_FINDINGS: StoredFindings = {
  claimsNonReceipt: false,
  asksForNewBankDetails: false,
  summary: "no emails on file",
};

const UNREAD_FINDINGS: EmailFindings = {
  claimsNonReceipt: false,
  asksForNewBankDetails: false,
  summary: "the emails could not be read",
};

export interface Engine {
  client: AirwallexClient;
  ledger: Ledger;
  reader: EmailReader;
}

// The bank outcome that settles the original. Any other outcome is the failure
// type the simulator fails it with.
export const PAID_OUTCOME: string = "PAID";

export interface Scenario {
  bankOutcome: string;
  emailsName: string;
}

interface Assessment {
  original: Transfer;
  findings: StoredFindings;
  unverified: string[];
  bankDetails: TransferBankDetails;
  decision: Decision;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function newInvoiceId(ledger: Ledger): string {
  for (;;) {
    const invoiceId: string = `INV-${randomInt(100_000, 1_000_000)}`;
    if (ledger.obligation(invoiceId) === undefined) {
      return invoiceId;
    }
  }
}

// What a standing line is about. A standing line says how things are now and is
// written again on every check. A line with no topic records something that
// happened.
type Topic = "decision" | "waiting" | "approval" | "cost" | "bank-details";

// True when the timeline's last word on a topic is this message and nothing has
// happened since.
function stillSays(events: LedgerEvent[], topic: Topic, message: string): boolean {
  for (const event of [...events].reverse()) {
    if (event.topic === topic) {
      return event.message === message;
    }
    if (event.topic === null) {
      return false;
    }
  }
  return false;
}

// Adds a line to the incident's timeline and prints it. A line identical to the
// previous one is skipped. So is a standing line the timeline still says, which
// keeps a check that finds nothing new from repeating the decision.
function note(
  ledger: Ledger,
  invoiceId: string,
  kind: EventKind,
  message: string,
  topic: Topic | null = null,
): void {
  const events: LedgerEvent[] = ledger.events(invoiceId);
  const last: LedgerEvent | undefined = events.at(-1);
  if (last?.kind === kind && last.message === message) {
    return;
  }
  if (topic !== null && stillSays(events, topic, message)) {
    return;
  }
  ledger.addEvent(invoiceId, kind, message, topic);
  console.log(`  ${kind.padEnd(8)} ${message}`);
}

// Puts a failure on the incident's timeline. It must not throw, because it runs
// from error handlers.
export function noteError(ledger: Ledger, invoiceId: string, error: unknown): void {
  console.error(error);
  try {
    note(ledger, invoiceId, "error", messageOf(error));
  } catch (inner: unknown) {
    console.error(`Could not record the error for ${invoiceId}: ${messageOf(inner)}`);
  }
}

// An obligation recorded before the domain column existed has none on file, and
// there is nothing to compare its senders with.
function sendersNotOnFile(obligation: Obligation, emails: SupplierEmail[]): string[] {
  return obligation.supplierDomain === ""
    ? []
    : unverifiedSenders(emails, obligation.supplierDomain);
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
  for (const sender of sendersNotOnFile(obligation, emails)) {
    note(
      engine.ledger,
      invoiceId,
      "warning",
      `Sender ${sender} does not match the supplier's domain on file (${obligation.supplierDomain})`,
    );
  }

  // If the reader fails, the thread is marked unread so the policy escalates
  // and does not act on findings from before these emails arrived.
  const thread: SupplierEmail[] = engine.ledger.emails(invoiceId);
  let read: EmailFindings = UNREAD_FINDINGS;
  let unread: boolean = false;
  try {
    read = await engine.reader.read(thread);
  } catch (error: unknown) {
    unread = true;
    note(
      engine.ledger,
      invoiceId,
      "error",
      `Supplier emails could not be read: ${messageOf(error)}`,
    );
  }
  const findings: StoredFindings = {
    ...read,
    unverifiedSenders: sendersNotOnFile(obligation, thread),
    unread,
    ...(unread ? {} : { readBy: read.readBy ?? engine.reader.name }),
  };
  engine.ledger.saveFindings(invoiceId, JSON.stringify(findings));
  note(engine.ledger, invoiceId, "email", `Emails read: ${findings.summary}`);
}

// The email evidence a person sees and approves against.
function evidenceSummary(assessment: Assessment): string {
  return assessment.unverified.length === 0
    ? assessment.findings.summary
    : `${assessment.findings.summary}, sender ${assessment.unverified.join(", ")} does not match the supplier on file`;
}

async function assess(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<Assessment> {
  const original: Transfer = await getTransfer(engine.client, originalId);
  const emails: SupplierEmail[] = engine.ledger.emails(obligation.invoiceId);
  const stored: string | undefined = engine.ledger.findings(obligation.invoiceId);
  const findings: StoredFindings =
    stored === undefined ? NO_FINDINGS : (JSON.parse(stored) as StoredFindings);
  const unverified: string[] = sendersNotOnFile(obligation, emails);
  // A replacement is paid by beneficiary id, so what counts is the account that
  // record points to now, not the one the original went to.
  const bankDetails: TransferBankDetails = await getBankDetails(
    engine.client,
    obligation.beneficiaryId,
  );
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
    supplierReportsNonReceipt: findings.claimsNonReceipt === true,
    supplierAsksForNewBankDetails: findings.asksForNewBankDetails === true,
    beneficiaryChanged: !sameBankDetails(
      original.beneficiary?.bank_details,
      bankDetails,
    ),
    emailFromUnverifiedSender: unverified.length > 0,
    emailsUnread:
      findings.unread === true || (emails.length > 0 && stored === undefined),
    availableBalanceMinor: availableMinor,
    reserveFloorMinor: obligation.reserveFloorMinor,
  };

  // Said whatever the policy escalates for, because it checks other things first.
  if (incident.beneficiaryChanged) {
    note(
      engine.ledger,
      obligation.invoiceId,
      "warning",
      "The supplier's bank details on file are not the ones the original payment went to",
      "bank-details",
    );
  }

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
      "cost",
    );
  }

  const decision: Decision = decide(incident);
  // Once an invoice has gone to a person, the policy no longer acts for itself.
  const held: string =
    obligation.state !== "escalated"
      ? ""
      : decision.action === "replace"
        ? ". This invoice was escalated, so it still needs a person's approval"
        : decision.action === "close"
          ? ". This invoice was escalated, so a person closes it"
          : "";
  note(
    engine.ledger,
    obligation.invoiceId,
    "decision",
    `${capitalise(decision.action)}: ${decision.reason}${held}`,
    "decision",
  );
  return { original, findings, unverified, bankDetails, decision };
}

// Opening the attempt takes the duplicate lock, so this throws if the invoice
// already has a live payment.
async function pay(
  engine: Engine,
  obligation: Obligation,
  kind: AttemptKind,
): Promise<Transfer> {
  const attempt: Attempt = engine.ledger.openAttempt(obligation.invoiceId, kind);
  let created: Transfer;
  try {
    created = await sendAttempt(engine.client, engine.ledger, obligation, attempt);
  } catch (error: unknown) {
    throw new Error(
      wasRejected(error)
        ? `${capitalise(kind)} payment was refused and nothing was sent. ${messageOf(error)}`
        : `${capitalise(kind)} payment request did not complete, so the transfer may or may not exist. Run ${obligation.invoiceId} again to reconcile it. ${messageOf(error)}`,
      { cause: error },
    );
  }

  // Noted as soon as the transfer exists, so a later failure cannot hide it.
  const fee: string =
    created.fee_amount > 0
      ? `, plus a ${formatMoney(toMinor(created.fee_amount), obligation.currency)} transfer fee`
      : "";
  note(
    engine.ledger,
    obligation.invoiceId,
    "payment",
    `${capitalise(kind)} ${created.short_reference_id} sent: ${money(obligation)} to ${obligation.supplier}${fee}`,
  );

  // The simulator rejects a transition until the transfer has left SCHEDULED.
  await waitForTransfer(
    engine.client,
    created.id,
    (transfer: Transfer): boolean => transfer.status !== "SCHEDULED",
  );
  await simulateTransfer(engine.client, created.id, "SENT");
  return syncTransfer(engine.client, engine.ledger, created.id);
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

// Sandbox scaffolding: the scripted bank pays the replacement.
async function settleReplacement(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
  replacementId: string,
): Promise<void> {
  const current: Transfer = await waitForTransfer(
    engine.client,
    replacementId,
    (transfer: Transfer): boolean => transfer.status !== "SCHEDULED",
  );
  if (current.status !== "PAID") {
    if (current.status !== "SENT") {
      await simulateTransfer(engine.client, replacementId, "SENT");
    }
    await simulateTransfer(engine.client, replacementId, "PAID");
  }

  await syncTransfer(engine.client, engine.ledger, originalId);
  const paid: Transfer = await syncTransfer(
    engine.client,
    engine.ledger,
    replacementId,
  );
  note(engine.ledger, obligation.invoiceId, "bank", `Replacement ${describe(paid)}`);
  if (!close(engine, obligation.invoiceId)) {
    note(
      engine.ledger,
      obligation.invoiceId,
      "error",
      `Replacement ${paid.short_reference_id} did not read back as paid, so the incident stays open`,
    );
  }
}

async function replaceAndSettle(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<void> {
  const replacement: Transfer = await pay(engine, obligation, "replacement");
  await settleReplacement(engine, obligation, originalId, replacement.id);
}

function termsOf(obligation: Obligation, assessment: Assessment): ApprovalTerms {
  return termsFor(
    obligation,
    assessment.original,
    assessment.decision,
    evidenceSummary(assessment),
    assessment.bankDetails,
  );
}

// A replacement is only on offer when the original has failed, and it goes to the
// beneficiary on file. A paid original leaves nothing to pay, so the person closes
// the incident. Any other escalation has no payment a person could approve yet.
function escalate(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
): void {
  // An invoice that is already with a person keeps the reason it went there for
  // when the policy would now do something else.
  engine.ledger.escalate(
    obligation.invoiceId,
    assessment.decision.action === "escalate"
      ? assessment.decision.reason
      : obligation.escalationReason,
  );
  const originalState: OriginalTransferState = originalStateOf(assessment.original);
  if (originalState !== "failed") {
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      originalState === "paid"
        ? "Waiting on a person to check with the supplier and close the incident. PayOnce will not send a second payment"
        : "Waiting on a person",
      "waiting",
    );
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
    "waiting",
  );
}

async function continueEscalated(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<void> {
  // Once an invoice has gone to a person, only an approval releases a payment and
  // only a person closes it, even if the policy would now do either unprompted.
  const assessment: Assessment = await assess(engine, obligation, originalId);
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

// Carries out a decision: replace, close, hand over to a person, or leave it
// waiting. Returns true when a replacement was sent.
async function act(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
): Promise<boolean> {
  if (assessment.decision.action === "replace") {
    await replaceAndSettle(engine, obligation, assessment.original.id);
    return true;
  }
  if (assessment.decision.action === "escalate") {
    escalate(engine, obligation, assessment);
  }
  if (assessment.decision.action === "close" && !close(engine, obligation.invoiceId)) {
    note(
      engine.ledger,
      obligation.invoiceId,
      "error",
      "The ledger does not show this invoice as paid once, so the incident stays open",
    );
  }
  return false;
}

// Picks up an invoice that already has payments. It retries an attempt that has
// no transfer yet under its original request_id and syncs the rest. A replacement
// already out is finished. An escalated invoice pays only on a matching approval.
// An open one that stopped before its decision was carried out gets that decision.
export async function resumeIncident(
  engine: Engine,
  invoiceId: string,
): Promise<void> {
  const obligation: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (obligation === undefined) {
    throw new Error(`${invoiceId} is not in the ledger`);
  }

  let originalId: string | null = null;
  let liveReplacementId: string | null = null;
  for (const attempt of engine.ledger.attempts(invoiceId)) {
    // An attempt Airwallex refused never became a transfer. Only one still
    // pending is retried.
    if (attempt.transferId === null && attempt.state !== "pending") {
      continue;
    }
    const transfer: Transfer =
      attempt.transferId === null
        ? await sendAttempt(engine.client, engine.ledger, obligation, attempt)
        : await syncTransfer(engine.client, engine.ledger, attempt.transferId);
    if (attempt.kind === "original") {
      originalId = transfer.id;
    } else if (originalStateOf(transfer) === "in_flight") {
      liveReplacementId = transfer.id;
    }
    console.log(`  ${attempt.kind} ${describe(transfer)}`);
  }

  if (originalId === null) {
    return;
  }
  if (engine.ledger.paidOnce(invoiceId)) {
    // Closed already, by the policy or by a person.
    if (obligation.state === "settled") {
      return;
    }
    // A paid replacement was sent on a decision already made, so it closes the
    // incident. A paid original goes to the policy, which may want a person.
    if (paidOriginal(engine.ledger, invoiceId) === undefined) {
      close(engine, invoiceId);
      return;
    }
  }
  // A replacement that is already out is finished, never approved a second time.
  if (liveReplacementId !== null) {
    note(
      engine.ledger,
      invoiceId,
      "payment",
      "Picking up a replacement that was already sent",
    );
    await settleReplacement(engine, obligation, originalId, liveReplacementId);
    return;
  }
  if (obligation.state === "escalated") {
    await continueEscalated(engine, obligation, originalId);
    return;
  }
  await act(engine, obligation, await assess(engine, obligation, originalId));
}

// The original, when it is the one payment the invoice has been paid with.
function paidOriginal(ledger: Ledger, invoiceId: string): Attempt | undefined {
  if (!ledger.paidOnce(invoiceId)) {
    return undefined;
  }
  return ledger
    .attempts(invoiceId)
    .find(
      (attempt: Attempt): boolean =>
        attempt.kind === "original" && attempt.state === "paid",
    );
}

// What a person is shown before closing an escalated invoice whose original the
// bank reports as paid.
export interface CloseReview {
  reference: string | null;
  reason: string;
}

export function pendingClose(
  ledger: Ledger,
  invoiceId: string,
): CloseReview | undefined {
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  const paid: Attempt | undefined = paidOriginal(ledger, invoiceId);
  return obligation?.state !== "escalated" || paid === undefined
    ? undefined
    : { reference: paid.reference, reason: obligation.escalationReason };
}

// Records a person closing such an invoice. It moves no money, so it is not bound
// to terms the way an approval is.
export function closeIncident(
  ledger: Ledger,
  invoiceId: string,
  closedBy: string,
  finding: string,
): void {
  if (pendingClose(ledger, invoiceId) === undefined || !ledger.settle(invoiceId)) {
    throw new Error(`${invoiceId} is not waiting on a person to close it`);
  }
  note(ledger, invoiceId, "closed", `Incident closed by ${closedBy}: ${finding}`);
}

// Returns the request an escalated invoice is waiting on, if there is one.
export function pendingApproval(
  ledger: Ledger,
  invoiceId: string,
): { id: number; terms: ApprovalTerms } | undefined {
  const approval: Approval | undefined = ledger.latestApproval(invoiceId);
  return approval === undefined || approval.state !== "requested"
    ? undefined
    : { id: approval.id, terms: JSON.parse(approval.terms) as ApprovalTerms };
}

// approvalId is the request the approver was shown. If a newer one has replaced
// it, the approval is refused so nobody approves terms they did not see.
export function approveReplacement(
  ledger: Ledger,
  invoiceId: string,
  approver: string,
  approvalId: number,
): ApprovalTerms {
  const approval: Approval | undefined = ledger.latestApproval(invoiceId);
  if (approval === undefined || approval.state !== "requested") {
    throw new Error(`No approval is waiting for ${invoiceId}`);
  }
  if (approval.id !== approvalId) {
    throw new Error(
      `The approval request for ${invoiceId} has changed. Review the current terms`,
    );
  }
  const terms: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  ledger.setApprovalState(approval.id, "approved", approver);
  note(
    ledger,
    invoiceId,
    "approval",
    `Approved by ${approver}: ${formatMoney(terms.amountMinor, terms.currency)} to ${terms.payTo} (the account on file)`,
    // Standing, so the check that follows does not restate the decision.
    "approval",
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
  // openObligation leaves an existing row as it is, so a reused invoice number
  // would run this scenario against someone else's invoice.
  if (engine.ledger.obligation(invoiceId) !== undefined) {
    throw new Error(`${invoiceId} is already in the ledger`);
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
// the transfer is in flight, apply the bank outcome, then act on the decision. The
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

  if (scenario.bankOutcome === PAID_OUTCOME) {
    await simulateTransfer(engine.client, original.id, "PAID");
  } else {
    await simulateTransfer(engine.client, original.id, "FAILED", scenario.bankOutcome);
  }
  const outcome: Transfer = await syncTransfer(
    engine.client,
    engine.ledger,
    original.id,
  );
  note(engine.ledger, invoiceId, "bank", `Original ${describe(outcome)}`);
  await receive(engine, obligation, thread.slice(1));
  const assessment: Assessment = await assess(engine, obligation, original.id);
  if (!(await act(engine, obligation, assessment))) {
    return;
  }

  // Shows the lock holding: a second payment for a settled invoice is refused.
  try {
    const extra: Attempt = engine.ledger.openAttempt(invoiceId, "replacement");
    // Not expected. Fail the stray attempt so a later run cannot send it.
    engine.ledger.failAttempt(extra.requestId, null);
    note(engine.ledger, invoiceId, "error", "The lock let a second payment through");
  } catch (error: unknown) {
    if (!(error instanceof DuplicatePaymentError)) {
      throw error;
    }
    note(engine.ledger, invoiceId, "lock", `Second payment refused: ${error.message}`);
  }
}

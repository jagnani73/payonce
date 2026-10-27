import { getAvailableMinor } from "./airwallex/balances.js";
import { getBankDetails } from "./airwallex/beneficiaries.js";
import type { AirwallexClient } from "./airwallex/client.js";
import {
  getTransfer,
  type Transfer,
  type TransferBankDetails,
} from "./airwallex/transfers.js";
import {
  bindingOf,
  changedFields,
  termsFor,
  type ApprovalTerms,
} from "./approval.js";
import {
  attemptStateOf,
  originalStateOf,
  resendCanFix,
  sameBankDetails,
} from "./assess.js";
import { decide } from "./decide.js";
import {
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
  type AttemptState,
  type EventKind,
  type Ledger,
  type LedgerEvent,
  type Obligation,
} from "./ledger.js";
import { formatMoney, toMinor } from "./money.js";
import { sendAttempt, syncTransfer, wasRejected } from "./payments.js";

// What the reader found. unverifiedSenders is kept for display; the policy works
// the sender check out again from the stored emails. unread marks a thread the
// reader failed on. emailsRead is how many emails of the thread were read.
interface StoredFindings extends EmailFindings {
  unverifiedSenders?: string[];
  unread?: boolean;
  emailsRead?: number;
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

// Told about each payment PayOnce sends. In the sandbox it plays the bank, so the
// payment moves on. In production there is none, because the bank moves it.
export interface Bank {
  sent(invoiceId: string, kind: AttemptKind, transferId: string): void;
}

export interface Engine {
  client: AirwallexClient;
  ledger: Ledger;
  reader: EmailReader;
  bank?: Bank;
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

// What a standing line is about. A standing line says how things are now and is
// written again on every check. A line with no topic records something that
// happened.
export type Topic = "decision" | "waiting" | "approval" | "cost" | "bank-details";

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
export function note(
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

// The inbox: stores emails that arrived for an invoice, puts them on its timeline
// and checks their senders against the domain on file. The agent reads them the
// next time it looks at the invoice.
export function deliver(
  ledger: Ledger,
  obligation: Obligation,
  emails: SupplierEmail[],
): void {
  const invoiceId: string = obligation.invoiceId;
  ledger.addEmails(invoiceId, emails);
  for (const email of emails) {
    note(ledger, invoiceId, "email", `Email from ${email.from}: ${email.subject}`);
  }
  for (const sender of sendersNotOnFile(obligation, emails)) {
    note(
      ledger,
      invoiceId,
      "warning",
      `Sender ${sender} does not match the supplier's domain on file (${obligation.supplierDomain})`,
    );
  }
}

// Reads the whole thread once emails have arrived since it was last read, and
// keeps the findings so later looks see the same result. If the reader fails,
// the thread is marked unread so the policy escalates and does not act on
// findings from before these emails arrived. It is read again on the next look.
async function readNewEmails(engine: Engine, obligation: Obligation): Promise<void> {
  const invoiceId: string = obligation.invoiceId;
  const thread: SupplierEmail[] = engine.ledger.emails(invoiceId);
  const stored: string | undefined = engine.ledger.findings(invoiceId);
  const previous: StoredFindings | undefined =
    stored === undefined ? undefined : (JSON.parse(stored) as StoredFindings);
  // Findings saved before the count was kept cover the whole thread.
  const readCount: number =
    previous === undefined ? 0 : (previous.emailsRead ?? thread.length);
  if (readCount >= thread.length) {
    return;
  }

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
    emailsRead: unread ? 0 : thread.length,
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
    replacementFailed: engine.ledger
      .attempts(obligation.invoiceId)
      .some(
        (attempt: Attempt): boolean =>
          attempt.kind === "replacement" && attempt.state === "failed",
      ),
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
  engine.bank?.sent(obligation.invoiceId, kind, created.id);
  return created;
}

export function payOriginal(engine: Engine, obligation: Obligation): Promise<Transfer> {
  return pay(engine, obligation, "original");
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

function waitForReplacement(engine: Engine, invoiceId: string, reference: string): void {
  note(
    engine.ledger,
    invoiceId,
    "payment",
    `Waiting for the bank to pay replacement ${reference}`,
    "waiting",
  );
}

// The bank pays the replacement later. The agent hears about it the way it heard
// about the original, and closes the incident then.
async function replace(engine: Engine, obligation: Obligation): Promise<void> {
  const replacement: Transfer = await pay(engine, obligation, "replacement");
  waitForReplacement(engine, obligation.invoiceId, replacement.short_reference_id);
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
  await replace(engine, obligation);
}

// Carries out a decision: replace, close, hand over to a person, or leave it
// waiting.
async function act(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
): Promise<void> {
  if (assessment.decision.action === "replace") {
    await replace(engine, obligation);
    return;
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
}

// Looks at an invoice again, after a webhook, a status check, new emails or a
// person's action. It syncs each payment with Airwallex, retrying an attempt that
// has no transfer yet under its original request_id, and notes any payment the
// bank has paid or failed since the last look. Then it reads new emails, decides
// and acts. A replacement already out is waited on, never approved a second time.
// An escalated invoice pays only on a matching approval.
export async function resumeIncident(
  engine: Engine,
  invoiceId: string,
): Promise<void> {
  const obligation: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (obligation === undefined) {
    throw new Error(`${invoiceId} is not in the ledger`);
  }

  let originalId: string | null = null;
  let liveReplacement: Transfer | null = null;
  for (const attempt of engine.ledger.attempts(invoiceId)) {
    // An attempt Airwallex refused never became a transfer. Only one still
    // pending is retried.
    if (attempt.transferId === null && attempt.state !== "pending") {
      continue;
    }
    let transfer: Transfer;
    if (attempt.transferId === null) {
      transfer = await sendAttempt(engine.client, engine.ledger, obligation, attempt);
      engine.bank?.sent(invoiceId, attempt.kind, transfer.id);
    } else {
      transfer = await syncTransfer(engine.client, engine.ledger, attempt.transferId);
    }
    const state: AttemptState | null = attemptStateOf(transfer);
    if (state !== attempt.state && (state === "paid" || state === "failed")) {
      note(engine.ledger, invoiceId, "bank", `${capitalise(attempt.kind)} ${describe(transfer)}`);
    }
    if (attempt.kind === "original") {
      originalId = transfer.id;
    } else if (originalStateOf(transfer) === "in_flight") {
      liveReplacement = transfer;
    }
    console.log(`  ${attempt.kind} ${describe(transfer)}`);
  }

  if (originalId === null) {
    return;
  }
  await readNewEmails(engine, obligation);
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
  if (liveReplacement !== null) {
    waitForReplacement(engine, invoiceId, liveReplacement.short_reference_id);
    return;
  }
  if (obligation.state === "escalated") {
    await continueEscalated(engine, obligation, originalId);
    return;
  }
  await act(engine, obligation, await assess(engine, obligation, originalId));
}

// Shows the lock holding: a second payment for a settled invoice is refused.
export function proveLock(ledger: Ledger, invoiceId: string): void {
  try {
    const extra: Attempt = ledger.openAttempt(invoiceId, "replacement");
    // Not expected. Fail the stray attempt so a later run cannot send it.
    ledger.failAttempt(extra.requestId, null);
    note(ledger, invoiceId, "error", "The lock let a second payment through");
  } catch (error: unknown) {
    if (!(error instanceof DuplicatePaymentError)) {
      throw error;
    }
    note(ledger, invoiceId, "lock", `Second payment refused: ${error.message}`);
  }
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

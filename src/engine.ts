import { getAvailableMinor } from "./airwallex/balances.js";
import {
  findBeneficiary,
  getBankDetails,
  type BeneficiaryRecord,
} from "./airwallex/beneficiaries.js";
import { AirwallexError, AirwallexUnreachableError, type AirwallexClient } from "./airwallex/client.js";
import { createQuote, type Quote } from "./airwallex/fx.js";
import {
  findTransferByRequestId,
  getTransfer,
  listTransfersSince,
  type Transfer,
  type TransferBankDetails,
} from "./airwallex/transfers.js";
import {
  accountKeyOf,
  bindingOf,
  changedFields,
  conversionText,
  describeRate,
  fxTermsOf,
  heldTermsFor,
  keyHash,
  markupOf,
  paidWith,
  paymentAmount,
  rateMismatch,
  sentToOf,
  termsFor,
  withArrival,
  withFeeEstimate,
  type ApprovalTerms,
  type DuplicateEvidence,
  type FxTerms,
  type HeldPaymentTerms,
  type LastQuote,
  type ReplacementTerms,
} from "./approval.js";
import {
  APPROVED_USE_WITHIN_MS,
  checkSigner,
  eligibleApprovers,
  knownName,
  personName,
  signoffProblem,
  signoffsNeeded,
  type ApprovalPolicy,
  type Approver,
  type Barred,
  type SignoffRule,
} from "./approvers.js";
import {
  arrivalFor,
  atRisk,
  ifSentOn,
  replacementArrivalText,
  sentArrivalText,
  today,
  type ArrivalTerms,
} from "./arrival.js";
import {
  attemptStateOf,
  debitOf,
  feeOf,
  originalStateOf,
  resendCanFix,
  routeKeyOf,
  routeOfDetailsKey,
  sameBankDetails,
  type Debit,
  type Fee,
} from "./assess.js";
import { committedAcross, committedByInvoice, committedMinor } from "./cash-position.js";
import { withCurrencyLock } from "./currency-lock.js";
import { deadlineMinutes, deadlineOf, describeDeadline, isOverdue } from "./deadlines.js";
import {
  decide,
  floorReason,
  LAST_PAID_CHANGED_REASON,
  namingNotToPay,
  NO_FLOOR_CLAUSE,
  NO_FLOOR_REASON,
  OUTAGE_REASON,
  OUTSIDE_PAYOUT_REASON,
  UNCONFIRMED_ACCOUNT_REASON,
} from "./decide.js";
import { likelyDuplicates, nearlyPays, sameNumberForSupplier } from "./duplicates.js";
import {
  emailEvidence,
  summarise,
  unverifiedSenders,
  type EmailFindings,
  type EmailReader,
  type SupplierEmail,
} from "./emails.js";
import { quoteValidity } from "./fx.js";
import type { Decision, Incident, OriginalTransferState } from "./incident.js";
import {
  crossCurrency,
  DuplicatePaymentError,
  expiryOf,
  holdsAccount,
  isExpired,
  lateBesideLive,
  liveAtBank,
  mismatchedLive,
  RailOutageError,
  signersOf,
  storedObject,
  type AccountRef,
  type Approval,
  type Attempt,
  type AttemptKind,
  type BankChange,
  type AttemptState,
  type EventKind,
  type LastPaid,
  type Lease,
  type Ledger,
  type LedgerEvent,
  type Obligation,
  type ObligationState,
  type Outage,
  type OutsidePayout,
  type PayoutMoney,
  type PayoutState,
  type RunRow,
  type ScannedObligation,
  type Signoff,
} from "./ledger.js";
import { formatMoney, readMinor, toMajor, toMinor } from "./money.js";
import { holdLine, railFailureSeen, waitingLine } from "./outages.js";
import { sendAttempt, syncTransfer, wasRejected, type Decide } from "./payments.js";
import { oneLine, say, sayError } from "./printable.js";
import { debitCurrency, floorFor, type ReservePolicy } from "./reserve.js";

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
  asksNotToPay: false,
  summary: "no emails on file",
};

// Emails on file that no look has read yet.
const NOT_READ_FINDINGS: StoredFindings = {
  ...NO_FINDINGS,
  summary: "the emails have not been read yet",
};

const UNREAD_SUMMARY: string = "the emails could not be read";

// Why an invoice with emails on file waits: the reader failed on one, or one
// arrived after the last read.
const EMAILS_NOT_READ: string = "supplier emails are on file that could not be read";

// An email delivered before the first payment is read by a person first.
export const EMAILS_BEFORE_PAYMENT_REASON: string =
  "supplier emails arrived before the first payment, so a person reads them before PayOnce pays it";

// Told about each payment PayOnce sends. In the sandbox it plays the bank, so the
// payment moves on. In production there is none, because the bank moves it.
export interface Bank {
  sent(invoiceId: string, kind: AttemptKind, transferId: string): void;
}

export interface Engine {
  client: AirwallexClient;
  ledger: Ledger;
  reader: EmailReader;
  approvals: ApprovalPolicy;
  reserve: ReservePolicy;
  bank?: Bank;
}

// The quote a payment from another currency's wallet is approved at. fresh is
// true for one no request has shown, which a new request may open on. endsAt is
// when it runs out by this machine's clock, and NaN for one taken from an open
// request.
interface Rate {
  fx: FxTerms;
  fresh: boolean;
  endsAt: number;
}

interface Assessment {
  original: Transfer;
  incident: Incident;
  findings: StoredFindings;
  unverified: string[];
  // The emails on file when the look assessed the invoice.
  emails: SupplierEmail[];
  bankDetails: TransferBankDetails;
  // The callback that verified the bank details on file, when they are not the
  // ones the original went to. Null when none matches them.
  bankChange: BankChange | null;
  // The quote a replacement from another currency's wallet would be paid at.
  // Null for any other invoice, and before the original has failed.
  rate: Rate | null;
  // When a replacement sent now usually arrives. Null for an invoice with no due
  // date, so its terms are as they were before.
  arrival: ArrivalTerms | null;
  decision: Decision;
  // The floor reason added to the decision's reason, or null when none was.
  floor: string | null;
  // A paid invoice this one looks like a second bill for, once the original has
  // failed. Null when there is none.
  paidDuplicate: string | null;
}

// An approval request ends this long before its quote does, after the time an
// approval given at the last moment has to be used, so a slow look or a clock
// that differs from Airwallex's never sends on a quote that has run out.
const QUOTE_MARGIN_MS: number = 2 * 60_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// What a standing line is about. A standing line says how things are now and is
// written again on every check. A line with no topic records something that
// happened.
export type Topic =
  | "decision"
  | "waiting"
  | "approval"
  | "cost"
  | "bank-details"
  | "last-paid"
  | "floor"
  | "second-bill"
  | "retry";

// True when the timeline's last word on a topic is this message and nothing has
// happened since. A pay run's timeline uses it too.
export function stillSays(events: LedgerEvent[], topic: string, message: string): boolean {
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

// False for a line identical to the timeline's last one, and for a standing line
// the timeline still says. A pay run's timeline uses it too.
export function lineWanted(events: LedgerEvent[], kind: EventKind, message: string, topic: string | null): boolean {
  const last: LedgerEvent | undefined = events.at(-1);
  if (last?.kind === kind && last.message === message) {
    return false;
  }
  return topic === null || !stillSays(events, topic, message);
}

// Adds a line to the incident's timeline and prints it, unless lineWanted says
// the timeline has it already, which keeps a check that finds nothing new from
// repeating the decision.
export function note(
  ledger: Ledger,
  invoiceId: string,
  kind: EventKind,
  message: string,
  topic: Topic | null = null,
): void {
  // One line, as the ledger stores it, so a line break in a name or a note cannot
  // print as a line of its own.
  const line: string = oneLine(message);
  if (!lineWanted(ledger.events(invoiceId), kind, line, topic)) {
    return;
  }
  ledger.addEvent(invoiceId, kind, line, topic);
  say(`  ${kind.padEnd(8)} ${line}`);
}

// Puts a failure on the incident's timeline. It must not throw, because it runs
// from error handlers. An Airwallex error says all there is in its message and
// repeats on every look while Airwallex is down, so it prints as one line; any
// other error prints with its stack trace.
export function noteError(ledger: Ledger, invoiceId: string, error: unknown): void {
  sayError(
    error instanceof AirwallexError || error instanceof AirwallexUnreachableError
      ? `  error    ${invoiceId}: ${messageOf(error)}`
      : error,
  );
  try {
    note(ledger, invoiceId, "error", messageOf(error));
  } catch (inner: unknown) {
    sayError(`Could not record the error for ${invoiceId}: ${messageOf(inner)}`);
  }
}

// With no domain on file every sender is flagged, since nothing can vouch for it.
function sendersNotOnFile(obligation: Obligation, emails: SupplierEmail[]): string[] {
  return unverifiedSenders(emails, obligation.supplierDomain);
}

// The stored findings, or what stands for them before anything was read. They are
// read strict, so a look on findings that do not parse throws and pays nothing.
// Only a view, such as the board's pendingClose, reads them soft (readingSoft), and
// there findings that do not parse stand as not read.
function storedFindings(ledger: Ledger, invoiceId: string, emails: SupplierEmail[]): { findings: StoredFindings; stored: boolean } {
  const stored: string | undefined = ledger.findings(invoiceId);
  const findings: StoredFindings | null = stored === undefined ? null : storedObject<StoredFindings>(stored);
  if (findings !== null) {
    return { findings, stored: true };
  }
  return { findings: emails.length === 0 ? NO_FINDINGS : NOT_READ_FINDINGS, stored: false };
}

// True while an email on file has not been read: the reader failed on it, or it
// arrived after the findings were saved, for example from another process during
// this look.
function emailsNotRead(findings: StoredFindings, stored: boolean, emails: SupplierEmail[]): boolean {
  return (
    findings.unread === true ||
    (emails.length > 0 && !stored) ||
    (findings.emailsRead ?? emails.length) < emails.length
  );
}

// Puts the sender check on the timeline: each From and Reply-To address the
// domain on file does not vouch for.
export function noteSenders(ledger: Ledger, obligation: Obligation, emails: SupplierEmail[]): void {
  const invoiceId: string = obligation.invoiceId;
  const domain: string = obligation.supplierDomain;
  const fromOnly: SupplierEmail[] = emails.map((email: SupplierEmail): SupplierEmail => ({ ...email, replyTo: [] }));
  const replies: SupplierEmail[] = emails.flatMap((email: SupplierEmail): SupplierEmail[] =>
    (email.replyTo ?? []).map((address: string): SupplierEmail => ({ from: address, subject: "", body: "" })),
  );
  for (const sender of unverifiedSenders(fromOnly, domain)) {
    note(
      ledger,
      invoiceId,
      "warning",
      domain === ""
        ? `No supplier domain is on file for this invoice, so sender ${sender} cannot be checked`
        : `Sender ${sender} does not match the supplier's domain on file (${domain})`,
    );
  }
  for (const address of unverifiedSenders(replies, domain)) {
    note(
      ledger,
      invoiceId,
      "warning",
      domain === ""
        ? `No supplier domain is on file for this invoice, so Reply-To address ${address} cannot be checked`
        : `Replies to this email go to ${address}, which does not match the supplier's domain on file (${domain})`,
    );
  }
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

// A payout's amount, payee and status, as the timeline shows it.
export function payoutSummary(transfer: Transfer): string {
  const failure: string =
    transfer.failure?.code === undefined ? "" : `, ${transfer.failure.code}`;
  const payee: string =
    transfer.beneficiary?.bank_details?.account_name ?? "an unnamed payee";
  return `${formatMoney(toMinor(transfer.transfer_amount), transfer.transfer_currency)} to ${payee}, ${transfer.status}${failure}`;
}

// A payout's amount and fee for the ledger, each in the currency it was taken in.
// One that cannot be read is null, so tying the payout never fails on it.
function payoutMoney(transfer: Transfer): PayoutMoney {
  const fee: Fee | null = feeOf(transfer);
  const debit: Debit | null = debitOf(transfer);
  return {
    amountMinor: debit?.minor ?? null,
    currency: debit?.currency ?? null,
    feeMinor: fee?.minor ?? null,
    feeCurrency: fee?.currency ?? null,
    // Where it went, for the supplier view only. sentToOf never throws, so odd
    // bank details cannot stop the payout being tied or the check before a payment.
    ...sentToOf(transfer.beneficiary?.bank_details),
  };
}

// A payout whose reference names an invoice PayOnce has may pay that invoice a
// second time. It goes on the invoice's timeline, and the policy holds every
// payment while it is live. A settled invoice, or one closed without paying, is
// reopened for a person to check. exact is false when the reference only nearly
// matches the invoice number. Call it in the invoice's turn. False when the
// payout was tied already.
export function linkOutsidePayout(
  engine: Engine,
  invoiceId: string,
  transfer: Transfer,
  exact: boolean = true,
): boolean {
  const state: PayoutState = originalStateOf(transfer);
  // A closed invoice it may still pay is reopened in the transaction that ties it.
  const linked: boolean = engine.ledger.linkOutsidePayout(
    invoiceId,
    {
      transferId: transfer.id,
      reference: transfer.short_reference_id,
      state,
      ...payoutMoney(transfer),
    },
    state === "failed" ? null : OUTSIDE_PAYOUT_REASON,
  );
  if (!linked) {
    return false;
  }
  note(
    engine.ledger,
    invoiceId,
    "warning",
    exact
      ? `Payout ${transfer.short_reference_id} for this invoice was sent outside PayOnce: ${payoutSummary(transfer)}`
      : `Payout ${transfer.short_reference_id} was sent outside PayOnce with reference ${transfer.reference}, which matches this invoice's number apart from case, spacing, leading zeros or letters added at the end. It went to the same supplier for the same amount: ${payoutSummary(transfer)}`,
  );
  return true;
}

// Why an invoice waits for a person when a transfer Airwallex listed late under
// the request id of a payment PayOnce had marked failed may pay it a second time.
// A fixed string, because alerts post escalation reasons.
export const LATE_TRANSFER_REASON: string =
  "a payment PayOnce marked as never sent reached the bank, so the supplier may have been paid twice";

// The attempt a transfer Airwallex lists belongs to, when the ledger has no
// transfer on it: one still pending whose create went unanswered, or one marked
// failed because Airwallex listed nothing under its request id at the time. The
// transfer must also carry the invoice's number as its reference, and its amount
// and currency, as PayOnce sends them.
export function unrecordedAttemptOf(ledger: Ledger, transfer: Transfer): Attempt | undefined {
  const requestId: string = transfer.request_id ?? "";
  const attempt: Attempt | undefined =
    requestId === "" ? undefined : ledger.attemptOf(requestId, transfer.id);
  if (attempt?.requestId !== requestId || attempt.transferId !== null) {
    return undefined;
  }
  const obligation: Obligation | undefined = ledger.obligation(attempt.invoiceId);
  return obligation !== undefined &&
    transfer.reference === obligation.invoiceId &&
    transfer.transfer_currency === obligation.currency &&
    readMinor(transfer.transfer_amount) === obligation.amountMinor
    ? attempt
    : undefined;
}

// Why an invoice waits for a person when Airwallex lists a transfer under the
// request id of a payment PayOnce marked failed with none, and that transfer does
// not carry the invoice's number, amount and currency. A fixed string, because
// alerts post escalation reasons.
export const MISMATCHED_TRANSFER_REASON: string =
  "Airwallex lists a transfer under the request id of a payment PayOnce marked as never sent, and it does not match this invoice";

// The same reason once the bank has failed every such transfer for the invoice.
export const MISMATCHED_FAILED_REASON: string =
  "Airwallex listed a transfer under the request id of a payment PayOnce marked as never sent that did not match this invoice, and the bank has failed it";

// Such a transfer is not recorded as the attempt's payment, because it may not be
// this invoice's. It is kept beside the attempt with the status the bank gives
// it, and counts as live (liveAtBank) until the bank fails it, so nothing more is
// sent or released for the invoice meanwhile. The first time, the timeline says
// so in PayOnce's words and the invoice waits for a person, reopened unless it
// is settled. Later reads only update its status. True when it tied the transfer
// or its status changed, so the caller looks at the invoice again.
export function noteMismatchedTransfer(engine: Engine, transfer: Transfer): boolean {
  const requestId: string = transfer.request_id ?? "";
  const attempt: Attempt | undefined =
    requestId === "" ? undefined : engine.ledger.attemptOf(requestId, transfer.id);
  if (attempt?.requestId !== requestId || attempt.transferId !== null) {
    return false;
  }
  if (attempt.mismatchedTransferId === transfer.id) {
    return syncMismatched(engine, attempt, transfer);
  }
  if (
    attempt.state !== "failed" ||
    unrecordedAttemptOf(engine.ledger, transfer) !== undefined ||
    // The invoice goes to a person in the transaction that keeps the transfer.
    !engine.ledger.addMismatched(
      requestId,
      transfer.id,
      transfer.short_reference_id,
      transfer.status ?? null,
      debitOf(transfer),
      MISMATCHED_TRANSFER_REASON,
    )
  ) {
    return false;
  }
  const invoiceId: string = attempt.invoiceId;
  note(
    engine.ledger,
    invoiceId,
    "warning",
    `${capitalise(attempt.kind)} payment PayOnce had marked failed has a transfer under its request id that does not match this invoice: Airwallex lists ${transfer.short_reference_id} ${transfer.status} under it with another reference, amount or currency. PayOnce did not record it as the ${attempt.kind}, sends nothing for this invoice while the bank has it, and a person checks it`,
  );
  return true;
}

// Records the status the bank gives a transfer kept beside an attempt because it
// does not match the invoice, with a bank line when it is paid or failed. True
// when the status changed.
function syncMismatched(engine: Engine, attempt: Attempt, transfer: Transfer): boolean {
  if (!engine.ledger.setMismatchedStatus(transfer.id, transfer.status, debitOf(transfer))) {
    return false;
  }
  const state: AttemptState | null = attemptStateOf(transfer);
  if (state === "paid" || state === "failed") {
    note(
      engine.ledger,
      attempt.invoiceId,
      "bank",
      `Transfer under the ${attempt.kind}'s request id that does not match this invoice: ${describe(transfer)}`,
    );
  }
  return true;
}

// Nothing is sent or released while a transfer under one of the invoice's request
// ids that does not match it is live at the bank, and any open request is
// withdrawn. A person checks it: once it is paid, a person can close the invoice,
// and once it has failed, the invoice carries on, but PayOnce never closes it by
// itself until a person has.
function holdMismatched(engine: Engine, invoiceId: string, attempt: Attempt): NextLook {
  engine.ledger.escalateUnlessSettled(invoiceId, MISMATCHED_TRANSFER_REASON);
  if (engine.ledger.voidOpenApprovals(invoiceId)) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      "Approval request withdrawn: a transfer that does not match this invoice is live under one of its request ids",
    );
  }
  const reference: string = attempt.mismatchedReference ?? attempt.mismatchedTransferId ?? "";
  note(
    engine.ledger,
    invoiceId,
    "approval",
    attempt.mismatchedStatus === "PAID"
      ? `Waiting on a person. Transfer ${reference}, under the ${attempt.kind}'s request id, is paid but does not match this invoice. Check it with the supplier and close the incident. PayOnce sends nothing more`
      : `Waiting on a person. Transfer ${reference}, under the ${attempt.kind}'s request id, does not match this invoice and is still with the bank, so PayOnce sends nothing`,
    "waiting",
  );
  return null;
}

// A payment the bank has not failed that PayOnce found late, while another payment
// for the invoice, PayOnce's or one sent outside it, is live at the bank too: the
// supplier may have been paid twice. Late is a transfer recorded on an attempt
// PayOnce had marked failed with none, or one the ledger keeps failed while the
// bank shows it live, because another payment holds the duplicate lock. Both are
// judged by liveAtBank, so two late transfers the ledger keeps apart count too.
// settle makes the same test inside its transaction.
export function paidTwice(ledger: Ledger, invoiceId: string): Attempt | undefined {
  return lateBesideLive(ledger.attempts(invoiceId), ledger.outsidePayouts(invoiceId));
}

// A transfer the ledger keeps failed while the bank shows it live. It holds the
// duplicate lock once another payment has failed, which the next record of it
// does, so a look records it again after reading the others.
function keptFailed(attempt: Attempt): boolean {
  return attempt.state === "failed" && attempt.transferId !== null && liveAtBank(attempt);
}

// Nothing more is sent while two payments may both pay the invoice, and any open
// request is withdrawn. The invoice waits for a person with a reason the policy
// never replaces, because the look holds it here before the policy runs, so the
// alert and the close card name it.
function holdPaidTwice(engine: Engine, invoiceId: string, late: Attempt): NextLook {
  engine.ledger.escalate(invoiceId, LATE_TRANSFER_REASON);
  if (engine.ledger.voidOpenApprovals(invoiceId)) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      "Approval request withdrawn: the supplier may have been paid twice",
    );
  }
  note(
    engine.ledger,
    invoiceId,
    "approval",
    `Waiting on a person. ${capitalise(late.kind)} ${late.reference ?? late.transferId ?? ""} and another payment for this invoice may both pay the supplier, so PayOnce sends nothing`,
    "waiting",
  );
  return null;
}

// Records a transfer Airwallex lists only now under the request id of an attempt
// PayOnce had marked failed with none on it, in the state the bank gives it, and
// says so on the timeline. A pending attempt is left to its look, which lists it
// by request id and checks its transfer as it does any payment it sends. When
// another payment for the invoice has not failed either, the line is a warning
// and the invoice waits for a person with LATE_TRANSFER_REASON, reopened if it
// was closed. Any other closed invoice the transfer may still pay is reopened
// too. True when it recorded one, and the caller then looks at the invoice
// again.
export async function recordLateTransfer(engine: Engine, transfer: Transfer): Promise<boolean> {
  const attempt: Attempt | undefined = unrecordedAttemptOf(engine.ledger, transfer);
  if (attempt?.state !== "failed" || !engine.ledger.foundLate(attempt.requestId, Date.now())) {
    return false;
  }
  const invoiceId: string = attempt.invoiceId;
  const before: Obligation | undefined = engine.ledger.obligation(invoiceId);
  const checks: TransferChecks | undefined =
    before === undefined ? undefined : transferChecks(engine, before, attempt);
  let twice: boolean = false;
  let kept: boolean = false;
  // What it decides is written with the record, before any line: the checks, and
  // the escalation that reopens a closed invoice it may still pay. A line that
  // could not be written then leaves nothing undone, and a step that stops before
  // the record leaves the attempt with no transfer, for the next sweep.
  const recorded: Transfer = await syncTransfer(engine.client, engine.ledger, transfer.id, (read: Transfer): void => {
    const live: boolean = attemptStateOf(read) !== "failed";
    // It is checked against its approved quote, for a payment from another
    // currency's wallet, and against the account it was decided or approved for,
    // as when a look finds a transfer by request id. A failed one on a closed
    // invoice moved nothing, so it does not reopen it.
    if (checks !== undefined && before !== undefined && (live || before.state === "open" || before.state === "escalated")) {
      checks.decide(read);
    }
    twice = paidTwice(engine.ledger, invoiceId) !== undefined;
    // Live at the bank, but the ledger keeps it failed: another payment holds the lock.
    kept = live && engine.ledger.attemptOf(attempt.requestId, read.id)?.state === "failed";
    const state: ObligationState | undefined = engine.ledger.obligation(invoiceId)?.state;
    if (twice) {
      engine.ledger.escalate(invoiceId, LATE_TRANSFER_REASON);
    } else if (live && (state === "settled" || state === "rejected")) {
      engine.ledger.escalate(
        invoiceId,
        `${attempt.kind} ${read.short_reference_id} was found in Airwallex after the invoice was closed`,
      );
    }
    engine.ledger.lookNow(invoiceId);
  });
  if (checks !== undefined) {
    noteChecks(engine, invoiceId, checks);
  }
  const other: string = anyLive(engine.ledger.outsidePayouts(invoiceId))
    ? "A payout sent outside PayOnce for this invoice"
    : "Another payment PayOnce sent for this invoice";
  note(
    engine.ledger,
    invoiceId,
    twice ? "warning" : "bank",
    `${capitalise(attempt.kind)} payment PayOnce had marked failed is a transfer after all: Airwallex now lists ${describe(recorded)} under its request id${twice ? `. ${other} has not failed either, so the supplier may have been paid twice` : ""}${kept ? `. PayOnce still lists the ${attempt.kind} as failed, because it keeps one live payment per invoice` : ""}`,
  );
  return true;
}

// Looks in Airwallex for payouts for this invoice that PayOnce has not seen, and
// ties them to it: one whose reference names it, or one it nearlyPays whose
// reference names no invoice exactly. It runs before an original or a replacement
// goes out, so a payment someone made outside PayOnce is not paid a second time,
// even when the reference also nearly matches an older invoice. A transfer listed
// under the request id of one of its attempts marked failed with none on it is
// recorded on that attempt. A pending one is the look's own: it lists each by
// request id before this. True when it tied or recorded any.
async function linkUnseenPayouts(engine: Engine, invoiceId: string): Promise<boolean> {
  const obligation: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (obligation === undefined) {
    return false;
  }
  let linked: boolean = false;
  const transfers: Transfer[] = await listTransfersSince(
    engine.client,
    engine.ledger.startedAt(),
  );
  for (const transfer of transfers) {
    const late: Attempt | undefined = unrecordedAttemptOf(engine.ledger, transfer);
    if (late?.invoiceId === invoiceId && late.state === "failed") {
      linked = (await recordLateTransfer(engine, transfer)) || linked;
      continue;
    }
    if (engine.ledger.knowsTransfer(transfer.request_id ?? "", transfer.id)) {
      if (engine.ledger.attemptOf(transfer.request_id ?? "", transfer.id)?.invoiceId === invoiceId) {
        linked = noteMismatchedTransfer(engine, transfer) || linked;
      }
      continue;
    }
    const named: Obligation | undefined = engine.ledger.obligationForReference(
      transfer.reference ?? "",
    );
    if (named !== undefined ? named.invoiceId === invoiceId : nearlyPays(obligation, transfer)) {
      linked = linkOutsidePayout(engine, invoiceId, transfer, named !== undefined) || linked;
    }
  }
  return linked;
}

// Reads each outside payout the bank has not finished with, and notes any it has
// paid or failed since. Returns them all as they now stand.
async function syncOutsidePayouts(
  engine: Engine,
  invoiceId: string,
): Promise<OutsidePayout[]> {
  for (const payout of engine.ledger.outsidePayouts(invoiceId)) {
    if (payout.state === "paid" || payout.state === "failed") {
      continue;
    }
    const transfer: Transfer = await getTransfer(engine.client, payout.transferId);
    const state: PayoutState = originalStateOf(transfer);
    engine.ledger.recordOutsidePayout(payout.transferId, state, payoutMoney(transfer));
    if (state === payout.state) {
      continue;
    }
    if (state === "paid" || state === "failed") {
      note(engine.ledger, invoiceId, "bank", `Payout sent outside PayOnce ${describe(transfer)}`);
    }
    if (state === "failed") {
      railFailureSeen(engine.ledger, transfer, "look");
    }
  }
  return engine.ledger.outsidePayouts(invoiceId);
}

// A status PayOnce does not recognise counts as live.
function anyLive(payouts: OutsidePayout[]): boolean {
  return payouts.some((payout: OutsidePayout): boolean => payout.state !== "failed");
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
  noteSenders(ledger, obligation, emails);
}

// Reads the emails that arrived since the thread was last read, one at a time,
// and keeps the findings so later looks see the same result. One email at a time
// means an instruction in one cannot change how another is read. Findings only
// ever add caution: each read is ORed with what earlier reads found, so a later
// email cannot clear a finding. If the reader fails, the thread is marked unread
// so the policy escalates, and the count stays at the emails read so far, so the
// next look reads from the one that failed.
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

  let claimsNonReceipt: boolean = previous?.claimsNonReceipt === true;
  let asksForNewBankDetails: boolean = previous?.asksForNewBankDetails === true;
  let asksNotToPay: boolean = previous?.asksNotToPay === true;
  let readBy: string | undefined = previous?.readBy;
  let emailsRead: number = readCount;
  let unread: boolean = false;
  // What the emails read in this look said, apart from the invoice's findings so
  // far, so the timeline does not pin an earlier email's finding on a new one.
  let newNonReceipt: boolean = false;
  let newBankDetails: boolean = false;
  let newNotToPay: boolean = false;
  for (const email of thread.slice(readCount)) {
    try {
      const read: EmailFindings = await engine.reader.read([email]);
      newNonReceipt = newNonReceipt || read.claimsNonReceipt;
      newBankDetails = newBankDetails || read.asksForNewBankDetails;
      newNotToPay = newNotToPay || read.asksNotToPay === true;
      claimsNonReceipt = claimsNonReceipt || read.claimsNonReceipt;
      asksForNewBankDetails = asksForNewBankDetails || read.asksForNewBankDetails;
      asksNotToPay = asksNotToPay || read.asksNotToPay === true;
      readBy = read.readBy ?? engine.reader.name;
      emailsRead += 1;
    } catch (error: unknown) {
      unread = true;
      note(
        engine.ledger,
        invoiceId,
        "error",
        `Supplier emails could not be read: ${messageOf(error)}`,
      );
      break;
    }
  }
  const found: string = summarise(claimsNonReceipt, asksForNewBankDetails, asksNotToPay);
  const findings: StoredFindings = {
    claimsNonReceipt,
    asksForNewBankDetails,
    asksNotToPay,
    summary: !unread
      ? found
      : claimsNonReceipt || asksForNewBankDetails || asksNotToPay
        ? `${found}, and some emails could not be read`
        : UNREAD_SUMMARY,
    unverifiedSenders: sendersNotOnFile(obligation, thread),
    unread,
    emailsRead,
    ...(readBy === undefined ? {} : { readBy }),
  };
  engine.ledger.saveFindings(invoiceId, JSON.stringify(findings));
  const count: number = emailsRead - readCount;
  const said: string = summarise(newNonReceipt, newBankDetails, newNotToPay);
  const soFar: string = `Findings for this invoice so far: ${findings.summary}`;
  const which: string = `${count} ${readCount === 0 ? "" : "new "}${count === 1 ? "email" : "emails"}`;
  note(
    engine.ledger,
    invoiceId,
    "email",
    count === 0 ? soFar : said === findings.summary ? `Read ${which}: ${said}` : `Read ${which}: ${said}. ${soFar}`,
  );
}

// The floor as the cost line names it.
function floorText(floorMinor: number | null, currency: string): string {
  if (floorMinor === null) {
    return `no reserve floor is set for ${currency}`;
  }
  return Number.isFinite(floorMinor)
    ? `reserve floor ${formatMoney(floorMinor, currency)}`
    : "the reserve floor setting could not be read";
}

function quoteFits(fx: FxTerms, obligation: Obligation): boolean {
  return (
    fx.sellCurrency === obligation.sourceCurrency &&
    fx.buyCurrency === obligation.currency &&
    fx.buyAmountMinor === obligation.amountMinor
  );
}

// The quote a payment of this invoice from another currency's wallet is offered
// at. While an approval request is open, every look builds its terms on that
// request's own quote, so its binding holds still. Any other time it offers the
// invoice's last quote if no request has shown it and it holds long enough for
// one, so a look that opens no request takes no quote, and otherwise takes a
// fresh one. A new request never opens on a quote an earlier one showed.
// feeEstimateMinor is the fee the payment should cost, in the sell currency.
async function rateFor(
  engine: Engine,
  obligation: Obligation,
  feeEstimateMinor: number | null,
): Promise<Rate> {
  const latest: Approval | undefined = engine.ledger.latestApproval(obligation.invoiceId);
  const shown: FxTerms | undefined =
    latest === undefined ? undefined : (JSON.parse(latest.terms) as ApprovalTerms).fx;
  const open: FxTerms | undefined =
    latest !== undefined &&
    (latest.state === "requested" || latest.state === "approved") &&
    !isExpired(latest)
      ? shown
      : undefined;
  if (open !== undefined && quoteFits(open, obligation)) {
    return { fx: withFeeEstimate(open, feeEstimateMinor), fresh: false, endsAt: Number.NaN };
  }
  // Every request opens on the last quote, so only the latest can have shown it.
  // It is offered while a request opened on it would stay open at least as long
  // as an approval has to be used.
  const kept: string | undefined = engine.ledger.lastQuote(obligation.invoiceId);
  const last: LastQuote | undefined =
    kept === undefined ? undefined : (JSON.parse(kept) as LastQuote);
  if (
    last !== undefined &&
    last.fx.quoteId !== shown?.quoteId &&
    quoteFits(last.fx, obligation) &&
    last.endsAt - Date.now() > 2 * APPROVED_USE_WITHIN_MS + QUOTE_MARGIN_MS
  ) {
    return { fx: withFeeEstimate(last.fx, feeEstimateMinor), fresh: true, endsAt: last.endsAt };
  }
  const quote: Quote = await createQuote(
    engine.client,
    obligation.sourceCurrency,
    obligation.currency,
    toMajor(obligation.amountMinor),
    quoteValidity(),
  );
  const receivedAt: number = Date.now();
  const fx: FxTerms = fxTermsOf(quote, obligation, feeEstimateMinor);
  // This clock and Airwallex's may differ, so the quote is taken to hold no
  // longer than its validity counted from when it arrived.
  const validTo: number = Date.parse(quote.valid_to_at);
  const endsAt: number = Math.min(validTo, receivedAt + (validTo - Date.parse(quote.valid_from_at)));
  if (!(endsAt - receivedAt > APPROVED_USE_WITHIN_MS + QUOTE_MARGIN_MS)) {
    throw new Error(
      `The exchange rate quote Airwallex sent holds until ${quote.valid_to_at}, too briefly for an approval request, so PayOnce offers nothing on it`,
    );
  }
  const taken: LastQuote = { fx, endsAt };
  engine.ledger.saveQuote(obligation.invoiceId, JSON.stringify(taken));
  return { fx, fresh: true, endsAt };
}

// The day an invoice's arrival estimate counts from. While an approval request is
// requested or approved and has not expired, it is that request's day, so its
// binding holds past midnight. Otherwise it is today. awaitApproval never opens
// a new request on an estimate from another day.
function arrivalFrom(ledger: Ledger, invoiceId: string): string {
  const latest: Approval | undefined = ledger.latestApproval(invoiceId);
  const open: ArrivalTerms | undefined =
    latest !== undefined &&
    (latest.state === "requested" || latest.state === "approved") &&
    !isExpired(latest)
      ? (JSON.parse(latest.terms) as ApprovalTerms).arrival
      : undefined;
  return open?.from ?? today();
}

// When a payment of the invoice to these bank details usually arrives, or null
// when the invoice has no due date.
function arrivalOf(
  ledger: Ledger,
  obligation: Obligation,
  bankDetails: TransferBankDetails,
): ArrivalTerms | null {
  return obligation.dueDate === null
    ? null
    : arrivalFor(
        obligation.transferMethod,
        obligation.currency,
        bankDetails,
        obligation.dueDate,
        arrivalFrom(ledger, obligation.invoiceId),
      );
}

// What the decision line adds about when a replacement would arrive: only for an
// invoice with a due date whose original failed and no payout sent outside
// PayOnce may pay. It counts from today, also while an open request keeps the day
// it opened on.
function arrivalClause(assessment: Assessment): string {
  return assessment.arrival === null ||
    assessment.incident.originalState !== "failed" ||
    assessment.incident.outsidePayoutLive
    ? ""
    : `. ${replacementArrivalText(ifSentOn(assessment.arrival, today()))}`;
}

// The terms a new request opens on. Terms that kept an open request's arrival
// estimate, counted from a day that is not today, count from today. Only the
// dates change.
function countedFromToday<T extends ApprovalTerms>(terms: T): T {
  return terms.arrival !== undefined && terms.arrival.from !== today()
    ? withArrival(terms, ifSentOn(terms.arrival, today()))
    : terms;
}

// The email evidence a person sees and approves against. It names no address, so
// nothing a sender wrote reaches the binding.
function evidenceSummary(obligation: Obligation, assessment: Assessment): string {
  return emailEvidence(assessment.findings.summary, assessment.emails, obligation.supplierDomain);
}

// Approval terms counted the emails from this version on, and named no sender
// address. A request opened before then no longer matches its terms once the
// invoice has emails. This line says only why. What happens to the request, a
// new one or none, and whether approvals given on it still count, is said once,
// by the step that does it.
const EMAIL_COUNT: RegExp = /\b[0-9]+ emails? on file\b/;

function noteEvidenceUpgrade(engine: Engine, invoiceId: string, approval: Approval | undefined, emails: number): void {
  if (
    emails === 0 ||
    approval === undefined ||
    (approval.state !== "requested" && approval.state !== "approved") ||
    isExpired(approval)
  ) {
    return;
  }
  const terms: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  const evidence: string | undefined = terms.action === "replace" ? terms.evidence.emails : undefined;
  if (evidence === undefined || EMAIL_COUNT.test(evidence)) {
    return;
  }
  note(
    engine.ledger,
    invoiceId,
    "approval",
    `Approval terms now count the supplier emails on file and name no sender address, so the open ${approval.state === "approved" ? "approval" : "request"} no longer matches them`,
  );
}

async function assess(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<Assessment> {
  const original: Transfer = await getTransfer(engine.client, originalId);
  const emails: SupplierEmail[] = engine.ledger.emails(obligation.invoiceId);
  const { findings, stored }: { findings: StoredFindings; stored: boolean } = storedFindings(
    engine.ledger,
    obligation.invoiceId,
    emails,
  );
  const unverified: string[] = sendersNotOnFile(obligation, emails);
  // A replacement is paid by beneficiary id, so what counts is the account that
  // record points to now, not the one the original went to.
  const bankDetails: TransferBankDetails = await getBankDetails(
    engine.client,
    obligation.beneficiaryId,
  );
  // Read fresh on every look. The cash panel's cached balance never feeds a decision.
  const wallet: string = debitCurrency(obligation);
  // The original was paid from the same wallet, so its fee is in that currency. A
  // fee in any other is not added to it, and the policy then cannot read the cash.
  const feeMinor: number =
    original.fee_currency === undefined || original.fee_currency === wallet
      ? toMinor(original.fee_amount)
      : Number.NaN;
  // Counted before the balance is read, so a payment that gets its transfer in
  // between is counted twice, as committed and as debited, and never not at all.
  const committed: number = committedMinor(engine.ledger, wallet, {
    invoiceId: obligation.invoiceId,
  });
  const availableMinor: number = await getAvailableMinor(engine.client, wallet);
  const floorMinor: number | null = floorFor(engine.reserve, obligation);
  const originalState: OriginalTransferState = originalStateOf(original);
  const converts: boolean = crossCurrency(obligation);
  // A replacement from another wallet is priced on a quote, which the cash check
  // and the approval both go by. Only a failed original leaves one to price.
  const rate: Rate | null =
    converts && originalState === "failed"
      ? await rateFor(engine, obligation, Number.isFinite(feeMinor) ? feeMinor : null)
      : null;
  const incident: Incident = {
    invoiceId: obligation.invoiceId,
    supplier: obligation.supplier,
    currency: obligation.currency,
    amountMinor: obligation.amountMinor,
    crossCurrency: converts,
    sourceCurrency: wallet,
    sourceAmountMinor: converts ? (rate?.fx.sellAmountMinor ?? Number.NaN) : obligation.amountMinor,
    transferFeeMinor: feeMinor,
    originalState,
    bankOverdue: originalState === "in_flight" && isOverdue(original),
    resendCanFix: resendCanFix(original),
    sentOutsidePayOnce: obligation.origin === "outside",
    // The look that called this has just read them from Airwallex.
    outsidePayoutLive: anyLive(engine.ledger.outsidePayouts(obligation.invoiceId)),
    // Failed at the bank: a replacement the ledger keeps failed beside a live one
    // has not.
    replacementFailed: engine.ledger
      .attempts(obligation.invoiceId)
      .some(
        (attempt: Attempt): boolean =>
          attempt.kind === "replacement" && !liveAtBank(attempt),
      ),
    supplierReportsNonReceipt: findings.claimsNonReceipt === true,
    supplierAsksForNewBankDetails: findings.asksForNewBankDetails === true,
    supplierAsksNotToPay: findings.asksNotToPay === true,
    beneficiaryChanged: !sameBankDetails(
      original.beneficiary?.bank_details,
      bankDetails,
    ),
    emailFromUnverifiedSender: unverified.length > 0,
    emailsUnread: emailsNotRead(findings, stored, emails),
    emailPartlyUnread: emails.some((email: SupplierEmail): boolean => email.partial === true),
    availableBalanceMinor: availableMinor,
    committedMinor: committed,
    reserveFloorMinor: floorMinor,
    twoApproversAboveMinor: engine.approvals.twoApproversAboveMinor,
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
  // Money committed to other payments is taken off as well, so the numbers behind
  // a floor decision are on the timeline.
  if (
    incident.originalState === "failed" &&
    Number.isFinite(feeMinor) &&
    Number.isFinite(incident.sourceAmountMinor) &&
    (feeMinor > 0 || committed > 0)
  ) {
    const costMinor: number = incident.sourceAmountMinor + feeMinor;
    const afterMinor: number = availableMinor - committed - costMinor;
    const fee: string =
      feeMinor > 0 ? ` with a second ${formatMoney(feeMinor, wallet)} transfer fee` : "";
    const others: string =
      committed > 0
        ? `, and ${formatMoney(committed, wallet)} is committed to other payments not sent yet`
        : "";
    const replacement: string = converts ? `A replacement of ${money(obligation)}` : "A replacement";
    note(
      engine.ledger,
      obligation.invoiceId,
      floorMinor !== null && afterMinor >= floorMinor ? "payment" : "warning",
      `${replacement} costs ${formatMoney(costMinor, wallet)}${fee}${others}. Cash after it: ${formatMoney(afterMinor, wallet)}, ${floorText(floorMinor, wallet)}`,
      "cost",
    );
  }

  // Looked for whenever a replacement could be asked for, so every look, and so
  // every request, names it (namingPaidDuplicate).
  const paid: string | null =
    originalState === "failed" ? paidDuplicate(engine.ledger, obligation) : null;
  const decision: Decision = secondBill(decide(incident), paid);
  // Once an invoice has gone to a person, the policy no longer acts for itself.
  const held: string =
    obligation.state !== "escalated"
      ? ""
      : decision.action === "replace"
        ? ". This invoice was escalated, so it still needs a person's approval"
        : decision.action === "close"
          ? ". This invoice was escalated, so a person closes it"
          : "";
  const bankChange: BankChange | null = incident.beneficiaryChanged
    ? (engine.ledger.verifiedBankChange(obligation.beneficiaryId, bankDetails) ?? null)
    : null;
  const arrival: ArrivalTerms | null = arrivalOf(engine.ledger, obligation, bankDetails);
  const assessment: Assessment = {
    original,
    incident,
    findings,
    unverified,
    emails,
    bankDetails,
    bankChange,
    rate,
    arrival,
    decision,
    floor: null,
    paidDuplicate: paid,
  };
  // The arrival is advice for people. The policy decided without it. The ask not
  // to pay is named here as the request and the alert name it. The floor and a
  // paid second bill have standing warnings of their own (noteFloor, noteSecondBill).
  const said: string =
    decision.action === "escalate"
      ? namingNotToPay(decision.reason, incident.supplierAsksNotToPay)
      : decision.reason;
  note(
    engine.ledger,
    obligation.invoiceId,
    "decision",
    `${capitalise(decision.action)}: ${said}${held}${arrivalClause(assessment)}`,
    "decision",
  );
  return assessment;
}

// The first invoice this one looks like a second bill for that is paid, by
// PayOnce or by a payout sent outside it. Null when there is none.
function paidDuplicate(ledger: Ledger, obligation: Obligation): string | null {
  return (
    likelyDuplicates(ledger, obligation).find((other: ScannedObligation): boolean =>
      isPaid(ledger, other.invoiceId),
    )?.invoiceId ?? null
  );
}

function secondBillReason(invoiceId: string): string {
  return `it looks like a second bill for ${invoiceId}, which is paid`;
}

// A replacement for what looks like a second bill of a paid invoice goes to a
// person.
function secondBill(decision: Decision, paid: string | null): Decision {
  return paid !== null && decision.action === "replace"
    ? { action: "escalate", reason: secondBillReason(paid) }
    : decision;
}

// The beneficiary record no longer holds the account a payment was decided or
// approved for.
export class AccountChangedError extends Error {
  constructor(what: string) {
    super(
      `The supplier's bank details changed after the ${what}, so PayOnce sent nothing. Check again to look at the new details`,
    );
    this.name = "AccountChangedError";
  }
}

// A transfer is paid to the beneficiary record as it is when it is created, so a
// replacement first checks that the record still holds the account it was
// decided or approved for: every detail, by its full accountKey, so a change to
// any field after a decision or an approval stops the payment, and the next look
// decides or asks again. Throws AccountChangedError, sending nothing, when it
// does not. Gives the routeKey of the record it read, which the attempt opened
// next keeps.
async function requireAccount(
  engine: Engine,
  obligation: Obligation,
  accountKey: string,
  what: string,
): Promise<string> {
  const now: TransferBankDetails = await getBankDetails(engine.client, obligation.beneficiaryId);
  if (accountKeyOf(now) !== accountKey) {
    throw new AccountChangedError(what);
  }
  return routeKeyOf(now);
}



// A payment from another currency's wallet must go out on the quote a person
// approved. The money has moved by then, so a transfer at any other rate goes to
// a person, and only a person closes the invoice. Why it did not, or null.
function rateProblem(engine: Engine, attempt: Attempt, transfer: Transfer): string | null {
  if (attempt.quoteId === null) {
    return null;
  }
  // The approval the attempt was opened on, so a request another process opened
  // since does not count.
  const approval: Approval | undefined = engine.ledger.approvalOf(attempt);
  const approved: FxTerms | undefined =
    approval?.state === "used" ? (JSON.parse(approval.terms) as ApprovalTerms).fx : undefined;
  const problem: string | null = rateMismatch(
    approved?.quoteId === attempt.quoteId ? approved : undefined,
    transfer,
  );
  return problem === null ? null : `${attempt.kind} ${transfer.short_reference_id} ${problem}`;
}

// A transfer is paid to the beneficiary record as it is when it is created, which
// can change between the account check and the create call. One that went to
// other details than the attempt was decided or approved for is marked
// misdirected, so it never counts as the account PayOnce last paid this supplier,
// and goes to a person. So does one that shows no bank details, which nobody
// could check, as a transfer with no conversion fails the rate check. Why, or
// null when it went to the account it was meant for.
function accountMismatch(attempt: Attempt, transfer: Transfer): string | null {
  const sentTo: TransferBankDetails | undefined = transfer.beneficiary?.bank_details;
  if (attempt.accountKey === null || (sentTo !== undefined && accountKeyOf(sentTo) === attempt.accountKey)) {
    return null;
  }
  return sentTo === undefined
    ? `${attempt.kind} ${transfer.short_reference_id} shows no bank details, so PayOnce cannot check they are the ones it was decided or approved for`
    : `${attempt.kind} ${transfer.short_reference_id} went to bank details that are not the ones it was decided or approved for`;
}

// The checks a transfer gets wherever its attempt first gains it: when it is
// sent, when a retry creates it, when it is found by its request_id, and when it
// is found late under the request id of an attempt marked failed. decide writes
// what they find, the mismatch or misdirected mark and the escalation, in the
// transaction that records the transfer (see Decide), so a step that stops after
// the record, such as on a timeline line it could not write, never leaves a
// transfer recorded and unchecked. warnings holds the lines for what decide
// found, which noteChecks writes after the record.
interface TransferChecks {
  decide: Decide;
  warnings: string[];
}

function transferChecks(engine: Engine, obligation: Obligation, attempt: Attempt): TransferChecks {
  const warnings: string[] = [];
  return {
    warnings,
    decide: (transfer: Transfer): void => {
      warnings.length = 0;
      const rate: string | null = rateProblem(engine, attempt, transfer);
      if (rate !== null) {
        engine.ledger.markRateMismatch(attempt.requestId, rate);
        engine.ledger.escalate(obligation.invoiceId, rate);
        warnings.push(capitalise(rate));
      }
      const account: string | null = accountMismatch(attempt, transfer);
      if (account !== null) {
        engine.ledger.markMisdirected(attempt.requestId);
        engine.ledger.escalate(obligation.invoiceId, account);
        warnings.push(capitalise(account));
      }
    },
  };
}

function noteChecks(engine: Engine, invoiceId: string, checks: TransferChecks): void {
  for (const warning of checks.warnings) {
    note(engine.ledger, invoiceId, "warning", warning);
  }
}

// Sends an attempt already written to the ledger, to the account it keeps.
async function send(
  engine: Engine,
  obligation: Obligation,
  attempt: Attempt,
): Promise<Transfer> {
  const kind: AttemptKind = attempt.kind;
  const checks: TransferChecks = transferChecks(engine, obligation, attempt);
  let created: Transfer;
  try {
    created = await sendAttempt(engine.client, engine.ledger, obligation, attempt, "first", checks.decide);
  } catch (error: unknown) {
    throw new Error(
      wasRejected(error)
        ? `${capitalise(kind)} payment was refused and nothing was sent. ${messageOf(error)}`
        : `${capitalise(kind)} payment request did not complete, so the transfer may or may not exist. Run ${obligation.invoiceId} again to reconcile it. ${messageOf(error)}`,
      { cause: error },
    );
  }

  // Noted as soon as the transfer exists, so a later failure cannot hide it, and
  // after the checks recorded what they found with it. The fee is charged in the
  // wallet the payment left.
  const fee: string =
    created.fee_amount > 0
      ? `, plus a ${formatMoney(toMinor(created.fee_amount), created.fee_currency ?? obligation.sourceCurrency)} transfer fee`
      : "";
  note(
    engine.ledger,
    obligation.invoiceId,
    "payment",
    `${capitalise(kind)} ${created.short_reference_id} sent: ${money(obligation)} to ${obligation.supplier}${conversionText(created)}${fee}`,
  );
  noteChecks(engine, obligation.invoiceId, checks);
  const sentTo: TransferBankDetails | undefined = created.beneficiary?.bank_details;
  // When it usually arrives, counted from the day the transfer was created, which
  // is earlier than today for a pending attempt found by its request_id, against
  // the due date. Advice for people: nothing PayOnce decides reads it.
  const createdAt: number = Date.parse(created.created_at);
  const arrival: ArrivalTerms = arrivalFor(
    obligation.transferMethod,
    obligation.currency,
    sentTo,
    obligation.dueDate,
    Number.isNaN(createdAt) ? today() : today(new Date(createdAt)),
  );
  engine.ledger.setArrival(attempt.requestId, arrival);
  note(
    engine.ledger,
    obligation.invoiceId,
    atRisk(arrival) ? "warning" : "payment",
    sentArrivalText(`${capitalise(kind)} ${created.short_reference_id}`, arrival),
  );
  engine.bank?.sent(obligation.invoiceId, kind, created.id);
  return created;
}

// Closes the incident on the state the look read the invoice in. False, with
// nothing changed, when the ledger refuses (see settle).
function close(engine: Engine, invoiceId: string, from: ObligationState): boolean {
  if (!engine.ledger.settle(invoiceId, false, from)) {
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

// The time of the next look the agent takes by itself, in epoch milliseconds.
// Null when it waits for news or for a person.
type NextLook = number | null;

// What a look does when the ledger refused its close. A payment that went out at a
// rate nobody approved waits for a person, and so does an invoice the ledger no
// longer shows as paid once. By itself PayOnce never closes an invoice beside a
// live payout sent outside PayOnce, or a transfer under one of its request ids
// that does not match it which no person has cleared (see settle), so that one
// goes to a person too, open or not, and the close card offers it. One already
// with a person keeps its reason. Otherwise another process recorded a payment
// that may pay it a second time, or changed the invoice, since this look read it,
// and the next look, at once, decides as the ledger now stands.
function closeRefused(engine: Engine, invoiceId: string): NextLook {
  if (
    engine.ledger
      .attempts(invoiceId)
      .some((attempt: Attempt): boolean => attempt.rateMismatch !== null && liveAtBank(attempt))
  ) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      "Waiting on a person to check the exchange rate a payment went out at and close the incident. PayOnce will not send another payment",
      "waiting",
    );
    return null;
  }
  if (!engine.ledger.paidOnce(invoiceId)) {
    note(
      engine.ledger,
      invoiceId,
      "error",
      "The ledger does not show this invoice as paid once, so the incident stays open",
    );
    return null;
  }
  const outside: boolean = anyLive(engine.ledger.outsidePayouts(invoiceId));
  if (outside || coveredByClose(engine.ledger, invoiceId).length > 0) {
    const reason: string = outside
      ? OUTSIDE_PAYOUT_REASON
      : engine.ledger.attempts(invoiceId).some(mismatchedLive)
        ? MISMATCHED_TRANSFER_REASON
        : MISMATCHED_FAILED_REASON;
    if (engine.ledger.escalateIfOpen(invoiceId, reason)) {
      note(engine.ledger, invoiceId, "approval", closeWaitingLine(engine.ledger, invoiceId), "waiting");
    }
    return null;
  }
  return Date.now();
}

// What an invoice paid once waits for while only a person can close it. It names
// a live payout sent outside PayOnce, or else the transfers a person's close
// covers, so the person checks them first.
function closeWaitingLine(ledger: Ledger, invoiceId: string): string {
  if (anyLive(ledger.outsidePayouts(invoiceId))) {
    return "Waiting on a person. A payout sent outside PayOnce may also pay this invoice, which PayOnce has paid once. Check it with the supplier and close the incident. PayOnce will not send a second payment";
  }
  const references: string[] = coveredByClose(ledger, invoiceId).map(
    (transfer: CoveredTransfer): string => transfer.reference,
  );
  if (references.length === 0) {
    return "Waiting on a person to check with the supplier and close the incident. PayOnce will not send a second payment";
  }
  const one: boolean = references.length === 1;
  return `Waiting on a person to check ${one ? "transfer" : "transfers"} ${listOf(references)}, listed under this invoice's request ${one ? "id" : "ids"}, which ${one ? "does" : "do"} not match it, and close the incident. PayOnce will not send a second payment`;
}

const RETRY_FAILED_LOOK_MS: number = 60_000;

// Leaves the invoice waiting on the bank until the transfer's deadline, when the
// agent looks again if nothing has woken it before.
function waitForBank(
  engine: Engine,
  invoiceId: string,
  kind: AttemptKind,
  transfer: Transfer,
): NextLook {
  note(
    engine.ledger,
    invoiceId,
    "payment",
    kind === "replacement"
      ? `Waiting for the bank to pay replacement ${transfer.short_reference_id}. If it has not paid or failed it within ${describeDeadline(transfer)} of sending, a person hears about it`
      : `Waiting for the bank to pay or fail original ${transfer.short_reference_id}. If it has done neither within ${describeDeadline(transfer)} of sending, a person hears about it`,
    "waiting",
  );
  return deadlineLook(transfer);
}

// The look at a transfer's deadline. A deadline that cannot be read is due now,
// and the look then finds the transfer overdue.
function deadlineLook(transfer: Transfer): number {
  const deadline: number = deadlineOf(transfer);
  return Number.isFinite(deadline) ? deadline : Date.now();
}

export const REPLACEMENT_DEADLINE_REASON: string =
  "the bank has not paid or failed the replacement by its deadline";

// A replacement the bank sits on is never followed by another payment. A person
// hears about it, and the incident still closes if the bank pays it.
function replacementOverdue(
  engine: Engine,
  invoiceId: string,
  replacement: Transfer,
): NextLook {
  const reason: string = REPLACEMENT_DEADLINE_REASON;
  engine.ledger.escalate(invoiceId, reason);
  note(engine.ledger, invoiceId, "decision", `Escalate: ${reason}`, "decision");
  note(
    engine.ledger,
    invoiceId,
    "approval",
    `Waiting on a person. Replacement ${replacement.short_reference_id} is still with the bank, so PayOnce sends nothing more`,
    "waiting",
  );
  return null;
}

function termsOf(obligation: Obligation, assessment: Assessment): ReplacementTerms {
  return termsFor(
    obligation,
    assessment.original,
    assessment.decision,
    evidenceSummary(obligation, assessment),
    assessment.bankDetails,
    assessment.bankChange,
    assessment.rate?.fx ?? null,
    assessment.arrival,
  );
}

// The people who may not approve a payment of this invoice to the account with
// this accountKey, and why: whoever started the incident, and everyone who
// recorded a callback verifying that account. A name stored before names were
// checked that does not follow the name rule bars nobody (knownName): such a
// starter counts as not known, so signoffsNeeded asks for two approvers, and a
// payment to a callback-verified account needs two already.
function barredFrom(
  ledger: Ledger,
  obligation: Obligation,
  accountKey: string | undefined,
  routeKey: string | null = null,
): Barred[] {
  const barred: Barred[] = [];
  const starter: string | null = knownName(obligation.startedBy);
  if (starter !== null) {
    barred.push({
      name: starter,
      why: obligation.runRowId === null ? "started this incident" : "uploaded the pay run it came from",
    });
  }
  // The routeKey of the account, given or as the ledger keeps it with a request,
  // so a callback for the same account bars its recorder even when a bank name
  // changed since.
  const route: string | undefined =
    routeKey ?? (accountKey === undefined ? undefined : ledger.accountRoutes().get(accountKey));
  for (const detailsKey of ledger.appliedKeys(obligation.beneficiaryId)) {
    if (
      accountKey === undefined ||
      (keyHash(detailsKey) !== accountKey && (route === undefined || routeOfDetailsKey(detailsKey) !== route))
    ) {
      continue;
    }
    for (const stored of ledger.bankChangeRecorders(obligation.beneficiaryId, detailsKey)) {
      const name: string | null = knownName(stored);
      if (name !== null) {
        barred.push({ name, why: "recorded the callback for the new bank details" });
      }
    }
  }
  return barred;
}

function ruleFor(
  engine: Engine,
  obligation: Obligation,
  terms: ApprovalTerms,
  newAccount: boolean,
): SignoffRule {
  return signoffsNeeded(engine.approvals, paymentAmount(terms), newAccount, obligation.startedBy);
}

// Why an approval no longer covers the payment under the approval policy as it
// is now, or null when it still does.
function approvalProblem(
  engine: Engine,
  obligation: Obligation,
  rule: SignoffRule,
  approval: Approval,
): string | null {
  const approved: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  return signoffProblem(
    engine.approvals,
    rule,
    approval,
    paymentAmount(approved),
    barredFrom(engine.ledger, obligation, approved.accountKey),
  );
}

// Voids an approval that no longer covers the payment, and says why: it expired
// before it was used, the terms changed, or the approval policy as it is now
// refuses it. True when it was voided.
function voidIfStale(
  engine: Engine,
  obligation: Obligation,
  approval: Approval,
  current: ApprovalTerms,
  rule: SignoffRule,
): boolean {
  let why: string | null = null;
  if (isExpired(approval)) {
    why = "expired before it was used";
  } else if (bindingOf(current) !== approval.binding) {
    const approved: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
    why = `is void: ${changedFields(approved, current).join(", ")} changed`;
  } else {
    const problem: string | null = approvalProblem(engine, obligation, rule, approval);
    why = problem === null ? null : `is void: ${problem}`;
  }
  if (why === null) {
    return false;
  }
  engine.ledger.setApprovalState(approval.id, "void");
  note(engine.ledger, obligation.invoiceId, "approval", `Approval by ${approval.approver} ${why}`);
  return true;
}

// Nothing is sent while a payout for the invoice sent outside PayOnce may pay it.
function holdForOutsidePayout(engine: Engine, invoiceId: string): NextLook {
  if (engine.ledger.voidOpenApprovals(invoiceId)) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      "Approval request withdrawn: a payout for this invoice was sent outside PayOnce",
    );
  }
  note(
    engine.ledger,
    invoiceId,
    "approval",
    "Waiting on a person. A payout sent outside PayOnce may already pay this invoice, so PayOnce sends nothing",
    "waiting",
  );
  return null;
}

// A pending attempt is not sent again while a payout for the invoice sent outside
// PayOnce is live. It stays pending under its request id, which keeps the
// duplicate lock, so PayOnce opens no other payment for the invoice either. It is
// tried again on a look after that payout has failed.
function holdRetryForOutsidePayout(engine: Engine, invoiceId: string, attempt: Attempt): NextLook {
  engine.ledger.escalate(invoiceId, OUTSIDE_PAYOUT_REASON);
  note(
    engine.ledger,
    invoiceId,
    "warning",
    `${capitalise(attempt.kind)} payment not sent again: a payout for this invoice was sent outside PayOnce and may already pay it. The ${attempt.kind} stays open under its request id, and a later look sends it only if that payout fails`,
    "retry",
  );
  return holdForOutsidePayout(engine, invoiceId);
}

// Why a pending payment with no transfer goes to a person when the record no
// longer holds the account it was decided or approved for. A fixed string, as
// alerts post it.
export const ACCOUNT_CHANGED_REASON: string =
  "the supplier's bank details on file changed after this payment was decided or approved, so PayOnce does not send it again";

// The record no longer holds the account a pending payment was decided or
// approved for, so it is not sent again. Restoring those details in Airwallex
// lets the next look send it. Once it is marked failed, restoring them sends
// nothing by itself: the invoice is with a person like any other whose payment
// failed, held before paying for an original, or under the policy's bank-details
// rule for a replacement, and pays only on an approval. The waiting line says so
// until the next look, at once, says what the invoice waits on.
function accountChangedCause(engine: Engine, invoiceId: string, kind: AttemptKind): NeverSentCause {
  const hold = (): NextLook => {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      "Waiting on a person. The bank details on file are not the ones this payment was decided or approved for, so PayOnce does not send it again. Restore those details in Airwallex and check again to send it",
      "waiting",
    );
    return null;
  };
  return {
    payment: "the bank details on file are not the ones it was decided or approved for",
    then: "a person decides how to pay the invoice, or closes it without paying",
    reason: ACCOUNT_CHANGED_REASON,
    hold,
    afterFail: (): NextLook => {
      note(
        engine.ledger,
        invoiceId,
        "approval",
        `Waiting on a person. The ${kind} was marked failed without being sent, so restoring those details no longer sends it: paying this invoice now takes a person's approval, or a person closes it without paying`,
        "waiting",
      );
      return Date.now();
    },
  };
}

// When a pending attempt with no transfer counts as never sent: a bank deadline
// of its method after its latest create try, or after it was opened when it has
// had none. One with neither time on file is given a try time now, so it waits a
// full deadline and is never failed on the first look.
function neverSentAt(engine: Engine, obligation: Obligation, attempt: Attempt): number {
  let from: number = Date.parse(attempt.triedAt ?? attempt.openedAt ?? "");
  if (!Number.isFinite(from)) {
    from = Date.now();
    engine.ledger.tried(attempt.requestId, from);
  }
  return from + deadlineMinutes(obligation.transferMethod) * 60_000;
}

// What pays an invoice when a pending attempt with no transfer may never have
// been sent: a payout sent outside PayOnce that has paid it, a transfer found late
// that the bank has live, or a paid transfer under another attempt's request id
// that does not match the invoice. payment says so in PayOnce's words, then says what
// marking the attempt failed leaves, reason is why the invoice waits for a person
// meanwhile, hold how it waits, and afterFail what the look does once the attempt
// is marked failed.
interface NeverSentCause {
  payment: string;
  then: string;
  reason: string;
  hold: () => NextLook;
  afterFail: () => NextLook;
}

function paidOutsideCause(engine: Engine, invoiceId: string, paidBy: OutsidePayout): NeverSentCause {
  return {
    payment: `payout ${paidBy.reference} sent outside PayOnce has paid this invoice`,
    then: "a person can close the invoice",
    reason: OUTSIDE_PAYOUT_REASON,
    hold: (): NextLook => holdForOutsidePayout(engine, invoiceId),
    afterFail: (): NextLook => holdForOutsidePayout(engine, invoiceId),
  };
}

// The attempt is held while the late transfer may pay the invoice. Once it is
// marked failed, the duplicate lock is free, and the next look, at once, records
// the late transfer in its own state and follows it like any payment.
function lateTransferCause(engine: Engine, invoiceId: string, late: Attempt): NeverSentCause {
  const named: string = `${late.kind} ${late.reference ?? late.transferId ?? ""}`;
  return {
    payment: `${named}, found late, is live at the bank and may pay this invoice`,
    then: `${named} counts as this invoice's payment`,
    reason: LATE_TRANSFER_REASON,
    hold: (): NextLook => holdPaidTwice(engine, invoiceId, late),
    afterFail: (): NextLook => Date.now(),
  };
}

// A paid transfer under the request id of another attempt that does not match the
// invoice. Once the attempt is marked failed, a person can close the invoice from
// the close card.
function mismatchedCause(engine: Engine, invoiceId: string, mismatched: Attempt): NeverSentCause {
  const reference: string = mismatched.mismatchedReference ?? mismatched.mismatchedTransferId ?? "";
  return {
    payment: `transfer ${reference} under the failed ${mismatched.kind}'s request id is paid but does not match this invoice`,
    then: "a person can close the invoice",
    reason: MISMATCHED_TRANSFER_REASON,
    hold: (): NextLook => holdMismatched(engine, invoiceId, mismatched),
    afterFail: (): NextLook => holdMismatched(engine, invoiceId, mismatched),
  };
}

// A pending attempt with no transfer, on an invoice something else pays (cause).
// It is held as any retry is until neverSentAt, and the look comes back then.
// After that, if Airwallex still lists no transfer under its request id, it never
// became one: it is marked failed, which releases the duplicate lock. The attempt
// is read again, listed and failed under the lock of the wallet it pays from,
// which a retry holds from its create try to recording the transfer, so no try is
// under way meanwhile, and a try another process made since this look read it
// moves the deadline on. failAttempt changes only an attempt still pending with no
// transfer. A transfer listed by then is recorded by the next look, due at once.
async function failNeverSent(
  engine: Engine,
  obligation: Obligation,
  attempt: Attempt,
  cause: NeverSentCause,
): Promise<NextLook> {
  const invoiceId: string = obligation.invoiceId;
  const kind: string = capitalise(attempt.kind);
  engine.ledger.escalate(invoiceId, cause.reason);
  let deadline: number = neverSentAt(engine, obligation, attempt);
  if (Date.now() >= deadline) {
    const failed: boolean | number = await withCurrencyLock(
      engine.ledger,
      debitCurrency(obligation),
      async (): Promise<boolean | number> => {
        const now: Attempt | undefined = engine.ledger
          .attempts(invoiceId)
          .find((current: Attempt): boolean => current.requestId === attempt.requestId);
        if (now === undefined || now.state !== "pending" || now.transferId !== null) {
          return false;
        }
        const due: number = neverSentAt(engine, obligation, now);
        if (Date.now() < due) {
          return due;
        }
        return (
          (await findTransferByRequestId(engine.client, attempt.requestId)) === undefined &&
          engine.ledger.failAttempt(attempt.requestId, null, false)
        );
      },
    );
    if (failed === false) {
      return Date.now();
    }
    if (failed === true) {
      note(
        engine.ledger,
        invoiceId,
        "payment",
        `${kind} payment marked failed: Airwallex lists no transfer under its request id a bank deadline after it was last tried, and ${cause.payment}. PayOnce sent nothing for it, so ${cause.then}`,
        "retry",
      );
      return cause.afterFail();
    }
    deadline = failed;
  }
  note(
    engine.ledger,
    invoiceId,
    "warning",
    `${kind} payment not sent again: ${cause.payment}. If Airwallex still lists no transfer for the ${attempt.kind} at ${new Date(deadline).toISOString().slice(11, 16)} UTC, a bank deadline after it was last tried, PayOnce marks it failed and ${cause.then}`,
    "retry",
  );
  cause.hold();
  return deadline;
}

// When a request opened now on this quote stops covering a payment: its TTL, or
// earlier, so that an approval given at the last moment is used, or void, before
// the quote runs out.
function requestExpiry(engine: Engine, rate: Rate | null, now: number): number {
  const ttl: number = now + engine.approvals.expiresAfterMs;
  return rate === null ? ttl : Math.min(ttl, rate.endsAt - APPROVED_USE_WITHIN_MS - QUOTE_MARGIN_MS);
}

// "Quote for 4,000.00 EUR: 4,478.04 USD at 1 EUR = 1.119509 USD, ..." with the
// last request's rate when it was another.
function quoteLine(obligation: Obligation, fx: FxTerms, previous: FxTerms | undefined): string {
  const until: string = new Date(Date.parse(fx.validTo)).toISOString().slice(11, 16);
  const was: string =
    previous === undefined || previous.quoteId === fx.quoteId
      ? ""
      : `. The last request's quote was ${describeRate(previous)} (${formatMoney(previous.sellAmountMinor, previous.sellCurrency)})`;
  return `Quote for ${money(obligation)}: ${formatMoney(fx.sellAmountMinor, fx.sellCurrency)} at ${describeRate(fx)}, ${markupOf(fx)} from mid-market, held until ${until} UTC${was}`;
}

// Asks the approvers to approve a payment under the approval policy, and says
// what the invoice is waiting on. A request still open for the same terms is kept.
// Returns when the request expires, so the look then can open a new one. rate is
// the quote a payment from another currency's wallet is offered at, and a new
// request opens only on a quote this look took for it.
function awaitApproval(
  engine: Engine,
  obligation: Obligation,
  given: ApprovalTerms,
  rule: SignoffRule,
  rate: Rate | null,
  routeKey: string,
): NextLook {
  const invoiceId: string = obligation.invoiceId;
  let terms: ApprovalTerms = given;
  let binding: string = bindingOf(terms);

  // A request nobody on the list could approve would only expire and be opened
  // again, so none is opened until the approver list changes.
  const eligible: Approver[] = eligibleApprovers(
    engine.approvals,
    paymentAmount(terms),
    barredFrom(engine.ledger, obligation, terms.accountKey, routeKey),
  );
  if (engine.approvals.problem !== null || eligible.length < rule.needed) {
    if (engine.ledger.voidOpenApprovals(invoiceId)) {
      note(
        engine.ledger,
        invoiceId,
        "approval",
        "Approval request withdrawn: nobody on the approver list can approve it",
      );
    }
    const able: string =
      eligible.length === 0
        ? "nobody on the approver list can"
        : `only ${eligible.map((approver: Approver): string => approver.name).join(" and ")} can`;
    // No request opens, so no rate is named: only about what the payment takes
    // from its wallet, which the limits are compared with.
    const fx: string =
      terms.fx === undefined
        ? ""
        : `, about ${formatMoney(terms.fx.sellAmountMinor, terms.fx.sellCurrency)},`;
    const payment: string =
      terms.action === "replace"
        ? `A replacement of ${money(obligation)}${fx}`
        : `Paying ${money(obligation)} for this invoice${fx}`;
    note(
      engine.ledger,
      invoiceId,
      "approval",
      engine.approvals.problem !== null
        ? `Waiting on a person. Approvals are refused: ${engine.approvals.problem}`
        : `Waiting on a person. ${payment} needs ${rule.needed === 1 ? "one approver" : `${rule.needed} approvers, because ${rule.why},`} and ${able} approve it. Change APPROVERS, restart and check again`,
      "waiting",
    );
    return null;
  }

  let latest: Approval | undefined = engine.ledger.latestApproval(invoiceId);
  let sameRequest: boolean =
    latest?.state === "requested" && latest.binding === binding && latest.needed >= rule.needed;
  let opening: boolean = !sameRequest || latest === undefined || isExpired(latest);
  // Terms built on an open request's quote that now need a new request: that one
  // is withdrawn, and the next look, at once, takes a fresh quote for its own.
  if (opening && terms.fx !== undefined && rate?.fresh !== true) {
    const signed: Signoff[] = latest?.state === "requested" ? latest.signoffs : [];
    if (engine.ledger.voidOpenApprovals(invoiceId)) {
      note(
        engine.ledger,
        invoiceId,
        "approval",
        signed.length > 0
          ? `Approval by ${signersOf(signed)} no longer counts: the terms changed, so PayOnce takes a new exchange rate quote and opens a new request`
          : "Approval request withdrawn: the terms changed, so PayOnce takes a new exchange rate quote and opens a new request",
      );
    }
    return Date.now();
  }
  if (opening) {
    terms = countedFromToday(terms);
    binding = bindingOf(terms);
    // Another process may have opened today's request on these terms after the
    // look read the day an open request kept, so it is compared again.
    sameRequest =
      latest?.state === "requested" && latest.binding === binding && latest.needed >= rule.needed;
    opening = !sameRequest || latest === undefined || isExpired(latest);
  }
  const previous: FxTerms | undefined =
    latest === undefined ? undefined : (JSON.parse(latest.terms) as ApprovalTerms).fx;
  // A partly signed request that expired is reported as expired, even when the
  // terms have changed since. So is a request on a quote, which is replaced on a
  // fresh quote once it expires, so its terms differ even when nothing else
  // changed, and one with an arrival estimate, which may count from a new day.
  const expiredRequest: boolean =
    latest?.state === "requested" &&
    isExpired(latest) &&
    (sameRequest ||
      latest.signoffs.length > 0 ||
      terms.fx !== undefined ||
      terms.arrival !== undefined);
  if (expiredRequest && latest !== undefined) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      `Approval request expired before ${latest.signoffs.length === 0 ? "anyone approved it" : "enough people approved it"}, so PayOnce opened a new one`,
    );
  } else if (!sameRequest && latest?.state === "requested" && latest.signoffs.length > 0) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      `Approval by ${signersOf(latest.signoffs)} no longer counts: the terms changed, so PayOnce opened a new request`,
    );
  }
  if (opening) {
    const opened: boolean = engine.ledger.requestApproval(invoiceId, {
      binding,
      terms: JSON.stringify(terms),
      needed: rule.needed,
      neededWhy: rule.why,
      expiresAt: requestExpiry(engine, terms.fx === undefined ? null : rate, Date.now()),
      routeKey,
    });
    // Another process closed the invoice meanwhile.
    if (!opened) {
      return null;
    }
    // Written only for a quote a request opens on, so the timeline names no rate
    // nothing could be paid at.
    if (terms.fx !== undefined) {
      note(engine.ledger, invoiceId, "payment", quoteLine(obligation, terms.fx, previous));
    }
    latest = engine.ledger.latestApproval(invoiceId);
  }
  if (latest === undefined) {
    return null;
  }
  // A held invoice can be closed without paying instead.
  const payment: string = `${money(obligation)} to ${terms.payTo} (the account on file)${paidWith(terms.fx)}`;
  note(
    engine.ledger,
    invoiceId,
    "approval",
    terms.action === "replace"
      ? latest.needed === 1
        ? `Waiting on a person to approve ${payment}`
        : `Waiting on ${latest.needed} approvers for ${payment}, because ${latest.neededWhy}`
      : latest.needed === 1
        ? `Waiting on a person to approve paying ${payment}, or to close the invoice without paying`
        : `Waiting on ${latest.needed} approvers to pay ${payment}, because ${latest.neededWhy}, or on a person to close the invoice without paying`,
    "waiting",
  );
  return expiryOf(latest);
}

// A replacement is only on offer when the original has failed, and it goes to the
// beneficiary on file. A paid original leaves nothing to pay, so the person closes
// the incident. Any other escalation has no payment a person could approve yet.
// Returns when to look again: when an open request expires, so a new one can be
// opened.
// reason, when given, is the invoice's escalation reason in place of the
// decision's. Only an outage gives one, for a replacement the policy would send:
// the terms still come from that replace decision.
function escalate(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  reason: string | null = null,
): NextLook {
  // An invoice that is already with a person keeps the reason it went there for
  // when the policy would now do something else.
  engine.ledger.escalate(
    obligation.invoiceId,
    reason ??
      (assessment.decision.action === "escalate"
        ? assessment.decision.reason
        : obligation.escalationReason),
  );
  if (assessment.incident.outsidePayoutLive) {
    return holdForOutsidePayout(engine, obligation.invoiceId);
  }
  // An invoice already paid once, by the original or a replacement, has nothing
  // left to approve.
  const originalState: OriginalTransferState = originalStateOf(assessment.original);
  if (originalState === "paid" || engine.ledger.paidOnce(obligation.invoiceId)) {
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      closeWaitingLine(engine.ledger, obligation.invoiceId),
      "waiting",
    );
    return null;
  }
  if (originalState !== "failed") {
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      originalState === "in_flight"
        ? `Waiting on a person. Original ${assessment.original.short_reference_id} is still with the bank, so PayOnce sends nothing more`
        : "Waiting on a person",
      "waiting",
    );
    return null;
  }

  // A person closed it without paying, and continueEscalated could not close it
  // again, as when another process changed it meanwhile. Nobody is asked to
  // approve paying it.
  if (obligation.rejectedBy !== null) {
    if (engine.ledger.voidOpenApprovals(obligation.invoiceId)) {
      note(
        engine.ledger,
        obligation.invoiceId,
        "approval",
        `Approval request withdrawn: ${obligation.rejectedBy} closed this invoice without paying`,
      );
    }
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      `Waiting on a person. ${obligation.rejectedBy} closed this invoice without paying, so PayOnce asks nobody to approve paying it`,
      "waiting",
    );
    return null;
  }

  // An account the original did not go to is paid only once a person has called
  // the supplier on the number on file and the record matches what they confirmed.
  if (assessment.incident.beneficiaryChanged && assessment.bankChange === null) {
    if (engine.ledger.voidOpenApprovals(obligation.invoiceId)) {
      note(
        engine.ledger,
        obligation.invoiceId,
        "approval",
        "Approval request withdrawn: the bank details on file have not been verified by a callback",
      );
    }
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      obligation.supplierPhone === null
        ? "Waiting on a person. The bank details on file are not the ones the original went to, and no phone number is on file to verify them by calling the supplier back. Close the invoice without paying, or restore the details the original went to in Airwallex and check again"
        : `Waiting on a person to call the supplier on ${obligation.supplierPhone}, the number on file, and record the callback. PayOnce pays an account the original did not go to only after that`,
      "waiting",
    );
    noteFloor(engine, obligation, assessment, false);
    noteSecondBill(engine, obligation, assessment, false);
    return null;
  }

  const terms: ReplacementTerms = termsOf(obligation, assessment);
  const next: NextLook = awaitApproval(
    engine,
    obligation,
    terms,
    ruleFor(engine, obligation, terms, assessment.incident.beneficiaryChanged),
    assessment.rate,
    routeKeyOf(assessment.bankDetails),
  );
  // No request is open when nobody on the approver list could approve it, or when
  // a request on an old quote was withdrawn so the next look takes a fresh one. A
  // request awaitApproval opened just now counts its arrival from today.
  const latest: Approval | undefined = engine.ledger.latestApproval(obligation.invoiceId);
  const requested: boolean =
    latest?.state === "requested" &&
    !isExpired(latest) &&
    (latest.binding === bindingOf(terms) || latest.binding === bindingOf(countedFromToday(terms)));
  noteFloor(engine, obligation, assessment, requested);
  noteSecondBill(engine, obligation, assessment, requested);
  return next;
}

// Says that the floor reason was added to the policy's, and that the approval
// request says so too only when one is open.
function noteFloor(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  requested: boolean,
): void {
  if (assessment.floor === null) {
    return;
  }
  note(
    engine.ledger,
    obligation.invoiceId,
    "warning",
    requested
      ? `Also, ${assessment.floor}. The approval request says this too, and only an approval of that request releases a replacement`
      : `Also, ${assessment.floor}`,
    "floor",
  );
}

// Says that the invoice also looks like a second bill for a paid one when the
// policy sent it to a person for another reason, so the decision line did not
// say so.
function noteSecondBill(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  requested: boolean,
): void {
  const paid: string | null = assessment.paidDuplicate;
  if (paid === null || decide(assessment.incident).action === "replace") {
    return;
  }
  note(
    engine.ledger,
    obligation.invoiceId,
    "warning",
    requested
      ? `Also, ${secondBillReason(paid)}. The approval request says this too`
      : `Also, ${secondBillReason(paid)}`,
    "second-bill",
  );
}

// A replacement that takes cash below its floor, or that no floor can be checked
// for, is paid only on an approval whose request said so. The policy checks some
// reasons before the cash, such as a payment sent outside PayOnce, so when one of
// those sent the invoice to a person the floor reason is added to it. The request
// then names both, and an approval of terms that did not is void.
function namingFloor(assessment: Assessment): Assessment {
  const decision: Decision = assessment.decision;
  const incident: Incident = assessment.incident;
  if (
    decision.action !== "escalate" ||
    incident.originalState !== "failed" ||
    incident.outsidePayoutLive
  ) {
    return assessment;
  }
  const floor: string | null = floorReason(incident);
  if (floor === null || floor === decision.reason) {
    return assessment;
  }
  const clause: string = floor === NO_FLOOR_REASON ? NO_FLOOR_CLAUSE : floor;
  return {
    ...assessment,
    decision: { action: "escalate", reason: `${decision.reason}, and ${clause}` },
    floor: clause,
  };
}

// A replacement request names a paid invoice this one looks like a second bill
// for, whatever else sent it to a person, so the binding carries it and an
// approval given without it is void. It comes after the floor, so the policy's
// reason and the floor read as they do without one.
function namingPaidDuplicate(assessment: Assessment): Assessment {
  const decision: Decision = assessment.decision;
  const incident: Incident = assessment.incident;
  const paid: string | null = assessment.paidDuplicate;
  if (
    paid === null ||
    decision.action !== "escalate" ||
    incident.originalState !== "failed" ||
    incident.outsidePayoutLive ||
    decision.reason === secondBillReason(paid)
  ) {
    return assessment;
  }
  return {
    ...assessment,
    decision: { action: "escalate", reason: `${decision.reason}, and ${secondBillReason(paid)}` },
  };
}

// The policy escalates for a supplier who asks not to pay, unless a payout sent
// outside PayOnce or new bank details come first. Then the reason names the ask
// as well, last, so the request, the alert and the card say it. Nothing is added
// without the finding, so every other invoice keeps its terms and its binding.
function namingNotToPayIn(assessment: Assessment): Assessment {
  const decision: Decision = assessment.decision;
  if (decision.action !== "escalate") {
    return assessment;
  }
  const reason: string = namingNotToPay(decision.reason, assessment.incident.supplierAsksNotToPay);
  return reason === decision.reason ? assessment : { ...assessment, decision: { action: "escalate", reason } };
}

// namingFloor, namingPaidDuplicate and namingNotToPayIn, and a line on the
// timeline once the floor stops applying after a line said it applied. The line
// says an approval still counts only when an open request or approval named the
// floor.
function withFloorReason(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
): Assessment {
  const lastFloorLine: LedgerEvent | undefined = [...engine.ledger.events(obligation.invoiceId)]
    .reverse()
    .find((event: LedgerEvent): boolean => event.topic === "floor");
  if (floorReason(assessment.incident) === null && lastFloorLine?.kind === "warning") {
    const approval: Approval | undefined = engine.ledger.latestApproval(obligation.invoiceId);
    const above: string =
      "A replacement and its transfer fee would now leave cash above the reserve floor";
    note(
      engine.ledger,
      obligation.invoiceId,
      "payment",
      requestedDecision(obligation, assessment, approval) === undefined
        ? above
        : `${above}. An approval of a request that named the floor still counts`,
      "floor",
    );
  }
  return namingNotToPayIn(namingPaidDuplicate(namingFloor(assessment)));
}

// The decision an open request or approval was made under, when the floor applied
// then and does not now: cash was below it, could not be read, or no floor was
// set. Only the floor is changed, so the policy gives the reason it gave then.
// Undefined when no open request or approval named the floor.
function requestedDecision(
  obligation: Obligation,
  assessment: Assessment,
  approval: Approval | undefined,
): Decision | undefined {
  if (
    approval === undefined ||
    (approval.state !== "requested" && approval.state !== "approved") ||
    isExpired(approval) ||
    floorReason(assessment.incident) !== null
  ) {
    return undefined;
  }
  for (const floorMinor of [Number.MAX_SAFE_INTEGER, Number.NaN, null]) {
    const incident: Incident = { ...assessment.incident, reserveFloorMinor: floorMinor };
    const requested: Assessment = namingNotToPayIn(
      namingPaidDuplicate(
        namingFloor({ ...assessment, incident, decision: secondBill(decide(incident), assessment.paidDuplicate) }),
      ),
    );
    if (bindingOf(termsOf(obligation, requested)) === approval.binding) {
      return requested.decision;
    }
  }
  return undefined;
}

// The assessment as an open request or approval that named the floor saw it, so
// an approval given with less cash than there is now still covers the
// replacement. Otherwise the assessment as it is.
function asRequested(
  obligation: Obligation,
  assessment: Assessment,
  approval: Approval | undefined,
): Assessment {
  const decision: Decision | undefined = requestedDecision(obligation, assessment, approval);
  return decision === undefined ? assessment : { ...assessment, decision };
}

async function continueEscalated(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<NextLook> {
  // A person closed it without paying, and a payment found since reopened it. Once
  // every payment for it has failed at the bank, it is closed again and nobody is
  // asked to pay it.
  if (obligation.rejectedBy !== null && engine.ledger.rejectAgain(obligation.invoiceId)) {
    note(
      engine.ledger,
      obligation.invoiceId,
      "closed",
      `Closed without paying again. Every payment for this invoice has failed at the bank, and ${obligation.rejectedBy} had already closed it without paying`,
    );
    return null;
  }
  // Once an invoice has gone to a person, only an approval releases a payment and
  // only a person closes it, even if the policy would now do either unprompted.
  const assessed: Assessment = withFloorReason(
    engine,
    obligation,
    await assess(engine, obligation, originalId),
  );
  const approval: Approval | undefined = engine.ledger.latestApproval(
    obligation.invoiceId,
  );
  noteEvidenceUpgrade(engine, obligation.invoiceId, approval, assessed.emails.length);
  const assessment: Assessment = asRequested(obligation, assessed, approval);
  const current: ReplacementTerms = termsOf(obligation, assessment);
  const rule: SignoffRule = ruleFor(engine, obligation, current, assessment.incident.beneficiaryChanged);
  // A request that stays open keeps the terms it was opened with. A new one, after
  // a void or because more approvers are needed, gives the terms as they are now.
  if (approval?.state !== "approved") {
    return escalate(
      engine,
      obligation,
      approval?.state === "requested" && approval.needed >= rule.needed ? assessment : assessed,
    );
  }
  if (voidIfStale(engine, obligation, approval, current, rule)) {
    return escalate(engine, obligation, assessed);
  }
  // An approved payment on a rail with an outage waits with its approval, which
  // is neither spent nor void. useApproval refuses it too.
  const outage: Outage | undefined = engine.ledger.activeOutage(obligation.currency, obligation.transferMethod);
  if (outage !== undefined) {
    throw new RailOutageError(outage, "approved");
  }

  // A payout tied to the invoice now is looked at before anything is sent, and the
  // approval is left as it is until then. Another process may have tied one while
  // the list was being read.
  if (
    (await linkUnseenPayouts(engine, obligation.invoiceId)) ||
    anyLive(engine.ledger.outsidePayouts(obligation.invoiceId))
  ) {
    return Date.now();
  }
  // The currency lock is taken before anything is spent and held from the account
  // check to the recorded transfer, so a payment that cannot get its turn leaves
  // the approval unspent.
  return withCurrencyLock(engine.ledger, debitCurrency(obligation), async (lease: Lease): Promise<NextLook> => {
    // Checked before the approval is spent, so a failed check leaves it unspent.
    const route: string = await requireAccount(engine, obligation, current.accountKey, "replacement was approved");
    // One approval covers one attempt, so it is spent as the attempt is opened.
    // Another process may have voided it since it was read, recorded paid an
    // invoice this one looks like a second bill for since assess looked, or
    // delivered an email the approval did not see. Then nothing is spent, and the
    // next look names that invoice, or reads that email, in a new request.
    const attempt: Attempt | undefined = engine.ledger.useApproval(
      obligation.invoiceId,
      approval.id,
      lease,
      (): boolean =>
        paidDuplicate(engine.ledger, obligation) === assessment.paidDuplicate &&
        engine.ledger.emailCount(obligation.invoiceId) === assessment.emails.length,
      route,
    );
    if (attempt === undefined) {
      return Date.now();
    }
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      `Approval by ${approval.approver} matches the current terms`,
    );
    const replacement: Transfer = await send(engine, obligation, attempt);
    return waitForBank(engine, obligation.invoiceId, "replacement", replacement);
  });
}

// What the ledger shows of the invoices a held one looks like a second bill for,
// listed or found now: each one's state and the payments for it that reached the
// bank. duplicateEvidence reads its terms from these, so a release compares this
// under the lease with what it was when the terms were taken.
function duplicatesOnFile(ledger: Ledger, held: Obligation): string {
  const found: string[] = likelyDuplicates(ledger, held).map(
    (other: ScannedObligation): string => other.invoiceId,
  );
  return JSON.stringify(
    [...new Set([...held.duplicateOf, ...found])].map((invoiceId: string): unknown[] => [
      invoiceId,
      ledger.obligation(invoiceId)?.state ?? null,
      [...ledger.attempts(invoiceId), ...ledger.outsidePayouts(invoiceId)]
        .filter((payment: { transferId: string | null }): boolean => payment.transferId !== null)
        .map((payment: { transferId: string | null; state: string }): string[] => [
          payment.transferId ?? "",
          payment.state,
        ]),
    ]),
  );
}

// The invoices a held one looks like a second bill for, as they stand now, and
// whether the payment that paid each, or one still with the bank, went to the
// account with this accountKey.
async function duplicateEvidence(
  engine: Engine,
  obligation: Obligation,
  accountKey: string,
): Promise<DuplicateEvidence[]> {
  const evidence: DuplicateEvidence[] = [];
  for (const invoiceId of obligation.duplicateOf) {
    const other: Obligation | undefined = engine.ledger.obligation(invoiceId);
    if (other === undefined) {
      continue;
    }
    const payments: { reference: string | null; transferId: string | null; state: string }[] = [
      ...engine.ledger.attempts(invoiceId),
      ...engine.ledger.outsidePayouts(invoiceId),
    ].filter((payment: { transferId: string | null }): boolean => payment.transferId !== null);
    const paid: { reference: string | null; transferId: string | null } | undefined = payments.find(
      (payment: { state: string }): boolean => payment.state === "paid",
    );
    const sent: { transferId: string | null } | undefined =
      paid ?? payments.find((payment: { state: string }): boolean => payment.state === "in_flight");
    let sameAccount: boolean | null = null;
    if (sent !== undefined && sent.transferId !== null) {
      const details: TransferBankDetails | undefined = (
        await getTransfer(engine.client, sent.transferId)
      ).beneficiary?.bank_details;
      sameAccount = details === undefined ? null : accountKeyOf(details) === accountKey;
    }
    evidence.push({ invoiceId, state: other.state, paidBy: paid?.reference ?? null, sameAccount });
  }
  return evidence;
}

// True when a payment for the invoice, PayOnce's or one sent outside it, is paid.
function isPaid(ledger: Ledger, invoiceId: string): boolean {
  return (
    ledger.attempts(invoiceId).some((attempt: Attempt): boolean => attempt.state === "paid") ||
    ledger.outsidePayouts(invoiceId).some((payout: OutsidePayout): boolean => payout.state === "paid")
  );
}

// True for an invoice with a person that has sent nothing: PayOnce held it before
// paying, or Airwallex refused every payment it was sent with.
export function heldBeforePaying(ledger: Ledger, obligation: Obligation): boolean {
  return (
    obligation.state === "escalated" &&
    ledger
      .attempts(obligation.invoiceId)
      .every((attempt: Attempt): boolean => attempt.transferId === null && attempt.state === "failed")
  );
}

function listOf(invoiceIds: string[]): string {
  return invoiceIds.length <= 1
    ? (invoiceIds[0] ?? "")
    : `${invoiceIds.slice(0, -1).join(", ")} and ${invoiceIds.at(-1)}`;
}

// The reason a pay run row is held at send when paying it would take cash below
// the floor. It stays the same whatever the numbers, so it does not void an
// approval by its wording.
export const CASH_HOLD_REASON: string =
  "paying it now would take cash below the reserve floor";

function waitingForFirst(ledger: Ledger, invoiceId: string): Obligation | undefined {
  const now: Obligation | undefined = ledger.obligation(invoiceId);
  return now?.state === "open" && ledger.attempts(invoiceId).length === 0 ? now : undefined;
}

// What startPayment found once every check had run: an attempt to send, or a
// reason to hold the invoice, written already. sameNumber lists the invoices in
// duplicateOf that only share its number, for another amount or currency.
type FirstPayment =
  | { kind: "send"; obligation: Obligation; attempt: Attempt }
  | { kind: "held"; duplicateOf: string[]; sameNumber: string[]; reason: string; detail: string | null };

// Puts a hold startPayment wrote on the timelines, after its transaction.
function noteHold(engine: Engine, invoiceId: string, held: Extract<FirstPayment, { kind: "held" }>): void {
  note(engine.ledger, invoiceId, "decision", `Escalate: ${held.reason}`, "decision");
  if (held.detail !== null) {
    note(engine.ledger, invoiceId, "warning", held.detail, "cost");
  }
  for (const other of held.duplicateOf) {
    note(
      engine.ledger,
      other,
      "warning",
      held.sameNumber.includes(other)
        ? `${invoiceId} has the same invoice number as this invoice, for the same supplier, so PayOnce held it before paying`
        : `${invoiceId} looks like a second bill for this invoice, so PayOnce held it before paying`,
    );
  }
}

// Why a pay run row waits for a person when the record no longer holds the
// account the run was approved for. A fixed string, as the supplier view tests it.
export const RUN_ACCOUNT_CHANGED_REASON: string =
  "its bank details changed after the pay run was approved";

// Why a pay run row is not sent to the record as it is now, or null when the
// record still holds the account the run was approved for.
async function accountProblem(
  engine: Engine,
  obligation: Obligation,
  account: AccountRef,
): Promise<{ problem: string | null; route: string | null }> {
  const record: BeneficiaryRecord | undefined = await findBeneficiary(
    engine.client,
    obligation.beneficiaryId,
  );
  const details: TransferBankDetails | undefined = record?.beneficiary?.bank_details;
  if (details === undefined) {
    return { problem: "the beneficiary is no longer in Airwallex", route: null };
  }
  return accountKeyOf(details) === account.accountKey
    ? { problem: null, route: routeKeyOf(details) }
    : { problem: RUN_ACCOUNT_CHANGED_REASON, route: null };
}

// Why a first payment to the record as it is now waits for a person because of
// where PayOnce last paid this supplier, or null. LAST_PAID_CHANGED_REASON when
// the record no longer holds the account of PayOnce's last checked payment to
// it, whether or not a callback verified the one it holds: continueHeld then
// waits for a callback, and once there is one needs two approvers and bars
// whoever recorded it. UNCONFIRMED_ACCOUNT_REASON when PayOnce paid this
// supplier only before it kept which account each payment went to. A supplier
// PayOnce has never paid is not held for this. Reads only the ledger.
function lastPaidHold(ledger: Ledger, obligation: Obligation, record: TransferBankDetails): string | null {
  const last: LastPaid | undefined = ledger.lastPaidTransfer(obligation.beneficiaryId);
  if (last !== undefined) {
    return holdsAccount(last, record) ? null : LAST_PAID_CHANGED_REASON;
  }
  return ledger.lastPaidUnchecked(obligation.beneficiaryId) === undefined ? null : UNCONFIRMED_ACCOUNT_REASON;
}

// Why a new invoice is held before paying because of other invoices: it looks
// like a second bill for one, it has the number of another invoice to the same
// supplier, for any amount, or a payout for it sent outside PayOnce is live.
// Undefined when none of these holds. Reads only the ledger, so it runs in the
// transaction that would open the attempt.
function heldForOthers(
  ledger: Ledger,
  obligation: Obligation,
): Extract<FirstPayment, { kind: "held" }> | undefined {
  const duplicates: string[] = likelyDuplicates(ledger, obligation).map(
    (other: ScannedObligation): string => other.invoiceId,
  );
  const sameNumber: string[] = sameNumberForSupplier(ledger, obligation)
    .map((other: ScannedObligation): string => other.invoiceId)
    .filter((other: string): boolean => !duplicates.includes(other));
  const duplicateOf: string[] = [...duplicates, ...sameNumber];
  if (duplicateOf.length === 0 && !anyLive(ledger.outsidePayouts(obligation.invoiceId))) {
    return undefined;
  }
  const reason: string =
    duplicates.length > 0
      ? `it looks like a second bill for ${listOf(duplicates)}: the same supplier and amount, and the same invoice number apart from case, spacing, leading zeros or letters added at the end`
      : sameNumber.length > 0
        ? `it has the same invoice number as ${listOf(sameNumber)}, apart from case, spacing, leading zeros or letters added at the end, for the same supplier, and PayOnce pays an invoice number once`
        : OUTSIDE_PAYOUT_REASON;
  return { kind: "held", duplicateOf, sameNumber, reason, detail: null };
}

// Sends a new invoice's original, unless it looks like a second bill for an
// invoice the ledger already has, has the number of another invoice to the same
// supplier, a payout for it sent outside PayOnce may already pay it, or it is
// paid from another currency's wallet, so a person approves the rate. Then it
// holds the invoice for a person, sends nothing and returns null. accountKey is
// the account a pay run approved, and a pay run's row is held too when the
// record no longer holds it, or when paying it would take cash below the floor.
// Any other first payment is decided on the record as it is read here, and is
// held when PayOnce last paid this supplier another account, even one a callback
// verified, or paid it only before it kept which account each payment went to
// (lastPaidHold). A supplier PayOnce has never paid is not held for this. The
// attempt keeps the account either way, so every retry is checked against it.
// A pay run's row is never paid from another currency's wallet. Call it in the
// invoice's turn.
//
// It holds the currency lock of the wallet the money leaves throughout. The reads
// from Airwallex come first, with the beneficiary record last, and every check
// after them runs in the transaction that opens the attempt, so nothing is
// awaited between the last check and the attempt. When it throws, the next look
// comes a minute later and tries again: it sends the original if no attempt was
// opened, and retries a pending one under its request_id.
export async function startPayment(
  engine: Engine,
  obligation: Obligation,
  account: AccountRef | null = null,
): Promise<Transfer | null> {
  const invoiceId: string = obligation.invoiceId;
  if (waitingForFirst(engine.ledger, invoiceId) === undefined) {
    throw new Error(`${invoiceId} is not waiting for its first payment`);
  }
  // Pay runs do not pay across currencies: a row pays in its own currency from
  // that currency's wallet.
  if (obligation.runRowId !== null && crossCurrency(obligation)) {
    throw new Error(
      `${invoiceId} is a pay run row paid from ${obligation.sourceCurrency}, and a pay run pays each row from its own currency's wallet, so PayOnce sent nothing`,
    );
  }
  const wallet: string = debitCurrency(obligation);
  try {
    // A first payment on a rail with an outage waits, unsent and with no attempt,
    // and every check runs once the outage has ended. openAttempt refuses it too.
    const outage: Outage | undefined = engine.ledger.activeOutage(obligation.currency, obligation.transferMethod);
    if (outage !== undefined) {
      throw new RailOutageError(outage, "original");
    }
    return await withCurrencyLock(engine.ledger, wallet, async (lease: Lease): Promise<Transfer | null> => {
      // A pay run's row is held to the floor. A single incident's original is not.
      // The money committed elsewhere is counted before the balance read and again
      // in the transaction.
      const before: Map<string, number> = committedByInvoice(engine.ledger, wallet, { invoiceId });
      const availableMinor: number | null =
        obligation.runRowId === null ? null : await getAvailableMinor(engine.client, wallet);
      await linkUnseenPayouts(engine, invoiceId);
      // Read last, so the record is checked as close to the attempt as a read
      // from Airwallex can be.
      const record: TransferBankDetails | undefined =
        account === null
          ? (await findBeneficiary(engine.client, obligation.beneficiaryId))?.beneficiary?.bank_details
          : undefined;
      const checked: { problem: string | null; route: string | null } =
        account !== null
          ? await accountProblem(engine, obligation, account)
          : record === undefined
            ? { problem: "the beneficiary is no longer in Airwallex", route: null }
            : { problem: null, route: routeKeyOf(record) };
      const wrongAccount: string | null = checked.problem;
      const decidedKey: string | null = account?.accountKey ?? (record === undefined ? null : accountKeyOf(record));

      const first: FirstPayment = engine.ledger.transaction((): FirstPayment => {
        // Another process may have held or paid it while Airwallex was read.
        const now: Obligation | undefined = waitingForFirst(engine.ledger, invoiceId);
        if (now === undefined) {
          throw new Error(`${invoiceId} is not waiting for its first payment`);
        }
        if (wrongAccount !== null) {
          engine.ledger.holdBeforePaying(invoiceId, [], wrongAccount);
          return { kind: "held", duplicateOf: [], sameNumber: [], reason: wrongAccount, detail: null };
        }
        const held: Extract<FirstPayment, { kind: "held" }> | undefined = heldForOthers(engine.ledger, now);
        if (held !== undefined) {
          engine.ledger.holdBeforePaying(invoiceId, held.duplicateOf, held.reason);
          return held;
        }
        // An account PayOnce has not paid this supplier, when it has paid them
        // another, waits for a person, as a replacement does: a callback first,
        // then two approvers. So does any account of a supplier PayOnce paid only
        // before it kept which account each payment went to.
        const lastPaid: string | null = record === undefined ? null : lastPaidHold(engine.ledger, now, record);
        if (lastPaid !== null) {
          engine.ledger.holdBeforePaying(invoiceId, [], lastPaid);
          return { kind: "held", duplicateOf: [], sameNumber: [], reason: lastPaid, detail: null };
        }
        // A supplier who wrote before anything was paid may be asking not to pay
        // it, or to pay elsewhere, so a person reads the email first. That
        // includes a pay run row waiting its turn.
        if (engine.ledger.emailCount(invoiceId) > 0) {
          engine.ledger.holdBeforePaying(invoiceId, [], EMAILS_BEFORE_PAYMENT_REASON);
          return { kind: "held", duplicateOf: [], sameNumber: [], reason: EMAILS_BEFORE_PAYMENT_REASON, detail: null };
        }
        // The agent never pays at a rate nobody has seen, so this is the least
        // serious reason to hold it and comes after the others.
        if (crossCurrency(now)) {
          const reason: string = `it is paid from ${now.sourceCurrency}, so a person approves the exchange rate before PayOnce pays it`;
          engine.ledger.holdBeforePaying(invoiceId, [], reason);
          return { kind: "held", duplicateOf: [], sameNumber: [], reason, detail: null };
        }
        if (availableMinor !== null) {
          const short: string | null = floorBreach(engine, now, availableMinor, before);
          if (short !== null) {
            engine.ledger.holdBeforePaying(invoiceId, [], CASH_HOLD_REASON);
            return { kind: "held", duplicateOf: [], sameNumber: [], reason: CASH_HOLD_REASON, detail: short };
          }
        }
        return {
          kind: "send",
          obligation: now,
          attempt: engine.ledger.openAttempt(invoiceId, "original", lease, null, decidedKey, checked.route),
        };
      });
      if (first.kind === "held") {
        noteHold(engine, invoiceId, first);
        return null;
      }
      try {
        const original: Transfer = await send(engine, first.obligation, first.attempt);
        // The look at its deadline is planned as soon as it is with the bank, so it
        // comes even if nothing wakes the invoice before, for example when the
        // sandbox bank's script fails.
        engine.ledger.lookAt(invoiceId, deadlineLook(original));
        return original;
      } catch (error: unknown) {
        const refused: Attempt | undefined = engine.ledger.attempts(invoiceId).at(-1);
        if (refused?.state !== "failed" || refused.transferId !== null) {
          throw error;
        }
        note(engine.ledger, invoiceId, "error", messageOf(error));
        holdRefused(engine, first.obligation, refused);
        return null;
      }
    });
  } catch (error: unknown) {
    // The transfer may exist, or nothing was opened at all, for example when the
    // lock never came free. A look tries again a minute later, as after a look
    // that failed, so an invoice started from the page is never left with no
    // payment and no look.
    const at: number = Date.now();
    engine.ledger.postponeDueLook(invoiceId, at, at + RETRY_FAILED_LOOK_MS);
    throw error;
  }
}

// What is wrong with paying a pay run's row now, against the floor of its
// currency, or null when it fits. Money promised elsewhere is taken off,
// including the run's other rows not sent yet. A currency with no floor set does
// not stop a row, because a person approved the run.
function floorBreach(
  engine: Engine,
  obligation: Obligation,
  availableMinor: number,
  committedBefore: Map<string, number>,
): string | null {
  const wallet: string = debitCurrency(obligation);
  const floorMinor: number | null = floorFor(engine.reserve, obligation);
  if (floorMinor === null) {
    return null;
  }
  if (!Number.isFinite(floorMinor)) {
    return "The reserve floor setting could not be read, so PayOnce did not pay this invoice";
  }
  const feeMinor: number = engine.ledger.latestFee(wallet, obligation.transferMethod) ?? 0;
  const afterMinor: number =
    availableMinor -
    committedAcross(
      committedBefore,
      committedByInvoice(engine.ledger, wallet, { invoiceId: obligation.invoiceId }),
    ) -
    obligation.amountMinor -
    feeMinor;
  return afterMinor >= floorMinor
    ? null
    : `Paying it now would leave ${formatMoney(afterMinor, wallet)}, ${formatMoney(floorMinor - afterMinor, wallet)} below the reserve floor of ${formatMoney(floorMinor, wallet)}`;
}

// Airwallex refused every original the invoice was sent with, so nothing was
// paid. It goes to a person and pays only on an approval, like a held invoice.
function holdRefused(engine: Engine, obligation: Obligation, refused: Attempt): Obligation {
  const reason: string = `Airwallex refused the original payment${refused.failureCode === null ? "" : ` (${refused.failureCode})`}, so nothing was sent`;
  engine.ledger.escalate(obligation.invoiceId, reason);
  note(engine.ledger, obligation.invoiceId, "decision", `Escalate: ${reason}`, "decision");
  return { ...obligation, state: "escalated", escalationReason: reason };
}

// An invoice held before paying waits for a person. Once the approvers approve
// paying it, the agent sends the original and the invoice carries on like any
// other. A person can instead close it without paying. A payout for it sent
// outside PayOnce holds everything, as it does on any invoice.
async function continueHeld(engine: Engine, obligation: Obligation): Promise<NextLook> {
  const invoiceId: string = obligation.invoiceId;
  if (anyLive(await syncOutsidePayouts(engine, invoiceId))) {
    return holdForOutsidePayout(engine, invoiceId);
  }
  // A person decided not to pay it, and a payout sent outside PayOnce reopened it.
  // That payout has failed, so it is closed again and nobody is asked to pay it.
  // A transfer found under one of its request ids that does not match it leaves
  // that to a person, on the close card.
  if (obligation.rejectedBy !== null) {
    if (engine.ledger.rejectAgain(invoiceId)) {
      note(
        engine.ledger,
        invoiceId,
        "closed",
        `Closed without paying again. The payout sent outside PayOnce failed, and ${obligation.rejectedBy} had already closed this invoice without paying`,
      );
    } else {
      note(
        engine.ledger,
        invoiceId,
        "approval",
        `Waiting on a person to close it again. ${obligation.rejectedBy} closed this invoice without paying, and PayOnce asks nobody to approve paying it`,
        "waiting",
      );
    }
    return null;
  }
  // A held invoice reads its emails like any other, and its terms carry what
  // they say. Until every email is read, nothing is offered for approval, and
  // the look comes again a minute later.
  await readNewEmails(engine, obligation);
  const emails: SupplierEmail[] = engine.ledger.emails(invoiceId);
  const { findings, stored }: { findings: StoredFindings; stored: boolean } = storedFindings(
    engine.ledger,
    invoiceId,
    emails,
  );
  // A supplier who asks to hold, cancel or not pay the invoice is named in the
  // reason it is held for, so the alert, the request and the card say so.
  const reason: string = namingNotToPay(obligation.escalationReason, findings.asksNotToPay === true);
  if (reason !== obligation.escalationReason) {
    // Another process changed the reason or the invoice since this look read it.
    // Terms built on the reason read would open a request the next look voids, so
    // the look comes again at once and reads the invoice as it is then.
    if (!engine.ledger.rewordEscalation(invoiceId, obligation.escalationReason, reason)) {
      return Date.now();
    }
    note(engine.ledger, invoiceId, "decision", `Escalate: ${reason}`, "decision");
  }
  if (emailsNotRead(findings, stored, emails)) {
    // An email delivered by another process while the others were read is read
    // on the next look, at once. One the reader failed on is tried a minute later.
    const failed: boolean = findings.unread === true;
    waitWithoutPaying(
      engine,
      invoiceId,
      EMAILS_NOT_READ,
      failed
        ? "Waiting on a person. Supplier emails are on file that PayOnce could not read yet, so it asks nobody to approve paying this invoice. It tries reading them again in a minute"
        : "Waiting on a person. A supplier email arrived while PayOnce read the others, so it asks nobody to approve paying this invoice until it has read that one too",
    );
    return failed ? Date.now() + RETRY_FAILED_LOOK_MS : Date.now();
  }
  const evidence: string | null =
    emails.length === 0 ? null : emailEvidence(findings.summary, emails, obligation.supplierDomain);
  // The invoices it was held for, and any that match it now: one started after
  // it, or one that came first while this one was held for another reason.
  const added: string[] = likelyDuplicates(engine.ledger, obligation)
    .map((other: ScannedObligation): string => other.invoiceId)
    .filter((other: string): boolean => !obligation.duplicateOf.includes(other));
  const held: Obligation = {
    ...obligation,
    escalationReason: reason,
    duplicateOf: [...obligation.duplicateOf, ...added],
  };
  if (added.length > 0) {
    engine.ledger.setDuplicateOf(invoiceId, held.duplicateOf);
    note(
      engine.ledger,
      invoiceId,
      "warning",
      `This invoice also looks like a second bill for ${listOf(added)}: the same supplier and amount, and the same invoice number apart from case, spacing, leading zeros or letters added at the end`,
    );
  }
  const record: BeneficiaryRecord | undefined = await findBeneficiary(
    engine.client,
    obligation.beneficiaryId,
  );
  const bankDetails: TransferBankDetails | undefined = record?.beneficiary?.bank_details;
  if (bankDetails === undefined) {
    return waitWithoutPaying(
      engine,
      invoiceId,
      "the beneficiary is no longer in Airwallex",
      "Waiting on a person. The beneficiary is no longer in Airwallex, so there is nothing to pay it to. Close the invoice without paying",
    );
  }
  const accountKey: string = accountKeyOf(bankDetails);
  // A pay run approved one account, every detail of it. Another is paid only once
  // a callback verified it, and then by two approvers.
  const row: RunRow | undefined =
    obligation.runRowId === null ? undefined : engine.ledger.runRow(obligation.runRowId);
  if (
    row !== undefined &&
    row.accountKey !== accountKey &&
    engine.ledger.verifiedBankChange(obligation.beneficiaryId, bankDetails) === undefined
  ) {
    return waitWithoutPaying(
      engine,
      invoiceId,
      "the bank details on file are not the ones the pay run approved",
      "Waiting on a person. The bank details on file are not the ones the pay run approved, so PayOnce does not pay this invoice. Close it without paying, or restore the approved details in Airwallex and check again",
    );
  }
  // Any other held invoice: an account PayOnce has not paid this supplier, when it
  // has paid them another, is paid only once a person has called the supplier on
  // the number on file and the record matches what they confirmed, as for a
  // replacement. A pay run approved its row's account against the one PayOnce
  // last paid already.
  const last: LastPaid | undefined =
    row === undefined ? engine.ledger.lastPaidTransfer(obligation.beneficiaryId) : undefined;
  const lastElsewhere: boolean = last !== undefined && !holdsAccount(last, bankDetails);
  const bankChange: BankChange | null = lastElsewhere
    ? (engine.ledger.verifiedBankChange(obligation.beneficiaryId, bankDetails) ?? null)
    : null;
  if (last !== undefined && lastElsewhere) {
    note(
      engine.ledger,
      invoiceId,
      "warning",
      `The bank details on file are not the ones PayOnce last paid this supplier, with ${last.reference ?? last.transferId}`,
      "last-paid",
    );
    if (bankChange === null) {
      return waitWithoutPaying(
        engine,
        invoiceId,
        "the bank details on file have not been verified by a callback",
        obligation.supplierPhone === null
          ? "Waiting on a person. The bank details on file are not the ones PayOnce last paid this supplier, and no phone number is on file to verify them by calling the supplier back. Close the invoice without paying, or restore the details PayOnce last paid in Airwallex and check again"
          : `Waiting on a person to call the supplier on ${obligation.supplierPhone}, the number on file, and record the callback. PayOnce pays an account it has not paid this supplier before only after that`,
      );
    }
  }
  const onFile: string = duplicatesOnFile(engine.ledger, held);
  const duplicates: DuplicateEvidence[] = await duplicateEvidence(engine, held, accountKey);
  // Paid from another currency's wallet, it is approved at a quote. Nothing has
  // been sent, so no fee is known yet.
  const rate: Rate | null = crossCurrency(obligation) ? await rateFor(engine, obligation, null) : null;
  const terms: HeldPaymentTerms = heldTermsFor(
    held,
    bankDetails,
    duplicates,
    rate?.fx ?? null,
    evidence,
    arrivalOf(engine.ledger, obligation, bankDetails),
    bankChange,
  );
  // A second bill paid to a different account from the first is the pattern of an
  // invoice resent with new bank details, so it needs two approvers.
  const elsewhere: DuplicateEvidence | undefined = duplicates.find(
    (duplicate: DuplicateEvidence): boolean => duplicate.sameAccount === false,
  );
  if (elsewhere !== undefined) {
    note(
      engine.ledger,
      invoiceId,
      "warning",
      `The account on file for this invoice is not the one ${elsewhere.invoiceId} was sent to`,
      "bank-details",
    );
  }
  // Two approvers for a payee PayOnce has never paid on a person's approval, and
  // for an account it has not paid this supplier before, as for a pay run's row.
  const payee: SignoffRule | null = payeeRule(engine, obligation, bankDetails);
  const rule: SignoffRule =
    elsewhere !== undefined
      ? { needed: 2, why: `it pays a different account from the one ${elsewhere.invoiceId} was sent to` }
      : (payee ??
        signoffsNeeded(engine.approvals, paymentAmount(terms), false, obligation.startedBy));
  const approval: Approval | undefined = engine.ledger.latestApproval(invoiceId);
  if (approval?.state !== "approved" || voidIfStale(engine, held, approval, terms, rule)) {
    return awaitApproval(engine, held, terms, rule, rate, routeKeyOf(bankDetails));
  }
  // Paying it waits for the end of an outage on its rail, with the approval kept.
  // releaseFor refuses it too.
  const outage: Outage | undefined = engine.ledger.activeOutage(obligation.currency, obligation.transferMethod);
  if (outage !== undefined) {
    throw new RailOutageError(outage, "approved");
  }

  if (
    (await linkUnseenPayouts(engine, invoiceId)) ||
    anyLive(engine.ledger.outsidePayouts(invoiceId))
  ) {
    return Date.now();
  }
  return withCurrencyLock(engine.ledger, debitCurrency(obligation), async (lease: Lease): Promise<NextLook> => {
    // Checked before the invoice is released, so a failed check leaves it held
    // with its approval unspent.
    const route: string = await requireAccount(engine, obligation, terms.accountKey, "payment was approved");
    // Another process may have voided the approval, closed the invoice or tied a
    // payout to it since it was read, or changed what the terms say of the
    // invoices it looks like a second bill for. A match the terms do not list,
    // even one found before onFile was taken, refuses it too. The next look sees
    // which, and adds a new match to the terms.
    const attempt: Attempt | undefined = engine.ledger.releaseFor(
      invoiceId,
      approval.id,
      lease,
      (): boolean =>
        duplicatesOnFile(engine.ledger, held) === onFile &&
        engine.ledger.emailCount(invoiceId) === emails.length &&
        likelyDuplicates(engine.ledger, held).every((other: ScannedObligation): boolean =>
          held.duplicateOf.includes(other.invoiceId),
        ),
      route,
    );
    if (attempt === undefined) {
      return Date.now();
    }
    note(
      engine.ledger,
      invoiceId,
      "approval",
      `Approval by ${approval.approver} matches the current terms, so PayOnce pays the invoice`,
    );
    const original: Transfer = await send(engine, { ...held, state: "open" }, attempt);
    return waitForBank(engine, invoiceId, "original", original);
  });
}

// Two approvers for a payment to a beneficiary PayOnce has never paid, to one it
// paid only before it kept which account each payment went to, to an account it
// has not paid this supplier before, by the account its last checked payment
// kept, or to one PayOnce has paid only by itself, with no person approving any
// payment to it (paidOnApproval). Null when PayOnce last paid this very account
// and a person has approved a payment to the beneficiary.
function payeeRule(engine: Engine, obligation: Obligation, bankDetails: TransferBankDetails): SignoffRule | null {
  const last: LastPaid | undefined = engine.ledger.lastPaidTransfer(obligation.beneficiaryId);
  if (last === undefined) {
    return engine.ledger.lastPaidUnchecked(obligation.beneficiaryId) === undefined
      ? { needed: 2, why: "PayOnce has never paid this beneficiary" }
      : { needed: 2, why: "PayOnce paid this supplier before it kept which account each payment went to" };
  }
  if (!holdsAccount(last, bankDetails)) {
    return { needed: 2, why: "it pays an account PayOnce has not paid this supplier before" };
  }
  return engine.ledger.paidOnApproval(obligation.beneficiaryId)
    ? null
    : { needed: 2, why: PAID_ONLY_BY_ITSELF };
}

// Why a held invoice needs two approvers when PayOnce has paid the beneficiary
// only with payments no person approved. A fixed string, which why-facts reads.
export const PAID_ONLY_BY_ITSELF: string = "PayOnce has never paid this beneficiary on a person's approval";

// A held invoice with nothing a person could approve paying: any open request is
// withdrawn, and the timeline says what the invoice waits on.
function waitWithoutPaying(
  engine: Engine,
  invoiceId: string,
  withdrawn: string,
  waiting: string,
): NextLook {
  if (engine.ledger.voidOpenApprovals(invoiceId)) {
    note(engine.ledger, invoiceId, "approval", `Approval request withdrawn: ${withdrawn}`);
  }
  note(engine.ledger, invoiceId, "approval", waiting, "waiting");
  return null;
}

// An automatic replacement, while holding the currency lock. The balance is read
// again under the lock and the policy decides again on it, with the money
// committed elsewhere as it is now, so two replacements in one currency cannot
// both pass on the same cash. The decision runs in the transaction that opens
// the attempt, so nothing is awaited between them.
async function replaceUnderLock(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  lease: Lease,
): Promise<NextLook> {
  const invoiceId: string = obligation.invoiceId;
  // A payout tied to the invoice now is looked at before anything is sent.
  if (await linkUnseenPayouts(engine, invoiceId)) {
    return Date.now();
  }
  const accountKey: string = accountKeyOf(assessment.bankDetails);
  const route: string = await requireAccount(engine, obligation, accountKey, "decision");
  const wallet: string = debitCurrency(obligation);
  const before: Map<string, number> = committedByInvoice(engine.ledger, wallet, { invoiceId });
  const availableMinor: number = await getAvailableMinor(engine.client, wallet);

  let incident: Incident = assessment.incident;
  let paid: string | null = assessment.paidDuplicate;
  const next: Attempt | Decision | Outage | null = engine.ledger.transaction((): Attempt | Decision | Outage | null => {
    // Another process may have sent the invoice to a person, or a person may have
    // closed it without paying, while this look waited for the lock or read
    // Airwallex. Only an approval pays an invoice with a person, and nothing pays
    // a closed one, so the next look, at once, reads it as it is now.
    if (engine.ledger.obligation(invoiceId)?.state !== "open") {
      return null;
    }
    // An email delivered since assess read the thread is read before anything
    // is sent.
    if (engine.ledger.emailCount(invoiceId) !== assessment.emails.length) {
      return null;
    }
    incident = {
      ...assessment.incident,
      availableBalanceMinor: availableMinor,
      committedMinor: committedAcross(
        before,
        committedByInvoice(engine.ledger, wallet, { invoiceId }),
      ),
    };
    // assess makes this check too. Made again here for an invoice paid since.
    paid = paidDuplicate(engine.ledger, obligation);
    const decision: Decision = secondBill(decide(incident), paid);
    if (decision.action !== "replace") {
      return decision;
    }
    // No replacement is sent by itself on a rail with an outage. Read under the
    // write lock, so a declaration cannot land between this and the attempt.
    // Opening the attempt takes the duplicate lock, so this throws if the invoice
    // already has a live payment.
    return (
      engine.ledger.activeOutage(obligation.currency, obligation.transferMethod) ??
      engine.ledger.openAttempt(invoiceId, "replacement", lease, null, accountKey, route)
    );
  });
  if (next === null) {
    return Date.now();
  }
  if ("declaredAt" in next) {
    return escalateForOutage(engine, obligation, { ...assessment, incident, paidDuplicate: paid }, next);
  }
  if ("action" in next) {
    note(engine.ledger, invoiceId, "decision", `Escalate: ${next.reason}${arrivalClause(assessment)}`, "decision");
    // The first request names the floor as well, as every later one does.
    return escalate(
      engine,
      obligation,
      withFloorReason(engine, obligation, { ...assessment, incident, decision: next, paidDuplicate: paid }),
    );
  }
  const replacement: Transfer = await send(engine, obligation, next);
  return waitForBank(engine, invoiceId, "replacement", replacement);
}

// A replacement the policy would send by itself, on a rail with an outage, goes
// to a person. The approval request is built from the replace decision, so its
// terms, and its binding, say nothing of the outage. If the outage ended in the
// moment since it was read, the next look, at once, replaces as usual.
function escalateForOutage(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  outage: Outage,
): NextLook {
  const invoiceId: string = obligation.invoiceId;
  if (engine.ledger.outage(outage.id)?.state !== "active") {
    return Date.now();
  }
  note(engine.ledger, invoiceId, "decision", `Escalate: ${OUTAGE_REASON}${arrivalClause(assessment)}`, "decision");
  if (!engine.ledger.holdForOutage(outage.id, { invoiceId }, "replacement", holdLine(outage, "replacement"))) {
    return Date.now();
  }
  return escalate(engine, obligation, assessment, OUTAGE_REASON);
}

// An invoice whose payment an outage held waits for a person to end it. The hold
// line goes on its timeline once, and a standing line says what it waits on, both
// in the transaction that finds the outage still active, so neither lands after
// the end line. The look is tried again a minute later, which costs a ledger read
// while the outage lasts. If the outage has ended meanwhile, the next look is due
// at once.
export function waitOnOutage(engine: Engine, invoiceId: string, error: RailOutageError): void {
  const outage: Outage | undefined = engine.ledger.outage(error.outageId);
  const approval: Approval | undefined =
    error.what === "approved" ? engine.ledger.latestApproval(invoiceId) : undefined;
  const waiting: string =
    outage === undefined ? "" : waitingLine(outage, approval?.state === "approved" ? approval : undefined);
  if (
    outage?.state !== "active" ||
    !engine.ledger.holdForOutage(outage.id, { invoiceId }, error.what, holdLine(outage, error.what), {
      kind: "outage",
      message: waiting,
      topic: "waiting",
      wanted: (events: LedgerEvent[]): boolean => lineWanted(events, "outage", waiting, "waiting"),
    })
  ) {
    engine.ledger.lookAt(invoiceId, Date.now());
  }
}

// Carries out a decision: replace, close, hand over to a person, or wait for the
// bank until the original's deadline.
async function act(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
): Promise<NextLook> {
  switch (assessment.decision.action) {
    case "replace":
      return withCurrencyLock(
        engine.ledger,
        debitCurrency(obligation),
        (lease: Lease): Promise<NextLook> => replaceUnderLock(engine, obligation, assessment, lease),
      );
    case "wait":
      return waitForBank(engine, obligation.invoiceId, "original", assessment.original);
    case "escalate":
      // The first request names the floor as well, as every later one does.
      return escalate(engine, obligation, withFloorReason(engine, obligation, assessment));
    case "close":
      return close(engine, obligation.invoiceId, obligation.state)
        ? null
        : closeRefused(engine, obligation.invoiceId);
  }
}

// True for an attempt sent on a quote that ran out a bank deadline ago. Airwallex
// refuses to create a transfer on a quote that has run out, and a transfer
// created before then has had that long to show.
function quoteLapsed(obligation: Obligation, attempt: Attempt): boolean {
  if (attempt.quoteValidTo === null) {
    return false;
  }
  const deadline: number =
    Date.parse(attempt.quoteValidTo) + deadlineMinutes(obligation.transferMethod) * 60_000;
  return !(Date.now() < deadline);
}

// Looks at an invoice again, after a webhook, a status check, new emails, a
// person's action or a deadline. It syncs each payment with Airwallex, retrying an
// attempt that has no transfer yet under its original request_id, and notes any
// payment the bank has paid or failed since the last look. Then it reads new
// emails, decides and acts. A replacement already out is waited on until its
// deadline, never approved a second time. An escalated invoice pays only on a
// matching approval. sendRunRow lets the look send a pay run row's first
// payment, which only the release and the server's watcher pass.
export async function resumeIncident(
  engine: Engine,
  invoiceId: string,
  sendRunRow: boolean = false,
): Promise<void> {
  let next: NextLook;
  try {
    next = await look(engine, invoiceId, sendRunRow);
  } catch (error: unknown) {
    // A deadline already passed stays due, and the watcher has the agent try
    // again a minute later rather than on every check.
    const now: number = Date.now();
    engine.ledger.postponeDueLook(invoiceId, now, now + RETRY_FAILED_LOOK_MS);
    // An outage is no failure of the look, so it writes no error line.
    if (error instanceof RailOutageError) {
      waitOnOutage(engine, invoiceId, error);
      return;
    }
    throw error;
  }
  engine.ledger.lookAt(invoiceId, next);
}

// Sends an attempt still pending with no transfer again, under its request_id,
// holding the currency lock of the wallet the money leaves. A retry pays the
// record as it is now, so every payment goes out only to the account it was
// decided or approved for, which the attempt keeps. Throws AccountChangedError,
// sending nothing, when the record no longer holds it. An attempt from before the
// account was kept is checked as it was then: against the approval it was opened
// on, so a request another process opened since does not count, then the run
// row's account, since a person may have approved another account after the row
// was held.
//
// Once its quote has run out a bank deadline ago, a payment from another
// currency's wallet has one last try, which fails it if Airwallex refuses its
// quote and lists no transfer for it. Null then: nothing was sent, and a person
// approves it on a new quote.
//
// Undefined, with nothing sent, when the ledger shows a payout for the invoice
// sent outside PayOnce live, another payment for it live at the bank, such as a
// transfer found late (paidTwice), the invoice closed, or the attempt no longer
// pending with no transfer, just before the create call. Another process may
// have tied the payout, recorded the late transfer, closed the invoice, or failed
// or recorded the attempt, while this one waited for the lock.
async function retry(
  engine: Engine,
  obligation: Obligation,
  attempt: Attempt,
  original: Transfer | null,
  checks: TransferChecks,
): Promise<Transfer | null | undefined> {
  const approval: Approval | undefined = engine.ledger.approvalOf(attempt);
  const approved: ApprovalTerms | undefined =
    approval?.state === "used" ? (JSON.parse(approval.terms) as ApprovalTerms) : undefined;
  const row: RunRow | undefined =
    obligation.runRowId === null ? undefined : engine.ledger.runRow(obligation.runRowId);
  if (attempt.accountKey !== null) {
    await requireAccount(
      engine,
      obligation,
      attempt.accountKey,
      attempt.approvalId === null ? "payment was decided" : "payment was approved",
    );
  } else if (attempt.kind === "replacement") {
    await requireAccount(
      engine,
      obligation,
      approved?.action === "replace"
        ? approved.accountKey
        : accountKeyOf(original?.beneficiary?.bank_details),
      "replacement was approved",
    );
  } else if (approved?.action === "pay") {
    await requireAccount(engine, obligation, approved.accountKey, "payment was approved");
  } else if (row?.accountKey !== undefined && row.accountKey !== null) {
    await requireAccount(engine, obligation, row.accountKey, "pay run was approved");
  }
  const lapsed: boolean = quoteLapsed(obligation, attempt);
  const invoiceId: string = obligation.invoiceId;
  const state: ObligationState | undefined = engine.ledger.obligation(invoiceId)?.state;
  const attempts: Attempt[] = engine.ledger.attempts(invoiceId);
  if (
    (state !== "open" && state !== "escalated") ||
    anyLive(engine.ledger.outsidePayouts(invoiceId)) ||
    attempts.some(
      (current: Attempt): boolean => current.requestId !== attempt.requestId && liveAtBank(current),
    ) ||
    !attempts.some(
      (current: Attempt): boolean =>
        current.requestId === attempt.requestId &&
        current.state === "pending" &&
        current.transferId === null,
    )
  ) {
    return undefined;
  }
  try {
    return await sendAttempt(
      engine.client,
      engine.ledger,
      obligation,
      attempt,
      lapsed ? "lapsed" : "retry",
      checks.decide,
    );
  } catch (error: unknown) {
    // Nothing was sent only if the last try failed the attempt on a refusal.
    // Anything else, such as a failed listing, fails the look, which is retried.
    const failed: boolean = engine.ledger
      .attempts(obligation.invoiceId)
      .some(
        (current: Attempt): boolean =>
          current.requestId === attempt.requestId && current.state === "failed",
      );
    if (!lapsed || !wasRejected(error) || !failed) {
      throw error;
    }
    note(
      engine.ledger,
      obligation.invoiceId,
      "payment",
      `${capitalise(attempt.kind)} payment never became a transfer: its exchange rate quote ran out, and Airwallex refused a last try under the same request id and lists no transfer with it (${error.code ?? String(error.status)}). Nothing was sent, so it needs a new approval on a new quote`,
    );
    return null;
  }
}

// The first payment of an open invoice with no attempt. A pay run's row sends its
// original, to the account the run approved, only in its turn: when the release
// or the server's watcher passes sendRunRow. Any other look leaves it for that
// turn. Any other invoice is here only when its first send failed before an
// attempt was opened, and the look tries it again. When startPayment holds it
// instead, the next look comes at once, and asks a person.
async function startFirst(
  engine: Engine,
  obligation: Obligation,
  sendRunRow: boolean,
): Promise<NextLook> {
  const invoiceId: string = obligation.invoiceId;
  let account: AccountRef | null = null;
  if (obligation.runRowId !== null) {
    const row: RunRow | undefined = engine.ledger.runRow(obligation.runRowId);
    if (row === undefined || row.accountKey === null) {
      throw new Error(`${invoiceId} has no pay run row to send it from`);
    }
    if (!sendRunRow) {
      note(
        engine.ledger,
        invoiceId,
        "payment",
        `Waiting for its turn in pay run ${row.runId}. The server sends the run's first payments one at a time`,
        "waiting",
      );
      // Due at once, so the server's watcher gives it its turn.
      return Date.now();
    }
    account = { accountKey: row.accountKey, routeKey: row.routeKey };
  }
  const original: Transfer | null = await startPayment(engine, obligation, account);
  return original === null ? Date.now() : waitForBank(engine, invoiceId, "original", original);
}

async function look(engine: Engine, invoiceId: string, sendRunRow: boolean): Promise<NextLook> {
  const read: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (read === undefined) {
    throw new Error(`${invoiceId} is not in the ledger`);
  }
  let obligation: Obligation = read;

  // A transfer kept beside an attempt because it does not match the invoice is
  // read like any payment with the bank. Once the bank has failed every one, the
  // reason the invoice waits for a person says so, unless another process has
  // changed the reason or closed the invoice meanwhile.
  for (const attempt of engine.ledger.attempts(invoiceId).filter(mismatchedLive)) {
    if (attempt.mismatchedTransferId !== null && attempt.mismatchedStatus !== "PAID") {
      syncMismatched(engine, attempt, await getTransfer(engine.client, attempt.mismatchedTransferId));
    }
  }
  if (
    obligation.escalationReason === MISMATCHED_TRANSFER_REASON &&
    !engine.ledger.attempts(invoiceId).some(mismatchedLive) &&
    engine.ledger.rewordEscalation(invoiceId, MISMATCHED_TRANSFER_REASON, MISMATCHED_FAILED_REASON)
  ) {
    obligation = engine.ledger.obligation(invoiceId) ?? obligation;
  }
  let originalId: string | null = null;
  let original: Transfer | null = null;
  let liveReplacement: Transfer | null = null;
  for (const attempt of engine.ledger.attempts(invoiceId)) {
    // An attempt Airwallex refused never became a transfer. Only one still
    // pending is retried.
    if (attempt.transferId === null && attempt.state !== "pending") {
      continue;
    }
    let transfer: Transfer;
    const existing: Transfer | undefined =
      attempt.transferId === null
        ? await findTransferByRequestId(engine.client, attempt.requestId)
        : undefined;
    if (existing !== undefined) {
      const checks: TransferChecks = transferChecks(engine, obligation, attempt);
      transfer = await syncTransfer(engine.client, engine.ledger, existing.id, checks.decide);
      noteChecks(engine, invoiceId, checks);
      engine.bank?.sent(invoiceId, attempt.kind, transfer.id);
    } else if (attempt.transferId === null) {
      // A payout sent outside PayOnce since the attempt was opened, for example in
      // the Airwallex web app while its create call went unanswered, may already
      // pay the invoice, so the attempt is not sent again while one is live. One
      // tied just now that has already failed holds nothing: the next look, at
      // once, sends the attempt, as before any other payment. Nor is it sent
      // while a payment found late may pay the invoice.
      const linked: boolean = await linkUnseenPayouts(engine, invoiceId);
      const outside: OutsidePayout[] = await syncOutsidePayouts(engine, invoiceId);
      // A transfer found late that the bank has live may pay the invoice. This
      // attempt waits for it as for a paid payout sent outside PayOnce, and is
      // marked failed if it never became a transfer, so the late one takes the
      // lock.
      const twice: Attempt | undefined = paidTwice(engine.ledger, invoiceId);
      if (twice !== undefined) {
        return failNeverSent(engine, obligation, attempt, lateTransferCause(engine, invoiceId, twice));
      }
      const paidBy: OutsidePayout | undefined = outside.find(
        (payout: OutsidePayout): boolean => payout.state === "paid",
      );
      if (paidBy !== undefined) {
        return failNeverSent(engine, obligation, attempt, paidOutsideCause(engine, invoiceId, paidBy));
      }
      if (anyLive(outside)) {
        return holdRetryForOutsidePayout(engine, invoiceId, attempt);
      }
      // A paid one is waited for as a paid payout sent outside PayOnce is, so the
      // attempt is marked failed if it never became a transfer.
      const mismatched: Attempt | undefined = engine.ledger.attempts(invoiceId).find(mismatchedLive);
      if (mismatched?.mismatchedStatus === "PAID") {
        return failNeverSent(engine, obligation, attempt, mismatchedCause(engine, invoiceId, mismatched));
      }
      if (mismatched !== undefined) {
        return holdMismatched(engine, invoiceId, mismatched);
      }
      if (linked) {
        return Date.now();
      }
      const paying: Obligation = obligation;
      const checks: TransferChecks = transferChecks(engine, obligation, attempt);
      let sent: Transfer | null | undefined;
      try {
        sent = await withCurrencyLock(
          engine.ledger,
          debitCurrency(paying),
          (): Promise<Transfer | null | undefined> => retry(engine, paying, attempt, original, checks),
        );
      } catch (error: unknown) {
        if (!(error instanceof AccountChangedError)) {
          throw error;
        }
        return failNeverSent(engine, obligation, attempt, accountChangedCause(engine, invoiceId, attempt.kind));
      }
      // The next look, at once, holds or records it as the ledger now stands.
      if (sent === undefined) {
        return Date.now();
      }
      if (sent === null) {
        continue;
      }
      transfer = sent;
      noteChecks(engine, invoiceId, checks);
      engine.bank?.sent(invoiceId, attempt.kind, transfer.id);
    } else {
      transfer = await syncTransfer(engine.client, engine.ledger, attempt.transferId);
    }
    const state: AttemptState | null = attemptStateOf(transfer);
    // Not for a transfer the ledger keeps failed while another payment holds the
    // duplicate lock: paidTwice holds the invoice for a person below.
    if (
      state !== attempt.state &&
      (state === "paid" || state === "failed") &&
      engine.ledger.attemptOf(attempt.requestId, transfer.id)?.state === state
    ) {
      note(engine.ledger, invoiceId, "bank", `${capitalise(attempt.kind)} ${describe(transfer)}`);
    }
    // After the bank line, so an outage this failure declares reads after it.
    if (state === "failed") {
      railFailureSeen(engine.ledger, transfer, "look");
    }
    // The original the policy goes by is the latest the bank has not failed, so a
    // transfer found late that is live is never taken for a failed one and
    // replaced. With none live, it is the latest.
    if (
      attempt.kind === "original" &&
      (original === null ||
        originalStateOf(transfer) !== "failed" ||
        originalStateOf(original) === "failed")
    ) {
      originalId = transfer.id;
      original = transfer;
    } else if (attempt.kind === "replacement" && originalStateOf(transfer) === "in_flight") {
      liveReplacement = transfer;
    }
    say(`  ${attempt.kind} ${describe(transfer)}`);
  }
  // A transfer kept failed beside a payment that has failed since, in this look
  // or another, takes its own state now that the duplicate lock is free.
  for (const kept of engine.ledger.attempts(invoiceId).filter(keptFailed)) {
    if (kept.transferId === null) {
      continue;
    }
    const transfer: Transfer = await syncTransfer(engine.client, engine.ledger, kept.transferId);
    if (engine.ledger.attemptOf(kept.requestId, transfer.id)?.state !== "failed") {
      note(engine.ledger, invoiceId, "bank", `${capitalise(kept.kind)} ${describe(transfer)}`);
    }
  }
  // A transfer found at a rate nobody approved may have escalated it above.
  obligation = engine.ledger.obligation(invoiceId) ?? obligation;
  // Before anything is decided, held or released for a closed invoice reopened by
  // it, or for one with nothing sent. Payouts sent outside PayOnce are read first,
  // so one the bank has paid or failed since is recorded, and the watcher stops
  // waking the invoice for it.
  const mismatched: Attempt | undefined = engine.ledger.attempts(invoiceId).find(mismatchedLive);
  if (mismatched !== undefined && obligation.state !== "settled") {
    await syncOutsidePayouts(engine, invoiceId);
    return holdMismatched(engine, invoiceId, mismatched);
  }

  if (originalId === null) {
    const refused: Attempt | undefined = engine.ledger.attempts(invoiceId).at(-1);
    if (refused === undefined && obligation.state === "open") {
      return startFirst(engine, obligation, sendRunRow);
    }
    if (refused !== undefined && obligation.state === "open") {
      return continueHeld(engine, holdRefused(engine, obligation, refused));
    }
    return heldBeforePaying(engine.ledger, obligation) ? continueHeld(engine, obligation) : null;
  }
  const outside: OutsidePayout[] = await syncOutsidePayouts(engine, invoiceId);
  await readNewEmails(engine, obligation);
  // Closed already, by the policy or by a person, so nothing is decided or sent,
  // whatever its payments show now. A payment found late that may still pay it
  // reopened it when it was recorded.
  if (obligation.state === "settled" || obligation.state === "rejected") {
    return null;
  }
  // Before the policy, so its reason is not replaced, and before a paid payment
  // could close the incident.
  const twice: Attempt | undefined = paidTwice(engine.ledger, invoiceId);
  if (twice !== undefined) {
    return holdPaidTwice(engine, invoiceId, twice);
  }
  // Still kept failed, as when another process opened or recorded a payment
  // meanwhile: nothing is decided around a payment the bank has live, and the
  // next look, at once, records it again.
  if (engine.ledger.attempts(invoiceId).some(keptFailed)) {
    return Date.now();
  }
  if (engine.ledger.paidOnce(invoiceId)) {
    // A paid replacement was sent on a decision already made, so it closes the
    // incident. A paid original goes to the policy, which may want a person. So
    // does an invoice with a live payout sent outside PayOnce.
    if (paidOriginal(engine.ledger, invoiceId) === undefined && !anyLive(outside)) {
      // Refused when a payment went out at a rate nobody approved, or when another
      // process changed the ledger since this look read it.
      return close(engine, invoiceId, obligation.state) ? null : closeRefused(engine, invoiceId);
    }
  }
  if (liveReplacement !== null) {
    return isOverdue(liveReplacement)
      ? replacementOverdue(engine, invoiceId, liveReplacement)
      : waitForBank(engine, invoiceId, "replacement", liveReplacement);
  }
  if (obligation.state === "escalated") {
    return continueEscalated(engine, obligation, originalId);
  }
  return act(engine, obligation, await assess(engine, obligation, originalId));
}

const ATTEMPT_STATE_WORDS: Record<AttemptState, string> = {
  pending: "pending",
  in_flight: "in flight",
  paid: "paid",
  failed: "failed",
};

export interface PayAgainResult {
  refused: boolean;
  message: string;
}

// A person asks for the invoice to be paid again. The request takes the duplicate
// lock like any payment, inside a transaction that is always rolled back, so it
// never reaches Airwallex. When every payment has failed the lock has nothing to
// refuse, but a replacement still goes through the policy and any approval, so
// nothing is sent from here either.
export function payAgain(ledger: Ledger, invoiceId: string): PayAgainResult {
  try {
    ledger.tryLock(invoiceId);
  } catch (error: unknown) {
    if (!(error instanceof DuplicatePaymentError)) {
      throw error;
    }
    const holder: Attempt | undefined = ledger.attempts(invoiceId).find(liveAtBank);
    const held: string =
      holder === undefined
        ? ""
        : holder.state === "failed" && holder.transferId === null
          ? `: transfer ${holder.mismatchedReference ?? ""} under the ${holder.kind}'s request id is live at the bank`
          : `: ${holder.kind} ${holder.reference ?? "with no reference yet"} is ${holder.state === "failed" ? "live at the bank" : ATTEMPT_STATE_WORDS[holder.state]}`;
    const message: string = `Pay again refused by the duplicate lock${held}. An invoice can have one live payment`;
    note(ledger, invoiceId, "lock", message);
    return { refused: true, message };
  }
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  const message: string =
    obligation?.state === "settled"
      ? "Pay again not sent. The incident is closed, so PayOnce pays nothing more for this invoice"
      : obligation?.state === "rejected"
        ? "Pay again not sent. A person closed this invoice without paying"
        : anyLive(ledger.outsidePayouts(invoiceId))
          ? "Pay again not sent. A payout sent outside PayOnce may already pay this invoice"
          : obligation !== undefined && heldBeforePaying(ledger, obligation)
            ? "Pay again not sent. PayOnce is holding this invoice before paying it, so it pays only on an approval"
            : "Pay again not sent. No payment for this invoice is live, so a replacement goes through the policy, and through a person's approval once the invoice is with a person";
  note(ledger, invoiceId, "warning", message);
  return { refused: false, message };
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

// What a person is shown before closing an escalated invoice the bank reports as
// paid once: by PayOnce's original or replacement, or by a payout sent outside
// PayOnce after every payment PayOnce sent failed. kind duplicate is an invoice
// held before paying as a second bill for others, and its reference lists them.
// kind unpaid is any other escalated invoice with nothing for it live at the
// bank, such as one whose original Airwallex refused, or whose payments all
// failed. Closing either leaves it unpaid. emails is the
// email evidence an approval would show, null when the invoice has no emails.
// covered lists the transfers under its request ids that do not match it and
// that no person has cleared: the card shows them, and closing on this review
// clears exactly those.
export interface CloseReview {
  kind: AttemptKind | "outside" | "mismatched" | "duplicate" | "unpaid";
  reference: string | null;
  reason: string;
  emails: string | null;
  covered: CoveredTransfer[];
}

// A transfer under the request id of one of the invoice's attempts (kind) that
// does not match the invoice, with the bank's short reference and the status a
// look last read for it.
export interface CoveredTransfer {
  transferId: string;
  reference: string;
  status: string | null;
  kind: AttemptKind;
}

// The transfers under the invoice's request ids that do not match it, which no
// person has cleared: what a person's close covers.
function coveredByClose(ledger: Ledger, invoiceId: string): CoveredTransfer[] {
  return ledger
    .attempts(invoiceId)
    .flatMap((attempt: Attempt): CoveredTransfer[] =>
      attempt.mismatchedTransferId !== null && attempt.mismatchedClearedAt === null
        ? [
            {
              transferId: attempt.mismatchedTransferId,
              reference: attempt.mismatchedReference ?? attempt.mismatchedTransferId,
              status: attempt.mismatchedStatus,
              kind: attempt.kind,
            },
          ]
        : [],
    );
}

// How a close names the transfers it covers, as the card and pnpm close show them.
export function coveredText(transfer: CoveredTransfer): string {
  return `${transfer.reference} (${transfer.transferId}), ${transfer.status ?? "status not read"}, under the ${transfer.kind}'s request id`;
}

export function pendingClose(
  ledger: Ledger,
  invoiceId: string,
): CloseReview | undefined {
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  if (obligation?.state !== "escalated") {
    return undefined;
  }
  const reason: string = obligation.escalationReason;
  const onFile: SupplierEmail[] = ledger.emails(invoiceId);
  const emails: string | null =
    onFile.length === 0
      ? null
      : emailEvidence(storedFindings(ledger, invoiceId, onFile).findings.summary, onFile, obligation.supplierDomain);
  const covered: CoveredTransfer[] = coveredByClose(ledger, invoiceId);
  if (ledger.paidOnce(invoiceId)) {
    const paid: Attempt | undefined = ledger
      .attempts(invoiceId)
      .find((attempt: Attempt): boolean => attempt.state === "paid");
    // A payment at a rate nobody approved is why it was not closed by itself.
    return paid === undefined
      ? undefined
      : { kind: paid.kind, reference: paid.reference, reason: paid.rateMismatch ?? reason, emails, covered };
  }
  if (ledger.paidOutside(invoiceId)) {
    const paid: OutsidePayout | undefined = ledger
      .outsidePayouts(invoiceId)
      .find((payout: OutsidePayout): boolean => payout.state === "paid");
    return paid === undefined
      ? undefined
      : { kind: "outside", reference: paid.reference, reason, emails, covered };
  }
  // Paid by a transfer under one of its request ids that does not match it: a
  // person checks it and closes the invoice.
  if (ledger.paidMismatched(invoiceId)) {
    const paid: Attempt | undefined = ledger
      .attempts(invoiceId)
      .find((attempt: Attempt): boolean => attempt.mismatchedStatus === "PAID");
    return { kind: "mismatched", reference: paid?.mismatchedReference ?? null, reason, emails, covered };
  }
  // Not while anything for it may be paying it.
  if (anyLive(ledger.outsidePayouts(invoiceId)) || ledger.attempts(invoiceId).some(liveAtBank)) {
    return undefined;
  }
  // Nothing for it is with the bank or paid, so a person may close it without
  // paying, whatever it waits on: held before paying, a failed payment with a
  // request open, new bank details nobody can verify by calling back, or one a
  // person closed before that a payment found since reopened.
  return obligation.rejectedBy === null &&
    heldBeforePaying(ledger, obligation) &&
    obligation.duplicateOf.length > 0
    ? { kind: "duplicate", reference: listOf(obligation.duplicateOf), reason, emails, covered }
    : { kind: "unpaid", reference: null, reason, emails, covered };
}

// Records a person closing such an invoice. It moves no money, so it is not bound
// to terms the way an approval is. A held duplicate, and any other invoice with
// nothing live at the bank, is closed without paying, and the invoices a held
// one duplicated say so on their timelines. shown is the transfer ids
// of the covered list the person saw, null when the caller names none. The close
// is refused when it covers a transfer under the invoice's request ids that does
// not match it and that is not on that list: one found since, or any at all when
// the caller named none. Otherwise it clears those, in the transaction that
// closes it, so one found after that still keeps PayOnce from closing the invoice
// by itself.
export function closeIncident(
  ledger: Ledger,
  invoiceId: string,
  closer: string,
  finding: string,
  shown: string[] | null = null,
): void {
  const closedBy: string = personName(closer);
  const review: CloseReview | undefined = pendingClose(ledger, invoiceId);
  const covered: CoveredTransfer[] = review?.covered ?? [];
  if (shown === null && covered.length > 0) {
    throw new Error(
      `Closing ${invoiceId} covers transfers listed under its request ids that do not match it, so the close must name them: ${covered.map(coveredText).join("; ")}`,
    );
  }
  if (covered.some((transfer: CoveredTransfer): boolean => !(shown ?? []).includes(transfer.transferId))) {
    throw new Error(
      `A transfer was found under one of ${invoiceId}'s request ids since the close card was shown. Look at the incident again before closing it`,
    );
  }
  const clears: string[] = covered.map((transfer: CoveredTransfer): string => transfer.transferId);
  if (review?.kind === "duplicate" || review?.kind === "unpaid") {
    const obligation: Obligation | undefined = ledger.obligation(invoiceId);
    // Named only for a held invoice or one closed before, so a close of an
    // invoice paid on an approval after a hold does not call it a second bill.
    const duplicateOf: string[] =
      obligation !== undefined && (obligation.rejectedBy !== null || heldBeforePaying(ledger, obligation))
        ? obligation.duplicateOf
        : [];
    // One closed without paying before keeps who closed it first.
    const closed: boolean =
      obligation?.rejectedBy !== null && obligation?.rejectedBy !== undefined
        ? ledger.rejectAgain(invoiceId, true, clears)
        : ledger.reject(invoiceId, closedBy, clears);
    if (!closed) {
      throw new Error(`${invoiceId} is not waiting on a person to close it`);
    }
    note(
      ledger,
      invoiceId,
      "closed",
      duplicateOf.length > 0
        ? `Closed without paying by ${closedBy}, as a second bill for ${listOf(duplicateOf)}: ${finding}`
        : `Closed without paying by ${closedBy}: ${finding}`,
    );
    for (const other of duplicateOf) {
      note(
        ledger,
        other,
        "warning",
        `${invoiceId} was closed without paying by ${closedBy}, as a second bill for this invoice`,
      );
    }
    return;
  }
  if (review === undefined || !ledger.settle(invoiceId, true, "escalated", clears)) {
    throw new Error(`${invoiceId} is not waiting on a person to close it`);
  }
  note(ledger, invoiceId, "closed", `Incident closed by ${closedBy}: ${finding}`);
}

export interface PendingApproval {
  approval: Approval;
  terms: ApprovalTerms;
  // Who may not approve it, and why.
  barred: Barred[];
  expired: boolean;
}

// Returns the request an escalated invoice is waiting on, if there is one.
export function pendingApproval(
  ledger: Ledger,
  invoiceId: string,
): PendingApproval | undefined {
  const approval: Approval | undefined = ledger.latestApproval(invoiceId);
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  if (
    approval === undefined ||
    approval.state !== "requested" ||
    obligation?.state !== "escalated"
  ) {
    return undefined;
  }
  const terms: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  return {
    approval,
    terms,
    barred: barredFrom(ledger, obligation, terms.accountKey),
    expired: isExpired(approval),
  };
}

// Records one person's approval of a replacement, or of paying a held invoice,
// under the approval policy. approvalId is the request the approver was shown. If
// a newer one has replaced it, the approval is refused so nobody approves terms
// they did not see. A request that needs two approvers stays open after the first.
export function approvePayment(
  ledger: Ledger,
  policy: ApprovalPolicy,
  invoiceId: string,
  approver: string,
  approvalId: number,
): Approval {
  const pending: PendingApproval | undefined = pendingApproval(ledger, invoiceId);
  if (pending === undefined) {
    throw new Error(`No approval is waiting for ${invoiceId}`);
  }
  const { approval, terms } = pending;
  if (approval.id !== approvalId) {
    throw new Error(
      `The approval request for ${invoiceId} has changed. Review the current terms`,
    );
  }
  if (pending.expired) {
    throw new Error(
      `The approval request for ${invoiceId} has expired. PayOnce opens a new one on its next look`,
    );
  }
  const signer: Approver = checkSigner(
    policy,
    approver,
    paymentAmount(terms),
    pending.barred,
    approval.signoffs.map((signoff: Signoff): string => signoff.approver),
  );
  const after: Approval = ledger.signOff(
    approval.id,
    signer.name,
    approval.binding,
    APPROVED_USE_WITHIN_MS,
  );
  const payment: string = `${formatMoney(terms.amountMinor, terms.currency)} to ${terms.payTo} (the account on file)${paidWith(terms.fx)}`;
  const left: number = after.needed - after.signoffs.length;
  note(
    ledger,
    invoiceId,
    "approval",
    after.state === "approved"
      ? `Approved by ${signersOf(after.signoffs)}: ${payment}`
      : `${signer.name} approved ${payment}. It needs ${left} more approver${left === 1 ? "" : "s"}`,
    // Standing, so the check that follows does not restate the decision.
    "approval",
  );
  return after;
}

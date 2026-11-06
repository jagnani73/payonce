import {
  describeRate,
  markupOf,
  type ApprovalTerms,
  type BankChangeEvidence,
  type DuplicateEvidence,
  type FxTerms,
  type HeldPaymentTerms,
  type ReplacementTerms,
} from "../domain/approval.js";
import { knownName, sameName, type ApprovalPolicy, type Barred } from "../domain/approvers.js";
import { HOLIDAYS_NOTE, type ArrivalTerms } from "../domain/arrival.js";
import { committedMinor } from "../engine/cash-position.js";
import { deadlineMinutes } from "../domain/deadlines.js";
import {
  BELOW_FLOOR_REASON,
  CHANGED_BANK_DETAILS_REASON,
  EMAILS_UNREAD_REASON,
  IN_FLIGHT_REASON,
  LAST_PAID_CHANGED_REASON,
  NEW_BANK_DETAILS_REASON,
  NO_FLOOR_CLAUSE,
  NO_FLOOR_REASON,
  NON_RECEIPT_REASON,
  NOT_RESENDABLE_REASON,
  NOT_TO_PAY_CLAUSE,
  NOT_TO_PAY_REASON,
  ORIGINAL_DEADLINE_REASON,
  OUTAGE_REASON,
  OUTSIDE_PAYOUT_REASON,
  PARTLY_UNREAD_REASON,
  REPLACE_REASON,
  REPLACEMENT_FAILED_REASON,
  SENT_OUTSIDE_REASON,
  SETTLED_REASON,
  TWO_APPROVERS_REASON,
  UNCONFIRMED_ACCOUNT_REASON,
  UNKNOWN_STATUS_REASON,
  UNREADABLE_CASH_REASON,
  UNVERIFIED_SENDER_REASON,
} from "../domain/decide.js";
import { emailEvidence, type SupplierEmail } from "../reader/emails.js";
import { heldBeforePaying } from "../engine/facts.js";
import { pendingApproval, pendingClose, type CloseReview, type PendingApproval } from "../engine/person.js";
import {
  ACCOUNT_CHANGED_REASON,
  CASH_HOLD_REASON,
  EMAILS_BEFORE_PAYMENT_REASON,
  LATE_TRANSFER_REASON,
  MISMATCHED_FAILED_REASON,
  MISMATCHED_TRANSFER_REASON,
  REPLACEMENT_DEADLINE_REASON,
  RUN_ACCOUNT_CHANGED_REASON,
} from "../engine/reason-text.js";
import { quoteValidity } from "../domain/fx.js";
import { currentSettings } from "../settings.js";
import {
  crossCurrency,
  INVOICE_ID_PATTERN,
  isExpired,
  type Approval,
  type Attempt,
  type Ledger,
  type LedgerEvent,
  type Obligation,
  type Outage,
  type OutageHold,
  type OutsidePayout,
  type RunRow,
} from "../store/ledger.js";
import { formatAmount, formatMoney } from "../domain/money.js";
import { currencyFloor, debitCurrency, floorFor, type ReservePolicy } from "../domain/reserve.js";
import { SANDBOX_BANK_AFTER, SANDBOX_BANK_RECOVER, SANDBOX_BANK_STOPPED, TRY_WORDS_SOURCE } from "../text/words.js";
import { CURRENCY_PATTERN, CURRENCY_SOURCE, FAILURE_CODE_SOURCE, METHOD_PATTERN, METHOD_SOURCE, REFERENCE_PATTERN, REFERENCE_SOURCE, STATUS_PATTERN, STATUS_SOURCE } from "../domain/patterns.js";
import { FAILURE_WORDS, RAIL_FAILURE_CODES, RESENDABLE_FAILURE_CODES } from "../domain/failure-codes.js";
import { capitalise } from "../text/printable.js";

// The facts a model is given to explain one invoice. Every value is PayOnce's own
// words, a closed-pattern value such as a bank reference, a status or an amount,
// or an alias ([invoice N], [person N]) PayOnce swaps back only in the answer it
// shows. Nothing from an email, an upload, a sender, a subject, a display name,
// an attachment name, account details, a phone number, a payout reference, a note
// a person typed or an error text is read into them. Timeline lines pass only
// through LINE_RULES, an allowlist: a line no rule knows is replaced by a
// stand-in, so a template added later with outside text in it fails closed.

export const WHY_QUESTION: string =
  "Why did PayOnce do what it did on this invoice, and what is it waiting on now?";

const TIMELINE_LINES: number = 60;
const UNPASSED_REASON: string = "(a reason PayOnce does not pass on)";
const UNPASSED_CODE: string = "an error code PayOnce does not pass on";
const A_PERSON: string = "a person";

// The settings the facts quote, as PayOnce reads them now. readers are the names
// the stored findings may give for whoever read the emails: the models the reader
// is set up with and the keyword reader (readerNamesFromEnv).
export interface WhySettings {
  approvals: ApprovalPolicy;
  reserve: ReservePolicy;
  readers: readonly string[];
}

export interface LegendEntry {
  alias: string;
  value: string;
}

export interface ArrivalFacts {
  route: string | null;
  from: string | null;
  earliest: string | null;
  latest: string | null;
  dueDate: string | null;
}

export interface InvoiceFacts {
  ref: string;
  state: string;
  origin: string;
  fromPayRun: { run: number; row: number } | null;
  amount: string;
  paidFromWallet: string | null;
  transferMethod: string;
  dueDate: string | null;
  startedBy: string;
  supplierDomainOnFile: boolean;
  supplierPhoneOnFile: boolean;
  heldBeforePaying: boolean;
  escalationReason: string | null;
  closedWithoutPayingBy: string | null;
  decisionNow: string | null;
  waitingOn: string | null;
  looksLike: { invoice: string; state: string }[];
}

export interface PaymentFacts {
  kind: string;
  bankReference: string | null;
  state: string;
  bankStatus: string | null;
  createdAt: string | null;
  deadline: string | null;
  pastDeadline: boolean | null;
  failure: string | null;
  resendCanFix: boolean | null;
  amountFromWallet: string | null;
  fee: string | null;
  openedOnApproval: number | null;
  exchangeRate: string | null;
  wentOutAtUnapprovedRate: boolean;
  foundLateInAirwallex: boolean;
  transferThatDoesNotMatch: { bankReference: string | null; bankStatus: string | null } | null;
  usuallyArrives: ArrivalFacts | null;
}

export interface PayoutFacts {
  bankReference: string | null;
  state: string;
  amount: string | null;
  fee: string | null;
}

export interface EmailFacts {
  evidence: string | null;
  onFile: number;
  read: number;
  withTextPayOnceCouldNotRead: number;
  readerFailed: boolean;
  reportsNonReceipt: boolean;
  asksForDifferentAccount: boolean;
  asksNotToPay: boolean;
  readBy: string | null;
}

export interface ApprovalFacts {
  number: number;
  state: string;
  action: string;
  amount: string;
  takesFromWallet: string | null;
  exchangeRate: { rate: string; markup: string; validTo: string | null } | null;
  arrival: ArrivalFacts | null;
  requestedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  approversNeeded: number;
  whyMoreThanOne: string | null;
  approvedBy: string[];
  barred: { person: string; why: string }[];
  reasonInTerms: string;
  emailEvidenceInTerms: string | null;
  originalInTerms: { bankReference: string | null; state: string; failure: string | null } | null;
  looksLikeInTerms: { invoice: string; state: string; paidBy: string | null; sameAccount: boolean | null }[];
  bankDetailsVerifiedByCallback: { on: string | null; recordedBy: string } | null;
}

export interface CloseFacts {
  kind: string;
  bankReference: string | null;
  looksLike: string[];
  reason: string;
}

export interface CashFacts {
  wallet: string;
  reserveFloor: string;
  floorFrom: string;
  committedToOtherPayments: string;
  balance: string;
}

export interface PolicyFacts {
  note: string;
  approvers: { person: string; limit: string }[];
  twoApproversAbove: string;
  approvalRequestExpiresAfterMinutes: number;
  approvalsRefused: boolean;
  bankDeadlineMinutes: number;
  fxQuoteValidity: string | null;
}

export interface OutageFacts {
  number: number;
  rail: string;
  onThisInvoicesRail: boolean;
  state: string;
  declaredAt: string | null;
  endedAt: string | null;
  failureCodes: string[];
  payeesCounted: number;
  windowMinutes: number;
  heldOfThisInvoice: string | null;
}

export interface TimelineLine {
  n: number;
  at: string | null;
  kind: string;
  line: string;
}

export interface WhyFacts {
  question: string;
  invoice: InvoiceFacts;
  payments: PaymentFacts[];
  outsidePayouts: PayoutFacts[];
  emails: EmailFacts;
  approval: ApprovalFacts | null;
  closeReview: CloseFacts | null;
  cash: CashFacts;
  policy: PolicyFacts;
  outages: OutageFacts[];
  timeline: TimelineLine[];
  timelineLeftOut: { earlierLines: number; linesNotPassedOn: Record<string, number> };
}

// What the builder hands back: the facts, the legend that swaps the aliases
// back, which line the facts go up to, and how many reasons it did not
// recognise, so a gap shows up on the console without its text.
export interface WhyBuild {
  facts: WhyFacts;
  legend: LegendEntry[];
  asOf: { lines: number; lastEventId: number };
  unrecognised: number;
}

// ---------- closed patterns ----------

const DATE_PATTERN: RegExp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const COUNTRY_PATTERN: RegExp = /^[A-Z]{2}$/;
// A wallet or transfer method that is not a currency code or a method, as on a
// payout found in Airwallex.
const UNPASSED_WALLET: string = "(a wallet PayOnce does not pass on)";
const UNPASSED_METHOD: string = "(a transfer method PayOnce does not pass on)";
// What a line may hold once its rule has run. A rule written too loosely fails
// here and the line becomes a stand-in.
const SAFE_LINE: RegExp = /^[A-Za-z0-9 .,:;()'%=+\-/[\]"#_]*$/;


// The Airwallex error codes PayOnce passes on. Any other becomes UNPASSED_CODE.
export const KNOWN_CODES: ReadonlySet<string> = new Set<string>([
  "duplicate_request_id",
  "quote_expired",
  "quote_id_invalid",
  "invalid_argument",
  "validation_failed",
  "insufficient_fund",
  "insufficient_funds",
  "operation_failed",
  "resource_not_found",
  "not_found",
  "unauthorized",
  "forbidden",
  "too_many_requests",
]);

// Regular expression sources for the slots a line or a reason may hold.
const REF: string = REFERENCE_SOURCE;
const UUID: string = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REF_OR_ID: string = `(?:${REF}|${UUID})`;
const STATUS: string = STATUS_SOURCE;
const INV: string = "[A-Za-z0-9-]{1,40}";
const INV_LIST: string = `${INV}(?:(?:, | and )${INV})*`;
const MONEY: string = String.raw`-?[0-9][0-9,]*\.[0-9]{2} ${CURRENCY_SOURCE}`;
const CUR: string = CURRENCY_SOURCE;
const METHOD: string = METHOD_SOURCE;
const RATE: string = String.raw`1 ${CURRENCY_SOURCE} = [0-9]+(?:\.[0-9]+)?(?:e[-+]?[0-9]+)? ${CURRENCY_SOURCE}`;
const PCT: string = String.raw`[0-9]+\.[0-9]{2}%`;
const CLOCK: string = "[0-9]{2}:[0-9]{2} UTC";
const DATE: string = "[0-9]{4}-[0-9]{2}-[0-9]{2}";
const N: string = "[0-9]{1,9}";
const KIND: string = "original|replacement";
const KIND_CAP: string = "Original|Replacement";
const DURATION: string = `${N} (?:minute|hour|day)s?`;
// The routes arrival.ts names, from its CORRIDORS table.
const ROUTE: string = "ACH|Next Day ACH|FedNow|Fedwire|SWIFT|SEPA";
const DAYS: string = "[0-9]+ business days?|[0-9]+ to [0-9]+ business days";
const CODE_LABEL: string = [...new Set<string>([...Object.values(RAIL_FAILURE_CODES), "rail failure"])]
  .map(escapeRegExp)
  .join("|");
const RAIL_CODES: string = String.raw`[0-9]{5} \((?:${CODE_LABEL})\)(?:(?:, | and )[0-9]{5} \((?:${CODE_LABEL})\))*`;
const PAID_WITH: string = String.raw`, paid with ${MONEY} at ${RATE}`;
const DRAFT_LABELS: readonly string[] = [
  "Payment sent",
  "Payment sent again",
  "We are looking into it",
  "We will call to confirm bank details",
  "Trace request to Airwallex",
  "Refund trace request to Airwallex",
];
const WEBHOOK_NEWS: string = "has been paid|has failed|was cancelled|is overdue";
const BARRED_WHY: ReadonlySet<string> = new Set<string>([
  "started this incident",
  "uploaded the pay run it came from",
  "recorded the callback for the new bank details",
]);
const CHANGED_FIELD: string = "payment|amount|currency|beneficiary|exchange rate|arrival estimate|evidence";
// A model's name as the reader and the explainer write it, from READER_MODEL.
const MODEL_PATTERN: RegExp = /^[A-Za-z0-9._:/-]{1,80}$/;
const MODEL_TRY: RegExp = new RegExp(`^(\\S+) (${TRY_WORDS_SOURCE})$`);
const SIMULATED: string = "SENT|PAID|FAILED";
const SANDBOX_TRANSFER: string = `transfer ${REF}|the transfer`;
// How the sandbox bank's lines end: the server's ending, pnpm recover's two, and
// the ending older code gave a transfer that converts.
const SANDBOX_ENDS: readonly string[] = [SANDBOX_BANK_AFTER, SANDBOX_BANK_STOPPED, SANDBOX_BANK_RECOVER];
const SANDBOX_END: string = `(${SANDBOX_ENDS.map(escapeRegExp).join("|")})`;
const OLD_CONVERTS_END: string = "If the bank has neither paid nor failed it by its deadline, a person hears about it";
const SANDBOX_ANSWER: string = `: it answered ([0-9]{3})(?: (${FAILURE_CODE_SOURCE}))?|: it did not answer`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pattern(source: string): RegExp {
  return new RegExp(`^(?:${source})$`);
}

function ref(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && REFERENCE_PATTERN.test(value) ? value : null;
}

function status(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && STATUS_PATTERN.test(value) ? value : null;
}

function date(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && DATE_PATTERN.test(value) ? value : null;
}

// A time PayOnce or Airwallex wrote, as an ISO time in UTC, or null.
function isoTime(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const at: number = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function money(minor: number | null, currency: string | null): string | null {
  return minor === null || currency === null || !Number.isFinite(minor) || !CURRENCY_PATTERN.test(currency)
    ? null
    : formatMoney(minor, currency);
}

// A bank failure code or an Airwallex error code in PayOnce's words.
function failureText(code: string | null | undefined): string | null {
  if (code === null || code === undefined || code === "") {
    return null;
  }
  if (/^[0-9]{5}$/.test(code)) {
    return `${code} ${FAILURE_WORDS[code] ?? "(a failure code PayOnce has no words for)"}`;
  }
  return KNOWN_CODES.has(code) ? code : UNPASSED_CODE;
}

function rate(fx: FxTerms | undefined): string | null {
  if (fx === undefined) {
    return null;
  }
  const text: string = describeRate(fx);
  return pattern(RATE).test(text) ? text : null;
}

function arrivalFacts(arrival: ArrivalTerms | null | undefined): ArrivalFacts | null {
  if (arrival === null || arrival === undefined) {
    return null;
  }
  const method: string = arrival.method === "LOCAL" || arrival.method === "SWIFT" ? arrival.method : "";
  const country: string = arrival.country !== null && COUNTRY_PATTERN.test(arrival.country) ? ` to ${arrival.country}` : "";
  const days: string =
    arrival.minDays === arrival.maxDays ? `${arrival.maxDays}` : `${arrival.minDays} to ${arrival.maxDays}`;
  const route: string | null =
    arrival.route !== null && pattern(ROUTE).test(arrival.route) && arrival.minDays !== null && arrival.maxDays !== null
      ? `${arrival.route}, usually ${days} business ${days === "1" ? "day" : "days"}`
      : method === ""
        ? null
        : `${method}${country}, arrival not known`;
  return {
    route,
    from: date(arrival.from),
    earliest: date(arrival.earliest),
    latest: date(arrival.latest),
    dueDate: date(arrival.dueDate),
  };
}

// ---------- the reason grammar ----------

// The summaries summarise and the engine write, and nothing else.
const SUMMARIES: readonly string[] = ((): string[] => {
  const parts: string[] = [
    "supplier reports the payment has not arrived",
    "asks for payment to a different account",
    "asks to hold, cancel or not pay the invoice",
  ];
  const found: string[] = [];
  for (let mask: number = 1; mask < 8; mask += 1) {
    found.push(parts.filter((_part: string, index: number): boolean => (mask & (1 << index)) !== 0).join(", "));
  }
  return [
    ...found,
    ...found.map((summary: string): string => `${summary}, and some emails could not be read`),
    "nothing relevant found",
    "the emails could not be read",
    "no emails on file",
    "the emails have not been read yet",
  ].sort((a: string, b: string): number => b.length - a.length);
})();

const EVIDENCE_TAIL: RegExp =
  /^(?:, [0-9]+ emails? on file(?:, [0-9]+ with text PayOnce could not read)?(?:, no supplier domain on file to check (?:1 sender|[0-9]+ senders) against|, [0-9]+ (?:sender does|senders do) not match the supplier on file)?)?$/;

function summaryText(text: string | null | undefined): string | null {
  return text !== null && text !== undefined && SUMMARIES.includes(text) ? text : null;
}

// emailEvidence's text, or null when it holds anything else, as terms written by
// older code that named sender addresses do.
function evidenceText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) {
    return null;
  }
  return SUMMARIES.some(
    (summary: string): boolean => text.startsWith(summary) && EVIDENCE_TAIL.test(text.slice(summary.length)),
  )
    ? text
    : null;
}

// What the leading part of a reason a person was sent for says, for the metrics.
// A part that never leads such a reason has none.
export type ReasonCode =
  | "bank-deadline"
  | "status"
  | "not-resendable"
  | "refused"
  | "sent-outside"
  | "bank-details"
  | "second-bill"
  | "supplier-email"
  | "cash"
  | "two-approvers"
  | "exchange-rate"
  | "outage"
  | "paid-twice"
  | "other";

interface ReasonPart {
  test: RegExp;
  render: (match: RegExpExecArray, builder: FactsBuilder) => string | null;
  code: ReasonCode | null;
}

function fixedPart(text: string, code: ReasonCode | null = null): ReasonPart {
  return { test: new RegExp(escapeRegExp(text), "y"), render: (): string => text, code };
}

function slotPart(source: string, render: ReasonPart["render"], code: ReasonCode | null = null): ReasonPart {
  return { test: new RegExp(source, "y"), render, code };
}

// A reason is one or more of these parts joined by ", and ". Each part is matched
// whole, at its position, so a part that holds ", and " itself is never split.
// The fixed parts come from the exported constants, so a reworded constant stays
// in step. Anything else fails closed to UNPASSED_REASON. Each part's code is what
// the metrics count a reason under when it leads.
const REASON_PARTS: readonly ReasonPart[] = [
  ...(
    [
      [OUTSIDE_PAYOUT_REASON, "sent-outside"],
      [NEW_BANK_DETAILS_REASON, "bank-details"],
      [NOT_TO_PAY_REASON, "supplier-email"],
      [CHANGED_BANK_DETAILS_REASON, "bank-details"],
      [UNVERIFIED_SENDER_REASON, "supplier-email"],
      [EMAILS_UNREAD_REASON, "supplier-email"],
      [PARTLY_UNREAD_REASON, "supplier-email"],
      [UNKNOWN_STATUS_REASON, "status"],
      [NON_RECEIPT_REASON, "supplier-email"],
      [SETTLED_REASON, null],
      [ORIGINAL_DEADLINE_REASON, "bank-deadline"],
      [IN_FLIGHT_REASON, "status"],
      [REPLACEMENT_FAILED_REASON, "not-resendable"],
      [NOT_RESENDABLE_REASON, "not-resendable"],
      [SENT_OUTSIDE_REASON, "sent-outside"],
      [BELOW_FLOOR_REASON, "cash"],
      [UNREADABLE_CASH_REASON, "cash"],
      [NO_FLOOR_REASON, "cash"],
      [NO_FLOOR_CLAUSE, "cash"],
      [TWO_APPROVERS_REASON, "two-approvers"],
      [REPLACE_REASON, null],
      [OUTAGE_REASON, "outage"],
      [NOT_TO_PAY_CLAUSE, "supplier-email"],
      [EMAILS_BEFORE_PAYMENT_REASON, "supplier-email"],
      [CASH_HOLD_REASON, "cash"],
      [REPLACEMENT_DEADLINE_REASON, "bank-deadline"],
      [LATE_TRANSFER_REASON, "paid-twice"],
      [MISMATCHED_TRANSFER_REASON, "paid-twice"],
      [MISMATCHED_FAILED_REASON, "paid-twice"],
      [LAST_PAID_CHANGED_REASON, "bank-details"],
      [UNCONFIRMED_ACCOUNT_REASON, "bank-details"],
      [ACCOUNT_CHANGED_REASON, "bank-details"],
      [RUN_ACCOUNT_CHANGED_REASON, "bank-details"],
      // accountProblem's other reason in engine.ts, which it does not export.
      ["the beneficiary is no longer in Airwallex", "bank-details"],
    ] as [string, ReasonCode | null][]
  )
    .sort((a: [string, ReasonCode | null], b: [string, ReasonCode | null]): number => b[0].length - a[0].length)
    .map(([text, code]: [string, ReasonCode | null]): ReasonPart => fixedPart(text, code)),
  slotPart(
    `a replacement paid from (${CUR}) takes a new exchange rate, so a person approves it`,
    (match: RegExpExecArray): string => match[0],
    "exchange-rate",
  ),
  slotPart(
    `it is paid from (${CUR}), so a person approves the exchange rate before PayOnce pays it`,
    (match: RegExpExecArray): string => match[0],
    "exchange-rate",
  ),
  slotPart(
    `it looks like a second bill for (${INV}), which is paid`,
    (match: RegExpExecArray, builder: FactsBuilder) => {
      const alias: string | null = builder.aliases.invoice(match[1] ?? "");
      return alias === null ? null : `it looks like a second bill for ${alias}, which is paid`;
    },
    "second-bill",
  ),
  slotPart(
    `it looks like a second bill for (${INV_LIST}): the same supplier and amount, and the same invoice number apart from (case, spacing, leading zeros or letters added at the end|case, spacing, zeros or a letter suffix)`,
    (match: RegExpExecArray, builder: FactsBuilder) => {
      const list: string | null = builder.aliases.invoiceList(match[1] ?? "");
      return list === null
        ? null
        : `it looks like a second bill for ${list}: the same supplier and amount, and the same invoice number apart from ${match[2] ?? ""}`;
    },
    "second-bill",
  ),
  slotPart(
    `it has the same invoice number as (${INV_LIST}), apart from case, spacing, leading zeros or letters added at the end, for the same supplier, and PayOnce pays an invoice number once`,
    (match: RegExpExecArray, builder: FactsBuilder) => {
      const list: string | null = builder.aliases.invoiceList(match[1] ?? "");
      return list === null
        ? null
        : `it has the same invoice number as ${list}, apart from case, spacing, leading zeros or letters added at the end, for the same supplier, and PayOnce pays an invoice number once`;
    },
    "second-bill",
  ),
  slotPart(
    String.raw`Airwallex refused the original payment(?: \(([^()]{1,60})\))?, so nothing was sent`,
    (match: RegExpExecArray): string =>
      match[1] === undefined
        ? "Airwallex refused the original payment, so nothing was sent"
        : `Airwallex refused the original payment (${failureText(match[1]) ?? UNPASSED_CODE}), so nothing was sent`,
    "refused",
  ),
  slotPart(
    String.raw`(?:${KIND}) ${REF} went out (?:with no exchange rate on it|at ${RATE} \((?:${MONEY}|amount not readable)\))(?:, and no approval covers the quote it was sent with|, not the approved ${RATE} \(${MONEY}\))`,
    (match: RegExpExecArray): string => match[0],
    "exchange-rate",
  ),
  slotPart(
    `(?:${KIND}) ${REF} went to bank details that are not the ones it was (?:decided or )?approved for`,
    (match: RegExpExecArray): string => match[0],
    "bank-details",
  ),
  slotPart(
    `(?:${KIND}) ${REF} shows no bank details, so PayOnce cannot check they are the ones it was decided or approved for`,
    (match: RegExpExecArray): string => match[0],
    "bank-details",
  ),
  slotPart(
    `(?:${KIND}) ${REF} was found in Airwallex after the invoice was closed`,
    (match: RegExpExecArray): string => match[0],
    "paid-twice",
  ),
];

// The reason grammar's parts and their codes, for the metrics' reasonCode, so a
// reason added to the grammar is coded in the same place.
export interface ReasonLead {
  readonly test: RegExp;
  readonly code: ReasonCode | null;
}
export const REASON_LEADS: readonly ReasonLead[] = REASON_PARTS;

// Why a payment needs more than one approver, in the words approvers.ts and the
// engine use. signoffProblem's "it now needs N approvers, because ..." holds one.
const WHY_PARTS: readonly ReasonPart[] = [
  fixedPart("it pays an account the original payment did not go to"),
  fixedPart("PayOnce does not know who started this payment"),
  fixedPart("PayOnce has never paid this beneficiary"),
  fixedPart("PayOnce has never paid this beneficiary on a person's approval"),
  fixedPart("it pays an account PayOnce has not paid this supplier before"),
  fixedPart("PayOnce paid this supplier before it kept which account each payment went to"),
  slotPart(`the amount is above (${MONEY})`, (match: RegExpExecArray): string => match[0]),
  slotPart(
    `it pays (?:a different account from the one|another account than the one) (${INV}) was (sent|paid) to`,
    (match: RegExpExecArray, builder: FactsBuilder) => {
      const alias: string | null = builder.aliases.invoice(match[1] ?? "");
      return alias === null ? null : `it pays a different account from the one ${alias} was ${match[2] ?? "sent"} to`;
    },
  ),
];

// Parses text from pos into parts, each followed by the end or ", and ". Backtracks,
// so a part that also matches a shorter prefix does not hide a longer one.
function parseParts(
  parts: readonly ReasonPart[],
  text: string,
  pos: number,
): { part: ReasonPart; match: RegExpExecArray }[] | null {
  for (const part of parts) {
    part.test.lastIndex = pos;
    const match: RegExpExecArray | null = part.test.exec(text);
    if (match === null) {
      continue;
    }
    const end: number = pos + match[0].length;
    if (end === text.length) {
      return [{ part, match }];
    }
    if (!text.startsWith(", and ", end)) {
      continue;
    }
    const rest: { part: ReasonPart; match: RegExpExecArray }[] | null = parseParts(parts, text, end + ", and ".length);
    if (rest !== null) {
      return [{ part, match }, ...rest];
    }
  }
  return null;
}

// ---------- aliases ----------

// Other invoices and people never reach the model by name. Each gets an alias in
// the order it first appears, and the legend swaps them back in the answer
// PayOnce shows.
class Aliases {
  private readonly invoices: Map<string, string> = new Map();
  private readonly people: Map<string, string> = new Map();
  private readonly entries: LegendEntry[] = [];
  // Longest first, so "Sam Lee" is tried before "Sam".
  private readonly known: string[];

  constructor(
    private readonly ledger: Ledger,
    private readonly self: string,
    known: string[],
  ) {
    const names: string[] = [];
    for (const name of known) {
      const trimmed: string = name.trim();
      if (trimmed !== "" && !names.some((other: string): boolean => sameName(other, trimmed))) {
        names.push(trimmed);
      }
    }
    this.known = names.sort((a: string, b: string): number => b.length - a.length);
  }

  // The alias of an invoice in the ledger, "this invoice" for the one explained,
  // or null for a value that is not an invoice PayOnce has.
  invoice(invoiceId: string): string | null {
    if (invoiceId === this.self) {
      return "this invoice";
    }
    if (!INVOICE_ID_PATTERN.test(invoiceId) || this.ledger.obligation(invoiceId) === undefined) {
      return null;
    }
    let alias: string | undefined = this.invoices.get(invoiceId);
    if (alias === undefined) {
      alias = `[invoice ${this.invoices.size + 1}]`;
      this.invoices.set(invoiceId, alias);
      this.entries.push({ alias, value: invoiceId });
    }
    return alias;
  }

  // "A, B and C" with each one aliased, or null when any is not an invoice.
  invoiceList(text: string): string | null {
    const aliases: (string | null)[] = text
      .split(/, | and /)
      .map((invoiceId: string): string | null => this.invoice(invoiceId));
    return aliases.some((alias: string | null): boolean => alias === null) ? null : listOf(aliases as string[]);
  }

  // The aliases of the invoices in the ledger, leaving out any that is not.
  invoiceAliases(invoiceIds: string[]): string[] {
    return invoiceIds
      .map((invoiceId: string): string | null => this.invoice(invoiceId))
      .filter((alias: string | null): alias is string => alias !== null);
  }

  private knownName(name: string): string | undefined {
    return this.known.find((candidate: string): boolean => sameName(candidate, name));
  }

  // A known person's alias, or "a person": a typed name is never passed on.
  person(name: string | null): string {
    const known: string | undefined = name === null ? undefined : this.knownName(name);
    if (known === undefined) {
      return A_PERSON;
    }
    const key: string = known.toLowerCase();
    let alias: string | undefined = this.people.get(key);
    if (alias === undefined) {
      alias = `[person ${this.people.size + 1}]`;
      this.people.set(key, alias);
      this.entries.push({ alias, value: known });
    }
    return alias;
  }

  // Known names joined by ", " and " and ", as signersOf writes them.
  private parsePeople(text: string, depth: number = 0): string[] | null {
    if (depth > 12) {
      return null;
    }
    for (const name of this.known) {
      if (sameName(text, name)) {
        return [name];
      }
      for (const separator of [", ", " and "]) {
        if (text.length > name.length + separator.length && sameName(text.slice(0, name.length), name) && text.startsWith(separator, name.length)) {
          const rest: string[] | null = this.parsePeople(text.slice(name.length + separator.length), depth + 1);
          if (rest !== null) {
            return [name, ...rest];
          }
        }
      }
    }
    return null;
  }

  // A list of names as aliases, or "a person" when it is not made of known names.
  peopleText(text: string): string {
    const names: string[] | null = this.parsePeople(text.trim());
    return names === null ? A_PERSON : listOf(names.map((name: string): string => this.person(name)));
  }

  // The people at the start of text, up to the first place a separator follows a
  // list of known names. Used where a typed note follows the names.
  peopleBefore(text: string, separator: string): string {
    for (let at: number = text.indexOf(separator); at > 0; at = text.indexOf(separator, at + 1)) {
      const names: string[] | null = this.parsePeople(text.slice(0, at));
      if (names !== null) {
        return listOf(names.map((name: string): string => this.person(name)));
      }
    }
    return A_PERSON;
  }

  legend(): LegendEntry[] {
    return [...this.entries];
  }
}

function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// ---------- timeline lines ----------

// Where a line comes from: its kind, and its topic after a slash when it has one.
// Every rule and fixed line names the sources PayOnce writes it from, and passes
// a line from no other. An error line holds any error's message and a callback
// line starts with a name a person typed, so without this either could read as a
// decision, a bank line or a closing line.
type Source = string;

const DECISION: Source = "decision/decision";
const WAITING: Source = "approval/waiting";
const APPROVAL: Source = "approval";
const SIGNOFF: Source = "approval/approval";
const PAYMENT: Source = "payment";
const PAYMENT_WAITING: Source = "payment/waiting";
const WARNING: Source = "warning";
const BANK: Source = "bank";
// An error line passes only through a rule that gives PayOnce's own words for
// one of PayOnce's own errors. None of those rules keeps the line as written.
const ERROR: Source = "error";
const LOCK: Source = "lock";
const CLOSED: Source = "closed";
const CALLBACK: Source = "callback";
const EMAIL: Source = "email";
const OUTAGE: Source = "outage";
const OUTAGE_WAITING: Source = "outage/waiting";
const OUTBOX: Source = "outbox/outbox";

function sourceOf(event: LedgerEvent): Source {
  if (event.topic === null) {
    return event.kind;
  }
  return `${event.kind}/${event.topic.startsWith("outbox:") ? "outbox" : event.topic}`;
}

interface LineRule {
  from: readonly Source[];
  test: RegExp;
  line: (match: RegExpExecArray, builder: FactsBuilder) => string;
}

function keep(from: readonly Source[], source: string): LineRule {
  return { from, test: pattern(source), line: (match: RegExpExecArray): string => match[0] };
}

function rule(from: readonly Source[], source: string, line: LineRule["line"]): LineRule {
  return { from, test: pattern(source), line };
}

function fixedFrom(from: readonly Source[], lines: readonly string[]): [string, readonly Source[]][] {
  return lines.map((line: string): [string, readonly Source[]] => [line, from]);
}

// Lines PayOnce writes with no slot at all, kept as written, each with the
// sources it is written from.
const FIXED_LINES: ReadonlyMap<string, readonly Source[]> = new Map<string, readonly Source[]>([
  ...fixedFrom(
    [WAITING],
    [
      "Waiting on a person",
      "Waiting on a person. A payout sent outside PayOnce may already pay this invoice, so PayOnce sends nothing",
      "Waiting on a person. A payout sent outside PayOnce may also pay this invoice, which PayOnce has paid once. Check it with the supplier and close the incident. PayOnce will not send a second payment",
      "Waiting on a person to check with the supplier and close the incident. PayOnce will not send a second payment",
      "Waiting on a person to check the exchange rate a payment went out at and close the incident. PayOnce will not send another payment",
      "Waiting on a person to check the bank details a payment went to and close the incident. PayOnce will not send another payment",
      "Waiting on a person. The bank details on file are not the ones the original went to, and no phone number is on file to verify them by calling the supplier back",
      "Waiting on a person. Supplier emails are on file that PayOnce could not read yet, so it asks nobody to approve paying this invoice. It tries reading them again in a minute",
      "Waiting on a person. A supplier email arrived while PayOnce read the others, so it asks nobody to approve paying this invoice until it has read that one too",
      "Waiting on a person. The beneficiary is no longer in Airwallex, so there is nothing to pay it to. Close the invoice without paying",
      "Waiting on a person. The bank details on file are not the ones the pay run approved, so PayOnce does not pay this invoice. Close it without paying, or restore the approved details in Airwallex and check again",
      "Waiting on a person. The bank details on file are not the ones the original went to, and no phone number is on file to verify them by calling the supplier back. Close the invoice without paying, or restore the details the original went to in Airwallex and check again",
      "Waiting on a person. The bank details on file are not the ones PayOnce last paid this supplier, and no phone number is on file to verify them by calling the supplier back. Close the invoice without paying, or restore the details PayOnce last paid in Airwallex and check again",
      "Waiting on a person. The bank details on file are not the ones this payment was decided or approved for, so PayOnce does not send it again. Restore those details in Airwallex and check again to send it",
      ...["original", "replacement"].map(
        (kind: string): string =>
          `Waiting on a person. The ${kind} was marked failed without being sent, so restoring those details no longer sends it: paying this invoice now takes a person's approval, or a person closes it without paying`,
      ),
    ],
  ),
  ...fixedFrom(["warning/bank-details"], ["The supplier's bank details on file are not the ones the original payment went to"]),
  ...fixedFrom(
    [APPROVAL],
    [
      "Approval request withdrawn: a transfer that does not match this invoice is live under one of its request ids",
      "Approval request withdrawn: the supplier may have been paid twice",
      "Approval request withdrawn: a payout for this invoice was sent outside PayOnce",
      "Approval request withdrawn: nobody on the approver list can approve it",
      "Approval request withdrawn: the terms changed, so PayOnce takes a new exchange rate quote and opens a new request",
      "Approval request withdrawn: the bank details on file have not been verified by a callback",
      "Approval request withdrawn: it was for the old bank details",
      `Approval request withdrawn: ${EMAILS_UNREAD_REASON}`,
      "Approval request withdrawn: the beneficiary is no longer in Airwallex",
      "Approval request withdrawn: the bank details on file are not the ones the pay run approved",
      "Approval request expired before anyone approved it, so PayOnce opened a new one",
      "Approval request expired before enough people approved it, so PayOnce opened a new one",
      "Approval terms now count the supplier emails on file and name no sender address, so the open approval no longer matches them",
      "Approval terms now count the supplier emails on file and name no sender address, so the open request no longer matches them",
    ],
  ),
  ...fixedFrom(
    [CLOSED],
    ["Incident closed: the original failed and one replacement was paid", "Incident closed: the original payment arrived"],
  ),
  ...fixedFrom(
    [ERROR],
    [
      "The ledger does not show this invoice as paid once, so the incident stays open",
      "PayOnce could not confirm whether the supplier's record changed. Record the callback again once Airwallex answers",
    ],
  ),
  ...fixedFrom([EMAIL], ["This incident is closed. The email is on file and does not reopen it"]),
  ...fixedFrom(
    ["payment/floor"],
    [
      "A replacement and its transfer fee would now leave cash above the reserve floor",
      "A replacement and its transfer fee would now leave cash above the reserve floor. An approval of a request that named the floor still counts",
    ],
  ),
  ...fixedFrom(["warning/cost"], ["The reserve floor setting could not be read, so PayOnce did not pay this invoice"]),
  ...fixedFrom(
    [WARNING],
    [
      "Pay again not sent. The incident is closed, so PayOnce pays nothing more for this invoice",
      "Pay again not sent. A person closed this invoice without paying, because it was a second bill for another invoice",
      "Pay again not sent. A person closed this invoice without paying, as a second bill for another",
      "Pay again not sent. A person closed this invoice without paying",
      "Pay again not sent. A payout sent outside PayOnce may already pay this invoice",
      "Pay again not sent. PayOnce is holding this invoice before paying it, so it pays only on an approval",
      "Pay again not sent. No payment for this invoice is live, so a replacement goes through the policy, and through a person's approval once the invoice is with a person",
    ],
  ),
  ...fixedFrom([LOCK], ["Pay again refused by the duplicate lock. An invoice can have one live payment"]),
]);

const HELD_SUFFIXES: readonly string[] = [
  ". This invoice was escalated, so it still needs a person's approval",
  ". This invoice was escalated, so a person closes it",
];
const ARRIVAL_MARKERS: readonly string[] = [
  ". A replacement sent on ",
  ". PayOnce has no arrival estimate for a replacement by ",
];
const CAUSE: string = String.raw`payout ${REF} sent outside PayOnce has paid this invoice|payout ${REF} sent outside PayOnce names this invoice and is paid, but (?:does not match|PayOnce could not check) its amount, currency or account|(?:${KIND}) (?:${REF_OR_ID})?, found late, is live at the bank and may pay this invoice|transfer (?:${REF_OR_ID})? under the failed (?:${KIND})'s request id is paid but does not match this invoice|the bank details on file are not the ones it was decided or approved for`;
const THEN: string = `a person checks it, and can close the invoice without paying|a person can close the invoice|(?:${KIND}) (?:${REF_OR_ID})? counts as this invoice's payment|a person decides how to pay the invoice, or closes it without paying`;
const OUTAGE_LEAD: string = `Outage ${N} on ${CUR} (?:${METHOD}), declared at ${CLOCK}`;
// holdLine's endings in outages.ts.
const HOLD_ENDINGS: string = [
  ", holds this invoice's first payment. PayOnce sends it once a person ends the outage, after the checks it makes before any payment",
  ": PayOnce does not send a replacement by itself while it lasts, so a person approves it. An approval given now is kept until the outage ends and still expires when it would",
  ", holds the approved payment. The approval stays approved and unspent, and PayOnce sends the payment once a person ends the outage, if the approval has not expired by then",
  ", holds this invoice's payments",
]
  .map(escapeRegExp)
  .join("|");

// A transfer as the sandbox bank's line names it, from the captured slot.
function sandboxTransfer(named: string | undefined): string {
  return named === undefined || named === "the transfer" ? "the transfer" : named;
}

// The fixed ending a sandbox bank line had.
function sandboxEnd(ending: string | undefined): string {
  return SANDBOX_ENDS.find((end: string): boolean => end === ending) ?? SANDBOX_BANK_AFTER;
}

// What the simulator answered, as the sandbox bank's line gives it, with the code
// only when PayOnce passes that code on.
function sandboxAnswer(answer: string | undefined, status: string | undefined, code: string | undefined): string {
  if (answer === undefined) {
    return "";
  }
  if (status === undefined) {
    return ": it did not answer";
  }
  return `: it answered ${status}${code !== undefined && KNOWN_CODES.has(code) ? ` ${code}` : ""}`;
}

// A bank line's failure: the code in PayOnce's words. Airwallex's message is never
// passed on.
function bankFailure(code: string | undefined): string {
  return code === undefined ? "" : `, failure ${failureText(code) ?? UNPASSED_CODE}`;
}

// Checked in order. The first rule whose pattern matches the whole line gives what
// is passed on. A rule either keeps the line, when every slot in it is a closed
// pattern, or rewrites it in fixed words with only the safe slots.
const LINE_RULES: readonly LineRule[] = [
  // Decisions: the action and the reason, through the grammar. The arrival clause
  // is dropped, because the arrival is in the facts as fields.
  rule([DECISION], "(Wait|Replace|Escalate|Close): ([\\s\\S]+)", (match: RegExpExecArray, builder: FactsBuilder): string => {
    let body: string = match[2] ?? "";
    for (const marker of ARRIVAL_MARKERS) {
      const at: number = body.indexOf(marker);
      if (at >= 0) {
        body = body.slice(0, at);
      }
    }
    const held: string = HELD_SUFFIXES.find((suffix: string): boolean => body.endsWith(suffix)) ?? "";
    return `${match[1] ?? ""}: ${builder.reason(body.slice(0, body.length - held.length))}${held}`;
  }),

  // Waiting lines.
  keep([PAYMENT_WAITING], `Waiting for the bank to pay or fail original ${REF}\\. If it has done neither within ${DURATION} of sending, a person hears about it`),
  keep([PAYMENT_WAITING], `Waiting for the bank to pay replacement ${REF}(?:\\. If it has not paid or failed it within ${DURATION} of sending, a person hears about it)?`),
  keep([WAITING], `Waiting on a person\\. (?:${KIND_CAP}) ${REF} is still with the bank, so PayOnce sends nothing more`),
  keep([WAITING], `Waiting on a person\\. Transfer (?:${REF_OR_ID})?, under the (?:${KIND})'s request id, is paid but does not match this invoice\\. Check it with the supplier and close the incident\\. PayOnce sends nothing more`),
  keep([WAITING], `Waiting on a person\\. Transfer (?:${REF_OR_ID})?, under the (?:${KIND})'s request id, does not match this invoice and is still with the bank, so PayOnce sends nothing`),
  keep([WAITING], `Waiting on a person\\. (?:${KIND_CAP}) (?:${REF_OR_ID})? and another payment for this invoice may both pay the supplier, so PayOnce sends nothing`),
  keep(
    [WAITING],
    `Waiting on a person to check (?:transfer|transfers) ${REF_OR_ID}(?:(?:, | and )${REF_OR_ID})*, listed under this invoice's request (?:id|ids), which (?:does|do) not match it, and close the incident\\. PayOnce will not send a second payment`,
  ),
  rule(
    [WAITING],
    "Waiting on a person\\. Approvals are refused: [\\s\\S]*",
    (): string => "Waiting on a person. Approvals are refused because the APPROVERS setting cannot be used",
  ),
  // approveOrWait's line in engine.ts when too few people on the list could
  // approve: the reason goes through the grammar, so another invoice in it is an
  // alias, and the names that can approve become aliases.
  rule(
    [WAITING],
    `Waiting on a person\\. (?<payment>A replacement of ${MONEY}|Paying ${MONEY} for this invoice)(?<about>, about ${MONEY},)? needs (?:one approver|(?<count>${N}) approvers, because (?<why>[\\s\\S]+?),) and (?:nobody on the approver list can|only (?<able>[\\s\\S]+) can) approve it\\. Change APPROVERS, restart and check again`,
    (match: RegExpExecArray, builder: FactsBuilder): string => {
      const slots: Record<string, string | undefined> = match.groups ?? {};
      const needs: string =
        slots["count"] === undefined
          ? "one approver"
          : `${slots["count"]} approvers, because ${builder.why(slots["why"] ?? "")},`;
      const able: string =
        slots["able"] === undefined ? "nobody on the approver list can" : `only ${builder.aliases.peopleText(slots["able"])} can`;
      return `Waiting on a person. ${slots["payment"] ?? ""}${slots["about"] ?? ""} needs ${needs} and ${able} approve it. Change APPROVERS, restart and check again`;
    },
  ),
  rule(
    [WAITING],
    `Waiting on a person to approve (${MONEY}) to [\\s\\S]+? \\(the account on file\\)(${PAID_WITH})?`,
    (match: RegExpExecArray): string => `Waiting on a person to approve a replacement of ${match[1] ?? ""}${match[2] ?? ""}`,
  ),
  rule(
    [WAITING],
    `Waiting on (${N}) approvers for (${MONEY}) to [\\s\\S]+? \\(the account on file\\)(${PAID_WITH})?, because ([\\s\\S]+)`,
    (match: RegExpExecArray, builder: FactsBuilder): string =>
      `Waiting on ${match[1] ?? ""} approvers for a replacement of ${match[2] ?? ""}${match[3] ?? ""}, because ${builder.why(match[4] ?? "")}`,
  ),
  rule(
    [WAITING],
    `Waiting on a person to approve paying (${MONEY}) to [\\s\\S]+? \\(the account on file\\)(${PAID_WITH})?, or to close the invoice without paying`,
    (match: RegExpExecArray): string =>
      `Waiting on a person to approve paying ${match[1] ?? ""} for this invoice${match[2] ?? ""}, or to close the invoice without paying`,
  ),
  rule(
    [WAITING],
    `Waiting on (${N}) approvers to pay (${MONEY}) to [\\s\\S]+? \\(the account on file\\)(${PAID_WITH})?, because ([\\s\\S]+), or on a person to close the invoice without paying`,
    (match: RegExpExecArray, builder: FactsBuilder): string =>
      `Waiting on ${match[1] ?? ""} approvers to pay ${match[2] ?? ""} for this invoice${match[3] ?? ""}, because ${builder.why(match[4] ?? "")}, or on a person to close the invoice without paying`,
  ),
  rule(
    [WAITING],
    "Waiting on a person\\. ([\\s\\S]+) closed this invoice without paying, so PayOnce asks nobody to approve paying it",
    (match: RegExpExecArray, builder: FactsBuilder): string =>
      `Waiting on a person. ${capitalise(builder.aliases.person(match[1] ?? ""))} closed this invoice without paying, so PayOnce asks nobody to approve paying it`,
  ),
  rule(
    [WAITING],
    "Waiting on a person to close it again\\. ([\\s\\S]+) closed this invoice without paying, and PayOnce asks nobody to approve paying it",
    (match: RegExpExecArray, builder: FactsBuilder): string =>
      `Waiting on a person to close it again. ${capitalise(builder.aliases.person(match[1] ?? ""))} closed this invoice without paying, and PayOnce asks nobody to approve paying it`,
  ),
  rule(
    [WAITING],
    "Waiting on a person to call the supplier on [\\s\\S]+, the number on file, and record the callback\\. PayOnce pays an account the original did not go to only after that",
    (): string =>
      "Waiting on a person to call the supplier on the number on file and record the callback. PayOnce pays an account the original did not go to only after that",
  ),
  rule(
    [WAITING],
    "Waiting on a person to call the supplier on [\\s\\S]+, the number on file, and record the callback\\. PayOnce pays an account it has not paid this supplier before only after that",
    (): string =>
      "Waiting on a person to call the supplier on the number on file and record the callback. PayOnce pays an account it has not paid this supplier before only after that",
  ),
  keep([PAYMENT_WAITING], `Waiting for its turn in pay run ${N}\\. The server sends the run's first payments one at a time`),
  rule(
    [OUTAGE_WAITING],
    `(Waiting on a person to end outage ${N} on ${CUR} (?:${METHOD})\\. PayOnce checks again every minute)(?:\\. The approval by ([\\s\\S]+) is kept and counts until (${CLOCK}))?`,
    (match: RegExpExecArray, builder: FactsBuilder): string =>
      match[2] === undefined
        ? (match[1] ?? "")
        : `${match[1] ?? ""}. The approval by ${builder.aliases.peopleText(match[2])} is kept and counts until ${match[3] ?? ""}`,
  ),

  // The cost of a replacement and the floor.
  keep(
    ["payment/cost", "warning/cost"],
    `A replacement(?: of ${MONEY})? costs ${MONEY}(?: with a second ${MONEY} transfer fee)?(?:, and ${MONEY} is committed to other payments not sent yet)?\\. Cash after it: ${MONEY}, (?:no reserve floor is set for ${CUR}|reserve floor ${MONEY}|the reserve floor setting could not be read)`,
  ),
  keep(["warning/cost"], `Paying it now would leave ${MONEY}, ${MONEY} below the reserve floor of ${MONEY}`),
  rule(
    ["warning/floor", "warning/second-bill"],
    "Also, ([\\s\\S]+?)(\\. The approval request says this too(?:, and only an approval of that request releases a replacement)?)?",
    (match: RegExpExecArray, builder: FactsBuilder): string => `Also, ${builder.reason(match[1] ?? "")}${match[2] ?? ""}`,
  ),

  // Bank details and second bills.
  keep(["warning/last-paid"], `The bank details on file are not the ones PayOnce last paid this supplier, with ${REF_OR_ID}`),
  rule(["warning/bank-details"], `The account on file for this invoice is not the one (${INV}) was (sent|paid) to`, (match: RegExpExecArray, builder: FactsBuilder): string =>
    `The account on file for this invoice is not the one ${builder.aliases.invoice(match[1] ?? "") ?? "another invoice"} was ${match[2] ?? "sent"} to`,
  ),
  rule(
    [WARNING],
    `(${INV}) has the same invoice number as this invoice, for the same supplier, so PayOnce held it before paying`,
    (match: RegExpExecArray, builder: FactsBuilder): string =>
      `${capitalise(builder.aliases.invoice(match[1] ?? "") ?? "another invoice")} has the same invoice number as this invoice, for the same supplier, so PayOnce held it before paying`,
  ),
  rule([WARNING], `(${INV}) looks like a second bill for this invoice, so PayOnce held it before paying`, (match: RegExpExecArray, builder: FactsBuilder): string =>
    `${capitalise(builder.aliases.invoice(match[1] ?? "") ?? "another invoice")} looks like a second bill for this invoice, so PayOnce held it before paying`,
  ),
  rule(
    [WARNING],
    `This invoice also looks like a second bill for (${INV_LIST}): the same supplier and amount, and the same invoice number apart from case, spacing, leading zeros or letters added at the end`,
    (match: RegExpExecArray, builder: FactsBuilder): string =>
      `This invoice also looks like a second bill for ${builder.aliases.invoiceList(match[1] ?? "") ?? "other invoices"}: the same supplier and amount, and the same invoice number apart from case, spacing, leading zeros or letters added at the end`,
  ),
  rule([WARNING], `(${INV}) was closed without paying by ([\\s\\S]+), as a second bill for this invoice`, (match: RegExpExecArray, builder: FactsBuilder): string =>
    `${capitalise(builder.aliases.invoice(match[1] ?? "") ?? "another invoice")} was closed without paying by ${builder.aliases.person(match[2] ?? "")}, as a second bill for this invoice`,
  ),

  // Payments PayOnce sends. The supplier's name, which for a pay run row or a
  // found payout is the account name in Airwallex, is dropped.
  rule([PAYMENT], `(${KIND_CAP}) (${REF}) sent: (${MONEY}) to [\\s\\S]*`, (match: RegExpExecArray): string =>
    `${match[1] ?? ""} ${match[2] ?? ""} sent: ${match[3] ?? ""}`,
  ),
  keep(
    [PAYMENT, WARNING],
    `(?:${KIND_CAP}) ${REF} (?:usually arrives (?:on ${DATE}|between ${DATE} and ${DATE})\\. (?:${ROUTE}) takes (?:${DAYS})(?:\\. Due ${DATE}, so it should arrive in time|\\. Due ${DATE}, so it may arrive late|\\. Due ${DATE}, so even at its fastest it arrives late|\\. The due date, ${DATE}, has already passed)?\\. ${escapeRegExp(HOLIDAYS_NOTE)}|has no arrival estimate, because PayOnce has no figures for (?:${METHOD})(?: to [A-Z]{2})?(?:\\. Due ${DATE}|\\. The due date, ${DATE}, has already passed)?)`,
  ),
  rule([PAYMENT, WARNING], `(${KIND_CAP}) (${REF}) (?:usually arrives|has no arrival estimate)[\\s\\S]*`, (match: RegExpExecArray): string =>
    `${match[1] ?? ""} ${match[2] ?? ""}: PayOnce recorded when it usually arrives`,
  ),
  keep([WARNING], `(?:${KIND_CAP}) ${REF} went to bank details that are not the ones it was (?:decided or )?approved for`),
  keep([WARNING], `(?:${KIND_CAP}) ${REF} shows no bank details, so PayOnce cannot check they are the ones it was decided or approved for`),
  rule([WARNING], `(${KIND_CAP}) (${REF} went out[\\s\\S]*)`, (match: RegExpExecArray, builder: FactsBuilder): string =>
    capitalise(builder.reason(`${(match[1] ?? "").toLowerCase()} ${match[2] ?? ""}`)),
  ),
  keep([PAYMENT], `Quote for ${MONEY}: ${MONEY} at ${RATE}, ${PCT} from mid-market, held until [0-9]{2}:[0-9]{2} UTC(?:\\. The last request's quote was ${RATE} \\(${MONEY}\\))?`),
  keep(["payment/retry"], `(?:${KIND_CAP}) payment marked failed: Airwallex lists no transfer under its request id a bank deadline after it was last tried, and (?:${CAUSE})\\. PayOnce sent nothing for it, so (?:${THEN})`),
  keep(["warning/retry"], `(?:${KIND_CAP}) payment not sent again: (?:${CAUSE})\\. If Airwallex still lists no transfer for the (?:${KIND}) at [0-9]{2}:[0-9]{2} UTC, a bank deadline after it was last tried, PayOnce marks it failed and (?:${THEN})`),
  keep(["warning/retry"], `(?:${KIND_CAP}) payment not sent again: a payout for this invoice was sent outside PayOnce and may already pay it\\. The (?:${KIND}) stays open under its request id, and a later look sends it only if that payout fails`),
  rule(
    [PAYMENT],
    `(${KIND_CAP}) payment never became a transfer: its exchange rate quote ran out, and Airwallex refused a last try under the same request id and lists no transfer with it \\(([^()]*)\\)\\. Nothing was sent, so it needs a new approval on a new quote`,
    (match: RegExpExecArray): string =>
      `${match[1] ?? ""} payment never became a transfer: its exchange rate quote ran out, and Airwallex refused a last try under the same request id and lists no transfer with it (${/^[0-9]{3}$/.test(match[2] ?? "") ? (match[2] ?? "") : (failureText(match[2]) ?? UNPASSED_CODE)}). Nothing was sent, so it needs a new approval on a new quote`,
  ),
  keep(
    [WARNING],
    `(?:${KIND_CAP}) payment PayOnce had marked failed has a transfer under its request id that does not match this invoice: Airwallex lists ${REF} ${STATUS} under it with another reference, amount or currency\\. PayOnce did not record it as the (?:${KIND}), sends nothing for this invoice while the bank has it, and a person checks it`,
  ),
  rule(
    [WARNING, BANK],
    `(${KIND_CAP}) payment PayOnce had marked failed is a transfer after all: Airwallex now lists (${REF}) (${STATUS})(?:, (\\S+)[\\s\\S]*?)? under its request id(\\. (?:A payout sent outside PayOnce for this invoice|Another payment PayOnce sent for this invoice) has not failed either, so the supplier may have been paid twice)?(\\. PayOnce still lists the (?:${KIND}) as failed, because it keeps one live payment per invoice)?`,
    (match: RegExpExecArray): string =>
      `${match[1] ?? ""} payment PayOnce had marked failed is a transfer after all: Airwallex now lists ${match[2] ?? ""} ${match[3] ?? ""}${bankFailure(match[4])} under its request id${match[5] ?? ""}${match[6] ?? ""}`,
  ),

  // What the bank did. Airwallex's failure message is dropped.
  rule([BANK], `(${KIND_CAP}) (${REF}) (${STATUS})(?:, (\\S+)[\\s\\S]*)?`, (match: RegExpExecArray): string =>
    `${match[1] ?? ""} ${match[2] ?? ""} ${match[3] ?? ""}${bankFailure(match[4])}`,
  ),
  rule([BANK], `Payout sent outside PayOnce (${REF}) (${STATUS})(?:, (\\S+)[\\s\\S]*)?`, (match: RegExpExecArray): string =>
    `Payout sent outside PayOnce ${match[1] ?? ""} ${match[2] ?? ""}${bankFailure(match[3])}`,
  ),
  rule(
    [BANK],
    `Transfer under the (${KIND})'s request id that does not match this invoice: (${REF}) (${STATUS})(?:, (\\S+)[\\s\\S]*)?`,
    (match: RegExpExecArray): string =>
      `Transfer under the ${match[1] ?? ""}'s request id that does not match this invoice: ${match[2] ?? ""} ${match[3] ?? ""}${bankFailure(match[4])}`,
  ),
  keep([BANK], `Webhook from Airwallex: (?:${KIND}) ${REF} (?:${WEBHOOK_NEWS})\\. Checking it`),
  rule([BANK], `Found payout (${REF}), sent outside PayOnce: [\\s\\S]*`, (match: RegExpExecArray): string =>
    `Found payout ${match[1] ?? ""}, sent outside PayOnce`,
  ),
  rule([WARNING], `Payout (${REF}) for this invoice was sent outside PayOnce: [\\s\\S]*`, (match: RegExpExecArray): string =>
    `Payout ${match[1] ?? ""} for this invoice was sent outside PayOnce`,
  ),
  rule([WARNING], `Payout (${REF}) was sent outside PayOnce with reference [\\s\\S]*`, (match: RegExpExecArray): string =>
    `Payout ${match[1] ?? ""} was sent outside PayOnce with a reference that nearly matches this invoice's number, to the same supplier for the same amount`,
  ),
  rule(
    [WARNING],
    `Its reference [\\s\\S]* nearly matches (${INV}), which is closed\\. Check it is not the same bill before approving a replacement`,
    (match: RegExpExecArray, builder: FactsBuilder): string =>
      `Its reference nearly matches ${builder.aliases.invoice(match[1] ?? "") ?? "another invoice"}, which is closed. Check it is not the same bill before approving a replacement`,
  ),

  // Approvals. Names become aliases, and the pay-to account is dropped.
  rule([APPROVAL], "Approval by ([\\s\\S]+?) expired before it was used", (match: RegExpExecArray, builder: FactsBuilder): string =>
    `Approval by ${builder.aliases.peopleText(match[1] ?? "")} expired before it was used`,
  ),
  rule(
    [APPROVAL],
    `Approval by ([\\s\\S]+?) is void: ((?:${CHANGED_FIELD})(?:, (?:${CHANGED_FIELD}))*) changed`,
    (match: RegExpExecArray, builder: FactsBuilder): string =>
      `Approval by ${builder.aliases.peopleText(match[1] ?? "")} is void: ${match[2] ?? ""} changed`,
  ),
  rule([APPROVAL], "Approval by ([\\s\\S]+?) is void: ([\\s\\S]+)", (match: RegExpExecArray, builder: FactsBuilder): string => {
    const problem: string = match[2] ?? "";
    const needs: RegExpExecArray | null = /^it now needs ([0-9]{1,3}) approvers, because ([\s\S]+)$/.exec(problem);
    const said: string =
      problem === "an approver signed different terms"
        ? problem
        : needs !== null
          ? `it now needs ${needs[1] ?? ""} approvers, because ${builder.why(needs[2] ?? "")}`
          : "the approval policy now refuses it";
    return `Approval by ${builder.aliases.peopleText(match[1] ?? "")} is void: ${said}`;
  }),
  rule([APPROVAL], "Approval by ([\\s\\S]+?) matches the current terms(, so PayOnce pays the invoice)?", (match: RegExpExecArray, builder: FactsBuilder): string =>
    `Approval by ${builder.aliases.peopleText(match[1] ?? "")} matches the current terms${match[2] ?? ""}`,
  ),
  rule(
    [APPROVAL],
    "Approval by ([\\s\\S]+?) no longer counts: the terms changed, so PayOnce (takes a new exchange rate quote and opens a new request|opened a new request)",
    (match: RegExpExecArray, builder: FactsBuilder): string =>
      `Approval by ${builder.aliases.peopleText(match[1] ?? "")} no longer counts: the terms changed, so PayOnce ${match[2] ?? ""}`,
  ),
  rule([APPROVAL], "Approval request withdrawn: ([\\s\\S]+) closed this invoice without paying", (match: RegExpExecArray, builder: FactsBuilder): string =>
    `Approval request withdrawn: ${builder.aliases.person(match[1] ?? "")} closed this invoice without paying`,
  ),
  rule([SIGNOFF], "Approved by ([\\s\\S]+)", (match: RegExpExecArray, builder: FactsBuilder): string =>
    `Approved by ${builder.aliases.peopleBefore(match[1] ?? "", ": ")}`,
  ),
  rule([SIGNOFF], `([\\s\\S]+) approved [\\s\\S]+\\. It needs (${N}) more (approvers?)`, (match: RegExpExecArray, builder: FactsBuilder): string =>
    `${capitalise(builder.aliases.peopleBefore(match[0], " approved "))} approved. It needs ${match[2] ?? ""} more ${match[3] ?? "approvers"}`,
  ),
  rule([APPROVAL], `Opened from pay run (${N}), row (${N}) \\([\\s\\S]*`, (match: RegExpExecArray): string =>
    `Opened from pay run ${match[1] ?? ""}, row ${match[2] ?? ""}, released on the run's approved request`,
  ),
  rule([PAYMENT], "Incident opened(?: by ([\\s\\S]+))?", (match: RegExpExecArray, builder: FactsBuilder): string =>
    match[1] === undefined ? "Incident opened" : `Incident opened by ${builder.aliases.person(match[1])}`,
  ),

  // Closing.
  rule(
    [CLOSED],
    "Closed without paying again\\. (Every payment for this invoice has failed at the bank|The payout sent outside PayOnce failed), and ([\\s\\S]+) had already closed (it|this invoice) without paying",
    (match: RegExpExecArray, builder: FactsBuilder): string =>
      `Closed without paying again. ${match[1] ?? ""}, and ${builder.aliases.person(match[2] ?? "")} had already closed ${match[3] ?? "it"} without paying`,
  ),
  rule([CLOSED], "Closed without paying by [\\s\\S]*", (match: RegExpExecArray, builder: FactsBuilder): string =>
    builder.closedWithoutPaying(/^Closed without paying by [A-Za-z0-9 .'_-]{1,80}, as a second bill for /.test(match[0])),
  ),
  rule([CLOSED], "Incident closed by ([\\s\\S]*)", (match: RegExpExecArray, builder: FactsBuilder): string =>
    `Incident closed by ${builder.aliases.peopleBefore(match[1] ?? "", ": ")}. Their note is not passed on`,
  ),

  // The duplicate lock. The second line is how older code wrote a refusal.
  keep(
    [LOCK],
    `Pay again refused by the duplicate lock(?:: (?:${KIND}) (?:${REF}|with no reference yet) is (?:pending|in flight|paid|failed|live at the bank)|: transfer (?:${REF_OR_ID})? under the (?:${KIND})'s request id is live at the bank)\\. An invoice can have one live payment`,
  ),
  rule([LOCK], `Second payment refused: (${INV}) already has a live payment`, (match: RegExpExecArray, builder: FactsBuilder): string =>
    `Second payment refused: ${builder.aliases.invoice(match[1] ?? "") ?? "another invoice"} already has a live payment`,
  ),

  // Emails: what PayOnce found, never what the email said or who sent it.
  rule([EMAIL], "Email from [\\s\\S]*, upload ([0-9]{1,9}), uploaded by [\\s\\S]*", (match: RegExpExecArray): string =>
    `Upload ${match[1] ?? ""}, an email, was delivered to this invoice by a person`,
  ),
  rule([EMAIL], "Email from [\\s\\S]*", (): string => "An email from the sample thread was put on file"),
  rule([EMAIL], "Read ([0-9]{1,6}) (new )?(emails?): ([\\s\\S]+?)(?:\\. Findings for this invoice so far: ([\\s\\S]+))?", (match: RegExpExecArray): string => {
    const said: string | null = summaryText(match[4]);
    const soFar: string | null = match[5] === undefined ? null : summaryText(match[5]);
    return `Read ${match[1] ?? ""} ${match[2] ?? ""}${match[3] ?? ""}: ${said ?? "(findings PayOnce does not pass on)"}${match[5] === undefined ? "" : `. Findings for this invoice so far: ${soFar ?? "(findings PayOnce does not pass on)"}`}`;
  }),
  rule([EMAIL], "(Findings for this invoice so far|Emails read): ([\\s\\S]+)", (match: RegExpExecArray): string =>
    `${match[1] ?? ""}: ${summaryText(match[2]) ?? "(findings PayOnce does not pass on)"}`,
  ),
  rule([WARNING], "Sender [\\s\\S]* does not match the supplier's domain on file \\([\\s\\S]*\\)", (): string =>
    "An email's sender does not match the supplier's domain on file",
  ),
  rule([WARNING], "Replies to this email go to [\\s\\S]*, which does not match the supplier's domain on file \\([\\s\\S]*\\)", (): string =>
    "An email's Reply-To address does not match the supplier's domain on file",
  ),
  rule([WARNING], "No supplier domain is on file for this invoice, so (sender|Reply-To address) [\\s\\S]* cannot be checked", (match: RegExpExecArray): string =>
    `No supplier domain is on file for this invoice, so an email's ${match[1] ?? "sender"} cannot be checked`,
  ),
  rule([WARNING], "Part of upload ([0-9]{1,9}) could not be read, so a person reads it: [\\s\\S]*", (match: RegExpExecArray): string =>
    `Part of upload ${match[1] ?? ""} could not be read, so a person reads it`,
  ),
  rule([WARNING], `Upload ([0-9]{1,9}) names (${INV}(?:, ${INV})*), not this invoice`, (match: RegExpExecArray, builder: FactsBuilder): string =>
    `Upload ${match[1] ?? ""} names ${builder.aliases.invoiceList(match[2] ?? "") ?? "other invoices"}, not this invoice`,
  ),
  keep([WARNING], "Upload [0-9]{1,9} has the same Message-ID as upload [0-9]{1,9}, which says something different"),

  // A reader failure: what each model did in PayOnce's words, with a model named
  // only when PayOnce is set up with it.
  rule(
    [EMAIL],
    "The email reader could not read a supplier email(?:: ([\\s\\S]+?))?\\. PayOnce reads it again on its next look(, in about a minute| at this invoice)",
    (match: RegExpExecArray, builder: FactsBuilder): string => {
      const tries: (string | null)[] =
        match[1] === undefined
          ? []
          : match[1].split(", then ").map((part: string): string | null => {
              const tried: RegExpExecArray | null = MODEL_TRY.exec(part);
              return tried === null ? null : `${builder.model(tried[1] ?? "")} ${tried[2] ?? ""}`;
            });
      const said: string = tries.length === 0 || tries.includes(null) ? "" : `: ${tries.join(", then ")}`;
      return `The email reader could not read a supplier email${said}. PayOnce reads it again on its next look${match[2] ?? ""}`;
    },
  ),

  // The sandbox bank's lines, which are bank lines, and the same lines as error
  // lines, as older code wrote them, with Airwallex's raw simulator errors. Each is
  // rebuilt from its bank reference, the status asked for, the answer's HTTP
  // status and a code PayOnce passes on, and its fixed ending.
  rule(
    [BANK, ERROR],
    `The sandbox's simulator, which stands in for the bank, did not move (${SANDBOX_TRANSFER}) to (${SIMULATED}) this time(${SANDBOX_ANSWER})?\\. ${SANDBOX_END}`,
    (match: RegExpExecArray): string =>
      `The sandbox's simulator, which stands in for the bank, did not move ${sandboxTransfer(match[1])} to ${match[2] ?? ""} this time${sandboxAnswer(match[3], match[4], match[5])}. ${sandboxEnd(match[6])}`,
  ),
  rule(
    [BANK, ERROR],
    `The sandbox bank could not read (${SANDBOX_TRANSFER}) from Airwallex this time(${SANDBOX_ANSWER})?, so the simulator, which stands in for the bank, did not move it\\. ${SANDBOX_END}`,
    (match: RegExpExecArray): string =>
      `The sandbox bank could not read ${sandboxTransfer(match[1])} from Airwallex this time${sandboxAnswer(match[2], match[3], match[4])}, so the simulator, which stands in for the bank, did not move it. ${sandboxEnd(match[5])}`,
  ),
  rule(
    [BANK, ERROR],
    `(?:Transfer (${REF})|The transfer) stayed SCHEDULED in Airwallex for longer than the sandbox bank waits, so the simulator, which stands in for the bank, did not move it this time\\. ${SANDBOX_END}`,
    (match: RegExpExecArray): string =>
      `${match[1] === undefined ? "The transfer" : `Transfer ${match[1]}`} stayed SCHEDULED in Airwallex for longer than the sandbox bank waits, so the simulator, which stands in for the bank, did not move it this time. ${sandboxEnd(match[2])}`,
  ),
  rule(
    [BANK, ERROR],
    `The sandbox's simulator, which stands in for the bank, does not move a transfer that converts currency, so nothing here pays or fails (${REF}|it), and it stays in PROCESSING\\. (?:${SANDBOX_END}|(${escapeRegExp(OLD_CONVERTS_END)}))`,
    (match: RegExpExecArray): string =>
      `The sandbox's simulator, which stands in for the bank, does not move a transfer that converts currency, so nothing here pays or fails ${match[1] ?? "it"}, and it stays in PROCESSING. ${match[3] === undefined ? sandboxEnd(match[2]) : OLD_CONVERTS_END}`,
  ),
  rule(
    [ERROR],
    `The sandbox simulator does not move a transfer that converts currency, so nothing here pays or fails (${REF}), and it stays in PROCESSING`,
    (match: RegExpExecArray): string =>
      `The sandbox simulator does not move a transfer that converts currency, so nothing here pays or fails ${match[1] ?? ""}, and it stays in PROCESSING`,
  ),
  rule(
    [ERROR],
    `POST /api/v1/simulation/transfers/${UUID}/transition (?:failed with ([0-9]{3})(?: ([A-Za-z0-9_.-]{1,64}))?|did not complete): [\\s\\S]*`,
    (match: RegExpExecArray): string =>
      `The sandbox's simulator, which stands in for the bank, did not move a transfer this time${
        match[1] === undefined ? ": it did not answer" : sandboxAnswer(":", match[1], match[2])
      }`,
  ),

  // Errors PayOnce writes in its own words, each given in fixed words that hold
  // only a currency, a kind of payment, an outage's number and rail or an alias.
  // Any other error line is a stand-in.
  rule([ERROR], "Supplier emails could not be read: [\\s\\S]*", (): string =>
    "The email reader could not read a supplier email, so the thread counts as unread",
  ),
  rule([ERROR], `Other (${CUR}) payments held the (?:${CUR}) lock for the ${N} seconds PayOnce waits for its turn, so it sent nothing\\. It tries again in a minute`, (match: RegExpExecArray): string =>
    `Other ${match[1] ?? ""} payments held the ${match[1] ?? ""} lock for as long as PayOnce waits for its turn, so it sent nothing. It tries again in a minute`,
  ),
  rule([ERROR], `The (${CUR}) lock ran out before the payment was recorded, so PayOnce sent nothing\\. It tries again in a minute`, (match: RegExpExecArray): string =>
    `The ${match[1] ?? ""} lock ran out before the payment was recorded, so PayOnce sent nothing. It tries again in a minute`,
  ),
  rule(
    [ERROR],
    "The supplier's bank details changed after the (decision|replacement was approved|payment was decided|payment was approved|pay run was approved), so PayOnce sent nothing\\. Check again to look at the new details",
    (match: RegExpExecArray): string =>
      `The supplier's bank details changed after the ${match[1] ?? "decision"}, so PayOnce sent nothing. Check again to look at the new details`,
  ),
  rule([ERROR], `Outage (${N}) on (${CUR}) (${METHOD}) is active, so PayOnce opened no payment on it`, (match: RegExpExecArray): string =>
    `Outage ${match[1] ?? ""} on ${match[2] ?? ""} ${match[3] ?? ""} is active, so PayOnce opened no payment on it`,
  ),
  rule([ERROR], `(${KIND_CAP}) payment was refused and nothing was sent\\.[\\s\\S]*`, (match: RegExpExecArray): string =>
    `${match[1] ?? ""} payment was refused and nothing was sent`,
  ),
  rule([ERROR], `(${KIND_CAP}) payment request did not complete, so the transfer may or may not exist\\.[\\s\\S]*`, (match: RegExpExecArray): string =>
    `${match[1] ?? ""} payment request did not complete, so the transfer may or may not exist`,
  ),
  rule([ERROR], `(${INV}) already has a live payment`, (match: RegExpExecArray, builder: FactsBuilder): string =>
    `${capitalise(builder.aliases.invoice(match[1] ?? "") ?? "another invoice")} already has a live payment`,
  ),
  rule([ERROR], "Airwallex refused the new bank details, so the record is unchanged: [\\s\\S]*", (): string =>
    "Airwallex refused the new bank details, so the record is unchanged",
  ),
  rule([ERROR], "The supplier's record in Airwallex does not hold the new [\\s\\S]*", (): string =>
    "The supplier's record in Airwallex does not hold the new bank details. PayOnce pays no new account until a callback matches the record",
  ),

  // Callbacks: who recorded one, never the number, who they spoke to or what was said.
  rule([CALLBACK], "([\\s\\S]+?) called the supplier on [\\s\\S]*", (match: RegExpExecArray, builder: FactsBuilder): string =>
    `${capitalise(builder.aliases.peopleBefore(match[0], " called the supplier on "))} recorded a callback to the supplier on the number on file`,
  ),
  rule([CALLBACK], "Supplier's bank details updated in Airwallex: [\\s\\S]*", (): string => "Supplier's bank details updated in Airwallex"),
  rule([CALLBACK], "The supplier's record in Airwallex already holds these details, and the callback verifies them: [\\s\\S]*", (): string =>
    "The supplier's record in Airwallex already holds these details, and the callback verifies them",
  ),

  // Rail outages.
  rule(
    [OUTAGE],
    `Outage (${N}) declared on (${CUR}) (${METHOD}): payouts to (${N}) payees failed with (${RAIL_CODES}) within (${N}) minutes \\(([\\s\\S]*)\\)\\. PayOnce opens no new payment on ${CUR} (?:${METHOD}) until a person ends the outage`,
    (match: RegExpExecArray): string => {
      const references: string[] = (match[7] ?? "").split(", ");
      const named: string = references.every((reference: string): boolean => REFERENCE_PATTERN.test(reference)) ? ` (${references.join(", ")})` : "";
      return `Outage ${match[1] ?? ""} declared on ${match[2] ?? ""} ${match[3] ?? ""}: payouts to ${match[4] ?? ""} payees failed with ${match[5] ?? ""} within ${match[6] ?? ""} minutes${named}. PayOnce opens no new payment on ${match[2] ?? ""} ${match[3] ?? ""} until a person ends the outage`;
    },
  ),
  keep([OUTAGE], `${OUTAGE_LEAD}(?:${HOLD_ENDINGS})`),
  rule(
    [OUTAGE],
    `Outage (${N}) on (${CUR}) (${METHOD}) ended by ([\\s\\S]*)\\. It was declared at (${CLOCK})\\.( No approver list was set, so any named person could end it\\.)? PayOnce opens payments on ${CUR} (?:${METHOD}) again( and looks at this invoice now|\\. This invoice is already closed, so PayOnce sends nothing for it)`,
    (match: RegExpExecArray, builder: FactsBuilder): string =>
      `Outage ${match[1] ?? ""} on ${match[2] ?? ""} ${match[3] ?? ""} ended by ${builder.aliases.peopleBefore(match[4] ?? "", ": ")}. Their note is not passed on. It was declared at ${match[5] ?? ""}.${match[6] ?? ""} PayOnce opens payments on ${match[2] ?? ""} ${match[3] ?? ""} again${match[7] ?? ""}`,
  ),

  // The outbox: what was drafted, never the text, names or notes.
  rule([OUTBOX], `Draft (${N}) for the (supplier|bank) created by [\\s\\S]*: "([\\s\\S]*)"\\. Text SHA-256 [0-9a-f]{64}\\. PayOnce does not send it`, (match: RegExpExecArray): string =>
    DRAFT_LABELS.includes(match[3] ?? "")
      ? `Draft ${match[1] ?? ""} for the ${match[2] ?? ""} created: "${match[3] ?? ""}". PayOnce does not send it`
      : `Draft ${match[1] ?? ""} for the ${match[2] ?? ""} created. PayOnce does not send it`,
  ),
  rule([OUTBOX], `Draft (${N}) copied(?: by [\\s\\S]*)?`, (match: RegExpExecArray): string => `Draft ${match[1] ?? ""} copied`),
  rule([OUTBOX], `Draft (${N}) marked sent by [\\s\\S]*`, (match: RegExpExecArray): string =>
    `Draft ${match[1] ?? ""} marked sent by a person. PayOnce did not send it`,
  ),
  rule([OUTBOX], `Draft (${N}) dismissed by [\\s\\S]*`, (match: RegExpExecArray): string => `Draft ${match[1] ?? ""} dismissed`),
];

// ---------- the builder ----------

class FactsBuilder {
  readonly aliases: Aliases;
  unrecognised: number = 0;

  constructor(
    ledger: Ledger,
    private readonly obligation: Obligation,
    known: string[],
    private readonly readers: readonly string[],
  ) {
    this.aliases = new Aliases(ledger, obligation.invoiceId, known);
  }

  // A model as a line names it: only one PayOnce is set up with, as for readBy.
  model(name: string): string {
    return this.readers.includes(name) && MODEL_PATTERN.test(name) ? name : "a model";
  }

  // A reason in PayOnce's words with its slots aliased, or UNPASSED_REASON.
  reason(text: string): string {
    return this.through(REASON_PARTS, text);
  }

  // Why a payment needs more than one approver, or UNPASSED_REASON.
  why(text: string): string {
    const needs: RegExpExecArray | null = /^it now needs ([0-9]{1,3}) approvers, because ([\s\S]+)$/.exec(text);
    if (needs !== null) {
      return `it now needs ${needs[1] ?? ""} approvers, because ${this.through(WHY_PARTS, needs[2] ?? "")}`;
    }
    return this.through(WHY_PARTS, text);
  }

  private through(parts: readonly ReasonPart[], text: string): string {
    const parsed: { part: ReasonPart; match: RegExpExecArray }[] | null = text === "" ? null : parseParts(parts, text, 0);
    const rendered: (string | null)[] =
      parsed?.map(({ part, match }: { part: ReasonPart; match: RegExpExecArray }): string | null => part.render(match, this)) ?? [null];
    if (rendered.some((piece: string | null): boolean => piece === null)) {
      this.unrecognised += 1;
      return UNPASSED_REASON;
    }
    return rendered.join(", and ");
  }

  // The close-without-paying line, from the invoice's own fields, since the line
  // holds the note a person typed. secondBill is whether the line named the
  // invoices it was a second bill for, which a close of an invoice that sent a
  // payment does not.
  closedWithoutPaying(secondBill: boolean): string {
    const by: string = this.aliases.person(this.obligation.rejectedBy);
    const matches: string[] = secondBill ? this.aliases.invoiceAliases(this.obligation.duplicateOf) : [];
    return `Closed without paying by ${by}${matches.length === 0 ? "" : `, as a second bill for ${listOf(matches)}`}. Their note is not passed on`;
  }

  // The line as it is passed on, or null for a stand-in. Only rules for the line's
  // own kind and topic are tried.
  line(event: LedgerEvent): string | null {
    const source: Source = sourceOf(event);
    if (FIXED_LINES.get(event.message)?.includes(source) === true) {
      return event.message;
    }
    for (const lineRule of LINE_RULES) {
      if (!lineRule.from.includes(source)) {
        continue;
      }
      const match: RegExpExecArray | null = lineRule.test.exec(event.message);
      if (match === null) {
        continue;
      }
      const line: string = lineRule.line(match, this);
      return SAFE_LINE.test(line) ? line : null;
    }
    return null;
  }
}

function standIn(kind: string): string {
  return `(${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} line PayOnce does not pass on)`;
}

function paymentFacts(ledger: Ledger, obligation: Obligation, attempt: Attempt, now: number): PaymentFacts {
  const createdAt: string | null = isoTime(attempt.bankCreatedAt);
  const live: boolean = attempt.state === "in_flight" || attempt.state === "pending";
  const deadlineAt: number | null =
    createdAt === null ? null : Date.parse(createdAt) + deadlineMinutes(obligation.transferMethod) * 60_000;
  const code: string | null = attempt.failureCode;
  const approval: Approval | undefined = attempt.quoteId === null ? undefined : ledger.approvalOf(attempt);
  const fx: FxTerms | undefined =
    approval === undefined ? undefined : (JSON.parse(approval.terms) as ApprovalTerms).fx;
  return {
    kind: attempt.kind,
    bankReference: ref(attempt.reference),
    state: attempt.state,
    bankStatus: status(attempt.bankStatus),
    createdAt,
    deadline: live && deadlineAt !== null ? new Date(deadlineAt).toISOString() : null,
    pastDeadline: live && deadlineAt !== null ? now >= deadlineAt : null,
    failure: attempt.state === "failed" ? failureText(code) : null,
    resendCanFix: attempt.state === "failed" && code !== null && /^[0-9]{5}$/.test(code) ? RESENDABLE_FAILURE_CODES.has(code) : null,
    amountFromWallet: money(attempt.amountMinor, attempt.currency),
    fee: money(attempt.feeMinor, attempt.feeCurrency),
    openedOnApproval: attempt.approvalId,
    exchangeRate: fx?.quoteId === attempt.quoteId ? rate(fx) : null,
    wentOutAtUnapprovedRate: attempt.rateMismatch !== null,
    foundLateInAirwallex: attempt.foundLateAt !== null,
    transferThatDoesNotMatch:
      attempt.mismatchedTransferId === null
        ? null
        : { bankReference: ref(attempt.mismatchedReference), bankStatus: status(attempt.mismatchedStatus) },
    usuallyArrives: arrivalFacts(attempt.arrival),
  };
}

function payoutFacts(payout: OutsidePayout): PayoutFacts {
  return {
    bankReference: ref(payout.reference),
    state: payout.state,
    amount: money(payout.amountMinor, payout.currency),
    fee: money(payout.feeMinor, payout.feeCurrency),
  };
}

interface StoredFindings {
  claimsNonReceipt?: boolean;
  asksForNewBankDetails?: boolean;
  asksNotToPay?: boolean;
  summary?: string;
  readBy?: string;
  unread?: boolean;
  emailsRead?: number;
}

function emailFacts(ledger: Ledger, obligation: Obligation, builder: FactsBuilder, readers: readonly string[]): EmailFacts {
  // Only counted and checked: no address, subject or text is read into the facts.
  const emails: SupplierEmail[] = ledger.emails(obligation.invoiceId);
  const stored: string | undefined = ledger.findings(obligation.invoiceId);
  let findings: StoredFindings = {};
  try {
    findings = stored === undefined ? {} : (JSON.parse(stored) as StoredFindings);
  } catch {
    builder.unrecognised += 1;
  }
  const summary: string | null =
    stored === undefined ? (emails.length === 0 ? "no emails on file" : "the emails have not been read yet") : summaryText(findings.summary);
  const evidence: string | null =
    summary === null ? null : evidenceText(emailEvidence(summary, emails, obligation.supplierDomain));
  return {
    evidence,
    onFile: emails.length,
    read: typeof findings.emailsRead === "number" ? findings.emailsRead : stored === undefined ? 0 : emails.length,
    withTextPayOnceCouldNotRead: emails.filter((email: SupplierEmail): boolean => email.partial === true).length,
    readerFailed: findings.unread === true,
    reportsNonReceipt: findings.claimsNonReceipt === true,
    asksForDifferentAccount: findings.asksForNewBankDetails === true,
    asksNotToPay: findings.asksNotToPay === true,
    // Only a name PayOnce is set up with: the findings are stored JSON, and a model
    // named in them is otherwise free text.
    readBy:
      stored === undefined
        ? null
        : typeof findings.readBy === "string" && readers.includes(findings.readBy)
          ? findings.readBy
          : "the email reader",
  };
}

function approvalFacts(ledger: Ledger, obligation: Obligation, builder: FactsBuilder): ApprovalFacts | null {
  const approval: Approval | undefined = ledger.latestApproval(obligation.invoiceId);
  if (approval === undefined) {
    return null;
  }
  const terms: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  const pending: PendingApproval | undefined = pendingApproval(ledger, obligation.invoiceId);
  const fx: FxTerms | undefined = terms.fx;
  const aliases: Aliases = builder.aliases;
  // Terms PayOnce did not write, such as a row made by hand in a test ledger, may
  // have no evidence. They give none, instead of failing the facts.
  const evidence: ApprovalTerms["evidence"] | undefined =
    typeof terms.evidence === "object" && terms.evidence !== null ? terms.evidence : undefined;
  // Picked field by field: payTo, accountKey, the beneficiary, the quote id, the
  // binding and the callback's number, contact and words are never read.
  const replacement: ReplacementTerms | null = terms.action === "replace" && evidence !== undefined ? terms : null;
  const held: HeldPaymentTerms | null = terms.action === "pay" && evidence !== undefined ? terms : null;
  const callback: BankChangeEvidence | null = replacement?.evidence.bankChange ?? null;
  return {
    number: approval.id,
    state: approval.state,
    action: terms.action,
    amount: money(terms.amountMinor, terms.currency) ?? "",
    takesFromWallet: fx === undefined ? null : money(fx.sellAmountMinor, fx.sellCurrency),
    exchangeRate:
      fx === undefined || rate(fx) === null
        ? null
        : { rate: rate(fx) ?? "", markup: markupOf(fx), validTo: isoTime(fx.validTo) },
    arrival: arrivalFacts(terms.arrival),
    requestedAt: isoTime(approval.requestedAt),
    expiresAt: isoTime(approval.expiresAt),
    expired: isExpired(approval),
    approversNeeded: approval.needed,
    whyMoreThanOne: approval.needed > 1 ? builder.why(approval.neededWhy) : null,
    approvedBy: approval.signoffs.map((signoff: { approver: string }): string => aliases.person(signoff.approver)),
    barred: (pending?.barred ?? []).map((entry: Barred): { person: string; why: string } => ({
      person: aliases.person(entry.name),
      why: BARRED_WHY.has(entry.why) ? entry.why : "barred by the approval policy",
    })),
    reasonInTerms: builder.reason(evidence?.reason ?? ""),
    emailEvidenceInTerms: evidenceText(evidence?.emails),
    originalInTerms:
      replacement === null
        ? null
        : {
            bankReference: ref(replacement.evidence.originalReference),
            state: replacement.evidence.originalState,
            failure: failureText(replacement.evidence.failureCode),
          },
    looksLikeInTerms: (held?.evidence.duplicates ?? []).map(
      (duplicate: DuplicateEvidence): ApprovalFacts["looksLikeInTerms"][number] => ({
        invoice: aliases.invoice(duplicate.invoiceId) ?? "another invoice",
        state: duplicate.state,
        paidBy: ref(duplicate.paidBy),
        sameAccount: duplicate.sameAccount,
      }),
    ),
    bankDetailsVerifiedByCallback:
      callback === null
        ? null
        : { on: isoTime(callback.calledAt)?.slice(0, 10) ?? null, recordedBy: aliases.person(callback.calledBy) },
  };
}

function closeFacts(ledger: Ledger, obligation: Obligation, builder: FactsBuilder): CloseFacts | null {
  const review: CloseReview | undefined = pendingClose(ledger, obligation.invoiceId);
  if (review === undefined) {
    return null;
  }
  const duplicate: boolean = review.kind === "duplicate";
  return {
    kind: review.kind,
    bankReference: duplicate ? null : ref(review.reference),
    looksLike: duplicate ? builder.aliases.invoiceAliases(obligation.duplicateOf) : [],
    reason: builder.reason(review.reason),
  };
}

function cashFacts(ledger: Ledger, obligation: Obligation, settings: WhySettings): CashFacts {
  const wallet: string = debitCurrency(obligation);
  if (!CURRENCY_PATTERN.test(wallet)) {
    return {
      wallet: UNPASSED_WALLET,
      reserveFloor: "not passed on",
      floorFrom: "nothing",
      committedToOtherPayments: "not passed on",
      balance: "not read for this explanation",
    };
  }
  const floor: number | null = floorFor(settings.reserve, obligation);
  const own: boolean =
    obligation.invoiceFloorMinor > 0 &&
    floor !== null &&
    Number.isFinite(floor) &&
    floor === obligation.invoiceFloorMinor &&
    (currencyFloor(settings.reserve, wallet).minor ?? 0) < obligation.invoiceFloorMinor;
  return {
    wallet,
    reserveFloor:
      floor === null ? "not set" : Number.isFinite(floor) ? formatMoney(floor, wallet) : "the setting could not be read",
    floorFrom: floor === null ? "nothing" : own ? "this invoice's own floor" : "RESERVE_FLOORS",
    committedToOtherPayments: formatMoney(committedMinor(ledger, wallet, { invoiceId: obligation.invoiceId }), wallet),
    balance:
      "not read for this explanation. The latest cost line on the timeline has the figures from PayOnce's last look",
  };
}

function policyFacts(obligation: Obligation, settings: WhySettings, builder: FactsBuilder): PolicyFacts {
  let validity: string | null = null;
  if (crossCurrency(obligation)) {
    try {
      validity = quoteValidity(currentSettings().fxQuotes);
    } catch {
      validity = "the setting could not be read";
    }
  }
  return {
    note: "These settings are as PayOnce reads them now. An earlier step may have run under other settings",
    approvers: settings.approvals.approvers.map((approver: { name: string; limitMinor: number }) => ({
      person: builder.aliases.person(approver.name),
      limit: formatAmount(approver.limitMinor),
    })),
    twoApproversAbove: formatAmount(settings.approvals.twoApproversAboveMinor),
    approvalRequestExpiresAfterMinutes: settings.approvals.expiresAfterMs / 60_000,
    approvalsRefused: settings.approvals.problem !== null,
    bankDeadlineMinutes: deadlineMinutes(obligation.transferMethod),
    fxQuoteValidity: validity,
  };
}

function outageFacts(ledger: Ledger, obligation: Obligation): OutageFacts[] {
  const facts: OutageFacts[] = [];
  for (const outage of [...ledger.outages()].reverse()) {
    const hold: OutageHold | undefined = ledger
      .outageHolds(outage.id)
      .find((entry: OutageHold): boolean => entry.invoiceId === obligation.invoiceId);
    if (outage.state !== "active" && hold === undefined) {
      continue;
    }
    facts.push(outageFact(outage, obligation, hold));
  }
  return facts;
}

function outageFact(outage: Outage, obligation: Obligation, hold: OutageHold | undefined): OutageFacts {
  const rail: string =
    CURRENCY_PATTERN.test(outage.currency) && pattern(METHOD).test(outage.method) ? `${outage.currency} ${outage.method}` : "a rail";
  return {
    number: outage.id,
    rail,
    onThisInvoicesRail:
      outage.currency === obligation.currency.toUpperCase() && outage.method === obligation.transferMethod.toUpperCase(),
    state: outage.state,
    declaredAt: isoTime(outage.declaredAt),
    endedAt: isoTime(outage.endedAt),
    failureCodes: outage.codes.map((code: string): string => failureText(code) ?? UNPASSED_CODE),
    payeesCounted: outage.payees,
    windowMinutes: outage.windowMinutes,
    heldOfThisInvoice: hold?.what ?? null,
  };
}

// The facts about one invoice, from the ledger and the settings alone, read in
// one snapshot. Undefined when the invoice is not in the ledger. It writes
// nothing and calls nothing outside the ledger, so the page and the CLI give the
// same facts.
export function whyFacts(
  ledger: Ledger,
  invoiceId: string,
  settings: WhySettings,
  now: number = Date.now(),
): WhyBuild | undefined {
  return ledger.readSnapshot((): WhyBuild | undefined => {
    const obligation: Obligation | undefined = ledger.obligation(invoiceId);
    if (obligation === undefined) {
      return undefined;
    }
    const approvals: Approval[] = ledger.approvalsFor(invoiceId);
    const known: string[] = [
      ...settings.approvals.approvers.map((approver: { name: string }): string => approver.name),
      ...approvals.flatMap((approval: Approval): string[] =>
        approval.signoffs.map((signoff: { approver: string }): string => signoff.approver),
      ),
      ...ledger.callbackRecorders(invoiceId),
      ...(obligation.startedBy === null ? [] : [obligation.startedBy]),
      ...(obligation.rejectedBy === null ? [] : [obligation.rejectedBy]),
    ];
    const builder: FactsBuilder = new FactsBuilder(ledger, obligation, known, settings.readers);
    const aliases: Aliases = builder.aliases;
    const events: LedgerEvent[] = ledger.events(invoiceId);
    // == null: a ledger no newer code has opened has no run_row_id column at all.
    const row: RunRow | undefined = obligation.runRowId == null ? undefined : ledger.runRowOf(invoiceId);

    // The invoices it looks like a second bill for come first, so they are
    // numbered first.
    const looksLike: { invoice: string; state: string }[] = obligation.duplicateOf.flatMap(
      (other: string): { invoice: string; state: string }[] => {
        const alias: string | null = aliases.invoice(other);
        return alias === null ? [] : [{ invoice: alias, state: ledger.obligation(other)?.state ?? "unknown" }];
      },
    );
    const latestOn = (topic: string): string | null => {
      const event: LedgerEvent | undefined = [...events].reverse().find((entry: LedgerEvent): boolean => entry.topic === topic);
      return event === undefined ? null : (builder.line(event) ?? standIn(event.kind));
    };
    const invoice: InvoiceFacts = {
      ref: "this invoice",
      state: obligation.state,
      origin: obligation.origin,
      fromPayRun: row === undefined ? null : { run: row.runId, row: row.line },
      amount: money(obligation.amountMinor, obligation.currency) ?? "",
      // Both come from Airwallex for a payout found there, so both are checked.
      paidFromWallet: !crossCurrency(obligation)
        ? null
        : CURRENCY_PATTERN.test(obligation.sourceCurrency)
          ? obligation.sourceCurrency
          : UNPASSED_WALLET,
      transferMethod: METHOD_PATTERN.test(obligation.transferMethod) ? obligation.transferMethod : UNPASSED_METHOD,
      dueDate: date(obligation.dueDate),
      startedBy: knownName(obligation.startedBy) === null ? "not known" : aliases.person(obligation.startedBy),
      supplierDomainOnFile: obligation.supplierDomain !== "",
      supplierPhoneOnFile: obligation.supplierPhone !== null,
      heldBeforePaying: heldBeforePaying(ledger, obligation),
      escalationReason: obligation.escalationReason === "" ? null : builder.reason(obligation.escalationReason),
      closedWithoutPayingBy: obligation.rejectedBy === null ? null : aliases.person(obligation.rejectedBy),
      decisionNow: latestOn("decision"),
      waitingOn: latestOn("waiting"),
      looksLike,
    };

    const shown: LedgerEvent[] = events.slice(-TIMELINE_LINES);
    const notPassed: Record<string, number> = {};
    const timeline: TimelineLine[] = shown.map((event: LedgerEvent, index: number): TimelineLine => {
      const line: string | null = builder.line(event);
      if (line === null) {
        notPassed[event.kind] = (notPassed[event.kind] ?? 0) + 1;
      }
      return {
        n: events.length - shown.length + index + 1,
        at: isoTime(event.at),
        kind: event.kind,
        line: line ?? standIn(event.kind),
      };
    });

    const facts: WhyFacts = {
      question: WHY_QUESTION,
      invoice,
      payments: ledger.attempts(invoiceId).map((attempt: Attempt): PaymentFacts => paymentFacts(ledger, obligation, attempt, now)),
      outsidePayouts: ledger.outsidePayouts(invoiceId).map(payoutFacts),
      emails: emailFacts(ledger, obligation, builder, settings.readers),
      approval: approvalFacts(ledger, obligation, builder),
      closeReview: closeFacts(ledger, obligation, builder),
      cash: cashFacts(ledger, obligation, settings),
      policy: policyFacts(obligation, settings, builder),
      outages: outageFacts(ledger, obligation),
      timeline,
      timelineLeftOut: { earlierLines: events.length - shown.length, linesNotPassedOn: notPassed },
    };
    return {
      facts,
      legend: aliases.legend(),
      asOf: { lines: events.length, lastEventId: events.at(-1)?.id ?? 0 },
      unrecognised: builder.unrecognised,
    };
  });
}

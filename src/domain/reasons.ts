import type { Transfer } from "../airwallex/transfers.js";
import { rateText, type FxTerms } from "./approval.js";
import { debitOf, type Debit } from "./assess.js";
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
} from "./decide.js";
import { formatMoney } from "./money.js";
import { CURRENCY_SOURCE, REFERENCE_SOURCE } from "./patterns.js";

// Every reason PayOnce stores, as a code with its slots and the clauses the
// engine adds, and the exact text each renders to. The engine builds reasons as
// codes and the ledger stores the codes beside the text, which stays the record:
// reasonText gives the text byte for byte. parseReason reads a text with no codes
// back: a row from before codes, which the ledger backfills once, and the reason
// texts in timeline lines and approval terms, which stay text.

export type ReasonFamily =
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
  | "approval"
  | "outage"
  | "paid-twice"
  | "other";

export type ReasonCode =
  | "outside-payout"
  | "new-bank-details"
  | "asks-not-to-pay"
  | "bank-details-changed"
  | "unverified-sender"
  | "emails-unread"
  | "email-partly-unread"
  | "unknown-status"
  | "non-receipt"
  | "settled"
  | "deadline-original"
  | "in-flight"
  | "replacement-failed"
  | "not-resendable"
  | "sent-outside"
  | "below-floor"
  | "cash-unreadable"
  | "no-floor"
  | "two-approvers"
  | "new-rate-replacement"
  | "replace"
  | "last-paid-account-changed"
  | "account-unconfirmed"
  | "outage"
  | "emails-before-payment"
  | "late-transfer"
  | "unrecognised-transfer"
  | "unrecognised-transfer-failed"
  | "deadline-replacement"
  | "account-changed-before-send"
  | "account-unknown-before-send"
  | "run-row-below-floor"
  | "run-account-changed"
  | "beneficiary-missing"
  | "person-started"
  | "second-bill-paid"
  | "second-bill"
  | "same-invoice-number"
  | "new-rate-first-payment"
  | "refused"
  | "rate-mismatch"
  | "misdirected"
  | "no-bank-details-shown"
  | "found-after-close";

export type ClauseCode = "below-floor" | "cash-unreadable" | "no-floor" | "second-bill-paid" | "asks-not-to-pay";

export type TransferKind = "original" | "replacement";

// Only PayOnce's own values, each in a closed pattern.
export interface Slots {
  invoices?: string[];
  invoice?: string;
  wallet?: string;
  failureCode?: string;
  kind?: TransferKind;
  reference?: string;
  rate?: { pair: string; rate: number };
  amount?: { minor: number; currency: string };
  approved?: { pair: string; rate: number; minor: number; currency: string };
  noRate?: true;
  amountUnreadable?: true;
  noQuoteApproved?: true;
  wording?: "legacy";
}

export interface Clause {
  code: ClauseCode;
  slots: Slots;
}

export interface Reason {
  code: ReasonCode;
  slots: Slots;
  clauses: Clause[];
}

export interface UnrecognisedReason {
  code: "unrecognised";
  text: string;
}

export type StoredReason = Reason | UnrecognisedReason;

export interface ReasonView {
  code: ReasonCode | "unrecognised";
  family: ReasonFamily;
  label: string;
  text: string;
  clauses: { code: ClauseCode; label: string }[];
}

// An email delivered before the first payment is read by a person first.
export const EMAILS_BEFORE_PAYMENT_REASON: string =
  "supplier emails arrived before the first payment, so a person reads them before PayOnce pays it";

// Why an invoice waits for a person when a transfer Airwallex listed late under
// the request id of a payment PayOnce had marked failed may pay it a second time.
// A fixed string, because alerts post escalation reasons.
export const LATE_TRANSFER_REASON: string =
  "a payment PayOnce marked as never sent reached the bank, so the supplier may have been paid twice";

// Why an invoice waits for a person when Airwallex lists a transfer under the
// request id of a payment PayOnce marked failed with none, and that transfer does
// not carry the invoice's number, amount and currency. A fixed string, because
// alerts post escalation reasons.
export const MISMATCHED_TRANSFER_REASON: string =
  "Airwallex lists a transfer under the request id of a payment PayOnce marked as never sent, and it does not match this invoice";

// The same reason once the bank has failed every such transfer for the invoice.
export const MISMATCHED_FAILED_REASON: string =
  "Airwallex listed a transfer under the request id of a payment PayOnce marked as never sent that did not match this invoice, and the bank has failed it";

export const REPLACEMENT_DEADLINE_REASON: string =
  "the bank has not paid or failed the replacement by its deadline";

// Why a pending payment with no transfer goes to a person when the record no
// longer holds the account it was decided or approved for. A fixed string, as
// alerts post it.
export const ACCOUNT_CHANGED_REASON: string =
  "the supplier's bank details on file changed after this payment was decided or approved, so PayOnce does not send it again";

// Why a pending payment with no transfer goes to a person when nothing on file
// says which account it was decided or approved for: a replacement from before
// PayOnce kept the account, whose original shows no bank details or whose terms
// name none. A fixed string, as alerts post it.
export const ACCOUNT_UNKNOWN_REASON: string =
  "PayOnce does not know which bank details this payment was decided or approved for, so it does not send it again";

// The reason a pay run row is held at send when paying it would take cash below
// the floor. It stays the same whatever the numbers, so it does not void an
// approval by its wording.
export const CASH_HOLD_REASON: string =
  "paying it now would take cash below the reserve floor";

// Why a pay run row waits for a person when the record no longer holds the
// account the run was approved for. A fixed string, as the supplier view tests it.
export const RUN_ACCOUNT_CHANGED_REASON: string =
  "its bank details changed after the pay run was approved";

// Why a first payment is held when its beneficiary record is gone from Airwallex.
export const BENEFICIARY_MISSING_REASON: string = "the beneficiary is no longer in Airwallex";

// Why a payment a person started waits before its first transfer when nothing
// more specific holds it. Approval terms carry it, so it stays as it is.
export const PERSON_STARTED_REASON: string =
  "a person started this payment, so someone else approves it before PayOnce pays it";

const AND: string = ", and ";
const INVOICE: string = "[A-Za-z0-9-]{1,40}";
const INVOICE_LIST: string = `${INVOICE}(?:(?:, | and )${INVOICE})*`;
const KIND: string = "(original|replacement)";
const NUMBER: string = "[0-9]+(?:\\.[0-9]+)?(?:e[-+]?[0-9]+)?";
const RATE: string = `1 (${CURRENCY_SOURCE}) = (${NUMBER}) (${CURRENCY_SOURCE})`;
const MONEY: string = `(-?[0-9][0-9,]*\\.[0-9]{2}) (${CURRENCY_SOURCE})`;
const SECOND_BILL_TAIL: string = "case, spacing, leading zeros or letters added at the end";
const SECOND_BILL_LEGACY_TAIL: string = "case, spacing, zeros or a letter suffix";
const NO_QUOTE_APPROVED: string = ", and no approval covers the quote it was sent with";
const MISDIRECTED_TAIL: string = "went to bank details that are not the ones it was decided or approved for";
const MISDIRECTED_LEGACY_TAIL: string = "went to bank details that are not the ones it was approved for";

interface Part<C extends string> {
  code: C;
  source: string;
  slots: (match: RegExpExecArray) => Slots | null;
  text: (slots: Slots) => string;
}

interface Compiled<C extends string> extends Part<C> {
  test: RegExp;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fixed<C extends string>(code: C, text: string): Part<C> {
  return { code, source: escaped(text), slots: (): Slots => ({}), text: (): string => text };
}

function compiled<C extends string>(parts: Part<C>[]): Compiled<C>[] {
  return parts.map((part: Part<C>): Compiled<C> => ({ ...part, test: new RegExp(part.source, "y") }));
}

function listOf(invoices: string[]): string {
  return invoices.length <= 1
    ? (invoices[0] ?? "")
    : `${invoices.slice(0, -1).join(", ")} and ${invoices.at(-1)}`;
}

// The invoices listOf joined, or null for a list it would not have written.
function invoicesOf(list: string): string[] | null {
  const invoices: string[] = list.split(/, | and /);
  return listOf(invoices) === list ? invoices : null;
}

// A number exactly as String(number) writes it, or null.
function numberOf(text: string): number | null {
  const value: number = Number(text);
  return Number.isFinite(value) && String(value) === text ? value : null;
}

// An amount exactly as formatMoney writes it, or null.
function moneyOf(amount: string, currency: string): { minor: number; currency: string } | null {
  const minor: number = Math.round(Number(amount.replace(/,/g, "")) * 100);
  return Number.isFinite(minor) && formatMoney(minor, currency) === `${amount} ${currency}` ? { minor, currency } : null;
}

function rateOf(from: string, rate: string, to: string): { pair: string; rate: number } | null {
  const value: number | null = numberOf(rate);
  return value === null ? null : { pair: `${from}${to}`, rate: value };
}

function kindOf(text: string | undefined): TransferKind | null {
  return text === "original" || text === "replacement" ? text : null;
}

function named(slots: Slots): string {
  return `${slots.kind ?? ""} ${slots.reference ?? ""}`;
}

function secondBillPaidPart<C extends string>(code: C): Part<C> {
  return {
    code,
    source: `it looks like a second bill for (${INVOICE}), which is paid`,
    slots: (match: RegExpExecArray): Slots => ({ invoice: match[1] ?? "" }),
    text: (slots: Slots): string => `it looks like a second bill for ${slots.invoice ?? ""}, which is paid`,
  };
}

// The rate-mismatch reason, as rateProblem builds it around approval.ts's
// rateMismatch.
const RATE_MISMATCH: Part<ReasonCode> = {
  code: "rate-mismatch",
  source: `${KIND} (${REFERENCE_SOURCE}) went out (?:(with no exchange rate on it)|at ${RATE} \\((?:${MONEY}|(amount not readable))\\))(?:(${escaped(NO_QUOTE_APPROVED)})|, not the approved ${RATE} \\(${MONEY}\\))`,
  slots: (match: RegExpExecArray): Slots | null => {
    const kind: TransferKind | null = kindOf(match[1]);
    const rate: { pair: string; rate: number } | null = rateOf(match[4] ?? "", match[5] ?? "", match[6] ?? "");
    const amount: { minor: number; currency: string } | null = moneyOf(match[7] ?? "", match[8] ?? "");
    const approvedRate: { pair: string; rate: number } | null = rateOf(match[11] ?? "", match[12] ?? "", match[13] ?? "");
    const approvedAmount: { minor: number; currency: string } | null = moneyOf(match[14] ?? "", match[15] ?? "");
    const actual: Slots | null =
      match[3] !== undefined
        ? { noRate: true }
        : rate === null
          ? null
          : match[9] !== undefined
            ? { rate, amountUnreadable: true }
            : amount === null
              ? null
              : { rate, amount };
    const tail: Slots | null =
      match[10] !== undefined
        ? { noQuoteApproved: true }
        : approvedRate === null || approvedAmount === null
          ? null
          : { approved: { ...approvedRate, ...approvedAmount } };
    return kind === null || actual === null || tail === null
      ? null
      : { kind, reference: match[2] ?? "", ...actual, ...tail };
  },
  text: (slots: Slots): string => {
    const actual: string =
      slots.noRate === true || slots.rate === undefined
        ? "with no exchange rate on it"
        : `at ${rateText(slots.rate.pair, slots.rate.rate)} (${slots.amount === undefined ? "amount not readable" : formatMoney(slots.amount.minor, slots.amount.currency)})`;
    const approved: Slots["approved"] = slots.approved;
    const tail: string =
      slots.noQuoteApproved === true || approved === undefined
        ? NO_QUOTE_APPROVED
        : `, not the approved ${rateText(approved.pair, approved.rate)} (${formatMoney(approved.minor, approved.currency)})`;
    return `${named(slots)} went out ${actual}${tail}`;
  },
};

function transferPart(code: ReasonCode, tail: string, legacyTail: string | null = null): Part<ReasonCode> {
  return {
    code,
    source: `${KIND} (${REFERENCE_SOURCE}) (${escaped(tail)}${legacyTail === null ? "" : `|${escaped(legacyTail)}`})`,
    slots: (match: RegExpExecArray): Slots | null => {
      const kind: TransferKind | null = kindOf(match[1]);
      return kind === null
        ? null
        : { kind, reference: match[2] ?? "", ...(match[3] === legacyTail ? { wording: "legacy" as const } : {}) };
    },
    text: (slots: Slots): string => `${named(slots)} ${slots.wording === "legacy" && legacyTail !== null ? legacyTail : tail}`,
  };
}

function leadParts(): Part<ReasonCode>[] {
  return [
    fixed("outside-payout", OUTSIDE_PAYOUT_REASON),
    fixed("new-bank-details", NEW_BANK_DETAILS_REASON),
    fixed("asks-not-to-pay", NOT_TO_PAY_REASON),
    fixed("bank-details-changed", CHANGED_BANK_DETAILS_REASON),
    fixed("unverified-sender", UNVERIFIED_SENDER_REASON),
    fixed("emails-unread", EMAILS_UNREAD_REASON),
    fixed("email-partly-unread", PARTLY_UNREAD_REASON),
    fixed("unknown-status", UNKNOWN_STATUS_REASON),
    fixed("non-receipt", NON_RECEIPT_REASON),
    fixed("settled", SETTLED_REASON),
    fixed("deadline-original", ORIGINAL_DEADLINE_REASON),
    fixed("in-flight", IN_FLIGHT_REASON),
    fixed("replacement-failed", REPLACEMENT_FAILED_REASON),
    fixed("not-resendable", NOT_RESENDABLE_REASON),
    fixed("sent-outside", SENT_OUTSIDE_REASON),
    fixed("below-floor", BELOW_FLOOR_REASON),
    fixed("cash-unreadable", UNREADABLE_CASH_REASON),
    fixed("no-floor", NO_FLOOR_REASON),
    fixed("two-approvers", TWO_APPROVERS_REASON),
    {
      code: "new-rate-replacement",
      source: `a replacement paid from (${CURRENCY_SOURCE}) takes a new exchange rate, so a person approves it`,
      slots: (match: RegExpExecArray): Slots => ({ wallet: match[1] ?? "" }),
      text: (slots: Slots): string =>
        `a replacement paid from ${slots.wallet ?? ""} takes a new exchange rate, so a person approves it`,
    },
    fixed("replace", REPLACE_REASON),
    fixed("last-paid-account-changed", LAST_PAID_CHANGED_REASON),
    fixed("account-unconfirmed", UNCONFIRMED_ACCOUNT_REASON),
    fixed("outage", OUTAGE_REASON),
    fixed("emails-before-payment", EMAILS_BEFORE_PAYMENT_REASON),
    fixed("late-transfer", LATE_TRANSFER_REASON),
    fixed("unrecognised-transfer", MISMATCHED_TRANSFER_REASON),
    fixed("unrecognised-transfer-failed", MISMATCHED_FAILED_REASON),
    fixed("deadline-replacement", REPLACEMENT_DEADLINE_REASON),
    fixed("account-changed-before-send", ACCOUNT_CHANGED_REASON),
    fixed("account-unknown-before-send", ACCOUNT_UNKNOWN_REASON),
    fixed("run-row-below-floor", CASH_HOLD_REASON),
    fixed("run-account-changed", RUN_ACCOUNT_CHANGED_REASON),
    fixed("beneficiary-missing", BENEFICIARY_MISSING_REASON),
    fixed("person-started", PERSON_STARTED_REASON),
    secondBillPaidPart("second-bill-paid"),
    {
      code: "second-bill",
      source: `it looks like a second bill for (${INVOICE_LIST}): the same supplier and amount, and the same invoice number apart from (${escaped(SECOND_BILL_TAIL)}|${escaped(SECOND_BILL_LEGACY_TAIL)})`,
      slots: (match: RegExpExecArray): Slots | null => {
        const invoices: string[] | null = invoicesOf(match[1] ?? "");
        return invoices === null
          ? null
          : { invoices, ...(match[2] === SECOND_BILL_LEGACY_TAIL ? { wording: "legacy" as const } : {}) };
      },
      text: (slots: Slots): string =>
        `it looks like a second bill for ${listOf(slots.invoices ?? [])}: the same supplier and amount, and the same invoice number apart from ${slots.wording === "legacy" ? SECOND_BILL_LEGACY_TAIL : SECOND_BILL_TAIL}`,
    },
    {
      code: "same-invoice-number",
      source: `it has the same invoice number as (${INVOICE_LIST}), apart from ${escaped(SECOND_BILL_TAIL)}, for the same supplier, and PayOnce pays an invoice number once`,
      slots: (match: RegExpExecArray): Slots | null => {
        const invoices: string[] | null = invoicesOf(match[1] ?? "");
        return invoices === null ? null : { invoices };
      },
      text: (slots: Slots): string =>
        `it has the same invoice number as ${listOf(slots.invoices ?? [])}, apart from ${SECOND_BILL_TAIL}, for the same supplier, and PayOnce pays an invoice number once`,
    },
    {
      code: "new-rate-first-payment",
      source: `it is paid from (${CURRENCY_SOURCE}), so a person approves the exchange rate before PayOnce pays it`,
      slots: (match: RegExpExecArray): Slots => ({ wallet: match[1] ?? "" }),
      text: (slots: Slots): string =>
        `it is paid from ${slots.wallet ?? ""}, so a person approves the exchange rate before PayOnce pays it`,
    },
    {
      code: "refused",
      source: "Airwallex refused the original payment(?: \\(([^()]{1,60})\\))?, so nothing was sent",
      slots: (match: RegExpExecArray): Slots => (match[1] === undefined ? {} : { failureCode: match[1] }),
      text: (slots: Slots): string =>
        `Airwallex refused the original payment${slots.failureCode === undefined ? "" : ` (${slots.failureCode})`}, so nothing was sent`,
    },
    RATE_MISMATCH,
    transferPart("misdirected", MISDIRECTED_TAIL, MISDIRECTED_LEGACY_TAIL),
    transferPart(
      "no-bank-details-shown",
      "shows no bank details, so PayOnce cannot check they are the ones it was decided or approved for",
    ),
    transferPart("found-after-close", "was found in Airwallex after the invoice was closed"),
  ];
}

function clauseParts(): Part<ClauseCode>[] {
  return [
    fixed("below-floor", BELOW_FLOOR_REASON),
    fixed("cash-unreadable", UNREADABLE_CASH_REASON),
    fixed("no-floor", NO_FLOOR_CLAUSE),
    secondBillPaidPart("second-bill-paid"),
    fixed("asks-not-to-pay", NOT_TO_PAY_CLAUSE),
  ];
}

interface Grammar {
  leads: Compiled<ReasonCode>[];
  clauses: Compiled<ClauseCode>[];
  leadOf: Map<ReasonCode, Compiled<ReasonCode>>;
  clauseOf: Map<ClauseCode, Compiled<ClauseCode>>;
}

// Built on first use.
let grammar: Grammar | null = null;

function grammarOf(): Grammar {
  if (grammar === null) {
    const leads: Compiled<ReasonCode>[] = compiled(leadParts());
    const clauses: Compiled<ClauseCode>[] = compiled(clauseParts());
    grammar = {
      leads,
      clauses,
      leadOf: new Map(leads.map((part: Compiled<ReasonCode>): [ReasonCode, Compiled<ReasonCode>] => [part.code, part])),
      clauseOf: new Map(clauses.map((part: Compiled<ClauseCode>): [ClauseCode, Compiled<ClauseCode>] => [part.code, part])),
    };
  }
  return grammar;
}

function matchAt<C extends string>(part: Compiled<C>, text: string, at: number): { slots: Slots; end: number } | null {
  part.test.lastIndex = at;
  const match: RegExpExecArray | null = part.test.exec(text);
  if (match === null) {
    return null;
  }
  const slots: Slots | null = part.slots(match);
  return slots === null ? null : { slots, end: at + match[0].length };
}

// The clauses from at to the end of text, each after ", and ". Backtracks, so a
// clause that also matches a shorter prefix does not hide a longer one.
function clausesFrom(text: string, at: number): Clause[] | null {
  if (at === text.length) {
    return [];
  }
  if (!text.startsWith(AND, at)) {
    return null;
  }
  for (const part of grammarOf().clauses) {
    const found: { slots: Slots; end: number } | null = matchAt(part, text, at + AND.length);
    if (found === null) {
      continue;
    }
    const rest: Clause[] | null = clausesFrom(text, found.end);
    if (rest !== null) {
      return [{ code: part.code, slots: found.slots }, ...rest];
    }
  }
  return null;
}

export function reasonText(reason: StoredReason): string {
  if (reason.code === "unrecognised") {
    return reason.text;
  }
  const { leadOf, clauseOf }: Grammar = grammarOf();
  const lead: string = leadOf.get(reason.code)?.text(reason.slots) ?? "";
  return [lead, ...reason.clauses.map((clause: Clause): string => clauseOf.get(clause.code)?.text(clause.slots) ?? "")].join(
    AND,
  );
}

// The reason a stored text holds. Only a parse that renders back to the text
// exactly counts, so reasonText(parseReason(text)) === text for every text.
export function parseReason(text: string): StoredReason {
  for (const part of grammarOf().leads) {
    const found: { slots: Slots; end: number } | null = matchAt(part, text, 0);
    if (found === null) {
      continue;
    }
    const clauses: Clause[] | null = clausesFrom(text, found.end);
    if (clauses === null) {
      continue;
    }
    const reason: Reason = { code: part.code, slots: found.slots, clauses };
    if (reasonText(reason) === text) {
      return reason;
    }
  }
  return { code: "unrecognised", text };
}

export function clauseText(clause: Clause): string {
  return grammarOf().clauseOf.get(clause.code)?.text(clause.slots) ?? "";
}

// A lone clause as the engine writes it on a line of its own ("Also, ..."), or
// null for text that is not one.
export function parseClause(text: string): Clause | null {
  for (const part of grammarOf().clauses) {
    const found: { slots: Slots; end: number } | null = matchAt(part, text, 0);
    if (found !== null && found.end === text.length) {
      const clause: Clause = { code: part.code, slots: found.slots };
      if (clauseText(clause) === text) {
        return clause;
      }
    }
  }
  return null;
}

// ---------- reasons as obligations stores them ----------

// The four columns an escalation writes: the text, which stays the record, and
// its lead's code, clauses and slots as JSON. A reason that never went to a
// person has an empty text and code.
export interface ReasonColumns {
  text: string;
  code: string;
  clauses: string;
  slots: string;
}

export function reasonColumns(reason: StoredReason | null): ReasonColumns {
  if (reason === null) {
    return { text: "", code: "", clauses: "[]", slots: "{}" };
  }
  return reason.code === "unrecognised"
    ? { text: reason.text, code: "unrecognised", clauses: "[]", slots: "{}" }
    : {
        text: reasonText(reason),
        code: reason.code,
        clauses: JSON.stringify(reason.clauses),
        slots: JSON.stringify(reason.slots),
      };
}

function isReasonCode(code: string): code is ReasonCode {
  return Object.hasOwn(FAMILIES, code);
}

function isClauseCode(code: unknown): code is ClauseCode {
  return typeof code === "string" && grammarOf().clauseOf.has(code as ClauseCode);
}

// The codes as stored, when they render the stored text exactly, or null.
function codedReason(columns: ReasonColumns): Reason | null {
  if (!isReasonCode(columns.code)) {
    return null;
  }
  try {
    const slots: unknown = JSON.parse(columns.slots);
    const clauses: unknown = JSON.parse(columns.clauses);
    if (
      slots === null ||
      typeof slots !== "object" ||
      Array.isArray(slots) ||
      !Array.isArray(clauses) ||
      !clauses.every(
        (clause: unknown): boolean =>
          typeof clause === "object" &&
          clause !== null &&
          isClauseCode((clause as { code?: unknown }).code) &&
          typeof (clause as { slots?: unknown }).slots === "object",
      )
    ) {
      return null;
    }
    const reason: Reason = { code: columns.code, slots: slots as Slots, clauses: clauses as Clause[] };
    return reasonText(reason) === columns.text ? reason : null;
  } catch {
    return null;
  }
}

let driftSaid: boolean = false;

// The reason a row holds, from its codes. The text is the record: a row whose
// codes do not render its text, as when a PayOnce from before codes rewrote the
// text of a row this one coded, or one with none, is read by parsing the text,
// and the first such row in a process says so once.
export function storedReason(columns: ReasonColumns): StoredReason | null {
  if (columns.text === "") {
    return null;
  }
  const coded: Reason | null = codedReason(columns);
  if (coded !== null) {
    return coded;
  }
  if (columns.code !== "" && columns.code !== "unrecognised" && !driftSaid) {
    driftSaid = true;
    console.warn("An escalation reason's stored codes do not match its text, so PayOnce read the text instead");
  }
  return parseReason(columns.text);
}

// ---------- building reasons ----------

export function reasonFor(code: ReasonCode, slots: Slots = {}): Reason {
  return { code, slots, clauses: [] };
}

export const NOT_TO_PAY: Clause = { code: "asks-not-to-pay", slots: {} };

// The policy's reason as codes. decide.ts gives each reason as one of its
// constants, or the cross-currency one built on the wallet, so the text maps to
// one code exactly. Anything else throws, and the look fails closed.
export function policyReason(text: string, wallet: string): Reason {
  for (const code of POLICY_CODES) {
    const reason: Reason = reasonFor(code, code === "new-rate-replacement" ? { wallet } : {});
    if (reasonText(reason) === text) {
      return reason;
    }
  }
  throw new Error("The policy gave a reason PayOnce has no code for");
}

const POLICY_CODES: readonly ReasonCode[] = [
  "outside-payout",
  "new-bank-details",
  "asks-not-to-pay",
  "bank-details-changed",
  "unverified-sender",
  "emails-unread",
  "email-partly-unread",
  "unknown-status",
  "non-receipt",
  "settled",
  "deadline-original",
  "in-flight",
  "replacement-failed",
  "not-resendable",
  "sent-outside",
  "below-floor",
  "cash-unreadable",
  "no-floor",
  "two-approvers",
  "new-rate-replacement",
  "replace",
];

// The floor clause for floorReason's text: the clause the engine adds to another
// reason, whose text for no floor is the short one.
export function floorClause(floorText: string): Clause {
  if (floorText === BELOW_FLOOR_REASON) {
    return { code: "below-floor", slots: {} };
  }
  if (floorText === UNREADABLE_CASH_REASON) {
    return { code: "cash-unreadable", slots: {} };
  }
  if (floorText === NO_FLOOR_REASON) {
    return { code: "no-floor", slots: {} };
  }
  throw new Error("The policy gave a floor reason PayOnce has no code for");
}

export const FLOOR_CLAUSES: readonly ClauseCode[] = ["below-floor", "cash-unreadable", "no-floor"];

export function secondBillPaid(invoice: string): Reason {
  return reasonFor("second-bill-paid", { invoice });
}

// A first payment held as a likely second bill for invoices on file, or for one
// with the same number for the same supplier.
export function heldAsSecondBill(invoices: string[]): Reason {
  return reasonFor("second-bill", { invoices });
}

export function heldForSameNumber(invoices: string[]): Reason {
  return reasonFor("same-invoice-number", { invoices });
}

// A first payment from another currency's wallet, held for a person to approve
// the rate.
export function heldForRate(wallet: string): Reason {
  return reasonFor("new-rate-first-payment", { wallet });
}

export function refusedOriginal(failureCode: string | null): Reason {
  return reasonFor("refused", failureCode === null ? {} : { failureCode });
}

export function foundAfterClose(kind: TransferKind, reference: string): Reason {
  return reasonFor("found-after-close", { kind, reference });
}

// A transfer that went to other bank details than it was decided or approved
// for, or that shows none.
export function accountMismatchOf(kind: TransferKind, reference: string, shown: boolean): Reason {
  return reasonFor(shown ? "misdirected" : "no-bank-details-shown", { kind, reference });
}

// Why a transfer did not go out on its approved quote, or null when it did. fx is
// undefined when no approval covers the quote it was sent with. Rates are
// compared as Airwallex gives them, never inverted, and a transfer with no
// conversion on it does not match.
export function rateMismatchOf(kind: TransferKind, fx: FxTerms | undefined, transfer: Transfer): Reason | null {
  const debit: Debit | null = debitOf(transfer);
  if (
    fx !== undefined &&
    transfer.conversion?.currency_pair === fx.currencyPair &&
    transfer.conversion.rate === fx.clientRate &&
    debit?.minor === fx.sellAmountMinor &&
    debit.currency === fx.sellCurrency
  ) {
    return null;
  }
  const actual: Slots =
    transfer.conversion === undefined
      ? { noRate: true }
      : debit === null
        ? { rate: { pair: transfer.conversion.currency_pair, rate: transfer.conversion.rate }, amountUnreadable: true }
        : {
            rate: { pair: transfer.conversion.currency_pair, rate: transfer.conversion.rate },
            amount: { minor: debit.minor, currency: debit.currency },
          };
  return reasonFor("rate-mismatch", {
    kind,
    reference: transfer.short_reference_id,
    ...actual,
    ...(fx === undefined
      ? { noQuoteApproved: true }
      : {
          approved: {
            pair: fx.currencyPair,
            rate: fx.clientRate,
            minor: fx.sellAmountMinor,
            currency: fx.sellCurrency,
          },
        }),
  });
}

// The same reason without the clauses named, as alerts compare it, so a floor
// clause the agent adds or drops as the balance moves does not alert again.
export function withoutClauses(reason: StoredReason, codes: readonly ClauseCode[]): StoredReason {
  return reason.code === "unrecognised"
    ? reason
    : { ...reason, clauses: reason.clauses.filter((clause: Clause): boolean => !codes.includes(clause.code)) };
}

// ---------- what a reason is about ----------

// The supplier's bank details: asked for, changed after the original, or changed
// since PayOnce last paid the supplier.
export function aboutBankDetailsReason(reason: StoredReason | null): boolean {
  const code: string | undefined = reason?.code;
  return code === "new-bank-details" || code === "bank-details-changed" || code === "last-paid-account-changed";
}

// The record's bank details changed after a payment to it was made, decided or
// approved.
export function accountChangedReason(reason: StoredReason | null): boolean {
  const code: string | undefined = reason?.code;
  return (
    code === "bank-details-changed" ||
    code === "last-paid-account-changed" ||
    code === "account-changed-before-send" ||
    code === "run-account-changed"
  );
}

export function deadlineReason(reason: StoredReason | null): boolean {
  return reason?.code === "deadline-original" || reason?.code === "deadline-replacement";
}

function sameSlots(a: Slots, b: Slots): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The reason with a clause joined on as the engine joins it, last, unless the
// lead or a clause already names it.
export function withClause(reason: Reason, clause: Clause): Reason {
  const named: boolean =
    (reason.code === clause.code && (clause.code !== "second-bill-paid" || sameSlots(reason.slots, clause.slots))) ||
    reason.clauses.some((other: Clause): boolean => other.code === clause.code && sameSlots(other.slots, clause.slots));
  return named ? reason : { ...reason, clauses: [...reason.clauses, clause] };
}

const FAMILIES: Record<ReasonCode, ReasonFamily> = {
  "outside-payout": "sent-outside",
  "new-bank-details": "bank-details",
  "asks-not-to-pay": "supplier-email",
  "bank-details-changed": "bank-details",
  "unverified-sender": "supplier-email",
  "emails-unread": "supplier-email",
  "email-partly-unread": "supplier-email",
  "unknown-status": "status",
  "non-receipt": "supplier-email",
  settled: "other",
  "deadline-original": "bank-deadline",
  "in-flight": "status",
  "replacement-failed": "not-resendable",
  "not-resendable": "not-resendable",
  "sent-outside": "sent-outside",
  "below-floor": "cash",
  "cash-unreadable": "cash",
  "no-floor": "cash",
  "two-approvers": "two-approvers",
  "new-rate-replacement": "exchange-rate",
  replace: "other",
  "last-paid-account-changed": "bank-details",
  "account-unconfirmed": "bank-details",
  outage: "outage",
  "emails-before-payment": "supplier-email",
  "late-transfer": "paid-twice",
  "unrecognised-transfer": "paid-twice",
  "unrecognised-transfer-failed": "paid-twice",
  "deadline-replacement": "bank-deadline",
  "account-changed-before-send": "bank-details",
  "account-unknown-before-send": "bank-details",
  "run-row-below-floor": "cash",
  "run-account-changed": "bank-details",
  "beneficiary-missing": "bank-details",
  "person-started": "approval",
  "second-bill-paid": "second-bill",
  "second-bill": "second-bill",
  "same-invoice-number": "second-bill",
  "new-rate-first-payment": "exchange-rate",
  refused: "refused",
  "rate-mismatch": "exchange-rate",
  misdirected: "bank-details",
  "no-bank-details-shown": "bank-details",
  "found-after-close": "paid-twice",
};

export function familyOf(code: ReasonCode | ClauseCode | "unrecognised"): ReasonFamily {
  return code === "unrecognised" ? "other" : FAMILIES[code];
}

const LABELS: Record<ReasonCode | "unrecognised", string> = {
  "outside-payout": "Payout sent outside PayOnce",
  "new-bank-details": "Supplier asked for new bank details",
  "asks-not-to-pay": "Supplier asked not to pay",
  "bank-details-changed": "Bank details changed since the original",
  "unverified-sender": "Email from an unexpected address",
  "emails-unread": "Supplier emails not read",
  "email-partly-unread": "Part of an email not read",
  "unknown-status": "Transfer in an unknown status",
  "non-receipt": "Supplier says it has not arrived",
  settled: "Original paid",
  "deadline-original": "Bank late with the original",
  "in-flight": "Original still with the bank",
  "replacement-failed": "Replacement failed too",
  "not-resendable": "Failed in a way a resend cannot fix",
  "sent-outside": "Original sent outside PayOnce",
  "below-floor": "Would go below the reserve floor",
  "cash-unreadable": "Cash could not be read",
  "no-floor": "No reserve floor set",
  "two-approvers": "Large enough for two approvers",
  "new-rate-replacement": "New exchange rate to approve",
  replace: "A resend can fix it",
  "last-paid-account-changed": "Bank details differ from the last paid",
  "account-unconfirmed": "Account never confirmed",
  outage: "Rail outage",
  "emails-before-payment": "Emails arrived before paying",
  "late-transfer": "May be paid twice",
  "unrecognised-transfer": "Unrecognised transfer",
  "unrecognised-transfer-failed": "Unrecognised transfer",
  "deadline-replacement": "Bank late with the replacement",
  "account-changed-before-send": "Bank details changed before sending",
  "account-unknown-before-send": "Bank details not known before sending",
  "run-row-below-floor": "Pay run row below the floor",
  "run-account-changed": "Bank details changed after the run was approved",
  "beneficiary-missing": "Supplier record gone from Airwallex",
  "person-started": "New payment to approve",
  "second-bill-paid": "Looks like a second bill",
  "second-bill": "Looks like a second bill",
  "same-invoice-number": "Same invoice number as another",
  "new-rate-first-payment": "New exchange rate to approve",
  refused: "Airwallex refused the transfer",
  "rate-mismatch": "Rate nobody approved",
  misdirected: "Went to other bank details",
  "no-bank-details-shown": "Went to other bank details",
  "found-after-close": "Transfer found after closing",
  unrecognised: "A reason PayOnce does not recognise",
};

const CLAUSE_LABELS: Record<ClauseCode, string> = {
  "below-floor": LABELS["below-floor"],
  "cash-unreadable": LABELS["cash-unreadable"],
  "no-floor": LABELS["no-floor"],
  "second-bill-paid": LABELS["second-bill-paid"],
  "asks-not-to-pay": LABELS["asks-not-to-pay"],
};

// ---------- why a request needs more than one approver ----------

export type NeededWhyCode =
  | "new-account"
  | "starter-unknown"
  | "above-threshold"
  | "never-paid"
  | "paid-before-keeping-accounts"
  | "account-not-paid-before"
  | "never-paid-on-approval"
  | "other-invoice-account"
  | "run-new-payee"
  | "run-callback-account"
  | "run-above-threshold"
  | "uploader-unknown";

// The words approvers.ts, the engine and runs.ts give for a second approver,
// each whole, with the older wordings still on file.
const NEEDED_WHY: readonly [NeededWhyCode, RegExp][] = [
  ["new-account", /^it pays an account the original payment did not go to$/],
  ["starter-unknown", /^PayOnce does not know who started this payment$/],
  ["above-threshold", new RegExp(`^the amount is above ${MONEY}$`)],
  ["never-paid", /^PayOnce has never paid this beneficiary$/],
  ["paid-before-keeping-accounts", /^PayOnce paid this supplier before it kept which account each payment went to$/],
  ["account-not-paid-before", /^it pays an account PayOnce has not paid this supplier before$/],
  ["never-paid-on-approval", /^PayOnce has never paid this beneficiary on a person's approval$/],
  [
    "other-invoice-account",
    new RegExp(`^it pays (?:a different account from the one|another account than the one) ${INVOICE} was (?:sent|paid) to$`),
  ],
  ["run-new-payee", /^row [0-9]+ pays .+, which PayOnce has never paid on a person's approval$/],
  ["run-callback-account", /^row [0-9]+ pays an account a callback verified, not the one PayOnce last paid .+$/],
  ["run-above-threshold", new RegExp(`^the ${CURRENCY_SOURCE} total is above ${MONEY}$`)],
  ["uploader-unknown", /^PayOnce does not know who uploaded this run$/],
];

// The code of a request's needed_why, with its text as stored. Null for a
// request that needs one approver.
export function neededWhyOf(text: string): { code: NeededWhyCode | "unrecognised"; text: string } | null {
  if (text === "") {
    return null;
  }
  const found: [NeededWhyCode, RegExp] | undefined = NEEDED_WHY.find(
    ([, test]: [NeededWhyCode, RegExp]): boolean => test.test(text),
  );
  return { code: found?.[0] ?? "unrecognised", text };
}

export function labelOf(code: ReasonCode | "unrecognised"): string {
  return LABELS[code];
}

export function reasonView(reason: StoredReason): ReasonView {
  return {
    code: reason.code,
    family: familyOf(reason.code),
    label: LABELS[reason.code],
    text: reasonText(reason),
    clauses:
      reason.code === "unrecognised"
        ? []
        : reason.clauses.map((clause: Clause): { code: ClauseCode; label: string } => ({
            code: clause.code,
            label: CLAUSE_LABELS[clause.code],
          })),
  };
}

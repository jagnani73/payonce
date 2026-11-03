import { RESENDABLE_FAILURE_CODES } from "./assess.js";
import { attemptLostFee, payoutLostFee } from "./cash-position.js";
import {
  expiryOf,
  ownLive,
  type Ledger,
  type MetricsAttempt,
  type MetricsObligation,
  type MetricsOutage,
  type MetricsPayout,
  type MetricsRead,
  type MetricsRequest,
} from "./ledger.js";
import { RAIL_FAILURE_CODES } from "./outages.js";
import { BREAK_KINDS, clearsByItself, KIND_LABELS, type BreakKind } from "./recon-match.js";
import type { BreakTimes } from "./recon-store.js";
import { FAILURE_WORDS, KNOWN_CODES, REASON_LEADS, type ReasonCode } from "./why-facts.js";

// Ops metrics over three periods, from the ledger alone. Display only: nothing
// PayOnce decides, alerts on, binds or checks reads them. Every string in a
// report is a code from a fixed set, a currency code, an ISO time or one of the
// fixed labels below, so no name, note, reference, reason text, email or
// Airwallex message can reach one. Amounts are minor units of one currency and
// are never added across currencies.

export type Period = "7d" | "30d" | "all";
export const PERIODS: readonly Period[] = ["7d", "30d", "all"];
export const PERIOD_PROBLEM: string = "The period is 7d, 30d or all";

const DAY_MS: number = 86_400_000;
const PERIOD_DAYS: Record<Exclude<Period, "all">, number> = { "7d": 7, "30d": 30 };
const CURRENCY: RegExp = /^[A-Z]{3}$/;
const FIVE_DIGITS: RegExp = /^[0-9]{5}$/;
const ISO_YEAR: RegExp = /^[0-9]{4}-/;

export function isPeriod(value: string): value is Period {
  return (PERIODS as readonly string[]).includes(value);
}

export const REASON_LABELS: Record<ReasonCode, string> = {
  "bank-deadline": "Bank deadline passed",
  status: "Original still with the bank, or in a status PayOnce does not know",
  "not-resendable": "Failed in a way a resend cannot fix",
  refused: "Airwallex refused the first payment",
  "sent-outside": "A payout was sent outside PayOnce",
  "bank-details": "Bank details changed or not confirmed",
  "second-bill": "Looked like a second bill",
  "supplier-email": "A supplier email",
  cash: "Reserve floor or cash",
  "two-approvers": "Large enough to need two approvers",
  "exchange-rate": "Exchange rate to approve or check",
  outage: "Rail outage",
  "paid-twice": "May have been paid twice",
  other: "A reason PayOnce does not recognise",
};
const REASON_ORDER: readonly ReasonCode[] = Object.keys(REASON_LABELS) as ReasonCode[];

const NO_CODE_LABEL: string = "no failure code on file";
const OTHER_CODE_LABEL: string = "a code PayOnce does not pass on";
const NO_WORDS_LABEL: string = "no words on file";
const OTHER_KIND_LABEL: string = "A kind PayOnce does not know";

// n, the median and p90 by nearest rank, and the longest, in whole seconds.
// notOnFile counts what a time was missing or unreadable for, or came out
// negative. p90 is null below 10.
export interface Spread {
  n: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  maxSeconds: number | null;
  notOnFile: number;
}

export type PaymentKind = "first" | "first-approved" | "replacement-auto" | "replacement-approved";
const PAYMENT_KINDS: readonly PaymentKind[] = ["first", "first-approved", "replacement-auto", "replacement-approved"];
export type Method = "LOCAL" | "SWIFT" | "other";
const METHODS: readonly Method[] = ["LOCAL", "SWIFT", "other"];

export interface PaymentRow {
  currency: string;
  what: PaymentKind;
  sent: number;
  paid: number;
  failed: number;
  withBank: number;
  paidMinor: number;
  fromPayRuns: number;
}

export interface FirstTimeRow {
  currency: string;
  ended: number;
  paid: number;
  percent: number | null;
}

// Money by the wallet it left, and how many payments it was.
export interface WalletMoney {
  currency: string;
  payments: number;
  amountMinor: number;
}

// Invoices with two or more payments paid at the bank, PayOnce's own and payouts
// sent outside it. extra is what each paid payment after the first took: PayOnce's
// in the order it opened them, then payouts in the order they were tied. notKnown
// counts extra payments whose amount the ledger does not hold.
export interface PaidTwice {
  invoices: number;
  extra: WalletMoney[];
  notKnown: number;
}

// Paid transfers kept beside an attempt because they do not carry its invoice's
// number, amount and currency. They are counted apart, never as a second payment
// of the invoice.
export interface MismatchedPaid {
  invoices: number;
  transfers: number;
  paid: WalletMoney[];
  notKnown: number;
}

export interface BankTimeRow extends Spread {
  currency: string;
  method: Method;
}

export interface PaymentsTable {
  rows: PaymentRow[];
  firstTime: FirstTimeRow[];
  paidMoreThanOnce: PaidTwice;
  mismatchedPaid: MismatchedPaid;
  bankTimeToPay: BankTimeRow[];
  notOnFile: number;
  unreadable: number;
}

export type FailureStage = "bank" | "refused" | "never-created";
const STAGES: readonly FailureStage[] = ["bank", "refused", "never-created"];

export interface FailureRow {
  currency: string;
  method: Method;
  stage: FailureStage;
  code: string;
  label: string;
  rail: boolean;
  resendable: boolean;
  payonce: number;
  outside: number;
}

export interface FailuresTable {
  rows: FailureRow[];
  outsidePayoutsFailed: number;
  notOnFile: number;
  unreadable: number;
}

export type CloseHow = "first-time" | "replaced" | "person-paid" | "not-paid";
const CLOSE_HOWS: readonly CloseHow[] = ["first-time", "replaced", "person-paid", "not-paid"];
export type CloseGroup = "paid-first-time" | "recovered-by-itself" | "with-a-person";
const CLOSE_GROUPS: readonly CloseGroup[] = ["paid-first-time", "recovered-by-itself", "with-a-person"];
const GROUP_OF: Record<CloseHow, CloseGroup> = {
  "first-time": "paid-first-time",
  replaced: "recovered-by-itself",
  "person-paid": "with-a-person",
  "not-paid": "with-a-person",
};

export interface ClosedRow {
  currency: string;
  how: CloseHow;
  count: number;
  amountMinor: number;
  fromPayRuns: number;
  found: number;
}

export interface GroupSpread extends Spread {
  group: CloseGroup;
}

export interface ReasonRow {
  code: ReasonCode;
  label: string;
  paid: number;
  notPaid: number;
}

export interface IncidentsTable {
  started: { single: number; payRun: number; found: number; notOnFile: number };
  closed: ClosedRow[];
  // From the first timeline line to the close.
  timeToClose: GroupSpread[];
  // From the first time an original was recorded failed to the close, for the
  // invoices whose original failed.
  afterFailure: GroupSpread[];
  // From the first time the invoice went to a person to the close.
  withPerson: Spread;
  // The reason on file when a person's invoice closed.
  reasons: ReasonRow[];
  notOnFile: number;
  unreadable: number;
}

export interface ApprovalRow {
  of: "invoice" | "run";
  given: number;
  twoApprovers: number;
  spent: number;
  voided: number;
  waiting: number;
  // From an episode's first request to the signoff that completed one.
  wait: Spread;
  notOnFile: number;
}

export interface ApprovalsTable {
  rows: ApprovalRow[];
  // Requests waiting for a person now, whatever the period.
  openNow: number;
}

export interface FeeRow {
  currency: string;
  transfers: number;
  feeMinor: number;
  notRead: number;
  payonce: number;
  outside: number;
}

export interface FeesTable {
  rows: FeeRow[];
  notOnFile: number;
  unreadable: number;
}

export interface DuplicateRow {
  currency: string;
  held: number;
  stopped: number;
  stoppedMinor: number;
  paid: number;
  stillHeld: number;
}

export interface DuplicatesTable {
  rows: DuplicateRow[];
  notOnFile: number;
  unreadable: number;
}

export interface OutageCode {
  code: string;
  label: string;
}

export interface OutageRow {
  id: number;
  currency: string;
  method: Method;
  declaredAt: string | null;
  endedAt: string | null;
  seconds: number | null;
  active: boolean;
  payees: number;
  codes: OutageCode[];
  held: { original: number; replacement: number; approved: number; run: number };
}

export interface RailRow {
  currency: string;
  method: Method;
  outages: number;
  totalSeconds: number;
  longestSeconds: number | null;
}

export interface OutagesTable {
  rows: OutageRow[];
  byRail: RailRow[];
  notOnFile: number;
  unreadable: number;
}

export type ReconKind = BreakKind | "other";

export interface ReconRow {
  kind: ReconKind;
  label: string;
  byItself: boolean;
  found: number;
  explained: number;
  cleared: number;
  open: number;
}

export interface ReconTable {
  ran: boolean;
  rows: ReconRow[];
  resolve: Spread;
  notOnFile: number;
}

export interface MetricsReport {
  period: Period;
  from: string | null;
  to: string;
  builtAt: string;
  ledgerStartedAt: string | null;
  payments: PaymentsTable;
  failures: FailuresTable;
  incidents: IncidentsTable;
  approvals: ApprovalsTable;
  fees: FeesTable;
  duplicates: DuplicatesTable;
  outages: OutagesTable;
  recon: ReconTable;
}

// ---------- shared rules ----------

// from null is since the ledger started: every row is in, one with no time too.
interface Window {
  from: number | null;
  to: number;
}

type Where = "in" | "out" | "unknown";

function msOf(at: string | null): number {
  return at === null ? Number.NaN : Date.parse(at);
}

function where(at: string | null, window: Window): Where {
  if (window.from === null) {
    return "in";
  }
  const ms: number = msOf(at);
  if (Number.isNaN(ms)) {
    return "unknown";
  }
  return ms >= window.from && ms <= window.to ? "in" : "out";
}

// An ISO time with a four-digit year, or null, so every time is in one form.
function isoOf(ms: number): string | null {
  if (!Number.isFinite(ms)) {
    return null;
  }
  const iso: string = new Date(ms).toISOString();
  return ISO_YEAR.test(iso) ? iso : null;
}

function secondsBetween(from: number, to: number): number | null {
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return null;
  }
  const seconds: number = Math.floor((to - from) / 1000);
  return seconds < 0 ? null : seconds;
}

function seconds(from: string | null, to: string | null): number | null {
  return secondsBetween(msOf(from), msOf(to));
}

class Durations {
  private readonly values: number[] = [];
  private missing: number = 0;

  add(value: number | null): void {
    if (value === null) {
      this.missing += 1;
    } else {
      this.values.push(value);
    }
  }

  spread(): Spread {
    const sorted: number[] = [...this.values].sort((a: number, b: number): number => a - b);
    const n: number = sorted.length;
    return {
      n,
      medianSeconds: n === 0 ? null : (sorted[Math.ceil(0.5 * n) - 1] ?? null),
      p90Seconds: n < 10 ? null : (sorted[Math.ceil(0.9 * n) - 1] ?? null),
      maxSeconds: n === 0 ? null : (sorted[n - 1] ?? null),
      notOnFile: this.missing,
    };
  }
}

export function percentOf(part: number, whole: number): number | null {
  return whole >= 1 ? Math.round((100 * part) / whole) : null;
}

function methodOf(method: string): Method {
  return method === "LOCAL" || method === "SWIFT" ? method : "other";
}

type Outcome = "paid" | "failed" | "with-bank";

// The attempt's own payment as the bank has it now, by liveAtBank's rules: a
// transfer the ledger keeps failed while the bank has it live is with the bank.
function outcomeOf(attempt: MetricsAttempt): Outcome {
  if (attempt.state === "paid" || attempt.bankStatus === "PAID") {
    return "paid";
  }
  return ownLive(attempt) ? "with-bank" : "failed";
}

// A found payout's original was sent by someone else.
function sentOutside(obligation: MetricsObligation, attempt: MetricsAttempt): boolean {
  return obligation.origin === "outside" && attempt.kind === "original";
}

// What a payment took from the wallet it left, before the fee.
interface Took {
  currency: string;
  amountMinor: number;
}

function tookOf(currency: string | null, amountMinor: number | null): Took | null {
  return currency !== null && amountMinor !== null && Number.isSafeInteger(amountMinor) ? { currency, amountMinor } : null;
}

// What a paid attempt took: as debitOf stored it, else for PayOnce's own payment
// the invoice's amount from the invoice's own wallet, which it sent exactly, or
// the sell amount of its quote from another currency's wallet. A payout someone
// sent outside PayOnce and found as the invoice's original has no amount PayOnce
// set, so with none stored it is not known.
function attemptTook(obligation: MetricsObligation, attempt: MetricsAttempt): Took | null {
  const stored: Took | null = tookOf(attempt.currency, attempt.amountMinor);
  if (stored !== null || sentOutside(obligation, attempt)) {
    return stored;
  }
  return obligation.wallet === obligation.currency
    ? tookOf(obligation.currency, obligation.amountMinor)
    : tookOf(obligation.wallet, attempt.quoteAmountMinor);
}

function failureCodeOf(code: string | null): string {
  if (code === null) {
    return "none";
  }
  return FIVE_DIGITS.test(code) || KNOWN_CODES.has(code) ? code : "other";
}

function failureLabel(code: string): string {
  if (code === "none") {
    return NO_CODE_LABEL;
  }
  if (code === "other") {
    return OTHER_CODE_LABEL;
  }
  return Object.hasOwn(FAILURE_WORDS, code) ? (FAILURE_WORDS[code] ?? NO_WORDS_LABEL) : NO_WORDS_LABEL;
}

// The code of the reason an invoice went to a person, from its leading part only,
// matched against PayOnce's own reason grammar. Anything else is other, so a
// reworded constant or a reason from an older PayOnce shows up instead of being
// guessed. Only the code ever leaves this function.
export function reasonCode(reason: string): ReasonCode {
  for (const lead of REASON_LEADS) {
    lead.test.lastIndex = 0;
    const match: RegExpExecArray | null = lead.test.exec(reason);
    if (match === null) {
      continue;
    }
    const end: number = match[0].length;
    if (end === reason.length || reason.startsWith(", and ", end)) {
      return lead.code ?? "other";
    }
  }
  return "other";
}

function byCurrency<T extends { currency: string }>(rows: Iterable<T>): T[] {
  return [...rows].sort((a: T, b: T): number => a.currency.localeCompare(b.currency));
}

function grouped<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups: Map<string, T[]> = new Map();
  for (const item of items) {
    const list: T[] = groups.get(key(item)) ?? [];
    list.push(item);
    groups.set(key(item), list);
  }
  return groups;
}

function rowFor<T>(rows: Map<string, T>, key: string, make: () => T): T {
  let row: T | undefined = rows.get(key);
  if (row === undefined) {
    row = make();
    rows.set(key, row);
  }
  return row;
}

interface Indexed {
  obligations: Map<string, MetricsObligation>;
  attempts: Map<string, MetricsAttempt[]>;
  payouts: Map<string, MetricsPayout[]>;
}

// ---------- 1. payments sent ----------

function paymentsOf(read: MetricsRead, index: Indexed, window: Window): PaymentsTable {
  const rows: Map<string, PaymentRow> = new Map();
  const firstTime: Map<string, FirstTimeRow> = new Map();
  const bankTime: Map<string, { currency: string; method: Method; durations: Durations }> = new Map();
  let notOnFile: number = 0;
  let unreadable: number = 0;
  for (const attempt of read.attempts) {
    const obligation: MetricsObligation | undefined = index.obligations.get(attempt.invoiceId);
    if (obligation === undefined || attempt.transferId === null || sentOutside(obligation, attempt)) {
      continue;
    }
    const at: Where = where(attempt.bankCreatedAt, window);
    if (at === "out") {
      continue;
    }
    if (at === "unknown") {
      notOnFile += 1;
      continue;
    }
    const currency: string = obligation.currency;
    if (!CURRENCY.test(currency)) {
      unreadable += 1;
      continue;
    }
    const what: PaymentKind =
      attempt.kind === "original"
        ? attempt.approved
          ? "first-approved"
          : "first"
        : attempt.approved
          ? "replacement-approved"
          : "replacement-auto";
    const row: PaymentRow = rowFor(rows, `${currency}|${what}`, () => ({
      currency,
      what,
      sent: 0,
      paid: 0,
      failed: 0,
      withBank: 0,
      paidMinor: 0,
      fromPayRuns: 0,
    }));
    const outcome: Outcome = outcomeOf(attempt);
    row.sent += 1;
    row.fromPayRuns += obligation.fromRun ? 1 : 0;
    if (outcome === "paid") {
      row.paid += 1;
      row.paidMinor += obligation.amountMinor;
      const method: Method = methodOf(obligation.transferMethod);
      rowFor(bankTime, `${currency}|${method}`, () => ({ currency, method, durations: new Durations() })).durations.add(
        seconds(attempt.triedAt, attempt.paidAt),
      );
    } else if (outcome === "failed") {
      row.failed += 1;
    } else {
      row.withBank += 1;
    }
    if (attempt.kind === "original" && outcome !== "with-bank") {
      const first: FirstTimeRow = rowFor(firstTime, currency, () => ({ currency, ended: 0, paid: 0, percent: null }));
      first.ended += 1;
      first.paid += outcome === "paid" ? 1 : 0;
    }
  }
  // Since the ledger started, whatever the period: it should read nothing.
  const twice: PaidTwice = { invoices: 0, extra: [], notKnown: 0 };
  const extra: Map<string, WalletMoney> = new Map();
  const mismatched: MismatchedPaid = { invoices: 0, transfers: 0, paid: [], notKnown: 0 };
  const mismatchedMoney: Map<string, WalletMoney> = new Map();
  const unreadableInvoices: Set<string> = new Set();
  // Adds one payment to its wallet, or counts it not known, or, for a currency
  // that cannot be read, leaves it out of the money.
  const add = (money: Map<string, WalletMoney>, took: Took | null, invoiceId: string): boolean => {
    if (took === null) {
      return false;
    }
    if (!CURRENCY.test(took.currency)) {
      unreadableInvoices.add(invoiceId);
      return true;
    }
    const row: WalletMoney = rowFor(money, took.currency, () => ({ currency: took.currency, payments: 0, amountMinor: 0 }));
    row.payments += 1;
    row.amountMinor += took.amountMinor;
    return true;
  };
  for (const obligation of read.obligations) {
    const attempts: MetricsAttempt[] = index.attempts.get(obligation.invoiceId) ?? [];
    const paid: (Took | null)[] = [
      ...attempts
        .filter((attempt: MetricsAttempt): boolean => attempt.state === "paid" || attempt.bankStatus === "PAID")
        .map((attempt: MetricsAttempt): Took | null => attemptTook(obligation, attempt)),
      ...(index.payouts.get(obligation.invoiceId) ?? [])
        .filter((payout: MetricsPayout): boolean => payout.state === "paid")
        .map((payout: MetricsPayout): Took | null => tookOf(payout.currency, payout.amountMinor)),
    ];
    if (paid.length >= 2) {
      twice.invoices += 1;
      for (const took of paid.slice(1)) {
        twice.notKnown += add(extra, took, obligation.invoiceId) ? 0 : 1;
      }
    }
    const kept: MetricsAttempt[] = attempts.filter(
      (attempt: MetricsAttempt): boolean => attempt.mismatchedTransferId !== null && attempt.mismatchedStatus === "PAID",
    );
    if (kept.length > 0) {
      mismatched.invoices += 1;
      mismatched.transfers += kept.length;
      for (const attempt of kept) {
        mismatched.notKnown += add(
          mismatchedMoney,
          tookOf(attempt.mismatchedCurrency, attempt.mismatchedAmountMinor),
          obligation.invoiceId,
        )
          ? 0
          : 1;
      }
    }
  }
  unreadable += unreadableInvoices.size;
  return {
    rows: [...rows.values()].sort(
      (a: PaymentRow, b: PaymentRow): number =>
        a.currency.localeCompare(b.currency) || PAYMENT_KINDS.indexOf(a.what) - PAYMENT_KINDS.indexOf(b.what),
    ),
    firstTime: byCurrency(firstTime.values()).map(
      (row: FirstTimeRow): FirstTimeRow => ({ ...row, percent: percentOf(row.paid, row.ended) }),
    ),
    paidMoreThanOnce: { ...twice, extra: byCurrency(extra.values()) },
    mismatchedPaid: { ...mismatched, paid: byCurrency(mismatchedMoney.values()) },
    bankTimeToPay: [...bankTime.values()]
      .sort(
        (a: { currency: string; method: Method }, b: { currency: string; method: Method }): number =>
          a.currency.localeCompare(b.currency) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method),
      )
      .map(
        (entry: { currency: string; method: Method; durations: Durations }): BankTimeRow => ({
          currency: entry.currency,
          method: entry.method,
          ...entry.durations.spread(),
        }),
      ),
    notOnFile,
    unreadable,
  };
}

// ---------- 2. failures by rail and code ----------

function failuresOf(read: MetricsRead, index: Indexed, window: Window): FailuresTable {
  const rows: Map<string, FailureRow> = new Map();
  let notOnFile: number = 0;
  let unreadable: number = 0;
  for (const attempt of read.attempts) {
    const obligation: MetricsObligation | undefined = index.obligations.get(attempt.invoiceId);
    if (obligation === undefined) {
      continue;
    }
    let stage: FailureStage;
    let anchor: string | null;
    if (attempt.transferId !== null) {
      if (outcomeOf(attempt) !== "failed") {
        continue;
      }
      stage = "bank";
      anchor = attempt.bankCreatedAt;
    } else if (attempt.state === "failed") {
      stage = attempt.failureCode !== null ? "refused" : "never-created";
      anchor = attempt.triedAt ?? attempt.openedAt;
    } else {
      continue;
    }
    const at: Where = where(anchor, window);
    if (at === "out") {
      continue;
    }
    if (at === "unknown") {
      notOnFile += 1;
      continue;
    }
    if (!CURRENCY.test(obligation.currency)) {
      unreadable += 1;
      continue;
    }
    const method: Method = methodOf(obligation.transferMethod);
    const code: string = failureCodeOf(attempt.failureCode);
    const row: FailureRow = rowFor(rows, `${obligation.currency}|${method}|${stage}|${code}`, () => ({
      currency: obligation.currency,
      method,
      stage,
      code,
      label: failureLabel(code),
      rail: Object.hasOwn(RAIL_FAILURE_CODES, code),
      resendable: RESENDABLE_FAILURE_CODES.has(code),
      payonce: 0,
      outside: 0,
    }));
    if (sentOutside(obligation, attempt)) {
      row.outside += 1;
    } else {
      row.payonce += 1;
    }
  }
  let outsidePayoutsFailed: number = 0;
  for (const payout of read.payouts) {
    if (payout.state !== "failed") {
      continue;
    }
    const at: Where = where(payout.foundAt, window);
    if (at === "in") {
      outsidePayoutsFailed += 1;
    } else if (at === "unknown") {
      notOnFile += 1;
    }
  }
  return {
    rows: [...rows.values()].sort(
      (a: FailureRow, b: FailureRow): number =>
        a.currency.localeCompare(b.currency) ||
        METHODS.indexOf(a.method) - METHODS.indexOf(b.method) ||
        STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) ||
        b.payonce + b.outside - (a.payonce + a.outside) ||
        a.code.localeCompare(b.code),
    ),
    outsidePayoutsFailed,
    notOnFile,
    unreadable,
  };
}

// ---------- 3. incidents ----------

// How a closed invoice ended. Sent to a person means a reason is on file, which
// every path that hands an invoice to a person writes.
function closeHow(obligation: MetricsObligation, attempts: MetricsAttempt[]): CloseHow {
  if (obligation.state === "rejected") {
    return "not-paid";
  }
  if (obligation.escalationReason !== "") {
    return "person-paid";
  }
  return attempts.some((attempt: MetricsAttempt): boolean => attempt.kind === "replacement") ? "replaced" : "first-time";
}

// The first time an original of the invoice was recorded failed, null when none
// failed, and "" when one failed but no time is on file for it.
function firstFailure(attempts: MetricsAttempt[]): string | null {
  const failed: MetricsAttempt[] = attempts.filter(
    (attempt: MetricsAttempt): boolean =>
      attempt.kind === "original" && (attempt.state === "failed" || attempt.failedAt !== null),
  );
  if (failed.length === 0) {
    return null;
  }
  const times: number[] = failed
    .map((attempt: MetricsAttempt): number => msOf(attempt.failedAt))
    .filter((ms: number): boolean => !Number.isNaN(ms));
  return times.length === 0 ? "" : (isoOf(Math.min(...times)) ?? "");
}

function incidentsOf(read: MetricsRead, index: Indexed, window: Window): IncidentsTable {
  const started: IncidentsTable["started"] = { single: 0, payRun: 0, found: 0, notOnFile: 0 };
  const closed: Map<string, ClosedRow> = new Map();
  const toClose: Map<CloseGroup, Durations> = new Map(CLOSE_GROUPS.map((group: CloseGroup) => [group, new Durations()]));
  const afterFailure: Map<CloseGroup, Durations> = new Map(
    CLOSE_GROUPS.map((group: CloseGroup) => [group, new Durations()]),
  );
  const withPerson: Durations = new Durations();
  const reasons: Map<ReasonCode, ReasonRow> = new Map();
  let notOnFile: number = 0;
  let unreadable: number = 0;
  for (const obligation of read.obligations) {
    const begun: Where = where(obligation.startedAt, window);
    if (begun === "unknown") {
      started.notOnFile += 1;
    } else if (begun === "in") {
      if (obligation.origin === "outside") {
        started.found += 1;
      } else if (obligation.fromRun) {
        started.payRun += 1;
      } else {
        started.single += 1;
      }
    }
    if (obligation.state !== "settled" && obligation.state !== "rejected") {
      continue;
    }
    const ended: Where = where(obligation.closedAt, window);
    if (ended === "out") {
      continue;
    }
    if (ended === "unknown") {
      notOnFile += 1;
      continue;
    }
    const attempts: MetricsAttempt[] = index.attempts.get(obligation.invoiceId) ?? [];
    const how: CloseHow = closeHow(obligation, attempts);
    const group: CloseGroup = GROUP_OF[how];
    if (CURRENCY.test(obligation.currency)) {
      const row: ClosedRow = rowFor(closed, `${obligation.currency}|${how}`, () => ({
        currency: obligation.currency,
        how,
        count: 0,
        amountMinor: 0,
        fromPayRuns: 0,
        found: 0,
      }));
      row.count += 1;
      row.amountMinor += obligation.amountMinor;
      row.fromPayRuns += obligation.fromRun ? 1 : 0;
      row.found += obligation.origin === "outside" ? 1 : 0;
    } else {
      unreadable += 1;
    }
    toClose.get(group)?.add(seconds(obligation.startedAt, obligation.closedAt));
    const failure: string | null = firstFailure(attempts);
    if (failure !== null) {
      afterFailure.get(group)?.add(seconds(failure === "" ? null : failure, obligation.closedAt));
    }
    if (group === "with-a-person") {
      withPerson.add(seconds(obligation.escalatedAt, obligation.closedAt));
      const code: ReasonCode = reasonCode(obligation.escalationReason);
      const reason: ReasonRow = rowFor(reasons, code, () => ({ code, label: REASON_LABELS[code], paid: 0, notPaid: 0 }));
      if (how === "person-paid") {
        reason.paid += 1;
      } else {
        reason.notPaid += 1;
      }
    }
  }
  const spreads = (durations: Map<CloseGroup, Durations>): GroupSpread[] =>
    CLOSE_GROUPS.map((group: CloseGroup): GroupSpread => ({
      group,
      ...(durations.get(group) ?? new Durations()).spread(),
    }));
  return {
    started,
    closed: [...closed.values()].sort(
      (a: ClosedRow, b: ClosedRow): number =>
        a.currency.localeCompare(b.currency) || CLOSE_HOWS.indexOf(a.how) - CLOSE_HOWS.indexOf(b.how),
    ),
    timeToClose: spreads(toClose),
    afterFailure: spreads(afterFailure),
    withPerson: withPerson.spread(),
    reasons: REASON_ORDER.map((code: ReasonCode): ReasonRow | undefined => reasons.get(code)).filter(
      (row: ReasonRow | undefined): row is ReasonRow => row !== undefined,
    ),
    notOnFile,
    unreadable,
  };
}

// ---------- 4. approvals ----------

// A request reaches its signoffs at the time of its needed-th signoff. One
// approved or used with fewer signoffs on file was approved before signoffs were
// kept: it was given, at a time not on file.
function reached(request: MetricsRequest): { given: boolean; at: string | null } {
  const needed: number = Math.max(1, request.needed);
  if (request.signoffs.length >= needed) {
    return { given: true, at: request.signoffs[needed - 1] ?? null };
  }
  return { given: request.state === "approved" || request.state === "used", at: null };
}

function approvalsOf(of: "invoice" | "run", requests: MetricsRequest[], window: Window): ApprovalRow {
  const row: ApprovalRow = {
    of,
    given: 0,
    twoApprovers: 0,
    spent: 0,
    voided: 0,
    waiting: 0,
    wait: new Durations().spread(),
    notOnFile: 0,
  };
  const wait: Durations = new Durations();
  // A request renews every APPROVAL_TTL_MINUTES, so one wait is an episode: from
  // the first request after the last one given to the next one given.
  for (const owned of grouped(requests, (request: MetricsRequest): string => request.owner).values()) {
    let first: MetricsRequest | null = null;
    for (const request of owned) {
      first ??= request;
      const given: { given: boolean; at: string | null } = reached(request);
      if (!given.given) {
        continue;
      }
      const episodeStart: string | null = first.requestedAt;
      first = null;
      const at: Where = where(given.at, window);
      if (at === "out") {
        continue;
      }
      if (at === "unknown") {
        row.notOnFile += 1;
        continue;
      }
      row.given += 1;
      row.twoApprovers += request.needed >= 2 ? 1 : 0;
      row.spent += request.state === "used" ? 1 : 0;
      row.voided += request.state === "void" ? 1 : 0;
      row.waiting += request.state === "approved" ? 1 : 0;
      wait.add(seconds(episodeStart, given.at));
    }
  }
  return { ...row, wait: wait.spread() };
}

// ---------- 5. fees lost ----------

function feesOf(read: MetricsRead, index: Indexed, window: Window): FeesTable {
  const rows: Map<string, FeeRow> = new Map();
  let notOnFile: number = 0;
  let unreadable: number = 0;
  const add = (currency: string, feeMinor: number | null, outside: boolean): void => {
    if (!CURRENCY.test(currency)) {
      unreadable += 1;
      return;
    }
    const row: FeeRow = rowFor(rows, currency, () => ({
      currency,
      transfers: 0,
      feeMinor: 0,
      notRead: 0,
      payonce: 0,
      outside: 0,
    }));
    row.transfers += 1;
    if (feeMinor === null) {
      row.notRead += 1;
    } else {
      row.feeMinor += feeMinor;
    }
    if (outside) {
      row.outside += 1;
    } else {
      row.payonce += 1;
    }
  };
  for (const attempt of read.attempts) {
    const obligation: MetricsObligation | undefined = index.obligations.get(attempt.invoiceId);
    if (obligation === undefined || !attemptLostFee(attempt)) {
      continue;
    }
    const at: Where = where(attempt.bankCreatedAt, window);
    if (at === "unknown") {
      notOnFile += 1;
    } else if (at === "in") {
      add(attempt.feeCurrency ?? obligation.wallet, attempt.feeMinor, sentOutside(obligation, attempt));
    }
  }
  for (const payout of read.payouts) {
    const obligation: MetricsObligation | undefined = index.obligations.get(payout.invoiceId);
    if (obligation === undefined || !payoutLostFee(payout)) {
      continue;
    }
    const at: Where = where(payout.foundAt, window);
    if (at === "unknown") {
      notOnFile += 1;
    } else if (at === "in") {
      add(payout.feeCurrency ?? obligation.wallet, payout.feeMinor, true);
    }
  }
  return { rows: byCurrency(rows.values()), notOnFile, unreadable };
}

// ---------- 6. duplicates held ----------

function duplicatesOf(read: MetricsRead, window: Window): DuplicatesTable {
  const rows: Map<string, DuplicateRow> = new Map();
  let notOnFile: number = 0;
  let unreadable: number = 0;
  for (const obligation of read.obligations) {
    if (!obligation.heldDuplicate) {
      continue;
    }
    const at: Where = where(obligation.startedAt, window);
    if (at === "out") {
      continue;
    }
    if (at === "unknown") {
      notOnFile += 1;
      continue;
    }
    if (!CURRENCY.test(obligation.currency)) {
      unreadable += 1;
      continue;
    }
    const row: DuplicateRow = rowFor(rows, obligation.currency, () => ({
      currency: obligation.currency,
      held: 0,
      stopped: 0,
      stoppedMinor: 0,
      paid: 0,
      stillHeld: 0,
    }));
    row.held += 1;
    if (obligation.state === "rejected") {
      row.stopped += 1;
      row.stoppedMinor += obligation.amountMinor;
    } else if (obligation.state === "settled") {
      row.paid += 1;
    } else {
      row.stillHeld += 1;
    }
  }
  return { rows: byCurrency(rows.values()), notOnFile, unreadable };
}

// ---------- 7. outages ----------

function outageCodes(stored: string): OutageCode[] {
  let codes: unknown;
  try {
    codes = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(codes)) {
    return [];
  }
  const known: string[] = [
    ...new Set<string>(
      codes.filter(
        (code: unknown): code is string => typeof code === "string" && Object.hasOwn(RAIL_FAILURE_CODES, code),
      ),
    ),
  ].sort();
  return known.map((code: string): OutageCode => ({ code, label: RAIL_FAILURE_CODES[code] ?? NO_WORDS_LABEL }));
}

// An outage counts while it overlaps the period: declared by its end and not
// ended before its start.
function outagesOf(read: MetricsRead, window: Window, now: number): OutagesTable {
  const rows: OutageRow[] = [];
  let notOnFile: number = 0;
  let unreadable: number = 0;
  for (const outage of read.outages) {
    const declared: number = msOf(outage.declaredAt);
    const ended: number | null = outage.endedAt === null ? null : msOf(outage.endedAt);
    if (window.from !== null) {
      if (Number.isNaN(declared) || (ended !== null && Number.isNaN(ended))) {
        notOnFile += 1;
        continue;
      }
      if (declared > window.to || (ended !== null && ended < window.from)) {
        continue;
      }
    }
    if (!CURRENCY.test(outage.currency)) {
      unreadable += 1;
      continue;
    }
    rows.push(outageRow(outage, declared, ended, now));
  }
  const rails: Map<string, RailRow> = new Map();
  for (const row of rows) {
    const rail: RailRow = rowFor(rails, `${row.currency}|${row.method}`, () => ({
      currency: row.currency,
      method: row.method,
      outages: 0,
      totalSeconds: 0,
      longestSeconds: null,
    }));
    rail.outages += 1;
    rail.totalSeconds += row.seconds ?? 0;
    if (row.seconds !== null) {
      rail.longestSeconds = Math.max(rail.longestSeconds ?? 0, row.seconds);
    }
  }
  return {
    rows,
    byRail: [...rails.values()].sort(
      (a: RailRow, b: RailRow): number =>
        a.currency.localeCompare(b.currency) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method),
    ),
    notOnFile,
    unreadable,
  };
}

function outageRow(outage: MetricsOutage, declared: number, ended: number | null, now: number): OutageRow {
  const active: boolean = outage.state === "active";
  const held = (what: string): number => (Object.hasOwn(outage.held, what) ? (outage.held[what] ?? 0) : 0);
  return {
    id: outage.id,
    currency: outage.currency,
    method: methodOf(outage.method),
    declaredAt: isoOf(declared),
    endedAt: ended === null ? null : isoOf(ended),
    seconds: active ? secondsBetween(declared, now) : ended === null ? null : secondsBetween(declared, ended),
    active,
    payees: Number.isSafeInteger(outage.payees) ? outage.payees : 0,
    codes: outageCodes(outage.codes),
    held: {
      original: held("original"),
      replacement: held("replacement"),
      approved: held("approved"),
      run: held("run"),
    },
  };
}

// ---------- 8. reconciliation breaks ----------

function reconOf(breaks: BreakTimes[] | null, window: Window): ReconTable {
  const resolve: Durations = new Durations();
  if (breaks === null) {
    return { ran: false, rows: [], resolve: resolve.spread(), notOnFile: 0 };
  }
  const rows: Map<ReconKind, ReconRow> = new Map();
  let notOnFile: number = 0;
  for (const found of breaks) {
    const at: Where = where(found.openedAt, window);
    if (at === "out") {
      continue;
    }
    if (at === "unknown") {
      notOnFile += 1;
      continue;
    }
    const kind: ReconKind = (BREAK_KINDS as readonly string[]).includes(found.kind)
      ? (found.kind as BreakKind)
      : "other";
    const row: ReconRow = rowFor(rows, kind, () => ({
      kind,
      label: kind === "other" ? OTHER_KIND_LABEL : KIND_LABELS[kind],
      byItself: kind !== "other" && clearsByItself(kind),
      found: 0,
      explained: 0,
      cleared: 0,
      open: 0,
    }));
    row.found += 1;
    if (found.state === "explained") {
      row.explained += 1;
      resolve.add(seconds(found.openedAt, found.explainedAt));
    } else if (found.state === "cleared") {
      row.cleared += 1;
      resolve.add(seconds(found.openedAt, found.clearedAt));
    } else {
      row.open += 1;
    }
  }
  return {
    ran: true,
    rows: [...BREAK_KINDS, "other" as const]
      .map((kind: ReconKind): ReconRow | undefined => rows.get(kind))
      .filter((row: ReconRow | undefined): row is ReconRow => row !== undefined),
    resolve: resolve.spread(),
    notOnFile,
  };
}

// ---------- the report ----------

export function metricsOf(
  read: MetricsRead,
  breaks: BreakTimes[] | null,
  period: Period,
  now: number,
): MetricsReport {
  const startedAt: string | null = isoOf(msOf(read.startedAt));
  const window: Window =
    period === "all" ? { from: null, to: now } : { from: now - PERIOD_DAYS[period] * DAY_MS, to: now };
  const index: Indexed = {
    obligations: new Map(
      read.obligations.map((obligation: MetricsObligation): [string, MetricsObligation] => [
        obligation.invoiceId,
        obligation,
      ]),
    ),
    attempts: grouped(read.attempts, (attempt: MetricsAttempt): string => attempt.invoiceId),
    payouts: grouped(read.payouts, (payout: MetricsPayout): string => payout.invoiceId),
  };
  const openNow: number = [...read.requests, ...read.runRequests].filter(
    (request: MetricsRequest): boolean => request.state === "requested" && expiryOf(request) > now,
  ).length;
  const nowIso: string = new Date(now).toISOString();
  return {
    period,
    from: window.from === null ? startedAt : new Date(window.from).toISOString(),
    to: nowIso,
    builtAt: nowIso,
    ledgerStartedAt: startedAt,
    payments: paymentsOf(read, index, window),
    failures: failuresOf(read, index, window),
    incidents: incidentsOf(read, index, window),
    approvals: {
      rows: [approvalsOf("invoice", read.requests, window), approvalsOf("run", read.runRequests, window)],
      openNow,
    },
    fees: feesOf(read, index, window),
    duplicates: duplicatesOf(read, window),
    outages: outagesOf(read, window, now),
    recon: reconOf(breaks, window),
  };
}

// The report for one period, read in one snapshot. Ledger only: no Airwallex, no
// balance and no setting.
export function metricsReport(ledger: Ledger, period: Period, now: number): MetricsReport {
  const { read, breaks } = ledger.readSnapshot(() => ({
    read: ledger.metricsRead(),
    breaks: ledger.recon().hasTables() ? ledger.recon().breakTimes() : null,
  }));
  return metricsOf(read, breaks, period, now);
}

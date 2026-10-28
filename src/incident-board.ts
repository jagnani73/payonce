import type { ApprovalTerms } from "./approval.js";
import {
  cashLines,
  FIRM_KINDS,
  payRunLines,
  WAITING_KINDS,
  waitingRunLines,
  type CashKind,
  type CashLine,
} from "./cash-position.js";
import { CHANGED_BANK_DETAILS_REASON, NEW_BANK_DETAILS_REASON, ORIGINAL_DEADLINE_REASON } from "./decide.js";
import { deadlineMinutes } from "./deadlines.js";
import { heldBeforePaying, pendingClose, REPLACEMENT_DEADLINE_REASON } from "./engine.js";
import { candidatesFor, invoiceIndex, type InvoiceIndex, type Match } from "./intake.js";
import {
  isExpired,
  type Approval,
  type Attempt,
  type Ledger,
  type LedgerEvent,
  type Obligation,
  type ObligationState,
  type OutsidePayout,
  type Run,
  type RunApproval,
  type RunRow,
  type Upload,
} from "./ledger.js";
import { debitCurrency } from "./reserve.js";
import { runStatus, type RunStatus } from "./runs.js";

// The incident board: every invoice that is not closed, and every pay row of the
// run waiting for approval, ranked by how soon a person should look at it, then
// by the money that could still leave a wallet for it, then by age. It reads the
// ledger only. Its money is the cash panel's lines, never a figure of its own,
// and its reasons are fixed text, never an email's or an escalation reason.

export type BoardGroup = "person" | "deadline" | "bank" | "open";
export const BOARD_GROUPS: BoardGroup[] = ["person", "deadline", "bank", "open"];
export const GROUP_LABELS: Record<BoardGroup, string> = {
  person: "Waiting on a person",
  deadline: "Bank deadline passed",
  bank: "With the bank",
  open: "Everything else open",
};

export type BoardOrigin = "payonce" | "outside" | "pay-run";
export const BOARD_ORIGINS: BoardOrigin[] = ["payonce", "outside", "pay-run"];
export const ORIGIN_LABELS: Record<BoardOrigin, string> = {
  payonce: "PayOnce",
  outside: "Sent outside PayOnce",
  "pay-run": "Pay run",
};

export const CURRENCY_PATTERN: RegExp = /^[A-Z]{3}$/;

// Money that can still leave a wallet. A fee kept on a failed transfer has left.
const AT_RISK: ReadonlySet<CashKind> = new Set<CashKind>([...FIRM_KINDS, ...WAITING_KINDS, "with-bank", "outside"]);
const WITH_BANK: ReadonlySet<CashKind> = new Set<CashKind>(["with-bank", "outside"]);
const DEADLINE_REASONS: readonly string[] = [ORIGINAL_DEADLINE_REASON, REPLACEMENT_DEADLINE_REASON];
const BANK_DETAILS_REASONS: readonly string[] = [NEW_BANK_DETAILS_REASON, CHANGED_BANK_DETAILS_REASON];
const MS_PER_MINUTE: number = 60_000;

export type BoardReason =
  | "approve-replacement"
  | "approve-held"
  | "approved"
  | "request-expired"
  | "held"
  | "callback"
  | "with-person"
  | "run-waiting-approval"
  | "run-approved"
  | "run-expired"
  | "run-needs-check"
  | "inbox"
  | "deadline-original"
  | "deadline-replacement"
  | "deadline-outside"
  | "bank-original"
  | "bank-replacement"
  | "bank-outside"
  | "run-turn"
  | "sending"
  | "close"
  | "escalated"
  | "open";

// What an entry has at risk in one currency: the sum of its cash lines there,
// amount and fee, as the cash panel adds them.
export interface BoardMoney {
  currency: string;
  minor: number;
  // Some of it is estimated, as the cash panel marks it.
  estimated: boolean;
  // Lines whose fee is not known, and so is not in minor.
  feeUnknown: number;
}

export interface BoardEntry {
  // An invoice in the ledger, or a pay row of the run waiting for approval,
  // which has no invoice yet.
  kind: "invoice" | "run-row";
  invoiceId: string;
  supplier: string;
  amountMinor: number;
  currency: string;
  // The wallet the money leaves.
  wallet: string;
  origin: BoardOrigin;
  // Null for a run row.
  state: ObligationState | null;
  runId: number | null;
  group: BoardGroup;
  reason: BoardReason;
  // Why it is in its group, in PayOnce's fixed words.
  why: string;
  // Anything else a person should know, in the same words.
  also: string[];
  atRisk: BoardMoney[];
  // The largest amount in atRisk, which the board ranks by.
  rankMinor: number;
  // When the bank should have paid or failed the payment with it. Null when
  // nothing is with the bank or no creation time is on file.
  deadlineAt: string | null;
  // When PayOnce took the invoice on (its first timeline line), or when the run
  // was uploaded. Null when neither is on file.
  waitingSince: string | null;
}

export interface BoardTotal {
  currency: string;
  minor: number;
  // Being sent, approved, and approved pay runs: what the cash panel's headroom
  // takes off.
  promisedMinor: number;
  // Invoices waiting on a person: the cash panel's "Waiting on a person".
  waitingMinor: number;
  // Rows of a pay run waiting for approval, which the cash panel does not count.
  runWaitingMinor: number;
  // With the bank and payouts sent outside PayOnce.
  withBankMinor: number;
  entries: number;
  estimated: boolean;
  feeUnknown: number;
}

export interface BoardFilters {
  group: BoardGroup | null;
  currency: string | null;
  origin: BoardOrigin | null;
}

export interface BoardGroupOf {
  group: BoardGroup;
  label: string;
}

export interface BoardGroupCount {
  group: BoardGroup;
  label: string;
  // Entries in the group that pass the currency and origin filters.
  count: number;
}

export interface BoardReport {
  generatedAt: string;
  filters: BoardFilters;
  groups: BoardGroupCount[];
  origins: { origin: BoardOrigin; label: string }[];
  // Every currency money on the board leaves from, for the currency filter.
  currencies: string[];
  // Per currency, over the entries shown.
  totals: BoardTotal[];
  // Ranked: by group, then the most money first, then the oldest first.
  entries: BoardEntry[];
  // How many entries the board holds before any filter.
  all: number;
  // How many invoices the ledger holds, closed ones included.
  invoices: number;
}

interface Ranked {
  entry: BoardEntry;
  lines: CashLine[];
}

interface Board {
  ranked: Ranked[];
  invoices: number;
}

interface Situation {
  group: BoardGroup;
  reason: BoardReason;
  why: string;
}

export function isBoardGroup(value: unknown): value is BoardGroup {
  return typeof value === "string" && (BOARD_GROUPS as string[]).includes(value);
}

export function isBoardOrigin(value: unknown): value is BoardOrigin {
  return typeof value === "string" && (BOARD_ORIGINS as string[]).includes(value);
}

function situation(group: BoardGroup, reason: BoardReason, why: string): Situation {
  return { group, reason, why };
}

function progress(approval: { signoffs: unknown[]; needed: number }): string {
  return `${approval.signoffs.length} of ${approval.needed} ${approval.needed === 1 ? "approval" : "approvals"}`;
}

// Waiting uploads that name an invoice. offered: those the inbox offers it to
// first, because it is the one invoice they name, not only among other digits,
// and it is open or escalated. named: those that name it any weaker way, beside
// other invoices, only nearly or among other digits.
interface InboxNames {
  offered: number;
  named: number;
}

const NO_NAMES: InboxNames = { offered: 0, named: 0 };

function offeredText(count: number): string {
  return count === 1
    ? "An email waiting in the inbox names only this invoice"
    : `${count} emails waiting in the inbox name only this invoice`;
}

function namedText(count: number): string {
  return count === 1
    ? "An email waiting in the inbox may be about this invoice"
    : `${count} emails waiting in the inbox may be about this invoice`;
}

function deadlineText(obligation: Obligation, attempt: Attempt): Situation {
  if (obligation.origin === "outside" && attempt.kind === "original") {
    return situation("deadline", "deadline-outside", "The bank has not paid or failed the payout sent outside PayOnce by its deadline");
  }
  return attempt.kind === "replacement"
    ? situation("deadline", "deadline-replacement", "The bank has not paid or failed the replacement by its deadline")
    : situation("deadline", "deadline-original", "The bank has not paid or failed the original by its deadline");
}

function withBankText(obligation: Obligation, attempt: Attempt): Situation {
  if (obligation.origin === "outside" && attempt.kind === "original") {
    return situation("bank", "bank-outside", "The payout sent outside PayOnce is with the bank");
  }
  return attempt.kind === "replacement"
    ? situation("bank", "bank-replacement", "The replacement is with the bank")
    : situation("bank", "bank-original", "The original is with the bank");
}

function isLive(attempt: Attempt): boolean {
  return attempt.transferId !== null && (attempt.state === "pending" || attempt.state === "in_flight");
}

// When the bank should have paid or failed the payment, counted from the creation
// time Airwallex gave, as the watcher counts it. NaN when none is on file.
function deadlineOf(obligation: Obligation, attempt: Attempt): number {
  const created: number = attempt.bankCreatedAt === null ? Number.NaN : Date.parse(attempt.bankCreatedAt);
  return created + deadlineMinutes(obligation.transferMethod) * MS_PER_MINUTE;
}

// Past its deadline by its creation time, or, with none on file, when the
// invoice went to a person for a deadline, as the outbox's trace request counts it.
function pastDeadline(obligation: Obligation, attempt: Attempt, now: number): boolean {
  const deadline: number = deadlineOf(obligation, attempt);
  if (Number.isNaN(deadline)) {
    return DEADLINE_REASONS.some((reason: string): boolean => obligation.escalationReason.startsWith(reason));
  }
  return now >= deadline;
}

function aboutBankDetails(obligation: Obligation): boolean {
  return BANK_DETAILS_REASONS.some((reason: string): boolean => obligation.escalationReason.startsWith(reason));
}

// The person-facing step an invoice with money at risk waits on, or null.
function personSituation(
  ledger: Ledger,
  obligation: Obligation,
  kinds: ReadonlySet<CashKind>,
  inbox: InboxNames,
  now: number,
): Situation | null {
  const latest: Approval | undefined = ledger.latestApproval(obligation.invoiceId);
  if (kinds.has("awaiting-approval") && latest !== undefined) {
    const terms: ApprovalTerms = JSON.parse(latest.terms) as ApprovalTerms;
    return terms.action === "pay"
      ? situation("person", "approve-held", `Paying this held invoice waits for approval (${progress(latest)})`)
      : situation("person", "approve-replacement", `A replacement waits for approval (${progress(latest)})`);
  }
  if (kinds.has("awaiting-person")) {
    if (latest !== undefined && (latest.state === "requested" || latest.state === "approved") && isExpired(latest, now)) {
      return situation("person", "request-expired", "The approval request expired, and PayOnce opens a new one on its next look");
    }
    if (heldBeforePaying(ledger, obligation)) {
      return situation("person", "held", "Held before paying, with no approval request open");
    }
    if (aboutBankDetails(obligation) && obligation.supplierPhone !== null) {
      return situation("person", "callback", "Waiting for a callback to the supplier about new bank details");
    }
    return situation("person", "with-person", "Its payments failed, and no approval request is open");
  }
  if (inbox.offered > 0 && kinds.size > 0) {
    return situation("person", "inbox", offeredText(inbox.offered));
  }
  return null;
}

// Nothing waits on a person or is with the bank.
function otherSituation(
  ledger: Ledger,
  obligation: Obligation,
  lines: CashLine[],
): Situation {
  const run: CashLine | undefined = lines.find((line: CashLine): boolean => line.kind === "pay-run");
  if (run !== undefined) {
    return situation("open", "run-turn", `Released with pay run ${run.runId ?? ""}, and waits for its turn to be sent`);
  }
  if (lines.some((line: CashLine): boolean => line.kind === "sending")) {
    return situation("open", "sending", "PayOnce is sending a payment and has no transfer for it yet");
  }
  // The look spends an approved request, as the watcher releases an approved run,
  // so the next step is PayOnce's.
  if (lines.some((line: CashLine): boolean => line.kind === "approved")) {
    return situation("open", "approved", "The payment is approved, and PayOnce sends it on its next look");
  }
  if (obligation.state === "escalated") {
    return pendingClose(ledger, obligation.invoiceId) === undefined
      ? situation("open", "escalated", "Waiting on a person, with nothing left to pay")
      : situation("open", "close", "Paid once, and waits for a person to close it");
  }
  return situation("open", "open", "Open, with no payment being sent, approved or with the bank");
}

function originOf(obligation: Obligation): BoardOrigin {
  return obligation.runRowId !== null ? "pay-run" : obligation.origin;
}

function moneyOf(lines: CashLine[]): BoardMoney[] {
  const byCurrency: Map<string, BoardMoney> = new Map<string, BoardMoney>();
  for (const line of lines) {
    const money: BoardMoney = byCurrency.get(line.currency) ?? {
      currency: line.currency,
      minor: 0,
      estimated: false,
      feeUnknown: 0,
    };
    money.minor += line.amountMinor + line.feeMinor;
    money.estimated = money.estimated || line.estimated;
    money.feeUnknown += line.feeKnown ? 0 : 1;
    byCurrency.set(line.currency, money);
  }
  return [...byCurrency.values()].sort((a: BoardMoney, b: BoardMoney): number => a.currency.localeCompare(b.currency));
}

function rankOf(money: BoardMoney[]): number {
  return money.reduce((most: number, entry: BoardMoney): number => Math.max(most, entry.minor), 0);
}

function iso(at: number): string | null {
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function invoiceEntry(
  ledger: Ledger,
  obligation: Obligation,
  lines: CashLine[],
  inbox: InboxNames,
  now: number,
): Ranked {
  const invoiceId: string = obligation.invoiceId;
  const kinds: ReadonlySet<CashKind> = new Set<CashKind>(lines.map((line: CashLine): CashKind => line.kind));
  const live: Attempt[] = ledger.attempts(invoiceId).filter(isLive);
  const overdue: Attempt | undefined = [...live]
    .reverse()
    .find((attempt: Attempt): boolean => pastDeadline(obligation, attempt, now));
  const latest: Attempt | undefined = live.at(-1);
  const outside: boolean = ledger
    .outsidePayouts(invoiceId)
    .some((payout: OutsidePayout): boolean => payout.state === "in_flight" || payout.state === "unknown");

  const also: string[] = [];
  const person: Situation | null = personSituation(ledger, obligation, kinds, inbox, now);
  let found: Situation;
  if (person !== null) {
    found = person;
    if (overdue !== undefined) {
      also.push(deadlineText(obligation, overdue).why);
    }
  } else if (overdue !== undefined) {
    found = deadlineText(obligation, overdue);
  } else if (latest !== undefined) {
    found = withBankText(obligation, latest);
  } else if (outside) {
    found = situation("bank", "bank-outside", "A payout sent outside PayOnce is with the bank");
  } else {
    found = otherSituation(ledger, obligation, lines);
  }
  if (inbox.offered > 0 && found.reason !== "inbox") {
    also.push(offeredText(inbox.offered));
  }
  if (inbox.named > 0) {
    also.push(namedText(inbox.named));
  }
  const atRisk: BoardMoney[] = moneyOf(lines);
  const first: LedgerEvent | undefined = ledger.firstEvent(invoiceId);
  const timed: Attempt | undefined = overdue ?? latest;
  return {
    lines,
    entry: {
      kind: "invoice",
      invoiceId,
      supplier: obligation.supplier,
      amountMinor: obligation.amountMinor,
      currency: obligation.currency,
      wallet: debitCurrency(obligation),
      origin: originOf(obligation),
      state: obligation.state,
      runId: ledger.runRowOf(invoiceId)?.runId ?? null,
      ...found,
      also,
      atRisk,
      rankMinor: rankOf(atRisk),
      deadlineAt: timed === undefined ? null : iso(deadlineOf(obligation, timed)),
      waitingSince: first?.at ?? null,
    },
  };
}

function runSituation(run: Run, status: RunStatus, approval: RunApproval | undefined): Situation {
  if (status === "waiting-approval" && approval !== undefined) {
    return situation("person", "run-waiting-approval", `Pay run ${run.id} waits for approval (${progress(approval)})`);
  }
  // The server's watcher releases an approved run, so the next step is PayOnce's.
  if (status === "approved") {
    return situation("open", "run-approved", `Pay run ${run.id} is approved, and PayOnce releases it on its next check`);
  }
  if (status === "expired") {
    return situation("person", "run-expired", `The approval request for pay run ${run.id} expired. Check the run again`);
  }
  return situation("person", "run-needs-check", `Pay run ${run.id} waits for a person to check it again`);
}

function runRowEntry(run: Run, found: Situation, row: RunRow, lines: CashLine[]): Ranked {
  const atRisk: BoardMoney[] = moneyOf(lines);
  return {
    lines,
    entry: {
      kind: "run-row",
      invoiceId: row.invoiceId ?? "",
      supplier: row.payee ?? row.supplier ?? "",
      amountMinor: row.amountMinor ?? 0,
      currency: row.currency ?? "",
      wallet: row.currency ?? "",
      origin: "pay-run",
      state: null,
      runId: run.id,
      ...found,
      also: [],
      atRisk,
      rankMinor: rankOf(atRisk),
      deadlineAt: null,
      waitingSince: run.uploadedAt,
    },
  };
}

function add(map: Map<string, CashLine[]>, key: string, line: CashLine): void {
  const list: CashLine[] = map.get(key) ?? [];
  list.push(line);
  map.set(key, list);
}

// How many waiting uploads name each invoice, split as the inbox's match card
// offers them. The invoices are indexed once for every upload.
function inboxNames(ledger: Ledger): Map<string, InboxNames> {
  const names: Map<string, InboxNames> = new Map<string, InboxNames>();
  const waiting: Upload[] = ledger.uploads(0).filter((upload: Upload): boolean => upload.state === "waiting");
  if (waiting.length === 0) {
    return names;
  }
  const index: InvoiceIndex = invoiceIndex(ledger);
  for (const upload of waiting) {
    const match: Match = candidatesFor(ledger, upload, index);
    for (const candidate of match.candidates) {
      const id: string = candidate.invoiceId;
      const counted: InboxNames = names.get(id) ?? { ...NO_NAMES };
      if (match.suggested === id) {
        counted.offered += 1;
      } else {
        counted.named += 1;
      }
      names.set(id, counted);
    }
  }
  return names;
}

const GROUP_ORDER: Record<BoardGroup, number> = { person: 0, deadline: 1, bank: 2, open: 3 };

function sinceOf(entry: BoardEntry): number {
  const at: number = entry.waitingSince === null ? Number.NaN : Date.parse(entry.waitingSince);
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

// By group, then the most money first, then the oldest first. Amounts in
// different currencies are compared as numbers, because PayOnce has no exchange
// rate to compare them with.
function compare(a: Ranked, b: Ranked): number {
  return (
    GROUP_ORDER[a.entry.group] - GROUP_ORDER[b.entry.group] ||
    b.entry.rankMinor - a.entry.rankMinor ||
    sinceOf(a.entry) - sinceOf(b.entry) ||
    a.entry.invoiceId.localeCompare(b.entry.invoiceId)
  );
}

// Every entry on the board, ranked, and how many invoices the ledger holds.
function rankedBoard(ledger: Ledger, now: number): Board {
  const run: Run | undefined = ledger.waitingRun();
  const byInvoice: Map<string, CashLine[]> = new Map<string, CashLine[]>();
  const byRow: Map<string, CashLine[]> = new Map<string, CashLine[]>();
  for (const line of cashLines(ledger, now, { openOnly: true })) {
    if (AT_RISK.has(line.kind)) {
      add(byInvoice, line.invoiceId, line);
    }
  }
  // The waiting run has released nothing, so its lines are its rows'. Any other
  // run's line is a released row's invoice.
  for (const line of [...payRunLines(ledger, now), ...waitingRunLines(ledger, now)]) {
    add(run !== undefined && line.runId === run.id ? byRow : byInvoice, line.invoiceId, line);
  }

  const inbox: Map<string, InboxNames> = inboxNames(ledger);
  const obligations: Obligation[] = ledger.obligations();
  const ranked: Ranked[] = [];
  for (const obligation of obligations) {
    if (obligation.state === "settled" || obligation.state === "rejected") {
      continue;
    }
    const id: string = obligation.invoiceId;
    ranked.push(invoiceEntry(ledger, obligation, byInvoice.get(id) ?? [], inbox.get(id) ?? NO_NAMES, now));
  }
  if (run !== undefined) {
    const found: Situation = runSituation(run, runStatus(ledger, run), ledger.latestRunApproval(run.id));
    for (const row of ledger.runRows(run.id)) {
      if (row.action === "pay" && row.state === "waiting" && row.invoiceId !== null) {
        ranked.push(runRowEntry(run, found, row, byRow.get(row.invoiceId) ?? []));
      }
    }
  }
  return { ranked: ranked.sort(compare), invoices: obligations.length };
}

function blankTotal(currency: string): BoardTotal {
  return {
    currency,
    minor: 0,
    promisedMinor: 0,
    waitingMinor: 0,
    runWaitingMinor: 0,
    withBankMinor: 0,
    entries: 0,
    estimated: false,
    feeUnknown: 0,
  };
}

// Each line once, in the bucket the cash panel shows it in. With a currency
// filter, only that currency.
function totalsOf(ranked: Ranked[], currency: string | null): BoardTotal[] {
  const totals: Map<string, BoardTotal> = new Map<string, BoardTotal>();
  for (const { lines } of ranked) {
    const counted: Set<string> = new Set<string>();
    for (const line of lines) {
      if (currency !== null && line.currency !== currency) {
        continue;
      }
      const total: BoardTotal = totals.get(line.currency) ?? blankTotal(line.currency);
      const minor: number = line.amountMinor + line.feeMinor;
      total.minor += minor;
      if (FIRM_KINDS.has(line.kind)) {
        total.promisedMinor += minor;
      } else if (WITH_BANK.has(line.kind)) {
        total.withBankMinor += minor;
      } else if (line.runId === null) {
        total.waitingMinor += minor;
      } else {
        total.runWaitingMinor += minor;
      }
      total.estimated = total.estimated || line.estimated;
      total.feeUnknown += line.feeKnown ? 0 : 1;
      if (!counted.has(line.currency)) {
        counted.add(line.currency);
        total.entries += 1;
      }
      totals.set(line.currency, total);
    }
  }
  return [...totals.values()].sort((a: BoardTotal, b: BoardTotal): number => a.currency.localeCompare(b.currency));
}

function inCurrency(entry: BoardEntry, currency: string): boolean {
  return entry.wallet === currency || entry.atRisk.some((money: BoardMoney): boolean => money.currency === currency);
}

// The group each invoice on the board is in, with its label, for the incident
// list. Closed invoices and run rows are not in it.
export function boardGroups(ledger: Ledger, now: number = Date.now()): Map<string, BoardGroupOf> {
  const groups: Map<string, BoardGroupOf> = new Map<string, BoardGroupOf>();
  for (const { entry } of rankedBoard(ledger, now).ranked) {
    if (entry.kind === "invoice") {
      groups.set(entry.invoiceId, { group: entry.group, label: GROUP_LABELS[entry.group] });
    }
  }
  return groups;
}

// The board as the page and pnpm board show it, with the filters applied.
export function boardReport(
  ledger: Ledger,
  filters: BoardFilters,
  now: number = Date.now(),
): BoardReport {
  const { ranked, invoices }: Board = rankedBoard(ledger, now);
  const others: Ranked[] = ranked.filter(
    (item: Ranked): boolean =>
      (filters.currency === null || inCurrency(item.entry, filters.currency)) &&
      (filters.origin === null || item.entry.origin === filters.origin),
  );
  const shown: Ranked[] = others.filter(
    (item: Ranked): boolean => filters.group === null || item.entry.group === filters.group,
  );
  const currencies: Set<string> = new Set<string>();
  for (const item of ranked) {
    currencies.add(item.entry.wallet);
    for (const money of item.entry.atRisk) {
      currencies.add(money.currency);
    }
  }
  currencies.delete("");
  return {
    generatedAt: new Date(now).toISOString(),
    filters,
    groups: BOARD_GROUPS.map(
      (group: BoardGroup): BoardGroupCount => ({
        group,
        label: GROUP_LABELS[group],
        count: others.filter((item: Ranked): boolean => item.entry.group === group).length,
      }),
    ),
    origins: BOARD_ORIGINS.map((origin: BoardOrigin) => ({ origin, label: ORIGIN_LABELS[origin] })),
    currencies: [...currencies].sort((a: string, b: string): number => a.localeCompare(b)),
    totals: totalsOf(shown, filters.currency),
    entries: shown.map((item: Ranked): BoardEntry => item.entry),
    all: ranked.length,
    invoices,
  };
}

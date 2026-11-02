import { createHash } from "node:crypto";
import { getBalances, type Balance } from "./airwallex/balances.js";
import { AirwallexError, type AirwallexClient } from "./airwallex/client.js";
import { HISTORY_WINDOW_MS, listBalanceHistory, type HistoryItem } from "./airwallex/history.js";
import { getTransfer, listTransfersSince, type Transfer } from "./airwallex/transfers.js";
import { knownName, personName } from "./approvers.js";
import { debitOf, failedStatus, feeOf, type Debit, type Fee } from "./assess.js";
import { reconChainProblem, reconChainReport, type ReconChainReport } from "./audit-trail.js";
import { cleanLine } from "./eml.js";
import type { Ledger } from "./ledger.js";
import { readMinor } from "./money.js";
import {
  breakText,
  clearsByItself,
  KIND_ACTIONS,
  KIND_LABELS,
  match,
  shownCurrency,
  shownInvoice,
  shownReference,
  typeName,
  waitingText,
  type BalancePair,
  type BreakKind,
  type MatchResult,
  type Movement,
  type MovementLabel,
  type ReconTransfer,
  type WaitingItem,
  type WalletSummary,
} from "./recon-match.js";
import type {
  BreakChanges,
  CommitResult,
  CommitRules,
  ExplainItem,
  RanFrom,
  ReconBreak,
  ReconMode,
  ReconRun,
  ReconSnapshot,
  ReconStore,
  ReconWrite,
  WindowRead,
} from "./recon-store.js";

// One reconciliation run: Airwallex's balance history and transfers, read with
// GETs only, matched against each other and against PayOnce's ledger, and the
// breaks a person needs to see recorded in reconciliation's own chain. It never
// moves money and never changes an invoice, an approval or a timeline.

const MS_PER_MINUTE: number = 60_000;
// The last window ends this far after now, so a movement Airwallex dates a
// little ahead of this machine's clock is still read.
const AHEAD_MS: number = 10 * MS_PER_MINUTE;
// Every window since the ledger started is read again once this long after the
// last run that did.
const FULL_READ_EVERY_MS: number = 24 * 60 * MS_PER_MINUTE;
// Transfers movements name that the listing did not have, read by id per run.
const LOOKUPS_PER_RUN: number = 5;
const DEFAULT_EVERY_MINUTES: number = 10;
const MAX_EVERY_MINUTES: number = 1440;
const FIRST_RUN_AFTER_MS: number = MS_PER_MINUTE;
// The page's "Check now" starts at most one run a minute.
const CHECK_NOW_GAP_MS: number = MS_PER_MINUTE;
const MAX_ERROR_TEXT: number = 300;
const MAX_NOTE: number = 200;
export const MAX_EXPLAINED_AT_ONCE: number = 200;
const EXPLAINED_SHOWN: number = 50;
export const MOVEMENTS_SHOWN: number = 500;
// A full recheck of the chain at most once a minute, as the alert loop's audit.
const AUDIT_EVERY_MS: number = 60_000;

const ID: RegExp = /^[A-Za-z0-9_-]{1,80}$/;
const CODE: RegExp = /^[A-Z_]{1,40}$/;
const CURRENCY: RegExp = /^[A-Z]{3}$/;
const REFERENCE: RegExp = /^[A-Z0-9-]{1,30}$/;
const STATUS: RegExp = /^[A-Z_]{1,30}$/;
const METHOD: RegExp = /^[A-Z_]{1,20}$/;
// Airwallex's times: 2026-10-29T04:48:14+0800, 2026-10-28T20:48:14.662+00:00
// or ...Z. Anything else cannot be read, rather than guessed at.
const AIRWALLEX_TIME: RegExp =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):?(\d{2}))$/;

// UTC milliseconds, read with the offset Airwallex gives. NaN for anything else.
export function airwallexTime(value: unknown): number {
  if (typeof value !== "string") {
    return Number.NaN;
  }
  const parts: RegExpExecArray | null = AIRWALLEX_TIME.exec(value);
  if (parts === null) {
    return Number.NaN;
  }
  const [, year, month, day, hour, minute, second, fraction, zone, sign, zoneHours, zoneMinutes] = parts;
  const local: number = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number((fraction ?? "0").padEnd(3, "0").slice(0, 3)),
  );
  if (Number(month) > 12 || Number(day) > 31 || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    return Number.NaN;
  }
  if (zone === "Z") {
    return local;
  }
  const offset: number = (Number(zoneHours) * 60 + Number(zoneMinutes)) * MS_PER_MINUTE;
  return sign === "+" ? local - offset : local + offset;
}

// ---------- settings ----------

export interface ReconSetting {
  // Null when the server never runs it by itself.
  everyMs: number | null;
  problem: string | null;
}

export function reconSettingFromEnv(env: NodeJS.ProcessEnv = process.env): ReconSetting {
  const raw: string | undefined = env["RECON_EVERY_MINUTES"];
  if (raw === undefined || raw.trim() === "") {
    return { everyMs: DEFAULT_EVERY_MINUTES * MS_PER_MINUTE, problem: null };
  }
  const minutes: number = Number(raw.trim());
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_EVERY_MINUTES) {
    return {
      everyMs: DEFAULT_EVERY_MINUTES * MS_PER_MINUTE,
      problem: `RECON_EVERY_MINUTES takes a whole number from 0 to ${MAX_EVERY_MINUTES}, so it is every ${DEFAULT_EVERY_MINUTES} minutes`,
    };
  }
  return { everyMs: minutes === 0 ? null : minutes * MS_PER_MINUTE, problem: null };
}

export function describeReconSetting(setting: ReconSetting): string {
  const when: string =
    setting.everyMs === null
      ? "Reconciliation runs only when asked (RECON_EVERY_MINUTES=0): Check now on the page, or pnpm reconcile"
      : `Reconciliation reads Airwallex's balance history (GETs only) a minute after start, then every ${setting.everyMs / MS_PER_MINUTE} ${setting.everyMs === MS_PER_MINUTE ? "minute" : "minutes"}`;
  return setting.problem === null ? when : `${when}. ${setting.problem}`;
}

// ---------- reading Airwallex ----------

export interface ReconRead {
  write: ReconWrite;
  balances: Map<string, BalancePair>;
}

function floorSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

function ceilSecond(ms: number): number {
  return Math.ceil(ms / 1000) * 1000;
}

// The windows a run reads. A full read covers every window since the ledger
// started. Any other read covers the last seven days, which also picks up a
// movement posted late within the week. Ends are whole seconds, so a movement
// Airwallex dates to the second is in exactly one window.
export function windowsFor(startedMs: number, now: number, full: boolean): { fromMs: number; toMs: number }[] {
  const end: number = ceilSecond(now) + AHEAD_MS;
  const start: number = floorSecond(startedMs);
  if (!full) {
    return [{ fromMs: Math.max(start, end - HISTORY_WINDOW_MS), toMs: end }];
  }
  const windows: { fromMs: number; toMs: number }[] = [];
  for (let from: number = start; from < end; from += HISTORY_WINDOW_MS) {
    windows.push({ fromMs: from, toMs: Math.min(from + HISTORY_WINDOW_MS, end) });
  }
  return windows;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "", "utf8").digest("hex");
}

// A history row as the store keeps it. A row PayOnce cannot read is kept as
// unreadable, under an id of its own when Airwallex's cannot be used, and dated to
// the start of its window when its time cannot be read, so the window's next
// read replaces it.
export function movementOf(item: HistoryItem, seq: number, window: { fromMs: number }): Movement {
  const idOk: boolean = typeof item.id === "string" && ID.test(item.id);
  const currency: string = typeof item.currency === "string" && CURRENCY.test(item.currency) ? item.currency : "";
  const posted: number = airwallexTime(item.posted_at);
  const whole: boolean = idOk && currency !== "" && Number.isFinite(posted);
  return {
    id: idOk ? (item.id as string) : `x${hashOf(item).slice(0, 40)}`,
    currency,
    amountMinor: whole ? readMinor(item.amount) : null,
    balanceMinor: whole ? readMinor(item.balance) : null,
    postedMs: Number.isFinite(posted) ? posted : window.fromMs,
    seq,
    sourceId: typeof item.source === "string" && ID.test(item.source) ? item.source : null,
    sourceType: typeof item.source_type === "string" && CODE.test(item.source_type) ? item.source_type : null,
    transactionType:
      typeof item.transaction_type === "string" && CODE.test(item.transaction_type) ? item.transaction_type : null,
  };
}

function checked(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function timeOrNull(value: unknown): number | null {
  const at: number = airwallexTime(value);
  return Number.isFinite(at) ? at : null;
}

// A transfer as the store keeps it, every field checked. Null for one whose id
// cannot be used.
export function reconTransferOf(transfer: Transfer, now: number): ReconTransfer | null {
  if (typeof transfer.id !== "string" || !ID.test(transfer.id)) {
    return null;
  }
  const status: string | null = checked(transfer.status, STATUS);
  const debit: Debit | null = debitOf(transfer);
  const fee: Fee | null = feeOf(transfer);
  const debitCurrency: string | null = debit === null ? null : checked(debit.currency, CURRENCY);
  const feeCurrency: string | null = fee === null ? null : checked(fee.currency, CURRENCY);
  return {
    transferId: transfer.id,
    found: true,
    reference: checked(transfer.short_reference_id, REFERENCE),
    status,
    method: checked(transfer.transfer_method, METHOD),
    createdMs: timeOrNull(transfer.created_at),
    updatedMs: timeOrNull(transfer.updated_at),
    debitMinor: debitCurrency === null ? null : (debit?.minor ?? null),
    debitCurrency,
    transferMinor: readMinor(transfer.transfer_amount),
    transferCurrency: checked(transfer.transfer_currency, CURRENCY),
    feeMinor: feeCurrency === null ? null : (fee?.minor ?? null),
    feeCurrency,
    failedSeenMs: status !== null && failedStatus(status) ? now : null,
  };
}

function missingTransfer(transferId: string): ReconTransfer {
  return {
    transferId,
    found: false,
    reference: null,
    status: null,
    method: null,
    createdMs: null,
    updatedMs: null,
    debitMinor: null,
    debitCurrency: null,
    transferMinor: null,
    transferCurrency: null,
    feeMinor: null,
    feeCurrency: null,
    failedSeenMs: null,
  };
}

function availableOf(balances: Balance[]): Map<string, number | null> {
  return new Map(balances.map((balance: Balance): [string, number | null] => [balance.currency, balance.availableMinor]));
}

// Reads, in this order: the balances, the history of every window, the balances
// again, then the transfers since the ledger started, then by id the few
// transfers movements name that the listing did not have. A movement whose
// transfer has not been read is waiting, never a break. Any failed read stops the
// run.
export async function readAirwallex(
  client: AirwallexClient,
  store: ReconStore,
  startedAt: string,
  full: boolean,
  now: number,
  reads: { count: number },
): Promise<ReconRead> {
  const before: Map<string, number | null> = availableOf(await getBalances(client));
  reads.count += 1;
  const windows: WindowRead[] = [];
  for (const window of windowsFor(Date.parse(startedAt), now, full)) {
    const items: HistoryItem[] = await listBalanceHistory(client, window.fromMs, window.toMs, reads);
    windows.push({
      ...window,
      movements: items
        .filter((item: HistoryItem): boolean => item.account_type === undefined || item.account_type === "cash")
        .map((item: HistoryItem, seq: number): Movement => movementOf(item, seq, window)),
    });
  }
  const after: Map<string, number | null> = availableOf(await getBalances(client));
  reads.count += 1;
  const balances: Map<string, BalancePair> = new Map();
  for (const currency of new Set([...before.keys(), ...after.keys()])) {
    balances.set(currency, { before: before.get(currency) ?? null, after: after.get(currency) ?? null });
  }

  const listed: Transfer[] = await listTransfersSince(client, startedAt, reads);
  const transfers: ReconTransfer[] = [];
  for (const transfer of listed) {
    const item: ReconTransfer | null = reconTransferOf(transfer, now);
    if (item !== null) {
      transfers.push(item);
    }
  }
  const known: Set<string> = new Set([
    ...store.knownTransferIds(),
    ...transfers.map((item: ReconTransfer): string => item.transferId),
  ]);
  const unread: string[] = [];
  const named: Movement[] = [
    ...windows.flatMap((window: WindowRead): Movement[] => window.movements),
    ...store.unreadSources(),
  ];
  for (const movement of named) {
    const source: string | null = movement.sourceId;
    const payout: boolean =
      ["PAYOUT", "BATCH_PAYOUT", "FEE"].includes(movement.sourceType ?? "") ||
      ["PAYOUT", "PAYOUT_FAILURE", "PAYOUT_REVERSAL", "FEE"].includes(movement.transactionType ?? "");
    if (source !== null && payout && !known.has(source) && !unread.includes(source)) {
      unread.push(source);
    }
  }
  for (const transferId of unread.slice(0, LOOKUPS_PER_RUN)) {
    try {
      const transfer: Transfer = await getTransfer(client, transferId);
      reads.count += 1;
      const item: ReconTransfer | null = transfer.id === transferId ? reconTransferOf(transfer, now) : null;
      transfers.push(item ?? missingTransfer(transferId));
    } catch (error: unknown) {
      reads.count += 1;
      // Airwallex has no transfer by that id, so the movement is something else.
      if (error instanceof AirwallexError && error.status === 404) {
        transfers.push(missingTransfer(transferId));
        continue;
      }
      throw error;
    }
  }
  return { write: { windows, transfers, fullRead: full, reads: reads.count }, balances };
}

// ---------- one run ----------

export interface RunSummary {
  wallets: WalletSummary[];
  waiting: WaitingItem[];
  movements: number;
  transfers: number;
  unread: number;
}

function decideWith(
  now: number,
  balances: Map<string, BalancePair> | null,
): (snapshot: ReconSnapshot) => { result: MatchResult; summary: string } {
  return (snapshot: ReconSnapshot) => {
    const result: MatchResult = match({
      now,
      startedMs: snapshot.startedMs,
      movements: snapshot.movements,
      transfers: snapshot.transfers,
      ledger: snapshot.ledger,
      balances,
      prior: snapshot.prior,
    });
    const summary: RunSummary = {
      wallets: result.wallets,
      waiting: result.waiting,
      movements: snapshot.movements.length,
      transfers: snapshot.transfers.filter((transfer: ReconTransfer): boolean => transfer.found).length,
      unread: result.unread.length,
    };
    return { result, summary: JSON.stringify(summary) };
  };
}

function rules(now: number, balances: Map<string, BalancePair> | null): CommitRules {
  return { decide: decideWith(now, balances), byItself: clearsByItself, describe: breakText };
}

export type RunOutcome =
  | { outcome: "committed"; run: ReconRun; changes: BreakChanges; result: MatchResult }
  | { outcome: "stale"; run: ReconRun }
  | { outcome: "failed"; run: ReconRun; error: string };

function errorText(error: unknown): string {
  return cleanLine(error instanceof Error ? error.message : String(error), MAX_ERROR_TEXT);
}

export function beginRun(ledger: Ledger, ranFrom: RanFrom, mode: ReconMode, now: number = Date.now()): ReconRun {
  return ledger.recon().beginRun(ranFrom, mode, now);
}

export function fullReadDue(ledger: Ledger, now: number): boolean {
  const at: number | null = ledger.recon().fullReadAt();
  return at === null || now - at >= FULL_READ_EVERY_MS;
}

// Records what a run read, unless a run that started later has already been
// recorded.
export function commitRun(ledger: Ledger, run: ReconRun, read: ReconRead | null, now: number = Date.now()): RunOutcome {
  const committed: CommitResult = ledger.recon().commit(run.id, read?.write ?? null, now, rules(now, read?.balances ?? null));
  if (committed.stale) {
    return { outcome: "stale", run };
  }
  return { outcome: "committed", run, changes: committed.changes, result: committed.result };
}

// One live run, from the reads to the record.
export async function reconcileOnce(
  client: AirwallexClient,
  ledger: Ledger,
  ranFrom: RanFrom,
  now: () => number = Date.now,
): Promise<RunOutcome> {
  const run: ReconRun = beginRun(ledger, ranFrom, "live", now());
  const reads: { count: number } = { count: 0 };
  let read: ReconRead;
  try {
    read = await readAirwallex(client, ledger.recon(), ledger.startedAt(), fullReadDue(ledger, now()), now(), reads);
  } catch (error: unknown) {
    const text: string = errorText(error);
    ledger.recon().failRun(run.id, text, reads.count, now());
    return { outcome: "failed", run, error: text };
  }
  return commitRun(ledger, run, read, now());
}

// Matches what the ledger already holds again, with no Airwallex call. The
// closing balance is not checked, since no balance is read.
export function reconcileOffline(ledger: Ledger, ranFrom: RanFrom, now: number = Date.now()): RunOutcome {
  const run: ReconRun = beginRun(ledger, ranFrom, "offline", now);
  return commitRun(ledger, run, null, now);
}

// The server's runs: one a minute after start, then on the setting's interval,
// and "Check now", never two at once in this process and at most one a minute.
export class ReconRunner {
  private readonly client: AirwallexClient;
  private readonly ledger: Ledger;
  readonly everyMs: number | null;
  private busy: boolean = false;
  private lastStart: number = Number.NEGATIVE_INFINITY;

  constructor(client: AirwallexClient, ledger: Ledger, everyMs: number | null) {
    this.client = client;
    this.ledger = ledger;
    this.everyMs = everyMs;
  }

  running(): boolean {
    return this.busy;
  }

  start(): void {
    const every: number | null = this.everyMs;
    if (every === null) {
      return;
    }
    setTimeout((): void => {
      void this.tick();
      setInterval((): void => {
        void this.tick();
      }, every);
    }, FIRST_RUN_AFTER_MS);
  }

  private async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    await this.runOnce();
  }

  // "running" while one runs here, "soon" within a minute of the last start.
  checkNow(now: number = Date.now()): "started" | "running" | "soon" {
    if (this.busy) {
      return "running";
    }
    if (now - this.lastStart < CHECK_NOW_GAP_MS) {
      return "soon";
    }
    void this.runOnce();
    return "started";
  }

  private async runOnce(): Promise<void> {
    this.busy = true;
    this.lastStart = Date.now();
    try {
      await reconcileOnce(this.client, this.ledger, "server");
    } catch {
      // The run's own row says why. A ledger that cannot be written is the same
      // for every step, and the next run tries again.
    } finally {
      this.busy = false;
    }
  }
}

// ---------- what a person sees ----------

export interface RunView {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  ranFrom: RanFrom;
  mode: ReconMode;
  fullRead: boolean;
  reads: number;
  outcome: string | null;
  error: string | null;
}

export interface BreakView {
  id: number;
  kind: BreakKind;
  label: string;
  text: string;
  action: string;
  clearsByItself: boolean;
  currency: string | null;
  invoiceId: string | null;
  reference: string | null;
  fingerprint: string;
  state: string;
  foundAt: string;
  openedAt: string | null;
  goneAt: string | null;
  explainedBy: string | null;
  explainedAt: string | null;
  note: string | null;
}

export interface WaitingView {
  text: string;
  currency: string | null;
  dueAt: string | null;
}

export interface KindCount {
  kind: BreakKind;
  label: string;
  count: number;
}

export interface ReconReport {
  built: true;
  startedAt: string;
  everyMinutes: number | null;
  running: boolean;
  lastRun: RunView | null;
  // The latest run, when it failed or found a newer run already recorded.
  lastProblem: RunView | null;
  wallets: WalletSummary[];
  open: BreakView[];
  byKind: KindCount[];
  pending: number;
  waiting: WaitingView[];
  explained: BreakView[];
  audit: { lines: number; problem: string | null };
}

function runView(run: ReconRun): RunView {
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ranFrom: run.ranFrom,
    mode: run.mode,
    fullRead: run.fullRead,
    reads: run.reads,
    outcome: run.outcome,
    error: run.error,
  };
}

function referenceOf(item: ReconBreak): string | null {
  try {
    return shownReference((JSON.parse(item.facts) as { reference?: unknown }).reference);
  } catch {
    return null;
  }
}

export function breakView(item: ReconBreak): BreakView {
  return {
    id: item.id,
    kind: item.kind,
    label: KIND_LABELS[item.kind] ?? "Break",
    text: breakText(item.kind, item.facts),
    action: KIND_ACTIONS[item.kind] ?? "",
    clearsByItself: clearsByItself(item.kind),
    currency: shownCurrency(item.currency),
    invoiceId: shownInvoice(item.invoiceId),
    reference: referenceOf(item),
    fingerprint: item.fingerprint,
    state: item.state,
    foundAt: item.foundAt,
    openedAt: item.openedAt,
    goneAt: item.goneAt,
    explainedBy: knownName(item.explainedBy),
    explainedAt: item.explainedAt,
    note: item.note,
  };
}

function summaryOf(run: ReconRun | undefined): RunSummary | null {
  if (run?.summary === null || run?.summary === undefined) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(run.summary);
    return typeof parsed === "object" && parsed !== null ? (parsed as RunSummary) : null;
  } catch {
    return null;
  }
}

// The chain is checked in full at most once a minute, and again whenever a line
// was added or removed since.
let auditCache: { at: number; lines: number; last: number; result: { lines: number; problem: string | null } } | null =
  null;

export function reconAudit(store: ReconStore, now: number = Date.now()): { lines: number; problem: string | null } {
  const count: { lines: number; last: number } = store.lineCount();
  if (
    auditCache !== null &&
    now - auditCache.at < AUDIT_EVERY_MS &&
    auditCache.lines === count.lines &&
    auditCache.last === count.last
  ) {
    return auditCache.result;
  }
  const report: ReconChainReport = reconChainReport(store.auditSnapshot());
  const result: { lines: number; problem: string | null } = { lines: report.lines, problem: reconChainProblem(report) };
  auditCache = { at: now, lines: count.lines, last: count.last, result };
  return result;
}

export function kindCounts(open: ReconBreak[]): KindCount[] {
  const counts: Map<BreakKind, number> = new Map();
  for (const item of open) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]: [BreakKind, number]): KindCount => ({ kind, label: KIND_LABELS[kind], count }));
}

// The report from the ledger alone: the last run, each wallet, what waits on a
// person, what waits on time and what people explained.
export function reconReport(ledger: Ledger, runner: ReconRunner | null = null): ReconReport {
  const store: ReconStore = ledger.recon();
  const last: ReconRun | undefined = store.lastCommitted();
  const latest: ReconRun | undefined = store.runs(5).find((run: ReconRun): boolean => run.outcome !== null);
  const summary: RunSummary | null = summaryOf(last);
  const open: ReconBreak[] = store.breaks(["open"]);
  return {
    built: true,
    startedAt: ledger.startedAt(),
    everyMinutes: runner?.everyMs === null || runner === null ? null : runner.everyMs / MS_PER_MINUTE,
    running: runner?.running() ?? false,
    lastRun: last === undefined ? null : runView(last),
    lastProblem: latest !== undefined && latest.outcome !== "committed" && (last === undefined || latest.id > last.id) ? runView(latest) : null,
    wallets: summary?.wallets ?? [],
    open: open.map(breakView),
    byKind: kindCounts(open),
    pending: store.breaks(["pending"]).length,
    waiting: (summary?.waiting ?? []).map(
      (item: WaitingItem): WaitingView => ({ text: waitingText(item), currency: shownCurrency(item.currency), dueAt: item.dueAt }),
    ),
    explained: store.breaks(["explained"], EXPLAINED_SHOWN).map(breakView),
    audit: reconAudit(store),
  };
}

export interface MovementView {
  id: string;
  postedAt: string;
  typeText: string;
  amountMinor: number | null;
  balanceMinor: number | null;
  how: MovementLabel["how"];
  invoiceId: string | null;
  reference: string | null;
  breakId: number | null;
}

// One wallet's stored movements, newest first, with what explains each now. The
// matcher runs again on what the ledger holds, so no balance is read.
export function movementsView(ledger: Ledger, currency: string, now: number = Date.now()): MovementView[] {
  const store: ReconStore = ledger.recon();
  const snapshot: ReconSnapshot = store.snapshot();
  const result: MatchResult = match({
    now,
    startedMs: snapshot.startedMs,
    movements: snapshot.movements,
    transfers: snapshot.transfers,
    ledger: snapshot.ledger,
    balances: null,
    prior: snapshot.prior,
  });
  const open: ReconBreak[] = store.breaks(["open"]);
  const bySubject: Map<string, number> = new Map();
  for (const item of open) {
    bySubject.set(item.subject, item.id);
  }
  return store.movements(currency, MOVEMENTS_SHOWN).map((movement: Movement): MovementView => {
    const label: MovementLabel | undefined = result.labels.get(movement.id);
    return {
      id: movement.id,
      postedAt: new Date(movement.postedMs).toISOString(),
      typeText: typeName(movement.transactionType),
      amountMinor: movement.amountMinor,
      balanceMinor: movement.balanceMinor,
      how: label?.how ?? "unexplained",
      invoiceId: shownInvoice(label?.invoiceId ?? null),
      reference: shownReference(label?.reference ?? null),
      breakId: bySubject.get(movement.id) ?? (movement.sourceId === null ? undefined : bySubject.get(movement.sourceId)) ?? null,
    };
  });
}

// ---------- a person explains ----------

export class ExplainInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplainInputError";
  }
}

const FINGERPRINT: RegExp = /^[0-9a-f]{12,64}$/;

// The breaks a request names, each with the facts it was shown, checked as typed
// input. Throws ExplainInputError.
export function explainItems(raw: unknown): ExplainItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ExplainInputError("Pick the breaks to explain");
  }
  if (raw.length > MAX_EXPLAINED_AT_ONCE) {
    throw new ExplainInputError(`Explain at most ${MAX_EXPLAINED_AT_ONCE} breaks at once`);
  }
  const items: ExplainItem[] = [];
  for (const entry of raw) {
    const id: unknown = (entry as { id?: unknown } | null)?.id;
    const fingerprint: unknown = (entry as { fingerprint?: unknown } | null)?.fingerprint;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new ExplainInputError("Each break needs its number");
    }
    if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) {
      throw new ExplainInputError("Each break needs the facts it was shown with");
    }
    if (items.some((item: ExplainItem): boolean => item.id === id)) {
      throw new ExplainInputError(`Break ${id} is named twice`);
    }
    items.push({ id, fingerprint });
  }
  return items;
}

// The note as PayOnce records it: one cleaned line, 1 to 200 characters.
export function explainNote(typed: string): string {
  const note: string = cleanLine(typed, MAX_NOTE + 1);
  if (note === "") {
    throw new ExplainInputError("Say what these are");
  }
  if (note.length > MAX_NOTE) {
    throw new ExplainInputError(`A note is at most ${MAX_NOTE} characters`);
  }
  return note;
}

// Records a person's explanation of open breaks of one kind, bound to the facts
// they were shown. The name follows the rule every name follows. Throws NameError,
// ExplainInputError, ReconUnknownError, ReconChangedError or ReconKindsError.
export function explainBreaks(ledger: Ledger, items: ExplainItem[], typedName: string, typedNote: string): BreakView[] {
  const name: string = personName(typedName);
  const note: string = explainNote(typedNote);
  return ledger.recon().explain(items, name, note, Date.now()).map(breakView);
}

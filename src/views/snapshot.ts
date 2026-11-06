import type { ApprovalTerms, RunTerms } from "../domain/approval.js";
import { knownName, type ApprovalPolicy, type Barred } from "../domain/approvers.js";
import { knownRoute } from "../domain/assess.js";
import { barredFrom, type BarFacts } from "../domain/barred.js";
import { callbackBlocked } from "../domain/callback.js";
import { deadlineMinutes } from "../domain/deadlines.js";
import type {
  EmailsSnapshot,
  InvoiceSnapshot,
  LastCheck,
  OutageSnapshot,
  RequestSnapshot,
  RunSnapshot,
  RunTurn,
  SnapshotTimes,
} from "../domain/situation.js";
import { invoiceIndex, type InvoiceIndex } from "../intake/intake.js";
import { endRefusal, outageEnders } from "../outages/outages.js";
import { runBarred } from "../runs/runs.js";
import { inboxNames, runOutage, type InboxNames } from "./incident-board.js";
import {
  readingSoft,
  storedObject,
  type Approval,
  type Attempt,
  type Ledger,
  type LedgerEvent,
  type MetricsAttempt,
  type MetricsObligation,
  type MetricsPayout,
  type MetricsRead,
  type Obligation,
  type Outage,
  type OutageHold,
  type PayRunRow,
  type Run,
  type RunApproval,
  type RunRow,
} from "../store/ledger.js";
import { callbackFacts } from "../store/read/callback.js";

// Loads what situationOf and runSituationOf read, from the ledger alone, in one
// read transaction, reading stored JSON soft as every view does. Nothing here
// writes.

export interface SnapshotOptions {
  policy: ApprovalPolicy;
  askWhy: boolean;
  // The engine's last look at an invoice, where the process keeps one.
  lastCheck?: (invoiceId: string) => LastCheck | null;
  busy?: (invoiceId: string) => boolean;
}

// What the findings JSON holds, as the engine stores it.
interface StoredFindings {
  claimsNonReceipt?: boolean;
  asksForNewBankDetails?: boolean;
  asksNotToPay?: boolean;
  unread?: boolean;
  emailsRead?: number;
}

// What is read once for every invoice a call loads.
interface Shared {
  metrics: MetricsRead;
  obligations: Map<string, MetricsObligation>;
  attempts: Map<string, MetricsAttempt[]>;
  payouts: Map<string, MetricsPayout[]>;
  holds: Map<string, OutageHold[]>;
  queued: PayRunRow[];
  inbox: Map<string, InboxNames>;
}

function grouped<T extends { invoiceId: string }>(items: T[]): Map<string, T[]> {
  const map: Map<string, T[]> = new Map<string, T[]>();
  for (const item of items) {
    const list: T[] = map.get(item.invoiceId) ?? [];
    list.push(item);
    map.set(item.invoiceId, list);
  }
  return map;
}

function sharedOf(ledger: Ledger, now: number): Shared {
  const metrics: MetricsRead = ledger.metricsRead();
  const holds: OutageHold[] = ledger
    .outages()
    .flatMap((outage: Outage): OutageHold[] => ledger.outageHolds(outage.id))
    .filter((hold: OutageHold): boolean => hold.invoiceId !== null);
  return {
    metrics,
    obligations: new Map(metrics.obligations.map((row: MetricsObligation): [string, MetricsObligation] => [row.invoiceId, row])),
    attempts: grouped(metrics.attempts),
    payouts: grouped(metrics.payouts),
    holds: grouped(holds.map((hold: OutageHold): OutageHold & { invoiceId: string } => ({ ...hold, invoiceId: hold.invoiceId ?? "" }))),
    queued: ledger.payRunRows(now),
    inbox: inboxNames(ledger, (): InvoiceIndex => invoiceIndex(ledger)),
  };
}

function emailsOf(ledger: Ledger, invoiceId: string): EmailsSnapshot {
  const count: number = ledger.emailCount(invoiceId);
  const stored: string | undefined = ledger.findings(invoiceId);
  const findings: StoredFindings | null = stored === undefined ? null : storedObject<StoredFindings>(stored);
  return {
    count,
    unread:
      findings?.unread === true || (count > 0 && findings === null) || (findings?.emailsRead ?? count) < count,
    readerFailed: findings?.unread === true,
    asksForNewBankDetails: findings?.asksForNewBankDetails === true,
    asksNotToPay: findings?.asksNotToPay === true,
    claimsNonReceipt: findings?.claimsNonReceipt === true,
  };
}

// Who may not approve the latest request: as pendingApproval bars them while an
// escalated invoice waits for signoffs, else whoever started the payment.
function barredOf(ledger: Ledger, obligation: Obligation, latest: RequestSnapshot | undefined): Barred[] {
  const facts: BarFacts = {
    startedBy: obligation.startedBy,
    fromRun: obligation.runRowId !== null,
    callbacks: ledger.callbacksFor(obligation.beneficiaryId),
  };
  if (latest?.approval.state === "requested" && latest.terms !== null) {
    const accountKey: string = latest.terms.accountKey;
    return obligation.state === "escalated"
      ? barredFrom(facts, accountKey, knownRoute(ledger.accountRoutes().get(accountKey)))
      : [];
  }
  return barredFrom(facts, undefined, null);
}

function turnOf(ledger: Ledger, shared: Shared, obligation: Obligation): RunTurn | null {
  const queued: PayRunRow | undefined =
    obligation.runRowId === null
      ? undefined
      : shared.queued.find((row: PayRunRow): boolean => row.invoiceId === obligation.invoiceId);
  if (queued === undefined) {
    return null;
  }
  const waiting: ReadonlySet<string> = new Set<string>(
    shared.queued.filter((row: PayRunRow): boolean => row.runId === queued.runId).map((row: PayRunRow): string => row.invoiceId),
  );
  const lines: RunRow[] = ledger
    .runRows(queued.runId)
    .filter((row: RunRow): boolean => row.invoiceId !== null && waiting.has(row.invoiceId));
  const at: number = lines.findIndex((row: RunRow): boolean => row.invoiceId === obligation.invoiceId);
  return { runId: queued.runId, line: lines[at]?.line ?? 0, after: at > 0 ? (lines[at - 1]?.line ?? null) : null };
}

function outageOf(ledger: Ledger, policy: ApprovalPolicy, obligation: Obligation): OutageSnapshot | null {
  const outage: Outage | undefined = ledger.activeOutage(obligation.currency, obligation.transferMethod);
  return outage === undefined
    ? null
    : {
        outage,
        holds: ledger
          .outageHolds(outage.id)
          .filter((hold: OutageHold): boolean => hold.invoiceId === obligation.invoiceId),
        enders: outageEnders(policy),
        endRefusal: endRefusal(policy),
      };
}

// A time as the ledger keeps it, or null for one that is blank or unreadable.
function known(at: string | null | undefined): string | null {
  return at === null || at === undefined || !Number.isFinite(Date.parse(at)) ? null : at;
}

function timesOf(ledger: Ledger, shared: Shared, obligation: Obligation): SnapshotTimes {
  const invoiceId: string = obligation.invoiceId;
  const row: MetricsObligation | undefined = shared.obligations.get(invoiceId);
  const attempts: MetricsAttempt[] = shared.attempts.get(invoiceId) ?? [];
  const closedLine: LedgerEvent | undefined =
    obligation.state === "settled" || obligation.state === "rejected"
      ? ledger
          .events(invoiceId)
          .filter((event: LedgerEvent): boolean => event.kind === "closed")
          .at(-1)
      : undefined;
  return {
    firstEventAt: known(row?.startedAt),
    escalatedAt: known(row?.escalatedAt),
    closedAt: known(row?.closedAt),
    closedLine: closedLine?.message ?? null,
    failedAt: attempts.map((attempt: MetricsAttempt): string | null => known(attempt.failedAt)),
    paidAt: attempts.map((attempt: MetricsAttempt): string | null => known(attempt.paidAt)),
    foundAt: (shared.payouts.get(invoiceId) ?? []).map((payout: MetricsPayout): string | null => known(payout.foundAt)),
    holds: shared.holds.get(invoiceId) ?? [],
  };
}

function invoiceSnapshot(
  ledger: Ledger,
  shared: Shared,
  options: SnapshotOptions,
  obligation: Obligation,
  now: number,
): InvoiceSnapshot {
  const invoiceId: string = obligation.invoiceId;
  const attempts: Attempt[] = ledger.attempts(invoiceId);
  const requests: RequestSnapshot[] = ledger.approvalsFor(invoiceId).map(
    (approval: Approval): RequestSnapshot => ({ approval, terms: storedObject<ApprovalTerms>(approval.terms) }),
  );
  const row: RunRow | undefined = ledger.runRowOf(invoiceId);
  const run: Run | undefined = row === undefined ? undefined : ledger.run(row.runId);
  return {
    obligation,
    attempts,
    payouts: ledger.outsidePayouts(invoiceId),
    requests,
    reason: ledger.reasonOf(obligation),
    emails: emailsOf(ledger, invoiceId),
    outage: outageOf(ledger, options.policy, obligation),
    run: row === undefined || run === undefined ? null : { run, row },
    turn: turnOf(ledger, shared, obligation),
    inbox: shared.inbox.get(invoiceId) ?? { offered: 0, named: 0 },
    callbackBlocked: callbackBlocked(callbackFacts(ledger, obligation, now)),
    signing: {
      policy: options.policy,
      barred: barredOf(ledger, obligation, requests.at(-1)),
      startedKnown: knownName(obligation.startedBy) !== null,
    },
    deadlineMinutes: deadlineMinutes(obligation.transferMethod),
    nextCheckAt: checkAt(ledger.nextCheckAt(invoiceId)),
    lastCheck: options.lastCheck?.(invoiceId) ?? null,
    busy: options.busy?.(invoiceId) ?? false,
    times: timesOf(ledger, shared, obligation),
    askWhy: options.askWhy,
  };
}

function checkAt(at: string | null): number | null {
  const ms: number = at === null ? Number.NaN : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

function invoiceSnapshots(
  ledger: Ledger,
  shared: Shared,
  options: SnapshotOptions,
  invoiceIds: string[] | null,
  now: number,
): InvoiceSnapshot[] {
  const obligations: Obligation[] =
    invoiceIds === null
      ? ledger.obligations()
      : invoiceIds
          .map((invoiceId: string): Obligation | undefined => ledger.obligation(invoiceId))
          .filter((obligation: Obligation | undefined): obligation is Obligation => obligation !== undefined);
  return obligations.map((obligation: Obligation): InvoiceSnapshot => invoiceSnapshot(ledger, shared, options, obligation, now));
}

function read<T>(ledger: Ledger, fn: () => T): T {
  return ledger.readSnapshot((): T => readingSoft(fn));
}

export function readInvoiceSnapshot(
  ledger: Ledger,
  invoiceId: string,
  options: SnapshotOptions,
  now: number,
): InvoiceSnapshot | undefined {
  return readInvoiceSnapshots(ledger, options, now, [invoiceId])[0];
}

// Every invoice, or the ones named, in ledger order. What every invoice shares
// is read once.
export function readInvoiceSnapshots(
  ledger: Ledger,
  options: SnapshotOptions,
  now: number,
  invoiceIds: string[] | null = null,
): InvoiceSnapshot[] {
  return read(ledger, (): InvoiceSnapshot[] => invoiceSnapshots(ledger, sharedOf(ledger, now), options, invoiceIds, now));
}

function runSnapshot(ledger: Ledger, options: SnapshotOptions, shared: () => Shared, run: Run, now: number): RunSnapshot {
  const rows: RunRow[] = ledger.runRows(run.id);
  const requests: RunApproval[] = ledger.runApprovalsFor(run.id);
  const approval: RunApproval | undefined = requests.at(-1);
  const terms: RunTerms | null = approval === undefined ? null : storedObject<RunTerms>(approval.terms);
  // A waiting run is released whole, so an active outage on the rail of any of
  // its pay rows holds all of it.
  const outage: Outage | undefined = runOutage(
    ledger,
    rows.filter((row: RunRow): boolean => row.action === "pay" && row.state === "waiting" && row.invoiceId !== null),
  );
  const standing: LedgerEvent | undefined = ledger
    .runEvents(run.id)
    .filter((event: LedgerEvent): boolean => event.topic !== null)
    .at(-1);
  const released: string[] = rows
    .filter((row: RunRow): boolean => row.state === "released" && row.invoiceId !== null)
    .map((row: RunRow): string => row.invoiceId ?? "");
  return {
    run,
    rows,
    requests,
    request: approval === undefined ? null : { approval, terms, barred: terms === null ? [] : runBarred(ledger, terms) },
    outage: outage === undefined ? null : { outage, enders: outageEnders(options.policy) },
    policy: options.policy,
    standing: standing?.message ?? null,
    released: released.length === 0 ? [] : invoiceSnapshots(ledger, shared(), options, released, now),
  };
}

// The shared reads, made on first use.
function sharedOnce(ledger: Ledger, now: number): () => Shared {
  let shared: Shared | undefined;
  return (): Shared => (shared ??= sharedOf(ledger, now));
}

export function readRunSnapshot(
  ledger: Ledger,
  runId: number,
  options: SnapshotOptions,
  now: number,
): RunSnapshot | undefined {
  return read(ledger, (): RunSnapshot | undefined => {
    const run: Run | undefined = ledger.run(runId);
    return run === undefined ? undefined : runSnapshot(ledger, options, sharedOnce(ledger, now), run, now);
  });
}

// Every run, newest first.
export function readRunSnapshots(ledger: Ledger, options: SnapshotOptions, now: number): RunSnapshot[] {
  return read(ledger, (): RunSnapshot[] => {
    const shared: () => Shared = sharedOnce(ledger, now);
    return ledger.runs().map((run: Run): RunSnapshot => runSnapshot(ledger, options, shared, run, now));
  });
}

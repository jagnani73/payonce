import type { ApprovalTerms, RunTerms } from "../domain/approval.js";
import { knownName, type ApprovalPolicy, type Barred } from "../domain/approvers.js";
import { deadlineMinutes } from "../domain/deadlines.js";
import { liveAtBank, payoutNotFailed } from "../domain/live.js";
import { reasonOf } from "../domain/reasons.js";
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
import { pendingApproval } from "../engine/person.js";
import { candidatesFor, invoiceIndex, type InvoiceIndex, type Match } from "../intake/intake.js";
import { endRefusal, outageEnders } from "../outages/outages.js";
import { runBarred } from "../runs/runs.js";
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
  type ScannedObligation,
  type Upload,
} from "../store/ledger.js";

// Loads what situationOf and runSituationOf read, from the ledger alone, in one
// read transaction, reading stored JSON soft as every view does. Nothing here
// writes. Reads the Ledger has no method for are worked out here from its public
// reads: callbackBlocked and the inbox counts.

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
  inbox: Map<string, { offered: number; named: number }>;
  scanned: ScannedObligation[];
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

// How many waiting uploads name each invoice: offered when the inbox offers it
// first, named for any weaker match.
function inboxNames(ledger: Ledger): Map<string, { offered: number; named: number }> {
  const names: Map<string, { offered: number; named: number }> = new Map();
  const waiting: Upload[] = ledger.uploads(0).filter((upload: Upload): boolean => upload.state === "waiting");
  if (waiting.length === 0) {
    return names;
  }
  const index: InvoiceIndex = invoiceIndex(ledger);
  for (const upload of waiting) {
    const match: Match = candidatesFor(ledger, upload, index);
    for (const candidate of match.candidates) {
      const counted: { offered: number; named: number } = names.get(candidate.invoiceId) ?? { offered: 0, named: 0 };
      if (match.suggested === candidate.invoiceId) {
        counted.offered += 1;
      } else {
        counted.named += 1;
      }
      names.set(candidate.invoiceId, counted);
    }
  }
  return names;
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
    inbox: inboxNames(ledger),
    scanned: ledger.scannedObligations(),
  };
}

// Why a callback cannot be recorded for the invoice now, or null: the ledger-only
// checks of bank-change.ts blockedReason, which the engine does not export, in
// the same order and words.
function callbackBlocked(ledger: Ledger, shared: Shared, obligation: Obligation, attempts: Attempt[]): string | null {
  if (obligation.supplierPhone === null) {
    return "No phone number is on file for this supplier, so there is no number to call back";
  }
  if (obligation.state !== "escalated") {
    return obligation.state === "settled" ? "The incident is closed" : "The incident is not waiting on a person";
  }
  if (attempts.some(liveAtBank)) {
    return "A payment for this invoice is still with the bank or paid, so its bank details stay as they are";
  }
  const original: boolean = attempts.some(
    (attempt: Attempt): boolean => attempt.kind === "original" && attempt.transferId !== null,
  );
  if (!original && ledger.lastPaidTransfer(obligation.beneficiaryId) === undefined) {
    return ledger.lastPaidUnchecked(obligation.beneficiaryId) === undefined
      ? "PayOnce has not paid this supplier before, so there are no bank details to compare new ones with. Approve paying the account on file, or close the invoice without paying"
      : "PayOnce paid this supplier only before it kept which account each payment went to, so there are no checked bank details to compare new ones with. Approve paying the account on file, or close the invoice without paying";
  }
  if (ledger.outsidePayouts(obligation.invoiceId).some(payoutNotFailed)) {
    return "A payout for this invoice sent outside PayOnce may already pay it";
  }
  const starting: boolean =
    shared.scanned.some(
      (other: ScannedObligation): boolean =>
        other.invoiceId !== obligation.invoiceId &&
        other.beneficiaryId === obligation.beneficiaryId &&
        other.state !== "settled" &&
        other.state !== "rejected" &&
        (ledger.attempts(other.invoiceId).some((attempt: Attempt): boolean => attempt.state === "pending") ||
          ledger.latestApproval(other.invoiceId)?.state === "approved"),
    ) ||
    shared.queued.some(
      (row: PayRunRow): boolean => row.beneficiaryId === obligation.beneficiaryId && row.invoiceId !== obligation.invoiceId,
    );
  return starting
    ? "Another invoice to this supplier is about to be paid. Record the callback once it has gone to the bank"
    : null;
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

// Who may not approve the latest request: as pendingApproval bars them while it
// waits for signoffs, else whoever started the payment.
function barredOf(ledger: Ledger, obligation: Obligation, latest: RequestSnapshot | undefined): Barred[] {
  if (latest?.approval.state === "requested" && latest.terms !== null) {
    return pendingApproval(ledger, obligation.invoiceId)?.barred ?? [];
  }
  const starter: string | null = knownName(obligation.startedBy);
  return starter === null
    ? []
    : [{ name: starter, why: obligation.runRowId === null ? "started this incident" : "uploaded the pay run it came from" }];
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
    reason: reasonOf(obligation.escalationReason),
    emails: emailsOf(ledger, invoiceId),
    outage: outageOf(ledger, options.policy, obligation),
    run: row === undefined || run === undefined ? null : { run, row },
    turn: turnOf(ledger, shared, obligation),
    inbox: shared.inbox.get(invoiceId) ?? { offered: 0, named: 0 },
    callbackBlocked: callbackBlocked(ledger, shared, obligation, attempts),
    signing: {
      policy: options.policy,
      barred: barredOf(ledger, obligation, requests.at(-1)),
      startedKnown: knownName(obligation.startedBy) !== null,
    },
    deadlineMinutes: deadlineMinutes(obligation.transferMethod),
    // The ledger has no read of obligations.look_at yet.
    nextCheckAt: null,
    lastCheck: options.lastCheck?.(invoiceId) ?? null,
    busy: options.busy?.(invoiceId) ?? false,
    times: timesOf(ledger, shared, obligation),
    askWhy: options.askWhy,
  };
}

function invoiceSnapshots(
  ledger: Ledger,
  shared: Shared,
  options: SnapshotOptions,
  invoiceIds: string[] | null,
): InvoiceSnapshot[] {
  const obligations: Obligation[] =
    invoiceIds === null
      ? ledger.obligations()
      : invoiceIds
          .map((invoiceId: string): Obligation | undefined => ledger.obligation(invoiceId))
          .filter((obligation: Obligation | undefined): obligation is Obligation => obligation !== undefined);
  return obligations.map((obligation: Obligation): InvoiceSnapshot => invoiceSnapshot(ledger, shared, options, obligation));
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
  return read(ledger, (): InvoiceSnapshot[] => invoiceSnapshots(ledger, sharedOf(ledger, now), options, invoiceIds));
}

// The first active outage on a rail a pay row of the run pays on, as the release
// checks them.
function runOutage(ledger: Ledger, rows: RunRow[]): Outage | undefined {
  for (const row of rows) {
    if (row.action !== "pay" || row.state !== "waiting" || row.invoiceId === null) {
      continue;
    }
    const outage: Outage | undefined =
      row.currency === null || row.transferMethod === null ? undefined : ledger.activeOutage(row.currency, row.transferMethod);
    if (outage !== undefined) {
      return outage;
    }
  }
  return undefined;
}

function runSnapshot(ledger: Ledger, options: SnapshotOptions, shared: () => Shared, run: Run): RunSnapshot {
  const rows: RunRow[] = ledger.runRows(run.id);
  const approval: RunApproval | undefined = ledger.latestRunApproval(run.id);
  const terms: RunTerms | null = approval === undefined ? null : storedObject<RunTerms>(approval.terms);
  const outage: Outage | undefined = runOutage(ledger, rows);
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
    request: approval === undefined ? null : { approval, terms, barred: terms === null ? [] : runBarred(ledger, terms) },
    outage: outage === undefined ? null : { outage, enders: outageEnders(options.policy) },
    policy: options.policy,
    standing: standing?.message ?? null,
    released: released.length === 0 ? [] : invoiceSnapshots(ledger, shared(), options, released),
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
    return run === undefined ? undefined : runSnapshot(ledger, options, sharedOnce(ledger, now), run);
  });
}

// Every run, newest first.
export function readRunSnapshots(ledger: Ledger, options: SnapshotOptions, now: number): RunSnapshot[] {
  return read(ledger, (): RunSnapshot[] => {
    const shared: () => Shared = sharedOnce(ledger, now);
    return ledger.runs().map((run: Run): RunSnapshot => runSnapshot(ledger, options, shared, run));
  });
}

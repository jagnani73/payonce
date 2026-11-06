import { sameName } from "../domain/approvers.js";
import { railWords } from "../domain/patterns.js";
import { sendsText } from "../outages/outages.js";
import type { Settings } from "../settings.js";
import type { Attempt, Ledger, OutsidePayout, Run } from "../store/ledger.js";
import { debitCurrency } from "../domain/reserve.js";
import {
  incidentOf,
  runSituationOf,
  situationOf,
  type InvoiceSnapshot,
  type QueueGroup,
  type RunSituation,
  type RunSnapshot,
  type Situation,
} from "../domain/situation.js";
import { boardReport, type BoardEntry, type BoardOutage, type BoardReport, type BoardTotal } from "./incident-board.js";
import type { IncidentRow, IncidentScope, IncidentsQuery, IncidentsView, OutageStrip, WalletTotals } from "./contract.js";
import { snapshotOptions, type Live } from "./context.js";
import { money } from "./parts.js";
import { byRank, GROUP_LABELS, incidentRow, originOf } from "./rows.js";
import { readInvoiceSnapshots, readRunSnapshot } from "./snapshot.js";

// Every payment in the ledger as a ranked list, with the board's totals and the
// active outages. The board's ranking and money are reused, the groups are the
// situation's.

const SCOPES: IncidentScope[] = ["needs-you", "bank-late", "with-bank", "payonce", "closed", "all"];

export const DEFAULT_QUERY: IncidentsQuery = { scope: "all", currency: null, origin: null, me: null, clean: false, q: null };

export function isScope(value: string): value is IncidentScope {
  return (SCOPES as string[]).includes(value);
}

export function outageStrip(outage: BoardOutage): OutageStrip {
  return {
    id: outage.id,
    rail: railWords(outage.currency, outage.method),
    pausing: outage.originals.length + outage.approved.length + outage.runs.length,
    sendsText: `Ending it sends ${sendsText(outage.sends)}.`,
  };
}

export function walletTotals(total: BoardTotal): WalletTotals {
  const estimated: boolean = total.estimated || total.feeUnknown > 0;
  return {
    wallet: total.currency,
    promised: money(total.promisedMinor, total.currency, estimated),
    waitingOnPeople: money(total.waitingMinor, total.currency, estimated),
    pausedByOutage: money(total.outageMinor, total.currency, estimated),
    runWaiting: money(total.runWaitingMinor, total.currency, estimated),
    runsWaiting: total.runsWaiting,
    withBank: money(total.withBankMinor, total.currency, estimated),
    estimated,
    feeUnknown: total.feeUnknown,
  };
}

// The approvers who can sign the payment's request now include this name.
export function waitingFor(situation: Situation, me: string): boolean {
  return situation.waitingOn.who === "approvers" && situation.waitingOn.names.some((name: string): boolean => sameName(name, me));
}

function matches(texts: (string | null)[], q: string): boolean {
  const lower: string = q.toLowerCase();
  return texts.some((text: string | null): boolean => text !== null && text.toLowerCase().includes(lower));
}

function matchesText(snapshot: InvoiceSnapshot, q: string): boolean {
  return matches(
    [
      snapshot.obligation.invoiceId,
      snapshot.obligation.supplier,
      ...snapshot.attempts.flatMap((attempt: Attempt): (string | null)[] => [attempt.reference, attempt.mismatchedReference]),
      ...snapshot.payouts.map((payout: OutsidePayout): string => payout.reference),
    ],
    q,
  );
}

function inWallet(snapshot: InvoiceSnapshot, currency: string): boolean {
  return snapshot.obligation.currency === currency || snapshot.obligation.sourceCurrency === currency;
}

export function incidentsView(
  ledger: Ledger,
  settings: Settings,
  now: number,
  query: IncidentsQuery,
  live: Live | null = null,
): IncidentsView {
  const all: InvoiceSnapshot[] = readInvoiceSnapshots(ledger, snapshotOptions(settings, live), now);
  const listed: { snapshot: InvoiceSnapshot; situation: Situation }[] = all
    .filter(
      (snapshot: InvoiceSnapshot): boolean =>
        (query.currency === null || inWallet(snapshot, query.currency)) &&
        (query.origin === null || originOf(snapshot) === query.origin) &&
        (query.q === null || matchesText(snapshot, query.q)),
    )
    .map((snapshot: InvoiceSnapshot) => ({ snapshot, situation: situationOf(snapshot, now) }))
    .filter(
      ({ snapshot, situation }: { snapshot: InvoiceSnapshot; situation: Situation }): boolean =>
        (query.me === null || waitingFor(situation, query.me)) &&
        (situation.group !== "closed" || query.clean || incidentOf(snapshot) !== null),
    );
  const inScope = (group: QueueGroup): boolean => query.scope === "all" || group === query.scope;
  const shown: Set<string> = new Set<string>(
    listed
      .filter(({ situation }: { situation: Situation }): boolean => inScope(situation.group))
      .map(({ snapshot }: { snapshot: InvoiceSnapshot }): string => snapshot.obligation.invoiceId),
  );
  // The waiting pay run's rows have no invoice yet: they count while the run
  // passes the same filters.
  const waiting: Run | undefined = ledger.waitingRun();
  const run: RunSnapshot | undefined = waiting === undefined ? undefined : readRunSnapshot(ledger, waiting.id, snapshotOptions(settings, live), now);
  const runSituation: RunSituation | null = run === undefined ? null : runSituationOf(run, now);
  const runPasses = (entry: BoardEntry): boolean => {
    const situation: RunSituation | null = entry.runId === run?.run.id ? runSituation : null;
    return (
      situation !== null &&
      inScope(situation.group) &&
      (query.me === null ||
        (situation.waitingOn.who === "approvers" && situation.waitingOn.names.some((name: string): boolean => sameName(name, query.me ?? "")))) &&
      (query.q === null || matches([entry.invoiceId, entry.supplier], query.q))
    );
  };
  const board: BoardReport = boardReport(
    ledger,
    { group: null, currency: query.currency, origin: query.origin },
    settings.bankDeadlineMinutes,
    now,
    (entry: BoardEntry): boolean => (entry.kind === "invoice" ? shown.has(entry.invoiceId) : runPasses(entry)),
  );
  const entries: Map<string, BoardEntry> = new Map<string, BoardEntry>(
    board.entries
      .filter((entry: BoardEntry): boolean => entry.kind === "invoice")
      .map((entry: BoardEntry): [string, BoardEntry] => [entry.invoiceId, entry]),
  );
  const rows: IncidentRow[] = listed
    .map(
      ({ snapshot, situation }: { snapshot: InvoiceSnapshot; situation: Situation }): IncidentRow =>
        incidentRow(snapshot, situation, entries.get(snapshot.obligation.invoiceId), live),
    )
    .sort(byRank);
  const count = (group: QueueGroup): number => rows.filter((row: IncidentRow): boolean => row.situation.group === group).length;
  const wallets: Set<string> = new Set<string>([...board.currencies, ...all.map((snapshot: InvoiceSnapshot): string => debitCurrency(snapshot.obligation))]);
  return {
    view: "incidents",
    generatedAt: new Date(now).toISOString(),
    query,
    scopes: SCOPES.map((scope: IncidentScope) => ({
      scope,
      label: scope === "all" ? "All" : GROUP_LABELS[scope],
      count: scope === "all" ? rows.length : count(scope),
    })),
    wallets: [...wallets].sort((a: string, b: string): number => a.localeCompare(b)),
    outages: board.outages.map(outageStrip),
    totals: board.totals.map(walletTotals),
    rows: rows.filter((row: IncidentRow): boolean => query.scope === "all" || row.situation.group === query.scope),
    ledgerCount: board.invoices,
  };
}

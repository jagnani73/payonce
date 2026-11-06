import { sameName } from "../domain/approvers.js";
import { railWords } from "../domain/patterns.js";
import { sendsText } from "../outages/outages.js";
import type { Settings } from "../settings.js";
import type { Attempt, Ledger, OutsidePayout } from "../store/ledger.js";
import type { InvoiceSnapshot, QueueGroup, Situation } from "../domain/situation.js";
import { boardReport, type BoardOutage, type BoardReport, type BoardTotal } from "./incident-board.js";
import type { IncidentRow, IncidentScope, IncidentsQuery, IncidentsView, OutageStrip, WalletTotals } from "./contract.js";
import { snapshotOptions, type Live } from "./context.js";
import { money } from "./parts.js";
import { GROUP_LABELS, incidentRows, originOf } from "./rows.js";
import { readInvoiceSnapshots } from "./snapshot.js";

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
    withBank: money(total.withBankMinor, total.currency, estimated),
    estimated,
    feeUnknown: total.feeUnknown,
  };
}

// The approvers who can sign the payment's request now include this name.
export function waitingFor(situation: Situation, me: string): boolean {
  return situation.waitingOn.who === "approvers" && situation.waitingOn.names.some((name: string): boolean => sameName(name, me));
}

function matchesText(snapshot: InvoiceSnapshot, q: string): boolean {
  const lower: string = q.toLowerCase();
  const references: (string | null)[] = [
    ...snapshot.attempts.flatMap((attempt: Attempt): (string | null)[] => [attempt.reference, attempt.mismatchedReference]),
    ...snapshot.payouts.map((payout: OutsidePayout): string => payout.reference),
  ];
  return (
    snapshot.obligation.invoiceId.toLowerCase().includes(lower) ||
    snapshot.obligation.supplier.toLowerCase().includes(lower) ||
    references.some((reference: string | null): boolean => reference !== null && reference.toLowerCase().includes(lower))
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
  const board: BoardReport = boardReport(ledger, { group: null, currency: query.currency, origin: query.origin }, now);
  const snapshots: InvoiceSnapshot[] = readInvoiceSnapshots(ledger, snapshotOptions(settings, live), now).filter(
    (snapshot: InvoiceSnapshot): boolean =>
      (query.currency === null || inWallet(snapshot, query.currency)) &&
      (query.origin === null || originOf(snapshot) === query.origin) &&
      (query.q === null || matchesText(snapshot, query.q)),
  );
  const rows: IncidentRow[] = incidentRows(snapshots, board.entries, live, now).filter(
    (row: IncidentRow): boolean =>
      (query.me === null || waitingFor(row.situation, query.me)) &&
      (row.situation.group !== "closed" || query.clean || row.incident !== null),
  );
  const count = (group: QueueGroup): number => rows.filter((row: IncidentRow): boolean => row.situation.group === group).length;
  return {
    view: "incidents",
    generatedAt: new Date(now).toISOString(),
    query,
    scopes: SCOPES.map((scope: IncidentScope) => ({
      scope,
      label: scope === "all" ? "All" : GROUP_LABELS[scope],
      count: scope === "all" ? rows.length : count(scope),
    })),
    wallets: board.currencies,
    outages: board.outages.map(outageStrip),
    totals: board.totals.map(walletTotals),
    rows: rows.filter((row: IncidentRow): boolean => query.scope === "all" || row.situation.group === query.scope),
    ledgerCount: board.invoices,
  };
}

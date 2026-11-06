import { sameName } from "../domain/approvers.js";
import type { InvoiceSnapshot, RunSituation, RunSnapshot } from "../domain/situation.js";
import { candidatesFor, invoiceIndex, type InvoiceIndex } from "../intake/intake.js";
import type { Settings } from "../settings.js";
import type { InboxWaiting, Ledger, Upload } from "../store/ledger.js";
import { boardReport, type BoardReport } from "./incident-board.js";
import { metricsReport, type FirstTimeRow, type MetricsReport } from "./metrics.js";
import type { AirwallexHealth, HomeView, IncidentRow, QueueItem, ReadinessItem, RunRowItem, Tile } from "./contract.js";
import { readerOf, snapshotOptions, type Live } from "./context.js";
import { waitingFor } from "./incidents.js";
import { incidentRows, runItems } from "./rows.js";
import { readInvoiceSnapshots, readRunSnapshots } from "./snapshot.js";

// Home: what needs a person now, what PayOnce is handling, and on an empty
// ledger the checklist of settings that make PayOnce work.

function readiness(settings: Settings, airwallex: AirwallexHealth | null): ReadinessItem[] {
  const approvers: number = settings.approvals.approvers.length;
  const floors: string[] = [...settings.reserve.floors.keys()].sort();
  const reader: { name: string; isModel: boolean } = readerOf(settings);
  return [
    {
      key: "airwallex",
      label: "Airwallex sandbox connected",
      state: airwallex === null || airwallex.state === "unknown" ? "warning" : airwallex.state === "ok" ? "ok" : "missing",
      text: airwallex?.text ?? "Only pnpm ui reads Airwallex.",
      href: "#settings/airwallex",
    },
    {
      key: "approvers",
      label: approvers === 0 ? "Approvers set" : `Approvers set (${approvers})`,
      state: settings.approvals.problem === null ? "ok" : "missing",
      text: settings.approvals.problem === null ? "Approvals are checked against the approver list and its limits." : "Without approvers nobody can approve anything.",
      href: "#settings/approvals",
    },
    {
      key: "floors",
      label: floors.length === 0 ? "Reserve floors set" : `Reserve floors set for ${floors.join(", ")}`,
      state: settings.reserve.problem !== null ? "missing" : floors.length === 0 ? "warning" : "ok",
      text:
        settings.reserve.problem ?? "A currency with no floor sends every replacement to a person.",
      href: "#settings/cash",
    },
    {
      key: "alerts",
      label: "Alerts",
      state: settings.alerts.target !== null ? "ok" : settings.alerts.problem !== null ? "warning" : "optional",
      text: settings.alerts.problem ?? (settings.alerts.target === null ? "No alert address is set." : "Alerts post when something needs a person."),
      href: "#settings/alerts",
    },
    {
      key: "reader",
      label: "Email reader",
      state: "ok",
      text: reader.isModel ? `Model: ${reader.name}` : "Keyword reader",
      href: "#settings/reader",
    },
  ];
}

// Uploads waiting in the inbox that suggest an invoice.
function suggestedUploads(ledger: Ledger): number {
  const waiting: Upload[] = ledger.uploads(0).filter((upload: Upload): boolean => upload.state === "waiting");
  if (waiting.length === 0) {
    return 0;
  }
  const index: InvoiceIndex = invoiceIndex(ledger);
  return waiting.filter((upload: Upload): boolean => candidatesFor(ledger, upload, index).suggested !== null).length;
}

function paidTile(report: MetricsReport): Tile {
  const ended: number = report.payments.firstTime.reduce((sum: number, row: FirstTimeRow): number => sum + row.ended, 0);
  const first: number = report.payments.firstTime.reduce((sum: number, row: FirstTimeRow): number => sum + row.paid, 0);
  const paid: number = report.incidents.closed
    .filter((row: { how: string }): boolean => row.how !== "not-paid")
    .reduce((sum: number, row: { count: number }): number => sum + row.count, 0);
  return {
    key: "paid-week",
    label: "Paid in the last 7 days",
    value: String(paid),
    sub: ended === 0 ? null : `${Math.round((first / ended) * 100)}% the first time`,
    href: "#reports?period=7d",
  };
}

type RunItem = { snapshot: RunSnapshot; situation: RunSituation; item: RunRowItem };

interface Queues {
  rows: IncidentRow[];
  runs: RunItem[];
}

function queuesOf(ledger: Ledger, settings: Settings, now: number, live: Live | null): Queues {
  const board: BoardReport = boardReport(ledger, { group: null, currency: null, origin: null }, now);
  const snapshots: InvoiceSnapshot[] = readInvoiceSnapshots(ledger, snapshotOptions(settings, live), now);
  return {
    rows: incidentRows(snapshots, board.entries, live, now),
    runs: runItems(readRunSnapshots(ledger, snapshotOptions(settings, live), now), now),
  };
}

function inGroups(rows: IncidentRow[], ...groups: string[]): IncidentRow[] {
  return rows.filter((row: IncidentRow): boolean => groups.includes(row.situation.group));
}

function asItems(rows: IncidentRow[], runs: RunRowItem[]): QueueItem[] {
  return [
    ...rows.map((row: IncidentRow): QueueItem => ({ type: "payment", row })),
    ...runs.map((row: RunRowItem): QueueItem => ({ type: "run", row })),
  ];
}

// The payments and runs whose requests this name can sign now.
function waitingOn(queues: Queues, me: string): QueueItem[] {
  return asItems(
    inGroups(queues.rows, "needs-you", "bank-late").filter((row: IncidentRow): boolean => waitingFor(row.situation, me)),
    queues.runs
      .filter(
        (run: RunItem): boolean =>
          run.situation.waitingOn.who === "approvers" &&
          run.situation.waitingOn.names.some((name: string): boolean => sameName(name, me)),
      )
      .map((run: RunItem): RunRowItem => run.item),
  );
}

// Home's waitingForMe alone, for a name as personName records it.
export function waitingForMe(ledger: Ledger, settings: Settings, now: number, me: string, live: Live | null = null): QueueItem[] {
  return waitingOn(queuesOf(ledger, settings, now, live), me);
}

// me: the name a person chose, for what waits on their signoff.
export function homeView(
  ledger: Ledger,
  settings: Settings,
  now: number,
  me: string | null,
  airwallex: AirwallexHealth | null = null,
  live: Live | null = null,
  metrics: MetricsReport | null = null,
): HomeView {
  const queues: Queues = queuesOf(ledger, settings, now, live);
  const { rows, runs }: Queues = queues;
  const inGroup = (...groups: string[]): IncidentRow[] => inGroups(rows, ...groups);
  const needsYou: IncidentRow[] = inGroup("needs-you", "bank-late");
  const runsNeedingYou: RunRowItem[] = runs
    .filter((run: RunItem): boolean => run.situation.group === "needs-you")
    .map((run: RunItem): RunRowItem => run.item);
  const withBank: IncidentRow[] = inGroup("with-bank", "bank-late");
  const handling: IncidentRow[] = inGroup("payonce");
  const blocked: IncidentRow[] = handling.filter((row: IncidentRow): boolean => row.situation.blockers.length > 0);
  const inbox: InboxWaiting = ledger.inboxWaiting();
  const closedAt: number[] = inGroup("closed")
    .map((row: IncidentRow): number => (row.situation.since === null ? Number.NaN : Date.parse(row.situation.since)))
    .filter((at: number): boolean => Number.isFinite(at));
  const urgent: number = needsYou.filter((row: IncidentRow): boolean => row.situation.urgent).length;
  const late: number = withBank.filter((row: IncidentRow): boolean => row.situation.group === "bank-late").length;
  return {
    view: "home",
    generatedAt: new Date(now).toISOString(),
    tiles: [
      {
        key: "needs-you",
        label: "Needs you",
        value: String(needsYou.length + runsNeedingYou.length),
        sub: urgent === 0 ? null : `${urgent} urgent`,
        href: "#incidents?scope=needs-you",
      },
      { key: "with-bank", label: "With the bank", value: String(withBank.length), sub: late === 0 ? null : `${late} late`, href: "#incidents?scope=with-bank" },
      {
        key: "payonce",
        label: "PayOnce is handling",
        value: String(handling.length),
        sub: blocked.length === 0 ? null : `${blocked.length} blocked`,
        href: "#incidents?scope=payonce",
      },
      paidTile(metrics ?? metricsReport(ledger, "7d", now)),
    ],
    waitingForMe: me === null ? null : waitingOn(queues, me),
    needsYou: asItems(needsYou, runsNeedingYou),
    inbox: { waiting: inbox.waiting, suggested: suggestedUploads(ledger) },
    handling: {
      count: handling.length,
      blocked: blocked.length,
      rows: [...blocked, ...handling.filter((row: IncidentRow): boolean => row.situation.blockers.length === 0)],
    },
    firstRun: ledger.obligations().length === 0 && ledger.runs().length === 0 ? { readiness: readiness(settings, airwallex) } : null,
    lastClosedAt: closedAt.length === 0 ? null : new Date(Math.max(...closedAt)).toISOString(),
  };
}


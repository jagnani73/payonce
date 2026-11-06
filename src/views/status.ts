import { isExpired } from "../domain/live.js";
import type { AlertTarget } from "../alerts/alerts.js";
import { sendsText, type HoldingOf, type OutageHolding } from "../outages/outages.js";
import { reconReport, type BreakView, type ReconReport } from "../recon/reconcile.js";
import type { Settings } from "../settings.js";
import { readingSoft, type Alert, type Ledger, type Outage, type Run, type RunApproval } from "../store/ledger.js";
import type { AirwallexHealth, AuditCheckView, OutageStrip, StatusView } from "./contract.js";
import { readerOf } from "./context.js";
import { airwallexHealth, type ServerFacts } from "./health.js";
import { outageHolding } from "./incident-board.js";

// The status chip and the banners every screen shows, polled every 10 s, so it
// reads little: the latest Airwallex reads, the active outages, alerts, the
// audit check the server keeps, reconciliation's last check and two counts.

const UNREACHABLE_BANNER_MS: number = 30_000;
const NO_READ: AirwallexHealth = {
  state: "unknown",
  lastOkAt: null,
  failingSince: null,
  text: "Only pnpm ui reads Airwallex.",
  detail: null,
};

function stripOf(outage: Outage, holding: HoldingOf): OutageStrip {
  const held: OutageHolding = holding(outage);
  return {
    id: outage.id,
    rail: `${outage.currency} ${outage.method}`,
    pausing: held.invoices.length + held.runs.length,
    sendsText: `Ending it sends ${sendsText(held.sends)}.`,
  };
}

function alertsLine(settings: Settings, server: ServerFacts | null): string {
  const target: AlertTarget | null = settings.alerts.target;
  if (server?.alerts.stopped !== null && server?.alerts.stopped !== undefined) {
    return `Alerts stopped: ${server.alerts.stopped}`;
  }
  if (target === null) {
    return settings.alerts.problem === null ? "Off: no alert address is set" : `Off: ${settings.alerts.problem}`;
  }
  return `On · ${target.format === "slack" ? "Slack" : "Discord"} (${target.host})`;
}

// audit: the ledger-wide check the server keeps by change stamp, or null before
// the first one.
export function statusView(
  ledger: Ledger,
  settings: Settings,
  now: number,
  server: ServerFacts | null,
  audit: AuditCheckView | null,
): StatusView {
  return readingSoft((): StatusView => {
    const airwallex: AirwallexHealth = server === null ? NO_READ : airwallexHealth(ledger, server.host, server.balances);
    const active: Outage[] = ledger.outages().filter((outage: Outage): boolean => outage.state === "active").reverse();
    const holding: HoldingOf = outageHolding(ledger, now);
    const outages: OutageStrip[] = active.map((outage: Outage): OutageStrip => stripOf(outage, holding));
    const recon: ReconReport = reconReport(ledger, server?.reconRunner ?? null);
    const waitingRun: Run | undefined = ledger.waitingRun();
    const request: RunApproval | undefined = waitingRun === undefined ? undefined : ledger.latestRunApproval(waitingRun.id);
    const sent: Alert | undefined = ledger.recentAlerts(20).find((alert: Alert): boolean => alert.sentAt !== null);
    const failing: number = airwallex.failingSince === null ? Number.NaN : Date.parse(airwallex.failingSince);
    const down: boolean = airwallex.state === "unreachable" || airwallex.state === "error";
    const intact: boolean = audit?.intact ?? true;
    const banners: StatusView["banners"] = [
      ...(intact
        ? []
        : [
            {
              code: "audit" as const,
              tone: "danger" as const,
              text: `The audit trail no longer verifies${audit?.problems[0] === undefined ? "" : ` (${audit.problems[0]})`}. Check it before trusting the record.`,
              href: "#reports/audit",
            },
          ]),
      ...(down && (!Number.isFinite(failing) || now - failing > UNREACHABLE_BANNER_MS)
        ? [{ code: "airwallex" as const, tone: "danger" as const, text: airwallex.text, href: "#settings/airwallex" }]
        : []),
      ...(outages.length === 0
        ? []
        : [
            {
              code: "outage" as const,
              tone: "warning" as const,
              text:
                outages.length === 1
                  ? `Outage ${outages[0]?.id ?? ""} on ${outages[0]?.rail ?? ""}: PayOnce opens no new transfers there until someone ends it.`
                  : `${outages.length} outages active: ${outages.map((outage: OutageStrip): string => outage.rail).join(", ")}.`,
              href: "#treasury/outages",
            },
          ]),
      ...(server?.alerts.stopped === null || server === null
        ? []
        : [{ code: "alerts" as const, tone: "warning" as const, text: `${alertsLine(settings, server)}. Nobody is told about new incidents.`, href: "#settings/alerts" }]),
    ];
    return {
      view: "status",
      generatedAt: new Date(now).toISOString(),
      chip: !intact
        ? { tone: "danger", label: "Audit trail broken" }
        : down
          ? { tone: "danger", label: airwallex.state === "unreachable" ? "Airwallex unreachable" : "Airwallex error" }
          : outages.length > 0
            ? { tone: "warning", label: outages.length === 1 ? "1 outage" : `${outages.length} outages` }
            : server !== null && airwallex.state === "unknown"
              ? { tone: "starting", label: "Starting" }
              : { tone: "ok", label: "All good" },
      banners,
      airwallex,
      outages,
      alerts: { on: settings.alerts.target !== null && (server?.alerts.stopped ?? null) === null, text: alertsLine(settings, server), lastSentAt: sent?.sentAt ?? null },
      audit: { intact, checkedAt: audit?.checkedAt ?? null },
      recon: {
        lastCheckAt: recon.lastRun?.finishedAt ?? null,
        needsPerson: recon.open.filter((item: BreakView): boolean => !item.clearsByItself).length,
      },
      reader: readerOf(settings).name,
      inbox: { waiting: ledger.inboxWaiting().waiting },
      runs: {
        needsApproval: request !== undefined && request.state === "requested" && !isExpired(request, now) ? 1 : 0,
      },
    };
  });
}

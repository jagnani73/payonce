import type { ServerResponse } from "node:http";
import { CHECK_EVERY_MS } from "../start.js";
import { auditView, ledgerAuditExport } from "../../../views/audit.js";
import { beneficiaryPicker, readBeneficiaries, type BeneficiaryRead } from "../../../views/beneficiaries.js";
import type { AuditCheckView, BeneficiaryPickerView, HomeView, ReportsView, SearchView, StatusView } from "../../../views/contract.js";
import { airwallexHealth, type ServerFacts } from "../../../views/health.js";
import { homeView } from "../../../views/home.js";
import { isPeriod, metricsReport, PERIOD_PROBLEM, type MetricsReport, type Period } from "../../../views/metrics.js";
import { reportsView } from "../../../views/reports.js";
import { MAX_QUERY_LENGTH, searchView } from "../../../views/search.js";
import { settingsView } from "../../../views/settings-view.js";
import { statusView } from "../../../views/status.js";
import type { HttpApp } from "../app.js";
import { HttpError, queryName, sendJson } from "../http.js";
import type { Route } from "../router.js";

// The read routes that answer views from src/views/: Home, the status chip,
// Settings, Search, Reports and the metrics, the ledger-wide audit and its
// export, and the New payment form's beneficiary picker. They read the ledger
// and the server's own state, and only the picker calls Airwallex, with GETs.

// The ledger-wide audit hashes every line, so it is kept by the ledger's change
// stamp and built again at most once a minute.
const AUDIT_EVERY_MS: number = 60_000;
// The beneficiary list is read again once it is this old.
const BENEFICIARIES_EVERY_MS: number = 60_000;
const METRICS_KEPT: number = 3;

export function viewRoutes(app: HttpApp, sweepEveryMs: number): Route[] {
  const { engine, settings, balances, reconRunner, alertsStatus, live } = app;
  const metricsCache: Map<string, MetricsReport> = new Map();
  let audit: { stamp: string; at: number; view: AuditCheckView } | null = null;
  let beneficiaries: BeneficiaryRead | null = null;
  let reading: Promise<BeneficiaryRead> | null = null;

  function server(): ServerFacts {
    return {
      host: engine.client.host,
      balances: balances.latest(),
      alerts: alertsStatus(),
      reconRunner,
      checksEverySeconds: CHECK_EVERY_MS / 1000,
      listingEverySeconds: sweepEveryMs / 1000,
    };
  }

  // The last three metrics answers, by period, the ledger's change stamp and the
  // minute, since durations still running and requests open now move with the
  // clock. Home, Reports and the metrics route share them.
  function metrics(period: Period, now: number): MetricsReport {
    const key: string = `${period}|${engine.ledger.changeStamp()}|${Math.floor(now / 60_000)}`;
    const kept: MetricsReport | undefined = metricsCache.get(key);
    if (kept !== undefined) {
      return kept;
    }
    const report: MetricsReport = metricsReport(engine.ledger, period, now);
    metricsCache.set(key, report);
    for (const old of [...metricsCache.keys()].slice(0, Math.max(0, metricsCache.size - METRICS_KEPT))) {
      metricsCache.delete(old);
    }
    return report;
  }

  function auditNow(now: number): AuditCheckView {
    const stamp: string = engine.ledger.changeStamp();
    if (audit === null || (audit.stamp !== stamp && now - audit.at >= AUDIT_EVERY_MS)) {
      audit = { stamp, at: now, view: auditView(engine.ledger, settings, now) };
    }
    return audit.view;
  }

  function home(params: URLSearchParams): HomeView {
    const now: number = Date.now();
    return homeView(
      engine.ledger,
      settings,
      now,
      queryName(params, "me"),
      airwallexHealth(engine.ledger, engine.client.host, balances.latest()),
      live,
      metrics("7d", now),
    );
  }

  // Polled every 10 s. It asks for a balance read when the cache is 30 s old, as
  // the cash panel does, so whether Airwallex answers stays current.
  function status(): StatusView {
    balances.refreshIfOld();
    const now: number = Date.now();
    return statusView(engine.ledger, settings, now, server(), auditNow(now));
  }

  function search(params: URLSearchParams): SearchView {
    const q: string = (params.get("q") ?? "").trim();
    if (q === "" || q.length > MAX_QUERY_LENGTH) {
      throw new HttpError(400, `Search for 1 to ${MAX_QUERY_LENGTH} characters`);
    }
    return searchView(engine.ledger, settings, Date.now(), q);
  }

  function periodOf(params: URLSearchParams): Period {
    const period: string = params.get("period") ?? "7d";
    if (!isPeriod(period)) {
      throw new HttpError(400, PERIOD_PROBLEM);
    }
    return period;
  }

  function reports(params: URLSearchParams): ReportsView {
    const period: Period = periodOf(params);
    const now: number = Date.now();
    return reportsView(engine.ledger, settings, now, period, metrics(period, now));
  }

  function sendExport(response: ServerResponse): void {
    const body: string = JSON.stringify(ledgerAuditExport(engine.ledger, Date.now()));
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="payonce-audit.json"',
    });
    response.end(body);
  }

  // At most one read at a time, and none while the last is under a minute old.
  async function beneficiaryList(params: URLSearchParams): Promise<BeneficiaryPickerView> {
    const q: string = (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
    if (beneficiaries === null || Date.now() - beneficiaries.readAt >= BENEFICIARIES_EVERY_MS) {
      reading ??= readBeneficiaries(engine.client).finally((): void => {
        reading = null;
      });
      beneficiaries = await reading;
    }
    return beneficiaryPicker(engine.ledger, settings, Date.now(), q, beneficiaries);
  }

  return [
    { method: "GET", pattern: "/api/home", handler: ({ response, url }): void => sendJson(response, 200, home(url.searchParams)) },
    { method: "GET", pattern: "/api/status", handler: ({ response }): void => sendJson(response, 200, status()) },
    {
      method: "GET",
      pattern: "/api/settings",
      handler: ({ response }): void => sendJson(response, 200, settingsView(engine.ledger, settings, Date.now(), server())),
    },
    { method: "GET", pattern: "/api/search", handler: ({ response, url }): void => sendJson(response, 200, search(url.searchParams)) },
    { method: "GET", pattern: "/api/reports", handler: ({ response, url }): void => sendJson(response, 200, reports(url.searchParams)) },
    {
      method: "GET",
      pattern: "/api/metrics",
      handler: ({ response, url }): void => sendJson(response, 200, metrics(periodOf(url.searchParams), Date.now())),
    },
    { method: "GET", pattern: "/api/audit", handler: ({ response }): void => sendJson(response, 200, auditNow(Date.now())) },
    { method: "GET", pattern: "/api/audit/export", handler: ({ response }): void => sendExport(response) },
    {
      method: "GET",
      pattern: "/api/beneficiaries",
      handler: async ({ response, url }): Promise<void> => sendJson(response, 200, await beneficiaryList(url.searchParams)),
    },
  ];
}

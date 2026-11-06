import { boardReport, CURRENCY_PATTERN, isBoardGroup, isBoardOrigin, type BoardReport } from "../../../views/incident-board.js";
import { isPeriod, metricsReport, PERIOD_PROBLEM, type MetricsReport } from "../../../views/metrics.js";
import { supplierDetail, supplierList, type SupplierDetail } from "../../../views/suppliers.js";
import type { HttpApp } from "../app.js";
import { HttpError, sendJson } from "../http.js";
import type { Route } from "../router.js";

// The last three metrics answers, by period, the ledger's change stamp and the
// minute, since durations still running and requests open now move with the clock.
const METRICS_KEPT: number = 3;

// The incident board, the metrics and the supplier view, from the ledger alone.
export function reportRoutes(app: HttpApp): Route[] {
  const { engine } = app;
  const metricsCache: Map<string, MetricsReport> = new Map();

  // The incident board, from the ledger alone, with the filters the query names. An
  // empty value is no filter, and one the board does not know answers 400.
  function board(params: URLSearchParams): BoardReport {
    const group: string = params.get("group") ?? "";
    const currency: string = params.get("currency") ?? "";
    const origin: string = params.get("origin") ?? "";
    if (group !== "" && !isBoardGroup(group)) {
      throw new HttpError(400, "The group is person, deadline, bank or open");
    }
    if (currency !== "" && !CURRENCY_PATTERN.test(currency)) {
      throw new HttpError(400, "The currency is a three-letter code such as USD");
    }
    if (origin !== "" && !isBoardOrigin(origin)) {
      throw new HttpError(400, "The origin is payonce, outside or pay-run");
    }
    return boardReport(engine.ledger, {
      group: group === "" ? null : group,
      currency: currency === "" ? null : currency,
      origin: origin === "" ? null : origin,
    });
  }

  function metrics(params: URLSearchParams): MetricsReport {
    const period: string = params.get("period") ?? "7d";
    if (!isPeriod(period)) {
      throw new HttpError(400, PERIOD_PROBLEM);
    }
    const now: number = Date.now();
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

  // One supplier record by its beneficiary id, from the ledger alone.
  function supplier(raw: string): SupplierDetail {
    const detail: SupplierDetail | null = supplierDetail(engine.ledger, raw);
    if (detail === null) {
      throw new HttpError(404, `No invoice or pay run row in the ledger names supplier record ${raw.slice(0, 20)}`);
    }
    return detail;
  }

  return [
    { method: "GET", pattern: "/api/board", handler: ({ response, url }): void => sendJson(response, 200, board(url.searchParams)) },
    {
      method: "GET",
      pattern: "/api/metrics",
      handler: ({ response, url }): void => sendJson(response, 200, metrics(url.searchParams)),
    },
    {
      method: "GET",
      pattern: "/api/suppliers",
      handler: ({ response }): void => sendJson(response, 200, supplierList(engine.ledger)),
    },
    {
      method: "GET",
      pattern: "api/suppliers/:key",
      handler: ({ response }, key: string): void => sendJson(response, 200, supplier(key)),
    },
  ];
}

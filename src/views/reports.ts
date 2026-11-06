import { formatMoney } from "../domain/money.js";
import type { Settings } from "../settings.js";
import type { Ledger } from "../store/ledger.js";
import type { ReportsView } from "./contract.js";
import {
  metricsReport,
  type ClosedRow,
  type DuplicateRow,
  type FeeRow,
  type FirstTimeRow,
  type GroupSpread,
  type MetricsReport,
  type Period,
} from "./metrics.js";
import { listOf } from "./parts.js";

// Reports: the headline tiles over the metrics, and the metrics unchanged.

function count(rows: ClosedRow[], ...hows: ClosedRow["how"][]): number {
  return rows.filter((row: ClosedRow): boolean => hows.includes(row.how)).reduce((sum: number, row: ClosedRow): number => sum + row.count, 0);
}

function duration(seconds: number | null): string | null {
  if (seconds === null) {
    return null;
  }
  const minutes: number = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

function amounts(items: { minor: number; currency: string }[]): string | null {
  const shown: { minor: number; currency: string }[] = items.filter((item: { minor: number }): boolean => item.minor !== 0);
  return shown.length === 0 ? null : listOf(shown.map((item: { minor: number; currency: string }): string => formatMoney(item.minor, item.currency)));
}

export function reportTiles(report: MetricsReport): ReportsView["tiles"] {
  const ended: number = report.payments.firstTime.reduce((sum: number, row: FirstTimeRow): number => sum + row.ended, 0);
  const first: number = report.payments.firstTime.reduce((sum: number, row: FirstTimeRow): number => sum + row.paid, 0);
  const withPerson: GroupSpread | undefined = report.incidents.timeToClose.find(
    (spread: GroupSpread): boolean => spread.group === "with-a-person",
  );
  const median: string | null = duration(withPerson?.medianSeconds ?? null);
  const stopped: number = report.duplicates.rows.reduce((sum: number, row: DuplicateRow): number => sum + row.stopped, 0);
  return [
    {
      key: "first-time",
      label: "Paid the first time",
      value: ended === 0 ? "—" : `${Math.round((first / ended) * 100)}%`,
      sub: ended === 0 ? null : `${first} of ${ended}`,
    },
    { key: "recovered", label: "Recovered by PayOnce", value: String(count(report.incidents.closed, "replaced")), sub: null },
    {
      key: "needed-person",
      label: "Needed a person",
      value: String(count(report.incidents.closed, "person-paid", "not-paid")),
      sub: median === null ? null : `median ${median} to close`,
    },
    {
      key: "fees-kept",
      label: "Fees kept on failed transfers",
      value: amounts(report.fees.rows.map((row: FeeRow) => ({ minor: row.feeMinor, currency: row.currency }))) ?? "0.00",
      sub: null,
    },
    {
      key: "second-bills",
      label: "Second bills stopped",
      value: String(stopped),
      sub: amounts(report.duplicates.rows.map((row: DuplicateRow) => ({ minor: row.stoppedMinor, currency: row.currency }))),
    },
  ];
}

// metrics: the same report the metrics route answers, when the caller keeps one.
export function reportsView(
  ledger: Ledger,
  _settings: Settings,
  now: number,
  period: Period,
  metrics: MetricsReport | null = null,
): ReportsView {
  const report: MetricsReport = metrics ?? metricsReport(ledger, period, now);
  return { view: "reports", period, tiles: reportTiles(report), metrics: report };
}

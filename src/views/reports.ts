import { formatMoney } from "../domain/money.js";
import { railWords } from "../domain/patterns.js";
import type { Settings } from "../settings.js";
import type { Ledger } from "../store/ledger.js";
import type { Money, ReportsView, ShownMetrics } from "./contract.js";
import {
  metricsReport,
  type CloseGroup,
  type CloseHow,
  type ClosedRow,
  type DuplicateRow,
  type FailureRow,
  type FailureStage,
  type FeeRow,
  type FirstTimeRow,
  type GroupSpread,
  type Method,
  type MetricsReport,
  type PaymentKind,
  type PaymentRow,
  type Period,
  type WalletMoney,
} from "./metrics.js";
import { listOf, money } from "./parts.js";

// Reports: the headline tiles over the metrics, and the metrics with their money
// and codes in words, as the page shows them.

const PAYMENT_WORDS: Record<PaymentKind, string> = {
  first: "first transfer",
  "first-approved": "first transfer, approved",
  "replacement-auto": "replacement by PayOnce",
  "replacement-approved": "replacement, approved",
};

const STAGE_WORDS: Record<FailureStage, string> = {
  bank: "Failed at the bank",
  refused: "Refused by Airwallex",
  "never-created": "Never created",
};

const HOW_WORDS: Record<CloseHow, string> = {
  "first-time": "paid the first time",
  replaced: "replaced by PayOnce",
  "person-paid": "paid after a person",
  "not-paid": "closed without paying",
};

const GROUP_WORDS: Record<CloseGroup, string> = {
  "paid-first-time": "Paid the first time",
  "recovered-by-itself": "Recovered by PayOnce",
  "with-a-person": "With a person",
};

function railed<T extends { currency: string; method: Method }>(row: T): T & { railText: string } {
  return { ...row, railText: row.method === "other" ? `${row.currency} (method not on file)` : railWords(row.currency, row.method) };
}

function walletAmount(item: WalletMoney): WalletMoney & { amount: Money } {
  return { ...item, amount: money(item.amountMinor, item.currency) };
}

function grouped(spread: GroupSpread): GroupSpread & { groupText: string } {
  return { ...spread, groupText: GROUP_WORDS[spread.group] };
}

export function shownMetrics(report: MetricsReport): ShownMetrics {
  return {
    ...report,
    payments: {
      ...report.payments,
      rows: report.payments.rows.map((row: PaymentRow) => ({ ...row, whatText: PAYMENT_WORDS[row.what], paidAmount: money(row.paidMinor, row.currency) })),
      paidMoreThanOnce: { ...report.payments.paidMoreThanOnce, extra: report.payments.paidMoreThanOnce.extra.map(walletAmount) },
      mismatchedPaid: { ...report.payments.mismatchedPaid, paid: report.payments.mismatchedPaid.paid.map(walletAmount) },
      bankTimeToPay: report.payments.bankTimeToPay.map(railed),
    },
    failures: {
      ...report.failures,
      rows: report.failures.rows.map((row: FailureRow) => ({ ...railed(row), stageText: STAGE_WORDS[row.stage] })),
    },
    incidents: {
      ...report.incidents,
      closed: report.incidents.closed.map((row: ClosedRow) => ({ ...row, howText: HOW_WORDS[row.how], amount: money(row.amountMinor, row.currency) })),
      timeToClose: report.incidents.timeToClose.map(grouped),
      afterFailure: report.incidents.afterFailure.map(grouped),
    },
    fees: { ...report.fees, rows: report.fees.rows.map((row: FeeRow) => ({ ...row, fee: money(row.feeMinor, row.currency) })) },
    duplicates: {
      ...report.duplicates,
      rows: report.duplicates.rows.map((row: DuplicateRow) => ({ ...row, stoppedAmount: money(row.stoppedMinor, row.currency) })),
    },
    outages: { ...report.outages, rows: report.outages.rows.map(railed), byRail: report.outages.byRail.map(railed) },
  };
}

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
      label: "Second bills closed without paying",
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
  return { view: "reports", period, tiles: reportTiles(report), metrics: shownMetrics(report) };
}

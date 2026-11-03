import { existsSync } from "node:fs";
import { Ledger, LEDGER_PATH } from "./ledger.js";
import {
  isPeriod,
  metricsReport,
  type ApprovalRow,
  type CloseGroup,
  type CloseHow,
  type FailureStage,
  type GroupSpread,
  type MetricsReport,
  type PaymentKind,
  type Period,
  type Spread,
  type WalletMoney,
} from "./metrics.js";
import { formatMoney } from "./money.js";
import { printableJson, say, sayError } from "./printable.js";

// pnpm metrics [7d|30d|all] [json]: the ops metrics from the ledger alone, opened
// read-only. No .env is read, because no figure uses a setting.

const USAGE: string = "Usage: pnpm metrics [7d|30d|all] [json]";

const PERIOD_WORDS: Record<Period, string> = {
  "7d": "for the last 7 days",
  "30d": "for the last 30 days",
  all: "since the ledger started",
};

const PAYMENT_WORDS: Record<PaymentKind, string> = {
  first: "first payment",
  "first-approved": "first payment, approved",
  "replacement-auto": "replacement by PayOnce",
  "replacement-approved": "replacement, approved",
};

const HOW_WORDS: Record<CloseHow, string> = {
  "first-time": "paid the first time",
  replaced: "replaced by PayOnce",
  "person-paid": "paid after a person",
  "not-paid": "closed without paying",
};

const GROUP_WORDS: Record<CloseGroup, string> = {
  "paid-first-time": "paid the first time",
  "recovered-by-itself": "recovered by PayOnce alone",
  "with-a-person": "with a person",
};

const STAGE_WORDS: Record<FailureStage, string> = {
  bank: "failed at the bank",
  refused: "refused by Airwallex",
  "never-created": "never created",
};

function fail(message: string): never {
  sayError(message);
  process.exit(1);
}

// say cleans each line as printable does and keeps its indent. Every string here
// is PayOnce's own, but it goes through the helper all the same.
function line(text: string = ""): void {
  say(text);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function durationText(seconds: number | null): string {
  if (seconds === null) {
    return "none";
  }
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes: number = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours: number = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  }
  const days: number = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

// What payments took, wallet by wallet and never added across currencies, and how
// many of them have no amount on file.
function moneyText(rows: WalletMoney[], notKnown: number): string {
  const parts: string[] = rows.map(
    (row: WalletMoney): string =>
      `${formatMoney(row.amountMinor, row.currency)} in ${plural(row.payments, "payment", "payments")}`,
  );
  if (notKnown > 0) {
    parts.push(`${plural(notKnown, "payment", "payments")} with no amount on file`);
  }
  return parts.length === 0 ? "money in a currency PayOnce cannot read" : parts.join(", ");
}

function spreadText(spread: Spread): string {
  const missing: string = spread.notOnFile === 0 ? "" : `, ${spread.notOnFile} not on file`;
  if (spread.n === 0) {
    return `none measured${missing}`;
  }
  const p90: string = spread.p90Seconds === null ? "" : `, p90 ${durationText(spread.p90Seconds)}`;
  return `median ${durationText(spread.medianSeconds)} (n ${spread.n})${p90}, longest ${durationText(spread.maxSeconds)}${missing}`;
}


// For payments and incidents the counts are invoices, each counted once however
// many figures it was left out of.
function notOnFile(count: number, unreadable: number = 0, invoices: boolean = false): void {
  const what = (n: number): string => (invoices ? plural(n, "invoice", "invoices") : String(n));
  if (count > 0) {
    line(
      invoices
        ? `  Not on file: ${what(count)}, left out of some figures because a time they need is not in the ledger`
        : `  Not on file: ${count}, left out because a time they need is not in the ledger`,
    );
  }
  if (unreadable > 0) {
    line(`  Unreadable currency: ${what(unreadable)}, left out of the money`);
  }
}

function payments(report: MetricsReport): void {
  const table = report.payments;
  line("Payments sent, by when the transfer was created");
  if (table.rows.length === 0) {
    line("  No payments sent in this period");
  }
  for (const row of table.rows) {
    const runs: string = row.fromPayRuns === 0 ? "" : `, ${row.fromPayRuns} from pay runs`;
    line(
      `  ${row.currency} ${PAYMENT_WORDS[row.what]}: ${row.sent} sent, ${row.paid} paid, ${row.failed} failed, ${row.withBank} with the bank${runs}. ${formatMoney(row.paidMinor, row.currency)} paid`,
    );
  }
  for (const row of table.firstTime) {
    line(
      `  Paid the first time, ${row.currency}: ${row.paid} of the ${row.ended} first payments the bank has paid or failed${row.percent === null ? "" : ` (${row.percent}%)`}`,
    );
  }
  const twice = table.paidMoreThanOnce;
  line(
    twice.invoices === 0
      ? "  Paid more than once, since the ledger started: none"
      : `  Paid more than once, since the ledger started: ${plural(twice.invoices, "invoice", "invoices")}. The payments after the first took ${moneyText(twice.extra, twice.notKnown)}`,
  );
  const kept = table.mismatchedPaid;
  if (kept.transfers > 0) {
    line(
      `  Paid transfers that did not match their invoice, since the ledger started: ${plural(kept.transfers, "transfer", "transfers")} on ${plural(kept.invoices, "invoice", "invoices")}, which took ${moneyText(kept.paid, kept.notKnown)}. They are not counted as a second payment`,
    );
  }
  for (const row of table.bankTimeToPay) {
    line(`  Bank time to pay, ${row.currency} ${row.method}: ${spreadText(row)}`);
  }
  notOnFile(table.leftOut, table.unreadable, true);
}

function failures(report: MetricsReport): void {
  const table = report.failures;
  line("Failures by rail and code, by when the transfer was created or the payment was tried");
  if (table.rows.length === 0) {
    line("  No failures in this period");
  }
  for (const row of table.rows) {
    const flags: string[] = [row.rail ? "counts toward an outage" : "", row.resendable ? "a resend can fix it" : ""].filter(
      (flag: string): boolean => flag !== "",
    );
    const outside: string = row.outside === 0 ? "" : `, ${row.outside} sent outside PayOnce`;
    line(
      `  ${row.currency} ${row.method} ${STAGE_WORDS[row.stage]}, ${row.code} (${row.label}): ${row.payonce} PayOnce${outside}${flags.length === 0 ? "" : `. ${flags.join(", ")}`}`,
    );
  }
  if (table.outsidePayoutsFailed > 0) {
    line(`  Payouts sent outside PayOnce that failed, by when they were tied: ${table.outsidePayoutsFailed}`);
  }
  notOnFile(table.notOnFile, table.unreadable);
}

function groupLines(title: string, spreads: GroupSpread[]): void {
  for (const spread of spreads) {
    if (spread.n > 0 || spread.notOnFile > 0) {
      line(`  ${title}, ${GROUP_WORDS[spread.group]}: ${spreadText(spread)}`);
    }
  }
}

function incidents(report: MetricsReport): void {
  const table = report.incidents;
  const started = table.started;
  line("Incidents started, by their first timeline line");
  line(`  ${started.single} single, ${started.payRun} from pay runs, ${started.found} found in Airwallex`);
  notOnFile(started.notOnFile);
  line();
  line("Incidents closed, by their close");
  if (table.closed.length === 0) {
    line("  No incidents closed in this period");
  }
  for (const row of table.closed) {
    const parts: string[] = [
      row.fromPayRuns === 0 ? "" : `${row.fromPayRuns} from pay runs`,
      row.found === 0 ? "" : `${row.found} found in Airwallex`,
    ].filter((part: string): boolean => part !== "");
    line(
      `  ${row.currency} ${HOW_WORDS[row.how]}: ${row.count}, ${formatMoney(row.amountMinor, row.currency)}${parts.length === 0 ? "" : ` (${parts.join(", ")})`}`,
    );
  }
  groupLines("Time to close from the first line", table.timeToClose);
  groupLines("Time to close from the first failure", table.afterFailure);
  if (table.withPerson.n > 0 || table.withPerson.notOnFile > 0) {
    line(`  Time with a person, from when it first went to one: ${spreadText(table.withPerson)}`);
  }
  for (const row of table.reasons) {
    line(`  Reason on file when closed, ${row.label}: ${row.paid} paid, ${row.notPaid} not paid`);
  }
  notOnFile(table.leftOut, table.unreadable, true);
}

function approvalLine(row: ApprovalRow): void {
  const of: string = row.of === "invoice" ? "Invoice approvals" : "Pay run approvals";
  line(
    `  ${of}: ${row.given} given, ${row.twoApprovers} needing two approvers. ${row.spent} spent, ${row.voided} voided, ${row.waiting} waiting to be used`,
  );
  line(`  ${of}, time to approve: ${spreadText(row.wait)}`);
  notOnFile(row.notOnFile);
}

function approvals(report: MetricsReport): void {
  line("Approvals, by when a request got its last signoff");
  for (const row of report.approvals.rows) {
    approvalLine(row);
  }
  line(`  Requests waiting for a person now: ${report.approvals.openNow}`);
}

function fees(report: MetricsReport): void {
  const table = report.fees;
  line("Fees lost on failed transfers, by when the transfer was created");
  if (table.rows.length === 0) {
    line("  No fees lost in this period");
  }
  for (const row of table.rows) {
    const notRead: string = row.notRead === 0 ? "" : `, ${row.notRead} not read yet`;
    line(
      `  ${row.currency}: ${formatMoney(row.feeMinor, row.currency)} on ${row.transfers} ${row.transfers === 1 ? "transfer" : "transfers"} (${row.payonce} PayOnce, ${row.outside} outside)${notRead}`,
    );
  }
  notOnFile(table.notOnFile, table.unreadable);
}

function duplicates(report: MetricsReport): void {
  const table = report.duplicates;
  line("Duplicates held, by their first timeline line");
  if (table.rows.length === 0) {
    line("  No invoices held as a likely duplicate in this period");
  }
  for (const row of table.rows) {
    line(
      `  ${row.currency}: ${row.held} held. ${row.stopped} closed without paying (${formatMoney(row.stoppedMinor, row.currency)} not paid twice), ${row.paid} paid on approval, ${row.released} approved and paying now, ${row.stillHeld} still held`,
    );
  }
  notOnFile(table.notOnFile, table.unreadable);
}

function outages(report: MetricsReport): void {
  const table = report.outages;
  line("Rail outages, those running in the period");
  if (table.rows.length === 0) {
    line("  No outages in this period");
  }
  for (const row of table.rows) {
    const held: string[] = [
      row.held.original === 0 ? "" : plural(row.held.original, "first payment", "first payments"),
      row.held.replacement === 0 ? "" : plural(row.held.replacement, "replacement", "replacements"),
      row.held.approved === 0 ? "" : plural(row.held.approved, "approved payment", "approved payments"),
      row.held.run === 0 ? "" : plural(row.held.run, "pay run", "pay runs"),
    ].filter((part: string): boolean => part !== "");
    const codes: string = row.codes.map((code: { code: string; label: string }): string => `${code.code} (${code.label})`).join(", ");
    const ended: string = row.active ? "still active" : `ended ${row.endedAt ?? "at a time not on file"}`;
    const lasted: string = row.seconds === null ? "how long it lasted is not on file" : `${row.active ? "so far " : ""}${durationText(row.seconds)}`;
    line(
      `  Outage ${row.id} on ${row.currency} ${row.method}: declared ${row.declaredAt ?? "at a time not on file"}, ${ended}, ${lasted}. ${plural(row.payees, "payee", "payees")}, ${codes === "" ? "no codes on file" : codes}. Held ${held.length === 0 ? "nothing" : held.join(", ")}`,
    );
  }
  for (const rail of table.byRail) {
    line(
      `  ${rail.currency} ${rail.method}: ${plural(rail.outages, "outage", "outages")}, ${durationText(rail.totalSeconds)} in all, longest ${rail.longestSeconds === null ? "not on file" : durationText(rail.longestSeconds)}`,
    );
  }
  notOnFile(table.notOnFile, table.unreadable);
}

function recon(report: MetricsReport): void {
  const table = report.recon;
  line("Reconciliation breaks, by when they opened");
  if (!table.ran) {
    line("  Reconciliation has not run on this ledger");
    return;
  }
  if (table.rows.length === 0) {
    line("  No breaks opened in this period");
  }
  for (const row of table.rows) {
    line(
      `  ${row.label}${row.byItself ? " (clears by itself)" : ""}: ${row.found} found, ${row.explained} explained, ${row.cleared} cleared, ${row.open} open`,
    );
  }
  if (table.resolve.n > 0 || table.resolve.notOnFile > 0) {
    line(`  Time to resolve: ${spreadText(table.resolve)}`);
  }
  notOnFile(table.notOnFile);
}

function main(): void {
  let period: Period | null = null;
  let json: boolean = false;
  for (const word of process.argv.slice(2)) {
    if (word === "json" && !json) {
      json = true;
    } else if (isPeriod(word) && period === null) {
      period = word;
    } else {
      fail(USAGE);
    }
  }
  if (!existsSync(LEDGER_PATH)) {
    fail(`There is no ${LEDGER_PATH} here. Start an incident first.`);
  }
  const ledger: Ledger = new Ledger(LEDGER_PATH, true);
  try {
    const gaps: string[] = ledger.schemaGaps();
    if (gaps.length > 0) {
      fail(
        `This ledger was written by an older PayOnce and lacks ${gaps.length} ${gaps.length === 1 ? "table or column" : "tables or columns"} (${gaps.slice(0, 3).join(", ")}). pnpm metrics never upgrades a ledger. Restart pnpm ui, or run pnpm board once, which upgrades it, then run it again.`,
      );
    }
    const report: MetricsReport = metricsReport(ledger, period ?? "7d", Date.now());
    if (json) {
      say(printableJson(JSON.stringify(report, null, 2)));
      return;
    }
    line(`PayOnce metrics ${PERIOD_WORDS[report.period]}: ${report.from ?? "the ledger's start"} to ${report.to} (UTC)`);
    line("Each table counts by the time it names. Amounts are never added across currencies.");
    for (const table of [payments, failures, incidents, approvals, fees, duplicates, outages, recon]) {
      line();
      table(report);
    }
  } finally {
    ledger.close();
  }
}

main();

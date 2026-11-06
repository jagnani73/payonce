import type { ComponentChildren, JSX } from "preact";
import { Card, Table, type Column } from "../../components/Layout";
import { Time } from "../../components/Text";
import { count } from "../../text";
import type { ReportsView } from "../../types";
import { amountText, railWords, secondsText } from "../treasury/format";

// The eight tables of Reports (ia.md section 9), from the metrics as the server
// keeps them. Each says in one line what puts a row in the period. Amounts are
// never added across currencies.

type Metrics = ReportsView["metrics"];
type Cell = ComponentChildren;

interface Row {
  key: string;
  cells: Cell[];
}

interface Spread {
  n: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  maxSeconds: number | null;
  notOnFile: number;
}

const PAYMENT_WORDS: Record<Metrics["payments"]["rows"][number]["what"], string> = {
  first: "first transfer",
  "first-approved": "first transfer, approved",
  "replacement-auto": "replacement by PayOnce",
  "replacement-approved": "replacement, approved",
};

const STAGE_WORDS: Record<Metrics["failures"]["rows"][number]["stage"], string> = {
  bank: "Failed at the bank",
  refused: "Refused by Airwallex",
  "never-created": "Never created",
};

const HOW_WORDS: Record<Metrics["incidents"]["closed"][number]["how"], string> = {
  "first-time": "paid the first time",
  replaced: "replaced by PayOnce",
  "person-paid": "paid after a person",
  "not-paid": "closed without paying",
};

const GROUP_WORDS: Record<Metrics["incidents"]["timeToClose"][number]["group"], string> = {
  "paid-first-time": "Paid the first time",
  "recovered-by-itself": "Recovered by PayOnce",
  "with-a-person": "With a person",
};

function railOf(currency: string, method: string): string {
  return railWords(`${currency} ${method}`).replace(/ other$/, " (method not on file)");
}

function yes(value: boolean): string {
  return value ? "Yes" : "No";
}

// Median with its n, p90 (from 10 measured), and the longest.
function spreadCells(spread: Spread): Cell[] {
  if (spread.n === 0) {
    return ["none measured", "", ""];
  }
  return [`${secondsText(spread.medianSeconds)} (n ${spread.n})`, spread.p90Seconds === null ? "" : secondsText(spread.p90Seconds), secondsText(spread.maxSeconds)];
}

function spreadRow(key: string, label: string, spread: Spread): Row[] {
  return spread.n === 0 && spread.notOnFile === 0 ? [] : [{ key, cells: [label, ...spreadCells(spread)] }];
}

// What a table left out: rows a time they need is missing for, and rows whose
// currency can't be read. For payments and incidents the server counts invoices.
function LeftOut(props: { notOnFile: number; unreadable?: number; invoices?: boolean }): JSX.Element | null {
  const what = (n: number): string => (props.invoices === true ? count(n, "invoice") : String(n));
  const parts: string[] = [
    ...(props.notOnFile > 0 ? [`${what(props.notOnFile)} left out because a time they need is not on file.`] : []),
    ...((props.unreadable ?? 0) > 0 ? [`${what(props.unreadable ?? 0)} left out of the money because the currency can't be read.`] : []),
  ];
  return parts.length === 0 ? null : <p class="report__note">{parts.join(" ")}</p>;
}

function Grid(props: { caption: string; head: string[]; rows: Row[]; empty: string; numericFrom?: number; minWidth?: number }): JSX.Element {
  const from: number = props.numericFrom ?? 1;
  const columns: Column<Row>[] = props.head.map(
    (label: string, index: number): Column<Row> => ({
      key: String(index),
      label,
      cell: (row: Row): Cell => row.cells[index] ?? "",
      numeric: index >= from,
    }),
  );
  return <Table caption={props.caption} columns={columns} rows={props.rows} rowKey={(row: Row): string => row.key} empty={props.empty} minWidth={props.minWidth ?? 440} />;
}

function Report(props: { title: string; caption: string; children: ComponentChildren }): JSX.Element {
  return (
    <Card title={props.title} class="report">
      <p class="report__caption">{props.caption}</p>
      {props.children}
    </Card>
  );
}

function Payments(props: { table: Metrics["payments"] }): JSX.Element {
  const t: Metrics["payments"] = props.table;
  const twice: Metrics["payments"]["paidMoreThanOnce"] = t.paidMoreThanOnce;
  const kept: Metrics["payments"]["mismatchedPaid"] = t.mismatchedPaid;
  const extra: string = twice.extra.map((money: { amountMinor: number; currency: string; payments: number }): string => `${amountText(money.amountMinor, money.currency)} in ${count(money.payments, "payment")}`).join(", ");
  return (
    <Report title="Payments" caption="Transfers created in the period, by what they were and how the bank answered.">
      <Grid
        caption="Payments"
        head={["Transfer", "Sent", "Paid", "Failed", "With the bank", "Paid out", "From pay runs"]}
        rows={t.rows.map((row: Metrics["payments"]["rows"][number]): Row => ({
          key: `${row.currency}-${row.what}`,
          cells: [`${row.currency} ${PAYMENT_WORDS[row.what]}`, row.sent, row.paid, row.failed, row.withBank, amountText(row.paidMinor, row.currency), row.fromPayRuns],
        }))}
        empty="No transfers were created in this period."
        minWidth={620}
      />
      {t.firstTime.length === 0 ? null : (
        <p class="report__line">
          {`Paid the first time: ${t.firstTime
            .map((row: Metrics["payments"]["firstTime"][number]): string => `${row.currency} ${row.paid} of ${row.ended}${row.percent === null ? "" : ` (${row.percent}%)`}`)
            .join("; ")}.`}
        </p>
      )}
      <p class={twice.invoices === 0 ? "report__line" : "report__line report__line--danger"}>
        {twice.invoices === 0
          ? "Paid more than once, since the ledger started: none."
          : `Paid more than once, since the ledger started: ${count(twice.invoices, "invoice")}.${extra === "" ? "" : ` The extra payments took ${extra}.`}${twice.notKnown === 0 ? "" : ` ${count(twice.notKnown, "extra payment")} with no amount on file.`}`}
      </p>
      {kept.transfers === 0 ? null : (
        <p class="report__line">
          {`Paid transfers that didn't match their invoice, since the ledger started: ${count(kept.transfers, "transfer")} on ${count(kept.invoices, "invoice")}. PayOnce doesn't count these as a second payment.`}
        </p>
      )}
      {t.bankTimeToPay.some((row: Spread): boolean => row.n > 0) ? (
        <Grid
          caption="Bank time to pay"
          head={["Bank time to pay", "Median", "p90", "Longest"]}
          rows={t.bankTimeToPay.flatMap((row: Metrics["payments"]["bankTimeToPay"][number]): Row[] => spreadRow(`${row.currency}-${row.method}`, railOf(row.currency, row.method), row))}
          empty=""
        />
      ) : null}
      <LeftOut notOnFile={t.leftOut} unreadable={t.unreadable} invoices />
    </Report>
  );
}

function Failures(props: { table: Metrics["failures"] }): JSX.Element {
  const t: Metrics["failures"] = props.table;
  return (
    <Report title="Failures" caption="Transfers created or tried in the period that failed, by rail and code.">
      <Grid
        caption="Failures"
        head={["Rail", "Where", "Code", "What it means", "PayOnce", "Outside PayOnce", "Counts toward an outage", "A resend can fix it"]}
        rows={t.rows.map((row: Metrics["failures"]["rows"][number]): Row => ({
          key: `${row.currency}-${row.method}-${row.stage}-${row.code}`,
          cells: [railOf(row.currency, row.method), STAGE_WORDS[row.stage], <span class="mono">{row.code}</span>, row.label, row.payonce, row.outside, yes(row.rail), yes(row.resendable)],
        }))}
        empty="No transfer failed in this period."
        numericFrom={4}
        minWidth={760}
      />
      {t.outsidePayoutsFailed === 0 ? null : <p class="report__line">{`Payouts sent outside PayOnce that failed: ${t.outsidePayoutsFailed}.`}</p>}
      <LeftOut notOnFile={t.notOnFile} unreadable={t.unreadable} />
    </Report>
  );
}

function Incidents(props: { table: Metrics["incidents"] }): JSX.Element {
  const t: Metrics["incidents"] = props.table;
  const times: Row[] = [
    ...t.timeToClose.flatMap((spread: Metrics["incidents"]["timeToClose"][number]): Row[] => spreadRow(`close-${spread.group}`, `${GROUP_WORDS[spread.group]}, from the first line`, spread)),
    ...t.afterFailure.flatMap((spread: Metrics["incidents"]["afterFailure"][number]): Row[] => spreadRow(`fail-${spread.group}`, `${GROUP_WORDS[spread.group]}, from the first failure`, spread)),
    ...spreadRow("person", "With a person, from when it first went to one", t.withPerson),
  ];
  return (
    <Report title="Incidents" caption="Payments that closed in the period, by how they closed.">
      <p class="report__line">{`Started in the period: ${t.started.single} single, ${t.started.payRun} from pay runs, ${t.started.found} found in Airwallex.`}</p>
      <Grid
        caption="Incidents closed"
        head={["How it closed", "Count", "Amount", "From pay runs", "Found in Airwallex"]}
        rows={t.closed.map((row: Metrics["incidents"]["closed"][number]): Row => ({
          key: `${row.currency}-${row.how}`,
          cells: [`${row.currency} ${HOW_WORDS[row.how]}`, row.count, amountText(row.amountMinor, row.currency), row.fromPayRuns, row.found],
        }))}
        empty="No payment closed in this period."
        minWidth={560}
      />
      {times.length === 0 ? null : <Grid caption="How long they took" head={["How long they took", "Median", "p90", "Longest"]} rows={times} empty="" />}
      {t.reasons.length === 0 ? null : (
        <Grid
          caption="Why they needed a person"
          head={["Why they needed a person", "Paid", "Not paid"]}
          rows={t.reasons.map((row: Metrics["incidents"]["reasons"][number]): Row => ({ key: row.code, cells: [row.label, row.paid, row.notPaid] }))}
          empty=""
        />
      )}
      <LeftOut notOnFile={t.leftOut} unreadable={t.unreadable} invoices />
    </Report>
  );
}

function Approvals(props: { table: Metrics["approvals"] }): JSX.Element {
  const t: Metrics["approvals"] = props.table;
  return (
    <Report title="Approvals" caption="Requests fully signed off in the period.">
      <Grid
        caption="Approvals"
        head={["Requests", "Given", "Two approvers", "Used", "Withdrawn", "Waiting to be used", "Time to approve", "p90", "Longest"]}
        rows={t.rows.map((row: Metrics["approvals"]["rows"][number]): Row => ({
          key: row.of,
          cells: [row.of === "run" ? "Pay runs" : "Payments", row.given, row.twoApprovers, row.spent, row.voided, row.waiting, ...spreadCells(row.wait)],
        }))}
        empty="No request was approved in this period."
        minWidth={760}
      />
      <p class="report__line">{`Waiting for a person now: ${count(t.openNow, "request")}.`}</p>
      <LeftOut notOnFile={t.rows.reduce((sum: number, row: Metrics["approvals"]["rows"][number]): number => sum + row.notOnFile + row.wait.notOnFile, 0)} />
    </Report>
  );
}

function Fees(props: { table: Metrics["fees"] }): JSX.Element {
  const t: Metrics["fees"] = props.table;
  return (
    <Report title="Fees" caption="Fees the bank kept on transfers that failed, by when the transfer was created.">
      <Grid
        caption="Fees"
        head={["Wallet", "Transfers", "Fees kept", "Not read yet", "PayOnce", "Outside PayOnce"]}
        rows={t.rows.map((row: Metrics["fees"]["rows"][number]): Row => ({
          key: row.currency,
          cells: [row.currency, row.transfers, amountText(row.feeMinor, row.currency), row.notRead, row.payonce, row.outside],
        }))}
        empty="No fees were kept in this period."
        minWidth={560}
      />
      <LeftOut notOnFile={t.notOnFile} unreadable={t.unreadable} />
    </Report>
  );
}

function SecondBills(props: { table: Metrics["duplicates"] }): JSX.Element {
  const t: Metrics["duplicates"] = props.table;
  return (
    <Report title="Possible second bills" caption="Payments started in the period that went on hold as a possible second bill.">
      <Grid
        caption="Possible second bills"
        head={["Wallet", "On hold", "Closed without paying", "Not paid twice", "Paid on approval", "Approved, paying now", "Still on hold"]}
        rows={t.rows.map((row: Metrics["duplicates"]["rows"][number]): Row => ({
          key: row.currency,
          cells: [row.currency, row.held, row.stopped, amountText(row.stoppedMinor, row.currency), row.paid, row.released, row.stillHeld],
        }))}
        empty="No payment looked like a second bill in this period."
        minWidth={680}
      />
      <LeftOut notOnFile={t.notOnFile} unreadable={t.unreadable} />
    </Report>
  );
}

function pausedText(held: Metrics["outages"]["rows"][number]["held"]): string {
  const parts: string[] = [
    ...(held.original > 0 ? [count(held.original, "first transfer")] : []),
    ...(held.replacement > 0 ? [count(held.replacement, "replacement")] : []),
    ...(held.approved > 0 ? [count(held.approved, "approved transfer")] : []),
    ...(held.run > 0 ? [count(held.run, "pay run")] : []),
  ];
  return parts.length === 0 ? "Nothing" : parts.join(", ");
}

function Outages(props: { table: Metrics["outages"] }): JSX.Element {
  const t: Metrics["outages"] = props.table;
  return (
    <Report title="Outages" caption="Outages that were active at any time in the period.">
      <Grid
        caption="Outages"
        head={["Outage", "Declared", "Ended", "Lasted", "Payees", "Codes", "Paused"]}
        rows={t.rows.map((row: Metrics["outages"]["rows"][number]): Row => ({
          key: String(row.id),
          cells: [
            <a href={`#outage/${row.id}`}>{`Outage ${row.id} on ${railOf(row.currency, row.method)}`}</a>,
            row.declaredAt === null ? "not on file" : <Time at={row.declaredAt} />,
            row.active ? "Still active" : row.endedAt === null ? "not on file" : <Time at={row.endedAt} />,
            secondsText(row.seconds),
            row.payees,
            row.codes.length === 0 ? "none on file" : row.codes.map((code: { code: string; label: string }): string => `${code.code} ${code.label}`).join(", "),
            pausedText(row.held),
          ],
        }))}
        empty="No outage was active in this period."
        numericFrom={7}
        minWidth={760}
      />
      {t.byRail.length === 0 ? null : (
        <Grid
          caption="Outages by rail"
          head={["By rail", "Outages", "In all", "Longest"]}
          rows={t.byRail.map((row: Metrics["outages"]["byRail"][number]): Row => ({
            key: `${row.currency}-${row.method}`,
            cells: [railOf(row.currency, row.method), row.outages, secondsText(row.totalSeconds), secondsText(row.longestSeconds)],
          }))}
          empty=""
        />
      )}
      <LeftOut notOnFile={t.notOnFile} unreadable={t.unreadable} />
    </Report>
  );
}

function Reconciliation(props: { table: Metrics["recon"] }): JSX.Element {
  const t: Metrics["recon"] = props.table;
  const resolve: Row[] = spreadRow("resolve", "From opening to explained or cleared", t.resolve);
  return (
    <Report title="Reconciliation" caption="Breaks that opened in the period, by kind.">
      {!t.ran ? (
        <p class="muted">Reconciliation hasn't run on this ledger.</p>
      ) : (
        <>
          <Grid
            caption="Reconciliation breaks"
            head={["Kind", "Clears by itself", "Found", "Explained", "Cleared", "Open"]}
            rows={t.rows.map((row: Metrics["recon"]["rows"][number]): Row => ({
              key: row.kind,
              cells: [row.label, yes(row.byItself), row.found, row.explained, row.cleared, row.open],
            }))}
            empty="No break opened in this period."
            numericFrom={2}
            minWidth={560}
          />
          {resolve.length === 0 ? null : <Grid caption="Time to resolve" head={["Time to resolve", "Median", "p90", "Longest"]} rows={resolve} empty="" />}
        </>
      )}
      <p class="report__line">
        <a href="#treasury/reconciliation">Open reconciliation</a>
      </p>
      <LeftOut notOnFile={t.notOnFile + t.resolve.notOnFile} />
    </Report>
  );
}

// Nothing at all happened in the period: no transfer, close, request, fee,
// second bill, outage or break.
export function quiet(metrics: Metrics): boolean {
  return (
    metrics.payments.rows.length === 0 &&
    metrics.failures.rows.length === 0 &&
    metrics.incidents.closed.length === 0 &&
    metrics.incidents.started.single + metrics.incidents.started.payRun + metrics.incidents.started.found === 0 &&
    metrics.approvals.rows.every((row: Metrics["approvals"]["rows"][number]): boolean => row.given === 0) &&
    metrics.fees.rows.length === 0 &&
    metrics.duplicates.rows.length === 0 &&
    metrics.outages.rows.length === 0 &&
    metrics.recon.rows.length === 0
  );
}

export function ReportTables(props: { metrics: Metrics }): JSX.Element {
  const m: Metrics = props.metrics;
  return (
    <div class="reports-grid">
      <Payments table={m.payments} />
      <Failures table={m.failures} />
      <Incidents table={m.incidents} />
      <Approvals table={m.approvals} />
      <Fees table={m.fees} />
      <SecondBills table={m.duplicates} />
      <Outages table={m.outages} />
      <Reconciliation table={m.recon} />
    </div>
  );
}

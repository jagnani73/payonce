import { feeSeenText } from "../domain/arrival.js";
import { watching } from "../domain/live.js";
import {
  runRowStateOf,
  runSituationOf,
  situationOf,
  type InvoiceSnapshot,
  type RunRowStateView,
  type RunSituation,
  type RunSnapshot,
  type Situation,
} from "../domain/situation.js";
import { MAX_RUN_FILE_CHARS, MAX_RUN_ROWS, RUN_COLUMNS, type RunColumn } from "../runs/run-file.js";
import { runCounts, type RunCash, type RunCounts } from "../runs/runs.js";
import type { Settings } from "../settings.js";
import { readingSoft, storedList, type Ledger, type Outage, type Run, type RunRow } from "../store/ledger.js";
import type {
  Activity,
  ApproverChoice,
  Caution,
  Money,
  RunCashView,
  RunDecisionOption,
  RunListRow,
  RunRequestView,
  RunRowView,
  RunsView,
  RunView,
} from "./contract.js";
import { isBusy, isRunBusy, snapshotOptions, type Live } from "./context.js";
import { accountView, activityOf, allowed, arrivalView, money, refused, runAuditLine, timelineView } from "./parts.js";
import { runRequestView } from "./requests.js";
import { readRunSnapshot, readRunSnapshots } from "./snapshot.js";
import { sendsText, type OutageSend } from "../outages/outages.js";
import { outageHolding } from "./incident-board.js";

// Pay runs: the list, and one run with its rows, its request, its cash check,
// its timeline and its audit line.

const COLUMN_NOTES: Record<string, string> = {
  invoice: "The supplier's invoice number. PayOnce pays an invoice number once.",
  supplier: "The supplier's name, as the beneficiary record's account name has it.",
  beneficiary_id: "The Airwallex beneficiary record to pay.",
  amount: "The amount, with at most two decimals.",
  currency: "Three capital letters, such as USD. The row is paid from that wallet.",
  method: "LOCAL or SWIFT. Needed when the beneficiary takes both.",
  due_date: "When the supplier expects the money, as 2026-11-02. Advice only.",
  sandbox_outcome: "Sandbox only: what the simulator plays on the row's first transfer.",
  supplier_domain: "The domain the supplier's emails come from. A change needs two approvers.",
};

function runActivity(snapshot: RunSnapshot, live: Live | null): Activity {
  return activityOf(
    isRunBusy(live, snapshot.run.id) || snapshot.released.some((invoice: InvoiceSnapshot): boolean => isBusy(live, invoice.obligation.invoiceId)),
    snapshot.released.some((invoice: InvoiceSnapshot): boolean => watching(invoice.attempts, invoice.payouts)),
  );
}

function totalsOf(counts: RunCounts): Money[] {
  return counts.totals.map((total: { currency: string; amountMinor: number }): Money => money(total.amountMinor, total.currency));
}

export function runsView(ledger: Ledger, settings: Settings, now: number, live: Live | null = null): RunsView {
  return readingSoft((): RunsView => ({
    view: "runs",
    rows: readRunSnapshots(ledger, snapshotOptions(settings, live), now).map((snapshot: RunSnapshot): RunListRow => {
      const counts: RunCounts = runCounts(snapshot.rows);
      return {
        id: snapshot.run.id,
        fileName: snapshot.run.fileName,
        uploadedBy: snapshot.run.uploadedBy,
        uploadedAt: snapshot.run.uploadedAt,
        situation: runSituationOf(snapshot, now),
        counts: { pay: counts.pay, held: counts.held, skip: counts.skip },
        totals: totalsOf(counts),
        activity: runActivity(snapshot, live),
      };
    }),
    waiting: ledger.waitingRun()?.id ?? null,
    upload: {
      maxRows: MAX_RUN_ROWS,
      maxChars: MAX_RUN_FILE_CHARS,
      columns: RUN_COLUMNS.map((column: RunColumn) => ({ name: column.name, required: column.required, note: COLUMN_NOTES[column.name] ?? "" })),
    },
  }));
}

// ---------- one run ----------

// Why a row was skipped, by the fixed words runs.ts writes. Cells the file gave
// can be inside the words, so the text stays Theirs.
const SKIP_CODES: readonly [string, string, RegExp][] = [
  ["already-in-ledger", "Already in the ledger", /is already in the ledger, and PayOnce pays an invoice number once$/],
  ["same-number", "Same invoice number on file", /is already in the ledger as .+ for the same supplier/],
  ["twice-in-file", "Twice in this file", /is on row [0-9]+ of this file/],
  ["second-bill", "Possible second bill", /looks like a second bill for/],
  ["beneficiary-missing", "Beneficiary not in Airwallex", /^Beneficiary .+ is not in Airwallex$/],
  ["no-bank-details", "No bank details", /has no bank details$/],
  ["name-differs", "Name does not match", /^The supplier in the file is /],
  ["currency-differs", "Currency does not match", /account is in |does not say which currency/],
  ["method", "Method not taken", /^The beneficiary takes /],
  ["account-changed", "Bank details changed", /^The bank details on file for /],
  ["cash", "Not enough cash above the floor", /reserve floor|balance/],
];

function skipCode(text: string): { code: string; label: string } {
  const found: [string, string, RegExp] | undefined = SKIP_CODES.find(([, , test]: [string, string, RegExp]): boolean => test.test(text));
  return found === undefined ? { code: "other", label: "Other" } : { code: found[0], label: found[1] };
}

function rowView(ledger: Ledger, run: Run, row: RunRow, released: Map<string, { situation: Situation; snapshot: InvoiceSnapshot }>, live: Live | null, now: number): RunRowView {
  const payment: { situation: Situation; snapshot: InvoiceSnapshot } | undefined =
    row.invoiceId === null ? undefined : released.get(row.invoiceId);
  const state: RunRowStateView = runRowStateOf(row, payment?.situation ?? null);
  return {
    line: row.line,
    invoiceId: row.invoiceId,
    supplier: row.supplier,
    payee: row.payee,
    amount: row.amountMinor === null || row.currency === null ? null : money(row.amountMinor, row.currency),
    method: row.transferMethod,
    account: accountView(row.payTo),
    dueDate: row.dueDate,
    arrival: row.arrival === null ? null : arrivalView(row.arrival, run.state === "waiting", now),
    feeSeen: row.arrival === null || row.currency === null ? null : feeSeenText(ledger, row.currency, row.arrival.method),
    state: state.state,
    label: state.label,
    newPayee: state.newPayee,
    callbackVerified: state.callbackVerified,
    secondBillOf: row.heldFor,
    skipReasons: row.reasons.map((text: string) => ({ code: skipCode(text).code, text })),
    payment:
      payment === undefined
        ? null
        : {
            situation: { label: payment.situation.label, tone: payment.situation.tone },
            activity: activityOf(isBusy(live, payment.snapshot.obligation.invoiceId), watching(payment.snapshot.attempts, payment.snapshot.payouts)),
          },
  };
}

function cashView(cash: RunCash): RunCashView {
  const of = (minor: number | null): Money | null => (minor === null ? null : money(minor, cash.currency));
  return {
    currency: cash.currency,
    balance: of(cash.availableMinor),
    committedElsewhere: money(cash.committedMinor, cash.currency),
    rows: money(cash.payMinor, cash.currency),
    fees: money(cash.feeMinor, cash.currency, cash.feeUnknown > 0),
    left: of(cash.afterMinor),
    floor: of(cash.floorMinor),
    short: of(cash.shortMinor),
  };
}

function decisionOf(ledger: Ledger, snapshot: RunSnapshot, situation: RunSituation, request: RunRequestView | null, now: number): RunView["decision"] {
  if (snapshot.run.state !== "waiting") {
    return null;
  }
  const options: RunDecisionOption[] = [];
  const cautions: Caution[] = [];
  const outage: Outage | undefined = snapshot.outage?.outage;
  if (outage !== undefined) {
    cautions.push({
      code: "outage",
      text: `Outage ${outage.id} on ${outage.currency} ${outage.method} is active. The run is released whole, so it waits until someone ends it.`,
    });
  }
  if (request !== null && request.state === "waiting") {
    options.push({
      kind: "approve",
      title: "Approve run",
      consequence: [
        `Releases ${request.terms.payments} payments once every signoff is in. Your signoff is ${request.signoffs.length + 1} of ${request.needed}.`,
        "PayOnce sends the rows one at a time, each checked again before it goes.",
      ],
      can: request.approvers.some((approver: ApproverChoice): boolean => approver.canApprove) ? allowed() : refused("no-approver", "Nobody left on the approver list can approve this run."),
      suggested: situation.state === "needs-approval",
      requestId: request.id,
      approvers: request.approvers,
    });
  }
  options.push({
    kind: "recheck",
    title: "Re-check run",
    consequence: [
      "Runs every row's checks again, reading Airwallex.",
      "Opens a new request if the old one expired or the terms changed. Signoffs on the old request no longer count.",
    ],
    can: allowed(),
    suggested: situation.state === "request-expired" || situation.state === "needs-recheck",
  });
  options.push({
    kind: "cancel",
    title: "Cancel run",
    consequence: ["Drops every row. Their invoice numbers are free again. Nothing is sent."],
    can: allowed(),
    suggested: situation.state === "nothing-to-pay",
  });
  if (outage !== undefined && situation.state === "paused-by-outage") {
    const sends: OutageSend[] = outageHolding(ledger, now)(outage).sends;
    options.push({
      kind: "end-outage",
      title: `End outage ${outage.id} on ${outage.currency} ${outage.method}`,
      consequence: [`Ending it releases the run and sends ${sendsText(sends)}.`],
      can: allowed(),
      suggested: true,
      outageId: outage.id,
      rail: `${outage.currency} ${outage.method}`,
      enders: snapshot.outage?.enders ?? null,
      sends: sends.map((send: OutageSend) => ({ payments: send.payments, total: money(send.minor, send.currency, send.estimated) })),
    });
  }
  return {
    request,
    cautions,
    options: [
      ...options.filter((option: RunDecisionOption): boolean => option.suggested),
      ...options.filter((option: RunDecisionOption): boolean => !option.suggested),
    ],
  };
}

export function runView(ledger: Ledger, settings: Settings, now: number, runId: number, live: Live | null = null): RunView | null {
  return readingSoft((): RunView | null => {
    const snapshot: RunSnapshot | undefined = readRunSnapshot(ledger, runId, snapshotOptions(settings, live), now);
    if (snapshot === undefined) {
      return null;
    }
    const run: Run = snapshot.run;
    const situation: RunSituation = runSituationOf(snapshot, now);
    const counts: RunCounts = runCounts(snapshot.rows);
    const released: Map<string, { situation: Situation; snapshot: InvoiceSnapshot }> = new Map(
      snapshot.released.map((invoice: InvoiceSnapshot): [string, { situation: Situation; snapshot: InvoiceSnapshot }] => [
        invoice.obligation.invoiceId,
        { situation: situationOf(invoice, now), snapshot: invoice },
      ]),
    );
    const skipped: Map<string, { code: string; label: string; count: number }> = new Map();
    for (const row of snapshot.rows.filter((item: RunRow): boolean => item.action === "skip")) {
      for (const text of row.reasons) {
        const code: { code: string; label: string } = skipCode(text);
        const entry: { code: string; label: string; count: number } = skipped.get(code.code) ?? { ...code, count: 0 };
        entry.count += 1;
        skipped.set(code.code, entry);
      }
    }
    const request: RunRequestView | null = runRequestView(ledger, snapshot, now);
    return {
      view: "run",
      generatedAt: new Date(now).toISOString(),
      run: {
        id: run.id,
        fileName: run.fileName,
        fileHash: run.fileHash,
        uploadedBy: run.uploadedBy,
        uploadedAt: run.uploadedAt,
        checkedAt: run.checkedAt,
        releasedAt: run.releasedAt,
        cancelledBy: run.cancelledBy,
        cancelNote: run.cancelNote,
      },
      situation,
      counts: { pay: counts.pay, held: counts.held, skip: counts.skip },
      decision: decisionOf(ledger, snapshot, situation, request, now),
      rows: snapshot.rows.map((row: RunRow): RunRowView => rowView(ledger, run, row, released, live, now)),
      skippedSummary: [...skipped.values()],
      cash: { checkedAt: run.checkedAt, currencies: storedList<RunCash>(run.cash).map(cashView) },
      timeline: timelineView(ledger.runEvents(run.id)),
      audit: runAuditLine(ledger, run.id),
      activity: runActivity(snapshot, live),
    };
  });
}

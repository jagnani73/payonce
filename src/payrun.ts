import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { AirwallexClient } from "./airwallex/client.js";
import type { RunTotal } from "./approval.js";
import { describePolicy, policyFromEnv, type ApprovalPolicy } from "./approvers.js";
import type { Engine } from "./engine.js";
import {
  Ledger,
  LEDGER_PATH,
  NothingToPayError,
  SameFileError,
  signersOf,
  WaitingRunError,
  type CheckedRow,
  type LedgerEvent,
  type Run,
  type RunApproval,
  type RunRow,
} from "./ledger.js";
import { formatMoney } from "./money.js";
import { readerFromEnv } from "./reader.js";
import { describeFloors, reserveFromEnv } from "./reserve.js";
import { parseRunFile, type FileProblem, type ParsedRunFile } from "./run-file.js";
import {
  approveRun,
  cancelRun,
  domainChecks,
  domainText,
  pendingRunApproval,
  recheckRun,
  runCounts,
  runStatus,
  uploadRun,
  type PendingRunApproval,
  type RunCash,
  type RunCounts,
  type RunStatus,
} from "./runs.js";

const USAGE: string[] = [
  "pnpm payrun upload <FILE> <NAME>            check the file and store the run",
  "pnpm payrun show <RUN>                      rows, cash, the waiting approval and its request number",
  "pnpm payrun approve <RUN> [REQUEST NAME]    show the terms; with both, record that approval",
  "pnpm payrun check <RUN>                     check again, and open a new request if the old one expired or changed",
  "pnpm payrun cancel <RUN> <NAME> <NOTE>      cancel a run that is waiting",
];

const STATUS_WORDS: Record<RunStatus, string> = {
  "waiting-approval": "waiting for approval",
  approved: "approved, and the server releases it on its next check",
  expired: "its approval request expired. Check it again",
  "needs-check": "waiting on a person",
  released: "released",
  cancelled: "cancelled",
};

const EVENTS_SHOWN: number = 8;

function fail(message: string): void {
  console.log(message);
  process.exitCode = 1;
}

// Upload and check read Airwallex, GETs only. Show, approve and cancel do not.
function engineFrom(ledger: Ledger): Engine {
  return {
    client: AirwallexClient.fromEnv(),
    ledger,
    reader: readerFromEnv(),
    approvals: policyFromEnv(),
    reserve: reserveFromEnv(),
  };
}

function runOf(ledger: Ledger, raw: string | undefined): Run | undefined {
  const run: Run | undefined =
    raw !== undefined && /^[1-9][0-9]{0,9}$/.test(raw) ? ledger.run(Number(raw)) : undefined;
  if (run === undefined) {
    fail(`Run ${raw ?? ""} is not in the ledger`);
  }
  return run;
}

function totalsText(totals: { currency: string; amountMinor: number }[]): string {
  return totals.length === 0
    ? "nothing"
    : totals
        .map((total: { currency: string; amountMinor: number }): string =>
          formatMoney(total.amountMinor, total.currency),
        )
        .join(" and ");
}

function rowText(row: CheckedRow | RunRow): string {
  const money: string =
    row.amountMinor === null || row.currency === null ? "" : ` ${formatMoney(row.amountMinor, row.currency)}`;
  const state: string = "state" in row && row.state !== "waiting" ? ` (${row.state})` : "";
  const outcome: string = row.sandboxOutcome === "PAID" ? "" : `, sandbox ${row.sandboxOutcome}`;
  return `  row ${String(row.line).padEnd(3)} ${(row.invoiceId ?? "?").padEnd(16)}${money} ${row.action}${state}${outcome}`;
}

function printRows(rows: (CheckedRow | RunRow)[]): void {
  for (const row of rows) {
    console.log(rowText(row));
    if (row.payTo !== null && row.action === "pay") {
      console.log(`           to ${row.payTo}${row.newPayee ? ", a payee PayOnce has never paid" : ""}`);
    }
    for (const reason of row.reasons) {
      console.log(`           ${reason}`);
    }
    if (row.heldFor.length > 0) {
      console.log(`           held for a person when sent: looks like a second bill for ${row.heldFor.join(", ")}`);
    }
    if ("note" in row && row.note !== null) {
      console.log(`           ${row.note}`);
    }
  }
}

function printCash(cash: RunCash[]): void {
  for (const entry of cash) {
    const floor: string =
      entry.floorMinor === null ? `no reserve floor is set for ${entry.currency}` : `floor ${formatMoney(entry.floorMinor, entry.currency)}`;
    const available: string =
      entry.availableMinor === null ? "unknown" : formatMoney(entry.availableMinor, entry.currency);
    const after: string = entry.afterMinor === null ? "unknown" : formatMoney(entry.afterMinor, entry.currency);
    console.log(
      `  cash     ${entry.currency}: ${formatMoney(entry.payMinor, entry.currency)} to pay, available ${available}, committed elsewhere ${formatMoney(entry.committedMinor, entry.currency)}, ${floor}, after the run ${after}${entry.feeUnknown > 0 ? ", fee not known" : ""}`,
    );
    if (entry.problem !== null) {
      console.log(`           ${entry.problem}`);
    }
  }
}

function printApproval(ledger: Ledger, pending: PendingRunApproval): void {
  const approval: RunApproval = pending.approval;
  const totals: RunTotal[] = pending.terms.totals;
  const payments: number = pending.terms.rows.length;
  console.log(
    `Request ${approval.id}: pay ${totalsText(totals)} in ${payments} ${payments === 1 ? "payment" : "payments"}`,
  );
  // As on the page's card, so an approver sees a currency with no floor.
  for (const total of totals) {
    console.log(
      `  ${total.currency.padEnd(8)} ${formatMoney(total.amountMinor, total.currency)} in ${total.payments} ${total.payments === 1 ? "payment" : "payments"}, ${total.reserveFloorMinor === null ? `no reserve floor is set for ${total.currency}` : `reserve floor ${formatMoney(total.reserveFloorMinor, total.currency)}`}`,
    );
  }
  console.log(
    `  needs    ${approval.needed === 1 ? "one approver" : `${approval.needed} approvers, because ${approval.neededWhy}`}`,
  );
  console.log(`  limits   checked against ${formatMoney(pending.largest.amountMinor, pending.largest.currency)}, the largest total`);
  // The sender check trusts these domains, so the approvers see each one.
  for (const check of domainChecks(ledger, pending.terms)) {
    const changed: boolean = check.caution;
    console.log(`  ${changed ? "caution " : "domain  "} ${domainText(check)}`);
  }
  if (approval.signoffs.length > 0) {
    console.log(`  so far   approved by ${signersOf(approval.signoffs)}`);
  }
  for (const bar of pending.barred) {
    console.log(`  not      ${bar.name}, who ${bar.why}`);
  }
  console.log(
    `  expires  ${new Date(approval.expiresAt).toLocaleString()}${pending.expired ? " (expired)" : ""}`,
  );
}

function show(ledger: Ledger, run: Run): void {
  const rows: RunRow[] = ledger.runRows(run.id);
  const counts: RunCounts = runCounts(rows);
  console.log(
    `Pay run ${run.id}, ${run.fileName}, uploaded by ${run.uploadedBy} at ${new Date(run.uploadedAt).toLocaleString()}: ${STATUS_WORDS[runStatus(ledger, run)]}`,
  );
  console.log(
    `  ${counts.pay} to pay (${totalsText(counts.totals)})${counts.held === 0 ? "" : `, ${counts.held} held for a person when sent`}, ${counts.skip} skipped`,
  );
  printRows(rows);
  printCash(JSON.parse(run.cash) as RunCash[]);
  const pending: PendingRunApproval | undefined = pendingRunApproval(ledger, run.id);
  if (pending !== undefined) {
    printApproval(ledger, pending);
  }
  const events: LedgerEvent[] = ledger.runEvents(run.id).slice(-EVENTS_SHOWN);
  for (const event of events) {
    console.log(`  ${event.kind.padEnd(8)} ${event.message}`);
  }
}

function problemsText(problems: FileProblem[]): string {
  return problems
    .map((problem: FileProblem): string =>
      problem.line === null ? `  ${problem.message}` : `  line ${problem.line}: ${problem.message}`,
    )
    .join("\n");
}

async function upload(ledger: Ledger, path: string | undefined, uploadedBy: string): Promise<void> {
  if (path === undefined || uploadedBy === "") {
    fail("Usage: pnpm payrun upload <FILE> <NAME>. The name is who uploads the run, and that person cannot approve it");
    return;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (error: unknown) {
    fail(`Cannot read ${path} as UTF-8 text: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const parsed: ParsedRunFile = parseRunFile(basename(path), text);
  if (!parsed.ok) {
    fail(`PayOnce cannot read this file:\n${problemsText(parsed.problems)}`);
    return;
  }
  const engine: Engine = engineFrom(ledger);
  console.log(describePolicy(engine.approvals));
  console.log(describeFloors(engine.reserve));
  try {
    const runId: number = await uploadRun(engine, parsed.file, uploadedBy);
    const run: Run | undefined = ledger.run(runId);
    if (run !== undefined) {
      show(ledger, run);
      const pending: PendingRunApproval | undefined = pendingRunApproval(ledger, runId);
      if (pending !== undefined) {
        console.log(`To approve: pnpm payrun approve ${runId} ${pending.approval.id} <NAME>`);
      }
    }
  } catch (error: unknown) {
    if (error instanceof NothingToPayError) {
      fail(error.message);
      printRows(error.rows);
    } else if (error instanceof WaitingRunError || error instanceof SameFileError) {
      fail(error.message);
    } else {
      throw error;
    }
  }
}

// Without a name it shows the terms. With the request number it showed and a
// name, it records that person's approval of that request under the approval
// policy. The server releases the run.
function approve(ledger: Ledger, run: Run, requestRaw: string | undefined, approver: string): void {
  const policy: ApprovalPolicy = policyFromEnv();
  const pending: PendingRunApproval | undefined = pendingRunApproval(ledger, run.id);
  if (pending === undefined) {
    fail(`No approval is waiting for run ${run.id}`);
    return;
  }
  printApproval(ledger, pending);
  console.log(describePolicy(policy));
  if (requestRaw === undefined || approver === "") {
    console.log(`To approve these terms: pnpm payrun approve ${run.id} ${pending.approval.id} <NAME>`);
    return;
  }
  const requestId: number = Number(requestRaw);
  if (!Number.isInteger(requestId)) {
    fail("Usage: pnpm payrun approve <RUN> [REQUEST NAME]");
    return;
  }
  try {
    const after: RunApproval = approveRun(ledger, policy, run.id, approver, requestId);
    const left: number = after.needed - after.signoffs.length;
    console.log(
      after.state === "approved"
        ? "Approved. pnpm ui releases the run on its next check"
        : `Recorded. It needs ${left} more approver${left === 1 ? "" : "s"} before PayOnce releases it`,
    );
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  const [command, first, second, ...rest] = process.argv.slice(2);
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  if (command === "upload") {
    await upload(ledger, first, [second, ...rest].join(" ").trim());
    return;
  }
  if (command !== "show" && command !== "approve" && command !== "check" && command !== "cancel") {
    fail(USAGE.join("\n"));
    return;
  }
  const run: Run | undefined = runOf(ledger, first);
  if (run === undefined) {
    return;
  }
  if (command === "show") {
    show(ledger, run);
  } else if (command === "approve") {
    approve(ledger, run, second, rest.join(" ").trim());
  } else if (command === "check") {
    try {
      await recheckRun(engineFrom(ledger), run.id);
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : String(error));
    }
    show(ledger, ledger.run(run.id) ?? run);
  } else {
    const note: string = rest.join(" ").trim();
    if (second === undefined || note === "") {
      fail("Usage: pnpm payrun cancel <RUN> <NAME> <NOTE>");
      return;
    }
    try {
      cancelRun(ledger, run.id, second, note);
      console.log(`Run ${run.id} is cancelled. Its invoice numbers are free again`);
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

await main();

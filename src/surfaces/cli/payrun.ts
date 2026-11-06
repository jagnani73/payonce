import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { airwallexAdvice, AirwallexError, AirwallexUnreachableError, withAdvice } from "../../airwallex/client.js";
import { describePolicy, personName } from "../../domain/approvers.js";
import { formatMoney } from "../../domain/money.js";
import { describeFloors } from "../../domain/reserve.js";
import { createEngine, type EngineBuild } from "../../engine/create.js";
import type { Engine } from "../../engine/engine.js";
import { loadEnvIfPresent } from "../../env-file.js";
import { parseRunFile, type FileProblem, type ParsedRunFile } from "../../runs/run-file.js";
import {
  approveRun,
  cancelRun,
  pendingRunApproval,
  recheckRun,
  uploadRun,
  type PendingRunApproval,
} from "../../runs/runs.js";
import { loadSettings, type Settings } from "../../settings.js";
import {
  Ledger,
  LEDGER_PATH,
  NothingToPayError,
  SameFileError,
  WaitingRunError,
  type CheckedRow,
  type Run,
  type RunApproval,
} from "../../store/ledger.js";
import { say } from "../../text/printable.js";
import type {
  ArrivalView,
  RunCashView,
  RunDecisionOption,
  RunRequestView,
  RunRowView,
  RunTermsView,
  RunView,
} from "../../views/contract.js";
import { runView } from "../../views/runs.js";
import { readableRunTerms } from "./terms-shape.js";
import {
  count,
  heading,
  listOf,
  money,
  put,
  putAll,
  putCautions,
  putFields,
  putConsequence,
  putOption,
  putRows,
  putTimeline,
  signingFields,
  utc,
  type Field,
  type Listed,
} from "./view-text.js";

const USAGE: string[] = [
  "pnpm payrun upload <FILE> <NAME>            check the file and store the run",
  "pnpm payrun show <RUN>                      rows, cash, the waiting approval and its request number",
  "pnpm payrun approve <RUN> [REQUEST NAME]    show the terms; with both, record that approval",
  "pnpm payrun check <RUN>                     check again, and open a new request if the old one expired or changed",
  "pnpm payrun cancel <RUN> <NAME> <NOTE>      cancel a run that is waiting",
];

const TIMELINE_SHOWN: number = 8;

function fail(message: string): void {
  say(message);
  process.exitCode = 1;
}

// The server's words for the same failure, so the terminal and the page agree.
function airwallexDown(error: unknown): string | undefined {
  if (!(error instanceof AirwallexError || error instanceof AirwallexUnreachableError)) {
    return undefined;
  }
  const advice: string = airwallexAdvice(error);
  return `Airwallex could not be read, so the file was not checked: ${withAdvice(error.message, advice)}`;
}

function runOf(ledger: Ledger, raw: string | undefined): Run | undefined {
  const run: Run | undefined =
    raw !== undefined && /^[1-9][0-9]{0,9}$/.test(raw) ? ledger.run(Number(raw)) : undefined;
  if (run === undefined) {
    fail(`Run ${raw ?? ""} is not in the ledger`);
  }
  return run;
}

// ---------- the run view ----------

function arrivalLines(arrival: ArrivalView | null): string[] {
  return arrival === null ? [] : [arrival.text, ...(arrival.sentToday === null ? [] : [arrival.sentToday.text])];
}

function rowListed(row: RunRowView): Listed {
  const to: string[] = [
    ...(row.account === null ? [] : [`To ${row.account.label}`]),
    ...(row.newPayee ? ["a payee PayOnce has never paid on a person's approval"] : []),
    ...(row.callbackVerified ? ["account verified by a callback"] : []),
  ];
  return {
    head: [`Row ${row.line}`, row.invoiceId ?? "no invoice number", row.payee ?? row.supplier ?? "", row.amount === null ? "" : row.amount.text, row.label],
    lines: [
      ...(to.length === 0 ? [] : [to.join(", ")]),
      ...arrivalLines(row.arrival).map((line: string, index: number): string => (index === 0 && row.feeSeen !== null ? `${line}; ${row.feeSeen}` : line)),
      ...row.skipReasons.map((reason: { text: string }): string => reason.text),
    ],
  };
}

function cashLine(cash: RunCashView): Field {
  const parts: string[] = [
    `available ${cash.balance === null ? "not known" : money(cash.balance)}`,
    `promised elsewhere ${money(cash.committedElsewhere)}`,
    `rows ${money(cash.rows)}`,
    `fees ${money(cash.fees)}`,
    `left ${cash.left === null ? "not known" : money(cash.left)}`,
    cash.floor === null ? `no reserve floor is set for ${cash.currency}` : `floor ${money(cash.floor)}`,
    ...(cash.short === null ? [] : [`short ${money(cash.short)}`]),
  ];
  return [cash.currency, parts.join(", ")];
}

function termsFields(terms: RunTermsView): Field[] {
  const rows = (lines: number[]): string => `${lines.length === 1 ? "row" : "rows"} ${listOf(lines.map(String))}`;
  return [
    [
      "Pays",
      terms.totals.map(
        (total: RunTermsView["totals"][number]): string =>
          `${money(total.total)} in ${count(total.payments, "payment", "payments")}, ${total.floor === null ? `no reserve floor is set for ${total.total.currency}` : `reserve floor ${money(total.floor)}`}`,
      ),
    ],
    ["Limits", `checked against ${money(terms.largest)}, the largest total`],
    ...(terms.newPayees.length === 0 ? [] : [["New payees", rows(terms.newPayees)] as Field]),
    ...(terms.callbackRows.length === 0 ? [] : [["Callbacks", `${rows(terms.callbackRows)} pay bank details a callback confirmed`] as Field]),
    ...(terms.domains.length === 0
      ? []
      : [["Domains", terms.domains.map((domain: RunTermsView["domains"][number]): string => `${domain.caution ? "! " : ""}${domain.text}`)] as Field]),
    ...(terms.arrivals.length === 0
      ? []
      : [
          [
            "Arrival",
            terms.arrivals.flatMap((item: RunTermsView["arrivals"][number]): string[] =>
              arrivalLines(item.advice).map((line: string, index: number): string => (index === 0 ? `row ${item.line} ${item.invoiceId}: ${line}` : line)),
            ),
          ] as Field,
        ]),
  ];
}

function putRequest(request: RunRequestView): void {
  heading(`Request #${request.id}: pay ${count(request.terms.payments, "payment", "payments")}`);
  putFields([["State", request.label], ...termsFields(request.terms), ...signingFields(request)]);
}

function putOptions(view: RunView): void {
  const options: RunDecisionOption[] = view.decision?.options ?? [];
  if (options.length > 0) {
    heading("What you can do");
    for (const option of options) {
      putOption(option);
    }
  }
}

function show(view: RunView): void {
  const run: RunView["run"] = view.run;
  put(`Pay run ${run.id} · ${run.fileName} · uploaded by ${run.uploadedBy} at ${utc(run.uploadedAt)}`);
  put(view.situation.label);
  put(view.situation.next);
  if (view.situation.why !== null) {
    put(`Why: ${view.situation.why}`);
  }
  put(
    `${view.counts.pay} to pay${view.counts.held === 0 ? "" : `, ${count(view.counts.held, "possible second bill", "possible second bills")} checked again at send`}, ${view.counts.skip} skipped`,
  );
  heading("Rows");
  putRows(view.rows.map(rowListed), 3);
  const note: string | undefined = view.rows.find((row: RunRowView): boolean => row.arrival !== null)?.arrival?.note;
  if (note !== undefined) {
    put(note, 1);
  }
  if (view.skippedSummary.length > 0) {
    heading("Skipped");
    putAll(view.skippedSummary.map((item: { label: string; count: number }): string => `${item.label}: ${item.count}`), 1);
  }
  heading(`Cash when the run was checked, at ${utc(view.cash.checkedAt)}`);
  putFields(view.cash.currencies.map(cashLine));
  if (view.decision !== null) {
    if (view.decision.request !== null) {
      putRequest(view.decision.request);
    }
    putCautions(view.decision.cautions);
    putOptions(view);
  }
  heading("Timeline, newest last");
  putTimeline(view.timeline.lines, TIMELINE_SHOWN);
}

function viewOf(settings: Settings, ledger: Ledger, runId: number): RunView | null {
  return runView(ledger, settings, Date.now(), runId);
}

// The run's waiting request, or undefined when none waits. Null when its stored
// terms are not JSON or not in their shape: they were changed outside PayOnce,
// so the command says so and shows or approves nothing on them.
function waitingRequest(ledger: Ledger, run: Run): PendingRunApproval | undefined | null {
  const latest: RunApproval | undefined = ledger.latestRunApproval(run.id);
  if (latest?.state === "requested" && ledger.run(run.id)?.state === "waiting") {
    let terms: unknown;
    try {
      terms = JSON.parse(latest.terms) as unknown;
    } catch {
      return null;
    }
    if (!readableRunTerms(terms)) {
      return null;
    }
  }
  return pendingRunApproval(ledger, run.id);
}

function unreadableText(run: Run, ledger: Ledger): string {
  const id: number | undefined = ledger.latestRunApproval(run.id)?.id;
  return `${id === undefined ? "The approval request" : `Request ${id}`} for run ${run.id} holds terms PayOnce cannot read, so there is nothing to show or approve`;
}

// The run as its page shows it. A waiting request with terms PayOnce cannot read
// is refused instead.
function showRun(settings: Settings, ledger: Ledger, run: Run): void {
  const view: RunView | null = waitingRequest(ledger, run) === null ? null : viewOf(settings, ledger, run.id);
  if (view === null) {
    fail(unreadableText(run, ledger));
    return;
  }
  show(view);
}

function problemsText(problems: FileProblem[]): string {
  return problems
    .map((problem: FileProblem): string =>
      problem.line === null ? `  ${problem.message}` : `  line ${problem.line}: ${problem.message}`,
    )
    .join("\n");
}

// The rows of a file with nothing to pay, which is not stored, with why each is
// skipped.
function skippedRows(rows: CheckedRow[]): Listed[] {
  return rows.map(
    (row: CheckedRow): Listed => ({
      head: [
        `Row ${row.line}`,
        row.invoiceId ?? "no invoice number",
        row.amountMinor === null || row.currency === null ? "" : formatMoney(row.amountMinor, row.currency),
      ],
      lines: row.reasons,
    }),
  );
}

// Upload and check read Airwallex, GETs only. Show, approve and cancel do not.
async function upload(settings: Settings, ledger: Ledger, path: string | undefined, uploader: string): Promise<void> {
  if (path === undefined || uploader === "") {
    fail("Usage: pnpm payrun upload <FILE> <NAME>. The name is who uploads the run, and that person cannot approve it");
    return;
  }
  let uploadedBy: string;
  try {
    uploadedBy = personName(uploader);
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
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
  // A credential missing from .env, or an address that is not the sandbox, in
  // PayOnce's words and with no stack trace. Nothing is stored.
  const built: EngineBuild = createEngine(settings, ledger);
  if (built.problem !== null) {
    fail(built.problem);
    return;
  }
  const engine: Engine = built.engine;
  say(describePolicy(engine.approvals));
  say(describeFloors(engine.reserve));
  try {
    const runId: number = await uploadRun(engine, parsed.file, uploadedBy);
    const run: Run | undefined = ledger.run(runId);
    if (run !== undefined) {
      say();
      showRun(settings, ledger, run);
      const pending: PendingRunApproval | undefined = pendingRunApproval(ledger, runId);
      if (pending !== undefined) {
        say();
        say(`To approve: pnpm payrun approve ${runId} ${pending.approval.id} <NAME>`);
      }
    }
  } catch (error: unknown) {
    if (error instanceof NothingToPayError) {
      fail(error.message);
      putRows(skippedRows(error.rows));
    } else if (error instanceof WaitingRunError || error instanceof SameFileError) {
      fail(error.message);
    } else {
      const down: string | undefined = airwallexDown(error);
      if (down === undefined) {
        throw error;
      }
      fail(down);
    }
  }
}

// Without a name it shows the terms. With the request number it showed and a
// name, it records that person's approval of that request under the approval
// policy. The server releases the run.
function approve(settings: Settings, ledger: Ledger, run: Run, requestRaw: string | undefined, approver: string): void {
  const pending: PendingRunApproval | undefined | null = waitingRequest(ledger, run);
  if (pending === null) {
    fail(unreadableText(run, ledger));
    return;
  }
  if (pending === undefined) {
    fail(`No approval is waiting for run ${run.id}`);
    return;
  }
  const view: RunView | null = viewOf(settings, ledger, run.id);
  const request: RunRequestView | null = view?.decision?.request ?? null;
  if (view === null || request === null) {
    fail(unreadableText(run, ledger));
    return;
  }
  put(`Pay run ${run.id} · ${view.run.fileName} · ${view.situation.label}`);
  putRequest(request);
  putCautions(view.decision?.cautions ?? []);
  const option: RunDecisionOption | undefined = view.decision?.options.find((item: RunDecisionOption): boolean => item.kind === "approve");
  if (option !== undefined) {
    heading("If you approve");
    putConsequence(option);
  }
  say();
  // An expired request can no longer be approved, and a run's request is not
  // renewed by itself, so the next step is a check.
  if (pending.expired) {
    say(
      `This request has expired, and a pay run's request does not renew by itself. pnpm payrun check ${run.id} runs every check again and opens a new request`,
    );
    if (approver !== "") {
      process.exitCode = 1;
    }
    return;
  }
  if (requestRaw === undefined || approver === "") {
    say(`To approve these terms: pnpm payrun approve ${run.id} ${pending.approval.id} <NAME>`);
    return;
  }
  const requestId: number = Number(requestRaw);
  if (!Number.isInteger(requestId)) {
    fail("Usage: pnpm payrun approve <RUN> [REQUEST NAME]");
    return;
  }
  try {
    const after: RunApproval = approveRun(ledger, settings.approvals, run.id, approver, requestId);
    const left: number = after.needed - after.signoffs.length;
    say(
      after.state === "approved"
        ? "Approved. pnpm ui releases the run on its next check"
        : `Recorded. It needs ${left} more ${left === 1 ? "signoff" : "signoffs"} before PayOnce releases it`,
    );
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  // Upload and check need the credentials; show, approve and cancel read only
  // APPROVERS and the other settings, and run without a .env.
  loadEnvIfPresent();
  const settings: Settings = loadSettings();
  const [command, first, second, ...rest] = process.argv.slice(2);
  if (command !== "upload" && command !== "show" && command !== "approve" && command !== "check" && command !== "cancel") {
    fail(USAGE.join("\n"));
    return;
  }
  // Opening a ledger that is not there would make an empty one.
  if (!existsSync(LEDGER_PATH)) {
    fail(`There is no ${LEDGER_PATH} here. Start an incident first, or start pnpm ui once.`);
    return;
  }
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  if (command === "upload") {
    await upload(settings, ledger, first, [second, ...rest].join(" ").trim());
    return;
  }
  const run: Run | undefined = runOf(ledger, first);
  if (run === undefined) {
    return;
  }
  if (command === "show") {
    showRun(settings, ledger, run);
  } else if (command === "approve") {
    approve(settings, ledger, run, second, rest.join(" ").trim());
  } else if (command === "check") {
    const built: EngineBuild = createEngine(settings, ledger);
    if (built.problem !== null) {
      fail(built.problem);
    } else {
      try {
        await recheckRun(built.engine, run.id);
      } catch (error: unknown) {
        fail(airwallexDown(error) ?? (error instanceof Error ? error.message : String(error)));
      }
    }
    showRun(settings, ledger, ledger.run(run.id) ?? run);
  } else {
    const note: string = rest.join(" ").trim();
    if (second === undefined || note === "") {
      fail("Usage: pnpm payrun cancel <RUN> <NAME> <NOTE>");
      return;
    }
    try {
      cancelRun(ledger, run.id, second, note);
      say(`Run ${run.id} is cancelled. Its invoice numbers are free again`);
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

await main();

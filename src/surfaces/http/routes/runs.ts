import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { airwallexAdvice, AirwallexError, AirwallexUnreachableError, withAdvice } from "../../../airwallex/client.js";
import { runKey } from "../../../domain/patterns.js";
import { cleanFileName, MAX_RUN_FILE_CHARS, parseRunFile, type FileProblem, type ParsedRunFile } from "../../../runs/run-file.js";
import { approveRun, cancelRun, recheckRun, uploadRun } from "../../../runs/runs.js";
import { auditCsv, runAuditExport, type RunAuditExport } from "../../../store/audit-trail.js";
import {
  NothingToPayError,
  SameFileError,
  WaitingRunError,
  type Run,
  type RunApproval,
} from "../../../store/ledger.js";
import type { Acted, Notice, RunsView, RunView } from "../../../views/contract.js";
import { checkedRowViews, runsView, runView } from "../../../views/runs.js";
import type { HttpApp } from "../app.js";
import { HttpError, MAX_FINDING_LENGTH, name, readJson, RUN_ID_PATTERN, sendJson, text, UPLOAD_BODY_MS } from "../http.js";
import type { Route } from "../router.js";

// A pay run file travels as a string inside JSON. Its largest, 40,000 characters,
// takes at most 6 bytes a character once escaped, so this always fits it, and
// parseRunFile refuses a longer file by its characters.
const MAX_RUN_BODY_BYTES: number = 256 * 1024;
const RUN_TOO_LARGE_TEXT: string = `The file is too large. A pay run file can be at most ${MAX_RUN_FILE_CHARS.toLocaleString("en-US")} characters`;
const EXAMPLE_FILE: URL = new URL("../../../../fixtures/pay-run-example.csv", import.meta.url);

// Pay runs: the list, a run, its audit, the example file, and a person uploading,
// approving, checking or cancelling one. Every action answers the run as it is
// after it.
export function runRoutes(app: HttpApp): Route[] {
  const { engine, settings, agent, live, startRelease } = app;

  function requireRun(raw: string): Run {
    const run: Run | undefined = RUN_ID_PATTERN.test(raw) ? engine.ledger.run(Number(raw)) : undefined;
    if (run === undefined) {
      throw new HttpError(404, `Run ${raw.slice(0, 20)} is not in the ledger`);
    }
    return run;
  }

  function list(): RunsView {
    return runsView(engine.ledger, settings, Date.now(), live);
  }

  function runNow(raw: string): RunView {
    const view: RunView | null = RUN_ID_PATTERN.test(raw) ? runView(engine.ledger, settings, Date.now(), Number(raw), live) : null;
    if (view === null) {
      throw new HttpError(404, `Run ${raw.slice(0, 20)} is not in the ledger`);
    }
    return view;
  }

  function sendRunAudit(response: ServerResponse, raw: string, format: string): void {
    const run: Run = requireRun(raw);
    if (format !== "json" && format !== "csv") {
      throw new HttpError(400, "The format is json or csv");
    }
    const audit: RunAuditExport = runAuditExport(
      { runId: run.id, fileName: run.fileName, fileHash: run.fileHash, uploadedBy: run.uploadedBy, state: run.state },
      engine.ledger.runAuditSnapshot(run.id),
    );
    if (format === "json") {
      sendJson(response, 200, audit);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="run-${run.id}-audit.csv"`,
      "X-Audit-Chain": audit.intact ? "intact" : "broken",
    });
    response.end(auditCsv(audit));
  }

  // The file the upload form offers as an example of the columns.
  function sendExample(response: ServerResponse): void {
    const content: Buffer = readFileSync(EXAMPLE_FILE);
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="pay-run-example.csv"',
    });
    response.end(content);
  }

  // An Airwallex read that failed while checking a file is the bank's problem, not
  // the file's.
  function airwallexDown(error: unknown): HttpError | undefined {
    if (!(error instanceof AirwallexError || error instanceof AirwallexUnreachableError)) {
      return undefined;
    }
    return new HttpError(
      502,
      `Airwallex could not be read, so the file was not checked: ${withAdvice(error.message, airwallexAdvice(error))}`,
    );
  }

  // "Pay run 7 checked: 5 rows to pay, 1 held, 1 skipped. Waiting for approval."
  function checkedNotice(view: RunView): Notice {
    const parts: string[] = [`${view.counts.pay} ${view.counts.pay === 1 ? "row" : "rows"} to pay`];
    if (view.counts.held > 0) {
      parts.push(`${view.counts.held} held`);
    }
    if (view.counts.skip > 0) {
      parts.push(`${view.counts.skip} skipped`);
    }
    return { tone: "success", text: `Pay run ${view.run.id} checked: ${parts.join(", ")}. Waiting for approval.` };
  }

  // The page sends the file's text inside JSON, so the guard's Origin and content
  // type checks cover an upload too, and nothing parses multipart. The checks are a
  // handful of Airwallex GETs, so the answer waits for them.
  async function uploadRunFile(request: IncomingMessage): Promise<Acted<RunView>> {
    const body: Record<string, unknown> = await readJson(request, MAX_RUN_BODY_BYTES, RUN_TOO_LARGE_TEXT, UPLOAD_BODY_MS);
    const uploadedBy: string = name(body, "uploadedBy", "Enter your name");
    const csv: unknown = body["csv"];
    if (typeof csv !== "string") {
      throw new HttpError(400, "Choose a CSV file");
    }
    const parsed: ParsedRunFile = parseRunFile(
      typeof body["fileName"] === "string" ? cleanFileName(body["fileName"]) : "",
      csv,
    );
    if (!parsed.ok) {
      throw new HttpError(400, "PayOnce cannot read this file", {
        problems: parsed.problems.map((problem: FileProblem) => ({ line: problem.line, text: problem.message })),
      });
    }
    let runId: number;
    try {
      runId = await uploadRun(engine, parsed.file, uploadedBy);
    } catch (error: unknown) {
      if (error instanceof WaitingRunError) {
        throw new HttpError(409, error.message, { code: "run-waiting", runId: error.runId });
      }
      if (error instanceof SameFileError) {
        throw new HttpError(409, error.message, { code: "same-file", runId: error.runId });
      }
      if (error instanceof NothingToPayError) {
        throw new HttpError(422, error.message, { code: "nothing-to-pay", rows: checkedRowViews(engine.ledger, error.rows, Date.now()) });
      }
      throw airwallexDown(error) ?? error;
    }
    const view: RunView = runNow(String(runId));
    return { view, notice: checkedNotice(view) };
  }

  // A person's action on a run waits its turn behind any step already running on it.
  async function inRunTurn<T>(runId: number, step: () => Promise<T> | T): Promise<T> {
    try {
      return await agent.run(runKey(runId), step);
    } catch (error: unknown) {
      throw airwallexDown(error) ?? new HttpError(409, error instanceof Error ? error.message : String(error));
    }
  }

  async function approveRunByPerson(request: IncomingMessage, raw: string): Promise<Acted<RunView>> {
    const run: Run = requireRun(raw);
    const body: Record<string, unknown> = await readJson(request);
    const approver: string = name(body, "approver", "Enter the approver's name");
    const approvalId: unknown = body["approvalId"];
    if (typeof approvalId !== "number" || !Number.isInteger(approvalId)) {
      throw new HttpError(400, "Say which approval request is being approved");
    }
    const after: RunApproval = await inRunTurn(run.id, (): RunApproval =>
      approveRun(engine.ledger, engine.approvals, run.id, approver, approvalId),
    );
    if (after.state === "approved") {
      startRelease(run.id);
    }
    const left: number = Math.max(0, after.needed - after.signoffs.length);
    return {
      view: runNow(raw),
      notice: {
        tone: "success",
        text:
          after.state === "approved"
            ? `Pay run ${run.id} approved. PayOnce releases it now.`
            : `Signed off. Request #${after.id} needs ${left} more ${left === 1 ? "approver" : "approvers"}.`,
      },
    };
  }

  async function checkRunAgain(raw: string): Promise<Acted<RunView>> {
    const run: Run = requireRun(raw);
    await inRunTurn(run.id, (): Promise<void> => recheckRun(engine, run.id));
    return { view: runNow(raw), notice: { tone: "success", text: `Pay run ${run.id} checked again.` } };
  }

  async function cancelRunByPerson(request: IncomingMessage, raw: string): Promise<Acted<RunView>> {
    const run: Run = requireRun(raw);
    const body: Record<string, unknown> = await readJson(request);
    const cancelledBy: string = name(body, "cancelledBy", "Enter your name");
    const note: string = text(body, "note");
    if (note === "" || note.length > MAX_FINDING_LENGTH) {
      throw new HttpError(400, "Say why the run is cancelled");
    }
    await inRunTurn(run.id, (): void => cancelRun(engine.ledger, run.id, cancelledBy, note));
    return { view: runNow(raw), notice: { tone: "success", text: `Pay run ${run.id} cancelled. Nothing was sent.` } };
  }

  return [
    { method: "GET", pattern: "/api/runs", handler: ({ response }): void => sendJson(response, 200, list()) },
    {
      method: "POST",
      pattern: "/api/runs",
      handler: async ({ request, response }): Promise<void> => sendJson(response, 201, await uploadRunFile(request)),
    },
    // Before the run's own pattern, which would take it for a run id.
    { method: "GET", pattern: "/api/runs/example.csv", handler: ({ response }): void => sendExample(response) },
    { method: "GET", pattern: "api/runs/:id", handler: ({ response }, id: string): void => sendJson(response, 200, runNow(id)) },
    {
      method: "GET",
      pattern: "api/runs/:id/audit",
      handler: ({ response, url }, id: string): void => sendRunAudit(response, id, url.searchParams.get("format") ?? "json"),
    },
    {
      method: "POST",
      pattern: "api/runs/:id/approve",
      handler: async ({ request, response }, id: string): Promise<void> =>
        sendJson(response, 200, await approveRunByPerson(request, id)),
    },
    {
      method: "POST",
      pattern: "api/runs/:id/check",
      handler: async ({ response }, id: string): Promise<void> => sendJson(response, 200, await checkRunAgain(id)),
    },
    {
      method: "POST",
      pattern: "api/runs/:id/cancel",
      handler: async ({ request, response }, id: string): Promise<void> =>
        sendJson(response, 200, await cancelRunByPerson(request, id)),
    },
  ];
}

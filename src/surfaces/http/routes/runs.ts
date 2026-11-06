import type { IncomingMessage, ServerResponse } from "node:http";
import { airwallexAdvice, AirwallexError, AirwallexUnreachableError, withAdvice } from "../../../airwallex/client.js";
import type { RunRowTerms, RunTerms } from "../../../domain/approval.js";
import { feeSeenText } from "../../../domain/arrival.js";
import { runKey } from "../../../domain/patterns.js";
import { outageView, type OutageView } from "../../../outages/outages.js";
import { cleanFileName, MAX_RUN_FILE_CHARS, parseRunFile, type ParsedRunFile } from "../../../runs/run-file.js";
import {
  approveRun,
  cancelRun,
  domainChecks,
  domainText,
  largestTotal,
  recheckRun,
  runBarred,
  runCounts,
  runStatus,
  uploadRun,
  type DomainCheck,
  type RunCash,
} from "../../../runs/runs.js";
import {
  describeBreaks,
  describeRunLedger,
  auditCsv,
  runAuditExport,
  runChainReport,
  runLedgerReport,
  type RunAuditExport,
  type RunAuditSnapshot,
  type RunChainReport,
  type RunLedgerReport,
} from "../../../store/audit-trail.js";
import {
  isExpired,
  NothingToPayError,
  readingSoft,
  SameFileError,
  WaitingRunError,
  type Attempt,
  type Obligation,
  type Outage,
  type Run,
  type RunApproval,
  type RunRow,
  type Signoff,
} from "../../../store/ledger.js";
import { adviceFor, isLive, type AuditSummary, type HttpApp } from "../app.js";
import { HttpError, MAX_FINDING_LENGTH, name, readJson, RUN_ID_PATTERN, sendJson, text, UPLOAD_BODY_MS } from "../http.js";
import type { Route } from "../router.js";
import { capitalise } from "../../../text/printable.js";

// A pay run file travels as a string inside JSON. Its largest, 40,000 characters,
// takes at most 6 bytes a character once escaped, so this always fits it, and
// parseRunFile refuses a longer file by its characters.
const MAX_RUN_BODY_BYTES: number = 256 * 1024;
const RUN_TOO_LARGE_TEXT: string = `The file is too large. A pay run file can be at most ${MAX_RUN_FILE_CHARS.toLocaleString("en-US")} characters`;

// Pay runs: the list, a run's rows and approval, its audit, and a person
// uploading, approving, checking or cancelling one.
export function runRoutes(app: HttpApp): Route[] {
  const { engine, agent, isBusy, isWatching, startRelease } = app;

  function requireRun(raw: string): Run {
    const run: Run | undefined = RUN_ID_PATTERN.test(raw) ? engine.ledger.run(Number(raw)) : undefined;
    if (run === undefined) {
      throw new HttpError(404, `Run ${raw.slice(0, 20)} is not in the ledger`);
    }
    return run;
  }

  function releasedInvoices(run: Run): string[] {
    return engine.ledger
      .runRows(run.id)
      .filter((row: RunRow): boolean => row.state === "released" && row.invoiceId !== null)
      .map((row: RunRow): string => row.invoiceId ?? "");
  }

  // True while the run's own step or any of its invoices is being worked on.
  function runBusy(run: Run): boolean {
    return agent.isBusy(runKey(run.id)) || releasedInvoices(run).some(isBusy);
  }

  function runWatching(run: Run): boolean {
    return releasedInvoices(run).some(isWatching);
  }

  // A list the page polls, so it reads stored JSON soft, as the incident list does.
  function listRuns(): unknown {
    return readingSoft(runList);
  }

  function runList(): unknown {
    return {
      runs: engine.ledger.runs().map((run: Run) => ({
        id: run.id,
        fileName: run.fileName,
        uploadedBy: run.uploadedBy,
        uploadedAt: run.uploadedAt,
        state: run.state,
        status: runStatus(engine.ledger, run),
        counts: runCounts(engine.ledger.runRows(run.id)),
        busy: runBusy(run),
        watching: runWatching(run),
      })),
    };
  }

  // A released row's invoice as the rows card shows it.
  function invoiceSummary(invoiceId: string): unknown {
    const obligation: Obligation | undefined = engine.ledger.obligation(invoiceId);
    if (obligation === undefined) {
      return null;
    }
    return {
      invoiceId,
      state: obligation.state,
      attempts: engine.ledger.attempts(invoiceId).map((attempt: Attempt) => ({
        kind: attempt.kind,
        state: attempt.state,
        reference: attempt.reference,
      })),
      busy: isBusy(invoiceId),
      watching: isWatching(invoiceId),
    };
  }

  function runOutage(terms: RunTerms): OutageView | null {
    for (const row of terms.rows) {
      const outage: Outage | undefined = engine.ledger.activeOutage(row.currency, row.transferMethod);
      if (outage !== undefined) {
        return outageView(engine.ledger, outage);
      }
    }
    return null;
  }

  function runDetail(raw: string): unknown {
    const run: Run = requireRun(raw);
    const rows: RunRow[] = engine.ledger.runRows(run.id);
    const approval: RunApproval | undefined = engine.ledger.latestRunApproval(run.id);
    const terms: RunTerms | null =
      approval === undefined ? null : (JSON.parse(approval.terms) as RunTerms);
    return {
      run: {
        id: run.id,
        fileName: run.fileName,
        fileHash: run.fileHash,
        columns: run.columns,
        uploadedBy: run.uploadedBy,
        uploadedAt: run.uploadedAt,
        state: run.state,
        checkedAt: run.checkedAt,
        releasedAt: run.releasedAt,
        cancelledBy: run.cancelledBy,
        cancelNote: run.cancelNote,
      },
      status: runStatus(engine.ledger, run),
      counts: runCounts(rows),
      rows: rows.map((row: RunRow) => ({
        ...row,
        // The fee PayOnce last saw by the row's method in its currency, as an estimate.
        feeSeen:
          row.arrival === null || row.currency === null
            ? null
            : feeSeenText(engine.ledger, row.currency, row.arrival.method),
        arrivalAdvice: row.arrival === null ? null : adviceFor(row.arrival, run.state === "waiting"),
        invoice:
          row.state === "released" && row.invoiceId !== null ? invoiceSummary(row.invoiceId) : null,
      })),
      cash: JSON.parse(run.cash) as RunCash[],
      approval:
        approval === undefined || terms === null
          ? null
          : {
              id: approval.id,
              state: approval.state,
              approver: approval.approver,
              terms,
              // How the page words each estimate the terms carry, kept out of them.
              arrivalAdvice: terms.rows.flatMap((row: RunRowTerms) =>
                row.arrival === undefined
                  ? []
                  : [
                      {
                        line: row.line,
                        invoiceId: row.invoiceId,
                        advice: adviceFor(row.arrival, run.state === "waiting" && isLive(approval)),
                      },
                    ],
              ),
              needed: approval.needed,
              neededWhy: approval.neededWhy,
              signoffs: approval.signoffs.map((signoff: Signoff) => ({
                approver: signoff.approver,
                at: signoff.at,
              })),
              expiresAt: approval.expiresAt,
              expired: isExpired(approval),
              barred: runBarred(engine.ledger, terms),
              largest: largestTotal(terms),
              domains: domainChecks(engine.ledger, terms).map((check: DomainCheck) => ({
                ...check,
                changed: check.caution,
                text: domainText(check),
              })),
            },
      // A waiting run is released whole, so an active outage on any of its pay rows'
      // rails holds all of it, as the board says. The first one found, or null.
      outage: run.state === "waiting" && terms !== null ? runOutage(terms) : null,
      events: engine.ledger.runEvents(run.id),
      audit: runAuditSummary(run.id),
      busy: runBusy(run),
      watching: runWatching(run),
    };
  }

  // The same for a pay run's timeline.
  function runAuditSummary(runId: number): AuditSummary {
    const snapshot: RunAuditSnapshot = engine.ledger.runAuditSnapshot(runId);
    const report: RunChainReport = runChainReport(runId, snapshot.events);
    const ledger: RunLedgerReport = runLedgerReport(snapshot);
    const problem: string | null =
      describeBreaks(report.breaks) ?? (ledger.intact ? null : describeRunLedger(ledger));
    return {
      lines: report.lines,
      problem: problem === null ? null : capitalise(problem),
    };
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

  // The page sends the file's text inside JSON, so the guard's Origin and content
  // type checks cover an upload too, and nothing parses multipart. The checks are a
  // handful of Airwallex GETs, so the answer waits for them.
  async function uploadRunFile(request: IncomingMessage): Promise<unknown> {
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
      throw new HttpError(400, "PayOnce cannot read this file", { problems: parsed.problems });
    }
    try {
      return { runId: await uploadRun(engine, parsed.file, uploadedBy) };
    } catch (error: unknown) {
      if (error instanceof WaitingRunError || error instanceof SameFileError) {
        throw new HttpError(409, error.message, { runId: error.runId });
      }
      if (error instanceof NothingToPayError) {
        throw new HttpError(422, error.message, { rows: error.rows });
      }
      throw airwallexDown(error) ?? error;
    }
  }

  // A person's action on a run waits its turn behind any step already running on it.
  async function inRunTurn<T>(runId: number, step: () => Promise<T> | T): Promise<T> {
    try {
      return await agent.run(runKey(runId), step);
    } catch (error: unknown) {
      throw airwallexDown(error) ?? new HttpError(409, error instanceof Error ? error.message : String(error));
    }
  }

  async function approveRunByPerson(request: IncomingMessage, raw: string): Promise<unknown> {
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
    return { ok: true, approved: after.state === "approved" };
  }

  async function checkRunAgain(raw: string): Promise<unknown> {
    const run: Run = requireRun(raw);
    await inRunTurn(run.id, (): Promise<void> => recheckRun(engine, run.id));
    return { ok: true };
  }

  async function cancelRunByPerson(request: IncomingMessage, raw: string): Promise<unknown> {
    const run: Run = requireRun(raw);
    const body: Record<string, unknown> = await readJson(request);
    const cancelledBy: string = name(body, "cancelledBy", "Enter your name");
    const note: string = text(body, "note");
    if (note === "" || note.length > MAX_FINDING_LENGTH) {
      throw new HttpError(400, "Say why the run is cancelled");
    }
    await inRunTurn(run.id, (): void => cancelRun(engine.ledger, run.id, cancelledBy, note));
    return { ok: true };
  }

  return [
    { method: "GET", pattern: "/api/runs", handler: ({ response }): void => sendJson(response, 200, listRuns()) },
    {
      method: "POST",
      pattern: "/api/runs",
      handler: async ({ request, response }): Promise<void> => sendJson(response, 201, await uploadRunFile(request)),
    },
    { method: "GET", pattern: "api/runs/:id", handler: ({ response }, id: string): void => sendJson(response, 200, runDetail(id)) },
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

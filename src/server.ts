import { readFileSync, readdirSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname } from "node:path";
import { BalanceCache } from "./airwallex/balances.js";
import { AirwallexClient, AirwallexError, AirwallexUnreachableError } from "./airwallex/client.js";
import { subscribe } from "./airwallex/webhooks.js";
import type { ApprovalTerms, RunTerms } from "./approval.js";
import { describePolicy, policyFromEnv, type Approver, type Barred } from "./approvers.js";
import {
  auditCsv,
  auditExport,
  chainReport,
  describeBreaks,
  describeLedger,
  describeRunLedger,
  ledgerReport,
  runAuditExport,
  runChainReport,
  runLedgerReport,
  type AuditExport,
  type AuditSnapshot,
  type ChainReport,
  type LedgerReport,
  type RunAuditExport,
  type RunAuditSnapshot,
  type RunChainReport,
  type RunLedgerReport,
} from "./audit-trail.js";
import {
  bankChangeForm,
  recordBankChange,
  type BankChangeForm,
  type CallbackInput,
} from "./bank-change.js";
import { cashReport, payRunLines, type CashReport } from "./cash-position.js";
import { Dispatcher } from "./dispatcher.js";
import type { EmailFindings } from "./emails.js";
import {
  approvePayment,
  closeIncident,
  note,
  noteError,
  payAgain,
  pendingApproval,
  pendingClose,
  type Engine,
  type PayAgainResult,
} from "./engine.js";
import { recordMissingFees } from "./payments.js";
import { readerFromEnv } from "./reader.js";
import { describeFloors, reserveFromEnv } from "./reserve.js";
import {
  INVOICE_ID_PATTERN,
  isExpired,
  Ledger,
  LEDGER_PATH,
  NothingToPayError,
  SameFileError,
  WaitingRunError,
  type Approval,
  type Attempt,
  type Obligation,
  type OutsidePayout,
  type Run,
  type RunApproval,
  type RunRow,
  type Signoff,
} from "./ledger.js";
import {
  cleanFileName,
  MAX_RUN_FILE_CHARS,
  MAX_RUN_ROWS,
  parseRunFile,
  RUN_COLUMNS,
  type ParsedRunFile,
} from "./run-file.js";
import {
  approveRun,
  cancelRun,
  largestTotal,
  recheckRun,
  releaseRun,
  runBarred,
  runCounts,
  runKey,
  runNoteError,
  runStatus,
  uploadRun,
  type RunCash,
} from "./runs.js";
import { SANDBOX_OUTCOMES, SandboxBank } from "./sandbox-bank.js";
import {
  DEFAULT_EMAILS,
  DEFAULT_SCENARIO,
  newInvoiceId,
  openScenario,
  runScenario,
  SCENARIOS,
  type ScenarioDef,
} from "./scenario.js";
import { openTunnel, type Tunnel } from "./tunnel.js";
import { Watcher } from "./watcher.js";
import { WEBHOOK_PATH, WebhookReceiver, type WebhookEvent } from "./webhooks.js";

// Local demo server. It binds to loopback only and has no authentication.
const HOST: string = "127.0.0.1";
const PORT: number = Number(process.env["PORT"] ?? 4310);
const WEBHOOK_PORT: number = Number(process.env["WEBHOOK_PORT"] ?? 4311);
const WEBHOOK_API_VERSION: string = process.env["WEBHOOK_API_VERSION"] ?? "2025-06-30";
// How often payments in flight are checked when no webhook can arrive, and when
// webhooks are the main signal and the check is a safety net for a late or lost
// event.
const CHECK_EVERY_MS: number = 3_000;
const CHECK_WITH_WEBHOOKS_MS: number = 15_000;
// How often Airwallex is swept for payouts PayOnce did not send.
const SWEEP_EVERY_MS: number = 30_000;
// How long the cash panel shows a balance before reading it again. The policy
// reads its own, fresh, before any money moves.
const BALANCE_MAX_AGE_MS: number = 30_000;
const SUBSCRIBE_TRIES: number = 3;
const SUBSCRIBE_RETRY_MS: number = 5_000;
const MAX_BODY_BYTES: number = 64 * 1024;
const WEB_DIR: URL = new URL("../web/", import.meta.url);
const EMAILS_DIR: URL = new URL("../fixtures/emails/", import.meta.url);

const MAX_NAME_LENGTH: number = 80;
const MAX_FINDING_LENGTH: number = 200;
const RUN_ID_PATTERN: RegExp = /^[1-9][0-9]{0,9}$/;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

// extra is merged into the error's JSON, such as a file's problems or the run a
// refused upload names.
class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const client: AirwallexClient = AirwallexClient.fromEnv();
const ledger: Ledger = new Ledger(LEDGER_PATH);
// A pay run row's original gets the row's sandbox outcome, kept in the ledger.
const bank: SandboxBank = new SandboxBank(
  client,
  (invoiceId: string, error: unknown): void => noteError(ledger, invoiceId, error),
  (invoiceId: string): string | null => ledger.runRowOf(invoiceId)?.sandboxOutcome ?? null,
);
const engine: Engine = {
  client,
  ledger,
  reader: readerFromEnv(),
  approvals: policyFromEnv(),
  reserve: reserveFromEnv(),
  bank,
};
const agent: Dispatcher = new Dispatcher(engine);

// Starts releasing an approved run in its turn and does not wait for it, because
// the release goes on to send its rows one at a time.
function startRelease(runId: number): void {
  agent
    .run(runKey(runId), (): Promise<void> => releaseRun(engine, agent, runId))
    .catch((error: unknown): void => {
      runNoteError(
        engine.ledger,
        runId,
        error,
        "The run could not be released, and PayOnce tries again in a minute: ",
      );
    });
}

const watcher: Watcher = new Watcher(engine, agent, CHECK_EVERY_MS, SWEEP_EVERY_MS, startRelease);
// After each read it fills in the fees of failed transfers the ledger has none for.
// That writes only fee columns, so it runs outside the invoices' turns.
const balances: BalanceCache = new BalanceCache(
  client,
  BALANCE_MAX_AGE_MS,
  async (): Promise<void> => {
    await recordMissingFees(client, ledger);
  },
);

const ALLOWED_HOSTS: ReadonlySet<string> = new Set<string>([
  `${HOST}:${PORT}`,
  `localhost:${PORT}`,
]);

// The server has no login, so it only answers its own page. The Host check stops
// DNS rebinding. For writes, the Origin check and the JSON content type stop
// another site open in the same browser from starting or approving a payment.
function guard(request: IncomingMessage, method: string): void {
  const host: string = request.headers.host ?? "";
  if (!ALLOWED_HOSTS.has(host)) {
    throw new HttpError(403, "Forbidden");
  }
  if (method === "GET") {
    return;
  }
  const contentType: string = request.headers["content-type"] ?? "";
  if (
    request.headers.origin !== `http://${host}` ||
    !contentType.startsWith("application/json")
  ) {
    throw new HttpError(403, "Forbidden");
  }
}

// True while the agent or the sandbox bank is working on the invoice.
function isBusy(invoiceId: string): boolean {
  return agent.isBusy(invoiceId) || bank.isBusy(invoiceId);
}

// True while a payment is with the bank, so news can arrive at any moment. That
// includes a payout for the invoice sent outside PayOnce.
function isWatching(invoiceId: string): boolean {
  return (
    engine.ledger
      .attempts(invoiceId)
      .some(
        (attempt: Attempt): boolean =>
          attempt.state === "pending" || attempt.state === "in_flight",
      ) ||
    engine.ledger
      .outsidePayouts(invoiceId)
      .some((payout: OutsidePayout): boolean => payout.state === "in_flight")
  );
}

// The default thread comes first, so the form starts on it.
function emailThreads(): string[] {
  return readdirSync(EMAILS_DIR)
    .filter((name: string): boolean => name.endsWith(".json"))
    .map((name: string): string => name.slice(0, -".json".length))
    .sort(
      (a: string, b: string): number =>
        Number(b === DEFAULT_EMAILS) - Number(a === DEFAULT_EMAILS),
    );
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size: number = 0;
  for await (const chunk of request) {
    const buffer: Buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object");
  }
}

// What was running lives in memory, so a restart forgets it. Any invoice with a
// payment still pending or in flight is looked at again, which syncs it with
// Airwallex and never sends a new payment by itself. In the sandbox the bank
// also goes back to paying a replacement it had not finished with, an original
// paid on an approval after a hold, and a pay run row's original, which gets the
// row's sandbox outcome. A released row that never sent is left to the watcher,
// which wakes such rows one at a time.
function pickUpInterrupted(): void {
  for (const obligation of engine.ledger.obligations()) {
    if (
      obligation.state === "settled" ||
      obligation.state === "rejected" ||
      !isWatching(obligation.invoiceId)
    ) {
      continue;
    }
    const latest: Approval | undefined = engine.ledger.latestApproval(obligation.invoiceId);
    const released: boolean =
      obligation.runRowId !== null ||
      (latest?.state === "used" && (JSON.parse(latest.terms) as ApprovalTerms).action === "pay");
    for (const attempt of engine.ledger.attempts(obligation.invoiceId)) {
      if (
        (attempt.kind === "replacement" || released) &&
        attempt.state === "in_flight" &&
        attempt.transferId !== null
      ) {
        bank.sent(obligation.invoiceId, attempt.kind, attempt.transferId);
      }
    }
    agent.wake(obligation.invoiceId);
  }
}

// The events that can change a decision. The rest are only logged.
const DECISIVE_EVENTS: Record<string, string> = {
  "payout.transfer.paid": "has been paid",
  "payout.transfer.failed": "has failed",
  "payout.transfer.cancelled": "was cancelled",
  "payout.transfer.overdue": "is overdue",
};

// A signed event only wakes the agent, which reads the transfer from Airwallex
// itself and decides on that, not on what the event said.
function onWebhook(event: WebhookEvent): void {
  if (!engine.ledger.firstDelivery(event.id, event.name)) {
    return;
  }
  const attempt: Attempt | undefined = engine.ledger.attemptOf(
    event.data.request_id ?? "",
    event.data.id ?? "",
  );
  const reference: string = attempt?.reference ?? event.data.short_reference_id ?? "";
  console.log(`  webhook  ${event.name} ${reference}`);
  const news: string | undefined = DECISIVE_EVENTS[event.name];
  if (news === undefined) {
    return;
  }
  if (attempt === undefined) {
    // A payout already tied to an invoice wakes that invoice. Any other is one
    // the sweep has not seen.
    const invoiceId: string | undefined = engine.ledger.outsideInvoiceOf(
      event.data.id ?? "",
    );
    if (invoiceId === undefined) {
      watcher.sweepSoon();
    } else {
      agent.wake(invoiceId);
    }
    return;
  }
  // A failed transfer is cancelled a few seconds later, and a status check may
  // have got there first. Either way the ledger already has the news.
  if (attempt.state === "paid" || attempt.state === "failed") {
    return;
  }
  note(
    engine.ledger,
    attempt.invoiceId,
    "bank",
    `Webhook from Airwallex: ${attempt.kind} ${reference} ${news}. Checking it`,
  );
  agent.wake(attempt.invoiceId);
}

let tunnel: Tunnel | null = null;

async function subscribeWithRetry(url: string): Promise<string> {
  for (let attempt: number = 1; ; attempt += 1) {
    try {
      return await subscribe(engine.client, url, WEBHOOK_API_VERSION);
    } catch (error: unknown) {
      // A new tunnel address can take a few seconds to resolve.
      if (attempt >= SUBSCRIBE_TRIES) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, SUBSCRIBE_RETRY_MS));
    }
  }
}

// Starts the webhook receiver, gives it a public address and points the Airwallex
// subscription at it. If any step fails, the watcher keeps checking payments
// often enough that nothing waits long.
async function connectWebhooks(): Promise<void> {
  if (process.env["WEBHOOKS"] === "off") {
    console.log("Webhooks are off. Payments in flight are checked every 3 seconds");
    return;
  }
  try {
    const receiver: WebhookReceiver = new WebhookReceiver(onWebhook);
    await receiver.listen(WEBHOOK_PORT);
    let address: string | undefined = process.env["WEBHOOK_URL"];
    if (!address) {
      tunnel = await openTunnel(
        process.env["CLOUDFLARED"] ?? "cloudflared",
        WEBHOOK_PORT,
        (code: number | null): void => {
          tunnel = null;
          watcher.every(CHECK_EVERY_MS);
          console.warn(
            `The webhook tunnel closed (exit ${code}). Payments in flight are checked every 3 seconds`,
          );
        },
      );
      address = tunnel.url;
    }
    const url: string = `${address.replace(/\/+$/, "")}${WEBHOOK_PATH}`;
    receiver.setSecret(await subscribeWithRetry(url));
    watcher.every(CHECK_WITH_WEBHOOKS_MS);
    console.log(`Airwallex webhooks arrive at ${url}`);
  } catch (error: unknown) {
    console.warn(
      `Webhooks are not connected, so payments in flight are checked every 3 seconds: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireObligation(invoiceId: string): Obligation {
  const obligation: Obligation | undefined = INVOICE_ID_PATTERN.test(invoiceId)
    ? engine.ledger.obligation(invoiceId)
    : undefined;
  if (obligation === undefined) {
    throw new HttpError(404, `${invoiceId} is not in the ledger`);
  }
  return obligation;
}

function listIncidents(): unknown {
  return {
    incidents: engine.ledger.obligations().map((obligation: Obligation) => ({
      invoiceId: obligation.invoiceId,
      supplier: obligation.supplier,
      currency: obligation.currency,
      amountMinor: obligation.amountMinor,
      state: obligation.state,
      headline: engine.ledger.events(obligation.invoiceId).at(-1)?.message ?? "",
      busy: isBusy(obligation.invoiceId),
      watching: isWatching(obligation.invoiceId),
      runId: engine.ledger.runRowOf(obligation.invoiceId)?.runId ?? null,
    })),
  };
}

// Whether the invoice's timeline still chains together, for the line under it on
// the page. problem is the first break, or a running hash that is missing or does
// not match.
interface AuditSummary {
  lines: number;
  problem: string | null;
}

function auditSummary(invoiceId: string): AuditSummary {
  const snapshot: AuditSnapshot = engine.ledger.auditSnapshot(invoiceId);
  const report: ChainReport = chainReport(invoiceId, snapshot.events);
  const ledger: LedgerReport = ledgerReport(snapshot);
  const problem: string | null =
    describeBreaks(report.breaks) ?? (ledger.intact ? null : describeLedger(ledger));
  return {
    lines: report.lines,
    problem: problem === null ? null : problem.charAt(0).toUpperCase() + problem.slice(1),
  };
}

// The invoice's timeline with every line's hashes and the result of checking
// them. CSV gives the lines alone, as a file for a spreadsheet, with the result
// in a header.
function sendAudit(response: ServerResponse, invoiceId: string, format: string): void {
  const obligation: Obligation = requireObligation(invoiceId);
  if (format !== "json" && format !== "csv") {
    throw new HttpError(400, "The format is json or csv");
  }
  const audit: AuditExport = auditExport(obligation, engine.ledger.auditSnapshot(invoiceId));
  if (format === "json") {
    sendJson(response, 200, audit);
    return;
  }
  // The invoice number is letters, digits and dashes, so it is safe in a header.
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${invoiceId}-audit.csv"`,
    "X-Audit-Chain": audit.intact ? "intact" : "broken",
  });
  response.end(auditCsv(audit));
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
    problem: problem === null ? null : problem.charAt(0).toUpperCase() + problem.slice(1),
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

function incidentDetail(invoiceId: string): unknown {
  const obligation: Obligation = requireObligation(invoiceId);
  const findings: string | undefined = engine.ledger.findings(invoiceId);
  const approval: Approval | undefined = engine.ledger.latestApproval(invoiceId);
  // The approval card shows who may not approve, and that is the same for any request.
  const barred: Barred[] = pendingApproval(engine.ledger, invoiceId)?.barred ?? [];
  const row: RunRow | undefined = engine.ledger.runRowOf(invoiceId);
  return {
    obligation,
    run: row === undefined ? null : { id: row.runId, line: row.line },
    attempts: engine.ledger.attempts(invoiceId),
    emails: engine.ledger.emails(invoiceId),
    findings: findings === undefined ? null : (JSON.parse(findings) as EmailFindings),
    approval:
      approval === undefined
        ? null
        : {
            id: approval.id,
            state: approval.state,
            approver: approval.approver,
            terms: JSON.parse(approval.terms) as ApprovalTerms,
            needed: approval.needed,
            neededWhy: approval.neededWhy,
            signoffs: approval.signoffs.map((signoff: Signoff) => ({
              approver: signoff.approver,
              at: signoff.at,
            })),
            expiresAt: approval.expiresAt,
            expired: isExpired(approval),
            barred,
          },
    review: pendingClose(engine.ledger, invoiceId) ?? null,
    events: engine.ledger.events(invoiceId),
    audit: auditSummary(invoiceId),
    busy: isBusy(invoiceId),
    watching: isWatching(invoiceId),
  };
}

async function startIncident(request: IncomingMessage): Promise<unknown> {
  const body: Record<string, unknown> = await readJson(request);
  const bankOutcome: unknown = body["bankOutcome"];
  const emailsName: unknown = body["emails"];
  if (typeof bankOutcome !== "string" || !SANDBOX_OUTCOMES.includes(bankOutcome)) {
    throw new HttpError(400, "Unknown bank outcome");
  }
  if (typeof emailsName !== "string" || !emailThreads().includes(emailsName)) {
    throw new HttpError(400, "Unknown email thread");
  }
  const startedBy: string =
    typeof body["startedBy"] === "string" ? body["startedBy"].trim() : "";
  if (startedBy === "" || startedBy.length > MAX_NAME_LENGTH) {
    throw new HttpError(400, "Enter your name");
  }
  const scenarioId: unknown = body["scenario"] ?? DEFAULT_SCENARIO;
  if (
    typeof scenarioId !== "string" ||
    !SCENARIOS.some((scenario: ScenarioDef): boolean => scenario.id === scenarioId)
  ) {
    throw new HttpError(400, "Unknown scenario");
  }

  // The supplier's invoice number when the person gives one, so a second bill
  // under a near-identical number can be caught.
  const given: string = typeof body["invoiceId"] === "string" ? body["invoiceId"].trim() : "";
  if (given !== "" && !INVOICE_ID_PATTERN.test(given)) {
    throw new HttpError(400, "An invoice number has up to 40 letters, digits and dashes");
  }
  if (given !== "" && engine.ledger.obligation(given) !== undefined) {
    throw new HttpError(409, `${given} is already in the ledger, and PayOnce pays an invoice number once`);
  }
  const waitingRow: RunRow | undefined = given === "" ? undefined : engine.ledger.waitingRunRow(given);
  if (waitingRow !== undefined) {
    throw new HttpError(
      409,
      `${given} is on pay run ${waitingRow.runId}, which is waiting for approval, and PayOnce pays an invoice number once`,
    );
  }
  const invoiceId: string = given === "" ? newInvoiceId(engine.ledger) : given;
  const obligation: Obligation = await openScenario(engine, invoiceId, scenarioId, startedBy);
  runScenario(engine, agent, bank, obligation, { bankOutcome, emailsName }).catch(
    (error: unknown): void => noteError(engine.ledger, invoiceId, error),
  );
  return { invoiceId };
}

// A person's action waits its turn behind whatever the agent is doing on the
// invoice, so it never lands in the middle of a step.
async function inTurn<T>(invoiceId: string, step: () => T): Promise<T> {
  try {
    return await agent.run(invoiceId, step);
  } catch (error: unknown) {
    throw new HttpError(409, error instanceof Error ? error.message : String(error));
  }
}

async function approveIncident(
  request: IncomingMessage,
  invoiceId: string,
): Promise<unknown> {
  requireObligation(invoiceId);
  const body: Record<string, unknown> = await readJson(request);
  const approver: string =
    typeof body["approver"] === "string" ? body["approver"].trim() : "";
  if (approver === "" || approver.length > MAX_NAME_LENGTH) {
    throw new HttpError(400, "Enter the approver's name");
  }
  const approvalId: unknown = body["approvalId"];
  if (typeof approvalId !== "number" || !Number.isInteger(approvalId)) {
    throw new HttpError(400, "Say which approval request is being approved");
  }
  await inTurn(invoiceId, (): Approval =>
    approvePayment(engine.ledger, engine.approvals, invoiceId, approver, approvalId),
  );
  agent.wake(invoiceId);
  return { ok: true };
}

// A person closes an escalated incident whose original the bank reports as paid.
// Nothing is sent, so there is no background step to wait for.
async function closeByPerson(
  request: IncomingMessage,
  invoiceId: string,
): Promise<unknown> {
  requireObligation(invoiceId);
  const body: Record<string, unknown> = await readJson(request);
  const closedBy: string =
    typeof body["closedBy"] === "string" ? body["closedBy"].trim() : "";
  if (closedBy === "" || closedBy.length > MAX_NAME_LENGTH) {
    throw new HttpError(400, "Enter your name");
  }
  const finding: string =
    typeof body["finding"] === "string" ? body["finding"].trim() : "";
  if (finding === "" || finding.length > MAX_FINDING_LENGTH) {
    throw new HttpError(400, "Say what you confirmed");
  }
  await inTurn(invoiceId, (): void =>
    closeIncident(engine.ledger, invoiceId, closedBy, finding),
  );
  return { ok: true };
}

// A person asks to pay the invoice again. The lock refuses it while a payment is
// live, and nothing reaches Airwallex either way.
async function payAgainByPerson(invoiceId: string): Promise<PayAgainResult> {
  requireObligation(invoiceId);
  return inTurn(invoiceId, (): PayAgainResult => payAgain(engine.ledger, invoiceId));
}

// What a person needs to record a callback about new bank details: the number on
// file and the fields the supplier's record has.
async function bankDetailsForm(invoiceId: string): Promise<BankChangeForm> {
  return bankChangeForm(engine, requireObligation(invoiceId));
}

function text(body: Record<string, unknown>, field: string): string {
  return typeof body[field] === "string" ? body[field].trim() : "";
}

// A person records calling the supplier back on the number on file, with the new
// bank details the supplier confirmed. PayOnce updates the supplier's record in
// Airwallex, and the agent then looks at the invoice again.
async function bankChangeByPerson(
  request: IncomingMessage,
  invoiceId: string,
): Promise<unknown> {
  requireObligation(invoiceId);
  const body: Record<string, unknown> = await readJson(request);
  const raw: unknown = body["details"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, "Enter the new bank details");
  }
  const details: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      throw new HttpError(400, "Enter the new bank details");
    }
    details[name] = value;
  }
  const input: CallbackInput = {
    calledBy: text(body, "calledBy"),
    numberCalled: text(body, "numberCalled"),
    calledAt: text(body, "calledAt"),
    spokeTo: text(body, "spokeTo"),
    confirmed: text(body, "confirmed"),
    details,
  };
  try {
    await inTurn(invoiceId, (): Promise<void> => recordBankChange(engine, invoiceId, input));
  } finally {
    // A change that failed part way may still have reached the record.
    agent.wake(invoiceId);
  }
  return { ok: true };
}

// The cash panel: balances from the cache, read again when 30 seconds old, and the
// ledger as it is now. It answers at once with whatever the cache holds.
function cash(): CashReport {
  balances.refreshIfOld();
  return cashReport({
    ledger: engine.ledger,
    reserve: engine.reserve,
    balances: balances.latest(),
    statesCheckedAt: watcher.lastCheckedAt,
    payRunLines: payRunLines(engine.ledger),
  });
}

// Has the agent look at an incident again. It cannot send a second live payment,
// and an escalated invoice still needs its approval.
function resume(invoiceId: string): unknown {
  requireObligation(invoiceId);
  agent.wake(invoiceId);
  return { ok: true };
}

// ---------- pay runs ----------

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

function listRuns(): unknown {
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
            needed: approval.needed,
            neededWhy: approval.neededWhy,
            signoffs: approval.signoffs.map((signoff: Signoff) => ({
              approver: signoff.approver,
              at: signoff.at,
            })),
            expiresAt: approval.expiresAt,
            expired: isExpired(approval),
            barred: runBarred(engine.ledger, terms),
            largest: largestTotal(terms.totals),
          },
    events: engine.ledger.runEvents(run.id),
    audit: runAuditSummary(run.id),
    busy: runBusy(run),
    watching: runWatching(run),
  };
}

function name(body: Record<string, unknown>, field: string, missing: string): string {
  const value: string = text(body, field);
  if (value === "" || value.length > MAX_NAME_LENGTH) {
    throw new HttpError(400, missing);
  }
  return value;
}

// An Airwallex read that failed while checking a file is the bank's problem, not
// the file's.
function airwallexDown(error: unknown): HttpError | undefined {
  return error instanceof AirwallexError || error instanceof AirwallexUnreachableError
    ? new HttpError(502, `Airwallex could not be read, so the file was not checked: ${error.message}`)
    : undefined;
}

// The page sends the file's text inside JSON, so the guard's Origin and content
// type checks cover an upload too, and nothing parses multipart. The checks are a
// handful of Airwallex GETs, so the answer waits for them.
async function uploadRunFile(request: IncomingMessage): Promise<unknown> {
  const body: Record<string, unknown> = await readJson(request);
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

// Only files that exist directly in web/ are served, so a path cannot leave it.
function serveStatic(response: ServerResponse, pathname: string): void {
  const name: string = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!readdirSync(WEB_DIR).includes(name)) {
    throw new HttpError(404, "Not found");
  }
  // Read before any header goes out, so a failed read can still become an error
  // response.
  const content: Buffer = readFileSync(new URL(name, WEB_DIR));
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(name)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  response.end(content);
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method: string = request.method ?? "GET";
  const url: URL = new URL(request.url ?? "/", `http://${HOST}`);
  const pathname: string = url.pathname;
  const parts: string[] = pathname.split("/").filter(Boolean);
  guard(request, method);

  if (parts[0] !== "api") {
    if (method !== "GET") {
      throw new HttpError(405, "Method not allowed");
    }
    serveStatic(response, pathname);
    return;
  }

  const invoiceId: string | undefined = parts[2];
  if (method === "GET" && pathname === "/api/options") {
    sendJson(response, 200, {
      bankOutcomes: SANDBOX_OUTCOMES,
      emailThreads: emailThreads(),
      runColumns: RUN_COLUMNS,
      sandboxOutcomes: SANDBOX_OUTCOMES,
      maxRunRows: MAX_RUN_ROWS,
      maxRunFileChars: MAX_RUN_FILE_CHARS,
      approvers: engine.approvals.approvers.map((approver: Approver) => ({
        name: approver.name,
        limitMinor: approver.limitMinor,
      })),
      approvalPolicy: {
        twoApproversAboveMinor: engine.approvals.twoApproversAboveMinor,
        expiresAfterMinutes: engine.approvals.expiresAfterMs / 60_000,
        problem: engine.approvals.problem,
      },
      scenarios: SCENARIOS.map((scenario: ScenarioDef) => ({
        id: scenario.id,
        label: scenario.label,
      })),
    });
  } else if (method === "GET" && pathname === "/api/cash") {
    sendJson(response, 200, cash());
  } else if (method === "GET" && pathname === "/api/runs") {
    sendJson(response, 200, listRuns());
  } else if (method === "POST" && pathname === "/api/runs") {
    sendJson(response, 201, await uploadRunFile(request));
  } else if (parts[1] === "runs" && parts[2] !== undefined) {
    const runId: string = parts[2];
    if (method === "GET" && parts.length === 3) {
      sendJson(response, 200, runDetail(runId));
    } else if (method === "GET" && parts[3] === "audit" && parts.length === 4) {
      sendRunAudit(response, runId, url.searchParams.get("format") ?? "json");
    } else if (method === "POST" && parts[3] === "approve" && parts.length === 4) {
      sendJson(response, 200, await approveRunByPerson(request, runId));
    } else if (method === "POST" && parts[3] === "check" && parts.length === 4) {
      sendJson(response, 200, await checkRunAgain(runId));
    } else if (method === "POST" && parts[3] === "cancel" && parts.length === 4) {
      sendJson(response, 200, await cancelRunByPerson(request, runId));
    } else {
      throw new HttpError(404, "Not found");
    }
  } else if (method === "GET" && pathname === "/api/incidents") {
    sendJson(response, 200, listIncidents());
  } else if (method === "POST" && pathname === "/api/incidents") {
    sendJson(response, 202, await startIncident(request));
  } else if (
    method === "GET" &&
    parts[1] === "incidents" &&
    invoiceId !== undefined &&
    parts.length === 3
  ) {
    sendJson(response, 200, incidentDetail(invoiceId));
  } else if (
    method === "GET" &&
    parts[1] === "incidents" &&
    invoiceId !== undefined &&
    parts[3] === "audit" &&
    parts.length === 4
  ) {
    sendAudit(response, invoiceId, url.searchParams.get("format") ?? "json");
  } else if (
    method === "POST" &&
    parts[1] === "incidents" &&
    invoiceId !== undefined &&
    parts[3] === "approve" &&
    parts.length === 4
  ) {
    sendJson(response, 200, await approveIncident(request, invoiceId));
  } else if (
    method === "POST" &&
    parts[1] === "incidents" &&
    invoiceId !== undefined &&
    parts[3] === "close" &&
    parts.length === 4
  ) {
    sendJson(response, 200, await closeByPerson(request, invoiceId));
  } else if (
    method === "POST" &&
    parts[1] === "incidents" &&
    invoiceId !== undefined &&
    parts[3] === "resume" &&
    parts.length === 4
  ) {
    sendJson(response, 200, resume(invoiceId));
  } else if (
    method === "POST" &&
    parts[1] === "incidents" &&
    invoiceId !== undefined &&
    parts[3] === "pay-again" &&
    parts.length === 4
  ) {
    sendJson(response, 200, await payAgainByPerson(invoiceId));
  } else if (
    method === "GET" &&
    parts[1] === "incidents" &&
    invoiceId !== undefined &&
    parts[3] === "bank-details" &&
    parts.length === 4
  ) {
    sendJson(response, 200, await bankDetailsForm(invoiceId));
  } else if (
    method === "POST" &&
    parts[1] === "incidents" &&
    invoiceId !== undefined &&
    parts[3] === "bank-change" &&
    parts.length === 4
  ) {
    sendJson(response, 200, await bankChangeByPerson(request, invoiceId));
  } else {
    throw new HttpError(404, "Not found");
  }
}

const server: Server = createServer(
  (request: IncomingMessage, response: ServerResponse): void => {
    route(request, response).catch((error: unknown): void => {
      const status: number = error instanceof HttpError ? error.status : 500;
      const message: string = error instanceof Error ? error.message : String(error);
      if (status === 500) {
        console.error(error);
      }
      if (response.headersSent) {
        response.end();
        return;
      }
      sendJson(response, status, {
        error: message,
        ...(error instanceof HttpError ? error.extra : {}),
      });
    });
  },
);

// One failed step must not take the server, and every other incident, down with it.
process.on("unhandledRejection", (reason: unknown): void => {
  console.error("Unhandled rejection:", reason);
});

process.on("exit", (): void => {
  tunnel?.stop();
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, (): void => {
    process.exit(0);
  });
}

server.listen(PORT, HOST, (): void => {
  console.log(`PayOnce is at http://${HOST}:${PORT} (sandbox only, no real money)`);
  console.log(`Supplier emails are read by: ${engine.reader.name}`);
  console.log(describePolicy(engine.approvals));
  console.log(describeFloors(engine.reserve));
  // The first page load then has balances to show.
  balances.refreshIfOld();
  pickUpInterrupted();
  watcher.start();
  void connectWebhooks();
});

import { readFileSync, readdirSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname } from "node:path";
import { AirwallexClient } from "./airwallex/client.js";
import { subscribe } from "./airwallex/webhooks.js";
import type { ApprovalTerms } from "./approval.js";
import { Dispatcher } from "./dispatcher.js";
import type { EmailFindings } from "./emails.js";
import {
  approveReplacement,
  closeIncident,
  note,
  noteError,
  pendingClose,
  type Engine,
} from "./engine.js";
import { readerFromEnv } from "./reader.js";
import {
  Ledger,
  LEDGER_PATH,
  type Approval,
  type Attempt,
  type Obligation,
} from "./ledger.js";
import { PAID_OUTCOME, SandboxBank } from "./sandbox-bank.js";
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
const SUBSCRIBE_TRIES: number = 3;
const SUBSCRIBE_RETRY_MS: number = 5_000;
const MAX_BODY_BYTES: number = 64 * 1024;
const WEB_DIR: URL = new URL("../web/", import.meta.url);
const EMAILS_DIR: URL = new URL("../fixtures/emails/", import.meta.url);
const INVOICE_PATTERN: RegExp = /^[A-Za-z0-9-]{1,40}$/;

const MAX_NAME_LENGTH: number = 80;
const MAX_FINDING_LENGTH: number = 200;

// What the scripted bank can do to the original: fail it one of these ways, or
// pay it.
const BANK_OUTCOMES: string[] = [
  "CHANNEL_TIMEOUT",
  "SYSTEM_ERROR",
  "BENEFICIARY_BANK_RETURNED",
  "ACCOUNT_CLOSED",
  "INVALID_ACCOUNT_NAME_OR_NUMBER",
  PAID_OUTCOME,
];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const client: AirwallexClient = AirwallexClient.fromEnv();
const ledger: Ledger = new Ledger(LEDGER_PATH);
const bank: SandboxBank = new SandboxBank(
  client,
  (invoiceId: string, error: unknown): void => noteError(ledger, invoiceId, error),
);
const engine: Engine = { client, ledger, reader: readerFromEnv(), bank };
const agent: Dispatcher = new Dispatcher(engine);
const watcher: Watcher = new Watcher(engine, agent, CHECK_EVERY_MS);

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

// True while a payment is with the bank, so news can arrive at any moment.
function isWatching(invoiceId: string): boolean {
  return engine.ledger
    .attempts(invoiceId)
    .some(
      (attempt: Attempt): boolean =>
        attempt.state === "pending" || attempt.state === "in_flight",
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
// also goes back to paying a replacement it had not finished with.
function pickUpInterrupted(): void {
  for (const obligation of engine.ledger.obligations()) {
    if (obligation.state === "settled" || !isWatching(obligation.invoiceId)) {
      continue;
    }
    for (const attempt of engine.ledger.attempts(obligation.invoiceId)) {
      if (
        attempt.kind === "replacement" &&
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
  // A failed transfer is cancelled a few seconds later, and a status check may
  // have got there first. Either way the ledger already has the news.
  if (
    attempt === undefined ||
    news === undefined ||
    attempt.state === "paid" ||
    attempt.state === "failed"
  ) {
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
  const obligation: Obligation | undefined = INVOICE_PATTERN.test(invoiceId)
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
    })),
  };
}

function incidentDetail(invoiceId: string): unknown {
  const obligation: Obligation = requireObligation(invoiceId);
  const findings: string | undefined = engine.ledger.findings(invoiceId);
  const approval: Approval | undefined = engine.ledger.latestApproval(invoiceId);
  return {
    obligation,
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
          },
    review: pendingClose(engine.ledger, invoiceId) ?? null,
    events: engine.ledger.events(invoiceId),
    busy: isBusy(invoiceId),
    watching: isWatching(invoiceId),
  };
}

async function startIncident(request: IncomingMessage): Promise<unknown> {
  const body: Record<string, unknown> = await readJson(request);
  const bankOutcome: unknown = body["bankOutcome"];
  const emailsName: unknown = body["emails"];
  if (typeof bankOutcome !== "string" || !BANK_OUTCOMES.includes(bankOutcome)) {
    throw new HttpError(400, "Unknown bank outcome");
  }
  if (typeof emailsName !== "string" || !emailThreads().includes(emailsName)) {
    throw new HttpError(400, "Unknown email thread");
  }
  const scenarioId: unknown = body["scenario"] ?? DEFAULT_SCENARIO;
  if (
    typeof scenarioId !== "string" ||
    !SCENARIOS.some((scenario: ScenarioDef): boolean => scenario.id === scenarioId)
  ) {
    throw new HttpError(400, "Unknown scenario");
  }

  const invoiceId: string = newInvoiceId(engine.ledger);
  const obligation: Obligation = await openScenario(engine, invoiceId, scenarioId);
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
  await inTurn(invoiceId, (): ApprovalTerms =>
    approveReplacement(engine.ledger, invoiceId, approver, approvalId),
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

// Has the agent look at an incident again. It cannot send a second live payment,
// and an escalated invoice still needs its approval.
function resume(invoiceId: string): unknown {
  requireObligation(invoiceId);
  agent.wake(invoiceId);
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
  const pathname: string = new URL(request.url ?? "/", `http://${HOST}`).pathname;
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
      bankOutcomes: BANK_OUTCOMES,
      emailThreads: emailThreads(),
      scenarios: SCENARIOS.map((scenario: ScenarioDef) => ({
        id: scenario.id,
        label: scenario.label,
      })),
    });
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
      sendJson(response, status, { error: message });
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
  pickUpInterrupted();
  watcher.start();
  void connectWebhooks();
});

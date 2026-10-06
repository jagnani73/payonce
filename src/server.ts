import { readFileSync, readdirSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname } from "node:path";
import { AirwallexClient } from "./airwallex/client.js";
import type { ApprovalTerms } from "./approval.js";
import type { EmailFindings } from "./emails.js";
import {
  approveReplacement,
  DEFAULT_SCENARIO,
  newInvoiceId,
  noteError,
  openScenario,
  resumeIncident,
  runScenario,
  SCENARIOS,
  type Engine,
  type ScenarioDef,
} from "./engine.js";
import { KeywordReader } from "./keyword-reader.js";
import {
  Ledger,
  LEDGER_PATH,
  type Approval,
  type Attempt,
  type Obligation,
} from "./ledger.js";

// Local demo server. It binds to loopback only and has no authentication.
const HOST: string = "127.0.0.1";
const PORT: number = Number(process.env["PORT"] ?? 4310);
const MAX_BODY_BYTES: number = 64 * 1024;
const WEB_DIR: URL = new URL("../web/", import.meta.url);
const EMAILS_DIR: URL = new URL("../fixtures/emails/", import.meta.url);
const INVOICE_PATTERN: RegExp = /^[A-Za-z0-9-]{1,40}$/;

const FAILURE_TYPES: string[] = [
  "CHANNEL_TIMEOUT",
  "SYSTEM_ERROR",
  "BENEFICIARY_BANK_RETURNED",
  "ACCOUNT_CLOSED",
  "INVALID_ACCOUNT_NAME_OR_NUMBER",
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

const engine: Engine = {
  client: AirwallexClient.fromEnv(),
  ledger: new Ledger(LEDGER_PATH),
  reader: new KeywordReader(),
};

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

// Invoices with a step still running in the background.
const busy: Set<string> = new Set<string>();

function emailThreads(): string[] {
  return readdirSync(EMAILS_DIR)
    .filter((name: string): boolean => name.endsWith(".json"))
    .map((name: string): string => name.slice(0, -".json".length));
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

function runInBackground(invoiceId: string, task: () => Promise<void>): void {
  busy.add(invoiceId);
  task()
    .catch((error: unknown): void => {
      noteError(engine.ledger, invoiceId, error);
    })
    .finally((): void => {
      busy.delete(invoiceId);
    });
}

// The busy set lives in memory, so a restart forgets what was running. Any
// invoice with a payment still pending or in flight is picked up again, which
// syncs it with Airwallex and never sends a new payment by itself.
function pickUpInterrupted(): void {
  for (const obligation of engine.ledger.obligations()) {
    const unfinished: boolean = engine.ledger
      .attempts(obligation.invoiceId)
      .some(
        (attempt: Attempt): boolean =>
          attempt.state === "pending" || attempt.state === "in_flight",
      );
    if (unfinished && obligation.state !== "settled") {
      runInBackground(obligation.invoiceId, (): Promise<void> =>
        resumeIncident(engine, obligation.invoiceId),
      );
    }
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
      busy: busy.has(obligation.invoiceId),
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
    events: engine.ledger.events(invoiceId),
    busy: busy.has(invoiceId),
  };
}

async function startIncident(request: IncomingMessage): Promise<unknown> {
  const body: Record<string, unknown> = await readJson(request);
  const failureType: unknown = body["failureType"];
  const emailsName: unknown = body["emails"];
  if (typeof failureType !== "string" || !FAILURE_TYPES.includes(failureType)) {
    throw new HttpError(400, "Unknown failure type");
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
  runInBackground(invoiceId, (): Promise<void> =>
    runScenario(engine, obligation, { failureType, emailsName }),
  );
  return { invoiceId };
}

async function approveIncident(
  request: IncomingMessage,
  invoiceId: string,
): Promise<unknown> {
  requireObligation(invoiceId);
  const body: Record<string, unknown> = await readJson(request);
  const approver: string =
    typeof body["approver"] === "string" ? body["approver"].trim() : "";
  if (approver === "" || approver.length > 80) {
    throw new HttpError(400, "Enter the approver's name");
  }
  const approvalId: unknown = body["approvalId"];
  if (typeof approvalId !== "number" || !Number.isInteger(approvalId)) {
    throw new HttpError(400, "Say which approval request is being approved");
  }
  if (busy.has(invoiceId)) {
    throw new HttpError(409, `${invoiceId} is still being worked on`);
  }
  try {
    approveReplacement(engine.ledger, invoiceId, approver, approvalId);
  } catch (error: unknown) {
    throw new HttpError(409, error instanceof Error ? error.message : String(error));
  }
  runInBackground(invoiceId, (): Promise<void> => resumeIncident(engine, invoiceId));
  return { ok: true };
}

// Continues an incident that stopped part-way. It cannot send a second live
// payment, and an escalated invoice still needs its approval.
function resume(invoiceId: string): unknown {
  requireObligation(invoiceId);
  if (busy.has(invoiceId)) {
    throw new HttpError(409, `${invoiceId} is still being worked on`);
  }
  runInBackground(invoiceId, (): Promise<void> => resumeIncident(engine, invoiceId));
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
      failureTypes: FAILURE_TYPES,
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

server.listen(PORT, HOST, (): void => {
  console.log(`PayOnce is at http://${HOST}:${PORT} (sandbox only, no real money)`);
  pickUpInterrupted();
});

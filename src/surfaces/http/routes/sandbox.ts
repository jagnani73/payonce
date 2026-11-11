import type { IncomingMessage } from "node:http";
import { airwallexAdvice, AirwallexError, AirwallexUnreachableError } from "../../../airwallex/client.js";
import { dueDateProblem } from "../../../domain/arrival.js";
import { noteError } from "../../../engine/lines.js";
import { payAgain, type PayAgainResult } from "../../../engine/person.js";
import {
  DEFAULT_EMAILS,
  DEFAULT_SCENARIO,
  newInvoiceId,
  openScenario,
  runScenario,
  SCENARIOS,
  type ScenarioDef,
} from "../../../engine/scenario.js";
import { INVOICE_ID_PATTERN, type Obligation, type RunRow } from "../../../store/ledger.js";
import { SANDBOX_OUTCOMES } from "../../../text/words.js";
import type { DuplicateLockResult, PaymentCreated } from "../../../views/contract.js";
import { sandboxView, threadLabel, type SandboxScenarios } from "../../../views/sandbox.js";
import type { HttpApp } from "../app.js";
import { HttpError, name, readJson, sendJson } from "../http.js";
import type { Route } from "../router.js";

const SCRIPTED: SandboxScenarios = { scenarios: SCENARIOS, defaultScenario: DEFAULT_SCENARIO, defaultEmails: DEFAULT_EMAILS };

// The sandbox simulator: a scripted incident, which plays the bank and the
// supplier's emails, and the duplicate lock test. PayOnce only ever runs against
// the sandbox, so pnpm ui always serves them.
export function sandboxRoutes(app: HttpApp): Route[] {
  const { engine, agent, bank, requireObligation, incident, inTurn, emailThreads, dailyCap } = app;

  async function startScenario(request: IncomingMessage): Promise<PaymentCreated> {
    const body: Record<string, unknown> = await readJson(request);
    const bankOutcome: unknown = body["bankOutcome"];
    const emailsName: unknown = body["emails"];
    if (typeof bankOutcome !== "string" || !SANDBOX_OUTCOMES.includes(bankOutcome)) {
      throw new HttpError(400, "Unknown bank outcome");
    }
    if (typeof emailsName !== "string" || !emailThreads().includes(emailsName)) {
      throw new HttpError(400, "Unknown email thread");
    }
    const startedBy: string = name(body, "startedBy", "Enter your name");
    const scenarioId: unknown = body["scenario"] ?? DEFAULT_SCENARIO;
    if (
      typeof scenarioId !== "string" ||
      !SCENARIOS.some((scenario: ScenarioDef): boolean => scenario.id === scenarioId)
    ) {
      throw new HttpError(400, "Unknown scenario");
    }
    // Optional. A date in the past is taken, and the arrival estimates say it has
    // passed.
    if (body["dueDate"] !== undefined && body["dueDate"] !== null && typeof body["dueDate"] !== "string") {
      throw new HttpError(400, "The due date is not a date written like 2026-11-02");
    }
    const dueDate: string = typeof body["dueDate"] === "string" ? body["dueDate"].trim() : "";
    const badDue: string | null = dueDate === "" ? null : dueDateProblem(dueDate);
    if (badDue !== null) {
      throw new HttpError(400, badDue);
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
    let obligation: Obligation;
    try {
      obligation = await dailyCap.starting(
        (): Promise<Obligation> => openScenario(engine, invoiceId, scenarioId, startedBy, dueDate === "" ? null : dueDate),
      );
    } catch (error: unknown) {
      // Airwallex is read before the invoice is written, so nothing is stored. The
      // person reads PayOnce's words first and Airwallex's after them.
      if (error instanceof AirwallexUnreachableError || error instanceof AirwallexError) {
        const what: string =
          error instanceof AirwallexUnreachableError ? "Airwallex could not be reached" : "Airwallex answered with an error";
        const advice: string = airwallexAdvice(error);
        throw new HttpError(502, `${what}, so nothing was sent or stored.${advice === "" ? "" : ` ${advice}`} ${error.message}`);
      }
      throw error;
    }
    runScenario(engine, agent, bank, obligation, { bankOutcome, emailsName }).catch(
      (error: unknown): void => noteError(engine.ledger, invoiceId, error),
    );
    return {
      invoiceId,
      view: incident(invoiceId),
      notice: {
        tone: "success",
        text: `${invoiceId} started. Its first payment waits for approval. Once someone approves it, the simulator plays ${bankOutcome} and the "${threadLabel(emailsName)}" emails.`,
      },
    };
  }

  // A person asks the ledger to open a second live payment. The lock refuses it
  // while a payment is live, and nothing reaches Airwallex either way.
  async function duplicateLock(invoiceId: string): Promise<DuplicateLockResult> {
    requireObligation(invoiceId);
    const result: PayAgainResult = await inTurn(invoiceId, (): PayAgainResult => payAgain(engine.ledger, invoiceId));
    return { refused: result.refused, text: result.message, view: incident(invoiceId) };
  }

  return [
    {
      method: "GET",
      pattern: "/api/sandbox",
      handler: ({ response }): void => sendJson(response, 200, sandboxView(SCRIPTED, emailThreads())),
    },
    {
      method: "POST",
      pattern: "/api/sandbox/scenarios",
      handler: async ({ request, response }): Promise<void> => sendJson(response, 202, await startScenario(request)),
    },
    {
      method: "POST",
      pattern: "api/sandbox/duplicate-lock/:id",
      handler: async ({ response }, id: string): Promise<void> => sendJson(response, 200, await duplicateLock(id)),
    },
  ];
}

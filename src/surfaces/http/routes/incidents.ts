import type { IncomingMessage, ServerResponse } from "node:http";
import { airwallexAdvice, AirwallexError, AirwallexUnreachableError } from "../../../airwallex/client.js";
import type { ApprovalTerms } from "../../../domain/approval.js";
import { dueDateProblem } from "../../../domain/arrival.js";
import type { Barred } from "../../../domain/approvers.js";
import { isExpired } from "../../../domain/live.js";
import { bankChangeForm, recordBankChange, type BankChangeForm, type CallbackInput } from "../../../engine/bank-change.js";
import { noteError } from "../../../engine/lines.js";
import {
  approvePayment,
  closeIncident,
  payAgain,
  pendingApproval,
  pendingClose,
  type PayAgainResult,
} from "../../../engine/person.js";
import { DEFAULT_SCENARIO, newInvoiceId, openScenario, runScenario, SCENARIOS, type ScenarioDef } from "../../../engine/scenario.js";
import { noteTexts } from "../../../intake/eml.js";
import { outageView } from "../../../outages/outages.js";
import { outboxOf } from "../../../outbox/drafts.js";
import type { EmailFindings, SupplierEmail } from "../../../reader/emails.js";
import {
  auditCsv,
  auditExport,
  chainReport,
  describeBreaks,
  describeLedger,
  type AuditExport,
  type ChainReport,
  type LedgerReport,
} from "../../../store/audit-trail.js";
import {
  INVOICE_ID_PATTERN,
  readingSoft,
  type Approval,
  type Obligation,
  type Outage,
  type RunRow,
  type Signoff,
} from "../../../store/ledger.js";
import { SANDBOX_OUTCOMES } from "../../../text/words.js";
import { boardGroups, type BoardGroupOf } from "../../../views/incident-board.js";
import { adviceFor, isLive, type AuditSummary, type HttpApp } from "../app.js";
import { HttpError, MAX_FINDING_LENGTH, name, readJson, sendJson, text } from "../http.js";
import type { Route } from "../router.js";
import { capitalise } from "../../../text/printable.js";

// The transfers a close card can cover, one per attempt at most.
const MAX_COVERED: number = 50;
const MAX_TRANSFER_ID_LENGTH: number = 64;

// The incident list, one incident, its audit, starting one, and a person
// approving, closing, paying again, recording a callback or asking for a look.
export function incidentRoutes(app: HttpApp): Route[] {
  const { engine, agent, bank, isBusy, isWatching, watchedInvoices, requireObligation, inTurn, emailThreads } = app;

  // The page polls this, so it reads the ledger a few times in all, never once per
  // invoice. The headline says how the incident stands: the board's reason for an
  // open invoice, and otherwise the latest decision, close or standing line, never
  // an error, an email or a message draft. A view, so it reads stored JSON soft.
  function listIncidents(): unknown {
    return readingSoft(incidentList);
  }

  function incidentList(): unknown {
    const groups: Map<string, BoardGroupOf> = boardGroups(engine.ledger);
    const headlines: Map<string, string> = engine.ledger.headlines();
    const runs: Map<string, number> = engine.ledger.runIdsByInvoice();
    const watched: Set<string> = watchedInvoices();
    return {
      incidents: engine.ledger.obligations().map((obligation: Obligation) => {
        const group: BoardGroupOf | undefined = groups.get(obligation.invoiceId);
        return {
          invoiceId: obligation.invoiceId,
          supplier: obligation.supplier,
          currency: obligation.currency,
          amountMinor: obligation.amountMinor,
          state: obligation.state,
          headline: group?.why ?? headlines.get(obligation.invoiceId) ?? "",
          busy: isBusy(obligation.invoiceId),
          watching: watched.has(obligation.invoiceId),
          runId: runs.get(obligation.invoiceId) ?? null,
          board: group === undefined ? null : { group: group.group, label: group.label },
        };
      }),
    };
  }

  // The page polls an incident, so the running hash is checked by runningHashCheck,
  // which hashes only the lines added since its last check and every line once a
  // minute. The audit export and pnpm run audit hash every line every time.
  function auditSummary(invoiceId: string): AuditSummary {
    const report: ChainReport = chainReport(invoiceId, engine.ledger.chainedEvents(invoiceId));
    const ledger: LedgerReport = engine.ledger.runningHashCheck();
    const problem: string | null =
      describeBreaks(report.breaks) ?? (ledger.intact ? null : describeLedger(ledger));
    return {
      lines: report.lines,
      problem: problem === null ? null : capitalise(problem),
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

  function incidentDetail(invoiceId: string): unknown {
    const obligation: Obligation = requireObligation(invoiceId);
    const findings: string | undefined = engine.ledger.findings(invoiceId);
    const approval: Approval | undefined = engine.ledger.latestApproval(invoiceId);
    // The approval card shows who may not approve, and that is the same for any request.
    const barred: Barred[] = pendingApproval(engine.ledger, invoiceId)?.barred ?? [];
    const row: RunRow | undefined = engine.ledger.runRowOf(invoiceId);
    const terms: ApprovalTerms | undefined =
      approval === undefined ? undefined : (JSON.parse(approval.terms) as ApprovalTerms);
    const outage: Outage | undefined = engine.ledger.activeOutage(obligation.currency, obligation.transferMethod);
    return {
      obligation,
      run: row === undefined ? null : { id: row.runId, line: row.line },
      // The active outage on the rail this invoice pays on, or null.
      outage: outage === undefined ? null : outageView(engine.ledger, outage),
      attempts: engine.ledger.attempts(invoiceId),
      emails: engine.ledger.emails(invoiceId).map((email: SupplierEmail) =>
        email.uploadId === undefined
          ? email
          : {
              ...email,
              notes: noteTexts(email.notes ?? []),
              uploadedBy: engine.ledger.upload(email.uploadId)?.uploadedBy ?? null,
            },
      ),
      findings: findings === undefined ? null : (JSON.parse(findings) as EmailFindings),
      approval:
        approval === undefined
          ? null
          : {
              id: approval.id,
              state: approval.state,
              approver: approval.approver,
              terms,
              // How the page words the estimate the terms carry, kept out of them.
              arrivalAdvice:
                terms?.arrival === undefined ? null : adviceFor(terms.arrival, isLive(approval)),
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
      outbox: outboxOf(engine.ledger, obligation),
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
    if (body["dueDate"] !== undefined && typeof body["dueDate"] !== "string") {
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
      obligation = await openScenario(engine, invoiceId, scenarioId, startedBy, dueDate === "" ? null : dueDate);
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
    return { invoiceId };
  }

  async function approveIncident(
    request: IncomingMessage,
    invoiceId: string,
  ): Promise<unknown> {
    requireObligation(invoiceId);
    const body: Record<string, unknown> = await readJson(request);
    const approver: string = name(body, "approver", "Enter the approver's name");
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
    const closedBy: string = name(body, "closedBy", "Enter your name");
    const finding: string = text(body, "finding");
    if (finding === "" || finding.length > MAX_FINDING_LENGTH) {
      throw new HttpError(400, "Say what you confirmed");
    }
    // The transfer ids the close card covered, so one found since it was shown is
    // not cleared by a close nobody saw it on. A close that names none is refused
    // while any is on file.
    const covered: unknown = body["covered"] ?? null;
    if (
      covered !== null &&
      (!Array.isArray(covered) ||
        covered.length > MAX_COVERED ||
        !covered.every((id: unknown): boolean => typeof id === "string" && id.length <= MAX_TRANSFER_ID_LENGTH))
    ) {
      throw new HttpError(400, "Say which transfers the close card covered");
    }
    await inTurn(invoiceId, (): void =>
      closeIncident(engine.ledger, invoiceId, closedBy, finding, covered as string[] | null),
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
      calledBy: name(body, "calledBy", "Enter your name"),
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

  // Has the agent look at an incident again. It cannot send a second live payment,
  // and an escalated invoice still needs its approval.
  function resume(invoiceId: string): unknown {
    requireObligation(invoiceId);
    agent.wake(invoiceId);
    return { ok: true };
  }

  return [
    { method: "GET", pattern: "/api/incidents", handler: ({ response }): void => sendJson(response, 200, listIncidents()) },
    {
      method: "POST",
      pattern: "/api/incidents",
      handler: async ({ request, response }): Promise<void> => sendJson(response, 202, await startIncident(request)),
    },
    {
      method: "GET",
      pattern: "api/incidents/:id",
      handler: ({ response }, id: string): void => sendJson(response, 200, incidentDetail(id)),
    },
    {
      method: "GET",
      pattern: "api/incidents/:id/audit",
      handler: ({ response, url }, id: string): void => sendAudit(response, id, url.searchParams.get("format") ?? "json"),
    },
    {
      method: "POST",
      pattern: "api/incidents/:id/approve",
      handler: async ({ request, response }, id: string): Promise<void> =>
        sendJson(response, 200, await approveIncident(request, id)),
    },
    {
      method: "POST",
      pattern: "api/incidents/:id/close",
      handler: async ({ request, response }, id: string): Promise<void> =>
        sendJson(response, 200, await closeByPerson(request, id)),
    },
    {
      method: "POST",
      pattern: "api/incidents/:id/resume",
      handler: ({ response }, id: string): void => sendJson(response, 200, resume(id)),
    },
    {
      method: "POST",
      pattern: "api/incidents/:id/pay-again",
      handler: async ({ response }, id: string): Promise<void> => sendJson(response, 200, await payAgainByPerson(id)),
    },
    {
      method: "GET",
      pattern: "api/incidents/:id/bank-details",
      handler: async ({ response }, id: string): Promise<void> => sendJson(response, 200, await bankDetailsForm(id)),
    },
    {
      method: "POST",
      pattern: "api/incidents/:id/bank-change",
      handler: async ({ request, response }, id: string): Promise<void> =>
        sendJson(response, 200, await bankChangeByPerson(request, id)),
    },
  ];
}

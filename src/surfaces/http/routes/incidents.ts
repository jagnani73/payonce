import type { IncomingMessage, ServerResponse } from "node:http";
import { CURRENCY_PATTERN } from "../../../domain/patterns.js";
import { bankChangeForm, recordBankChange, type BankChangeForm, type CallbackInput } from "../../../engine/bank-change.js";
import { approvePayment, closeIncident, pendingClose, type CloseReview } from "../../../engine/person.js";
import { auditCsv, auditExport, type AuditExport } from "../../../store/audit-trail.js";
import type { Approval, Obligation } from "../../../store/ledger.js";
import type { Acted, IncidentScope, IncidentsQuery, IncidentsView, IncidentView, Notice } from "../../../views/contract.js";
import { isBoardGroup, isBoardOrigin, type BoardGroup } from "../../../views/incident-board.js";
import { incidentsView, isScope } from "../../../views/incidents.js";
import { MAX_QUERY_LENGTH } from "../../../views/search.js";
import type { HttpApp } from "../app.js";
import { HttpError, MAX_FINDING_LENGTH, name, queryName, readJson, sendJson, text } from "../http.js";
import type { Route } from "../router.js";

// The transfers a close card can cover, one per attempt at most.
const MAX_COVERED: number = 50;
const MAX_TRANSFER_ID_LENGTH: number = 64;

// The board's groups as the incident list's scopes, for the old board URL.
const BOARD_SCOPES: Record<BoardGroup, IncidentScope> = {
  person: "needs-you",
  deadline: "bank-late",
  bank: "with-bank",
  open: "payonce",
};

// The incident list, one incident, its audit, and a person approving, closing,
// recording a callback or asking for a check. Every action answers the payment
// page as it is after it, with a notice.
export function incidentRoutes(app: HttpApp): Route[] {
  const { engine, settings, agent, live, requireObligation, incident, inTurn } = app;

  // The list's filters from the query. An empty value is no filter, and one the
  // list does not know answers 400.
  function incidentsQuery(params: URLSearchParams): IncidentsQuery {
    const scope: string = params.get("scope") ?? "";
    const currency: string = params.get("currency") ?? "";
    const origin: string = params.get("origin") ?? "";
    const clean: string = params.get("clean") ?? "";
    const q: string = (params.get("q") ?? "").trim();
    if (scope !== "" && !isScope(scope)) {
      throw new HttpError(400, "The scope is needs-you, bank-late, with-bank, payonce, closed or all");
    }
    if (currency !== "" && !CURRENCY_PATTERN.test(currency)) {
      throw new HttpError(400, "The currency is a three-letter code such as USD");
    }
    if (origin !== "" && !isBoardOrigin(origin)) {
      throw new HttpError(400, "The origin is payonce, outside or pay-run");
    }
    if (clean !== "" && clean !== "true" && clean !== "false") {
      throw new HttpError(400, "clean is true or false");
    }
    if (q.length > MAX_QUERY_LENGTH) {
      throw new HttpError(400, `Search for 1 to ${MAX_QUERY_LENGTH} characters`);
    }
    return {
      scope: scope === "" ? "all" : scope,
      currency: currency === "" ? null : currency,
      origin: origin === "" ? null : origin,
      me: queryName(params, "me"),
      clean: clean === "true",
      q: q === "" ? null : q,
    };
  }

  function incidents(params: URLSearchParams): IncidentsView {
    return incidentsView(engine.ledger, settings, Date.now(), incidentsQuery(params), live);
  }

  // The incident board's old address sends the page to the incident list, its
  // group as the list's scope.
  function boardRedirect(response: ServerResponse, params: URLSearchParams): void {
    const group: string = params.get("group") ?? "";
    if (group !== "" && !isBoardGroup(group)) {
      throw new HttpError(400, "The group is person, deadline, bank or open");
    }
    const target: URLSearchParams = new URLSearchParams();
    if (group !== "") {
      target.set("scope", BOARD_SCOPES[group]);
    }
    for (const field of ["currency", "origin"]) {
      const value: string = params.get(field) ?? "";
      if (value !== "") {
        target.set(field, value);
      }
    }
    const location: string = `/api/incidents${target.size === 0 ? "" : `?${target.toString()}`}`;
    sendJson(response, 307, { location }, { Location: location });
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

  function approvedNotice(approval: Approval): Notice {
    if (approval.state === "approved") {
      return { tone: "success", text: "Approved. PayOnce sends it at its next check." };
    }
    const left: number = Math.max(0, approval.needed - approval.signoffs.length);
    return {
      tone: "success",
      text: `Signed off. Request #${approval.id} needs ${left} more ${left === 1 ? "approver" : "approvers"}.`,
    };
  }

  async function approveIncident(request: IncomingMessage, invoiceId: string): Promise<Acted<IncidentView>> {
    requireObligation(invoiceId);
    const body: Record<string, unknown> = await readJson(request);
    const approver: string = name(body, "approver", "Enter the approver's name");
    const approvalId: unknown = body["approvalId"];
    if (typeof approvalId !== "number" || !Number.isInteger(approvalId)) {
      throw new HttpError(400, "Say which approval request is being approved");
    }
    const after: Approval = await inTurn(invoiceId, (): Approval =>
      approvePayment(engine.ledger, engine.approvals, invoiceId, approver, approvalId),
    );
    agent.wake(invoiceId);
    return { view: incident(invoiceId), notice: approvedNotice(after) };
  }

  // The option the person chose on the page, paid or unpaid, must still be how
  // PayOnce would close it, so nobody closes as paid what nothing paid. When
  // nothing can close it, closeIncident gives its own refusal.
  function closeKindRefusal(invoiceId: string, as: "paid" | "unpaid"): void {
    const kind: CloseReview["kind"] | undefined = pendingClose(engine.ledger, invoiceId)?.kind;
    if (kind === undefined || (kind !== "duplicate" && kind !== "unpaid") === (as === "paid")) {
      return;
    }
    throw new HttpError(
      409,
      as === "paid"
        ? `Nothing on file has paid ${invoiceId}, so it can only be closed without paying. Look at the payment again before closing it`
        : `${invoiceId} is paid, so it can only be closed as paid. Look at the payment again before closing it`,
      { code: "close-kind-changed" },
    );
  }

  // A person closes an escalated incident as paid, or without paying. Nothing is
  // sent, so there is no background step to wait for.
  async function closeByPerson(request: IncomingMessage, invoiceId: string): Promise<Acted<IncidentView>> {
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
    const as: unknown = body["as"] ?? null;
    if (as !== null && as !== "paid" && as !== "unpaid") {
      throw new HttpError(400, "Say whether you are closing it as paid or without paying");
    }
    await inTurn(invoiceId, (): void => {
      if (as !== null) {
        closeKindRefusal(invoiceId, as);
      }
      closeIncident(engine.ledger, invoiceId, closedBy, finding, covered as string[] | null);
    });
    const view: IncidentView = incident(invoiceId);
    return {
      view,
      notice: {
        tone: "success",
        text: view.decision.closed?.kind === "unpaid" ? `${invoiceId} closed without paying.` : `${invoiceId} closed as paid.`,
      },
    };
  }

  // What a person needs to record a callback about new bank details: the number on
  // file and the fields the supplier's record has.
  async function bankDetailsForm(invoiceId: string): Promise<BankChangeForm> {
    return bankChangeForm(engine, requireObligation(invoiceId));
  }

  // A person records calling the supplier back on the number on file, with the new
  // bank details the supplier confirmed. PayOnce updates the supplier's record in
  // Airwallex, and the agent then looks at the invoice again.
  async function bankChangeByPerson(request: IncomingMessage, invoiceId: string): Promise<Acted<IncidentView>> {
    requireObligation(invoiceId);
    const body: Record<string, unknown> = await readJson(request);
    const raw: unknown = body["details"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new HttpError(400, "Enter the new bank details");
    }
    const details: Record<string, string> = {};
    for (const [field, value] of Object.entries(raw)) {
      if (typeof value !== "string") {
        throw new HttpError(400, "Enter the new bank details");
      }
      details[field] = value;
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
    return {
      view: incident(invoiceId),
      notice: { tone: "success", text: "Callback recorded. PayOnce updated the supplier's bank details in Airwallex and is checking the payment again." },
    };
  }

  // Has the agent look at an incident again. It cannot send a second live payment,
  // and an escalated invoice still needs its approval.
  function check(invoiceId: string): Acted<IncidentView> {
    requireObligation(invoiceId);
    agent.wake(invoiceId);
    return { view: incident(invoiceId), notice: { tone: "info", text: `PayOnce is checking ${invoiceId}.` } };
  }

  return [
    { method: "GET", pattern: "/api/incidents", handler: ({ response, url }): void => sendJson(response, 200, incidents(url.searchParams)) },
    { method: "GET", pattern: "/api/board", handler: ({ response, url }): void => boardRedirect(response, url.searchParams) },
    {
      method: "GET",
      pattern: "api/incidents/:id",
      handler: ({ response }, id: string): void => sendJson(response, 200, incident(id)),
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
      pattern: "api/incidents/:id/check",
      handler: ({ response }, id: string): void => sendJson(response, 200, check(id)),
    },
    {
      method: "POST",
      pattern: "api/incidents/:id/resume",
      handler: ({ response }, id: string): void => sendJson(response, 200, check(id)),
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

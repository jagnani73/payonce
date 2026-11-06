import type { IncomingMessage } from "node:http";
import { createDraft, DraftMoveError, DraftNotFitError, isTemplate, markDraft, type DraftTemplate, type DraftView } from "../../../outbox/drafts.js";
import { DraftOpenError, type Draft, type DraftMove } from "../../../store/ledger.js";
import type { Acted, IncidentView } from "../../../views/contract.js";
import type { HttpApp } from "../app.js";
import { HttpError, MAX_FINDING_LENGTH, name, readJson, RUN_ID_PATTERN, sendJson, text } from "../http.js";
import type { Route } from "../router.js";

const MOVE_NOTICES: Record<DraftMove, string> = {
  copied: "Marked as copied.",
  sent: "Marked as sent.",
  dismissed: "Draft dismissed.",
};

// The outbox: a person drafts a message to send themselves, then copies it,
// marks it sent or dismisses it. PayOnce sends nothing. Each step answers the
// payment page as it is after it.
export function outboxRoutes(app: HttpApp): Route[] {
  const { engine, agent, requireObligation, incident } = app;

  // A person's step on a draft waits its turn on the invoice like any other. The
  // known refusals answer 409 or 422. Anything else is PayOnce's own failure and
  // answers 500.
  async function inOutboxTurn<T>(invoiceId: string, step: () => T): Promise<T> {
    try {
      return await agent.run(invoiceId, step);
    } catch (error: unknown) {
      if (error instanceof DraftOpenError) {
        throw new HttpError(409, error.message, { draftId: error.draftId });
      }
      if (error instanceof DraftNotFitError) {
        throw new HttpError(422, error.message);
      }
      if (error instanceof DraftMoveError) {
        throw new HttpError(409, error.message);
      }
      throw error;
    }
  }

  // Renders a message for a person to send and records it. PayOnce sends nothing.
  async function draftByPerson(request: IncomingMessage, invoiceId: string): Promise<Acted<IncidentView> & { draftId: number }> {
    requireObligation(invoiceId);
    const body: Record<string, unknown> = await readJson(request);
    const template: unknown = body["template"];
    if (!isTemplate(template)) {
      throw new HttpError(400, "Choose a message PayOnce offers");
    }
    const createdBy: string = name(body, "createdBy", "Enter your name");
    const chosen: DraftTemplate = template;
    const draft: DraftView = await inOutboxTurn(invoiceId, (): DraftView =>
      createDraft(engine.ledger, requireObligation(invoiceId), chosen, createdBy, engine.bankDeadlineMinutes),
    );
    return {
      draftId: draft.id,
      view: incident(invoiceId),
      notice: { tone: "success", text: "Draft written. Copy it and send it yourself: PayOnce never sends it." },
    };
  }

  // Records a person copying a draft, marking it sent or dismissing it.
  async function markByPerson(
    request: IncomingMessage,
    invoiceId: string,
    rawId: string,
    move: DraftMove,
  ): Promise<Acted<IncidentView>> {
    requireObligation(invoiceId);
    const draft: Draft | undefined = RUN_ID_PATTERN.test(rawId) ? engine.ledger.draft(Number(rawId)) : undefined;
    if (draft === undefined || draft.invoiceId !== invoiceId) {
      throw new HttpError(404, `Draft ${rawId.slice(0, 20)} is not a draft for ${invoiceId}`);
    }
    const body: Record<string, unknown> = await readJson(request);
    let by: string | null;
    if (move === "copied") {
      // A copy may go unnamed.
      by = text(body, "copiedBy") === "" ? null : name(body, "copiedBy", "Enter your name");
    } else {
      by = name(body, move === "sent" ? "sentBy" : "dismissedBy", "Enter your name");
    }
    const note: string = move === "dismissed" ? text(body, "note") : "";
    if (note.length > MAX_FINDING_LENGTH) {
      throw new HttpError(400, "The note is too long");
    }
    await inOutboxTurn(invoiceId, (): void =>
      markDraft(engine.ledger, requireObligation(invoiceId), draft.id, move, by, engine.bankDeadlineMinutes, note === "" ? null : note),
    );
    return { view: incident(invoiceId), notice: { tone: "success", text: MOVE_NOTICES[move] } };
  }

  return [
    {
      method: "POST",
      pattern: "api/incidents/:id/outbox",
      handler: async ({ request, response }, id: string): Promise<void> =>
        sendJson(response, 201, await draftByPerson(request, id)),
    },
    {
      method: "POST",
      pattern: "api/incidents/:id/outbox/:draft/copied",
      handler: async ({ request, response }, id: string, draft: string): Promise<void> =>
        sendJson(response, 200, await markByPerson(request, id, draft, "copied")),
    },
    {
      method: "POST",
      pattern: "api/incidents/:id/outbox/:draft/sent",
      handler: async ({ request, response }, id: string, draft: string): Promise<void> =>
        sendJson(response, 200, await markByPerson(request, id, draft, "sent")),
    },
    {
      method: "POST",
      pattern: "api/incidents/:id/outbox/:draft/dismiss",
      handler: async ({ request, response }, id: string, draft: string): Promise<void> =>
        sendJson(response, 200, await markByPerson(request, id, draft, "dismissed")),
    },
  ];
}

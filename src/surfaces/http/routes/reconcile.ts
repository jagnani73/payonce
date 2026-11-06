import type { IncomingMessage } from "node:http";
import { NameError } from "../../../domain/approvers.js";
import {
  explainBreaks,
  ExplainInputError,
  explainItems,
  movementsView,
  reconReport,
  type BreakView,
} from "../../../recon/reconcile.js";
import { ReconChangedError, ReconKindsError, ReconUnknownError } from "../../../store/recon-store.js";
import { CURRENCY_PATTERN } from "../../../views/incident-board.js";
import type { HttpApp } from "../app.js";
import { HttpError, readJson, sendJson, typed } from "../http.js";
import type { Route } from "../router.js";

// Reconciliation's routes. The report and the movements read the ledger alone.
// A person explains breaks of one kind, bound to the facts the page showed.
export function reconcileRoutes(app: HttpApp): Route[] {
  const { engine, reconRunner } = app;

  function movements(url: URL): unknown {
    const currency: string = url.searchParams.get("currency") ?? "";
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new HttpError(400, "Name a wallet by its three capital letters, such as USD");
    }
    return { currency, movements: movementsView(engine.ledger, currency) };
  }

  function checkNow(): unknown {
    const started: "started" | "running" | "soon" = reconRunner.checkNow();
    if (started === "running") {
      throw new HttpError(409, "A check is already running");
    }
    if (started === "soon") {
      throw new HttpError(429, "A check started less than a minute ago. Try again in a minute", {}, { "Retry-After": "60" });
    }
    return { started: true };
  }

  async function explain(request: IncomingMessage): Promise<unknown> {
    const body: Record<string, unknown> = await readJson(request);
    try {
      const explained: BreakView[] = explainBreaks(
        engine.ledger,
        explainItems(body["breaks"]),
        typed(body, "explainedBy"),
        typed(body, "note"),
      );
      return { explained: explained.map((item: BreakView): number => item.id) };
    } catch (error: unknown) {
      if (error instanceof NameError || error instanceof ExplainInputError || error instanceof ReconKindsError) {
        throw new HttpError(400, error.message);
      }
      if (error instanceof ReconUnknownError) {
        throw new HttpError(404, error.message, { unknown: error.ids });
      }
      if (error instanceof ReconChangedError) {
        throw new HttpError(409, error.message, { changed: error.ids });
      }
      throw error;
    }
  }

  return [
    {
      method: "GET",
      pattern: "api/reconcile",
      handler: ({ response }): void => sendJson(response, 200, reconReport(engine.ledger, reconRunner)),
    },
    {
      method: "GET",
      pattern: "api/reconcile/movements",
      handler: ({ response, url }): void => sendJson(response, 200, movements(url)),
    },
    { method: "POST", pattern: "api/reconcile/run", handler: ({ response }): void => sendJson(response, 202, checkNow()) },
    {
      method: "POST",
      pattern: "api/reconcile/explain",
      handler: async ({ request, response }): Promise<void> => sendJson(response, 200, await explain(request)),
    },
  ];
}

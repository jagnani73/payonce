import type { IncomingMessage } from "node:http";
import { NameError } from "../../../domain/approvers.js";
import { CURRENCY_PATTERN } from "../../../domain/patterns.js";
import { explainBreaks, ExplainInputError, explainItems, type BreakView } from "../../../recon/reconcile.js";
import { ReconChangedError, ReconKindsError, ReconUnknownError } from "../../../store/recon-store.js";
import type { Acted, ReconMovementsView, ReconView } from "../../../views/contract.js";
import { reconMovementsView, reconView } from "../../../views/treasury.js";
import type { HttpApp } from "../app.js";
import { HttpError, readJson, sendJson, typed } from "../http.js";
import type { Route } from "../router.js";

// Reconciliation's routes. The report and the movements read the ledger alone.
// A person explains breaks of one kind, bound to the facts the page showed.
export function reconcileRoutes(app: HttpApp): Route[] {
  const { engine, settings, reconRunner } = app;

  function report(): ReconView {
    return reconView(engine.ledger, settings, Date.now(), reconRunner);
  }

  function movements(url: URL): ReconMovementsView {
    const currency: string = url.searchParams.get("currency") ?? "";
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new HttpError(400, "Name a wallet by its three capital letters, such as USD");
    }
    return reconMovementsView(engine.ledger, currency, engine.bankDeadlineMinutes, Date.now());
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

  async function explain(request: IncomingMessage): Promise<Acted<ReconView>> {
    const body: Record<string, unknown> = await readJson(request);
    let explained: BreakView[];
    try {
      explained = explainBreaks(
        engine.ledger,
        explainItems(body["breaks"]),
        typed(body, "explainedBy"),
        typed(body, "note"),
      );
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
    return {
      view: report(),
      notice: {
        tone: "success",
        text: `${explained.length} ${explained.length === 1 ? "break" : "breaks"} explained.`,
      },
    };
  }

  return [
    { method: "GET", pattern: "api/reconcile", handler: ({ response }): void => sendJson(response, 200, report()) },
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

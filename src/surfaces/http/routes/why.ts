import type { IncomingMessage } from "node:http";
import {
  ExplainError,
  factsKey,
  shownAnswer,
  type ModelAnswer,
  type Refusal,
  type ShownAnswer,
} from "../../../explain/explainer.js";
import { whyFacts, type WhyBuild } from "../../../explain/why-facts.js";
import { say, sayWarning } from "../../../text/printable.js";
import type { HttpApp } from "../app.js";
import { HttpError, readJson, sendJson } from "../http.js";
import type { Route } from "../router.js";

// Ask why: a model's explanation of one invoice.
export function whyRoutes(app: HttpApp): Route[] {
  const { engine, explainer, explainLimiter, requireObligation } = app;
  const READER_NAMES: string[] = app.readerNames;

  // A model's explanation of the invoice, from the facts why-facts.ts builds. It
  // does not take the invoice's turn, because it writes nothing: the facts are read
  // in one snapshot, and the model is asked after the snapshot closes. The answer
  // is returned to the page only. The console gets one line, with no text.
  async function askWhy(request: IncomingMessage, invoiceId: string): Promise<ShownAnswer> {
    await readJson(request);
    if (explainer === null) {
      throw new HttpError(
        503,
        "The model reader is off, so PayOnce cannot ask a model. Set CLAUDE_API_KEY or READER_API_KEY in .env and restart",
      );
    }
    requireObligation(invoiceId);
    let build: WhyBuild | undefined;
    try {
      build = whyFacts(engine.ledger, invoiceId, {
        approvals: engine.approvals,
        reserve: engine.reserve,
        readers: READER_NAMES,
        bankDeadlineMinutes: engine.bankDeadlineMinutes,
        fxQuotes: engine.fxQuotes,
      });
    } catch (error: unknown) {
      throw new HttpError(
        500,
        `PayOnce could not build the facts for this invoice, so it sent nothing: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (build === undefined) {
      throw new HttpError(404, `${invoiceId} is not in the ledger`);
    }
    if (build.unrecognised > 0) {
      sayWarning(`  why      ${build.unrecognised} unrecognised reason${build.unrecognised === 1 ? "" : "s"} on ${invoiceId}`);
    }
    const key: string = factsKey(invoiceId, build.facts, explainer.models);
    const remembered: { answer: ModelAnswer; at: number } | undefined = explainLimiter.remembered(key, Date.now());
    if (remembered !== undefined) {
      return shownAnswer(remembered.answer, build, remembered.at, true);
    }
    const refused: Refusal | null = explainLimiter.begin(Date.now());
    if (refused !== null) {
      throw new HttpError(
        refused.status,
        refused.message,
        refused.retryAfterSeconds === null ? {} : { retryAfterSeconds: refused.retryAfterSeconds },
        refused.retryAfterSeconds === null ? {} : { "Retry-After": String(refused.retryAfterSeconds) },
      );
    }
    let answer: ModelAnswer | null = null;
    let limited: boolean = false;
    try {
      answer = await explainer.explain(build.facts);
    } catch (error: unknown) {
      limited = error instanceof ExplainError && error.limited;
      throw new HttpError(502, error instanceof ExplainError ? error.message : "No model gave an explanation");
    } finally {
      explainLimiter.end(key, Date.now(), answer, limited);
    }
    say(
      `  why      ${invoiceId} answered by ${answer.model} in ${(answer.ms / 1000).toFixed(1)} s (${answer.explanation.length} characters)`,
    );
    return shownAnswer(answer, build, Date.now(), false);
  }

  return [
    {
      method: "POST",
      pattern: "api/incidents/:id/why",
      handler: async ({ request, response }, id: string): Promise<void> => sendJson(response, 200, await askWhy(request, id)),
    },
  ];
}

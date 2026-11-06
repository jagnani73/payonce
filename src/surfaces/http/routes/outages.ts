import type { IncomingMessage } from "node:http";
import { endOutage, EndRefusedError, outagesReport, type EndedOutage } from "../../../outages/outages.js";
import { outageHolding } from "../../../views/incident-board.js";
import type { HttpApp } from "../app.js";
import { HttpError, readJson, RUN_ID_PATTERN, sendJson, text, typed } from "../http.js";
import type { Route } from "../router.js";

// The rail outages, and a person ending one.
export function outageRoutes(app: HttpApp): Route[] {
  const { engine, agent, startRelease } = app;

  // A person ends an outage with their name and a note. It runs in no invoice's
  // turn: it changes the outage and the looks of what it held, and moves no money.
  // The held invoices are then looked at, and the held runs released, at once. A
  // released pay run row that has not sent is left to the watcher, which gives it
  // the run's turn.
  async function endOutageByPerson(request: IncomingMessage, raw: string): Promise<unknown> {
    if (!RUN_ID_PATTERN.test(raw)) {
      throw new HttpError(404, `Outage ${raw.slice(0, 20)} is not in the ledger`);
    }
    const body: Record<string, unknown> = await readJson(request);
    let ended: EndedOutage;
    try {
      ended = endOutage(
        engine.ledger,
        engine.approvals,
        Number(raw),
        typed(body, "endedBy"),
        text(body, "note"),
        outageHolding(engine.ledger),
      );
    } catch (error: unknown) {
      if (!(error instanceof EndRefusedError)) {
        throw error;
      }
      const status: number = { input: 400, approver: 403, unknown: 404, ended: 409 }[error.why];
      throw new HttpError(
        status,
        error.message,
        error.why === "ended" && error.outage !== null
          ? { endedBy: error.outage.endedBy, endedAt: error.outage.endedAt }
          : {},
      );
    }
    const unsent: ReadonlySet<string> = new Set<string>(
      engine.ledger.unsentRunInvoices().map((row: { invoiceId: string }): string => row.invoiceId),
    );
    const invoices: string[] = [];
    const runs: number[] = [];
    for (const hold of ended.holds) {
      if (hold.invoiceId !== null) {
        invoices.push(hold.invoiceId);
        if (!unsent.has(hold.invoiceId)) {
          agent.wake(hold.invoiceId);
        }
      } else if (hold.runId !== null) {
        runs.push(hold.runId);
        startRelease(hold.runId);
      }
    }
    return { ok: true, invoices, runs };
  }

  return [
    {
      method: "GET",
      pattern: "/api/outages",
      handler: ({ response }): void =>
        sendJson(response, 200, outagesReport(engine.ledger, engine.approvals, outageHolding(engine.ledger))),
    },
    {
      method: "POST",
      pattern: "api/outages/:id/end",
      handler: async ({ request, response }, id: string): Promise<void> =>
        sendJson(response, 200, await endOutageByPerson(request, id)),
    },
  ];
}

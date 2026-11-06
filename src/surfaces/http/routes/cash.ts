import { readingSoft } from "../../../store/ledger.js";
import type { CashReport } from "../../../store/read/cash.js";
import type { CashView } from "../../../views/contract.js";
import { cashView } from "../../../views/treasury.js";
import type { HttpApp } from "../app.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";

export function cashRoutes(app: HttpApp): Route[] {
  const { engine, settings, balances, watcher, cash } = app;

  // Treasury's cash: balances from the cache, read again when 30 seconds old, and
  // the ledger as it is now. It answers at once with whatever the cache holds.
  function cashNow(): CashView {
    balances.refreshIfOld();
    return cashView(engine.ledger, settings, Date.now(), balances.latest(), watcher.lastCheckedAt);
  }

  return [
    { method: "GET", pattern: "/api/cash", handler: ({ response }): void => sendJson(response, 200, cashNow()) },
    {
      method: "GET",
      pattern: "/api/cash/cached",
      // The cash panel from the cache as it is, never starting an Airwallex read,
      // for the read-only MCP server. A view, so it reads stored JSON soft.
      handler: ({ response }): void => sendJson(response, 200, readingSoft((): CashReport => cash())),
    },
  ];
}

import type { CashReport } from "../../../engine/cash-position.js";
import { readingSoft } from "../../../store/ledger.js";
import type { HttpApp } from "../app.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";

export function cashRoutes(app: HttpApp): Route[] {
  const { balances, cash } = app;

  // The cash panel: balances from the cache, read again when 30 seconds old, and the
  // ledger as it is now. It answers at once with whatever the cache holds. The panel
  // is a view, so it reads stored JSON soft.
  function cashPanel(read: boolean): CashReport {
    if (read) {
      balances.refreshIfOld();
    }
    return readingSoft(cash);
  }

  return [
    { method: "GET", pattern: "/api/cash", handler: ({ response }): void => sendJson(response, 200, cashPanel(true)) },
    {
      method: "GET",
      pattern: "/api/cash/cached",
      // The same panel from the cache as it is, never starting an Airwallex read,
      // for the read-only MCP server.
      handler: ({ response }): void => sendJson(response, 200, cashPanel(false)),
    },
  ];
}

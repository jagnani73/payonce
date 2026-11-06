import { alertMessage, type AlertFacts } from "../../../alerts/alert-payloads.js";
import type { Alert } from "../../../store/ledger.js";
import type { HttpApp } from "../app.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";

// The latest alerts and how they went. Never the address.
export function alertRoutes(app: HttpApp): Route[] {
  const { engine, alertsStatus } = app;

  function recentAlerts(): unknown {
    return {
      ...alertsStatus(),
      recent: engine.ledger.recentAlerts(50).map((alert: Alert) => ({
        id: alert.id,
        key: alert.key,
        kind: alert.kind,
        title: alertMessage(JSON.parse(alert.facts) as AlertFacts, "").title,
        state: alert.state,
        tries: alert.tries,
        lastError: alert.lastError,
        createdAt: alert.createdAt,
        sentAt: alert.sentAt,
      })),
    };
  }

  return [{ method: "GET", pattern: "/api/alerts", handler: ({ response }): void => sendJson(response, 200, recentAlerts()) }];
}

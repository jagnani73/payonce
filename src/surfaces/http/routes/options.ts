import { alertMessage, type AlertFacts } from "../../../alerts/alert-payloads.js";
import type { Approver } from "../../../domain/approvers.js";
import { SCENARIOS, type ScenarioDef } from "../../../engine/scenario.js";
import { ASKS_PER_DAY, ASKS_PER_MINUTE } from "../../../explain/explainer.js";
import { MAX_EMAIL_BYTES } from "../../../intake/eml.js";
import { outageEnders } from "../../../outages/outages.js";
import { KeywordReader } from "../../../reader/keyword-reader.js";
import { ModelReader } from "../../../reader/model-reader.js";
import { MAX_RUN_FILE_CHARS, MAX_RUN_ROWS, RUN_COLUMNS } from "../../../runs/run-file.js";
import type { Alert } from "../../../store/ledger.js";
import { SANDBOX_OUTCOMES } from "../../../text/words.js";
import type { HttpApp } from "../app.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";

// What the page's forms offer, the settings it shows, and the latest alerts.
export function optionsRoutes(app: HttpApp): Route[] {
  const { engine, explainer, emailThreads, alertsStatus } = app;

  function options(): unknown {
    return {
      bankOutcomes: SANDBOX_OUTCOMES,
      emailThreads: emailThreads(),
      runColumns: RUN_COLUMNS,
      sandboxOutcomes: SANDBOX_OUTCOMES,
      maxRunRows: MAX_RUN_ROWS,
      maxRunFileChars: MAX_RUN_FILE_CHARS,
      maxEmailBytes: MAX_EMAIL_BYTES,
      // The page names where a model reader sends uploads, and warns when a model
      // on Google's free tier may read them.
      reader: engine.reader.name,
      readerIsModel: !(engine.reader instanceof KeywordReader),
      readerServices: engine.reader instanceof ModelReader ? engine.reader.views : [],
      // The "Ask why" card: off without CLAUDE_API_KEY or READER_API_KEY, and the
      // page's limits.
      explainer: {
        on: explainer !== null,
        models: explainer?.name ?? "",
        services: explainer?.views ?? [],
        googleFreeTier: explainer?.googleFreeTier ?? false,
        maxSeconds: explainer?.maxSeconds ?? 0,
        perMinute: ASKS_PER_MINUTE,
        perDay: ASKS_PER_DAY,
      },
      approvers: engine.approvals.approvers.map((approver: Approver) => ({
        name: approver.name,
        limitMinor: approver.limitMinor,
      })),
      approvalPolicy: {
        twoApproversAboveMinor: engine.approvals.twoApproversAboveMinor,
        expiresAfterMinutes: engine.approvals.expiresAfterMs / 60_000,
        problem: engine.approvals.problem,
      },
      scenarios: SCENARIOS.map((scenario: ScenarioDef) => ({
        id: scenario.id,
        label: scenario.label,
      })),
      alerts: alertsStatus(),
      // Who may end an outage: these names, or anyone with a name when null.
      outageEnders: outageEnders(engine.approvals),
    };
  }

  // The latest alerts and how they went. Never the address.
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

  return [
    { method: "GET", pattern: "/api/options", handler: ({ response }): void => sendJson(response, 200, options()) },
    { method: "GET", pattern: "/api/alerts", handler: ({ response }): void => sendJson(response, 200, recentAlerts()) },
  ];
}

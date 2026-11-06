import { readdirSync } from "node:fs";
import type { BalanceCache } from "../../airwallex/balances.js";
import type { Alerts, AlertSetting, AlertsStatus } from "../../alerts/alerts.js";
import type { CashReport } from "../../engine/cash-position.js";
import type { Dispatcher } from "../../engine/dispatcher.js";
import type { Engine } from "../../engine/engine.js";
import type { SandboxBank } from "../../engine/sandbox-bank.js";
import { DEFAULT_EMAILS } from "../../engine/scenario.js";
import type { Watcher } from "../../engine/watcher.js";
import type { Explainer, ExplainLimiter } from "../../explain/explainer.js";
import type { ReconRunner } from "../../recon/reconcile.js";
import type { Settings } from "../../settings.js";
import {
  INVOICE_ID_PATTERN,
  readingSoft,
  withBank,
  type Attempt,
  type Obligation,
  type OutsidePayout,
} from "../../store/ledger.js";
import { liveFrom, type Live } from "../../views/context.js";
import type { IncidentView } from "../../views/contract.js";
import { incidentView } from "../../views/incident.js";
import { HttpError } from "./http.js";

const EMAILS_DIR: URL = new URL("../../../fixtures/emails/", import.meta.url);

// What main() starts the server with.
export interface HttpParts {
  settings: Settings;
  engine: Engine;
  agent: Dispatcher;
  bank: SandboxBank;
  watcher: Watcher;
  balances: BalanceCache;
  // Null without CLAUDE_API_KEY or READER_API_KEY.
  explainer: Explainer | null;
  explainLimiter: ExplainLimiter;
  // The names "Ask why" passes on for whoever read an invoice's emails.
  readerNames: string[];
  reconRunner: ReconRunner;
  alerts: Alerts | null;
  alertSetting: AlertSetting;
  startRelease: (runId: number) => void;
  // The cash panel from the balance cache as it is, read strict.
  cash: () => CashReport;
}

// The parts and the helpers more than one area of routes uses.
export interface HttpApp extends HttpParts {
  // What the views call busy: the agent or the sandbox bank working on an
  // invoice, or on a run's own step.
  live: Live;
  isWatching: (invoiceId: string) => boolean;
  requireObligation: (invoiceId: string) => Obligation;
  incident: (invoiceId: string) => IncidentView;
  inTurn: <T>(invoiceId: string, step: () => T) => Promise<T>;
  emailThreads: () => string[];
  alertsStatus: () => AlertsStatus;
}

export function httpApp(parts: HttpParts): HttpApp {
  const { settings, engine, agent, bank, alerts, alertSetting, cash } = parts;

  // True while the agent or the sandbox bank is working on the invoice or the
  // run's key.
  function isBusy(key: string): boolean {
    return agent.isBusy(key) || bank.isBusy(key);
  }

  const live: Live = liveFrom(isBusy);

  // True while a payment is with the bank, so news can arrive at any moment. That
  // includes a payout for the invoice sent outside PayOnce.
  function isWatching(invoiceId: string): boolean {
    return (
      engine.ledger
        .attempts(invoiceId)
        .some(
          (attempt: Attempt): boolean => withBank(attempt),
        ) ||
      // In any state that is not final, as the watcher reads them.
      engine.ledger
        .outsidePayouts(invoiceId)
        .some((payout: OutsidePayout): boolean => payout.state !== "paid" && payout.state !== "failed")
    );
  }

  // The default thread comes first, so the form starts on it.
  function emailThreads(): string[] {
    return readdirSync(EMAILS_DIR)
      .filter((name: string): boolean => name.endsWith(".json"))
      .map((name: string): string => name.slice(0, -".json".length))
      .sort(
        (a: string, b: string): number =>
          Number(b === DEFAULT_EMAILS) - Number(a === DEFAULT_EMAILS),
      );
  }

  function requireObligation(invoiceId: string): Obligation {
    const obligation: Obligation | undefined = INVOICE_ID_PATTERN.test(invoiceId)
      ? engine.ledger.obligation(invoiceId)
      : undefined;
    if (obligation === undefined) {
      throw new HttpError(404, `${invoiceId} is not in the ledger`);
    }
    return obligation;
  }

  // The payment page as it is now, its headroom lines from the balance cache as it
  // is. A view, so the cash panel is read soft too.
  function incident(invoiceId: string): IncidentView {
    const view: IncidentView | null = INVOICE_ID_PATTERN.test(invoiceId)
      ? incidentView(engine.ledger, settings, Date.now(), invoiceId, live, readingSoft(cash))
      : null;
    if (view === null) {
      throw new HttpError(404, `${invoiceId} is not in the ledger`);
    }
    return view;
  }

  // A person's action waits its turn behind whatever the agent is doing on the
  // invoice, so it never lands in the middle of a step. A refusal the step gives
  // as an HttpError keeps its own status.
  async function inTurn<T>(invoiceId: string, step: () => T): Promise<T> {
    try {
      return await agent.run(invoiceId, step);
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }
  }

  function alertsStatus(): AlertsStatus {
    return (
      alerts?.status() ?? {
        on: false,
        format: null,
        host: null,
        test: false,
        problem: alertSetting.problem,
        stopped: null,
      }
    );
  }

  return { ...parts, live, isWatching, requireObligation, incident, inTurn, emailThreads, alertsStatus };
}

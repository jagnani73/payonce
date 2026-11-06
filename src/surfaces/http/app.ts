import { readdirSync } from "node:fs";
import type { BalanceCache } from "../../airwallex/balances.js";
import type { Alerts, AlertSetting, AlertsStatus } from "../../alerts/alerts.js";
import { arrivalAdvice, type ArrivalAdvice, type ArrivalTerms } from "../../domain/arrival.js";
import { isExpired, withBank } from "../../domain/live.js";
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
  type Approval,
  type Attempt,
  type Obligation,
  type OutsidePayout,
  type RunApproval,
} from "../../store/ledger.js";
import type { CashReport } from "../../store/read/cash.js";
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
  isBusy: (invoiceId: string) => boolean;
  isWatching: (invoiceId: string) => boolean;
  watchedInvoices: () => Set<string>;
  requireObligation: (invoiceId: string) => Obligation;
  inTurn: <T>(invoiceId: string, step: () => T) => Promise<T>;
  emailThreads: () => string[];
  alertsStatus: () => AlertsStatus;
}

export function httpApp(parts: HttpParts): HttpApp {
  const { engine, agent, bank, alerts, alertSetting } = parts;

  // True while the agent or the sandbox bank is working on the invoice.
  function isBusy(invoiceId: string): boolean {
    return agent.isBusy(invoiceId) || bank.isBusy(invoiceId);
  }

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

  // The invoices with a payment with the bank, the test isWatching makes, for every
  // invoice at once.
  function watchedInvoices(): Set<string> {
    const watched: Set<string> = engine.ledger.invoicesWithPayoutInFlight();
    for (const attempt of engine.ledger.attemptsMaybeWithBank()) {
      if (withBank(attempt)) {
        watched.add(attempt.invoiceId);
      }
    }
    return watched;
  }

  // A person's action waits its turn behind whatever the agent is doing on the
  // invoice, so it never lands in the middle of a step.
  async function inTurn<T>(invoiceId: string, step: () => T): Promise<T> {
    try {
      return await agent.run(invoiceId, step);
    } catch (error: unknown) {
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

  return { ...parts, isBusy, isWatching, watchedInvoices, requireObligation, inTurn, emailThreads, alertsStatus };
}

// Whether the invoice's timeline still chains together, for the line under it on
// the page. problem is the first break, or a running hash that is missing or does
// not match.
export interface AuditSummary {
  lines: number;
  problem: string | null;
}

// "If sent today" says when a payment that can still be approved and sent would
// arrive, so a used, void or expired request, and a run already released, have none.
export function adviceFor(arrival: ArrivalTerms, live: boolean): ArrivalAdvice {
  const advice: ArrivalAdvice = arrivalAdvice(arrival);
  return live ? advice : { ...advice, sentToday: null };
}

export function isLive(approval: Approval | RunApproval): boolean {
  return (approval.state === "requested" || approval.state === "approved") && !isExpired(approval);
}

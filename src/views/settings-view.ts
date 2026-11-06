import { OFFLINE_HOST } from "../airwallex/client.js";
import { alertMessage, type AlertFacts } from "../alerts/alert-payloads.js";
import type { AlertTarget } from "../alerts/alerts.js";
import { APPROVED_USE_WITHIN_MS, type ApprovalPolicy, type Approver } from "../domain/approvers.js";
import { deadlineMinutes } from "../domain/deadlines.js";
import { FAILURE_CODES, type FailureCode } from "../domain/failure-codes.js";
import { describeQuotes } from "../domain/fx.js";
import { formatAmount, formatMoney } from "../domain/money.js";
import { ASKS_PER_DAY, ASKS_PER_MINUTE, explainerFor, type Explainer } from "../explain/explainer.js";
import { MAX_EMAIL_BYTES } from "../intake/eml.js";
import { describeOutageRule } from "../outages/outages.js";
import { ModelReader } from "../reader/model-reader.js";
import { readerFor } from "../reader/reader.js";
import type { EmailReader } from "../reader/emails.js";
import type { ServiceView } from "../reader/model-service.js";
import { MAX_RUN_FILE_CHARS, MAX_RUN_ROWS } from "../runs/run-file.js";
import type { Settings } from "../settings.js";
import type { Alert, Ledger } from "../store/ledger.js";
import type { Money, SettingRow, SettingsView } from "./contract.js";
import { airwallexHealth, type ServerFacts } from "./health.js";
import { money } from "./parts.js";

// Settings as PayOnce read them from its .env file, read-only. A secret is never
// in it: only whether a key is set shows, through what it turns on.

const MINUTE_MS: number = 60_000;
const NAMES_SHOWN: number = 50;
const ALERTS_SHOWN: number = 50;

const NO_LOGIN: string =
  "PayOnce has no login. It runs on this computer only, and the name you choose is recorded on everything you do here. Approvals are checked against the approver list, its limits and who is barred.";
const BARRED_RULE: string =
  "Whoever started a payment, uploaded its pay run, or recorded a callback for its bank details cannot approve it.";
const CLOSE_RULE: string = "Anyone with a name can close a payment without paying or cancel a waiting pay run.";

// An approver's limit applies in whichever currency a payment is paid from.
function limitOf(minor: number): Money {
  return { minor, currency: "", text: formatAmount(minor) };
}

function row(label: string, value: string, variable: string | null, problem: string | null = null): SettingRow {
  return { label, value, variable, problem };
}

function alertTitle(alert: Alert): string {
  try {
    return alertMessage(JSON.parse(alert.facts) as AlertFacts, "").title;
  } catch {
    return "An alert PayOnce cannot read back";
  }
}

function readerSection(settings: Settings): SettingsView["reader"] {
  const reader: EmailReader = readerFor(settings.models.readerServices());
  const explainer: Explainer | null = explainerFor(settings.models.askServices());
  const free: boolean = reader instanceof ModelReader && reader.views.some((view: ServiceView): boolean => view.googleFreeTier);
  return {
    name: reader.name,
    isModel: reader instanceof ModelReader,
    notice: free ? "A model on Google's free tier reads uploaded emails. Don't upload anything you can't share with Google." : null,
    askWhy: {
      on: explainer !== null,
      models: explainer?.name ?? "",
      perMinute: ASKS_PER_MINUTE,
      perDay: ASKS_PER_DAY,
      variables: ["CLAUDE_API_KEY", "CLAUDE_ASK_MODEL", "READER_API_KEY", "READER_MODEL"],
    },
    variables: ["CLAUDE_API_KEY", "CLAUDE_MODEL", "READER_API_KEY", "READER_MODEL", "READER_BASE_URL"],
  };
}

// server: what only pnpm ui knows, its client, alerts and timers. Null in the
// CLI, MCP and the dump.
export function settingsView(ledger: Ledger, settings: Settings, _now: number, server: ServerFacts | null = null): SettingsView {
  const policy: ApprovalPolicy = settings.approvals;
  const target: AlertTarget | null = settings.alerts.target;
  return {
    view: "settings",
    approvals: {
      approvers: policy.approvers.map((approver: Approver) => ({ name: approver.name, limit: limitOf(approver.limitMinor) })),
      rows: [
        row(
          "Approvers",
          policy.approvers.length === 0 ? "None" : `${policy.approvers.length}`,
          "APPROVERS",
          policy.problem,
        ),
        row("Two approvers above", formatAmount(policy.twoApproversAboveMinor), "TWO_APPROVERS_ABOVE"),
        row("Requests expire after", `${policy.expiresAfterMs / MINUTE_MS} minutes`, "APPROVAL_TTL_MINUTES"),
        row("An approved request has at least", `${APPROVED_USE_WITHIN_MS / MINUTE_MS} more minutes to be used`, null),
      ],
      barredRule: BARRED_RULE,
      closeRule: CLOSE_RULE,
      problem: policy.problem,
    },
    cash: {
      floors: [...settings.reserve.floors.entries()]
        .sort(([a]: [string, number], [b]: [string, number]): number => a.localeCompare(b))
        .map(([currency, minor]: [string, number]) => ({ currency, floor: money(minor, currency), text: formatMoney(minor, currency) })),
      rows: [
        row(
          "Reserve floors",
          settings.reserve.floors.size === 0 ? "Not set: every automatic replacement goes to a person" : `${settings.reserve.floors.size} set`,
          "RESERVE_FLOORS",
          settings.reserve.problem,
        ),
        row("Exchange-rate quotes", describeQuotes(settings.fxQuotes), "FX_QUOTE_VALIDITY", settings.fxQuotes.problem),
      ],
    },
    bankDeadlines: [
      row("Local transfers", `${deadlineMinutes("LOCAL")} minutes, then PayOnce says the bank is late`, "BANK_DEADLINE_LOCAL_MINUTES"),
      row("SWIFT transfers", `${deadlineMinutes("SWIFT")} minutes, then PayOnce says the bank is late`, "BANK_DEADLINE_SWIFT_MINUTES"),
    ],
    outages: [row("Rule", describeOutageRule(settings.outageRule), "OUTAGE_FAILURES", settings.outageRule.problem)],
    alerts: {
      on: target !== null,
      format: target?.format ?? null,
      host: target?.host ?? null,
      test: target?.test ?? false,
      problem: settings.alerts.problem,
      stopped: server?.alerts.stopped ?? null,
      recent: ledger.recentAlerts(ALERTS_SHOWN).map((alert: Alert) => ({
        id: alert.id,
        kind: alert.kind,
        title: alertTitle(alert),
        state: alert.state,
        tries: alert.tries,
        lastError: alert.lastError,
        createdAt: alert.createdAt,
        sentAt: alert.sentAt,
      })),
      variables: { target: ["ALERT_WEBHOOK_URL", "ALERT_FORMAT"], test: ["ALERT_TEST_RECEIVER_URL"] },
    },
    reader: readerSection(settings),
    airwallex:
      server === null
        ? null
        : {
            host: server.host,
            offline: server.host === OFFLINE_HOST,
            connection: airwallexHealth(ledger, server.host, server.balances),
            webhooks: {
              on: settings.server.webhooks === "on",
              host: settings.server.webhookUrl !== undefined && URL.canParse(settings.server.webhookUrl) ? new URL(settings.server.webhookUrl).host : null,
            },
            checksEverySeconds: server.checksEverySeconds,
            listingEverySeconds: server.listingEverySeconds,
            reconEveryMinutes: settings.recon.everyMs === null ? null : settings.recon.everyMs / MINUTE_MS,
            variables: { host: ["AWX_BASE_URL"], webhooks: ["WEBHOOKS", "WEBHOOK_URL"], recon: ["RECON_EVERY_MINUTES"] },
          },
    people: { noLogin: NO_LOGIN, names: ledger.knownNames(NAMES_SHOWN) },
    failureCodes: Object.entries(FAILURE_CODES).map(([code, failure]: [string, FailureCode]) => ({
      code,
      words: failure.words,
      resendable: failure.resendable,
      railLevel: failure.rail,
      accountLevel: failure.account,
    })),
    limits: { maxEmailBytes: MAX_EMAIL_BYTES, maxRunRows: MAX_RUN_ROWS, maxRunFileChars: MAX_RUN_FILE_CHARS },
  };
}

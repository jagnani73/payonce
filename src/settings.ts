import { existsSync } from "node:fs";
import { AirwallexClient } from "./airwallex/client.js";
import { QUOTE_VALIDITIES, type QuoteValidity } from "./airwallex/fx.js";
import type { AlertFormat } from "./alerts/alert-payloads.js";
import type { AlertSetting } from "./alerts/alerts.js";
import { policyFromEnv, type ApprovalPolicy } from "./domain/approvers.js";
import type { QuoteSetting } from "./domain/fx.js";
import { reserveFromEnv, type ReservePolicy } from "./domain/reserve.js";
import type { OutageRule } from "./outages/outages.js";
import type { ModelService } from "./reader/model-service.js";
import { modelServicesFromEnv, readerNamesFromEnv } from "./reader/reader.js";
import type { ReconSetting } from "./recon/reconcile.js";

// Every environment setting PayOnce reads, read once when a command or server
// starts, right after it loads .env. A setting PayOnce cannot use never throws
// here: it carries its problem, and the code that needs it refuses at the moment
// it always did (a missing credential when the client is built, a bad quote
// validity when a quote is taken). This file imports only modules that never
// import it, so reading the settings starts no import cycle.

export interface AirwallexSetting {
  // Builds the client from AWX_BASE_URL, AWX_CLIENT_ID and AWX_API_KEY, or throws
  // in PayOnce's words when a credential is missing or the address is not the
  // sandbox. The credentials stay inside it, so no copy of the settings holds them.
  client: () => AirwallexClient;
  // Whether each credential is set, never its value.
  keys: { clientId: boolean; apiKey: boolean };
}

export interface BankDeadlineMinutes {
  // BANK_DEADLINE_LOCAL_MINUTES and BANK_DEADLINE_SWIFT_MINUTES, or null when one
  // is not a positive number, so the method's default applies.
  LOCAL: number | null;
  SWIFT: number | null;
}

export interface ModelSettings {
  // The model services the email reader and Ask why ask, in order. They hold the
  // keys, so they are handed out by a function and never sit in a field.
  readerServices: () => ModelService[];
  askServices: () => ModelService[];
  // Every name the stored findings may give for whoever read an invoice's emails.
  readerNames: string[];
}

export interface ServerSettings {
  port: number;
  webhookPort: number;
  webhookApiVersion: string;
  // on or off, trimmed and lower-cased, and on when unset or empty. Any other
  // value turns webhooks off with a warning.
  webhooks: string;
  webhookUrl: string | undefined;
  cloudflared: string;
}

export interface McpSettings {
  // PAYONCE_LEDGER as given, empty when unset.
  ledger: string;
  // The server's PORT, for the cached balances, or its default when not a port.
  port: number;
}

export interface Settings {
  airwallex: AirwallexSetting;
  approvals: ApprovalPolicy;
  reserve: ReservePolicy;
  fxQuotes: QuoteSetting;
  bankDeadlineMinutes: BankDeadlineMinutes;
  outageRule: OutageRule;
  recon: ReconSetting;
  alerts: AlertSetting;
  models: ModelSettings;
  server: ServerSettings;
  mcp: McpSettings;
}

const DEFAULT_AIRWALLEX_URL: string = "https://api.sandbox.airwallex.com";
const DEFAULT_PORT: number = 4310;
const DEFAULT_WEBHOOK_PORT: number = 4311;
const DEFAULT_WEBHOOK_API_VERSION: string = "2025-06-30";
const DEFAULT_QUOTE_VALIDITY: QuoteValidity = "HR_1";
const DEFAULT_OUTAGE_FAILURES: number = 3;
const DEFAULT_OUTAGE_WINDOW_MINUTES: number = 30;
const DEFAULT_RECON_EVERY_MINUTES: number = 10;
const MAX_RECON_EVERY_MINUTES: number = 1440;
const MS_PER_MINUTE: number = 60_000;
const SLACK_HOSTS: readonly string[] = ["hooks.slack.com"];
const DISCORD_HOSTS: readonly string[] = ["discord.com", "discordapp.com"];
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

let loaded: Settings | null = null;

// Reads every setting from env and keeps them for currentSettings. A command
// that loads .env only on some paths loads its settings again after it does.
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  loaded = readSettings(env);
  return loaded;
}

// The settings the running command loaded, for the code that cannot be handed
// them yet: the bank deadlines, the outage rule and the quote validity.
export function currentSettings(): Settings {
  if (loaded === null) {
    throw new Error("PayOnce read a setting before it loaded its settings");
  }
  return loaded;
}

function readSettings(env: NodeJS.ProcessEnv): Settings {
  const readerServices: ModelService[] = modelServicesFromEnv(env);
  const askServices: ModelService[] = modelServicesFromEnv(env, "ask");
  return {
    airwallex: airwallexSetting(env),
    approvals: policyFromEnv(env),
    reserve: reserveFromEnv(env),
    fxQuotes: quoteSetting(env),
    bankDeadlineMinutes: {
      LOCAL: deadlineMinutes(env["BANK_DEADLINE_LOCAL_MINUTES"]),
      SWIFT: deadlineMinutes(env["BANK_DEADLINE_SWIFT_MINUTES"]),
    },
    outageRule: outageRule(env),
    recon: reconSetting(env),
    alerts: alertSetting(env),
    models: {
      readerServices: (): ModelService[] => readerServices,
      askServices: (): ModelService[] => askServices,
      readerNames: readerNamesFromEnv(env),
    },
    server: {
      port: Number(env["PORT"] ?? DEFAULT_PORT),
      webhookPort: Number(env["WEBHOOK_PORT"] ?? DEFAULT_WEBHOOK_PORT),
      webhookApiVersion: env["WEBHOOK_API_VERSION"] ?? DEFAULT_WEBHOOK_API_VERSION,
      webhooks: (env["WEBHOOKS"]?.trim() || "on").toLowerCase(),
      webhookUrl: env["WEBHOOK_URL"],
      cloudflared: env["CLOUDFLARED"] ?? "cloudflared",
    },
    mcp: {
      ledger: env["PAYONCE_LEDGER"] ?? "",
      port: mcpPort(env["PORT"]),
    },
  };
}

// A .env that lacks the setting needs only that line. With no .env, the README's
// setup lines say what goes in one.
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      existsSync(".env")
        ? `Missing environment variable ${name}. Add ${name} to .env`
        : `Missing environment variable ${name}. Make a .env file in this folder from the setup lines under Run it in the README`,
    );
  }
  return value;
}

function airwallexSetting(env: NodeJS.ProcessEnv): AirwallexSetting {
  // Left empty, as NAME= in .env, it is the default, as when it is not set.
  const baseUrl: string = env["AWX_BASE_URL"] || DEFAULT_AIRWALLEX_URL;
  const clientId: string | undefined = env["AWX_CLIENT_ID"];
  const apiKey: string | undefined = env["AWX_API_KEY"];
  return {
    client: (): AirwallexClient =>
      new AirwallexClient(baseUrl, required("AWX_CLIENT_ID", clientId), required("AWX_API_KEY", apiKey)),
    keys: { clientId: Boolean(clientId), apiKey: Boolean(apiKey) },
  };
}

// How long the bank has to pay or fail a transfer, in minutes. Real rails take
// days. The sandbox moves in seconds, so the defaults are minutes.
function deadlineMinutes(raw: string | undefined): number | null {
  const configured: number = Number(raw);
  return Number.isFinite(configured) && configured > 0 ? configured : null;
}

// FX_QUOTE_VALIDITY: how long the exchange rate quote behind an approval request
// holds. A longer quote costs a slightly worse rate and gives a person longer to
// approve. A value PayOnce does not take holds every cross-currency payment.
function quoteSetting(env: NodeJS.ProcessEnv): QuoteSetting {
  const raw: string = (env["FX_QUOTE_VALIDITY"] ?? "").trim().toUpperCase();
  if (raw === "") {
    return { validity: DEFAULT_QUOTE_VALIDITY, problem: null };
  }
  const validity: QuoteValidity | undefined = QUOTE_VALIDITIES.find(
    (candidate: QuoteValidity): boolean => candidate === raw,
  );
  if (validity === undefined) {
    return {
      validity: null,
      problem: `FX_QUOTE_VALIDITY must be one of ${QUOTE_VALIDITIES.join(", ")}, so PayOnce takes no exchange rate quote`,
    };
  }
  return { validity, problem: null };
}

// OUTAGE_FAILURES, a whole number from 2 to 100, and OUTAGE_WINDOW_MINUTES, from
// 1 to 1440. A value outside the range falls back to the default, and the
// start-up line says so.
function outageRule(env: NodeJS.ProcessEnv): OutageRule {
  const problems: string[] = [];
  const read = (name: string, min: number, max: number, fallback: number): number => {
    const raw: string = (env[name] ?? "").trim();
    if (raw === "") {
      return fallback;
    }
    const value: number = /^[0-9]{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
    if (value >= min && value <= max) {
      return value;
    }
    problems.push(`${name} is not a whole number from ${min} to ${max}, so ${fallback} is used`);
    return fallback;
  };
  return {
    failures: read("OUTAGE_FAILURES", 2, 100, DEFAULT_OUTAGE_FAILURES),
    windowMinutes: read("OUTAGE_WINDOW_MINUTES", 1, 1440, DEFAULT_OUTAGE_WINDOW_MINUTES),
    problem: problems.length === 0 ? null : problems.join(". "),
  };
}

// RECON_EVERY_MINUTES, a whole number from 0 to 1440, where 0 means only when asked.
function reconSetting(env: NodeJS.ProcessEnv): ReconSetting {
  const raw: string | undefined = env["RECON_EVERY_MINUTES"];
  if (raw === undefined || raw.trim() === "") {
    return { everyMs: DEFAULT_RECON_EVERY_MINUTES * MS_PER_MINUTE, problem: null };
  }
  const minutes: number = Number(raw.trim());
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_RECON_EVERY_MINUTES) {
    return {
      everyMs: DEFAULT_RECON_EVERY_MINUTES * MS_PER_MINUTE,
      problem: `RECON_EVERY_MINUTES takes a whole number from 0 to ${MAX_RECON_EVERY_MINUTES}, so it is every ${DEFAULT_RECON_EVERY_MINUTES} minutes`,
    };
  }
  return { everyMs: minutes === 0 ? null : minutes * MS_PER_MINUTE, problem: null };
}

function parsedUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function slackOrDiscord(url: URL): AlertFormat | null {
  if (SLACK_HOSTS.includes(url.hostname) && url.pathname.startsWith("/services/")) {
    return "slack";
  }
  if (DISCORD_HOSTS.includes(url.hostname) && url.pathname.startsWith("/api/webhooks/")) {
    return "discord";
  }
  return null;
}

// ALERT_WEBHOOK_URL must be a Slack or Discord incoming webhook over https.
// ALERT_TEST_RECEIVER_URL, for checking alerts against a receiver on this machine,
// takes only a loopback address, and wins when set.
function alertSetting(env: NodeJS.ProcessEnv): AlertSetting {
  const off = (problem: string): AlertSetting => ({ target: null, problem });
  const format: string = (env["ALERT_FORMAT"] ?? "").trim().toLowerCase() || "slack";
  if (format !== "slack" && format !== "discord") {
    return off("ALERT_FORMAT is slack or discord");
  }
  const testRaw: string = (env["ALERT_TEST_RECEIVER_URL"] ?? "").trim();
  if (testRaw !== "") {
    const url: URL | null = parsedUrl(testRaw);
    if (
      url === null ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      !LOOPBACK_HOSTS.includes(url.hostname)
    ) {
      return off("ALERT_TEST_RECEIVER_URL takes only an http or https address on 127.0.0.1, localhost or [::1]");
    }
    return { target: { format, url, host: url.host, test: true }, problem: null };
  }
  const raw: string = (env["ALERT_WEBHOOK_URL"] ?? "").trim();
  if (raw === "") {
    return { target: null, problem: null };
  }
  const url: URL | null = parsedUrl(raw);
  if (url === null || url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return off("ALERT_WEBHOOK_URL is not an https address PayOnce takes");
  }
  const kind: AlertFormat | null = slackOrDiscord(url);
  if (kind === null) {
    return off(
      "ALERT_WEBHOOK_URL is not a Slack or Discord incoming webhook (https://hooks.slack.com/services/... or https://discord.com/api/webhooks/...)",
    );
  }
  if (kind !== format) {
    return off(`ALERT_WEBHOOK_URL is a ${kind === "slack" ? "Slack" : "Discord"} webhook, so set ALERT_FORMAT=${kind}`);
  }
  return { target: { format, url, host: url.hostname, test: false }, problem: null };
}

// The MCP server checks PORT is a port before it asks the server for balances.
function mcpPort(raw: string | undefined): number {
  const port: number = Number(raw ?? DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT;
}

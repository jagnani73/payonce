// What an alert says, and how it is posted to a Slack or Discord incoming webhook.
// Every message is built from an alert's stored facts, which hold invoice numbers,
// formatted amounts, dates, counts and reasons PayOnce wrote. They never hold email
// text, model output, account details or anything secret.

export type AlertFormat = "slack" | "discord";

// What an invoice waits on, first match wins: an approval of paying a held
// invoice, an approval of a replacement, a person closing a paid one, a person
// deciding on a held one nobody can approve yet, the bank's deadline, a payout
// sent outside PayOnce, a call to the supplier, or anything else.
export type InvoiceNeed =
  | "approve-held"
  | "approve"
  | "close"
  | "held"
  | "bank"
  | "outside"
  | "callback"
  | "check";

export interface InvoiceAlertFacts {
  kind: "invoice";
  invoice: string;
  supplier: string;
  amount: string;
  need: InvoiceNeed;
  reason: string;
  // The approvers an open request needs, and when it ends. Null with no request.
  approvers: number | null;
  openUntil: string | null;
  // True when the request pays an account the original did not go to.
  newAccount: boolean;
}

export interface PayoutAlertFacts {
  kind: "payout";
  // The bank's short reference, or null when none was recorded.
  reference: string | null;
  invoice: string;
  // True for a payout taken on as an incident of its own, false for one tied to
  // an invoice PayOnce already had.
  takenOn: boolean;
  supplier: string;
  amount: string;
  state: string;
}

export interface RunAlertFacts {
  kind: "run";
  run: number;
  payments: number;
  totals: string[];
  approvers: number;
  openUntil: string | null;
}

export interface AuditAlertFacts {
  kind: "audit";
  scope: "invoices" | "runs";
  broken: number;
  // The first broken timeline (an invoice number or a run number) and its line.
  first: string | null;
  line: number | null;
  runningHash: "matches" | "missing" | "does not match";
}

export interface CashAlertFacts {
  kind: "cash";
  currency: string;
  headroom: string;
  floor: string | null;
  readAt: string | null;
}

export interface SummaryAlertFacts {
  kind: "summary";
  invoices: number;
  runs: number;
  audit: number;
  cash: number;
}

export type AlertFacts =
  | InvoiceAlertFacts
  | PayoutAlertFacts
  | RunAlertFacts
  | AuditAlertFacts
  | CashAlertFacts
  | SummaryAlertFacts;

export interface AlertField {
  name: string;
  value: string;
  inline: boolean;
}

// One message, before it is shaped for Slack or Discord. link only works on the
// machine running PayOnce, and every message says so.
export interface AlertMessage {
  title: string;
  line: string;
  fields: AlertField[];
  link: string;
  linkText: string;
  urgent: boolean;
}

const MAX_NAME: number = 80;
const MAX_REASON: number = 300;
const SLACK_HEADER_MAX: number = 150;
const SLACK_FIELDS_MAX: number = 10;
const DISCORD_TITLE_MAX: number = 256;
const DISCORD_FIELD_VALUE_MAX: number = 1024;
const AMBER: number = 15105570;
const RED: number = 15158332;
const FOOTNOTE: string = "Sandbox, no real money.";
const CONTROL: RegExp = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

const NEED_TITLES: Record<InvoiceNeed, string> = {
  "approve-held": "is held: approve paying it or close it",
  approve: "needs an approval",
  close: "is paid and needs a person to close it",
  held: "is held before paying and needs a person",
  bank: "",
  outside: "may already be paid outside PayOnce",
  callback: "needs a call to the supplier",
  check: "needs a person",
};

// Control characters and line breaks become spaces, and long text is cut.
export function oneLine(text: string, max: number): string {
  const flat: string = text.replace(CONTROL, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// Slack reads &, < and > as control characters, so <!channel>, <@U123> and
// <url|text> cannot come from a value.
export function slackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Discord markdown is escaped, so a value cannot become a masked link, a heading
// or a mention. allowed_mentions stops pings in any case.
export function discordText(text: string): string {
  return text.replace(/[\\*_~`|<>[\]()#@]/g, "\\$&");
}

// "28 Oct 2026, 15:05 UTC"
export function utcText(iso: string): string {
  const at: Date = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "not known";
  }
  const day: string = at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const time: string = at.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `${day}, ${time} UTC`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function field(name: string, value: string, inline: boolean = true): AlertField {
  return { name, value, inline };
}

function invoiceMessage(facts: InvoiceAlertFacts, base: string): AlertMessage {
  const supplier: string = oneLine(facts.supplier, MAX_NAME);
  const title: string =
    facts.need === "bank"
      ? `Bank deadline passed on ${facts.invoice}`
      : `${facts.invoice} ${NEED_TITLES[facts.need]}`;
  return {
    title,
    line: `${facts.amount} to ${supplier}`,
    fields: [
      field("Supplier", supplier),
      field("Amount", facts.amount),
      field("Why", oneLine(facts.reason, MAX_REASON), false),
      field(
        "Waiting on",
        facts.approvers === null ? "a person" : plural(facts.approvers, "approver", "approvers"),
      ),
      ...(facts.openUntil === null ? [] : [field("Request open until", utcText(facts.openUntil))]),
      ...(facts.newAccount
        ? [field("Account", "the request pays an account the original did not go to", false)]
        : []),
    ],
    link: `${base}/#${encodeURIComponent(facts.invoice)}`,
    linkText: `Open ${facts.invoice} in PayOnce`,
    urgent: facts.need === "bank",
  };
}

function payoutMessage(facts: PayoutAlertFacts, base: string): AlertMessage {
  const supplier: string = oneLine(facts.supplier, MAX_NAME);
  return {
    title:
      facts.reference === null
        ? `A payout for ${facts.invoice} was sent outside PayOnce`
        : `Payout ${facts.reference} was sent outside PayOnce`,
    line: `${facts.amount} to ${supplier}`,
    fields: [
      field(
        "Invoice",
        facts.takenOn ? `${facts.invoice}, taken on as a new incident` : `${facts.invoice}, tied to this invoice`,
      ),
      field("Supplier", supplier),
      field("Amount", facts.amount),
      field("Status", facts.state),
    ],
    link: `${base}/#${encodeURIComponent(facts.invoice)}`,
    linkText: `Open ${facts.invoice} in PayOnce`,
    urgent: false,
  };
}

function runMessage(facts: RunAlertFacts, base: string): AlertMessage {
  return {
    title: `Pay run ${facts.run} is waiting for approval`,
    line: `${plural(facts.payments, "payment", "payments")}: ${facts.totals.join(", ")}`,
    fields: [
      field("Payments", String(facts.payments)),
      field("Totals", facts.totals.join(", ")),
      field("Approvers needed", String(facts.approvers)),
      ...(facts.openUntil === null ? [] : [field("Request open until", utcText(facts.openUntil))]),
    ],
    link: `${base}/#run/${facts.run}`,
    linkText: `Open pay run ${facts.run} in PayOnce`,
    urgent: false,
  };
}

function auditMessage(facts: AuditAlertFacts, base: string): AlertMessage {
  const what: string = facts.scope === "invoices" ? "Invoice timelines" : "Pay run timelines";
  const first: string =
    facts.first === null ? "" : `, ${facts.scope === "runs" ? "run " : ""}${facts.first} from line ${facts.line ?? 1}`;
  return {
    title:
      facts.scope === "invoices"
        ? "An audit trail in PayOnce no longer verifies"
        : "A pay run audit trail in PayOnce no longer verifies",
    line: "Check it with pnpm run audit before trusting the timeline",
    fields: [
      field(what, facts.broken === 0 ? "no breaks" : `${facts.broken} broken${first}`),
      field("Running hash", facts.runningHash),
    ],
    link: `${base}/`,
    linkText: "Open PayOnce",
    urgent: true,
  };
}

function cashMessage(facts: CashAlertFacts, base: string): AlertMessage {
  return {
    title: `${facts.currency} headroom is below 0`,
    line: `Headroom above the reserve floor is ${facts.headroom}`,
    fields: [
      field("Headroom", facts.headroom),
      field("Reserve floor", facts.floor ?? "not set"),
      field("Balance read at", facts.readAt === null ? "not known" : utcText(facts.readAt)),
    ],
    link: `${base}/`,
    linkText: "Open the cash panel in PayOnce",
    urgent: true,
  };
}

function summaryMessage(facts: SummaryAlertFacts, base: string): AlertMessage {
  const parts: string[] = [
    `${plural(facts.invoices, "invoice is", "invoices are")} waiting on a person`,
    `${plural(facts.runs, "pay run waits", "pay runs wait")} for approval`,
    ...(facts.audit === 0 ? [] : [`${plural(facts.audit, "audit trail does", "audit trails do")} not verify`]),
    ...(facts.cash === 0 ? [] : [`${plural(facts.cash, "currency is", "currencies are")} below 0 headroom`]),
  ];
  return {
    title: "PayOnce alerts are on",
    line: `${parts.join(", ")}. From now on each new one gets an alert of its own`,
    fields: [
      field("Invoices waiting on a person", String(facts.invoices)),
      field("Pay runs waiting for approval", String(facts.runs)),
    ],
    link: `${base}/`,
    linkText: "Open PayOnce",
    urgent: false,
  };
}

// base is the local page, such as http://127.0.0.1:4310.
export function alertMessage(facts: AlertFacts, base: string): AlertMessage {
  switch (facts.kind) {
    case "invoice":
      return invoiceMessage(facts, base);
    case "payout":
      return payoutMessage(facts, base);
    case "run":
      return runMessage(facts, base);
    case "audit":
      return auditMessage(facts, base);
    case "cash":
      return cashMessage(facts, base);
    case "summary":
      return summaryMessage(facts, base);
  }
}

// An incoming webhook message: text is the notification, and the blocks are the
// message. Incoming webhooks cannot set the channel, name or icon.
export function slackPayload(message: AlertMessage): unknown {
  return {
    text: slackText(`${message.title}: ${message.line}`),
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: oneLine(message.title, SLACK_HEADER_MAX), emoji: false },
      },
      { type: "section", text: { type: "mrkdwn", text: slackText(message.line) } },
      {
        type: "section",
        fields: message.fields.slice(0, SLACK_FIELDS_MAX).map((item: AlertField) => ({
          type: "mrkdwn",
          text: `*${slackText(item.name)}*\n${slackText(item.value)}`,
        })),
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<${message.link}|${slackText(message.linkText)}> on the machine running it. ${FOOTNOTE}`,
          },
        ],
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

// An execute-webhook message with one embed. The link is plain text in the
// description, out of content, so Discord makes no preview, and the embed has no
// url, which Discord may refuse for a loopback address.
export function discordPayload(message: AlertMessage, at: string): unknown {
  return {
    username: "PayOnce",
    content: discordText(oneLine(message.title, DISCORD_TITLE_MAX)),
    embeds: [
      {
        title: oneLine(message.title, DISCORD_TITLE_MAX),
        description: `${discordText(message.line)}\nOpen it in PayOnce on the machine running it: ${message.link}`,
        color: message.urgent ? RED : AMBER,
        fields: message.fields.map((item: AlertField) => ({
          name: item.name,
          value: discordText(oneLine(item.value, DISCORD_FIELD_VALUE_MAX - 100)),
          inline: item.inline,
        })),
        footer: { text: `PayOnce. ${FOOTNOTE}` },
        timestamp: at,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export function payloadFor(format: AlertFormat, message: AlertMessage, at: string): unknown {
  return format === "slack" ? slackPayload(message) : discordPayload(message, at);
}

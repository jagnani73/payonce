// What an alert says, and how it is posted to a Slack or Discord incoming webhook.
// Every message is built from an alert's stored facts: invoice numbers, supplier
// names, formatted amounts, dates, counts and reasons PayOnce wrote. They never
// hold email text, model output, account details or anything secret.

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

// Text in a message. outside is text PayOnce did not write itself, such as a
// supplier name from a pay run file or an outside payout, or a reason that names
// other invoices. Each format renders it as an inline code span, so it cannot
// become a link, a mention or markup. blank is what outside text reads as, in
// PayOnce's words, when nothing is left of it once hidden characters are dropped.
export interface AlertText {
  text: string;
  outside: boolean;
  blank: string;
}

export interface AlertField {
  name: string;
  value: AlertText;
  inline: boolean;
}

// One message, before it is shaped for Slack or Discord. The title holds only
// PayOnce's own words and checked identifiers. The parts of line are joined with
// a space. link is the one real link, to the local page, and only works on the
// machine running PayOnce, which every message says.
export interface AlertMessage {
  title: string;
  line: AlertText[];
  fields: AlertField[];
  link: string;
  linkText: string;
  urgent: boolean;
}

// Caps on text after it is escaped, well inside each service's limits: Slack's
// header is 150 characters and a field 2,000; Discord's title is 256, a field
// value 1,024 and a whole embed 6,000.
const MAX_SUPPLIER: number = 200;
const MAX_REASON: number = 600;
const MAX_VALUE: number = 300;
const SLACK_HEADER_MAX: number = 150;
const SLACK_FIELDS_MAX: number = 10;
const DISCORD_TITLE_MAX: number = 256;
const AMBER: number = 15105570;
const RED: number = 15158332;
const FOOTNOTE: string = "Sandbox, no real money.";
const NO_NAME: string = "(no name)";
const NO_REASON: string = "(no reason recorded)";
const CONTROL: RegExp = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
// Format characters (bidi controls, zero-width characters, the soft hyphen, tag
// characters and the rest of Unicode's Cf), which could reverse or hide part of
// a supplier name inside a code span, and the unassigned rest of the tag block.
const HIDDEN: RegExp = /[\p{Cf}\u{e0000}-\u{e007f}]/gu;
// An invoice number or a bank reference, as PayOnce accepts them.
const IDENTIFIER: RegExp = /^[A-Za-z0-9-]{1,40}$/;

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

// Control characters and line breaks become spaces.
export function oneLine(text: string): string {
  return text.replace(CONTROL, " ").trim();
}

// Escapes each character, then cuts to max characters with an ellipsis. It cuts
// between whole characters, so neither an escape nor a surrogate pair is split,
// and the result is never longer than max.
export function capped(text: string, max: number, escape: (char: string) => string): string {
  const pieces: string[] = Array.from(text, escape);
  const whole: string = pieces.join("");
  if (whole.length <= max) {
    return whole;
  }
  let out: string = "";
  for (const piece of pieces) {
    if (out.length + piece.length > max - 1) {
      break;
    }
    out += piece;
  }
  return `${out}…`;
}

// Slack reads &, < and > as control characters, so <!channel>, <@U123> and
// <url|text> cannot come from a value.
function slackChar(char: string): string {
  return char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char;
}

export function slackText(text: string): string {
  return Array.from(text, slackChar).join("");
}

// Discord markdown is escaped, so PayOnce's own text cannot turn into a heading,
// a masked link or a mention. allowed_mentions stops pings in any case.
function discordChar(char: string): string {
  return /[\\*_~`|<>[\]()#@]/.test(char) ? `\\${char}` : char;
}

// A link needs ://, or www. on Slack, so neither survives in outside text. A
// backtick would end the code span, so it becomes an apostrophe. Format
// characters are dropped.
export function defanged(text: string): string {
  return oneLine(text.replace(HIDDEN, "")).replace(/:\/\//g, "[:]//").replace(/\bwww\./gi, "www[.]").replace(/`/g, "'");
}

function identifier(value: string | null, fallback: string): string {
  return value !== null && IDENTIFIER.test(value) ? value : fallback;
}

// Outside text with nothing left once defanged reads as its blank, in PayOnce's
// words, so a message never holds an empty span.
function shown(part: AlertText): AlertText {
  return part.outside && defanged(part.text) === "" ? ours(part.blank) : part;
}

// Outside text is a code span: on Slack with &, < and > escaped, on Discord as is,
// because nothing inside a code span is read as markdown, a link or a mention.
function slackSpan(part: AlertText, max: number): string {
  const text: AlertText = shown(part);
  return text.outside
    ? `\`${capped(defanged(text.text), max - 2, slackChar)}\``
    : capped(oneLine(text.text), max, slackChar);
}

function discordSpan(part: AlertText, max: number): string {
  const text: AlertText = shown(part);
  return text.outside
    ? `\`${capped(defanged(text.text), max - 2, (char: string): string => char)}\``
    : capped(oneLine(text.text), max, discordChar);
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

function ours(text: string): AlertText {
  return { text, outside: false, blank: "" };
}

function theirs(text: string, blank: string): AlertText {
  return { text, outside: true, blank };
}

function field(name: string, value: AlertText, inline: boolean = true): AlertField {
  return { name, value, inline };
}

// An invoice number PayOnce did not accept is never shown or linked to.
function invoiceLink(invoice: string, known: boolean, base: string): { link: string; linkText: string } {
  return known
    ? { link: `${base}/#${encodeURIComponent(invoice)}`, linkText: `Open ${invoice} in PayOnce` }
    : { link: `${base}/`, linkText: "Open PayOnce" };
}

function invoiceMessage(facts: InvoiceAlertFacts, base: string): AlertMessage {
  const known: boolean = IDENTIFIER.test(facts.invoice);
  const invoice: string = known ? facts.invoice : "an invoice";
  const title: string =
    facts.need === "bank"
      ? `Bank deadline passed on ${invoice}`
      : `${known ? invoice : "An invoice"} ${NEED_TITLES[facts.need]}`;
  return {
    title,
    line: [ours(`${facts.amount} to`), theirs(facts.supplier, NO_NAME)],
    fields: [
      field("Supplier", theirs(facts.supplier, NO_NAME)),
      field("Amount", ours(facts.amount)),
      field("Why", theirs(facts.reason, NO_REASON), false),
      field(
        "Waiting on",
        ours(facts.approvers === null ? "a person" : plural(facts.approvers, "approver", "approvers")),
      ),
      ...(facts.openUntil === null ? [] : [field("Request open until", ours(utcText(facts.openUntil)))]),
      ...(facts.newAccount
        ? [field("Account", ours("the request pays an account the original did not go to"), false)]
        : []),
    ],
    ...invoiceLink(invoice, known, base),
    urgent: facts.need === "bank",
  };
}

function payoutMessage(facts: PayoutAlertFacts, base: string): AlertMessage {
  const known: boolean = IDENTIFIER.test(facts.invoice);
  const invoice: string = known ? facts.invoice : "an invoice";
  const reference: string | null = facts.reference === null ? null : identifier(facts.reference, "");
  return {
    title:
      reference === null || reference === ""
        ? `A payout for ${invoice} was sent outside PayOnce`
        : `Payout ${reference} was sent outside PayOnce`,
    line: [ours(`${facts.amount} to`), theirs(facts.supplier, NO_NAME)],
    fields: [
      field("Invoice", ours(facts.takenOn ? `${invoice}, taken on as a new incident` : `${invoice}, tied to this invoice`)),
      field("Supplier", theirs(facts.supplier, NO_NAME)),
      field("Amount", ours(facts.amount)),
      field("Status", ours(facts.state)),
    ],
    ...invoiceLink(invoice, known, base),
    urgent: false,
  };
}

function runMessage(facts: RunAlertFacts, base: string): AlertMessage {
  return {
    title: `Pay run ${facts.run} is waiting for approval`,
    line: [ours(`${plural(facts.payments, "payment", "payments")}: ${facts.totals.join(", ")}`)],
    fields: [
      field("Payments", ours(String(facts.payments))),
      field("Totals", ours(facts.totals.join(", "))),
      field("Approvers needed", ours(String(facts.approvers))),
      ...(facts.openUntil === null ? [] : [field("Request open until", ours(utcText(facts.openUntil)))]),
    ],
    link: `${base}/#run/${facts.run}`,
    linkText: `Open pay run ${facts.run} in PayOnce`,
    urgent: false,
  };
}

function auditMessage(facts: AuditAlertFacts, base: string): AlertMessage {
  const what: string = facts.scope === "invoices" ? "Invoice timelines" : "Pay run timelines";
  const name: string = identifier(facts.first, "one");
  const first: string =
    facts.first === null ? "" : `, ${facts.scope === "runs" ? "run " : ""}${name} from line ${facts.line ?? 1}`;
  return {
    title:
      facts.scope === "invoices"
        ? "An audit trail in PayOnce no longer verifies"
        : "A pay run audit trail in PayOnce no longer verifies",
    line: [ours("Check it with pnpm run audit before trusting the timeline")],
    fields: [
      field(what, ours(facts.broken === 0 ? "no breaks" : `${facts.broken} broken${first}`)),
      field("Running hash", ours(facts.runningHash)),
    ],
    link: `${base}/`,
    linkText: "Open PayOnce",
    urgent: true,
  };
}

function cashMessage(facts: CashAlertFacts, base: string): AlertMessage {
  return {
    title: `${identifier(facts.currency, "A currency")} headroom is below 0`,
    line: [ours(`Headroom above the reserve floor is ${facts.headroom}`)],
    fields: [
      field("Headroom", ours(facts.headroom)),
      field("Reserve floor", ours(facts.floor ?? "not set")),
      field("Balance read at", ours(facts.readAt === null ? "not known" : utcText(facts.readAt))),
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
    line: [ours(`${parts.join(", ")}. From now on each new one gets an alert of its own`)],
    fields: [
      field("Invoices waiting on a person", ours(String(facts.invoices))),
      field("Pay runs waiting for approval", ours(String(facts.runs))),
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

function capFor(item: AlertField): number {
  return item.name === "Supplier" ? MAX_SUPPLIER : item.name === "Why" ? MAX_REASON : MAX_VALUE;
}

// An incoming webhook message: text is the notification and holds only the
// title, and the blocks are the message. Incoming webhooks cannot set the
// channel, name or icon. Every mrkdwn object is verbatim, so Slack links no bare
// URL, domain or channel name and parses no mention; the <url|text> link to the
// local page still works.
export function slackPayload(message: AlertMessage): unknown {
  return {
    text: capped(oneLine(message.title), SLACK_HEADER_MAX, slackChar),
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: capped(oneLine(message.title), SLACK_HEADER_MAX, (char: string): string => char), emoji: false },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: message.line.map((part: AlertText): string => slackSpan(part, MAX_SUPPLIER)).join(" "),
          verbatim: true,
        },
      },
      {
        type: "section",
        fields: message.fields.slice(0, SLACK_FIELDS_MAX).map((item: AlertField) => ({
          type: "mrkdwn",
          text: `*${slackText(item.name)}*\n${slackSpan(item.value, capFor(item))}`,
          verbatim: true,
        })),
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<${message.link}|${slackText(message.linkText)}> on the machine running it. ${FOOTNOTE}`,
            verbatim: true,
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
    content: capped(oneLine(message.title), DISCORD_TITLE_MAX, discordChar),
    embeds: [
      {
        title: capped(oneLine(message.title), DISCORD_TITLE_MAX, (char: string): string => char),
        description: `${message.line.map((part: AlertText): string => discordSpan(part, MAX_SUPPLIER)).join(" ")}\nOpen it in PayOnce on the machine running it: ${message.link}`,
        color: message.urgent ? RED : AMBER,
        fields: message.fields.map((item: AlertField) => ({
          name: item.name,
          value: discordSpan(item.value, capFor(item)),
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

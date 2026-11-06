// What an alert says, and how it is posted to a Slack or Discord incoming webhook.
// Every message is built from an alert's stored facts: invoice numbers, supplier
// names, formatted amounts, dates, counts and reasons PayOnce wrote. They never
// hold email text, model output, account details or anything secret. The inbox
// alert is a count: no sender, name, subject or text of an uploaded email.

import { RAIL_FAILURE_CODES } from "../outages/outages.js";
import { isBreakKind, KIND_LABELS } from "../recon/recon-match.js";

export type AlertFormat = "slack" | "discord";

// What an invoice waits on, first match wins: an approval of paying a held
// invoice, an approval of a replacement, a person checking a payment found late
// that may pay it a second time, a person closing a paid one, a person deciding
// on a held one nobody can approve yet, the bank's deadline, a payout sent
// outside PayOnce, a call to the supplier, or anything else.
export type InvoiceNeed =
  | "approve-held"
  | "approve"
  | "twice"
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
  // recon is reconciliation's record, one chain, so broken is 0 or 1 and first is
  // null.
  scope: "invoices" | "runs" | "recon";
  broken: number;
  // The first broken timeline (an invoice number or a run number) and its line.
  // For recon, line is null when the lines from the start were removed.
  first: string | null;
  line: number | null;
  // "started again" once the running hash went missing and PayOnce started it
  // again, whatever it reads now.
  runningHash: "matches" | "missing" | "does not match" | "started again";
  // How many invoices, runs or opened breaks have no line at all.
  withoutLine: number;
}

export interface CashAlertFacts {
  kind: "cash";
  currency: string;
  headroom: string;
  floor: string | null;
  readAt: string | null;
}

// Supplier emails uploaded and waiting for a person to pick their invoice.
export interface InboxAlertFacts {
  kind: "inbox";
  waiting: number;
}

// An outage declared on a rail, or ended by a person. It never names who ended
// it, their note, an approver, an account or Airwallex's failure message.
export interface OutageAlertFacts {
  kind: "outage";
  outage: number;
  currency: string;
  method: string;
  state: "active" | "ended";
  // Rail-level codes. The message adds PayOnce's own label to each.
  codes: string[];
  payees: number;
  windowMinutes: number;
  // The bank's short references of the payouts counted, five at most.
  references: string[];
  declaredAt: string;
  endedAt: string | null;
  // The invoices and runs it held.
  held: number;
}

// Reconciliation's breaks that wait on a person, by count and kind, with the
// newest one's wallet, invoice and the bank's short reference. Never Airwallex's
// description or reference text, a note or a name.
export interface ReconAlertFacts {
  kind: "recon";
  open: number;
  kinds: { kind: string; count: number }[];
  currencies: string[];
  newestKind: string;
  newestCurrency: string | null;
  newestInvoice: string | null;
  newestReference: string | null;
}

export interface SummaryAlertFacts {
  kind: "summary";
  invoices: number;
  runs: number;
  audit: number;
  cash: number;
  // Emails waiting in the inbox. Absent in a summary queued before inbox alerts.
  inbox?: number;
  // Active outages. Absent in a summary queued before outages.
  outages?: number;
  // Open reconciliation breaks. Absent in a summary queued before reconciliation.
  recon?: number;
}

export type AlertFacts =
  | InvoiceAlertFacts
  | PayoutAlertFacts
  | RunAlertFacts
  | AuditAlertFacts
  | CashAlertFacts
  | InboxAlertFacts
  | OutageAlertFacts
  | ReconAlertFacts
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
  twice: "may have been paid twice",
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
    urgent: facts.need === "bank" || facts.need === "twice",
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

// Shown only when something has no line, so other audit alerts read as before.
function withoutLineField(facts: AuditAlertFacts, what: string): AlertField[] {
  const count: number = Number.isSafeInteger(facts.withoutLine) ? facts.withoutLine : 0;
  return count === 0 ? [] : [field("With no line at all", ours(`${count} ${count === 1 ? what.replace(/s$/, "") : what}`))];
}

function reconAuditMessage(facts: AuditAlertFacts, base: string): AlertMessage {
  const line: string =
    facts.broken === 0
      ? "no breaks"
      : facts.line === null
        ? "lines removed from its start"
        : `broken from line ${Number.isSafeInteger(facts.line) ? facts.line : 1}`;
  return {
    title: "PayOnce's reconciliation record no longer verifies",
    line: [ours("Check it with pnpm run audit before trusting what reconciliation found or what people explained")],
    fields: [
      field("Reconciliation record", ours(line)),
      field("Running hash", ours(facts.runningHash)),
      ...withoutLineField(facts, "breaks"),
    ],
    link: `${base}/#recon`,
    linkText: "Open reconciliation in PayOnce",
    urgent: true,
  };
}

function auditMessage(facts: AuditAlertFacts, base: string): AlertMessage {
  if (facts.scope === "recon") {
    return reconAuditMessage(facts, base);
  }
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
      ...withoutLineField(facts, facts.scope === "invoices" ? "invoices" : "pay runs"),
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

function inboxMessage(facts: InboxAlertFacts, base: string): AlertMessage {
  return {
    title: `${plural(facts.waiting, "supplier email waits", "supplier emails wait")} in the inbox`,
    line: [ours("A person picks the invoice each one is for, or dismisses it. PayOnce delivers none by itself")],
    fields: [field("Waiting", ours(String(facts.waiting)))],
    link: `${base}/`,
    linkText: "Open the inbox in PayOnce",
    urgent: false,
  };
}

// "USD LOCAL", from a currency and a method PayOnce checks, so the title holds
// only its own words.
function railText(facts: OutageAlertFacts): string {
  return /^[A-Z]{3}$/.test(facts.currency) && (facts.method === "LOCAL" || facts.method === "SWIFT")
    ? `${facts.currency} ${facts.method}`
    : "a currency and transfer method";
}

// "91402 and 91401", with PayOnce's label after each code when labelled.
function outageCodes(facts: OutageAlertFacts, labelled: boolean): string {
  const named: string[] = facts.codes
    .filter((code: string): boolean => /^[0-9]{5}$/.test(code))
    .map((code: string): string => (labelled ? `${code} (${RAIL_FAILURE_CODES[code] ?? "rail failure"})` : code));
  return named.length <= 1 ? (named[0] ?? "a rail-level code") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

// "20:42 UTC". The fields carry the dates.
function clockText(iso: string | null): string {
  const at: Date = new Date(iso ?? "");
  return Number.isNaN(at.getTime()) ? "a time not known" : `${at.toISOString().slice(11, 16)} UTC`;
}

// The lines stay well under the 200 characters a line part is cut at, so the
// codes' labels are in the fields only.
function outageMessage(facts: OutageAlertFacts, base: string): AlertMessage {
  const rail: string = railText(facts);
  const references: string[] = facts.references.filter((reference: string): boolean => /^[A-Z0-9-]{1,30}$/.test(reference));
  const payees: string = plural(facts.payees, "payee", "payees");
  const fields: AlertField[] = [
    field("Rail", ours(rail)),
    field("Failure codes", ours(outageCodes(facts, true))),
    field("Payees", ours(String(facts.payees))),
    field("Window", ours(plural(facts.windowMinutes, "minute", "minutes"))),
    field("Declared", ours(utcText(facts.declaredAt))),
    ...(references.length === 0 ? [] : [field("Payouts", ours(references.join(", ")), false)]),
  ];
  if (facts.state === "active") {
    return {
      title: `Outage declared on ${rail}`,
      line: [
        ours(
          `Payouts to ${payees} failed with ${outageCodes(facts, false)} within ${plural(facts.windowMinutes, "minute", "minutes")}. PayOnce opens no new payment on ${rail} until a person ends the outage`,
        ),
      ],
      fields,
      link: `${base}/`,
      linkText: "Open PayOnce",
      urgent: true,
    };
  }
  return {
    title: `Outage on ${rail} ended`,
    line: [
      ours(
        `Declared at ${clockText(facts.declaredAt)} after payouts to ${payees} failed, ended at ${clockText(facts.endedAt)}. PayOnce opens payments on ${rail} again, and the ${plural(facts.held, "invoice or run", "invoices and runs")} it held carry on`,
      ),
    ],
    fields: [
      ...fields,
      field("Ended", ours(facts.endedAt === null ? "not known" : utcText(facts.endedAt))),
      field("Held", ours(String(facts.held))),
    ],
    link: `${base}/`,
    linkText: "Open PayOnce",
    urgent: false,
  };
}

const BALANCE_KINDS: readonly string[] = ["balance-gap", "balance-differs"];

function reconMessage(facts: ReconAlertFacts, base: string): AlertMessage {
  const currency: string | null =
    facts.newestCurrency !== null && /^[A-Z]{3}$/.test(facts.newestCurrency) ? facts.newestCurrency : null;
  const kinds: string = facts.kinds
    .map((entry: { kind: string; count: number }): string =>
      isBreakKind(entry.kind) && Number.isSafeInteger(entry.count) ? `${KIND_LABELS[entry.kind]}: ${entry.count}` : "",
    )
    .filter((text: string): boolean => text !== "")
    .join(", ");
  const wallets: string = facts.currencies.filter((code: string): boolean => /^[A-Z]{3}$/.test(code)).join(", ");
  const reference: string | null =
    facts.newestReference !== null && /^[A-Z0-9-]{1,30}$/.test(facts.newestReference) ? facts.newestReference : null;
  const invoice: string = identifier(facts.newestInvoice, "");
  const newest: string[] = [
    ...(isBreakKind(facts.newestKind) ? [KIND_LABELS[facts.newestKind]] : []),
    ...(reference === null ? [] : [reference]),
    ...(invoice === "" ? [] : [invoice]),
  ];
  return {
    title:
      BALANCE_KINDS.includes(facts.newestKind) && currency !== null
        ? `The ${currency} balance does not add up from its movements`
        : `${plural(facts.open, "wallet movement needs", "wallet movements need")} a person`,
    line: [
      ours(
        "PayOnce matched each wallet's movements in Airwallex with its transfers and its ledger. It moved no money and changed no invoice",
      ),
    ],
    fields: [
      field("Waiting on a person", ours(String(facts.open))),
      ...(wallets === "" ? [] : [field("Wallets", ours(wallets))]),
      ...(kinds === "" ? [] : [field("Kinds", ours(kinds), false)]),
      ...(newest.length === 0 ? [] : [field("Newest", ours(newest.join(", ")), false)]),
    ],
    link: `${base}/#recon`,
    linkText: "Open reconciliation in PayOnce",
    urgent: facts.kinds.some((entry: { kind: string }): boolean => entry.kind === "paid-then-returned"),
  };
}

function summaryMessage(facts: SummaryAlertFacts, base: string): AlertMessage {
  const inbox: number = facts.inbox ?? 0;
  const outages: number = facts.outages ?? 0;
  const recon: number = facts.recon ?? 0;
  const parts: string[] = [
    `${plural(facts.invoices, "invoice is", "invoices are")} waiting on a person`,
    `${plural(facts.runs, "pay run waits", "pay runs wait")} for approval`,
    ...(outages === 0 ? [] : [`${plural(outages, "outage is", "outages are")} active`]),
    ...(inbox === 0 ? [] : [`${plural(inbox, "supplier email waits", "supplier emails wait")} in the inbox`]),
    ...(facts.audit === 0 ? [] : [`${plural(facts.audit, "audit trail does", "audit trails do")} not verify`]),
    ...(facts.cash === 0 ? [] : [`${plural(facts.cash, "currency is", "currencies are")} below 0 headroom`]),
    ...(recon === 0 ? [] : [`${plural(recon, "wallet movement needs", "wallet movements need")} a person`]),
  ];
  return {
    title: "PayOnce alerts are on",
    line: [ours(`${parts.join(", ")}. From now on each new one gets an alert of its own`)],
    fields: [
      field("Invoices waiting on a person", ours(String(facts.invoices))),
      field("Pay runs waiting for approval", ours(String(facts.runs))),
      ...(inbox === 0 ? [] : [field("Emails waiting in the inbox", ours(String(inbox)))]),
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
    case "inbox":
      return inboxMessage(facts, base);
    case "outage":
      return outageMessage(facts, base);
    case "recon":
      return reconMessage(facts, base);
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

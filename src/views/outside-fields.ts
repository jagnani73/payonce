import { RAIL_PATTERN, REFERENCE_PATTERN } from "../domain/patterns.js";
import type { ReasonView } from "../domain/reasons.js";
import { UNSHOWN_REFERENCE } from "../text/printable.js";
import type { AuditExport, RunAuditExport } from "../store/audit-trail.js";
import type {
  AccountView,
  ApproverChoice,
  ArrivalView,
  AuditCheckView,
  AuditLineView,
  Barred,
  CallbackEvidenceView,
  CashView,
  DecisionOption,
  DuplicateView,
  FailureView,
  FxView,
  IncidentRow,
  IncidentsView,
  IncidentView,
  OutageCardView,
  OutagesView,
  OutageStrip,
  PhoneOnFileView,
  QueueItem,
  ReportsView,
  RequestView,
  RunDecisionOption,
  RunListRow,
  RunRequestView,
  RunRowItem,
  RunRowView,
  RunsView,
  RunView,
  Situation,
  RunSituation,
  SupplierView,
  SuppliersView,
  TermsView,
  TimelineView,
  Why,
} from "./contract.js";

// Which strings in a view are text PayOnce did not write, field by field, for
// the MCP server's projection (surfaces/mcp/mcp-text.ts). A field the contract
// types Theirs is listed with where its text comes from and is always wrapped.
// A field PayOnce builds from fixed words and closed values is listed "plain". A
// field that holds PayOnce's words only in some forms is wrapped unless its
// check vouches for it. Every other string is wrapped as "unknown" unless it is
// a token (a time, an id, a code, an amount), so a field added to a view later
// is wrapped until it is listed here. A link is not a token: it passes only in
// the fields below that hold one, in the form PayOnce builds there.

// Where text PayOnce did not write came from. quoted is PayOnce's own wording
// that can carry such text, such as a timeline line or a sentence that names a
// person. unknown is any other string the projection cannot vouch for.
export type OutsideSource = "supplier" | "email" | "airwallex" | "run-file" | "person" | "quoted" | "unknown";

export interface Checked {
  from: OutsideSource;
  // True when the text is in a form PayOnce vouches for, given the object that holds it.
  plainWhen: (text: string, parent: Readonly<Record<string, unknown>>) => boolean;
  // The form holds no words, such as a link: only a phone number on file is cut from it.
  closed?: true;
}

export type Field = OutsideSource | "plain" | Checked;

type Join<P extends string, K extends string> = P extends "" ? K : `${P}.${K}`;

// Every path to a string in T, as the projection walks it: keys joined by dots,
// and [] for an array's items.
export type StringPaths<T, P extends string = ""> = T extends string
  ? P
  : T extends number | boolean | null | undefined
    ? never
    : T extends readonly (infer U)[]
      ? StringPaths<U, `${P}[]`>
      : T extends object
        ? { [K in keyof T & string]-?: StringPaths<T[K], Join<P, K>> }[keyof T & string]
        : never;

export type Fields<T> = { readonly [K in StringPaths<T>]?: Field };

type Under<P extends string, F> = { readonly [K in keyof F & string as `${P}.${K}`]: F[K] };

export function under<P extends string, F extends Readonly<Record<string, Field>>>(prefix: P, fields: F): Under<P, F> {
  return Object.fromEntries(Object.entries(fields).map(([key, field]: [string, Field]): [string, Field] => [`${prefix}.${key}`, field])) as Under<P, F>;
}

function quotedUnless(plainWhen: Checked["plainWhen"]): Checked {
  return { from: "quoted", plainWhen };
}

function codeIn(codes: readonly string[]): Checked["plainWhen"] {
  return (_text: string, parent: Readonly<Record<string, unknown>>): boolean => codes.includes(String(parent["code"]));
}

function fits(pattern: RegExp): Checked["plainWhen"] {
  return (text: string): boolean => pattern.test(text);
}

// ---------- the forms PayOnce vouches for ----------

// The email evidence and the findings' summary as emailEvidence and summarise
// word them now. An older PayOnce named the sender's address there, and an older
// reader wrote the summary itself, so anything else is wrapped. A change to that
// wording makes them wrapped until these patterns follow it.
const FOUND: string =
  "(supplier reports the payment has not arrived(, asks for payment to a different account)?(, asks to hold, cancel or not pay the invoice)?|asks for payment to a different account(, asks to hold, cancel or not pay the invoice)?|asks to hold, cancel or not pay the invoice)";
const SUMMARY: string = `(${FOUND}(, and some emails could not be read)?|nothing relevant found|the emails could not be read|the emails have not been read yet|no emails on file)`;
const COUNT: string = "[1-9][0-9]{0,5}";
const EMAIL_SUMMARY: RegExp = new RegExp(`^${SUMMARY}$`);
const EMAIL_EVIDENCE: RegExp = new RegExp(
  `^${SUMMARY}(, (1 email|${COUNT} emails) on file(, ${COUNT} with text PayOnce could not read)?(, no supplier domain on file to check (1 sender|${COUNT} senders) against|, (1 sender does|${COUNT} senders do) not match the supplier on file)?)?$`,
);
// The keyword reader's name, or model ids as READER_MODEL lists them.
const READER_NAME: RegExp = /^(keyword placeholder|[A-Za-z0-9._:/-]{1,60}(, then [A-Za-z0-9._:/-]{1,60}){0,4})$/;
const FX_RATE: RegExp = /^1 [A-Z]{3} = [0-9.e+-]{1,30} [A-Z]{3}$/;
const FX_MARKUP: RegExp = /^[0-9.]{1,20}% from mid-market [0-9.e+-]{1,30}$/;
// What this process says when the server's RESERVE_FLOORS could not be read, in
// place of the server's words, which it cannot vouch for.
export const SERVER_FLOORS_UNREADABLE: string = "PayOnce's server could not read RESERVE_FLOORS";

// Why codes whose text is one of PayOnce's fixed sentences. The others name a
// person, an approver's limit or a setting as written, so they are wrapped.
const FIXED_WHY: readonly string[] = [
  "not-waiting",
  "expired",
  "no-approver",
  "not-escalated",
  "callback-blocked",
  "not-paid",
  "live",
  "no-outage",
  "not-late",
  "closed",
  "approvers-unset",
  "drafted",
  "not-built",
  "draft",
  "copied",
  "sent",
  "dismissed",
];
// The second-approver reasons that are whole fixed sentences. The pay run ones
// name a payee, and an unrecognised one is stored text.
const FIXED_NEEDED_WHY: readonly string[] = [
  "new-account",
  "starter-unknown",
  "above-threshold",
  "never-paid",
  "paid-before-keeping-accounts",
  "account-not-paid-before",
  "never-paid-on-approval",
  "other-invoice-account",
  "run-above-threshold",
  "uploader-unknown",
];

const WHY_TEXT: Checked = quotedUnless(codeIn(FIXED_WHY));
const RAIL: Checked = { from: "unknown", plainWhen: fits(RAIL_PATTERN) };
const REFERENCE: Checked = { from: "airwallex", plainWhen: fits(REFERENCE_PATTERN) };
// A reference as shownReference gives it: in its own form, or PayOnce's words for one that is not.
const SHOWN_REFERENCE: Checked = {
  from: "airwallex",
  plainWhen: (text: string): boolean => REFERENCE_PATTERN.test(text) || text === UNSHOWN_REFERENCE,
};

// The page's links, each in the one form PayOnce builds it from an invoice number
// (INVOICE_ID_PATTERN) or a run's number. Any other text in these fields is wrapped.
const INVOICE: string = "[A-Za-z0-9-]{1,40}";
const RUN: string = "[0-9]{1,10}";

function link(source: string): Checked {
  return { from: "unknown", plainWhen: fits(new RegExp(`^${source}$`)), closed: true };
}

const ROW_LINK: Checked = link(
  `(#incident/${INVOICE}(\\?do=(approve|callback|close-paid|close-unpaid|end-outage|trace))?|#run/${RUN}(\\?do=(approve|recheck))?)`,
);
const AUDIT_EXPORT_LINK: Checked = link(`/api/(incidents/${INVOICE}|runs/${RUN})/audit\\?format=(json|csv)`);
const BANK_DETAILS_LINK: Checked = link(`/api/incidents/${INVOICE}/bank-details`);
const LEDGER_EXPORT_LINK: Checked = link("/api/audit/export");

// ---------- shared pieces ----------

const WHY = { text: WHY_TEXT } as const satisfies Fields<Why>;
const CAN = { "why.text": WHY_TEXT } as const;
const FAILURE = { code: "plain", words: "plain" } as const satisfies Fields<FailureView>;
const ACCOUNT = { label: "airwallex" } as const satisfies Fields<AccountView>;
const FX = {
  rate: { from: "unknown", plainWhen: fits(FX_RATE) },
  markup: { from: "unknown", plainWhen: fits(FX_MARKUP) },
} as const satisfies Fields<FxView>;
// Built only from an estimate vouchedArrival accepts (views/parts.ts).
const ARRIVAL = { text: "plain", route: "plain", due: "plain", "sentToday.text": "plain", note: "plain" } as const satisfies Fields<ArrivalView>;
// A reason PayOnce recognised is written again from its code and closed slots.
const REASON = {
  label: "plain",
  text: quotedUnless((_text: string, parent: Readonly<Record<string, unknown>>): boolean => parent["code"] !== "unrecognised"),
  "clauses[].label": "plain",
} as const satisfies Fields<ReasonView>;
const TIMELINE = { "lines[].kindLabel": "plain", "lines[].lead": "plain", "lines[].text": "quoted" } as const satisfies Fields<TimelineView>;
const AUDIT_LINE = { problem: "plain", "exports.json": AUDIT_EXPORT_LINK, "exports.csv": AUDIT_EXPORT_LINK } as const satisfies Fields<AuditLineView>;
const APPROVER = { name: "person", ...under("why", WHY) } as const satisfies Fields<ApproverChoice>;
// The engine's and runs.ts's fixed words for why someone may not approve.
const BARRED = {
  name: "person",
  "why.text": quotedUnless(codeIn(["started", "uploaded-run", "recorded-callback", "set-callback-phone"])),
} as const satisfies Fields<Barred>;
// Why a person cannot propose, confirm or withdraw a phone number now. The
// waiting proposal's refusal names who proposed it.
const CONTACT_CAN = { "why.text": quotedUnless(codeIn(["no-phone-proposal", "phone-proposal-lapsed"])) } as const;
// The phone on file, by its ending, and who put it there.
const PHONE_ON_FILE = {
  originText: "plain",
  proposedBy: "person",
  proposedSource: "plain",
  confirmedBy: "person",
  confirmedSource: "plain",
  "changed.text": "plain",
} as const satisfies Fields<PhoneOnFileView>;
const CALLBACK = { calledBy: "person", spokeTo: "person", confirmed: "person" } as const satisfies Fields<CallbackEvidenceView>;
const DUPLICATE = { label: "plain" } as const satisfies Fields<DuplicateView>;
const OUTAGE_STRIP = { rail: RAIL, sendsText: "plain" } as const satisfies Fields<OutageStrip>;

// The labels come from fixed tables, with an outage's or a run's number. The
// other sentences can name a person, a reference as Airwallex gave it, or a
// stored reason, so they are quoted.
const SITUATION = {
  label: "plain",
  detail: "quoted",
  next: "quoted",
  ...under("why", REASON),
  "blockers[].text": "plain",
  "also[]": "quoted",
  "waitingOn.names[]": "person",
  ...under("can.approve", CAN),
  ...under("can.recordCallback", CAN),
  ...under("can.closeAsPaid", CAN),
  ...under("can.closeUnpaid", CAN),
  ...under("can.endOutage", CAN),
  ...under("can.draftTrace", CAN),
  ...under("can.checkNow", CAN),
} as const satisfies Fields<Situation>;

const RUN_SITUATION = { label: "plain", detail: "quoted", next: "quoted", why: "quoted", "waitingOn.names[]": "person" } as const satisfies Fields<RunSituation>;

const INCIDENT_ROW = {
  supplier: "supplier",
  ...under("situation", SITUATION),
  "incident.cause": "quoted",
  "tags[].text": "plain",
  "primary.label": "plain",
  "primary.href": ROW_LINK,
} as const satisfies Fields<IncidentRow>;

const RUN_ROW_ITEM = {
  fileName: "person",
  label: "plain",
  next: "quoted",
  "primary.label": "plain",
  "primary.href": ROW_LINK,
} as const satisfies Fields<RunRowItem>;

export const QUEUE_ITEM = { ...under("row", { ...INCIDENT_ROW, ...RUN_ROW_ITEM }) } as const satisfies Fields<QueueItem>;

// ---------- the payment page ----------

const TERMS = {
  title: "plain",
  supplier: "supplier",
  ...under("account", ACCOUNT),
  ...under("fx", FX),
  ...under("reason", REASON),
  "original.reference": REFERENCE,
  "original.stateLabel": "plain",
  ...under("original.failure", FAILURE),
  emails: quotedUnless(fits(EMAIL_EVIDENCE)),
  ...under("duplicates[]", DUPLICATE),
  ...under("callback", CALLBACK),
  ...under("arrival", ARRIVAL),
} as const satisfies Fields<TermsView>;

const REQUEST = {
  // "Approved by" names the people who signed.
  label: quotedUnless((_text: string, parent: Readonly<Record<string, unknown>>): boolean => parent["state"] !== "approved"),
  "neededWhy.text": quotedUnless(codeIn(FIXED_NEEDED_WHY)),
  "signoffs[].name": "person",
  ...under("approvers[]", APPROVER),
  ...under("barred[]", BARRED),
  ...under("terms", TERMS),
} as const satisfies Fields<RequestView>;

const OPTION = {
  title: "plain",
  // "Sends ... to <account label>", "Withdraws request #3 (approved by ...)".
  "consequence[]": "quoted",
  ...under("can", CAN),
  ...under("approvers[]", APPROVER),
  formPath: BANK_DETAILS_LINK,
  "covers[].text": "plain",
  "namesOnly[].text": "quoted",
  "withdraws.approvedBy[]": "person",
  rail: RAIL,
  "enders[]": "person",
} as const satisfies Fields<DecisionOption>;

export const INCIDENT_FIELDS = {
  "payment.supplier": "supplier",
  "payment.startedBy": "person",
  ...under("situation", SITUATION),
  "incident.cause": "quoted",
  "summary[].lead": "plain",
  "summary[].text": "quoted",
  "summary[].refs[].reference": SHOWN_REFERENCE,
  ...under("decision.open.request", REQUEST),
  "decision.open.cautions[].text": "plain",
  ...under("decision.open.options[]", OPTION),
  "decision.closed.by": "person",
  "decision.closed.note": "person",
  ...under("decision.checkNow", CAN),
  "transfers[].reference": SHOWN_REFERENCE,
  "transfers[].stateLabel": "plain",
  ...under("transfers[].failure", FAILURE),
  ...under("transfers[].account", ACCOUNT),
  "transfers[].onRequest.approvedBy[]": "person",
  ...under("transfers[].fx", FX),
  ...under("transfers[].arrival", ARRIVAL),
  "emails.findings.summary": quotedUnless(fits(EMAIL_SUMMARY)),
  "emails.findings.readBy": { from: "unknown", plainWhen: fits(READER_NAME) },
  "emails.unread.text": "plain",
  "emails.senderWarnings[]": "quoted",
  "emails.emails[].from": "email",
  "emails.emails[].fromName": "email",
  "emails.emails[].replyTo[]": "email",
  "emails.emails[].subject": "email",
  "emails.emails[].body": "email",
  "emails.emails[].styleText": "email",
  "emails.emails[].attachments[].name": "email",
  "emails.emails[].attachments[].type": "email",
  "emails.emails[].notes[]": "plain",
  "emails.emails[].uploadedBy": "person",
  "messages.drafts[].label": "plain",
  "messages.drafts[].subject": "quoted",
  "messages.drafts[].body": "quoted",
  "messages.drafts[].stateLabel": "plain",
  "messages.drafts[].createdBy": "person",
  "messages.drafts[].copiedBy": "person",
  "messages.drafts[].sentBy": "person",
  "messages.drafts[].dismissedBy": "person",
  "messages.drafts[].dismissNote": "person",
  "messages.drafts[].changed[]": "quoted",
  "messages.drafts[].noLongerFits": "plain",
  ...under("messages.drafts[].can.copy", CAN),
  ...under("messages.drafts[].can.markSent", CAN),
  ...under("messages.drafts[].can.dismiss", CAN),
  "messages.offers[].label": "plain",
  "messages.offers[].why": "plain",
  "messages.withheld[].label": "plain",
  "messages.withheld[].why": "plain",
  "messages.notOffered[].label": "plain",
  "messages.notOffered[].why": "plain",
  ...under("timeline", TIMELINE),
  ...under("audit", AUDIT_LINE),
  "supplier.name": "supplier",
  ...under("supplier.account", ACCOUNT),
  ...under("supplier.phone.onFile", PHONE_ON_FILE),
  "supplier.phone.pending.proposedBy": "person",
  "supplier.emailDomain": "supplier",
  "supplier.cautions.top": "plain",
  ...under("related.secondBills[]", DUPLICATE),
  "related.outage.rail": RAIL,
} as const satisfies Fields<IncidentView>;

// ---------- lists ----------

export const INCIDENTS_FIELDS = {
  "query.me": "person",
  "query.q": "person",
  "scopes[].label": "plain",
  ...under("outages[]", OUTAGE_STRIP),
  ...under("rows[]", INCIDENT_ROW),
} as const satisfies Fields<IncidentsView>;

// ---------- pay runs ----------

const RUN_LIST_ROW = { fileName: "person", uploadedBy: "person", ...under("situation", RUN_SITUATION) } as const satisfies Fields<RunListRow>;

export const RUNS_FIELDS = { ...under("rows[]", RUN_LIST_ROW), "upload.columns[].note": "plain" } as const satisfies Fields<RunsView>;

const RUN_REQUEST = {
  label: quotedUnless((_text: string, parent: Readonly<Record<string, unknown>>): boolean => parent["state"] !== "approved"),
  "neededWhy.text": quotedUnless(codeIn(FIXED_NEEDED_WHY)),
  "signoffs[].name": "person",
  ...under("approvers[]", APPROVER),
  ...under("barred[]", BARRED),
  "terms.domains[].domain": "run-file",
  // domainText names the domain the file gives and the one on file.
  "terms.domains[].text": "quoted",
  ...under("terms.arrivals[].advice", ARRIVAL),
} as const satisfies Fields<RunRequestView>;

const RUN_OPTION = {
  title: "plain",
  "consequence[]": "quoted",
  ...under("can", CAN),
  ...under("approvers[]", APPROVER),
  rail: RAIL,
  "enders[]": "person",
} as const satisfies Fields<RunDecisionOption>;

const RUN_ROW = {
  supplier: "run-file",
  payee: "airwallex",
  ...under("account", ACCOUNT),
  ...under("arrival", ARRIVAL),
  // Built only for a currency in its own form and an estimate vouchedArrival accepts.
  feeSeen: "plain",
  label: "plain",
  // The fixed words runs.ts writes, with cells the file gave inside them.
  "skipReasons[].text": "run-file",
  "payment.situation.label": "plain",
} as const satisfies Fields<RunRowView>;

export const RUN_FIELDS = {
  "run.fileName": "person",
  "run.uploadedBy": "person",
  "run.cancelledBy": "person",
  "run.cancelNote": "person",
  ...under("situation", RUN_SITUATION),
  ...under("decision.request", RUN_REQUEST),
  "decision.cautions[].text": "plain",
  ...under("decision.options[]", RUN_OPTION),
  ...under("rows[]", RUN_ROW),
  "skippedSummary[].label": "plain",
  ...under("timeline", TIMELINE),
  ...under("audit", AUDIT_LINE),
} as const satisfies Fields<RunView>;

// ---------- suppliers ----------

export const SUPPLIERS_FIELDS = { "rows[].name": "supplier", "rows[].hint": "plain", "rows[].cautions[].text": "plain" } as const satisfies Fields<SuppliersView>;

export const SUPPLIER_FIELDS = {
  name: "supplier",
  "otherNames[]": "supplier",
  hint: "plain",
  "cautions[].text": "plain",
  "contact.emailDomains[].domain": "supplier",
  "contact.changedBy": "person",
  "contact.pending[].proposedBy": "person",
  ...under("contact.phone", PHONE_ON_FILE),
  "contact.proposal.proposedBy": "person",
  "contact.proposal.source": "plain",
  "contact.proposal.note": "person",
  "contact.history[].proposedBy": "person",
  "contact.history[].confirmedBy": "person",
  "contact.history[].closedBy": "person",
  "contact.callbackBarred[]": "person",
  "contact.notice": "plain",
  ...under("contact.actions.propose", CONTACT_CAN),
  ...under("contact.actions.confirm", CONTACT_CAN),
  ...under("contact.actions.withdraw", CONTACT_CAN),
  "accounts[].label": "airwallex",
  "accounts[].verifiedBy.calledBy": "person",
  "accounts[].barred[]": "person",
  ...under("payments.open[]", INCIDENT_ROW),
  ...under("payments.closed.listed[]", INCIDENT_ROW),
  "callbacks[].calledBy": "person",
  ...under("secondBills[].invoices[]", DUPLICATE),
  "runRows[].label": "plain",
  "drafts[].label": "plain",
  "drafts[].stateLabel": "plain",
  ...under("outages.active[]", OUTAGE_STRIP),
  ...under("outages.failures[].failure", FAILURE),
  "related[].name": "supplier",
  ...under("can.newPayment", CAN),
} as const satisfies Fields<SupplierView>;

// ---------- treasury ----------

export const CASH_FIELDS = {
  "balances.problem.text": "plain",
  // This process's own RESERVE_FLOORS problem quotes the setting it could not read.
  floorsProblem: quotedUnless((text: string): boolean => text === SERVER_FLOORS_UNREADABLE),
  "wallets[].floor.text": "plain",
  "wallets[].invoiceFloors[].text": "plain",
  "wallets[].worksheet[].label": "plain",
} as const satisfies Fields<CashView>;

const OUTAGE_CARD = {
  rail: RAIL,
  // "Outage 1 on USD LOCAL was ended by Yash".
  text: "quoted",
  "codes[].label": "plain",
  ...under("counted[].failure", FAILURE),
  "pausing[].label": "plain",
  sendsText: "plain",
  endedBy: "person",
  endNote: "person",
  "end.why.text": WHY_TEXT,
  "end.enders[]": "person",
} as const satisfies Fields<OutageCardView>;

export const OUTAGES_FIELDS = {
  "rule.text": "plain",
  "rule.problem": "plain",
  ...under("active[]", OUTAGE_CARD),
  ...under("ended[]", OUTAGE_CARD),
} as const satisfies Fields<OutagesView>;

// ---------- reports and audit ----------

export const REPORTS_FIELDS = {
  "tiles[].label": "plain",
  "tiles[].value": "plain",
  "tiles[].sub": "plain",
  "metrics.failures.rows[].label": "plain",
  "metrics.outages.rows[].codes[].label": "plain",
  "metrics.incidents.reasons[].label": "plain",
  "metrics.recon.rows[].label": "plain",
} as const satisfies Fields<ReportsView>;

export const AUDIT_FIELDS = {
  "problems[]": "plain",
  "recon.problem": "plain",
  exportPath: LEDGER_EXPORT_LINK,
} as const satisfies Fields<AuditCheckView>;

const CHAIN_EXPORT = {
  "method.hash": "plain",
  "method.ledgerHead": "plain",
  "method.genesis": "plain",
  "lines[].message": "quoted",
  "breaks[].problem": "plain",
} as const;

export const INVOICE_EXPORT_FIELDS = { "invoice.supplier": "supplier", ...CHAIN_EXPORT } as const satisfies Fields<AuditExport>;

export const RUN_EXPORT_FIELDS = { "run.fileName": "person", "run.uploadedBy": "person", ...CHAIN_EXPORT } as const satisfies Fields<RunAuditExport>;

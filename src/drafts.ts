import { createHash } from "node:crypto";
import type { ApprovalTerms } from "./approval.js";
import { today, type ArrivalTerms } from "./arrival.js";
import { deadlineMinutes } from "./deadlines.js";
import {
  CHANGED_BANK_DETAILS_REASON,
  NEW_BANK_DETAILS_REASON,
  ORIGINAL_DEADLINE_REASON,
} from "./decide.js";
import type { EmailFindings } from "./emails.js";
import { REPLACEMENT_DEADLINE_REASON } from "./engine.js";
import {
  crossCurrency,
  type Approval,
  type Attempt,
  type Draft,
  type DraftMove,
  type DraftState,
  type Ledger,
  type Obligation,
} from "./ledger.js";
import { formatMoney } from "./money.js";

// Messages for a person to send to the supplier or the bank. PayOnce never sends
// them. Each is rendered once, from facts PayOnce formats itself: amounts, bank
// references, dates, statuses and the last four digits of the phone number on
// file. No supplier name, email text, model output, reason or account detail
// goes into one.

export type DraftTemplate =
  | "payment-sent"
  | "replacement-sent"
  | "checking"
  | "callback-notice"
  | "bank-trace";

export type DraftAudience = "supplier" | "bank";

// Every value is a string PayOnce wrote, or null when it is not known.
type Facts = Record<string, string | null>;

interface Text {
  subject: string;
  body: string;
}

interface Context {
  ledger: Ledger;
  obligation: Obligation;
  attempts: Attempt[];
  findings: EmailFindings | null;
  emails: number;
  now: number;
}

interface Template {
  label: string;
  audience: DraftAudience;
  // The facts in a fixed key order, or why the template does not fit now.
  facts(context: Context): Facts | string;
  // Why it is suggested, or null when it is only offered.
  suggest(context: Context, facts: Facts): string | null;
  render(facts: Facts): Text;
}

const REFERENCE: RegExp = /^[A-Z0-9-]{1,30}$/;
const BANK_STATUS: RegExp = /^[A-Z_]{1,30}$/;
const DAY: RegExp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function referenceOf(attempt: Attempt | undefined): string | null {
  return attempt?.reference !== null && attempt?.reference !== undefined && REFERENCE.test(attempt.reference)
    ? attempt.reference
    : null;
}

// "28 October 2026"
function dayText(day: string): string | null {
  if (!DAY.test(day)) {
    return null;
  }
  const at: Date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(at.getTime())
    ? null
    : at.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

// "28 October 2026, 14:05 UTC"
function timeText(iso: string | null): string | null {
  const at: number = iso === null ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(at)) {
    return null;
  }
  const date: Date = new Date(at);
  const day: string = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const time: string = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `${day}, ${time} UTC`;
}

// The day the payment was sent, on this machine's calendar, as the route
// advisory counted it.
function sentOn(attempt: Attempt): string | null {
  if (attempt.arrival !== null) {
    return dayText(attempt.arrival.from);
  }
  const created: number = attempt.bankCreatedAt === null ? Number.NaN : Date.parse(attempt.bankCreatedAt);
  return Number.isNaN(created) ? null : dayText(today(new Date(created)));
}

// The route advisory's latest usual day for a payment still with the bank, or
// null. PayOnce's own bank deadline is never shown to a supplier.
function expectedBy(attempt: Attempt): string | null {
  const arrival: ArrivalTerms | null = attempt.arrival;
  return attempt.state !== "in_flight" || arrival === null || arrival.latest === null ? null : dayText(arrival.latest);
}

function statusOf(attempt: Attempt): string {
  return attempt.state === "paid" ? "paid" : "in flight";
}

function sentWithTheBank(attempt: Attempt): boolean {
  return attempt.transferId !== null && (attempt.state === "in_flight" || attempt.state === "paid");
}

function amountOf(obligation: Obligation): string {
  return formatMoney(obligation.amountMinor, obligation.currency);
}

function stillOpen(obligation: Obligation): boolean {
  return obligation.state === "open" || obligation.state === "escalated";
}

function aboutBankDetails(context: Context): boolean {
  const reason: string = context.obligation.escalationReason;
  return (
    context.findings?.asksForNewBankDetails === true ||
    reason.startsWith(NEW_BANK_DETAILS_REASON) ||
    reason.startsWith(CHANGED_BANK_DETAILS_REASON)
  );
}

function phoneEnding(obligation: Obligation): string | null {
  const digits: string = (obligation.supplierPhone ?? "").replace(/[^0-9]/g, "");
  return digits.length < 4 ? null : digits.slice(-4);
}

// The latest payment with the bank past the time PayOnce gives it, or undefined.
// One with no creation time on file counts when the invoice went to a person for
// a deadline.
function overdue(context: Context): Attempt | undefined {
  const reason: string = context.obligation.escalationReason;
  const deadlineReason: boolean =
    reason.startsWith(ORIGINAL_DEADLINE_REASON) || reason.startsWith(REPLACEMENT_DEADLINE_REASON);
  return [...context.attempts].reverse().find((attempt: Attempt): boolean => {
    if (attempt.state !== "in_flight" || attempt.transferId === null) {
      return false;
    }
    const created: number = attempt.bankCreatedAt === null ? Number.NaN : Date.parse(attempt.bankCreatedAt);
    return Number.isNaN(created)
      ? deadlineReason
      : context.now >= created + deadlineMinutes(context.obligation.transferMethod) * 60_000;
  });
}

function lines(...parts: (string | null | false)[]): string {
  return parts.filter((part: string | null | false): part is string => typeof part === "string").join("\n");
}

function arrivalParagraph(facts: Facts, newPayment: boolean): string {
  const which: string = newPayment ? "the new payment reference" : "the payment reference";
  if (facts["status"] === "paid") {
    return newPayment
      ? "Our bank shows the new payment as paid. If you cannot see it, please ask your bank to look for the new payment reference, and let us know what they find."
      : "Our bank shows this payment as paid. If you cannot see it, please ask your bank to look for the payment reference above, and let us know what they find.";
  }
  return facts["expectedBy"] === null
    ? `We expect it to reach your account within the usual time for this route. If it does not arrive, please let us know and quote ${which}.`
    : `We expect it to reach your account by ${facts["expectedBy"] ?? ""}, or a little later if there is a public holiday before then. If it has not arrived by then, please let us know and quote ${which}.`;
}

const TEMPLATES: Record<DraftTemplate, Template> = {
  "payment-sent": {
    label: "Payment sent",
    audience: "supplier",
    facts(context: Context): Facts | string {
      const original: Attempt | undefined = context.attempts.find(
        (attempt: Attempt): boolean => attempt.kind === "original" && sentWithTheBank(attempt),
      );
      if (original === undefined || referenceOf(original) === null) {
        return "the original payment is not with the bank or paid";
      }
      return {
        invoice: context.obligation.invoiceId,
        amount: amountOf(context.obligation),
        reference: referenceOf(original),
        sentOn: sentOn(original),
        status: statusOf(original),
        expectedBy: expectedBy(original),
      };
    },
    suggest(context: Context): string | null {
      return context.findings?.claimsNonReceipt === true ? "The supplier says the payment has not arrived" : null;
    },
    render(facts: Facts): Text {
      return {
        subject: `Payment for invoice ${facts["invoice"] ?? ""}`,
        body: lines(
          "Hello,",
          "",
          `We have sent the payment for invoice ${facts["invoice"] ?? ""}.`,
          "",
          `Amount: ${facts["amount"] ?? ""}`,
          `Payment reference: ${facts["reference"] ?? ""}`,
          facts["sentOn"] !== null && `Sent on: ${facts["sentOn"] ?? ""}`,
          "",
          arrivalParagraph(facts, false),
          "",
          "Regards,",
        ),
      };
    },
  },
  "replacement-sent": {
    label: "Payment sent again",
    audience: "supplier",
    facts(context: Context): Facts | string {
      const replacement: Attempt | undefined = [...context.attempts]
        .reverse()
        .find((attempt: Attempt): boolean => attempt.kind === "replacement" && sentWithTheBank(attempt));
      const failed: Attempt | undefined = context.attempts.find(
        (attempt: Attempt): boolean => attempt.kind === "original" && attempt.state === "failed",
      );
      if (replacement === undefined || failed === undefined || referenceOf(replacement) === null) {
        return "no payment sent again after a failed original is with the bank or paid";
      }
      // The callback behind the approval this replacement was sent on, if any.
      const approval: Approval | undefined =
        replacement.approvalId === null ? undefined : context.ledger.approval(replacement.approvalId);
      const terms: ApprovalTerms | undefined =
        approval === undefined ? undefined : (JSON.parse(approval.terms) as ApprovalTerms);
      const calledAt: string | null =
        terms?.action === "replace" && terms.evidence.bankChange !== null ? terms.evidence.bankChange.calledAt : null;
      const called: number = calledAt === null ? Number.NaN : Date.parse(calledAt);
      return {
        invoice: context.obligation.invoiceId,
        amount: amountOf(context.obligation),
        failedReference: referenceOf(failed),
        failedOn: sentOn(failed),
        reference: referenceOf(replacement),
        sentOn: sentOn(replacement),
        status: statusOf(replacement),
        expectedBy: expectedBy(replacement),
        confirmedByPhoneOn: Number.isNaN(called) ? null : dayText(today(new Date(called))),
      };
    },
    suggest(): string | null {
      return "The first payment failed and PayOnce sent it again";
    },
    render(facts: Facts): Text {
      const failed: string =
        facts["failedReference"] === null
          ? ""
          : ` That payment had the reference ${facts["failedReference"] ?? ""}${facts["failedOn"] === null ? "" : ` and was sent on ${facts["failedOn"] ?? ""}`}.`;
      return {
        subject: `Invoice ${facts["invoice"] ?? ""}: payment sent again`,
        body: lines(
          "Hello,",
          "",
          `Our first payment for invoice ${facts["invoice"] ?? ""} failed at the bank, so it will not reach you.${failed}`,
          "",
          "We have sent the payment again:",
          "",
          `Amount: ${facts["amount"] ?? ""}`,
          `Payment reference: ${facts["reference"] ?? ""}`,
          facts["sentOn"] !== null && `Sent on: ${facts["sentOn"] ?? ""}`,
          "",
          facts["confirmedByPhoneOn"] !== null &&
            `It goes to the bank account you confirmed with us by phone on ${facts["confirmedByPhoneOn"] ?? ""}.`,
          facts["confirmedByPhoneOn"] !== null && "",
          arrivalParagraph(facts, true),
          "",
          "Regards,",
        ),
      };
    },
  },
  checking: {
    label: "We are looking into it",
    audience: "supplier",
    facts(context: Context): Facts | string {
      if (!stillOpen(context.obligation)) {
        return "the invoice is closed";
      }
      if (context.emails === 0) {
        return "no supplier emails are on file";
      }
      const latest: Attempt | undefined = [...context.attempts]
        .reverse()
        .find((attempt: Attempt): boolean => referenceOf(attempt) !== null);
      return {
        invoice: context.obligation.invoiceId,
        amount: amountOf(context.obligation),
        reference: referenceOf(latest),
      };
    },
    suggest(context: Context): string | null {
      return context.obligation.state === "escalated" ? "The supplier wrote, and the invoice is waiting on a person" : null;
    },
    render(facts: Facts): Text {
      return {
        subject: `Invoice ${facts["invoice"] ?? ""}: we are looking into it`,
        body: lines(
          "Hello,",
          "",
          `Thank you for your message about invoice ${facts["invoice"] ?? ""} for ${facts["amount"] ?? ""}.`,
          "",
          `We are looking into the payment for this invoice${facts["reference"] === null ? "" : `, reference ${facts["reference"] ?? ""}`}, and we will write again when we know more.`,
          "",
          "Regards,",
        ),
      };
    },
  },
  "callback-notice": {
    label: "We will call to confirm bank details",
    audience: "supplier",
    facts(context: Context): Facts | string {
      if (!stillOpen(context.obligation)) {
        return "the invoice is closed";
      }
      if (!aboutBankDetails(context)) {
        return "nothing on file says the supplier's bank details changed";
      }
      const ending: string | null = phoneEnding(context.obligation);
      if (ending === null) {
        return "no phone number for the supplier is on file";
      }
      return { invoice: context.obligation.invoiceId, phoneEnding: ending };
    },
    suggest(): string | null {
      return "The supplier's bank details may have changed";
    },
    render(facts: Facts): Text {
      return {
        subject: `Invoice ${facts["invoice"] ?? ""}: we will call you about your bank details`,
        body: lines(
          "Hello,",
          "",
          `Before we pay invoice ${facts["invoice"] ?? ""} to any bank account other than the one we paid before, we will call you to confirm it. We will use the phone number we already have for you, ending ${facts["phoneEnding"] ?? ""}.`,
          "",
          "Please do not send bank details by email or in a reply to this message. We only change bank details after that call.",
          "",
          "If you have not asked to change your bank details, please call us.",
          "",
          "Regards,",
        ),
      };
    },
  },
  "bank-trace": {
    label: "Trace request to Airwallex",
    audience: "bank",
    facts(context: Context): Facts | string {
      const late: Attempt | undefined = overdue(context);
      if (late === undefined || referenceOf(late) === null) {
        return "no payment is with the bank past its deadline";
      }
      const status: string =
        late.bankStatus !== null && BANK_STATUS.test(late.bankStatus) ? late.bankStatus : "in flight";
      return {
        reference: referenceOf(late),
        invoice: context.obligation.invoiceId,
        amount: amountOf(context.obligation),
        debited:
          crossCurrency(context.obligation) && late.amountMinor !== null && late.currency !== null
            ? formatMoney(late.amountMinor, late.currency)
            : null,
        method: context.obligation.transferMethod,
        createdAt: timeText(late.bankCreatedAt),
        status,
      };
    },
    suggest(_context: Context, facts: Facts): string | null {
      return `The bank has not paid or failed ${facts["reference"] ?? "the payment"} by its deadline`;
    },
    render(facts: Facts): Text {
      return {
        subject: `Trace request for transfer ${facts["reference"] ?? ""}`,
        body: lines(
          "Hello,",
          "",
          "Please trace this transfer. The bank has neither paid nor failed it, and it has been with the bank longer than we expect.",
          "",
          `Transfer reference: ${facts["reference"] ?? ""}`,
          `Invoice: ${facts["invoice"] ?? ""}`,
          `Amount: ${facts["amount"] ?? ""}`,
          facts["debited"] !== null && `Debited: ${facts["debited"] ?? ""}`,
          `Method: ${facts["method"] ?? ""}`,
          facts["createdAt"] !== null && `Created: ${facts["createdAt"] ?? ""}`,
          `Status when we last checked: ${facts["status"] ?? ""}`,
          "",
          "Please tell us where the transfer is and when it will be paid. If it cannot be paid, please tell us whether the money will come back to our account, and when.",
          "",
          "Thank you,",
        ),
      };
    },
  },
};

export const DRAFT_TEMPLATES: DraftTemplate[] = Object.keys(TEMPLATES) as DraftTemplate[];

const FACT_LABELS: Record<string, string> = {
  invoice: "invoice",
  amount: "amount",
  reference: "payment reference",
  sentOn: "day sent",
  status: "payment status",
  expectedBy: "expected arrival",
  failedReference: "failed payment's reference",
  failedOn: "failed payment's day",
  confirmedByPhoneOn: "phone confirmation",
  phoneEnding: "phone number on file",
  debited: "amount debited",
  method: "method",
  createdAt: "time created",
};

export function isTemplate(value: unknown): value is DraftTemplate {
  return typeof value === "string" && Object.hasOwn(TEMPLATES, value);
}

function contextOf(ledger: Ledger, obligation: Obligation, now: number): Context {
  const findings: string | undefined = ledger.findings(obligation.invoiceId);
  return {
    ledger,
    obligation,
    attempts: ledger.attempts(obligation.invoiceId),
    findings: findings === undefined ? null : (JSON.parse(findings) as EmailFindings),
    emails: ledger.emails(obligation.invoiceId).length,
    now,
  };
}

// The hash recorded on the timeline when a draft is made.
export function textHash(template: string, subject: string, body: string): string {
  return createHash("sha256").update(JSON.stringify({ template, subject, body })).digest("hex");
}

export interface DraftOffer {
  template: DraftTemplate;
  label: string;
  audience: DraftAudience;
  suggested: boolean;
  why: string | null;
}

export interface NotOffered {
  label: string;
  why: string;
}

// withheld holds the messages to the supplier that fit but are not offered,
// because the supplier asked to hold, cancel or not pay the invoice. A person can
// still draft one on purpose. Empty otherwise.
export interface Outbox {
  drafts: DraftView[];
  offers: DraftOffer[];
  notOffered: NotOffered[];
  withheld: DraftOffer[];
}

// What a draft says now: whether its text still matches its hash, and what has
// changed since it was made, or why it no longer fits.
export interface DraftView {
  id: number;
  template: string;
  label: string;
  audience: string;
  subject: string;
  body: string;
  state: DraftState;
  createdBy: string;
  createdAt: string;
  copiedBy: string | null;
  copiedAt: string | null;
  sentBy: string | null;
  sentAt: string | null;
  dismissedBy: string | null;
  dismissedAt: string | null;
  dismissNote: string | null;
  textHash: string;
  intact: boolean;
  changed: string[] | null;
  noLongerFits: string | null;
}

function viewOf(context: Context, draft: Draft): DraftView {
  const template: Template | undefined = isTemplate(draft.template) ? TEMPLATES[draft.template] : undefined;
  const now: Facts | string = template === undefined ? "PayOnce no longer has this template" : template.facts(context);
  const then: Facts = JSON.parse(draft.facts) as Facts;
  const changed: string[] | null =
    typeof now === "string"
      ? null
      : Object.keys(now)
          .filter((key: string): boolean => now[key] !== (then[key] ?? null))
          .map(
            (key: string): string =>
              `the ${FACT_LABELS[key] ?? key} changed from ${then[key] ?? "none"} to ${now[key] ?? "none"}`,
          );
  return {
    id: draft.id,
    template: draft.template,
    label: template?.label ?? draft.template,
    audience: draft.audience,
    subject: draft.subject,
    body: draft.body,
    state: draft.state,
    createdBy: draft.createdBy,
    createdAt: draft.createdAt,
    copiedBy: draft.copiedBy,
    copiedAt: draft.copiedAt,
    sentBy: draft.sentBy,
    sentAt: draft.sentAt,
    dismissedBy: draft.dismissedBy,
    dismissedAt: draft.dismissedAt,
    dismissNote: draft.dismissNote,
    textHash: draft.textHash,
    intact: textHash(draft.template, draft.subject, draft.body) === draft.textHash,
    changed,
    noLongerFits: typeof now === "string" ? now : null,
  };
}

// True when the last draft of this template marked sent was made from these very
// facts, so offering it again would only repeat it.
function sentAlready(drafts: Draft[], name: DraftTemplate, facts: Facts): boolean {
  const sent: Draft | undefined = [...drafts]
    .reverse()
    .find((draft: Draft): boolean => draft.template === name && draft.state === "sent");
  return sent !== undefined && sent.facts === JSON.stringify(facts);
}

// The drafts on file and the templates that fit the invoice now, suggested ones
// first. A pure read: nothing is drafted until a person asks. A template with an
// open draft, or whose last sent draft had the same facts, is not offered. While
// the supplier's ask to hold, cancel or not pay is on file, no message to the
// supplier is offered: each one that fits is withheld, and the trace request to
// the bank is still offered.
export function outboxOf(ledger: Ledger, obligation: Obligation, now: number = Date.now()): Outbox {
  const context: Context = contextOf(ledger, obligation, now);
  const drafts: Draft[] = ledger.drafts(obligation.invoiceId);
  const open: Set<string> = new Set(
    drafts
      .filter((draft: Draft): boolean => draft.state === "draft" || draft.state === "copied")
      .map((draft: Draft): string => draft.template),
  );
  const offers: DraftOffer[] = [];
  for (const name of DRAFT_TEMPLATES) {
    const template: Template = TEMPLATES[name];
    const facts: Facts | string = template.facts(context);
    if (typeof facts === "string" || open.has(name) || sentAlready(drafts, name, facts)) {
      continue;
    }
    const why: string | null = template.suggest(context, facts);
    offers.push({ template: name, label: template.label, audience: template.audience, suggested: why !== null, why });
  }
  if (context.findings?.asksNotToPay === true) {
    const withheld: DraftOffer[] = offers
      .filter((offer: DraftOffer): boolean => offer.audience === "supplier")
      .map((offer: DraftOffer): DraftOffer => ({ ...offer, suggested: false, why: null }));
    return {
      drafts: drafts.map((draft: Draft): DraftView => viewOf(context, draft)),
      offers: offers.filter((offer: DraftOffer): boolean => offer.audience !== "supplier"),
      notOffered: notOfferedIn(context, obligation),
      withheld,
    };
  }
  // A note to the supplier while it waits on a person only when nothing more
  // specific is suggested.
  const checking: DraftOffer | undefined = offers.find((offer: DraftOffer): boolean => offer.template === "checking");
  if (
    checking !== undefined &&
    offers.some(
      (offer: DraftOffer): boolean =>
        offer.suggested && (offer.template === "payment-sent" || offer.template === "callback-notice"),
    )
  ) {
    checking.suggested = false;
    checking.why = null;
  }
  offers.sort((a: DraftOffer, b: DraftOffer): number => Number(b.suggested) - Number(a.suggested));
  return {
    drafts: drafts.map((draft: Draft): DraftView => viewOf(context, draft)),
    offers,
    notOffered: notOfferedIn(context, obligation),
    withheld: [],
  };
}

function notOfferedIn(context: Context, obligation: Obligation): NotOffered[] {
  return stillOpen(obligation) && aboutBankDetails(context) && phoneEnding(obligation) === null
    ? [
        {
          label: TEMPLATES["callback-notice"].label,
          why: "No phone number for this supplier is on file, so PayOnce has no number to call back on. Do not ask the supplier to send bank details by email.",
        },
      ]
    : [];
}

export class DraftNotFitError extends Error {
  constructor(why: string) {
    super(`This message does not fit the invoice now: ${why}`);
    this.name = "DraftNotFitError";
  }
}

// Renders the template once and stores it with its facts and hash, and the
// chained timeline line that records the hash, in one transaction.
export function createDraft(
  ledger: Ledger,
  obligation: Obligation,
  name: DraftTemplate,
  createdBy: string,
  now: number = Date.now(),
): DraftView {
  const template: Template = TEMPLATES[name];
  const context: Context = contextOf(ledger, obligation, now);
  const facts: Facts | string = template.facts(context);
  if (typeof facts === "string") {
    throw new DraftNotFitError(facts);
  }
  const text: Text = template.render(facts);
  const hash: string = textHash(name, text.subject, text.body);
  const id: number = ledger.createDraft(
    {
      invoiceId: obligation.invoiceId,
      template: name,
      audience: template.audience,
      facts: JSON.stringify(facts),
      subject: text.subject,
      body: text.body,
      textHash: hash,
      createdBy,
    },
    (draftId: number): string =>
      `Draft ${draftId} for the ${template.audience} created by ${createdBy}: "${template.label}". Text SHA-256 ${hash}. PayOnce does not send it`,
  );
  console.log(`  outbox   Draft ${id} created by ${createdBy}: ${template.label}`);
  const draft: Draft | undefined = ledger.draft(id);
  if (draft === undefined) {
    throw new Error(`Draft ${id} could not be read back`);
  }
  return viewOf(context, draft);
}

export class DraftMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftMoveError";
  }
}

const MOVES_FROM: Record<DraftMove, DraftState[]> = {
  copied: ["draft"],
  sent: ["draft", "copied"],
  dismissed: ["draft", "copied"],
};

// Records a person copying, sending or dismissing a draft. Marking it sent
// changes nothing else: no invoice state, no approval, no money. Copying a
// copied draft again records nothing new.
export function markDraft(
  ledger: Ledger,
  obligation: Obligation,
  draftId: number,
  move: DraftMove,
  by: string | null,
  note: string | null = null,
  now: number = Date.now(),
): void {
  const draft: Draft | undefined = ledger.draft(draftId);
  if (draft === undefined || draft.invoiceId !== obligation.invoiceId) {
    throw new DraftMoveError(`Draft ${draftId} is not a draft for ${obligation.invoiceId}`);
  }
  if (move === "copied" && draft.state === "copied") {
    return;
  }
  const view: DraftView = viewOf(contextOf(ledger, obligation, now), draft);
  const since: string =
    view.noLongerFits !== null
      ? `. Since it was drafted, it no longer fits: ${view.noLongerFits}`
      : view.changed !== null && view.changed.length > 0
        ? `. Since it was drafted, ${view.changed.join(", ")}`
        : "";
  const line: string =
    move === "copied"
      ? `Draft ${draftId} copied${by === null ? "" : ` by ${by}`}`
      : move === "sent"
        ? `Draft ${draftId} marked sent by ${by ?? ""}. PayOnce did not send it${since}`
        : `Draft ${draftId} dismissed by ${by ?? ""}${note === null ? "" : `: ${note}`}`;
  if (!ledger.markDraft(obligation.invoiceId, draftId, move, MOVES_FROM[move], by, note, line)) {
    throw new DraftMoveError(`Draft ${draftId} is already ${ledger.draft(draftId)?.state ?? draft.state}, so it cannot be marked ${move}`);
  }
  console.log(`  outbox   ${line}`);
}

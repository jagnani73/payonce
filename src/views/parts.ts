import { describeRate, markupOf, type FxTerms } from "../domain/approval.js";
import { arrivalAdvice, HOLIDAYS_NOTE, ROUTES, today, type ArrivalAdvice, type ArrivalTerms } from "../domain/arrival.js";
import { FAILURE_CODES, type FailureCode } from "../domain/failure-codes.js";
import { formatMoney } from "../domain/money.js";
import { FAILURE_CODE_PATTERN, TRANSFER_METHODS } from "../domain/patterns.js";
import type { Can, Why } from "../domain/situation.js";
import {
  chainReport,
  describeBreaks,
  describeLedger,
  describeRunLedger,
  runChainReport,
  runLedgerReport,
  type ChainReport,
  type LedgerReport,
  type RunAuditSnapshot,
  type RunChainReport,
  type RunLedgerReport,
} from "../store/audit-trail.js";
import type { EventKind, Ledger, LedgerEvent } from "../store/ledger.js";
import { capitalise } from "../domain/sentences.js";
import type {
  AccountView,
  Activity,
  ArrivalView,
  AuditLineView,
  FailureView,
  FxView,
  Money,
  TimelineLine,
  TimelineView,
} from "./contract.js";

// The small pieces every view is built from: money, failures, accounts, rates,
// arrival estimates, timelines and the audit line. Pure, apart from the audit
// line, which reads the chain.

// formatMoney with a real minus sign, as a person reads it: "−7.05 EUR".
// Stored lines and terms keep formatMoney's hyphen.
export function moneyText(minor: number, currency: string): string {
  return formatMoney(minor, currency).replace(/^-/, "−");
}

export function money(minor: number, currency: string, estimated: boolean = false): Money {
  return estimated
    ? { minor, currency, text: moneyText(minor, currency), estimated: true }
    : { minor, currency, text: moneyText(minor, currency) };
}

export function iso(at: number | null): string | null {
  return at === null || !Number.isFinite(at) ? null : new Date(at).toISOString();
}

export function allowed(): Can {
  return { allowed: true, why: null };
}

export function refused(code: string, text: string): Can {
  return { allowed: false, why: { code, text } };
}

export function why(code: string, text: string): Why {
  return { code, text };
}

export function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

const COUNT_WORDS: readonly string[] = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

// When a request's last signoff comes in, whoever reads it.
export function onceSignedOff(signed: number, needed: number): string {
  const left: number = Math.max(1, needed - signed);
  const words = (n: number): string => COUNT_WORDS[n] ?? String(n);
  if (signed === 0) {
    return needed === 1 ? "Once an approver signs off" : `Once ${words(needed)} approvers sign off`;
  }
  return left === 1 ? "Once one more approver signs off" : `Once ${words(left)} more approvers sign off`;
}

// The last four digits of a phone number or an account, never more.
export function lastFour(value: string | null | undefined): string | null {
  const digits: string = (value ?? "").replace(/[^0-9]/g, "");
  return digits.length < 4 ? null : digits.slice(-4);
}

// A bank failure code, shown only in its own pattern, with the one table's words.
export function failureView(code: string | null): FailureView | null {
  if (code === null) {
    return null;
  }
  const known: FailureCode | undefined = Object.hasOwn(FAILURE_CODES, code) ? FAILURE_CODES[code] : undefined;
  return {
    code: FAILURE_CODE_PATTERN.test(code) ? code : "a code PayOnce cannot show",
    words: known?.words ?? "a code PayOnce has no words for",
    resendable: known?.resendable ?? false,
    railLevel: known?.rail ?? false,
    accountLevel: known?.account ?? false,
  };
}

// The last four characters of an account, from the label PayOnce wrote for it.
function endingOfLabel(label: string): string | null {
  const found: RegExpExecArray | null = /([A-Za-z0-9]{4})(?:\s*\(the account on file\))?\s*$/.exec(label);
  return found?.[1] ?? null;
}

// An account as terms and run rows name it ("COMMERZBANK AG account ending 3000").
export function accountView(label: string | null, ending: string | null = null): AccountView | null {
  if (label === null || label === "") {
    return ending === null ? null : { label: `the account ending ${ending}`, ending };
  }
  return { label, ending: ending ?? endingOfLabel(label) };
}

export function fxView(fx: FxTerms): FxView {
  return {
    rate: describeRate(fx),
    markup: `${markupOf(fx)} from mid-market ${String(fx.midRate)}`,
    takes: money(fx.sellAmountMinor, fx.sellCurrency),
    delivers: money(fx.buyAmountMinor, fx.buyCurrency),
    quoteId: fx.quoteId,
    validTo: fx.validTo,
  };
}

// Airwallex's bank_country_code, as an estimate carries it.
const COUNTRY_CODE: RegExp = /^[A-Z]{2}$/;
const DAY: RegExp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function isDay(value: unknown): boolean {
  return typeof value === "string" && DAY.test(value);
}

function isDayCount(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

// A stored estimate in PayOnce's own forms: a method, a route PayOnce knows or
// none, and days and day counts as PayOnce writes them. Null for anything else,
// so the advice never repeats text PayOnce did not write there. The country
// comes from the beneficiary record in Airwallex, so one that is not two capital
// letters is left out instead.
export function vouchedArrival(arrival: ArrivalTerms): ArrivalTerms | null {
  const fits: boolean =
    TRANSFER_METHODS.includes(arrival.method) &&
    (arrival.route === null || ROUTES.includes(arrival.route)) &&
    isDay(arrival.from) &&
    [arrival.earliest, arrival.latest, arrival.dueDate].every((day: string | null): boolean => day === null || isDay(day)) &&
    isDayCount(arrival.minDays) &&
    isDayCount(arrival.maxDays);
  if (!fits) {
    return null;
  }
  return arrival.country === null || COUNTRY_CODE.test(arrival.country) ? arrival : { ...arrival, country: null };
}

// The route advisory's words for an estimate, or null for one vouchedArrival
// refuses. live: the payment can still be sent, so "if sent today" applies.
export function arrivalView(stored: ArrivalTerms, live: boolean, now: number): ArrivalView | null {
  const arrival: ArrivalTerms | null = vouchedArrival(stored);
  if (arrival === null) {
    return null;
  }
  const advice: ArrivalAdvice = arrivalAdvice(arrival, today(new Date(now)));
  return {
    text: advice.text,
    route: advice.route,
    due: advice.due,
    atRisk: advice.atRisk,
    sentToday: live ? advice.sentToday : null,
    note: advice.note,
    latestDay: arrival.latest,
  };
}

export function activityOf(busy: boolean, watching: boolean): Activity {
  return { busy, watching };
}

// ---------- timelines ----------

const KIND_LABELS: Record<EventKind, string> = {
  payment: "Payment",
  email: "Supplier email",
  bank: "Bank",
  decision: "Decision",
  approval: "Approval",
  warning: "Warning",
  lock: "Duplicate lock",
  closed: "Closed",
  callback: "Callback",
  error: "Error",
  outbox: "Message",
  outage: "Outage",
  contact: "Supplier phone",
  sandbox: "Sandbox",
};

// The fixed prefixes the engine writes on decision lines, and their chips.
const LEADS: readonly [string, NonNullable<TimelineLine["lead"]>][] = [
  ["Escalate: ", "Sent to a person"],
  ["Wait: ", "Waiting"],
  ["Replace: ", "Resending"],
  ["Close: ", "Closing"],
];

// An arrival estimate, written when a payment goes out.
function arrivalLine(message: string): boolean {
  return message.endsWith(HOLIDAYS_NOTE) || / has no arrival estimate, because /.test(message);
}

// Lines a person's act wrote, which never count as system lines, so a signoff
// the final approval came after stays in view.
const NEVER_SYSTEM: ReadonlySet<EventKind> = new Set<EventKind>(["approval"]);

// Newest first. Repeated identical error lines fold into the newest of them. The
// sandbox bank's lines are system lines, as errors are, because they say what
// the simulator did and not what the bank did. A cost line is a system line
// unless it is a warning, which gives the figures behind a floor decision.
export function timelineView(events: LedgerEvent[]): TimelineView {
  const latestOnTopic: Map<string, number> = new Map<string, number>();
  for (const event of events) {
    if (event.topic !== null) {
      latestOnTopic.set(event.topic, event.id);
    }
  }
  const lines: TimelineLine[] = [];
  for (const event of events) {
    const previous: TimelineLine | undefined = lines.at(-1);
    if (
      event.kind === "error" &&
      previous !== undefined &&
      previous.kind === "error" &&
      previous.text === event.message
    ) {
      previous.repeat = {
        count: (previous.repeat?.count ?? 1) + 1,
        firstAt: previous.repeat?.firstAt ?? previous.at,
        lastAt: event.at,
      };
      previous.id = event.id;
      previous.at = event.at;
      continue;
    }
    const lead: [string, NonNullable<TimelineLine["lead"]>] | undefined =
      event.kind === "decision" ? LEADS.find(([prefix]: [string, string]): boolean => event.message.startsWith(prefix)) : undefined;
    lines.push({
      id: event.id,
      at: event.at,
      kind: event.kind,
      kindLabel: KIND_LABELS[event.kind] ?? capitalise(event.kind),
      lead: lead?.[1] ?? null,
      text: lead === undefined ? event.message : event.message.slice(lead[0].length),
      topic: event.topic,
      system:
        !NEVER_SYSTEM.has(event.kind) &&
        (event.kind === "error" ||
        event.kind === "sandbox" ||
        (event.topic === "cost" && event.kind !== "warning") ||
        (event.topic !== null && latestOnTopic.get(event.topic) !== event.id) ||
        arrivalLine(event.message)),
      repeat: null,
    });
  }
  const newest: TimelineLine[] = lines.reverse();
  return {
    lines: newest,
    total: events.length,
    systemCount: newest.filter((line: TimelineLine): boolean => line.system).length,
  };
}

// ---------- the audit line ----------

function auditLineOf(lines: number, problem: string | null, exports: { json: string; csv: string }): AuditLineView {
  return { lines, intact: problem === null, problem: problem === null ? null : capitalise(problem), exports };
}

// Whether an invoice's timeline still chains, and the running hash over every
// line, as the page's line under it says (runningHashCheck hashes only what is new).
export function invoiceAuditLine(ledger: Ledger, invoiceId: string, now: number): AuditLineView {
  const report: ChainReport = chainReport(invoiceId, ledger.chainedEvents(invoiceId));
  const whole: LedgerReport = ledger.runningHashCheck(now);
  const path: string = `/api/incidents/${encodeURIComponent(invoiceId)}/audit`;
  return auditLineOf(report.lines, describeBreaks(report.breaks) ?? (whole.intact ? null : describeLedger(whole)), {
    json: `${path}?format=json`,
    csv: `${path}?format=csv`,
  });
}

export function runAuditLine(ledger: Ledger, runId: number): AuditLineView {
  const snapshot: RunAuditSnapshot = ledger.runAuditSnapshot(runId);
  const report: RunChainReport = runChainReport(runId, snapshot.events);
  const whole: RunLedgerReport = runLedgerReport(snapshot);
  return auditLineOf(report.lines, describeBreaks(report.breaks) ?? (whole.intact ? null : describeRunLedger(whole)), {
    json: `/api/runs/${runId}/audit?format=json`,
    csv: `/api/runs/${runId}/audit?format=csv`,
  });
}

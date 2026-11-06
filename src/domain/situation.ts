import { paymentAmount, runAmount, type ApprovalTerms, type PaymentAmount, type RunTerms } from "./approval.js";
import { checkSigner, eligibleApprovers, sameName, type ApprovalPolicy, type Approver, type Barred } from "./approvers.js";
import { barredInWords } from "./barred.js";
import { FAILURE_WORDS, RESENDABLE_FAILURE_CODES } from "./failure-codes.js";
import {
  approvedUnspent,
  awaitingSignoffs,
  closesItself,
  couldStillPay,
  deadlineAt,
  expiryOf,
  heldBeforePaying,
  inFlight,
  isExpired,
  lateBesideLive,
  liveAtBank,
  paidMismatched,
  paidOnce,
  paidOutside,
  pastDeadline,
  payoutLive,
  payoutNamesOnly,
  payoutNotFailed,
  payoutPays,
  requestExpired,
  requestOpen,
  sending,
  unrecognisedLive,
  unrecognisedPaid,
} from "./live.js";
import { formatAmount, formatMoney } from "./money.js";
import { RAIL_PATTERN, railWords } from "./patterns.js";
import {
  aboutBankDetailsReason,
  labelOf,
  reasonText,
  reasonView,
  type ReasonView,
  type StoredReason,
} from "./reasons.js";
import { timeAt, timed, type Timed, type TimePart } from "./timed.js";
import { capitalise } from "../text/printable.js";
import type {
  Approval,
  Attempt,
  Obligation,
  Outage,
  OutageHold,
  OutsidePayout,
  Run,
  RunApproval,
  RunRow,
} from "../store/ledger.js";

// What a person sees as the state of a payment and of a pay run, worked out once
// from a snapshot of the ledger. Pure: no ledger, no clock and no settings are
// read here, so the board, alerts, cautions, outbox, page and MCP answers that
// read it cannot disagree. Nothing here pays, holds, approves or closes: the
// engine decides with its own code, and where a predicate restates one of its
// guards, the guard inside its write transaction stays the authority.

export type Tone = "act" | "urgent" | "progress" | "blocked" | "done";

export interface Why {
  code: string;
  text: string;
}

export interface Can {
  allowed: boolean;
  why: Why | null;
}

export type PaymentState =
  | "paid"
  | "closed-unpaid"
  | "paid-twice"
  | "unrecognised-transfer"
  | "ready-to-close"
  | "paused-by-outage"
  | "needs-approval"
  | "approved"
  | "renewing-request"
  | "bank-late"
  | "with-bank"
  | "sending"
  | "queued-in-run"
  | "reading-emails"
  | "needs-callback"
  | "needs-phone"
  | "no-approvers"
  | "needs-decision"
  | "closing"
  | "deciding"
  | "starting"
  | "checking";

export type QueueGroup = "needs-you" | "bank-late" | "with-bank" | "payonce" | "closed";

export type WaitingOn =
  | { who: "approvers"; names: string[] }
  | { who: "person" }
  | { who: "outage-ender"; names: string[] | null }
  | { who: "admin" }
  | { who: "payonce" }
  | { who: "bank" }
  | { who: "bank-then-person" }
  | { who: "nobody" };

export type BlockerCode = "airwallex-unreachable" | "airwallex-error" | "outage" | "reader" | "overdue-check";

export interface Blocker {
  code: BlockerCode;
  text: Timed;
  since: string | null;
}

export type PersonAction =
  | "approve"
  | "recordCallback"
  | "closeAsPaid"
  | "closeUnpaid"
  | "endOutage"
  | "draftTrace"
  | "checkNow"
  | "askWhy";

export interface Situation {
  state: PaymentState;
  variant: string | null;
  label: string;
  detail: Timed | null;
  tone: Tone;
  group: QueueGroup;
  waitingOn: WaitingOn;
  next: Timed;
  why: ReasonView | null;
  blockers: Blocker[];
  also: string[];
  since: string | null;
  nextCheckAt: string | null;
  deadlineAt: string | null;
  urgent: boolean;
  can: Record<PersonAction, Can>;
}

export interface IncidentBrief {
  cause: string;
  openedAt: string | null;
  endedAt: string | null;
  neededPerson: boolean;
}

// What a person's close would record, as pendingClose names it.
export type CloseKind = "original" | "replacement" | "outside" | "mismatched" | "duplicate" | "unpaid";

export type RequestState = "waiting" | "approved" | "used" | "expired" | "replaced" | "withdrawn";

export interface RequestStateView {
  id: number;
  state: RequestState;
  label: string;
}

export interface ApproverChoice {
  name: string;
  limitMinor: number;
  canApprove: boolean;
  signed: boolean;
  why: Why | null;
}

export type OutageTouch = "original" | "replacement" | "approved" | "approval";

// ---------- the snapshot ----------

// A request, with its terms read soft: null when they do not parse.
export interface RequestSnapshot {
  approval: Approval;
  terms: ApprovalTerms | null;
}

export interface LastCheck {
  at: string;
  ok: boolean;
  error: "airwallex-unreachable" | "airwallex-error" | "other" | null;
}

export interface OutageSnapshot {
  outage: Outage;
  // Its hold rows on this invoice.
  holds: OutageHold[];
  // Who may end it: null for any named person, empty for nobody.
  enders: string[] | null;
  endRefusal: string | null;
}

export interface EmailsSnapshot {
  count: number;
  // An email on file the reader has not read: it failed on one, or one arrived
  // after the last read.
  unread: boolean;
  readerFailed: boolean;
  asksForNewBankDetails: boolean;
  asksNotToPay: boolean;
  claimsNonReceipt: boolean;
}

// The released pay run row whose turn it is to be sent, and the row sent before
// it in the run's order, if any.
export interface RunTurn {
  runId: number;
  line: number;
  after: number | null;
}

// When things happened, as the ledger's triggers and lines have them. failedAt
// and paidAt line up with attempts, foundAt with payouts.
export interface SnapshotTimes {
  firstEventAt: string | null;
  escalatedAt: string | null;
  closedAt: string | null;
  // The latest closed line, which names who closed it.
  closedLine: string | null;
  failedAt: (string | null)[];
  paidAt: (string | null)[];
  foundAt: (string | null)[];
  // Every outage hold on the invoice, active outage or not.
  holds: OutageHold[];
}

export interface Signing {
  policy: ApprovalPolicy;
  // Who may not approve the latest request: as the engine bars them while it
  // waits for signoffs, else whoever started the payment.
  barred: Barred[];
  startedKnown: boolean;
}

export interface InvoiceSnapshot {
  obligation: Obligation;
  attempts: Attempt[];
  payouts: OutsidePayout[];
  // Every request for the invoice, oldest first.
  requests: RequestSnapshot[];
  reason: StoredReason | null;
  emails: EmailsSnapshot;
  outage: OutageSnapshot | null;
  run: { run: Run; row: RunRow } | null;
  turn: RunTurn | null;
  inbox: { offered: number; named: number };
  // Why a callback cannot be recorded now, or null when it can.
  callbackBlocked: string | null;
  signing: Signing;
  deadlineMinutes: number;
  nextCheckAt: number | null;
  lastCheck: LastCheck | null;
  busy: boolean;
  times: SnapshotTimes;
  askWhy: boolean;
}

export interface RunSnapshot {
  run: Run;
  rows: RunRow[];
  // Every request for the run, oldest first.
  requests: RunApproval[];
  // The latest request, with its terms read soft and who may not approve it.
  request: { approval: RunApproval; terms: RunTerms | null; barred: Barred[] } | null;
  outage: { outage: Outage; enders: string[] | null } | null;
  policy: ApprovalPolicy;
  // The run's latest standing line, which says why it needs a check.
  standing: string | null;
  // The invoices its released rows became.
  released: InvoiceSnapshot[];
}

// ---------- small words ----------

const MS_PER_MINUTE: number = 60_000;
const OVERDUE_CHECK_MS: number = 2 * MS_PER_MINUTE;

function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function iso(at: number | null): string | null {
  return at === null || !Number.isFinite(at) ? null : new Date(at).toISOString();
}

function atNextCheck(nextCheckAt: number | null): Timed {
  const at: TimePart | null = timeAt(nextCheckAt);
  return at === null ? ["at its next check"] : timed("at its next check (", at, ")");
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : `${count} ${many}`;
}

function railName(outage: Outage): string {
  return RAIL_PATTERN.test(`${outage.currency} ${outage.method}`) ? railWords(outage.currency, outage.method) : "a rail PayOnce cannot name";
}

function refOf(reference: string | null | undefined, fallback: string): string {
  return reference === null || reference === undefined || reference === "" ? fallback : reference;
}

function phoneEnding(phone: string | null): string | null {
  const digits: string = (phone ?? "").replace(/[^0-9]/g, "");
  return digits.length < 4 ? null : digits.slice(-4);
}

function allowed(): Can {
  return { allowed: true, why: null };
}

function refused(code: string, text: string): Can {
  return { allowed: false, why: { code, text } };
}

// ---------- facts, each worked out once ----------

interface Facts {
  s: InvoiceSnapshot;
  now: number;
  o: Obligation;
  attempts: Attempt[];
  payouts: OutsidePayout[];
  latest: RequestSnapshot | undefined;
  closed: boolean;
  escalated: boolean;
  held: boolean;
  could: boolean;
  closeKind: CloseKind | undefined;
  awaiting: boolean;
  approved: boolean;
  open: boolean;
  expired: boolean;
  bankDetails: boolean;
  phone: boolean;
  touch: OutageTouch | null;
  late: Attempt | undefined;
  overdue: Attempt | undefined;
  live: Attempt | undefined;
  livePayout: OutsidePayout | undefined;
  pending: Attempt | undefined;
  choices: ApproverChoice[];
}

function latestRequest(snapshot: InvoiceSnapshot): RequestSnapshot | undefined {
  return snapshot.requests.at(-1);
}

// What the latest request asks: to replace a failed payment or to pay a held
// invoice. Terms that do not parse are told apart by the invoice.
function requestKind(snapshot: InvoiceSnapshot, request: RequestSnapshot): "replace" | "pay" {
  return request.terms?.action ?? (heldBeforePaying(snapshot.obligation, snapshot.attempts) ? "pay" : "replace");
}

export function closeKindOf(snapshot: InvoiceSnapshot): CloseKind | undefined {
  return closeKindFor(snapshot.obligation, snapshot.attempts, snapshot.payouts);
}

// What a person's close of the invoice would record, or undefined while it
// cannot close it: paid by its one paid payment, by a payout sent outside
// PayOnce, or by a mismatched transfer, else, once nothing for it that may pay it
// is live, a held second bill or an unpaid close. The engine's pendingClose and
// the views both read it.
export function closeKindFor(
  o: Pick<Obligation, "state" | "rejectedBy" | "duplicateOf">,
  attempts: Attempt[],
  payouts: OutsidePayout[],
): CloseKind | undefined {
  if (o.state !== "escalated") {
    return undefined;
  }
  if (paidOnce(attempts)) {
    return attempts.find((attempt: Attempt): boolean => attempt.state === "paid")?.kind;
  }
  if (paidOutside(attempts, payouts)) {
    return "outside";
  }
  if (paidMismatched(attempts, payouts)) {
    return "mismatched";
  }
  const others: OutsidePayout[] = payouts.filter((payout: OutsidePayout): boolean => !payoutNamesOnly(payout));
  if (others.some(payoutNotFailed) || attempts.some(liveAtBank)) {
    return undefined;
  }
  return o.rejectedBy === null && heldBeforePaying(o, attempts) && o.duplicateOf.length > 0 ? "duplicate" : "unpaid";
}

function paidKind(kind: CloseKind | undefined): boolean {
  return kind === "original" || kind === "replacement" || kind === "outside" || kind === "mismatched";
}

function unpaidKind(kind: CloseKind | undefined): boolean {
  return kind === "duplicate" || kind === "unpaid";
}

// The bank details a supplier email or the reason is about.
export function aboutBankDetails(snapshot: InvoiceSnapshot): boolean {
  return aboutBankDetailsReason(snapshot.reason) || snapshot.emails.asksForNewBankDetails;
}

export function phoneOnFile(obligation: Pick<Obligation, "supplierPhone">): boolean {
  return (obligation.supplierPhone ?? "").trim() !== "";
}

// How the active outage on the invoice's rail touches it: it holds the first
// payment, an approved payment, or the replacement PayOnce would have sent, or a
// payment approved now would wait for it.
function outageTouch(snapshot: InvoiceSnapshot, could: boolean, approved: boolean): OutageTouch | null {
  const o: Obligation = snapshot.obligation;
  if (snapshot.outage === null) {
    return null;
  }
  if ((o.state === "open" && o.runRowId === null && snapshot.attempts.length === 0) || snapshot.turn !== null) {
    return "original";
  }
  if (!could) {
    return null;
  }
  if (approved) {
    return "approved";
  }
  return snapshot.outage.holds.length > 0 && snapshot.reason?.code === "outage" ? "replacement" : "approval";
}

// Each approver on the list and whether they can sign the latest request now,
// with checkSigner's own words when they cannot.
export function approverChoices(snapshot: InvoiceSnapshot, now: number): ApproverChoice[] {
  const request: RequestSnapshot | undefined = latestRequest(snapshot);
  const policy: ApprovalPolicy = snapshot.signing.policy;
  if (request === undefined || request.terms === null) {
    return [];
  }
  return signerChoices(
    policy,
    request.approval,
    paymentAmount(request.terms),
    snapshot.signing.barred,
    awaitingSignoffs(request.approval, now),
    isExpired(request.approval, now),
  );
}

export function signerChoices(
  policy: ApprovalPolicy,
  request: Pick<Approval, "state" | "signoffs">,
  amount: PaymentAmount,
  barred: Barred[],
  waiting: boolean,
  expired: boolean,
): ApproverChoice[] {
  const signedBy: string[] = request.signoffs.map((signoff: { approver: string }): string => signoff.approver);
  return policy.approvers.map((approver: Approver): ApproverChoice => {
    const signed: boolean = signedBy.some((name: string): boolean => sameName(name, approver.name));
    const code: string | null =
      policy.problem !== null
        ? "policy-unreadable"
        : barred.some((entry: Barred): boolean => sameName(entry.name, approver.name))
          ? "barred"
          : signed
            ? "signed"
            : amount.minor > approver.limitMinor
              ? "over-limit"
              : null;
    let why: Why | null = null;
    if (code !== null) {
      try {
        checkSigner(policy, approver.name, amount, barredInWords(barred), signedBy);
      } catch (error: unknown) {
        why = { code, text: `${error instanceof Error ? error.message : String(error)}.` };
      }
    } else if (expired) {
      why = { code: "expired", text: "The request has expired. PayOnce opens a new one at its next check." };
    } else if (!waiting) {
      why = { code: "not-waiting", text: "No request is waiting for signoffs." };
    }
    return { name: approver.name, limitMinor: approver.limitMinor, canApprove: why === null, signed, why };
  });
}

// Why no request is open for an escalated payment a person could pay, or null.
// Display only: when it disagrees with the engine, the engine still decides.
export function whyNoRequest(snapshot: InvoiceSnapshot): Why | null {
  const policy: ApprovalPolicy = snapshot.signing.policy;
  if (policy.problem !== null) {
    return policy.unreadable
      ? { code: "approvers-unreadable", text: "Approvals are off: PayOnce can't read the approval settings. Settings shows what to fix." }
      : { code: "approvers-unset", text: "No approver list is set, so nobody can approve payments." };
  }
  // Limits are compared with what a request's terms take from the wallet, so
  // only a payment that had a request can be compared.
  const terms: ApprovalTerms | null | undefined = latestRequest(snapshot)?.terms;
  if (terms === null || terms === undefined) {
    return null;
  }
  const amount: PaymentAmount = paymentAmount(terms);
  const needed: number = Math.max(1, latestRequest(snapshot)?.approval.needed ?? 1, snapshot.signing.startedKnown ? 1 : 2);
  const eligible: Approver[] = eligibleApprovers(policy, amount, snapshot.signing.barred);
  if (eligible.length >= needed) {
    return null;
  }
  const limits: string = policy.approvers
    .map((approver: Approver): string => `${approver.name} ${formatAmount(approver.limitMinor)}`)
    .join(", ");
  const payment: string = formatMoney(amount.minor, amount.currency);
  const able: string = eligible.length === 0 ? "None of the approvers" : `Only ${eligible.length} of the approvers`;
  return {
    code: "too-few-approvers",
    text: `${able} can approve ${payment} (limits: ${limits}), and it needs ${needed}.`,
  };
}

function factsOf(snapshot: InvoiceSnapshot, now: number): Facts {
  const o: Obligation = snapshot.obligation;
  const attempts: Attempt[] = snapshot.attempts;
  const payouts: OutsidePayout[] = snapshot.payouts;
  const latest: RequestSnapshot | undefined = latestRequest(snapshot);
  const could: boolean = couldStillPay(o, attempts, payouts);
  const approved: boolean = approvedUnspent(latest?.approval, now);
  const live: Attempt[] = attempts.filter(inFlight);
  return {
    s: snapshot,
    now,
    o,
    attempts,
    payouts,
    latest,
    closed: o.state === "settled" || o.state === "rejected",
    escalated: o.state === "escalated",
    held: heldBeforePaying(o, attempts),
    could,
    closeKind: closeKindOf(snapshot),
    awaiting: awaitingSignoffs(latest?.approval, now),
    approved,
    open: requestOpen(latest?.approval, now),
    expired: requestExpired(latest?.approval, now),
    bankDetails: aboutBankDetails(snapshot),
    phone: phoneOnFile(o),
    touch: outageTouch(snapshot, could, approved),
    late: lateBesideLive(attempts, payouts),
    overdue: [...live]
      .reverse()
      .find((attempt: Attempt): boolean => pastDeadline(attempt, snapshot.deadlineMinutes, snapshot.reason, now)),
    live: live.at(-1),
    livePayout: payouts.find(payoutLive),
    pending: attempts.filter(sending).at(-1),
    choices: approverChoices(snapshot, now),
  };
}

// ---------- the payment's state ----------

interface Placed {
  state: PaymentState;
  variant: string | null;
}

// Held because the bank details on file are not, or may not be, the ones the
// payment was decided or approved for.
function detailsChanged(snapshot: InvoiceSnapshot): boolean {
  const code: string | undefined = snapshot.reason?.code;
  return code === "account-changed-before-send" || code === "account-unknown-before-send" || code === "run-account-changed";
}

function decisionVariant(f: Facts): string {
  const code: string | undefined = f.s.reason?.code;
  if (code === "replacement-failed") {
    return "replacement-failed";
  }
  if (detailsChanged(f.s)) {
    return "details-changed";
  }
  if (code === "beneficiary-missing") {
    return "beneficiary-missing";
  }
  if (f.payouts.some(payoutNamesOnly)) {
    return "names-only-payout";
  }
  if (f.o.rejectedBy !== null) {
    return "reopened";
  }
  return f.held ? "held" : "other";
}

function closeVariant(f: Facts): string {
  const paid: Attempt | undefined = f.attempts.find((attempt: Attempt): boolean => attempt.state === "paid");
  if (f.s.reason?.code === "non-receipt") {
    return "non-receipt";
  }
  if (paid?.rateMismatch !== null && paid?.rateMismatch !== undefined) {
    return "rate-mismatch";
  }
  if (paid?.misdirected === true) {
    return "misdirected";
  }
  if (f.closeKind === "outside") {
    return "outside";
  }
  return f.closeKind === "mismatched" ? "unrecognised" : "other";
}

function sendingVariant(f: Facts): string {
  if (f.escalated && f.payouts.some(payoutNotFailed)) {
    return "held-for-outside-payout";
  }
  return f.s.lastCheck?.ok === false || f.pending?.triedAt !== null ? "retrying" : "first";
}

function attemptVariant(f: Facts, attempt: Attempt, outside: string): string {
  return f.o.origin === "outside" && attempt.kind === "original" ? outside : attempt.kind;
}

// The first state whose predicate holds, in the order states.md gives.
function placed(f: Facts): Placed {
  const at = (state: PaymentState, variant: string | null = null): Placed => ({ state, variant });
  const decision: boolean = f.escalated && unpaidKind(f.closeKind) && !f.open;
  if (f.o.state === "settled") {
    return at("paid");
  }
  if (f.o.state === "rejected") {
    return at("closed-unpaid");
  }
  if (f.late !== undefined) {
    return at("paid-twice");
  }
  if (f.escalated && f.attempts.some(unrecognisedLive)) {
    return at("unrecognised-transfer");
  }
  // A paid replacement PayOnce closes by itself on its next look (the engine's
  // close rule). An open invoice paid once is closing too, further down.
  if (f.escalated && closesItself(f.attempts, f.payouts)) {
    return at("closing");
  }
  if (f.escalated && paidKind(f.closeKind)) {
    return at("ready-to-close", closeVariant(f));
  }
  if (f.touch === "original" || f.touch === "approved") {
    return at("paused-by-outage", f.touch);
  }
  if (f.could && f.awaiting && f.latest !== undefined) {
    return at("needs-approval", requestKind(f.s, f.latest) === "pay" ? "first-payment" : "replacement");
  }
  if (f.could && f.approved) {
    return at("approved");
  }
  if (f.could && f.expired && f.o.rejectedBy === null) {
    return at("renewing-request");
  }
  if (f.overdue !== undefined) {
    return at("bank-late", attemptVariant(f, f.overdue, "outside-taken-on"));
  }
  if (f.live !== undefined) {
    return at("with-bank", attemptVariant(f, f.live, "outside"));
  }
  if (f.livePayout !== undefined) {
    return at("with-bank", "outside");
  }
  if (f.pending !== undefined) {
    // A payment held because its bank details changed waits for a person to
    // restore them, not for PayOnce.
    return f.escalated && detailsChanged(f.s) ? at("needs-decision", "details-changed") : at("sending", sendingVariant(f));
  }
  if (f.s.turn !== null) {
    return at("queued-in-run");
  }
  if (decision && f.s.emails.count > 0 && f.s.emails.unread) {
    return at("reading-emails");
  }
  if (decision && f.bankDetails && f.phone && f.s.callbackBlocked === null) {
    return at("needs-callback");
  }
  if (decision && f.bankDetails && !f.phone) {
    return at("needs-phone");
  }
  if (decision && f.could && whyNoRequest(f.s) !== null) {
    return at("no-approvers");
  }
  if (decision) {
    return at("needs-decision", decisionVariant(f));
  }
  if (!f.closed && paidOnce(f.attempts)) {
    return at("closing");
  }
  if (f.o.state === "open") {
    return at(f.attempts.length > 0 ? "deciding" : "starting");
  }
  return at("checking");
}

interface StateKind {
  label: string;
  tone: Tone;
  group: QueueGroup;
}

const STATES: Record<PaymentState, StateKind> = {
  paid: { label: "Paid", tone: "done", group: "closed" },
  "closed-unpaid": { label: "Closed without paying", tone: "done", group: "closed" },
  "paid-twice": { label: "May be paid twice", tone: "urgent", group: "needs-you" },
  "unrecognised-transfer": { label: "Unrecognised transfer", tone: "urgent", group: "needs-you" },
  "ready-to-close": { label: "Paid, needs closing", tone: "act", group: "needs-you" },
  "paused-by-outage": { label: "Paused by outage", tone: "act", group: "needs-you" },
  "needs-approval": { label: "Needs approval", tone: "act", group: "needs-you" },
  approved: { label: "Approved, sending", tone: "progress", group: "payonce" },
  "renewing-request": { label: "Request expired", tone: "progress", group: "payonce" },
  "bank-late": { label: "Bank is late", tone: "urgent", group: "bank-late" },
  "with-bank": { label: "With the bank", tone: "progress", group: "with-bank" },
  sending: { label: "Sending", tone: "progress", group: "payonce" },
  "queued-in-run": { label: "Queued in pay run", tone: "progress", group: "payonce" },
  "reading-emails": { label: "Reading supplier emails", tone: "progress", group: "payonce" },
  "needs-callback": { label: "Needs a callback", tone: "act", group: "needs-you" },
  "needs-phone": { label: "Needs a phone number", tone: "blocked", group: "needs-you" },
  "no-approvers": { label: "Nobody can approve", tone: "blocked", group: "needs-you" },
  "needs-decision": { label: "Needs a decision", tone: "act", group: "needs-you" },
  closing: { label: "Paid, closing", tone: "progress", group: "payonce" },
  deciding: { label: "Deciding", tone: "progress", group: "payonce" },
  starting: { label: "Starting", tone: "progress", group: "payonce" },
  checking: { label: "Checking", tone: "progress", group: "payonce" },
};

// The approvers who could still sign the latest request.
function signers(f: Facts): string[] {
  return f.choices.filter((choice: ApproverChoice): boolean => choice.canApprove).map((choice: ApproverChoice): string => choice.name);
}

function waitingOnOf(f: Facts, state: PaymentState): WaitingOn {
  switch (state) {
    case "paid":
    case "closed-unpaid":
      return { who: "nobody" };
    case "paid-twice":
      return { who: "bank-then-person" };
    case "paused-by-outage":
      return { who: "outage-ender", names: f.s.outage?.enders ?? null };
    case "needs-approval":
      return { who: "approvers", names: signers(f) };
    case "bank-late":
    case "with-bank":
      return { who: "bank" };
    case "no-approvers":
      return { who: "admin" };
    case "unrecognised-transfer":
    case "ready-to-close":
    case "needs-callback":
    case "needs-phone":
    case "needs-decision":
      return { who: "person" };
    default:
      return { who: "payonce" };
  }
}

// The reference a person reads for the payment that paid the invoice.
function paidReference(f: Facts): string {
  if (f.closeKind === "outside") {
    return refOf(f.payouts.find(payoutPays)?.reference, "the payout");
  }
  if (f.closeKind === "mismatched") {
    return refOf(f.attempts.find(unrecognisedPaid)?.mismatchedReference, "the transfer");
  }
  return refOf(f.attempts.find((attempt: Attempt): boolean => attempt.state === "paid")?.reference, "the transfer");
}

function reasonSentence(f: Facts): string | null {
  return f.s.reason === null ? null : reasonText(f.s.reason);
}

function closeNext(f: Facts, variant: string): string {
  const ref: string = paidReference(f);
  switch (variant) {
    case "non-receipt":
      return `The bank paid ${ref}, but the supplier says it has not arrived. Confirm with them, then close as paid.`;
    case "rate-mismatch":
      return `${capitalise(ref)} went out at a rate nobody approved. Check the amount, then close as paid.`;
    case "misdirected":
      return `${capitalise(ref)} went to other bank details than were approved. Check with the supplier, then close as paid.`;
    case "outside":
      return `Payout ${ref} sent outside PayOnce paid it. Close as paid.`;
    case "unrecognised":
      return `Transfer ${ref}, unrecognised, is paid. Check it is this payment, then close as paid and name it.`;
    default: {
      const reason: string | null = reasonSentence(f);
      return reason === null
        ? `Paid by ${ref}. Only a person can close it.`
        : `Paid by ${ref}. PayOnce did not close it by itself because ${reason}.`;
    }
  }
}

function decisionNext(f: Facts, variant: string): string {
  const reason: string | null = reasonSentence(f);
  switch (variant) {
    case "replacement-failed":
      return "Both transfers failed. PayOnce never sends a third. Pay outside PayOnce and close it later, or close without paying.";
    case "details-changed":
      if (f.s.reason?.code === "account-unknown-before-send") {
        return "PayOnce doesn't know which bank details this payment was decided or approved for, so it won't send it again. Pay it another way, or close without paying.";
      }
      return f.pending !== undefined
        ? "The supplier's bank details changed before PayOnce sent this. Restore them in Airwallex and press Check now."
        : "The supplier's bank details changed before PayOnce sent this. Restore them in Airwallex and press Check now, or close without paying.";
    case "beneficiary-missing":
      return "The supplier record is no longer in Airwallex. Close without paying.";
    case "names-only-payout":
      return `Payout ${refOf(f.payouts.find(payoutNamesOnly)?.reference, "on file")} names this payment but does not match it. If the supplier was paid another way, close without paying.`;
    case "reopened":
      return `${f.o.rejectedBy ?? "A person"} closed this without paying before. A transfer found since reopened it, and nothing is live now. Close it again.`;
    case "held":
      return reason === null
        ? "PayOnce held this before the first transfer. Close without paying, or press Check now to ask for a new request."
        : `PayOnce held this before the first transfer: ${reason}. Close without paying, or press Check now to ask for a new request.`;
    default:
      return reason === null
        ? "Close without paying, or press Check now."
        : `${capitalise(reason)}. Close without paying, or press Check now.`;
  }
}

function transferName(f: Facts, attempt: Attempt): string {
  const ref: string = refOf(attempt.reference, "");
  if (f.o.origin === "outside" && attempt.kind === "original") {
    return ref === "" ? "the payout sent outside PayOnce" : `payout ${ref} sent outside PayOnce`;
  }
  return ref === "" ? `the ${attempt.kind}` : `${attempt.kind} ${ref}`;
}

interface Copy {
  next: Timed;
  detail: Timed | null;
  label: string;
}

function copyOf(f: Facts, place: Placed): Copy {
  const kind: StateKind = STATES[place.state];
  const s: InvoiceSnapshot = f.s;
  const request: Approval | undefined = f.latest?.approval;
  const expires: TimePart | null = request === undefined ? null : timeAt(request.expiresAt, true);
  const at: Timed = atNextCheck(s.nextCheckAt);
  const words = (next: string, detail: string | null = null): Copy => ({
    label: kind.label,
    detail: detail === null ? null : [detail],
    next: [next],
  });
  switch (place.state) {
    case "paid": {
      const by: RegExpExecArray | null = /^Incident closed by (.+?): /.exec(s.times.closedLine ?? "");
      return words(by === null ? "Closed by PayOnce" : `Closed by ${by[1] ?? ""}`);
    }
    case "closed-unpaid":
      return words(f.o.rejectedBy === null ? "Closed without paying" : `Closed without paying by ${f.o.rejectedBy}`);
    case "paid-twice":
      return words(
        "PayOnce sends nothing and closes nothing while two transfers may both pay the supplier. Check with the supplier which one arrived. Once the bank pays or fails one of them, close it here.",
      );
    case "unrecognised-transfer":
      return words(
        `Look up ${refOf(f.attempts.find(unrecognisedLive)?.mismatchedReference, "the transfer")} in Airwallex. It is listed under this payment's request id but does not match its number, amount or currency. If the bank pays it, close as paid here.`,
      );
    case "ready-to-close":
      return words(closeNext(f, place.variant ?? "other"));
    case "paused-by-outage": {
      const outage: Outage | undefined = s.outage?.outage;
      const id: string = outage === undefined ? "" : ` ${outage.id}`;
      return {
        label: `Paused by outage${id}`,
        detail:
          place.variant === "approved"
            ? timed("Approved transfer paused", expires === null ? null : timed(" (approval counts until ", expires, ")"))
            : ["First transfer paused"],
        next: [`Outage${id} on ${outage === undefined ? "its rail" : railName(outage)} stops new transfers there. Ending it sends this payment.`],
      };
    }
    case "needs-approval": {
      const names: string[] = signers(f);
      const signed: number = request?.signoffs.length ?? 0;
      const needed: number = request?.needed ?? 1;
      const lead: string = place.variant === "first-payment" ? "On hold before the first transfer" : "Replacement";
      return {
        label: kind.label,
        detail: timed(`${lead} · ${signed} of ${needed} signoffs`, expires === null ? null : timed(" · open until ", expires)),
        next: [
          names.length > 0
            ? `${listOf(names)} can approve it, or anyone can close it without paying.`
            : "Nobody left can approve it. Close it without paying, or wait for the request to expire.",
        ],
      };
    }
    case "approved":
      return { label: kind.label, detail: null, next: timed("PayOnce sends it ", at, ".") };
    case "renewing-request":
      return {
        label: kind.label,
        detail: null,
        next: timed("PayOnce opens a new request ", at, `. Signoffs on request #${request?.id ?? ""} no longer count.`),
      };
    case "bank-late": {
      const attempt: Attempt | undefined = f.overdue;
      const name: string = attempt === undefined ? "the transfer" : transferName(f, attempt);
      const due: TimePart | null = attempt === undefined ? null : timeAt(deadlineAt(attempt, s.deadlineMinutes), true);
      return {
        label: kind.label,
        detail: timed(capitalise(name), due === null ? null : timed(", due ", due)),
        next: timed(
          `The bank has not paid or failed ${name} by `,
          due ?? "its deadline",
          ". Ask Airwallex to trace it. PayOnce closes this if the bank pays it, and sends nothing else while it is live.",
        ),
      };
    }
    case "with-bank": {
      if (f.live === undefined) {
        const ref: string = refOf(f.livePayout?.reference, "on file");
        return words(
          `A payout sent outside PayOnce (${ref}) is with the bank. PayOnce sends nothing for this payment while it is live.`,
          `Payout ${ref} sent outside PayOnce`,
        );
      }
      const name: string = transferName(f, f.live);
      const due: TimePart | null = timeAt(deadlineAt(f.live, s.deadlineMinutes), true);
      return {
        label: kind.label,
        detail: [capitalise(name)],
        next: timed(`Waiting for the bank to pay or fail ${name}`, due === null ? null : timed(", due by ", due), "."),
      };
    }
    case "sending":
      return {
        label: kind.label,
        detail: null,
        next:
          place.variant === "held-for-outside-payout"
            ? ["A payout sent outside PayOnce may pay this, so PayOnce does not send the transfer while it is live."]
            : place.variant === "retrying"
              ? timed("Airwallex has not answered yet. PayOnce tries again ", at, " under the same request id, so it cannot pay twice.")
              : ["PayOnce is creating the transfer."],
      };
    case "queued-in-run": {
      const turn: RunTurn | null = s.turn;
      return {
        label: turn === null ? kind.label : `Queued in pay run ${turn.runId}`,
        detail: null,
        next: [
          `Pay run ${turn?.runId ?? ""} sends its rows one at a time. ${turn?.after === null || turn === null ? "This one is next." : `This one is next after row ${turn.after}.`}`,
        ],
      };
    }
    case "reading-emails":
      return {
        label: kind.label,
        detail: null,
        next: timed("PayOnce reads the supplier's emails before it offers anything for approval. It tries again ", at, "."),
      };
    case "needs-callback": {
      const ending: string | null = phoneEnding(f.o.supplierPhone);
      return words(
        `Call the supplier on the number on file${ending === null ? "" : ` (ending ${ending})`} and record what they confirm. Or close without paying.`,
      );
    }
    case "needs-phone":
      return words(
        "PayOnce never takes bank details from an email. Add a phone number you trust to the supplier record, then record a callback. Or close without paying.",
      );
    case "no-approvers":
      return words(`${whyNoRequest(s)?.text ?? ""} Or close without paying.`.trim());
    case "needs-decision":
      return words(decisionNext(f, place.variant ?? "other"));
    case "closing":
      return {
        label: kind.label,
        detail: null,
        next: timed(
          `The bank paid ${refOf(f.attempts.find((attempt: Attempt): boolean => attempt.state === "paid")?.reference, "the transfer")}. PayOnce closes this `,
          at,
          ".",
        ),
      };
    case "deciding":
      return {
        label: kind.label,
        detail: null,
        next: timed(`The ${f.attempts.at(-1)?.kind ?? "original"} failed. PayOnce decides `, at, " whether to resend it or ask a person."),
      };
    case "starting":
      return words("PayOnce checks the supplier record and sends the first transfer.");
    case "checking":
      return { label: kind.label, detail: null, next: timed("PayOnce checks this payment again ", at, ".") };
  }
}

function blockersOf(f: Facts, state: PaymentState): Blocker[] {
  const s: InvoiceSnapshot = f.s;
  const found: Blocker[] = [];
  const check: LastCheck | null = s.lastCheck;
  if (check !== null && !check.ok && check.error === "airwallex-unreachable") {
    found.push({
      code: "airwallex-unreachable",
      text: timed("PayOnce cannot reach Airwallex (since ", timeAt(check.at) ?? "its last check", "). It tries again every minute."),
      since: check.at,
    });
  } else if (check !== null && !check.ok && check.error === "airwallex-error") {
    found.push({
      code: "airwallex-error",
      text: timed("Airwallex answered with an error at ", timeAt(check.at) ?? "its last check", ". PayOnce tries again ", atNextCheck(s.nextCheckAt), "."),
      since: check.at,
    });
  }
  const outage: Outage | undefined = s.outage?.outage;
  if (state === "needs-approval" && outage !== undefined && (f.touch === "replacement" || f.touch === "approval")) {
    found.push({
      code: "outage",
      text: [`Outage ${outage.id} on ${railName(outage)} is active, so an approval given now waits until someone ends it.`],
      since: outage.declaredAt,
    });
  }
  if (state === "reading-emails" && s.emails.readerFailed) {
    found.push({
      code: "reader",
      text: timed("The email reader could not read an email. PayOnce tries again ", atNextCheck(s.nextCheckAt), "."),
      since: null,
    });
  }
  if (!f.closed && !s.busy && s.nextCheckAt !== null && f.now - s.nextCheckAt > OVERDUE_CHECK_MS) {
    found.push({ code: "overdue-check", text: ["PayOnce's check is overdue. Press Check now."], since: iso(s.nextCheckAt) });
  }
  return found;
}

function alsoOf(f: Facts, state: PaymentState): string[] {
  const s: InvoiceSnapshot = f.s;
  const also: string[] = [];
  if (s.inbox.offered > 0) {
    also.push(
      s.inbox.offered === 1
        ? "An email in the inbox names only this payment."
        : `${s.inbox.offered} emails in the inbox name only this payment.`,
    );
  }
  if (s.inbox.named > 0) {
    also.push(
      s.inbox.named === 1
        ? "An email in the inbox may be about this payment."
        : `${s.inbox.named} emails in the inbox may be about this payment.`,
    );
  }
  const terms: ApprovalTerms | null | undefined = f.latest?.terms;
  const verified: boolean = terms !== null && terms !== undefined && terms.evidence.bankChange !== null && terms.evidence.bankChange !== undefined;
  if (state === "needs-approval" && f.bankDetails && !verified) {
    also.push("The supplier asked to be paid to other bank details. This request pays the account on file.");
  }
  if (
    state === "needs-approval" &&
    terms?.action === "replace" &&
    !verified &&
    terms.evidence.failureCode !== null &&
    !RESENDABLE_FAILURE_CODES.has(terms.evidence.failureCode)
  ) {
    also.push("This replacement goes to the account the original failed on. Check the account with the supplier first.");
  }
  if (state !== "bank-late" && f.overdue !== undefined) {
    also.push(`${capitalise(transferName(f, f.overdue))} is past its bank deadline.`);
  }
  return also;
}

function sinceOf(f: Facts, state: PaymentState): string | null {
  const times: SnapshotTimes = f.s.times;
  const request: Approval | undefined = f.latest?.approval;
  const index = (attempt: Attempt | undefined): number => (attempt === undefined ? -1 : f.attempts.indexOf(attempt));
  switch (state) {
    case "paid":
    case "closed-unpaid":
      return times.closedAt;
    case "paid-twice":
      return f.late?.foundLateAt ?? times.escalatedAt;
    case "paused-by-outage":
      return f.s.outage?.outage.declaredAt ?? null;
    case "needs-approval":
      return request?.requestedAt ?? null;
    case "approved":
      return request?.signoffs.at(-1)?.at ?? null;
    case "renewing-request":
      return request?.expiresAt ?? null;
    case "bank-late":
      return f.overdue === undefined ? null : iso(deadlineAt(f.overdue, f.s.deadlineMinutes));
    case "with-bank":
      return f.live?.bankCreatedAt ?? times.foundAt[f.livePayout === undefined ? -1 : f.payouts.indexOf(f.livePayout)] ?? null;
    case "sending":
      return f.pending?.openedAt ?? null;
    case "queued-in-run":
      return f.s.run?.run.releasedAt ?? null;
    case "closing":
      return times.paidAt[index(f.attempts.find((attempt: Attempt): boolean => attempt.state === "paid"))] ?? null;
    case "deciding":
      return times.failedAt[f.attempts.length - 1] ?? null;
    case "starting":
      return times.firstEventAt;
    case "checking":
      return null;
    default:
      return times.escalatedAt;
  }
}

function deadlineOfState(f: Facts, state: PaymentState): string | null {
  const request: Approval | undefined = f.latest?.approval;
  if (state === "bank-late" && f.overdue !== undefined) {
    return iso(deadlineAt(f.overdue, f.s.deadlineMinutes));
  }
  if (state === "with-bank" && f.live !== undefined) {
    return iso(deadlineAt(f.live, f.s.deadlineMinutes));
  }
  if ((state === "needs-approval" || state === "approved" || state === "paused-by-outage") && request !== undefined) {
    return iso(expiryOf(request));
  }
  return null;
}

function canOf(f: Facts, state: PaymentState): Record<PersonAction, Can> {
  const s: InvoiceSnapshot = f.s;
  const approve: Can = !f.awaiting
    ? refused(f.expired ? "expired" : "not-waiting", f.expired ? "The approval request has expired." : "No approval request is waiting.")
    : f.choices.some((choice: ApproverChoice): boolean => choice.canApprove)
      ? allowed()
      : refused("no-approver", "Nobody left on the approver list can approve this request.");
  return {
    approve,
    recordCallback: !f.escalated
      ? refused("not-escalated", "The payment is not waiting on a person.")
      : s.callbackBlocked !== null
        ? refused("callback-blocked", /[.!?]$/.test(s.callbackBlocked) ? s.callbackBlocked : `${s.callbackBlocked}.`)
        : allowed(),
    closeAsPaid: paidKind(f.closeKind) ? allowed() : refused("not-paid", "Nothing on file has paid this payment."),
    closeUnpaid: unpaidKind(f.closeKind)
      ? allowed()
      : refused(
          f.escalated ? "live" : "not-escalated",
          f.escalated ? "A payment for it is with the bank or paid." : "The payment is not waiting on a person.",
        ),
    endOutage:
      state !== "paused-by-outage"
        ? refused("no-outage", "No outage holds this payment.")
        : s.outage?.endRefusal !== null && s.outage?.endRefusal !== undefined
          ? refused("policy-unreadable", s.outage.endRefusal)
          : allowed(),
    draftTrace: state === "bank-late" ? allowed() : refused("not-late", "The bank is not late with a transfer for it."),
    checkNow: f.closed ? refused("closed", "The payment is closed.") : allowed(),
    askWhy: s.askWhy ? allowed() : refused("explainer-off", "Ask why is not set up."),
  };
}

export function situationOf(snapshot: InvoiceSnapshot, now: number): Situation {
  const f: Facts = factsOf(snapshot, now);
  const place: Placed = placed(f);
  const kind: StateKind = STATES[place.state];
  const copy: Copy = copyOf(f, place);
  const blockers: Blocker[] = blockersOf(f, place.state);
  return {
    state: place.state,
    variant: place.variant,
    label: copy.label,
    detail: copy.detail,
    tone: blockers.length > 0 && kind.tone !== "urgent" ? "blocked" : kind.tone,
    group: kind.group,
    waitingOn: waitingOnOf(f, place.state),
    next: blockers.length > 0 && place.state === "approved" ? (blockers[0]?.text ?? copy.next) : copy.next,
    why: snapshot.reason === null ? null : reasonView(snapshot.reason),
    blockers,
    also: alsoOf(f, place.state),
    since: sinceOf(f, place.state),
    nextCheckAt: iso(snapshot.nextCheckAt),
    deadlineAt: deadlineOfState(f, place.state),
    urgent: kind.tone === "urgent",
    can: canOf(f, place.state),
  };
}

// ---------- the incident on a payment ----------

function failureWords(code: string | null): string {
  if (code === null) {
    return "no failure code";
  }
  return Object.hasOwn(FAILURE_WORDS, code) ? (FAILURE_WORDS[code] ?? code) : "a code PayOnce has no words for";
}

function earliest(times: (string | null | undefined)[]): string | null {
  const known: number[] = times
    .map((at: string | null | undefined): number => (at === null || at === undefined ? Number.NaN : Date.parse(at)))
    .filter((at: number): boolean => Number.isFinite(at));
  return known.length === 0 ? null : new Date(Math.min(...known)).toISOString();
}

// The exception on a payment, or null for one paid by its first transfer with
// nothing else on file.
export function incidentOf(snapshot: InvoiceSnapshot): IncidentBrief | null {
  const o: Obligation = snapshot.obligation;
  const attempts: Attempt[] = snapshot.attempts;
  const times: SnapshotTimes = snapshot.times;
  const pauses: OutageHold[] = times.holds.filter((hold: OutageHold): boolean => hold.what !== "counted");
  const failed: Attempt | undefined = attempts.find((attempt: Attempt): boolean => attempt.state === "failed");
  const any: boolean =
    failed !== undefined ||
    attempts.some(
      (attempt: Attempt): boolean =>
        attempt.kind === "replacement" || attempt.mismatchedTransferId !== null || attempt.foundLateAt !== null,
    ) ||
    o.escalationReason !== "" ||
    o.origin === "outside" ||
    snapshot.payouts.length > 0 ||
    pauses.length > 0 ||
    o.rejectedBy !== null ||
    o.state === "rejected";
  if (!any) {
    return null;
  }
  const label: string | null =
    snapshot.reason === null ? null : labelOf(snapshot.reason.code).replace(/^./, (first: string): string => first.toLowerCase());
  // Held before its first transfer: nothing sent yet, or the first transfer went
  // out on a person's approval.
  const first: Attempt | undefined = attempts[0];
  const heldFirst: boolean = first === undefined || (first.kind === "original" && first.approvalId !== null);
  // A transfer PayOnce had marked never sent that Airwallex listed later is with
  // the bank, as the Transfers tab says, not failed.
  const late: boolean = failed !== undefined && failed.foundLateAt !== null && liveAtBank(failed);
  const cause: string =
    failed !== undefined
      ? late
        ? `${capitalise(failed.kind)} turned up late at the bank`
        : failed.transferId !== null
          ? `${capitalise(failed.kind)} failed: ${failureWords(failed.failureCode)}`
          : failed.failureCode !== null
            ? `Airwallex refused the ${failed.kind} (${failed.failureCode})`
            : `${capitalise(failed.kind)} was never sent`
      : o.origin === "outside"
        ? "Found: a payout sent outside PayOnce"
        : heldFirst && label !== null
          ? `On hold: ${label}`
          : pauses[0] !== undefined
            ? `Paused by outage ${pauses[0].outageId}`
            : snapshot.reason !== null
              ? labelOf(snapshot.reason.code)
              : snapshot.payouts.length > 0
                ? "A payout sent outside PayOnce names it"
                : o.state === "rejected"
                  ? "Closed without paying"
                  : "A transfer turned up late";
  const failedAt: string | null = failed === undefined ? null : (times.failedAt[attempts.indexOf(failed)] ?? null);
  return {
    cause,
    openedAt:
      earliest([failedAt, times.escalatedAt, times.foundAt[0], pauses[0]?.heldAt]) ?? times.firstEventAt,
    endedAt: o.state === "settled" || o.state === "rejected" ? times.closedAt : null,
    neededPerson: o.escalationReason !== "",
  };
}

// ---------- requests ----------

export function requestStateOf(request: Approval | RunApproval, requests: { id: number }[], now: number): RequestStateView {
  const later: { id: number } | undefined = requests.find((other: { id: number }): boolean => other.id > request.id);
  const expired: boolean = isExpired(request, now);
  const view = (state: RequestState, label: string): RequestStateView => ({ id: request.id, state, label });
  switch (request.state) {
    case "requested":
      return expired
        ? view("expired", "Expired")
        : view("waiting", `Waiting for signoffs (${request.signoffs.length} of ${request.needed})`);
    case "approved":
      return expired
        ? view("expired", "Expired")
        : view("approved", `Approved by ${listOf(request.signoffs.map((signoff: { approver: string }): string => signoff.approver))}`);
    case "used":
      return view("used", "Used for one transfer");
    case "void":
      return later === undefined ? view("withdrawn", "Withdrawn") : view("replaced", `Replaced by request #${later.id}`);
  }
}

// ---------- pay runs ----------

export type RunStatus = "waiting-approval" | "approved" | "expired" | "needs-check" | "released" | "cancelled";

export type RunPhase =
  | "needs-approval"
  | "paused-by-outage"
  | "approved"
  | "request-expired"
  | "nothing-to-pay"
  | "needs-recheck"
  | "sending"
  | "released"
  | "cancelled";

export interface RunSituation {
  state: RunPhase;
  label: string;
  detail: Timed | null;
  tone: Tone;
  group: QueueGroup;
  waitingOn: WaitingOn;
  next: Timed;
  why: string | null;
}

export type RunRowState = "will-pay" | "second-bill-check" | "skipped" | "released" | "not-released";

export interface RunRowStateView {
  state: RunRowState;
  label: string;
  newPayee: boolean;
  callbackVerified: boolean;
}

// The body of runs.ts runStatus, at a given time.
export function runStatusOf(run: Pick<Run, "state">, request: Pick<RunApproval, "state" | "expiresAt"> | undefined, now: number): RunStatus {
  if (run.state === "released" || run.state === "cancelled") {
    return run.state;
  }
  if (request?.state === "requested") {
    return isExpired(request, now) ? "expired" : "waiting-approval";
  }
  if (request?.state === "approved") {
    return isExpired(request, now) ? "expired" : "approved";
  }
  return "needs-check";
}

function runSigners(snapshot: RunSnapshot): string[] {
  const request: RunSnapshot["request"] = snapshot.request;
  if (request === null || request.terms === null || snapshot.policy.problem !== null) {
    return [];
  }
  const signedBy: string[] = request.approval.signoffs.map((signoff: { approver: string }): string => signoff.approver);
  return eligibleApprovers(snapshot.policy, runAmount(request.terms), request.barred)
    .map((approver: Approver): string => approver.name)
    .filter((name: string): boolean => !signedBy.some((signer: string): boolean => sameName(signer, name)));
}

function runTotalsText(terms: RunTerms | null): string {
  return terms === null
    ? ""
    : listOf(terms.totals.map((total: { amountMinor: number; currency: string }): string => formatMoney(total.amountMinor, total.currency)));
}

export function runSituationOf(snapshot: RunSnapshot, now: number): RunSituation {
  const run: Run = snapshot.run;
  const status: RunStatus = runStatusOf(run, snapshot.request?.approval, now);
  const paying: number = snapshot.rows.filter((row: RunRow): boolean => row.action === "pay" && row.state !== "dropped").length;
  const situation = (
    state: RunPhase,
    label: string,
    tone: Tone,
    group: QueueGroup,
    waitingOn: WaitingOn,
    next: string,
    why: string | null = null,
    detail: Timed | null = null,
  ): RunSituation => ({ state, label, detail, tone, group, waitingOn, next: [next], why });
  const request: RunApproval | undefined = snapshot.request?.approval;
  const expires: TimePart | null = request === undefined ? null : timeAt(request.expiresAt, true);
  if (status === "waiting-approval") {
    const names: string[] = runSigners(snapshot);
    const totals: string = runTotalsText(snapshot.request?.terms ?? null);
    const payments: string = plural(paying, "1 payment", "payments");
    return situation(
      "needs-approval",
      "Needs approval",
      "act",
      "needs-you",
      { who: "approvers", names },
      `${names.length > 0 ? `${listOf(names)} can approve` : "Nobody left can approve"} ${payments}${totals === "" ? "" : ` (${totals})`}. Anyone can cancel the run.`,
      null,
      timed(`${request?.signoffs.length ?? 0} of ${request?.needed ?? 1} signoffs`, expires === null ? null : timed(" · open until ", expires)),
    );
  }
  const outage: Outage | undefined = snapshot.outage?.outage;
  if (run.state === "waiting" && outage !== undefined && status === "approved") {
    return situation(
      "paused-by-outage",
      `Paused by outage ${outage.id}`,
      "act",
      "needs-you",
      { who: "outage-ender", names: snapshot.outage?.enders ?? null },
      `The run is released whole, and outage ${outage.id} on ${railName(outage)} is active. Ending it releases the run.`,
      null,
      timed("Approved release paused", expires === null ? null : timed(" (approval counts until ", expires, ")")),
    );
  }
  if (status === "approved") {
    return situation(
      "approved",
      "Approved, releasing",
      "progress",
      "payonce",
      { who: "payonce" },
      "PayOnce releases the run at its next check and sends rows one at a time.",
    );
  }
  if (status === "expired") {
    return situation(
      "request-expired",
      "Request expired",
      "act",
      "needs-you",
      { who: "person" },
      "Run requests are not renewed by themselves. Re-check the run to open a new request.",
    );
  }
  if (status === "needs-check") {
    return paying === 0
      ? situation(
          "nothing-to-pay",
          "Nothing to pay",
          "act",
          "needs-you",
          { who: "person" },
          "Every row was skipped. Cancel the run, fix the file and upload it again.",
        )
      : situation(
          "needs-recheck",
          "Needs re-check",
          "act",
          "needs-you",
          { who: "person" },
          "The approval no longer covers the rows. Re-check the run.",
          snapshot.standing,
        );
  }
  if (status === "cancelled") {
    return situation(
      "cancelled",
      "Cancelled",
      "done",
      "closed",
      { who: "nobody" },
      `Cancelled by ${run.cancelledBy ?? "a person"}${run.cancelNote === null ? "" : `: ${run.cancelNote}`}`,
    );
  }
  const states: PaymentState[] = snapshot.released.map((invoice: InvoiceSnapshot): PaymentState => situationOf(invoice, now).state);
  const released: number = snapshot.rows.filter((row: RunRow): boolean => row.state === "released").length;
  if (states.some((state: PaymentState): boolean => state === "starting" || state === "queued-in-run" || state === "sending")) {
    const sent: number = states.filter(
      (state: PaymentState): boolean => state !== "starting" && state !== "queued-in-run" && state !== "sending",
    ).length;
    return situation(
      "sending",
      "Sending rows",
      "progress",
      "payonce",
      { who: "payonce" },
      `${sent} of ${released} rows sent. PayOnce sends them one at a time.`,
    );
  }
  const groups: QueueGroup[] = states.map((state: PaymentState): QueueGroup => STATES[state].group);
  const needYou: number = groups.filter((group: QueueGroup): boolean => group === "needs-you" || group === "bank-late").length;
  return situation(
    "released",
    "Released",
    needYou > 0 ? "act" : "done",
    "closed",
    { who: "nobody" },
    `${states.filter((state: PaymentState): boolean => state === "paid").length} paid, ${groups.filter((group: QueueGroup): boolean => group === "with-bank").length} with the bank, ${needYou} need you.`,
  );
}

export function runRowStateOf(
  row: Pick<RunRow, "action" | "state" | "reasons" | "heldFor" | "newPayee" | "bankChangeId">,
  payment: Situation | null,
): RunRowStateView {
  const flags = { newPayee: row.newPayee, callbackVerified: row.bankChangeId !== null };
  if (row.action === "skip") {
    return { state: "skipped", label: `Skipped (${plural(row.reasons.length, "1 reason", "reasons")})`, ...flags };
  }
  if (row.state === "released") {
    return { state: "released", label: payment?.label ?? "Released", ...flags };
  }
  if (row.state === "dropped") {
    return { state: "not-released", label: "Not released", ...flags };
  }
  return row.heldFor.length > 0
    ? {
        state: "second-bill-check",
        label: `Pays, checked again at send: possible second bill of ${listOf(row.heldFor)}`,
        ...flags,
      }
    : { state: "will-pay", label: "Pays", ...flags };
}

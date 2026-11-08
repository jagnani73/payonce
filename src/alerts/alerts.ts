import { createHash, randomUUID } from "node:crypto";
import type { CashReport, CurrencyCash } from "../store/read/cash.js";
import {
  alertMessage,
  payloadFor,
  type AlertFacts,
  type AlertFormat,
  type AuditAlertFacts,
  type CashAlertFacts,
  type ContactAlertFacts,
  type InboxAlertFacts,
  type InvoiceAlertFacts,
  type InvoiceNeed,
  type OutageAlertFacts,
  type PayoutAlertFacts,
  type ReconAlertFacts,
  type RunAlertFacts,
  type SummaryAlertFacts,
} from "./alert-payloads.js";
import type { ApprovalTerms, RunTerms, RunTotal } from "../domain/approval.js";
import {
  chainReports,
  ledgerReport,
  reconChainReport,
  runChainReports,
  runLedgerReport,
  type AuditSnapshot,
  type ChainBreak,
  type ChainReport,
  type HeadRestart,
  type LedgerReport,
  type ReconChainReport,
  type RunAuditSnapshot,
  type RunChainReport,
  type RunLedgerReport,
} from "../store/audit-trail.js";
import { waiting, type Contact } from "../domain/contacts.js";
import { BENEFICIARY_ID_PATTERN } from "../domain/patterns.js";
import { approvedUnderway, heldBeforePaying } from "../domain/live.js";
import { FLOOR_CLAUSES, parseReason, reasonText, withoutClauses } from "../domain/reasons.js";
import {
  aboutBankDetails,
  situationOf,
  type InvoiceSnapshot,
  type RequestSnapshot,
  type Situation,
} from "../domain/situation.js";
import type {
  Alert,
  AlertFinish,
  Attempt,
  FoundCondition,
  InboxWaiting,
  Ledger,
  Obligation,
  Outage,
  OutageHold,
  OutsidePayout,
  RecordedConditions,
  Run,
  RunApproval,
} from "../store/ledger.js";
import { formatMoney } from "../domain/money.js";
import { say, sayWarning } from "../text/printable.js";
import { redactKeys } from "../text/redact.js";
import { shownCurrency, shownInvoice, shownReference } from "../recon/recon-match.js";
import type { KindTotal, ReconAlertState, ReconBreak } from "../store/recon-store.js";
import { runStatus } from "../runs/runs.js";

// How often the server looks for conditions that need a person, how long a new
// alert waits before it is posted (so a request opened a moment after an
// escalation replaces it), and how long a condition must be gone before its
// return counts as new.
const CHECK_EVERY_MS: number = 5_000;
const SETTLE_MS: number = 10_000;
const CLEAR_AFTER_MS: number = 10 * 60_000;
const AUDIT_EVERY_MS: number = 60_000;
const POST_TIMEOUT_MS: number = 8_000;
const MAX_TRIES: number = 5;
const FIRST_BACKOFF_MS: number = 30_000;
const MAX_RETRY_AFTER_MS: number = 15 * 60_000;
const CLAIM_MS: number = 60_000;
const POSTS_PER_FLUSH: number = 4;
// Slack takes about one message a second from an incoming webhook.
const POST_GAP_MS: number = 1_100;

// How long an ended outage stays a condition, and how many payouts its alert
// names.
const ENDED_OUTAGE_SHOWN_MS: number = 24 * 60 * 60_000;
// How long a phone number two people put on file stays a condition.
const CONTACT_SHOWN_MS: number = 24 * 60 * 60_000;
const OUTAGE_REFERENCES_SHOWN: number = 5;

const SUMMARY_KEY: string = "summary";
const INBOX_KEY: string = "inbox";
const RECON_KEY: string = "recon";
// Answers that mean the address is wrong or the webhook is gone, so posting again
// cannot help.
const GONE: readonly number[] = [401, 403, 404, 410];

// Where alerts go. test is a receiver on this machine, which only
// ALERT_TEST_RECEIVER_URL can name.
export interface AlertTarget {
  format: AlertFormat;
  url: URL;
  host: string;
  test: boolean;
}

// ALERT_WEBHOOK_URL, ALERT_FORMAT and ALERT_TEST_RECEIVER_URL, as settings.ts
// reads them. target is null when alerts are off: no setting, or one PayOnce
// refused, which problem says without repeating the value.
export interface AlertSetting {
  target: AlertTarget | null;
  problem: string | null;
}

// The start-up line. It names the host only, never the address.
export function describeAlerts(setting: AlertSetting): string {
  const target: AlertTarget | null = setting.target;
  if (target === null) {
    return setting.problem === null
      ? "Alerts are off: ALERT_WEBHOOK_URL is not set"
      : `Alerts are off, and nothing is sent: ${setting.problem}`;
  }
  const format: string = target.format === "slack" ? "Slack's" : "Discord's";
  return target.test
    ? `Alerts go to a test receiver at ${target.host} in ${format} format (ALERT_TEST_RECEIVER_URL), not to Slack or Discord`
    : `Alerts go to ${target.format === "slack" ? "Slack" : "Discord"} at ${target.host}`;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function condition(key: string, identity: unknown, facts: AlertFacts): FoundCondition {
  return { key, kind: facts.kind, fingerprint: hashOf(identity), facts: JSON.stringify(facts) };
}

// What the situation asks a person to do about an escalated invoice, or null:
// the approvers sign, a person checks a payment that may pay it twice, closes a
// paid one, decides on a held one, calls the supplier or finds a phone number,
// the bank's deadline passed, or a payout sent outside PayOnce is with the bank.
// An escalated payment whose own transfer is with the bank keeps the need its
// reason gives, a call when the supplier's bank details are in question and a
// phone is on file, as an alert for a fraud signal while money is in flight.
function situationNeed(snapshot: InvoiceSnapshot, situation: Situation): InvoiceNeed | null {
  switch (situation.state) {
    case "needs-approval":
      return situation.variant === "first-payment" ? "approve-held" : "approve";
    case "paid-twice":
    case "unrecognised-transfer":
      return "twice";
    case "bank-late":
      return "bank";
    case "ready-to-close":
      return "close";
    case "needs-decision":
      return snapshot.obligation.rejectedBy !== null || heldBeforePaying(snapshot.obligation, snapshot.attempts)
        ? "held"
        : "check";
    case "no-approvers":
      return "check";
    case "needs-callback":
      return "callback";
    case "needs-phone":
      return "phone";
    case "with-bank":
      return situation.variant === "outside"
        ? "outside"
        : aboutBankDetails(snapshot) && snapshot.obligation.supplierPhone !== null
          ? "callback"
          : "check";
    default:
      return null;
  }
}

// Whether a person already approved what the invoice went to a person for, and
// PayOnce is sending that payment or it is with the bank. The approval every
// payment a person starts waits for is not one: it came before anything went
// wrong, so a reason the invoice went to a person for since is news.
function underway(snapshot: InvoiceSnapshot, now: number): boolean {
  const latest: RequestSnapshot | undefined = snapshot.requests.at(-1);
  if (latest?.terms?.action === "pay" && parseReason(latest.terms.evidence.reason).code === "person-started") {
    return false;
  }
  return approvedUnderway(latest?.approval, snapshot.attempts, now);
}

// The need, unless a person already approved and PayOnce is sending that payment
// or it is with the bank: then only a payment that may pay twice and a bank that
// is late are news.
function needOf(snapshot: InvoiceSnapshot, situation: Situation, now: number): InvoiceNeed | null {
  const need: InvoiceNeed | null = situationNeed(snapshot, situation);
  return need === null ||
    need === "approve" ||
    need === "approve-held" ||
    need === "bank" ||
    need === "twice" ||
    !underway(snapshot, now)
    ? need
    : null;
}

function invoiceCondition(snapshot: InvoiceSnapshot, now: number): FoundCondition | null {
  const obligation: Obligation = snapshot.obligation;
  if (obligation.state !== "escalated") {
    return null;
  }
  const situation: Situation = situationOf(snapshot, now);
  const need: InvoiceNeed | null = needOf(snapshot, situation, now);
  if (need === null) {
    return null;
  }
  const invoiceId: string = obligation.invoiceId;
  // The request the approvers are asked to sign.
  const pending: RequestSnapshot | undefined =
    situation.state === "needs-approval" ? snapshot.requests.at(-1) : undefined;
  const terms: ApprovalTerms | null = pending?.terms ?? null;
  const facts: InvoiceAlertFacts = {
    kind: "invoice",
    invoice: invoiceId,
    supplier: obligation.supplier,
    amount: formatMoney(obligation.amountMinor, obligation.currency),
    need,
    reason: obligation.escalationReason,
    approvers: pending?.approval.needed ?? null,
    openUntil: pending?.approval.expiresAt ?? null,
    newAccount: terms?.action === "replace" && terms.evidence.bankChange !== null,
  };
  // A request renewed on the same terms is the same need. The reason leaves out
  // the floor clause the agent adds or drops as the balance moves, so the floor
  // alone does not alert an invoice again. The fingerprint never leaves the
  // ledger.
  const base: string = snapshot.reason === null ? "" : reasonText(withoutClauses(snapshot.reason, FLOOR_CLAUSES));
  const request: unknown =
    terms === null
      ? null
      : {
          action: terms.action,
          amountMinor: terms.amountMinor,
          currency: terms.currency,
          accountKey: terms.accountKey,
          needed: pending?.approval.needed,
        };
  return condition(`invoice:${invoiceId}`, { need, reason: base, request }, facts);
}

const PAYOUT_STATES: Record<string, string> = {
  in_flight: "in flight",
  pending: "in flight",
  paid: "paid",
  failed: "failed",
  unknown: "in a status PayOnce does not know",
};

function payoutConditions(ledger: Ledger, obligation: Obligation): FoundCondition[] {
  const found: FoundCondition[] = ledger.outsidePayouts(obligation.invoiceId).map(
    (payout: OutsidePayout): FoundCondition => {
      const facts: PayoutAlertFacts = {
        kind: "payout",
        reference: payout.reference === "" ? null : payout.reference,
        invoice: obligation.invoiceId,
        takenOn: false,
        supplier: obligation.supplier,
        amount:
          payout.amountMinor === null || payout.currency === null
            ? formatMoney(obligation.amountMinor, obligation.currency)
            : formatMoney(payout.amountMinor, payout.currency),
        state: PAYOUT_STATES[payout.state] ?? payout.state,
      };
      return condition(`payout:${payout.transferId}`, "found", facts);
    },
  );
  if (obligation.origin === "outside") {
    const original: Attempt | undefined = ledger
      .attempts(obligation.invoiceId)
      .find((attempt: Attempt): boolean => attempt.kind === "original" && attempt.transferId !== null);
    if (original !== undefined) {
      const facts: PayoutAlertFacts = {
        kind: "payout",
        reference: original.reference,
        invoice: obligation.invoiceId,
        takenOn: true,
        supplier: obligation.supplier,
        amount: formatMoney(obligation.amountMinor, obligation.currency),
        state: PAYOUT_STATES[original.state] ?? original.state,
      };
      found.push(condition(`payout:${original.transferId ?? ""}`, "found", facts));
    }
  }
  return found;
}

function runCondition(ledger: Ledger, run: Run): FoundCondition | null {
  const approval: RunApproval | undefined = ledger.latestRunApproval(run.id);
  if (approval === undefined || runStatus(ledger, run) !== "waiting-approval") {
    return null;
  }
  const terms: RunTerms = JSON.parse(approval.terms) as RunTerms;
  const facts: RunAlertFacts = {
    kind: "run",
    run: run.id,
    payments: terms.rows.length,
    totals: terms.totals.map((total: RunTotal): string => formatMoney(total.amountMinor, total.currency)),
    approvers: approval.needed,
    openUntil: approval.expiresAt,
  };
  return condition(`run:${run.id}`, { binding: approval.binding, needed: approval.needed }, facts);
}

function runningHash(report: {
  stored: string | null;
  computed: string;
  restarted: HeadRestart | null;
}): AuditAlertFacts["runningHash"] {
  return report.restarted !== null
    ? "started again"
    : report.stored === null
      ? "missing"
      : report.stored === report.computed
        ? "matches"
        : "does not match";
}

// Every invoice and pay run timeline, and both running hashes. This reads every
// line, so the server runs it once a minute.
function auditConditions(ledger: Ledger): FoundCondition[] {
  const found: FoundCondition[] = [];
  const invoices: AuditSnapshot = ledger.auditSnapshot(null);
  const brokenInvoices: ChainReport[] = chainReports(invoices.events).filter(
    (report: ChainReport): boolean => report.breaks.length > 0,
  );
  const invoiceReport: LedgerReport = ledgerReport(invoices);
  const invoiceHash: AuditAlertFacts["runningHash"] = runningHash(invoiceReport);
  if (brokenInvoices.length > 0 || !invoiceReport.intact) {
    const first: ChainBreak | undefined = brokenInvoices[0]?.breaks[0];
    const facts: AuditAlertFacts = {
      kind: "audit",
      scope: "invoices",
      broken: brokenInvoices.length,
      first: brokenInvoices[0]?.invoiceId ?? null,
      line: first?.line ?? null,
      runningHash: invoiceHash,
      withoutLine: invoiceReport.unlined.length,
    };
    const ids: string[] = brokenInvoices.map((report: ChainReport): string => report.invoiceId).sort();
    found.push(condition("audit:invoices", { ids, hash: invoiceHash, unlined: invoiceReport.unlined }, facts));
  }
  const runs: RunAuditSnapshot = ledger.runAuditSnapshot(null);
  const brokenRuns: RunChainReport[] = runChainReports(runs.events).filter(
    (report: RunChainReport): boolean => report.breaks.length > 0,
  );
  const runReport: RunLedgerReport = runLedgerReport(runs);
  const runHash: AuditAlertFacts["runningHash"] = runningHash(runReport);
  if (brokenRuns.length > 0 || !runReport.intact) {
    const first: ChainBreak | undefined = brokenRuns[0]?.breaks[0];
    const facts: AuditAlertFacts = {
      kind: "audit",
      scope: "runs",
      broken: brokenRuns.length,
      first: brokenRuns[0] === undefined ? null : String(brokenRuns[0].runId),
      line: first?.line ?? null,
      runningHash: runHash,
      withoutLine: runReport.unlined.length,
    };
    const ids: number[] = brokenRuns
      .map((report: RunChainReport): number => report.runId)
      .sort((a: number, b: number): number => a - b);
    found.push(condition("audit:runs", { ids, hash: runHash, unlined: runReport.unlined }, facts));
  }
  // Reconciliation's record is one chain, so there is no first timeline to name.
  if (ledger.recon().hasTables()) {
    const recon: ReconChainReport = reconChainReport(ledger.recon().auditSnapshot());
    if (!recon.intact) {
      const reconHash: AuditAlertFacts["runningHash"] = runningHash(recon);
      const facts: AuditAlertFacts = {
        kind: "audit",
        scope: "recon",
        broken: recon.breaks.length > 0 || recon.lostStart !== null ? 1 : 0,
        first: null,
        line: recon.breaks[0]?.line ?? null,
        runningHash: reconHash,
        withoutLine: recon.unlined.length,
      };
      const lines: number[] = recon.breaks.map((item: ChainBreak): number => item.line);
      found.push(
        condition("audit:recon", { lines, lostStart: recon.lostStart, hash: reconHash, unlined: recon.unlined }, facts),
      );
    }
  }
  return found;
}

function cashConditions(report: CashReport): FoundCondition[] {
  return report.currencies
    .filter((cash: CurrencyCash): boolean => cash.headroomMinor !== null && cash.headroomMinor < 0)
    .map((cash: CurrencyCash): FoundCondition => {
      const facts: CashAlertFacts = {
        kind: "cash",
        currency: cash.currency,
        headroom: formatMoney(cash.headroomMinor ?? 0, cash.currency),
        floor: cash.floor.minor === null ? null : formatMoney(cash.floor.minor, cash.currency),
        readAt: report.airwallex.readAt,
      };
      return condition(`cash:${cash.currency}`, "below", facts);
    });
}

// An outage alerts once when it is declared and once when a person ends it: the
// fingerprint is its state. An ended one stays a condition for a day, so its end
// alert is not taken for a condition that cleared, and then clears with nothing
// posted.
function outageConditions(ledger: Ledger, now: number): FoundCondition[] {
  return ledger
    .outages()
    .filter(
      (outage: Outage): boolean =>
        outage.state === "active" ||
        (outage.endedAt !== null && now - Date.parse(outage.endedAt) < ENDED_OUTAGE_SHOWN_MS),
    )
    .map((outage: Outage): FoundCondition => {
      const facts: OutageAlertFacts = {
        kind: "outage",
        outage: outage.id,
        currency: outage.currency,
        method: outage.method,
        state: outage.state,
        codes: outage.codes,
        payees: outage.payees,
        windowMinutes: outage.windowMinutes,
        references: outage.counted
          .map((transferId: string): string | undefined => ledger.railFailure(transferId)?.reference)
          .filter((reference: string | undefined): reference is string => reference !== undefined)
          .slice(0, OUTAGE_REFERENCES_SHOWN),
        declaredAt: outage.declaredAt,
        endedAt: outage.endedAt,
        // As the Outages card counts them: an invoice whose failure was only
        // counted is not held.
        held: ledger.outageHolds(outage.id).filter((hold: OutageHold): boolean => hold.what !== "counted").length,
      };
      return condition(`outage:${outage.id}`, { state: outage.state }, facts);
    });
}

// A supplier record's phone: while a new number two people have not yet put on
// file waits, and for a day after two people put one on file, with which it is
// as the fingerprint, so each posts once. A number the demo scenario or an older
// invoice put there is no news. Never the number or a name.
function contactConditions(ledger: Ledger, now: number): FoundCondition[] {
  const byRecord: Map<string, Contact[]> = new Map<string, Contact[]>();
  for (const contact of ledger.contactsOf(null)) {
    if (contact.field === "phone") {
      byRecord.set(contact.beneficiaryId, [...(byRecord.get(contact.beneficiaryId) ?? []), contact]);
    }
  }
  const found: FoundCondition[] = [];
  for (const [beneficiaryId, contacts] of byRecord) {
    const proposal: Contact | undefined = contacts.find((contact: Contact): boolean => waiting(contact, now));
    const onFile: Contact | undefined = contacts.find(
      (contact: Contact): boolean =>
        contact.state === "on_file" &&
        contact.origin === "person" &&
        contact.confirmedAt !== null &&
        now - Date.parse(contact.confirmedAt) < CONTACT_SHOWN_MS,
    );
    const row: Contact | undefined = proposal ?? onFile;
    if (row === undefined) {
      continue;
    }
    const replaced: Contact | undefined = contacts.find((contact: Contact): boolean => contact.id === row.replacesId);
    const change: ContactAlertFacts["change"] =
      row.value === "" ? "removal" : replaced === undefined || replaced.value === "" ? "first" : "change";
    const state: ContactAlertFacts["state"] = proposal !== undefined ? "waiting" : change === "first" ? "set" : "changed";
    const invoices: Obligation[] = ledger.obligationsFor(beneficiaryId);
    const facts: ContactAlertFacts = {
      kind: "contact",
      supplierKey: BENEFICIARY_ID_PATTERN.test(beneficiaryId) ? beneficiaryId : null,
      supplier: invoices[0]?.supplier ?? "",
      field: "phone",
      state,
      change,
      at: (proposal === undefined ? row.confirmedAt : row.proposedAt) ?? row.proposedAt,
      openInvoices: invoices.filter(
        (obligation: Obligation): boolean => obligation.state === "open" || obligation.state === "escalated",
      ).length,
      withdrawn: row.withdrawnRequests,
    };
    found.push(condition(`contact:${beneficiaryId}`, `${state}:${row.id}`, facts));
  }
  return found;
}

// Emails waiting in the inbox, by count only. The fingerprint is the newest
// upload in any state, so a new upload alerts again and a delivery or a dismissal
// does not.
function inboxCondition(inbox: InboxWaiting): FoundCondition | null {
  if (inbox.waiting === 0) {
    return null;
  }
  const facts: InboxAlertFacts = { kind: "inbox", waiting: inbox.waiting };
  return condition(INBOX_KEY, { newest: inbox.newest }, facts);
}

// Reconciliation's breaks that wait on a person, as one condition. Its
// fingerprint is the newest line saying a break is new or has new facts, in any
// state, so a new or changed break alerts and one clearing or explained does not.
function reconCondition(state: ReconAlertState): FoundCondition | null {
  const newest: ReconBreak | undefined = state.newestOpen;
  if (newest === undefined) {
    return null;
  }
  let reference: string | null;
  try {
    reference = shownReference((JSON.parse(newest.facts) as { reference?: unknown }).reference);
  } catch {
    reference = null;
  }
  const facts: ReconAlertFacts = {
    kind: "recon",
    open: state.open,
    kinds: state.kinds.map((entry: KindTotal): { kind: string; count: number } => ({
      kind: entry.kind,
      count: entry.count,
    })),
    currencies: state.currencies
      .map((code: string): string | null => shownCurrency(code))
      .filter((code: string | null): code is string => code !== null),
    newestKind: newest.kind,
    newestCurrency: shownCurrency(newest.currency),
    newestInvoice: shownInvoice(newest.invoiceId),
    newestReference: reference,
  };
  return condition(RECON_KEY, { newest: state.newest }, facts);
}

function summaryOf(found: FoundCondition[], inbox: InboxWaiting, recon: number): FoundCondition {
  const count = (kind: string): number => found.filter((item: FoundCondition): boolean => item.kind === kind).length;
  const active: string = hashOf({ state: "active" });
  const facts: SummaryAlertFacts = {
    kind: "summary",
    invoices: count("invoice"),
    runs: count("run"),
    audit: count("audit"),
    cash: count("cash"),
    inbox: inbox.waiting,
    outages: found.filter((item: FoundCondition): boolean => item.kind === "outage" && item.fingerprint === active)
      .length,
    recon,
  };
  return condition(SUMMARY_KEY, "first", facts);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The address, its path and its query never reach a log line or the ledger. Each
// is cut as redactKey cuts a key: URL-encoded, in either case, cut short, or with
// spaces or line breaks between its characters.
function redact(text: string, url: URL): string {
  return redactKeys(
    text,
    [url.href, `${url.origin}${url.pathname}`, url.pathname, url.search].filter((part: string): boolean => part.length > 1),
    "[webhook]",
  );
}

interface Answer {
  status: number | null;
  retryAfterMs: number | null;
  error: string;
}

// The status and a short code: Slack's lower-case code or Discord's numeric one.
// Nothing else from the answer is kept, not even Discord's message, because
// PayOnce cannot rule out that an answer repeats part of the address.
function errorOf(status: number, body: string): string {
  if (/^[a-z_]{1,40}$/.test(body.trim())) {
    return `${status} ${body.trim()}`;
  }
  try {
    const parsedBody: unknown = JSON.parse(body);
    if (typeof parsedBody === "object" && parsedBody !== null) {
      const code: unknown = (parsedBody as Record<string, unknown>)["code"];
      return Number.isSafeInteger(code) ? `${status} ${String(code)}` : String(status);
    }
  } catch {
    // Not JSON, so only the status is kept.
  }
  return String(status);
}

function retryAfterOf(response: Response, body: string): number | null {
  const header: number = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) {
    return header * 1_000;
  }
  try {
    const seconds: unknown = (JSON.parse(body) as Record<string, unknown>)["retry_after"];
    return typeof seconds === "number" && seconds > 0 ? seconds * 1_000 : null;
  } catch {
    return null;
  }
}

// One POST of the JSON and nothing else: no redirects followed, no other header,
// and never the Airwallex client, so no Airwallex token can ride along.
async function post(target: AlertTarget, payload: unknown): Promise<Answer> {
  const url: URL = new URL(target.url.href);
  if (target.format === "discord") {
    url.searchParams.set("wait", "true");
  }
  try {
    const response: Response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    const body: string = (await response.text()).slice(0, 2_000);
    return {
      status: response.status,
      retryAfterMs: response.status === 429 ? retryAfterOf(response, body) : null,
      error: redact(errorOf(response.status, body), target.url),
    };
  } catch (error: unknown) {
    return { status: null, retryAfterMs: null, error: redact(messageOf(error), target.url) };
  }
}

function backoff(tries: number): number {
  return FIRST_BACKOFF_MS * 4 ** (tries - 1);
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// The cash panel's report, null while no balance has been read, or "reading"
// while no balance has been read and a read is running.
export type AlertCash = CashReport | null | "reading";

export interface AlertsStatus {
  on: boolean;
  format: AlertFormat | null;
  host: string | null;
  test: boolean;
  problem: string | null;
  stopped: string | null;
}

// The situations of the invoices named, as the views load them, at now.
export type SnapshotsOf = (invoiceIds: string[], now: number) => InvoiceSnapshot[];

// Works out what needs a person from the ledger, records it, and posts the
// alerts that are due. Only pnpm ui runs it. The CLI only writes the ledger, and
// the server's next check sees what it did.
export class Alerts {
  private readonly ledger: Ledger;
  private readonly snapshots: SnapshotsOf;
  private readonly target: AlertTarget;
  private readonly base: string;
  private readonly cash: () => AlertCash;
  private readonly holder: string = randomUUID();
  private running: boolean = false;
  private evaluated: boolean = false;
  private stopped: string | null = null;
  private auditAt: number = Number.NEGATIVE_INFINITY;
  private audit: FoundCondition[] = [];
  private timer: NodeJS.Timeout | null = null;

  // snapshots loads the situations of the invoices with a person. base is the
  // local page the links point to. cash is the panel's report.
  constructor(ledger: Ledger, snapshots: SnapshotsOf, target: AlertTarget, base: string, cash: () => AlertCash) {
    this.ledger = ledger;
    this.snapshots = snapshots;
    this.target = target;
    this.base = base;
    this.cash = cash;
  }

  start(): void {
    this.timer ??= setInterval((): void => {
      void this.tick();
    }, CHECK_EVERY_MS);
  }

  status(): AlertsStatus {
    return {
      on: true,
      format: this.target.format,
      host: this.target.host,
      test: this.target.test,
      problem: null,
      stopped: this.stopped,
    };
  }

  // Skips a tick while the last one is still posting. The first evaluation waits
  // for the start-up balance read to finish, good or failed, so a currency
  // already below 0 when alerts are first turned on joins the summary instead of
  // getting an alert of its own.
  async tick(now: number = Date.now()): Promise<void> {
    if (this.running || (!this.evaluated && this.cash() === "reading")) {
      return;
    }
    this.running = true;
    try {
      this.evaluate(now);
      if (this.stopped === null) {
        await this.flush();
      }
    } catch (error: unknown) {
      sayWarning(`  alert    ${redact(messageOf(error), this.target.url)}`);
    } finally {
      this.running = false;
    }
  }

  evaluate(now: number = Date.now()): RecordedConditions {
    if (now - this.auditAt >= AUDIT_EVERY_MS) {
      this.audit = auditConditions(this.ledger);
      this.auditAt = now;
    }
    const found: FoundCondition[] = [];
    const obligations: Obligation[] = this.ledger.obligations();
    // Only an invoice with a person can need one, so only those are read whole.
    const snapshots: Map<string, InvoiceSnapshot> = new Map(
      this.snapshots(
        obligations
          .filter((obligation: Obligation): boolean => obligation.state === "escalated")
          .map((obligation: Obligation): string => obligation.invoiceId),
        now,
      ).map((snapshot: InvoiceSnapshot): [string, InvoiceSnapshot] => [snapshot.obligation.invoiceId, snapshot]),
    );
    for (const obligation of obligations) {
      const snapshot: InvoiceSnapshot | undefined = snapshots.get(obligation.invoiceId);
      const invoice: FoundCondition | null = snapshot === undefined ? null : invoiceCondition(snapshot, now);
      if (invoice !== null) {
        found.push(invoice);
      }
      found.push(...payoutConditions(this.ledger, obligation));
    }
    for (const run of this.ledger.runs()) {
      const waiting: FoundCondition | null = runCondition(this.ledger, run);
      if (waiting !== null) {
        found.push(waiting);
      }
    }
    const inbox: InboxWaiting = this.ledger.inboxWaiting();
    const emails: FoundCondition | null = inboxCondition(inbox);
    if (emails !== null) {
      found.push(emails);
    }
    found.push(...outageConditions(this.ledger, now));
    found.push(...contactConditions(this.ledger, now));
    const recon: ReconAlertState = this.ledger.recon().alertState();
    const wallet: FoundCondition | null = reconCondition(recon);
    if (wallet !== null) {
      found.push(wallet);
    }
    found.push(...this.audit);
    // Before the first balance read the cash is not known, so a standing cash
    // condition is neither found nor cleared.
    const cash: AlertCash = this.cash();
    const report: CashReport | null = cash === "reading" ? null : cash;
    this.evaluated = true;
    if (report !== null) {
      found.push(...cashConditions(report));
    }
    const recorded: RecordedConditions = this.ledger.recordConditions(
      found,
      summaryOf(found, inbox, recon.open),
      now,
      SETTLE_MS,
      CLEAR_AFTER_MS,
      report === null ? ["cash:"] : [],
    );
    if (recorded.first) {
      say(
        recorded.standing === 0
          ? "  alert    Alerts on: nothing is waiting on a person, so no summary is queued"
          : `  alert    Alerts on: ${recorded.standing} ${recorded.standing === 1 ? "condition" : "conditions"} already standing recorded without an alert each, and one summary queued`,
      );
    }
    return recorded;
  }

  // Posts up to four due alerts, a little over a second apart.
  async flush(): Promise<void> {
    for (let posted: number = 0; posted < POSTS_PER_FLUSH && this.stopped === null; posted += 1) {
      const alert: Alert | undefined = this.ledger.claimAlert(this.holder, Date.now(), CLAIM_MS);
      if (alert === undefined) {
        return;
      }
      if (posted > 0) {
        await wait(POST_GAP_MS);
      }
      await this.send(alert);
    }
  }

  private finish(alert: Alert, finish: AlertFinish): void {
    this.ledger.finishAlert(alert.id, this.holder, finish);
  }

  private async send(alert: Alert): Promise<void> {
    if (alert.kind !== "summary" && this.ledger.skipStaleAlert(alert.id, this.holder)) {
      return;
    }
    const facts: AlertFacts = JSON.parse(alert.facts) as AlertFacts;
    const title: string = alertMessage(facts, this.base).title;
    const answer: Answer = await post(
      this.target,
      payloadFor(this.target.format, alertMessage(facts, this.base), alert.createdAt),
    );
    const tries: number = alert.tries + 1;
    const status: number | null = answer.status;
    const error: string = answer.error.replace(/[.\s]+$/, "");
    if (status !== null && status >= 200 && status < 300) {
      this.finish(alert, { state: "sent", tried: true, nextTryAt: null, error: null });
      say(`  alert    sent: ${title}`);
      return;
    }
    const retry: boolean = status === null || status === 429 || status >= 500;
    if (retry && tries < MAX_TRIES) {
      const delay: number =
        status === 429
          ? Math.min(Math.max(answer.retryAfterMs ?? backoff(tries), 1_000), MAX_RETRY_AFTER_MS)
          : backoff(tries);
      this.finish(alert, { state: "queued", tried: true, nextTryAt: Date.now() + delay, error: answer.error });
      sayWarning(`  alert    ${title}: ${error}. Trying again in ${Math.round(delay / 1_000)} seconds`);
      return;
    }
    this.finish(alert, { state: "failed", tried: true, nextTryAt: null, error: answer.error });
    if (status !== null && GONE.includes(status)) {
      this.stopped = `the webhook answered ${status}, so the address is wrong or the webhook was removed`;
      sayWarning(
        `  alert    Alerts stopped: ${this.stopped}. Fix ALERT_WEBHOOK_URL and restart; alerts still queued are sent then if they still apply`,
      );
      return;
    }
    sayWarning(
      `  alert    ${title} was not sent: ${error}${retry ? `, after ${tries} tries` : ""}. PayOnce does not try it again`,
    );
  }
}

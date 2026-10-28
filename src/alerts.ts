import { createHash, randomUUID } from "node:crypto";
import {
  alertMessage,
  payloadFor,
  type AlertFacts,
  type AlertFormat,
  type AuditAlertFacts,
  type CashAlertFacts,
  type InboxAlertFacts,
  type InvoiceAlertFacts,
  type InvoiceNeed,
  type PayoutAlertFacts,
  type RunAlertFacts,
  type SummaryAlertFacts,
} from "./alert-payloads.js";
import type { ApprovalTerms, RunTerms, RunTotal } from "./approval.js";
import {
  chainReports,
  ledgerReport,
  runChainReports,
  runLedgerReport,
  type AuditSnapshot,
  type ChainBreak,
  type ChainReport,
  type LedgerReport,
  type RunAuditSnapshot,
  type RunChainReport,
  type RunLedgerReport,
} from "./audit-trail.js";
import type { CashReport, CurrencyCash } from "./cash-position.js";
import {
  BELOW_FLOOR_REASON,
  CHANGED_BANK_DETAILS_REASON,
  NEW_BANK_DETAILS_REASON,
  NO_FLOOR_CLAUSE,
  ORIGINAL_DEADLINE_REASON,
  OUTSIDE_PAYOUT_REASON,
  UNREADABLE_CASH_REASON,
} from "./decide.js";
import {
  pendingApproval,
  pendingClose,
  REPLACEMENT_DEADLINE_REASON,
  type CloseReview,
  type PendingApproval,
} from "./engine.js";
import {
  isExpired,
  type Alert,
  type AlertFinish,
  type Approval,
  type Attempt,
  type FoundCondition,
  type InboxWaiting,
  type Ledger,
  type Obligation,
  type OutsidePayout,
  type RecordedConditions,
  type Run,
  type RunApproval,
} from "./ledger.js";
import { formatMoney } from "./money.js";
import { runStatus } from "./runs.js";

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

const SUMMARY_KEY: string = "summary";
const INBOX_KEY: string = "inbox";
const SLACK_HOSTS: readonly string[] = ["hooks.slack.com"];
const DISCORD_HOSTS: readonly string[] = ["discord.com", "discordapp.com"];
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];
const DEADLINE_REASONS: readonly string[] = [ORIGINAL_DEADLINE_REASON, REPLACEMENT_DEADLINE_REASON];
const BANK_DETAILS_REASONS: readonly string[] = [NEW_BANK_DETAILS_REASON, CHANGED_BANK_DETAILS_REASON];
const FLOOR_CLAUSES: readonly string[] = [BELOW_FLOOR_REASON, UNREADABLE_CASH_REASON, NO_FLOOR_CLAUSE];
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

// target is null when alerts are off: no setting, or one PayOnce refused, which
// problem says without repeating the value.
export interface AlertSetting {
  target: AlertTarget | null;
  problem: string | null;
}

function parsed(raw: string): URL | null {
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
export function alertTargetFromEnv(env: NodeJS.ProcessEnv = process.env): AlertSetting {
  const off = (problem: string): AlertSetting => ({ target: null, problem });
  const format: string = (env["ALERT_FORMAT"] ?? "").trim().toLowerCase() || "slack";
  if (format !== "slack" && format !== "discord") {
    return off("ALERT_FORMAT is slack or discord");
  }
  const testRaw: string = (env["ALERT_TEST_RECEIVER_URL"] ?? "").trim();
  if (testRaw !== "") {
    const url: URL | null = parsed(testRaw);
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
  const url: URL | null = parsed(raw);
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

// The reason without a floor clause the agent adds or drops as the balance moves,
// so the floor alone does not alert an invoice again.
export function baseReason(reason: string): string {
  for (const clause of FLOOR_CLAUSES) {
    const suffix: string = `, and ${clause}`;
    const at: number = reason.indexOf(suffix);
    if (at > 0) {
      return reason.slice(0, at) + reason.slice(at + suffix.length);
    }
  }
  return reason;
}

function needOf(
  obligation: Obligation,
  base: string,
  pending: PendingApproval | undefined,
  review: CloseReview | undefined,
): InvoiceNeed {
  if (pending !== undefined) {
    return pending.terms.action === "pay" ? "approve-held" : "approve";
  }
  if (review !== undefined) {
    return review.kind === "duplicate" || review.kind === "unpaid" ? "held" : "close";
  }
  if (DEADLINE_REASONS.includes(base)) {
    return "bank";
  }
  if (base.startsWith(OUTSIDE_PAYOUT_REASON)) {
    return "outside";
  }
  return BANK_DETAILS_REASONS.includes(base) && obligation.supplierPhone !== null ? "callback" : "check";
}

// True when a person already approved and the agent is using it: the approval is
// approved and not expired, or used with its payment still with the bank.
function approvedAndUnderway(ledger: Ledger, invoiceId: string): boolean {
  const latest: Approval | undefined = ledger.latestApproval(invoiceId);
  if (latest?.state === "approved") {
    return !isExpired(latest);
  }
  return (
    latest?.state === "used" &&
    ledger
      .attempts(invoiceId)
      .some(
        (attempt: Attempt): boolean =>
          attempt.approvalId === latest.id && (attempt.state === "pending" || attempt.state === "in_flight"),
      )
  );
}

function invoiceCondition(ledger: Ledger, obligation: Obligation): FoundCondition | null {
  if (obligation.state !== "escalated") {
    return null;
  }
  const invoiceId: string = obligation.invoiceId;
  const pending: PendingApproval | undefined = pendingApproval(ledger, invoiceId);
  const review: CloseReview | undefined = pending === undefined ? pendingClose(ledger, invoiceId) : undefined;
  const base: string = baseReason(obligation.escalationReason);
  const need: InvoiceNeed = needOf(obligation, base, pending, review);
  if (need !== "bank" && pending === undefined && approvedAndUnderway(ledger, invoiceId)) {
    return null;
  }
  const terms: ApprovalTerms | undefined = pending?.terms;
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
  // A request renewed on the same terms is the same need. The fingerprint never
  // leaves the ledger.
  const request: unknown =
    terms === undefined
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

function runningHash(report: LedgerReport | RunLedgerReport): AuditAlertFacts["runningHash"] {
  return report.intact ? "matches" : report.stored === null ? "missing" : "does not match";
}

// Every invoice and pay run timeline, and both running hashes. This reads every
// line, so the server runs it once a minute.
function auditConditions(ledger: Ledger): FoundCondition[] {
  const found: FoundCondition[] = [];
  const invoices: AuditSnapshot = ledger.auditSnapshot(null);
  const brokenInvoices: ChainReport[] = chainReports(invoices.events).filter(
    (report: ChainReport): boolean => report.breaks.length > 0,
  );
  const invoiceHash: AuditAlertFacts["runningHash"] = runningHash(ledgerReport(invoices));
  if (brokenInvoices.length > 0 || invoiceHash !== "matches") {
    const first: ChainBreak | undefined = brokenInvoices[0]?.breaks[0];
    const facts: AuditAlertFacts = {
      kind: "audit",
      scope: "invoices",
      broken: brokenInvoices.length,
      first: brokenInvoices[0]?.invoiceId ?? null,
      line: first?.line ?? null,
      runningHash: invoiceHash,
    };
    const ids: string[] = brokenInvoices.map((report: ChainReport): string => report.invoiceId).sort();
    found.push(condition("audit:invoices", { ids, hash: invoiceHash }, facts));
  }
  const runs: RunAuditSnapshot = ledger.runAuditSnapshot(null);
  const brokenRuns: RunChainReport[] = runChainReports(runs.events).filter(
    (report: RunChainReport): boolean => report.breaks.length > 0,
  );
  const runHash: AuditAlertFacts["runningHash"] = runningHash(runLedgerReport(runs));
  if (brokenRuns.length > 0 || runHash !== "matches") {
    const first: ChainBreak | undefined = brokenRuns[0]?.breaks[0];
    const facts: AuditAlertFacts = {
      kind: "audit",
      scope: "runs",
      broken: brokenRuns.length,
      first: brokenRuns[0] === undefined ? null : String(brokenRuns[0].runId),
      line: first?.line ?? null,
      runningHash: runHash,
    };
    const ids: number[] = brokenRuns
      .map((report: RunChainReport): number => report.runId)
      .sort((a: number, b: number): number => a - b);
    found.push(condition("audit:runs", { ids, hash: runHash }, facts));
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

function summaryOf(found: FoundCondition[], inbox: InboxWaiting): FoundCondition {
  const count = (kind: string): number => found.filter((item: FoundCondition): boolean => item.kind === kind).length;
  const facts: SummaryAlertFacts = {
    kind: "summary",
    invoices: count("invoice"),
    runs: count("run"),
    audit: count("audit"),
    cash: count("cash"),
    inbox: inbox.waiting,
  };
  return condition(SUMMARY_KEY, "first", facts);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The address, its path and its query never reach a log line or the ledger.
function redact(text: string, url: URL): string {
  let out: string = text;
  for (const part of [url.href, `${url.origin}${url.pathname}`, url.pathname, url.search]) {
    if (part.length > 1) {
      out = out.split(part).join("[webhook]");
    }
  }
  return out;
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

// Works out what needs a person from the ledger, records it, and posts the
// alerts that are due. Only pnpm ui runs it. The CLI only writes the ledger, and
// the server's next check sees what it did.
export class Alerts {
  private readonly ledger: Ledger;
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

  // base is the local page the links point to. cash is the panel's report.
  constructor(ledger: Ledger, target: AlertTarget, base: string, cash: () => AlertCash) {
    this.ledger = ledger;
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
      console.warn(`  alert    ${redact(messageOf(error), this.target.url)}`);
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
    for (const obligation of this.ledger.obligations()) {
      const invoice: FoundCondition | null = invoiceCondition(this.ledger, obligation);
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
      summaryOf(found, inbox),
      now,
      SETTLE_MS,
      CLEAR_AFTER_MS,
      report === null ? ["cash:"] : [],
    );
    if (recorded.first) {
      console.log(
        `  alert    Alerts on: ${recorded.standing} ${recorded.standing === 1 ? "condition" : "conditions"} already standing recorded without an alert each, and one summary queued`,
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
      console.log(`  alert    sent: ${title}`);
      return;
    }
    const retry: boolean = status === null || status === 429 || status >= 500;
    if (retry && tries < MAX_TRIES) {
      const delay: number =
        status === 429
          ? Math.min(Math.max(answer.retryAfterMs ?? backoff(tries), 1_000), MAX_RETRY_AFTER_MS)
          : backoff(tries);
      this.finish(alert, { state: "queued", tried: true, nextTryAt: Date.now() + delay, error: answer.error });
      console.warn(`  alert    ${title}: ${error}. Trying again in ${Math.round(delay / 1_000)} seconds`);
      return;
    }
    this.finish(alert, { state: "failed", tried: true, nextTryAt: null, error: answer.error });
    if (status !== null && GONE.includes(status)) {
      this.stopped = `the webhook answered ${status}, so the address is wrong or the webhook was removed`;
      console.warn(
        `  alert    Alerts stopped: ${this.stopped}. Fix ALERT_WEBHOOK_URL and restart; alerts still queued are sent then if they still apply`,
      );
      return;
    }
    console.warn(
      `  alert    ${title} was not sent: ${error}${retry ? `, after ${tries} tries` : ""}. PayOnce does not try it again`,
    );
  }
}

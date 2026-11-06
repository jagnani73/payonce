import type { Balance, BalanceState } from "../airwallex/balances.js";
import type { ApprovalTerms, BankChangeEvidence, RunRowTerms, RunTerms } from "../domain/approval.js";
import { policyFromEnv, type Barred } from "../domain/approvers.js";
import { arrivalAdvice, feeSeenText, ROUTES, type ArrivalAdvice, type ArrivalTerms } from "../domain/arrival.js";
import {
  chainReport,
  chainReports,
  describeBreaks,
  describeLedger,
  describeRunLedger,
  ledgerReport,
  runChainReport,
  runChainReports,
  runLedgerReport,
  type AuditSnapshot,
  type ChainReport,
  type LedgerReport,
  type RunAuditSnapshot,
  type RunChainReport,
  type RunLedgerReport,
} from "../store/audit-trail.js";
import { cashReport, payRunLines, type CashReport } from "../engine/cash-position.js";
import { summarise, unverifiedSenders, type EmailFindings, type SupplierEmail } from "../reader/emails.js";
import { pendingApproval, pendingClose } from "../engine/engine.js";
import { boardGroups, outageHolding, type BoardGroupOf } from "./incident-board.js";
import {
  isExpired,
  readingSoft,
  type Approval,
  type Attempt,
  type Ledger,
  type LedgerEvent,
  type Obligation,
  type ObligationState,
  type Outage,
  type Run,
  type RunApproval,
  type RunRow,
  type Signoff,
} from "../store/ledger.js";
import { COUNTRY_CODE, lastFour, SERVER_FLOORS_UNREADABLE } from "../surfaces/mcp/mcp-text.js";
import { outagesReport, outageView, type OutagesReport } from "../outages/outages.js";
import type { ReservePolicy } from "../domain/reserve.js";
import { currentSettings } from "../settings.js";
import {
  domainChecks,
  domainText,
  largestTotal,
  runBarred,
  runCounts,
  runStatus,
  type DomainCheck,
  type RunCash,
} from "../runs/runs.js";
import { resolveSupplier, supplierDetail, supplierList, type Resolved, type SupplierDetail } from "./suppliers.js";
import { CURRENCY_PATTERN, TRANSFER_METHODS } from "../domain/patterns.js";
import { capitalise } from "../text/printable.js";

// What the read-only MCP server answers, built from the ledger alone. The shapes
// follow the JSON API's, without the server's busy and watching, and with the
// text of supplier emails, the phone number on file and message drafts left out.

// A tool's answer in PayOnce's words when there is nothing to show, such as an
// invoice that is not in the ledger.
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefusal";
  }
}

export const NOT_CHAINED: string =
  "This ledger's timelines are not a hash chain yet. The next pnpm ui or other command that opens it starts the chain";
const RUNS_NOT_CHAINED: string =
  "This ledger's pay run timelines are not a hash chain yet. The next pnpm ui or other command that opens it starts the chain";
const DAY: RegExp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const BALANCE_MAX_AGE_MS: number = 30_000;

const NO_BALANCES: BalanceState = {
  readAt: null,
  balances: [],
  refreshing: false,
  error: null,
  maxAgeMs: BALANCE_MAX_AGE_MS,
};

interface Timeline {
  total: number;
  shown: number;
  lines: LedgerEvent[];
}

interface AuditSummary {
  lines: number;
  problem: string | null;
}

function isDay(value: unknown): boolean {
  return typeof value === "string" && DAY.test(value);
}

function isDayCount(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

// A stored estimate the advice can be built from: a method, a route PayOnce
// knows or none, and days and day counts in PayOnce's own forms. Null for
// anything else, so the advice never repeats text PayOnce did not write there.
// The country comes from the beneficiary record in Airwallex, so one that is not
// two capital letters is left out instead. The terms still show the estimate,
// wrapped where it does not fit.
function vouchedArrival(arrival: ArrivalTerms): ArrivalTerms | null {
  const fits: boolean =
    TRANSFER_METHODS.includes(arrival.method) &&
    (arrival.route === null || ROUTES.includes(arrival.route)) &&
    isDay(arrival.from) &&
    [arrival.earliest, arrival.latest, arrival.dueDate].every(
      (day: string | null): boolean => day === null || isDay(day),
    ) &&
    isDayCount(arrival.minDays) &&
    isDayCount(arrival.maxDays);
  if (!fits) {
    return null;
  }
  return arrival.country === null || COUNTRY_CODE.test(arrival.country) ? arrival : { ...arrival, country: null };
}

// The advice for an estimate, which is PayOnce's own sentence, or null when the
// estimate is not in PayOnce's own forms. "If sent today" says when a payment
// that can still be approved and sent would arrive, so, as the server's
// adviceFor gives it, a used, void or expired request and a run that no longer
// waits have none.
function adviceOf(arrival: ArrivalTerms, live: boolean): ArrivalAdvice | null {
  const vouched: ArrivalTerms | null = vouchedArrival(arrival);
  if (vouched === null) {
    return null;
  }
  const advice: ArrivalAdvice = arrivalAdvice(vouched);
  return live ? advice : { ...advice, sentToday: null };
}

function isLive(approval: Approval | RunApproval): boolean {
  return (approval.state === "requested" || approval.state === "approved") && !isExpired(approval);
}

// The newest lines, oldest first.
function timelineOf(events: LedgerEvent[], lines: number): Timeline {
  const shown: LedgerEvent[] = events.slice(-lines);
  return { total: events.length, shown: shown.length, lines: shown };
}

function capitalised(problem: string | null): string | null {
  return problem === null ? null : capitalise(problem);
}

// The line under an incident's timeline on the page: its length and the first
// break, or a running hash that is missing or does not match.
function auditSummary(ledger: Ledger, invoiceId: string): AuditSummary {
  const snapshot: AuditSnapshot = ledger.auditSnapshot(invoiceId);
  const report: ChainReport = chainReport(invoiceId, snapshot.events);
  const whole: LedgerReport = ledgerReport(snapshot);
  return {
    lines: report.lines,
    problem: capitalised(describeBreaks(report.breaks) ?? (whole.intact ? null : describeLedger(whole))),
  };
}

function runAuditSummary(ledger: Ledger, runId: number): AuditSummary {
  const snapshot: RunAuditSnapshot = ledger.runAuditSnapshot(runId);
  const report: RunChainReport = runChainReport(runId, snapshot.events);
  const whole: RunLedgerReport = runLedgerReport(snapshot);
  return {
    lines: report.lines,
    problem: capitalised(describeBreaks(report.breaks) ?? (whole.intact ? null : describeRunLedger(whole))),
  };
}

// Each invoice's headline follows the incident list's rule: the board's fixed
// reason for an invoice on the board, and otherwise its latest decision, close or
// standing line (Ledger.headlines), never an error, an email or a message draft.
// A view, so it reads stored JSON soft.
export function incidentsView(ledger: Ledger, state: ObligationState | null, limit: number): unknown {
  return readingSoft((): unknown => incidentsOf(ledger, state, limit));
}

function incidentsOf(ledger: Ledger, state: ObligationState | null, limit: number): unknown {
  const groups: Map<string, BoardGroupOf> = boardGroups(ledger);
  const headlines: Map<string, string> = ledger.headlines();
  const all: Obligation[] = ledger
    .obligations()
    .filter((obligation: Obligation): boolean => state === null || obligation.state === state);
  const shown: Obligation[] = all.slice(0, limit);
  return {
    total: all.length,
    shown: shown.length,
    incidents: shown.map((obligation: Obligation) => ({
      invoiceId: obligation.invoiceId,
      supplier: obligation.supplier,
      currency: obligation.currency,
      sourceCurrency: obligation.sourceCurrency,
      amountMinor: obligation.amountMinor,
      state: obligation.state,
      origin: obligation.origin,
      headline: groups.get(obligation.invoiceId)?.why ?? headlines.get(obligation.invoiceId) ?? "",
      runId: ledger.runRowOf(obligation.invoiceId)?.runId ?? null,
      board: groups.get(obligation.invoiceId) ?? null,
    })),
  };
}

// The terms as the approvers saw them, with the number a callback dialled cut to
// its last four digits, in a replacement's terms and a held payment's alike. The
// binding covers the stored terms, so this copy cannot be used to work it out.
function shownTerms(terms: ApprovalTerms): unknown {
  // Stored terms are read as they are, so terms with no evidence show as stored.
  const bankChange: BankChangeEvidence | null | undefined = (
    terms.evidence as ApprovalTerms["evidence"] | undefined
  )?.bankChange;
  if (bankChange === null || bankChange === undefined) {
    return terms;
  }
  const { numberCalled, ...rest }: BankChangeEvidence = bankChange;
  return {
    ...terms,
    evidence: { ...terms.evidence, bankChange: { ...rest, numberCalledLast4: lastFour(numberCalled) } },
  };
}

// What PayOnce made of the supplier emails, never their text: how many, how many
// it could not read in full, how many senders the check flags, and the findings
// with the summary written again from them.
function emailsOf(ledger: Ledger, obligation: Obligation): unknown {
  const emails: SupplierEmail[] = ledger.emails(obligation.invoiceId);
  const stored: string | undefined = ledger.findings(obligation.invoiceId);
  const findings: (EmailFindings & { unread?: boolean; emailsRead?: number }) | null =
    stored === undefined ? null : (JSON.parse(stored) as EmailFindings & { unread?: boolean; emailsRead?: number });
  return {
    count: emails.length,
    partlyUnread: emails.filter((email: SupplierEmail): boolean => email.partial === true).length,
    sendersFlagged: unverifiedSenders(emails, obligation.supplierDomain).length,
    findings:
      findings === null
        ? null
        : {
            claimsNonReceipt: findings.claimsNonReceipt === true,
            asksForNewBankDetails: findings.asksForNewBankDetails === true,
            asksNotToPay: findings.asksNotToPay === true,
            summary: summarise(
              findings.claimsNonReceipt === true,
              findings.asksForNewBankDetails === true,
              findings.asksNotToPay === true,
            ),
            unread: findings.unread === true,
            emailsRead: findings.emailsRead ?? null,
            readBy: findings.readBy ?? null,
          },
  };
}

export function incidentView(ledger: Ledger, invoiceId: string, lines: number): unknown {
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  if (obligation === undefined) {
    throw new ToolRefusal(`${invoiceId} is not in the ledger`);
  }
  const { supplierPhone, ...shown }: Obligation = obligation;
  const approval: Approval | undefined = ledger.latestApproval(invoiceId);
  const terms: ApprovalTerms | undefined =
    approval === undefined ? undefined : (JSON.parse(approval.terms) as ApprovalTerms);
  // Who may not approve, the same for any request on the invoice.
  const barred: Barred[] = pendingApproval(ledger, invoiceId)?.barred ?? [];
  const row: RunRow | undefined = ledger.runRowOf(invoiceId);
  const outage: Outage | undefined = ledger.activeOutage(obligation.currency, obligation.transferMethod);
  return {
    obligation: { ...shown, phoneOnFile: supplierPhone !== null },
    run: row === undefined ? null : { id: row.runId, line: row.line },
    outage: outage === undefined ? null : outageView(ledger, outage),
    attempts: ledger.attempts(invoiceId),
    outsidePayouts: ledger.outsidePayouts(invoiceId),
    emails: emailsOf(ledger, obligation),
    approval:
      approval === undefined || terms === undefined
        ? null
        : {
            id: approval.id,
            state: approval.state,
            approver: approval.approver,
            terms: shownTerms(terms),
            arrivalAdvice: terms.arrival === undefined ? null : adviceOf(terms.arrival, isLive(approval)),
            needed: approval.needed,
            neededWhy: approval.neededWhy,
            signoffs: approval.signoffs.map((signoff: Signoff) => ({ approver: signoff.approver, at: signoff.at })),
            requestedAt: approval.requestedAt,
            expiresAt: approval.expiresAt,
            expired: isExpired(approval),
            barred,
          },
    review: pendingClose(ledger, invoiceId) ?? null,
    timeline: timelineOf(ledger.events(invoiceId), lines),
    audit: auditSummary(ledger, invoiceId),
  };
}

export function runsView(ledger: Ledger): unknown {
  return {
    runs: ledger.runs().map((run: Run) => ({
      id: run.id,
      fileName: run.fileName,
      uploadedBy: run.uploadedBy,
      uploadedAt: run.uploadedAt,
      state: run.state,
      status: runStatus(ledger, run),
      counts: runCounts(ledger.runRows(run.id)),
    })),
  };
}

// A released row's invoice as the rows card shows it.
function invoiceSummary(ledger: Ledger, invoiceId: string): unknown {
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  return obligation === undefined
    ? null
    : {
        invoiceId,
        state: obligation.state,
        attempts: ledger.attempts(invoiceId).map((attempt: Attempt) => ({
          kind: attempt.kind,
          state: attempt.state,
          reference: attempt.reference,
        })),
      };
}

export function runView(ledger: Ledger, runId: number, lines: number): unknown {
  const run: Run | undefined = ledger.run(runId);
  if (run === undefined) {
    throw new ToolRefusal(`Run ${runId} is not in the ledger`);
  }
  const rows: RunRow[] = ledger.runRows(run.id);
  const approval: RunApproval | undefined = ledger.latestRunApproval(run.id);
  const terms: RunTerms | null = approval === undefined ? null : (JSON.parse(approval.terms) as RunTerms);
  return {
    run: {
      id: run.id,
      fileName: run.fileName,
      fileHash: run.fileHash,
      columns: run.columns,
      uploadedBy: run.uploadedBy,
      uploadedAt: run.uploadedAt,
      state: run.state,
      checkedAt: run.checkedAt,
      releasedAt: run.releasedAt,
      cancelledBy: run.cancelledBy,
      cancelNote: run.cancelNote,
    },
    status: runStatus(ledger, run),
    counts: runCounts(rows),
    // The cells are left out: what the check made of them is all a reader needs.
    rows: rows.map(({ cells, ...row }: RunRow) => {
      const arrival: ArrivalTerms | null = row.arrival === null ? null : vouchedArrival(row.arrival);
      return {
        ...row,
        feeSeen:
          arrival === null || row.currency === null || !CURRENCY_PATTERN.test(row.currency)
            ? null
            : feeSeenText(ledger, row.currency, arrival.method),
        arrivalAdvice: arrival === null ? null : adviceOf(arrival, run.state === "waiting"),
        invoice: row.state === "released" && row.invoiceId !== null ? invoiceSummary(ledger, row.invoiceId) : null,
      };
    }),
    cash: JSON.parse(run.cash) as RunCash[],
    approval:
      approval === undefined || terms === null
        ? null
        : {
            id: approval.id,
            state: approval.state,
            approver: approval.approver,
            terms,
            arrivalAdvice: terms.rows.flatMap((row: RunRowTerms) => {
              const advice: ArrivalAdvice | null =
                row.arrival === undefined ? null : adviceOf(row.arrival, run.state === "waiting" && isLive(approval));
              return advice === null ? [] : [{ line: row.line, invoiceId: row.invoiceId, advice }];
            }),
            needed: approval.needed,
            neededWhy: approval.neededWhy,
            signoffs: approval.signoffs.map((signoff: Signoff) => ({ approver: signoff.approver, at: signoff.at })),
            requestedAt: approval.requestedAt,
            expiresAt: approval.expiresAt,
            expired: isExpired(approval),
            barred: runBarred(ledger, terms),
            largest: largestTotal(terms),
            domains: domainChecks(ledger, terms).map((check: DomainCheck) => ({
              ...check,
              changed: check.caution,
              text: domainText(check),
            })),
          },
    timeline: timelineOf(ledger.runEvents(run.id), lines),
    audit: runAuditSummary(ledger, run.id),
  };
}

// The active outages and those ended lately, as GET /api/outages gives them,
// without the names that may end one: the approver list is not loaded here.
export function outagesView(ledger: Ledger): unknown {
  const { enders, ...report }: OutagesReport = outagesReport(ledger, policyFromEnv({}), outageHolding(ledger));
  return report;
}

// Every supplier record, as GET /api/suppliers gives them. The builder is the
// server's own, so there is no copy to drift.
export function suppliersView(ledger: Ledger): unknown {
  return supplierList(ledger);
}

// One supplier record, by its beneficiary id or by an invoice number, as GET
// /api/suppliers/:key gives it, without the inbox and the drafts, which the MCP
// leaves out everywhere.
export function supplierView(ledger: Ledger, word: string): unknown {
  const resolved: Resolved | null = resolveSupplier(ledger, word);
  const detail: SupplierDetail | null = resolved === null ? null : supplierDetail(ledger, resolved.key);
  if (resolved === null || detail === null) {
    throw new ToolRefusal(`No invoice or pay run row in the ledger names supplier record ${word.slice(0, 20)}`);
  }
  const { inbox, drafts, ...shown }: SupplierDetail = detail;
  return { ...shown, viaInvoice: resolved.viaInvoice };
}

// The cash panel on this ledger. Given what a running server holds, its balances
// and floors are used, so the headroom is the one the page shows; otherwise the
// floors come from RESERVE_FLOORS and there is no balance. A view, so it reads
// stored JSON soft.
export function cashView(ledger: Ledger, cached: CachedBalances | null): CashReport {
  return readingSoft(
    (): CashReport =>
      cashReport({
        ledger,
        reserve: cached?.reserve ?? currentSettings().reserve,
        balances: cached?.balances ?? NO_BALANCES,
        statesCheckedAt: cached?.statesCheckedAt ?? null,
        payRunLines: payRunLines(ledger),
      }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function minorOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function timeOf(value: unknown): number | null {
  const at: number = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
}

export interface CachedBalances {
  balances: BalanceState;
  reserve: ReservePolicy;
  statesCheckedAt: number | null;
}

// GET /api/cash/cached's answer, number by number: the balances and the floors
// the server holds, so the panel is worked out again on this ledger and the
// headroom is the one the page shows. Of its text only the error message is kept,
// as Airwallex's. Null for anything that is not a cash panel.
export function cachedBalances(answer: unknown): CachedBalances | null {
  if (
    !isRecord(answer) ||
    typeof answer["generatedAt"] !== "string" ||
    !Array.isArray(answer["currencies"]) ||
    !isRecord(answer["airwallex"])
  ) {
    return null;
  }
  const airwallex: Record<string, unknown> = answer["airwallex"];
  const balances: Balance[] = [];
  const floors: Map<string, number> = new Map<string, number>();
  for (const entry of answer["currencies"] as unknown[]) {
    const currency: unknown = isRecord(entry) ? entry["currency"] : undefined;
    if (!isRecord(entry) || typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      continue;
    }
    const floor: unknown = entry["floor"];
    const floorMinor: number | null = isRecord(floor) && floor["source"] === "setting" ? minorOf(floor["minor"]) : null;
    if (floorMinor !== null && floorMinor >= 0) {
      floors.set(currency, floorMinor);
    }
    const read: unknown = entry["airwallex"];
    if (isRecord(read)) {
      balances.push({
        currency,
        availableMinor: minorOf(read["availableMinor"]),
        reservedMinor: minorOf(read["reservedMinor"]),
        pendingMinor: minorOf(read["pendingMinor"]),
        prepaymentMinor: minorOf(read["prepaymentMinor"]),
        totalMinor: minorOf(read["totalMinor"]),
      });
    }
  }
  const unreadable: boolean = isRecord(answer["floors"]) && typeof answer["floors"]["problem"] === "string";
  const error: unknown = airwallex["error"];
  const maxAge: unknown = airwallex["maxAgeSeconds"];
  return {
    reserve: unreadable
      ? { floors: new Map<string, number>(), problem: SERVER_FLOORS_UNREADABLE }
      : { floors, problem: null },
    balances: {
      readAt: timeOf(airwallex["readAt"]),
      balances,
      refreshing: airwallex["refreshing"] === true,
      error:
        isRecord(error) && typeof error["message"] === "string"
          ? { message: error["message"], at: timeOf(error["at"]) ?? Date.now() }
          : null,
      maxAgeMs: typeof maxAge === "number" && Number.isFinite(maxAge) ? maxAge * 1000 : BALANCE_MAX_AGE_MS,
    },
    statesCheckedAt: isRecord(answer["ledger"]) ? timeOf(answer["ledger"]["statesCheckedAt"]) : null,
  };
}

export type AuditTarget = { invoiceId: string } | { runId: number } | null;

// The hash chain check pnpm run audit makes, as data. It reports breaks and
// cannot repair them.
export function auditView(ledger: Ledger, target: AuditTarget): unknown {
  if (!ledger.chainStarted()) {
    throw new ToolRefusal(NOT_CHAINED);
  }
  if (target === null) {
    const snapshot: AuditSnapshot = ledger.auditSnapshot(null);
    const reports: ChainReport[] = chainReports(snapshot.events);
    const whole: LedgerReport = ledgerReport(snapshot);
    let intact: boolean = whole.intact && reports.every((report: ChainReport): boolean => report.breaks.length === 0);
    let runs: unknown;
    if (ledger.runChainStarted()) {
      const runSnapshot: RunAuditSnapshot = ledger.runAuditSnapshot(null);
      const runReports: RunChainReport[] = runChainReports(runSnapshot.events);
      const runWhole: RunLedgerReport = runLedgerReport(runSnapshot);
      intact =
        intact && runWhole.intact && runReports.every((report: RunChainReport): boolean => report.breaks.length === 0);
      runs = { started: true, reports: runReports, ledger: runWhole };
    } else {
      const hasLines: boolean = ledger.hasRunLines();
      intact = intact && !hasLines;
      runs = { started: false, hasLines, problem: hasLines ? RUNS_NOT_CHAINED : null };
    }
    return { intact, invoices: { reports, ledger: whole }, runs };
  }
  if ("invoiceId" in target) {
    const snapshot: AuditSnapshot = ledger.auditSnapshot(target.invoiceId);
    if (ledger.obligation(target.invoiceId) === undefined && snapshot.events.length === 0) {
      throw new ToolRefusal(`${target.invoiceId} is not in the ledger`);
    }
    const chain: ChainReport = chainReport(target.invoiceId, snapshot.events);
    const whole: LedgerReport = ledgerReport(snapshot);
    return {
      intact: chain.breaks.length === 0 && whole.intact,
      chain,
      ledger: whole,
      backfilled: backfilledOf(snapshot),
    };
  }
  const run: Run | undefined = ledger.run(target.runId);
  if (run === undefined) {
    throw new ToolRefusal(`Run ${target.runId} is not in the ledger`);
  }
  if (!ledger.runChainStarted()) {
    throw new ToolRefusal(RUNS_NOT_CHAINED);
  }
  const snapshot: RunAuditSnapshot = ledger.runAuditSnapshot(run.id);
  const chain: RunChainReport = runChainReport(run.id, snapshot.events);
  const whole: RunLedgerReport = runLedgerReport(snapshot);
  return {
    intact: chain.breaks.length === 0 && whole.intact,
    chain,
    ledger: whole,
    backfilled: backfilledOf(snapshot),
  };
}

// The lines that were already there when the chain started and were hashed then,
// so the chain vouches for them only from that day.
function backfilledOf(snapshot: {
  events: { id: number }[];
  backfilledThrough: number;
  chainStartedAt: string | null;
}): { lines: number; chainStartedAt: string | null } {
  return {
    lines: snapshot.events.filter((event: { id: number }): boolean => event.id <= snapshot.backfilledThrough).length,
    chainStartedAt: snapshot.chainStartedAt,
  };
}

import {
  paymentAmount,
  runAmount,
  type ApprovalTerms,
  type BankChangeEvidence,
  type DuplicateEvidence,
  type FxTerms,
  type PaymentAmount,
  type RunRowTerms,
  type RunTerms,
  type RunTotal,
} from "../domain/approval.js";
import type { Barred as DomainBarred } from "../domain/approvers.js";
import { barredWords, STARTED_WHY } from "../domain/barred.js";
import type { OriginalTransferState } from "../domain/incident.js";
import { awaitingSignoffs, isExpired, requestOpen } from "../domain/live.js";
import { neededWhyOf, parseReason, reasonView } from "../domain/reasons.js";
import {
  approverChoices,
  requestStateOf,
  signerChoices,
  situationOf,
  type ApproverChoice as DomainChoice,
  type InvoiceSnapshot,
  type RequestSnapshot,
  type RequestStateView,
  type RunSnapshot,
  type Situation,
} from "../domain/situation.js";
import type { Approval, Ledger, RunApproval, RunRow, Signoff } from "../store/ledger.js";
import type {
  ApproverChoice,
  ArrivalView,
  Barred,
  CallbackEvidenceView,
  DuplicateView,
  RequestView,
  RunRequestView,
  RunTermsView,
  TermsView,
  Why,
} from "./contract.js";
import { domainChecks, domainText, type DomainCheck } from "../runs/runs.js";
import { accountView, arrivalView, failureView, fxView, lastFour, money, why } from "./parts.js";

// Approval requests as a person reads them: the terms an approval covers, who
// can sign it now and why the others cannot, and who is barred.

export function approverViews(choices: DomainChoice[], currency: string): ApproverChoice[] {
  return choices.map(
    (choice: DomainChoice): ApproverChoice => ({
      name: choice.name,
      limit: money(choice.limitMinor, currency),
      canApprove: choice.canApprove,
      signed: choice.signed,
      why: choice.why,
    }),
  );
}

// The engine's and runs.ts's fixed words for why someone may not approve.
function barredCode(text: string): string {
  if (text === STARTED_WHY) {
    return "started";
  }
  if (text === "uploaded the pay run it came from" || text === "uploaded this run") {
    return "uploaded-run";
  }
  if (/^(proposed|confirmed) the phone number the callback/.test(text)) {
    return "set-callback-phone";
  }
  return text.startsWith("recorded the callback") ? "recorded-callback" : "other";
}

export function barredViews(barred: DomainBarred[]): Barred[] {
  return barred.map((entry: DomainBarred): Barred => ({ name: entry.name, why: why(barredCode(entry.why), barredWords(entry.why)) }));
}

function signoffsOf(signoffs: Signoff[]): { name: string; at: string }[] {
  return signoffs.map((signoff: Signoff): { name: string; at: string } => ({ name: signoff.approver, at: signoff.at }));
}

function neededWhy(text: string): Why | null {
  const found: { code: string; text: string } | null = neededWhyOf(text);
  return found === null ? null : why(found.code, found.text);
}

const ORIGINAL_STATES: Record<OriginalTransferState, string> = {
  in_flight: "With the bank",
  paid: "Paid",
  failed: "Failed",
  unknown: "In a status PayOnce does not know",
};

function callbackView(evidence: BankChangeEvidence): CallbackEvidenceView {
  return {
    calledBy: evidence.calledBy,
    numberEnding: lastFour(evidence.numberCalled),
    calledAt: evidence.calledAt === "" ? null : evidence.calledAt,
    spokeTo: evidence.spokeTo,
    confirmed: evidence.confirmed,
  };
}

// An invoice another one looks like a second bill of, with its state now.
export function duplicateView(
  invoiceId: string,
  situation: Situation | null,
  evidence: DuplicateEvidence | null,
): DuplicateView {
  return {
    invoiceId,
    state: situation?.state ?? null,
    label: situation?.label ?? "No longer in the ledger",
    paidBy: evidence?.paidBy ?? null,
    sameAccount: evidence?.sameAccount ?? null,
  };
}

export function termsView(
  snapshot: InvoiceSnapshot,
  request: Approval,
  terms: ApprovalTerms,
  duplicates: Map<string, Situation>,
  now: number,
): TermsView {
  const bankChange: BankChangeEvidence | null | undefined = terms.evidence.bankChange;
  const fx: FxTerms | undefined = terms.fx;
  return {
    action: terms.action,
    title: terms.action === "replace" ? "Approve this replacement" : "Approve paying this held invoice",
    pay: money(terms.amountMinor, terms.currency),
    supplier: snapshot.obligation.supplier,
    account: accountView(terms.payTo) ?? { label: "an account PayOnce cannot name", ending: null },
    // A callback changed the account the request pays, or the request pays the
    // account the supplier record held all along.
    accountOnFile: bankChange === null || bankChange === undefined,
    fx: fx === undefined ? null : fxView(fx),
    feeEstimate: fx?.feeEstimateMinor === null || fx === undefined ? null : money(fx.feeEstimateMinor, fx.sellCurrency, true),
    reason: reasonView(parseReason(terms.evidence.reason)),
    original:
      terms.action === "replace"
        ? {
            reference: terms.evidence.originalReference === "" ? null : terms.evidence.originalReference,
            stateLabel: ORIGINAL_STATES[terms.evidence.originalState] ?? "In a status PayOnce does not know",
            failure: failureView(terms.evidence.failureCode),
          }
        : null,
    emails: terms.evidence.emails === undefined || terms.evidence.emails === "" ? null : terms.evidence.emails,
    duplicates:
      terms.action === "pay"
        ? terms.evidence.duplicates.map(
            (evidence: DuplicateEvidence): DuplicateView =>
              duplicateView(evidence.invoiceId, duplicates.get(evidence.invoiceId) ?? null, evidence),
          )
        : [],
    callback: bankChange === null || bankChange === undefined ? null : callbackView(bankChange),
    arrival: terms.arrival === undefined ? null : arrivalView(terms.arrival, requestOpen(request, now), now),
  };
}

// The latest request on an invoice, or null when it has none or its terms do
// not parse.
export function requestView(snapshot: InvoiceSnapshot, duplicates: Map<string, Situation>, now: number): RequestView | null {
  const latest: RequestSnapshot | undefined = snapshot.requests.at(-1);
  if (latest === undefined || latest.terms === null) {
    return null;
  }
  const request: Approval = latest.approval;
  const state: RequestStateView = requestStateOf(request, snapshot.requests.map((item: RequestSnapshot): Approval => item.approval), now);
  const amount: PaymentAmount = paymentAmount(latest.terms);
  const later: RequestSnapshot | undefined = snapshot.requests.find((other: RequestSnapshot): boolean => other.approval.id > request.id);
  return {
    id: request.id,
    state: state.state,
    label: state.label,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    needed: request.needed,
    neededWhy: neededWhy(request.neededWhy),
    signoffs: signoffsOf(request.signoffs),
    approvers: approverViews(approverChoices(snapshot, now), amount.currency),
    barred: barredViews(snapshot.signing.barred),
    terms: termsView(snapshot, request, latest.terms, duplicates, now),
    replacedBy: state.state === "replaced" ? (later?.approval.id ?? null) : null,
  };
}

// The situations of the invoices a held invoice's terms or its duplicateOf name.
export function duplicateIds(snapshot: InvoiceSnapshot): string[] {
  const named: string[] = [...snapshot.obligation.duplicateOf];
  for (const request of snapshot.requests) {
    if (request.terms?.action === "pay") {
      named.push(...request.terms.evidence.duplicates.map((evidence: DuplicateEvidence): string => evidence.invoiceId));
    }
  }
  return [...new Set<string>(named)];
}

export function situationsOf(snapshots: InvoiceSnapshot[], now: number): Map<string, Situation> {
  return new Map<string, Situation>(
    snapshots.map((snapshot: InvoiceSnapshot): [string, Situation] => [snapshot.obligation.invoiceId, situationOf(snapshot, now)]),
  );
}

// ---------- pay runs ----------

export function runTermsView(ledger: Ledger, terms: RunTerms, live: boolean, now: number): RunTermsView {
  const largest: PaymentAmount = runAmount(terms);
  return {
    payments: terms.rows.length,
    totals: terms.totals.map((total: RunTotal) => ({
      total: money(total.amountMinor, total.currency),
      payments: total.payments,
      floor: total.reserveFloorMinor === null ? null : money(total.reserveFloorMinor, total.currency),
    })),
    largest: money(largest.minor, largest.currency),
    newPayees: [],
    // Rows whose account a callback verified, whether or not PayOnce paid it since.
    callbackRows: terms.rows
      .filter((row: RunRowTerms): boolean => row.bankChange !== null || row.verifiedBy !== undefined)
      .map((row: RunRowTerms): number => row.line),
    domains: domainChecks(ledger, terms).map((check: DomainCheck) => ({
      line: check.line,
      domain: check.domain,
      caution: check.caution,
      text: domainText(check),
    })),
    arrivals: terms.rows.flatMap((row: RunRowTerms) => {
      const advice: ArrivalView | null = row.arrival === undefined ? null : arrivalView(row.arrival, live, now);
      return advice === null ? [] : [{ line: row.line, invoiceId: row.invoiceId, advice }];
    }),
  };
}

export function runRequestView(ledger: Ledger, snapshot: RunSnapshot, now: number): RunRequestView | null {
  const latest: RunSnapshot["request"] = snapshot.request;
  if (latest === null || latest.terms === null) {
    return null;
  }
  const request: RunApproval = latest.approval;
  const state: RequestStateView = requestStateOf(request, snapshot.requests, now);
  const amount: PaymentAmount = runAmount(latest.terms);
  const later: RunApproval | undefined = snapshot.requests.find((other: RunApproval): boolean => other.id > request.id);
  const terms: RunTermsView = runTermsView(
    ledger,
    latest.terms,
    snapshot.run.state === "waiting" && requestOpen(request, now),
    now,
  );
  return {
    id: request.id,
    state: state.state,
    label: state.label,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    replacedBy: later?.id ?? null,
    needed: request.needed,
    neededWhy: neededWhy(request.neededWhy),
    signoffs: signoffsOf(request.signoffs),
    approvers: approverViews(
      signerChoices(
        snapshot.policy,
        request,
        amount,
        latest.barred,
        awaitingSignoffs(request, now),
        isExpired(request, now),
        "run",
      ),
      amount.currency,
    ),
    barred: barredViews(latest.barred),
    terms: {
      ...terms,
      newPayees: snapshot.rows
        .filter((row: RunRow): boolean => row.action === "pay" && row.newPayee)
        .map((row: RunRow): number => row.line),
    },
  };
}

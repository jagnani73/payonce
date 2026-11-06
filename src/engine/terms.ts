import type { TransferBankDetails } from "../airwallex/transfers.js";
import { termsFor, withArrival, type ApprovalTerms, type ReplacementTerms } from "../domain/approval.js";
import { arrivalFor, ifSentOn, replacementArrivalText, today, type ArrivalTerms } from "../domain/arrival.js";
import { reasonText } from "../domain/reasons.js";
import { emailEvidence } from "../reader/emails.js";
import { isExpired, type Approval, type Ledger, type Obligation } from "../store/ledger.js";
import type { Assessment } from "./engine.js";
import { requestTerms } from "./stored.js";

// The day an invoice's arrival estimate counts from. While an approval request is
// requested or approved and has not expired, it is that request's day, so its
// binding holds past midnight. Otherwise it is today. awaitApproval never opens
// a new request on an estimate from another day.
function arrivalFrom(ledger: Ledger, invoiceId: string): string {
  const latest: Approval | undefined = ledger.latestApproval(invoiceId);
  const open: ArrivalTerms | undefined =
    latest !== undefined &&
    (latest.state === "requested" || latest.state === "approved") &&
    !isExpired(latest)
      ? requestTerms(latest).arrival
      : undefined;
  return open?.from ?? today();
}

// When a payment of the invoice to these bank details usually arrives, or null
// when the invoice has no due date.
export function arrivalOf(
  ledger: Ledger,
  obligation: Obligation,
  bankDetails: TransferBankDetails,
): ArrivalTerms | null {
  return obligation.dueDate === null
    ? null
    : arrivalFor(
        obligation.transferMethod,
        obligation.currency,
        bankDetails,
        obligation.dueDate,
        arrivalFrom(ledger, obligation.invoiceId),
      );
}

// What the decision line adds about when a replacement would arrive: only for an
// invoice with a due date whose original failed and no payout sent outside
// PayOnce may pay. It counts from today, also while an open request keeps the day
// it opened on.
export function arrivalClause(assessment: Assessment): string {
  return assessment.arrival === null ||
    assessment.incident.originalState !== "failed" ||
    assessment.incident.outsidePayoutLive
    ? ""
    : `. ${replacementArrivalText(ifSentOn(assessment.arrival, today()))}`;
}

// The terms a new request opens on. Terms that kept an open request's arrival
// estimate, counted from a day that is not today, count from today. Only the
// dates change.
export function countedFromToday<T extends ApprovalTerms>(terms: T): T {
  return terms.arrival !== undefined && terms.arrival.from !== today()
    ? withArrival(terms, ifSentOn(terms.arrival, today()))
    : terms;
}

// The email evidence a person sees and approves against. It names no address, so
// nothing a sender wrote reaches the binding.
function evidenceSummary(obligation: Obligation, assessment: Assessment): string {
  return emailEvidence(assessment.findings.summary, assessment.emails, obligation.supplierDomain);
}

// The terms carry the reason as its text, so codes never reach a binding.
export function termsOf(obligation: Obligation, assessment: Assessment): ReplacementTerms {
  return termsFor(
    obligation,
    assessment.original,
    { action: assessment.decision.action, reason: reasonText(assessment.decision.reason) },
    evidenceSummary(obligation, assessment),
    assessment.bankDetails,
    assessment.bankChange,
    assessment.rate?.fx ?? null,
    assessment.arrival,
  );
}

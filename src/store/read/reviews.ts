import type { ApprovalTerms } from "../../domain/approval.js";
import type { Barred } from "../../domain/approvers.js";
import { knownRoute } from "../../domain/assess.js";
import { barredFrom } from "../../domain/barred.js";
import { emailEvidence, type SupplierEmail } from "../../domain/emails.js";
import { isExpired, payoutNamesOnly, payoutPays } from "../../domain/live.js";
import { formatMoney } from "../../domain/money.js";
import { STATUS_PATTERN } from "../../domain/patterns.js";
import { closeKindFor } from "../../domain/situation.js";
import { listOf, shownReference } from "../../text/printable.js";
import type { Approval } from "../approvals.js";
import type { Attempt, AttemptKind } from "../attempts.js";
import type { Obligation } from "../invoices.js";
import type { Ledger } from "../ledger.js";
import { payoutVerdict, type OutsidePayout } from "../payouts.js";
import { requestTerms, storedFindings } from "../stored.js";
import { coveredByClose, type CoveredTransfer } from "./facts.js";

// What a person reads before closing an invoice or approving a payment for it,
// from the ledger as it is now. The engine's close and approval check against
// these, and the views and commands show them. Nothing here writes.

// barredFrom, on the ledger as it is now. The account's routeKey is the one given
// or, without one, the one the ledger keeps with a request.
export function barredOnFile(
  ledger: Ledger,
  obligation: Obligation,
  accountKey: string | undefined,
  routeKey: string | null = null,
): Barred[] {
  return barredFrom(
    {
      startedBy: obligation.startedBy,
      fromRun: obligation.runRowId !== null,
      callbacks: ledger.callbacksFor(obligation.beneficiaryId),
    },
    accountKey,
    knownRoute(routeKey ?? (accountKey === undefined ? undefined : ledger.accountRoutes().get(accountKey))),
  );
}

// What a person is shown before closing an escalated invoice the bank reports as
// paid once: by PayOnce's original or replacement, or by a payout sent outside
// PayOnce after every payment PayOnce sent failed. kind duplicate is an invoice
// held before paying as a second bill for others, and its reference lists them.
// kind unpaid is any other escalated invoice with nothing for it live at the
// bank, such as one whose original Airwallex refused, or whose payments all
// failed. Closing either leaves it unpaid. emails is the
// email evidence an approval would show, null when the invoice has no emails.
// covered lists the transfers under its request ids that do not match it and
// that no person has cleared: the card shows them, and closing on this review
// clears exactly those.
export interface CloseReview {
  kind: AttemptKind | "outside" | "mismatched" | "duplicate" | "unpaid";
  reference: string | null;
  reason: string;
  emails: string | null;
  covered: CoveredTransfer[];
  // Paid payouts sent outside PayOnce that name this invoice but do not pay it,
  // or that PayOnce could not check yet (payoutPays): what the card shows of
  // each, so a person sees they do not count.
  namesOnly: NamingPayout[];
}

// A payout that names an invoice without paying it, as the close card shows it:
// the bank's short reference, what it delivered, the last four characters of
// the account it went to, and checked, false while PayOnce could not tell
// whether it pays the invoice. Never the payee's name.
export interface NamingPayout {
  reference: string;
  amountMinor: number | null;
  currency: string | null;
  ending: string | null;
  checked: boolean;
}

// checked is whether PayOnce could tell from what it read that the payout does
// not pay the invoice (payoutVerdict gives a verdict whatever the account).
function namingPayout(obligation: Obligation, payout: OutsidePayout): NamingPayout {
  return {
    reference: payout.reference,
    amountMinor: payout.deliveredMinor ?? null,
    currency: payout.deliveredCurrency ?? null,
    ending: payout.sentEnding ?? null,
    checked: payoutVerdict(obligation, payout, null) !== null,
  };
}

// How pnpm close names a payout that names the invoice but does not pay it, or
// that PayOnce could not check yet.
export function namingText(payout: NamingPayout): string {
  const amount: string =
    payout.amountMinor === null || payout.currency === null
      ? "an amount PayOnce did not read"
      : formatMoney(payout.amountMinor, payout.currency);
  return `${payout.reference}, ${amount}, to ${payout.ending === null ? "an account PayOnce did not read" : `the account ending ${payout.ending}`}, paid, ${payout.checked ? "and does not match this invoice" : "and PayOnce could not check it yet"}`;
}

// Airwallex's transfer ids are UUIDs and its statuses capital words, so a stored
// value in any other form is not shown.
const TRANSFER_ID: RegExp = /^[A-Za-z0-9-]{1,64}$/;

// How a close names the transfers it covers, as the card and pnpm close show them.
// The bank's reference, transfer id and status show only in their own forms,
// because the refusal that carries this goes to the page and the terminal.
export function coveredText(transfer: CoveredTransfer): string {
  const id: string = TRANSFER_ID.test(transfer.transferId) ? transfer.transferId : "a transfer id PayOnce cannot show";
  const status: string =
    transfer.status === null
      ? "status not read"
      : STATUS_PATTERN.test(transfer.status)
        ? transfer.status
        : "a status PayOnce cannot show";
  return `${shownReference(transfer.reference)} (${id}), ${status}, under the ${transfer.kind}'s request id`;
}

export function pendingClose(
  ledger: Ledger,
  invoiceId: string,
): CloseReview | undefined {
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  if (obligation?.state !== "escalated") {
    return undefined;
  }
  const reason: string = obligation.escalationReason;
  const onFile: SupplierEmail[] = ledger.emails(invoiceId);
  const emails: string | null =
    onFile.length === 0
      ? null
      : emailEvidence(storedFindings(ledger, invoiceId, onFile).findings.summary, onFile, obligation.supplierDomain);
  const covered: CoveredTransfer[] = coveredByClose(ledger, invoiceId);
  const attempts: Attempt[] = ledger.attempts(invoiceId);
  const payouts: OutsidePayout[] = ledger.outsidePayouts(invoiceId);
  const namesOnly: NamingPayout[] = payouts
    .filter(payoutNamesOnly)
    .map((payout: OutsidePayout): NamingPayout => namingPayout(obligation, payout));
  const review = (kind: CloseReview["kind"], reference: string | null, why: string = reason): CloseReview => ({
    kind,
    reference,
    reason: why,
    emails,
    covered,
    namesOnly,
  });
  // Nothing for it is with the bank or paid when it is a duplicate or unpaid, so
  // a person may close it without paying, whatever it waits on: held before
  // paying, a failed payment with a request open, new bank details nobody can
  // verify by calling back, or one a person closed before that a payment found
  // since reopened.
  switch (closeKindFor(obligation, attempts, payouts)) {
    case "original":
    case "replacement": {
      const paid: Attempt | undefined = attempts.find((attempt: Attempt): boolean => attempt.state === "paid");
      // A payment at a rate nobody approved is why it was not closed by itself.
      return paid === undefined ? undefined : review(paid.kind, paid.reference, paid.rateMismatch ?? reason);
    }
    case "outside": {
      const paid: OutsidePayout | undefined = payouts.find(payoutPays);
      return paid === undefined ? undefined : review("outside", paid.reference);
    }
    // Paid by a transfer under one of its request ids that does not match it: a
    // person checks it and closes the invoice.
    case "mismatched":
      return review(
        "mismatched",
        attempts.find((attempt: Attempt): boolean => attempt.mismatchedStatus === "PAID")?.mismatchedReference ?? null,
      );
    case "duplicate":
      return review("duplicate", listOf(obligation.duplicateOf));
    case "unpaid":
      return review("unpaid", null);
    case undefined:
      return undefined;
  }
}

export interface PendingApproval {
  approval: Approval;
  terms: ApprovalTerms;
  // Who may not approve it, and why.
  barred: Barred[];
  expired: boolean;
}

// Returns the request an escalated invoice is waiting on, if there is one.
export function pendingApproval(
  ledger: Ledger,
  invoiceId: string,
): PendingApproval | undefined {
  const approval: Approval | undefined = ledger.latestApproval(invoiceId);
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  if (
    approval === undefined ||
    approval.state !== "requested" ||
    obligation?.state !== "escalated"
  ) {
    return undefined;
  }
  const terms: ApprovalTerms = requestTerms(approval);
  return {
    approval,
    terms,
    barred: barredOnFile(ledger, obligation, terms.accountKey),
    expired: isExpired(approval),
  };
}

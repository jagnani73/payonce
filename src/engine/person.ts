import { paidWith, paymentAmount, type ApprovalTerms } from "../domain/approval.js";
import {
  APPROVED_USE_WITHIN_MS,
  checkSigner,
  personName,
  type ApprovalPolicy,
  type Approver,
  type Barred,
} from "../domain/approvers.js";
import { formatMoney } from "../domain/money.js";
import { STATUS_PATTERN } from "../domain/patterns.js";
import { emailEvidence, type SupplierEmail } from "../reader/emails.js";
import {
  DuplicatePaymentError,
  isExpired,
  liveAtBank,
  payoutVerdict,
  signersOf,
  type Approval,
  type Attempt,
  type AttemptKind,
  type AttemptState,
  type Ledger,
  type Obligation,
  type OutsidePayout,
  type Signoff,
} from "../store/ledger.js";
import { shownReference } from "../text/printable.js";
import { storedFindings } from "./emails.js";
import { anyLive, coveredByClose, heldBeforePaying, type CoveredTransfer } from "./facts.js";
import { listOf, note } from "./lines.js";
import { barredFrom } from "./requests.js";

const ATTEMPT_STATE_WORDS: Record<AttemptState, string> = {
  pending: "pending",
  in_flight: "in flight",
  paid: "paid",
  failed: "failed",
};

export interface PayAgainResult {
  refused: boolean;
  message: string;
}

// A person asks for the invoice to be paid again. The request takes the duplicate
// lock like any payment, inside a transaction that is always rolled back, so it
// never reaches Airwallex. When every payment has failed the lock has nothing to
// refuse, but a replacement still goes through the policy and any approval, so
// nothing is sent from here either.
export function payAgain(ledger: Ledger, invoiceId: string): PayAgainResult {
  try {
    ledger.tryLock(invoiceId);
  } catch (error: unknown) {
    if (!(error instanceof DuplicatePaymentError)) {
      throw error;
    }
    const holder: Attempt | undefined = ledger.attempts(invoiceId).find(liveAtBank);
    const held: string =
      holder === undefined
        ? ""
        : holder.state === "failed" && holder.transferId === null
          ? `: transfer ${holder.mismatchedReference ?? ""} under the ${holder.kind}'s request id is live at the bank`
          : `: ${holder.kind} ${holder.reference ?? "with no reference yet"} is ${holder.state === "failed" ? "live at the bank" : ATTEMPT_STATE_WORDS[holder.state]}`;
    const message: string = `Pay again refused by the duplicate lock${held}. An invoice can have one live payment`;
    note(ledger, invoiceId, "lock", message);
    return { refused: true, message };
  }
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  const message: string =
    obligation?.state === "settled"
      ? "Pay again not sent. The incident is closed, so PayOnce pays nothing more for this invoice"
      : obligation?.state === "rejected"
        ? "Pay again not sent. A person closed this invoice without paying"
        : anyLive(ledger.outsidePayouts(invoiceId))
          ? "Pay again not sent. A payout sent outside PayOnce may already pay this invoice"
          : obligation !== undefined && heldBeforePaying(ledger, obligation)
            ? "Pay again not sent. PayOnce is holding this invoice before paying it, so it pays only on an approval"
            : "Pay again not sent. No payment for this invoice is live, so a replacement goes through the policy, and through a person's approval once the invoice is with a person";
  note(ledger, invoiceId, "warning", message);
  return { refused: false, message };
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
  const paying: { pays: OutsidePayout[]; namesOnly: OutsidePayout[] } = ledger.payingPayouts(invoiceId);
  const namesOnly: NamingPayout[] = paying.namesOnly.map(
    (payout: OutsidePayout): NamingPayout => namingPayout(obligation, payout),
  );
  if (ledger.paidOnce(invoiceId)) {
    const paid: Attempt | undefined = ledger
      .attempts(invoiceId)
      .find((attempt: Attempt): boolean => attempt.state === "paid");
    // A payment at a rate nobody approved is why it was not closed by itself.
    return paid === undefined
      ? undefined
      : { kind: paid.kind, reference: paid.reference, reason: paid.rateMismatch ?? reason, emails, covered, namesOnly };
  }
  if (ledger.paidOutside(invoiceId)) {
    const paid: OutsidePayout | undefined = paying.pays.find(
      (payout: OutsidePayout): boolean => payout.state === "paid",
    );
    return paid === undefined
      ? undefined
      : { kind: "outside", reference: paid.reference, reason, emails, covered, namesOnly };
  }
  // Paid by a transfer under one of its request ids that does not match it: a
  // person checks it and closes the invoice.
  if (ledger.paidMismatched(invoiceId)) {
    const paid: Attempt | undefined = ledger
      .attempts(invoiceId)
      .find((attempt: Attempt): boolean => attempt.mismatchedStatus === "PAID");
    return { kind: "mismatched", reference: paid?.mismatchedReference ?? null, reason, emails, covered, namesOnly };
  }
  // Not while anything for it may be paying it: a paid payout that only names it
  // does not.
  const naming: ReadonlySet<string> = new Set<string>(
    paying.namesOnly.map((payout: OutsidePayout): string => payout.transferId),
  );
  const others: OutsidePayout[] = ledger
    .outsidePayouts(invoiceId)
    .filter((payout: OutsidePayout): boolean => !naming.has(payout.transferId));
  if (anyLive(others) || ledger.attempts(invoiceId).some(liveAtBank)) {
    return undefined;
  }
  // Nothing for it is with the bank or paid, so a person may close it without
  // paying, whatever it waits on: held before paying, a failed payment with a
  // request open, new bank details nobody can verify by calling back, or one a
  // person closed before that a payment found since reopened.
  return obligation.rejectedBy === null &&
    heldBeforePaying(ledger, obligation) &&
    obligation.duplicateOf.length > 0
    ? { kind: "duplicate", reference: listOf(obligation.duplicateOf), reason, emails, covered, namesOnly }
    : { kind: "unpaid", reference: null, reason, emails, covered, namesOnly };
}

// Records a person closing such an invoice. It moves no money, so it is not bound
// to terms the way an approval is. A held duplicate, and any other invoice with
// nothing live at the bank, is closed without paying, and the invoices a held
// one duplicated say so on their timelines. shown is the transfer ids
// of the covered list the person saw, null when the caller names none. The close
// is refused when it covers a transfer under the invoice's request ids that does
// not match it and that is not on that list: one found since, or any at all when
// the caller named none. Otherwise it clears those, in the transaction that
// closes it, so one found after that still keeps PayOnce from closing the invoice
// by itself.
export function closeIncident(
  ledger: Ledger,
  invoiceId: string,
  closer: string,
  finding: string,
  shown: string[] | null = null,
): void {
  const closedBy: string = personName(closer);
  const review: CloseReview | undefined = pendingClose(ledger, invoiceId);
  const covered: CoveredTransfer[] = review?.covered ?? [];
  if (shown === null && covered.length > 0) {
    throw new Error(
      `Closing ${invoiceId} covers transfers listed under its request ids that do not match it, so the close must name them: ${covered.map(coveredText).join("; ")}`,
    );
  }
  if (covered.some((transfer: CoveredTransfer): boolean => !(shown ?? []).includes(transfer.transferId))) {
    throw new Error(
      `A transfer was found under one of ${invoiceId}'s request ids since the close card was shown. Look at the incident again before closing it`,
    );
  }
  const clears: string[] = covered.map((transfer: CoveredTransfer): string => transfer.transferId);
  if (review?.kind === "duplicate" || review?.kind === "unpaid") {
    const obligation: Obligation | undefined = ledger.obligation(invoiceId);
    // Named only for a held invoice or one closed before, so a close of an
    // invoice paid on an approval after a hold does not call it a second bill.
    const duplicateOf: string[] =
      obligation !== undefined && (obligation.rejectedBy !== null || heldBeforePaying(ledger, obligation))
        ? obligation.duplicateOf
        : [];
    // One closed without paying before keeps who closed it first.
    const closed: boolean =
      obligation?.rejectedBy !== null && obligation?.rejectedBy !== undefined
        ? ledger.rejectAgain(invoiceId, true, clears)
        : ledger.reject(invoiceId, closedBy, clears);
    if (!closed) {
      throw new Error(`${invoiceId} is not waiting on a person to close it`);
    }
    note(
      ledger,
      invoiceId,
      "closed",
      duplicateOf.length > 0
        ? `Closed without paying by ${closedBy}, as a second bill for ${listOf(duplicateOf)}: ${finding}`
        : `Closed without paying by ${closedBy}: ${finding}`,
    );
    for (const other of duplicateOf) {
      note(
        ledger,
        other,
        "warning",
        `${invoiceId} was closed without paying by ${closedBy}, as a second bill for this invoice`,
      );
    }
    return;
  }
  if (review === undefined || !ledger.settle(invoiceId, true, "escalated", clears)) {
    throw new Error(`${invoiceId} is not waiting on a person to close it`);
  }
  note(ledger, invoiceId, "closed", `Incident closed by ${closedBy}: ${finding}`);
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
  const terms: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  return {
    approval,
    terms,
    barred: barredFrom(ledger, obligation, terms.accountKey),
    expired: isExpired(approval),
  };
}

// Records one person's approval of a replacement, or of paying a held invoice,
// under the approval policy. approvalId is the request the approver was shown. If
// a newer one has replaced it, the approval is refused so nobody approves terms
// they did not see. A request that needs two approvers stays open after the first.
export function approvePayment(
  ledger: Ledger,
  policy: ApprovalPolicy,
  invoiceId: string,
  approver: string,
  approvalId: number,
): Approval {
  const pending: PendingApproval | undefined = pendingApproval(ledger, invoiceId);
  if (pending === undefined) {
    throw new Error(`No approval is waiting for ${invoiceId}`);
  }
  const { approval, terms } = pending;
  if (approval.id !== approvalId) {
    throw new Error(
      `The approval request for ${invoiceId} has changed. Review the current terms`,
    );
  }
  if (pending.expired) {
    throw new Error(
      `The approval request for ${invoiceId} has expired. PayOnce opens a new one on its next look`,
    );
  }
  const signer: Approver = checkSigner(
    policy,
    approver,
    paymentAmount(terms),
    pending.barred,
    approval.signoffs.map((signoff: Signoff): string => signoff.approver),
  );
  const after: Approval = ledger.signOff(
    approval.id,
    signer.name,
    approval.binding,
    APPROVED_USE_WITHIN_MS,
  );
  const payment: string = `${formatMoney(terms.amountMinor, terms.currency)} to ${terms.payTo} (the account on file)${paidWith(terms.fx)}`;
  const left: number = after.needed - after.signoffs.length;
  note(
    ledger,
    invoiceId,
    "approval",
    after.state === "approved"
      ? `Approved by ${signersOf(after.signoffs)}: ${payment}`
      : `${signer.name} approved ${payment}. It needs ${left} more approver${left === 1 ? "" : "s"}`,
    // Standing, so the check that follows does not restate the decision.
    "approval",
  );
  return after;
}

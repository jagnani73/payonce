import { paidWith, paymentAmount } from "../domain/approval.js";
import {
  APPROVED_USE_WITHIN_MS,
  checkSigner,
  personName,
  type ApprovalPolicy,
  type Approver,
} from "../domain/approvers.js";
import { liveAtBank } from "../domain/live.js";
import { formatMoney } from "../domain/money.js";
import {
  DuplicatePaymentError,
  signersOf,
  type Approval,
  type Attempt,
  type AttemptState,
  type Ledger,
  type Obligation,
  type Signoff,
} from "../store/ledger.js";
import { anyLive, heldBeforePaying, type CoveredTransfer } from "../store/read/facts.js";
import {
  coveredText,
  pendingApproval,
  pendingClose,
  type CloseReview,
  type PendingApproval,
} from "../store/read/reviews.js";
import { listOf } from "../text/printable.js";
import { note } from "./lines.js";

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

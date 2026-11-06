import { likelyDuplicates } from "../domain/duplicates.js";
import {
  lateBesideLive,
  liveAtBank,
  type Attempt,
  type AttemptKind,
  type Ledger,
  type Obligation,
  type OutsidePayout,
  type ScannedObligation,
} from "../store/ledger.js";

// A status PayOnce does not recognise counts as live.
export function anyLive(payouts: OutsidePayout[]): boolean {
  return payouts.some((payout: OutsidePayout): boolean => payout.state !== "failed");
}

// True when a payment for the invoice, PayOnce's or one sent outside it, is paid.
function isPaid(ledger: Ledger, invoiceId: string): boolean {
  return (
    ledger.attempts(invoiceId).some((attempt: Attempt): boolean => attempt.state === "paid") ||
    ledger.outsidePayouts(invoiceId).some((payout: OutsidePayout): boolean => payout.state === "paid")
  );
}

// The first invoice this one looks like a second bill for that is paid, by
// PayOnce or by a payout sent outside it. Null when there is none.
export function paidDuplicate(ledger: Ledger, obligation: Obligation): string | null {
  return (
    likelyDuplicates(ledger, obligation).find((other: ScannedObligation): boolean =>
      isPaid(ledger, other.invoiceId),
    )?.invoiceId ?? null
  );
}

// A payment the bank has not failed that PayOnce found late, while another payment
// for the invoice, PayOnce's or one sent outside it, is live at the bank too: the
// supplier may have been paid twice. Late is a transfer recorded on an attempt
// PayOnce had marked failed with none, or one the ledger keeps failed while the
// bank shows it live, because another payment holds the duplicate lock. Both are
// judged by liveAtBank, so two late transfers the ledger keeps apart count too.
// settle makes the same test inside its transaction.
export function paidTwice(ledger: Ledger, invoiceId: string): Attempt | undefined {
  return lateBesideLive(ledger.attempts(invoiceId), ledger.outsidePayouts(invoiceId));
}

// A transfer the ledger keeps failed while the bank shows it live. It holds the
// duplicate lock once another payment has failed, which the next record of it
// does, so a look records it again after reading the others.
export function keptFailed(attempt: Attempt): boolean {
  return attempt.state === "failed" && attempt.transferId !== null && liveAtBank(attempt);
}

// True for an invoice with a person that has sent nothing: PayOnce held it before
// paying, or Airwallex refused every payment it was sent with.
export function heldBeforePaying(ledger: Ledger, obligation: Obligation): boolean {
  return (
    obligation.state === "escalated" &&
    ledger
      .attempts(obligation.invoiceId)
      .every((attempt: Attempt): boolean => attempt.transferId === null && attempt.state === "failed")
  );
}

// A transfer under the request id of one of the invoice's attempts (kind) that
// does not match the invoice, with the bank's short reference and the status a
// look last read for it.
export interface CoveredTransfer {
  transferId: string;
  reference: string;
  status: string | null;
  kind: AttemptKind;
}

// The transfers under the invoice's request ids that do not match it, which no
// person has cleared: what a person's close covers.
export function coveredByClose(ledger: Ledger, invoiceId: string): CoveredTransfer[] {
  return ledger
    .attempts(invoiceId)
    .flatMap((attempt: Attempt): CoveredTransfer[] =>
      attempt.mismatchedTransferId !== null && attempt.mismatchedClearedAt === null
        ? [
            {
              transferId: attempt.mismatchedTransferId,
              reference: attempt.mismatchedReference ?? attempt.mismatchedTransferId,
              status: attempt.mismatchedStatus,
              kind: attempt.kind,
            },
          ]
        : [],
    );
}

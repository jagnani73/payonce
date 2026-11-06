import {
  lateBesideLive,
  liveAtBank,
  mismatchedLive,
  nothingWithBank,
  payoutPays,
  stillWithBank,
} from "../domain/live.js";
import type { ApprovalStore } from "./approvals.js";
import { LIVE_ATTEMPT, UNCLEARED_MISMATCH, type Attempt, type AttemptStore } from "./attempts.js";
import type { Db } from "./db.js";
import type { ObligationState } from "./invoices.js";
import { BLOCKING_OUTSIDE_PAYOUT, LIVE_OUTSIDE_PAYOUT, type OutsidePayout, type PayoutStore } from "./payouts.js";

// Closing an invoice: paid once, paid outside, paid by a mismatched transfer, or
// closed without paying.
export class CloseStore {
  private readonly db: Db;
  private readonly attempts: AttemptStore;
  private readonly payouts: PayoutStore;
  private readonly approvals: ApprovalStore;

  constructor(db: Db, attempts: AttemptStore, payouts: PayoutStore, approvals: ApprovalStore) {
    this.db = db;
    this.attempts = attempts;
    this.payouts = payouts;
    this.approvals = approvals;
  }

  // Closes an escalated invoice without paying it, recording who did. False when
  // it is no longer escalated, for example because its payment was released in
  // the meantime, or when a payment for it is live at the bank: PayOnce's, a
  // transfer under one of its request ids, or a payout sent outside PayOnce in
  // flight, or paid and paying it (BLOCKING_OUTSIDE_PAYOUT). covered lists the transfers under its request ids that do not
  // match it which the person's close covered, and they are cleared in the same
  // transaction, as any open request is voided.
  reject(invoiceId: string, rejectedBy: string, covered: string[] = []): boolean {
    return this.db.transaction((): boolean => {
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE obligations SET state = 'rejected', rejected_by = ?
            WHERE invoice_id = ? AND state = 'escalated'
              AND NOT EXISTS (${BLOCKING_OUTSIDE_PAYOUT}) AND NOT EXISTS (${LIVE_ATTEMPT})`,
        )
        .run(rejectedBy, invoiceId, invoiceId, invoiceId);
      if (Number(result.changes) !== 1) {
        return false;
      }
      this.approvals.voidOpenApprovals(invoiceId);
      this.attempts.clearMismatched(invoiceId, covered);
      return true;
    });
  }

  // Closes again without paying an invoice a person had closed without paying,
  // which a payment found since reopened, once nothing for it is live at the bank,
  // PayOnce's or sent outside it. By itself, PayOnce leaves it alone while any
  // payout sent outside PayOnce tied to it is in flight, paid or in a status it
  // does not know (LIVE_OUTSIDE_PAYOUT), and while a transfer under one of its
  // request ids that does not match it was found since a person last closed it.
  // Only a person (byPerson) closes past a paid payout that names the invoice but
  // does not pay it (BLOCKING_OUTSIDE_PAYOUT), and clears only the mismatched
  // transfers their close covered (covered), in the same transaction. False when
  // nothing changed.
  rejectAgain(invoiceId: string, byPerson: boolean = false, covered: string[] = []): boolean {
    return this.db.transaction((): boolean => {
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE obligations SET state = 'rejected'
            WHERE invoice_id = ? AND state = 'escalated' AND rejected_by IS NOT NULL
              AND NOT EXISTS (${LIVE_ATTEMPT})
              AND (? = 1 OR (NOT EXISTS (${LIVE_OUTSIDE_PAYOUT}) AND NOT EXISTS (${UNCLEARED_MISMATCH})))
              AND NOT EXISTS (${BLOCKING_OUTSIDE_PAYOUT})`,
        )
        .run(invoiceId, invoiceId, byPerson ? 1 : 0, invoiceId, invoiceId, invoiceId);
      if (Number(result.changes) !== 1) {
        return false;
      }
      this.approvals.voidOpenApprovals(invoiceId);
      this.attempts.clearMismatched(invoiceId, covered);
      return true;
    });
  }

  // True when one attempt is paid and no other payment for the invoice is with the
  // bank: each has failed, or is a transfer the ledger keeps failed, or one under a
  // request id that does not match the invoice, that the bank has paid as well,
  // which the look holds for a person.
  paidOnce(invoiceId: string): boolean {
    const attempts: Attempt[] = this.attempts.attempts(invoiceId);
    const paid: number = attempts.filter(
      (attempt: Attempt): boolean => attempt.state === "paid",
    ).length;
    const unresolved: number = attempts.filter(stillWithBank).length;
    return paid === 1 && unresolved === 0;
  }

  // True when every payment PayOnce sent has failed at the bank, nothing for the
  // invoice is still with the bank, and a transfer under one of its request ids
  // that does not match it is paid. Only a person closes it then. A payout sent
  // outside PayOnce that is paid as well does not stop it.
  paidMismatched(invoiceId: string): boolean {
    const attempts: Attempt[] = this.attempts.attempts(invoiceId);
    return (
      attempts.every(nothingWithBank) &&
      attempts.some(
        (attempt: Attempt): boolean => mismatchedLive(attempt) && attempt.mismatchedStatus === "PAID",
      ) &&
      !this.payouts.outsidePayouts(invoiceId).some(
        (payout: OutsidePayout): boolean => payout.state !== "failed" && payout.state !== "paid",
      )
    );
  }

  // True when every payment PayOnce sent has failed at the bank, nothing for the
  // invoice is still with the bank, and the bank reports a payout sent outside
  // PayOnce paid that pays the invoice (payoutPays): one that only names it does
  // not. A transfer under one of its request ids that does not match it and is
  // paid as well does not stop it.
  paidOutside(invoiceId: string): boolean {
    return (
      this.attempts.attempts(invoiceId).every(nothingWithBank) &&
      this.payouts.outsidePayouts(invoiceId).some(payoutPays)
    );
  }

  // Settles only when the invoice has been paid once by PayOnce or, when a
  // person closes it, by a payout sent outside PayOnce or a transfer under one of
  // its request ids that does not match it. A payment that went out at a rate
  // nobody approved, or to other bank details than it was decided or approved
  // for (misdirected), leaves the invoice for a person to close, unless it
  // failed. So does a transfer found late that may have paid it a second time
  // (lateBesideLive, the test paidTwice makes), and by itself PayOnce never closes
  // one while a payout sent outside PayOnce is live or a mismatched transfer no
  // person has cleared is on file. The checks and the close run in one write
  // transaction, and the close only changes an invoice still open or escalated,
  // and still in the state the caller read when it gives one (from), so a payment
  // another process recorded or tied, or a change it made to the invoice, after
  // the caller looked leaves it as it is. False then. covered lists the
  // transfers under its request ids that do not match it which a person's close
  // covered, and they are cleared in the same transaction.
  settle(
    invoiceId: string,
    byPerson: boolean = false,
    from: ObligationState | null = null,
    covered: string[] = [],
  ): boolean {
    return this.db.transaction((): boolean => {
      if (
        !this.paidOnce(invoiceId) &&
        !(byPerson && (this.paidOutside(invoiceId) || this.paidMismatched(invoiceId)))
      ) {
        return false;
      }
      const attempts: Attempt[] = this.attempts.attempts(invoiceId);
      if (
        !byPerson &&
        (attempts.some(
          (attempt: Attempt): boolean => (attempt.rateMismatch !== null || attempt.misdirected) && liveAtBank(attempt),
        ) ||
          lateBesideLive(attempts, this.payouts.outsidePayouts(invoiceId)) !== undefined)
      ) {
        return false;
      }
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE obligations SET state = 'settled'
            WHERE invoice_id = ? AND state = COALESCE(?, state) AND state IN ('open', 'escalated')
              AND (? = 1 OR (NOT EXISTS (${LIVE_OUTSIDE_PAYOUT}) AND NOT EXISTS (${UNCLEARED_MISMATCH})))`,
        )
        .run(invoiceId, from, byPerson ? 1 : 0, invoiceId, invoiceId);
      if (Number(result.changes) !== 1) {
        return false;
      }
      // Nothing is left to approve on a settled invoice.
      this.approvals.voidOpenApprovals(invoiceId);
      this.attempts.clearMismatched(invoiceId, covered);
      return true;
    });
  }
}

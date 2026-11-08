import { liveAtBank, mismatchedLive } from "../domain/live.js";
import { reasonFor, routineApproval, type Reason } from "../domain/reasons.js";
import type { Attempt, Ledger, Obligation, ObligationState } from "../store/ledger.js";
import { PAID_FIRST_TIME_LINE } from "../text/words.js";
import { anyLive, coveredByClose, type CoveredTransfer } from "../store/read/facts.js";
import { listOf } from "../text/printable.js";
import type { Engine, NextLook } from "./engine.js";
import { note } from "./lines.js";

// True for a payment that never had an incident: its original was PayOnce's only
// payment for it, nothing was sent outside PayOnce, and nothing sent it to a
// person but the approval every payment a person starts waits for.
function paidFirstTime(ledger: Ledger, invoiceId: string, attempts: Attempt[]): boolean {
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  return (
    obligation !== undefined &&
    obligation.origin === "payonce" &&
    attempts.length === 1 &&
    ledger.outsidePayouts(invoiceId).length === 0 &&
    (obligation.escalationReason === "" || routineApproval(ledger.reasonOf(obligation)))
  );
}

// Closes the invoice on the state the look read it in. False, with nothing
// changed, when the ledger refuses (see settle).
export function close(engine: Engine, invoiceId: string, from: ObligationState): boolean {
  if (!engine.ledger.settle(invoiceId, false, from)) {
    return false;
  }
  const attempts: Attempt[] = engine.ledger.attempts(invoiceId);
  const replaced: boolean = attempts.some((attempt: Attempt): boolean => attempt.kind === "replacement");
  note(
    engine.ledger,
    invoiceId,
    "closed",
    replaced
      ? "Incident closed: the original failed and one replacement was paid"
      : paidFirstTime(engine.ledger, invoiceId, attempts)
        ? PAID_FIRST_TIME_LINE
        : "Incident closed: the original payment arrived",
  );
  return true;
}

// What an invoice paid by a payment that went to other bank details than it was
// decided or approved for waits on.
const MISDIRECTED_WAITING_LINE: string =
  "Waiting on a person to check the bank details a payment went to and close the incident. PayOnce will not send another payment";

// What a look does when the ledger refused its close. A payment that went out at a
// rate nobody approved waits for a person, and so does an invoice the ledger no
// longer shows as paid once. By itself PayOnce never closes an invoice beside a
// live payout sent outside PayOnce, or a transfer under one of its request ids
// that does not match it which no person has cleared (see settle), so that one
// goes to a person too, open or not, and the close card offers it. One already
// with a person keeps its reason. Otherwise another process recorded a payment
// that may pay it a second time, or changed the invoice, since this look read it,
// and the next look, at once, decides as the ledger now stands.
export function closeRefused(engine: Engine, invoiceId: string): NextLook {
  // A payment that went to other bank details than it was meant for is checked by
  // a person, as one at a rate nobody approved is. checkAccount escalated it.
  if (engine.ledger.attempts(invoiceId).some((attempt: Attempt): boolean => attempt.misdirected && liveAtBank(attempt))) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      MISDIRECTED_WAITING_LINE,
      "waiting",
    );
    return null;
  }
  if (
    engine.ledger
      .attempts(invoiceId)
      .some((attempt: Attempt): boolean => attempt.rateMismatch !== null && liveAtBank(attempt))
  ) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      "Waiting on a person to check the exchange rate a payment went out at and close the incident. PayOnce will not send another payment",
      "waiting",
    );
    return null;
  }
  if (!engine.ledger.paidOnce(invoiceId)) {
    note(
      engine.ledger,
      invoiceId,
      "error",
      "The ledger does not show this invoice as paid once, so the incident stays open",
    );
    return null;
  }
  const outside: boolean = anyLive(engine.ledger.outsidePayouts(invoiceId));
  if (outside || coveredByClose(engine.ledger, invoiceId).length > 0) {
    const reason: Reason = reasonFor(
      outside
        ? "outside-payout"
        : engine.ledger.attempts(invoiceId).some(mismatchedLive)
          ? "unrecognised-transfer"
          : "unrecognised-transfer-failed",
    );
    if (engine.ledger.escalateIfOpen(invoiceId, reason)) {
      note(engine.ledger, invoiceId, "approval", closeWaitingLine(engine.ledger, invoiceId), "waiting");
    }
    return null;
  }
  return Date.now();
}

// What an invoice paid once waits for while only a person can close it. It names
// a live payout sent outside PayOnce, or else the transfers a person's close
// covers, so the person checks them first.
export function closeWaitingLine(ledger: Ledger, invoiceId: string): string {
  if (anyLive(ledger.outsidePayouts(invoiceId))) {
    return "Waiting on a person. A payout sent outside PayOnce may also pay this invoice, which PayOnce has paid once. Check it with the supplier and close the incident. PayOnce will not send a second payment";
  }
  const references: string[] = coveredByClose(ledger, invoiceId).map(
    (transfer: CoveredTransfer): string => transfer.reference,
  );
  if (references.length === 0) {
    return "Waiting on a person to check with the supplier and close the incident. PayOnce will not send a second payment";
  }
  const one: boolean = references.length === 1;
  return `Waiting on a person to check ${one ? "transfer" : "transfers"} ${listOf(references)}, listed under this invoice's request ${one ? "id" : "ids"}, which ${one ? "does" : "do"} not match it, and close the incident. PayOnce will not send a second payment`;
}

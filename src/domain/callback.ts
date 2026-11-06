import type { Attempt, ObligationState, OutsidePayout } from "../store/ledger.js";
import { PROPOSAL_BLOCKS_CALLBACK } from "./contacts.js";
import { liveAtBank, payoutNotFailed, type LiveTested } from "./live.js";

// What decides whether a callback with new bank details can be recorded for an
// invoice now. The two facts that scan the ledger are read only when the checks
// before them pass.
export interface CallbackFacts {
  // A new phone number for the record waits for a second person.
  phoneProposed: boolean;
  supplierPhone: string | null;
  state: ObligationState;
  attempts: (LiveTested & Pick<Attempt, "kind">)[];
  payouts: () => Pick<OutsidePayout, "state" | "pays">[];
  // Whether PayOnce has paid this supplier before: with the account each
  // payment went to kept (checked), only before it kept them (unchecked), or
  // never.
  paidBefore: () => "checked" | "unchecked" | "never";
  // Another open invoice to the same beneficiary is about to pay it: a payment
  // not yet with the bank, an approval not yet spent, or a pay run row approved
  // or released and not sent yet.
  anotherStarting: () => boolean;
}

// Why a callback cannot be recorded for the invoice now, or null when it can.
// It is made on the record's phone on file, so not while a new one waits for a
// second person. Bank details can change only while the invoice is with a person
// and nothing is with the bank or paid: every payment PayOnce sent has failed, or
// it was held before paying a supplier PayOnce has paid before, no payout sent
// outside PayOnce is live, and no other invoice to the supplier is about to pay.
export function callbackBlocked(facts: CallbackFacts): string | null {
  if (facts.phoneProposed) {
    return PROPOSAL_BLOCKS_CALLBACK;
  }
  if (facts.supplierPhone === null) {
    return "No phone number is on file for this supplier, so there is no number to call back";
  }
  if (facts.state !== "escalated") {
    return facts.state === "settled" ? "The incident is closed" : "The incident is not waiting on a person";
  }
  if (facts.attempts.some(liveAtBank)) {
    return "A payment for this invoice is still with the bank or paid, so its bank details stay as they are";
  }
  // New details are compared with the invoice's original, or with the payment
  // PayOnce last made to this supplier that the bank paid.
  const original: boolean = facts.attempts.some(
    (attempt: LiveTested & Pick<Attempt, "kind">): boolean => attempt.kind === "original" && attempt.transferId !== null,
  );
  const paidBefore: "checked" | "unchecked" | "never" = original ? "checked" : facts.paidBefore();
  if (paidBefore !== "checked") {
    return paidBefore === "never"
      ? "PayOnce has not paid this supplier before, so there are no bank details to compare new ones with. Approve paying the account on file, or close the invoice without paying"
      : "PayOnce paid this supplier only before it kept which account each payment went to, so there are no checked bank details to compare new ones with. Approve paying the account on file, or close the invoice without paying";
  }
  if (facts.payouts().some(payoutNotFailed)) {
    return "A payout for this invoice sent outside PayOnce may already pay it";
  }
  if (facts.anotherStarting()) {
    return "Another invoice to this supplier is about to be paid. Record the callback once it has gone to the bank";
  }
  return null;
}

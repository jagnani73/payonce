import type { CallbackFacts } from "../../domain/callback.js";
import { waiting, type Contact } from "../../domain/contacts.js";
import type { Attempt } from "../attempts.js";
import type { Obligation, ScannedObligation } from "../invoices.js";
import type { Ledger } from "../ledger.js";
import type { OutsidePayout } from "../payouts.js";
import type { PayRunRow } from "../runs.js";

// What callbackBlocked reads for an invoice, from the ledger as it is now. The
// two facts that scan other invoices are read only when callbackBlocked asks.
export function callbackFacts(ledger: Ledger, obligation: Obligation, now: number): CallbackFacts {
  const proposal: Contact | undefined = ledger.contactProposal(obligation.beneficiaryId, "phone");
  return {
    phoneProposed: proposal !== undefined && waiting(proposal, now),
    supplierPhone: obligation.supplierPhone,
    state: obligation.state,
    attempts: ledger.attempts(obligation.invoiceId),
    payouts: (): OutsidePayout[] => ledger.outsidePayouts(obligation.invoiceId),
    paidBefore: (): "checked" | "unchecked" | "never" =>
      ledger.lastPaidTransfer(obligation.beneficiaryId) !== undefined
        ? "checked"
        : ledger.lastPaidUnchecked(obligation.beneficiaryId) !== undefined
          ? "unchecked"
          : "never",
    anotherStarting: (): boolean => anotherPaymentStarting(ledger, obligation, now),
  };
}

// True when another open invoice paid to the same beneficiary is about to pay it:
// a payment not yet with the bank, an approval not yet spent, or a pay run row
// approved or released and not sent yet. Changing the record then would change
// the account that payment goes to outside its turn.
function anotherPaymentStarting(ledger: Ledger, obligation: Obligation, now: number): boolean {
  return (
    ledger.scannedObligations().some(
      (other: ScannedObligation): boolean =>
        other.invoiceId !== obligation.invoiceId &&
        other.beneficiaryId === obligation.beneficiaryId &&
        other.state !== "settled" &&
        other.state !== "rejected" &&
        (ledger.attempts(other.invoiceId).some((attempt: Attempt): boolean => attempt.state === "pending") ||
          ledger.latestApproval(other.invoiceId)?.state === "approved"),
    ) ||
    ledger
      .payRunRows(now)
      .some(
        (row: PayRunRow): boolean => row.beneficiaryId === obligation.beneficiaryId && row.invoiceId !== obligation.invoiceId,
      )
  );
}

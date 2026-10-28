import type { Transfer } from "./airwallex/transfers.js";
import { sameName } from "./approvers.js";
import type { Ledger, Obligation } from "./ledger.js";
import { toMinor } from "./money.js";

// A supplier billing again often adds a letter or a short word after the number,
// such as A, B or REV.
const SUFFIX: RegExp = /^[A-Z]{1,4}$/;
const DIGITS: RegExp = /^[0-9]+$/;

// An invoice number with case, spaces, dashes and other marks, and leading zeros
// taken out. base also drops up to four letters after the last digit.
export interface InvoiceNumber {
  full: string;
  base: string;
}

export function numberOf(invoiceNumber: string): InvoiceNumber {
  const runs: string[] = (invoiceNumber.toUpperCase().match(/[A-Z]+|[0-9]+/g) ?? []).map(
    (run: string): string => (DIGITS.test(run) ? run.replace(/^0+(?=[0-9])/, "") : run),
  );
  const last: string | undefined = runs.at(-1);
  const before: string | undefined = runs.at(-2);
  const suffixed: boolean =
    last !== undefined && before !== undefined && SUFFIX.test(last) && DIGITS.test(before);
  return { full: runs.join("|"), base: (suffixed ? runs.slice(0, -1) : runs).join("|") };
}

// True when two invoice numbers are the same apart from case, spacing, marks and
// leading zeros, or when one is the other with up to four letters added after its
// last digit. INV-0042, inv 42 and INV-42A all match INV-42. INV-42A and INV-42B do
// not match each other, and neither do RENT-2026-OCT and RENT-2026-NOV, because
// each could be a bill of its own. INV-42-1 and INV-421 do not match INV-42.
export function sameInvoiceNumber(a: string, b: string): boolean {
  const x: InvoiceNumber = numberOf(a);
  const y: InvoiceNumber = numberOf(b);
  if (x.full === "" || y.full === "") {
    return false;
  }
  return x.full === y.full || x.base === y.full || x.full === y.base;
}

// True when two invoice numbers are the same apart from case, spacing, marks and
// leading zeros, with no letters added: INV-0042 and inv 42, not INV-42A.
export function sameNumberExactly(a: string, b: string): boolean {
  const x: InvoiceNumber = numberOf(a);
  return x.full !== "" && x.full === numberOf(b).full;
}

// The numbers an invoice is known by: its invoice number and, for a payout found
// outside PayOnce, the reference it was sent with.
export function numbersOf(obligation: Obligation): string[] {
  return [obligation.invoiceId, obligation.payoutReference].filter(
    (reference: string | null): reference is string => reference !== null,
  );
}

function knownAs(obligation: Obligation, reference: string): boolean {
  return numbersOf(obligation).some((number: string): boolean => sameInvoiceNumber(number, reference));
}

export interface Bill {
  supplier: string;
  beneficiaryId: string;
  currency: string;
  amountMinor: number;
}

function sameBill(obligation: Bill, bill: Bill): boolean {
  return (
    obligation.currency === bill.currency &&
    obligation.amountMinor === bill.amountMinor &&
    (obligation.beneficiaryId === bill.beneficiaryId || sameName(obligation.supplier, bill.supplier))
  );
}

// The test likelyDuplicates makes, for two bills that are not in the ledger yet,
// such as two rows of one pay run file.
export function sameBillAndNumber(
  a: Bill & { invoiceId: string },
  b: Bill & { invoiceId: string },
): boolean {
  return sameBill(a, b) && sameInvoiceNumber(a.invoiceId, b.invoiceId);
}

// The other invoices this one may be a second bill for, oldest first: the same
// supplier, by beneficiary or by name, the same amount and currency, and an
// invoice number sameInvoiceNumber matches. An invoice closed without paying as a
// duplicate is left out, since the one it duplicated is listed already.
export function likelyDuplicates(ledger: Ledger, obligation: Obligation): Obligation[] {
  return ledger
    .obligations()
    .filter(
      (other: Obligation): boolean =>
        other.invoiceId !== obligation.invoiceId &&
        other.state !== "rejected" &&
        sameBill(other, obligation) &&
        numbersOf(obligation).some((number: string): boolean => knownAs(other, number)),
    )
    .reverse();
}

// The other invoices to the same supplier, by beneficiary or by name, whose
// number sameInvoiceNumber matches this one's, whatever their amount and
// currency, oldest first. PayOnce pays an invoice number once, so a payment for
// such an invoice waits for a person. Rejected invoices are left out, as in
// likelyDuplicates.
export function sameNumberForSupplier(ledger: Ledger, obligation: Obligation): Obligation[] {
  return ledger
    .obligations()
    .filter(
      (other: Obligation): boolean =>
        other.invoiceId !== obligation.invoiceId &&
        other.state !== "rejected" &&
        (other.beneficiaryId === obligation.beneficiaryId ||
          sameName(other.supplier, obligation.supplier)) &&
        numbersOf(obligation).some((number: string): boolean => knownAs(other, number)),
    )
    .reverse();
}

function billOf(transfer: Transfer): Bill | undefined {
  const beneficiaryId: string | undefined = transfer.beneficiary_id;
  if (beneficiaryId === undefined || !Number.isFinite(transfer.transfer_amount)) {
    return undefined;
  }
  return {
    supplier: transfer.beneficiary?.bank_details?.account_name ?? "",
    beneficiaryId,
    currency: transfer.transfer_currency,
    amountMinor: toMinor(transfer.transfer_amount),
  };
}

// True when a payout's reference nearly matches the invoice's number, by
// sameInvoiceNumber, and it went to the same supplier for the same amount and
// currency.
export function nearlyPays(obligation: Obligation, transfer: Transfer): boolean {
  const bill: Bill | undefined = billOf(transfer);
  return (
    bill !== undefined && sameBill(obligation, bill) && knownAs(obligation, transfer.reference ?? "")
  );
}

export interface PayoutMatch {
  obligation: Obligation;
  // False when the payout's reference only nearly matches the invoice number.
  exact: boolean;
}

// The invoice a payout sent outside PayOnce is for: the one its reference names
// exactly, or else one it nearlyPays. Of those, an invoice not yet closed comes
// first, because that is where a second payment would do harm, and then the
// oldest.
export function invoiceForPayout(ledger: Ledger, transfer: Transfer): PayoutMatch | undefined {
  const named: Obligation | undefined = ledger.obligationForReference(transfer.reference ?? "");
  if (named !== undefined) {
    return { obligation: named, exact: true };
  }
  const near: Obligation[] = ledger
    .obligations()
    .reverse()
    .filter((obligation: Obligation): boolean => nearlyPays(obligation, transfer));
  const chosen: Obligation | undefined =
    near.find(
      (obligation: Obligation): boolean =>
        obligation.state === "open" || obligation.state === "escalated",
    ) ?? near[0];
  return chosen === undefined ? undefined : { obligation: chosen, exact: false };
}

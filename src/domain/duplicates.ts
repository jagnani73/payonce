import type { Transfer } from "../airwallex/transfers.js";
import type { Ledger, Obligation, ScannedObligation } from "../store/ledger.js";
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
export function numbersOf(obligation: Pick<Obligation, "invoiceId" | "payoutReference">): string[] {
  return [obligation.invoiceId, obligation.payoutReference].filter(
    (reference: string | null): reference is string => reference !== null,
  );
}

function knownAs(obligation: Pick<Obligation, "invoiceId" | "payoutReference">, reference: string): boolean {
  return numbersOf(obligation).some((number: string): boolean => sameInvoiceNumber(number, reference));
}

// Two supplier names are the same supplier when they read the same, case and
// spacing aside. Characters that draw nothing, such as zero-width spaces, soft
// hyphens and bidi controls, are dropped and both are compared in NFKC, so a name
// cannot pass for another supplier's by a character nobody sees. People's names
// are compared by sameName in approvers.ts instead.
export function sameSupplier(a: string, b: string): boolean {
  return supplierNameKey(a) === supplierNameKey(b);
}

// What sameSupplier compares, for grouping many names at once.
export function supplierNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export interface Bill {
  supplier: string;
  beneficiaryId: string;
  currency: string;
  amountMinor: number;
}

// The other beneficiary records that pay the same account as the bill's, which
// a first payment's holds count as the same supplier too. None by default.
const NO_RECORDS: ReadonlySet<string> = new Set<string>();

// The same supplier: the same beneficiary record, the same name, or a record in
// sharing that pays the same account.
function sameSupplierOf(other: Bill, bill: Bill, sharing: ReadonlySet<string>): boolean {
  return (
    other.beneficiaryId === bill.beneficiaryId ||
    sameSupplier(other.supplier, bill.supplier) ||
    sharing.has(other.beneficiaryId)
  );
}

function sameBill(obligation: Bill, bill: Bill, sharing: ReadonlySet<string> = NO_RECORDS): boolean {
  return (
    obligation.currency === bill.currency &&
    obligation.amountMinor === bill.amountMinor &&
    sameSupplierOf(obligation, bill, sharing)
  );
}

// The other beneficiary records the ledger has seen paying the account a first
// payment to this record would go to (route), which the holds count as the same
// supplier. A first payment's holds and a pay run's check both ask it, so a run
// row names before approval what would hold it when it is sent. Empty with no
// route.
export function recordsSharing(ledger: Ledger, beneficiaryId: string, route: string | null): Set<string> {
  const records: Set<string> = route === null ? new Set<string>() : ledger.recordsOnRoute(route);
  records.delete(beneficiaryId);
  return records;
}

// The test likelyDuplicates makes, for two bills that are not in the ledger yet,
// such as two rows of one pay run file. sharing is the records that pay b's
// account.
export function sameBillAndNumber(
  a: Bill & { invoiceId: string },
  b: Bill & { invoiceId: string },
  sharing: ReadonlySet<string> = NO_RECORDS,
): boolean {
  return sameBill(a, b, sharing) && sameInvoiceNumber(a.invoiceId, b.invoiceId);
}

// The other invoices this one may be a second bill for, oldest first: the same
// supplier, by beneficiary, by name or, given sharing, by a record that pays the
// same account, the same amount and currency, and an invoice number
// sameInvoiceNumber matches. An invoice closed without paying as a duplicate is
// left out, since the one it duplicated is listed already.
export function likelyDuplicates(
  ledger: Ledger,
  obligation: ScannedObligation,
  sharing: ReadonlySet<string> = NO_RECORDS,
): ScannedObligation[] {
  return ledger
    .scannedObligations()
    .filter(
      (other: ScannedObligation): boolean =>
        other.invoiceId !== obligation.invoiceId &&
        other.state !== "rejected" &&
        sameBill(other, obligation, sharing) &&
        numbersOf(obligation).some((number: string): boolean => knownAs(other, number)),
    )
    .reverse();
}

// The other invoices to the same supplier, by beneficiary, by name or, given
// sharing, by a record that pays the same account, whose number
// sameInvoiceNumber matches this one's, whatever their amount and currency,
// oldest first. PayOnce pays an invoice number once, so a payment for such an
// invoice waits for a person. Rejected invoices are left out, as in
// likelyDuplicates.
export function sameNumberForSupplier(
  ledger: Ledger,
  obligation: ScannedObligation,
  sharing: ReadonlySet<string> = NO_RECORDS,
): ScannedObligation[] {
  return ledger
    .scannedObligations()
    .filter(
      (other: ScannedObligation): boolean =>
        other.invoiceId !== obligation.invoiceId &&
        other.state !== "rejected" &&
        sameSupplierOf(other, obligation, sharing) &&
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

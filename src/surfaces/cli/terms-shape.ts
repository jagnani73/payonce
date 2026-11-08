import type { ApprovalTerms, RunTerms } from "../../domain/approval.js";
import { validDomain } from "../../intake/eml.js";
import { INVOICE_ID_PATTERN } from "../../store/ledger.js";
import { CURRENCY_PATTERN } from "../../domain/patterns.js";

// The stored approval terms pnpm approve and pnpm payrun print through the views
// and approve, checked field by field in the type and form each is read in.
// Terms that do not parse into their shape were changed outside PayOnce, so the
// commands show and approve nothing for them. The engine and the pay runs check
// the same terms against the shapes in store/stored.ts before they act on them;
// these checks also test the form of each field the commands print.

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isTextOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isMinor(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isMinorOrNull(value: unknown): boolean {
  return value === null || isMinor(value);
}

function isRate(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// Counted one day at a time, so a stored count is kept to a few weeks.
function isDays(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 60);
}

function readableFx(fx: unknown): boolean {
  return (
    isFields(fx) &&
    isText(fx["quoteId"]) &&
    isText(fx["currencyPair"]) &&
    isRate(fx["clientRate"]) &&
    isRate(fx["midRate"]) &&
    isText(fx["sellCurrency"]) &&
    isMinor(fx["sellAmountMinor"]) &&
    isText(fx["buyCurrency"]) &&
    isMinor(fx["buyAmountMinor"]) &&
    isText(fx["validTo"]) &&
    (fx["feeEstimateMinor"] === null || isMinor(fx["feeEstimateMinor"]))
  );
}

function readableArrival(arrival: unknown): boolean {
  return (
    isFields(arrival) &&
    isText(arrival["method"]) &&
    isTextOrNull(arrival["country"]) &&
    isTextOrNull(arrival["route"]) &&
    isDays(arrival["minDays"]) &&
    isDays(arrival["maxDays"]) &&
    isText(arrival["from"]) &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(arrival["from"]) &&
    isTextOrNull(arrival["earliest"]) &&
    isTextOrNull(arrival["latest"]) &&
    isTextOrNull(arrival["dueDate"])
  );
}

// The callback that confirmed new bank details, as the terms carry it.
function readableCallback(callback: unknown): boolean {
  return (
    callback === null ||
    callback === undefined ||
    (isFields(callback) &&
      isText(callback["calledBy"]) &&
      isText(callback["numberCalled"]) &&
      isText(callback["calledAt"]) &&
      isText(callback["spokeTo"]) &&
      isText(callback["confirmed"]))
  );
}

function readableDuplicate(duplicate: unknown): boolean {
  return isFields(duplicate) && isText(duplicate["invoiceId"]) && isText(duplicate["state"]) && isTextOrNull(duplicate["paidBy"]);
}

// Every field pnpm approve prints of an invoice's terms.
export function readableTerms(terms: unknown): terms is ApprovalTerms {
  if (
    !isFields(terms) ||
    !isText(terms["invoiceId"]) ||
    !isMinor(terms["amountMinor"]) ||
    !isText(terms["currency"]) ||
    !isText(terms["payTo"]) ||
    (terms["fx"] !== undefined && !readableFx(terms["fx"])) ||
    (terms["arrival"] !== undefined && !readableArrival(terms["arrival"]))
  ) {
    return false;
  }
  const evidence: unknown = terms["evidence"];
  if (!isFields(evidence) || !isText(evidence["reason"]) || !readableCallback(evidence["bankChange"])) {
    return false;
  }
  if (terms["action"] === "replace") {
    return (
      isText(evidence["originalReference"]) &&
      isText(evidence["originalState"]) &&
      isTextOrNull(evidence["failureCode"]) &&
      isText(evidence["emails"])
    );
  }
  return (
    terms["action"] === "pay" &&
    Array.isArray(evidence["duplicates"]) &&
    evidence["duplicates"].every(readableDuplicate) &&
    (evidence["emails"] === undefined || isText(evidence["emails"])) &&
    (evidence["accountFailure"] === undefined || readableAccountFailure(evidence["accountFailure"]))
  );
}

function readableAccountFailure(failure: unknown): boolean {
  return isFields(failure) && isTextOrNull(failure["reference"]) && isText(failure["failureCode"]);
}

// A run row as pnpm payrun prints it and as the barred list and the domain
// checks read it: its line, invoice, beneficiary, account, callbacks, domain,
// estimate and failed account.
function readableRunRow(row: unknown): boolean {
  return (
    isFields(row) &&
    isMinor(row["line"]) &&
    isText(row["invoiceId"]) &&
    INVOICE_ID_PATTERN.test(row["invoiceId"]) &&
    isText(row["beneficiaryId"]) &&
    isText(row["accountKey"]) &&
    isMinorOrNull(row["bankChange"]) &&
    (row["supplierDomain"] === undefined || (isText(row["supplierDomain"]) && validDomain(row["supplierDomain"]))) &&
    (row["arrival"] === undefined || readableArrival(row["arrival"])) &&
    (row["verifiedBy"] === undefined || isMinor(row["verifiedBy"])) &&
    (row["accountFailure"] === undefined || readableAccountFailure(row["accountFailure"]))
  );
}

function readableRunTotal(total: unknown): boolean {
  return (
    isFields(total) &&
    isText(total["currency"]) &&
    CURRENCY_PATTERN.test(total["currency"]) &&
    isMinor(total["amountMinor"]) &&
    isMinor(total["payments"]) &&
    isMinorOrNull(total["reserveFloorMinor"])
  );
}

// Every field pnpm payrun show and approve print of a run's terms, and every one
// the barred list, the domain checks and the largest total read for them.
export function readableRunTerms(terms: unknown): terms is RunTerms {
  return (
    isFields(terms) &&
    terms["action"] === "run" &&
    isText(terms["uploadedBy"]) &&
    Array.isArray(terms["rows"]) &&
    terms["rows"].every(readableRunRow) &&
    Array.isArray(terms["totals"]) &&
    terms["totals"].every(readableRunTotal)
  );
}

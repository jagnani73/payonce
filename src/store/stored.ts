import { bindingOf, type ApprovalTerms, type FxTerms, type LastQuote, type RunTerms } from "../domain/approval.js";
import type { ArrivalTerms } from "../domain/arrival.js";
import type { EmailAttachment, EmailFindings, SupplierEmail } from "../domain/emails.js";
import type { Approval, RunApproval } from "./approvals.js";
import { checkedObject, storedShape } from "./db.js";
import type { Ledger } from "./ledger.js";

// Stored JSON the engine acts on, checked field by field against every shape
// PayOnce has written it in, before any field is read. A row in another shape was
// changed outside PayOnce, and the look fails closed on it as on one that does
// not parse. A field later versions added is optional only where earlier rows
// lack it.

// What the reader found. unverifiedSenders is kept for display; the policy works
// the sender check out again from the stored emails. unread marks a thread the
// reader failed on. emailsRead is how many emails of the thread were read.
export interface StoredFindings extends EmailFindings {
  unverifiedSenders?: string[];
  unread?: boolean;
  emailsRead?: number;
}

const NO_FINDINGS: StoredFindings = {
  claimsNonReceipt: false,
  asksForNewBankDetails: false,
  asksNotToPay: false,
  summary: "no emails on file",
};

// Emails on file that no look has read yet.
const NOT_READ_FINDINGS: StoredFindings = {
  ...NO_FINDINGS,
  summary: "the emails have not been read yet",
};

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

function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function isFx(fx: unknown): fx is FxTerms {
  return (
    isFields(fx) &&
    isText(fx["quoteId"]) &&
    isText(fx["currencyPair"]) &&
    isNumber(fx["clientRate"]) &&
    isNumber(fx["midRate"]) &&
    isText(fx["sellCurrency"]) &&
    isMinor(fx["sellAmountMinor"]) &&
    isText(fx["buyCurrency"]) &&
    isMinor(fx["buyAmountMinor"]) &&
    isText(fx["validTo"]) &&
    (fx["feeEstimateMinor"] === null || isMinor(fx["feeEstimateMinor"]))
  );
}

function isArrival(arrival: unknown): arrival is ArrivalTerms {
  return (
    isFields(arrival) &&
    isText(arrival["method"]) &&
    isTextOrNull(arrival["country"]) &&
    isTextOrNull(arrival["route"]) &&
    (arrival["minDays"] === null || isNumber(arrival["minDays"])) &&
    (arrival["maxDays"] === null || isNumber(arrival["maxDays"])) &&
    isText(arrival["from"]) &&
    isTextOrNull(arrival["earliest"]) &&
    isTextOrNull(arrival["latest"]) &&
    isTextOrNull(arrival["dueDate"])
  );
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

// A replacement's evidence. The first terms had no email summary, and terms from
// before callbacks no bankChange.
function isReplacementEvidence(evidence: unknown): boolean {
  return (
    isFields(evidence) &&
    isText(evidence["originalReference"]) &&
    isText(evidence["originalState"]) &&
    isTextOrNull(evidence["failureCode"]) &&
    isOptionalText(evidence["emails"]) &&
    isText(evidence["reason"]) &&
    (evidence["bankChange"] === undefined || evidence["bankChange"] === null || isFields(evidence["bankChange"]))
  );
}

function isHeldEvidence(evidence: unknown): boolean {
  return (
    isFields(evidence) &&
    isText(evidence["reason"]) &&
    Array.isArray(evidence["duplicates"]) &&
    evidence["duplicates"].every(isFields) &&
    isOptionalText(evidence["emails"]) &&
    (evidence["bankChange"] === undefined || isFields(evidence["bankChange"]))
  );
}

// A replacement's terms from before PayOnce kept the account have no accountKey.
// Every held payment's terms have one.
export function isApprovalTerms(terms: unknown): terms is ApprovalTerms {
  if (
    !isFields(terms) ||
    !isText(terms["invoiceId"]) ||
    !isMinor(terms["amountMinor"]) ||
    !isText(terms["currency"]) ||
    !isText(terms["beneficiaryId"]) ||
    !isText(terms["payTo"]) ||
    (terms["fx"] !== undefined && !isFx(terms["fx"])) ||
    (terms["arrival"] !== undefined && !isArrival(terms["arrival"]))
  ) {
    return false;
  }
  if (terms["action"] === "replace") {
    return isOptionalText(terms["accountKey"]) && isReplacementEvidence(terms["evidence"]);
  }
  return terms["action"] === "pay" && isText(terms["accountKey"]) && isHeldEvidence(terms["evidence"]);
}

// One pay row of a run's terms. Rows from before PayOnce kept a row's supplier
// domain or its arrival estimate have neither.
function isRunRow(row: unknown): boolean {
  return (
    isFields(row) &&
    isCount(row["line"]) &&
    isText(row["invoiceId"]) &&
    isMinor(row["amountMinor"]) &&
    isText(row["currency"]) &&
    isText(row["beneficiaryId"]) &&
    isText(row["transferMethod"]) &&
    isText(row["payTo"]) &&
    isText(row["accountKey"]) &&
    isTextList(row["heldFor"]) &&
    (row["bankChange"] === null || isCount(row["bankChange"])) &&
    isOptionalText(row["supplierDomain"]) &&
    (row["arrival"] === undefined || isArrival(row["arrival"]))
  );
}

function isRunTotal(total: unknown): boolean {
  return (
    isFields(total) &&
    isText(total["currency"]) &&
    isMinor(total["amountMinor"]) &&
    isCount(total["payments"]) &&
    (total["reserveFloorMinor"] === null || isMinor(total["reserveFloorMinor"]))
  );
}

export function isRunTerms(terms: unknown): terms is RunTerms {
  return (
    isFields(terms) &&
    terms["action"] === "run" &&
    isCount(terms["runId"]) &&
    isText(terms["fileHash"]) &&
    isText(terms["uploadedBy"]) &&
    Array.isArray(terms["rows"]) &&
    terms["rows"].every(isRunRow) &&
    Array.isArray(terms["totals"]) &&
    terms["totals"].every(isRunTotal)
  );
}

export function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText);
}

export function isAttachmentList(value: unknown): value is EmailAttachment[] {
  return (
    Array.isArray(value) &&
    value.every(
      (attachment: unknown): boolean =>
        isFields(attachment) && isText(attachment["name"]) && isText(attachment["type"]) && isCount(attachment["bytes"]),
    )
  );
}

export function isLastQuote(quote: unknown): quote is LastQuote {
  return isFields(quote) && isFx(quote["fx"]) && isNumber(quote["endsAt"]);
}

// Findings saved before PayOnce read a request not to pay have no asksNotToPay,
// and before it counted the emails read, no emailsRead.
export function isStoredFindings(findings: unknown): findings is StoredFindings {
  return (
    isFields(findings) &&
    typeof findings["claimsNonReceipt"] === "boolean" &&
    typeof findings["asksForNewBankDetails"] === "boolean" &&
    (findings["asksNotToPay"] === undefined || typeof findings["asksNotToPay"] === "boolean") &&
    isText(findings["summary"]) &&
    isOptionalText(findings["readBy"]) &&
    (findings["unverifiedSenders"] === undefined ||
      (Array.isArray(findings["unverifiedSenders"]) && findings["unverifiedSenders"].every(isText))) &&
    (findings["unread"] === undefined || typeof findings["unread"] === "boolean") &&
    (findings["emailsRead"] === undefined || isCount(findings["emailsRead"]))
  );
}

// What each read names when it fails. Invoice numbers and request ids are
// PayOnce's own, so they may go on a timeline line.
export function termsOnFile(approval: Pick<Approval, "id" | "invoiceId">): string {
  return `the terms of approval request ${approval.id} for ${approval.invoiceId}`;
}

export function quoteOnFile(invoiceId: string): string {
  return `the last exchange rate quote for ${invoiceId}`;
}

export function findingsOnFile(invoiceId: string): string {
  return `the email findings for ${invoiceId}`;
}

export function runTermsOnFile(approval: Pick<RunApproval, "id" | "runId">): string {
  return `the terms of approval request ${approval.id} for pay run ${approval.runId}`;
}

export function emailsOnFile(invoiceId: string): string {
  return `the emails on file for ${invoiceId}`;
}

// Terms in their shape that still hash to the binding the approvers signed.
// Terms that no longer do were changed outside PayOnce after the request opened,
// so they read as terms PayOnce cannot read, and nothing is spent on them.
function boundTo<T extends ApprovalTerms | RunTerms>(
  binding: string,
  shape: (terms: unknown) => terms is T,
): (terms: unknown) => terms is T {
  return (terms: unknown): terms is T => shape(terms) && bindingOf(terms) === binding;
}

// The terms a request was opened on, read strict wherever it is read, and only
// while they hash to the request's binding.
export function requestTerms(approval: Pick<Approval, "id" | "invoiceId" | "terms" | "binding">): ApprovalTerms {
  return checkedObject(approval.terms, boundTo(approval.binding, isApprovalTerms), termsOnFile(approval));
}

// The terms a pay run's request was opened on, read the same way.
export function runRequestTerms(approval: Pick<RunApproval, "id" | "runId" | "terms" | "binding">): RunTerms {
  return checkedObject(approval.terms, boundTo(approval.binding, isRunTerms), runTermsOnFile(approval));
}

// The stored findings, or what stands for them before anything was read. They are
// read strict, so a look on findings that do not parse, or are not in the shape
// PayOnce writes, throws and pays nothing. Only a view, such as the board's
// pendingClose, reads them soft (readingSoft), and there such findings stand as
// not read.
export function storedFindings(ledger: Ledger, invoiceId: string, emails: SupplierEmail[]): { findings: StoredFindings; stored: boolean } {
  const stored: string | undefined = ledger.findings(invoiceId);
  const findings: StoredFindings | null =
    stored === undefined ? null : storedShape(stored, isStoredFindings, findingsOnFile(invoiceId));
  if (findings !== null) {
    return { findings, stored: true };
  }
  return { findings: emails.length === 0 ? NO_FINDINGS : NOT_READ_FINDINGS, stored: false };
}

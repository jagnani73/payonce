import type { ApprovalTerms, FxTerms, LastQuote } from "../domain/approval.js";
import type { ArrivalTerms } from "../domain/arrival.js";
import type { EmailFindings, SupplierEmail } from "../reader/emails.js";
import type { Approval } from "./approvals.js";
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

// The terms a request was opened on, read strict wherever it is read.
export function requestTerms(approval: Pick<Approval, "id" | "invoiceId" | "terms">): ApprovalTerms {
  return checkedObject(approval.terms, isApprovalTerms, termsOnFile(approval));
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

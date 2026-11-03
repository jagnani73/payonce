import { describeRate, markupOf, type ApprovalTerms, type DuplicateEvidence } from "./approval.js";
import { arrivalAdvice, type ArrivalAdvice } from "./arrival.js";
import { describePolicy, policyFromEnv, type ApprovalPolicy } from "./approvers.js";
import { approvePayment, pendingApproval, type PendingApproval } from "./engine.js";
import { Ledger, LEDGER_PATH, signersOf, type Approval, type Obligation, type Outage } from "./ledger.js";
import { formatMoney } from "./money.js";
import { railOf } from "./outages.js";
import { printable, say, shownFailureCode, shownReference, utcTime } from "./printable.js";

function describeDuplicate(duplicate: DuplicateEvidence): string {
  const paid: string = duplicate.paidBy === null ? "" : `, paid by ${shownReference(duplicate.paidBy)}`;
  return `${printable(duplicate.invoiceId)}, ${duplicate.state}${paid}`;
}

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

function readableDuplicate(duplicate: unknown): boolean {
  return isFields(duplicate) && isText(duplicate["invoiceId"]) && isText(duplicate["state"]) && isTextOrNull(duplicate["paidBy"]);
}

function unreadableText(invoiceId: string, requestId: number | null): string {
  return `${requestId === null ? "The approval request" : `Request ${requestId}`} for ${invoiceId} holds terms PayOnce cannot read, so there is nothing to show or approve`;
}

// Every field show prints, in the type it prints it as. Terms that do not parse
// into their shape were changed outside PayOnce, so nothing is shown for them.
function readableTerms(terms: unknown): terms is ApprovalTerms {
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
  if (!isFields(evidence) || !isText(evidence["reason"])) {
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
    (evidence["emails"] === undefined || isText(evidence["emails"]))
  );
}

function show(pending: PendingApproval): void {
  const terms: ApprovalTerms = pending.terms;
  const approval: Approval = pending.approval;
  say(
    `${terms.action === "replace" ? "Replacement payment for" : "Payment of held invoice"} ${terms.invoiceId}, request ${approval.id}`,
  );
  say(`  pay      ${formatMoney(terms.amountMinor, terms.currency)}`);
  if (terms.fx !== undefined) {
    say(
      `  from     ${formatMoney(terms.fx.sellAmountMinor, terms.fx.sellCurrency)} at ${describeRate(terms.fx)} (${markupOf(terms.fx)} from mid-market ${String(terms.fx.midRate)})`,
    );
    say(
      `  quote    ${printable(terms.fx.quoteId)}, holds until ${utcTime(terms.fx.validTo)}`,
    );
    say(
      `  fee      ${terms.fx.feeEstimateMinor === null ? `charged in ${terms.fx.sellCurrency} when it is sent` : `about ${formatMoney(terms.fx.feeEstimateMinor, terms.fx.sellCurrency)}`}`,
    );
  }
  // The account name and the bank name come from Airwallex, so they print as one line.
  say(`  to       ${printable(terms.payTo)} (the account on file)`);
  if (terms.arrival !== undefined) {
    const advice: ArrivalAdvice = arrivalAdvice(terms.arrival);
    say(`  arrival  ${advice.text}`);
    if (advice.sentToday !== null) {
      say(`           ${advice.sentToday.text}`);
    }
    say(`           ${advice.note}`);
  }
  if (terms.action === "replace") {
    const failure: string =
      terms.evidence.failureCode === null ? "" : ` (${shownFailureCode(terms.evidence.failureCode)})`;
    say(
      `  because  original ${shownReference(terms.evidence.originalReference)} ${terms.evidence.originalState}${failure}: ${terms.evidence.reason}`,
    );
    say(`  emails   ${terms.evidence.emails}`);
  } else {
    say(`  held     ${terms.evidence.reason}`);
    for (const duplicate of terms.evidence.duplicates) {
      say(`  like     ${describeDuplicate(duplicate)}`);
    }
    if (terms.evidence.emails !== undefined) {
      say(`  emails   ${terms.evidence.emails}`);
    }
  }
  say(
    `  needs    ${approval.needed === 1 ? "one approver" : `${approval.needed} approvers, because ${approval.neededWhy}`}`,
  );
  if (approval.signoffs.length > 0) {
    say(`  so far   approved by ${signersOf(approval.signoffs)}`);
  }
  for (const bar of pending.barred) {
    say(`  not      ${printable(bar.name)}, who ${bar.why}`);
  }
  say(
    `  expires  ${approval.expiresAt === null ? "already" : utcTime(approval.expiresAt)}${pending.expired ? " (expired)" : ""}`,
  );
}

// Without a name it only shows the terms. With the request number it showed and
// a name, it records that person's approval of that request, under the approval
// policy. A request opened since is refused, so nobody approves terms they did
// not see.
function main(): void {
  const invoiceId: string | undefined = process.argv[2];
  const requestId: number = Number(process.argv[3]);
  const approver: string | undefined = process.argv.slice(4).join(" ").trim() || undefined;
  if (invoiceId === undefined || (process.argv[3] !== undefined && !Number.isInteger(requestId))) {
    say("Usage: pnpm approve <INVOICE> [REQUEST NAME]");
    process.exitCode = 1;
    return;
  }

  const policy: ApprovalPolicy = policyFromEnv();
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  let pending: PendingApproval | undefined;
  try {
    pending = pendingApproval(ledger, invoiceId);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    say(unreadableText(invoiceId, ledger.latestApproval(invoiceId)?.id ?? null));
    process.exitCode = 1;
    return;
  }
  if (pending === undefined) {
    say(`No approval is waiting for ${invoiceId}`);
    process.exitCode = 1;
    return;
  }
  if (!readableTerms(pending.terms as unknown)) {
    say(unreadableText(invoiceId, pending.approval.id));
    process.exitCode = 1;
    return;
  }

  show(pending);
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  const outage: Outage | undefined =
    obligation === undefined ? undefined : ledger.activeOutage(obligation.currency, obligation.transferMethod);
  if (outage !== undefined) {
    say(
      `  outage   Outage ${outage.id} on ${railOf(outage)} is active. An approval given now is kept until a person ends it and still expires when it would`,
    );
  }
  say(describePolicy(policy));
  // An expired request can no longer be approved, so no command is offered for it.
  if (pending.expired) {
    say("This request has expired. PayOnce opens a new request on its next look, and pnpm approve shows it then");
    if (approver !== undefined) {
      process.exitCode = 1;
    }
    return;
  }
  if (approver === undefined) {
    say(`To approve these terms: pnpm approve ${invoiceId} ${pending.approval.id} <NAME>`);
    return;
  }
  try {
    const after: Approval = approvePayment(
      ledger,
      policy,
      invoiceId,
      approver,
      requestId,
    );
    say(
      after.state === "approved"
        ? "Approved. The approval covers these terms only"
        : `Recorded. It needs ${after.needed - after.signoffs.length} more approver before PayOnce sends it`,
    );
  } catch (error: unknown) {
    say(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();

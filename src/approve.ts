import { describeRate, markupOf, type ApprovalTerms, type DuplicateEvidence } from "./approval.js";
import { arrivalAdvice, type ArrivalAdvice } from "./arrival.js";
import { describePolicy, policyFromEnv, type ApprovalPolicy } from "./approvers.js";
import { approvePayment, pendingApproval, type PendingApproval } from "./engine.js";
import { Ledger, LEDGER_PATH, signersOf, type Approval, type Obligation, type Outage } from "./ledger.js";
import { formatMoney } from "./money.js";
import { railOf } from "./outages.js";
import { printable, say, shownFailureCode, shownReference } from "./printable.js";

function describeDuplicate(duplicate: DuplicateEvidence): string {
  const paid: string = duplicate.paidBy === null ? "" : `, paid by ${shownReference(duplicate.paidBy)}`;
  return `${printable(duplicate.invoiceId)}, ${duplicate.state}${paid}`;
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
      `  quote    ${printable(terms.fx.quoteId)}, holds until ${new Date(terms.fx.validTo).toLocaleString()}`,
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
    `  expires  ${approval.expiresAt === null ? "already" : new Date(approval.expiresAt).toLocaleString()}${pending.expired ? " (expired)" : ""}`,
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
  const pending: PendingApproval | undefined = pendingApproval(ledger, invoiceId);
  if (pending === undefined) {
    say(`No approval is waiting for ${invoiceId}`);
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

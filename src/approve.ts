import type { ApprovalTerms, DuplicateEvidence } from "./approval.js";
import { describePolicy, policyFromEnv, type ApprovalPolicy } from "./approvers.js";
import { approvePayment, pendingApproval, type PendingApproval } from "./engine.js";
import { Ledger, LEDGER_PATH, signersOf, type Approval } from "./ledger.js";
import { formatMoney } from "./money.js";

function describeDuplicate(duplicate: DuplicateEvidence): string {
  const paid: string = duplicate.paidBy === null ? "" : `, paid by ${duplicate.paidBy}`;
  return `${duplicate.invoiceId}, ${duplicate.state}${paid}`;
}

function show(pending: PendingApproval): void {
  const terms: ApprovalTerms = pending.terms;
  const approval: Approval = pending.approval;
  console.log(
    `${terms.action === "replace" ? "Replacement payment for" : "Payment of held invoice"} ${terms.invoiceId}, request ${approval.id}`,
  );
  console.log(`  pay      ${formatMoney(terms.amountMinor, terms.currency)}`);
  console.log(`  to       ${terms.payTo} (the account on file)`);
  if (terms.action === "replace") {
    const failure: string =
      terms.evidence.failureCode === null ? "" : ` (${terms.evidence.failureCode})`;
    console.log(
      `  because  original ${terms.evidence.originalReference} ${terms.evidence.originalState}${failure}: ${terms.evidence.reason}`,
    );
    console.log(`  emails   ${terms.evidence.emails}`);
  } else {
    console.log(`  held     ${terms.evidence.reason}`);
    for (const duplicate of terms.evidence.duplicates) {
      console.log(`  like     ${describeDuplicate(duplicate)}`);
    }
  }
  console.log(
    `  needs    ${approval.needed === 1 ? "one approver" : `${approval.needed} approvers, because ${approval.neededWhy}`}`,
  );
  if (approval.signoffs.length > 0) {
    console.log(`  so far   approved by ${signersOf(approval.signoffs)}`);
  }
  for (const bar of pending.barred) {
    console.log(`  not      ${bar.name}, who ${bar.why}`);
  }
  console.log(
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
    console.log("Usage: pnpm approve <INVOICE> [REQUEST NAME]");
    process.exitCode = 1;
    return;
  }

  const policy: ApprovalPolicy = policyFromEnv();
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  const pending: PendingApproval | undefined = pendingApproval(ledger, invoiceId);
  if (pending === undefined) {
    console.log(`No approval is waiting for ${invoiceId}`);
    process.exitCode = 1;
    return;
  }

  show(pending);
  console.log(describePolicy(policy));
  if (approver === undefined) {
    console.log(`To approve these terms: pnpm approve ${invoiceId} ${pending.approval.id} <NAME>`);
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
    console.log(
      after.state === "approved"
        ? "Approved. The approval covers these terms only"
        : `Recorded. It needs ${after.needed - after.signoffs.length} more approver before PayOnce sends it`,
    );
  } catch (error: unknown) {
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();

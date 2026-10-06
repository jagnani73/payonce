import type { ApprovalTerms } from "./approval.js";
import { approveReplacement, pendingApproval } from "./engine.js";
import { Ledger, LEDGER_PATH } from "./ledger.js";
import { formatMoney } from "./money.js";

function show(terms: ApprovalTerms): void {
  const failure: string =
    terms.evidence.failureCode === null ? "" : ` (${terms.evidence.failureCode})`;
  console.log(`Replacement payment for ${terms.invoiceId}`);
  console.log(`  pay      ${formatMoney(terms.amountMinor, terms.currency)}`);
  console.log(`  to       ${terms.payTo} (the account on file)`);
  console.log(
    `  because  original ${terms.evidence.originalReference} ${terms.evidence.originalState}${failure}: ${terms.evidence.reason}`,
  );
  console.log(`  emails   ${terms.evidence.emails}`);
}

// Without a name it only shows the terms. With a name it approves the request
// that was just shown.
function main(): void {
  const invoiceId: string | undefined = process.argv[2];
  const approver: string | undefined = process.argv[3];
  if (invoiceId === undefined) {
    console.log("Usage: pnpm approve <INVOICE> [NAME]");
    process.exitCode = 1;
    return;
  }

  const ledger: Ledger = new Ledger(LEDGER_PATH);
  const pending: { id: number; terms: ApprovalTerms } | undefined = pendingApproval(
    ledger,
    invoiceId,
  );
  if (pending === undefined) {
    console.log(`No approval is waiting for ${invoiceId}`);
    process.exitCode = 1;
    return;
  }

  show(pending.terms);
  if (approver === undefined) {
    console.log(`To approve these terms: pnpm approve ${invoiceId} <NAME>`);
    return;
  }
  approveReplacement(ledger, invoiceId, approver, pending.id);
  console.log("The approval covers these terms only");
}

main();

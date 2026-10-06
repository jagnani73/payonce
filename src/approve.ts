import type { ApprovalTerms } from "./approval.js";
import { Ledger, LEDGER_PATH, type Approval } from "./ledger.js";
import { toMajor } from "./money.js";

function main(): void {
  const invoiceId: string | undefined = process.argv[2];
  const approver: string | undefined = process.argv[3];
  if (invoiceId === undefined || approver === undefined) {
    console.log("Usage: pnpm approve <INVOICE> <NAME>");
    process.exitCode = 1;
    return;
  }

  const ledger: Ledger = new Ledger(LEDGER_PATH);
  const approval: Approval | undefined = ledger.latestApproval(invoiceId);
  if (approval === undefined || approval.state !== "requested") {
    console.log(`No approval is waiting for ${invoiceId}`);
    process.exitCode = 1;
    return;
  }

  const terms: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  const failure: string =
    terms.evidence.failureCode === null ? "" : ` (${terms.evidence.failureCode})`;
  console.log(`Replacement payment for ${terms.invoiceId}`);
  console.log(`  pay      ${toMajor(terms.amountMinor)} ${terms.currency}`);
  console.log(`  to       ${terms.payTo} (the account on file)`);
  console.log(
    `  because  original ${terms.evidence.originalReference} ${terms.evidence.originalState}${failure}: ${terms.evidence.reason}`,
  );
  console.log(`  emails   ${terms.evidence.emails}`);

  ledger.setApprovalState(approval.id, "approved", approver);
  console.log(`Approved by ${approver}. The approval covers these terms only`);
}

main();

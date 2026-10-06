import type { ApprovalTerms } from "./approval.js";
import { approveReplacement } from "./engine.js";
import { Ledger, LEDGER_PATH } from "./ledger.js";
import { formatMoney } from "./money.js";

function main(): void {
  const invoiceId: string | undefined = process.argv[2];
  const approver: string | undefined = process.argv[3];
  if (invoiceId === undefined || approver === undefined) {
    console.log("Usage: pnpm approve <INVOICE> <NAME>");
    process.exitCode = 1;
    return;
  }

  let terms: ApprovalTerms;
  try {
    terms = approveReplacement(new Ledger(LEDGER_PATH), invoiceId, approver);
  } catch (error: unknown) {
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const failure: string =
    terms.evidence.failureCode === null ? "" : ` (${terms.evidence.failureCode})`;
  console.log(`Replacement payment for ${terms.invoiceId}`);
  console.log(`  pay      ${formatMoney(terms.amountMinor, terms.currency)}`);
  console.log(`  to       ${terms.payTo} (the account on file)`);
  console.log(
    `  because  original ${terms.evidence.originalReference} ${terms.evidence.originalState}${failure}: ${terms.evidence.reason}`,
  );
  console.log(`  emails   ${terms.evidence.emails}`);
  console.log("The approval covers these terms only");
}

main();

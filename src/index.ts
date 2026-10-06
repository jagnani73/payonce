import { decide } from "./decide.js";
import {
  loadEmails,
  unverifiedSenders,
  type EmailFindings,
  type EmailReader,
  type SupplierEmail,
} from "./emails.js";
import type { Decision, Incident, OriginalTransferState } from "./incident.js";
import { KeywordReader } from "./keyword-reader.js";

const INVOICE_ID: string = "INV-1042";
const SUPPLIER_DOMAIN: string = "example-supplier.test";

interface Sample {
  label: string;
  emails: string;
  originalState: OriginalTransferState;
  resendCanFix: boolean;
}

const samples: Sample[] = [
  {
    label: "original still in flight",
    emails: "nothing-arrived",
    originalState: "in_flight",
    resendCanFix: false,
  },
  {
    label: "original timed out on the sending side",
    emails: "nothing-arrived",
    originalState: "failed",
    resendCanFix: true,
  },
  {
    label: "supplier asks for a new account",
    emails: "new-account",
    originalState: "failed",
    resendCanFix: true,
  },
];

const reader: EmailReader = new KeywordReader();

for (const sample of samples) {
  const emails: SupplierEmail[] = loadEmails(sample.emails, INVOICE_ID);
  const findings: EmailFindings = await reader.read(emails);
  const unverified: string[] = unverifiedSenders(emails, SUPPLIER_DOMAIN);
  const incident: Incident = {
    invoiceId: INVOICE_ID,
    supplier: "Example Supplier LLC",
    currency: "USD",
    amountMinor: 400_000,
    transferFeeMinor: 0,
    originalState: sample.originalState,
    resendCanFix: sample.resendCanFix,
    supplierAsksForNewBankDetails: findings.asksForNewBankDetails,
    emailFromUnverifiedSender: unverified.length > 0,
    evidenceConflicts: false,
    availableBalanceMinor: 2_500_000,
    reserveFloorMinor: 1_000_000,
  };
  const decision: Decision = decide(incident);
  console.log(sample.label);
  console.log(`  emails: ${findings.summary}`);
  if (unverified.length > 0) {
    console.log(`  sender not on file: ${unverified.join(", ")}`);
  }
  console.log(`  decision: ${decision.action} (${decision.reason})`);
}

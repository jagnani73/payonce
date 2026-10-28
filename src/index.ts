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

const RESERVE_FLOOR_MINOR: number = 1_000_000;

interface Sample {
  label: string;
  emails: string;
  originalState: OriginalTransferState;
  resendCanFix: boolean;
  // Null when RESERVE_FLOORS sets no floor for the currency.
  reserveFloorMinor: number | null;
  // Approved payments on other invoices that have not been sent yet.
  committedMinor: number;
}

const samples: Sample[] = [
  {
    label: "original still in flight",
    emails: "nothing-arrived",
    originalState: "in_flight",
    resendCanFix: false,
    reserveFloorMinor: RESERVE_FLOOR_MINOR,
    committedMinor: 0,
  },
  {
    label: "original timed out on the sending side",
    emails: "nothing-arrived",
    originalState: "failed",
    resendCanFix: true,
    reserveFloorMinor: RESERVE_FLOOR_MINOR,
    committedMinor: 0,
  },
  {
    label: "supplier asks for a new account",
    emails: "new-account",
    originalState: "failed",
    resendCanFix: true,
    reserveFloorMinor: RESERVE_FLOOR_MINOR,
    committedMinor: 0,
  },
  {
    label: "bank reports the original as paid",
    emails: "nothing-arrived",
    originalState: "paid",
    resendCanFix: false,
    reserveFloorMinor: RESERVE_FLOOR_MINOR,
    committedMinor: 0,
  },
  {
    label: "original timed out, no reserve floor set for USD",
    emails: "nothing-arrived",
    originalState: "failed",
    resendCanFix: true,
    reserveFloorMinor: null,
    committedMinor: 0,
  },
  {
    label: "original timed out, other approved payments leave too little cash",
    emails: "nothing-arrived",
    originalState: "failed",
    resendCanFix: true,
    reserveFloorMinor: RESERVE_FLOOR_MINOR,
    committedMinor: 1_200_000,
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
    bankOverdue: false,
    resendCanFix: sample.resendCanFix,
    sentOutsidePayOnce: false,
    outsidePayoutLive: false,
    replacementFailed: false,
    supplierReportsNonReceipt: findings.claimsNonReceipt,
    supplierAsksForNewBankDetails: findings.asksForNewBankDetails,
    beneficiaryChanged: false,
    emailFromUnverifiedSender: unverified.length > 0,
    emailsUnread: false,
    availableBalanceMinor: 2_500_000,
    committedMinor: sample.committedMinor,
    reserveFloorMinor: sample.reserveFloorMinor,
    twoApproversAboveMinor: 500_000,
  };
  const decision: Decision = decide(incident);
  console.log(sample.label);
  console.log(`  emails: ${findings.summary}`);
  if (unverified.length > 0) {
    console.log(`  sender not on file: ${unverified.join(", ")}`);
  }
  console.log(`  decision: ${decision.action} (${decision.reason})`);
}

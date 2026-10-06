import { decide } from "./decide.js";
import { loadEmails, type EmailFindings, type EmailReader } from "./emails.js";
import type { Decision, Incident, OriginalTransferState } from "./incident.js";
import { KeywordReader } from "./keyword-reader.js";

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
  const findings: EmailFindings = await reader.read(loadEmails(sample.emails));
  const incident: Incident = {
    invoiceId: "INV-1042",
    supplier: "Example Supplier LLC",
    currency: "USD",
    amountMinor: 400_000,
    transferFeeMinor: 0,
    originalState: sample.originalState,
    resendCanFix: sample.resendCanFix,
    supplierAsksForNewBankDetails: findings.asksForNewBankDetails,
    evidenceConflicts: false,
    availableBalanceMinor: 2_500_000,
    reserveFloorMinor: 1_000_000,
  };
  const decision: Decision = decide(incident);
  console.log(sample.label);
  console.log(`  emails: ${findings.summary}`);
  console.log(`  decision: ${decision.action} (${decision.reason})`);
}

import { decide } from "./decide.js";
import type { Decision, Incident } from "./incident.js";

interface Sample {
  label: string;
  incident: Incident;
}

const base: Incident = {
  invoiceId: "INV-1042",
  supplier: "Example Supplier GmbH",
  currency: "EUR",
  amountMinor: 400000,
  transferFeeMinor: 1285,
  originalState: "in_flight",
  resendCanFix: false,
  supplierAsksForNewBankDetails: false,
  evidenceConflicts: false,
  availableBalanceMinor: 2500000,
  reserveFloorMinor: 1000000,
};

const samples: Sample[] = [
  { label: "original still in flight", incident: base },
  {
    label: "original timed out on the sending side",
    incident: { ...base, originalState: "failed", resendCanFix: true },
  },
  {
    label: "supplier asks for a new account",
    incident: {
      ...base,
      invoiceId: "INV-1043",
      originalState: "failed",
      resendCanFix: true,
      supplierAsksForNewBankDetails: true,
    },
  },
];

for (const sample of samples) {
  const decision: Decision = decide(sample.incident);
  console.log(`${sample.label}: ${decision.action} (${decision.reason})`);
}

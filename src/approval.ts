import { createHash } from "node:crypto";
import type { Transfer, TransferBankDetails } from "./airwallex/transfers.js";
import { originalStateOf } from "./assess.js";
import type { Decision, OriginalTransferState } from "./incident.js";
import type { Obligation } from "./ledger.js";

export interface ApprovalEvidence {
  originalReference: string;
  originalState: OriginalTransferState;
  failureCode: string | null;
  emails: string;
  reason: string;
}

// What a person is shown and what their approval covers. Always build it with
// termsFor so the key order, and with it the binding, stays stable.
export interface ApprovalTerms {
  action: "replace";
  invoiceId: string;
  amountMinor: number;
  currency: string;
  beneficiaryId: string;
  payTo: string;
  evidence: ApprovalEvidence;
}

function payTo(obligation: Obligation, details: TransferBankDetails): string {
  const parts: string[] = [details.account_name ?? obligation.supplier];
  if (details.bank_name !== undefined) {
    parts.push(details.bank_name);
  }
  const account: string | undefined = details.account_number ?? details.iban;
  if (account !== undefined) {
    parts.push(`account ending ${account.slice(-4)}`);
  }
  return parts.join(", ");
}

// bankDetails is what the beneficiary record holds now, which is where a new
// transfer would go. It is not taken from the original transfer.
export function termsFor(
  obligation: Obligation,
  original: Transfer,
  decision: Decision,
  emailSummary: string,
  bankDetails: TransferBankDetails,
): ApprovalTerms {
  return {
    action: "replace",
    invoiceId: obligation.invoiceId,
    amountMinor: obligation.amountMinor,
    currency: obligation.currency,
    beneficiaryId: obligation.beneficiaryId,
    payTo: payTo(obligation, bankDetails),
    evidence: {
      originalReference: original.short_reference_id,
      originalState: originalStateOf(original),
      failureCode: original.failure?.code ?? null,
      emails: emailSummary,
      reason: decision.reason,
    },
  };
}

export function bindingOf(terms: ApprovalTerms): string {
  return createHash("sha256").update(JSON.stringify(terms)).digest("hex");
}

export function changedFields(
  approved: ApprovalTerms,
  current: ApprovalTerms,
): string[] {
  const changed: string[] = [];
  if (approved.amountMinor !== current.amountMinor) {
    changed.push("amount");
  }
  if (approved.currency !== current.currency) {
    changed.push("currency");
  }
  if (
    approved.beneficiaryId !== current.beneficiaryId ||
    approved.payTo !== current.payTo
  ) {
    changed.push("beneficiary");
  }
  if (JSON.stringify(approved.evidence) !== JSON.stringify(current.evidence)) {
    changed.push("evidence");
  }
  return changed;
}

import { createHash } from "node:crypto";
import type { Transfer, TransferBankDetails } from "./airwallex/transfers.js";
import { bankDetailsKey, originalStateOf } from "./assess.js";
import type { Decision, OriginalTransferState } from "./incident.js";
import type { BankChange, Obligation, ObligationState } from "./ledger.js";

// The callback that verified the bank details the payment goes to, when they are
// not the ones the original went to.
export interface BankChangeEvidence {
  id: number;
  invoiceId: string;
  calledBy: string;
  numberCalled: string;
  calledAt: string;
  spokeTo: string;
  confirmed: string;
}

export interface ApprovalEvidence {
  originalReference: string;
  originalState: OriginalTransferState;
  failureCode: string | null;
  emails: string;
  reason: string;
  bankChange: BankChangeEvidence | null;
}

// An invoice a held one looks like a second bill for, as it stood when the terms
// were built. paidBy is the bank's reference for the payment that paid it, or
// null. sameAccount says whether that payment, or else one still with the bank,
// went to the account this one would, and is null when there is neither.
export interface DuplicateEvidence {
  invoiceId: string;
  state: ObligationState;
  paidBy: string | null;
  sameAccount: boolean | null;
}

export interface HeldEvidence {
  reason: string;
  duplicates: DuplicateEvidence[];
}

interface PaymentTerms {
  invoiceId: string;
  amountMinor: number;
  currency: string;
  beneficiaryId: string;
  payTo: string;
  // A hash of every bank detail the payment goes to. payTo shows only part of the
  // account, so this is what pins it.
  accountKey: string;
}

// A second payment for an invoice whose original failed.
export interface ReplacementTerms extends PaymentTerms {
  action: "replace";
  evidence: ApprovalEvidence;
}

// The first payment for an invoice PayOnce held before paying, because it looks
// like a second bill for one the ledger already has.
export interface HeldPaymentTerms extends PaymentTerms {
  action: "pay";
  evidence: HeldEvidence;
}

// What a person is shown and what their approval covers. Always build it with
// termsFor or heldTermsFor so the key order, and with it the binding, stays
// stable.
export type ApprovalTerms = ReplacementTerms | HeldPaymentTerms;

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
// transfer would go. It is not taken from the original transfer. bankChange is
// the callback that verified those details, if they changed.
export function termsFor(
  obligation: Obligation,
  original: Transfer,
  decision: Decision,
  emailSummary: string,
  bankDetails: TransferBankDetails,
  bankChange: BankChange | null,
): ReplacementTerms {
  return {
    action: "replace",
    invoiceId: obligation.invoiceId,
    amountMinor: obligation.amountMinor,
    currency: obligation.currency,
    beneficiaryId: obligation.beneficiaryId,
    payTo: payTo(obligation, bankDetails),
    accountKey: accountKeyOf(bankDetails),
    evidence: {
      originalReference: original.short_reference_id,
      originalState: originalStateOf(original),
      failureCode: original.failure?.code ?? null,
      emails: emailSummary,
      reason: decision.reason,
      bankChange:
        bankChange === null
          ? null
          : {
              id: bankChange.id,
              invoiceId: bankChange.invoiceId,
              calledBy: bankChange.calledBy,
              numberCalled: bankChange.numberCalled,
              calledAt: bankChange.calledAt,
              spokeTo: bankChange.spokeTo,
              confirmed: bankChange.confirmed,
            },
    },
  };
}

// bankDetails is what the beneficiary record holds now, which is where the payment
// would go.
export function heldTermsFor(
  obligation: Obligation,
  bankDetails: TransferBankDetails,
  duplicates: DuplicateEvidence[],
): HeldPaymentTerms {
  return {
    action: "pay",
    invoiceId: obligation.invoiceId,
    amountMinor: obligation.amountMinor,
    currency: obligation.currency,
    beneficiaryId: obligation.beneficiaryId,
    payTo: payTo(obligation, bankDetails),
    accountKey: accountKeyOf(bankDetails),
    evidence: {
      reason: obligation.escalationReason,
      duplicates,
    },
  };
}

// The accountKey for bank details already written by bankDetailsKey.
export function keyHash(detailsKey: string): string {
  return createHash("sha256").update(detailsKey).digest("hex").slice(0, 16);
}

export function accountKeyOf(details: TransferBankDetails | undefined): string {
  return keyHash(bankDetailsKey(details));
}

export function bindingOf(terms: ApprovalTerms): string {
  return createHash("sha256").update(JSON.stringify(terms)).digest("hex");
}

export function changedFields(
  approved: ApprovalTerms,
  current: ApprovalTerms,
): string[] {
  const changed: string[] = [];
  if (approved.action !== current.action) {
    changed.push("payment");
  }
  if (approved.amountMinor !== current.amountMinor) {
    changed.push("amount");
  }
  if (approved.currency !== current.currency) {
    changed.push("currency");
  }
  if (
    approved.beneficiaryId !== current.beneficiaryId ||
    approved.payTo !== current.payTo ||
    approved.accountKey !== current.accountKey
  ) {
    changed.push("beneficiary");
  }
  if (JSON.stringify(approved.evidence) !== JSON.stringify(current.evidence)) {
    changed.push("evidence");
  }
  return changed;
}

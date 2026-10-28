export type OriginalTransferState = "in_flight" | "paid" | "failed" | "unknown";

export interface Incident {
  invoiceId: string;
  supplier: string;
  currency: string;
  amountMinor: number;
  transferFeeMinor: number;
  originalState: OriginalTransferState;
  // The original is still in flight past the deadline for its transfer method.
  bankOverdue: boolean;
  resendCanFix: boolean;
  // Someone outside PayOnce sent the original, so they may be resending it too.
  sentOutsidePayOnce: boolean;
  // A payout for this invoice sent outside PayOnce is in flight or paid.
  outsidePayoutLive: boolean;
  replacementFailed: boolean;
  supplierReportsNonReceipt: boolean;
  supplierAsksForNewBankDetails: boolean;
  beneficiaryChanged: boolean;
  emailFromUnverifiedSender: boolean;
  emailsUnread: boolean;
  availableBalanceMinor: number;
  reserveFloorMinor: number;
  // Above this amount the approval policy needs two approvers.
  twoApproversAboveMinor: number;
}

export type Action = "wait" | "replace" | "escalate" | "close";

export interface Decision {
  action: Action;
  reason: string;
}

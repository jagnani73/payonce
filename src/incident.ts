export type OriginalTransferState = "in_flight" | "paid" | "failed" | "unknown";

export interface Incident {
  invoiceId: string;
  supplier: string;
  currency: string;
  amountMinor: number;
  // The invoice is paid from another currency's wallet, so each payment converts
  // on a quote a person approves.
  crossCurrency: boolean;
  // The wallet a payment leaves, and what a replacement takes from it before the
  // fee: the quote's sell amount when it converts, else amountMinor. NaN when no
  // quote was read. Limits, the floor and the fee are in this currency.
  sourceCurrency: string;
  sourceAmountMinor: number;
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
  // The supplier asked to hold, cancel or not pay the invoice.
  supplierAsksNotToPay: boolean;
  beneficiaryChanged: boolean;
  emailFromUnverifiedSender: boolean;
  emailsUnread: boolean;
  // An email on file has text nobody read, such as text past the cut, an
  // attachment of text or a part in a charset PayOnce cannot decode.
  emailPartlyUnread: boolean;
  availableBalanceMinor: number;
  // Money promised to other payments from the same wallet that has not left the
  // available balance yet: payments being sent and approvals not used yet.
  committedMinor: number;
  // Null when no floor is set for the currency. NaN when RESERVE_FLOORS could not
  // be read.
  reserveFloorMinor: number | null;
  // Above this amount the approval policy needs two approvers.
  twoApproversAboveMinor: number;
}

export type Action = "wait" | "replace" | "escalate" | "close";

export interface Decision {
  action: Action;
  reason: string;
}

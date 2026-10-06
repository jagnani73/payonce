export type OriginalTransferState = "in_flight" | "paid" | "failed";

export interface Incident {
  invoiceId: string;
  supplier: string;
  currency: string;
  amountMinor: number;
  transferFeeMinor: number;
  originalState: OriginalTransferState;
  resendCanFix: boolean;
  supplierAsksForNewBankDetails: boolean;
  evidenceConflicts: boolean;
  availableBalanceMinor: number;
  reserveFloorMinor: number;
}

export type Action = "wait" | "replace" | "escalate";

export interface Decision {
  action: Action;
  reason: string;
}

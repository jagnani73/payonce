import type { Transfer, TransferBankDetails } from "./airwallex/transfers.js";
import type { OriginalTransferState } from "./incident.js";
import type { AttemptState } from "./ledger.js";
import { readMinor } from "./money.js";

export interface Fee {
  minor: number;
  currency: string;
}

export interface Debit {
  minor: number;
  currency: string;
}

const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set<string>([
  "SCHEDULED",
  "PROCESSING",
  "SENT",
]);

const FAILED_STATUSES: ReadonlySet<string> = new Set<string>([
  "FAILED",
  "CANCELLED",
]);

// 91401 system error, 91402 channel timeout. Both fail on the sending side, so the
// beneficiary details were never rejected and the same payment can be sent again.
// The sandbox reports failure.details.type as INCORRECT_ROUTING for every failure,
// so the code is the only field worth reading.
const RESENDABLE_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  "91401",
  "91402",
]);

export function originalStateOf(transfer: Transfer): OriginalTransferState {
  if (IN_FLIGHT_STATUSES.has(transfer.status)) {
    return "in_flight";
  }
  if (transfer.status === "PAID") {
    return "paid";
  }
  if (FAILED_STATUSES.has(transfer.status)) {
    return "failed";
  }
  return "unknown";
}

// Null means the status is not recognised, so the ledger keeps what it had.
export function attemptStateOf(transfer: Transfer): AttemptState | null {
  const state: OriginalTransferState = originalStateOf(transfer);
  return state === "unknown" ? null : state;
}

// What the payer paid Airwallex for a transfer, for the ledger and the cash panel.
// A fee the beneficiary pays costs the payer nothing. Null when the fee cannot be
// read, so recording a transfer never fails on it.
export function feeOf(transfer: Transfer): Fee | null {
  const currency: string = transfer.fee_currency ?? transfer.transfer_currency;
  if (transfer.fee_paid_by === "BENEFICIARY") {
    return { minor: 0, currency };
  }
  const minor: number | null = readMinor(transfer.fee_amount);
  return minor === null ? null : { minor, currency };
}

// What a transfer took from the wallet, before its fee: the source amount in the
// source currency when it was paid from another currency, and otherwise the
// transfer amount. Null when that cannot be read.
export function debitOf(transfer: Transfer): Debit | null {
  const source: string | undefined = transfer.source_currency;
  if (source !== undefined && source !== transfer.transfer_currency) {
    const minor: number | null = readMinor(transfer.source_amount);
    return minor === null ? null : { minor, currency: source };
  }
  const minor: number | null = readMinor(transfer.transfer_amount);
  return minor === null ? null : { minor, currency: transfer.transfer_currency };
}

// The bank details as one string, the same whatever order Airwallex sends the
// fields in.
export function bankDetailsKey(details: TransferBankDetails | undefined): string {
  return JSON.stringify(
    Object.entries(details ?? {}).sort(
      ([a]: [string, unknown], [b]: [string, unknown]): number => a.localeCompare(b),
    ),
  );
}

// True when a new transfer would go to the same account the original went to.
// Any difference counts, so a change Airwallex makes to its own formatting
// escalates and does not slip through.
export function sameBankDetails(
  original: TransferBankDetails | undefined,
  current: TransferBankDetails,
): boolean {
  return original !== undefined && bankDetailsKey(original) === bankDetailsKey(current);
}

export function resendCanFix(transfer: Transfer): boolean {
  const code: string | undefined = transfer.failure?.code;
  return code !== undefined && RESENDABLE_FAILURE_CODES.has(code);
}

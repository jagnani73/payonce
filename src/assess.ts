import type { Transfer, TransferBankDetails } from "./airwallex/transfers.js";
import type { OriginalTransferState } from "./incident.js";
import type { AttemptState } from "./ledger.js";

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

function canonical(details: TransferBankDetails | undefined): string {
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
  return original !== undefined && canonical(original) === canonical(current);
}

export function resendCanFix(transfer: Transfer): boolean {
  const code: string | undefined = transfer.failure?.code;
  return code !== undefined && RESENDABLE_FAILURE_CODES.has(code);
}

import type { TransferMethod } from "../store/ledger.js";

// The forms PayOnce takes a value from Airwallex or the ledger in before it
// shows or passes it on. A value in any other form is left out or put in
// PayOnce's words instead. Each source is the form alone, for a longer pattern
// to be built from, and each pattern matches a whole value.

// Airwallex's short reference for a transfer.
export const REFERENCE_SOURCE: string = "[A-Z0-9-]{1,30}";
export const CURRENCY_SOURCE: string = "[A-Z]{3}";
// A bank failure code or an Airwallex error code.
export const FAILURE_CODE_SOURCE: string = "[A-Za-z0-9_]{1,40}";
// A transfer's status, such as PAID.
export const STATUS_SOURCE: string = "[A-Z_]{1,30}";
export const TRANSFER_METHODS: readonly TransferMethod[] = ["LOCAL", "SWIFT"];
export const METHOD_SOURCE: string = TRANSFER_METHODS.join("|");
// An Airwallex beneficiary id, as a pay run file or a form gives it.
export const BENEFICIARY_ID_PATTERN: RegExp = /^[A-Za-z0-9-]{1,64}$/;

export const REFERENCE_PATTERN: RegExp = whole(REFERENCE_SOURCE);
export const CURRENCY_PATTERN: RegExp = whole(CURRENCY_SOURCE);
export const FAILURE_CODE_PATTERN: RegExp = whole(FAILURE_CODE_SOURCE);
export const STATUS_PATTERN: RegExp = whole(STATUS_SOURCE);
export const METHOD_PATTERN: RegExp = whole(`(?:${METHOD_SOURCE})`);
// A rail: a currency and a transfer method, such as "USD LOCAL".
export const RAIL_PATTERN: RegExp = whole(`${CURRENCY_SOURCE} [A-Z_]{1,20}`);

// The Dispatcher key for a run's steps. A colon cannot be in an invoice number, so
// it never names an invoice.
export function runKey(runId: number): string {
  return `run:${runId}`;
}

function whole(source: string): RegExp {
  return new RegExp(`^${source}$`);
}

import { createHash } from "node:crypto";
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

// The statuses in which the bank has failed a transfer. The ledger's LIVE_ATTEMPT
// is built from this list, so SQL and code read a status the same way.
export const FAILED_STATUS_LIST: readonly string[] = ["FAILED", "CANCELLED"];

const FAILED_STATUSES: ReadonlySet<string> = new Set<string>(FAILED_STATUS_LIST);

// 91401 system error, 91402 channel timeout. Both fail on the sending side, so the
// beneficiary details were never rejected and the same payment can be sent again.
// The sandbox reports failure.details.type as INCORRECT_ROUTING for every failure,
// so the code is the only field worth reading.
export const RESENDABLE_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
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

// True for a status in which the bank has failed the transfer.
export function failedStatus(status: string): boolean {
  return FAILED_STATUSES.has(status);
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

// A short hash of a key string: the accountKey of bank details written by
// bankDetailsKey, or a routeKey.
export function keyHash(detailsKey: string): string {
  return createHash("sha256").update(detailsKey).digest("hex").slice(0, 16);
}

// The bank details fields known not to change where money goes, so a change to
// one alone is not another account. Every other field counts, a field Airwallex
// adds later included. bank_name is here because Airwallex rewrites it from the
// routing number when a record is updated (seen on 2026-10-28: "Bank of America"
// became "Bank of America, NA"), and the routing number, not the name, says
// where the money goes. A field joins this list only with evidence that it
// cannot route money, said here.
export const NOT_ROUTING_FIELDS: ReadonlySet<string> = new Set<string>(["bank_name"]);

// A field as the route compares it: Airwallex may change case or spacing when it
// stores a value.
export function routeValue(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, "").toUpperCase() : "";
}

// The scheme routeKeyOf builds keys with, as a prefix on every key. A stored key
// with another prefix, or none, was built by another scheme and is not known
// (knownRoute): no test ever matches it as a route. Change it whenever routeKeyOf
// or NOT_ROUTING_FIELDS change, and the next open rebuilds the stored keys from
// the bank details the ledger keeps and clears the rest (Ledger.rebuildRoutes).
export const ROUTE_SCHEME: string = "r2";

// A stored routeKey when this scheme built it, or null when it is not known.
export function knownRoute(key: string | null | undefined): string | null {
  return typeof key === "string" && key.startsWith(`${ROUTE_SCHEME}:`) ? key : null;
}

// The key of where money sent to these bank details goes: a hash of every field
// but NOT_ROUTING_FIELDS, deny by default, in name order, each string read as
// routeValue reads it. The tests that would otherwise stop a supplier being paid
// after a bank name changed compare it (see sameBankDetails, Ledger.holdsAccount
// and verifiedBankChange). An account an approval or a decision pinned is still
// compared by its full accountKey.
export function routeKeyOf(details: TransferBankDetails | undefined): string {
  return `${ROUTE_SCHEME}:` + keyHash(
    JSON.stringify(
      Object.entries(details ?? {})
        .filter(([field]: [string, unknown]): boolean => !NOT_ROUTING_FIELDS.has(field))
        .sort(([a]: [string, unknown], [b]: [string, unknown]): number => a.localeCompare(b))
        .map(([field, value]: [string, unknown]): [string, unknown] => [
          field,
          typeof value === "string" ? routeValue(value) : value,
        ]),
    ),
  );
}

// The routeKey of bank details stored as bankDetailsKey writes them, as a
// callback's applied_key keeps them, or null when they cannot be read.
export function routeOfDetailsKey(detailsKey: string): string | null {
  try {
    const entries: unknown = JSON.parse(detailsKey);
    if (!Array.isArray(entries)) {
      return null;
    }
    const pairs: [string, unknown][] = entries.filter(
      (entry: unknown): entry is [string, unknown] => Array.isArray(entry) && typeof entry[0] === "string",
    );
    return routeKeyOf(Object.fromEntries(pairs) as TransferBankDetails);
  } catch {
    return null;
  }
}

// True when a new transfer would go to the account the original went to. Every
// field but NOT_ROUTING_FIELDS counts, so a bank name Airwallex rewrote is not new
// bank details, and a change to any other field is. The replacement's terms
// still pin the record's full accountKey.
export function sameBankDetails(
  original: TransferBankDetails | undefined,
  current: TransferBankDetails,
): boolean {
  return original !== undefined && routeKeyOf(original) === routeKeyOf(current);
}

export function resendCanFix(transfer: Transfer): boolean {
  const code: string | undefined = transfer.failure?.code;
  return code !== undefined && RESENDABLE_FAILURE_CODES.has(code);
}

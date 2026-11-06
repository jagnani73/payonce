import type { Transfer } from "../airwallex/transfers.js";

const MS_PER_MINUTE: number = 60_000;
const MINUTES_PER_HOUR: number = 60;
const MINUTES_PER_DAY: number = 24 * MINUTES_PER_HOUR;

// BANK_DEADLINE_LOCAL_MINUTES and BANK_DEADLINE_SWIFT_MINUTES as the settings
// read them, or null when one is not a positive number, so the method's default
// applies.
export interface BankDeadlineMinutes {
  LOCAL: number | null;
  SWIFT: number | null;
}

// How long the bank has to pay or fail a transfer before a person hears about
// it, by transfer method. Real rails take days. The sandbox moves in seconds, so
// the defaults are minutes.
const DEFAULT_MINUTES: Record<string, number> = { LOCAL: 3, SWIFT: 5 };
// A method PayOnce does not know gets the longest deadline it has.
const FALLBACK_MINUTES: number = Math.max(...Object.values(DEFAULT_MINUTES));

// The configured minutes for the method when it has some, otherwise the method's
// default.
export function deadlineMinutes(method: string, configured: BankDeadlineMinutes): number {
  const minutes: number | null = method === "LOCAL" || method === "SWIFT" ? configured[method] : null;
  return minutes ?? DEFAULT_MINUTES[method] ?? FALLBACK_MINUTES;
}

// When the bank should have paid or failed the transfer, in epoch milliseconds.
// NaN when Airwallex gives a creation time that cannot be read.
export function deadlineOf(transfer: Transfer, configured: BankDeadlineMinutes): number {
  return (
    Date.parse(transfer.created_at) +
    deadlineMinutes(transfer.transfer_method, configured) * MS_PER_MINUTE
  );
}

// A transfer whose deadline cannot be read counts as overdue, so it reaches a
// person instead of waiting for ever.
export function isOverdue(transfer: Transfer, configured: BankDeadlineMinutes, now: number = Date.now()): boolean {
  return !(now < deadlineOf(transfer, configured));
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// The deadline as people read it, such as "3 minutes" or "2 days".
export function describeDeadline(transfer: Transfer, configured: BankDeadlineMinutes): string {
  const minutes: number = deadlineMinutes(transfer.transfer_method, configured);
  if (minutes % MINUTES_PER_DAY === 0) {
    return plural(minutes / MINUTES_PER_DAY, "day");
  }
  if (minutes % MINUTES_PER_HOUR === 0) {
    return plural(minutes / MINUTES_PER_HOUR, "hour");
  }
  return plural(minutes, "minute");
}

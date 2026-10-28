import type { Transfer } from "./airwallex/transfers.js";

const MS_PER_MINUTE: number = 60_000;
const MINUTES_PER_HOUR: number = 60;
const MINUTES_PER_DAY: number = 24 * MINUTES_PER_HOUR;

// How long the bank has to pay or fail a transfer before a person hears about
// it, by transfer method. Real rails take days. The sandbox moves in seconds, so
// the defaults are minutes.
const DEFAULT_MINUTES: Record<string, number> = { LOCAL: 3, SWIFT: 5 };
const SETTING: Record<string, string> = {
  LOCAL: "BANK_DEADLINE_LOCAL_MINUTES",
  SWIFT: "BANK_DEADLINE_SWIFT_MINUTES",
};
// A method PayOnce does not know gets the longest deadline it has.
const FALLBACK_MINUTES: number = Math.max(...Object.values(DEFAULT_MINUTES));

export function deadlineMinutes(method: string): number {
  const setting: string | undefined = SETTING[method];
  const configured: number = Number(setting === undefined ? "" : process.env[setting]);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_MINUTES[method] ?? FALLBACK_MINUTES;
}

// When the bank should have paid or failed the transfer, in epoch milliseconds.
// NaN when Airwallex gives a creation time that cannot be read.
export function deadlineOf(transfer: Transfer): number {
  return (
    Date.parse(transfer.created_at) +
    deadlineMinutes(transfer.transfer_method) * MS_PER_MINUTE
  );
}

// A transfer whose deadline cannot be read counts as overdue, so it reaches a
// person instead of waiting for ever.
export function isOverdue(transfer: Transfer, now: number = Date.now()): boolean {
  return !(now < deadlineOf(transfer));
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// The deadline as people read it, such as "3 minutes" or "2 days".
export function describeDeadline(transfer: Transfer): string {
  const minutes: number = deadlineMinutes(transfer.transfer_method);
  if (minutes % MINUTES_PER_DAY === 0) {
    return plural(minutes / MINUTES_PER_DAY, "day");
  }
  if (minutes % MINUTES_PER_HOUR === 0) {
    return plural(minutes / MINUTES_PER_HOUR, "hour");
  }
  return plural(minutes, "minute");
}

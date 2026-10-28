import type { Obligation } from "./ledger.js";
import { formatMoney, toMinor } from "./money.js";

// The cash each wallet keeps back, by currency, in minor units. A currency that
// is not listed has no floor, and the policy then sends every automatic
// replacement in it to a person.
export interface ReservePolicy {
  floors: ReadonlyMap<string, number>;
  // Why RESERVE_FLOORS could not be read. Every floor is unreadable while it is set.
  problem: string | null;
}

export type FloorSource = "setting" | "not-set" | "unreadable";

export interface CurrencyFloor {
  minor: number | null;
  source: FloorSource;
}

const CURRENCY_PATTERN: RegExp = /^[A-Z]{3}$/;

// The wallet a payment's money leaves: the invoice's own currency, or the one it
// is paid from across currencies.
export function debitCurrency(obligation: Obligation): string {
  return obligation.sourceCurrency;
}

function parseFloors(raw: string): Map<string, number> {
  const floors: Map<string, number> = new Map();
  for (const entry of raw.split(",")) {
    if (entry.trim() === "") {
      continue;
    }
    const colon: number = entry.indexOf(":");
    const currency: string = colon < 0 ? "" : entry.slice(0, colon).trim().toUpperCase();
    const amount: string = colon < 0 ? "" : entry.slice(colon + 1).trim();
    const floor: number = amount === "" ? Number.NaN : Number(amount);
    if (!CURRENCY_PATTERN.test(currency) || !Number.isFinite(floor) || floor < 0) {
      throw new Error(`"${entry.trim()}" is not a currency and an amount, such as USD:1000000`);
    }
    if (floors.has(currency)) {
      throw new Error(`${currency} is listed twice`);
    }
    floors.set(currency, toMinor(floor));
  }
  return floors;
}

// RESERVE_FLOORS is a list such as "USD:1000000,EUR:0", each a currency and the
// amount its wallet keeps back, in major units. EUR:0 says on purpose that EUR
// has no floor.
export function reserveFromEnv(env: NodeJS.ProcessEnv = process.env): ReservePolicy {
  try {
    return { floors: parseFloors(env["RESERVE_FLOORS"] ?? ""), problem: null };
  } catch (error: unknown) {
    return {
      floors: new Map(),
      problem: `RESERVE_FLOORS could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function currencyFloor(policy: ReservePolicy, currency: string): CurrencyFloor {
  if (policy.problem !== null) {
    return { minor: null, source: "unreadable" };
  }
  const minor: number | undefined = policy.floors.get(currency);
  return minor === undefined ? { minor: null, source: "not-set" } : { minor, source: "setting" };
}

// The floor one invoice's payment is held to: its currency's floor, or the
// invoice's own when that is stricter. An invoice can never be looser than its
// currency. NaN when RESERVE_FLOORS could not be read, so the policy treats the
// cash position as unreadable. Null when no floor is set for the currency and the
// invoice has none of its own.
export function floorFor(policy: ReservePolicy, obligation: Obligation): number | null {
  const floor: CurrencyFloor = currencyFloor(policy, debitCurrency(obligation));
  if (floor.source === "unreadable") {
    return Number.NaN;
  }
  if (floor.minor === null && obligation.invoiceFloorMinor <= 0) {
    return null;
  }
  return Math.max(floor.minor ?? 0, obligation.invoiceFloorMinor);
}

export function describeFloors(policy: ReservePolicy): string {
  if (policy.problem !== null) {
    return `Every reserve floor is unreadable, so every automatic replacement goes to a person: ${policy.problem}`;
  }
  if (policy.floors.size === 0) {
    return "No reserve floors are set, so every automatic replacement goes to a person. Add RESERVE_FLOORS to .env, such as USD:1000000,EUR:1000000";
  }
  const floors: string = [...policy.floors.entries()]
    .sort(([a]: [string, number], [b]: [string, number]): number => a.localeCompare(b))
    .map(([currency, minor]: [string, number]): string =>
      minor === 0 ? `${currency} none` : formatMoney(minor, currency),
    )
    .join(", ");
  return `Reserve floors: ${floors}. A currency not listed has no floor, so its automatic replacements go to a person`;
}

import { readMinor, toMinor } from "../money.js";
import type { AirwallexClient } from "./client.js";

interface BalanceRow {
  currency: string;
  available_amount: number;
  reserved_amount?: number;
  pending_amount?: number;
  prepayment_amount?: number;
  total_amount?: number;
  account_type?: string;
}

// One wallet's balance in minor units. reserved is money held for outgoing
// payments and pending is money still arriving from conversions; neither is part
// of available. A field Airwallex did not send, or sent unreadable, is null.
export interface Balance {
  currency: string;
  availableMinor: number | null;
  reservedMinor: number | null;
  pendingMinor: number | null;
  prepaymentMinor: number | null;
  totalMinor: number | null;
}

// The cash account only. An account with yield or credit balances lists those too,
// in the same currencies.
async function cashRows(client: AirwallexClient): Promise<BalanceRow[]> {
  const rows: BalanceRow[] = await client.get<BalanceRow[]>("/api/v1/balances/current");
  return rows.filter(
    (row: BalanceRow): boolean =>
      row.account_type === undefined || row.account_type.toLowerCase() === "cash",
  );
}

export async function getBalances(client: AirwallexClient): Promise<Balance[]> {
  return (await cashRows(client)).map(
    (row: BalanceRow): Balance => ({
      currency: row.currency,
      availableMinor: readMinor(row.available_amount),
      reservedMinor: readMinor(row.reserved_amount),
      pendingMinor: readMinor(row.pending_amount),
      prepaymentMinor: readMinor(row.prepayment_amount),
      totalMinor: readMinor(row.total_amount),
    }),
  );
}

// For the policy, which must not act on an amount it cannot read.
export async function getAvailableMinor(
  client: AirwallexClient,
  currency: string,
): Promise<number> {
  const balance: BalanceRow | undefined = (await cashRows(client)).find(
    (entry: BalanceRow): boolean => entry.currency === currency,
  );
  if (balance === undefined) {
    throw new Error(`Airwallex returned no ${currency} balance`);
  }
  return toMinor(balance.available_amount);
}

// The last good read and how it stands. readAt is null until a read has worked.
// error is the last try, when it failed, even if an older read is still shown.
export interface BalanceState {
  readAt: number | null;
  balances: Balance[];
  refreshing: boolean;
  error: { message: string; at: number } | null;
  maxAgeMs: number;
}

// Balances for the cash panel, read at most once per maxAgeMs and only while
// something asks for them. The policy never uses it: a decision reads the balance
// fresh. afterRead runs after each good read.
export class BalanceCache {
  private readonly client: AirwallexClient;
  private readonly maxAgeMs: number;
  private readonly afterRead: (() => Promise<void>) | undefined;
  private readAt: number | null = null;
  private balances: Balance[] = [];
  private error: { message: string; at: number } | null = null;
  // The last try, good or failed, so a failing Airwallex is tried once per maxAgeMs.
  private triedAt: number = Number.NEGATIVE_INFINITY;
  private reading: Promise<void> | null = null;

  constructor(client: AirwallexClient, maxAgeMs: number, afterRead?: () => Promise<void>) {
    this.client = client;
    this.maxAgeMs = maxAgeMs;
    this.afterRead = afterRead;
  }

  latest(): BalanceState {
    return {
      readAt: this.readAt,
      balances: this.balances,
      refreshing: this.reading !== null,
      error: this.error,
      maxAgeMs: this.maxAgeMs,
    };
  }

  // Starts one read when the last try is maxAgeMs old, and returns at once.
  refreshIfOld(now: number = Date.now()): void {
    if (this.reading !== null || now - this.triedAt < this.maxAgeMs) {
      return;
    }
    this.triedAt = now;
    this.reading = this.read().finally((): void => {
      this.reading = null;
    });
  }

  private async read(): Promise<void> {
    try {
      this.balances = await getBalances(this.client);
      this.readAt = Date.now();
      this.error = null;
    } catch (error: unknown) {
      this.error = {
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      };
      return;
    }
    try {
      await this.afterRead?.();
    } catch (error: unknown) {
      console.warn(`  balances ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

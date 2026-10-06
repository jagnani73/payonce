import { toMinor } from "../money.js";
import type { AirwallexClient } from "./client.js";

interface Balance {
  currency: string;
  available_amount: number;
}

export async function getAvailableMinor(
  client: AirwallexClient,
  currency: string,
): Promise<number> {
  const balances: Balance[] = await client.get<Balance[]>(
    "/api/v1/balances/current",
  );
  const balance: Balance | undefined = balances.find(
    (entry: Balance): boolean => entry.currency === currency,
  );
  return balance === undefined ? 0 : toMinor(balance.available_amount);
}

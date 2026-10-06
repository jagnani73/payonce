import { AirwallexError, type AirwallexClient } from "./client.js";
import { getTransfer, type Transfer } from "./transfers.js";

export type SimulatedStatus = "SENT" | "PAID" | "FAILED";

const MAX_TRIES: number = 4;
const RETRY_DELAY_MS: number = 1_500;

const REACHED: Record<SimulatedStatus, ReadonlySet<string>> = {
  SENT: new Set<string>(["SENT"]),
  PAID: new Set<string>(["PAID"]),
  FAILED: new Set<string>(["FAILED", "CANCELLED"]),
};

// Sandbox-only. Everything that fakes a bank outcome goes through this file.
// The simulator sometimes answers 500 after applying the transition, so a server
// error is treated as ambiguous: read the transfer before trying again.
export async function simulateTransfer(
  client: AirwallexClient,
  id: string,
  nextStatus: SimulatedStatus,
  failureType?: string,
): Promise<Transfer> {
  for (let attempt: number = 1; ; attempt += 1) {
    try {
      return await client.post<Transfer>(
        `/api/v1/simulation/transfers/${id}/transition`,
        {
          next_status: nextStatus,
          ...(failureType === undefined ? {} : { failure_type: failureType }),
        },
      );
    } catch (error: unknown) {
      if (!(error instanceof AirwallexError) || error.status < 500) {
        throw error;
      }
      const current: Transfer = await getTransfer(client, id);
      if (REACHED[nextStatus].has(current.status)) {
        return current;
      }
      if (attempt >= MAX_TRIES) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

import type { AirwallexClient } from "./client.js";
import type { Transfer } from "./transfers.js";

export type SimulatedStatus = "SENT" | "PAID" | "FAILED";

// Sandbox-only. Everything that fakes a bank outcome goes through this file.
export function simulateTransfer(
  client: AirwallexClient,
  id: string,
  nextStatus: SimulatedStatus,
  failureType?: string,
): Promise<Transfer> {
  return client.post<Transfer>(`/api/v1/simulation/transfers/${id}/transition`, {
    next_status: nextStatus,
    ...(failureType === undefined ? {} : { failure_type: failureType }),
  });
}

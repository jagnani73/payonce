import type { AirwallexClient } from "./airwallex/client.js";
import { simulateTransfer } from "./airwallex/simulation.js";
import { getTransfer, waitForTransfer, type Transfer } from "./airwallex/transfers.js";
import type { Bank } from "./engine.js";
import type { AttemptKind } from "./ledger.js";

// The bank outcome that pays a transfer. Any other outcome is the failure type
// the simulator fails it with.
export const PAID_OUTCOME: string = "PAID";
// The bank outcome that leaves a transfer in SENT, so the agent's deadline for it
// runs out.
export const STAYS_IN_FLIGHT: string = "STAYS_IN_FLIGHT";

const SETTLED_STATUSES: ReadonlySet<string> = new Set<string>([
  "PAID",
  "FAILED",
  "CANCELLED",
]);

// Sandbox-only. Nothing moves a sandbox transfer on by itself, so this plays the
// bank: it sends a new transfer, and pays or fails it when told to. It pays every
// replacement PayOnce sends. The agent never asks it what happened. It hears from
// Airwallex by webhook or finds out on a status check, as it would in production.
export class SandboxBank implements Bank {
  private readonly client: AirwallexClient;
  private readonly onError: (invoiceId: string, error: unknown) => void;
  // Steps still running, by invoice.
  private readonly running: Map<string, number> = new Map<string, number>();

  constructor(
    client: AirwallexClient,
    onError: (invoiceId: string, error: unknown) => void,
  ) {
    this.client = client;
    this.onError = onError;
  }

  isBusy(invoiceId: string): boolean {
    return (this.running.get(invoiceId) ?? 0) > 0;
  }

  // Runs a step for an invoice and counts it as busy until it ends.
  async run<T>(invoiceId: string, step: () => Promise<T>): Promise<T> {
    this.running.set(invoiceId, (this.running.get(invoiceId) ?? 0) + 1);
    try {
      return await step();
    } finally {
      const left: number = (this.running.get(invoiceId) ?? 1) - 1;
      if (left === 0) {
        this.running.delete(invoiceId);
      } else {
        this.running.set(invoiceId, left);
      }
    }
  }

  // Takes a new transfer to SENT. The simulator refuses a transition while the
  // transfer is still SCHEDULED, so it waits for Airwallex to move it on first.
  async send(transferId: string): Promise<void> {
    const current: Transfer = await waitForTransfer(
      this.client,
      transferId,
      (transfer: Transfer): boolean => transfer.status !== "SCHEDULED",
    );
    if (current.status === "PROCESSING") {
      await simulateTransfer(this.client, transferId, "SENT");
    }
  }

  // Pays the transfer, or fails it with the outcome as its failure type. A
  // transfer that has already settled is left as it is, and so is any transfer
  // when the outcome is STAYS_IN_FLIGHT.
  async settle(transferId: string, outcome: string): Promise<void> {
    if (outcome === STAYS_IN_FLIGHT) {
      return;
    }
    const current: Transfer = await getTransfer(this.client, transferId);
    if (SETTLED_STATUSES.has(current.status)) {
      return;
    }
    if (outcome === PAID_OUTCOME) {
      await simulateTransfer(this.client, transferId, "PAID");
    } else {
      await simulateTransfer(this.client, transferId, "FAILED", outcome);
    }
  }

  // PayOnce sent a payment. The scenario decides what happens to an original, and
  // the bank pays a replacement.
  sent(invoiceId: string, kind: AttemptKind, transferId: string): void {
    if (kind !== "replacement") {
      return;
    }
    this.run(invoiceId, async (): Promise<void> => {
      await this.send(transferId);
      await this.settle(transferId, PAID_OUTCOME);
    }).catch((error: unknown): void => {
      this.onError(invoiceId, error);
    });
  }
}

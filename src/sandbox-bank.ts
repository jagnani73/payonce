import type { AirwallexClient } from "./airwallex/client.js";
import { isAmbiguous, simulateTransfer } from "./airwallex/simulation.js";
import { getTransfer, waitForTransfer, type Transfer } from "./airwallex/transfers.js";
import { isOverdue } from "./deadlines.js";
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

const READ_TRIES: number = 4;
const READ_RETRY_MS: number = 1_500;

// Sandbox-only. Nothing moves a sandbox transfer on by itself, so this plays the
// bank: it sends a new transfer, and pays or fails it when told to. It pays every
// replacement PayOnce sends. The agent never asks it what happened. It hears from
// Airwallex by webhook or finds out on a status check, as it would in production.
export class SandboxBank implements Bank {
  private readonly client: AirwallexClient;
  private readonly onError: (invoiceId: string, error: unknown) => void;
  // Steps still running, by invoice.
  private readonly running: Map<string, number> = new Map<string, number>();
  // The scenario's outcome for the original of an invoice PayOnce held before
  // paying, played if a person releases the payment. It lives in memory, so
  // another process pays the original instead, and so does this one when the
  // server picks the original up again after a restart.
  private readonly held: Map<string, string> = new Map<string, string>();
  // Invoices whose original the scripted run is sending and settles itself.
  private readonly scripted: Set<string> = new Set<string>();
  // Transfers that convert, which the simulator will not move, already reported.
  private readonly converting: Set<string> = new Set<string>();

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

  // Reads a transfer, trying again on a server error or a lost connection, as
  // the simulation calls do.
  private async read(transferId: string): Promise<Transfer> {
    for (let attempt: number = 1; ; attempt += 1) {
      try {
        return await getTransfer(this.client, transferId);
      } catch (error: unknown) {
        if (!isAmbiguous(error) || attempt >= READ_TRIES) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, READ_RETRY_MS));
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

  // For an invoice PayOnce held before paying: the outcome the bank gives its
  // original if a person releases it. Anything that is not a simulator name,
  // such as the CLI's - placeholder, is ignored, and the bank pays it.
  expectOriginal(invoiceId: string, outcome: string): void {
    if (/^[A-Z_]+$/.test(outcome)) {
      this.held.set(invoiceId, outcome);
    }
  }

  // While the scripted run sends an invoice's original, so the bank leaves it to
  // the script.
  async scripting<T>(invoiceId: string, step: () => Promise<T>): Promise<T> {
    this.scripted.add(invoiceId);
    try {
      return await step();
    } finally {
      this.scripted.delete(invoiceId);
    }
  }

  // PayOnce sent a payment. The scripted run decides what happens to the original
  // it sends. The bank pays a replacement, and gives an original released after a
  // hold the outcome expectOriginal recorded, or pays it. The simulator refuses
  // every transition of a transfer that converts, so the bank says so once and
  // leaves it in PROCESSING, where the agent's deadline for it runs out.
  sent(invoiceId: string, kind: AttemptKind, transferId: string): void {
    if (kind === "original" && this.scripted.has(invoiceId)) {
      return;
    }
    const outcome: string =
      kind === "replacement" ? PAID_OUTCOME : (this.held.get(invoiceId) ?? PAID_OUTCOME);
    this.held.delete(invoiceId);
    this.run(invoiceId, async (): Promise<void> => {
      const transfer: Transfer = await this.read(transferId);
      if (transfer.source_currency !== undefined && transfer.source_currency !== transfer.transfer_currency) {
        // Past its deadline the agent has said so already.
        if (!this.converting.has(transferId) && !isOverdue(transfer)) {
          this.converting.add(transferId);
          throw new Error(
            `The sandbox simulator does not move a transfer that converts currency, so nothing here pays or fails ${transfer.short_reference_id}, and it stays in PROCESSING`,
          );
        }
        return;
      }
      await this.send(transferId);
      await this.settle(transferId, outcome);
    }).catch((error: unknown): void => {
      this.onError(invoiceId, error);
    });
  }
}

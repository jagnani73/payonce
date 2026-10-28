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

// What the sandbox bank can do with an original: fail it one of these ways, pay
// it, or leave it in flight past its deadline. A pay run file can name one per row.
export const SANDBOX_OUTCOMES: string[] = [
  "CHANNEL_TIMEOUT",
  "SYSTEM_ERROR",
  "BENEFICIARY_BANK_RETURNED",
  "ACCOUNT_CLOSED",
  "INVALID_ACCOUNT_NAME_OR_NUMBER",
  STAYS_IN_FLIGHT,
  PAID_OUTCOME,
];

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
  // The scenario's outcome for the original of an invoice PayOnce held before
  // paying, played if a person releases the payment. It lives in memory, so
  // another process pays the original instead, and so does this one when the
  // server picks the original up again after a restart.
  private readonly held: Map<string, string> = new Map<string, string>();
  // Invoices whose original the scripted run is sending and settles itself.
  private readonly scripted: Set<string> = new Set<string>();
  // The outcome the ledger keeps for an invoice's original, such as a pay run
  // row's sandbox_outcome, or null. It survives a restart and works in any process.
  private readonly outcomeOf: (invoiceId: string) => string | null;

  constructor(
    client: AirwallexClient,
    onError: (invoiceId: string, error: unknown) => void,
    outcomeOf: (invoiceId: string) => string | null = (): string | null => null,
  ) {
    this.client = client;
    this.onError = onError;
    this.outcomeOf = outcomeOf;
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
  // it sends. The bank pays a replacement. It gives any other original the outcome
  // expectOriginal recorded, else the one the ledger keeps for it, such as a pay
  // run row's, else pays it.
  sent(invoiceId: string, kind: AttemptKind, transferId: string): void {
    if (kind === "original" && this.scripted.has(invoiceId)) {
      return;
    }
    const outcome: string =
      kind === "replacement"
        ? PAID_OUTCOME
        : (this.held.get(invoiceId) ?? this.outcomeOf(invoiceId) ?? PAID_OUTCOME);
    this.held.delete(invoiceId);
    this.run(invoiceId, async (): Promise<void> => {
      await this.send(transferId);
      await this.settle(transferId, outcome);
    }).catch((error: unknown): void => {
      this.onError(invoiceId, error);
    });
  }
}

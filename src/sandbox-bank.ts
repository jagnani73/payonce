import { AirwallexError, AirwallexUnreachableError, type AirwallexClient } from "./airwallex/client.js";
import { isAmbiguous, simulateTransfer, type SimulatedStatus } from "./airwallex/simulation.js";
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

const READ_TRIES: number = 4;
const READ_RETRY_MS: number = 1_500;

// The bank's short reference and an Airwallex error code, in the forms Airwallex
// gives them. Anything else is left out of the line.
const REFERENCE: RegExp = /^[A-Z0-9-]{1,30}$/;
const ERROR_CODE: RegExp = /^[A-Za-z0-9_]{1,40}$/;
export const SANDBOX_BANK_AFTER: string =
  "PayOnce keeps reading the transfer from Airwallex as usual, and if the bank has neither paid nor failed it by its deadline, a person hears about it";

// What the sandbox bank was doing when a call failed: reading the transfer,
// waiting for Airwallex to move it past SCHEDULED, or asking the simulator to move
// it to a status.
type BankStep = "read" | "wait" | SimulatedStatus;

// The sandbox bank could not play its part this time. In the sandbox the
// simulator stands in for the bank, so a refusal of its own is not PayOnce
// failing, and the payment is followed as any other. The message is PayOnce's
// words for the timeline, with the answer's status and code only in the forms
// they take. detail is the error as it came, for the console.
export class SandboxBankError extends Error {
  readonly detail: string;

  constructor(step: BankStep, reference: string | null, error: unknown) {
    const named: string = reference !== null && REFERENCE.test(reference) ? `transfer ${reference}` : "the transfer";
    const answered: string =
      error instanceof AirwallexError
        ? `: it answered ${error.status}${error.code !== undefined && ERROR_CODE.test(error.code) ? ` ${error.code}` : ""}`
        : error instanceof AirwallexUnreachableError
          ? ": it did not answer"
          : "";
    const what: string =
      step === "read"
        ? `The sandbox bank could not read ${named} from Airwallex this time${answered}, so the simulator, which stands in for the bank, did not move it`
        : step === "wait"
          ? `${named.charAt(0).toUpperCase()}${named.slice(1)} stayed SCHEDULED in Airwallex for longer than the sandbox bank waits, so the simulator, which stands in for the bank, did not move it this time`
          : `The sandbox's simulator, which stands in for the bank, did not move ${named} to ${step} this time${answered}`;
    super(`${what}. ${SANDBOX_BANK_AFTER}`);
    this.name = "SandboxBankError";
    this.detail = error instanceof Error ? error.message : String(error);
  }
}

// A read the sandbox bank makes, with its failure in PayOnce's words.
async function reading<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    throw new SandboxBankError("read", null, error);
  }
}

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
  // Transfers that convert, which the simulator will not move, already reported.
  private readonly converting: Set<string> = new Set<string>();

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

  // Asks the simulator to move a transfer, with a refusal in PayOnce's words.
  private async move(transferId: string, reference: string, to: SimulatedStatus, failureType?: string): Promise<void> {
    try {
      await simulateTransfer(this.client, transferId, to, failureType);
    } catch (error: unknown) {
      throw new SandboxBankError(to, reference, error);
    }
  }

  // Takes a new transfer to SENT. The simulator refuses a transition while the
  // transfer is still SCHEDULED, so it waits for Airwallex to move it on first.
  async send(transferId: string): Promise<void> {
    let current: Transfer;
    try {
      current = await waitForTransfer(
        this.client,
        transferId,
        (transfer: Transfer): boolean => transfer.status !== "SCHEDULED",
      );
    } catch (error: unknown) {
      const read: boolean = error instanceof AirwallexError || error instanceof AirwallexUnreachableError;
      throw new SandboxBankError(read ? "read" : "wait", null, error);
    }
    if (current.status === "PROCESSING") {
      await this.move(transferId, current.short_reference_id, "SENT");
    }
  }

  // Pays the transfer, or fails it with the outcome as its failure type. A
  // transfer that has already settled is left as it is, and so is any transfer
  // when the outcome is STAYS_IN_FLIGHT.
  async settle(transferId: string, outcome: string): Promise<void> {
    if (outcome === STAYS_IN_FLIGHT) {
      return;
    }
    const current: Transfer = await reading((): Promise<Transfer> => getTransfer(this.client, transferId));
    if (SETTLED_STATUSES.has(current.status)) {
      return;
    }
    if (outcome === PAID_OUTCOME) {
      await this.move(transferId, current.short_reference_id, "PAID");
    } else {
      await this.move(transferId, current.short_reference_id, "FAILED", outcome);
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
  // run row's, else pays it. The simulator refuses every transition of a transfer
  // that converts, so the bank says so once and leaves it in PROCESSING, where the
  // agent's deadline for it runs out.
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
      const transfer: Transfer = await reading((): Promise<Transfer> => this.read(transferId));
      if (transfer.source_currency !== undefined && transfer.source_currency !== transfer.transfer_currency) {
        // Past its deadline the agent has said so already.
        if (!this.converting.has(transferId) && !isOverdue(transfer)) {
          this.converting.add(transferId);
          throw new Error(
            `The sandbox's simulator, which stands in for the bank, does not move a transfer that converts currency, so nothing here pays or fails ${REFERENCE.test(transfer.short_reference_id) ? transfer.short_reference_id : "it"}, and it stays in PROCESSING. If the bank has neither paid nor failed it by its deadline, a person hears about it`,
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

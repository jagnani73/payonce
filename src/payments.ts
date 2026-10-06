import { AirwallexError, type AirwallexClient } from "./airwallex/client.js";
import {
  createTransfer,
  findTransferByRequestId,
  getTransfer,
  type Transfer,
} from "./airwallex/transfers.js";
import { attemptStateOf } from "./assess.js";
import type { Attempt, Ledger, Obligation } from "./ledger.js";
import { toMajor } from "./money.js";

function record(ledger: Ledger, transfer: Transfer): void {
  ledger.record(
    transfer.request_id,
    transfer.id,
    transfer.short_reference_id,
    attemptStateOf(transfer),
    transfer.failure?.code ?? null,
  );
}

// A 4xx means Airwallex refused the request and created nothing.
export function wasRejected(error: unknown): error is AirwallexError {
  return error instanceof AirwallexError && error.status >= 400 && error.status < 500;
}

// Safe to call again for the same attempt: the request_id is reused, so Airwallex
// either creates the transfer once or reports the one it already has. A refused
// request marks the attempt failed. Any other error leaves it pending, because
// the transfer may exist.
export async function sendAttempt(
  client: AirwallexClient,
  ledger: Ledger,
  obligation: Obligation,
  attempt: Attempt,
): Promise<Transfer> {
  let transfer: Transfer;
  try {
    transfer = await createTransfer(client, {
      requestId: attempt.requestId,
      beneficiaryId: obligation.beneficiaryId,
      currency: obligation.currency,
      amountMajor: toMajor(obligation.amountMinor),
      method: obligation.transferMethod,
      reference: obligation.invoiceId,
    });
  } catch (error: unknown) {
    if (!wasRejected(error)) {
      throw error;
    }
    if (error.code !== "duplicate_request_id") {
      ledger.failAttempt(attempt.requestId, error.code ?? null);
      throw error;
    }
    const existing: Transfer | undefined = await findTransferByRequestId(
      client,
      attempt.requestId,
    );
    if (existing === undefined) {
      throw error;
    }
    transfer = existing;
  }
  record(ledger, transfer);
  return transfer;
}

export async function syncTransfer(
  client: AirwallexClient,
  ledger: Ledger,
  transferId: string,
): Promise<Transfer> {
  const transfer: Transfer = await getTransfer(client, transferId);
  record(ledger, transfer);
  return transfer;
}

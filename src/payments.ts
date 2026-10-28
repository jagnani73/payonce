import { AirwallexError, type AirwallexClient } from "./airwallex/client.js";
import {
  createTransfer,
  findTransferByRequestId,
  getTransfer,
  type Transfer,
} from "./airwallex/transfers.js";
import { attemptStateOf, debitOf, feeOf, type Debit, type Fee } from "./assess.js";
import type { Attempt, Ledger, Obligation } from "./ledger.js";
import { toMajor } from "./money.js";

// Failed transfers whose fee is read from Airwallex in one go, when the ledger
// has none for them.
const MISSING_FEES_PER_READ: number = 5;
// How long a transfer whose fee could not be recorded waits before it is read again.
const MISSING_FEE_RETRY_MS: number = 10 * 60_000;

function record(ledger: Ledger, transfer: Transfer): void {
  const fee: Fee | null = feeOf(transfer);
  const debit: Debit | null = debitOf(transfer);
  ledger.record(
    transfer.request_id,
    transfer.id,
    transfer.short_reference_id,
    attemptStateOf(transfer),
    transfer.failure?.code ?? null,
    fee?.minor ?? null,
    fee?.currency ?? null,
    debit?.minor ?? null,
    debit?.currency ?? null,
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

// Reads the fee of failed transfers the ledger has none for, such as those on
// invoices closed before fees were kept, which no look reads again. It writes the
// fee and nothing else. Returns how many it recorded. It reads at most limit
// transfers. One whose fee could not be recorded is read again only after
// MISSING_FEE_RETRY_MS, and behind those not tried since.
export async function recordMissingFees(
  client: AirwallexClient,
  ledger: Ledger,
  limit: number = MISSING_FEES_PER_READ,
): Promise<number> {
  let recorded: number = 0;
  const now: number = Date.now();
  for (const transferId of ledger.failedWithoutFee(limit, now - MISSING_FEE_RETRY_MS)) {
    ledger.feeTried(transferId, now);
    try {
      const fee: Fee | null = feeOf(await getTransfer(client, transferId));
      if (fee !== null) {
        ledger.recordFee(transferId, fee.minor, fee.currency);
        recorded += 1;
      }
    } catch (error: unknown) {
      console.warn(
        `  fees     ${transferId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return recorded;
}

import { AirwallexError, type AirwallexClient } from "./airwallex/client.js";
import {
  createTransfer,
  findTransferByRequestId,
  getTransfer,
  type Transfer,
} from "./airwallex/transfers.js";
import { attemptStateOf, feeOf, type Fee } from "./assess.js";
import { crossCurrency, type Attempt, type Ledger, type Obligation } from "./ledger.js";
import { readMinor, toMajor } from "./money.js";

// Failed transfers whose fee is read from Airwallex in one go, when the ledger
// has none for them.
const MISSING_FEES_PER_READ: number = 5;

function record(ledger: Ledger, transfer: Transfer): void {
  const fee: Fee | null = feeOf(transfer);
  ledger.record(
    transfer.request_id,
    transfer.id,
    transfer.short_reference_id,
    attemptStateOf(transfer),
    transfer.failure?.code ?? null,
    fee?.minor ?? null,
    fee?.currency ?? null,
    readMinor(transfer.source_amount),
  );
}

// A 4xx means Airwallex refused the request and created nothing.
export function wasRejected(error: unknown): error is AirwallexError {
  return error instanceof AirwallexError && error.status >= 400 && error.status < 500;
}

// Safe to call again for the same attempt: the request_id is reused, so Airwallex
// either creates the transfer once or reports the one it already has. A refused
// request marks the attempt failed. Any other error leaves it pending, because
// the transfer may exist. retry is true when the attempt may have been sent
// before. A payment from another currency's wallet goes out with the attempt's
// own quote, and a retry of one that is refused stays pending: its quote may
// have run out after the first try created the transfer, so the refusal does not
// prove nothing was sent.
export async function sendAttempt(
  client: AirwallexClient,
  ledger: Ledger,
  obligation: Obligation,
  attempt: Attempt,
  retry: boolean = false,
): Promise<Transfer> {
  // Without a quote Airwallex converts at its own rate, which nobody approved.
  if (crossCurrency(obligation) && attempt.quoteId === null) {
    throw new Error(
      `${obligation.invoiceId} is paid from ${obligation.sourceCurrency} and its ${attempt.kind} payment has no approved exchange rate quote, so PayOnce sent nothing`,
    );
  }
  let transfer: Transfer;
  try {
    transfer = await createTransfer(client, {
      requestId: attempt.requestId,
      beneficiaryId: obligation.beneficiaryId,
      currency: obligation.currency,
      amountMajor: toMajor(obligation.amountMinor),
      method: obligation.transferMethod,
      reference: obligation.invoiceId,
      sourceCurrency: obligation.sourceCurrency,
      ...(attempt.quoteId === null ? {} : { quoteId: attempt.quoteId }),
    });
  } catch (error: unknown) {
    if (!wasRejected(error)) {
      throw error;
    }
    if (error.code !== "duplicate_request_id") {
      if (!(retry && attempt.quoteId !== null)) {
        ledger.failAttempt(attempt.requestId, error.code ?? null);
      }
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
// fee and nothing else. Returns how many it recorded. A transfer that cannot be
// read is tried again on the next call.
export async function recordMissingFees(
  client: AirwallexClient,
  ledger: Ledger,
  limit: number = MISSING_FEES_PER_READ,
): Promise<number> {
  let recorded: number = 0;
  for (const transferId of ledger.failedWithoutFee(limit)) {
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

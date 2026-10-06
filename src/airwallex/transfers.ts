import type { AirwallexClient } from "./client.js";

const POLL_INTERVAL_MS: number = 1_000;
const POLL_TIMEOUT_MS: number = 30_000;

export interface TransferFailure {
  code?: string;
  message?: string;
}

export interface Transfer {
  id: string;
  request_id: string;
  status: string;
  reference: string;
  short_reference_id: string;
  transfer_amount: number;
  transfer_currency: string;
  fee_amount: number;
  failure?: TransferFailure;
}

export interface NewTransfer {
  requestId: string;
  beneficiaryId: string;
  currency: string;
  amountMajor: number;
  reference: string;
}

export function createTransfer(
  client: AirwallexClient,
  input: NewTransfer,
): Promise<Transfer> {
  return client.post<Transfer>("/api/v1/transfers/create", {
    request_id: input.requestId,
    beneficiary_id: input.beneficiaryId,
    source_currency: input.currency,
    transfer_currency: input.currency,
    transfer_amount: input.amountMajor,
    transfer_method: "LOCAL",
    reason: "professional_business_services",
    reference: input.reference,
  });
}

export function getTransfer(
  client: AirwallexClient,
  id: string,
): Promise<Transfer> {
  return client.get<Transfer>(`/api/v1/transfers/${id}`);
}

interface TransferList {
  items?: Transfer[];
}

export async function findTransferByRequestId(
  client: AirwallexClient,
  requestId: string,
): Promise<Transfer | undefined> {
  const list: TransferList = await client.get<TransferList>(
    `/api/v1/transfers?request_id=${encodeURIComponent(requestId)}`,
  );
  return list.items?.[0];
}

export async function waitForTransfer(
  client: AirwallexClient,
  id: string,
  done: (transfer: Transfer) => boolean,
): Promise<Transfer> {
  const deadline: number = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const transfer: Transfer = await getTransfer(client, id);
    if (done(transfer)) {
      return transfer;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Transfer ${id} did not reach the expected state, last status ${transfer.status}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

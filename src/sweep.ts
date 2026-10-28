import { listTransfersSince, type Transfer } from "./airwallex/transfers.js";
import { debitOf, feeOf, originalStateOf, type Debit, type Fee } from "./assess.js";
import { isOverdue } from "./deadlines.js";
import type { Dispatcher } from "./dispatcher.js";
import { invoiceForPayout, type PayoutMatch } from "./duplicates.js";
import { linkOutsidePayout, note, payoutSummary, type Engine } from "./engine.js";
import type { OriginalTransferState } from "./incident.js";
import { INVOICE_ID_PATTERN, type TransferMethod } from "./ledger.js";
import { toMinor } from "./money.js";

const METHODS: ReadonlySet<string> = new Set<string>(["LOCAL", "SWIFT"]);

// A found payout's invoice has no floor of its own, so its currency's floor in
// RESERVE_FLOORS applies.
const FOUND_INVOICE_FLOOR_MINOR: number = 0;

// The states in which a found payout becomes an incident.
type FoundState = Extract<OriginalTransferState, "failed" | "in_flight">;

// Payouts the console has already reported as ones PayOnce cannot take on or could
// not handle, so it says so once.
const reported: Set<string> = new Set<string>();

function reportOnce(transfer: Transfer, problem: string): void {
  if (reported.has(transfer.id)) {
    return;
  }
  reported.add(transfer.id);
  console.warn(`  sweep    ${transfer.short_reference_id ?? transfer.id}: ${problem}`);
}

// Takes a payout someone else sent on as a new invoice, so the agent runs the
// incident as it would its own. Its reference is the invoice number when it can
// be one, and the bank's short reference otherwise, with the payout's reference
// kept so a later payout with it is tied to this invoice.
function adopt(engine: Engine, transfer: Transfer, state: FoundState): string | undefined {
  const beneficiaryId: string | undefined = transfer.beneficiary_id;
  if (beneficiaryId === undefined || !METHODS.has(transfer.transfer_method)) {
    reportOnce(
      transfer,
      "sent outside PayOnce, but PayOnce cannot pay it again: no beneficiary on file or an unknown transfer method",
    );
    return undefined;
  }
  const reference: string = transfer.reference ?? "";
  const fits: boolean = INVOICE_ID_PATTERN.test(reference);
  const invoiceId: string = fits ? reference : transfer.short_reference_id;
  if (engine.ledger.obligation(invoiceId) !== undefined) {
    return undefined;
  }
  const fee: Fee | null = feeOf(transfer);
  const debit: Debit | null = debitOf(transfer);
  engine.ledger.adoptPayout(
    {
      invoiceId,
      supplier: transfer.beneficiary?.bank_details?.account_name ?? "Unnamed payee",
      // No supplier emails are on file, so there is no sender to check.
      supplierDomain: "",
      beneficiaryId,
      currency: transfer.transfer_currency,
      amountMinor: toMinor(transfer.transfer_amount),
      transferMethod: transfer.transfer_method as TransferMethod,
      invoiceFloorMinor: FOUND_INVOICE_FLOOR_MINOR,
      // Airwallex does not say who sent it.
      startedBy: null,
      supplierPhone: null,
    },
    fits || reference === "" ? null : reference,
    {
      // Airwallex requires a request_id, so a missing one is not expected.
      requestId: transfer.request_id || `outside-${transfer.id}`,
      transferId: transfer.id,
      reference: transfer.short_reference_id,
      state,
      failureCode: transfer.failure?.code ?? null,
      feeMinor: fee?.minor ?? null,
      feeCurrency: fee?.currency ?? null,
      amountMinor: debit?.minor ?? null,
      currency: debit?.currency ?? null,
    },
  );
  note(
    engine.ledger,
    invoiceId,
    "bank",
    `Found payout ${transfer.short_reference_id}, sent outside PayOnce: ${payoutSummary(transfer)}`,
  );
  return invoiceId;
}

async function sweepOne(engine: Engine, agent: Dispatcher, transfer: Transfer): Promise<void> {
  if (engine.ledger.knowsTransfer(transfer.request_id ?? "", transfer.id)) {
    return;
  }
  const match: PayoutMatch | undefined = invoiceForPayout(engine.ledger, transfer);
  const state: OriginalTransferState = originalStateOf(transfer);
  // A failed payout that only nearly matches a closed invoice may be a bill of its
  // own, so it becomes an incident like any other found payout.
  const nearClosed: boolean =
    match !== undefined &&
    !match.exact &&
    state === "failed" &&
    (match.obligation.state === "settled" || match.obligation.state === "rejected");
  if (match !== undefined && !nearClosed) {
    const invoiceId: string = match.obligation.invoiceId;
    const linked: boolean = await agent.run(invoiceId, (): boolean =>
      linkOutsidePayout(engine, invoiceId, transfer, match.exact),
    );
    if (linked) {
      agent.wake(invoiceId);
    }
    return;
  }
  if (state === "failed" || (state === "in_flight" && isOverdue(transfer))) {
    const invoiceId: string | undefined = adopt(engine, transfer, state);
    if (invoiceId !== undefined) {
      if (nearClosed && match !== undefined) {
        note(
          engine.ledger,
          invoiceId,
          "warning",
          `Its reference ${transfer.reference} nearly matches ${match.obligation.invoiceId}, which is closed. Check it is not the same bill before approving a replacement`,
        );
      }
      agent.wake(invoiceId);
    }
  }
}

// Looks through the payouts made since the ledger started for ones PayOnce did not
// send, for example from the Airwallex web app. One whose reference names an
// invoice in the ledger is tied to it, and so is one whose reference nearly
// matches an invoice to the same supplier for the same amount. Any other becomes an incident once it has
// failed, or once the bank has sat on it past its deadline. A payout that cannot
// be handled is reported and skipped, so it does not stop the rest.
export async function sweep(engine: Engine, agent: Dispatcher): Promise<void> {
  const transfers: Transfer[] = await listTransfersSince(
    engine.client,
    engine.ledger.startedAt(),
  );
  for (const transfer of transfers) {
    try {
      await sweepOne(engine, agent, transfer);
    } catch (error: unknown) {
      reportOnce(transfer, error instanceof Error ? error.message : String(error));
    }
  }
}

import { randomUUID } from "node:crypto";
import { getAvailableMinor } from "./airwallex/balances.js";
import {
  findOrCreateDemoBeneficiary,
  type Beneficiary,
} from "./airwallex/beneficiaries.js";
import { AirwallexClient } from "./airwallex/client.js";
import { simulateTransfer } from "./airwallex/simulation.js";
import {
  createTransfer,
  getTransfer,
  waitForTransfer,
  type Transfer,
} from "./airwallex/transfers.js";
import { originalStateOf, resendCanFix } from "./assess.js";
import { decide } from "./decide.js";
import type { Decision, Incident } from "./incident.js";
import { toMajor, toMinor } from "./money.js";

const INVOICE_ID: string = "INV-1042";
const SUPPLIER: string = "Example Supplier LLC";
const CURRENCY: string = "USD";
const AMOUNT_MINOR: number = 400_000;
const RESERVE_FLOOR_MINOR: number = 100_000_000;
const DEFAULT_FAILURE_TYPE: string = "CHANNEL_TIMEOUT";

function log(message: string): void {
  console.log(message);
}

function describe(transfer: Transfer): string {
  const failure: string =
    transfer.failure?.code === undefined
      ? ""
      : `, ${transfer.failure.code} ${transfer.failure.message ?? ""}`.trimEnd();
  return `${transfer.short_reference_id} ${transfer.status}${failure}`;
}

async function assess(
  client: AirwallexClient,
  originalId: string,
): Promise<Decision> {
  const original: Transfer = await getTransfer(client, originalId);
  const incident: Incident = {
    invoiceId: INVOICE_ID,
    supplier: SUPPLIER,
    currency: CURRENCY,
    amountMinor: AMOUNT_MINOR,
    transferFeeMinor: toMinor(original.fee_amount),
    originalState: originalStateOf(original),
    resendCanFix: resendCanFix(original),
    supplierAsksForNewBankDetails: false,
    evidenceConflicts: false,
    availableBalanceMinor: await getAvailableMinor(client, CURRENCY),
    reserveFloorMinor: RESERVE_FLOOR_MINOR,
  };
  const decision: Decision = decide(incident);
  log(`  original ${describe(original)}`);
  log(`  decision: ${decision.action} (${decision.reason})`);
  return decision;
}

async function send(
  client: AirwallexClient,
  beneficiary: Beneficiary,
): Promise<Transfer> {
  const created: Transfer = await createTransfer(client, {
    requestId: randomUUID(),
    beneficiaryId: beneficiary.id,
    currency: CURRENCY,
    amountMajor: toMajor(AMOUNT_MINOR),
    reference: INVOICE_ID,
  });
  // The simulator rejects a transition until the transfer has left SCHEDULED.
  await waitForTransfer(
    client,
    created.id,
    (transfer: Transfer): boolean => transfer.status !== "SCHEDULED",
  );
  return simulateTransfer(client, created.id, "SENT");
}

async function main(): Promise<void> {
  const failureType: string = process.argv[2] ?? DEFAULT_FAILURE_TYPE;
  const client: AirwallexClient = AirwallexClient.fromEnv();
  const beneficiary: Beneficiary = await findOrCreateDemoBeneficiary(client);

  log(`1. Pay ${INVOICE_ID}: ${toMajor(AMOUNT_MINOR)} ${CURRENCY} to ${SUPPLIER}`);
  const original: Transfer = await send(client, beneficiary);

  log("2. Supplier reports nothing arrived");
  await assess(client, original.id);

  log(`3. Bank outcome arrives: ${failureType}`);
  await simulateTransfer(client, original.id, "FAILED", failureType);
  const decision: Decision = await assess(client, original.id);

  if (decision.action !== "replace") {
    log("4. No replacement sent");
    return;
  }

  log("4. Send the replacement under a new request_id");
  const replacement: Transfer = await send(client, beneficiary);
  await simulateTransfer(client, replacement.id, "PAID");

  log("5. Outcome");
  log(`  original ${describe(await getTransfer(client, original.id))}`);
  log(`  replacement ${describe(await getTransfer(client, replacement.id))}`);
  log(
    `  available ${toMajor(await getAvailableMinor(client, CURRENCY))} ${CURRENCY}`,
  );
}

await main();

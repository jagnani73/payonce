import { randomInt } from "node:crypto";
import { getAvailableMinor } from "./airwallex/balances.js";
import {
  DE_SWIFT_SUPPLIER,
  US_BANK_CHANGE_SUPPLIER,
  US_LOCAL_SUPPLIER,
  findOrCreateBeneficiary,
  type Beneficiary,
  type BeneficiarySpec,
} from "./airwallex/beneficiaries.js";
import type { Transfer } from "./airwallex/transfers.js";
import type { Dispatcher } from "./dispatcher.js";
import { loadEmails, type SupplierEmail } from "./emails.js";
import {
  deliver,
  heldBeforePaying,
  payAgain,
  startPayment,
  type Engine,
  type PayAgainResult,
} from "./engine.js";
import type { Attempt, Ledger, Obligation, TransferMethod } from "./ledger.js";
import type { SandboxBank } from "./sandbox-bank.js";

const SUPPLIER_DOMAIN: string = "example-supplier.test";
const REST_CHECK_MS: number = 500;
// How long a scripted incident may take, from the bank's outcome to the agent
// closing it or handing it to a person.
const SETTLE_TIMEOUT_MS: number = 180_000;

export interface ScenarioDef {
  id: string;
  label: string;
  supplier: string;
  beneficiary: BeneficiarySpec;
  currency: string;
  amountMinor: number;
  transferMethod: TransferMethod;
  // The transfer fee the scenario expects. When set, the invoice gets a floor of
  // its own, placed so that one payment fits and a second fee is what breaches it.
  // Every other scenario uses its currency's floor from RESERVE_FLOORS.
  tightReserveFeeMinor: number | null;
  // The supplier's phone number on file, for a callback about new bank details.
  supplierPhone: string | null;
  // Gives each run a beneficiary of its own, so a bank change recorded in one run
  // reaches no other incident.
  beneficiaryPerRun: boolean;
}

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "usd-local",
    label: "USD, local transfer",
    supplier: "Example Supplier LLC",
    beneficiary: US_LOCAL_SUPPLIER,
    currency: "USD",
    amountMinor: 400_000,
    transferMethod: "LOCAL",
    tightReserveFeeMinor: null,
    supplierPhone: null,
    beneficiaryPerRun: false,
  },
  {
    id: "eur-swift",
    label: "EUR, SWIFT transfer",
    supplier: "Example Supplier GmbH",
    beneficiary: DE_SWIFT_SUPPLIER,
    currency: "EUR",
    amountMinor: 400_000,
    transferMethod: "SWIFT",
    tightReserveFeeMinor: null,
    supplierPhone: null,
    beneficiaryPerRun: false,
  },
  {
    id: "eur-swift-low-reserve",
    label: "EUR, SWIFT, low cash reserve",
    supplier: "Example Supplier GmbH",
    beneficiary: DE_SWIFT_SUPPLIER,
    currency: "EUR",
    amountMinor: 400_000,
    transferMethod: "SWIFT",
    tightReserveFeeMinor: 1_391,
    supplierPhone: null,
    beneficiaryPerRun: false,
  },
  {
    id: "usd-local-bank-change",
    label: "USD, local, supplier changes bank",
    supplier: "Example Supplier LLC",
    beneficiary: US_BANK_CHANGE_SUPPLIER,
    currency: "USD",
    amountMinor: 400_000,
    transferMethod: "LOCAL",
    tightReserveFeeMinor: null,
    supplierPhone: "+1 212 555 0147",
    beneficiaryPerRun: true,
  },
];

export const DEFAULT_SCENARIO: string = "usd-local";
export const DEFAULT_EMAILS: string = "nothing-arrived";

export interface Scenario {
  bankOutcome: string;
  emailsName: string;
}

export function newInvoiceId(ledger: Ledger): string {
  for (;;) {
    const invoiceId: string = `INV-${randomInt(100_000, 1_000_000)}`;
    if (ledger.obligation(invoiceId) === undefined) {
      return invoiceId;
    }
  }
}

// Records the demo invoice as an obligation to the scenario's supplier. startedBy
// is the name the person starting it gave, and that person cannot approve its
// replacement.
export async function openScenario(
  engine: Engine,
  invoiceId: string,
  scenarioId: string,
  startedBy: string,
): Promise<Obligation> {
  const def: ScenarioDef | undefined = SCENARIOS.find(
    (scenario: ScenarioDef): boolean => scenario.id === scenarioId,
  );
  if (def === undefined) {
    throw new Error(`Unknown scenario ${scenarioId}`);
  }
  // openObligation leaves an existing row as it is, so a reused invoice number
  // would run this scenario against someone else's invoice. It is checked again
  // after the lookups, with nothing awaited between that check and the insert.
  if (engine.ledger.obligation(invoiceId) !== undefined) {
    throw new Error(`${invoiceId} is already in the ledger`);
  }
  const beneficiary: Beneficiary = await findOrCreateBeneficiary(
    engine.client,
    def.beneficiaryPerRun
      ? { ...def.beneficiary, nickname: `${def.beneficiary.nickname} ${invoiceId}` }
      : def.beneficiary,
  );
  const invoiceFloorMinor: number =
    def.tightReserveFeeMinor === null
      ? 0
      : (await getAvailableMinor(engine.client, def.currency)) -
        def.amountMinor -
        Math.round(def.tightReserveFeeMinor * 1.5);
  if (engine.ledger.obligation(invoiceId) !== undefined) {
    throw new Error(`${invoiceId} is already in the ledger`);
  }
  return engine.ledger.openObligation({
    invoiceId,
    supplier: def.supplier,
    supplierDomain: SUPPLIER_DOMAIN,
    beneficiaryId: beneficiary.id,
    currency: def.currency,
    amountMinor: def.amountMinor,
    transferMethod: def.transferMethod,
    invoiceFloorMinor,
    startedBy,
    supplierPhone: def.supplierPhone,
  });
}

// True when nothing is running for the invoice and the ledger shows none of its
// payments still with the bank, so it is closed or waiting on a person.
export function atRest(
  ledger: Ledger,
  agent: Dispatcher,
  bank: SandboxBank,
  invoiceId: string,
): boolean {
  return (
    !agent.isBusy(invoiceId) &&
    !bank.isBusy(invoiceId) &&
    ledger
      .attempts(invoiceId)
      .every(
        (attempt: Attempt): boolean =>
          attempt.state === "paid" || attempt.state === "failed",
      )
  );
}

// False if the invoice is still not at rest when the time runs out.
export async function untilAtRest(
  ledger: Ledger,
  agent: Dispatcher,
  bank: SandboxBank,
  invoiceId: string,
  timeoutMs: number = SETTLE_TIMEOUT_MS,
): Promise<boolean> {
  const deadline: number = Date.now() + timeoutMs;
  while (!atRest(ledger, agent, bank, invoiceId)) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, REST_CHECK_MS));
  }
  return true;
}

// The scripted sandbox incident. PayOnce pays the invoice, the bank sends it, the
// supplier writes in while it is in flight, and then the bank pays or fails it.
// Nobody tells the agent what the bank did: it hears from Airwallex by webhook or
// finds out on a status check. Once the incident has settled down, a paid
// replacement is followed by a second payment the lock refuses.
// An invoice PayOnce holds before paying stops there and waits for a person. If
// they release it, the bank gives its original the scenario's outcome, and no
// supplier emails arrive. Run again on a held invoice, it has the agent look, so
// an approval given meanwhile is used.
export async function runScenario(
  engine: Engine,
  agent: Dispatcher,
  bank: SandboxBank,
  obligation: Obligation,
  scenario: Scenario,
): Promise<void> {
  const invoiceId: string = obligation.invoiceId;
  const thread: SupplierEmail[] = loadEmails(scenario.emailsName, invoiceId);

  if (heldBeforePaying(engine.ledger, obligation)) {
    bank.expectOriginal(invoiceId, scenario.bankOutcome);
    agent.wake(invoiceId);
    await agent.whenIdle(invoiceId);
    await untilAtRest(engine.ledger, agent, bank, invoiceId);
    return;
  }
  let original: Transfer | null;
  try {
    original = await agent.run(
      invoiceId,
      (): Promise<Transfer | null> =>
        bank.scripting(invoiceId, (): Promise<Transfer | null> => startPayment(engine, obligation)),
    );
  } catch (error: unknown) {
    // startPayment planned a look to try again, and the bank gives the original
    // that look sends the scenario's outcome.
    bank.expectOriginal(invoiceId, scenario.bankOutcome);
    throw error;
  }
  if (original === null) {
    bank.expectOriginal(invoiceId, scenario.bankOutcome);
    agent.wake(invoiceId);
    await agent.whenIdle(invoiceId);
    return;
  }
  await bank.run(invoiceId, (): Promise<void> => bank.send(original.id));
  for (const email of thread) {
    deliver(engine.ledger, obligation, [email]);
    agent.wake(invoiceId);
    await agent.whenIdle(invoiceId);
  }
  await bank.run(invoiceId, (): Promise<void> =>
    bank.settle(original.id, scenario.bankOutcome),
  );

  if (!(await untilAtRest(engine.ledger, agent, bank, invoiceId))) {
    return;
  }
  const replaced: boolean = engine.ledger
    .attempts(invoiceId)
    .some((attempt: Attempt): boolean => attempt.kind === "replacement");
  if (replaced && engine.ledger.obligation(invoiceId)?.state === "settled") {
    await agent.run(invoiceId, (): PayAgainResult => payAgain(engine.ledger, invoiceId));
  }
}

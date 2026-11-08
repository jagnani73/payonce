import { randomInt } from "node:crypto";
import { getAvailableMinor } from "../airwallex/balances.js";
import {
  DE_SWIFT_SUPPLIER,
  US_BANK_CHANGE_SUPPLIER,
  US_LOCAL_SUPPLIER,
  findOrCreateBeneficiary,
  type Beneficiary,
  type BeneficiarySpec,
} from "../airwallex/beneficiaries.js";
import type { Transfer } from "../airwallex/transfers.js";
import type { SupplierEmail } from "../domain/emails.js";
import { heldBeforePaying } from "../store/read/facts.js";
import type { Dispatcher } from "./dispatcher.js";
import { loadEmails } from "../reader/emails.js";
import { deliver } from "./emails.js";
import type { Engine } from "./engine.js";
import { startPayment } from "./first-payment.js";
import { waitOnOutage } from "./look.js";
import { openPayment, type Payee } from "./new-payment.js";
import { payAgain, type PayAgainResult } from "./person.js";
import { RailOutageError, type Attempt, type Ledger, type Obligation, type TransferMethod } from "../store/ledger.js";
import { bankOutcomeOf, type SandboxBank } from "./sandbox-bank.js";

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
  // The wallet the invoice is paid from, when not its own currency's. Such an
  // invoice is held before paying, so a person approves the exchange rate.
  sourceCurrency?: string;
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
  {
    id: "eur-from-usd",
    label: "EUR invoice paid from USD, SWIFT",
    supplier: "Example Supplier GmbH",
    beneficiary: DE_SWIFT_SUPPLIER,
    currency: "EUR",
    amountMinor: 400_000,
    transferMethod: "SWIFT",
    tightReserveFeeMinor: null,
    supplierPhone: null,
    beneficiaryPerRun: false,
    sourceCurrency: "USD",
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

// The scenario's supplier: its beneficiary, found or created in Airwallex, and
// the invoice's own floor when the scenario sets one.
async function scenarioPayee(engine: Engine, def: ScenarioDef, invoiceId: string): Promise<Payee> {
  const beneficiary: Beneficiary = await findOrCreateBeneficiary(
    engine.client,
    def.beneficiaryPerRun
      ? { ...def.beneficiary, nickname: `${def.beneficiary.nickname} ${invoiceId}` }
      : def.beneficiary,
  );
  const invoiceFloorMinor: number =
    def.tightReserveFeeMinor === null
      ? 0
      : (await getAvailableMinor(engine.client, def.sourceCurrency ?? def.currency)) -
        def.amountMinor -
        Math.round(def.tightReserveFeeMinor * 1.5);
  return {
    beneficiaryId: beneficiary.id,
    supplier: def.supplier,
    supplierDomain: SUPPLIER_DOMAIN,
    supplierPhone: def.supplierPhone,
    invoiceFloorMinor,
  };
}

// Records the demo invoice as an obligation to the scenario's supplier, through
// openPayment with the scenario's own values. starter is the name the person
// starting it gave, and that person cannot approve its replacement. dueDate is
// when the supplier expects the money, or null.
export async function openScenario(
  engine: Engine,
  invoiceId: string,
  scenarioId: string,
  starter: string,
  dueDate: string | null = null,
): Promise<Obligation> {
  const def: ScenarioDef | undefined = SCENARIOS.find(
    (scenario: ScenarioDef): boolean => scenario.id === scenarioId,
  );
  if (def === undefined) {
    throw new Error(`Unknown scenario ${scenarioId}`);
  }
  return openPayment(
    engine,
    {
      invoiceId,
      amountMinor: def.amountMinor,
      currency: def.currency,
      wallet: def.sourceCurrency ?? def.currency,
      transferMethod: def.transferMethod,
      dueDate,
      starter,
    },
    (): Promise<Payee> => scenarioPayee(engine, def, invoiceId),
  );
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

// The scripted part of an incident once a look has sent its original: the bank
// sends it, the supplier writes in while it is in flight, and then the bank pays
// or fails it. Nobody tells the agent what the bank did: it hears from Airwallex
// by webhook or finds out on a status check. Once the incident has settled down,
// a paid replacement is followed by a second payment the lock refuses. False when
// the invoice is still not at rest when the time runs out.
async function playOriginal(
  engine: Engine,
  agent: Dispatcher,
  bank: SandboxBank,
  obligation: Obligation,
  scenario: Scenario,
  original: { transferId: string; reference: string | null },
): Promise<boolean> {
  const invoiceId: string = obligation.invoiceId;
  const thread: SupplierEmail[] = loadEmails(scenario.emailsName, invoiceId);
  await bank.run(invoiceId, (): Promise<void> => bank.send(original.transferId, original.reference));
  for (const email of thread) {
    deliver(engine.ledger, obligation, [email]);
    agent.wake(invoiceId);
    await agent.whenIdle(invoiceId);
  }
  await bank.run(invoiceId, (): Promise<void> =>
    bank.settle(original.transferId, bankOutcomeOf(scenario.bankOutcome), original.reference),
  );

  if (!(await untilAtRest(engine.ledger, agent, bank, invoiceId))) {
    return false;
  }
  const replaced: boolean = engine.ledger
    .attempts(invoiceId)
    .some((attempt: Attempt): boolean => attempt.kind === "replacement");
  if (replaced && engine.ledger.obligation(invoiceId)?.state === "settled") {
    await agent.run(invoiceId, (): PayAgainResult => payAgain(engine.ledger, invoiceId));
  }
  return true;
}

// Held for the approval every payment a person starts waits for, and for nothing
// more specific, with nothing tried yet.
function waitsForApprovalAlone(ledger: Ledger, invoiceId: string): boolean {
  const held: Obligation | undefined = ledger.obligation(invoiceId);
  return (
    held?.state === "escalated" &&
    ledger.attempts(invoiceId).length === 0 &&
    ledger.reasonOf(held)?.code === "person-started"
  );
}

// The scripted sandbox incident. Its first payment waits for an approval, as
// every payment a person starts does, so starting it sends nothing. Once a person
// approves it, the look that sends the original hands it to the script
// (playOriginal), in this process. An invoice held for something more specific,
// such as a second bill or an exchange rate, or whose first send Airwallex
// refused, is played as before: the bank gives its original the scenario's
// outcome, and no supplier emails arrive. Run again on a held invoice, it has the
// agent look, so an approval given meanwhile is used, and then waits for the
// script to play. True when the invoice waits for a person with nothing sent;
// false when it is still not at rest when the time runs out.
export async function runScenario(
  engine: Engine,
  agent: Dispatcher,
  bank: SandboxBank,
  obligation: Obligation,
  scenario: Scenario,
): Promise<boolean> {
  const invoiceId: string = obligation.invoiceId;
  const continuing: boolean = heldBeforePaying(engine.ledger, obligation);
  // While this run waits on its own looks, it waits for the script too, and a
  // failure reaches its caller. Later, the bank reports it.
  let watching: boolean = true;
  let played: Promise<boolean> | null = null;
  const play = (transferId: string, reference: string | null, onError: (error: unknown) => void): boolean => {
    // Only the original sent on that first approval. One sent after Airwallex
    // refused the first is the bank's.
    const first: Attempt | undefined = engine.ledger
      .attempts(invoiceId)
      .find((attempt: Attempt): boolean => attempt.kind === "original");
    if (first?.transferId !== transferId) {
      return false;
    }
    const run: Promise<boolean> = playOriginal(engine, agent, bank, obligation, scenario, { transferId, reference });
    if (watching) {
      played = run;
    } else {
      run.catch(onError);
    }
    return true;
  };
  bank.expectOriginal(invoiceId, scenario.bankOutcome);
  try {
    if (!continuing) {
      // startPayment holds it, so the next look asks a person.
      await agent.run(invoiceId, (): Promise<Transfer | null> => startPayment(engine, obligation));
    }
    if (waitsForApprovalAlone(engine.ledger, invoiceId)) {
      bank.scriptOriginal(invoiceId, play);
    }
    agent.wake(invoiceId);
    await agent.whenIdle(invoiceId);
  } catch (error: unknown) {
    // An outage on its rail holds the first payment until a person ends it, and
    // the bank gives the original sent then the scenario's outcome. No supplier
    // emails arrive for it.
    if (error instanceof RailOutageError) {
      waitOnOutage(engine, invoiceId, error);
      return true;
    }
    throw error;
  } finally {
    watching = false;
  }
  if (played !== null) {
    return played;
  }
  return continuing && engine.ledger.attempts(invoiceId).length > 0 ? untilAtRest(engine.ledger, agent, bank, invoiceId) : true;
}

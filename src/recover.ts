import { AirwallexClient } from "./airwallex/client.js";
import { Dispatcher } from "./dispatcher.js";
import { noteError, type Engine } from "./engine.js";
import { Ledger, LEDGER_PATH, type Obligation } from "./ledger.js";
import { readerFromEnv } from "./reader.js";
import { SandboxBank } from "./sandbox-bank.js";
import {
  DEFAULT_EMAILS,
  DEFAULT_SCENARIO,
  newInvoiceId,
  openScenario,
  runScenario,
  untilAtRest,
} from "./scenario.js";
import { Watcher } from "./watcher.js";

const DEFAULT_OUTCOME: string = "CHANNEL_TIMEOUT";
// The CLI has no webhook receiver, so it checks the bank often.
const CHECK_EVERY_MS: number = 2_000;

async function main(): Promise<void> {
  const bankOutcome: string = process.argv[2] ?? DEFAULT_OUTCOME;
  const client: AirwallexClient = AirwallexClient.fromEnv();
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  const bank: SandboxBank = new SandboxBank(
    client,
    (invoiceId: string, error: unknown): void => noteError(ledger, invoiceId, error),
  );
  const engine: Engine = { client, ledger, reader: readerFromEnv(), bank };
  const agent: Dispatcher = new Dispatcher(engine);
  const watcher: Watcher = new Watcher(engine, agent, CHECK_EVERY_MS);
  const invoiceId: string = process.argv[3] ?? newInvoiceId(ledger);
  const emailsName: string = process.argv[4] ?? DEFAULT_EMAILS;
  const scenarioId: string = process.argv[5] ?? DEFAULT_SCENARIO;

  watcher.start();
  try {
    const existing: Obligation | undefined = ledger.obligation(invoiceId);
    if (existing !== undefined && ledger.attempts(invoiceId).length > 0) {
      console.log(`${invoiceId} is already in the ledger`);
      agent.wake(invoiceId);
      await untilAtRest(ledger, agent, bank, invoiceId);
    } else {
      // An obligation with no payment yet is a run that stopped before paying.
      console.log(`${existing === undefined ? "New incident" : "Starting"} ${invoiceId}`);
      await runScenario(
        engine,
        agent,
        bank,
        existing ?? (await openScenario(engine, invoiceId, scenarioId)),
        { bankOutcome, emailsName },
      );
    }
  } catch (error: unknown) {
    noteError(ledger, invoiceId, error);
    process.exitCode = 1;
  } finally {
    watcher.stop();
  }
  console.log(`  state: ${ledger.obligation(invoiceId)?.state ?? "unknown"}`);
}

await main();

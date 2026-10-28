import { userInfo } from "node:os";
import { AirwallexClient } from "./airwallex/client.js";
import { policyFromEnv } from "./approvers.js";
import { Dispatcher } from "./dispatcher.js";
import { noteError, type Engine } from "./engine.js";
import { describeQuotes } from "./fx.js";
import { Ledger, LEDGER_PATH, type Obligation, type RunRow } from "./ledger.js";
import { readerFromEnv } from "./reader.js";
import { describeFloors, reserveFromEnv } from "./reserve.js";
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
    (invoiceId: string): string | null => ledger.runRowOf(invoiceId)?.sandboxOutcome ?? null,
  );
  const engine: Engine = {
    client,
    ledger,
    reader: readerFromEnv(),
    approvals: policyFromEnv(),
    reserve: reserveFromEnv(),
    bank,
  };
  console.log(describeFloors(engine.reserve));
  console.log(describeQuotes());
  const agent: Dispatcher = new Dispatcher(engine);
  const watcher: Watcher = new Watcher(engine, agent, CHECK_EVERY_MS);
  const invoiceId: string = process.argv[3] ?? newInvoiceId(ledger);
  const emailsName: string = process.argv[4] ?? DEFAULT_EMAILS;
  const scenarioId: string = process.argv[5] ?? DEFAULT_SCENARIO;
  // Who started the incident. The login name stands in when none is given.
  const startedBy: string = process.argv.slice(6).join(" ").trim() || userInfo().username;

  // A pay run's invoice sends its first payment from the server, in the run's
  // order, and never from a scenario script. This watcher leaves such rows alone.
  const fromRun: RunRow | undefined = ledger.runRowOf(invoiceId);
  if (fromRun !== undefined && ledger.attempts(invoiceId).length === 0) {
    console.log(`${invoiceId} belongs to pay run ${fromRun.runId}, and the server sends it`);
    process.exitCode = 1;
    return;
  }

  watcher.start();
  try {
    const existing: Obligation | undefined = ledger.obligation(invoiceId);
    if (
      existing !== undefined &&
      (ledger.attempts(invoiceId).length > 0 || existing.state === "rejected")
    ) {
      console.log(`${invoiceId} is already in the ledger`);
      agent.wake(invoiceId);
      await untilAtRest(ledger, agent, bank, invoiceId);
    } else {
      // An obligation with no payment yet is a run that stopped before paying, or
      // one PayOnce held before paying.
      console.log(`${existing === undefined ? "New incident" : "Starting"} ${invoiceId}`);
      await runScenario(
        engine,
        agent,
        bank,
        existing ?? (await openScenario(engine, invoiceId, scenarioId, startedBy)),
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

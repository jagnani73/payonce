import { AirwallexClient } from "./airwallex/client.js";
import {
  DEFAULT_SCENARIO,
  newInvoiceId,
  noteError,
  openScenario,
  resumeIncident,
  runScenario,
  type Engine,
} from "./engine.js";
import { KeywordReader } from "./keyword-reader.js";
import { Ledger, LEDGER_PATH, type Obligation } from "./ledger.js";

const DEFAULT_FAILURE_TYPE: string = "CHANNEL_TIMEOUT";
const DEFAULT_EMAILS: string = "nothing-arrived";

async function main(): Promise<void> {
  const failureType: string = process.argv[2] ?? DEFAULT_FAILURE_TYPE;
  const engine: Engine = {
    client: AirwallexClient.fromEnv(),
    ledger: new Ledger(LEDGER_PATH),
    reader: new KeywordReader(),
  };
  const invoiceId: string = process.argv[3] ?? newInvoiceId(engine.ledger);
  const emailsName: string = process.argv[4] ?? DEFAULT_EMAILS;
  const scenarioId: string = process.argv[5] ?? DEFAULT_SCENARIO;

  try {
    const existing: Obligation | undefined = engine.ledger.obligation(invoiceId);
    if (existing !== undefined && engine.ledger.attempts(invoiceId).length > 0) {
      console.log(`${invoiceId} is already in the ledger`);
      await resumeIncident(engine, invoiceId);
    } else {
      // An obligation with no payment yet is a run that stopped before paying.
      console.log(`${existing === undefined ? "New incident" : "Starting"} ${invoiceId}`);
      await runScenario(
        engine,
        existing ?? (await openScenario(engine, invoiceId, scenarioId)),
        { failureType, emailsName },
      );
    }
  } catch (error: unknown) {
    noteError(engine.ledger, invoiceId, error);
    process.exitCode = 1;
  }
  console.log(`  state: ${engine.ledger.obligation(invoiceId)?.state ?? "unknown"}`);
}

await main();

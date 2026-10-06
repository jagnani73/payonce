import { AirwallexClient } from "./airwallex/client.js";
import {
  DEFAULT_SCENARIO,
  newInvoiceId,
  openScenario,
  resumeIncident,
  runScenario,
  type Engine,
} from "./engine.js";
import { KeywordReader } from "./keyword-reader.js";
import { Ledger, LEDGER_PATH } from "./ledger.js";

const DEFAULT_FAILURE_TYPE: string = "CHANNEL_TIMEOUT";
const DEFAULT_EMAILS: string = "nothing-arrived";

async function main(): Promise<void> {
  const failureType: string = process.argv[2] ?? DEFAULT_FAILURE_TYPE;
  const invoiceId: string = process.argv[3] ?? newInvoiceId();
  const emailsName: string = process.argv[4] ?? DEFAULT_EMAILS;
  const scenarioId: string = process.argv[5] ?? DEFAULT_SCENARIO;
  const engine: Engine = {
    client: AirwallexClient.fromEnv(),
    ledger: new Ledger(LEDGER_PATH),
    reader: new KeywordReader(),
  };

  if (engine.ledger.attempts(invoiceId).length > 0) {
    console.log(`${invoiceId} is already in the ledger`);
    await resumeIncident(engine, invoiceId);
  } else {
    console.log(`New incident ${invoiceId}`);
    await runScenario(engine, await openScenario(engine, invoiceId, scenarioId), {
      failureType,
      emailsName,
    });
  }
  console.log(`  state: ${engine.ledger.obligation(invoiceId)?.state ?? "unknown"}`);
}

await main();

import type { AirwallexClient } from "../airwallex/client.js";
import { readerFor } from "../reader/reader.js";
import type { Settings } from "../settings.js";
import { Ledger, LEDGER_PATH } from "../store/ledger.js";
import type { Engine } from "./engine.js";

// problem is why the settings make no Airwallex client: a missing credential, or
// an address that is not the sandbox, in PayOnce's words.
export type EngineBuild = { engine: Engine; problem: null } | { engine: null; problem: string };

// The one place an Engine is built. The Airwallex client comes first, so a
// command whose credentials are missing stops before it creates a ledger file.
// The ledger is the one the command already opened, or LEDGER_PATH, and an error
// opening it is thrown as it is. The sandbox bank, where a command plays it, is
// added by that command, since it is built on this client and ledger.
export function createEngine(settings: Settings, ledger?: Ledger): EngineBuild {
  let client: AirwallexClient;
  try {
    client = settings.airwallex.client();
  } catch (error: unknown) {
    return { engine: null, problem: error instanceof Error ? error.message : String(error) };
  }
  return {
    engine: {
      client,
      ledger: ledger ?? new Ledger(LEDGER_PATH),
      reader: readerFor(settings.models.readerServices()),
      approvals: settings.approvals,
      reserve: settings.reserve,
    },
    problem: null,
  };
}

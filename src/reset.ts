import { existsSync, renameSync } from "node:fs";
import { LEDGER_PATH } from "./ledger.js";

// Starts a clean ledger by moving the current one aside. Nothing is deleted, and
// transfers already sent in the sandbox stay there.
function main(): void {
  if (!existsSync(LEDGER_PATH)) {
    console.log("There is no ledger yet, so there is nothing to reset");
    return;
  }
  const stamp: string = new Date().toISOString().replace(/[:.]/g, "-");
  const archived: string = LEDGER_PATH.replace(/\.db$/, `.${stamp}.db`);
  try {
    renameSync(LEDGER_PATH, archived);
  } catch (error: unknown) {
    console.log(`Could not move ${LEDGER_PATH}. Stop pnpm ui and try again`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Moved the ledger to ${archived}. The next run starts a new one`);
}

main();

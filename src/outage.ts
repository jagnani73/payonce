import { policyFromEnv, type ApprovalPolicy } from "./approvers.js";
import { outageHolding } from "./incident-board.js";
import { Ledger, LEDGER_PATH } from "./ledger.js";
import {
  describeOutageRule,
  endOutage,
  outageRuleFromEnv,
  outagesReport,
  sendsText,
  type CountedPayout,
  type EndedOutage,
  type HeldItem,
  type OutagesReport,
  type OutageView,
} from "./outages.js";

const ENDED_SHOWN: number = 5;

// Without a .env no approver list is set and the default rule applies, and
// nothing is printed about it.
function loadEnv(): void {
  try {
    process.loadEnvFile(".env");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function show(view: OutageView): void {
  console.log(`Outage ${view.id} on ${view.rail}, ${view.state}`);
  console.log(`  ${view.text}`);
  for (const payout of view.counted) {
    console.log(`  counted  ${describeCounted(payout)}`);
  }
  for (const item of view.held) {
    console.log(`  held     ${describeHeld(item)}`);
  }
  if (view.state === "active") {
    console.log(`  ending   sends ${sendsText(view.sends)}`);
  }
  if (view.state === "ended") {
    console.log(`  ended    by ${view.endedBy ?? ""} at ${view.endedAt ?? ""}: ${view.endNote ?? ""}`);
  }
}

function describeCounted(payout: CountedPayout): string {
  const invoice: string = payout.invoiceId === null ? "no invoice" : payout.invoiceId;
  return `${payout.reference} (${invoice}, ${payout.origin === "payonce" ? "sent by PayOnce" : "sent outside PayOnce"}), ${payout.code}, seen ${payout.seenAt}`;
}

function describeHeld(item: HeldItem): string {
  const what: string = item.invoiceId !== null ? item.invoiceId : `pay run ${item.runId ?? ""}`;
  return `${what}: ${item.what}, now ${item.state ?? "not in the ledger"}`;
}

// pnpm outage lists the active outages and the last few ended. pnpm outage end
// <ID> <NAME> <NOTE> ends one, as the page's button does. It writes only the
// ledger: the server's watcher picks up what the outage held on its next check.
function main(): void {
  loadEnv();
  const command: string | undefined = process.argv[2];
  const policy: ApprovalPolicy = policyFromEnv();
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  if (command === undefined) {
    const report: OutagesReport = outagesReport(ledger, policy, outageHolding(ledger));
    console.log(describeOutageRule(outageRuleFromEnv()));
    if (report.active.length === 0) {
      console.log("No outage is active");
    }
    for (const view of [...report.active, ...report.recent.slice(0, ENDED_SHOWN)]) {
      show(view);
    }
    console.log(
      report.enders === null
        ? "Any named person may end an outage, because no approver list is set"
        : `An outage is ended by a name in APPROVERS: ${report.enders.join(", ")}`,
    );
    return;
  }
  const id: number = Number(process.argv[3]);
  const name: string = process.argv[4] ?? "";
  const note: string = process.argv.slice(5).join(" ");
  if (command !== "end" || !Number.isInteger(id) || name === "" || note.trim() === "") {
    console.log("Usage: pnpm outage [end <ID> <NAME> <NOTE...>]");
    process.exitCode = 1;
    return;
  }
  try {
    const ended: EndedOutage = endOutage(ledger, policy, id, name, note, outageHolding(ledger));
    console.log(
      `Ended. The server's watcher picks up the ${ended.holds.length} ${ended.holds.length === 1 ? "invoice or run" : "invoices and runs"} it held on its next check, or the next pnpm ui or pnpm recover does`,
    );
  } catch (error: unknown) {
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();

import { policyFromEnv, type ApprovalPolicy } from "./approvers.js";
import { outageHolding } from "./incident-board.js";
import { Ledger, LEDGER_PATH, type OutageHold } from "./ledger.js";
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
import { printable, say, shownFailureCode, shownReference } from "./printable.js";

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
  say(`Outage ${view.id} on ${view.rail}, ${view.state}`);
  // It names the stored codes, so it prints as one line.
  say(`  ${printable(view.text)}`);
  say(`  declared ${view.declaredAt}`);
  for (const payout of view.counted) {
    say(`  counted  ${describeCounted(payout)}`);
  }
  for (const item of view.held) {
    say(`  held     ${describeHeld(item)}`);
  }
  if (view.state === "active") {
    say(`  ending   sends ${sendsText(view.sends)}`);
  }
  if (view.state === "ended") {
    say(`  ended    by ${view.endedBy ?? ""} at ${view.endedAt ?? ""}: ${view.endNote ?? ""}`);
  }
}

function describeCounted(payout: CountedPayout): string {
  const invoice: string = payout.invoiceId === null ? "no invoice" : payout.invoiceId;
  return `${shownReference(payout.reference)} (${invoice}, ${payout.origin === "payonce" ? "sent by PayOnce" : "sent outside PayOnce"}), ${shownFailureCode(payout.code)}, failed ${payout.failedAt}, seen ${payout.seenAt}`;
}

function describeHeld(item: HeldItem): string {
  const what: string = item.invoiceId !== null ? item.invoiceId : `pay run ${item.runId ?? ""}`;
  return `${what}: ${item.what}, now ${item.state ?? "not in the ledger"}`;
}

// What the end leaves for PayOnce to look at: the open and escalated invoices it
// held, whose next look the end made due, and the pay runs still waiting, which
// only the server releases. A closed invoice or a run released or cancelled since
// gets nothing.
function pickedUpText(ledger: Ledger, holds: OutageHold[]): string {
  const invoices: number = holds.filter((hold: OutageHold): boolean => {
    const state: string | undefined = hold.invoiceId === null ? undefined : ledger.obligation(hold.invoiceId)?.state;
    return state === "open" || state === "escalated";
  }).length;
  const runs: number = holds.filter(
    (hold: OutageHold): boolean => hold.runId !== null && ledger.run(hold.runId)?.state === "waiting",
  ).length;
  if (invoices === 0 && runs === 0) {
    return "Ended. Nothing it held is still waiting, so PayOnce has nothing to pick up";
  }
  const what: string[] = [
    ...(invoices === 0 ? [] : [`${invoices} ${invoices === 1 ? "invoice" : "invoices"}`]),
    ...(runs === 0 ? [] : [`${runs} ${runs === 1 ? "pay run" : "pay runs"}`]),
  ];
  return `Ended. The server's watcher picks up the ${what.join(" and ")} it held on its next check, or the next ${runs === 0 ? "pnpm ui or pnpm recover" : "pnpm ui"} does`;
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
    say(describeOutageRule(outageRuleFromEnv()));
    if (report.active.length === 0) {
      say("No outage is active");
    }
    for (const view of [...report.active, ...report.recent.slice(0, ENDED_SHOWN)]) {
      show(view);
    }
    say(
      report.enders === null
        ? "Any named person may end an outage, because no approver list is set"
        : report.enders.length === 0
          ? `Nobody can end an outage while ${policy.problem ?? "the approval settings cannot be read"}`
          : `An outage is ended by a name in APPROVERS: ${report.enders.join(", ")}`,
    );
    return;
  }
  const id: number = Number(process.argv[3]);
  const name: string = process.argv[4] ?? "";
  const note: string = process.argv.slice(5).join(" ");
  if (command !== "end" || !Number.isInteger(id) || name === "" || note.trim() === "") {
    say("Usage: pnpm outage [end <ID> <NAME> <NOTE...>]");
    process.exitCode = 1;
    return;
  }
  try {
    const ended: EndedOutage = endOutage(ledger, policy, id, name, note, outageHolding(ledger));
    say(pickedUpText(ledger, ended.holds));
  } catch (error: unknown) {
    say(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();

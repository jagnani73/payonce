import type { ApprovalPolicy } from "../../domain/approvers.js";
import { loadEnvIfPresent } from "../../env-file.js";
import { outageHolding } from "../../views/incident-board.js";
import { Ledger, LEDGER_PATH, type OutageHold } from "../../store/ledger.js";
import { endOutage, type EndedOutage } from "../../outages/outages.js";
import { loadSettings, type Settings } from "../../settings.js";
import { say, shownReference } from "../../text/printable.js";
import type { OutageCardView, OutagesView } from "../../views/contract.js";
import { outagesView } from "../../views/treasury.js";
import { heading, listOf, put, putFields, utc, whyNot, type Field } from "./view-text.js";

const ENDED_SHOWN: number = 5;

function countedText(counted: OutageCardView["counted"][number]): string {
  const failure: string = counted.failure === null ? "no failure code" : `${counted.failure.code} (${counted.failure.words})`;
  return `${shownReference(counted.reference)}, ${counted.invoiceId ?? "no invoice"}, ${failure}, failed ${utc(counted.failedAt)}`;
}

function endersText(card: OutageCardView): string {
  const refused: string | null = whyNot(card.end);
  if (refused !== null) {
    return refused;
  }
  return card.end.enders === null
    ? "any named person, because no approver list is set"
    : card.end.enders.length === 0
      ? "nobody on the approver list"
      : listOf(card.end.enders);
}

// One outage as the Outages card shows it.
function show(card: OutageCardView): void {
  heading(
    card.state === "active"
      ? `Outage ${card.id} on ${card.rail}, active since ${utc(card.declaredAt)}`
      : `Outage ${card.id} on ${card.rail}, ended at ${utc(card.endedAt)} by ${card.endedBy ?? "a person"}: ${card.endNote ?? ""}`,
  );
  put(card.text, 1);
  const fields: Field[] = [
    ["Declared", utc(card.declaredAt)],
    ["Counted", card.counted.length === 0 ? "none" : card.counted.map(countedText)],
    [
      card.state === "active" ? "Pausing" : "Paused",
      card.pausing.length === 0 ? "nothing" : card.pausing.map((item: OutageCardView["pausing"][number]): string => item.label),
    ],
  ];
  if (card.state === "active") {
    fields.push(["Who can end", endersText(card)]);
  }
  putFields(fields);
  if (card.sendsText !== null) {
    put(card.sendsText, 1);
  }
  if (card.state === "active" && card.end.allowed) {
    put(`End it with pnpm outage end ${card.id} NAME NOTE`, 1);
  }
}

// What the end leaves for PayOnce to look at: the open and escalated invoices it
// held, whose next check the end made due, and the pay runs still waiting, which
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
    return "Ended. Nothing it paused is still waiting, so PayOnce has nothing to pick up";
  }
  const what: string[] = [
    ...(invoices === 0 ? [] : [`${invoices} ${invoices === 1 ? "payment" : "payments"}`]),
    ...(runs === 0 ? [] : [`${runs} ${runs === 1 ? "pay run" : "pay runs"}`]),
  ];
  return `Ended. The server picks up the ${what.join(" and ")} it paused at its next check, or the next ${runs === 0 ? "pnpm ui or pnpm recover" : "pnpm ui"} does`;
}

// pnpm outage lists the active outages and the last few ended, as Treasury's
// Outages tab does. pnpm outage end <ID> <NAME> <NOTE> ends one, as the page's
// button does. It writes only the ledger: the server's watcher picks up what the
// outage paused at its next check.
function main(): void {
  // Without a .env no approver list is set and the default rule applies, and
  // nothing is printed about it.
  loadEnvIfPresent();
  const settings: Settings = loadSettings();
  const command: string | undefined = process.argv[2];
  const policy: ApprovalPolicy = settings.approvals;
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  if (command === undefined) {
    const view: OutagesView = outagesView(ledger, settings, Date.now());
    put(view.rule.text);
    if (view.rule.problem !== null) {
      put(view.rule.problem);
    }
    if (view.active.length === 0) {
      put("No outage is active");
    }
    for (const card of [...view.active, ...view.ended.slice(0, ENDED_SHOWN)]) {
      show(card);
    }
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

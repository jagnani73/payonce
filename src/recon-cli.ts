import { existsSync } from "node:fs";
import { AirwallexClient } from "./airwallex/client.js";
import { NameError } from "./approvers.js";
import { Ledger, LEDGER_PATH } from "./ledger.js";
import { formatMoney } from "./money.js";
import { printable, say, sayError } from "./printable.js";
import { shownCurrency, type WalletSummary } from "./recon-match.js";
import {
  breakView,
  explainBreaks,
  ExplainInputError,
  explainItems,
  reconcileOffline,
  reconcileOnce,
  reconReport,
  type BreakView,
  type KindCount,
  type ReconReport,
  type RunOutcome,
  type RunView,
  type WaitingView,
} from "./reconcile.js";
import {
  ReconChangedError,
  ReconKindsError,
  ReconUnknownError,
  type BreakChanges,
  type ExplainItem,
  type ReconBreak,
} from "./recon-store.js";

// pnpm reconcile: one run against Airwallex (GETs only), the stored record
// matched again with no Airwallex call, the last report, and a person explaining
// breaks. It loads .env itself when there is one, as pnpm board does, because
// only the live run needs credentials.
const USAGE: string = `Usage:
  pnpm reconcile                                  one run against Airwallex (GETs only), then the report
  pnpm reconcile offline                          match what the ledger holds again, with no Airwallex call
  pnpm reconcile show [CURRENCY]                  the last report, from the ledger alone
  pnpm reconcile explain <ID[,ID...]>             the breaks and the facts each was found with
  pnpm reconcile explain <ID[,ID...]> <NAME> <NOTE> --facts=<FP[,FP...]>`;

const FACTS_SHOWN: number = 12;
const STATUS_TEXT: Record<WalletSummary["status"], string> = {
  "adds-up": "adds up to Airwallex's available balance",
  gap: "its movements do not add up",
  differs: "its movements do not end at Airwallex's available balance",
  moved: "the balance moved while PayOnce read it, so the closing balance was not checked",
  unchecked: "the movements add up, and the closing balance was not checked",
  empty: "no movements since the ledger started",
  "not-two-decimal": "not reconciled: PayOnce handles two-decimal currencies only",
  unreadable: "a movement cannot be read, so the wallet is not checked",
};

function loadEnv(): void {
  try {
    process.loadEnvFile(".env");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function fail(message: string): void {
  say(message);
  process.exitCode = 1;
}

function money(minor: number | null, currency: string): string {
  return minor === null ? "not known" : formatMoney(minor, currency);
}

function runLine(run: RunView): string {
  const from: string = run.ranFrom === "server" ? "the server" : "the terminal";
  const what: string = run.mode === "offline" ? "offline match" : run.fullRead ? "full read" : "last seven days";
  const outcome: string =
    run.outcome === "committed"
      ? "recorded"
      : run.outcome === "stale"
        ? "not recorded, because a run that started later was recorded first"
        : run.outcome === "failed"
          ? `failed: ${run.error ?? "no reason recorded"}`
          : "still running";
  return `Run ${run.id} from ${from} at ${run.startedAt}, ${what}, ${run.reads} ${run.reads === 1 ? "read" : "reads"}, ${outcome}`;
}

function printBreak(item: BreakView, withAction: boolean): void {
  const where: string[] = [
    ...(item.invoiceId === null ? [] : [item.invoiceId]),
    `found ${item.openedAt ?? item.foundAt}`,
    ...(item.goneAt === null ? [] : ["no longer found, still waits for a person"]),
  ];
  say(`    ${printable(`#${item.id}  ${item.text}`)}`);
  say(`          ${printable(where.join(", "))}`);
  if (withAction) {
    say(`          ${printable(item.action)}`);
  }
}

function printReport(report: ReconReport, currency: string | null): void {
  say(`Reconciliation of each wallet since ${report.startedAt}, when the ledger started`);
  if (report.lastRun === null) {
    say("No run is recorded yet. Run pnpm reconcile to read Airwallex");
  } else {
    say(runLine(report.lastRun));
  }
  if (report.lastProblem !== null) {
    say(`Latest: ${runLine(report.lastProblem)}`);
  }
  const wallets: WalletSummary[] = report.wallets.filter(
    (wallet: WalletSummary): boolean => currency === null || wallet.currency === currency,
  );
  if (wallets.length > 0) {
    say("");
    say("Wallets");
  }
  for (const wallet of wallets) {
    const code: string = shownCurrency(wallet.currency) ?? "???";
    say(`  ${code}  ${STATUS_TEXT[wallet.status]}`);
    if (wallet.movements > 0) {
      say(
        `       ${wallet.movements} movements: opening ${money(wallet.openingMinor, code)}, in ${money(wallet.inMinor, code)}, out ${money(Math.abs(wallet.outMinor), code)}, closing ${money(wallet.closingMinor, code)}`,
      );
      say(
        `       ${wallet.payonce} PayOnce's payments, ${wallet.mismatched ?? 0} kept beside a payment because they do not match its invoice, ${wallet.outside} sent outside PayOnce and tied, ${wallet.untied} tied to no invoice, ${wallet.before} from before the ledger, ${wallet.holds} holds, ${wallet.waiting} waiting, ${wallet.unexplained} not explained`,
      );
    }
    say(`       Airwallex's available balance ${money(wallet.availableMinor, code)}`);
  }
  const open: BreakView[] = report.open.filter(
    (item: BreakView): boolean => currency === null || item.currency === currency,
  );
  say("");
  // The counts cover every open break. A currency filter counts what is listed.
  const total: number = currency === null ? report.openCount : open.length;
  say(total === 0 ? "Nothing needs a person" : `Needs a person: ${total}`);
  const kinds: string[] = [...new Set(open.map((item: BreakView): string => item.kind))];
  if (currency === null && report.openCount > report.open.length) {
    const unlisted: KindCount[] = report.byKind.filter((entry: KindCount): boolean => !kinds.includes(entry.kind));
    say(
      `  The newest ${report.open.length} are listed here, and ${report.openCount - report.open.length} more are open${
        unlisted.length === 0
          ? ""
          : `. Not listed yet: ${unlisted.map((entry: KindCount): string => `${entry.label} (${entry.count})`).join(", ")}`
      }`,
    );
  }
  for (const kind of kinds) {
    const ofKind: BreakView[] = open.filter((item: BreakView): boolean => item.kind === kind);
    const counted: number =
      currency === null ? (report.byKind.find((entry: KindCount): boolean => entry.kind === kind)?.count ?? ofKind.length) : ofKind.length;
    say(`  ${ofKind[0]?.label ?? kind}: ${counted}. ${ofKind[0]?.action ?? ""}`);
    for (const item of ofKind) {
      printBreak(item, false);
    }
    say(
      `    Explain them with: pnpm reconcile explain ${ofKind.map((item: BreakView): number => item.id).join(",")}`,
    );
  }
  const waiting: WaitingView[] = report.waiting.filter(
    (item: WaitingView): boolean => currency === null || item.currency === currency,
  );
  if (waiting.length > 0 || report.pending > 0) {
    say("");
    say("Waiting");
    for (const item of waiting) {
      say(`  ${printable(item.text)}${item.dueAt === null ? "" : ` Due ${item.dueAt}`}`);
    }
    if (report.pending > 0) {
      say(
        `  ${report.pending} ${report.pending === 1 ? "break was" : "breaks were"} found once. PayOnce opens one when the next check finds the same facts`,
      );
    }
  }
  const explained: BreakView[] = report.explained.filter(
    (item: BreakView): boolean => currency === null || item.currency === currency,
  );
  if (explained.length > 0) {
    say("");
    say("Explained");
    for (const item of explained) {
      say(
        `  ${printable(`#${item.id}  ${item.label}, by ${item.explainedBy ?? "a name PayOnce does not know"} at ${item.explainedAt ?? "a time not known"}: ${item.note ?? ""}`)}`,
      );
    }
  }
  say("");
  say(
    report.audit.problem === null
      ? `Record: ${report.audit.lines} ${report.audit.lines === 1 ? "line" : "lines"}, the hash chain is intact`
      : `Record: the hash chain breaks. ${report.audit.problem}`,
  );
}

// 1 when the run failed, a wallet does not add up, or a break waits on a person,
// so a script can check it, as pnpm cash does.
function exitFor(report: ReconReport, outcome: RunOutcome | null): number {
  if (outcome !== null && outcome.outcome === "failed") {
    return 1;
  }
  const bad: boolean = report.wallets.some(
    (wallet: WalletSummary): boolean => wallet.status === "gap" || wallet.status === "differs" || wallet.status === "unreadable",
  );
  return bad || report.openCount > 0 ? 1 : 0;
}

function sayOutcome(outcome: RunOutcome): void {
  if (outcome.outcome === "failed") {
    say(`The run failed and changed no break: ${outcome.error}`);
    return;
  }
  if (outcome.outcome === "stale") {
    say("A run that started later was recorded first, so this run recorded nothing");
    return;
  }
  const changes: BreakChanges = outcome.changes;
  say(
    `Run ${outcome.run.id} recorded: ${changes.opened} opened, ${changes.changed} changed, ${changes.cleared} cleared, ${changes.gone} no longer shown, ${changes.pending} found once`,
  );
}

function existingLedger(): Ledger | null {
  if (!existsSync(LEDGER_PATH)) {
    fail("There is no ledger yet, so there is nothing to reconcile");
    return null;
  }
  return new Ledger(LEDGER_PATH);
}

async function runLive(): Promise<void> {
  loadEnv();
  let client: AirwallexClient;
  try {
    client = AirwallexClient.fromEnv();
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  const ledger: Ledger | null = existingLedger();
  if (ledger === null) {
    return;
  }
  const outcome: RunOutcome = await reconcileOnce(client, ledger, "terminal");
  sayOutcome(outcome);
  say("");
  const report: ReconReport = reconReport(ledger);
  printReport(report, null);
  process.exitCode = exitFor(report, outcome);
}

function runOffline(): void {
  loadEnv();
  const ledger: Ledger | null = existingLedger();
  if (ledger === null) {
    return;
  }
  const outcome: RunOutcome = reconcileOffline(ledger, "terminal");
  sayOutcome(outcome);
  say("");
  const report: ReconReport = reconReport(ledger);
  printReport(report, null);
  process.exitCode = exitFor(report, outcome);
}

// Ledger only, read-only, so showing the report never creates or upgrades a file.
function show(raw: string | undefined): void {
  loadEnv();
  const currency: string | null = raw === undefined ? null : raw.trim().toUpperCase();
  if (currency !== null && shownCurrency(currency) === null) {
    fail(USAGE);
    return;
  }
  if (!existsSync(LEDGER_PATH)) {
    fail("There is no ledger yet, so there is nothing to show");
    return;
  }
  const ledger: Ledger = new Ledger(LEDGER_PATH, true);
  if (!ledger.recon().hasTables()) {
    fail("This ledger has no reconciliation yet. Run pnpm reconcile, or open it with pnpm ui");
    return;
  }
  const report: ReconReport = reconReport(ledger);
  printReport(report, currency);
  process.exitCode = exitFor(report, null);
}

function idsOf(raw: string): number[] | null {
  const ids: number[] = raw.split(",").map((part: string): number => (/^[1-9][0-9]{0,9}$/.test(part.trim()) ? Number(part.trim()) : 0));
  return ids.length === 0 || ids.includes(0) ? null : ids;
}

function explain(args: string[]): void {
  const factsArg: string | undefined = args.find((arg: string): boolean => arg.startsWith("--facts="));
  const rest: string[] = args.filter((arg: string): boolean => !arg.startsWith("--facts="));
  const ids: number[] | null = rest[0] === undefined ? null : idsOf(rest[0]);
  // The words after the name are the note, as pnpm close and pnpm outage end take it.
  const note: string = rest.slice(2).join(" ").trim();
  if (ids === null || (rest.length >= 2 && note === "")) {
    fail(USAGE);
    return;
  }
  const ledger: Ledger | null = existingLedger();
  if (ledger === null) {
    return;
  }
  if (rest.length === 1) {
    const shown: BreakView[] = ledger
      .recon()
      .breaksById(ids)
      .filter((item: ReconBreak): boolean => item.state !== "pending")
      .map(breakView);
    for (const id of ids) {
      const view: BreakView | undefined = shown.find((entry: BreakView): boolean => entry.id === id);
      say(
        view === undefined
          ? `#${id}  not open`
          : printable(`#${id}  ${view.state}  facts ${view.fingerprint.slice(0, FACTS_SHOWN)}  ${view.text}`),
      );
    }
    const open: BreakView[] = shown.filter((view: BreakView): boolean => view.state === "open");
    if (open.length > 0) {
      say(
        `To explain the open ones: pnpm reconcile explain ${open.map((view: BreakView): number => view.id).join(",")} <NAME> <NOTE> --facts=${open
          .map((view: BreakView): string => view.fingerprint.slice(0, FACTS_SHOWN))
          .join(",")}`,
      );
    }
    return;
  }
  const facts: string[] = factsArg === undefined ? [] : factsArg.slice("--facts=".length).split(",");
  if (facts.length !== ids.length) {
    fail("Give --facts= with the facts printed for each break, in the same order as the breaks");
    return;
  }
  let items: ExplainItem[];
  try {
    items = explainItems(ids.map((id: number, index: number) => ({ id, fingerprint: (facts[index] ?? "").trim().toLowerCase() })));
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  try {
    const done: BreakView[] = explainBreaks(ledger, items, rest[1] ?? "", note);
    for (const item of done) {
      say(printable(`#${item.id} explained by ${item.explainedBy ?? ""}: ${item.note ?? ""}`));
    }
  } catch (error: unknown) {
    if (
      error instanceof NameError ||
      error instanceof ExplainInputError ||
      error instanceof ReconUnknownError ||
      error instanceof ReconChangedError ||
      error instanceof ReconKindsError
    ) {
      fail(error.message);
      return;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) {
    await runLive();
  } else if (command === "offline" && args.length === 0) {
    runOffline();
  } else if (command === "show" && args.length <= 1) {
    show(args[0]);
  } else if (command === "explain") {
    explain(args);
  } else {
    fail(USAGE);
  }
}

main().catch((error: unknown): void => {
  sayError(error);
  process.exitCode = 1;
});

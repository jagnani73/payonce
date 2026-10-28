import {
  BOARD_GROUPS,
  BOARD_ORIGINS,
  boardReport,
  CURRENCY_PATTERN,
  isBoardGroup,
  isBoardOrigin,
  type BoardEntry,
  type BoardFilters,
  type BoardMoney,
  type BoardReport,
  type BoardTotal,
} from "./incident-board.js";
import { Ledger, LEDGER_PATH } from "./ledger.js";
import { formatMoney } from "./money.js";

// The incident board in the terminal, ranked as the page ranks it. It reads only
// the ledger, with no Airwallex call, and loads .env only if there is one, for the
// bank deadlines. It loads the file itself, because Node's --env-file-if-exists
// says the file is missing once for tsx and again for the script.
const USAGE: string = `Usage: pnpm board [FILTER...]
Filters, in any order: a group (${BOARD_GROUPS.join(", ")}), a currency such as USD, and an origin (${BOARD_ORIGINS.join(", ")})`;

// A three-letter word is a currency only if it is a code Node knows, or a wallet
// already on the board, such as CNH, which Node does not list. Any other word,
// such as "pay", prints the usage.
const KNOWN_CURRENCIES: ReadonlySet<string> = new Set<string>(Intl.supportedValuesOf("currency"));

const ID_WIDTH: number = 16;
const SUPPLIER_WIDTH: number = 28;
const AMOUNT_WIDTH: number = 24;
const INDENT: string = "    ";
// Control characters, which could move the cursor or colour the terminal, and line
// breaks become spaces. Format characters (bidi controls, zero-width characters
// and the rest of Unicode's Cf), which could reverse or hide part of a line, and
// the rest of the tag block are dropped.
const CONTROL: RegExp = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const HIDDEN: RegExp = /[\p{Cf}\u{e0000}-\u{e007f}]/gu;

function fail(message: string): void {
  console.log(message);
  process.exitCode = 1;
}

// Without a .env the default deadlines apply, and nothing is printed about it.
function loadEnv(): void {
  try {
    process.loadEnvFile(".env");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function filtersOf(args: string[]): BoardFilters | null {
  const filters: BoardFilters = { group: null, currency: null, origin: null };
  for (const arg of args) {
    const word: string = arg.trim();
    if (isBoardGroup(word) && filters.group === null) {
      filters.group = word;
    } else if (isBoardOrigin(word) && filters.origin === null) {
      filters.origin = word;
    } else if (CURRENCY_PATTERN.test(word.toUpperCase()) && filters.currency === null) {
      filters.currency = word.toUpperCase();
    } else {
      return null;
    }
  }
  return filters;
}

function utc(at: string): string {
  return `${at.slice(0, 16).replace("T", " ")} UTC`;
}

// How long since an ISO time, in the largest whole unit.
function waited(since: string | null, now: string): string {
  const at: number = since === null ? Number.NaN : Date.parse(since);
  if (!Number.isFinite(at)) {
    return "since not known";
  }
  const minutes: number = Math.max(0, Math.floor((Date.parse(now) - at) / 60_000));
  if (minutes < 1) {
    return "under a minute";
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours: number = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

// A supplier or payee name, or an invoice number from a pay run file, as it is
// safe to print.
function printable(text: string): string {
  return text.replace(HIDDEN, "").replace(CONTROL, " ").trim();
}

function cut(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 3)}...`;
}

function moneyText(money: BoardMoney): string {
  const notes: string[] = [];
  if (money.estimated) {
    notes.push("estimated");
  }
  if (money.feeUnknown > 0) {
    notes.push("fee not known");
  }
  return `${formatMoney(money.minor, money.currency)}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}

function totalLine(total: BoardTotal): string {
  const buckets: [number, string][] = [
    [total.promisedMinor, "approved or being sent"],
    [total.waitingMinor, "waiting on a person"],
    [total.runWaitingMinor, "pay run waiting for approval"],
    [total.withBankMinor, "with the bank"],
  ];
  const parts: string[] = buckets
    .filter(([minor]: [number, string]): boolean => minor !== 0)
    .map(([minor, what]: [number, string]): string => `${what} ${formatMoney(minor, "").trim()}`);
  const notes: string[] = [];
  if (total.estimated) {
    notes.push("part estimated");
  }
  if (total.feeUnknown > 0) {
    notes.push(`fee not known for ${total.feeUnknown}`);
  }
  return `  ${formatMoney(total.minor, total.currency).padStart(AMOUNT_WIDTH)}  ${parts.join(", ")}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}

function entryLines(entry: BoardEntry, now: string): string[] {
  const amount: string =
    entry.wallet === entry.currency
      ? formatMoney(entry.amountMinor, entry.currency)
      : `${formatMoney(entry.amountMinor, entry.currency)} from ${entry.wallet}`;
  const where: string =
    entry.kind === "run-row"
      ? `, pay run ${entry.runId ?? ""}, not released`
      : entry.origin === "pay-run"
        ? `, pay run ${entry.runId ?? ""}`
        : entry.origin === "outside"
          ? ", sent outside PayOnce"
          : "";
  const risk: string =
    entry.atRisk.length === 0 ? "nothing at risk" : `at risk ${entry.atRisk.map(moneyText).join(", ")}`;
  const deadline: string = entry.deadlineAt === null ? "" : `. Deadline ${utc(entry.deadlineAt)}`;
  return [
    `  ${cut(printable(entry.invoiceId), ID_WIDTH)} ${cut(printable(entry.supplier), SUPPLIER_WIDTH)}${amount.padStart(AMOUNT_WIDTH)}  ${risk}, waiting ${waited(entry.waitingSince, now)}${where}`,
    `${INDENT}${entry.why}${deadline}`,
    ...entry.also.map((line: string): string => `${INDENT}Also: ${line}`),
  ];
}

function print(report: BoardReport): void {
  const applied: string[] = [
    report.filters.group === null ? null : `group ${report.filters.group}`,
    report.filters.currency,
    report.filters.origin === null ? null : `origin ${report.filters.origin}`,
  ].filter((part: string | null): part is string => part !== null);
  console.log(`Incident board at ${utc(report.generatedAt)}, from the ledger only`);
  if (applied.length > 0) {
    console.log(`Showing ${report.entries.length} of ${report.all}: ${applied.join(", ")}`);
  }
  console.log("");
  console.log("Money that could still leave a wallet");
  if (report.totals.length === 0) {
    console.log("  None");
  }
  for (const total of report.totals) {
    console.log(totalLine(total));
  }
  for (const group of report.groups) {
    const entries: BoardEntry[] = report.entries.filter((entry: BoardEntry): boolean => entry.group === group.group);
    if (report.filters.group !== null && report.filters.group !== group.group) {
      continue;
    }
    console.log("");
    console.log(`${group.label} (${group.count})`);
    if (entries.length === 0) {
      console.log("  None");
    }
    for (const entry of entries) {
      for (const line of entryLines(entry, report.generatedAt)) {
        console.log(line);
      }
    }
  }
  if (report.all === 0) {
    console.log("");
    console.log("Every invoice in the ledger is closed, and no pay run waits for approval");
  }
  console.log("");
  console.log("PayOnce has no exchange rates, so amounts in different currencies are ranked as plain numbers.");
}

function main(): void {
  const filters: BoardFilters | null = filtersOf(process.argv.slice(2));
  if (filters === null) {
    fail(USAGE);
    return;
  }
  loadEnv();
  const report: BoardReport = boardReport(new Ledger(LEDGER_PATH), filters);
  const currency: string | null = filters.currency;
  if (currency !== null && !KNOWN_CURRENCIES.has(currency) && !report.currencies.includes(currency)) {
    fail(USAGE);
    return;
  }
  print(report);
}

main();

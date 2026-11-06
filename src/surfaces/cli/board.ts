import { CURRENCY_PATTERN } from "../../domain/patterns.js";
import { loadEnvIfPresent } from "../../env-file.js";
import { loadSettings, type Settings } from "../../settings.js";
import { Ledger, LEDGER_PATH } from "../../store/ledger.js";
import { say } from "../../text/printable.js";
import type { HomeView, IncidentRow, IncidentScope, IncidentsView, OutageStrip, QueueGroup, QueueItem, RunRowItem } from "../../views/contract.js";
import { homeView } from "../../views/home.js";
import {
  BOARD_GROUPS,
  BOARD_ORIGINS,
  isBoardGroup,
  isBoardOrigin,
  ORIGIN_LABELS,
  type BoardFilters,
  type BoardGroup,
} from "../../views/incident-board.js";
import { incidentsView } from "../../views/incidents.js";
import { heading, paymentRow, put, putAll, putRows, runRow, table, utc, walletLine, type Listed } from "./view-text.js";

// The incident board in the terminal, from the Incidents and Home views, ranked
// as the page ranks them. It reads only the ledger, with no Airwallex call, and
// loads .env only if there is one, for the bank deadlines and the approvers. It
// loads the file itself, because Node's --env-file-if-exists says the file is
// missing once for tsx and again for the script.
const USAGE: string = `Usage: pnpm board [FILTER...]
Filters, in any order: a group (${BOARD_GROUPS.join(", ")}), a currency such as USD, and an origin (${BOARD_ORIGINS.join(", ")})`;

// A three-letter word is a currency only if it is a code Node knows, or a wallet
// already on the board, such as CNH, which Node does not list. Any other word,
// such as "pay", prints the usage.
const KNOWN_CURRENCIES: ReadonlySet<string> = new Set<string>(Intl.supportedValuesOf("currency"));

// The board's group words, as the Incidents screen's groups.
const SCOPES: Record<BoardGroup, QueueGroup> = {
  person: "needs-you",
  deadline: "bank-late",
  bank: "with-bank",
  open: "payonce",
};

const OPEN_GROUPS: QueueGroup[] = ["needs-you", "bank-late", "with-bank", "payonce"];

function fail(message: string): void {
  say(message);
  process.exitCode = 1;
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

// The pay runs that need someone, from Home, under the same filters.
function runsShown(home: HomeView, filters: BoardFilters): RunRowItem[] {
  return home.needsYou
    .flatMap((item: QueueItem): RunRowItem[] => (item.type === "run" ? [item.row] : []))
    .filter(
      (run: RunRowItem): boolean =>
        (filters.group === null || filters.group === "person") &&
        (filters.origin === null || filters.origin === "pay-run") &&
        (filters.currency === null || run.totals.some((total: { currency: string }): boolean => total.currency === filters.currency)),
    );
}

function putOutage(outage: OutageStrip): void {
  put(`Outage ${outage.id} on ${outage.rail}, pausing ${outage.pausing}`, 1);
  put(outage.sendsText, 2);
  put(`See it with pnpm outage, and end it with pnpm outage end ${outage.id} NAME NOTE`, 2);
}

function print(view: IncidentsView, home: HomeView, filters: BoardFilters): void {
  const label = (group: IncidentScope): string =>
    view.scopes.find((scope: { scope: IncidentScope }): boolean => scope.scope === group)?.label ?? group;
  const applied: string[] = [
    ...(filters.group === null ? [] : [label(SCOPES[filters.group])]),
    ...(filters.currency === null ? [] : [filters.currency]),
    ...(filters.origin === null ? [] : [ORIGIN_LABELS[filters.origin]]),
  ];
  const runs: RunRowItem[] = runsShown(home, filters);
  put(`Incidents at ${utc(view.generatedAt)}, from the ledger only`);
  if (applied.length > 0) {
    put(`Showing ${applied.join(", ")}`);
  }
  if (view.outages.length > 0) {
    heading(`Active rail outages (${view.outages.length}), whatever the filters`);
    view.outages.forEach(putOutage);
  }
  heading(filters.group === null ? "Money by wallet" : "Money by wallet, all groups");
  if (view.totals.length === 0) {
    put("None", 1);
  }
  putAll(table(view.totals.map(walletLine)), 1);
  const open: IncidentRow[] = view.rows.filter((row: IncidentRow): boolean => row.situation.group !== "closed");
  for (const group of OPEN_GROUPS) {
    if (filters.group !== null && SCOPES[filters.group] !== group) {
      continue;
    }
    const rows: Listed[] = [
      ...open.filter((row: IncidentRow): boolean => row.situation.group === group).map((row: IncidentRow): Listed => paymentRow(row, view.generatedAt)),
      ...(group === "needs-you" ? runs.map((run: RunRowItem): Listed => runRow(run, view.generatedAt)) : []),
    ];
    heading(`${label(group)} (${rows.length})`);
    if (rows.length === 0) {
      put("None", 1);
    }
    putRows(rows);
  }
  if (view.ledgerCount === 0) {
    heading("No payments yet. Start one with pnpm recover, or with New payment in pnpm ui");
  } else if (applied.length === 0 && open.length === 0 && runs.length === 0) {
    heading("Every payment in the ledger is closed, and no pay run waits for approval");
  }
  heading("PayOnce has no exchange rates, so amounts in different currencies are ranked as plain numbers.");
}

function main(): void {
  const filters: BoardFilters | null = filtersOf(process.argv.slice(2));
  if (filters === null) {
    fail(USAGE);
    return;
  }
  // Without a .env the default deadlines apply, and nothing is printed about it.
  loadEnvIfPresent();
  const settings: Settings = loadSettings();
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  const now: number = Date.now();
  const view: IncidentsView = incidentsView(ledger, settings, now, {
    scope: filters.group === null ? "all" : SCOPES[filters.group],
    currency: filters.currency,
    origin: filters.origin,
    me: null,
    clean: false,
    q: null,
  });
  const currency: string | null = filters.currency;
  if (currency !== null && !KNOWN_CURRENCIES.has(currency) && !view.wallets.includes(currency)) {
    fail(USAGE);
    return;
  }
  print(view, homeView(ledger, settings, now, null), filters);
}

main();

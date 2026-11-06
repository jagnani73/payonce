import { getBalances, type BalanceState } from "../../airwallex/balances.js";
import { airwallexAdvice, type AirwallexClient, AirwallexError, AirwallexUnreachableError } from "../../airwallex/client.js";
import {
  cashReport,
  payRunLines,
  type CashKind,
  type CashLine,
  type CashReport,
  type CurrencyCash,
} from "../../engine/cash-position.js";
import { loadEnvIfPresent } from "../../env-file.js";
import { Ledger, LEDGER_PATH, readingSoft } from "../../store/ledger.js";
import { formatMoney } from "../../domain/money.js";
import { recordMissingFees } from "../../engine/payments.js";
import { say } from "../../text/printable.js";
import { describeFloors, type ReservePolicy } from "../../domain/reserve.js";
import { loadSettings, type Settings } from "../../settings.js";

const LABEL_WIDTH: number = 34;
const DETAIL_WIDTH: number = 30;
const AMOUNT_WIDTH: number = 16;
const INVOICES_SHOWN: number = 3;

function amount(minor: number | null): string {
  return minor === null ? "Unknown" : formatMoney(minor, "").trim();
}

// A detail too long for its column goes on a line of its own under the label, so
// the amounts stay in one column.
function row(label: string, detail: string, value: string): string {
  const left: string = `${label.padEnd(LABEL_WIDTH)}${detail}`;
  if (detail === "" || left.length <= LABEL_WIDTH + DETAIL_WIDTH) {
    return `  ${left.padEnd(LABEL_WIDTH + DETAIL_WIDTH)}${value.padStart(AMOUNT_WIDTH)}`.trimEnd();
  }
  return `${row(label, "", value)}\n  ${" ".repeat(LABEL_WIDTH)}${detail}`;
}

function linesOf(currency: CurrencyCash, kinds: CashKind[]): CashLine[] {
  return currency.lines.filter((line: CashLine): boolean => kinds.includes(line.kind));
}

function invoices(lines: CashLine[]): string {
  const ids: string[] = [...new Set(lines.map((line: CashLine): string => line.invoiceId))];
  const shown: string = ids.slice(0, INVOICES_SHOWN).join(", ");
  return ids.length > INVOICES_SHOWN ? `${shown} and ${ids.length - INVOICES_SHOWN} more` : shown;
}

function total(lines: CashLine[]): number {
  return lines.reduce((sum: number, line: CashLine): number => sum + line.amountMinor + line.feeMinor, 0);
}

function feeNote(lines: CashLine[]): string {
  const unknown: number = lines.filter((line: CashLine): boolean => !line.feeKnown).length;
  return unknown === 0 ? "" : `, fee not known for ${unknown}`;
}

// A line of money with the invoices it is for. sign is "- " for money headroom
// takes off.
function moneyRow(currency: CurrencyCash, label: string, kinds: CashKind[], sign: string): string {
  const lines: CashLine[] = linesOf(currency, kinds);
  return row(label, `${invoices(lines)}${lines.length === 0 ? "" : feeNote(lines)}`, `${sign}${amount(total(lines))}`);
}

function printCurrency(currency: CurrencyCash, report: CashReport): void {
  const code: string = currency.currency;
  const headroom: string = `Headroom ${amount(currency.headroomMinor)}`;
  say(`${code.padEnd(LABEL_WIDTH + DETAIL_WIDTH + AMOUNT_WIDTH + 2 - headroom.length)}${headroom}`);

  const balance: CurrencyCash["airwallex"] = currency.airwallex;
  say(report.airwallex.readAt === null ? "Airwallex, not read" : "Airwallex, read just now");
  say(
    row(
      "Available",
      balance === null && report.airwallex.readAt !== null ? `no ${code} balance` : "",
      balance === null ? "Not read" : amount(balance.availableMinor),
    ),
  );
  // Shown when Airwallex sent them. None of them is part of available.
  if (balance !== null && balance.reservedMinor !== null) {
    say(row("Held for outgoing payments", "(reserved)", amount(balance.reservedMinor)));
  }
  if (balance !== null && balance.pendingMinor !== null) {
    say(row("Settling in", "(pending conversions)", amount(balance.pendingMinor)));
  }
  if (balance !== null && balance.prepaymentMinor !== null && balance.prepaymentMinor !== 0) {
    say(row("Held for future-dated payments", "(prepayment)", amount(balance.prepaymentMinor)));
  }
  if (balance !== null && balance.totalMinor !== null) {
    say(row("Total", "", amount(balance.totalMinor)));
  }

  say("Setting: RESERVE_FLOORS");
  if (currency.floor.source === "setting") {
    say(row("Reserve floor", "", `- ${amount(currency.floor.minor)}`));
  } else if (currency.floor.source === "not-set") {
    say(row("Reserve floor", "not set", "- 0.00"));
    say(`  With no floor set, every automatic replacement in ${code} goes to a person.`);
  } else {
    say(row("Reserve floor", "could not be read", "Unknown"));
  }
  for (const own of currency.floor.invoiceFloors) {
    say(`  ${own.invoiceId} has a stricter floor of its own: ${amount(own.floorMinor)}`);
  }

  say("PayOnce ledger, payment states as PayOnce last recorded them");
  say(moneyRow(currency, "Being sent, no transfer yet", ["sending"], "- "));
  say(moneyRow(currency, "Approved, not sent yet", ["approved"], "- "));
  say(
    report.payRuns === null
      ? row("Approved pay runs not sent yet", "(pay runs are not built yet)", "")
      : moneyRow(currency, "Approved pay runs not sent yet", ["pay-run"], "- "),
  );
  say(row("= Headroom", "", amount(currency.headroomMinor)));
  say(moneyRow(currency, "Waiting on a person", ["awaiting-approval", "awaiting-person"], "- "));
  say(moneyRow(currency, "Waiting on an outage", ["waiting-outage"], "- "));
  say(
    row("= Headroom if every waiting payment is approved", "", amount(currency.headroomIfApprovedMinor)),
  );

  say("Already out of available, not subtracted again");
  say(moneyRow(currency, "With the bank", ["with-bank"], ""));
  say(moneyRow(currency, "Payouts sent outside PayOnce", ["outside"], ""));
  const fees: CashLine[] = linesOf(currency, ["fee-lost"]);
  const unknown: number = fees.filter((line: CashLine): boolean => !line.feeKnown).length;
  const known: number = fees.length - unknown;
  say(
    row(
      "Fees on failed transfers",
      known === 0 ? "" : `${known} ${known === 1 ? "transfer" : "transfers"}`,
      amount(total(fees)),
    ),
  );
  if (unknown > 0) {
    say(
      `  ${unknown} failed ${unknown === 1 ? "transfer has" : "transfers have"} no fee recorded yet.`,
    );
  }
  if (known > 0) {
    say("  The sandbox keeps the fee when a transfer fails.");
  }
  say("");
}

// Reads the balances once, fresh, fills in fees the ledger is missing, and prints
// each currency from the balance down to the headroom above its floor. It writes
// nothing but fees. Exits 1 when Airwallex could not be read, the floors are
// unreadable, or any headroom is below 0.
async function main(): Promise<void> {
  loadEnvIfPresent();
  const settings: Settings = loadSettings();
  // A credential missing from .env, or an address that is not the sandbox, in
  // PayOnce's words and with no stack trace.
  let client: AirwallexClient;
  try {
    client = settings.airwallex.client();
  } catch (error: unknown) {
    say(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  const reserve: ReservePolicy = settings.reserve;
  const state: BalanceState = {
    readAt: null,
    balances: [],
    refreshing: false,
    error: null,
    maxAgeMs: 0,
  };
  let advice: string = "";
  try {
    state.balances = await getBalances(client);
    state.readAt = Date.now();
  } catch (error: unknown) {
    advice = error instanceof AirwallexError || error instanceof AirwallexUnreachableError ? airwallexAdvice(error) : "";
    state.error = {
      message: error instanceof Error ? error.message : String(error),
      at: Date.now(),
    };
  }
  if (state.readAt !== null) {
    const recorded: number = await recordMissingFees(client, ledger);
    if (recorded > 0) {
      say(`Recorded the fee of ${recorded} failed ${recorded === 1 ? "transfer" : "transfers"}`);
    }
  }

  // The panel is a view, so it reads stored JSON soft.
  const report: CashReport = readingSoft(
    (): CashReport =>
      cashReport({
        ledger,
        reserve,
        balances: state,
        statesCheckedAt: null,
        payRunLines: payRunLines(ledger),
      }),
  );
  say(describeFloors(reserve));
  if (state.error !== null) {
    say(`Airwallex could not be read: ${state.error.message}. PayOnce's own figures below are current.`);
    if (advice !== "") {
      say(advice);
    }
  }
  say("");
  for (const currency of report.currencies) {
    printCurrency(currency, report);
  }
  if (report.currencies.length === 0) {
    say("No currency has a floor, a balance or a payment in the ledger");
  }

  const below: boolean = report.currencies.some(
    (currency: CurrencyCash): boolean =>
      currency.headroomMinor !== null && currency.headroomMinor < 0,
  );
  if (state.readAt === null || reserve.problem !== null || below) {
    process.exitCode = 1;
  }
}

await main();

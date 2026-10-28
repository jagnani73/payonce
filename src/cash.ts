import { getBalances, type BalanceState } from "./airwallex/balances.js";
import { AirwallexClient } from "./airwallex/client.js";
import {
  cashReport,
  payRunLines,
  type CashKind,
  type CashLine,
  type CashReport,
  type CurrencyCash,
} from "./cash-position.js";
import { Ledger, LEDGER_PATH } from "./ledger.js";
import { formatMoney } from "./money.js";
import { recordMissingFees } from "./payments.js";
import { describeFloors, reserveFromEnv, type ReservePolicy } from "./reserve.js";

const LABEL_WIDTH: number = 34;
const DETAIL_WIDTH: number = 30;
const AMOUNT_WIDTH: number = 16;
const INVOICES_SHOWN: number = 3;

function amount(minor: number | null): string {
  return minor === null ? "Unknown" : formatMoney(minor, "").trim();
}

function row(label: string, detail: string, value: string): string {
  const left: string = `${label.padEnd(LABEL_WIDTH)}${detail}`.padEnd(LABEL_WIDTH + DETAIL_WIDTH);
  return `  ${left}${value.padStart(AMOUNT_WIDTH)}`.trimEnd();
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
  console.log(`${code.padEnd(LABEL_WIDTH + DETAIL_WIDTH + AMOUNT_WIDTH + 2 - headroom.length)}${headroom}`);

  const balance: CurrencyCash["airwallex"] = currency.airwallex;
  console.log(report.airwallex.readAt === null ? "Airwallex, not read" : "Airwallex, read just now");
  console.log(
    row(
      "Available",
      balance === null && report.airwallex.readAt !== null ? `no ${code} balance` : "",
      balance === null ? "Not read" : amount(balance.availableMinor),
    ),
  );
  // Shown when Airwallex sent them. None of them is part of available.
  if (balance !== null && balance.reservedMinor !== null) {
    console.log(row("Held for outgoing payments", "(reserved)", amount(balance.reservedMinor)));
  }
  if (balance !== null && balance.pendingMinor !== null) {
    console.log(row("Settling in", "(pending conversions)", amount(balance.pendingMinor)));
  }
  if (balance !== null && balance.prepaymentMinor !== null && balance.prepaymentMinor !== 0) {
    console.log(row("Held for future-dated payments", "(prepayment)", amount(balance.prepaymentMinor)));
  }
  if (balance !== null && balance.totalMinor !== null) {
    console.log(row("Total", "", amount(balance.totalMinor)));
  }

  console.log("Setting: RESERVE_FLOORS");
  if (currency.floor.source === "setting") {
    console.log(row("Reserve floor", "", `- ${amount(currency.floor.minor)}`));
  } else if (currency.floor.source === "not-set") {
    console.log(row("Reserve floor", "not set", "- 0.00"));
    console.log(`  With no floor set, every automatic replacement in ${code} goes to a person.`);
  } else {
    console.log(row("Reserve floor", "could not be read", "Unknown"));
  }
  for (const own of currency.floor.invoiceFloors) {
    console.log(`  ${own.invoiceId} has a stricter floor of its own: ${amount(own.floorMinor)}`);
  }

  console.log("PayOnce ledger, payment states as PayOnce last recorded them");
  console.log(moneyRow(currency, "Being sent, no transfer yet", ["sending"], "- "));
  console.log(moneyRow(currency, "Approved, not sent yet", ["approved"], "- "));
  console.log(
    report.payRuns === null
      ? row("Approved pay runs not sent yet", "(pay runs are not built yet)", "")
      : moneyRow(currency, "Approved pay runs not sent yet", ["pay-run"], "- "),
  );
  console.log(row("= Headroom", "", amount(currency.headroomMinor)));
  console.log(moneyRow(currency, "Waiting on a person", ["awaiting-approval", "awaiting-person"], "- "));
  console.log(
    row("= Headroom if every waiting payment is approved", "", amount(currency.headroomIfApprovedMinor)),
  );

  console.log("Already out of available, not subtracted again");
  console.log(moneyRow(currency, "With the bank", ["with-bank"], ""));
  console.log(moneyRow(currency, "Payouts sent outside PayOnce", ["outside"], ""));
  const fees: CashLine[] = linesOf(currency, ["fee-lost"]);
  const unknown: number = fees.filter((line: CashLine): boolean => !line.feeKnown).length;
  const known: number = fees.length - unknown;
  console.log(
    row(
      "Fees on failed transfers",
      known === 0 ? "" : `${known} ${known === 1 ? "transfer" : "transfers"}`,
      amount(total(fees)),
    ),
  );
  if (unknown > 0) {
    console.log(
      `  ${unknown} failed ${unknown === 1 ? "transfer has" : "transfers have"} no fee recorded yet.`,
    );
  }
  if (known > 0) {
    console.log("  The sandbox keeps the fee when a transfer fails.");
  }
  console.log("");
}

// Reads the balances once, fresh, fills in fees the ledger is missing, and prints
// each currency from the balance down to the headroom above its floor. It writes
// nothing but fees. Exits 1 when Airwallex could not be read, the floors are
// unreadable, or any headroom is below 0.
async function main(): Promise<void> {
  const client: AirwallexClient = AirwallexClient.fromEnv();
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  const reserve: ReservePolicy = reserveFromEnv();
  const state: BalanceState = {
    readAt: null,
    balances: [],
    refreshing: false,
    error: null,
    maxAgeMs: 0,
  };
  try {
    state.balances = await getBalances(client);
    state.readAt = Date.now();
  } catch (error: unknown) {
    state.error = {
      message: error instanceof Error ? error.message : String(error),
      at: Date.now(),
    };
  }
  if (state.readAt !== null) {
    const recorded: number = await recordMissingFees(client, ledger);
    if (recorded > 0) {
      console.log(`Recorded the fee of ${recorded} failed ${recorded === 1 ? "transfer" : "transfers"}`);
    }
  }

  const report: CashReport = cashReport({
    ledger,
    reserve,
    balances: state,
    statesCheckedAt: null,
    payRunLines: payRunLines(ledger),
  });
  console.log(describeFloors(reserve));
  if (state.error !== null) {
    console.log(`Airwallex could not be read: ${state.error.message}. PayOnce's own figures below are current.`);
  }
  console.log("");
  for (const currency of report.currencies) {
    printCurrency(currency, report);
  }
  if (report.currencies.length === 0) {
    console.log("No currency has a floor, a balance or a payment in the ledger");
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

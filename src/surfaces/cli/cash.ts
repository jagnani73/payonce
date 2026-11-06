import { getBalances, type BalanceState } from "../../airwallex/balances.js";
import { airwallexAdvice, type AirwallexClient, AirwallexError, AirwallexUnreachableError } from "../../airwallex/client.js";
import { loadEnvIfPresent } from "../../env-file.js";
import { Ledger, LEDGER_PATH } from "../../store/ledger.js";
import { recordMissingFees } from "../../engine/payments.js";
import { say } from "../../text/printable.js";
import { loadSettings, type Settings } from "../../settings.js";
import type { CashView, CashWorksheetGroup, Money, WalletCashView } from "../../views/contract.js";
import { cashView } from "../../views/treasury.js";
import { count, heading, money, put, putAll, table, utc } from "./view-text.js";

const INVOICES_SHOWN: number = 3;

function minus(amount: Money | null): string {
  return amount === null ? "not known" : `- ${money(amount)}`;
}

function shown(amount: Money | null): string {
  return amount === null ? "not known" : money(amount);
}

function invoices(group: CashWorksheetGroup): string {
  const ids: string[] = [...new Set(group.lines.map((line: CashWorksheetGroup["lines"][number]): string => line.invoiceId))];
  const listed: string = ids.slice(0, INVOICES_SHOWN).join(", ");
  const more: string = ids.length > INVOICES_SHOWN ? ` and ${ids.length - INVOICES_SHOWN} more` : "";
  return `${listed}${more}${group.feeUnknown === 0 ? "" : `, fee not known for ${group.feeUnknown}`}`;
}

// The worksheet's groups in one bucket, each with the payments it holds.
function bucketRows(wallet: WalletCashView, bucket: CashWorksheetGroup["bucket"], sign: string): string[][] {
  return wallet.worksheet
    .filter((group: CashWorksheetGroup): boolean => group.bucket === bucket)
    .map((group: CashWorksheetGroup): string[] => [`  ${group.label}`, invoices(group), `${sign}${money(group.total)}`]);
}

// One wallet from what Airwallex says is available down to the headroom above
// its floor, as Treasury's Cash tab works it out.
function putWallet(wallet: WalletCashView): void {
  const fees: CashWorksheetGroup | undefined = wallet.worksheet.find((group: CashWorksheetGroup): boolean => group.bucket === "fees-kept");
  heading(`${wallet.wallet}: headroom ${shown(wallet.headroom)}${wallet.tone === "ok" ? "" : wallet.tone === "below" ? ", below the floor" : ", below the floor if everything waiting is approved"}`);
  const rows: string[][] = [
    ["Available at Airwallex", "", shown(wallet.available)],
    ["Reserve floor", wallet.floor.source === "setting" ? "" : wallet.floor.source === "not-set" ? "not set" : "cannot be read", wallet.floor.amount === null ? "" : minus(wallet.floor.amount)],
    ["Promised", "", minus(wallet.promised)],
    ...bucketRows(wallet, "promised", "- "),
    ["= Headroom", "", shown(wallet.headroom)],
    ["Waiting on people", "", minus(wallet.waitingOnPeople)],
    ...bucketRows(wallet, "waiting-on-people", "- "),
    ["= Headroom if everything waiting is approved", "", shown(wallet.headroomIfApproved)],
    ["With the bank (already left the available balance)", "", money(wallet.withBank)],
    ...bucketRows(wallet, "with-bank", ""),
    ["Fees kept on failed transfers", fees === undefined ? "" : invoices(fees), money(wallet.feesKept)],
  ];
  putAll(table(rows, [2]), 1);
  if (wallet.floor.source !== "setting") {
    put(wallet.floor.text, 1);
  }
  putAll(wallet.invoiceFloors.map((floor: WalletCashView["invoiceFloors"][number]): string => floor.text), 1);
}

// Reads the balances once, fresh, fills in fees the ledger is missing, and prints
// each wallet from the balance down to the headroom above its floor. It writes
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
      say(`Recorded the fee of ${count(recorded, "failed transfer", "failed transfers")}`);
    }
  }

  const view: CashView = cashView(ledger, settings, Date.now(), state);
  put(view.balances.readAt === null ? "Balances not read" : `Balances read from Airwallex at ${utc(view.balances.readAt)}`);
  if (state.error !== null) {
    put(`Airwallex could not be read: ${state.error.message}. PayOnce's own figures below are current.`);
    if (advice !== "") {
      put(advice);
    }
  }
  if (view.floorsProblem !== null) {
    put(`Reserve floors cannot be read: ${view.floorsProblem}`);
  }
  for (const wallet of view.wallets) {
    putWallet(wallet);
  }
  if (view.wallets.length === 0) {
    heading("No wallet has a floor, a balance or a payment in the ledger");
  }
  say();

  const below: boolean = view.wallets.some((wallet: WalletCashView): boolean => wallet.headroom !== null && wallet.headroom.minor < 0);
  if (view.balances.readAt === null || view.floorsProblem !== null || below) {
    process.exitCode = 1;
  }
}

await main();

import { getBalances, type Balance } from "./airwallex/balances.js";
import { findBeneficiary, type BeneficiaryRecord } from "./airwallex/beneficiaries.js";
import { getTransfer, type TransferBankDetails } from "./airwallex/transfers.js";
import {
  accountKeyOf,
  bindingOf,
  payTo,
  runAmount,
  runTermsFor,
  type PaymentAmount,
  type RunRowTerms,
  type RunTerms,
  type RunTotal,
} from "./approval.js";
import {
  APPROVED_USE_WITHIN_MS,
  checkSigner,
  eligibleApprovers,
  sameName,
  signoffProblem,
  type ApprovalPolicy,
  type Approver,
  type Barred,
  type SignoffRule,
} from "./approvers.js";
import { bankDetailsKey } from "./assess.js";
import { committedAcross, committedByInvoice, type CommittedExcept } from "./cash-position.js";
import { withCurrencyLocks } from "./currency-lock.js";
import type { Dispatcher } from "./dispatcher.js";
import { likelyDuplicates, sameBillAndNumber, sameNumberExactly, type Bill } from "./duplicates.js";
import { stillSays, type Engine } from "./engine.js";
import {
  alreadyInLedger,
  isExpired,
  NothingToPayError,
  SameFileError,
  signersOf,
  skipRow,
  WaitingRunError,
  type BankChange,
  type CheckedRow,
  type EventKind,
  type Lease,
  type Ledger,
  type LedgerEvent,
  type Obligation,
  type ReleasedRun,
  type ReleaseRow,
  type Run,
  type RunApproval,
  type RunRow,
  type Signoff,
  type TransferMethod,
} from "./ledger.js";
import { formatMoney } from "./money.js";
import { currencyFloor, type CurrencyFloor, type FloorSource } from "./reserve.js";
import { rowFromCells, type RunFile, type RunFileRow } from "./run-file.js";

// The Dispatcher key for a run's steps. A colon cannot be in an invoice number, so
// it never names an invoice.
export function runKey(runId: number): string {
  return `run:${runId}`;
}

// The cash check of one currency's pay rows, as the last check found it.
export interface RunCash {
  currency: string;
  payMinor: number;
  payments: number;
  // The latest fee the ledger recorded in the currency by each row's method.
  feeMinor: number;
  // Rows whose fee is not known, and so is not in feeMinor.
  feeUnknown: number;
  availableMinor: number | null;
  // Money promised elsewhere and not out of the available balance yet.
  committedMinor: number;
  floorMinor: number | null;
  floorSource: FloorSource;
  afterMinor: number | null;
  // How far below the floor the rows would take cash. Null when they fit.
  shortMinor: number | null;
  // Why every row in the currency is skipped. Null when they fit.
  problem: string | null;
}

export interface RunCheck {
  rows: CheckedRow[];
  cash: RunCash[];
}

// A pay row, with every field a payment needs.
export interface PayRow extends RunRowTerms {
  payee: string;
  newPayee: boolean;
}

// What the beneficiary record says, and the account PayOnce last paid it.
interface Payee {
  record: BeneficiaryRecord | undefined;
  details: TransferBankDetails | undefined;
  methods: string[];
  lastPaid: { reference: string | null; accountKey: string; payTo: string } | undefined;
}

const METHODS: readonly TransferMethod[] = ["LOCAL", "SWIFT"];

function amount(minor: number | null): string {
  return minor === null ? "unknown" : formatMoney(minor, "").trim();
}

function listOf(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// A supplier's name with case, spacing and punctuation dropped, so "Example
// Supplier, LLC" is "Example Supplier LLC". Legal suffixes stay.
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function accountEnding(details: TransferBankDetails): string {
  const account: string | undefined = details.account_number ?? details.iban;
  return account === undefined ? "no account number" : `account ending ${account.slice(-4)}`;
}

// Reads every beneficiary the rows name once, and for each that PayOnce has paid,
// the transfer it last paid, for the bank details it went to. GETs only.
async function readPayees(engine: Engine, rows: RunFileRow[]): Promise<Map<string, Payee>> {
  const payees: Map<string, Payee> = new Map();
  const ids: string[] = [
    ...new Set(
      rows
        .map((row: RunFileRow): string | null => row.beneficiaryId)
        .filter((id: string | null): id is string => id !== null),
    ),
  ];
  for (const id of ids) {
    const record: BeneficiaryRecord | undefined = await findBeneficiary(engine.client, id);
    const details: TransferBankDetails | undefined = record?.beneficiary?.bank_details;
    const last: { transferId: string; reference: string | null } | undefined =
      details === undefined ? undefined : engine.ledger.lastPaidTransfer(id);
    let lastPaid: Payee["lastPaid"] = undefined;
    if (last !== undefined) {
      const sentTo: TransferBankDetails | undefined = (await getTransfer(engine.client, last.transferId))
        .beneficiary?.bank_details;
      lastPaid = {
        reference: last.reference,
        accountKey: accountKeyOf(sentTo),
        payTo: sentTo === undefined ? "details not known" : accountEnding(sentTo),
      };
    }
    payees.set(id, { record, details, methods: record?.transfer_methods ?? [], lastPaid });
  }
  return payees;
}

// The fields likelyDuplicates reads, for a row that is not in the ledger.
function asObligation(row: RunFileRow, payee: string, method: TransferMethod): Obligation {
  return {
    invoiceId: row.invoiceId ?? "",
    supplier: payee,
    supplierDomain: "",
    beneficiaryId: row.beneficiaryId ?? "",
    currency: row.currency ?? "",
    // A run's row is paid from its own currency's wallet.
    sourceCurrency: row.currency ?? "",
    amountMinor: row.amountMinor ?? 0,
    transferMethod: method,
    invoiceFloorMinor: 0,
    startedBy: null,
    supplierPhone: null,
    origin: "payonce",
    state: "open",
    escalationReason: "",
    payoutReference: null,
    duplicateOf: [],
    rejectedBy: null,
    runRowId: null,
  };
}

function billOf(row: RunFileRow, payees: Map<string, Payee>): (Bill & { invoiceId: string }) | null {
  if (
    row.invoiceId === null ||
    row.beneficiaryId === null ||
    row.currency === null ||
    row.amountMinor === null
  ) {
    return null;
  }
  return {
    invoiceId: row.invoiceId,
    supplier: payees.get(row.beneficiaryId)?.details?.account_name ?? row.supplier ?? "",
    beneficiaryId: row.beneficiaryId,
    currency: row.currency,
    amountMinor: row.amountMinor,
  };
}

// Every reason a row is skipped, or none, and what PayOnce would pay with it.
function checkRow(
  ledger: Ledger,
  row: RunFileRow,
  earlier: RunFileRow[],
  payees: Map<string, Payee>,
): CheckedRow {
  const reasons: string[] = [...row.problems];
  const payee: Payee | undefined =
    row.beneficiaryId === null ? undefined : payees.get(row.beneficiaryId);
  const details: TransferBankDetails | undefined = payee?.details;
  const payeeName: string | null = details?.account_name ?? null;

  const invoiceId: string | null = row.invoiceId;
  if (invoiceId !== null) {
    const same: Obligation | undefined =
      ledger.obligation(invoiceId) ?? ledger.obligationForReference(invoiceId);
    const alike: Obligation | undefined = ledger
      .obligations()
      .find(
        (other: Obligation): boolean =>
          sameNumberExactly(other.invoiceId, invoiceId) &&
          (other.beneficiaryId === row.beneficiaryId ||
            (payeeName !== null && sameName(other.supplier, payeeName))),
      );
    if (same !== undefined) {
      reasons.push(alreadyInLedger(invoiceId));
    } else if (alike !== undefined) {
      reasons.push(
        `${invoiceId} is already in the ledger as ${alike.invoiceId} for the same supplier, and PayOnce pays an invoice number once`,
      );
    }
    const twin: RunFileRow | undefined = earlier.find(
      (other: RunFileRow): boolean =>
        other.invoiceId !== null &&
        (other.invoiceId === invoiceId ||
          (sameNumberExactly(other.invoiceId, invoiceId) && other.beneficiaryId === row.beneficiaryId)),
    );
    const bill: (Bill & { invoiceId: string }) | null = billOf(row, payees);
    const near: RunFileRow | undefined =
      bill === null
        ? undefined
        : earlier.find((other: RunFileRow): boolean => {
            const theirs: (Bill & { invoiceId: string }) | null = billOf(other, payees);
            return theirs !== null && sameBillAndNumber(theirs, bill);
          });
    if (twin !== undefined) {
      reasons.push(
        twin.invoiceId === invoiceId
          ? `${invoiceId} is on row ${twin.line} of this file as well`
          : `${invoiceId} is on row ${twin.line} of this file as ${twin.invoiceId ?? ""} for the same supplier`,
      );
    } else if (near !== undefined) {
      reasons.push(
        `${invoiceId} looks like a second bill for ${near.invoiceId ?? ""} on row ${near.line} of this file: the same supplier and amount, and the same invoice number apart from case, spacing, leading zeros or letters added at the end. If it is a bill of its own, upload it on its own once ${near.invoiceId ?? ""} is paid`,
      );
    }
  }

  let method: TransferMethod | null = row.method;
  let newPayee: boolean = false;
  let bankChangeId: number | null = null;
  if (row.beneficiaryId !== null && payee !== undefined) {
    const short: string = row.beneficiaryId.slice(0, 8);
    if (payee.record === undefined) {
      reasons.push(`Beneficiary ${short} is not in Airwallex`);
    } else if (details === undefined) {
      reasons.push(`Beneficiary ${short} has no bank details`);
    } else {
      if (row.supplier !== null && nameKey(row.supplier) !== nameKey(details.account_name ?? "")) {
        reasons.push(
          `The supplier in the file is ${row.supplier}, and the account name on beneficiary ${short} is ${details.account_name ?? "missing"}`,
        );
      }
      if (row.currency !== null && details.account_currency !== row.currency) {
        reasons.push(
          details.account_currency === undefined
            ? `Beneficiary ${short} does not say which currency its account is in`
            : `The beneficiary's account is in ${details.account_currency}, and the row pays ${row.currency}`,
        );
      }
      const usable: TransferMethod[] = METHODS.filter((entry: TransferMethod): boolean =>
        payee.methods.includes(entry),
      );
      if (row.method !== null && !usable.includes(row.method)) {
        reasons.push(
          `The beneficiary takes ${payee.methods.length === 0 ? "no" : listOf(payee.methods)} transfers, not ${row.method}`,
        );
      } else if (row.method === null) {
        method = usable.length === 1 ? (usable[0] ?? null) : null;
        if (method === null) {
          reasons.push(
            usable.length === 0
              ? "The beneficiary takes no LOCAL or SWIFT transfers"
              : "The beneficiary takes LOCAL and SWIFT transfers, so the method column must say which",
          );
        }
      }
      // A changed account is paid only once a callback verified it.
      const key: string = accountKeyOf(details);
      if (payee.lastPaid === undefined) {
        newPayee = true;
      } else if (payee.lastPaid.accountKey !== key) {
        const verified: BankChange | undefined = ledger.verifiedBankChange(
          row.beneficiaryId,
          bankDetailsKey(details),
        );
        if (verified !== undefined) {
          bankChangeId = verified.id;
        } else {
          reasons.push(
            `The bank details on file for ${details.account_name ?? row.supplier ?? "the supplier"} (${accountEnding(details)}) are not the ones PayOnce last paid it (${payee.lastPaid.payTo}${payee.lastPaid.reference === null ? "" : `, transfer ${payee.lastPaid.reference}`}). Check the new details with the supplier. If they are right, pay this invoice outside PayOnce. If not, restore the old details in Airwallex and upload the row again`,
          );
        }
      }
    }
  }

  const pays: boolean = reasons.length === 0 && details !== undefined && method !== null;
  const name: string = payeeName ?? row.supplier ?? "";
  return {
    line: row.line,
    cells: row.cells,
    invoiceId: row.invoiceId,
    supplier: row.supplier,
    beneficiaryId: row.beneficiaryId,
    currency: row.currency,
    amountMinor: row.amountMinor,
    transferMethod: method,
    sandboxOutcome: row.sandboxOutcome,
    action: pays ? "pay" : "skip",
    reasons,
    heldFor:
      pays && method !== null
        ? likelyDuplicates(ledger, asObligation(row, name, method)).map(
            (other: Obligation): string => other.invoiceId,
          )
        : [],
    newPayee: pays && newPayee,
    bankChangeId: pays ? bankChangeId : null,
    payee: details === undefined ? null : name,
    payTo: details === undefined ? null : payTo(name, details),
    accountKey: details === undefined ? null : accountKeyOf(details),
  };
}

// The pay rows with every field a payment needs, in file order.
export function payRows(rows: CheckedRow[]): PayRow[] {
  const pay: PayRow[] = [];
  for (const row of rows) {
    if (
      row.action === "pay" &&
      row.invoiceId !== null &&
      row.beneficiaryId !== null &&
      row.currency !== null &&
      row.amountMinor !== null &&
      row.transferMethod !== null &&
      row.payee !== null &&
      row.payTo !== null &&
      row.accountKey !== null
    ) {
      pay.push({
        line: row.line,
        invoiceId: row.invoiceId,
        amountMinor: row.amountMinor,
        currency: row.currency,
        beneficiaryId: row.beneficiaryId,
        transferMethod: row.transferMethod,
        payTo: row.payTo,
        accountKey: row.accountKey,
        heldFor: row.heldFor,
        bankChange: row.bankChangeId,
        payee: row.payee,
        newPayee: row.newPayee,
      });
    }
  }
  return pay;
}

// Per currency, whether the pay rows fit above its reserve floor: the available
// balance read fresh, less money committed elsewhere, the rows and their fees.
// A run's own approved rows are not counted as committed elsewhere. A currency
// with no floor set does not stop the run, because a person approves every run.
async function cashCheck(engine: Engine, rows: CheckedRow[], runId: number | null): Promise<RunCash[]> {
  const pay: PayRow[] = payRows(rows);
  if (pay.length === 0) {
    return [];
  }
  const currencies: string[] = [...new Set(pay.map((row: PayRow): string => row.currency))].sort(
    (a: string, b: string): number => a.localeCompare(b),
  );
  const except: CommittedExcept = runId === null ? {} : { runId };
  // Counted before the balance read and again after it, so a payment that gets
  // its transfer in between, or is promised in between, is never missed.
  const before: Map<string, Map<string, number>> = new Map(
    currencies.map((currency: string): [string, Map<string, number>] => [
      currency,
      committedByInvoice(engine.ledger, currency, except),
    ]),
  );
  const balances: Balance[] = await getBalances(engine.client);
  return currencies.map((currency: string): RunCash => {
    const own: PayRow[] = pay.filter((row: PayRow): boolean => row.currency === currency);
    const payMinor: number = own.reduce((sum: number, row: PayRow): number => sum + row.amountMinor, 0);
    const fees: (number | null)[] = own.map((row: PayRow): number | null =>
      engine.ledger.latestFee(currency, row.transferMethod),
    );
    const feeMinor: number = fees.reduce((sum: number, fee: number | null): number => sum + (fee ?? 0), 0);
    const feeUnknown: number = fees.filter((fee: number | null): boolean => fee === null).length;
    const floor: CurrencyFloor = currencyFloor(engine.reserve, currency);
    const availableMinor: number | null =
      balances.find((balance: Balance): boolean => balance.currency === currency)?.availableMinor ??
      null;
    const committed: number = committedAcross(
      before.get(currency) ?? new Map<string, number>(),
      committedByInvoice(engine.ledger, currency, except),
    );
    const afterMinor: number | null =
      availableMinor === null ? null : availableMinor - committed - payMinor - feeMinor;
    const shortMinor: number | null =
      afterMinor !== null && floor.minor !== null && afterMinor < floor.minor
        ? floor.minor - afterMinor
        : null;
    const rowsText: string = `The ${currency} rows (${formatMoney(payMinor, currency)} in ${plural(own.length, "payment")})`;
    const problem: string | null =
      floor.source === "unreadable"
        ? `${rowsText} are skipped, because the reserve floor setting could not be read`
        : availableMinor === null
          ? `${rowsText} are skipped, because Airwallex has no ${currency} balance`
          : shortMinor !== null && afterMinor !== null && floor.minor !== null
            ? `${rowsText} would leave ${formatMoney(afterMinor, currency)}, ${formatMoney(shortMinor, currency)} below the reserve floor of ${formatMoney(floor.minor, currency)}`
            : null;
    return {
      currency,
      payMinor,
      payments: own.length,
      feeMinor,
      feeUnknown,
      availableMinor,
      committedMinor: committed,
      floorMinor: floor.minor,
      floorSource: floor.source,
      afterMinor,
      shortMinor,
      problem,
    };
  });
}

// Checks every row against the ledger and Airwallex, with GETs only: one read of
// each beneficiary, one of the transfer PayOnce last paid each, and one balance
// read. A row with any problem is skipped with every reason found. Then each
// currency's pay rows are checked against its floor, and when they do not fit,
// every row in that currency is skipped, so file order never decides who is paid.
export async function checkRows(
  engine: Engine,
  rows: RunFileRow[],
  runId: number | null,
): Promise<RunCheck> {
  const payees: Map<string, Payee> = await readPayees(engine, rows);
  const checked: CheckedRow[] = rows.map(
    (row: RunFileRow, index: number): CheckedRow =>
      checkRow(engine.ledger, row, rows.slice(0, index), payees),
  );
  const cash: RunCash[] = await cashCheck(engine, checked, runId);
  const short: Map<string, string> = new Map(
    cash
      .filter((entry: RunCash): boolean => entry.problem !== null)
      .map((entry: RunCash): [string, string] => [entry.currency, entry.problem ?? ""]),
  );
  return {
    rows: checked.map(
      (row: CheckedRow): CheckedRow =>
        row.action === "pay" && row.currency !== null && short.has(row.currency)
          ? skipRow(row, [short.get(row.currency) ?? ""])
          : row,
    ),
    cash,
  };
}

// The totals per currency the approvers approve: every currency whose rows fit.
function totalsOf(rows: CheckedRow[], cash: RunCash[]): RunTotal[] {
  const pay: PayRow[] = payRows(rows);
  return cash
    .filter((entry: RunCash): boolean => entry.problem === null)
    .map(
      (entry: RunCash): RunTotal => ({
        currency: entry.currency,
        amountMinor: pay
          .filter((row: PayRow): boolean => row.currency === entry.currency)
          .reduce((sum: number, row: PayRow): number => sum + row.amountMinor, 0),
        payments: pay.filter((row: PayRow): boolean => row.currency === entry.currency).length,
        reserveFloorMinor: entry.floorMinor,
      }),
    )
    .filter((total: RunTotal): boolean => total.payments > 0);
}

// Each pay row carries the supplier_domain its cells give, so the approvers
// approve the domain the sender check will trust.
export function termsOf(run: Run, rows: CheckedRow[], cash: RunCash[]): RunTerms {
  const withDomains: PayRow[] = payRows(rows).map((row: PayRow): PayRow => {
    const cells: CheckedRow | undefined = rows.find((entry: CheckedRow): boolean => entry.line === row.line);
    const domain: string | null =
      cells === undefined ? null : rowFromCells(cells.line, run.columns, cells.cells).supplierDomain;
    return domain === null ? row : { ...row, supplierDomain: domain };
  });
  return runTermsFor(run.id, run.fileHash, run.uploadedBy, withDomains, totalsOf(rows, cash));
}

// A row's supplier_domain against the domain on file for its beneficiary: the
// latest invoice to it that has one. onFile is null when the row's domain is the
// first for that beneficiary.
export interface DomainCheck {
  line: number;
  invoiceId: string;
  domain: string;
  onFile: string | null;
}

export function domainChecks(ledger: Ledger, terms: RunTerms): DomainCheck[] {
  const obligations: Obligation[] = ledger.obligations();
  return terms.rows.flatMap((row: RunRowTerms): DomainCheck[] => {
    if (row.supplierDomain === undefined) {
      return [];
    }
    const earlier: Obligation | undefined = obligations.find(
      (obligation: Obligation): boolean =>
        obligation.beneficiaryId === row.beneficiaryId && obligation.supplierDomain !== "",
    );
    return [{ line: row.line, invoiceId: row.invoiceId, domain: row.supplierDomain, onFile: earlier?.supplierDomain ?? null }];
  });
}

// The words for a row's domain, as the approval card and pnpm payrun show them.
export function domainText(check: DomainCheck): string {
  if (check.onFile === null) {
    return `Row ${check.line} gives ${check.domain} as the supplier's email domain, the first domain on file for this beneficiary`;
  }
  return check.onFile === check.domain
    ? `Row ${check.line} gives ${check.domain} as the supplier's email domain, the one already on file`
    : `Row ${check.line} gives ${check.domain} as the supplier's email domain, but ${check.onFile} is on file for this beneficiary`;
}

// The largest currency total, which approver limits are checked against, as the
// page and pnpm payrun show it.
export function largestTotal(terms: RunTerms): { amountMinor: number; currency: string } {
  const amount: PaymentAmount = runAmount(terms);
  return { amountMinor: amount.minor, currency: amount.currency };
}

// How many approvers a run needs, and why: two for a payee PayOnce has never
// paid, for an account a callback verified, and when any currency's total is
// above TWO_APPROVERS_ABOVE.
export function runRule(
  policy: ApprovalPolicy,
  rows: CheckedRow[],
  amount: PaymentAmount,
  domains: DomainCheck[],
): SignoffRule {
  const pay: PayRow[] = payRows(rows);
  const fresh: PayRow | undefined = pay.find((row: PayRow): boolean => row.newPayee);
  if (fresh !== undefined) {
    return { needed: 2, why: `row ${fresh.line} pays ${fresh.payee}, which PayOnce has never paid` };
  }
  const changed: PayRow | undefined = pay.find((row: PayRow): boolean => row.bankChange !== null);
  if (changed !== undefined) {
    return {
      needed: 2,
      why: `row ${changed.line} pays an account a callback verified, not the one PayOnce last paid ${changed.payee}`,
    };
  }
  // The sender check trusts the domain, so changing it is reviewed by two.
  const otherDomain: DomainCheck | undefined = domains.find(
    (check: DomainCheck): boolean => check.onFile !== null && check.onFile !== check.domain,
  );
  if (otherDomain !== undefined) {
    return {
      needed: 2,
      why: `row ${otherDomain.line} gives ${otherDomain.domain} as the supplier's email domain, and ${otherDomain.onFile ?? ""} is on file for that beneficiary`,
    };
  }
  if (amount.minor > policy.twoApproversAboveMinor) {
    return {
      needed: 2,
      why: `the ${amount.currency} total is above ${formatMoney(policy.twoApproversAboveMinor, amount.currency)}`,
    };
  }
  return { needed: 1, why: "" };
}

// Who may not approve the run: whoever uploaded it, and everyone who recorded the
// callback for an account a row pays.
export function runBarred(ledger: Ledger, terms: RunTerms): Barred[] {
  const barred: Barred[] = [{ name: terms.uploadedBy, why: "uploaded this run" }];
  for (const row of terms.rows) {
    const change: BankChange | undefined =
      row.bankChange === null ? undefined : ledger.bankChange(row.bankChange);
    if (change?.appliedKey === null || change === undefined) {
      continue;
    }
    for (const name of ledger.bankChangeRecorders(row.beneficiaryId, change.appliedKey)) {
      barred.push({ name, why: `recorded the callback for the bank details row ${row.line} pays` });
    }
  }
  return barred;
}

// "81.00 USD and 50.00 EUR in 3 payments"
function totalsText(totals: RunTotal[]): string {
  const payments: number = totals.reduce((sum: number, total: RunTotal): number => sum + total.payments, 0);
  return `${listOf(totals.map((total: RunTotal): string => formatMoney(total.amountMinor, total.currency)))} in ${plural(payments, "payment")}`;
}

// Adds a line to the run's timeline and prints it, skipping one that repeats the
// line before it, or a standing line the timeline still says, as note does for
// an invoice.
export function runNote(
  ledger: Ledger,
  runId: number,
  kind: EventKind,
  message: string,
  topic: string | null = null,
): void {
  const events: LedgerEvent[] = ledger.runEvents(runId);
  const last: LedgerEvent | undefined = events.at(-1);
  if (last?.kind === kind && last.message === message) {
    return;
  }
  if (topic !== null && stillSays(events, topic, message)) {
    return;
  }
  ledger.addRunEvent(runId, kind, message, topic);
  console.log(`  run ${runId}    ${kind.padEnd(8)} ${message}`);
}

// Puts a failure on the run's timeline. It must not throw, because it runs from
// error handlers.
export function runNoteError(ledger: Ledger, runId: number, error: unknown, what: string = ""): void {
  console.error(error);
  try {
    runNote(ledger, runId, "error", `${what}${error instanceof Error ? error.message : String(error)}`);
  } catch (inner: unknown) {
    console.error(
      `Could not record the error for run ${runId}: ${inner instanceof Error ? inner.message : String(inner)}`,
    );
  }
}

function cashText(entry: RunCash): string {
  if (entry.problem !== null) {
    return entry.problem;
  }
  const fee: string =
    entry.feeUnknown > 0
      ? ", fee not known"
      : entry.feeMinor > 0
        ? `, fees about ${amount(entry.feeMinor)}`
        : "";
  const floor: string =
    entry.floorMinor === null
      ? `no reserve floor is set for ${entry.currency}`
      : `reserve floor ${amount(entry.floorMinor)}`;
  return `${entry.currency}: ${amount(entry.payMinor)} to pay in ${plural(entry.payments, "payment")}${fee}. Available ${amount(entry.availableMinor)}, committed elsewhere ${amount(entry.committedMinor)}, ${floor}, after the run ${amount(entry.afterMinor)}`;
}

// What a check found, on the run's timeline: each skipped row, each row PayOnce
// will hold for a person, the cash per currency, and a summary. A row that was
// skipped or held before and now pays says so too.
function noteCheck(ledger: Ledger, runId: number, rows: CheckedRow[], cash: RunCash[]): void {
  const events: LedgerEvent[] = ledger.runEvents(runId);
  for (const row of rows) {
    const topic: string = `row:${row.line}`;
    const named: string = `Row ${row.line}${row.invoiceId === null ? "" : ` (${row.invoiceId})`}`;
    if (row.action === "skip") {
      runNote(ledger, runId, "decision", `${named} skipped: ${row.reasons.join(". ")}`, topic);
    } else if (row.heldFor.length > 0) {
      runNote(
        ledger,
        runId,
        "decision",
        `${named} looks like a second bill for ${listOf(row.heldFor)}, so PayOnce will hold it for a person before paying it`,
        topic,
      );
    } else if (events.some((event: LedgerEvent): boolean => event.topic === topic)) {
      runNote(ledger, runId, "decision", `${named} now pays ${row.payTo ?? ""}`, topic);
    }
  }
  for (const entry of cash) {
    runNote(
      ledger,
      runId,
      entry.problem === null ? "payment" : "warning",
      cashText(entry),
      `cash:${entry.currency}`,
    );
  }
  const pay: PayRow[] = payRows(rows);
  const held: number = pay.filter((row: PayRow): boolean => row.heldFor.length > 0).length;
  const skipped: number = rows.length - pay.length;
  const totals: RunTotal[] = totalsOf(rows, cash);
  runNote(
    ledger,
    runId,
    "decision",
    `Checked: ${pay.length} to pay${pay.length === 0 ? "" : ` (${listOf(totals.map((total: RunTotal): string => formatMoney(total.amountMinor, total.currency)))})`}${held === 0 ? "" : `, ${held} of them held for a person when PayOnce comes to send ${held === 1 ? "it" : "them"}`}, ${skipped} skipped`,
    "decision",
  );
}

// A line for a run's timeline, written once the transaction that decided it has
// committed.
interface RunLine {
  kind: EventKind;
  message: string;
  topic: string | null;
}

function writeLines(ledger: Ledger, runId: number, lines: RunLine[]): void {
  for (const line of lines) {
    runNote(ledger, runId, line.kind, line.message, line.topic);
  }
}

// Settles the run's request after a check: keeps a request still open, or
// approved, for the same terms, or opens a new one for the approvers under the
// approval policy. None is opened when nothing is left to pay, or when too few
// approvers could sign, and any open one is withdrawn. It only writes to the
// ledger, so it runs inside the transaction that wrote the check's rows, and it
// returns the timeline lines that say what the run waits on.
function settleRunRequest(
  ledger: Ledger,
  policy: ApprovalPolicy,
  run: Run,
  rows: CheckedRow[],
  cash: RunCash[],
): RunLine[] {
  const lines: RunLine[] = [];
  const say = (kind: EventKind, message: string, topic: string | null = null): void => {
    lines.push({ kind, message, topic });
  };
  const terms: RunTerms = termsOf(run, rows, cash);
  if (terms.rows.length === 0) {
    if (ledger.voidOpenRunApprovals(run.id)) {
      say("approval", "Approval request withdrawn: every row is skipped now");
    }
    say(
      "approval",
      "Waiting on a person. Every row is skipped, so there is nothing to approve. Cancel the run and upload a corrected file",
      "waiting",
    );
    return lines;
  }
  const binding: string = bindingOf(terms);
  const amount: PaymentAmount = runAmount(terms);
  const rule: SignoffRule = runRule(policy, rows, amount, domainChecks(ledger, terms));
  const eligible: Approver[] = eligibleApprovers(policy, amount, runBarred(ledger, terms));
  if (policy.problem !== null || eligible.length < rule.needed) {
    if (ledger.voidOpenRunApprovals(run.id)) {
      say("approval", "Approval request withdrawn: nobody on the approver list can approve it");
    }
    const able: string =
      eligible.length === 0
        ? "nobody on the approver list can"
        : `only ${listOf(eligible.map((approver: Approver): string => approver.name))} can`;
    say(
      "approval",
      policy.problem !== null
        ? `Waiting on a person. Approvals are refused: ${policy.problem}`
        : `Waiting on a person. The run needs ${rule.needed === 1 ? "one approver" : `${rule.needed} approvers, because ${rule.why},`} and ${able} approve it. Change APPROVERS, restart and check again`,
      "waiting",
    );
    return lines;
  }

  let latest: RunApproval | undefined = ledger.latestRunApproval(run.id);
  const same: boolean =
    latest !== undefined &&
    (latest.state === "requested" || latest.state === "approved") &&
    latest.binding === binding &&
    latest.needed >= rule.needed &&
    !isExpired(latest);
  if (!same) {
    if (latest?.state === "requested" && isExpired(latest)) {
      say(
        "approval",
        `Approval request expired before ${latest.signoffs.length === 0 ? "anyone approved it" : "enough people approved it"}, so PayOnce opened a new one`,
      );
    } else if (
      (latest?.state === "requested" || latest?.state === "approved") &&
      latest.signoffs.length > 0
    ) {
      say(
        "approval",
        `Approval by ${signersOf(latest.signoffs)} no longer counts: the checks changed, so PayOnce opened a new request`,
      );
    }
    const opened: boolean = ledger.addRunApproval(run.id, {
      binding,
      terms: JSON.stringify(terms),
      needed: rule.needed,
      neededWhy: rule.why,
      expiresAt: Date.now() + policy.expiresAfterMs,
    });
    // Another process released or cancelled the run meanwhile.
    if (!opened) {
      return lines;
    }
    latest = ledger.latestRunApproval(run.id);
  }
  if (latest === undefined) {
    return lines;
  }
  say(
    "approval",
    latest.state === "approved"
      ? `Approved by ${latest.approver ?? ""}. pnpm ui releases the run on its next check`
      : latest.needed === 1
        ? `Waiting on a person to approve paying ${totalsText(terms.totals)}`
        : `Waiting on ${latest.needed} approvers for ${totalsText(terms.totals)}, because ${latest.neededWhy}`,
    "waiting",
  );
  return lines;
}

// Reads a run's rows again from the cells the ledger stored.
function fileRowsOf(ledger: Ledger, run: Run): RunFileRow[] {
  return ledger
    .runRows(run.id)
    .map((row: RunRow): RunFileRow => rowFromCells(row.line, run.columns, row.cells));
}

// Checks a file, stores it as a run waiting for approval and asks for approval.
// Only one run waits at a time. Throws WaitingRunError, SameFileError, or
// NothingToPayError with every row's reasons.
export async function uploadRun(engine: Engine, file: RunFile, uploadedBy: string): Promise<number> {
  const waiting: Run | undefined = engine.ledger.waitingRun();
  if (waiting !== undefined) {
    throw new WaitingRunError(waiting.id);
  }
  const same: Run | undefined = engine.ledger.liveRunForFile(file.hash);
  if (same !== undefined) {
    throw new SameFileError(same);
  }
  const check: RunCheck = await checkRows(engine, file.rows, null);
  if (!check.rows.some((row: CheckedRow): boolean => row.action === "pay")) {
    throw new NothingToPayError(check.rows);
  }
  const runId: number = engine.ledger.createRun(
    {
      fileName: file.fileName,
      fileHash: file.hash,
      columns: file.columns,
      uploadedBy,
      cash: JSON.stringify(check.cash),
    },
    check.rows,
  );
  const run: Run | undefined = engine.ledger.run(runId);
  if (run === undefined) {
    throw new Error(`Run ${runId} was not stored`);
  }
  runNote(
    engine.ledger,
    runId,
    "payment",
    `Uploaded by ${uploadedBy}: ${file.fileName}, ${plural(file.rows.length, "row")} (file ${file.hash.slice(0, 8)})`,
  );
  // createRun may have skipped a row whose number reached the ledger meanwhile.
  const rows: CheckedRow[] = engine.ledger.runRows(runId);
  const lines: RunLine[] = engine.ledger.transaction((): RunLine[] =>
    settleRunRequest(engine.ledger, engine.approvals, run, rows, check.cash),
  );
  noteCheck(engine.ledger, runId, rows, check.cash);
  writeLines(engine.ledger, runId, lines);
  return runId;
}

// Runs every check again, and in one transaction rewrites the rows and opens a
// new request if the terms changed or the old one expired. Refused while the run
// is approved and waits for its release. Airwallex GETs only.
export async function recheckRun(engine: Engine, runId: number): Promise<void> {
  const run: Run | undefined = engine.ledger.run(runId);
  if (run?.state !== "waiting") {
    throw new Error(`Run ${runId} is not waiting for approval, so there is nothing to check`);
  }
  const check: RunCheck = await checkRows(engine, fileRowsOf(engine.ledger, run), runId);
  const lines: RunLine[] | undefined = engine.ledger.setRunRows(
    runId,
    check.rows,
    JSON.stringify(check.cash),
    null,
    (): RunLine[] => settleRunRequest(engine.ledger, engine.approvals, run, check.rows, check.cash),
  );
  if (lines === undefined) {
    throw new Error(
      engine.ledger.run(runId)?.state === "waiting"
        ? `Run ${runId} is approved, and pnpm ui releases it on its next check, so it is not checked again`
        : `Run ${runId} is not waiting for approval, so there is nothing to check`,
    );
  }
  noteCheck(engine.ledger, runId, check.rows, check.cash);
  writeLines(engine.ledger, runId, lines);
}

export interface PendingRunApproval {
  approval: RunApproval;
  terms: RunTerms;
  barred: Barred[];
  expired: boolean;
  largest: { amountMinor: number; currency: string };
}

// The request a waiting run is waiting on, if there is one.
export function pendingRunApproval(ledger: Ledger, runId: number): PendingRunApproval | undefined {
  const approval: RunApproval | undefined = ledger.latestRunApproval(runId);
  if (approval?.state !== "requested" || ledger.run(runId)?.state !== "waiting") {
    return undefined;
  }
  const terms: RunTerms = JSON.parse(approval.terms) as RunTerms;
  return {
    approval,
    terms,
    barred: runBarred(ledger, terms),
    expired: isExpired(approval),
    largest: largestTotal(terms),
  };
}

// Records one person's approval of a run under the approval policy, checked
// against the largest currency total. approvalId is the request the approver was
// shown, so nobody approves terms they did not see. No Airwallex call.
export function approveRun(
  ledger: Ledger,
  policy: ApprovalPolicy,
  runId: number,
  approver: string,
  approvalId: number,
): RunApproval {
  const pending: PendingRunApproval | undefined = pendingRunApproval(ledger, runId);
  if (pending === undefined) {
    throw new Error(`No approval is waiting for run ${runId}`);
  }
  if (pending.approval.id !== approvalId) {
    throw new Error(`The approval request for run ${runId} has changed. Review the current terms`);
  }
  if (pending.expired) {
    throw new Error(
      `The approval request for run ${runId} has expired. Check the run again to open a new one`,
    );
  }
  const signer: Approver = checkSigner(
    policy,
    approver,
    runAmount(pending.terms),
    pending.barred,
    pending.approval.signoffs.map((signoff: Signoff): string => signoff.approver),
  );
  const after: RunApproval = ledger.signOffRun(
    pending.approval.id,
    signer.name,
    pending.approval.binding,
    APPROVED_USE_WITHIN_MS,
  );
  const left: number = after.needed - after.signoffs.length;
  runNote(
    ledger,
    runId,
    "approval",
    after.state === "approved"
      ? `Approved by ${signersOf(after.signoffs)}: ${totalsText(pending.terms.totals)}`
      : `${signer.name} approved the run. It needs ${left} more approver${left === 1 ? "" : "s"}`,
    "approval",
  );
  return after;
}

// Cancels a run still waiting. It moves no money, so anyone who gives a name and a
// note may cancel it, and its invoice numbers are free again.
export function cancelRun(ledger: Ledger, runId: number, cancelledBy: string, note: string): void {
  if (!ledger.cancelRun(runId, cancelledBy, note)) {
    throw new Error(`Run ${runId} is not waiting for approval, so it cannot be cancelled`);
  }
  runNote(ledger, runId, "closed", `Cancelled by ${cancelledBy}: ${note}`);
}

// Releases an approved run, in its turn. Every check runs again. If the terms
// changed, the approval expired, or the approval policy as it is now refuses it,
// the approval is void and the run waits for a person to check it again. Then,
// holding the lock of every currency the run pays, the cash check runs again on
// a fresh balance: if any currency would now go below its floor, the approval is
// void and the run waits too. Otherwise one transaction spends the approval and
// writes each pay row as an invoice, with the account the approved terms name.
// After the commit, each invoice is woken in its own turn, one at a time, and
// allowed to send its original. Never awaits a run step, so it can run in the
// run's turn without waiting on itself.
export async function releaseRun(engine: Engine, agent: Dispatcher, runId: number): Promise<void> {
  const ledger: Ledger = engine.ledger;
  const run: Run | undefined = ledger.run(runId);
  const approval: RunApproval | undefined = ledger.latestRunApproval(runId);
  if (run?.state !== "waiting" || approval?.state !== "approved") {
    return;
  }
  const check: RunCheck = await checkRows(engine, fileRowsOf(ledger, run), runId);
  const terms: RunTerms = termsOf(run, check.rows, check.cash);
  const amount: PaymentAmount = runAmount(terms);
  let why: string | null = null;
  if (isExpired(approval)) {
    why = "expired before it was used";
  } else if (bindingOf(terms) !== approval.binding) {
    why = "is void: the checks changed since it was given";
  } else {
    const problem: string | null = signoffProblem(
      engine.approvals,
      runRule(engine.approvals, check.rows, amount, domainChecks(ledger, terms)),
      approval,
      amount,
      runBarred(ledger, terms),
    );
    why = problem === null ? null : `is void: ${problem}`;
  }
  if (why !== null) {
    // Another process may have released the run, or checked it again, since.
    if (ledger.setRunRows(runId, check.rows, JSON.stringify(check.cash), approval.id, (): boolean => true) === undefined) {
      return;
    }
    noteCheck(ledger, runId, check.rows, check.cash);
    runNote(
      ledger,
      runId,
      "approval",
      `Approval by ${approval.approver ?? ""} ${why}. Check the run again to open a new request`,
    );
    return;
  }

  // The rows are released as the approved terms have them, whatever a check in
  // another process has written on them since. The binding matched, so they are
  // the rows this release checked.
  const approved: RunTerms = JSON.parse(approval.terms) as RunTerms;
  const payees: Map<number, string> = new Map(
    payRows(check.rows).map((row: PayRow): [number, string] => [row.line, row.payee]),
  );
  const stored: RunRow[] = ledger.runRows(runId);
  const releaseRows: ReleaseRow[] = approved.rows.map((row: RunRowTerms): ReleaseRow => ({
    rowId: stored.find((entry: RunRow): boolean => entry.line === row.line)?.id ?? 0,
    // The domain the approvers approved, none when the row gave none.
    supplierDomain: row.supplierDomain ?? "",
    line: row.line,
    invoiceId: row.invoiceId,
    payee: payees.get(row.line) ?? row.payTo,
    beneficiaryId: row.beneficiaryId,
    currency: row.currency,
    amountMinor: row.amountMinor,
    transferMethod: row.transferMethod,
    accountKey: row.accountKey,
    payTo: row.payTo,
    firstLine: `Opened from pay run ${runId}, row ${row.line} (${run.fileName}, file ${run.fileHash.slice(0, 8)}), uploaded by ${run.uploadedBy} and approved by ${approval.approver ?? ""} on request ${approval.id} (binding ${approval.binding.slice(0, 8)}): ${formatMoney(row.amountMinor, row.currency)} to ${row.payTo}`,
  }));

  const released: ReleasedRun | undefined = await withCurrencyLocks(
    ledger,
    approved.totals.map((total: RunTotal): string => total.currency),
    async (leases: Lease[]): Promise<ReleasedRun | undefined> => {
      // Read again under the locks, so no payment opened since the check is
      // missed.
      const fresh: RunCash[] = await cashCheck(engine, check.rows, runId);
      const short: RunCash | undefined = fresh.find((entry: RunCash): boolean => entry.problem !== null);
      if (short !== undefined) {
        if (ledger.setRunRows(runId, check.rows, JSON.stringify(fresh), approval.id, (): boolean => true) !== undefined) {
          runNote(
            ledger,
            runId,
            "warning",
            `Not released: ${short.problem ?? ""}. The approval by ${approval.approver ?? ""} is void. Check the run again once there is cash for it`,
          );
        }
        return undefined;
      }
      return ledger.releaseRun(
        runId,
        approval.id,
        run.uploadedBy,
        releaseRows,
        `Released on the approval of ${approval.approver ?? ""}: ${plural(releaseRows.length, "invoice")} to pay, ${totalsText(approved.totals)}`,
        leases,
      );
    },
  );
  if (released === undefined) {
    return;
  }
  for (const dropped of released.dropped) {
    runNote(
      ledger,
      runId,
      "warning",
      `Row ${dropped.line} (${dropped.invoiceId}) was not released: PayOnce already had ${dropped.invoiceId} when the run was released`,
    );
  }
  // One at a time, in file order, so a run never sends a burst of payments. Only
  // these wakes, and the server's watcher once the release has stopped, may send
  // a row's first payment.
  for (const invoiceId of released.released) {
    agent.wake(invoiceId, true);
    await agent.whenIdle(invoiceId);
  }
  const sent: number = released.released.filter(
    (invoiceId: string): boolean => ledger.attempts(invoiceId).length > 0,
  ).length;
  const held: number = released.released.filter(
    (invoiceId: string): boolean => ledger.obligation(invoiceId)?.state === "escalated",
  ).length;
  const failed: number = released.released.length - sent - held;
  runNote(
    ledger,
    runId,
    "payment",
    `First payments: ${sent} sent${held === 0 ? "" : `, ${held} held for a person`}${failed === 0 ? "" : `, ${failed} not sent yet and tried again in a minute`}. Each invoice carries on as an incident of its own`,
  );
}

// How a run stands, for the page and the CLI.
export type RunStatus =
  | "waiting-approval"
  | "approved"
  | "expired"
  | "needs-check"
  | "released"
  | "cancelled";

export function runStatus(ledger: Ledger, run: Run): RunStatus {
  if (run.state === "released" || run.state === "cancelled") {
    return run.state;
  }
  const latest: RunApproval | undefined = ledger.latestRunApproval(run.id);
  if (latest?.state === "requested") {
    return isExpired(latest) ? "expired" : "waiting-approval";
  }
  if (latest?.state === "approved") {
    return isExpired(latest) ? "expired" : "approved";
  }
  return "needs-check";
}

// The totals of a run's pay rows by currency, and how many rows pay, are held or
// are skipped.
export interface RunCounts {
  pay: number;
  held: number;
  skip: number;
  totals: { currency: string; amountMinor: number }[];
}

export function runCounts(rows: RunRow[]): RunCounts {
  const pay: RunRow[] = rows.filter(
    (row: RunRow): boolean => row.action === "pay" && row.state !== "dropped",
  );
  const totals: Map<string, number> = new Map();
  for (const row of pay) {
    if (row.currency !== null && row.amountMinor !== null) {
      totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amountMinor);
    }
  }
  return {
    pay: pay.length,
    held: pay.filter((row: RunRow): boolean => row.heldFor.length > 0).length,
    skip: rows.filter((row: RunRow): boolean => row.action === "skip").length,
    totals: [...totals.entries()]
      .sort(([a]: [string, number], [b]: [string, number]): number => a.localeCompare(b))
      .map(([currency, amountMinor]: [string, number]) => ({ currency, amountMinor })),
  };
}

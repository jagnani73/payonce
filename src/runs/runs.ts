import { getBalances, type Balance } from "../airwallex/balances.js";
import { findBeneficiary, type BeneficiaryRecord } from "../airwallex/beneficiaries.js";
import { getTransfer, type TransferBankDetails } from "../airwallex/transfers.js";
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
} from "../domain/approval.js";
import {
  APPROVED_USE_WITHIN_MS,
  checkSigner,
  eligibleApprovers,
  knownName,
  personName,
  signoffProblem,
  type ApprovalPolicy,
  type Approver,
  type Barred,
  type SignoffRule,
} from "../domain/approvers.js";
import { arrivalFor, ifSentOn, today } from "../domain/arrival.js";
import { routeKeyOf } from "../domain/assess.js";
import { isExpired } from "../domain/live.js";
import { withCurrencyLocks } from "../engine/currency-lock.js";
import type { Dispatcher } from "../engine/dispatcher.js";
import { likelyDuplicates, sameBillAndNumber, sameNumberExactly, sameSupplier, type Bill } from "../domain/duplicates.js";
import type { Engine } from "../engine/engine.js";
import { lineWanted } from "../engine/lines.js";
import {
  alreadyInLedger,
  NothingToPayError,
  RailOutageError,
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
  type ScannedObligation,
  type Outage,
  type ReleasedRun,
  type ReleaseRow,
  type Run,
  type RunApproval,
  type RunRow,
  type Signoff,
  type TransferMethod,
} from "../store/ledger.js";
import { formatAmount, formatMoney } from "../domain/money.js";
import { runHoldLine, runWaitingLine } from "../outages/outages.js";
import { committedAcross, committedByInvoice, type CommittedExcept } from "../store/read/cash.js";
import { runRequestTerms } from "../store/stored.js";
import { oneLine, printable, say, sayError } from "../text/printable.js";
import { currencyFloor, type CurrencyFloor, type FloorSource } from "../domain/reserve.js";
import { rowFromCells, type RunFile, type RunFileRow } from "./run-file.js";
import { TRANSFER_METHODS } from "../domain/patterns.js";

// What the CLI says for an invoice number the ledger has no invoice for: that it
// is a pay row of the run waiting for approval, which is no invoice until the run
// is released, or that it is not in the ledger.
export function notAnInvoiceText(ledger: Ledger, invoiceId: string): string {
  const row: RunRow | undefined = ledger.waitingRunRow(invoiceId);
  return row === undefined
    ? `${printable(invoiceId)} is not in the ledger`
    : `${printable(invoiceId)} is row ${row.line} of pay run ${row.runId}, which is waiting for approval, so it is not an invoice until the run is released. See the run with pnpm payrun show ${row.runId}`;
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
  // routeKey is where that payment's money went.
  lastPaid: { reference: string | null; routeKey: string; payTo: string } | undefined;
}

function amount(minor: number | null): string {
  return minor === null ? "unknown" : formatAmount(minor);
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
// the transfer it last paid, for the bank details it went to. That is the latest
// checked payment (lastPaidTransfer), or for a supplier PayOnce paid only before
// it kept which account each payment went to, the latest of those, as before
// accounts were kept. GETs only.
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
      details === undefined
        ? undefined
        : (engine.ledger.lastPaidTransfer(id) ?? engine.ledger.lastPaidUnchecked(id));
    let lastPaid: Payee["lastPaid"] = undefined;
    if (last !== undefined) {
      const sentTo: TransferBankDetails | undefined = (await getTransfer(engine.client, last.transferId))
        .beneficiary?.bank_details;
      lastPaid = {
        reference: last.reference,
        routeKey: routeKeyOf(sentTo),
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
    dueDate: row.dueDate,
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
// from is the day a pay row's arrival estimate counts from.
function checkRow(
  ledger: Ledger,
  row: RunFileRow,
  earlier: RunFileRow[],
  payees: Map<string, Payee>,
  from: string,
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
    const alike: ScannedObligation | undefined = ledger
      .scannedObligations()
      .find(
        (other: ScannedObligation): boolean =>
          sameNumberExactly(other.invoiceId, invoiceId) &&
          (other.beneficiaryId === row.beneficiaryId ||
            (payeeName !== null && sameSupplier(other.supplier, payeeName))),
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
          `The supplier in the file is ${row.supplier}, and the account name on beneficiary ${short} is ${oneLine(details.account_name ?? "missing")}`,
        );
      }
      if (row.currency !== null && details.account_currency !== row.currency) {
        reasons.push(
          details.account_currency === undefined
            ? `Beneficiary ${short} does not say which currency its account is in`
            : `The beneficiary's account is in ${details.account_currency}, and the row pays ${row.currency}`,
        );
      }
      const usable: TransferMethod[] = TRANSFER_METHODS.filter((entry: TransferMethod): boolean =>
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
      // A changed account is paid only once a callback verified it. Only where the
      // money goes counts, so a bank name Airwallex rewrote is not a change.
      // A payee no person has approved a payment to counts as new, whatever PayOnce
      // paid it by itself (paidOnApproval). The account check below still compares
      // with the last payment, automatic or not.
      newPayee = !ledger.paidOnApproval(row.beneficiaryId);
      if (payee.lastPaid === undefined) {
        newPayee = true;
      } else if (payee.lastPaid.routeKey !== routeKeyOf(details)) {
        const verified: BankChange | undefined = ledger.verifiedBankChange(row.beneficiaryId, details);
        if (verified !== undefined) {
          bankChangeId = verified.id;
        } else {
          reasons.push(
            `The bank details on file for ${oneLine(details.account_name ?? row.supplier ?? "the supplier")} (${accountEnding(details)}) are not the ones PayOnce last paid it (${payee.lastPaid.payTo}${payee.lastPaid.reference === null ? "" : `, transfer ${payee.lastPaid.reference}`}). Check the new details with the supplier. If they are right, pay this invoice outside PayOnce. If not, restore the old details in Airwallex and upload the row again`,
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
            (other: ScannedObligation): string => other.invoiceId,
          )
        : [],
    newPayee: pays && newPayee,
    bankChangeId: pays ? bankChangeId : null,
    payee: details === undefined ? null : name,
    payTo: details === undefined ? null : payTo(name, details),
    accountKey: details === undefined ? null : accountKeyOf(details),
    routeKey: details === undefined ? null : routeKeyOf(details),
    dueDate: row.dueDate,
    arrival:
      pays && method !== null && row.currency !== null
        ? arrivalFor(method, row.currency, details, row.dueDate, from)
        : null,
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
      row.accountKey !== null &&
      row.arrival !== null
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
        arrival: row.arrival,
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
// Each pay row's arrival estimate counts from the day from: today for a check, and
// the approved estimate's day for a release, so a release after midnight still
// matches its approval.
export async function checkRows(
  engine: Engine,
  rows: RunFileRow[],
  runId: number | null,
  from: string = today(),
): Promise<RunCheck> {
  const payees: Map<string, Payee> = await readPayees(engine, rows);
  const checked: CheckedRow[] = rows.map(
    (row: RunFileRow, index: number): CheckedRow =>
      checkRow(engine.ledger, row, rows.slice(0, index), payees, from),
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

// A row's supplier_domain against the others PayOnce knows for its beneficiary.
// onFile is the domain of the latest invoice to it that has one, or null.
// inRun lists other domains this run gives the same beneficiary. paidBefore is
// true when an invoice to it was paid once. caution is true when the domain
// disagrees with either, or is the first on file for a beneficiary PayOnce has
// already paid, which is where a fraudster's domain would slip in. Any caution
// needs two approvers.
export interface DomainCheck {
  line: number;
  invoiceId: string;
  domain: string;
  onFile: string | null;
  inRun: string[];
  paidBefore: boolean;
  caution: boolean;
}

export function domainChecks(ledger: Ledger, terms: RunTerms): DomainCheck[] {
  const obligations: ScannedObligation[] = ledger.scannedObligations();
  // Every domain the run gives each beneficiary.
  const given: Map<string, Set<string>> = new Map<string, Set<string>>();
  for (const row of terms.rows) {
    if (row.supplierDomain !== undefined) {
      const domains: Set<string> = given.get(row.beneficiaryId) ?? new Set<string>();
      domains.add(row.supplierDomain);
      given.set(row.beneficiaryId, domains);
    }
  }
  return terms.rows.flatMap((row: RunRowTerms): DomainCheck[] => {
    const domain: string | undefined = row.supplierDomain;
    if (domain === undefined) {
      return [];
    }
    const theirs: ScannedObligation[] = obligations.filter(
      (obligation: ScannedObligation): boolean => obligation.beneficiaryId === row.beneficiaryId,
    );
    // Newest first, so this is the latest invoice with a domain.
    const onFile: string | null =
      theirs.find((obligation: ScannedObligation): boolean => obligation.supplierDomain !== "")?.supplierDomain ?? null;
    const inRun: string[] = [...(given.get(row.beneficiaryId) ?? [])].filter((other: string): boolean => other !== domain);
    const paidBefore: boolean = theirs.some((obligation: ScannedObligation): boolean => ledger.paidOnce(obligation.invoiceId));
    const caution: boolean = inRun.length > 0 || (onFile !== null && onFile !== domain) || (onFile === null && paidBefore);
    return [{ line: row.line, invoiceId: row.invoiceId, domain, onFile, inRun, paidBefore, caution }];
  });
}

// The words for a row's domain, as the approval card and pnpm payrun show them.
export function domainText(check: DomainCheck): string {
  const gives: string = `Row ${check.line} gives ${check.domain} as the supplier's email domain`;
  const parts: string[] = [];
  if (check.onFile === null) {
    parts.push(
      check.paidBefore
        ? "the first domain on file for a beneficiary PayOnce has already paid"
        : "the first domain on file for this beneficiary",
    );
  } else {
    parts.push(check.onFile === check.domain ? "the one already on file" : `but ${check.onFile} is on file for this beneficiary`);
  }
  if (check.inRun.length > 0) {
    parts.push(`and this run also gives it ${check.inRun.join(" and ")}`);
  }
  return `${gives}, ${parts.join(", ")}`;
}

// The day the estimates in a run's terms count from, or null when no row has one.
function termsDay(terms: RunTerms): string | null {
  return terms.rows.find((row: RunRowTerms): boolean => row.arrival !== undefined)?.arrival?.from ?? null;
}

// The day a check counts arrival estimates from: the day of the run's request
// while it is requested or approved and has not expired, so a check after
// midnight keeps its binding and its signoffs. Otherwise today.
function checkDay(ledger: Ledger, runId: number): string {
  const latest: RunApproval | undefined = ledger.latestRunApproval(runId);
  return latest !== undefined &&
    (latest.state === "requested" || latest.state === "approved") &&
    !isExpired(latest)
    ? (termsDay(runRequestTerms(latest)) ?? today())
    : today();
}

// The rows with every pay row's estimate counted from the day. Only the dates
// change, so nothing is read again.
function countedFrom(rows: CheckedRow[], day: string): CheckedRow[] {
  return rows.map(
    (row: CheckedRow): CheckedRow =>
      row.arrival === null || row.arrival.from === day ? row : { ...row, arrival: ifSentOn(row.arrival, day) },
  );
}

// The largest currency total, which approver limits are checked against, as the
// page and pnpm payrun show it.
export function largestTotal(terms: RunTerms): { amountMinor: number; currency: string } {
  const amount: PaymentAmount = runAmount(terms);
  return { amountMinor: amount.minor, currency: amount.currency };
}

// How many approvers a run needs, and why: two for a payee PayOnce has never
// paid on a person's approval (newPayee), for an account a callback verified, for a supplier_domain with a
// caution (domainChecks), when any currency's total is above
// TWO_APPROVERS_ABOVE, and when the uploader's name, stored before names were
// checked, does not follow the name rule, so the uploader cannot be barred.
export function runRule(
  policy: ApprovalPolicy,
  rows: CheckedRow[],
  amount: PaymentAmount,
  domains: DomainCheck[],
  uploadedBy: string,
): SignoffRule {
  const pay: PayRow[] = payRows(rows);
  const fresh: PayRow | undefined = pay.find((row: PayRow): boolean => row.newPayee);
  if (fresh !== undefined) {
    return { needed: 2, why: `row ${fresh.line} pays ${fresh.payee}, which PayOnce has never paid on a person's approval` };
  }
  const changed: PayRow | undefined = pay.find((row: PayRow): boolean => row.bankChange !== null);
  if (changed !== undefined) {
    return {
      needed: 2,
      why: `row ${changed.line} pays an account a callback verified, not the one PayOnce last paid ${changed.payee}`,
    };
  }
  // The sender check trusts the domain, so one that disagrees with another for
  // the same beneficiary, or is new for a beneficiary already paid, is reviewed
  // by two.
  const caution: DomainCheck | undefined = domains.find((check: DomainCheck): boolean => check.caution);
  if (caution !== undefined) {
    return {
      needed: 2,
      why:
        caution.inRun.length > 0
          ? `row ${caution.line} gives ${caution.domain} as the supplier's email domain, and this run gives the same beneficiary ${caution.inRun.join(" and ")}`
          : caution.onFile === null
            ? `row ${caution.line} sets ${caution.domain} as the first email domain for a beneficiary PayOnce has already paid`
            : `row ${caution.line} gives ${caution.domain} as the supplier's email domain, and ${caution.onFile} is on file for that beneficiary`,
    };
  }
  if (amount.minor > policy.twoApproversAboveMinor) {
    return {
      needed: 2,
      why: `the ${amount.currency} total is above ${formatMoney(policy.twoApproversAboveMinor, amount.currency)}`,
    };
  }
  if (knownName(uploadedBy) === null) {
    return { needed: 2, why: "PayOnce does not know who uploaded this run" };
  }
  return { needed: 1, why: "" };
}

// Who may not approve the run: whoever uploaded it, everyone who recorded the
// callback for an account a row pays, and whoever proposed or confirmed the phone
// number such a callback was made on. A name stored before names were checked
// that does not follow the name rule bars nobody (knownName): runRule asks for
// two approvers for such an uploader, and a row to a callback-verified account
// needs two already.
export function runBarred(ledger: Ledger, terms: RunTerms): Barred[] {
  const barred: Barred[] = [];
  const uploader: string | null = knownName(terms.uploadedBy);
  if (uploader !== null) {
    barred.push({ name: uploader, why: "uploaded this run" });
  }
  for (const row of terms.rows) {
    const change: BankChange | undefined =
      row.bankChange === null ? undefined : ledger.bankChange(row.bankChange);
    if (change?.appliedKey === null || change === undefined) {
      continue;
    }
    for (const stored of ledger.bankChangeRecorders(row.beneficiaryId, change.appliedKey)) {
      const name: string | null = knownName(stored);
      if (name !== null) {
        barred.push({ name, why: `recorded the callback for the bank details row ${row.line} pays` });
      }
    }
    for (const setter of ledger.callbackPhoneSetters(row.beneficiaryId, change.appliedKey)) {
      const name: string | null = knownName(setter.name);
      if (name !== null) {
        barred.push({ name, why: `${setter.role} the phone number the callback for row ${row.line} was made on` });
      }
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
  // One line, as the ledger stores it, so a line break in a name, a note or a
  // skip reason cannot print as a line of its own.
  const line: string = oneLine(message);
  if (!lineWanted(ledger.runEvents(runId), kind, line, topic)) {
    return;
  }
  ledger.addRunEvent(runId, kind, line, topic);
  say(`  run ${runId}    ${kind.padEnd(8)} ${line}`);
}

// Puts a failure on the run's timeline. It must not throw, because it runs from
// error handlers.
export function runNoteError(ledger: Ledger, runId: number, error: unknown, what: string = ""): void {
  sayError(error);
  try {
    runNote(ledger, runId, "error", `${what}${error instanceof Error ? error.message : String(error)}`);
  } catch (inner: unknown) {
    sayError(
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
  checked: CheckedRow[],
  cash: RunCash[],
): RunLine[] {
  const lines: RunLine[] = [];
  const say = (kind: EventKind, message: string, topic: string | null = null): void => {
    lines.push({ kind, message, topic });
  };
  let rows: CheckedRow[] = checked;
  let terms: RunTerms = termsOf(run, rows, cash);
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
  let binding: string = bindingOf(terms);
  const amount: PaymentAmount = runAmount(terms);
  const rule: SignoffRule = runRule(policy, rows, amount, domainChecks(ledger, terms), terms.uploadedBy);
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
  const keeps = (key: string): boolean =>
    latest !== undefined &&
    (latest.state === "requested" || latest.state === "approved") &&
    latest.binding === key &&
    latest.needed >= rule.needed &&
    !isExpired(latest);
  let same: boolean = keeps(binding);
  if (!same) {
    // A new request counts from today, even when the check counted from the open
    // request's day to keep it. The stored rows count from today too.
    const day: string = today();
    if (rows.some((row: CheckedRow): boolean => row.arrival !== null && row.arrival.from !== day)) {
      rows = countedFrom(rows, day);
      ledger.setRunArrivals(run.id, rows);
      terms = termsOf(run, rows, cash);
      binding = bindingOf(terms);
      // Another process may have opened today's request on these rows after the
      // check read the day the old one kept, so it is compared again.
      same = keeps(binding);
    }
  }
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
export async function uploadRun(engine: Engine, file: RunFile, uploader: string): Promise<number> {
  const uploadedBy: string = personName(uploader);
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
  const check: RunCheck = await checkRows(
    engine,
    fileRowsOf(engine.ledger, run),
    runId,
    checkDay(engine.ledger, runId),
  );
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
  const terms: RunTerms = runRequestTerms(approval);
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
export function cancelRun(ledger: Ledger, runId: number, canceller: string, note: string): void {
  const cancelledBy: string = personName(canceller);
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
  const approved: RunTerms = runRequestTerms(approval);
  // Read first, so a run held by an outage costs a ledger read and no Airwallex
  // call each time the watcher tries it.
  const outage: Outage | undefined = runOutage(ledger, approved);
  if (outage !== undefined) {
    holdRun(ledger, runId, outage, approval, approved);
    return;
  }
  const check: RunCheck = await checkRows(engine, fileRowsOf(ledger, run), runId, termsDay(approved) ?? today());
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
      runRule(engine.approvals, check.rows, amount, domainChecks(ledger, terms), terms.uploadedBy),
      approval,
      amount,
      runBarred(ledger, terms),
    );
    why = problem === null ? null : `is void: ${problem}`;
  }
  // Rows left waiting for a person count from today, as the next check does.
  const waiting: CheckedRow[] = countedFrom(check.rows, today());
  if (why !== null) {
    // Another process may have released the run, or checked it again, since.
    if (ledger.setRunRows(runId, waiting, JSON.stringify(check.cash), approval.id, (): boolean => true) === undefined) {
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
    dueDate: row.arrival?.dueDate ?? null,
    firstLine: `Opened from pay run ${runId}, row ${row.line} (${run.fileName}, file ${run.fileHash.slice(0, 8)}), uploaded by ${run.uploadedBy} and approved by ${approval.approver ?? ""} on request ${approval.id} (binding ${approval.binding.slice(0, 8)}): ${formatMoney(row.amountMinor, row.currency)} to ${row.payTo}`,
  }));

  let released: ReleasedRun | undefined;
  try {
    released = await releaseUnderLocks(engine, run, approval, approved, check, waiting, releaseRows);
  } catch (error: unknown) {
    // An outage declared since the read above: Ledger.releaseRun changed nothing.
    const declared: Outage | undefined =
      error instanceof RailOutageError ? ledger.outage(error.outageId) : undefined;
    if (declared === undefined) {
      throw error;
    }
    if (declared.state === "active") {
      holdRun(ledger, runId, declared, approval, approved);
    }
    return;
  }
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
    agent.wake(invoiceId, { runTurn: true });
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

// The first active outage on a rail any approved row pays on.
function runOutage(ledger: Ledger, terms: RunTerms): Outage | undefined {
  for (const row of terms.rows) {
    const outage: Outage | undefined = ledger.activeOutage(row.currency, row.transferMethod);
    if (outage !== undefined) {
      return outage;
    }
  }
  return undefined;
}

// A run with any row on a rail with an outage waits whole, with its approval
// neither spent nor void, and the watcher tries the release again every minute.
// The approval still expires when it would.
function holdRun(ledger: Ledger, runId: number, outage: Outage, approval: RunApproval, terms: RunTerms): void {
  const lines: number[] = terms.rows
    .filter(
      (row: RunRowTerms): boolean =>
        row.currency.toUpperCase() === outage.currency && row.transferMethod.toUpperCase() === outage.method,
    )
    .map((row: RunRowTerms): number => row.line);
  const line: string = runHoldLine(outage, lines, approval.approver ?? "", approval.expiresAt);
  const waiting: string = runWaitingLine(outage);
  // The waiting line is written with the hold, so it never lands after the end.
  ledger.holdForOutage(outage.id, { runId }, "run", line, {
    kind: "outage",
    message: waiting,
    topic: "release",
    wanted: (events: LedgerEvent[]): boolean => lineWanted(events, "outage", waiting, "release"),
  });
}

// The release once every check passed: under the lock of every currency the run
// pays, the cash check again on a fresh balance, then the one transaction that
// spends the approval and writes the rows as invoices.
async function releaseUnderLocks(
  engine: Engine,
  run: Run,
  approval: RunApproval,
  approved: RunTerms,
  check: RunCheck,
  waiting: CheckedRow[],
  releaseRows: ReleaseRow[],
): Promise<ReleasedRun | undefined> {
  const ledger: Ledger = engine.ledger;
  const runId: number = run.id;
  return withCurrencyLocks(
    ledger,
    approved.totals.map((total: RunTotal): string => total.currency),
    async (leases: Lease[]): Promise<ReleasedRun | undefined> => {
      // Read again under the locks, so no payment opened since the check is
      // missed.
      const fresh: RunCash[] = await cashCheck(engine, check.rows, runId);
      const short: RunCash | undefined = fresh.find((entry: RunCash): boolean => entry.problem !== null);
      if (short !== undefined) {
        if (ledger.setRunRows(runId, waiting, JSON.stringify(fresh), approval.id, (): boolean => true) !== undefined) {
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

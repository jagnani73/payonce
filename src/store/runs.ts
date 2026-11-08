import type { StatementSync } from "node:sqlite";
import type { AccountFailure } from "../domain/approval.js";
import type { ArrivalTerms } from "../domain/arrival.js";
import type { ApprovalStore, RunApprovalRow } from "./approvals.js";
import { isPrimaryKeyViolation, isUniqueViolation, storedObject, storedStrings, type Db } from "./db.js";
import { alreadyInLedger, type InvoiceStore, type TransferMethod } from "./invoices.js";
import type { Lease, LockStore } from "./locks.js";
import { RailOutageError, type Outage, type OutageStore } from "./outages.js";
import type { Timelines } from "./timeline.js";

export type RunState = "waiting" | "released" | "cancelled";

// A pay row is paid when the run is released. A skip row never is.
export type RunRowAction = "pay" | "skip";

// released is a row written into the ledger as an invoice. dropped is a pay row
// that never was: its invoice number was taken by then, or the run was cancelled.
export type RunRowState = "waiting" | "released" | "dropped";

export interface NewRun {
  fileName: string;
  fileHash: string;
  // The file's header, in order, so its rows can be read again from their cells.
  columns: string[];
  uploadedBy: string;
  // JSON: the cash check of the last check, per currency.
  cash: string;
}

export interface Run extends NewRun {
  id: number;
  uploadedAt: string;
  state: RunState;
  checkedAt: string;
  releasedAt: string | null;
  cancelledBy: string | null;
  cancelNote: string | null;
}

// A row as the last check left it.
export interface CheckedRow {
  line: number;
  cells: string[];
  invoiceId: string | null;
  supplier: string | null;
  beneficiaryId: string | null;
  currency: string | null;
  amountMinor: number | null;
  transferMethod: TransferMethod | null;
  sandboxOutcome: string;
  action: RunRowAction;
  // Why a skip row is skipped.
  reasons: string[];
  // Invoices in the ledger the row looks like a second bill for. PayOnce holds it
  // for a person when it comes to send it.
  heldFor: string[];
  newPayee: boolean;
  // The callback that verified the account on file, when it is not the one
  // PayOnce last paid.
  bankChangeId: number | null;
  // The callback that verified the account on file, whether or not it is the one
  // PayOnce last paid (verifiedBankChange). Null on rows from before it.
  verifiedBy: number | null;
  // The latest transfer that failed on the account with an account-level code,
  // when nothing to the account was paid after it (accountFailure).
  accountFailure: AccountFailure | null;
  // The account name on the beneficiary record. The invoice is recorded under it.
  payee: string | null;
  payTo: string | null;
  accountKey: string | null;
  // The routeKey of the record the check read, where the row's money goes.
  routeKey: string | null;
  // The due date the file gives, or null.
  dueDate: string | null;
  // When a pay row usually arrives, as its approvers see it. Null on a skip row.
  arrival: ArrivalTerms | null;
}

export interface RunRow extends CheckedRow {
  id: number;
  runId: number;
  state: RunRowState;
  // Why a dropped row was not released.
  note: string | null;
}

// A pay row the release writes as an invoice, as the approved terms have it.
export interface ReleaseRow {
  rowId: number;
  line: number;
  invoiceId: string;
  payee: string;
  beneficiaryId: string;
  currency: string;
  amountMinor: number;
  transferMethod: TransferMethod;
  // The account the approvers approved. The release writes it on the row, and
  // every payment of the row is sent only while the record still holds it.
  accountKey: string;
  payTo: string;
  dueDate: string | null;
  // The invoice's first timeline line, chained like any other.
  firstLine: string;
  // The domain the supplier's emails come from, from the file. Empty for none.
  supplierDomain: string;
}

// A pay row with the fields a skipped row keeps: the reasons, and no hold, new
// payee, callback, failed account or arrival, since those only matter for a row
// that pays.
export function skipRow(row: CheckedRow, reasons: string[]): CheckedRow {
  return {
    ...row,
    action: "skip",
    reasons,
    heldFor: [],
    newPayee: false,
    bankChangeId: null,
    verifiedBy: null,
    accountFailure: null,
    arrival: null,
  };
}

export interface ReleasedRun {
  released: string[];
  dropped: { line: number; invoiceId: string }[];
}

// Money a pay run has promised and not opened a payment for: a pay row of a
// waiting run whose approval is approved, or a released row whose invoice is
// open with no attempt yet.
export interface PayRunRow {
  runId: number;
  invoiceId: string;
  beneficiaryId: string;
  currency: string;
  amountMinor: number;
  transferMethod: TransferMethod;
}

interface PayRunRecord {
  run_id: number;
  invoice_id: string;
  beneficiary_id: string;
  currency: string;
  amount_minor: number;
  transfer_method: TransferMethod;
}

interface RunRowRecord {
  id: number;
  run_id: number;
  line: number;
  cells: string;
  invoice_id: string | null;
  supplier: string | null;
  beneficiary_id: string | null;
  currency: string | null;
  amount_minor: number | null;
  transfer_method: TransferMethod | null;
  sandbox_outcome: string;
  action: RunRowAction;
  reasons: string;
  held_for: string;
  new_payee: number;
  bank_change_id: number | null;
  payee: string | null;
  pay_to: string | null;
  account_key: string | null;
  route_key: string | null;
  state: RunRowState;
  note: string | null;
  due_date: string | null;
  arrival: string | null;
  // Missing on a file opened read-only from before the columns.
  verified_by?: number | null;
  account_failure?: string | null;
}

interface RunRecord {
  id: number;
  file_name: string;
  file_hash: string;
  columns: string;
  uploaded_by: string;
  uploaded_at: string;
  state: RunState;
  checked_at: string;
  cash: string;
  released_at: string | null;
  cancelled_by: string | null;
  cancel_note: string | null;
}

function toRun(row: RunRecord): Run {
  return {
    id: row.id,
    fileName: row.file_name,
    fileHash: row.file_hash,
    columns: storedStrings(row.columns),
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    state: row.state,
    checkedAt: row.checked_at,
    cash: row.cash,
    releasedAt: row.released_at,
    cancelledBy: row.cancelled_by,
    cancelNote: row.cancel_note,
  };
}

function toRunRow(row: RunRowRecord): RunRow {
  return {
    id: row.id,
    runId: row.run_id,
    line: row.line,
    cells: storedStrings(row.cells),
    invoiceId: row.invoice_id,
    supplier: row.supplier,
    beneficiaryId: row.beneficiary_id,
    currency: row.currency,
    amountMinor: row.amount_minor,
    transferMethod: row.transfer_method,
    sandboxOutcome: row.sandbox_outcome,
    action: row.action,
    reasons: storedStrings(row.reasons),
    heldFor: storedStrings(row.held_for),
    newPayee: row.new_payee === 1,
    bankChangeId: row.bank_change_id,
    verifiedBy: row.verified_by ?? null,
    accountFailure: typeof row.account_failure === "string" ? storedObject<AccountFailure>(row.account_failure) : null,
    payee: row.payee,
    payTo: row.pay_to,
    accountKey: row.account_key,
    routeKey: row.route_key ?? null,
    dueDate: row.due_date ?? null,
    arrival: typeof row.arrival === "string" ? storedObject<ArrivalTerms>(row.arrival) : null,
    state: row.state,
    note: row.note,
  };
}

// Another run is waiting for approval, and PayOnce takes one at a time.
export class WaitingRunError extends Error {
  readonly runId: number;

  constructor(runId: number) {
    super(`Run ${runId} is still waiting for approval. Cancel it or wait until it is released`);
    this.name = "WaitingRunError";
    this.runId = runId;
  }
}

// The same file is a run already, waiting or released.
export class SameFileError extends Error {
  readonly runId: number;

  constructor(run: Run) {
    super(
      `This file is run ${run.id}, uploaded by ${run.uploadedBy} at ${run.uploadedAt}, ${run.state === "released" ? "released" : "waiting for approval"}`,
    );
    this.name = "SameFileError";
    this.runId = run.id;
  }
}

// Every row of the file is skipped, so there is nothing to approve. rows says why
// each was skipped.
export class NothingToPayError extends Error {
  readonly rows: CheckedRow[];

  constructor(rows: CheckedRow[]) {
    super("Nothing to pay: every row of the file is skipped");
    this.name = "NothingToPayError";
    this.rows = rows;
  }
}

// Pay runs and their rows, from upload to release (runs, run_rows).
export class RunStore {
  private readonly db: Db;
  private readonly invoices: InvoiceStore;
  private readonly outages: OutageStore;
  private readonly locks: LockStore;
  private readonly timelines: Timelines;
  private readonly approvals: ApprovalStore;

  constructor(db: Db, invoices: InvoiceStore, outages: OutageStore, locks: LockStore, timelines: Timelines, approvals: ApprovalStore) {
    this.db = db;
    this.invoices = invoices;
    this.outages = outages;
    this.locks = locks;
    this.timelines = timelines;
    this.approvals = approvals;
  }

  run(id: number): Run | undefined {
    const row: RunRecord | undefined = this.db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(id) as unknown as RunRecord | undefined;
    return row === undefined ? undefined : toRun(row);
  }

  // Newest first.
  runs(): Run[] {
    return (
      this.db.prepare("SELECT * FROM runs ORDER BY id DESC").all() as unknown as RunRecord[]
    ).map(toRun);
  }

  waitingRun(): Run | undefined {
    const row: RunRecord | undefined = this.db
      .prepare("SELECT * FROM runs WHERE state = 'waiting' LIMIT 1")
      .get() as unknown as RunRecord | undefined;
    return row === undefined ? undefined : toRun(row);
  }

  // The run made from this file that is not cancelled, if any.
  liveRunForFile(fileHash: string): Run | undefined {
    const row: RunRecord | undefined = this.db
      .prepare("SELECT * FROM runs WHERE file_hash = ? AND state <> 'cancelled' LIMIT 1")
      .get(fileHash) as unknown as RunRecord | undefined;
    return row === undefined ? undefined : toRun(row);
  }

  // In file order.
  runRows(runId: number): RunRow[] {
    return (
      this.db
        .prepare("SELECT * FROM run_rows WHERE run_id = ? ORDER BY line")
        .all(runId) as unknown as RunRowRecord[]
    ).map(toRunRow);
  }

  runRow(id: number): RunRow | undefined {
    const row: RunRowRecord | undefined = this.db
      .prepare("SELECT * FROM run_rows WHERE id = ?")
      .get(id) as unknown as RunRowRecord | undefined;
    return row === undefined ? undefined : toRunRow(row);
  }

  // The run row an invoice was released from.
  runRowOf(invoiceId: string): RunRow | undefined {
    const row: RunRowRecord | undefined = this.db
      .prepare(
        `SELECT run_rows.* FROM run_rows
           JOIN obligations ON obligations.run_row_id = run_rows.id
          WHERE obligations.invoice_id = ?`,
      )
      .get(invoiceId) as unknown as RunRowRecord | undefined;
    return row === undefined ? undefined : toRunRow(row);
  }

  // A pay row of the run waiting for approval with this invoice number.
  waitingRunRow(invoiceId: string): RunRow | undefined {
    const row: RunRowRecord | undefined = this.db
      .prepare(
        `SELECT run_rows.* FROM run_rows JOIN runs ON runs.id = run_rows.run_id
          WHERE runs.state = 'waiting' AND run_rows.action = 'pay'
            AND run_rows.invoice_id = ? LIMIT 1`,
      )
      .get(invoiceId) as unknown as RunRowRecord | undefined;
    return row === undefined ? undefined : toRunRow(row);
  }

  private insertRunRow(runId: number, row: CheckedRow): void {
    this.db
      .prepare(
        `INSERT INTO run_rows
           (run_id, line, cells, invoice_id, supplier, beneficiary_id, currency, amount_minor,
            transfer_method, sandbox_outcome, action, reasons, held_for, new_payee,
            bank_change_id, payee, pay_to, account_key, due_date, arrival, route_key,
            verified_by, account_failure)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        row.line,
        JSON.stringify(row.cells),
        row.invoiceId,
        row.supplier,
        row.beneficiaryId,
        row.currency,
        row.amountMinor,
        row.transferMethod,
        row.sandboxOutcome,
        row.action,
        JSON.stringify(row.reasons),
        JSON.stringify(row.heldFor),
        row.newPayee ? 1 : 0,
        row.bankChangeId,
        row.payee,
        row.payTo,
        row.accountKey,
        row.dueDate,
        row.arrival === null ? null : JSON.stringify(row.arrival),
        row.routeKey,
        row.verifiedBy,
        row.accountFailure === null ? null : JSON.stringify(row.accountFailure),
      );
  }

  // Stores a checked file as a run waiting for approval, in one write transaction.
  // A row whose invoice number reached the ledger since the check is skipped
  // here, under the write lock. Throws WaitingRunError while another run waits,
  // SameFileError for a file that is a run already, and NothingToPayError when no
  // row is left to pay.
  createRun(input: NewRun, rows: CheckedRow[]): number {
    return this.db.transaction((): number => {
      const waiting: Run | undefined = this.waitingRun();
      if (waiting !== undefined) {
        throw new WaitingRunError(waiting.id);
      }
      const same: Run | undefined = this.liveRunForFile(input.fileHash);
      if (same !== undefined) {
        throw new SameFileError(same);
      }
      const checked: CheckedRow[] = rows.map((row: CheckedRow): CheckedRow =>
        row.action === "pay" && row.invoiceId !== null && this.invoices.obligation(row.invoiceId) !== undefined
          ? skipRow(row, [alreadyInLedger(row.invoiceId)])
          : row,
      );
      if (!checked.some((row: CheckedRow): boolean => row.action === "pay")) {
        throw new NothingToPayError(checked);
      }
      const now: string = new Date().toISOString();
      const result: { lastInsertRowid: number | bigint } = this.db
        .prepare(
          `INSERT INTO runs (file_name, file_hash, columns, uploaded_by, uploaded_at, checked_at, cash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.fileName,
          input.fileHash,
          JSON.stringify(input.columns),
          input.uploadedBy,
          now,
          now,
          input.cash,
        );
      const runId: number = Number(result.lastInsertRowid);
      for (const row of checked) {
        this.insertRunRow(runId, row);
      }
      return runId;
    });
  }

  // What a check found, written over the rows of a run still waiting, and then
  // settle, which settles the run's request, all in one write transaction. So the
  // rows never change under an approval without the approval changing with them.
  // voiding is the approved request a release found void, which is voided here.
  // Undefined, with nothing changed, when the run is no longer waiting, when
  // voiding is not the run's latest request, or, with no voiding, when the latest
  // request is approved and has not expired: those rows are the ones the release
  // pays.
  setRunRows<T>(
    runId: number,
    rows: CheckedRow[],
    cash: string,
    voiding: number | null,
    settle: () => T,
  ): T | undefined {
    return this.db.transaction((): T | undefined => {
      if (this.run(runId)?.state !== "waiting") {
        return undefined;
      }
      const latest: RunApprovalRow | undefined = this.db
        .prepare("SELECT * FROM run_approvals WHERE run_id = ? ORDER BY id DESC LIMIT 1")
        .get(runId) as unknown as RunApprovalRow | undefined;
      if (voiding === null) {
        if (latest?.state === "approved" && Date.parse(latest.expires_at) > Date.now()) {
          return undefined;
        }
      } else if (latest?.id !== voiding) {
        return undefined;
      } else if (latest.state === "approved") {
        this.db.prepare("UPDATE run_approvals SET state = 'void' WHERE id = ?").run(latest.id);
      }
      this.db
        .prepare("UPDATE runs SET checked_at = ?, cash = ? WHERE id = ?")
        .run(new Date().toISOString(), cash, runId);
      const update: StatementSync = this.db.prepare(
        `UPDATE run_rows SET invoice_id = ?, supplier = ?, beneficiary_id = ?, currency = ?,
                amount_minor = ?, transfer_method = ?, sandbox_outcome = ?, action = ?,
                reasons = ?, held_for = ?, new_payee = ?, bank_change_id = ?, payee = ?,
                pay_to = ?, account_key = ?, due_date = ?, arrival = ?, route_key = ?,
                verified_by = ?, account_failure = ?
          WHERE run_id = ? AND line = ?`,
      );
      for (const row of rows) {
        update.run(
          row.invoiceId,
          row.supplier,
          row.beneficiaryId,
          row.currency,
          row.amountMinor,
          row.transferMethod,
          row.sandboxOutcome,
          row.action,
          JSON.stringify(row.reasons),
          JSON.stringify(row.heldFor),
          row.newPayee ? 1 : 0,
          row.bankChangeId,
          row.payee,
          row.payTo,
          row.accountKey,
          row.dueDate,
          row.arrival === null ? null : JSON.stringify(row.arrival),
          row.routeKey,
          row.verifiedBy,
          row.accountFailure === null ? null : JSON.stringify(row.accountFailure),
          runId,
          row.line,
        );
      }
      return settle();
    });
  }

  // Rewrites the arrival estimates of a run's rows, inside the transaction of a
  // check that opens a request counting from another day than the check did.
  setRunArrivals(runId: number, rows: CheckedRow[]): void {
    if (!this.db.isTransaction) {
      throw new Error("A run's arrival estimates are rewritten only inside a ledger transaction");
    }
    const update: StatementSync = this.db.prepare(
      "UPDATE run_rows SET arrival = ? WHERE run_id = ? AND line = ?",
    );
    for (const row of rows) {
      update.run(row.arrival === null ? null : JSON.stringify(row.arrival), runId, row.line);
    }
  }

  // Cancels a run still waiting, voids its open request and drops its rows, so
  // their invoice numbers are free again. False when it is not waiting.
  cancelRun(runId: number, cancelledBy: string, note: string): boolean {
    return this.db.transaction((): boolean => {
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE runs SET state = 'cancelled', cancelled_by = ?, cancel_note = ?
            WHERE id = ? AND state = 'waiting'`,
        )
        .run(cancelledBy, note, runId);
      if (Number(result.changes) !== 1) {
        return false;
      }
      this.approvals.voidOpenRunApprovals(runId);
      this.db
        .prepare(
          `UPDATE run_rows SET state = 'dropped', note = 'the run was cancelled'
            WHERE run_id = ? AND action = 'pay' AND state = 'waiting'`,
        )
        .run(runId);
      return true;
    });
  }

  // Spends the run's approval, marks the run released and writes each pay row as
  // an invoice with its first chained timeline line, all in one write
  // transaction, so a run is never half released and an approval is never spent
  // twice. Each released row gets the account the approved terms name, which is
  // the one every payment of the row checks the record against. A row whose
  // invoice number another invoice took since the check is dropped and not
  // released. Undefined, with nothing changed, when the approval is no longer
  // approved or has expired, or the run is no longer waiting. Throws
  // LeaseLostError unless leases still hold the lock of every currency the rows
  // pay, and RailOutageError, with nothing changed, when any row pays on a rail
  // with an active outage, so the whole run waits with its approval. Throws
  // StoredShapeError, with nothing changed, when the request's stored terms no
  // longer hash to its binding.
  releaseRun(
    runId: number,
    approvalId: number,
    uploadedBy: string,
    rows: ReleaseRow[],
    runLine: string,
    leases: Lease[],
  ): ReleasedRun | undefined {
    return this.db.transaction((): ReleasedRun | undefined => {
      for (const currency of new Set(rows.map((row: ReleaseRow): string => row.currency))) {
        const lease: Lease | undefined = leases.find((entry: Lease): boolean => entry.currency === currency);
        if (lease === undefined) {
          throw new Error(`Run ${runId} pays ${currency}, and its release does not hold the ${currency} lock`);
        }
        this.locks.requireLease(lease);
      }
      for (const row of rows) {
        const outage: Outage | undefined = this.outages.activeOutage(row.currency, row.transferMethod);
        if (outage !== undefined) {
          throw new RailOutageError(outage, "run");
        }
      }
      this.approvals.requireBoundRun(approvalId);
      const now: string = new Date().toISOString();
      // Read under the write lock, so nothing can change between this and the
      // updates.
      const ready: unknown = this.db
        .prepare(
          `SELECT 1 FROM run_approvals JOIN runs ON runs.id = run_approvals.run_id
            WHERE run_approvals.id = ? AND run_approvals.run_id = ?
              AND run_approvals.state = 'approved' AND run_approvals.expires_at > ?
              AND runs.state = 'waiting'`,
        )
        .get(approvalId, runId, now);
      if (ready === undefined) {
        return undefined;
      }
      this.db.prepare("UPDATE run_approvals SET state = 'used' WHERE id = ?").run(approvalId);
      this.db
        .prepare("UPDATE runs SET state = 'released', released_at = ? WHERE id = ?")
        .run(now, runId);
      this.timelines.addRunEventRow(runId, "payment", runLine, null);
      const result: ReleasedRun = { released: [], dropped: [] };
      for (const row of rows) {
        this.db.exec("SAVEPOINT release_row");
        try {
          // A plain INSERT, so an invoice number taken since the check fails here.
          // A row pays from its own currency's wallet, so source_currency is null.
          this.db
            .prepare(
              `INSERT INTO obligations
                 (invoice_id, supplier, supplier_domain, beneficiary_id, currency, amount_minor,
                  transfer_method, invoice_floor_minor, started_by, supplier_phone, run_row_id,
                  look_at, source_currency, due_date)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, NULL, ?)`,
            )
            .run(
              row.invoiceId,
              row.payee,
              row.supplierDomain,
              row.beneficiaryId,
              row.currency,
              row.amountMinor,
              row.transferMethod,
              uploadedBy,
              row.rowId,
              now,
              row.dueDate,
            );
          const marked: { changes: number | bigint } = this.db
            .prepare(
              `UPDATE run_rows SET state = 'released', account_key = ?, pay_to = ?,
                      route_key = CASE WHEN account_key = ? THEN route_key END
                WHERE id = ? AND run_id = ? AND state = 'waiting'`,
            )
            .run(row.accountKey, row.payTo, row.accountKey, row.rowId, runId);
          if (Number(marked.changes) !== 1) {
            throw new Error(`Row ${row.line} of run ${runId} is not waiting to be released`);
          }
          this.timelines.appendEvent(row.invoiceId, "approval", row.firstLine, null);
          this.db.exec("RELEASE release_row");
          result.released.push(row.invoiceId);
        } catch (error: unknown) {
          this.db.exec("ROLLBACK TO release_row");
          this.db.exec("RELEASE release_row");
          if (!isUniqueViolation(error) && !isPrimaryKeyViolation(error)) {
            throw error;
          }
          this.db
            .prepare(
              `UPDATE run_rows SET state = 'dropped', note = ?
                WHERE id = ? AND state = 'waiting'`,
            )
            .run(`PayOnce already had ${row.invoiceId} when the run was released`, row.rowId);
          result.dropped.push({ line: row.line, invoiceId: row.invoiceId });
        }
      }
      return result;
    });
  }

  // Waiting runs whose latest request is approved, for the server to release.
  approvedRuns(): number[] {
    return (
      this.db
        .prepare(
          `SELECT runs.id FROM runs
            WHERE runs.state = 'waiting'
              AND (SELECT state FROM run_approvals WHERE run_id = runs.id
                    ORDER BY id DESC LIMIT 1) = 'approved'`,
        )
        .all() as unknown as { id: number }[]
    ).map((row: { id: number }): number => row.id);
  }

  // Released invoices that have not opened their first payment yet, by run, in
  // file order.
  unsentRunInvoices(): { invoiceId: string; runId: number }[] {
    return (
      this.db
        .prepare(
          `SELECT obligations.invoice_id, run_rows.run_id FROM obligations
             JOIN run_rows ON run_rows.id = obligations.run_row_id
            WHERE obligations.state = 'open'
              AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.invoice_id = obligations.invoice_id)
            ORDER BY run_rows.run_id, run_rows.line`,
        )
        .all() as unknown as { invoice_id: string; run_id: number }[]
    ).map((row: { invoice_id: string; run_id: number }): { invoiceId: string; runId: number } => ({
      invoiceId: row.invoice_id,
      runId: row.run_id,
    }));
  }

  // Money pay runs have promised and not opened a payment for. Both kinds are read
  // from the state of the rows, so a row stops counting in the transaction that
  // opens its attempt.
  payRunRows(now: number = Date.now()): PayRunRow[] {
    return (
      this.db
        .prepare(
          `SELECT run_rows.run_id, run_rows.invoice_id, run_rows.beneficiary_id, run_rows.currency,
                  run_rows.amount_minor, run_rows.transfer_method
             FROM run_rows JOIN runs ON runs.id = run_rows.run_id
            WHERE runs.state = 'waiting' AND run_rows.action = 'pay' AND run_rows.state = 'waiting'
              AND EXISTS (SELECT 1 FROM run_approvals a WHERE a.run_id = runs.id
                           AND a.state = 'approved' AND a.expires_at > ?
                           AND a.id = (SELECT MAX(id) FROM run_approvals WHERE run_id = runs.id))
           UNION ALL
           SELECT run_rows.run_id, obligations.invoice_id, obligations.beneficiary_id,
                  obligations.currency, obligations.amount_minor, obligations.transfer_method
             FROM obligations JOIN run_rows ON run_rows.id = obligations.run_row_id
            WHERE obligations.state = 'open'
              AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.invoice_id = obligations.invoice_id)`,
        )
        .all(new Date(now).toISOString()) as unknown as PayRunRecord[]
    ).map((row: PayRunRecord): PayRunRow => ({
      runId: row.run_id,
      invoiceId: row.invoice_id,
      beneficiaryId: row.beneficiary_id,
      currency: row.currency,
      amountMinor: row.amount_minor,
      transferMethod: row.transfer_method,
    }));
  }
}

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SupplierEmail } from "./emails.js";

export const LEDGER_PATH: string = "payonce.db";

const SQLITE_CONSTRAINT_UNIQUE: number = 2067;

// The partial unique index is the duplicate lock: an invoice can hold one attempt
// that is not failed, so a second live payment is refused by the database itself.
const SCHEMA: string = `
  CREATE TABLE IF NOT EXISTS obligations (
    invoice_id TEXT PRIMARY KEY,
    supplier TEXT NOT NULL,
    beneficiary_id TEXT NOT NULL,
    currency TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'open'
  );
  CREATE TABLE IF NOT EXISTS attempts (
    request_id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES obligations(invoice_id),
    kind TEXT NOT NULL,
    transfer_id TEXT,
    state TEXT NOT NULL,
    failure_code TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_live_attempt_per_invoice
    ON attempts(invoice_id) WHERE state <> 'failed';
  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT NOT NULL REFERENCES obligations(invoice_id),
    binding TEXT NOT NULL,
    terms TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'requested',
    approver TEXT
  );
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT NOT NULL REFERENCES obligations(invoice_id),
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_findings (
    invoice_id TEXT PRIMARY KEY REFERENCES obligations(invoice_id),
    findings TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT NOT NULL REFERENCES obligations(invoice_id),
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL
  );
`;

export type ObligationState = "open" | "settled" | "escalated";
export type AttemptKind = "original" | "replacement";
export type AttemptState = "pending" | "in_flight" | "paid" | "failed";
export type ApprovalState = "requested" | "approved" | "used" | "void";
export type EventKind =
  | "payment"
  | "email"
  | "bank"
  | "decision"
  | "approval"
  | "warning"
  | "lock"
  | "closed"
  | "error";

// One line of an incident's timeline.
export interface LedgerEvent {
  id: number;
  at: string;
  kind: EventKind;
  message: string;
}

export type TransferMethod = "LOCAL" | "SWIFT";

export interface NewObligation {
  invoiceId: string;
  supplier: string;
  supplierDomain: string;
  beneficiaryId: string;
  currency: string;
  amountMinor: number;
  transferMethod: TransferMethod;
  reserveFloorMinor: number;
}

export interface Obligation extends NewObligation {
  state: ObligationState;
}

export interface Attempt {
  requestId: string;
  invoiceId: string;
  kind: AttemptKind;
  transferId: string | null;
  state: AttemptState;
  failureCode: string | null;
}

// terms is the JSON shown to the approver, binding is its hash.
export interface Approval {
  id: number;
  invoiceId: string;
  binding: string;
  terms: string;
  state: ApprovalState;
  approver: string | null;
}

interface ApprovalRow {
  id: number;
  invoice_id: string;
  binding: string;
  terms: string;
  state: ApprovalState;
  approver: string | null;
}

interface EmailRow {
  sender: string;
  subject: string;
  body: string;
}

interface FindingsRow {
  findings: string;
}

interface ObligationRow {
  invoice_id: string;
  supplier: string;
  supplier_domain: string;
  beneficiary_id: string;
  currency: string;
  amount_minor: number;
  transfer_method: TransferMethod;
  reserve_floor_minor: number;
  state: ObligationState;
}

interface ColumnRow {
  name: string;
}

// Columns added after the first version of the ledger. A database created
// earlier gets them on open.
const ADDED_OBLIGATION_COLUMNS: Record<string, string> = {
  supplier_domain: "TEXT NOT NULL DEFAULT ''",
  transfer_method: "TEXT NOT NULL DEFAULT 'LOCAL'",
  reserve_floor_minor: "INTEGER NOT NULL DEFAULT 0",
};

interface AttemptRow {
  request_id: string;
  invoice_id: string;
  kind: AttemptKind;
  transfer_id: string | null;
  state: AttemptState;
  failure_code: string | null;
}

export class DuplicatePaymentError extends Error {
  readonly invoiceId: string;

  constructor(invoiceId: string) {
    super(`${invoiceId} already has a live payment`);
    this.name = "DuplicatePaymentError";
    this.invoiceId = invoiceId;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    error.errcode === SQLITE_CONSTRAINT_UNIQUE
  );
}

function toObligation(row: ObligationRow): Obligation {
  return {
    invoiceId: row.invoice_id,
    supplier: row.supplier,
    supplierDomain: row.supplier_domain,
    beneficiaryId: row.beneficiary_id,
    currency: row.currency,
    amountMinor: row.amount_minor,
    transferMethod: row.transfer_method,
    reserveFloorMinor: row.reserve_floor_minor,
    state: row.state,
  };
}

function toAttempt(row: AttemptRow): Attempt {
  return {
    requestId: row.request_id,
    invoiceId: row.invoice_id,
    kind: row.kind,
    transferId: row.transfer_id,
    state: row.state,
    failureCode: row.failure_code,
  };
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    binding: row.binding,
    terms: row.terms,
    state: row.state,
    approver: row.approver,
  };
}

export class Ledger {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    const existing: string[] = (
      this.db.prepare("PRAGMA table_info(obligations)").all() as unknown as ColumnRow[]
    ).map((column: ColumnRow): string => column.name);
    for (const [name, definition] of Object.entries(ADDED_OBLIGATION_COLUMNS)) {
      if (!existing.includes(name)) {
        this.db.exec(`ALTER TABLE obligations ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  openObligation(input: NewObligation): Obligation {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO obligations
           (invoice_id, supplier, supplier_domain, beneficiary_id, currency,
            amount_minor, transfer_method, reserve_floor_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.invoiceId,
        input.supplier,
        input.supplierDomain,
        input.beneficiaryId,
        input.currency,
        input.amountMinor,
        input.transferMethod,
        input.reserveFloorMinor,
      );
    const row: ObligationRow = this.db
      .prepare("SELECT * FROM obligations WHERE invoice_id = ?")
      .get(input.invoiceId) as unknown as ObligationRow;
    return toObligation(row);
  }

  obligation(invoiceId: string): Obligation | undefined {
    const row: ObligationRow | undefined = this.db
      .prepare("SELECT * FROM obligations WHERE invoice_id = ?")
      .get(invoiceId) as unknown as ObligationRow | undefined;
    return row === undefined ? undefined : toObligation(row);
  }

  // Newest first.
  obligations(): Obligation[] {
    const rows: ObligationRow[] = this.db
      .prepare("SELECT * FROM obligations ORDER BY rowid DESC")
      .all() as unknown as ObligationRow[];
    return rows.map(toObligation);
  }

  addEvent(invoiceId: string, kind: EventKind, message: string): void {
    this.db
      .prepare(
        "INSERT INTO events (invoice_id, at, kind, message) VALUES (?, ?, ?, ?)",
      )
      .run(invoiceId, new Date().toISOString(), kind, message);
  }

  events(invoiceId: string): LedgerEvent[] {
    return this.db
      .prepare(
        "SELECT id, at, kind, message FROM events WHERE invoice_id = ? ORDER BY id",
      )
      .all(invoiceId) as unknown as LedgerEvent[];
  }

  openAttempt(invoiceId: string, kind: AttemptKind): Attempt {
    const requestId: string = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO attempts (request_id, invoice_id, kind, state)
           VALUES (?, ?, ?, 'pending')`,
        )
        .run(requestId, invoiceId, kind);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new DuplicatePaymentError(invoiceId);
      }
      throw error;
    }
    return {
      requestId,
      invoiceId,
      kind,
      transferId: null,
      state: "pending",
      failureCode: null,
    };
  }

  attempts(invoiceId: string): Attempt[] {
    const rows: AttemptRow[] = this.db
      .prepare("SELECT * FROM attempts WHERE invoice_id = ? ORDER BY rowid")
      .all(invoiceId) as unknown as AttemptRow[];
    return rows.map(toAttempt);
  }

  // A null state leaves the stored state as it is.
  record(
    requestId: string,
    transferId: string,
    state: AttemptState | null,
    failureCode: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE attempts
            SET transfer_id = ?, state = COALESCE(?, state), failure_code = ?
          WHERE request_id = ?`,
      )
      .run(transferId, state, failureCode, requestId);
  }

  escalate(invoiceId: string): void {
    this.db
      .prepare("UPDATE obligations SET state = 'escalated' WHERE invoice_id = ?")
      .run(invoiceId);
  }

  addEmails(invoiceId: string, emails: SupplierEmail[]): void {
    for (const email of emails) {
      this.db
        .prepare(
          "INSERT INTO emails (invoice_id, sender, subject, body) VALUES (?, ?, ?, ?)",
        )
        .run(invoiceId, email.from, email.subject, email.body);
    }
  }

  emails(invoiceId: string): SupplierEmail[] {
    const rows: EmailRow[] = this.db
      .prepare(
        "SELECT sender, subject, body FROM emails WHERE invoice_id = ? ORDER BY id",
      )
      .all(invoiceId) as unknown as EmailRow[];
    return rows.map(
      (row: EmailRow): SupplierEmail => ({
        from: row.sender,
        subject: row.subject,
        body: row.body,
      }),
    );
  }

  // Findings are stored once per email thread so a later run reads the same
  // result instead of asking the reader again.
  saveFindings(invoiceId: string, findings: string): void {
    this.db
      .prepare(
        `INSERT INTO email_findings (invoice_id, findings) VALUES (?, ?)
         ON CONFLICT(invoice_id) DO UPDATE SET findings = excluded.findings`,
      )
      .run(invoiceId, findings);
  }

  findings(invoiceId: string): string | undefined {
    const row: FindingsRow | undefined = this.db
      .prepare("SELECT findings FROM email_findings WHERE invoice_id = ?")
      .get(invoiceId) as unknown as FindingsRow | undefined;
    return row?.findings;
  }

  // A new request voids any earlier one for the invoice that is still open.
  requestApproval(invoiceId: string, binding: string, terms: string): void {
    this.db
      .prepare(
        `UPDATE approvals SET state = 'void'
          WHERE invoice_id = ? AND state IN ('requested', 'approved')`,
      )
      .run(invoiceId);
    this.db
      .prepare("INSERT INTO approvals (invoice_id, binding, terms) VALUES (?, ?, ?)")
      .run(invoiceId, binding, terms);
  }

  latestApproval(invoiceId: string): Approval | undefined {
    const row: ApprovalRow | undefined = this.db
      .prepare(
        "SELECT * FROM approvals WHERE invoice_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(invoiceId) as unknown as ApprovalRow | undefined;
    return row === undefined ? undefined : toApproval(row);
  }

  setApprovalState(
    id: number,
    state: ApprovalState,
    approver: string | null = null,
  ): void {
    this.db
      .prepare(
        "UPDATE approvals SET state = ?, approver = COALESCE(?, approver) WHERE id = ?",
      )
      .run(state, approver, id);
  }

  // Settles only when one attempt is paid and every other attempt has failed.
  settle(invoiceId: string): boolean {
    const attempts: Attempt[] = this.attempts(invoiceId);
    const paid: number = attempts.filter(
      (attempt: Attempt): boolean => attempt.state === "paid",
    ).length;
    const unresolved: number = attempts.filter(
      (attempt: Attempt): boolean =>
        attempt.state !== "paid" && attempt.state !== "failed",
    ).length;
    if (paid !== 1 || unresolved > 0) {
      return false;
    }
    this.db
      .prepare("UPDATE obligations SET state = 'settled' WHERE invoice_id = ?")
      .run(invoiceId);
    return true;
  }
}

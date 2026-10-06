import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

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
`;

export type ObligationState = "open" | "settled" | "escalated";
export type AttemptKind = "original" | "replacement";
export type AttemptState = "pending" | "in_flight" | "paid" | "failed";

export interface NewObligation {
  invoiceId: string;
  supplier: string;
  beneficiaryId: string;
  currency: string;
  amountMinor: number;
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

interface ObligationRow {
  invoice_id: string;
  supplier: string;
  beneficiary_id: string;
  currency: string;
  amount_minor: number;
  state: ObligationState;
}

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
    beneficiaryId: row.beneficiary_id,
    currency: row.currency,
    amountMinor: row.amount_minor,
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

export class Ledger {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  openObligation(input: NewObligation): Obligation {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO obligations
           (invoice_id, supplier, beneficiary_id, currency, amount_minor)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.invoiceId,
        input.supplier,
        input.beneficiaryId,
        input.currency,
        input.amountMinor,
      );
    const row: ObligationRow = this.db
      .prepare("SELECT * FROM obligations WHERE invoice_id = ?")
      .get(input.invoiceId) as unknown as ObligationRow;
    return toObligation(row);
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

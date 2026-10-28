import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SupplierEmail } from "./emails.js";

export const LEDGER_PATH: string = "payonce.db";

// An invoice number PayOnce accepts. A found payout's reference becomes its
// invoice number only when it fits.
export const INVOICE_ID_PATTERN: RegExp = /^[A-Za-z0-9-]{1,40}$/;

const SQLITE_CONSTRAINT_UNIQUE: number = 2067;
const BUSY_TIMEOUT_MS: number = 5_000;

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
  CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outside_payouts (
    transfer_id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES obligations(invoice_id),
    found_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export type ObligationState = "open" | "settled" | "escalated";
// Who sent the original: PayOnce, or someone outside it, such as a person in the
// Airwallex web app. The sweep finds the second kind.
export type ObligationOrigin = "payonce" | "outside";
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
  // Set on a line that says how things stand. Null on one that records an event.
  topic: string | null;
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
  origin: ObligationOrigin;
  state: ObligationState;
  // Why the invoice last went to a person. Empty if it never has.
  escalationReason: string;
}

export interface Attempt {
  requestId: string;
  invoiceId: string;
  kind: AttemptKind;
  transferId: string | null;
  // The bank's short reference, as shown to people.
  reference: string | null;
  state: AttemptState;
  failureCode: string | null;
}

// What the bank last did with a payout sent outside PayOnce. unknown is a status
// PayOnce does not recognise.
export type PayoutState = "in_flight" | "paid" | "failed" | "unknown";

// A payout sent outside PayOnce whose reference names an invoice in the ledger.
export interface OutsidePayout {
  transferId: string;
  // The bank's short reference.
  reference: string;
  state: PayoutState;
}

// A payout someone sent outside PayOnce, taken on as an invoice's original.
export interface FoundPayout {
  requestId: string;
  transferId: string;
  reference: string;
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
  origin: ObligationOrigin;
  state: ObligationState;
  escalation_reason: string;
}

interface ColumnRow {
  name: string;
}

interface InvoiceRow {
  invoice_id: string;
}

interface MetaRow {
  value: string;
}

interface OutsideRow {
  transfer_id: string;
  reference: string;
  state: PayoutState;
}

// Columns added after the first version of the ledger, by table. A database
// created earlier gets them on open.
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  obligations: {
    supplier_domain: "TEXT NOT NULL DEFAULT ''",
    transfer_method: "TEXT NOT NULL DEFAULT 'LOCAL'",
    reserve_floor_minor: "INTEGER NOT NULL DEFAULT 0",
    escalation_reason: "TEXT NOT NULL DEFAULT ''",
    origin: "TEXT NOT NULL DEFAULT 'payonce'",
    // A found invoice's payout reference, when it could not be the invoice number.
    payout_reference: "TEXT",
    // When the agent next looks at the invoice by itself, as an ISO time.
    look_at: "TEXT",
  },
  attempts: {
    reference: "TEXT",
  },
  events: {
    topic: "TEXT",
  },
  outside_payouts: {
    reference: "TEXT NOT NULL DEFAULT ''",
    state: "TEXT NOT NULL DEFAULT 'in_flight'",
  },
};

interface AttemptRow {
  request_id: string;
  invoice_id: string;
  kind: AttemptKind;
  transfer_id: string | null;
  reference: string | null;
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
    origin: row.origin,
    state: row.state,
    escalationReason: row.escalation_reason,
  };
}

function toAttempt(row: AttemptRow): Attempt {
  return {
    requestId: row.request_id,
    invoiceId: row.invoice_id,
    kind: row.kind,
    transferId: row.transfer_id,
    reference: row.reference,
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
    // The CLI and the web server can have the file open at once, so a write
    // waits for the other instead of failing on the first lock.
    this.db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
    this.db.exec(SCHEMA);
    for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
      const existing: string[] = (
        this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnRow[]
      ).map((column: ColumnRow): string => column.name);
      for (const [name, definition] of Object.entries(columns)) {
        if (!existing.includes(name)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
      }
    }
    this.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('started_at', ?)")
      .run(new Date().toISOString());
  }

  // When this ledger was first opened, as an ISO time. The sweep only looks at
  // payouts made since, so payouts from an earlier ledger are not taken for ones
  // made outside PayOnce.
  startedAt(): string {
    const row: MetaRow = this.db
      .prepare("SELECT value FROM meta WHERE key = 'started_at'")
      .get() as unknown as MetaRow;
    return row.value;
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

  addEvent(
    invoiceId: string,
    kind: EventKind,
    message: string,
    topic: string | null = null,
  ): void {
    this.db
      .prepare(
        "INSERT INTO events (invoice_id, at, kind, message, topic) VALUES (?, ?, ?, ?, ?)",
      )
      .run(invoiceId, new Date().toISOString(), kind, message, topic);
  }

  events(invoiceId: string): LedgerEvent[] {
    return this.db
      .prepare(
        "SELECT id, at, kind, message, topic FROM events WHERE invoice_id = ? ORDER BY id",
      )
      .all(invoiceId) as unknown as LedgerEvent[];
  }

  private insertAttempt(requestId: string, invoiceId: string, kind: AttemptKind): void {
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
  }

  openAttempt(invoiceId: string, kind: AttemptKind): Attempt {
    const requestId: string = randomUUID();
    this.insertAttempt(requestId, invoiceId, kind);
    return {
      requestId,
      invoiceId,
      kind,
      transferId: null,
      reference: null,
      state: "pending",
      failureCode: null,
    };
  }

  // Opens a replacement attempt the way openAttempt does and always rolls it back,
  // so nothing is left for a later look to send. Throws DuplicatePaymentError when
  // the lock refuses it.
  tryLock(invoiceId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insertAttempt(randomUUID(), invoiceId, "replacement");
    } finally {
      this.db.exec("ROLLBACK");
    }
  }

  attempts(invoiceId: string): Attempt[] {
    const rows: AttemptRow[] = this.db
      .prepare("SELECT * FROM attempts WHERE invoice_id = ? ORDER BY rowid")
      .all(invoiceId) as unknown as AttemptRow[];
    return rows.map(toAttempt);
  }

  // The attempt a transfer belongs to. The request_id is PayOnce's own, so it
  // finds the attempt even before the transfer id has been recorded.
  attemptOf(requestId: string, transferId: string): Attempt | undefined {
    const row: AttemptRow | undefined = this.db
      .prepare("SELECT * FROM attempts WHERE request_id = ? OR transfer_id = ? LIMIT 1")
      .get(requestId, transferId) as unknown as AttemptRow | undefined;
    return row === undefined ? undefined : toAttempt(row);
  }

  // Records a payout found in Airwallex as the original of a new invoice. Both
  // rows are written or neither is. The attempt takes the duplicate lock like
  // any other.
  // payoutReference is the payout's own reference when the invoice number had to
  // be something else, so a later payout with that reference is still tied to it.
  adoptPayout(
    input: NewObligation,
    payoutReference: string | null,
    found: FoundPayout,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A plain INSERT, so an invoice written by another process since the sweep
      // checked fails here instead of gaining a second original.
      this.db
        .prepare(
          `INSERT INTO obligations
             (invoice_id, supplier, supplier_domain, beneficiary_id, currency,
              amount_minor, transfer_method, reserve_floor_minor, origin,
              payout_reference)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outside', ?)`,
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
          payoutReference,
        );
      this.db
        .prepare(
          `INSERT INTO attempts
             (request_id, invoice_id, kind, transfer_id, reference, state, failure_code)
           VALUES (?, ?, 'original', ?, ?, ?, ?)`,
        )
        .run(
          found.requestId,
          input.invoiceId,
          found.transferId,
          found.reference,
          found.state,
          found.failureCode,
        );
      this.db.exec("COMMIT");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      if (isUniqueViolation(error)) {
        throw new DuplicatePaymentError(input.invoiceId);
      }
      throw error;
    }
  }

  // The invoice a payout's reference names: its invoice number, or the payout
  // reference a found invoice was recorded with.
  obligationForReference(reference: string): Obligation | undefined {
    if (reference === "") {
      return undefined;
    }
    const row: ObligationRow | undefined = this.db
      .prepare(
        `SELECT * FROM obligations WHERE invoice_id = ? OR payout_reference = ?
          ORDER BY rowid LIMIT 1`,
      )
      .get(reference, reference) as unknown as ObligationRow | undefined;
    return row === undefined ? undefined : toObligation(row);
  }

  // Ties a payout made outside PayOnce to the invoice its reference names. False
  // when it was tied already.
  linkOutsidePayout(invoiceId: string, payout: OutsidePayout): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `INSERT OR IGNORE INTO outside_payouts
           (transfer_id, invoice_id, found_at, reference, state)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        payout.transferId,
        invoiceId,
        new Date().toISOString(),
        payout.reference,
        payout.state,
      );
    return Number(result.changes) === 1;
  }

  outsidePayouts(invoiceId: string): OutsidePayout[] {
    return (
      this.db
        .prepare(
          `SELECT transfer_id, reference, state FROM outside_payouts
            WHERE invoice_id = ? ORDER BY rowid`,
        )
        .all(invoiceId) as unknown as OutsideRow[]
    ).map(
      (row: OutsideRow): OutsidePayout => ({
        transferId: row.transfer_id,
        reference: row.reference,
        state: row.state,
      }),
    );
  }

  recordOutsidePayout(transferId: string, state: PayoutState): void {
    this.db
      .prepare("UPDATE outside_payouts SET state = ? WHERE transfer_id = ?")
      .run(state, transferId);
  }

  // The invoice an outside payout is tied to, if any.
  outsideInvoiceOf(transferId: string): string | undefined {
    const row: InvoiceRow | undefined = this.db
      .prepare("SELECT invoice_id FROM outside_payouts WHERE transfer_id = ?")
      .get(transferId) as unknown as InvoiceRow | undefined;
    return row?.invoice_id;
  }

  // True when the transfer is one of PayOnce's attempts or a payout the sweep has
  // already tied to an invoice.
  knowsTransfer(requestId: string, transferId: string): boolean {
    return (
      this.attemptOf(requestId, transferId) !== undefined ||
      this.db
        .prepare("SELECT 1 FROM outside_payouts WHERE transfer_id = ?")
        .get(transferId) !== undefined
    );
  }

  // Null means the agent waits for news and does not look by itself.
  lookAt(invoiceId: string, at: number | null): void {
    this.db
      .prepare("UPDATE obligations SET look_at = ? WHERE invoice_id = ?")
      .run(at === null ? null : new Date(at).toISOString(), invoiceId);
  }

  // Moves a look that is already due to a later time. For a look that failed, so
  // it is tried again later and not on every check.
  postponeDueLook(invoiceId: string, now: number, until: number): void {
    this.db
      .prepare(
        "UPDATE obligations SET look_at = ? WHERE invoice_id = ? AND look_at <= ?",
      )
      .run(new Date(until).toISOString(), invoiceId, new Date(now).toISOString());
  }

  // Open invoices whose next look is due.
  dueLooks(now: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT invoice_id FROM obligations
            WHERE look_at IS NOT NULL AND look_at <= ? AND state <> 'settled'`,
        )
        .all(new Date(now).toISOString()) as unknown as InvoiceRow[]
    ).map((row: InvoiceRow): string => row.invoice_id);
  }

  // Records a webhook event by its id. False when it has been seen before, since
  // Airwallex may deliver an event more than once.
  firstDelivery(eventId: string, name: string): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        "INSERT OR IGNORE INTO webhook_events (id, name, received_at) VALUES (?, ?, ?)",
      )
      .run(eventId, name, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  // A null state leaves the stored state as it is.
  record(
    requestId: string,
    transferId: string,
    reference: string,
    state: AttemptState | null,
    failureCode: string | null,
  ): void {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE attempts
            SET transfer_id = ?, reference = ?, state = COALESCE(?, state),
                failure_code = ?
          WHERE request_id = ?`,
      )
      .run(transferId, reference, state, failureCode, requestId);
    if (Number(result.changes) !== 1) {
      throw new Error(`No payment attempt has request_id ${requestId}`);
    }
  }

  // For an attempt Airwallex refused to create. It never became a transfer, so
  // it releases the lock.
  failAttempt(requestId: string, failureCode: string | null): void {
    this.db
      .prepare(
        "UPDATE attempts SET state = 'failed', failure_code = ? WHERE request_id = ?",
      )
      .run(failureCode, requestId);
  }

  escalate(invoiceId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE obligations SET state = 'escalated', escalation_reason = ?
          WHERE invoice_id = ?`,
      )
      .run(reason, invoiceId);
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

  // Voids a request or approval for the invoice that is still open. False when
  // there was none.
  voidOpenApprovals(invoiceId: string): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE approvals SET state = 'void'
          WHERE invoice_id = ? AND state IN ('requested', 'approved')`,
      )
      .run(invoiceId);
    return Number(result.changes) > 0;
  }

  // A new request voids any earlier one for the invoice that is still open.
  requestApproval(invoiceId: string, binding: string, terms: string): void {
    this.voidOpenApprovals(invoiceId);
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

  // True when one attempt is paid and every other attempt has failed.
  paidOnce(invoiceId: string): boolean {
    const attempts: Attempt[] = this.attempts(invoiceId);
    const paid: number = attempts.filter(
      (attempt: Attempt): boolean => attempt.state === "paid",
    ).length;
    const unresolved: number = attempts.filter(
      (attempt: Attempt): boolean =>
        attempt.state !== "paid" && attempt.state !== "failed",
    ).length;
    return paid === 1 && unresolved === 0;
  }

  // True when every payment PayOnce sent has failed and the bank reports a payout
  // sent outside PayOnce as paid.
  paidOutside(invoiceId: string): boolean {
    return (
      this.attempts(invoiceId).every((attempt: Attempt): boolean => attempt.state === "failed") &&
      this.outsidePayouts(invoiceId).some(
        (payout: OutsidePayout): boolean => payout.state === "paid",
      )
    );
  }

  // Settles only when the invoice has been paid once by PayOnce or, when a
  // person closes it, by a payout sent outside PayOnce.
  settle(invoiceId: string, byPerson: boolean = false): boolean {
    if (!this.paidOnce(invoiceId) && !(byPerson && this.paidOutside(invoiceId))) {
      return false;
    }
    this.db
      .prepare("UPDATE obligations SET state = 'settled' WHERE invoice_id = ?")
      .run(invoiceId);
    // Nothing is left to approve on a settled invoice.
    this.voidOpenApprovals(invoiceId);
    return true;
  }
}

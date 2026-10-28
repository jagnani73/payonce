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
  CREATE TABLE IF NOT EXISTS signoffs (
    approval_id INTEGER NOT NULL REFERENCES approvals(id),
    approver TEXT NOT NULL,
    binding TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_signoff_per_approver
    ON signoffs(approval_id, approver);
  CREATE TABLE IF NOT EXISTS bank_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT NOT NULL REFERENCES obligations(invoice_id),
    beneficiary_id TEXT NOT NULL,
    called_by TEXT NOT NULL,
    number_called TEXT NOT NULL,
    called_at TEXT NOT NULL,
    spoke_to TEXT NOT NULL,
    confirmed TEXT NOT NULL,
    old_details TEXT NOT NULL,
    new_details TEXT NOT NULL,
    applied_key TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    recorded_at TEXT NOT NULL
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
  | "callback"
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
  // The name the person who started the incident gave. Null when PayOnce does
  // not know, as for a payout sent outside it.
  startedBy: string | null;
  // The supplier's phone number from the supplier record, for calling back about
  // a change of bank details. Null when none is on file.
  supplierPhone: string | null;
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

// One approver's approval of a request, with the binding of the terms they saw.
export interface Signoff {
  approver: string;
  binding: string;
  at: string;
}

// terms is the JSON shown to the approver, binding is its hash. A request is
// approved once it has as many signoffs as it needs. approver names everyone who
// approved it.
export interface Approval {
  id: number;
  invoiceId: string;
  binding: string;
  terms: string;
  state: ApprovalState;
  approver: string | null;
  // ISO times. A request recorded before requests expired has none, and counts
  // as expired.
  requestedAt: string | null;
  expiresAt: string | null;
  needed: number;
  // Why it needs more than one approver. Empty when it needs one.
  neededWhy: string;
  signoffs: Signoff[];
}

// What a new approval request asks for.
export interface ApprovalRequest {
  binding: string;
  terms: string;
  needed: number;
  neededWhy: string;
  expiresAt: number;
}

interface ApprovalRow {
  id: number;
  invoice_id: string;
  binding: string;
  terms: string;
  state: ApprovalState;
  approver: string | null;
  requested_at: string | null;
  expires_at: string | null;
  needed: number;
  needed_why: string;
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
  started_by: string | null;
  supplier_phone: string | null;
}

// A person's callback to the supplier on the number on file, and the bank
// details it confirmed. applied means the supplier's record in Airwallex was
// read back holding them, and appliedKey is that record's bank details as
// bankDetailsKey writes them.
export type BankChangeState = "pending" | "applied" | "failed";

export interface NewBankChange {
  invoiceId: string;
  beneficiaryId: string;
  calledBy: string;
  numberCalled: string;
  calledAt: string;
  spokeTo: string;
  confirmed: string;
  oldDetails: string;
  newDetails: string;
}

export interface BankChange extends NewBankChange {
  id: number;
  appliedKey: string | null;
  state: BankChangeState;
  recordedAt: string;
}

interface BankChangeRow {
  id: number;
  invoice_id: string;
  beneficiary_id: string;
  called_by: string;
  number_called: string;
  called_at: string;
  spoke_to: string;
  confirmed: string;
  old_details: string;
  new_details: string;
  applied_key: string | null;
  state: BankChangeState;
  recorded_at: string;
}

function toBankChange(row: BankChangeRow): BankChange {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    beneficiaryId: row.beneficiary_id,
    calledBy: row.called_by,
    numberCalled: row.number_called,
    calledAt: row.called_at,
    spokeTo: row.spoke_to,
    confirmed: row.confirmed,
    oldDetails: row.old_details,
    newDetails: row.new_details,
    appliedKey: row.applied_key,
    state: row.state,
    recordedAt: row.recorded_at,
  };
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
    started_by: "TEXT",
    supplier_phone: "TEXT",
  },
  approvals: {
    requested_at: "TEXT",
    expires_at: "TEXT",
    needed: "INTEGER NOT NULL DEFAULT 1",
    needed_why: "TEXT NOT NULL DEFAULT ''",
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
    startedBy: row.started_by,
    supplierPhone: row.supplier_phone,
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

function toApproval(row: ApprovalRow, signoffs: Signoff[]): Approval {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    binding: row.binding,
    terms: row.terms,
    state: row.state,
    approver: row.approver,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    needed: row.needed,
    neededWhy: row.needed_why,
    signoffs,
  };
}

// Everyone who approved, as the timeline names them.
export function signersOf(signoffs: Signoff[]): string {
  const names: string[] = signoffs.map((signoff: Signoff): string => signoff.approver);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
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
            amount_minor, transfer_method, reserve_floor_minor, started_by,
            supplier_phone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.startedBy,
        input.supplierPhone,
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
              payout_reference, started_by, supplier_phone)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outside', ?, ?, ?)`,
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
          input.startedBy,
          input.supplierPhone,
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

  // Moves a look that is already due, or was never set, to a later time. For a
  // look that failed, so it is tried again later and not on every check.
  postponeDueLook(invoiceId: string, now: number, until: number): void {
    this.db
      .prepare(
        `UPDATE obligations SET look_at = ?
          WHERE invoice_id = ? AND (look_at IS NULL OR look_at <= ?)`,
      )
      .run(new Date(until).toISOString(), invoiceId, new Date(now).toISOString());
  }

  // True when the agent has a look at the invoice planned for later than now.
  lookPlanned(invoiceId: string, now: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM obligations WHERE invoice_id = ? AND look_at > ?")
        .get(invoiceId, new Date(now).toISOString()) !== undefined
    );
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
  requestApproval(invoiceId: string, request: ApprovalRequest): void {
    this.voidOpenApprovals(invoiceId);
    this.db
      .prepare(
        `INSERT INTO approvals
           (invoice_id, binding, terms, requested_at, expires_at, needed, needed_why)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invoiceId,
        request.binding,
        request.terms,
        new Date().toISOString(),
        new Date(request.expiresAt).toISOString(),
        request.needed,
        request.neededWhy,
      );
  }

  latestApproval(invoiceId: string): Approval | undefined {
    const row: ApprovalRow | undefined = this.db
      .prepare(
        "SELECT * FROM approvals WHERE invoice_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(invoiceId) as unknown as ApprovalRow | undefined;
    return row === undefined ? undefined : toApproval(row, this.signoffs(row.id));
  }

  private signoffs(approvalId: number): Signoff[] {
    return this.db
      .prepare(
        "SELECT approver, binding, at FROM signoffs WHERE approval_id = ? ORDER BY rowid",
      )
      .all(approvalId) as unknown as Signoff[];
  }

  // Records one approver's approval of a request that is still waiting and has
  // not expired, for the binding they were shown. The request becomes approved
  // once it has as many as it needs, and then has useWithinMs to be used, so a
  // request completed just before it expired is not lost to a slow look. Both
  // happen in one transaction, so approvals arriving together from the page and
  // the CLI are each counted once. Returns the request as it now stands.
  signOff(
    approvalId: number,
    approver: string,
    binding: string,
    useWithinMs: number,
  ): Approval {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row: ApprovalRow | undefined = this.db
        .prepare("SELECT * FROM approvals WHERE id = ?")
        .get(approvalId) as unknown as ApprovalRow | undefined;
      if (row === undefined || row.state !== "requested") {
        throw new Error("This approval request is no longer waiting for approval");
      }
      if (row.binding !== binding) {
        throw new Error("These are not the terms of the approval request");
      }
      const expiresAt: number = row.expires_at === null ? 0 : Date.parse(row.expires_at);
      if (!(expiresAt > Date.now())) {
        throw new Error("This approval request has expired. PayOnce opens a new one on its next look");
      }
      try {
        this.db
          .prepare(
            "INSERT INTO signoffs (approval_id, approver, binding, at) VALUES (?, ?, ?, ?)",
          )
          .run(approvalId, approver, binding, new Date().toISOString());
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          throw new Error(`${approver} has approved this already`);
        }
        throw error;
      }
      const signoffs: Signoff[] = this.signoffs(approvalId);
      if (signoffs.length >= row.needed) {
        const useBy: number = Math.max(expiresAt, Date.now() + useWithinMs);
        this.db
          .prepare(
            "UPDATE approvals SET state = 'approved', approver = ?, expires_at = ? WHERE id = ?",
          )
          .run(signersOf(signoffs), new Date(useBy).toISOString(), approvalId);
      }
      this.db.exec("COMMIT");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const row: ApprovalRow = this.db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(approvalId) as unknown as ApprovalRow;
    return toApproval(row, this.signoffs(approvalId));
  }

  // Spends an approval on one payment. False when it is no longer approved, for
  // example because another process voided it in the meantime.
  useApproval(id: number): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare("UPDATE approvals SET state = 'used' WHERE id = ? AND state = 'approved'")
      .run(id);
    return Number(result.changes) === 1;
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

  // Written before the supplier's record is changed, so a change that fails part
  // way is still on file.
  addBankChange(input: NewBankChange): number {
    const result: { lastInsertRowid: number | bigint } = this.db
      .prepare(
        `INSERT INTO bank_changes
           (invoice_id, beneficiary_id, called_by, number_called, called_at, spoke_to,
            confirmed, old_details, new_details, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.invoiceId,
        input.beneficiaryId,
        input.calledBy,
        input.numberCalled,
        input.calledAt,
        input.spokeTo,
        input.confirmed,
        input.oldDetails,
        input.newDetails,
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  finishBankChange(id: number, state: BankChangeState, appliedKey: string | null): void {
    this.db
      .prepare("UPDATE bank_changes SET state = ?, applied_key = ? WHERE id = ?")
      .run(state, appliedKey, id);
  }

  // The latest callback applied to this beneficiary, from any invoice paid to it,
  // when it verified exactly the bank details the record holds now. A record
  // changed since, in PayOnce or outside it, has none, even when it changed back
  // to details an older callback verified.
  verifiedBankChange(beneficiaryId: string, detailsKey: string): BankChange | undefined {
    const row: BankChangeRow | undefined = this.db
      .prepare(
        `SELECT * FROM bank_changes WHERE beneficiary_id = ? AND state = 'applied'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(beneficiaryId) as unknown as BankChangeRow | undefined;
    return row === undefined || row.applied_key !== detailsKey ? undefined : toBankChange(row);
  }

  // Everyone who recorded an applied callback for these details of this
  // beneficiary. None of them may approve a payment to them.
  bankChangeRecorders(beneficiaryId: string, detailsKey: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT called_by FROM bank_changes
            WHERE beneficiary_id = ? AND state = 'applied' AND applied_key = ?`,
        )
        .all(beneficiaryId, detailsKey) as unknown as { called_by: string }[]
    ).map((row: { called_by: string }): string => row.called_by);
  }

  // The applied callback whose record matches an approval's accountKey, keyed by
  // the hash the terms carry.
  appliedKeys(beneficiaryId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT applied_key FROM bank_changes
            WHERE beneficiary_id = ? AND state = 'applied' AND applied_key IS NOT NULL`,
        )
        .all(beneficiaryId) as unknown as { applied_key: string }[]
    ).map((row: { applied_key: string }): string => row.applied_key);
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

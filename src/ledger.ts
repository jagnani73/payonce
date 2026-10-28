import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  eventHash,
  GENESIS,
  nextLedgerHead,
  storable,
  type AuditSnapshot,
  type ChainedEvent,
  type EventFields,
} from "./audit-trail.js";
import type { SupplierEmail } from "./emails.js";

export const LEDGER_PATH: string = "payonce.db";

// An invoice number PayOnce accepts. A found payout's reference becomes its
// invoice number only when it fits.
export const INVOICE_ID_PATTERN: RegExp = /^[A-Za-z0-9-]{1,40}$/;

const SQLITE_CONSTRAINT_UNIQUE: number = 2067;

// An attempt for the invoice bound as the parameter that became a transfer or may
// still become one. An invoice with none has sent nothing.
const SENT_ATTEMPT: string = `SELECT 1 FROM attempts WHERE invoice_id = ?
  AND (transfer_id IS NOT NULL OR state <> 'failed')`;
// A payout for the invoice bound as the parameter, sent outside PayOnce, that is
// in flight, paid or in a status PayOnce does not know.
const LIVE_OUTSIDE_PAYOUT: string = `SELECT 1 FROM outside_payouts WHERE invoice_id = ?
  AND state <> 'failed'`;
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
  CREATE INDEX IF NOT EXISTS events_by_invoice ON events(invoice_id, id);
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

// rejected is an invoice a person closed without paying, because it was a second
// bill for one the ledger already had.
export type ObligationState = "open" | "settled" | "escalated" | "rejected";
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
  // A floor of the invoice's own, stricter than its currency's in RESERVE_FLOORS.
  // 0 for none. Only the low-reserve demo sets one.
  invoiceFloorMinor: number;
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
  // A found invoice's payout reference, when it could not be the invoice number.
  payoutReference: string | null;
  // The invoices this one looked like a second bill for when PayOnce held it
  // before paying. Empty when it was never held as one.
  duplicateOf: string[];
  // Who closed it without paying, if anyone ever did.
  rejectedBy: string | null;
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
  // What the payer paid Airwallex for the transfer, as last read from it. Null
  // until a transfer has been read.
  feeMinor: number | null;
  feeCurrency: string | null;
  // What the transfer took from the wallet, before the fee, as last read from it.
  // Null until a transfer has been read since PayOnce started keeping it.
  amountMinor: number | null;
  currency: string | null;
}

// What the bank last did with a payout sent outside PayOnce. unknown is a status
// PayOnce does not recognise.
export type PayoutState = "in_flight" | "paid" | "failed" | "unknown";

// A payout's amount and fee as last read from the transfer. The amount and
// currency are what it took from the wallet, before the fee: the source amount
// when it was paid from another currency. Null when it has not been read since
// PayOnce started keeping them.
export interface PayoutMoney {
  amountMinor: number | null;
  currency: string | null;
  feeMinor: number | null;
  feeCurrency: string | null;
}

// A payout sent outside PayOnce whose reference names an invoice in the ledger.
export interface OutsidePayout extends PayoutMoney {
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
  feeMinor: number | null;
  feeCurrency: string | null;
  amountMinor: number | null;
  currency: string | null;
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
  invoice_floor_minor: number;
  origin: ObligationOrigin;
  state: ObligationState;
  escalation_reason: string;
  started_by: string | null;
  supplier_phone: string | null;
  payout_reference: string | null;
  duplicate_of: string | null;
  rejected_by: string | null;
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

interface HashRow {
  hash: string | null;
}

interface LedgerRow extends HashRow {
  invoice_id: string;
}

interface EventRow {
  id: number;
  invoice_id: string;
  at: string;
  kind: string;
  message: string;
  topic: string | null;
  prev_hash: string | null;
  hash: string | null;
}

function toChainedEvent(row: EventRow): ChainedEvent {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    at: row.at,
    kind: row.kind,
    message: row.message,
    topic: row.topic,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

// The running hash of every line's hash, so lines removed from the end of a
// timeline, or a whole invoice's lines, are caught.
const LEDGER_HEAD_KEY: string = "events_head";
const CHAIN_STARTED_KEY: string = "chain_started_at";
const BACKFILLED_THROUGH_KEY: string = "chain_backfilled_through";

interface OutsideRow {
  transfer_id: string;
  reference: string;
  state: PayoutState;
  amount_minor: number | null;
  currency: string | null;
  fee_minor: number | null;
  fee_currency: string | null;
}

interface TransferRow {
  transfer_id: string;
}

interface FeeRow {
  fee_minor: number;
}

// Columns added after the first version of the ledger, by table. A database
// created earlier gets them on open.
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  obligations: {
    supplier_domain: "TEXT NOT NULL DEFAULT ''",
    transfer_method: "TEXT NOT NULL DEFAULT 'LOCAL'",
    // The floor each invoice carried before RESERVE_FLOORS. Copied into
    // invoice_floor_minor when that column is added, and otherwise not read or
    // written.
    reserve_floor_minor: "INTEGER NOT NULL DEFAULT 0",
    invoice_floor_minor: "INTEGER NOT NULL DEFAULT 0",
    escalation_reason: "TEXT NOT NULL DEFAULT ''",
    origin: "TEXT NOT NULL DEFAULT 'payonce'",
    // A found invoice's payout reference, when it could not be the invoice number.
    payout_reference: "TEXT",
    // When the agent next looks at the invoice by itself, as an ISO time.
    look_at: "TEXT",
    started_by: "TEXT",
    supplier_phone: "TEXT",
    // A JSON list of invoice numbers, set when the invoice is held as a duplicate.
    duplicate_of: "TEXT",
    rejected_by: "TEXT",
  },
  approvals: {
    requested_at: "TEXT",
    expires_at: "TEXT",
    needed: "INTEGER NOT NULL DEFAULT 1",
    needed_why: "TEXT NOT NULL DEFAULT ''",
  },
  attempts: {
    reference: "TEXT",
    fee_minor: "INTEGER",
    fee_currency: "TEXT",
    // When recordMissingFees last tried to read the fee, as an ISO time.
    fee_tried_at: "TEXT",
    // What the transfer took from the wallet, before the fee, as on outside_payouts.
    amount_minor: "INTEGER",
    currency: "TEXT",
  },
  events: {
    topic: "TEXT",
    // The hash of the invoice's line before this one, and this line's own.
    prev_hash: "TEXT",
    hash: "TEXT",
  },
  outside_payouts: {
    reference: "TEXT NOT NULL DEFAULT ''",
    state: "TEXT NOT NULL DEFAULT 'in_flight'",
    amount_minor: "INTEGER",
    currency: "TEXT",
    fee_minor: "INTEGER",
    fee_currency: "TEXT",
    fee_tried_at: "TEXT",
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
  fee_minor: number | null;
  fee_currency: string | null;
  amount_minor: number | null;
  currency: string | null;
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
    invoiceFloorMinor: row.invoice_floor_minor,
    origin: row.origin,
    state: row.state,
    escalationReason: row.escalation_reason,
    startedBy: row.started_by,
    supplierPhone: row.supplier_phone,
    payoutReference: row.payout_reference,
    duplicateOf: row.duplicate_of === null ? [] : (JSON.parse(row.duplicate_of) as string[]),
    rejectedBy: row.rejected_by,
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
    feeMinor: row.fee_minor,
    feeCurrency: row.fee_currency,
    amountMinor: row.amount_minor,
    currency: row.currency,
  };
}

function toOutsidePayout(row: OutsideRow): OutsidePayout {
  return {
    transferId: row.transfer_id,
    reference: row.reference,
    state: row.state,
    amountMinor: row.amount_minor,
    currency: row.currency,
    feeMinor: row.fee_minor,
    feeCurrency: row.fee_currency,
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

// When a request stops covering a payment, in epoch milliseconds. One recorded
// before requests expired counts as expired already.
export function expiryOf(approval: Approval): number {
  const at: number = approval.expiresAt === null ? Number.NaN : Date.parse(approval.expiresAt);
  return Number.isFinite(at) ? at : 0;
}

export function isExpired(approval: Approval, now: number = Date.now()): boolean {
  return expiryOf(approval) <= now;
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

  // readOnly opens an existing file as it is, without creating or upgrading it,
  // so a check cannot change what it checks.
  constructor(path: string, readOnly: boolean = false) {
    // The CLI and the web server can have the file open at once, so a write
    // waits for the other instead of failing on the first lock.
    this.db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS, readOnly });
    if (readOnly) {
      return;
    }
    this.db.exec(SCHEMA);
    this.addColumns();
    this.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('started_at', ?)")
      .run(new Date().toISOString());
    this.startChain();
  }

  // Under the write lock, so two processes opening an older file at once do not
  // both add a column.
  private addColumns(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
        const existing: string[] = (
          this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnRow[]
        ).map((column: ColumnRow): string => column.name);
        for (const [name, definition] of Object.entries(columns)) {
          if (!existing.includes(name)) {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
            // An invoice from before RESERVE_FLOORS keeps the floor it carried, so
            // none is held to a looser floor than it was.
            if (table === "obligations" && name === "invoice_floor_minor") {
              this.db.exec(
                "UPDATE obligations SET invoice_floor_minor = reserve_floor_minor WHERE reserve_floor_minor <> 0",
              );
            }
          }
        }
      }
      this.db.exec("COMMIT");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // True once the timeline is a hash chain: any record of the chain in meta, or
  // any line with a hash, counts. A file opened read-only from before the chain
  // has no hash column.
  chainStarted(): boolean {
    const hashColumn: boolean = (
      this.db.prepare("PRAGMA table_info(events)").all() as unknown as ColumnRow[]
    ).some((column: ColumnRow): boolean => column.name === "hash");
    return (
      this.metaValue(CHAIN_STARTED_KEY) !== null ||
      this.metaValue(BACKFILLED_THROUGH_KEY) !== null ||
      this.metaValue(LEDGER_HEAD_KEY) !== null ||
      (hashColumn &&
        this.db.prepare("SELECT 1 FROM events WHERE hash IS NOT NULL LIMIT 1").get() !==
          undefined)
    );
  }

  // The first time the ledger is opened with the chain, hashes the lines already
  // there in id order and starts the running hash. A ledger whose chain has
  // started is never hashed again, even if part of its record has gone missing,
  // because hashing again would vouch for whatever the lines now say.
  private startChain(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.chainStarted()) {
        const rows: EventRow[] = this.db
          .prepare("SELECT * FROM events ORDER BY id")
          .all() as unknown as EventRow[];
        const update: StatementSync = this.db.prepare(
          "UPDATE events SET prev_hash = ?, hash = ? WHERE id = ?",
        );
        const heads: Map<string, string> = new Map();
        let ledgerHead: string = GENESIS;
        for (const row of rows) {
          const event: ChainedEvent = toChainedEvent(row);
          const prevHash: string = heads.get(event.invoiceId) ?? GENESIS;
          const hash: string = eventHash(prevHash, event);
          update.run(prevHash, hash, event.id);
          heads.set(event.invoiceId, hash);
          ledgerHead = nextLedgerHead(ledgerHead, hash);
        }
        const insert: StatementSync = this.db.prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?)",
        );
        insert.run(LEDGER_HEAD_KEY, ledgerHead);
        insert.run(CHAIN_STARTED_KEY, new Date().toISOString());
        insert.run(BACKFILLED_THROUGH_KEY, String(rows.at(-1)?.id ?? 0));
      }
      this.db.exec("COMMIT");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private metaValue(key: string): string | null {
    const row: MetaRow | undefined = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as unknown as MetaRow | undefined;
    return row?.value ?? null;
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
            amount_minor, transfer_method, invoice_floor_minor, started_by,
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
        input.invoiceFloorMinor,
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

  // Chains the line to the invoice's last line and adds it to the running hash in
  // one write transaction. The CLI and the server write the same file, and a step
  // on one invoice can write on another's timeline, so the last hash is read
  // under the write lock.
  addEvent(
    invoiceId: string,
    kind: EventKind,
    message: string,
    topic: string | null = null,
  ): void {
    // Hashed as it will read back from the file.
    const invoice: string = storable(invoiceId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last: HashRow | undefined = this.db
        .prepare(
          `SELECT hash FROM events WHERE invoice_id = ? AND hash IS NOT NULL
            ORDER BY id DESC LIMIT 1`,
        )
        .get(invoice) as unknown as HashRow | undefined;
      const prevHash: string = last?.hash ?? GENESIS;
      const line: EventFields = {
        invoiceId: invoice,
        at: new Date().toISOString(),
        kind,
        message: storable(message),
        topic: topic === null ? null : storable(topic),
      };
      const hash: string = eventHash(prevHash, line);
      this.db
        .prepare(
          `INSERT INTO events (invoice_id, at, kind, message, topic, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(line.invoiceId, line.at, line.kind, line.message, line.topic, prevHash, hash);
      // A missing running hash starts again from the genesis, and the audit then
      // reports it as not matching.
      this.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(
          LEDGER_HEAD_KEY,
          nextLedgerHead(this.metaValue(LEDGER_HEAD_KEY) ?? GENESIS, hash),
        );
      this.db.exec("COMMIT");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // What an audit checks, read in one transaction so a line another process adds
  // meanwhile cannot make the running hash look wrong. invoiceId null reads every
  // invoice's lines.
  auditSnapshot(invoiceId: string | null): AuditSnapshot {
    this.db.exec("BEGIN");
    try {
      const rows: EventRow[] = (
        invoiceId === null
          ? this.db.prepare("SELECT * FROM events ORDER BY id").all()
          : this.db.prepare("SELECT * FROM events WHERE invoice_id = ? ORDER BY id").all(invoiceId)
      ) as unknown as EventRow[];
      const all: LedgerRow[] = this.db
        .prepare("SELECT invoice_id, hash FROM events ORDER BY id")
        .all() as unknown as LedgerRow[];
      const snapshot: AuditSnapshot = {
        events: rows.map(toChainedEvent),
        hashes: all.map((row: LedgerRow): string | null => row.hash),
        invoices: new Set(all.map((row: LedgerRow): string => row.invoice_id)).size,
        ledgerHead: this.metaValue(LEDGER_HEAD_KEY),
        chainStartedAt: this.metaValue(CHAIN_STARTED_KEY),
        backfilledThrough: Number(this.metaValue(BACKFILLED_THROUGH_KEY) ?? 0),
      };
      this.db.exec("COMMIT");
      return snapshot;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
      feeMinor: null,
      feeCurrency: null,
      amountMinor: null,
      currency: null,
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
              amount_minor, transfer_method, invoice_floor_minor, origin,
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
          input.invoiceFloorMinor,
          payoutReference,
          input.startedBy,
          input.supplierPhone,
        );
      this.db
        .prepare(
          `INSERT INTO attempts
             (request_id, invoice_id, kind, transfer_id, reference, state, failure_code,
              fee_minor, fee_currency, amount_minor, currency)
           VALUES (?, ?, 'original', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          found.requestId,
          input.invoiceId,
          found.transferId,
          found.reference,
          found.state,
          found.failureCode,
          found.feeMinor,
          found.feeCurrency,
          found.amountMinor,
          found.currency,
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
           (transfer_id, invoice_id, found_at, reference, state, amount_minor, currency,
            fee_minor, fee_currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        payout.transferId,
        invoiceId,
        new Date().toISOString(),
        payout.reference,
        payout.state,
        payout.amountMinor,
        payout.currency,
        payout.feeMinor,
        payout.feeCurrency,
      );
    return Number(result.changes) === 1;
  }

  outsidePayouts(invoiceId: string): OutsidePayout[] {
    return (
      this.db
        .prepare(
          `SELECT transfer_id, reference, state, amount_minor, currency, fee_minor, fee_currency
             FROM outside_payouts WHERE invoice_id = ? ORDER BY rowid`,
        )
        .all(invoiceId) as unknown as OutsideRow[]
    ).map(toOutsidePayout);
  }

  // A value that could not be read keeps the one already on file.
  recordOutsidePayout(transferId: string, state: PayoutState, money: PayoutMoney): void {
    this.db
      .prepare(
        `UPDATE outside_payouts
            SET state = ?, amount_minor = COALESCE(?, amount_minor),
                currency = COALESCE(?, currency), fee_minor = COALESCE(?, fee_minor),
                fee_currency = COALESCE(?, fee_currency)
          WHERE transfer_id = ?`,
      )
      .run(
        state,
        money.amountMinor,
        money.currency,
        money.feeMinor,
        money.feeCurrency,
        transferId,
      );
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
            WHERE look_at IS NOT NULL AND look_at <= ?
              AND state NOT IN ('settled', 'rejected')`,
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

  // A null state leaves the stored state as it is, and a null fee or amount the
  // stored one.
  record(
    requestId: string,
    transferId: string,
    reference: string,
    state: AttemptState | null,
    failureCode: string | null,
    feeMinor: number | null,
    feeCurrency: string | null,
    amountMinor: number | null,
    currency: string | null,
  ): void {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE attempts
            SET transfer_id = ?, reference = ?, state = COALESCE(?, state),
                failure_code = ?, fee_minor = COALESCE(?, fee_minor),
                fee_currency = COALESCE(?, fee_currency),
                amount_minor = COALESCE(?, amount_minor), currency = COALESCE(?, currency)
          WHERE request_id = ?`,
      )
      .run(
        transferId,
        reference,
        state,
        failureCode,
        feeMinor,
        feeCurrency,
        amountMinor,
        currency,
        requestId,
      );
    if (Number(result.changes) !== 1) {
      throw new Error(`No payment attempt has request_id ${requestId}`);
    }
  }

  // Failed transfers, PayOnce's and payouts sent outside it, whose fee has not
  // been recorded, such as those failed before fees were kept. Only those never
  // tried, or last tried at triedBefore or earlier, and the least recently tried
  // first, so a transfer that cannot be read does not keep the others waiting.
  failedWithoutFee(limit: number, triedBefore: number): string[] {
    const before: string = new Date(triedBefore).toISOString();
    return (
      this.db
        .prepare(
          `SELECT transfer_id, fee_tried_at FROM attempts
            WHERE state = 'failed' AND transfer_id IS NOT NULL AND fee_minor IS NULL
              AND (fee_tried_at IS NULL OR fee_tried_at <= ?)
           UNION
           SELECT transfer_id, fee_tried_at FROM outside_payouts
            WHERE state = 'failed' AND fee_minor IS NULL
              AND (fee_tried_at IS NULL OR fee_tried_at <= ?)
           ORDER BY fee_tried_at, transfer_id
           LIMIT ?`,
        )
        .all(before, before, limit) as unknown as TransferRow[]
    ).map((row: TransferRow): string => row.transfer_id);
  }

  // Notes that the fee of a transfer is being read, so it goes to the back of
  // failedWithoutFee's list whether or not the read works.
  feeTried(transferId: string, at: number): void {
    for (const table of ["attempts", "outside_payouts"]) {
      this.db
        .prepare(`UPDATE ${table} SET fee_tried_at = ? WHERE transfer_id = ?`)
        .run(new Date(at).toISOString(), transferId);
    }
  }

  // Writes only the fee of a transfer that has none on file, so it never changes
  // what a look decides on and is safe outside the invoice's turn.
  recordFee(transferId: string, feeMinor: number, feeCurrency: string): void {
    for (const table of ["attempts", "outside_payouts"]) {
      this.db
        .prepare(
          `UPDATE ${table} SET fee_minor = ?, fee_currency = ?
            WHERE transfer_id = ? AND fee_minor IS NULL`,
        )
        .run(feeMinor, feeCurrency, transferId);
    }
  }

  // The fee most recently recorded for a payment in this currency by this
  // transfer method, or null when the ledger has none.
  latestFee(currency: string, method: TransferMethod): number | null {
    const row: FeeRow | undefined = this.db
      .prepare(
        `SELECT attempts.fee_minor FROM attempts
           JOIN obligations ON obligations.invoice_id = attempts.invoice_id
          WHERE attempts.fee_minor IS NOT NULL AND attempts.fee_currency = ?
            AND obligations.transfer_method = ?
          ORDER BY attempts.rowid DESC LIMIT 1`,
      )
      .get(currency, method) as unknown as FeeRow | undefined;
    return row?.fee_minor ?? null;
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

  // Holds an invoice for a person before anything is paid. duplicateOf lists the
  // invoices it looks like a second bill for, and is empty when it is held for
  // another reason.
  holdBeforePaying(invoiceId: string, duplicateOf: string[], reason: string): void {
    this.db
      .prepare(
        `UPDATE obligations SET state = 'escalated', escalation_reason = ?, duplicate_of = ?
          WHERE invoice_id = ?`,
      )
      .run(reason, JSON.stringify(duplicateOf), invoiceId);
  }

  // Spends the approval to pay a held invoice, hands the invoice back to the
  // agent and opens its original's attempt, in one transaction, so a crash or a
  // failed write cannot leave it open with nothing sent. Undefined, with nothing
  // changed, when the approval is no longer approved or has expired, or the
  // invoice is no longer held: a person closed it, it has sent something, or a
  // payout for it sent outside PayOnce is live.
  releaseFor(invoiceId: string, approvalId: number): Attempt | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE approvals SET state = 'used'
            WHERE id = ? AND invoice_id = ? AND state = 'approved' AND expires_at > ?`,
        )
        .run(approvalId, invoiceId, new Date().toISOString());
      const released: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE obligations SET state = 'open'
            WHERE invoice_id = ? AND state = 'escalated' AND rejected_by IS NULL
              AND NOT EXISTS (${SENT_ATTEMPT}) AND NOT EXISTS (${LIVE_OUTSIDE_PAYOUT})`,
        )
        .run(invoiceId, invoiceId, invoiceId);
      if (Number(used.changes) !== 1 || Number(released.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const attempt: Attempt = this.openAttempt(invoiceId, "original");
      this.db.exec("COMMIT");
      return attempt;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // The invoices a held invoice looks like a second bill for, as they are now.
  setDuplicateOf(invoiceId: string, duplicateOf: string[]): void {
    this.db
      .prepare("UPDATE obligations SET duplicate_of = ? WHERE invoice_id = ?")
      .run(JSON.stringify(duplicateOf), invoiceId);
  }

  // Closes a held invoice without paying it, recording who did. False when it is
  // no longer held, for example because its payment was released in the meantime,
  // or a payout for it sent outside PayOnce is in flight or paid.
  reject(invoiceId: string, rejectedBy: string): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE obligations SET state = 'rejected', rejected_by = ?
          WHERE invoice_id = ? AND state = 'escalated'
            AND NOT EXISTS (${SENT_ATTEMPT}) AND NOT EXISTS (${LIVE_OUTSIDE_PAYOUT})`,
      )
      .run(rejectedBy, invoiceId, invoiceId, invoiceId);
    if (Number(result.changes) !== 1) {
      return false;
    }
    this.voidOpenApprovals(invoiceId);
    return true;
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

  // A new request voids any earlier one for the invoice that is still open. Only
  // an invoice with a person gets one, so a request cannot land on an invoice
  // another process has just closed. False when none was opened.
  requestApproval(invoiceId: string, request: ApprovalRequest): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.voidOpenApprovals(invoiceId);
      const result: { changes: number | bigint } = this.db
        .prepare(
          `INSERT INTO approvals
             (invoice_id, binding, terms, requested_at, expires_at, needed, needed_why)
           SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM obligations WHERE invoice_id = ? AND state = 'escalated')`,
        )
        .run(
          invoiceId,
          request.binding,
          request.terms,
          new Date().toISOString(),
          new Date(request.expiresAt).toISOString(),
          request.needed,
          request.neededWhy,
          invoiceId,
        );
      this.db.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
        // The next look is due now, so a watcher in another process uses the
        // approval on its next check and not when the look it had planned comes.
        this.db
          .prepare("UPDATE obligations SET look_at = ? WHERE invoice_id = ?")
          .run(new Date().toISOString(), row.invoice_id);
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

  // Spends an approval on one replacement and opens its attempt, in one
  // transaction, so the money is counted as approved or as being sent at every
  // moment and never as neither. Undefined, with nothing changed, when it is no
  // longer approved, for example because another process voided it in the
  // meantime, or when it has expired since the look checked it. Also when the
  // invoice is no longer escalated, as when a person closed it, or a payout for
  // it sent outside PayOnce is live.
  useApproval(invoiceId: string, approvalId: number): Attempt | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE approvals SET state = 'used'
            WHERE id = ? AND invoice_id = ? AND state = 'approved' AND expires_at > ?
              AND EXISTS (SELECT 1 FROM obligations WHERE invoice_id = ? AND state = 'escalated')
              AND NOT EXISTS (${LIVE_OUTSIDE_PAYOUT})`,
        )
        .run(approvalId, invoiceId, new Date().toISOString(), invoiceId, invoiceId);
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const attempt: Attempt = this.openAttempt(invoiceId, "replacement");
      this.db.exec("COMMIT");
      return attempt;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

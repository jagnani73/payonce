import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  eventHash,
  GENESIS,
  nextLedgerHead,
  runEventHash,
  storable,
  type AuditSnapshot,
  type ChainedEvent,
  type ChainedRunEvent,
  type EventFields,
  type RunAuditSnapshot,
  type RunEventFields,
} from "./audit-trail.js";
import type { ApprovalTerms, FxTerms } from "./approval.js";
import type { SupplierEmail } from "./emails.js";

export const LEDGER_PATH: string = "payonce.db";

// An invoice number PayOnce accepts. A found payout's reference becomes its
// invoice number only when it fits.
export const INVOICE_ID_PATTERN: RegExp = /^[A-Za-z0-9-]{1,40}$/;

const SQLITE_CONSTRAINT_UNIQUE: number = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY: number = 1555;

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
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    columns TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'waiting',
    checked_at TEXT NOT NULL,
    cash TEXT NOT NULL DEFAULT '[]',
    released_at TEXT,
    cancelled_by TEXT,
    cancel_note TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_waiting_run ON runs(state) WHERE state = 'waiting';
  CREATE UNIQUE INDEX IF NOT EXISTS one_live_run_per_file
    ON runs(file_hash) WHERE state <> 'cancelled';
  CREATE TABLE IF NOT EXISTS run_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    line INTEGER NOT NULL,
    cells TEXT NOT NULL,
    invoice_id TEXT,
    supplier TEXT,
    beneficiary_id TEXT,
    currency TEXT,
    amount_minor INTEGER,
    transfer_method TEXT,
    sandbox_outcome TEXT NOT NULL,
    action TEXT NOT NULL,
    reasons TEXT NOT NULL DEFAULT '[]',
    held_for TEXT NOT NULL DEFAULT '[]',
    new_payee INTEGER NOT NULL DEFAULT 0,
    bank_change_id INTEGER,
    payee TEXT,
    pay_to TEXT,
    account_key TEXT,
    state TEXT NOT NULL DEFAULT 'waiting',
    note TEXT,
    UNIQUE (run_id, line)
  );
  CREATE TABLE IF NOT EXISTS run_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    binding TEXT NOT NULL,
    terms TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'requested',
    approver TEXT,
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    needed INTEGER NOT NULL DEFAULT 1,
    needed_why TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS run_signoffs (
    approval_id INTEGER NOT NULL REFERENCES run_approvals(id),
    approver TEXT NOT NULL,
    binding TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_run_signoff_per_approver
    ON run_signoffs(approval_id, approver);
  CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    topic TEXT
  );
  CREATE INDEX IF NOT EXISTS run_events_by_run ON run_events(run_id, id);
  CREATE TABLE IF NOT EXISTS currency_locks (
    currency TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS currency_lock_waiters (
    currency TEXT NOT NULL,
    holder TEXT NOT NULL,
    since TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (currency, holder)
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
  // A floor of the invoice's own, stricter than its currency's in RESERVE_FLOORS,
  // in the currency of the wallet it is paid from. 0 for none. Only the
  // low-reserve demo sets one.
  invoiceFloorMinor: number;
  // The name the person who started the incident gave. Null when PayOnce does
  // not know, as for a payout sent outside it.
  startedBy: string | null;
  // The supplier's phone number from the supplier record, for calling back about
  // a change of bank details. Null when none is on file.
  supplierPhone: string | null;
  // The wallet the invoice is paid from, when not its own currency's.
  sourceCurrency?: string;
}

export interface Obligation extends NewObligation {
  // The invoice's own currency when it is not paid from another wallet.
  sourceCurrency: string;
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
  // The pay run row it was released from. Null for any other invoice.
  runRowId: number | null;
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
  // What the transfer took from the wallet, before the fee, as last read from it:
  // the source amount in the source currency for a payment from another
  // currency's wallet. Null until a transfer has been read since PayOnce started
  // keeping it.
  amountMinor: number | null;
  currency: string | null;
  // The quote a payment from another currency's wallet is sent with, and when it
  // runs out as Airwallex wrote it. Null on any other payment.
  quoteId: string | null;
  quoteValidTo: string | null;
  // The approval the attempt was opened on. Null on a payment no approval
  // released, and on one from before the column.
  approvalId: number | null;
  // Why the transfer did not go out on its approved quote. Null when it did, or
  // has not been checked. Only a person closes an invoice with one.
  rateMismatch: string | null;
}

// The quote an attempt is sent with, from the terms of the approval it was opened
// on. Written with the attempt, before Airwallex is called, so a retry sends the
// same one.
export interface AttemptQuote {
  quoteId: string;
  validTo: string;
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
  run_row_id: number | null;
  source_currency: string | null;
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

interface RunEventRow {
  id: number;
  run_id: number;
  at: string;
  kind: string;
  message: string;
  topic: string | null;
  prev_hash: string | null;
  hash: string | null;
}

interface RunHashRow extends HashRow {
  run_id: number;
}

function toChainedRunEvent(row: RunEventRow): ChainedRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    at: row.at,
    kind: row.kind,
    message: row.message,
    topic: row.topic,
    prevHash: row.prev_hash ?? null,
    hash: row.hash ?? null,
  };
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
// The same for pay run timelines, which are chained apart from invoice timelines.
const RUN_HEAD_KEY: string = "run_events_head";
const RUN_CHAIN_STARTED_KEY: string = "run_chain_started_at";
const RUN_BACKFILLED_THROUGH_KEY: string = "run_chain_backfilled_through";

// A waiter for a currency lock that has not asked again for this long has gone,
// for example because its process stopped, and loses its place. It asks every
// 200 ms, and a write can wait up to BUSY_TIMEOUT_MS for another process.
const WAITER_GONE_MS: number = 10_000;

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
    run_row_id: "INTEGER",
    // The wallet the invoice is paid from. Null is its own currency's.
    source_currency: "TEXT",
    // The latest exchange rate quote taken for it, as JSON.
    last_quote: "TEXT",
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
    // 1 when the transfer went to other bank details than the ones it was
    // approved or decided for, so it never counts as the account PayOnce last paid.
    misdirected: "INTEGER NOT NULL DEFAULT 0",
    // When recordMissingFees last tried to read the fee, as an ISO time.
    fee_tried_at: "TEXT",
    // What the transfer took from the wallet, before the fee, as on outside_payouts.
    amount_minor: "INTEGER",
    currency: "TEXT",
    quote_id: "TEXT",
    quote_valid_to: "TEXT",
    approval_id: "INTEGER",
    rate_mismatch: "TEXT",
  },
  events: {
    topic: "TEXT",
    // The hash of the invoice's line before this one, and this line's own.
    prev_hash: "TEXT",
    hash: "TEXT",
  },
  run_events: {
    // The hash of the run's line before this one, and this line's own.
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
  quote_id: string | null;
  quote_valid_to: string | null;
  approval_id: number | null;
  rate_mismatch: string | null;
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

// An invoice number is the primary key of obligations, and SQLite reports a
// second one with its own code.
function isPrimaryKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    error.errcode === SQLITE_CONSTRAINT_PRIMARYKEY
  );
}

function toObligation(row: ObligationRow): Obligation {
  return {
    invoiceId: row.invoice_id,
    supplier: row.supplier,
    supplierDomain: row.supplier_domain,
    beneficiaryId: row.beneficiary_id,
    currency: row.currency,
    sourceCurrency: row.source_currency ?? row.currency,
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
    runRowId: row.run_row_id,
  };
}

// True when the invoice is paid from another currency's wallet, so each payment
// converts on a quote a person approved.
export function crossCurrency(obligation: Obligation): boolean {
  return obligation.sourceCurrency !== obligation.currency;
}

// Null when the invoice is paid from its own currency, as the column keeps it.
function sourceColumn(input: NewObligation): string | null {
  return input.sourceCurrency === undefined || input.sourceCurrency === input.currency
    ? null
    : input.sourceCurrency;
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
    quoteId: row.quote_id,
    quoteValidTo: row.quote_valid_to,
    approvalId: row.approval_id,
    rateMismatch: row.rate_mismatch,
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
// before requests expired counts as expired already. Works for invoice and run
// requests alike.
export function expiryOf(approval: { expiresAt: string | null }): number {
  const at: number = approval.expiresAt === null ? Number.NaN : Date.parse(approval.expiresAt);
  return Number.isFinite(at) ? at : 0;
}

export function isExpired(approval: { expiresAt: string | null }, now: number = Date.now()): boolean {
  return expiryOf(approval) <= now;
}

// Everyone who approved, as the timeline names them.
export function signersOf(signoffs: Signoff[]): string {
  const names: string[] = signoffs.map((signoff: Signoff): string => signoff.approver);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// The message for an invoice number the ledger already has.
export function alreadyInLedger(invoiceId: string): string {
  return `${invoiceId} is already in the ledger, and PayOnce pays an invoice number once`;
}

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
  // The account name on the beneficiary record. The invoice is recorded under it.
  payee: string | null;
  payTo: string | null;
  accountKey: string | null;
}

export interface RunRow extends CheckedRow {
  id: number;
  runId: number;
  state: RunRowState;
  // Why a dropped row was not released.
  note: string | null;
}

// A request to approve a run, shaped like an invoice's.
export interface RunApproval {
  id: number;
  runId: number;
  binding: string;
  terms: string;
  state: ApprovalState;
  approver: string | null;
  requestedAt: string;
  expiresAt: string;
  needed: number;
  neededWhy: string;
  signoffs: Signoff[];
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
  // The invoice's first timeline line, chained like any other.
  firstLine: string;
}

// A currency lock held for one payment or one release. The ledger opens an
// attempt, or releases a run, only while the lock is still held.
export interface Lease {
  currency: string;
  holder: string;
}

// The lease ran out before the step that needed it, and someone else may hold
// the lock now, so nothing was written.
export class LeaseLostError extends Error {
  constructor(currency: string) {
    super(
      `The ${currency} lock ran out before the payment was recorded, so PayOnce sent nothing. It tries again in a minute`,
    );
    this.name = "LeaseLostError";
  }
}

// A pay row with the fields a skipped row keeps: the reasons, and no hold, new
// payee or callback, since those only matter for a row that pays.
export function skipRow(row: CheckedRow, reasons: string[]): CheckedRow {
  return { ...row, action: "skip", reasons, heldFor: [], newPayee: false, bankChangeId: null };
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
  state: RunRowState;
  note: string | null;
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

interface RunApprovalRow {
  id: number;
  run_id: number;
  binding: string;
  terms: string;
  state: ApprovalState;
  approver: string | null;
  requested_at: string;
  expires_at: string;
  needed: number;
  needed_why: string;
}

function toRun(row: RunRecord): Run {
  return {
    id: row.id,
    fileName: row.file_name,
    fileHash: row.file_hash,
    columns: JSON.parse(row.columns) as string[],
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
    cells: JSON.parse(row.cells) as string[],
    invoiceId: row.invoice_id,
    supplier: row.supplier,
    beneficiaryId: row.beneficiary_id,
    currency: row.currency,
    amountMinor: row.amount_minor,
    transferMethod: row.transfer_method,
    sandboxOutcome: row.sandbox_outcome,
    action: row.action,
    reasons: JSON.parse(row.reasons) as string[],
    heldFor: JSON.parse(row.held_for) as string[],
    newPayee: row.new_payee === 1,
    bankChangeId: row.bank_change_id,
    payee: row.payee,
    payTo: row.pay_to,
    accountKey: row.account_key,
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
    this.startRunChain();
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

  // True once pay run timelines are a hash chain, read the way chainStarted reads
  // invoice timelines. A file opened read-only from before pay runs has no
  // run_events table, and one from before this chain has no hash column.
  runChainStarted(): boolean {
    const hashColumn: boolean = (
      this.db.prepare("PRAGMA table_info(run_events)").all() as unknown as ColumnRow[]
    ).some((column: ColumnRow): boolean => column.name === "hash");
    return (
      this.metaValue(RUN_CHAIN_STARTED_KEY) !== null ||
      this.metaValue(RUN_BACKFILLED_THROUGH_KEY) !== null ||
      this.metaValue(RUN_HEAD_KEY) !== null ||
      (hashColumn &&
        this.db.prepare("SELECT 1 FROM run_events WHERE hash IS NOT NULL LIMIT 1").get() !==
          undefined)
    );
  }

  // False for a file opened read-only from before pay runs, which has no runs table.
  hasRunTable(): boolean {
    return (this.db.prepare("PRAGMA table_info(runs)").all() as unknown as ColumnRow[]).length > 0;
  }

  // True when the file has a run_events table with any line in it.
  hasRunLines(): boolean {
    const table: boolean =
      (this.db.prepare("PRAGMA table_info(run_events)").all() as unknown as ColumnRow[]).length > 0;
    return table && this.db.prepare("SELECT 1 FROM run_events LIMIT 1").get() !== undefined;
  }

  // Starts the chain of pay run timelines the way startChain starts the invoices':
  // the lines already there are hashed once, in id order, and never again.
  private startRunChain(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.runChainStarted()) {
        const rows: RunEventRow[] = this.db
          .prepare("SELECT * FROM run_events ORDER BY id")
          .all() as unknown as RunEventRow[];
        const update: StatementSync = this.db.prepare(
          "UPDATE run_events SET prev_hash = ?, hash = ? WHERE id = ?",
        );
        const heads: Map<number, string> = new Map();
        let runHead: string = GENESIS;
        for (const row of rows) {
          const event: ChainedRunEvent = toChainedRunEvent(row);
          const prevHash: string = heads.get(event.runId) ?? GENESIS;
          const hash: string = runEventHash(prevHash, event);
          update.run(prevHash, hash, event.id);
          heads.set(event.runId, hash);
          runHead = nextLedgerHead(runHead, hash);
        }
        const insert: StatementSync = this.db.prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?)",
        );
        insert.run(RUN_HEAD_KEY, runHead);
        insert.run(RUN_CHAIN_STARTED_KEY, new Date().toISOString());
        insert.run(RUN_BACKFILLED_THROUGH_KEY, String(rows.at(-1)?.id ?? 0));
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
            supplier_phone, source_currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        sourceColumn(input),
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
    this.transaction((): void => {
      this.appendEvent(invoiceId, kind, message, topic);
    });
  }

  // Runs fn in one write transaction and commits it, or rolls it all back if fn
  // throws. Steps that open a transaction of their own cannot run inside one, so
  // a nested call throws instead of failing part way.
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) {
      throw new Error("A ledger transaction is already open");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result: T = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Chains one line to the invoice's timeline. The caller holds the write
  // transaction.
  private appendEvent(
    invoiceId: string,
    kind: EventKind,
    message: string,
    topic: string | null,
  ): void {
    // Hashed as it will read back from the file.
    const invoice: string = storable(invoiceId);
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

  private insertAttempt(
    requestId: string,
    invoiceId: string,
    kind: AttemptKind,
    approvalId: number | null,
    quote: AttemptQuote | null,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO attempts
             (request_id, invoice_id, kind, state, quote_id, quote_valid_to, approval_id)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          requestId,
          invoiceId,
          kind,
          quote?.quoteId ?? null,
          quote?.validTo ?? null,
          approvalId,
        );
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new DuplicatePaymentError(invoiceId);
      }
      throw error;
    }
  }

  // Throws LeaseLostError unless lease still holds its currency's lock. Run
  // inside the write transaction that writes what the lock guards, so the lock
  // cannot be lost between the check and the write.
  private requireLease(lease: Lease): void {
    const held: unknown = this.db
      .prepare(
        "SELECT 1 FROM currency_locks WHERE currency = ? AND holder = ? AND expires_at > ?",
      )
      .get(lease.currency, lease.holder, new Date().toISOString());
    if (held === undefined) {
      throw new LeaseLostError(lease.currency);
    }
  }

  // Opens a payment's attempt, which counts its money as committed. Only inside a
  // write transaction, and only while lease holds the lock of the wallet the
  // payment leaves, so a holder that lost its lease, or holds another wallet's
  // lock, opens nothing. approvalId is the approval that released the payment:
  // the attempt keeps it, and a payment from another currency's wallet keeps the
  // quote in its terms, so a retry sends the same one. Such a payment is opened
  // only on an approval with a quote.
  openAttempt(
    invoiceId: string,
    kind: AttemptKind,
    lease: Lease,
    approvalId: number | null = null,
  ): Attempt {
    if (!this.db.isTransaction) {
      throw new Error("An attempt is opened only inside a ledger transaction");
    }
    this.requireLease(lease);
    const obligation: Obligation | undefined = this.obligation(invoiceId);
    if (obligation !== undefined && lease.currency !== obligation.sourceCurrency) {
      throw new Error(
        `${invoiceId} is paid from ${obligation.sourceCurrency}, and its payment was about to be opened under the ${lease.currency} lock`,
      );
    }
    const quote: AttemptQuote | null = approvalId === null ? null : this.approvedQuote(approvalId);
    if (obligation !== undefined && crossCurrency(obligation) && quote === null) {
      throw new Error(
        `${invoiceId} is paid from ${obligation.sourceCurrency}, so PayOnce pays it only on an approved exchange rate quote. Nothing was sent`,
      );
    }
    const requestId: string = randomUUID();
    this.insertAttempt(requestId, invoiceId, kind, approvalId, quote);
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
      quoteId: quote?.quoteId ?? null,
      quoteValidTo: quote?.validTo ?? null,
      approvalId,
      rateMismatch: null,
    };
  }

  // The quote in an approval's terms, for a payment from another currency's
  // wallet. Null when its terms carry none.
  private approvedQuote(approvalId: number): AttemptQuote | null {
    const row: { terms: string } | undefined = this.db
      .prepare("SELECT terms FROM approvals WHERE id = ?")
      .get(approvalId) as unknown as { terms: string } | undefined;
    const fx: FxTerms | undefined =
      row === undefined ? undefined : (JSON.parse(row.terms) as ApprovalTerms).fx;
    return fx === undefined ? null : { quoteId: fx.quoteId, validTo: fx.validTo };
  }

  // Opens a replacement attempt the way openAttempt does and always rolls it back,
  // so nothing is left for a later look to send. Throws DuplicatePaymentError when
  // the lock refuses it.
  tryLock(invoiceId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insertAttempt(randomUUID(), invoiceId, "replacement", null, null);
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
              payout_reference, started_by, supplier_phone, source_currency)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outside', ?, ?, ?, ?)`,
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
          sourceColumn(input),
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

  // For a transfer that did not go out on its approved quote.
  markRateMismatch(requestId: string, reason: string): void {
    this.db
      .prepare("UPDATE attempts SET rate_mismatch = ? WHERE request_id = ?")
      .run(reason, requestId);
  }

  // For an attempt Airwallex refused to create. It never became a transfer, so
  // it releases the lock. One a look has since found a transfer for is kept.
  failAttempt(requestId: string, failureCode: string | null): void {
    this.db
      .prepare(
        `UPDATE attempts SET state = 'failed', failure_code = ?
          WHERE request_id = ? AND state = 'pending' AND transfer_id IS NULL`,
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
  // payout for it sent outside PayOnce is live. Also when unchanged, run under
  // the write lock, returns false. The attempt keeps the approval, and the quote
  // in its terms for a payment from another currency's wallet.
  releaseFor(
    invoiceId: string,
    approvalId: number,
    lease: Lease,
    unchanged: () => boolean,
  ): Attempt | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!unchanged()) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
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
      const attempt: Attempt = this.openAttempt(invoiceId, "original", lease, approvalId);
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

  // The latest exchange rate quote taken for an invoice paid from another
  // currency's wallet, as JSON, whether or not a request opened on it.
  saveQuote(invoiceId: string, quote: string): void {
    this.db
      .prepare("UPDATE obligations SET last_quote = ? WHERE invoice_id = ?")
      .run(quote, invoiceId);
  }

  lastQuote(invoiceId: string): string | undefined {
    const row: { last_quote: string | null } | undefined = this.db
      .prepare("SELECT last_quote FROM obligations WHERE invoice_id = ?")
      .get(invoiceId) as unknown as { last_quote: string | null } | undefined;
    return row?.last_quote ?? undefined;
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

  approval(id: number): Approval | undefined {
    const row: ApprovalRow | undefined = this.db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(id) as unknown as ApprovalRow | undefined;
    return row === undefined ? undefined : toApproval(row, this.signoffs(row.id));
  }

  // The approval an attempt was opened on. An attempt no approval released, or one
  // from before the column, has the latest.
  approvalOf(attempt: Attempt): Approval | undefined {
    return attempt.approvalId === null
      ? this.latestApproval(attempt.invoiceId)
      : this.approval(attempt.approvalId);
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
  // it sent outside PayOnce is live. Also when unchanged, run under the write
  // lock, returns false. The attempt keeps the approval, and the quote in its
  // terms for a payment from another currency's wallet.
  useApproval(
    invoiceId: string,
    approvalId: number,
    lease: Lease,
    unchanged: () => boolean,
  ): Attempt | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!unchanged()) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
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
      const attempt: Attempt = this.openAttempt(invoiceId, "replacement", lease, approvalId);
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
  // person closes it, by a payout sent outside PayOnce. A payment that went out
  // at a rate nobody approved leaves the invoice for a person to close, unless it
  // failed.
  settle(invoiceId: string, byPerson: boolean = false): boolean {
    if (!this.paidOnce(invoiceId) && !(byPerson && this.paidOutside(invoiceId))) {
      return false;
    }
    if (
      !byPerson &&
      this.attempts(invoiceId).some(
        (attempt: Attempt): boolean => attempt.rateMismatch !== null && attempt.state !== "failed",
      )
    ) {
      return false;
    }
    this.db
      .prepare("UPDATE obligations SET state = 'settled' WHERE invoice_id = ?")
      .run(invoiceId);
    // Nothing is left to approve on a settled invoice.
    this.voidOpenApprovals(invoiceId);
    return true;
  }

  // A transfer that went to other bank details than the ones it was approved or
  // decided for.
  markMisdirected(requestId: string): void {
    this.db.prepare("UPDATE attempts SET misdirected = 1 WHERE request_id = ?").run(requestId);
  }

  // The latest payment PayOnce sent this beneficiary that the bank paid, to the
  // details it was meant for. Payouts sent outside PayOnce do not count, so a
  // record changed and paid in the web app does not become the account on file.
  lastPaidTransfer(beneficiaryId: string): { transferId: string; reference: string | null } | undefined {
    const row: { transfer_id: string; reference: string | null } | undefined = this.db
      .prepare(
        `SELECT attempts.transfer_id, attempts.reference FROM attempts
           JOIN obligations ON obligations.invoice_id = attempts.invoice_id
          WHERE obligations.beneficiary_id = ? AND obligations.origin = 'payonce'
            AND attempts.state = 'paid' AND attempts.transfer_id IS NOT NULL
            AND attempts.misdirected = 0
          ORDER BY attempts.rowid DESC LIMIT 1`,
      )
      .get(beneficiaryId) as unknown as { transfer_id: string; reference: string | null } | undefined;
    return row === undefined ? undefined : { transferId: row.transfer_id, reference: row.reference };
  }

  bankChange(id: number): BankChange | undefined {
    const row: BankChangeRow | undefined = this.db
      .prepare("SELECT * FROM bank_changes WHERE id = ?")
      .get(id) as unknown as BankChangeRow | undefined;
    return row === undefined ? undefined : toBankChange(row);
  }

  // ---------- pay runs ----------

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
            bank_change_id, payee, pay_to, account_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  // Stores a checked file as a run waiting for approval, in one write transaction.
  // A row whose invoice number reached the ledger since the check is skipped
  // here, under the write lock. Throws WaitingRunError while another run waits,
  // SameFileError for a file that is a run already, and NothingToPayError when no
  // row is left to pay.
  createRun(input: NewRun, rows: CheckedRow[]): number {
    return this.transaction((): number => {
      const waiting: Run | undefined = this.waitingRun();
      if (waiting !== undefined) {
        throw new WaitingRunError(waiting.id);
      }
      const same: Run | undefined = this.liveRunForFile(input.fileHash);
      if (same !== undefined) {
        throw new SameFileError(same);
      }
      const checked: CheckedRow[] = rows.map((row: CheckedRow): CheckedRow =>
        row.action === "pay" && row.invoiceId !== null && this.obligation(row.invoiceId) !== undefined
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
    return this.transaction((): T | undefined => {
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
                pay_to = ?, account_key = ?
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
          runId,
          row.line,
        );
      }
      return settle();
    });
  }

  // Cancels a run still waiting, voids its open request and drops its rows, so
  // their invoice numbers are free again. False when it is not waiting.
  cancelRun(runId: number, cancelledBy: string, note: string): boolean {
    return this.transaction((): boolean => {
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE runs SET state = 'cancelled', cancelled_by = ?, cancel_note = ?
            WHERE id = ? AND state = 'waiting'`,
        )
        .run(cancelledBy, note, runId);
      if (Number(result.changes) !== 1) {
        return false;
      }
      this.voidOpenRunApprovals(runId);
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
  // pay.
  releaseRun(
    runId: number,
    approvalId: number,
    uploadedBy: string,
    rows: ReleaseRow[],
    runLine: string,
    leases: Lease[],
  ): ReleasedRun | undefined {
    return this.transaction((): ReleasedRun | undefined => {
      for (const currency of new Set(rows.map((row: ReleaseRow): string => row.currency))) {
        const lease: Lease | undefined = leases.find((entry: Lease): boolean => entry.currency === currency);
        if (lease === undefined) {
          throw new Error(`Run ${runId} pays ${currency}, and its release does not hold the ${currency} lock`);
        }
        this.requireLease(lease);
      }
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
      this.addRunEventRow(runId, "payment", runLine, null);
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
                  look_at, source_currency)
               VALUES (?, ?, '', ?, ?, ?, ?, 0, ?, NULL, ?, ?, NULL)`,
            )
            .run(
              row.invoiceId,
              row.payee,
              row.beneficiaryId,
              row.currency,
              row.amountMinor,
              row.transferMethod,
              uploadedBy,
              row.rowId,
              now,
            );
          const marked: { changes: number | bigint } = this.db
            .prepare(
              `UPDATE run_rows SET state = 'released', account_key = ?, pay_to = ?
                WHERE id = ? AND run_id = ? AND state = 'waiting'`,
            )
            .run(row.accountKey, row.payTo, row.rowId, runId);
          if (Number(marked.changes) !== 1) {
            throw new Error(`Row ${row.line} of run ${runId} is not waiting to be released`);
          }
          this.appendEvent(row.invoiceId, "approval", row.firstLine, null);
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

  // Chains one line to the run's timeline and adds it to the running hash of run
  // lines, as appendEvent does for an invoice. The caller holds the write
  // transaction.
  private addRunEventRow(runId: number, kind: EventKind, message: string, topic: string | null): void {
    const last: HashRow | undefined = this.db
      .prepare(
        `SELECT hash FROM run_events WHERE run_id = ? AND hash IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(runId) as unknown as HashRow | undefined;
    const prevHash: string = last?.hash ?? GENESIS;
    // Hashed as it will read back from the file.
    const line: RunEventFields = {
      runId,
      at: new Date().toISOString(),
      kind,
      message: storable(message),
      topic: topic === null ? null : storable(topic),
    };
    const hash: string = runEventHash(prevHash, line);
    this.db
      .prepare(
        `INSERT INTO run_events (run_id, at, kind, message, topic, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(line.runId, line.at, line.kind, line.message, line.topic, prevHash, hash);
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(RUN_HEAD_KEY, nextLedgerHead(this.metaValue(RUN_HEAD_KEY) ?? GENESIS, hash));
  }

  // A run's timeline is a hash chain of its own, with a running hash over every
  // run's lines, so who uploaded, approved, checked, released or cancelled a run
  // is as tamper-evident as an invoice's timeline.
  addRunEvent(runId: number, kind: EventKind, message: string, topic: string | null = null): void {
    this.transaction((): void => {
      this.addRunEventRow(runId, kind, message, topic);
    });
  }

  // What an audit of run timelines checks, read in one transaction. runId null
  // reads every run's lines.
  runAuditSnapshot(runId: number | null): RunAuditSnapshot {
    this.db.exec("BEGIN");
    try {
      const rows: RunEventRow[] = (
        runId === null
          ? this.db.prepare("SELECT * FROM run_events ORDER BY id").all()
          : this.db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY id").all(runId)
      ) as unknown as RunEventRow[];
      const all: RunHashRow[] = this.db
        .prepare("SELECT run_id, hash FROM run_events ORDER BY id")
        .all() as unknown as RunHashRow[];
      const snapshot: RunAuditSnapshot = {
        events: rows.map(toChainedRunEvent),
        hashes: all.map((row: RunHashRow): string | null => row.hash),
        runs: new Set(all.map((row: RunHashRow): number => row.run_id)).size,
        ledgerHead: this.metaValue(RUN_HEAD_KEY),
        chainStartedAt: this.metaValue(RUN_CHAIN_STARTED_KEY),
        backfilledThrough: Number(this.metaValue(RUN_BACKFILLED_THROUGH_KEY) ?? 0),
      };
      this.db.exec("COMMIT");
      return snapshot;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  runEvents(runId: number): LedgerEvent[] {
    return this.db
      .prepare("SELECT id, at, kind, message, topic FROM run_events WHERE run_id = ? ORDER BY id")
      .all(runId) as unknown as LedgerEvent[];
  }

  // Run approvals are kept apart from invoice approvals, because a run has no
  // invoice until it is released. The methods copy the invoice ones.

  voidOpenRunApprovals(runId: number): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE run_approvals SET state = 'void'
          WHERE run_id = ? AND state IN ('requested', 'approved')`,
      )
      .run(runId);
    return Number(result.changes) > 0;
  }

  // A new request voids any earlier one for the run that is still open. Only a
  // run still waiting gets one. False when none was opened.
  requestRunApproval(runId: number, request: ApprovalRequest): boolean {
    return this.transaction((): boolean => this.addRunApproval(runId, request));
  }

  // requestRunApproval inside a transaction the caller holds, such as the one
  // setRunRows opens, so a check's rows and its request are written together.
  addRunApproval(runId: number, request: ApprovalRequest): boolean {
    if (!this.db.isTransaction) {
      throw new Error("A run's request is opened only inside a ledger transaction");
    }
    this.voidOpenRunApprovals(runId);
    const result: { changes: number | bigint } = this.db
      .prepare(
        `INSERT INTO run_approvals
           (run_id, binding, terms, requested_at, expires_at, needed, needed_why)
         SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND state = 'waiting')`,
      )
      .run(
        runId,
        request.binding,
        request.terms,
        new Date().toISOString(),
        new Date(request.expiresAt).toISOString(),
        request.needed,
        request.neededWhy,
        runId,
      );
    return Number(result.changes) === 1;
  }

  private runSignoffs(approvalId: number): Signoff[] {
    return this.db
      .prepare(
        "SELECT approver, binding, at FROM run_signoffs WHERE approval_id = ? ORDER BY rowid",
      )
      .all(approvalId) as unknown as Signoff[];
  }

  private toRunApproval(row: RunApprovalRow): RunApproval {
    return {
      id: row.id,
      runId: row.run_id,
      binding: row.binding,
      terms: row.terms,
      state: row.state,
      approver: row.approver,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      needed: row.needed,
      neededWhy: row.needed_why,
      signoffs: this.runSignoffs(row.id),
    };
  }

  latestRunApproval(runId: number): RunApproval | undefined {
    const row: RunApprovalRow | undefined = this.db
      .prepare("SELECT * FROM run_approvals WHERE run_id = ? ORDER BY id DESC LIMIT 1")
      .get(runId) as unknown as RunApprovalRow | undefined;
    return row === undefined ? undefined : this.toRunApproval(row);
  }

  // Records one approver's approval of a run request that is still waiting and
  // has not expired, for the binding they were shown, as signOff does for an
  // invoice. Returns the request as it now stands.
  signOffRun(
    approvalId: number,
    approver: string,
    binding: string,
    useWithinMs: number,
  ): RunApproval {
    this.transaction((): void => {
      const row: RunApprovalRow | undefined = this.db
        .prepare("SELECT * FROM run_approvals WHERE id = ?")
        .get(approvalId) as unknown as RunApprovalRow | undefined;
      if (row === undefined || row.state !== "requested") {
        throw new Error("This approval request is no longer waiting for approval");
      }
      if (row.binding !== binding) {
        throw new Error("These are not the terms of the approval request");
      }
      const expiresAt: number = Date.parse(row.expires_at);
      if (!(expiresAt > Date.now())) {
        throw new Error("This approval request has expired. Check the run again to open a new one");
      }
      try {
        this.db
          .prepare(
            "INSERT INTO run_signoffs (approval_id, approver, binding, at) VALUES (?, ?, ?, ?)",
          )
          .run(approvalId, approver, binding, new Date().toISOString());
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          throw new Error(`${approver} has approved this already`);
        }
        throw error;
      }
      const signoffs: Signoff[] = this.runSignoffs(approvalId);
      if (signoffs.length >= row.needed) {
        const useBy: number = Math.max(expiresAt, Date.now() + useWithinMs);
        this.db
          .prepare(
            "UPDATE run_approvals SET state = 'approved', approver = ?, expires_at = ? WHERE id = ?",
          )
          .run(signersOf(signoffs), new Date(useBy).toISOString(), approvalId);
      }
    });
    const row: RunApprovalRow = this.db
      .prepare("SELECT * FROM run_approvals WHERE id = ?")
      .get(approvalId) as unknown as RunApprovalRow;
    return this.toRunApproval(row);
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

  // ---------- the per-currency lock ----------

  // Takes the lease on a currency for holder until the given time, if nobody
  // holds it or the last holder's lease has run out, and nobody has been waiting
  // longer. True when taken. Otherwise holder joins the queue, or keeps its place
  // in it, so the holders waiting take the lock in the order they asked, across
  // processes. A holder that stops asking for WAITER_GONE_MS loses its place.
  takeCurrencyLock(currency: string, holder: string, until: number): boolean {
    return this.transaction((): boolean => {
      const at: number = Date.now();
      const now: string = new Date(at).toISOString();
      this.db
        .prepare("DELETE FROM currency_lock_waiters WHERE currency = ? AND seen_at <= ?")
        .run(currency, new Date(at - WAITER_GONE_MS).toISOString());
      const first: { holder: string } | undefined = this.db
        .prepare(
          "SELECT holder FROM currency_lock_waiters WHERE currency = ? ORDER BY since, rowid LIMIT 1",
        )
        .get(currency) as unknown as { holder: string } | undefined;
      if (first === undefined || first.holder === holder) {
        const result: { changes: number | bigint } = this.db
          .prepare(
            `INSERT INTO currency_locks (currency, holder, expires_at) VALUES (?, ?, ?)
             ON CONFLICT(currency) DO UPDATE SET holder = excluded.holder,
                                                 expires_at = excluded.expires_at
              WHERE currency_locks.expires_at <= ?`,
          )
          .run(currency, holder, new Date(until).toISOString(), now);
        if (Number(result.changes) === 1) {
          this.leaveCurrencyQueue(currency, holder);
          return true;
        }
      }
      this.db
        .prepare(
          `INSERT INTO currency_lock_waiters (currency, holder, since, seen_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(currency, holder) DO UPDATE SET seen_at = excluded.seen_at`,
        )
        .run(currency, holder, now, now);
      return false;
    });
  }

  // Gives up a place in the queue, for a holder that stopped waiting.
  leaveCurrencyQueue(currency: string, holder: string): void {
    this.db
      .prepare("DELETE FROM currency_lock_waiters WHERE currency = ? AND holder = ?")
      .run(currency, holder);
  }

  // False when holder no longer holds it, because the lease ran out and someone
  // else took it.
  renewCurrencyLock(currency: string, holder: string, until: number): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare("UPDATE currency_locks SET expires_at = ? WHERE currency = ? AND holder = ?")
      .run(new Date(until).toISOString(), currency, holder);
    return Number(result.changes) === 1;
  }

  releaseCurrencyLock(currency: string, holder: string): void {
    this.db
      .prepare("DELETE FROM currency_locks WHERE currency = ? AND holder = ?")
      .run(currency, holder);
  }
}

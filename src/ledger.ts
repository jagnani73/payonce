import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  eventHash,
  GENESIS,
  nextLedgerHead,
  restartOf,
  restartRecord,
  runEventHash,
  storable,
  type AuditSnapshot,
  type ChainedEvent,
  type ChainedRunEvent,
  type EventFields,
  type HeadRestart,
  type LedgerReport,
  type RunAuditSnapshot,
  type RunEventFields,
} from "./audit-trail.js";
import type { TransferBankDetails } from "./airwallex/transfers.js";
import type { ApprovalTerms, FxTerms } from "./approval.js";
import type { ArrivalTerms } from "./arrival.js";
import {
  bankDetailsKey,
  failedStatus,
  FAILED_STATUS_LIST,
  keyHash,
  routeKeyOf,
  routeOfDetailsKey,
  type Debit,
} from "./assess.js";
import type { EmailAttachment, SupplierEmail } from "./emails.js";
import { oneLine } from "./printable.js";
import { ReconStore } from "./recon-store.js";

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
const FAILED_IN_SQL: string = FAILED_STATUS_LIST.map((status: string): string => `'${status}'`).join(", ");
// A payment for the invoice bound as the parameter that the bank has live, the
// test liveAtBank makes in code: an attempt that is not failed, a transfer the
// ledger keeps failed while the bank shows it in flight, paid or in a status
// PayOnce does not know, or a transfer under an attempt's request id that does not
// match its invoice, while the bank has not failed it. A transfer found late
// whose status was never read counts as live.
const LIVE_ATTEMPT: string = `SELECT 1 FROM attempts WHERE invoice_id = ?
  AND (state <> 'failed'
    OR (transfer_id IS NOT NULL AND CASE
      WHEN bank_status IS NULL THEN found_late_at IS NOT NULL
      ELSE bank_status NOT IN (${FAILED_IN_SQL}) END)
    OR (mismatched_transfer_id IS NOT NULL
      AND (mismatched_status IS NULL OR mismatched_status NOT IN (${FAILED_IN_SQL}))))`;
// A transfer under the request id of one of the invoice's attempts that does not
// match the invoice, which no person has closed the invoice over since.
const UNCLEARED_MISMATCH: string = `SELECT 1 FROM attempts WHERE invoice_id = ?
  AND mismatched_transfer_id IS NOT NULL AND mismatched_cleared_at IS NULL`;
const BUSY_TIMEOUT_MS: number = 5_000;
// How often runningHashCheck hashes every line again, so a line rewritten in place
// is caught within a minute, as the alert loop's audit check catches it.
const FULL_HEAD_CHECK_MS: number = 60_000;
// A line the incident list may show for a closed invoice: a decision, a close, or a
// standing line, but never an error, an email or a message draft.
const HEADLINE_LINE: string = `(kind IN ('decision', 'closed')
    OR (topic IS NOT NULL AND topic NOT LIKE 'outbox:%'))
  AND kind NOT IN ('error', 'email', 'outbox')`;

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
  CREATE INDEX IF NOT EXISTS attempts_by_invoice ON attempts(invoice_id);
  CREATE INDEX IF NOT EXISTS obligations_by_beneficiary ON obligations(beneficiary_id);
  CREATE INDEX IF NOT EXISTS approvals_by_invoice ON approvals(invoice_id, id);
  CREATE INDEX IF NOT EXISTS emails_by_invoice ON emails(invoice_id, id);
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
  CREATE INDEX IF NOT EXISTS outside_payouts_by_invoice ON outside_payouts(invoice_id);
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
  CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    source TEXT NOT NULL,
    file_name TEXT,
    raw_sha256 TEXT NOT NULL,
    raw_bytes INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    message_id TEXT,
    sender TEXT NOT NULL,
    sender_name TEXT NOT NULL DEFAULT '',
    from_as_written TEXT NOT NULL DEFAULT '',
    reply_to TEXT NOT NULL DEFAULT '[]',
    date_as_written TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    style_text TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '[]',
    partial INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'waiting',
    invoice_id TEXT REFERENCES obligations(invoice_id),
    delivered_by TEXT,
    delivered_at TEXT,
    dismissed_by TEXT,
    dismissed_at TEXT,
    dismiss_note TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_upload_per_email ON inbox(content_hash);
  CREATE INDEX IF NOT EXISTS inbox_by_message_id ON inbox(message_id);
  CREATE TABLE IF NOT EXISTS alert_conditions (
    alert_key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    episode INTEGER NOT NULL DEFAULT 1,
    seen_at TEXT NOT NULL,
    cleared_at TEXT
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_key TEXT NOT NULL,
    episode INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    kind TEXT NOT NULL,
    facts TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    tries INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT NOT NULL,
    claimed_by TEXT,
    claim_until TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_alert_per_change
    ON alerts(alert_key, episode, fingerprint);
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT NOT NULL REFERENCES obligations(invoice_id),
    template TEXT NOT NULL,
    audience TEXT NOT NULL,
    facts TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    copied_by TEXT,
    copied_at TEXT,
    sent_by TEXT,
    sent_at TEXT,
    dismissed_by TEXT,
    dismissed_at TEXT,
    dismiss_note TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_draft_per_template
    ON outbox(invoice_id, template) WHERE state IN ('draft', 'copied');
  CREATE TABLE IF NOT EXISTS rail_failures (
    transfer_id TEXT PRIMARY KEY,
    currency TEXT NOT NULL,
    method TEXT NOT NULL,
    code TEXT NOT NULL,
    payee TEXT NOT NULL,
    reference TEXT NOT NULL,
    invoice_id TEXT,
    origin TEXT NOT NULL,
    created_at TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    seen_by TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rail_failures_by_rail ON rail_failures(currency, method, seen_at);
  CREATE TABLE IF NOT EXISTS outages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    currency TEXT NOT NULL,
    method TEXT NOT NULL,
    codes TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    declared_at TEXT NOT NULL,
    payees INTEGER NOT NULL,
    threshold INTEGER NOT NULL,
    window_minutes INTEGER NOT NULL,
    counted TEXT NOT NULL,
    ended_at TEXT,
    ended_by TEXT,
    end_note TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_outage_per_rail
    ON outages(currency, method) WHERE state = 'active';
  CREATE TABLE IF NOT EXISTS outage_holds (
    outage_id INTEGER NOT NULL REFERENCES outages(id),
    invoice_id TEXT REFERENCES obligations(invoice_id),
    run_id INTEGER REFERENCES runs(id),
    what TEXT NOT NULL,
    held_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_hold_per_invoice
    ON outage_holds(outage_id, invoice_id) WHERE invoice_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS one_hold_per_run
    ON outage_holds(outage_id, run_id) WHERE run_id IS NOT NULL;
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
  | "error"
  | "outbox"
  | "outage";

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
  // When the supplier expects the money, as YYYY-MM-DD. Advice for people only:
  // it never changes a decision or a payment.
  dueDate?: string | null;
}

export interface Obligation extends NewObligation {
  // The invoice's own currency when it is not paid from another wallet.
  sourceCurrency: string;
  dueDate: string | null;
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
  // The transfer's created_at and status as Airwallex last gave them, and when it
  // usually arrives as the route advisory worked it out when it was sent. Null
  // until read, and on payments from before these columns.
  bankCreatedAt: string | null;
  bankStatus: string | null;
  arrival: ArrivalTerms | null;
  // When PayOnce opened it. Null on attempts from before this was kept and on a
  // found payout's.
  openedAt: string | null;
  // When PayOnce last asked Airwallex to create its transfer. Null until the first
  // try, and on a found payout's.
  triedAt: string | null;
  // When Airwallex listed a transfer under its request id after PayOnce had
  // marked it failed with none. Null on every other attempt.
  foundLateAt: string | null;
  // A transfer under its request id that is not its invoice's payment by number,
  // amount and currency, on an attempt marked failed with none: its id, short
  // reference and last status read. Null on every other attempt.
  mismatchedTransferId: string | null;
  mismatchedReference: string | null;
  mismatchedStatus: string | null;
  // When a person closed the invoice after it was found. Until then PayOnce never
  // closes the invoice by itself.
  mismatchedClearedAt: string | null;
  // What that transfer took from the wallet it left before the fee, and that
  // wallet. Null until it has been read since PayOnce kept them.
  mismatchedAmountMinor: number | null;
  mismatchedCurrency: string | null;
  // The accountKey of the bank details it was decided or approved for. Null on a
  // found payout's, and on one from before it was kept that no approval or pay
  // run row named.
  accountKey: string | null;
  // The routeKey of those details: where the money goes. Its transfer and every
  // retry are checked against it, so a change to a field that does not say where
  // money goes is not another account. Null on attempts from before it was kept
  // that nothing on file gave it for, which are checked by accountKey instead.
  routeKey: string | null;
}

// An account a payment is decided or approved for, or that a stored payment was
// checked against: its accountKey and, when known, its routeKey. Two accounts
// are the same when their routeKeys match, or, with either routeKey not known,
// their accountKeys.
export interface AccountRef {
  accountKey: string;
  routeKey: string | null;
}

// True when details hold the account ref names, by where the money goes.
export function holdsAccount(ref: AccountRef, details: TransferBankDetails): boolean {
  return ref.routeKey !== null ? ref.routeKey === routeKeyOf(details) : ref.accountKey === keyHash(bankDetailsKey(details));
}

// The latest checked payment PayOnce made to a beneficiary, with the account it
// went to.
export interface LastPaid extends AccountRef {
  transferId: string;
  reference: string | null;
}

// True when two sets of bank details, as bankDetailsKey writes them, go to the
// same account.
function sameRoute(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const route: string | null = routeOfDetailsKey(a);
  return route !== null && route === routeOfDetailsKey(b);
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
  // The accountKey and routeKey of the bank details the transfer went to and
  // their last four characters, for the supplier view only. Nothing PayOnce
  // decides reads them.
  sentKey?: string | null;
  sentRoute?: string | null;
  sentEnding?: string | null;
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
  sentKey: string | null;
  sentRoute: string | null;
  sentEnding: string | null;
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
  // The routeKey of the account an invoice's terms name. A run's rows keep theirs.
  routeKey?: string | null;
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
  inbox_id: number | null;
  // From the upload, null for a fixture thread's email.
  sender_name: string | null;
  style_text: string;
  reply_to: string;
  attachments: string;
  notes: string;
  partial: number;
}

// An email a person uploaded. waiting is in the inbox, delivered is on an
// invoice, and dismissed is final: a person decided it belongs to none.
export type UploadState = "waiting" | "delivered" | "dismissed";

export interface NewUpload {
  uploadedBy: string;
  source: "file" | "paste";
  fileName: string | null;
  rawSha256: string;
  rawBytes: number;
  contentHash: string;
  messageId: string | null;
  sender: string;
  senderName: string;
  fromAsWritten: string;
  replyTo: string[];
  dateAsWritten: string;
  subject: string;
  body: string;
  styleText: string;
  attachments: EmailAttachment[];
  notes: string[];
  partial: boolean;
}

export interface Upload extends NewUpload {
  id: number;
  uploadedAt: string;
  state: UploadState;
  invoiceId: string | null;
  deliveredBy: string | null;
  deliveredAt: string | null;
  dismissedBy: string | null;
  dismissedAt: string | null;
  dismissNote: string | null;
}

interface UploadRow {
  id: number;
  uploaded_by: string;
  uploaded_at: string;
  source: "file" | "paste";
  file_name: string | null;
  raw_sha256: string;
  raw_bytes: number;
  content_hash: string;
  message_id: string | null;
  sender: string;
  sender_name: string;
  from_as_written: string;
  reply_to: string;
  date_as_written: string;
  subject: string;
  body: string;
  style_text: string;
  attachments: string;
  notes: string;
  partial: number;
  state: UploadState;
  invoice_id: string | null;
  delivered_by: string | null;
  delivered_at: string | null;
  dismissed_by: string | null;
  dismissed_at: string | null;
  dismiss_note: string | null;
}

function toUpload(row: UploadRow): Upload {
  return {
    id: row.id,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    source: row.source,
    fileName: row.file_name,
    rawSha256: row.raw_sha256,
    rawBytes: row.raw_bytes,
    contentHash: row.content_hash,
    messageId: row.message_id,
    sender: row.sender,
    senderName: row.sender_name,
    fromAsWritten: row.from_as_written,
    replyTo: storedStrings(row.reply_to),
    dateAsWritten: row.date_as_written,
    subject: row.subject,
    body: row.body,
    styleText: row.style_text,
    attachments: storedList<EmailAttachment>(row.attachments),
    notes: storedStrings(row.notes),
    partial: row.partial === 1,
    state: row.state,
    invoiceId: row.invoice_id,
    deliveredBy: row.delivered_by,
    deliveredAt: row.delivered_at,
    dismissedBy: row.dismissed_by,
    dismissedAt: row.dismissed_at,
    dismissNote: row.dismiss_note,
  };
}

// A second upload of an email already in the inbox, in any state.
export class DuplicateUploadError extends Error {
  readonly upload: Upload;

  constructor(upload: Upload) {
    super(
      upload.state === "delivered"
        ? `This email was uploaded already, as upload ${upload.id}, and delivered to ${upload.invoiceId ?? ""} by ${upload.deliveredBy ?? ""}`
        : upload.state === "dismissed"
          ? `This email was uploaded already, as upload ${upload.id}, and dismissed by ${upload.dismissedBy ?? ""}: ${upload.dismissNote ?? ""}`
          : `This email was uploaded already and waits in the inbox as upload ${upload.id}`,
    );
    this.name = "DuplicateUploadError";
    this.upload = upload;
  }
}

// What delivering an upload did. Not waiting means another person or process
// delivered or dismissed it first.
export type DeliverResult =
  | { ok: true; upload: Upload; obligation: Obligation }
  | { ok: false; upload: Upload };

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
  due_date: string | null;
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

interface IdHashRow extends LedgerRow {
  id: number;
}

// How far the running hash has been worked out: through which line, how many lines
// that covers and the last one's hash, so a line removed since is noticed, and
// when every line was last hashed again from the genesis.
interface HeadProgress {
  throughId: number;
  lines: number;
  lastHash: string | null;
  computed: string;
  invoices: Set<string>;
  fullAt: number;
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
// The first time the running hash was found missing and started again.
const LEDGER_RESTARTED_KEY: string = "events_head_restarted";
// The same for pay run timelines, which are chained apart from invoice timelines.
const RUN_HEAD_KEY: string = "run_events_head";
const RUN_CHAIN_STARTED_KEY: string = "run_chain_started_at";
const RUN_BACKFILLED_THROUGH_KEY: string = "run_chain_backfilled_through";
const RUN_RESTARTED_KEY: string = "run_events_head_restarted";

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
    // When the supplier expects the money, as YYYY-MM-DD.
    due_date: "TEXT",
    // When the invoice first went to a person, as an ISO time, written only by
    // the obligation_escalated_at trigger (TIME_TRIGGERS). For the metrics only:
    // nothing PayOnce decides reads it. '' on an invoice already sent to a person
    // when the column was added, whose first time is not known.
    escalated_at: "TEXT",
  },
  approvals: {
    requested_at: "TEXT",
    expires_at: "TEXT",
    needed: "INTEGER NOT NULL DEFAULT 1",
    needed_why: "TEXT NOT NULL DEFAULT ''",
    // The routeKey of the bank details the terms' accountKey hashes, kept beside
    // the terms so the binding is unchanged. Who may approve is worked out by it.
    // Null on requests from before it.
    route_key: "TEXT",
  },
  attempts: {
    reference: "TEXT",
    fee_minor: "INTEGER",
    fee_currency: "TEXT",
    // 1 when the transfer went to other bank details than the ones it was
    // approved or decided for, or showed none, so it never counts as the account
    // PayOnce last paid.
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
    // The transfer's created_at and status as last read, and its arrival estimate
    // as ArrivalTerms JSON.
    bank_created_at: "TEXT",
    bank_status: "TEXT",
    arrival: "TEXT",
    // When PayOnce opened the attempt, as an ISO time. Null on attempts from
    // before the column and on a found payout's.
    opened_at: "TEXT",
    // When PayOnce last called Airwallex to create the transfer, as an ISO time.
    tried_at: "TEXT",
    // When a transfer was found under its request id after PayOnce had marked it
    // failed with none, as an ISO time.
    found_late_at: "TEXT",
    // A transfer Airwallex lists under the request id of an attempt marked failed
    // with none that does not carry its invoice's number, amount and currency: its
    // id, short reference and last status read, and when a person closed the
    // invoice after it was found.
    mismatched_transfer_id: "TEXT",
    mismatched_reference: "TEXT",
    mismatched_status: "TEXT",
    mismatched_cleared_at: "TEXT",
    // What that transfer took from its wallet before the fee, and the wallet, as
    // debitOf reads it. Null until a read of it since the columns were added.
    mismatched_amount_minor: "INTEGER",
    mismatched_currency: "TEXT",
    // The accountKey of the bank details the payment was decided or approved for,
    // which its transfer and every retry are checked against. Null on a found
    // payout's, and on attempts from before the column that no approval or pay run
    // row named an account for.
    account_key: "TEXT",
    // The accountKey of the bank details the transfer went to, and their last
    // four characters, as last read. For the supplier view only: nothing PayOnce
    // decides reads them. Null until read since the columns were added.
    sent_key: "TEXT",
    sent_ending: "TEXT",
    // The routeKeys of account_key and sent_key: where the money goes. A transfer
    // and every retry are checked against route_key, and the supplier view groups
    // accounts by them. Null on attempts from before the columns that no callback
    // on file gave details for (backfillRoutes).
    route_key: "TEXT",
    sent_route: "TEXT",
    // When PayOnce first recorded the attempt failed, and first recorded it paid,
    // as ISO times, written only by TIME_TRIGGERS. For a found payout's original,
    // when PayOnce took it on. For the metrics only: nothing PayOnce decides reads
    // them. '' on an attempt already failed, or paid, when the column was added.
    failed_at: "TEXT",
    paid_at: "TEXT",
    // When Airwallex refused to create the transfer, as an ISO time, written by
    // failAttempt for a refusal, whether or not it gave a code. For the metrics
    // only: nothing PayOnce decides reads it. Null on an attempt PayOnce marked
    // failed because Airwallex listed no transfer for it, and on refusals from
    // before the column.
    refused_at: "TEXT",
  },
  rail_failures: {
    // When the transfer failed by Airwallex's updated_at, or when PayOnce first
    // read it as failed when Airwallex gave no readable updated_at. Null on rows
    // from before the column, which count by seen_at.
    failed_at: "TEXT",
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
  emails: {
    // The upload an email came from, null for a fixture thread's. The rest are
    // as the upload has them.
    inbox_id: "INTEGER",
    reply_to: "TEXT NOT NULL DEFAULT '[]'",
    style_text: "TEXT NOT NULL DEFAULT ''",
    attachments: "TEXT NOT NULL DEFAULT '[]'",
    notes: "TEXT NOT NULL DEFAULT '[]'",
    partial: "INTEGER NOT NULL DEFAULT 0",
  },
  run_rows: {
    // The due date the file gives, as YYYY-MM-DD, and when a pay row usually
    // arrives, as ArrivalTerms JSON.
    due_date: "TEXT",
    arrival: "TEXT",
    // The routeKey of account_key, as the check read the record. Null on rows
    // from before it, and on a released row whose last check read another
    // account than the run approved.
    route_key: "TEXT",
  },
  outside_payouts: {
    reference: "TEXT NOT NULL DEFAULT ''",
    state: "TEXT NOT NULL DEFAULT 'in_flight'",
    amount_minor: "INTEGER",
    currency: "TEXT",
    fee_minor: "INTEGER",
    fee_currency: "TEXT",
    fee_tried_at: "TEXT",
    // As on attempts, for the supplier view only.
    sent_key: "TEXT",
    sent_ending: "TEXT",
    sent_route: "TEXT",
  },
};

// The first time an invoice went to a person, and an attempt was first recorded
// failed or paid, for the metrics. Each trigger writes only its own column, only
// while it is null, on the row that changed, found by rowid: no constraint, no
// RAISE and no SELECT, so it cannot fail the statement it runs in. Created under
// the write lock that adds the columns, on every writable open. recursive_triggers
// stays off, and no trigger updates a state, so none sets off another. They fire
// for an older PayOnce sharing the file too.
const NOW_ISO: string = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const TIME_TRIGGERS: string = `
  CREATE TRIGGER IF NOT EXISTS obligation_escalated_at AFTER UPDATE OF state ON obligations
    WHEN NEW.state = 'escalated' AND OLD.state <> 'escalated' AND NEW.escalated_at IS NULL
  BEGIN
    UPDATE obligations SET escalated_at = COALESCE(escalated_at, ${NOW_ISO}) WHERE rowid = NEW.rowid;
  END;
  CREATE TRIGGER IF NOT EXISTS attempt_failed_at AFTER UPDATE OF state ON attempts
    WHEN NEW.state = 'failed' AND OLD.state <> 'failed' AND NEW.failed_at IS NULL
  BEGIN
    UPDATE attempts SET failed_at = COALESCE(failed_at, ${NOW_ISO}) WHERE rowid = NEW.rowid;
  END;
  CREATE TRIGGER IF NOT EXISTS attempt_paid_at AFTER UPDATE OF state ON attempts
    WHEN NEW.state = 'paid' AND OLD.state <> 'paid' AND NEW.paid_at IS NULL
  BEGIN
    UPDATE attempts SET paid_at = COALESCE(paid_at, ${NOW_ISO}) WHERE rowid = NEW.rowid;
  END;
  CREATE TRIGGER IF NOT EXISTS attempt_failed_at_insert AFTER INSERT ON attempts
    WHEN NEW.state = 'failed' AND NEW.failed_at IS NULL
  BEGIN
    UPDATE attempts SET failed_at = COALESCE(failed_at, ${NOW_ISO}) WHERE rowid = NEW.rowid;
  END;
  CREATE TRIGGER IF NOT EXISTS attempt_paid_at_insert AFTER INSERT ON attempts
    WHEN NEW.state = 'paid' AND NEW.paid_at IS NULL
  BEGIN
    UPDATE attempts SET paid_at = COALESCE(paid_at, ${NOW_ISO}) WHERE rowid = NEW.rowid;
  END;
`;

// What a row already in that state when its time column is added gets: '', a time
// not known, which no trigger overwrites and the metrics count as not on file.
const TIME_NOT_KNOWN: Record<string, string> = {
  "obligations.escalated_at":
    "UPDATE obligations SET escalated_at = '' WHERE state = 'escalated' OR escalation_reason <> ''",
  "attempts.failed_at": "UPDATE attempts SET failed_at = '' WHERE state = 'failed' OR found_late_at IS NOT NULL",
  "attempts.paid_at": "UPDATE attempts SET paid_at = '' WHERE state = 'paid'",
};

// What the account_key backfill reads of an attempt.
interface UnkeyedAttempt {
  request_id: string;
  invoice_id: string;
  kind: string;
  opened_at: string | null;
  reference: string | null;
}

// A used approval the backfill may take an attempt's account from, with when its
// last signoff came.
interface UsedApproval {
  account_key: string | null;
  approved_at: string | null;
}

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
  bank_created_at: string | null;
  bank_status: string | null;
  arrival: string | null;
  opened_at: string | null;
  tried_at: string | null;
  found_late_at: string | null;
  mismatched_transfer_id: string | null;
  mismatched_reference: string | null;
  mismatched_status: string | null;
  mismatched_cleared_at: string | null;
  mismatched_amount_minor: number | null;
  mismatched_currency: string | null;
  account_key: string | null;
  route_key: string | null;
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
    duplicateOf: row.duplicate_of === null ? [] : storedStrings(row.duplicate_of),
    rejectedBy: row.rejected_by,
    runRowId: row.run_row_id,
    dueDate: row.due_date ?? null,
  };
}

// A transfer the bank has live counts as live everywhere, whatever state its
// attempt is in. The duplicate lock holds one attempt that is not failed, so a
// transfer found late beside another live payment is kept failed (see record),
// and only its bank_status says the bank has it. This is LIVE_ATTEMPT's test, for
// an attempt in hand.
// A transfer under the attempt's request id that does not match its invoice
// counts too, while the bank has not failed it.
export function liveAtBank(attempt: LiveTested): boolean {
  return ownLive(attempt) || mismatchedLive(attempt);
}

// What liveAtBank reads of an attempt.
export type LiveTested = Pick<
  Attempt,
  "state" | "transferId" | "bankStatus" | "foundLateAt" | "mismatchedTransferId" | "mismatchedStatus"
>;

// The attempt's own payment: not failed, or a transfer the ledger keeps failed
// that the bank has live.
export function ownLive(attempt: LiveTested): boolean {
  if (attempt.state !== "failed") {
    return true;
  }
  if (attempt.transferId === null) {
    return false;
  }
  return attempt.bankStatus === null ? attempt.foundLateAt !== null : !failedStatus(attempt.bankStatus);
}

// A transfer under the attempt's request id that does not match its invoice, which
// the bank has not failed.
export function mismatchedLive(attempt: LiveTested): boolean {
  return (
    attempt.mismatchedTransferId !== null &&
    (attempt.mismatchedStatus === null || !failedStatus(attempt.mismatchedStatus))
  );
}

// A payment of the attempt's own live at the bank that the bank has not paid yet:
// one being sent, one in flight, or one in a status PayOnce does not know.
export function withBank(attempt: Attempt): boolean {
  return ownLive(attempt) && attempt.state !== "paid" && attempt.bankStatus !== "PAID";
}

// Anything under the attempt's request id that the bank has live and not paid:
// its own payment, or a transfer that does not match its invoice.
function stillWithBank(attempt: Attempt): boolean {
  return withBank(attempt) || (mismatchedLive(attempt) && attempt.mismatchedStatus !== "PAID");
}

// The attempt's own payment has failed at the bank, and nothing under its request
// id is still with it. A transfer there that does not match the invoice may be
// paid.
function nothingWithBank(attempt: Attempt): boolean {
  return !ownLive(attempt) && !stillWithBank(attempt);
}

// A transfer found late, or one the ledger keeps failed, that the bank has live,
// while another payment for the invoice, PayOnce's or one sent outside it, is live
// at the bank too: the supplier may have been paid twice. paidTwice gives it to
// the look, and settle refuses to close the invoice by itself while there is one.
export function lateBesideLive(attempts: Attempt[], payouts: OutsidePayout[]): Attempt | undefined {
  const late: Attempt | undefined = attempts.find(
    (attempt: Attempt): boolean =>
      attempt.transferId !== null &&
      liveAtBank(attempt) &&
      (attempt.state === "failed" || attempt.foundLateAt !== null),
  );
  if (late === undefined) {
    return undefined;
  }
  const other: boolean =
    attempts.some(
      (attempt: Attempt): boolean => attempt.requestId !== late.requestId && liveAtBank(attempt),
    ) || payouts.some((payout: OutsidePayout): boolean => payout.state !== "failed");
  return other ? late : undefined;
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
    bankCreatedAt: row.bank_created_at ?? null,
    bankStatus: row.bank_status ?? null,
    arrival: row.arrival === null || row.arrival === undefined ? null : storedObject<ArrivalTerms>(row.arrival),
    openedAt: row.opened_at ?? null,
    triedAt: row.tried_at ?? null,
    foundLateAt: row.found_late_at ?? null,
    mismatchedTransferId: row.mismatched_transfer_id ?? null,
    mismatchedReference: row.mismatched_reference ?? null,
    mismatchedStatus: row.mismatched_status ?? null,
    mismatchedClearedAt: row.mismatched_cleared_at ?? null,
    mismatchedAmountMinor: row.mismatched_amount_minor ?? null,
    mismatchedCurrency: row.mismatched_currency ?? null,
    accountKey: row.account_key ?? null,
    routeKey: row.route_key ?? null,
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
  dueDate: string | null;
  // The invoice's first timeline line, chained like any other.
  firstLine: string;
  // The domain the supplier's emails come from, from the file. Empty for none.
  supplierDomain: string;
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
// payee, callback or arrival, since those only matter for a row that pays.
export function skipRow(row: CheckedRow, reasons: string[]): CheckedRow {
  return { ...row, action: "skip", reasons, heldFor: [], newPayee: false, bankChangeId: null, arrival: null };
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

// active until a person ends it. Nothing ends an outage by itself.
export type OutageState = "active" | "ended";

// A rail is a currency and a transfer method, upper-cased, such as USD LOCAL.
// codes are the rail-level failure codes the counted payouts failed with.
export interface Outage {
  id: number;
  currency: string;
  method: string;
  codes: string[];
  state: OutageState;
  declaredAt: string;
  // The different payees counted, and the rule the outage was declared under.
  payees: number;
  threshold: number;
  windowMinutes: number;
  // The transfer ids of the failures counted.
  counted: string[];
  endedAt: string | null;
  endedBy: string | null;
  endNote: string | null;
}

interface OutageRow {
  id: number;
  currency: string;
  method: string;
  codes: string;
  state: OutageState;
  declared_at: string;
  payees: number;
  threshold: number;
  window_minutes: number;
  counted: string;
  ended_at: string | null;
  ended_by: string | null;
  end_note: string | null;
}

function toOutage(row: OutageRow): Outage {
  return {
    id: row.id,
    currency: row.currency,
    method: row.method,
    codes: storedStrings(row.codes),
    state: row.state,
    declaredAt: row.declared_at,
    payees: row.payees,
    threshold: row.threshold,
    windowMinutes: row.window_minutes,
    counted: storedStrings(row.counted),
    endedAt: row.ended_at,
    endedBy: row.ended_by,
    endNote: row.end_note,
  };
}

// Who read the failure: a look at an invoice, or the sweep.
export type FailureSeenBy = "look" | "sweep";

// A payout PayOnce read as failed with a rail-level code. payee stands for the
// account it paid, so two beneficiary records for one account are one payee.
// origin is outside for a payout PayOnce did not send.
export interface NewRailFailure {
  transferId: string;
  currency: string;
  method: string;
  code: string;
  payee: string;
  reference: string;
  invoiceId: string | null;
  origin: ObligationOrigin;
  createdAt: string;
  seenBy: FailureSeenBy;
  // When it failed, as an ISO time: the transfer's updated_at when Airwallex
  // gives one PayOnce can read, otherwise when PayOnce first read it as failed.
  failedAt: string;
}

export interface RailFailure extends NewRailFailure {
  // When PayOnce first read it as failed, by its own clock.
  seenAt: string;
}

interface RailFailureRow {
  transfer_id: string;
  currency: string;
  method: string;
  code: string;
  payee: string;
  reference: string;
  invoice_id: string | null;
  origin: ObligationOrigin;
  created_at: string;
  seen_at: string;
  seen_by: FailureSeenBy;
  failed_at: string | null;
}

function toRailFailure(row: RailFailureRow): RailFailure {
  return {
    transferId: row.transfer_id,
    currency: row.currency,
    method: row.method,
    code: row.code,
    payee: row.payee,
    reference: row.reference,
    invoiceId: row.invoice_id,
    origin: row.origin,
    createdAt: row.created_at,
    seenAt: row.seen_at,
    seenBy: row.seen_by,
    failedAt: row.failed_at ?? row.seen_at,
  };
}

// What an outage held: an invoice whose own failure it counted, a new invoice's
// first payment, an automatic replacement, a payment a person approved, or a pay
// run's release.
export type OutageHoldKind = "counted" | "original" | "replacement" | "approved" | "run";

export type OutageSubject = { invoiceId: string } | { runId: number };

// A standing line written in the same transaction as an outage hold, so it never
// lands after the end line. wanted reads the timeline as it is then and says
// whether the line is still to be written.
export interface StandingLine {
  kind: EventKind;
  message: string;
  topic: string;
  wanted: (events: LedgerEvent[]) => boolean;
}

// An invoice or run an outage holds, with what of it.
export interface OutageSubjectHeld {
  subject: OutageSubject;
  what: OutageHoldKind;
}

export interface OutageHold {
  outageId: number;
  invoiceId: string | null;
  runId: number | null;
  what: OutageHoldKind;
  heldAt: string;
}

interface OutageHoldRow {
  outage_id: number;
  invoice_id: string | null;
  run_id: number | null;
  what: OutageHoldKind;
  held_at: string;
}

// When an outage is declared: this many different payees failed within the
// window.
export interface OutageCount {
  failures: number;
  windowMinutes: number;
}

// A payment PayOnce did not open, or a run it did not release, because the rail
// it pays on has an outage. what says what was held.
export class RailOutageError extends Error {
  readonly outageId: number;
  readonly what: OutageHoldKind;

  constructor(outage: Outage, what: OutageHoldKind) {
    super(
      `Outage ${outage.id} on ${outage.currency} ${outage.method} is active, so PayOnce opened no payment on it`,
    );
    this.name = "RailOutageError";
    this.outageId = outage.id;
    this.what = what;
  }
}

// What the metrics read of an invoice: never its supplier, phone, references or
// the invoices it was held for, only whether it was held as a likely second bill.
// startedAt is its first timeline line's time, and closedAt its latest closed
// line's, only while it is settled or rejected.
export interface MetricsObligation {
  invoiceId: string;
  currency: string;
  wallet: string;
  amountMinor: number;
  state: ObligationState;
  origin: ObligationOrigin;
  fromRun: boolean;
  transferMethod: string;
  escalationReason: string;
  heldDuplicate: boolean;
  escalatedAt: string | null;
  startedAt: string | null;
  closedAt: string | null;
}

// What the metrics read of an attempt: what liveAtBank reads, and its times.
// amountMinor and currency are what its transfer took from the wallet as debitOf
// read it, the mismatched pair the same for a transfer kept beside it, and
// quoteAmountMinor the sell amount of the quote it was sent with, from the
// approval it was opened on, when that quote is the attempt's and sells from the
// invoice's wallet.
export interface MetricsAttempt extends LiveTested {
  invoiceId: string;
  kind: AttemptKind;
  failureCode: string | null;
  feeMinor: number | null;
  feeCurrency: string | null;
  amountMinor: number | null;
  currency: string | null;
  quoteAmountMinor: number | null;
  mismatchedAmountMinor: number | null;
  mismatchedCurrency: string | null;
  approved: boolean;
  bankCreatedAt: string | null;
  openedAt: string | null;
  triedAt: string | null;
  failedAt: string | null;
  paidAt: string | null;
  refusedAt: string | null;
}

export interface MetricsPayout {
  invoiceId: string;
  state: PayoutState;
  foundAt: string;
  feeMinor: number | null;
  feeCurrency: string | null;
  amountMinor: number | null;
  currency: string | null;
}

// An invoice's or a run's approval request, with no terms and no names. owner is
// the invoice or the run, and signoffs are the times of its signoffs in order.
export interface MetricsRequest {
  id: number;
  owner: string;
  state: ApprovalState;
  requestedAt: string | null;
  expiresAt: string | null;
  needed: number;
  signoffs: string[];
}

export interface MetricsOutage {
  id: number;
  currency: string;
  method: string;
  codes: string;
  state: string;
  declaredAt: string;
  endedAt: string | null;
  payees: number;
  // Hold rows by what they hold, without counted.
  held: Record<string, number>;
}

export interface MetricsRead {
  startedAt: string | null;
  obligations: MetricsObligation[];
  attempts: MetricsAttempt[];
  payouts: MetricsPayout[];
  requests: MetricsRequest[];
  runRequests: MetricsRequest[];
  outages: MetricsOutage[];
}

// As SQLite gives them, with 0 or 1 for the booleans.
interface MetricsObligationRow extends Omit<MetricsObligation, "fromRun" | "heldDuplicate"> {
  fromRun: number;
  heldDuplicate: number;
}

interface MetricsAttemptRow extends Omit<MetricsAttempt, "approved"> {
  approved: number;
}

interface MetricsRequestRow {
  id: number;
  owner: string | number;
  state: ApprovalState;
  requestedAt: string | null;
  expiresAt: string | null;
  needed: number;
}

interface MetricsSignoffRow {
  approvalId: number;
  at: string;
}

export class Ledger {
  private readonly db: DatabaseSync;
  // False only for a file opened read-only from before the meta table.
  private readonly hasMeta: boolean;
  // How far runningHashCheck has hashed the ledger's lines, in this process.
  private headProgress: HeadProgress | undefined;
  private readonly reconStore: ReconStore;

  // readOnly opens an existing file as it is, without creating or upgrading it,
  // so a check cannot change what it checks.
  constructor(path: string, readOnly: boolean = false) {
    // The CLI and the web server can have the file open at once, so a write
    // waits for the other instead of failing on the first lock.
    this.db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS, readOnly });
    this.reconStore = new ReconStore(this.db);
    if (readOnly) {
      this.hasMeta =
        (this.db.prepare("PRAGMA table_info(meta)").all() as unknown as ColumnRow[]).length > 0;
      return;
    }
    this.hasMeta = true;
    this.db.exec(SCHEMA);
    this.addColumns();
    this.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('started_at', ?)")
      .run(new Date().toISOString());
    // Failures of transfers created before outages were counted are never
    // counted, however long the bank deadlines are.
    this.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('outages_since', ?)")
      .run(new Date().toISOString());
    this.startChain();
    this.startRunChain();
    this.reconStore.ensure();
  }

  // Under the write lock, so two processes opening an older file at once do not
  // both add a column.
  private addColumns(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let accountKeyAdded: boolean = false;
      let routeKeyAdded: boolean = false;
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
            if (table === "attempts" && name === "account_key") {
              accountKeyAdded = true;
            }
            if (table === "attempts" && name === "route_key") {
              routeKeyAdded = true;
            }
            // A pending attempt with no transfer from before tries were kept may
            // have been tried at any time, so it counts as tried now.
            if (table === "attempts" && name === "tried_at") {
              this.db
                .prepare(
                  "UPDATE attempts SET tried_at = ? WHERE state = 'pending' AND transfer_id IS NULL",
                )
                .run(new Date().toISOString());
            }
            const notKnown: string | undefined = TIME_NOT_KNOWN[`${table}.${name}`];
            if (notKnown !== undefined) {
              this.db.exec(notKnown);
            }
          }
        }
      }
      this.db.exec(TIME_TRIGGERS);
      // Once every column is there, in the same write lock as the column add.
      if (accountKeyAdded) {
        this.backfillAccountKeys();
      }
      if (routeKeyAdded) {
        this.backfillRoutes();
      }
      this.db.exec("COMMIT");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // An attempt from before account_key keeps the account something checked when
  // it was sent: the accountKey in the terms of the approval it was opened on
  // (approval_id), else of the used approval of its invoice for the same kind of
  // payment that a person approved before the attempt was opened and after the
  // invoice's attempt before it, else, for a released pay run row's original, the
  // account the run approved. Never the invoice's latest approval as such. Any
  // other went out unchecked, so it never counts as the account PayOnce last
  // paid, and its supplier counts as paid before with the account not confirmed
  // (lastPaidUnchecked). Only inside addColumns' transaction.
  private backfillAccountKeys(): void {
    this.db.exec(
      `UPDATE attempts SET account_key =
         (SELECT json_extract(approvals.terms, '$.accountKey') FROM approvals
           WHERE approvals.id = attempts.approval_id)
       WHERE approval_id IS NOT NULL`,
    );
    const all: UnkeyedAttempt[] = this.db
      .prepare("SELECT request_id, invoice_id, kind, opened_at, reference FROM attempts ORDER BY rowid")
      .all() as unknown as UnkeyedAttempt[];
    const unkeyed: UnkeyedAttempt[] = this.db
      .prepare(
        `SELECT request_id, invoice_id, kind, opened_at, reference FROM attempts
          WHERE account_key IS NULL AND approval_id IS NULL ORDER BY rowid`,
      )
      .all() as unknown as UnkeyedAttempt[];
    const usedApprovals = this.db.prepare(
      `SELECT json_extract(approvals.terms, '$.accountKey') AS account_key,
              (SELECT max(signoffs.at) FROM signoffs WHERE signoffs.approval_id = approvals.id) AS approved_at
         FROM approvals
        WHERE approvals.invoice_id = ? AND approvals.state = 'used'
          AND json_extract(approvals.terms, '$.action') = ?`,
    );
    const setKey = this.db.prepare("UPDATE attempts SET account_key = ? WHERE request_id = ?");
    for (const attempt of unkeyed) {
      const at: number = this.openedAround(attempt);
      if (Number.isNaN(at)) {
        continue;
      }
      const index: number = all.findIndex((other: UnkeyedAttempt): boolean => other.request_id === attempt.request_id);
      const before: UnkeyedAttempt | undefined = all
        .slice(0, index)
        .filter((other: UnkeyedAttempt): boolean => other.invoice_id === attempt.invoice_id)
        .at(-1);
      const after: number = before === undefined ? Number.NaN : this.openedAround(before);
      const used: UsedApproval | undefined = (
        usedApprovals.all(
          attempt.invoice_id,
          attempt.kind === "replacement" ? "replace" : "pay",
        ) as unknown as UsedApproval[]
      )
        .map((approval: UsedApproval): UsedApproval & { at: number } => ({
          ...approval,
          at: Date.parse(approval.approved_at ?? ""),
        }))
        .filter(
          (approval: UsedApproval & { at: number }): boolean =>
            approval.at <= at && (Number.isNaN(after) || approval.at > after),
        )
        .sort((a: { at: number }, b: { at: number }): number => a.at - b.at)
        .at(-1);
      if (typeof used?.account_key === "string") {
        setKey.run(used.account_key, attempt.request_id);
      }
    }
    this.db.exec(
      `UPDATE attempts SET account_key =
         (SELECT run_rows.account_key FROM obligations
            JOIN run_rows ON run_rows.id = obligations.run_row_id
           WHERE obligations.invoice_id = attempts.invoice_id)
       WHERE account_key IS NULL AND approval_id IS NULL AND kind = 'original'`,
    );
  }

  // An accountKey kept before routeKeys were gets one from the bank details a
  // callback kept: the record it read before the change, or the record after it
  // (applied_key), whichever has that accountKey. Attempts, where they went, run
  // rows and payouts sent outside PayOnce alike. Any other keeps none and is
  // compared by accountKey, as before. Only inside addColumns' transaction.
  private backfillRoutes(): void {
    const routes: Map<string, string> = this.callbackRoutes();
    const pairs: [string, string, string][] = [
      ["attempts", "account_key", "route_key"],
      ["attempts", "sent_key", "sent_route"],
      ["outside_payouts", "sent_key", "sent_route"],
      ["run_rows", "account_key", "route_key"],
    ];
    for (const [table, full, route] of pairs) {
      const set: StatementSync = this.db.prepare(
        `UPDATE ${table} SET ${route} = ? WHERE ${full} = ? AND ${route} IS NULL`,
      );
      for (const [key, value] of routes) {
        set.run(value, key);
      }
    }
  }

  // The accountKey and routeKey of every set of bank details a callback kept.
  private callbackRoutes(): Map<string, string> {
    const routes: Map<string, string> = new Map<string, string>();
    const rows = this.db
      .prepare("SELECT applied_key, old_details FROM bank_changes")
      .all() as unknown as { applied_key: string | null; old_details: string | null }[];
    for (const row of rows) {
      if (row.applied_key !== null) {
        const route: string | null = routeOfDetailsKey(row.applied_key);
        if (route !== null) {
          routes.set(keyHash(row.applied_key), route);
        }
      }
      const before: unknown = row.old_details === null ? null : parsedOf(row.old_details);
      if (before !== null && typeof before === "object" && !Array.isArray(before)) {
        const details: TransferBankDetails = before as TransferBankDetails;
        routes.set(keyHash(bankDetailsKey(details)), routeKeyOf(details));
      }
    }
    return routes;
  }

  // Every accountKey the ledger keeps with the routeKey of the same details: from
  // attempts, where they went, run rows, payouts sent outside PayOnce, approval
  // requests and the details callbacks kept. The supplier view groups accounts through it, so an
  // approval's accountKey joins the account its details go to.
  accountRoutes(): Map<string, string> {
    const routes: Map<string, string> = this.callbackRoutes();
    const rows = this.db
      .prepare(
        `SELECT account_key AS full, route_key AS route FROM attempts WHERE account_key IS NOT NULL AND route_key IS NOT NULL
          UNION SELECT sent_key, sent_route FROM attempts WHERE sent_key IS NOT NULL AND sent_route IS NOT NULL
          UNION SELECT sent_key, sent_route FROM outside_payouts WHERE sent_key IS NOT NULL AND sent_route IS NOT NULL
          UNION SELECT account_key, route_key FROM run_rows WHERE account_key IS NOT NULL AND route_key IS NOT NULL
          UNION SELECT json_extract(terms, '$.accountKey'), route_key FROM approvals
                 WHERE route_key IS NOT NULL
                   AND CASE WHEN json_valid(terms) THEN json_type(terms, '$.accountKey') = 'text' ELSE 0 END`,
      )
      .all() as unknown as { full: string; route: string }[];
    for (const row of rows) {
      routes.set(row.full, row.route);
    }
    return routes;
  }

  // When an attempt from before account_key was opened: opened_at, or else when
  // the timeline first says it was sent, which comes just after. NaN when neither
  // is on file.
  private openedAround(attempt: UnkeyedAttempt): number {
    if (attempt.opened_at !== null) {
      return Date.parse(attempt.opened_at);
    }
    if (attempt.reference === null) {
      return Number.NaN;
    }
    const sent: string = `${attempt.kind === "replacement" ? "Replacement" : "Original"} ${attempt.reference} sent:`;
    const row: { at: string | null } | undefined = this.db
      .prepare("SELECT min(at) AS at FROM events WHERE invoice_id = ? AND substr(message, 1, ?) = ?")
      .get(attempt.invoice_id, sent.length, sent) as unknown as { at: string | null } | undefined;
    return Date.parse(row?.at ?? "");
  }

  // True once the timeline is a hash chain: any record of the chain in meta, or
  // any line with a hash, counts. A file opened read-only from before the chain
  // has no hash column, and one from before meta has no meta table.
  chainStarted(): boolean {
    const hashColumn: boolean = (
      this.db.prepare("PRAGMA table_info(events)").all() as unknown as ColumnRow[]
    ).some((column: ColumnRow): boolean => column.name === "hash");
    return (
      this.metaValue(CHAIN_STARTED_KEY) !== null ||
      this.metaValue(BACKFILLED_THROUGH_KEY) !== null ||
      this.metaValue(LEDGER_HEAD_KEY) !== null ||
      this.metaValue(LEDGER_RESTARTED_KEY) !== null ||
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
      this.metaValue(RUN_RESTARTED_KEY) !== null ||
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

  // The tables in SCHEMA and the columns in ADDED_COLUMNS this file lacks, as
  // "table" or "table.column". It only reads, so a read-only open can tell a
  // ledger an older PayOnce wrote, which a reader must not upgrade.
  schemaGaps(): string[] {
    const columnsOf = (table: string): string[] =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnRow[]).map(
        (column: ColumnRow): string => column.name,
      );
    const gaps: string[] = [];
    for (const match of SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) {
      const table: string = match[1] ?? "";
      if (columnsOf(table).length === 0) {
        gaps.push(table);
      }
    }
    for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
      const existing: string[] = columnsOf(table);
      if (existing.length === 0) {
        continue;
      }
      for (const name of Object.keys(columns)) {
        if (!existing.includes(name)) {
          gaps.push(`${table}.${name}`);
        }
      }
    }
    return gaps;
  }

  close(): void {
    this.db.close();
  }

  // Reconciliation's tables and chain, on this connection. It reads the ledger's
  // own tables only to match transfers, and writes none of them.
  recon(): ReconStore {
    return this.reconStore;
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
    if (!this.hasMeta) {
      return null;
    }
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

  // When this ledger first counted failures toward outages, as an ISO time.
  outagesSince(): string {
    return this.metaValue("outages_since") ?? this.startedAt();
  }

  // The outage on a rail, while it is active. Inside a transaction this reads
  // under the write lock, so no declaration can land between it and what follows.
  activeOutage(currency: string, method: string): Outage | undefined {
    const row: OutageRow | undefined = this.db
      .prepare("SELECT * FROM outages WHERE currency = ? AND method = ? AND state = 'active'")
      .get(currency.toUpperCase(), method.toUpperCase()) as unknown as OutageRow | undefined;
    return row === undefined ? undefined : toOutage(row);
  }

  outage(id: number): Outage | undefined {
    const row: OutageRow | undefined = this.db
      .prepare("SELECT * FROM outages WHERE id = ?")
      .get(id) as unknown as OutageRow | undefined;
    return row === undefined ? undefined : toOutage(row);
  }

  // Newest first.
  outages(): Outage[] {
    return (
      this.db.prepare("SELECT * FROM outages ORDER BY id DESC").all() as unknown as OutageRow[]
    ).map(toOutage);
  }

  outageHolds(outageId: number): OutageHold[] {
    return (
      this.db
        .prepare("SELECT * FROM outage_holds WHERE outage_id = ? ORDER BY rowid")
        .all(outageId) as unknown as OutageHoldRow[]
    ).map(
      (row: OutageHoldRow): OutageHold => ({
        outageId: row.outage_id,
        invoiceId: row.invoice_id,
        runId: row.run_id,
        what: row.what,
        heldAt: row.held_at,
      }),
    );
  }

  railFailure(transferId: string): RailFailure | undefined {
    const row: RailFailureRow | undefined = this.db
      .prepare("SELECT * FROM rail_failures WHERE transfer_id = ?")
      .get(transferId) as unknown as RailFailureRow | undefined;
    return row === undefined ? undefined : toRailFailure(row);
  }

  // Records a failure on a rail, once per transfer, and declares an outage on the
  // rail when count.failures different payees failed in the window (dated by
  // failed_at, or seen_at on rows from before that column), counted
  // from the end of the rail's last outage at the earliest, so the failures one
  // outage counted never declare the next. One write transaction, so two
  // processes that read the same failures declare one outage between them. The
  // outage's first line, from line, goes on the timeline of each invoice whose
  // failure it counted in the same transaction. Returns the outage this failure
  // declared, if any.
  recordRailFailure(
    failure: NewRailFailure,
    count: OutageCount,
    line: (outage: Outage, counted: RailFailure[]) => string,
  ): Outage | undefined {
    return this.transaction((): Outage | undefined => {
      const now: number = Date.now();
      const currency: string = failure.currency.toUpperCase();
      const method: string = failure.method.toUpperCase();
      const inserted: { changes: number | bigint } = this.db
        .prepare(
          `INSERT OR IGNORE INTO rail_failures
             (transfer_id, currency, method, code, payee, reference, invoice_id, origin,
              created_at, seen_at, seen_by, failed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          failure.transferId,
          currency,
          method,
          failure.code,
          failure.payee,
          failure.reference,
          failure.invoiceId,
          failure.origin,
          failure.createdAt,
          new Date(now).toISOString(),
          failure.seenBy,
          failure.failedAt,
        );
      if (Number(inserted.changes) !== 1 || this.activeOutage(currency, method) !== undefined) {
        return undefined;
      }
      const ended: { at: string | null } = this.db
        .prepare("SELECT MAX(ended_at) AS at FROM outages WHERE currency = ? AND method = ?")
        .get(currency, method) as unknown as { at: string | null };
      const windowStart: string = new Date(now - count.windowMinutes * 60_000).toISOString();
      const since: string = ended.at !== null && ended.at > windowStart ? ended.at : windowStart;
      const counted: RailFailure[] = (
        this.db
          .prepare(
            `SELECT * FROM rail_failures
              WHERE currency = ? AND method = ? AND COALESCE(failed_at, seen_at) > ?
              ORDER BY COALESCE(failed_at, seen_at), rowid`,
          )
          .all(currency, method, since) as unknown as RailFailureRow[]
      ).map(toRailFailure);
      const payees: number = new Set(counted.map((entry: RailFailure): string => entry.payee)).size;
      if (payees < count.failures) {
        return undefined;
      }
      const codes: string[] = [...new Set(counted.map((entry: RailFailure): string => entry.code))].sort();
      const declared: { lastInsertRowid: number | bigint } = this.db
        .prepare(
          `INSERT INTO outages
             (currency, method, codes, declared_at, payees, threshold, window_minutes, counted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          currency,
          method,
          JSON.stringify(codes),
          new Date(now).toISOString(),
          payees,
          count.failures,
          count.windowMinutes,
          JSON.stringify(counted.map((entry: RailFailure): string => entry.transferId)),
        );
      const outage: Outage | undefined = this.outage(Number(declared.lastInsertRowid));
      if (outage === undefined) {
        throw new Error("The outage just declared could not be read back");
      }
      const text: string = line(outage, counted);
      for (const invoiceId of new Set(counted.map((entry: RailFailure): string | null => entry.invoiceId))) {
        if (invoiceId === null || this.obligation(invoiceId) === undefined) {
          continue;
        }
        this.db
          .prepare(
            `INSERT OR IGNORE INTO outage_holds (outage_id, invoice_id, what, held_at)
             VALUES (?, ?, 'counted', ?)`,
          )
          .run(outage.id, invoiceId, new Date(now).toISOString());
        this.appendEvent(invoiceId, "outage", text, null);
      }
      return outage;
    });
  }

  // Records that an active outage held an invoice or a run, and puts line on its
  // timeline the first time, then standing, if given and wanted, in one
  // transaction. False when the outage has ended meanwhile, so neither line ever
  // lands after the end.
  holdForOutage(
    outageId: number,
    subject: OutageSubject,
    what: OutageHoldKind,
    line: string,
    standing: StandingLine | null = null,
  ): boolean {
    return this.transaction((): boolean => {
      if (this.db.prepare("SELECT 1 FROM outages WHERE id = ? AND state = 'active'").get(outageId) === undefined) {
        return false;
      }
      const held: boolean = this.insertHold(outageId, subject, what, new Date().toISOString());
      if ("invoiceId" in subject) {
        if (held) {
          this.appendEvent(subject.invoiceId, "outage", line, null);
        }
        if (standing !== null && standing.wanted(this.events(subject.invoiceId))) {
          this.appendEvent(subject.invoiceId, standing.kind, standing.message, standing.topic);
        }
      } else {
        if (held) {
          this.addRunEventRow(subject.runId, "outage", line, null);
        }
        if (standing !== null && standing.wanted(this.runEvents(subject.runId))) {
          this.addRunEventRow(subject.runId, standing.kind, standing.message, standing.topic);
        }
      }
      return true;
    });
  }

  // One hold per outage per invoice or run. True when this one is new, or when it
  // turns an invoice's counted hold (its own failure was counted) into what the
  // outage now holds of it, so that hold's line is written too. The caller holds
  // the write transaction.
  private insertHold(outageId: number, subject: OutageSubject, what: OutageHoldKind, at: string): boolean {
    const held: { changes: number | bigint } =
      "invoiceId" in subject
        ? this.db
            .prepare(
              `INSERT OR IGNORE INTO outage_holds (outage_id, invoice_id, what, held_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(outageId, subject.invoiceId, what, at)
        : this.db
            .prepare(
              `INSERT OR IGNORE INTO outage_holds (outage_id, run_id, what, held_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(outageId, subject.runId, what, at);
    if (Number(held.changes) === 1) {
      return true;
    }
    if (what === "counted" || !("invoiceId" in subject)) {
      return false;
    }
    const upgraded: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE outage_holds SET what = ?, held_at = ?
          WHERE outage_id = ? AND invoice_id = ? AND what = 'counted'`,
      )
      .run(what, at, outageId, subject.invoiceId);
    return Number(upgraded.changes) === 1;
  }

  // A person ends an active outage. One transaction records a hold for each
  // invoice and run listed (what the board shows as held, read while the outage
  // is still active and under the write lock), writes who and why, puts the end
  // line on every invoice and run it held, and makes each held invoice's next
  // look due now, so a watcher in any process picks it up. Undefined, with
  // nothing changed, when the outage is not active.
  endOutage(
    id: number,
    endedBy: string,
    note: string,
    invoiceLine: (outage: Outage, state: ObligationState | null) => string,
    runLine: (outage: Outage) => string,
    listed: (outage: Outage) => OutageSubjectHeld[] = (): OutageSubjectHeld[] => [],
  ): OutageHold[] | undefined {
    return this.transaction((): OutageHold[] | undefined => {
      const now: string = new Date().toISOString();
      const active: Outage | undefined = this.outage(id);
      if (active?.state !== "active") {
        return undefined;
      }
      for (const held of listed(active)) {
        this.insertHold(id, held.subject, held.what, now);
      }
      const ended: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE outages SET state = 'ended', ended_at = ?, ended_by = ?, end_note = ?
            WHERE id = ? AND state = 'active'`,
        )
        .run(now, endedBy, note, id);
      const outage: Outage | undefined = this.outage(id);
      if (Number(ended.changes) !== 1 || outage === undefined) {
        return undefined;
      }
      const holds: OutageHold[] = this.outageHolds(id);
      for (const hold of holds) {
        if (hold.invoiceId !== null) {
          this.appendEvent(
            hold.invoiceId,
            "outage",
            invoiceLine(outage, this.obligation(hold.invoiceId)?.state ?? null),
            null,
          );
          this.db
            .prepare(
              `UPDATE obligations SET look_at = ?
                WHERE invoice_id = ? AND state IN ('open', 'escalated')`,
            )
            .run(now, hold.invoiceId);
        } else if (hold.runId !== null) {
          this.addRunEventRow(hold.runId, "outage", runLine(outage), null);
        }
      }
      return holds;
    });
  }

  // Writes the invoice and its first timeline line in one transaction, so every
  // invoice has a line from the moment it exists, and an audit that finds one
  // with none knows its lines were removed.
  openObligation(input: NewObligation): Obligation {
    this.transaction((): void => {
      const opened: { changes: number | bigint } = this.db
        .prepare(
          `INSERT OR IGNORE INTO obligations
             (invoice_id, supplier, supplier_domain, beneficiary_id, currency,
              amount_minor, transfer_method, invoice_floor_minor, started_by,
              supplier_phone, source_currency, due_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.dueDate ?? null,
        );
      if (Number(opened.changes) === 1) {
        this.appendEvent(
          input.invoiceId,
          "payment",
          input.startedBy === null ? "Incident opened" : `Incident opened by ${input.startedBy}`,
          null,
        );
      }
    });
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

  // The invoices that are not closed, newest first: the ones the board lists.
  openObligations(): Obligation[] {
    return (
      this.db
        .prepare("SELECT * FROM obligations WHERE state IN ('open', 'escalated') ORDER BY rowid DESC")
        .all() as unknown as ObligationRow[]
    ).map(toObligation);
  }

  // The invoices that pay one beneficiary record, newest first.
  obligationsFor(beneficiaryId: string): Obligation[] {
    return (
      this.db
        .prepare("SELECT * FROM obligations WHERE beneficiary_id = ? ORDER BY rowid DESC")
        .all(beneficiaryId) as unknown as ObligationRow[]
    ).map(toObligation);
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
      // A timeline line is one line, whatever name, note or Airwallex text it holds.
      message: storable(oneLine(message)),
      topic: topic === null ? null : storable(topic),
    };
    const hash: string = eventHash(prevHash, line);
    const inserted: { lastInsertRowid: number | bigint } = this.db
      .prepare(
        `INSERT INTO events (invoice_id, at, kind, message, topic, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(line.invoiceId, line.at, line.kind, line.message, line.topic, prevHash, hash);
    this.chainHead(LEDGER_HEAD_KEY, LEDGER_RESTARTED_KEY, hash, line.at, Number(inserted.lastInsertRowid), invoice);
  }

  // Adds a line's hash to a running hash. Every chain sets its running hash when
  // it starts, so a missing one was removed. The line is still written, because a
  // payment step must never fail for want of a hash: the running hash starts
  // again from the genesis, and the first restart is kept in meta, with the time
  // and the line, so every audit reports it from then on. The caller holds the
  // write transaction.
  private chainHead(headKey: string, restartKey: string, hash: string, at: string, id: number, of: string): void {
    const head: string | null = this.metaValue(headKey);
    if (head === null) {
      this.db
        .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
        .run(restartKey, restartRecord(at, id, of));
    }
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(headKey, nextLedgerHead(head ?? GENESIS, hash));
  }

  // Runs fn in one deferred read transaction, so every read in it sees the ledger
  // as it was at one moment, whatever another process writes meanwhile. It works
  // on a read-only ledger. fn must only read, and must not open a transaction.
  readSnapshot<T>(fn: () => T): T {
    if (this.db.isTransaction) {
      throw new Error("A ledger transaction is already open");
    }
    this.db.exec("BEGIN");
    try {
      const result: T = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Changes whenever this connection writes or another connection commits, for a
  // cache of what was read. Writes nothing.
  changeStamp(): string {
    const version: { data_version: number } = this.db.prepare("PRAGMA data_version").get() as unknown as {
      data_version: number;
    };
    const changes: { n: number } = this.db.prepare("SELECT total_changes() AS n").get() as unknown as { n: number };
    return `${version.data_version}:${changes.n}`;
  }

  // Everything the metrics read, one query per table, with only the columns they
  // use: no names, notes, references, facts or email text, of an approval's terms
  // only its quote's sell amount, a number compared in SQL, and of the timeline
  // only each invoice's first line's time and its latest closed line's.
  // It only reads, so it runs inside readSnapshot. Stored JSON is read only inside
  // CASE WHEN json_valid(...), because SQLite evaluates both sides of an AND and a
  // JSON function throws on text that is not JSON.
  metricsRead(): MetricsRead {
    const obligations: MetricsObligation[] = (
      this.db
        .prepare(
          `SELECT o.invoice_id AS invoiceId, o.currency, COALESCE(o.source_currency, o.currency) AS wallet,
                  o.amount_minor AS amountMinor, o.state, o.origin, o.run_row_id IS NOT NULL AS fromRun,
                  o.transfer_method AS transferMethod, o.escalation_reason AS escalationReason,
                  CASE WHEN json_valid(o.duplicate_of) THEN json_array_length(o.duplicate_of) > 0 ELSE 0 END
                    AS heldDuplicate,
                  o.escalated_at AS escalatedAt,
                  (SELECT at FROM events WHERE events.invoice_id = o.invoice_id ORDER BY id LIMIT 1) AS startedAt,
                  CASE WHEN o.state IN ('settled', 'rejected') THEN
                    (SELECT at FROM events WHERE events.invoice_id = o.invoice_id AND kind = 'closed'
                      ORDER BY id DESC LIMIT 1)
                  END AS closedAt
             FROM obligations o ORDER BY o.rowid`,
        )
        .all() as unknown as MetricsObligationRow[]
    ).map(
      (row: MetricsObligationRow): MetricsObligation => ({
        ...row,
        fromRun: row.fromRun === 1,
        heldDuplicate: row.heldDuplicate === 1,
      }),
    );
    const attempts: MetricsAttempt[] = (
      this.db
        .prepare(
          `SELECT a.invoice_id AS invoiceId, a.kind, a.transfer_id AS transferId, a.state,
                  a.failure_code AS failureCode, a.fee_minor AS feeMinor, a.fee_currency AS feeCurrency,
                  a.amount_minor AS amountMinor, a.currency,
                  CASE WHEN a.amount_minor IS NULL AND a.quote_id IS NOT NULL THEN
                    (SELECT CASE WHEN json_valid(ap.terms) THEN
                              CASE WHEN json_type(ap.terms, '$.fx.sellAmountMinor') = 'integer'
                                    AND json_extract(ap.terms, '$.fx.quoteId') IS a.quote_id
                                    AND json_extract(ap.terms, '$.fx.sellCurrency')
                                        IS COALESCE(o.source_currency, o.currency)
                                   THEN json_extract(ap.terms, '$.fx.sellAmountMinor') END
                            END
                       FROM approvals ap
                      WHERE ap.id = COALESCE(a.approval_id,
                              (SELECT MAX(id) FROM approvals WHERE approvals.invoice_id = a.invoice_id)))
                  END AS quoteAmountMinor,
                  a.mismatched_amount_minor AS mismatchedAmountMinor, a.mismatched_currency AS mismatchedCurrency,
                  a.approval_id IS NOT NULL AS approved,
                  a.bank_created_at AS bankCreatedAt, a.bank_status AS bankStatus, a.found_late_at AS foundLateAt,
                  a.mismatched_transfer_id AS mismatchedTransferId, a.mismatched_status AS mismatchedStatus,
                  a.opened_at AS openedAt, a.tried_at AS triedAt, a.failed_at AS failedAt, a.paid_at AS paidAt,
                  a.refused_at AS refusedAt
             FROM attempts a LEFT JOIN obligations o ON o.invoice_id = a.invoice_id ORDER BY a.rowid`,
        )
        .all() as unknown as MetricsAttemptRow[]
    ).map((row: MetricsAttemptRow): MetricsAttempt => ({ ...row, approved: row.approved === 1 }));
    const payouts: MetricsPayout[] = this.db
      .prepare(
        `SELECT invoice_id AS invoiceId, state, found_at AS foundAt, fee_minor AS feeMinor,
                fee_currency AS feeCurrency, amount_minor AS amountMinor, currency
           FROM outside_payouts ORDER BY rowid`,
      )
      .all() as unknown as MetricsPayout[];
    const requestsOf = (requests: string, signoffs: string, owner: string): MetricsRequest[] => {
      const times: Map<number, string[]> = new Map();
      for (const row of this.db
        .prepare(`SELECT approval_id AS approvalId, at FROM ${signoffs} ORDER BY approval_id, at, rowid`)
        .all() as unknown as MetricsSignoffRow[]) {
        const list: string[] = times.get(row.approvalId) ?? [];
        list.push(row.at);
        times.set(row.approvalId, list);
      }
      return (
        this.db
          .prepare(
            `SELECT id, ${owner} AS owner, state, requested_at AS requestedAt, expires_at AS expiresAt, needed
               FROM ${requests} ORDER BY id`,
          )
          .all() as unknown as MetricsRequestRow[]
      ).map(
        (row: MetricsRequestRow): MetricsRequest => ({
          ...row,
          owner: String(row.owner),
          signoffs: times.get(row.id) ?? [],
        }),
      );
    };
    const held: Map<number, Record<string, number>> = new Map();
    for (const row of this.db
      .prepare(
        `SELECT outage_id AS outageId, what, COUNT(*) AS n FROM outage_holds
          WHERE what <> 'counted' GROUP BY outage_id, what`,
      )
      .all() as unknown as { outageId: number; what: string; n: number }[]) {
      held.set(row.outageId, { ...held.get(row.outageId), [row.what]: row.n });
    }
    const outages: MetricsOutage[] = (
      this.db
        .prepare(
          `SELECT id, currency, method, codes, state, declared_at AS declaredAt, ended_at AS endedAt, payees
             FROM outages ORDER BY id`,
        )
        .all() as unknown as Omit<MetricsOutage, "held">[]
    ).map((row: Omit<MetricsOutage, "held">): MetricsOutage => ({ ...row, held: held.get(row.id) ?? {} }));
    return {
      startedAt: this.metaValue("started_at"),
      obligations,
      attempts,
      payouts,
      requests: requestsOf("approvals", "signoffs", "invoice_id"),
      runRequests: requestsOf("run_approvals", "run_signoffs", "run_id"),
      outages,
    };
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
        restarted: restartOf(this.metaValue(LEDGER_RESTARTED_KEY)),
        unlined: this.unlinedInvoices(),
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

  // Every invoice with no timeline line, in the order written. Each invoice gets
  // one in the transaction that writes it, so one with none lost its lines.
  unlinedInvoices(): string[] {
    return (
      this.db
        .prepare(
          `SELECT invoice_id FROM obligations o
            WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.invoice_id = o.invoice_id)
            ORDER BY rowid`,
        )
        .all() as unknown as { invoice_id: string }[]
    ).map((row: { invoice_id: string }): string => row.invoice_id);
  }

  // Every run with no run line. A run's upload line follows the transaction that
  // writes the run, with nothing awaited between them.
  unlinedRuns(): number[] {
    if (!this.hasRunTable()) {
      return [];
    }
    return (
      this.db
        .prepare(
          `SELECT id FROM runs r
            WHERE NOT EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = r.id)
            ORDER BY id`,
        )
        .all() as unknown as { id: number }[]
    ).map((row: { id: number }): number => row.id);
  }

  // The invoice's first timeline line, without reading the rest.
  firstEvent(invoiceId: string): LedgerEvent | undefined {
    return this.db
      .prepare(
        "SELECT id, at, kind, message, topic FROM events WHERE invoice_id = ? ORDER BY id LIMIT 1",
      )
      .get(invoiceId) as unknown as LedgerEvent | undefined;
  }

  // One invoice's timeline with its hashes, for the page's audit line.
  chainedEvents(invoiceId: string): ChainedEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM events WHERE invoice_id = ? ORDER BY id")
        .all(invoiceId) as unknown as EventRow[]
    ).map(toChainedEvent);
  }

  // Each invoice's latest decision, close or standing line, for the incident list.
  // Each lookup walks back from the invoice's last line on events_by_invoice, so
  // the list does not read every timeline.
  headlines(): Map<string, string> {
    const rows: { invoice_id: string; message: string | null }[] = this.db
      .prepare(
        `SELECT invoice_id,
                (SELECT message FROM events
                  WHERE events.invoice_id = obligations.invoice_id AND ${HEADLINE_LINE}
                  ORDER BY id DESC LIMIT 1) AS message
           FROM obligations`,
      )
      .all() as unknown as { invoice_id: string; message: string | null }[];
    const headlines: Map<string, string> = new Map<string, string>();
    for (const row of rows) {
      if (row.message !== null) {
        headlines.set(row.invoice_id, row.message);
      }
    }
    return headlines;
  }

  // The run each invoice from a pay run was released from.
  runIdsByInvoice(): Map<string, number> {
    const rows: { invoice_id: string; run_id: number }[] = this.db
      .prepare(
        `SELECT obligations.invoice_id, run_rows.run_id FROM obligations
           JOIN run_rows ON run_rows.id = obligations.run_row_id`,
      )
      .all() as unknown as { invoice_id: string; run_id: number }[];
    return new Map(rows.map((row): [string, number] => [row.invoice_id, row.run_id]));
  }

  // Every attempt that may still be with the bank, from any invoice: more than
  // withBank takes, never fewer, so the incident list tests them in code without
  // reading each invoice's attempts. A paid attempt, and a failed one with no
  // transfer or one the bank failed, are left out.
  attemptsMaybeWithBank(): Attempt[] {
    const rows: AttemptRow[] = this.db
      .prepare(
        `SELECT * FROM attempts
          WHERE state <> 'paid'
            AND (state <> 'failed'
              OR (transfer_id IS NOT NULL AND (bank_status IS NULL OR bank_status NOT IN (${FAILED_IN_SQL}))))
          ORDER BY rowid`,
      )
      .all() as unknown as AttemptRow[];
    return rows.map(toAttempt);
  }

  // The invoices with a payout sent outside PayOnce in flight.
  invoicesWithPayoutInFlight(): Set<string> {
    const rows: { invoice_id: string }[] = this.db
      .prepare("SELECT DISTINCT invoice_id FROM outside_payouts WHERE state = 'in_flight'")
      .all() as unknown as { invoice_id: string }[];
    return new Set(rows.map((row: { invoice_id: string }): string => row.invoice_id));
  }

  // Whether the running hash matches every line in the ledger, as auditSnapshot and
  // ledgerReport check it, without hashing every line on every look at an invoice.
  // It hashes only the lines added since the last check in this process, and every
  // line again once a minute, as the alert loop's audit check does, so a line
  // rewritten or removed in the middle is caught within a minute. The last line it
  // hashed is read again each time, so lines removed from the end are caught at
  // once: ids are never reused, so its hash then reads as missing.
  runningHashCheck(now: number = Date.now()): LedgerReport {
    this.db.exec("BEGIN");
    try {
      let progress: HeadProgress | undefined = this.headProgress;
      if (progress !== undefined && now - progress.fullAt >= FULL_HEAD_CHECK_MS) {
        progress = undefined;
      }
      if (progress !== undefined && progress.throughId > 0) {
        const last: HashRow | undefined = this.db
          .prepare("SELECT hash FROM events WHERE id = ?")
          .get(progress.throughId) as unknown as HashRow | undefined;
        if (last === undefined || last.hash !== progress.lastHash) {
          progress = undefined;
        }
      }
      const from: HeadProgress = progress ?? {
        throughId: 0,
        lines: 0,
        lastHash: null,
        computed: GENESIS,
        invoices: new Set<string>(),
        fullAt: now,
      };
      const rows: IdHashRow[] = this.db
        .prepare("SELECT id, invoice_id, hash FROM events WHERE id > ? ORDER BY id")
        .all(from.throughId) as unknown as IdHashRow[];
      let computed: string = from.computed;
      for (const row of rows) {
        if (row.hash !== null) {
          computed = nextLedgerHead(computed, row.hash);
        }
        from.invoices.add(row.invoice_id);
      }
      const last: IdHashRow | undefined = rows.at(-1);
      this.headProgress = {
        throughId: last?.id ?? from.throughId,
        lines: from.lines + rows.length,
        lastHash: last === undefined ? from.lastHash : last.hash,
        computed,
        invoices: from.invoices,
        fullAt: from.fullAt,
      };
      const stored: string | null = this.metaValue(LEDGER_HEAD_KEY);
      const restarted: HeadRestart | null = restartOf(this.metaValue(LEDGER_RESTARTED_KEY));
      const unlined: string[] = this.unlinedInvoices();
      this.db.exec("COMMIT");
      return {
        lines: this.headProgress.lines,
        invoices: from.invoices.size,
        stored,
        computed,
        restarted,
        unlined,
        intact: stored === computed && restarted === null && unlined.length === 0,
      };
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertAttempt(
    requestId: string,
    invoiceId: string,
    kind: AttemptKind,
    approvalId: number | null,
    quote: AttemptQuote | null,
    accountKey: string | null,
    openedAt: string = new Date().toISOString(),
    routeKey: string | null = null,
  ): void {
    // The unique index refuses a second attempt that is not failed. A transfer the
    // ledger keeps failed while the bank has it live refuses one too.
    if (this.db.prepare(LIVE_ATTEMPT).get(invoiceId) !== undefined) {
      throw new DuplicatePaymentError(invoiceId);
    }
    try {
      this.db
        .prepare(
          `INSERT INTO attempts
             (request_id, invoice_id, kind, state, quote_id, quote_valid_to, approval_id, opened_at, account_key,
              route_key)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          requestId,
          invoiceId,
          kind,
          quote?.quoteId ?? null,
          quote?.validTo ?? null,
          approvalId,
          openedAt,
          accountKey,
          routeKey,
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
  // lock, opens nothing. released is the approval that released the payment:
  // the attempt keeps it, and a payment from another currency's wallet keeps the
  // quote in its terms, so a retry sends the same one. Such a payment is opened
  // only on an approval with a quote. The attempt keeps the account it goes to:
  // the one the approval's terms name, or else decided, the one the agent
  // decided on. Every payment the engine opens names one. route is the routeKey
  // of the record the caller just checked holds that account. No payment is
  // opened on a rail with an active outage: RailOutageError rolls the caller's
  // transaction back, so an approval it would have spent stays approved.
  openAttempt(
    invoiceId: string,
    kind: AttemptKind,
    lease: Lease,
    released: number | null,
    decided: string | null,
    route: string | null = null,
  ): Attempt {
    if (!this.db.isTransaction) {
      throw new Error("An attempt is opened only inside a ledger transaction");
    }
    // A caller that leaves either out opens it on no approval, or no account.
    const approvalId: number | null = released ?? null;
    this.requireLease(lease);
    const obligation: Obligation | undefined = this.obligation(invoiceId);
    if (obligation !== undefined && lease.currency !== obligation.sourceCurrency) {
      throw new Error(
        `${invoiceId} is paid from ${obligation.sourceCurrency}, and its payment was about to be opened under the ${lease.currency} lock`,
      );
    }
    const outage: Outage | undefined =
      obligation === undefined ? undefined : this.activeOutage(obligation.currency, obligation.transferMethod);
    if (outage !== undefined) {
      throw new RailOutageError(outage, approvalId === null ? kind : "approved");
    }
    const quote: AttemptQuote | null = approvalId === null ? null : this.approvedQuote(approvalId);
    const key: string | null = approvalId === null ? (decided ?? null) : this.approvedAccountKey(approvalId);
    if (obligation !== undefined && crossCurrency(obligation) && quote === null) {
      throw new Error(
        `${invoiceId} is paid from ${obligation.sourceCurrency}, so PayOnce pays it only on an approved exchange rate quote. Nothing was sent`,
      );
    }
    const requestId: string = randomUUID();
    const openedAt: string = new Date().toISOString();
    this.insertAttempt(requestId, invoiceId, kind, approvalId, quote, key, openedAt, key === null ? null : route);
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
      bankCreatedAt: null,
      bankStatus: null,
      arrival: null,
      openedAt,
      triedAt: null,
      foundLateAt: null,
      mismatchedTransferId: null,
      mismatchedReference: null,
      mismatchedStatus: null,
      mismatchedClearedAt: null,
      mismatchedAmountMinor: null,
      mismatchedCurrency: null,
      accountKey: key,
      routeKey: key === null ? null : route,
    };
  }

  // The account an approval's terms name.
  private approvedAccountKey(approvalId: number): string | null {
    const row: { terms: string } | undefined = this.db
      .prepare("SELECT terms FROM approvals WHERE id = ?")
      .get(approvalId) as unknown as { terms: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.terms) as ApprovalTerms).accountKey;
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
      this.insertAttempt(randomUUID(), invoiceId, "replacement", null, null, null);
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
  // line is the invoice's first timeline line, written in the same transaction,
  // so the invoice is never in the ledger without one.
  adoptPayout(
    input: NewObligation,
    payoutReference: string | null,
    found: FoundPayout,
    line: string,
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
              payout_reference, started_by, supplier_phone, source_currency, look_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outside', ?, ?, ?, ?, ?)`,
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
          // Due at once, so a watcher looks at it even if the step that found it
          // stops before it wakes the invoice.
          new Date().toISOString(),
        );
      this.db
        .prepare(
          `INSERT INTO attempts
             (request_id, invoice_id, kind, transfer_id, reference, state, failure_code,
              fee_minor, fee_currency, amount_minor, currency, sent_key, sent_ending, sent_route)
           VALUES (?, ?, 'original', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          found.sentKey,
          found.sentEnding,
          found.sentRoute,
        );
      this.appendEvent(input.invoiceId, "bank", line, null);
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
  // when it was tied already. What the tie decides is written in the same
  // transaction: a closed invoice is reopened with reopen when that is given, and
  // an open or escalated one gets a look due at once, so a step that stops after
  // the tie, as on a timeline line it could not write, leaves nothing undone.
  linkOutsidePayout(invoiceId: string, payout: OutsidePayout, reopen: string | null = null): boolean {
    return this.transaction((): boolean => {
      const result: { changes: number | bigint } = this.db
        .prepare(
          `INSERT OR IGNORE INTO outside_payouts
             (transfer_id, invoice_id, found_at, reference, state, amount_minor, currency,
              fee_minor, fee_currency, sent_key, sent_ending, sent_route)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          payout.sentKey ?? null,
          payout.sentEnding ?? null,
          payout.sentRoute ?? null,
        );
      if (Number(result.changes) !== 1) {
        return false;
      }
      if (reopen !== null) {
        this.db
          .prepare(
            `UPDATE obligations SET state = 'escalated', escalation_reason = ?
              WHERE invoice_id = ? AND state IN ('settled', 'rejected')`,
          )
          .run(reopen, invoiceId);
      }
      this.lookNow(invoiceId);
      return true;
    });
  }

  // Makes an open or escalated invoice's next look due now, so a watcher in any
  // process looks at it, for a bank fact recorded outside its look.
  lookNow(invoiceId: string): void {
    this.db
      .prepare(
        `UPDATE obligations SET look_at = ?
          WHERE invoice_id = ? AND state IN ('open', 'escalated')`,
      )
      .run(new Date().toISOString(), invoiceId);
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
                fee_currency = COALESCE(?, fee_currency),
                sent_key = COALESCE(?, sent_key), sent_ending = COALESCE(?, sent_ending),
                sent_route = COALESCE(?, sent_route)
          WHERE transfer_id = ?`,
      )
      .run(
        state,
        money.amountMinor,
        money.currency,
        money.feeMinor,
        money.feeCurrency,
        money.sentKey ?? null,
        money.sentEnding ?? null,
        money.sentRoute ?? null,
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

  // A null state leaves the stored state as it is, and a null fee, amount,
  // creation time or bank status the stored one. An attempt the ledger has as
  // failed whose transfer the bank shows live while another payment for the
  // invoice holds the duplicate lock keeps its failed state, so the lock still
  // holds one live payment, and the rest is recorded: bank_status says what the
  // bank shows. Once the lock is free, the next record takes the bank's state, so
  // the lock holds it from then on. A status PayOnce does not know counts as
  // live, so a failed attempt the bank shows in one is recorded in flight.
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
    bankCreatedAt: string | null = null,
    bankStatus: string | null = null,
  ): void {
    const unknownLive: number =
      state === null && bankStatus !== null && !failedStatus(bankStatus) ? 1 : 0;
    const update = (written: AttemptState | null, revive: number): { changes: number | bigint } =>
      this.db
        .prepare(
          `UPDATE attempts
              SET transfer_id = ?, reference = ?,
                  state = COALESCE(?, CASE WHEN state = 'failed' AND ? = 1 THEN 'in_flight' ELSE state END),
                  failure_code = ?, fee_minor = COALESCE(?, fee_minor),
                  fee_currency = COALESCE(?, fee_currency),
                  amount_minor = COALESCE(?, amount_minor), currency = COALESCE(?, currency),
                  bank_created_at = COALESCE(?, bank_created_at),
                  bank_status = COALESCE(?, bank_status)
            WHERE request_id = ?`,
        )
        .run(
          transferId,
          reference,
          written,
          revive,
          failureCode,
          feeMinor,
          feeCurrency,
          amountMinor,
          currency,
          bankCreatedAt,
          bankStatus,
          requestId,
        );
    let result: { changes: number | bigint };
    try {
      result = update(state, unknownLive);
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      result = update(null, 0);
    }
    if (Number(result.changes) !== 1) {
      throw new Error(`No payment attempt has request_id ${requestId}`);
    }
  }

  // Where an attempt's transfer went, as last read, for the supplier view only.
  // Its own write after record, so the duplicate lock's write is untouched, and
  // a value that could not be read keeps the one on file.
  recordSentTo(requestId: string, sentKey: string | null, sentRoute: string | null, sentEnding: string | null): void {
    this.db
      .prepare(
        `UPDATE attempts SET sent_key = COALESCE(?, sent_key), sent_route = COALESCE(?, sent_route),
                sent_ending = COALESCE(?, sent_ending)
          WHERE request_id = ?`,
      )
      .run(sentKey, sentRoute, sentEnding, requestId);
  }

  // Marks an attempt PayOnce had failed with no transfer as one Airwallex now
  // lists a transfer for, before that transfer is recorded on it. False when the
  // attempt has a transfer or is not failed, as when another step recorded it.
  foundLate(requestId: string, at: number): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE attempts SET found_late_at = ?
          WHERE request_id = ? AND state = 'failed' AND transfer_id IS NULL`,
      )
      .run(new Date(at).toISOString(), requestId);
    return Number(result.changes) === 1;
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

  // Written just before each call that creates the attempt's transfer, so a look
  // in another process counts a bank deadline from the latest try.
  tried(requestId: string, at: number): void {
    this.db
      .prepare("UPDATE attempts SET tried_at = ? WHERE request_id = ?")
      .run(new Date(at).toISOString(), requestId);
  }

  // For an attempt that never became a transfer: Airwallex refused to create it
  // (refused, with or without a code), or lists none under its request id long
  // after it was opened. It releases the lock. One a look has since found a
  // transfer for is kept. True when it changed the attempt.
  failAttempt(requestId: string, failureCode: string | null, refused: boolean): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE attempts SET state = 'failed', failure_code = ?, refused_at = ?
          WHERE request_id = ? AND state = 'pending' AND transfer_id IS NULL`,
      )
      .run(failureCode, refused ? new Date().toISOString() : null, requestId);
    return Number(result.changes) === 1;
  }

  escalate(invoiceId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE obligations SET state = 'escalated', escalation_reason = ?
          WHERE invoice_id = ?`,
      )
      .run(reason, invoiceId);
  }

  // Rewords the reason of an invoice that is still escalated with the reason it
  // was read with, so a close or another change from another process meanwhile
  // is left alone. True when it changed it.
  rewordEscalation(invoiceId: string, from: string, to: string): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE obligations SET escalation_reason = ?
          WHERE invoice_id = ? AND state = 'escalated' AND escalation_reason = ?`,
      )
      .run(to, invoiceId, from);
    return Number(result.changes) === 1;
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
    route: string | null = null,
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
              AND NOT EXISTS (${SENT_ATTEMPT}) AND NOT EXISTS (${LIVE_OUTSIDE_PAYOUT})
              AND NOT EXISTS (${LIVE_ATTEMPT})`,
        )
        .run(invoiceId, invoiceId, invoiceId, invoiceId);
      if (Number(used.changes) !== 1 || Number(released.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const attempt: Attempt = this.openAttempt(invoiceId, "original", lease, approvalId, null, route);
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

  // Closes an escalated invoice without paying it, recording who did. False when
  // it is no longer escalated, for example because its payment was released in
  // the meantime, or when a payment for it is live at the bank: PayOnce's, a
  // transfer under one of its request ids, or a payout sent outside PayOnce, in
  // flight or paid. covered lists the transfers under its request ids that do not
  // match it which the person's close covered, and they are cleared in the same
  // transaction, as any open request is voided.
  reject(invoiceId: string, rejectedBy: string, covered: string[] = []): boolean {
    return this.transaction((): boolean => {
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE obligations SET state = 'rejected', rejected_by = ?
            WHERE invoice_id = ? AND state = 'escalated'
              AND NOT EXISTS (${LIVE_OUTSIDE_PAYOUT}) AND NOT EXISTS (${LIVE_ATTEMPT})`,
        )
        .run(rejectedBy, invoiceId, invoiceId, invoiceId);
      if (Number(result.changes) !== 1) {
        return false;
      }
      this.voidOpenApprovals(invoiceId);
      this.clearMismatched(invoiceId, covered);
      return true;
    });
  }

  // Closes again without paying an invoice a person had closed without paying,
  // which a payment found since reopened, once nothing for it is live at the bank,
  // PayOnce's or sent outside it. By itself, PayOnce also leaves it alone while a
  // transfer under one of its request ids that does not match it was found since
  // a person last closed it: only a person (byPerson) clears that, and only the
  // ones their close covered (covered), in the same transaction. False when
  // nothing changed.
  rejectAgain(invoiceId: string, byPerson: boolean = false, covered: string[] = []): boolean {
    return this.transaction((): boolean => {
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE obligations SET state = 'rejected'
            WHERE invoice_id = ? AND state = 'escalated' AND rejected_by IS NOT NULL
              AND NOT EXISTS (${LIVE_ATTEMPT}) AND NOT EXISTS (${LIVE_OUTSIDE_PAYOUT})
              AND (? = 1 OR NOT EXISTS (${UNCLEARED_MISMATCH}))`,
        )
        .run(invoiceId, invoiceId, invoiceId, byPerson ? 1 : 0, invoiceId);
      if (Number(result.changes) !== 1) {
        return false;
      }
      this.voidOpenApprovals(invoiceId);
      this.clearMismatched(invoiceId, covered);
      return true;
    });
  }

  // Ties a transfer Airwallex lists under the request id of an attempt marked
  // failed with none, which does not match its invoice, to that attempt, with what
  // it took from its wallet (debit). False when the attempt already has one, has
  // a transfer, or is not failed. In the same transaction the invoice goes to a
  // person with reason unless it is settled, and gets a look due at once.
  addMismatched(
    requestId: string,
    transferId: string,
    reference: string,
    status: string | null,
    debit: Debit | null,
    reason: string,
  ): boolean {
    return this.transaction((): boolean => {
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE attempts
              SET mismatched_transfer_id = ?, mismatched_reference = ?, mismatched_status = ?,
                  mismatched_amount_minor = ?, mismatched_currency = ?
            WHERE request_id = ? AND state = 'failed' AND transfer_id IS NULL
              AND mismatched_transfer_id IS NULL`,
        )
        .run(transferId, reference, status, debit?.minor ?? null, debit?.currency ?? null, requestId);
      if (Number(result.changes) !== 1) {
        return false;
      }
      const invoice: InvoiceRow | undefined = this.db
        .prepare("SELECT invoice_id FROM attempts WHERE request_id = ?")
        .get(requestId) as unknown as InvoiceRow | undefined;
      if (invoice !== undefined) {
        this.escalateUnlessSettled(invoice.invoice_id, reason);
        this.lookNow(invoice.invoice_id);
      }
      return true;
    });
  }

  // The status a look or the sweep last read for such a transfer, and what it
  // took from its wallet, which a null debit leaves as it is. True when the status
  // changed, and then, in the same transaction, the invoice gets a look due at
  // once.
  setMismatchedStatus(transferId: string, status: string, debit: Debit | null = null): boolean {
    return this.transaction((): boolean => {
      this.db
        .prepare(
          `UPDATE attempts
              SET mismatched_amount_minor = COALESCE(?, mismatched_amount_minor),
                  mismatched_currency = COALESCE(?, mismatched_currency)
            WHERE mismatched_transfer_id = ?`,
        )
        .run(debit?.minor ?? null, debit?.currency ?? null, transferId);
      const changed: InvoiceRow[] = this.db
        .prepare(
          `UPDATE attempts SET mismatched_status = ?
            WHERE mismatched_transfer_id = ? AND mismatched_status IS NOT ?
            RETURNING invoice_id`,
        )
        .all(status, transferId, status) as unknown as InvoiceRow[];
      for (const row of changed) {
        this.lookNow(row.invoice_id);
      }
      return changed.length >= 1;
    });
  }

  // A person closed the invoice over these transfers found under its request ids
  // that did not match it, so they no longer keep it from closing by itself. One
  // found after the close was reviewed is left as it is. The caller holds the
  // write transaction that closes the invoice.
  private clearMismatched(invoiceId: string, transferIds: string[]): void {
    const at: string = new Date().toISOString();
    const clear: StatementSync = this.db.prepare(
      `UPDATE attempts SET mismatched_cleared_at = ?
        WHERE invoice_id = ? AND mismatched_transfer_id = ? AND mismatched_cleared_at IS NULL`,
    );
    for (const transferId of transferIds) {
      clear.run(at, invoiceId, transferId);
    }
  }

  // Sends an open invoice to a person with reason. One already with a person keeps
  // the reason it went there for, and a closed one is left as it is, so a close
  // another process made meanwhile stands. True when the invoice is with a person.
  escalateIfOpen(invoiceId: string, reason: string): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE obligations
            SET escalation_reason = CASE state WHEN 'escalated' THEN escalation_reason ELSE ? END,
                state = 'escalated'
          WHERE invoice_id = ? AND state IN ('open', 'escalated')`,
      )
      .run(reason, invoiceId);
    return Number(result.changes) === 1;
  }

  // Sends an invoice to a person unless it is settled, so a close another process
  // made meanwhile stands.
  escalateUnlessSettled(invoiceId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE obligations SET state = 'escalated', escalation_reason = ?
          WHERE invoice_id = ? AND state <> 'settled'`,
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

  // A fixture thread's emails have the three fields they were written with. An
  // uploaded one has the rest of what PayOnce read from it, and the display name
  // its upload keeps.
  emails(invoiceId: string): SupplierEmail[] {
    const rows: EmailRow[] = this.db
      .prepare(
        `SELECT e.sender, e.subject, e.body, e.inbox_id, i.sender_name, e.reply_to, e.style_text,
                e.attachments, e.notes, e.partial
           FROM emails e LEFT JOIN inbox i ON i.id = e.inbox_id
          WHERE e.invoice_id = ? ORDER BY e.id`,
      )
      .all(invoiceId) as unknown as EmailRow[];
    return rows.map(
      (row: EmailRow): SupplierEmail =>
        row.inbox_id === null
          ? { from: row.sender, subject: row.subject, body: row.body }
          : {
              from: row.sender,
              subject: row.subject,
              body: row.body,
              uploadId: row.inbox_id,
              fromName: row.sender_name ?? "",
              replyTo: JSON.parse(row.reply_to) as string[],
              styleText: row.style_text,
              attachments: JSON.parse(row.attachments) as EmailAttachment[],
              notes: JSON.parse(row.notes) as string[],
              partial: row.partial === 1,
            },
    );
  }

  emailCount(invoiceId: string): number {
    const row: { count: number } = this.db
      .prepare("SELECT COUNT(*) AS count FROM emails WHERE invoice_id = ?")
      .get(invoiceId) as unknown as { count: number };
    return row.count;
  }

  // Stores an upload in the inbox, waiting. The unique index on content_hash
  // refuses a second upload of the same email inside the insert, so two
  // processes cannot both store it. Throws DuplicateUploadError naming the first.
  addUpload(input: NewUpload): Upload {
    try {
      const result: { lastInsertRowid: number | bigint } = this.db
        .prepare(
          `INSERT INTO inbox
             (uploaded_by, uploaded_at, source, file_name, raw_sha256, raw_bytes, content_hash,
              message_id, sender, sender_name, from_as_written, reply_to, date_as_written,
              subject, body, style_text, attachments, notes, partial)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.uploadedBy,
          new Date().toISOString(),
          input.source,
          input.fileName,
          input.rawSha256,
          input.rawBytes,
          input.contentHash,
          input.messageId,
          input.sender,
          input.senderName,
          input.fromAsWritten,
          JSON.stringify(input.replyTo),
          input.dateAsWritten,
          input.subject,
          input.body,
          input.styleText,
          JSON.stringify(input.attachments),
          JSON.stringify(input.notes),
          input.partial ? 1 : 0,
        );
      const upload: Upload | undefined = this.upload(Number(result.lastInsertRowid));
      if (upload === undefined) {
        throw new Error("The upload was not stored");
      }
      return upload;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        const first: UploadRow | undefined = this.db
          .prepare("SELECT * FROM inbox WHERE content_hash = ?")
          .get(input.contentHash) as unknown as UploadRow | undefined;
        if (first !== undefined) {
          throw new DuplicateUploadError(toUpload(first));
        }
      }
      throw error;
    }
  }

  upload(id: number): Upload | undefined {
    const row: UploadRow | undefined = this.db
      .prepare("SELECT * FROM inbox WHERE id = ?")
      .get(id) as unknown as UploadRow | undefined;
    return row === undefined ? undefined : toUpload(row);
  }

  // Every waiting upload, then the latest others, newest first.
  uploads(others: number): Upload[] {
    const rows: UploadRow[] = this.db
      .prepare(
        `SELECT * FROM (SELECT * FROM inbox WHERE state = 'waiting' ORDER BY id DESC)
         UNION ALL
         SELECT * FROM (SELECT * FROM inbox WHERE state <> 'waiting' ORDER BY id DESC LIMIT ?)`,
      )
      .all(others) as unknown as UploadRow[];
    return rows.map(toUpload);
  }

  // How many uploads wait for a person, and the newest upload's id in any state,
  // which changes only when an email is uploaded. Counts only: no sender, name,
  // subject or text, so alerts can read it.
  inboxWaiting(): InboxWaiting {
    const row: { waiting: number; newest: number | null } = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM inbox WHERE state = 'waiting') AS waiting,
                (SELECT MAX(id) FROM inbox) AS newest`,
      )
      .get() as unknown as { waiting: number; newest: number | null };
    return { waiting: Number(row.waiting), newest: row.newest === null ? null : Number(row.newest) };
  }

  // Other uploads with the same Message-ID, which say something different, since
  // the same email twice is refused.
  sameMessageId(upload: Upload): number[] {
    if (upload.messageId === null) {
      return [];
    }
    const rows: { id: number }[] = this.db
      .prepare("SELECT id FROM inbox WHERE message_id = ? AND id <> ? ORDER BY id")
      .all(upload.messageId, upload.id) as unknown as { id: number }[];
    return rows.map((row: { id: number }): number => row.id);
  }

  // Delivers a waiting upload to an invoice in one transaction: the upload moves
  // to delivered only if it is still waiting, the email joins the invoice's
  // thread, and an open or escalated invoice's next look is due at once, so a
  // watcher in another process reads it. A closed invoice keeps the email on file
  // and is not reopened. ok false when the upload was no longer waiting.
  deliverUpload(id: number, invoiceId: string, deliveredBy: string): DeliverResult {
    return this.transaction((): DeliverResult => {
      const before: Upload | undefined = this.upload(id);
      if (before === undefined) {
        throw new Error(`Upload ${id} is not in the inbox`);
      }
      const obligation: Obligation | undefined = this.obligation(invoiceId);
      if (obligation === undefined) {
        throw new Error(`${invoiceId} is not in the ledger`);
      }
      const now: string = new Date().toISOString();
      const moved: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE inbox SET state = 'delivered', invoice_id = ?, delivered_by = ?, delivered_at = ?
            WHERE id = ? AND state = 'waiting'`,
        )
        .run(invoiceId, deliveredBy, now, id);
      if (Number(moved.changes) !== 1) {
        return { ok: false, upload: before };
      }
      this.db
        .prepare(
          `INSERT INTO emails
             (invoice_id, sender, subject, body, inbox_id, reply_to, style_text, attachments, notes, partial)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          invoiceId,
          before.sender,
          before.subject,
          before.body,
          id,
          JSON.stringify(before.replyTo),
          before.styleText,
          JSON.stringify(before.attachments),
          JSON.stringify(before.notes),
          before.partial ? 1 : 0,
        );
      this.db
        .prepare(
          `UPDATE obligations SET look_at = ?
            WHERE invoice_id = ? AND state IN ('open', 'escalated')`,
        )
        .run(now, invoiceId);
      const after: Upload | undefined = this.upload(id);
      return { ok: true, upload: after ?? before, obligation };
    });
  }

  // Dismisses a waiting upload, for good. False when it was no longer waiting.
  dismissUpload(id: number, dismissedBy: string, note: string): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE inbox SET state = 'dismissed', dismissed_by = ?, dismissed_at = ?, dismiss_note = ?
          WHERE id = ? AND state = 'waiting'`,
      )
      .run(dismissedBy, new Date().toISOString(), note, id);
    return Number(result.changes) === 1;
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
             (invoice_id, binding, terms, requested_at, expires_at, needed, needed_why, route_key)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?
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
          request.routeKey ?? null,
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

  // Every approval request for the invoice, oldest first.
  approvalsFor(invoiceId: string): Approval[] {
    return (
      this.db
        .prepare("SELECT * FROM approvals WHERE invoice_id = ? ORDER BY id")
        .all(invoiceId) as unknown as ApprovalRow[]
    ).map((row: ApprovalRow): Approval => toApproval(row, this.signoffs(row.id)));
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
  // invoice is no longer escalated, as when a person closed it, a person once
  // closed it without paying, a payout for it sent outside PayOnce is live, or
  // another payment for it is live at the bank.
  // Also when unchanged, run under the write lock, returns false. The attempt
  // keeps the approval, and the quote in its terms for a payment from another
  // currency's wallet.
  useApproval(
    invoiceId: string,
    approvalId: number,
    lease: Lease,
    unchanged: () => boolean,
    route: string | null = null,
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
              AND EXISTS (SELECT 1 FROM obligations WHERE invoice_id = ? AND state = 'escalated'
                AND rejected_by IS NULL)
              AND NOT EXISTS (${LIVE_OUTSIDE_PAYOUT}) AND NOT EXISTS (${LIVE_ATTEMPT})`,
        )
        .run(approvalId, invoiceId, new Date().toISOString(), invoiceId, invoiceId, invoiceId);
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const attempt: Attempt = this.openAttempt(invoiceId, "replacement", lease, approvalId, null, route);
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
  // when it verified the account the record holds now: where the money goes, so a
  // bank name Airwallex rewrote since does not undo it. A record changed to
  // another account since, in PayOnce or outside it, has none, even when it
  // changed back to an account an older callback verified.
  verifiedBankChange(beneficiaryId: string, details: TransferBankDetails): BankChange | undefined {
    const row: BankChangeRow | undefined = this.db
      .prepare(
        `SELECT * FROM bank_changes WHERE beneficiary_id = ? AND state = 'applied'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(beneficiaryId) as unknown as BankChangeRow | undefined;
    return row === undefined || row.applied_key === null || !sameRoute(row.applied_key, bankDetailsKey(details))
      ? undefined
      : toBankChange(row);
  }

  // Everyone who recorded an applied callback for the account these details go
  // to, of this beneficiary. None of them may approve a payment to it.
  bankChangeRecorders(beneficiaryId: string, detailsKey: string): string[] {
    return [
      ...new Set<string>(
        (
          this.db
            .prepare(
              `SELECT called_by, applied_key FROM bank_changes
                WHERE beneficiary_id = ? AND state = 'applied' AND applied_key IS NOT NULL ORDER BY id`,
            )
            .all(beneficiaryId) as unknown as { called_by: string; applied_key: string }[]
        )
          .filter((row: { applied_key: string }): boolean => sameRoute(row.applied_key, detailsKey))
          .map((row: { called_by: string }): string => row.called_by),
      ),
    ];
  }

  // Who recorded each callback on this invoice, in any state, oldest first. Only
  // the names: the number called and what was said stay out.
  callbackRecorders(invoiceId: string): string[] {
    return (
      this.db
        .prepare("SELECT called_by FROM bank_changes WHERE invoice_id = ? ORDER BY id")
        .all(invoiceId) as unknown as { called_by: string }[]
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

  // True when one attempt is paid and no other payment for the invoice is with the
  // bank: each has failed, or is a transfer the ledger keeps failed, or one under a
  // request id that does not match the invoice, that the bank has paid as well,
  // which the look holds for a person.
  paidOnce(invoiceId: string): boolean {
    const attempts: Attempt[] = this.attempts(invoiceId);
    const paid: number = attempts.filter(
      (attempt: Attempt): boolean => attempt.state === "paid",
    ).length;
    const unresolved: number = attempts.filter(stillWithBank).length;
    return paid === 1 && unresolved === 0;
  }

  // True when every payment PayOnce sent has failed at the bank, nothing for the
  // invoice is still with the bank, and a transfer under one of its request ids
  // that does not match it is paid. Only a person closes it then. A payout sent
  // outside PayOnce that is paid as well does not stop it.
  paidMismatched(invoiceId: string): boolean {
    const attempts: Attempt[] = this.attempts(invoiceId);
    return (
      attempts.every(nothingWithBank) &&
      attempts.some(
        (attempt: Attempt): boolean => mismatchedLive(attempt) && attempt.mismatchedStatus === "PAID",
      ) &&
      !this.outsidePayouts(invoiceId).some(
        (payout: OutsidePayout): boolean => payout.state !== "failed" && payout.state !== "paid",
      )
    );
  }

  // True when every payment PayOnce sent has failed at the bank, nothing for the
  // invoice is still with the bank, and the bank reports a payout sent outside
  // PayOnce as paid. A transfer under one of its request ids that does not match
  // it and is paid as well does not stop it.
  paidOutside(invoiceId: string): boolean {
    return (
      this.attempts(invoiceId).every(nothingWithBank) &&
      this.outsidePayouts(invoiceId).some(
        (payout: OutsidePayout): boolean => payout.state === "paid",
      )
    );
  }

  // Settles only when the invoice has been paid once by PayOnce or, when a
  // person closes it, by a payout sent outside PayOnce or a transfer under one of
  // its request ids that does not match it. A payment that went out
  // at a rate nobody approved leaves the invoice for a person to close, unless it
  // failed. So does a transfer found late that may have paid it a second time
  // (lateBesideLive, the test paidTwice makes), and by itself PayOnce never closes
  // one while a payout sent outside PayOnce is live or a mismatched transfer no
  // person has cleared is on file. The checks and the close run in one write
  // transaction, and the close only changes an invoice still open or escalated,
  // and still in the state the caller read when it gives one (from), so a payment
  // another process recorded or tied, or a change it made to the invoice, after
  // the caller looked leaves it as it is. False then. covered lists the
  // transfers under its request ids that do not match it which a person's close
  // covered, and they are cleared in the same transaction.
  settle(
    invoiceId: string,
    byPerson: boolean = false,
    from: ObligationState | null = null,
    covered: string[] = [],
  ): boolean {
    return this.transaction((): boolean => {
      if (
        !this.paidOnce(invoiceId) &&
        !(byPerson && (this.paidOutside(invoiceId) || this.paidMismatched(invoiceId)))
      ) {
        return false;
      }
      const attempts: Attempt[] = this.attempts(invoiceId);
      if (
        !byPerson &&
        (attempts.some(
          (attempt: Attempt): boolean => attempt.rateMismatch !== null && liveAtBank(attempt),
        ) ||
          lateBesideLive(attempts, this.outsidePayouts(invoiceId)) !== undefined)
      ) {
        return false;
      }
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE obligations SET state = 'settled'
            WHERE invoice_id = ? AND state = COALESCE(?, state) AND state IN ('open', 'escalated')
              AND (? = 1 OR (NOT EXISTS (${LIVE_OUTSIDE_PAYOUT}) AND NOT EXISTS (${UNCLEARED_MISMATCH})))`,
        )
        .run(invoiceId, from, byPerson ? 1 : 0, invoiceId, invoiceId);
      if (Number(result.changes) !== 1) {
        return false;
      }
      // Nothing is left to approve on a settled invoice.
      this.voidOpenApprovals(invoiceId);
      this.clearMismatched(invoiceId, covered);
      return true;
    });
  }

  // A transfer that went to other bank details than the ones it was approved or
  // decided for.
  markMisdirected(requestId: string): void {
    this.db.prepare("UPDATE attempts SET misdirected = 1 WHERE request_id = ?").run(requestId);
  }

  // The latest payment PayOnce sent this beneficiary that the bank paid, to the
  // details it was decided or approved for, with that account's key. Only a
  // checked payment counts: one that kept the account it was meant for and did
  // not go elsewhere or show no bank details (misdirected). Payouts sent outside
  // PayOnce do not count, so a record changed and paid in the web app does not
  // become the account on file, and nor does a payment from before the account
  // was kept that nothing checked (lastPaidUnchecked).
  lastPaidTransfer(beneficiaryId: string): LastPaid | undefined {
    const row: { transfer_id: string; reference: string | null; account_key: string; route_key: string | null } | undefined = this.db
      .prepare(
        `SELECT attempts.transfer_id, attempts.reference, attempts.account_key, attempts.route_key FROM attempts
           JOIN obligations ON obligations.invoice_id = attempts.invoice_id
          WHERE obligations.beneficiary_id = ? AND obligations.origin = 'payonce'
            AND attempts.state = 'paid' AND attempts.transfer_id IS NOT NULL
            AND attempts.misdirected = 0 AND attempts.account_key IS NOT NULL
          ORDER BY attempts.rowid DESC LIMIT 1`,
      )
      .get(beneficiaryId) as unknown as
      | { transfer_id: string; reference: string | null; account_key: string; route_key: string | null }
      | undefined;
    return row === undefined
      ? undefined
      : {
          transferId: row.transfer_id,
          reference: row.reference,
          accountKey: row.account_key,
          routeKey: row.route_key ?? null,
        };
  }

  // The latest payment PayOnce sent this beneficiary that the bank paid and that
  // kept no account: one from before attempts kept the account each payment went
  // to, which nothing on file shows was checked. Undefined when there is none.
  lastPaidUnchecked(beneficiaryId: string): { transferId: string; reference: string | null } | undefined {
    const row: { transfer_id: string; reference: string | null } | undefined = this.db
      .prepare(
        `SELECT attempts.transfer_id, attempts.reference FROM attempts
           JOIN obligations ON obligations.invoice_id = attempts.invoice_id
          WHERE obligations.beneficiary_id = ? AND obligations.origin = 'payonce'
            AND attempts.state = 'paid' AND attempts.transfer_id IS NOT NULL
            AND attempts.misdirected = 0 AND attempts.account_key IS NULL
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

  // ---------- supplier view ----------

  // What the supplier list reads for every record: only the columns its cautions
  // and counts use from invoices, attempts and payouts, and no drafts or outage
  // holds, which only a record's detail shows. Never an email's subject or body,
  // a callback's notes or typed details, or a timeline line. Each query runs once,
  // and it only reads, so it runs inside readSnapshot.
  supplierListRead(): SupplierListRead {
    const obligations: SupplierObligation[] = (
      this.db
        .prepare(
          `SELECT invoice_id, beneficiary_id, supplier, state, escalation_reason, supplier_domain,
                  supplier_phone, duplicate_of, currency, transfer_method
             FROM obligations ORDER BY rowid DESC`,
        )
        .all() as unknown as SupplierObligationRow[]
    ).map(toSupplierObligation);
    const attempts: SupplierAttempt[] = (
      this.db
        .prepare(
          `SELECT ${SUPPLIER_ATTEMPT_COLUMNS} FROM attempts
             JOIN obligations ON obligations.invoice_id = attempts.invoice_id ORDER BY attempts.rowid`,
        )
        .all() as unknown as SupplierAttemptRow[]
    ).map(toSupplierAttempt);
    const payouts: SupplierPayout[] = (
      this.db
        .prepare(
          `SELECT ${SUPPLIER_PAYOUT_COLUMNS} FROM outside_payouts
             JOIN obligations ON obligations.invoice_id = outside_payouts.invoice_id
            ORDER BY outside_payouts.rowid`,
        )
        .all() as unknown as SupplierPayoutRow[]
    ).map(toSupplierPayout);
    return routedRead({ obligations, attempts, payouts, ...this.supplierShared(null), drafts: [], holds: [] }, this.accountRoutes());
  }

  // What a record's detail reads of that one beneficiary record: what the list
  // reads, with the invoices in full and what the page shows of each payment, its
  // drafts by template and state, and its outage holds. Never a draft's text or
  // facts, nor anything supplierListRead leaves out.
  supplierRead(beneficiaryId: string): SupplierRead {
    const obligations: Obligation[] = this.obligationsFor(beneficiaryId);
    const attempts: SupplierPayment[] = (
      this.db
        .prepare(
          `SELECT ${SUPPLIER_ATTEMPT_COLUMNS}, attempts.kind, attempts.reference, attempts.amount_minor,
                  attempts.currency, attempts.fee_minor, attempts.fee_currency,
                  attempts.rate_mismatch IS NOT NULL AS rate_mismatch, attempts.mismatched_reference,
                  attempts.arrival
             FROM attempts JOIN obligations ON obligations.invoice_id = attempts.invoice_id
            WHERE obligations.beneficiary_id = ? ORDER BY attempts.rowid`,
        )
        .all(beneficiaryId) as unknown as SupplierPaymentRow[]
    ).map(
      (row: SupplierPaymentRow): SupplierPayment => ({
        ...toSupplierAttempt(row),
        kind: row.kind,
        reference: row.reference,
        amountMinor: row.amount_minor,
        currency: row.currency,
        feeMinor: row.fee_minor,
        feeCurrency: row.fee_currency,
        rateMismatch: row.rate_mismatch === 1,
        mismatchedReference: row.mismatched_reference ?? null,
        arrival: row.arrival ?? null,
      }),
    );
    const payouts: SupplierPayoutView[] = (
      this.db
        .prepare(
          `SELECT ${SUPPLIER_PAYOUT_COLUMNS}, outside_payouts.transfer_id, outside_payouts.reference,
                  outside_payouts.amount_minor, outside_payouts.currency, outside_payouts.fee_minor,
                  outside_payouts.fee_currency
             FROM outside_payouts JOIN obligations ON obligations.invoice_id = outside_payouts.invoice_id
            WHERE obligations.beneficiary_id = ? ORDER BY outside_payouts.rowid`,
        )
        .all(beneficiaryId) as unknown as (SupplierPayoutRow & OutsideRow)[]
    ).map(
      (row: SupplierPayoutRow & OutsideRow): SupplierPayoutView => ({
        ...toOutsidePayout(row),
        ...toSupplierPayout(row),
      }),
    );
    const drafts: SupplierDraft[] = (
      this.db
        .prepare(
          `SELECT outbox.id, outbox.invoice_id, outbox.template, outbox.audience, outbox.state,
                  outbox.created_by, outbox.created_at, outbox.copied_by, outbox.copied_at,
                  outbox.sent_by, outbox.sent_at, outbox.dismissed_by, outbox.dismissed_at
             FROM outbox JOIN obligations ON obligations.invoice_id = outbox.invoice_id
            WHERE obligations.beneficiary_id = ? ORDER BY outbox.id`,
        )
        .all(beneficiaryId) as unknown as SupplierDraftRow[]
    ).map(
      (row: SupplierDraftRow): SupplierDraft => ({
        id: row.id,
        invoiceId: row.invoice_id,
        template: row.template,
        audience: row.audience,
        state: row.state,
        createdBy: row.created_by,
        createdAt: row.created_at,
        copiedBy: row.copied_by,
        copiedAt: row.copied_at,
        sentBy: row.sent_by,
        sentAt: row.sent_at,
        dismissedBy: row.dismissed_by,
        dismissedAt: row.dismissed_at,
      }),
    );
    const holds: SupplierHold[] = (
      this.db
        .prepare(
          `SELECT outage_holds.*, outages.currency, outages.method, outages.state AS outage_state, outages.ended_at
             FROM outage_holds JOIN outages ON outages.id = outage_holds.outage_id
            WHERE outage_holds.invoice_id IN (SELECT invoice_id FROM obligations WHERE beneficiary_id = ?)
               OR outage_holds.run_id IN (SELECT run_id FROM run_rows WHERE beneficiary_id = ?)
            ORDER BY outage_holds.rowid`,
        )
        .all(beneficiaryId, beneficiaryId) as unknown as SupplierHoldRow[]
    ).map(
      (row: SupplierHoldRow): SupplierHold => ({
        outageId: row.outage_id,
        invoiceId: row.invoice_id,
        runId: row.run_id,
        what: row.what,
        heldAt: row.held_at,
        currency: row.currency,
        method: row.method,
        outageState: row.outage_state,
        endedAt: row.ended_at,
      }),
    );
    return routedRead(
      { obligations, attempts, payouts, ...this.supplierShared(beneficiaryId), drafts, holds },
      this.accountRoutes(),
    );
  }

  // What the list and a detail both read: approvals with only the account their
  // terms name, callbacks, emails' addresses, findings, rail failures and pay run
  // rows, for one record, or for every record when beneficiaryId is null.
  private supplierShared(beneficiaryId: string | null): SupplierShared {
    const one: boolean = beneficiaryId !== null;
    const args: string[] = beneficiaryId === null ? [] : [beneficiaryId];
    const where = (column: string): string => (one ? `WHERE ${column} = ?` : "");
    const all = <T>(sql: string): T[] => this.db.prepare(sql).all(...args) as unknown as T[];
    const approvals: SupplierApproval[] = all<SupplierApprovalRow>(
      `SELECT approvals.id, approvals.invoice_id, obligations.beneficiary_id, approvals.state,
              approvals.requested_at,
              CASE WHEN json_valid(approvals.terms) THEN json_extract(approvals.terms, '$.accountKey') END AS account_key
         FROM approvals JOIN obligations ON obligations.invoice_id = approvals.invoice_id
         ${where("obligations.beneficiary_id")} ORDER BY approvals.id`,
    ).map(
      (row: SupplierApprovalRow): SupplierApproval => ({
        id: row.id,
        invoiceId: row.invoice_id,
        beneficiaryId: row.beneficiary_id,
        state: row.state,
        requestedAt: row.requested_at,
        accountKey: typeof row.account_key === "string" ? row.account_key : null,
      }),
    );
    const callbacks: SupplierCallback[] = all<SupplierCallbackRow>(
      `SELECT id, invoice_id, beneficiary_id, called_by, number_called, called_at, state,
              applied_key, old_details, recorded_at
         FROM bank_changes ${where("beneficiary_id")} ORDER BY id`,
    ).map(
      (row: SupplierCallbackRow): SupplierCallback => ({
        id: row.id,
        invoiceId: row.invoice_id,
        beneficiaryId: row.beneficiary_id,
        calledBy: row.called_by,
        numberCalled: row.number_called,
        calledAt: row.called_at,
        state: row.state,
        appliedKey: row.applied_key,
        oldDetails: row.old_details,
        recordedAt: row.recorded_at,
      }),
    );
    const emails: SupplierEmailFacts[] = all<{ invoice_id: string; sender: string; reply_to: string; partial: number }>(
      `SELECT emails.invoice_id, emails.sender, emails.reply_to, emails.partial FROM emails
         JOIN obligations ON obligations.invoice_id = emails.invoice_id
         ${where("obligations.beneficiary_id")} ORDER BY emails.id`,
    ).map(
      (row: { invoice_id: string; sender: string; reply_to: string; partial: number }): SupplierEmailFacts => ({
        invoiceId: row.invoice_id,
        from: row.sender,
        replyTo: stringsOf(row.reply_to),
        partial: row.partial === 1,
      }),
    );
    const findings: SupplierFindings[] = all<{ invoice_id: string; findings: string }>(
      `SELECT email_findings.invoice_id, email_findings.findings FROM email_findings
         JOIN obligations ON obligations.invoice_id = email_findings.invoice_id
         ${where("obligations.beneficiary_id")}`,
    ).map(
      (row: { invoice_id: string; findings: string }): SupplierFindings => ({
        invoiceId: row.invoice_id,
        findings: row.findings,
      }),
    );
    const failures: SupplierFailure[] = all<RailFailureRow & { beneficiary_id: string }>(
      `SELECT rail_failures.*, obligations.beneficiary_id FROM rail_failures
         JOIN obligations ON obligations.invoice_id = rail_failures.invoice_id
         ${where("obligations.beneficiary_id")} ORDER BY rail_failures.rowid`,
    ).map(
      (row: RailFailureRow & { beneficiary_id: string }): SupplierFailure => ({
        ...toRailFailure(row),
        beneficiaryId: row.beneficiary_id,
      }),
    );
    const runRows: SupplierRunRow[] = all<SupplierRunRowRecord>(
      `SELECT run_rows.id, run_rows.run_id, runs.state AS run_state, runs.checked_at, run_rows.line,
              run_rows.invoice_id, run_rows.beneficiary_id, run_rows.supplier, run_rows.payee,
              run_rows.currency, run_rows.amount_minor, run_rows.action, run_rows.state,
              run_rows.new_payee, run_rows.bank_change_id, run_rows.account_key,
              CASE WHEN json_valid(run_rows.reasons) THEN json_array_length(run_rows.reasons) END AS skip_reasons
         FROM run_rows JOIN runs ON runs.id = run_rows.run_id
         ${one ? "WHERE run_rows.beneficiary_id = ?" : "WHERE run_rows.beneficiary_id IS NOT NULL"}
         ORDER BY run_rows.run_id DESC, run_rows.line`,
    ).map(
      (row: SupplierRunRowRecord): SupplierRunRow => ({
        id: row.id,
        runId: row.run_id,
        runState: row.run_state,
        checkedAt: row.checked_at,
        line: row.line,
        invoiceId: row.invoice_id,
        beneficiaryId: row.beneficiary_id ?? "",
        supplier: row.payee ?? row.supplier,
        currency: row.currency,
        amountMinor: row.amount_minor,
        action: row.action,
        state: row.state,
        newPayee: row.new_payee === 1,
        bankChangeId: row.bank_change_id,
        accountKey: row.account_key,
        skipReasons: row.skip_reasons ?? 0,
      }),
    );
    return { approvals, callbacks, emails, findings, failures, runRows };
  }

  // Whether an invoice, or a pay row of the waiting run, names this beneficiary
  // record, which is when the supplier view has a record for it.
  supplierNamed(beneficiaryId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM obligations WHERE beneficiary_id = ?
            UNION ALL
           SELECT 1 FROM run_rows JOIN runs ON runs.id = run_rows.run_id
            WHERE runs.state = 'waiting' AND run_rows.action = 'pay' AND run_rows.state = 'waiting'
              AND run_rows.beneficiary_id = ?
            LIMIT 1`,
        )
        .get(beneficiaryId, beneficiaryId) !== undefined
    );
  }

  // Every name and account the ledger keeps for each beneficiary record, for one
  // record's links to records that share a name or an account. The pay rows of
  // the waiting run count, since no invoice holds them yet. The accounts asked to
  // approve leave out except's own approvals, which its detail has read already,
  // so no terms JSON is parsed twice. The list builds the same from its own read.
  // Terms are read only inside CASE WHEN json_valid(...), as metricsRead reads
  // them, because SQLite promises no order for the two sides of an AND and a JSON
  // function throws on text that is not JSON.
  supplierLinks(except: string): SupplierLinks {
    const all = <T>(sql: string, ...params: string[]): T[] => this.db.prepare(sql).all(...params) as unknown as T[];
    // newest is the newest invoice with the name, and 0 for a waiting run's row.
    const names: { beneficiaryId: string; name: string; newest: number }[] = all<{
      beneficiary_id: string;
      name: string;
      newest: number;
    }>(
      `SELECT beneficiary_id, supplier AS name, max(rowid) AS newest FROM obligations
        GROUP BY beneficiary_id, supplier
        UNION
       SELECT run_rows.beneficiary_id, COALESCE(run_rows.payee, run_rows.supplier), 0 FROM run_rows
         JOIN runs ON runs.id = run_rows.run_id
        WHERE runs.state = 'waiting' AND run_rows.action = 'pay' AND run_rows.state = 'waiting'
          AND run_rows.beneficiary_id IS NOT NULL AND COALESCE(run_rows.payee, run_rows.supplier) IS NOT NULL`,
    ).map((row: { beneficiary_id: string; name: string; newest: number }) => ({
      beneficiaryId: row.beneficiary_id,
      name: row.name,
      newest: row.newest,
    }));
    const keys: { beneficiaryId: string; key: string }[] = all<{ beneficiary_id: string; key: string }>(
      `SELECT obligations.beneficiary_id, attempts.account_key AS key FROM attempts
         JOIN obligations ON obligations.invoice_id = attempts.invoice_id WHERE attempts.account_key IS NOT NULL
        UNION
       SELECT obligations.beneficiary_id, attempts.sent_key FROM attempts
         JOIN obligations ON obligations.invoice_id = attempts.invoice_id WHERE attempts.sent_key IS NOT NULL
        UNION
       SELECT obligations.beneficiary_id, outside_payouts.sent_key FROM outside_payouts
         JOIN obligations ON obligations.invoice_id = outside_payouts.invoice_id
        WHERE outside_payouts.sent_key IS NOT NULL
        UNION
       SELECT obligations.beneficiary_id, json_extract(approvals.terms, '$.accountKey') FROM approvals
         JOIN obligations ON obligations.invoice_id = approvals.invoice_id
        WHERE obligations.beneficiary_id <> ?
          AND CASE WHEN json_valid(approvals.terms) THEN json_type(approvals.terms, '$.accountKey') = 'text' ELSE 0 END
        UNION
       SELECT beneficiary_id, account_key FROM run_rows
        WHERE action = 'pay' AND account_key IS NOT NULL AND beneficiary_id IS NOT NULL`,
      except,
    ).map((row: { beneficiary_id: string; key: string }) => ({ beneficiaryId: row.beneficiary_id, key: row.key }));
    // By where the money goes, as the record's own read gives its keys.
    const routes: Map<string, string> = this.accountRoutes();
    for (const entry of keys) {
      entry.key = routes.get(entry.key) ?? entry.key;
    }
    const callbacks: { beneficiaryId: string; appliedKey: string | null; oldDetails: string }[] = all<{
      beneficiary_id: string;
      applied_key: string | null;
      old_details: string;
    }>("SELECT beneficiary_id, applied_key, old_details FROM bank_changes").map(
      (row: { beneficiary_id: string; applied_key: string | null; old_details: string }) => ({
        beneficiaryId: row.beneficiary_id,
        appliedKey: row.applied_key,
        oldDetails: row.old_details,
      }),
    );
    const payees: { beneficiaryId: string; payee: string }[] = all<{ beneficiary_id: string; payee: string }>(
      `SELECT DISTINCT obligations.beneficiary_id, rail_failures.payee FROM rail_failures
         JOIN obligations ON obligations.invoice_id = rail_failures.invoice_id`,
    ).map((row: { beneficiary_id: string; payee: string }) => ({ beneficiaryId: row.beneficiary_id, payee: row.payee }));
    return { names, keys, callbacks, payees };
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
            bank_change_id, payee, pay_to, account_key, due_date, arrival, route_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                pay_to = ?, account_key = ?, due_date = ?, arrival = ?, route_key = ?
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
  // pay, and RailOutageError, with nothing changed, when any row pays on a rail
  // with an active outage, so the whole run waits with its approval.
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
      for (const row of rows) {
        const outage: Outage | undefined = this.activeOutage(row.currency, row.transferMethod);
        if (outage !== undefined) {
          throw new RailOutageError(outage, "run");
        }
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
    // Hashed as it will read back from the file, and one line, as an invoice's.
    const line: RunEventFields = {
      runId,
      at: new Date().toISOString(),
      kind,
      message: storable(oneLine(message)),
      topic: topic === null ? null : storable(topic),
    };
    const hash: string = runEventHash(prevHash, line);
    const inserted: { lastInsertRowid: number | bigint } = this.db
      .prepare(
        `INSERT INTO run_events (run_id, at, kind, message, topic, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(line.runId, line.at, line.kind, line.message, line.topic, prevHash, hash);
    this.chainHead(RUN_HEAD_KEY, RUN_RESTARTED_KEY, hash, line.at, Number(inserted.lastInsertRowid), `run ${runId}`);
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
        restarted: restartOf(this.metaValue(RUN_RESTARTED_KEY)),
        unlined: this.unlinedRuns(),
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

  // Compares the conditions an evaluation found with the ones on file. When
  // nothing changed it writes nothing. Otherwise it compares again in one write
  // transaction, so two processes on the file queue each alert once, and writes
  // only the rows that changed. A new condition, a changed one, or one back after
  // more than clearAfterMs queues an alert. A change to a fingerprint whose alert was skipped in this episode
  // queues that alert again. On the first evaluation after alerts are turned on,
  // the conditions standing are recorded without an alert each, and only the
  // summary is queued, and only when any condition stands. A stored condition
  // whose key starts with one of unknownPrefixes is not cleared, because the
  // evaluation could not look.
  recordConditions(
    found: FoundCondition[],
    summary: FoundCondition,
    now: number,
    settleMs: number,
    clearAfterMs: number,
    unknownPrefixes: string[],
  ): RecordedConditions {
    // The first condition found for each key, so a key found twice cannot fail
    // the insert and roll the whole check back.
    const byKey: Map<string, FoundCondition> = new Map();
    for (const condition of found) {
      if (!byKey.has(condition.key)) {
        byKey.set(condition.key, condition);
      }
    }
    const conditions: FoundCondition[] = [...byKey.values()];
    if (!this.conditionsChanged(conditions, unknownPrefixes)) {
      return { first: false, queued: 0, standing: conditions.length };
    }
    return this.transaction((): RecordedConditions => {
      const at: string = new Date(now).toISOString();
      const due: string = new Date(now + settleMs).toISOString();
      // An alert skipped for this key, episode and fingerprint is queued again
      // with the facts as they are now. One queued, sending, sent or failed is
      // left as it is.
      const requeue = (condition: FoundCondition, episode: number): number =>
        Number(
          this.db
            .prepare(
              `UPDATE alerts
                  SET kind = ?, facts = ?, state = 'queued', tries = 0, next_try_at = ?,
                      last_error = NULL, created_at = ?
                WHERE alert_key = ? AND episode = ? AND fingerprint = ? AND state = 'skipped'`,
            )
            .run(condition.kind, condition.facts, due, at, condition.key, episode, condition.fingerprint)
            .changes,
        );
      const queue = (condition: FoundCondition, episode: number): number => {
        const inserted: number = Number(
          this.db
            .prepare(
              `INSERT OR IGNORE INTO alerts
                 (alert_key, episode, fingerprint, kind, facts, next_try_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(condition.key, episode, condition.fingerprint, condition.kind, condition.facts, due, at)
            .changes,
        );
        return inserted > 0 ? inserted : requeue(condition, episode);
      };
      const insert = (condition: FoundCondition): void => {
        this.db
          .prepare(
            "INSERT INTO alert_conditions (alert_key, fingerprint, episode, seen_at) VALUES (?, ?, 1, ?)",
          )
          .run(condition.key, condition.fingerprint, at);
      };
      if (this.firstAlertCheck()) {
        conditions.forEach(insert);
        this.db
          .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('alerts_started_at', ?)")
          .run(at);
        // A summary of nothing would only say that nothing is waiting.
        return {
          first: true,
          queued: conditions.length === 0 ? 0 : queue(summary, 1),
          standing: conditions.length,
        };
      }
      const stored: Map<string, ConditionRow> = new Map(
        (this.db.prepare("SELECT * FROM alert_conditions").all() as unknown as ConditionRow[]).map(
          (row: ConditionRow): [string, ConditionRow] => [row.alert_key, row],
        ),
      );
      let queued: number = 0;
      for (const condition of conditions) {
        const row: ConditionRow | undefined = stored.get(condition.key);
        stored.delete(condition.key);
        if (row === undefined) {
          insert(condition);
          queued += queue(condition, 1);
          continue;
        }
        const same: boolean = row.fingerprint === condition.fingerprint;
        const back: boolean = row.cleared_at !== null;
        if (same && !back) {
          continue;
        }
        const episode: number =
          back && now - Date.parse(row.cleared_at ?? "") >= clearAfterMs ? row.episode + 1 : row.episode;
        this.db
          .prepare(
            `UPDATE alert_conditions SET fingerprint = ?, episode = ?, seen_at = ?, cleared_at = NULL
              WHERE alert_key = ?`,
          )
          .run(condition.fingerprint, episode, at, condition.key);
        if (episode !== row.episode || !same) {
          queued += queue(condition, episode);
        } else if (back) {
          // Back within the clear window as it was. An alert skipped while it was
          // gone is due again.
          queued += requeue(condition, episode);
        }
      }
      for (const row of stored.values()) {
        const unknown: boolean = unknownPrefixes.some((prefix: string): boolean =>
          row.alert_key.startsWith(prefix),
        );
        if (row.cleared_at === null && !unknown) {
          this.db
            .prepare("UPDATE alert_conditions SET cleared_at = ? WHERE alert_key = ?")
            .run(at, row.alert_key);
        }
      }
      return { first: false, queued, standing: conditions.length };
    });
  }

  // The first evaluation since alerts were turned on: both alert tables are empty
  // and no evaluation has recorded when alerts started.
  private firstAlertCheck(): boolean {
    return (
      this.db.prepare("SELECT 1 FROM alert_conditions LIMIT 1").get() === undefined &&
      this.db.prepare("SELECT 1 FROM alerts LIMIT 1").get() === undefined &&
      this.db.prepare("SELECT 1 FROM meta WHERE key = 'alerts_started_at'").get() === undefined
    );
  }

  // True when recordConditions has something to write: it is the first
  // evaluation, or a condition is new, changed, back or gone. It only reads, so a
  // check that finds nothing new never waits for the write lock.
  private conditionsChanged(conditions: FoundCondition[], unknownPrefixes: string[]): boolean {
    if (this.firstAlertCheck()) {
      return true;
    }
    const stored: Map<string, ConditionRow> = new Map(
      (this.db.prepare("SELECT * FROM alert_conditions").all() as unknown as ConditionRow[]).map(
        (row: ConditionRow): [string, ConditionRow] => [row.alert_key, row],
      ),
    );
    for (const condition of conditions) {
      const row: ConditionRow | undefined = stored.get(condition.key);
      if (row === undefined || row.fingerprint !== condition.fingerprint || row.cleared_at !== null) {
        return true;
      }
      stored.delete(condition.key);
    }
    return [...stored.values()].some(
      (row: ConditionRow): boolean =>
        row.cleared_at === null &&
        !unknownPrefixes.some((prefix: string): boolean => row.alert_key.startsWith(prefix)),
    );
  }

  // Marks a claimed alert skipped when the condition it was queued for has
  // cleared or no longer has its episode and fingerprint. The check is part of
  // the UPDATE, so a condition another process records back to this fingerprint
  // either lands first and the alert is not skipped, or finds it skipped and
  // queues it again. False means the condition holds and the alert is posted.
  skipStaleAlert(id: number, holder: string): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE alerts
            SET state = 'skipped', sent_at = NULL, claimed_by = NULL, claim_until = NULL
          WHERE id = ? AND claimed_by = ?
            AND NOT EXISTS (
              SELECT 1 FROM alert_conditions
               WHERE alert_conditions.alert_key = alerts.alert_key
                 AND alert_conditions.episode = alerts.episode
                 AND alert_conditions.fingerprint = alerts.fingerprint
                 AND alert_conditions.cleared_at IS NULL)`,
      )
      .run(id, holder);
    return Number(result.changes) === 1;
  }

  // Takes the oldest alert that is due, or one whose sender's claim ran out, in
  // one statement, so two processes never take the same one. A read comes first,
  // so a check with nothing due never waits for the write lock.
  claimAlert(holder: string, now: number, claimMs: number): Alert | undefined {
    const at: string = new Date(now).toISOString();
    const due: string = "(state = 'queued' AND next_try_at <= ?) OR (state = 'sending' AND claim_until < ?)";
    if (this.db.prepare(`SELECT 1 FROM alerts WHERE ${due} LIMIT 1`).get(at, at) === undefined) {
      return undefined;
    }
    const row: AlertRow | undefined = this.db
      .prepare(
        `UPDATE alerts SET state = 'sending', claimed_by = ?, claim_until = ?
          WHERE id = (SELECT id FROM alerts WHERE ${due} ORDER BY id LIMIT 1)
          RETURNING *`,
      )
      .get(holder, new Date(now + claimMs).toISOString(), at, at) as unknown as AlertRow | undefined;
    return row === undefined ? undefined : toAlert(row);
  }

  // Only the holder of the claim can finish an alert.
  finishAlert(id: number, holder: string, finish: AlertFinish): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE alerts
            SET state = ?, tries = tries + ?, next_try_at = COALESCE(?, next_try_at),
                last_error = COALESCE(?, last_error), sent_at = ?,
                claimed_by = NULL, claim_until = NULL
          WHERE id = ? AND claimed_by = ?`,
      )
      .run(
        finish.state,
        finish.tried ? 1 : 0,
        finish.nextTryAt === null ? null : new Date(finish.nextTryAt).toISOString(),
        finish.error,
        finish.state === "sent" ? new Date().toISOString() : null,
        id,
        holder,
      );
    return Number(result.changes) === 1;
  }

  // Newest first.
  recentAlerts(limit: number): Alert[] {
    return (
      this.db.prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT ?").all(limit) as unknown as AlertRow[]
    ).map(toAlert);
  }

  // When the payment usually arrives, as the route advisory worked it out when it
  // was sent. Advice for people only.
  setArrival(requestId: string, arrival: ArrivalTerms): void {
    this.db.prepare("UPDATE attempts SET arrival = ? WHERE request_id = ?").run(JSON.stringify(arrival), requestId);
  }

  // Stores a draft and its chained timeline line in one write transaction, so a
  // draft never exists without the line that records its hash. A draft of the
  // same template still open on the invoice refuses it.
  createDraft(input: NewDraft, line: (id: number) => string): number {
    try {
      return this.transaction((): number => {
        const id: number = Number(
          this.db
            .prepare(
              `INSERT INTO outbox
                 (invoice_id, template, audience, facts, subject, body, text_hash, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.invoiceId,
              input.template,
              input.audience,
              input.facts,
              input.subject,
              input.body,
              input.textHash,
              input.createdBy,
              new Date().toISOString(),
            ).lastInsertRowid,
        );
        this.appendEvent(input.invoiceId, "outbox", line(id), `outbox:${id}`);
        return id;
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        const open: DraftRow | undefined = this.db
          .prepare(
            `SELECT * FROM outbox WHERE invoice_id = ? AND template = ? AND state IN ('draft', 'copied')`,
          )
          .get(input.invoiceId, input.template) as unknown as DraftRow | undefined;
        throw new DraftOpenError(open?.id ?? 0);
      }
      throw error;
    }
  }

  // Moves a draft on and writes its timeline line in one write transaction. The
  // move happens only from the states given, so a mark from the page and one
  // from the CLI cannot both succeed. False when it did not move.
  markDraft(
    invoiceId: string,
    id: number,
    move: DraftMove,
    from: DraftState[],
    by: string | null,
    note: string | null,
    line: string,
  ): boolean {
    const column: Record<DraftMove, string> = {
      copied: "copied_by = ?, copied_at = ?",
      sent: "sent_by = ?, sent_at = ?",
      dismissed: "dismissed_by = ?, dismissed_at = ?, dismiss_note = ?",
    };
    return this.transaction((): boolean => {
      const values: (string | number | null)[] = [move, by, new Date().toISOString()];
      if (move === "dismissed") {
        values.push(note);
      }
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE outbox SET state = ?, ${column[move]}
            WHERE id = ? AND invoice_id = ? AND state IN (${from.map((): string => "?").join(", ")})`,
        )
        .run(...values, id, invoiceId, ...from);
      if (Number(result.changes) !== 1) {
        return false;
      }
      this.appendEvent(invoiceId, "outbox", line, `outbox:${id}`);
      return true;
    });
  }

  drafts(invoiceId: string): Draft[] {
    return (
      this.db.prepare("SELECT * FROM outbox WHERE invoice_id = ? ORDER BY id").all(invoiceId) as unknown as DraftRow[]
    ).map(toDraft);
  }

  draft(id: number): Draft | undefined {
    const row: DraftRow | undefined = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as unknown as
      | DraftRow
      | undefined;
    return row === undefined ? undefined : toDraft(row);
  }
}

export type DraftState = "draft" | "copied" | "sent" | "dismissed";
export type DraftMove = "copied" | "sent" | "dismissed";

// A message for a person to send, never sent by PayOnce. facts is the JSON the
// text was rendered from, and textHash the SHA-256 of the template, subject and
// body, as recorded on the timeline when it was drafted.
export interface NewDraft {
  invoiceId: string;
  template: string;
  audience: string;
  facts: string;
  subject: string;
  body: string;
  textHash: string;
  createdBy: string;
}

export interface Draft extends NewDraft {
  id: number;
  state: DraftState;
  createdAt: string;
  copiedBy: string | null;
  copiedAt: string | null;
  sentBy: string | null;
  sentAt: string | null;
  dismissedBy: string | null;
  dismissedAt: string | null;
  dismissNote: string | null;
}

// A draft of the template is already open on the invoice.
export class DraftOpenError extends Error {
  readonly draftId: number;

  constructor(draftId: number) {
    super(`Draft ${draftId} of this message is still open. Mark it sent or dismiss it first`);
    this.name = "DraftOpenError";
    this.draftId = draftId;
  }
}

interface DraftRow {
  id: number;
  invoice_id: string;
  template: string;
  audience: string;
  facts: string;
  subject: string;
  body: string;
  text_hash: string;
  state: DraftState;
  created_by: string;
  created_at: string;
  copied_by: string | null;
  copied_at: string | null;
  sent_by: string | null;
  sent_at: string | null;
  dismissed_by: string | null;
  dismissed_at: string | null;
  dismiss_note: string | null;
}

function toDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    template: row.template,
    audience: row.audience,
    facts: row.facts,
    subject: row.subject,
    body: row.body,
    textHash: row.text_hash,
    createdBy: row.created_by,
    state: row.state,
    createdAt: row.created_at,
    copiedBy: row.copied_by,
    copiedAt: row.copied_at,
    sentBy: row.sent_by,
    sentAt: row.sent_at,
    dismissedBy: row.dismissed_by,
    dismissedAt: row.dismissed_at,
    dismissNote: row.dismiss_note,
  };
}

// A condition that needs a person, as an alert evaluation found it. facts is
// the JSON an alert about it is built from.
export interface FoundCondition {
  key: string;
  kind: string;
  fingerprint: string;
  facts: string;
}

export interface RecordedConditions {
  first: boolean;
  queued: number;
  standing: number;
}

// The inbox as alerts see it. newest is null while nothing was ever uploaded.
export interface InboxWaiting {
  waiting: number;
  newest: number | null;
}

export type AlertState = "queued" | "sending" | "sent" | "failed" | "skipped";

export interface Alert {
  id: number;
  key: string;
  episode: number;
  fingerprint: string;
  kind: string;
  facts: string;
  state: AlertState;
  tries: number;
  nextTryAt: string;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

// How a sender leaves an alert. nextTryAt is when a queued one is due again.
export interface AlertFinish {
  state: AlertState;
  tried: boolean;
  nextTryAt: number | null;
  error: string | null;
}

interface ConditionRow {
  alert_key: string;
  fingerprint: string;
  episode: number;
  seen_at: string;
  cleared_at: string | null;
}

interface AlertRow {
  id: number;
  alert_key: string;
  episode: number;
  fingerprint: string;
  kind: string;
  facts: string;
  state: AlertState;
  tries: number;
  next_try_at: string;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    key: row.alert_key,
    episode: row.episode,
    fingerprint: row.fingerprint,
    kind: row.kind,
    facts: row.facts,
    state: row.state,
    tries: row.tries,
    nextTryAt: row.next_try_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

// ---------- supplier view ----------

interface SupplierObligationRow {
  invoice_id: string;
  beneficiary_id: string;
  supplier: string;
  state: ObligationState;
  escalation_reason: string;
  supplier_domain: string;
  supplier_phone: string | null;
  duplicate_of: string | null;
  currency: string;
  transfer_method: TransferMethod;
}

function toSupplierObligation(row: SupplierObligationRow): SupplierObligation {
  return {
    invoiceId: row.invoice_id,
    beneficiaryId: row.beneficiary_id,
    supplier: row.supplier,
    state: row.state,
    escalationReason: row.escalation_reason,
    supplierDomain: row.supplier_domain,
    supplierPhone: row.supplier_phone,
    duplicateOf: row.duplicate_of === null ? [] : stringsOf(row.duplicate_of),
    currency: row.currency,
    transferMethod: row.transfer_method,
  };
}

// A supplier read with every accountKey given as the routeKey of the same
// details where the ledger knows it (accountRoutes), so the view groups accounts
// by where the money goes and a bank name Airwallex rewrote makes no new one. A
// key the ledger knows no routeKey for stays as it is.
function routedRead<
  T extends {
    attempts: SupplierAttempt[];
    payouts: SupplierPayout[];
    approvals: SupplierApproval[];
    runRows: SupplierRunRow[];
  },
>(read: T, routes: Map<string, string>): T {
  const route = (key: string | null): string | null => (key === null ? null : (routes.get(key) ?? key));
  return {
    ...read,
    attempts: read.attempts.map((attempt: T["attempts"][number]) => ({
      ...attempt,
      accountKey: route(attempt.accountKey),
      sentKey: route(attempt.sentKey),
    })),
    payouts: read.payouts.map((payout: T["payouts"][number]) => ({ ...payout, sentKey: route(payout.sentKey) })),
    approvals: read.approvals.map((approval: SupplierApproval) => ({ ...approval, accountKey: route(approval.accountKey) })),
    runRows: read.runRows.map((row: SupplierRunRow) => ({ ...row, accountKey: route(row.accountKey) })),
  };
}

// What the list and a detail read of every attempt.
const SUPPLIER_ATTEMPT_COLUMNS: string = `attempts.invoice_id, obligations.beneficiary_id, attempts.transfer_id,
  attempts.state, attempts.failure_code, attempts.account_key, attempts.sent_key, attempts.sent_ending,
  attempts.misdirected, attempts.bank_created_at, attempts.opened_at, attempts.bank_status,
  attempts.found_late_at, attempts.mismatched_transfer_id, attempts.mismatched_status`;

interface SupplierAttemptRow {
  invoice_id: string;
  beneficiary_id: string;
  transfer_id: string | null;
  state: AttemptState;
  failure_code: string | null;
  account_key: string | null;
  sent_key: string | null;
  sent_ending: string | null;
  misdirected: number;
  bank_created_at: string | null;
  opened_at: string | null;
  bank_status: string | null;
  found_late_at: string | null;
  mismatched_transfer_id: string | null;
  mismatched_status: string | null;
}

function toSupplierAttempt(row: SupplierAttemptRow): SupplierAttempt {
  return {
    invoiceId: row.invoice_id,
    beneficiaryId: row.beneficiary_id,
    transferId: row.transfer_id,
    state: row.state,
    failureCode: row.failure_code,
    accountKey: row.account_key ?? null,
    sentKey: row.sent_key ?? null,
    sentEnding: row.sent_ending ?? null,
    misdirected: row.misdirected === 1,
    bankCreatedAt: row.bank_created_at ?? null,
    openedAt: row.opened_at ?? null,
    bankStatus: row.bank_status ?? null,
    foundLateAt: row.found_late_at ?? null,
    mismatchedTransferId: row.mismatched_transfer_id ?? null,
    mismatchedStatus: row.mismatched_status ?? null,
  };
}

interface SupplierPaymentRow extends SupplierAttemptRow {
  kind: AttemptKind;
  reference: string | null;
  amount_minor: number | null;
  currency: string | null;
  fee_minor: number | null;
  fee_currency: string | null;
  rate_mismatch: number;
  mismatched_reference: string | null;
  arrival: string | null;
}

// What the list and a detail read of every payout sent outside PayOnce.
const SUPPLIER_PAYOUT_COLUMNS: string = `outside_payouts.invoice_id, obligations.beneficiary_id,
  outside_payouts.state, outside_payouts.found_at, outside_payouts.sent_key, outside_payouts.sent_ending`;

interface SupplierPayoutRow {
  invoice_id: string;
  beneficiary_id: string;
  state: PayoutState;
  found_at: string;
  sent_key: string | null;
  sent_ending: string | null;
}

function toSupplierPayout(row: SupplierPayoutRow): SupplierPayout {
  return {
    invoiceId: row.invoice_id,
    beneficiaryId: row.beneficiary_id,
    state: row.state,
    foundAt: row.found_at,
    sentKey: row.sent_key ?? null,
    sentEnding: row.sent_ending ?? null,
  };
}

interface SupplierApprovalRow {
  id: number;
  invoice_id: string;
  beneficiary_id: string;
  state: ApprovalState;
  requested_at: string | null;
  account_key: unknown;
}

interface SupplierCallbackRow {
  id: number;
  invoice_id: string;
  beneficiary_id: string;
  called_by: string;
  number_called: string;
  called_at: string;
  state: BankChangeState;
  applied_key: string | null;
  old_details: string;
  recorded_at: string;
}

type SupplierDraftRow = Omit<DraftRow, "facts" | "subject" | "body" | "text_hash" | "dismiss_note">;

interface SupplierHoldRow extends OutageHoldRow {
  currency: string;
  method: string;
  outage_state: OutageState;
  ended_at: string | null;
}

interface SupplierRunRowRecord {
  id: number;
  run_id: number;
  run_state: RunState;
  checked_at: string;
  line: number;
  invoice_id: string | null;
  beneficiary_id: string | null;
  supplier: string | null;
  payee: string | null;
  currency: string | null;
  amount_minor: number | null;
  action: RunRowAction;
  state: RunRowState;
  new_payee: number;
  bank_change_id: number | null;
  account_key: string | null;
  skip_reasons: number | null;
}

// Stored JSON. Outside readingSoft a row mapper reads it with JSON.parse, so text
// that does not parse throws: the engine, the policy, approvals, terms and
// bindings fail closed on a row they cannot read, and a look that throws is tried
// again a minute later and pays nothing. Inside readingSoft, which only views and
// the lists of invoices to wake run, a value that does not parse, or is not the
// shape PayOnce writes, reads as none, so one spoiled row cannot fail a whole
// view. What PayOnce writes reads the same either way.
let softReads: number = 0;

// Runs a view's reads with stored JSON read soft. The reads must be synchronous,
// so no step of the engine runs while they do.
export function readingSoft<T>(read: () => T): T {
  softReads += 1;
  try {
    const result: T = read();
    if (result instanceof Promise) {
      throw new Error("readingSoft takes synchronous reads only");
    }
    return result;
  } finally {
    softReads -= 1;
  }
}

function parsedOf(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

// A JSON list of strings as a column keeps it, or none when it is not one.
function stringsOf(json: string): string[] {
  const parsed: unknown = parsedOf(json);
  return Array.isArray(parsed) ? parsed.filter((item: unknown): item is string => typeof item === "string") : [];
}

// A stored list of strings.
export function storedStrings(json: string): string[] {
  return softReads === 0 ? (JSON.parse(json) as string[]) : stringsOf(json);
}

// A stored list.
export function storedList<T>(json: string): T[] {
  if (softReads === 0) {
    return JSON.parse(json) as T[];
  }
  const parsed: unknown = parsedOf(json);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

// A stored object, or null.
export function storedObject<T>(json: string): T | null {
  if (softReads === 0) {
    return JSON.parse(json) as T | null;
  }
  const parsed: unknown = parsedOf(json);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
}

// An invoice as the supplier list reads it: only what its cautions, counts and
// names use. A detail reads its record's invoices in full.
export type SupplierObligation = Pick<
  Obligation,
  | "invoiceId"
  | "beneficiaryId"
  | "supplier"
  | "state"
  | "escalationReason"
  | "supplierDomain"
  | "supplierPhone"
  | "duplicateOf"
  | "currency"
  | "transferMethod"
>;

// An attempt as the supplier view's accounts and cautions read it: with its
// invoice's beneficiary record, whether its transfer went to other details than
// it was meant for, where the transfer went as last read, and what liveAtBank
// tests.
export interface SupplierAttempt {
  invoiceId: string;
  beneficiaryId: string;
  transferId: string | null;
  state: AttemptState;
  failureCode: string | null;
  accountKey: string | null;
  sentKey: string | null;
  sentEnding: string | null;
  misdirected: boolean;
  bankCreatedAt: string | null;
  openedAt: string | null;
  bankStatus: string | null;
  foundLateAt: string | null;
  mismatchedTransferId: string | null;
  mismatchedStatus: string | null;
}

// An attempt as a record's detail shows it. rateMismatch says only whether the
// rate did not match, and arrival is the route advisory's JSON as kept, read only
// for the payment that paid a listed invoice.
export interface SupplierPayment extends SupplierAttempt {
  kind: AttemptKind;
  reference: string | null;
  amountMinor: number | null;
  currency: string | null;
  feeMinor: number | null;
  feeCurrency: string | null;
  rateMismatch: boolean;
  mismatchedReference: string | null;
  arrival: string | null;
}

export interface SupplierPayout {
  invoiceId: string;
  beneficiaryId: string;
  state: PayoutState;
  foundAt: string;
  sentKey: string | null;
  sentEnding: string | null;
}

// A payout as a record's detail shows it.
export interface SupplierPayoutView extends SupplierPayout {
  transferId: string;
  reference: string;
  amountMinor: number | null;
  currency: string | null;
  feeMinor: number | null;
  feeCurrency: string | null;
}

// An approval request with the account its terms name, never the terms.
export interface SupplierApproval {
  id: number;
  invoiceId: string;
  beneficiaryId: string;
  state: ApprovalState;
  requestedAt: string | null;
  accountKey: string | null;
}

// A callback without what the person typed about it: nobody spoken to, nothing
// confirmed and no new details. oldDetails is read only for its account key and
// ending.
export interface SupplierCallback {
  id: number;
  invoiceId: string;
  beneficiaryId: string;
  calledBy: string;
  numberCalled: string;
  calledAt: string;
  state: BankChangeState;
  appliedKey: string | null;
  oldDetails: string;
  recordedAt: string;
}

// An email's addresses and whether it was read in full, for the sender check.
export interface SupplierEmailFacts {
  invoiceId: string;
  from: string;
  replyTo: string[];
  partial: boolean;
}

export interface SupplierFindings {
  invoiceId: string;
  findings: string;
}

// A draft without its subject, body, facts or dismiss note.
export interface SupplierDraft {
  id: number;
  invoiceId: string;
  template: string;
  audience: string;
  state: DraftState;
  createdBy: string;
  createdAt: string;
  copiedBy: string | null;
  copiedAt: string | null;
  sentBy: string | null;
  sentAt: string | null;
  dismissedBy: string | null;
  dismissedAt: string | null;
}

export interface SupplierHold extends OutageHold {
  currency: string;
  method: string;
  outageState: OutageState;
  endedAt: string | null;
}

export interface SupplierFailure extends RailFailure {
  beneficiaryId: string;
}

// A run row without its cells, reasons or pay-to line: only how many reasons it
// was skipped for.
export interface SupplierRunRow {
  id: number;
  runId: number;
  runState: RunState;
  checkedAt: string;
  line: number;
  invoiceId: string | null;
  beneficiaryId: string;
  supplier: string | null;
  currency: string | null;
  amountMinor: number | null;
  action: RunRowAction;
  state: RunRowState;
  newPayee: boolean;
  bankChangeId: number | null;
  accountKey: string | null;
  skipReasons: number;
}

interface SupplierShared {
  approvals: SupplierApproval[];
  callbacks: SupplierCallback[];
  emails: SupplierEmailFacts[];
  findings: SupplierFindings[];
  failures: SupplierFailure[];
  // Newest run first, in file order within a run.
  runRows: SupplierRunRow[];
}

export interface SupplierListRead extends SupplierShared {
  // Newest first.
  obligations: SupplierObligation[];
  attempts: SupplierAttempt[];
  payouts: SupplierPayout[];
  // Empty: only a detail reads them.
  drafts: SupplierDraft[];
  holds: SupplierHold[];
}

export interface SupplierRead extends SupplierListRead {
  obligations: Obligation[];
  attempts: SupplierPayment[];
  payouts: SupplierPayoutView[];
}

export interface SupplierLinks {
  names: { beneficiaryId: string; name: string; newest: number }[];
  keys: { beneficiaryId: string; key: string }[];
  callbacks: { beneficiaryId: string; appliedKey: string | null; oldDetails: string }[];
  payees: { beneficiaryId: string; payee: string }[];
}

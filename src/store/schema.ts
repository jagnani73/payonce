import type { StatementSync } from "node:sqlite";
import { ROUTE_SCHEME } from "../domain/assess.js";
import { parseReason, reasonColumns, type ReasonColumns } from "../domain/reasons.js";
import type { BankChangeStore } from "./bank-changes.js";
import { seedContacts } from "./contacts.js";
import type { ColumnRow, Db } from "./db.js";

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
  CREATE TABLE IF NOT EXISTS supplier_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    beneficiary_id TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    digits TEXT NOT NULL DEFAULT '',
    replaces_id INTEGER,
    state TEXT NOT NULL,
    origin TEXT NOT NULL,
    proposed_by TEXT,
    proposed_at TEXT NOT NULL,
    proposed_source TEXT NOT NULL DEFAULT '',
    proposed_note TEXT NOT NULL DEFAULT '',
    seen_in_emails INTEGER NOT NULL DEFAULT 0,
    seen_flagged INTEGER NOT NULL DEFAULT 0,
    confirmed_by TEXT,
    confirmed_at TEXT,
    confirmed_source TEXT,
    confirmed_note TEXT,
    closed_by TEXT,
    closed_at TEXT,
    close_note TEXT,
    withdrawn_requests INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_contact_on_file
    ON supplier_contacts(beneficiary_id, field) WHERE state = 'on_file';
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_proposal
    ON supplier_contacts(beneficiary_id, field) WHERE state = 'proposed';
  CREATE INDEX IF NOT EXISTS contacts_by_beneficiary ON supplier_contacts(beneficiary_id, field, id);
`;

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
    // escalation_reason as codes (domain/reasons.ts): its lead's code, '' with no
    // reason and 'unrecognised' for a text PayOnce does not write, and its clauses
    // and slots as JSON. Written with the text by every escalation, and backfilled
    // from the text once when the columns are added. The text stays the record: a
    // row whose codes do not render it is read by its text.
    escalation_code: "TEXT NOT NULL DEFAULT ''",
    escalation_clauses: "TEXT NOT NULL DEFAULT '[]'",
    escalation_slots: "TEXT NOT NULL DEFAULT '{}'",
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
    // The routeKeys of account_key and sent_key: where the money goes. Nothing
    // that sends money reads them: a transfer (accountMismatch) and every retry
    // (requireAccount) are checked against the full account_key. The
    // first-payment hold, payeeRule and the pay run checks compare a record with
    // the route_key of the account PayOnce last paid (lastPaidTransfer), and the
    // supplier view groups accounts by them. Null on attempts from before the
    // columns that no callback on file gave details for (rebuildRoutes).
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
    // The callback that verified the account, as verifiedBankChange found it,
    // whether or not it is the one PayOnce last paid. bank_change_id is the same
    // callback only when it is not. Null on rows from before it.
    verified_by: "INTEGER",
    // The latest transfer that failed on the account with an account-level code,
    // when nothing to it was paid after, as AccountFailure JSON. Null on rows from
    // before it.
    account_failure: "TEXT",
  },
  bank_changes: {
    // The supplier_contacts row of the phone number the callback was made on.
    // Only while that row is on file does the callback verify bank details.
    // Null on a callback made on a number that was never a record's on file.
    contact_id: "INTEGER",
  },
  outside_payouts: {
    reference: "TEXT NOT NULL DEFAULT ''",
    state: "TEXT NOT NULL DEFAULT 'in_flight'",
    amount_minor: "INTEGER",
    currency: "TEXT",
    fee_minor: "INTEGER",
    fee_currency: "TEXT",
    fee_tried_at: "TEXT",
    // As on attempts. sent_route also says whether a paid payout pays its
    // invoice (payoutVerdict).
    sent_key: "TEXT",
    sent_ending: "TEXT",
    sent_route: "TEXT",
    // The beneficiary record the payout was sent to, as Airwallex gave it. Null on
    // payouts tied before it was kept and not read since.
    beneficiary_id: "TEXT",
    // What the payout delivered (transfer_amount and transfer_currency), as last
    // read.
    delivered_minor: "INTEGER",
    delivered_currency: "TEXT",
    // When this code last read the payout from Airwallex. Null on a payout tied
    // before it was kept, which the next look reads once, a paid one included.
    checked_at: "TEXT",
    // 1 when the last look found the payout pays its invoice, 0 when it found it
    // does not or could not tell, and null until a look has judged it, which
    // counts as not paying too.
    pays: "INTEGER",
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

// The tables a ledger gets, the columns added since the first version, the time
// triggers and the upgrades an older file gets on open.
export class Schema {
  private readonly db: Db;
  private readonly bankChanges: BankChangeStore;

  constructor(db: Db, bankChanges: BankChangeStore) {
    this.db = db;
    this.bankChanges = bankChanges;
  }

  // Creates the tables a new ledger gets and adds what an older one lacks, then
  // stamps when the ledger was first opened.
  create(): void {
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
  }

  // Under the write lock, so two processes opening an older file at once do not
  // both add a column.
  private addColumns(): void {
    this.db.transaction((): void => {
      let accountKeyAdded: boolean = false;
      let reasonCodesAdded: boolean = false;
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
            if (table === "obligations" && name === "escalation_code") {
              reasonCodesAdded = true;
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
      if (reasonCodesAdded) {
        this.backfillReasonCodes();
      }
      this.rebuildRoutes();
      seedContacts(this.db);
    });
  }

  // Every invoice with a reason from before the code columns gets the codes its
  // text parses to, 'unrecognised' for a text PayOnce does not write. Only inside
  // addColumns' transaction.
  private backfillReasonCodes(): void {
    const rows = this.db
      .prepare("SELECT invoice_id, escalation_reason FROM obligations WHERE escalation_reason <> ''")
      .all() as unknown as { invoice_id: string; escalation_reason: string }[];
    const set: StatementSync = this.db.prepare(
      `UPDATE obligations SET escalation_code = ?, escalation_clauses = ?, escalation_slots = ?
        WHERE invoice_id = ?`,
    );
    for (const row of rows) {
      const columns: ReasonColumns = reasonColumns(parseReason(row.escalation_reason));
      set.run(columns.code, columns.clauses, columns.slots, row.invoice_id);
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

  // When the stored routeKeys were built by another scheme than ROUTE_SCHEME, or
  // before there were any, every one is rebuilt: cleared to null, which reads as
  // not known, then each accountKey that matches bank details a callback kept
  // (the record before the change, or after it, applied_key) gets the routeKey of
  // those details. Attempts, where they went, run rows, payouts sent outside
  // PayOnce and approval requests alike. Any other stays null and is compared by
  // its full accountKey only. meta.route_scheme says which scheme the stored
  // keys are, so this runs once per change of scheme. Only inside addColumns'
  // transaction, under the write lock that adds the columns.
  private rebuildRoutes(): void {
    const scheme: { value: string } | undefined = this.db
      .prepare("SELECT value FROM meta WHERE key = 'route_scheme'")
      .get() as unknown as { value: string } | undefined;
    if (scheme?.value === ROUTE_SCHEME) {
      return;
    }
    const routes: Map<string, string> = this.bankChanges.callbackRoutes();
    const pairs: [string, string, string][] = [
      ["attempts", "account_key", "route_key"],
      ["attempts", "sent_key", "sent_route"],
      ["outside_payouts", "sent_key", "sent_route"],
      ["run_rows", "account_key", "route_key"],
      ["approvals", "CASE WHEN json_valid(terms) THEN json_extract(terms, '$.accountKey') END", "route_key"],
    ];
    for (const [table, full, route] of pairs) {
      this.db.exec(`UPDATE ${table} SET ${route} = NULL`);
      const set: StatementSync = this.db.prepare(`UPDATE ${table} SET ${route} = ? WHERE ${full} = ?`);
      for (const [key, value] of routes) {
        set.run(value, key);
      }
    }
    // Each payout sent outside PayOnce is read again on the next look and judged
    // by the new keys.
    this.db.exec("UPDATE outside_payouts SET checked_at = NULL, pays = NULL");
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('route_scheme', ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(ROUTE_SCHEME);
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

  // False for a file opened read-only from before pay runs, which has no runs table.
  hasRunTable(): boolean {
    return (this.db.prepare("PRAGMA table_info(runs)").all() as unknown as ColumnRow[]).length > 0;
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
}

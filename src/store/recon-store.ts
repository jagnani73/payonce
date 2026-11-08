import type { StatementSync } from "node:sqlite";
import {
  restartOf,
  type ChainedReconEvent,
  type ReconAuditSnapshot,
  type ReconEventFields,
} from "./audit-trail.js";
import { oneLine, storable } from "../text/printable.js";
import { GENESIS, RECON_CHAIN } from "./chain.js";
import type { Db } from "./db.js";
import type {
  BreakKind,
  ClearReason,
  ClosedInvoice,
  FoundBreak,
  LedgerTransfer,
  MatchResult,
  Movement,
  ReconTransfer,
} from "../recon/recon-match.js";

// Reconciliation's tables, on the ledger's own connection. They hold a copy of
// what Airwallex last showed (wallet_movements, recon_transfers), the transfers
// Airwallex refused to show (recon_lookups), the runs, the breaks a person sees,
// and recon_events, the hash chain of what PayOnce found and what people said
// about it. Nothing here touches an invoice: the ledger's
// tables are only read, to match transfers by id.
const RECON_SCHEMA: string = `
  CREATE TABLE IF NOT EXISTS wallet_movements (
    id TEXT PRIMARY KEY,
    currency TEXT NOT NULL,
    amount_minor INTEGER,
    balance_minor INTEGER,
    posted_ms INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    source_id TEXT,
    source_type TEXT,
    transaction_type TEXT,
    read_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS wallet_movements_by_wallet ON wallet_movements(currency, posted_ms);
  CREATE INDEX IF NOT EXISTS wallet_movements_by_time ON wallet_movements(posted_ms);
  CREATE TABLE IF NOT EXISTS recon_transfers (
    transfer_id TEXT PRIMARY KEY,
    found INTEGER NOT NULL,
    short_reference TEXT,
    status TEXT,
    method TEXT,
    created_ms INTEGER,
    updated_ms INTEGER,
    debit_minor INTEGER,
    debit_currency TEXT,
    transfer_minor INTEGER,
    transfer_currency TEXT,
    fee_minor INTEGER,
    fee_currency TEXT,
    failed_seen_ms INTEGER,
    read_at TEXT NOT NULL,
    paid_seen_ms INTEGER
  );
  CREATE TABLE IF NOT EXISTS recon_lookups (
    transfer_id TEXT PRIMARY KEY,
    refused_ms INTEGER NOT NULL,
    status INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recon_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ran_from TEXT NOT NULL,
    mode TEXT NOT NULL,
    full_read INTEGER NOT NULL DEFAULT 0,
    reads INTEGER NOT NULL DEFAULT 0,
    outcome TEXT,
    finished_at TEXT,
    error TEXT,
    summary TEXT
  );
  CREATE TABLE IF NOT EXISTS recon_breaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    currency TEXT NOT NULL,
    invoice_id TEXT,
    transfer_id TEXT,
    facts TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    found_at TEXT NOT NULL,
    opened_at TEXT,
    gone_at TEXT,
    cleared_at TEXT,
    explained_by TEXT,
    explained_at TEXT,
    note TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_break_per_key ON recon_breaks(key) WHERE state IN ('pending', 'open');
  CREATE INDEX IF NOT EXISTS recon_breaks_by_key ON recon_breaks(key, id);
  CREATE INDEX IF NOT EXISTS recon_breaks_by_state ON recon_breaks(state, id);
  CREATE TABLE IF NOT EXISTS recon_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    break_id INTEGER NOT NULL REFERENCES recon_breaks(id),
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
`;

// The newest run whose findings are recorded. A run that started before it
// commits nothing.
const COMMITTED_RUN_KEY: string = "recon_committed_run";
// When the last run that read every window since the ledger started committed.
const FULL_READ_KEY: string = "recon_full_read_at";
// Lines that say a break is new or has new facts. The alert follows them.
const NEWS_KINDS: readonly string[] = ["found", "changed", "reopened"];
const CLEARED_BECAUSE: Record<ClearReason, string> = {
  airwallex: "Airwallex's records no longer show it",
  tied: "the sweep tied the payout to an invoice",
};

export type RanFrom = "server" | "terminal";
export type ReconMode = "live" | "offline";
export type ReconOutcome = "committed" | "stale" | "failed";
// pending: found once, opened when the next live run finds it too. open: waits
// for a person, or to clear by itself. explained: a person said what it is, bound to
// the facts they were shown. cleared: no longer found.
export type BreakState = "pending" | "open" | "explained" | "cleared";

export interface ReconRun {
  id: number;
  startedAt: string;
  ranFrom: RanFrom;
  mode: ReconMode;
  fullRead: boolean;
  reads: number;
  outcome: ReconOutcome | null;
  finishedAt: string | null;
  error: string | null;
  summary: string | null;
}

export interface ReconBreak {
  id: number;
  key: string;
  kind: BreakKind;
  subject: string;
  currency: string;
  invoiceId: string | null;
  transferId: string | null;
  facts: string;
  fingerprint: string;
  state: BreakState;
  foundAt: string;
  openedAt: string | null;
  goneAt: string | null;
  clearedAt: string | null;
  explainedBy: string | null;
  explainedAt: string | null;
  note: string | null;
}

// A refund missing break with its transfer as the last check read it, null when
// no check has stored that transfer.
export interface RefundBreak extends ReconBreak {
  transfer: ReconTransfer | null;
}

export interface BreakTimes {
  kind: string;
  state: string;
  openedAt: string;
  explainedAt: string | null;
  clearedAt: string | null;
}

// One window of balance history, read to its last page, in Airwallex's order.
export interface WindowRead {
  fromMs: number;
  toMs: number;
  movements: Movement[];
}

// A transfer a movement names that Airwallex refused to show, with the status it
// answered.
export interface RefusedLookup {
  transferId: string;
  status: number;
}

export interface ReconWrite {
  windows: WindowRead[];
  // The range the read replaces: a stored movement posted in it that no window
  // listed is deleted.
  replaceFromMs: number;
  replaceToMs: number;
  transfers: ReconTransfer[];
  refused: RefusedLookup[];
  fullRead: boolean;
  reads: number;
}

// What the matcher works on, read inside the transaction that records it.
export interface ReconSnapshot {
  startedMs: number;
  movements: Movement[];
  transfers: ReconTransfer[];
  ledger: LedgerTransfer[];
  closed: ClosedInvoice[];
  refused: Set<string>;
  // The facts of the pending, open or explained break on each key.
  prior: Map<string, string>;
}

export interface ReconDecision {
  result: MatchResult;
  summary: string;
}

export interface CommitRules {
  decide: (snapshot: ReconSnapshot) => ReconDecision;
  // Whether a kind opens on the first live run that finds it.
  atOnce: (kind: BreakKind) => boolean;
  // Why a break no longer found clears, or null when it stays for a person.
  cleared: (kind: BreakKind, subject: string, result: MatchResult) => ClearReason | null;
  describe: (kind: BreakKind, facts: string) => string;
  // False for a match with no new read: it opens nothing and creates or changes
  // no found-once row, so what it finds new waits for the next live run to find.
  live: boolean;
}

export interface BreakChanges {
  opened: number;
  pending: number;
  changed: number;
  cleared: number;
  gone: number;
}

export type CommitResult = { stale: true } | { stale: false; changes: BreakChanges; result: MatchResult };

export interface ExplainItem {
  id: number;
  fingerprint: string;
}

// The breaks a person asked to explain that are not shown to anyone: not on
// file, or found only once so far.
export class ReconUnknownError extends Error {
  readonly ids: number[];

  constructor(ids: number[]) {
    super(`${ids.length === 1 ? "Break" : "Breaks"} ${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} not open`);
    this.name = "ReconUnknownError";
    this.ids = ids;
  }
}

// Breaks that changed since they were shown, or were explained or cleared.
export class ReconChangedError extends Error {
  readonly ids: number[];

  constructor(ids: number[]) {
    super(
      `${ids.length === 1 ? "Break" : "Breaks"} ${ids.join(", ")} changed since ${ids.length === 1 ? "it was" : "they were"} shown, or no longer ${ids.length === 1 ? "waits" : "wait"} for a person. Look again first`,
    );
    this.name = "ReconChangedError";
    this.ids = ids;
  }
}

export class ReconKindsError extends Error {
  constructor() {
    super("Explain breaks of one kind at a time, so the note is about all of them");
    this.name = "ReconKindsError";
  }
}

export interface KindTotal {
  kind: BreakKind;
  count: number;
}

// Only the breaks of the kinds the alert asks for count here.
export interface ReconAlertState {
  // Every such open break, counted in full.
  open: number;
  kinds: KindTotal[];
  currencies: string[];
  // The open break with the newest line saying it is new or has new facts, so a
  // break found once and opened later is named on the alert its line raised. The
  // open break with the highest number when no open break has such a line.
  newestOpen: ReconBreak | undefined;
  // The newest line saying a break is new or has new facts, in any state.
  newest: number;
}

interface MovementRow {
  id: string;
  currency: string;
  amount_minor: number | null;
  balance_minor: number | null;
  posted_ms: number;
  seq: number;
  source_id: string | null;
  source_type: string | null;
  transaction_type: string | null;
}

interface TransferRow {
  transfer_id: string;
  found: number;
  short_reference: string | null;
  status: string | null;
  method: string | null;
  created_ms: number | null;
  updated_ms: number | null;
  debit_minor: number | null;
  debit_currency: string | null;
  transfer_minor: number | null;
  transfer_currency: string | null;
  fee_minor: number | null;
  fee_currency: string | null;
  failed_seen_ms: number | null;
  paid_seen_ms: number | null;
}

interface RunRow {
  id: number;
  started_at: string;
  ran_from: RanFrom;
  mode: ReconMode;
  full_read: number;
  reads: number;
  outcome: ReconOutcome | null;
  finished_at: string | null;
  error: string | null;
  summary: string | null;
}

interface BreakRow {
  id: number;
  key: string;
  kind: BreakKind;
  subject: string;
  currency: string;
  invoice_id: string | null;
  transfer_id: string | null;
  facts: string;
  fingerprint: string;
  state: BreakState;
  found_at: string;
  opened_at: string | null;
  gone_at: string | null;
  cleared_at: string | null;
  explained_by: string | null;
  explained_at: string | null;
  note: string | null;
}

interface EventRow {
  id: number;
  break_id: number;
  at: string;
  kind: string;
  message: string;
  prev_hash: string | null;
  hash: string | null;
}

interface ColumnRow {
  name: string;
}

interface AttemptSide {
  invoice_id: string;
  kind: string;
  transfer_id: string | null;
  state: string;
  mismatched_transfer_id: string | null;
  mismatched_status: string | null;
  origin: string;
}

function toMovement(row: MovementRow): Movement {
  return {
    id: row.id,
    currency: row.currency,
    amountMinor: row.amount_minor,
    balanceMinor: row.balance_minor,
    postedMs: row.posted_ms,
    seq: row.seq,
    sourceId: row.source_id,
    sourceType: row.source_type,
    transactionType: row.transaction_type,
  };
}

function toTransfer(row: TransferRow): ReconTransfer {
  return {
    transferId: row.transfer_id,
    found: row.found === 1,
    reference: row.short_reference,
    status: row.status,
    method: row.method,
    createdMs: row.created_ms,
    updatedMs: row.updated_ms,
    debitMinor: row.debit_minor,
    debitCurrency: row.debit_currency,
    transferMinor: row.transfer_minor,
    transferCurrency: row.transfer_currency,
    feeMinor: row.fee_minor,
    feeCurrency: row.fee_currency,
    failedSeenMs: row.failed_seen_ms,
    paidSeenMs: row.paid_seen_ms,
  };
}

function toRun(row: RunRow): ReconRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    ranFrom: row.ran_from,
    mode: row.mode,
    fullRead: row.full_read === 1,
    reads: row.reads,
    outcome: row.outcome,
    finishedAt: row.finished_at,
    error: row.error,
    summary: row.summary,
  };
}

function toBreak(row: BreakRow): ReconBreak {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    subject: row.subject,
    currency: row.currency,
    invoiceId: row.invoice_id,
    transferId: row.transfer_id,
    facts: row.facts,
    fingerprint: row.fingerprint,
    state: row.state,
    foundAt: row.found_at,
    openedAt: row.opened_at,
    goneAt: row.gone_at,
    clearedAt: row.cleared_at,
    explainedBy: row.explained_by,
    explainedAt: row.explained_at,
    note: row.note,
  };
}

export class ReconStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Creates the tables and starts the chain, under the write lock, so two
  // processes opening a file at once do not both add a column. There is nothing
  // to backfill, so the running hash starts at the genesis, and only on a chain
  // that never had a line. Once it has, a running hash removed later stays
  // missing, and the audit says so, as it does for the invoice chain.
  ensure(): void {
    this.db.transaction((): void => {
      this.db.exec(RECON_SCHEMA);
      const columns: string[] = (
        this.db.prepare("PRAGMA table_info(recon_transfers)").all() as unknown as ColumnRow[]
      ).map((column: ColumnRow): string => column.name);
      if (!columns.includes("paid_seen_ms")) {
        this.db.exec("ALTER TABLE recon_transfers ADD COLUMN paid_seen_ms INTEGER");
      }
      // A chain whose lines came before the key takes it from its first line.
      this.db
        .prepare("INSERT OR IGNORE INTO meta (key, value) SELECT ?, at FROM recon_events ORDER BY id LIMIT 1")
        .run(RECON_CHAIN.shape.started);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO meta (key, value)
           SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM recon_events)
             AND NOT EXISTS (SELECT 1 FROM meta WHERE key = ?)`,
        )
        .run(RECON_CHAIN.shape.head, GENESIS, RECON_CHAIN.shape.started);
    });
  }

  // False on a file opened read-only that no PayOnce with reconciliation opened.
  hasTables(): boolean {
    return (this.db.prepare("PRAGMA table_info(recon_events)").all() as unknown as ColumnRow[]).length > 0;
  }

  // Every break that opened, with its kind, state and times only, for the
  // metrics: never its facts, note or who explained it. Only on a file that
  // hasTables, inside the caller's readSnapshot.
  breakTimes(): BreakTimes[] {
    return this.db
      .prepare(
        `SELECT kind, state, opened_at AS openedAt, explained_at AS explainedAt, cleared_at AS clearedAt
           FROM recon_breaks WHERE opened_at IS NOT NULL ORDER BY id`,
      )
      .all() as unknown as BreakTimes[];
  }

  private meta(key: string): string | null {
    const row: { value: string } | undefined = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // A run gets its number when it starts, under the write lock, so a later
  // number always means a later start, whichever process runs it.
  beginRun(ranFrom: RanFrom, mode: ReconMode, now: number): ReconRun {
    const row: RunRow = this.db.transaction((): RunRow => {
      this.db
        .prepare("INSERT INTO recon_runs (started_at, ran_from, mode) VALUES (?, ?, ?)")
        .run(new Date(now).toISOString(), ranFrom, mode);
      return this.db.prepare("SELECT * FROM recon_runs WHERE id = last_insert_rowid()").get() as unknown as RunRow;
    });
    return toRun(row);
  }

  // A run whose read failed records only the error. Every break stays as it was.
  failRun(id: number, error: string, reads: number, now: number): void {
    this.db
      .prepare("UPDATE recon_runs SET outcome = 'failed', error = ?, reads = ?, finished_at = ? WHERE id = ? AND outcome IS NULL")
      .run(error, reads, new Date(now).toISOString(), id);
  }

  fullReadAt(): number | null {
    const value: string | null = this.meta(FULL_READ_KEY);
    const at: number = value === null ? Number.NaN : Date.parse(value);
    return Number.isFinite(at) ? at : null;
  }

  // Every transfer id a run has read, found or not.
  knownTransferIds(): Set<string> {
    return new Set(
      (this.db.prepare("SELECT transfer_id FROM recon_transfers").all() as unknown as { transfer_id: string }[]).map(
        (row: { transfer_id: string }): string => row.transfer_id,
      ),
    );
  }

  // Every stored movement whose source no run has read as a transfer.
  unreadSources(): Movement[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM wallet_movements WHERE source_id IS NOT NULL
             AND source_id NOT IN (SELECT transfer_id FROM recon_transfers)`,
        )
        .all() as unknown as MovementRow[]
    ).map(toMovement);
  }

  // When Airwallex last refused to show each transfer a movement names, for the
  // ones no run has read since.
  refusedLookups(): Map<string, number> {
    return new Map(
      (
        this.db
          .prepare(
            `SELECT transfer_id, refused_ms FROM recon_lookups
              WHERE transfer_id NOT IN (SELECT transfer_id FROM recon_transfers)`,
          )
          .all() as unknown as { transfer_id: string; refused_ms: number }[]
      ).map((row: { transfer_id: string; refused_ms: number }): [string, number] => [row.transfer_id, row.refused_ms]),
    );
  }

  // When the last live run that was recorded matched what it read.
  lastLiveAt(): number | null {
    const row: { finished_at: string | null } | undefined = this.db
      .prepare("SELECT finished_at FROM recon_runs WHERE mode = 'live' AND outcome = 'committed' ORDER BY id DESC LIMIT 1")
      .get() as { finished_at: string | null } | undefined;
    const at: number = Date.parse(row?.finished_at ?? "");
    return Number.isFinite(at) ? at : null;
  }

  private snapshotRows(): ReconSnapshot {
    const started: string | null = this.meta("started_at");
    const movements: Movement[] = (
      this.db.prepare("SELECT * FROM wallet_movements ORDER BY posted_ms, seq DESC").all() as unknown as MovementRow[]
    ).map(toMovement);
    const transfers: ReconTransfer[] = (
      this.db.prepare("SELECT * FROM recon_transfers").all() as unknown as TransferRow[]
    ).map(toTransfer);
    const ledger: LedgerTransfer[] = [];
    const attempts: AttemptSide[] = this.db
      .prepare(
        `SELECT a.invoice_id, a.kind, a.transfer_id, a.state, a.mismatched_transfer_id, a.mismatched_status, o.origin
           FROM attempts a JOIN obligations o ON o.invoice_id = a.invoice_id
          WHERE a.transfer_id IS NOT NULL OR a.mismatched_transfer_id IS NOT NULL`,
      )
      .all() as unknown as AttemptSide[];
    for (const attempt of attempts) {
      if (attempt.transfer_id !== null) {
        // A found payout's original was sent outside PayOnce, which took it on.
        const outside: boolean = attempt.origin === "outside" && attempt.kind === "original";
        ledger.push({
          transferId: attempt.transfer_id,
          invoiceId: attempt.invoice_id,
          how: outside ? "outside" : "attempt",
          paid: attempt.state === "paid",
        });
      }
      if (attempt.mismatched_transfer_id !== null) {
        ledger.push({
          transferId: attempt.mismatched_transfer_id,
          invoiceId: attempt.invoice_id,
          how: "mismatched",
          paid: attempt.mismatched_status === "PAID",
        });
      }
    }
    const payouts: { invoice_id: string; transfer_id: string; state: string }[] = this.db
      .prepare("SELECT invoice_id, transfer_id, state FROM outside_payouts")
      .all() as unknown as { invoice_id: string; transfer_id: string; state: string }[];
    for (const payout of payouts) {
      ledger.push({ transferId: payout.transfer_id, invoiceId: payout.invoice_id, how: "outside", paid: payout.state === "paid" });
    }
    const closed: ClosedInvoice[] = (
      this.db
        .prepare("SELECT invoice_id, COALESCE(source_currency, currency) AS currency FROM obligations WHERE state = 'settled'")
        .all() as unknown as { invoice_id: string; currency: string }[]
    ).map((row: { invoice_id: string; currency: string }): ClosedInvoice => ({ invoiceId: row.invoice_id, currency: row.currency }));
    const prior: Map<string, string> = new Map();
    for (const row of this.db
      .prepare(
        `SELECT key, facts FROM recon_breaks WHERE id IN
           (SELECT MAX(id) FROM recon_breaks GROUP BY key)
           AND (state IN ('pending', 'open') OR (state = 'explained' AND gone_at IS NULL))`,
      )
      .all() as unknown as { key: string; facts: string }[]) {
      prior.set(row.key, row.facts);
    }
    return {
      startedMs: Date.parse(started ?? ""),
      movements,
      transfers,
      ledger,
      closed,
      refused: new Set(this.refusedLookups().keys()),
      prior,
    };
  }

  // What the matcher works on now, from the ledger alone, in one read.
  snapshot(): ReconSnapshot {
    return this.db.readSnapshot((): ReconSnapshot => this.snapshotRows());
  }

  private storeRead(write: ReconWrite, now: number): void {
    const at: string = new Date(now).toISOString();
    const inWindow: StatementSync = this.db.prepare(
      "SELECT id FROM wallet_movements WHERE posted_ms >= ? AND posted_ms < ?",
    );
    const remove: StatementSync = this.db.prepare("DELETE FROM wallet_movements WHERE id = ?");
    const upsert: StatementSync = this.db.prepare(
      `INSERT INTO wallet_movements
         (id, currency, amount_minor, balance_minor, posted_ms, seq, source_id, source_type, transaction_type, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET currency = excluded.currency, amount_minor = excluded.amount_minor,
         balance_minor = excluded.balance_minor, posted_ms = excluded.posted_ms, seq = excluded.seq,
         source_id = excluded.source_id, source_type = excluded.source_type,
         transaction_type = excluded.transaction_type, read_at = excluded.read_at`,
    );
    // Windows read to their last page are Airwallex's whole record for the range
    // they replace, so a movement none of them lists goes. Windows overlap, so the
    // range is taken as a whole: a movement one window lists on its edge and the
    // next leaves out stays. Both ends compare UTC milliseconds.
    const listed: Set<string> = new Set(
      write.windows.flatMap((window: WindowRead): string[] => window.movements.map((movement: Movement): string => movement.id)),
    );
    for (const row of inWindow.all(write.replaceFromMs, write.replaceToMs) as unknown as { id: string }[]) {
      if (!listed.has(row.id)) {
        remove.run(row.id);
      }
    }
    for (const window of write.windows) {
      for (const movement of window.movements) {
        upsert.run(
          movement.id,
          movement.currency,
          movement.amountMinor,
          movement.balanceMinor,
          movement.postedMs,
          movement.seq,
          movement.sourceId,
          movement.sourceType,
          movement.transactionType,
          at,
        );
      }
    }
    const transfer: StatementSync = this.db.prepare(
      `INSERT INTO recon_transfers
         (transfer_id, found, short_reference, status, method, created_ms, updated_ms, debit_minor, debit_currency,
          transfer_minor, transfer_currency, fee_minor, fee_currency, failed_seen_ms, paid_seen_ms, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(transfer_id) DO UPDATE SET found = excluded.found, short_reference = excluded.short_reference,
         status = excluded.status, method = excluded.method, created_ms = excluded.created_ms,
         updated_ms = excluded.updated_ms, debit_minor = excluded.debit_minor,
         debit_currency = excluded.debit_currency, transfer_minor = excluded.transfer_minor,
         transfer_currency = excluded.transfer_currency, fee_minor = excluded.fee_minor,
         fee_currency = excluded.fee_currency,
         failed_seen_ms = COALESCE(recon_transfers.failed_seen_ms, excluded.failed_seen_ms),
         paid_seen_ms = COALESCE(recon_transfers.paid_seen_ms, excluded.paid_seen_ms),
         read_at = excluded.read_at`,
    );
    const answered: StatementSync = this.db.prepare("DELETE FROM recon_lookups WHERE transfer_id = ?");
    for (const item of write.transfers) {
      answered.run(item.transferId);
      transfer.run(
        item.transferId,
        item.found ? 1 : 0,
        item.reference,
        item.status,
        item.method,
        item.createdMs,
        item.updatedMs,
        item.debitMinor,
        item.debitCurrency,
        item.transferMinor,
        item.transferCurrency,
        item.feeMinor,
        item.feeCurrency,
        item.failedSeenMs,
        item.paidSeenMs,
        at,
      );
    }
    const refused: StatementSync = this.db.prepare(
      `INSERT INTO recon_lookups (transfer_id, refused_ms, status) VALUES (?, ?, ?)
       ON CONFLICT(transfer_id) DO UPDATE SET refused_ms = excluded.refused_ms, status = excluded.status`,
    );
    for (const item of write.refused) {
      refused.run(item.transferId, now, item.status);
    }
  }

  // A transfer the ledger records as paid now is known to have been paid, so a
  // look that later reads it as failed cannot hide a payment that came back.
  private notePaid(now: number): void {
    this.db
      .prepare(
        `UPDATE recon_transfers SET paid_seen_ms = ? WHERE paid_seen_ms IS NULL AND transfer_id IN (
           SELECT transfer_id FROM attempts WHERE state = 'paid' AND transfer_id IS NOT NULL
           UNION SELECT mismatched_transfer_id FROM attempts WHERE mismatched_status = 'PAID'
           UNION SELECT transfer_id FROM outside_payouts WHERE state = 'paid')`,
      )
      .run(now);
  }

  // Chains one line. The caller holds the write transaction.
  private appendLine(breakId: number, kind: string, message: string, at: string): void {
    const last: { hash: string } | undefined = this.db
      .prepare("SELECT hash FROM recon_events ORDER BY id DESC LIMIT 1")
      .get() as { hash: string } | undefined;
    const prevHash: string = last?.hash ?? GENESIS;
    const line: ReconEventFields = { breakId, at, kind, message: storable(oneLine(message)) };
    const hash: string = RECON_CHAIN.hash(prevHash, line);
    const inserted: { lastInsertRowid: number | bigint } = this.db
      .prepare("INSERT INTO recon_events (break_id, at, kind, message, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)")
      .run(line.breakId, line.at, line.kind, line.message, prevHash, hash);
    // The first line starts the running hash from the genesis, and a running hash
    // missing after that was removed (HashChain.advance). The chain's first line
    // is the only line with no line, no key and no other opened break before it.
    const first: boolean =
      last === undefined &&
      this.meta(RECON_CHAIN.shape.started) === null &&
      this.meta(RECON_CHAIN.shape.restarted) === null &&
      this.db.prepare("SELECT 1 FROM recon_breaks WHERE id <> ? AND state <> 'pending' LIMIT 1").get(breakId) === undefined;
    RECON_CHAIN.advance(this.db, hash, at, Number(inserted.lastInsertRowid), `break ${breakId}`, !first);
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(RECON_CHAIN.shape.started, at);
  }

  private insertBreak(found: FoundBreak, state: "pending" | "open", at: string): number {
    this.db
      .prepare(
        `INSERT INTO recon_breaks
           (key, kind, subject, currency, invoice_id, transfer_id, facts, fingerprint, state, found_at, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        found.key,
        found.kind,
        found.subject,
        found.currency,
        found.invoiceId,
        found.transferId,
        found.facts,
        found.fingerprint,
        state,
        at,
        state === "open" ? at : null,
      );
    return Number((this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  }

  // Compares what a run found with the breaks on file and writes only what
  // differs, with one chained line for each change. A kind that does not open at
  // once opens only when two live runs in a row find the same facts, and a run
  // with no new read opens nothing and neither creates nor changes a found-once
  // row, so it never stands in for one of those runs. One open break per key: new
  // facts update it.
  // A kind that waits for a person never clears by itself: only an explanation
  // ends it, and the sweep tying a payout ends its untied break. An explanation
  // holds for the facts it was given on, and only while they are found without a
  // gap.
  private recordBreaks(result: MatchResult, now: number, rules: CommitRules): BreakChanges {
    const at: string = new Date(now).toISOString();
    const changes: BreakChanges = { opened: 0, pending: 0, changed: 0, cleared: 0, gone: 0 };
    const found: Map<string, FoundBreak> = new Map();
    for (const item of result.breaks) {
      if (!found.has(item.key)) {
        found.set(item.key, item);
      }
    }
    const live: Map<string, BreakRow> = new Map(
      (this.db.prepare("SELECT * FROM recon_breaks WHERE state IN ('pending', 'open')").all() as unknown as BreakRow[]).map(
        (row: BreakRow): [string, BreakRow] => [row.key, row],
      ),
    );
    const explained: Map<string, BreakRow> = new Map(
      (
        this.db
          .prepare(
            `SELECT * FROM recon_breaks WHERE id IN (SELECT MAX(id) FROM recon_breaks GROUP BY key)
               AND state = 'explained' AND gone_at IS NULL`,
          )
          .all() as unknown as BreakRow[]
      ).map((row: BreakRow): [string, BreakRow] => [row.key, row]),
    );
    const text = (item: FoundBreak): string => rules.describe(item.kind, item.facts);
    const update: StatementSync = this.db.prepare(
      `UPDATE recon_breaks SET facts = ?, fingerprint = ?, currency = ?, invoice_id = ?, transfer_id = ?,
         gone_at = NULL WHERE id = ?`,
    );

    for (const item of found.values()) {
      const row: BreakRow | undefined = live.get(item.key);
      if (row !== undefined) {
        if (row.state === "pending") {
          if (!rules.live) {
            continue;
          }
          if (row.fingerprint !== item.fingerprint) {
            update.run(item.facts, item.fingerprint, item.currency, item.invoiceId, item.transferId, row.id);
            this.db.prepare("UPDATE recon_breaks SET found_at = ? WHERE id = ?").run(at, row.id);
          } else {
            this.db.prepare("UPDATE recon_breaks SET state = 'open', opened_at = ? WHERE id = ?").run(at, row.id);
            this.appendLine(row.id, "found", `Break ${row.id} found: ${text(item)}`, at);
            changes.opened += 1;
          }
          continue;
        }
        if (row.fingerprint !== item.fingerprint) {
          update.run(item.facts, item.fingerprint, item.currency, item.invoiceId, item.transferId, row.id);
          this.appendLine(row.id, "changed", `Break ${row.id} changed: ${text(item)}`, at);
          changes.changed += 1;
        } else if (row.gone_at !== null) {
          this.db.prepare("UPDATE recon_breaks SET gone_at = NULL WHERE id = ?").run(row.id);
          this.appendLine(row.id, "back", `Break ${row.id} is found again`, at);
        }
        continue;
      }
      const before: BreakRow | undefined = explained.get(item.key);
      if (before !== undefined && (before.fingerprint === item.fingerprint || !rules.live)) {
        continue;
      }
      if (before !== undefined) {
        // New facts after an explanation: the explanation covered the old ones.
        this.db.prepare("UPDATE recon_breaks SET gone_at = ? WHERE id = ?").run(at, before.id);
        const id: number = this.insertBreak(item, "open", at);
        this.appendLine(
          id,
          "reopened",
          `Break ${id} opens again, because the facts of break ${before.id} changed after it was explained: ${text(item)}`,
          at,
        );
        changes.opened += 1;
        continue;
      }
      if (!rules.live) {
        // Found only in what is stored: the next live run has to find it first.
        continue;
      }
      if (rules.atOnce(item.kind)) {
        const id: number = this.insertBreak(item, "open", at);
        this.appendLine(id, "found", `Break ${id} found: ${text(item)}`, at);
        changes.opened += 1;
      } else {
        this.insertBreak(item, "pending", at);
        changes.pending += 1;
      }
    }

    for (const row of live.values()) {
      if (found.has(row.key) || result.unchecked.has(row.key)) {
        continue;
      }
      if (row.state === "pending") {
        this.db.prepare("DELETE FROM recon_breaks WHERE id = ? AND state = 'pending'").run(row.id);
        continue;
      }
      const reason: ClearReason | null = rules.cleared(row.kind, row.subject, result);
      if (reason !== null) {
        this.db.prepare("UPDATE recon_breaks SET state = 'cleared', cleared_at = ? WHERE id = ?").run(at, row.id);
        this.appendLine(row.id, "cleared", `Break ${row.id} cleared: ${CLEARED_BECAUSE[reason]}`, at);
        changes.cleared += 1;
      } else if (row.gone_at === null) {
        this.db.prepare("UPDATE recon_breaks SET gone_at = ? WHERE id = ?").run(at, row.id);
        this.appendLine(row.id, "gone", `Break ${row.id} is no longer found. It still waits for a person to explain it`, at);
        changes.gone += 1;
      }
    }

    for (const row of explained.values()) {
      if (found.has(row.key) || result.unchecked.has(row.key)) {
        continue;
      }
      const reason: ClearReason | null = rules.cleared(row.kind, row.subject, result);
      this.db.prepare("UPDATE recon_breaks SET gone_at = ? WHERE id = ?").run(at, row.id);
      this.appendLine(
        row.id,
        "ended",
        `Explained break ${row.id} is no longer found${reason === null ? "" : `: ${CLEARED_BECAUSE[reason]}`}`,
        at,
      );
    }
    return changes;
  }

  // Records one run in one write transaction: what it read, what the matcher
  // finds on everything stored, and the breaks that changed. A run that started
  // before the newest run already recorded commits nothing, so an older read
  // never undoes a newer one. Nothing awaits inside, so no other step on this
  // connection can find the transaction open.
  commit(runId: number, write: ReconWrite | null, now: number, rules: CommitRules): CommitResult {
    return this.db.transaction((): CommitResult => {
      const finishedAt: string = new Date(now).toISOString();
      const committed: number = Number(this.meta(COMMITTED_RUN_KEY) ?? 0);
      if (committed > runId) {
        this.db
          .prepare("UPDATE recon_runs SET outcome = 'stale', finished_at = ?, reads = ? WHERE id = ?")
          .run(finishedAt, write?.reads ?? 0, runId);
        return { stale: true };
      }
      if (write !== null) {
        this.storeRead(write, now);
      }
      this.notePaid(now);
      const decision: ReconDecision = rules.decide(this.snapshotRows());
      const changes: BreakChanges = this.recordBreaks(decision.result, now, rules);
      this.db
        .prepare(
          `UPDATE recon_runs SET outcome = 'committed', finished_at = ?, reads = ?, full_read = ?, summary = ?
            WHERE id = ?`,
        )
        .run(finishedAt, write?.reads ?? 0, write?.fullRead === true ? 1 : 0, decision.summary, runId);
      this.setMeta(COMMITTED_RUN_KEY, String(runId));
      if (write?.fullRead === true) {
        this.setMeta(FULL_READ_KEY, finishedAt);
      }
      return { stale: false, changes, result: decision.result };
    });
  }

  // A person says what a set of open breaks of one kind is. Every break must be
  // open with the facts the person was shown, or nothing changes.
  explain(items: ExplainItem[], name: string, note: string, now: number): ReconBreak[] {
    return this.db.transaction((): ReconBreak[] => {
      const at: string = new Date(now).toISOString();
      const rows: (BreakRow | undefined)[] = items.map(
        (item: ExplainItem): BreakRow | undefined =>
          this.db.prepare("SELECT * FROM recon_breaks WHERE id = ?").get(item.id) as unknown as BreakRow | undefined,
      );
      const unknown: number[] = items
        .filter((_item: ExplainItem, index: number): boolean => {
          const row: BreakRow | undefined = rows[index];
          return row === undefined || row.state === "pending";
        })
        .map((item: ExplainItem): number => item.id);
      if (unknown.length > 0) {
        throw new ReconUnknownError(unknown);
      }
      const changed: number[] = items
        .filter((item: ExplainItem, index: number): boolean => {
          const row: BreakRow = rows[index] as BreakRow;
          return row.state !== "open" || item.fingerprint.length < 12 || !row.fingerprint.startsWith(item.fingerprint);
        })
        .map((item: ExplainItem): number => item.id);
      if (changed.length > 0) {
        throw new ReconChangedError(changed);
      }
      if (new Set(rows.map((row: BreakRow | undefined): string => row?.kind ?? "")).size > 1) {
        throw new ReconKindsError();
      }
      for (const row of rows as BreakRow[]) {
        this.db
          .prepare(
            "UPDATE recon_breaks SET state = 'explained', explained_by = ?, explained_at = ?, note = ? WHERE id = ?",
          )
          .run(name, at, note, row.id);
        this.appendLine(
          row.id,
          "explained",
          `Break ${row.id} explained by ${name}: ${note}. Facts SHA-256 ${row.fingerprint.slice(0, 12)}`,
          at,
        );
      }
      return (rows as BreakRow[]).map(
        (row: BreakRow): ReconBreak => ({ ...toBreak(row), state: "explained", explainedBy: name, explainedAt: at, note }),
      );
    });
  }

  breaks(states: BreakState[], limit: number = 500): ReconBreak[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM recon_breaks WHERE state IN (${states.map((): string => "?").join(", ")})
            ORDER BY COALESCE(explained_at, opened_at, found_at) DESC, id DESC LIMIT ?`,
        )
        .all(...states, limit) as unknown as BreakRow[]
    ).map(toBreak);
  }

  // Breaks in these states by kind, counted in full, the kind with the newest
  // break first.
  kindTotals(states: BreakState[]): KindTotal[] {
    return (
      this.db
        .prepare(
          `SELECT kind, COUNT(*) AS count FROM recon_breaks WHERE state IN (${states.map((): string => "?").join(", ")})
            GROUP BY kind ORDER BY MAX(COALESCE(explained_at, opened_at, found_at)) DESC, MAX(id) DESC`,
        )
        .all(...states) as unknown as KindTotal[]
    ).map((row: KindTotal): KindTotal => ({ kind: row.kind, count: Number(row.count) }));
  }

  countBreaks(states: BreakState[]): number {
    return this.kindTotals(states).reduce((total: number, row: KindTotal): number => total + row.count, 0);
  }

  breaksById(ids: number[]): ReconBreak[] {
    return ids
      .map((id: number): BreakRow | undefined =>
        this.db.prepare("SELECT * FROM recon_breaks WHERE id = ?").get(id) as unknown as BreakRow | undefined,
      )
      .filter((row: BreakRow | undefined): row is BreakRow => row !== undefined)
      .map(toBreak);
  }

  // The newest refund missing break on each of these transfers, in any state,
  // newest first, for the outbox's refund trace. Nothing on a file reconciliation
  // never opened. Looked up by key, refund-missing:<transfer id>, so the read
  // stays on the key index however many breaks the ledger keeps.
  refundBreaks(transferIds: string[]): RefundBreak[] {
    if (transferIds.length === 0 || !this.hasTables()) {
      return [];
    }
    const keys: string[] = transferIds.map((transferId: string): string => `refund-missing:${transferId}`);
    const rows: BreakRow[] = this.db
      .prepare(
        `SELECT * FROM recon_breaks
          WHERE id IN (SELECT MAX(id) FROM recon_breaks WHERE key IN (${keys.map((): string => "?").join(", ")}) GROUP BY key)
            AND kind = 'refund-missing'
          ORDER BY id DESC`,
      )
      .all(...keys) as unknown as BreakRow[];
    const transfer: StatementSync = this.db.prepare("SELECT * FROM recon_transfers WHERE transfer_id = ?");
    return rows.map((row: BreakRow): RefundBreak => {
      const read: TransferRow | undefined = transfer.get(row.transfer_id) as unknown as TransferRow | undefined;
      return { ...toBreak(row), transfer: read === undefined ? null : toTransfer(read) };
    });
  }

  runs(limit: number): ReconRun[] {
    return (this.db.prepare("SELECT * FROM recon_runs ORDER BY id DESC LIMIT ?").all(limit) as unknown as RunRow[]).map(
      toRun,
    );
  }

  // The latest check against Airwallex that finished, whatever came of it. An
  // offline match after it reads nothing, so it never stands in for it.
  latestLive(): ReconRun | undefined {
    const row: RunRow | undefined = this.db
      .prepare("SELECT * FROM recon_runs WHERE mode = 'live' AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get() as unknown as RunRow | undefined;
    return row === undefined ? undefined : toRun(row);
  }

  lastCommitted(): ReconRun | undefined {
    const row: RunRow | undefined = this.db
      .prepare("SELECT * FROM recon_runs WHERE outcome = 'committed' ORDER BY id DESC LIMIT 1")
      .get() as unknown as RunRow | undefined;
    return row === undefined ? undefined : toRun(row);
  }

  movements(currency: string, limit: number): Movement[] {
    return (
      this.db
        .prepare("SELECT * FROM wallet_movements WHERE currency = ? ORDER BY posted_ms DESC, seq LIMIT ?")
        .all(currency, limit) as unknown as MovementRow[]
    ).map(toMovement);
  }

  lineCount(): { lines: number; last: number } {
    const row: { lines: number; last: number | null } = this.db
      .prepare("SELECT COUNT(*) AS lines, MAX(id) AS last FROM recon_events")
      .get() as unknown as { lines: number; last: number | null };
    return { lines: row.lines, last: row.last ?? 0 };
  }

  // What an audit of the chain checks, read in one transaction.
  auditSnapshot(): ReconAuditSnapshot {
    return this.db.readSnapshot((): ReconAuditSnapshot => ({
      events: (this.db.prepare("SELECT * FROM recon_events ORDER BY id").all() as unknown as EventRow[]).map(
        (row: EventRow): ChainedReconEvent => ({
          id: row.id,
          breakId: row.break_id,
          at: row.at,
          kind: row.kind,
          message: row.message,
          prevHash: row.prev_hash,
          hash: row.hash,
        }),
      ),
      ledgerHead: this.meta(RECON_CHAIN.shape.head),
      chainStartedAt: this.meta(RECON_CHAIN.shape.started),
      restarted: restartOf(this.meta(RECON_CHAIN.shape.restarted)),
      // A break gets its first line when it opens, so one that opened with none
      // lost its lines. A pending break has none yet.
      unlined: (
        this.db
          .prepare(
            `SELECT id FROM recon_breaks b
              WHERE state <> 'pending' AND NOT EXISTS (SELECT 1 FROM recon_events e WHERE e.break_id = b.id)
              ORDER BY id`,
          )
          .all() as unknown as { id: number }[]
      ).map((row: { id: number }): number => row.id),
    }));
  }

  // The open breaks of these kinds counted in full, and the newest line saying a
  // break of these kinds is new or has new facts, whatever state that break is
  // in now. A break clearing or explained adds no such line, so it never moves
  // the alert. The break named newest is found by the same lines, among the open
  // ones.
  alertState(alerting: readonly BreakKind[]): ReconAlertState {
    const kinds: KindTotal[] = this.kindTotals(["open"]).filter((entry: KindTotal): boolean => alerting.includes(entry.kind));
    const these: string = alerting.map((): string => "?").join(", ");
    const currencies: string[] = (
      this.db
        .prepare(`SELECT DISTINCT currency FROM recon_breaks WHERE state = 'open' AND kind IN (${these}) ORDER BY currency`)
        .all(...alerting) as unknown as { currency: string }[]
    ).map((row: { currency: string }): string => row.currency);
    const news: string = NEWS_KINDS.map((): string => "?").join(", ");
    // CROSS JOIN keeps the lines as the outer loop, newest first, so the first
    // open break met ends the scan.
    const newestOpen: BreakRow | undefined =
      (this.db
        .prepare(
          `SELECT b.* FROM recon_events e CROSS JOIN recon_breaks b ON b.id = e.break_id
            WHERE e.kind IN (${news}) AND b.state = 'open' AND b.kind IN (${these}) ORDER BY e.id DESC LIMIT 1`,
        )
        .get(...NEWS_KINDS, ...alerting) as unknown as BreakRow | undefined) ??
      (this.db
        .prepare(`SELECT * FROM recon_breaks WHERE state = 'open' AND kind IN (${these}) ORDER BY id DESC LIMIT 1`)
        .get(...alerting) as unknown as BreakRow | undefined);
    const row: { newest: number | null } = this.db
      .prepare(
        `SELECT MAX(e.id) AS newest FROM recon_events e CROSS JOIN recon_breaks b ON b.id = e.break_id
          WHERE e.kind IN (${news}) AND b.kind IN (${these})`,
      )
      .get(...NEWS_KINDS, ...alerting) as unknown as { newest: number | null };
    return {
      open: kinds.reduce((total: number, entry: KindTotal): number => total + entry.count, 0),
      kinds,
      currencies,
      newestOpen: newestOpen === undefined ? undefined : toBreak(newestOpen),
      newest: row.newest ?? 0,
    };
  }
}

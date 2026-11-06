import type { StatementSync } from "node:sqlite";
import { oneLine } from "../text/printable.js";
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
import type { ColumnRow, Db } from "./db.js";
import type { Schema } from "./schema.js";

// How often runningHashCheck hashes every line again, so a line rewritten in place
// is caught within a minute, as the alert loop's audit check catches it.
const FULL_HEAD_CHECK_MS: number = 60_000;

// A line the incident list may show for a closed invoice: a decision, a close, or a
// standing line, but never an error, an email or a message draft.
const HEADLINE_LINE: string = `(kind IN ('decision', 'closed')
    OR (topic IS NOT NULL AND topic NOT LIKE 'outbox:%'))
  AND kind NOT IN ('error', 'email', 'outbox')`;

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

// Invoice and pay run timelines (events, run_events): their lines, their hash
// chains and the running hashes.
export class Timelines {
  private readonly db: Db;
  private readonly schema: Schema;
  // How far runningHashCheck has hashed the ledger's lines, in this process.
  private headProgress: HeadProgress | undefined;

  constructor(db: Db, schema: Schema) {
    this.db = db;
    this.schema = schema;
  }

  // True once the timeline is a hash chain: any record of the chain in meta, or
  // any line with a hash, counts. A file opened read-only from before the chain
  // has no hash column, and one from before meta has no meta table.
  chainStarted(): boolean {
    const hashColumn: boolean = (
      this.db.prepare("PRAGMA table_info(events)").all() as unknown as ColumnRow[]
    ).some((column: ColumnRow): boolean => column.name === "hash");
    return (
      this.db.metaValue(CHAIN_STARTED_KEY) !== null ||
      this.db.metaValue(BACKFILLED_THROUGH_KEY) !== null ||
      this.db.metaValue(LEDGER_HEAD_KEY) !== null ||
      this.db.metaValue(LEDGER_RESTARTED_KEY) !== null ||
      (hashColumn &&
        this.db.prepare("SELECT 1 FROM events WHERE hash IS NOT NULL LIMIT 1").get() !==
          undefined)
    );
  }

  // The first time the ledger is opened with the chain, hashes the lines already
  // there in id order and starts the running hash. A ledger whose chain has
  // started is never hashed again, even if part of its record has gone missing,
  // because hashing again would vouch for whatever the lines now say.
  startChain(): void {
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
      this.db.metaValue(RUN_CHAIN_STARTED_KEY) !== null ||
      this.db.metaValue(RUN_BACKFILLED_THROUGH_KEY) !== null ||
      this.db.metaValue(RUN_HEAD_KEY) !== null ||
      this.db.metaValue(RUN_RESTARTED_KEY) !== null ||
      (hashColumn &&
        this.db.prepare("SELECT 1 FROM run_events WHERE hash IS NOT NULL LIMIT 1").get() !==
          undefined)
    );
  }

  // True when the file has a run_events table with any line in it.
  hasRunLines(): boolean {
    const table: boolean =
      (this.db.prepare("PRAGMA table_info(run_events)").all() as unknown as ColumnRow[]).length > 0;
    return table && this.db.prepare("SELECT 1 FROM run_events LIMIT 1").get() !== undefined;
  }

  // Starts the chain of pay run timelines the way startChain starts the invoices':
  // the lines already there are hashed once, in id order, and never again.
  startRunChain(): void {
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
    this.db.transaction((): void => {
      this.appendEvent(invoiceId, kind, message, topic);
    });
  }

  // Chains one line to the invoice's timeline. The caller holds the write
  // transaction.
  appendEvent(
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
    const head: string | null = this.db.metaValue(headKey);
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
        ledgerHead: this.db.metaValue(LEDGER_HEAD_KEY),
        chainStartedAt: this.db.metaValue(CHAIN_STARTED_KEY),
        backfilledThrough: Number(this.db.metaValue(BACKFILLED_THROUGH_KEY) ?? 0),
        restarted: restartOf(this.db.metaValue(LEDGER_RESTARTED_KEY)),
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
    if (!this.schema.hasRunTable()) {
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
      const stored: string | null = this.db.metaValue(LEDGER_HEAD_KEY);
      const restarted: HeadRestart | null = restartOf(this.db.metaValue(LEDGER_RESTARTED_KEY));
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

  // Chains one line to the run's timeline and adds it to the running hash of run
  // lines, as appendEvent does for an invoice. The caller holds the write
  // transaction.
  addRunEventRow(runId: number, kind: EventKind, message: string, topic: string | null): void {
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
    this.db.transaction((): void => {
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
        ledgerHead: this.db.metaValue(RUN_HEAD_KEY),
        chainStartedAt: this.db.metaValue(RUN_CHAIN_STARTED_KEY),
        backfilledThrough: Number(this.db.metaValue(RUN_BACKFILLED_THROUGH_KEY) ?? 0),
        restarted: restartOf(this.db.metaValue(RUN_RESTARTED_KEY)),
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
}

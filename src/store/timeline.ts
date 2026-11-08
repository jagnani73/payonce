import { oneLine, storable } from "../text/printable.js";
import {
  restartOf,
  type AuditSnapshot,
  type ChainedEvent,
  type ChainedRunEvent,
  type EventFields,
  type HeadRestart,
  type LedgerReport,
  type RunAuditSnapshot,
  type RunEventFields,
} from "./audit-trail.js";
import { GENESIS, INVOICE_CHAIN, RUN_CHAIN } from "./chain.js";
import type { ColumnRow, Db } from "./db.js";
import type { Schema } from "./schema.js";

// How often runningHashCheck hashes every line again, so a line rewritten in place
// is caught within a minute, as the alert loop's audit check catches it.
const FULL_HEAD_CHECK_MS: number = 60_000;

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
  | "outage"
  | "contact"
  | "sandbox";

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

  // True once invoice timelines are a hash chain (HashChain.started).
  chainStarted(): boolean {
    return INVOICE_CHAIN.started(this.db);
  }

  // The first time the ledger is opened with the chain, hashes the invoice lines
  // already there, once (HashChain.start).
  startChain(): void {
    this.db.transaction((): void => INVOICE_CHAIN.start(this.db, toChainedEvent));
  }

  // True once pay run timelines are a hash chain, read the way chainStarted reads
  // invoice timelines. A file opened read-only from before pay runs has no
  // run_events table, and one from before this chain has no hash column.
  runChainStarted(): boolean {
    return RUN_CHAIN.started(this.db);
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
    this.db.transaction((): void => RUN_CHAIN.start(this.db, toChainedRunEvent));
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
    const hash: string = INVOICE_CHAIN.hash(prevHash, line);
    const inserted: { lastInsertRowid: number | bigint } = this.db
      .prepare(
        `INSERT INTO events (invoice_id, at, kind, message, topic, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(line.invoiceId, line.at, line.kind, line.message, line.topic, prevHash, hash);
    INVOICE_CHAIN.advance(this.db, hash, line.at, Number(inserted.lastInsertRowid), invoice);
  }

  // What an audit checks, read in one transaction so a line another process adds
  // meanwhile cannot make the running hash look wrong. invoiceId null reads every
  // invoice's lines.
  auditSnapshot(invoiceId: string | null): AuditSnapshot {
    return this.db.readSnapshot((): AuditSnapshot => {
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
        ledgerHead: this.db.metaValue(INVOICE_CHAIN.shape.head),
        chainStartedAt: this.db.metaValue(INVOICE_CHAIN.shape.started),
        backfilledThrough: INVOICE_CHAIN.backfilledThrough(this.db),
        restarted: restartOf(this.db.metaValue(INVOICE_CHAIN.shape.restarted)),
        unlined: this.unlinedInvoices(),
      };
      return snapshot;
    });
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

  // Whether the running hash matches every line in the ledger, as auditSnapshot and
  // ledgerReport check it, without hashing every line on every look at an invoice.
  // It hashes only the lines added since the last check in this process, and every
  // line again once a minute, as the alert loop's audit check does, so a line
  // rewritten or removed in the middle is caught within a minute. The last line it
  // hashed is read again each time, so lines removed from the end are caught at
  // once: ids are never reused, so its hash then reads as missing.
  runningHashCheck(now: number = Date.now()): LedgerReport {
    return this.db.readSnapshot((): LedgerReport => {
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
          computed = INVOICE_CHAIN.next(computed, row.hash);
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
      const stored: string | null = this.db.metaValue(INVOICE_CHAIN.shape.head);
      const restarted: HeadRestart | null = restartOf(this.db.metaValue(INVOICE_CHAIN.shape.restarted));
      const unlined: string[] = this.unlinedInvoices();
      return {
        lines: this.headProgress.lines,
        invoices: from.invoices.size,
        stored,
        computed,
        restarted,
        unlined,
        intact: stored === computed && restarted === null && unlined.length === 0,
      };
    });
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
    const hash: string = RUN_CHAIN.hash(prevHash, line);
    const inserted: { lastInsertRowid: number | bigint } = this.db
      .prepare(
        `INSERT INTO run_events (run_id, at, kind, message, topic, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(line.runId, line.at, line.kind, line.message, line.topic, prevHash, hash);
    RUN_CHAIN.advance(this.db, hash, line.at, Number(inserted.lastInsertRowid), `run ${runId}`);
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
    return this.db.readSnapshot((): RunAuditSnapshot => {
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
        ledgerHead: this.db.metaValue(RUN_CHAIN.shape.head),
        chainStartedAt: this.db.metaValue(RUN_CHAIN.shape.started),
        backfilledThrough: RUN_CHAIN.backfilledThrough(this.db),
        restarted: restartOf(this.db.metaValue(RUN_CHAIN.shape.restarted)),
        unlined: this.unlinedRuns(),
      };
      return snapshot;
    });
  }

  runEvents(runId: number): LedgerEvent[] {
    return this.db
      .prepare("SELECT id, at, kind, message, topic FROM run_events WHERE run_id = ? ORDER BY id")
      .all(runId) as unknown as LedgerEvent[];
  }
}

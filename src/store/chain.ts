import { createHash } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import type { ChainBreak, EventFields, ReconEventFields, RunEventFields } from "./audit-trail.js";
import type { ColumnRow, Db } from "./db.js";

// The prev_hash of a chain's first line, and a running hash before its first
// line.
export const GENESIS: string = "0".repeat(64);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// What every chain's line hash covers, besides what the line is about.
interface ChainFields {
  at: string;
  kind: string;
  message: string;
}

// What breaks checks on a line of any chain.
export interface HashedLine {
  id: number;
  at: string;
  prevHash: string | null;
  hash: string | null;
}

// What tells one chain from another. A line's hash covers the JSON object {at,
// owner, kind, message, topic}, where owner is the column naming the invoice,
// run or break the line is about, and topic is left out on a chain whose lines
// have none. The meta keys are its running hash (head), the record of the first
// time that went missing and started again (restarted), when the chain started
// (started) and, on a chain that hashed the lines it found when it started, the
// last of them (backfilled).
interface ChainShape<L extends ChainFields> {
  table: string;
  owner: string;
  ownerOf: (line: L) => string | number;
  topicOf: ((line: L) => string | null) | null;
  head: string;
  restarted: string;
  started: string;
  backfilled?: string;
}

// One hash chain of timeline lines, as written and as an audit checks it.
export class HashChain<L extends ChainFields> {
  readonly shape: ChainShape<L>;

  constructor(shape: ChainShape<L>) {
    this.shape = shape;
  }

  // JSON.stringify keeps the keys in the order written here and adds no spaces, so
  // anyone can rebuild the same text from an export.
  canonical(line: L): string {
    const fields: Record<string, string | number | null> = {
      at: line.at,
      [this.shape.owner]: this.shape.ownerOf(line),
      kind: line.kind,
      message: line.message,
    };
    if (this.shape.topicOf !== null) {
      fields["topic"] = this.shape.topicOf(line);
    }
    return JSON.stringify(fields);
  }

  hash(prevHash: string, line: L): string {
    return sha256(prevHash + this.canonical(line));
  }

  // The running hash once a line with this hash joins the chain.
  next(head: string, hash: string): string {
    return sha256(head + hash);
  }

  // The running hash over these hashes in id order, from the genesis. A line with
  // no hash is skipped, as the ledger skips it when it adds the next.
  running(hashes: (string | null)[]): string {
    let computed: string = GENESIS;
    for (const hash of hashes) {
      if (hash !== null) {
        computed = this.next(computed, hash);
      }
    }
    return computed;
  }

  // Checks each line against the stored hash of the line before it and against its
  // own content, so one changed line shows up once and not on every line after it.
  // A line with no hash is skipped, as the ledger skips it when it adds the next.
  breaks(events: (L & HashedLine)[]): ChainBreak[] {
    const breaks: ChainBreak[] = [];
    let previous: string = GENESIS;
    events.forEach((event: L & HashedLine, index: number): void => {
      const line: number = index + 1;
      const found = (problem: string): void => {
        breaks.push({ line, id: event.id, at: event.at, problem });
      };
      if (event.prevHash === null || event.hash === null) {
        found("has no hash, so it was written outside the chain");
        return;
      }
      if (event.prevHash !== previous) {
        found(
          line === 1
            ? "does not start the chain, so lines before it were removed"
            : `does not follow line ${line - 1}: a line between them was removed or added, or line ${line - 1} was rewritten with a new hash`,
        );
      }
      if (this.hash(event.prevHash, event) !== event.hash) {
        found("was changed after it was written");
      }
      previous = event.hash;
    });
    return breaks;
  }

  // True once the table is a hash chain: any record of the chain in meta, or any
  // line with a hash, counts. A file opened read-only from before the chain has
  // no hash column, and one from before meta has no meta table.
  started(db: Db): boolean {
    const hashColumn: boolean = (
      db.prepare(`PRAGMA table_info(${this.shape.table})`).all() as unknown as ColumnRow[]
    ).some((column: ColumnRow): boolean => column.name === "hash");
    return (
      db.metaValue(this.shape.started) !== null ||
      (this.shape.backfilled !== undefined && db.metaValue(this.shape.backfilled) !== null) ||
      db.metaValue(this.shape.head) !== null ||
      db.metaValue(this.shape.restarted) !== null ||
      (hashColumn &&
        db.prepare(`SELECT 1 FROM ${this.shape.table} WHERE hash IS NOT NULL LIMIT 1`).get() !==
          undefined)
    );
  }

  // The last line already there that was hashed when the chain started. 0 when it
  // hashed none.
  backfilledThrough(db: Db): number {
    return Number((this.shape.backfilled === undefined ? null : db.metaValue(this.shape.backfilled)) ?? 0);
  }

  // The first time the ledger is opened with the chain, hashes the lines already
  // there in id order, each owner's lines a chain of their own, and starts the
  // running hash. A ledger whose chain has started is never hashed again, even if
  // part of its record has gone missing, because hashing again would vouch for
  // whatever the lines now say. The caller holds the write transaction.
  start<R>(db: Db, lineOf: (row: R) => L & { id: number }): void {
    if (this.started(db)) {
      return;
    }
    const rows: R[] = db.prepare(`SELECT * FROM ${this.shape.table} ORDER BY id`).all() as unknown as R[];
    const update: StatementSync = db.prepare(`UPDATE ${this.shape.table} SET prev_hash = ?, hash = ? WHERE id = ?`);
    const heads: Map<string | number, string> = new Map();
    let head: string = GENESIS;
    let lastId: number = 0;
    for (const row of rows) {
      const line: L & { id: number } = lineOf(row);
      const prevHash: string = heads.get(this.shape.ownerOf(line)) ?? GENESIS;
      const hash: string = this.hash(prevHash, line);
      update.run(prevHash, hash, line.id);
      heads.set(this.shape.ownerOf(line), hash);
      head = this.next(head, hash);
      lastId = line.id;
    }
    const insert: StatementSync = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    insert.run(this.shape.head, head);
    insert.run(this.shape.started, new Date().toISOString());
    if (this.shape.backfilled !== undefined) {
      insert.run(this.shape.backfilled, String(lastId));
    }
  }

  // Adds a line's hash to the running hash. Every chain sets its running hash when
  // it starts, so a missing one was removed. The line is still written, because a
  // payment step must never fail for want of a hash: the running hash starts
  // again from the genesis, and the first restart is kept in meta, with the time
  // and the line (id, and the invoice, run or break it is on), so every audit
  // reports it from then on. restart is false for the first line of a chain that
  // starts its running hash with that line. The caller holds the write
  // transaction.
  advance(db: Db, hash: string, at: string, id: number, of: string, restart: boolean = true): void {
    const head: string | null = db.metaValue(this.shape.head);
    if (head === null && restart) {
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(
        this.shape.restarted,
        JSON.stringify({ at, id, of }),
      );
    }
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(this.shape.head, this.next(head ?? GENESIS, hash));
  }
}

// Invoice timelines: one chain per invoice, with a running hash over every line,
// so lines removed from the end of a timeline, or a whole invoice's lines, are
// caught.
export const INVOICE_CHAIN: HashChain<EventFields> = new HashChain<EventFields>({
  table: "events",
  owner: "invoice_id",
  ownerOf: (line: EventFields): string => line.invoiceId,
  topicOf: (line: EventFields): string | null => line.topic,
  head: "events_head",
  restarted: "events_head_restarted",
  started: "chain_started_at",
  backfilled: "chain_backfilled_through",
});

// Pay run timelines, chained apart from invoice timelines, with a running hash of
// their own.
export const RUN_CHAIN: HashChain<RunEventFields> = new HashChain<RunEventFields>({
  table: "run_events",
  owner: "run_id",
  ownerOf: (line: RunEventFields): number => line.runId,
  topicOf: (line: RunEventFields): string | null => line.topic,
  head: "run_events_head",
  restarted: "run_events_head_restarted",
  started: "run_chain_started_at",
  backfilled: "run_chain_backfilled_through",
});

// Reconciliation's record: one chain over every break's lines in id order, with
// a running hash of its own. It starts with its first line, so it backfills
// nothing. Its start is set with that line and never removed, so a chain that
// has started and holds no line, or has lost its running hash, shows as broken.
export const RECON_CHAIN: HashChain<ReconEventFields> = new HashChain<ReconEventFields>({
  table: "recon_events",
  owner: "break_id",
  ownerOf: (line: ReconEventFields): number => line.breakId,
  topicOf: null,
  head: "recon_events_head",
  restarted: "recon_events_head_restarted",
  started: "recon_first_line_at",
});

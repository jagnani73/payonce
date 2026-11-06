import { DatabaseSync, type StatementSync } from "node:sqlite";

export const LEDGER_PATH: string = "payonce.db";

const SQLITE_CONSTRAINT_UNIQUE: number = 2067;

const SQLITE_CONSTRAINT_PRIMARYKEY: number = 1555;

const BUSY_TIMEOUT_MS: number = 5_000;

export interface ColumnRow {
  name: string;
}

interface MetaRow {
  value: string;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    error.errcode === SQLITE_CONSTRAINT_UNIQUE
  );
}

// An invoice number is the primary key of obligations, and SQLite reports a
// second one with its own code.
export function isPrimaryKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    error.errcode === SQLITE_CONSTRAINT_PRIMARYKEY
  );
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

export function parsedOf(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

// A JSON list of strings as a column keeps it, or none when it is not one.
export function stringsOf(json: string): string[] {
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

// Stored JSON that does not parse, or is not in the shape PayOnce writes. A
// SyntaxError, as JSON.parse's own is, and its message names what it is, never
// the stored text, since it goes on the timeline.
class StoredShapeError extends SyntaxError {
  constructor(what: string) {
    super(`PayOnce cannot read ${what} in the ledger, so it stops here and sends nothing`);
    this.name = "StoredShapeError";
  }
}

// A stored object that shape accepts, read strict even inside readingSoft:
// anything else throws a StoredShapeError naming what.
export function checkedObject<T>(json: string, shape: (value: unknown) => value is T, what: string): T {
  const parsed: unknown = parsedOf(json);
  if (!shape(parsed)) {
    throw new StoredShapeError(what);
  }
  return parsed;
}

// A stored object that shape accepts. Outside readingSoft anything else throws,
// as checkedObject does; inside, it reads as none.
export function storedShape<T>(json: string, shape: (value: unknown) => value is T, what: string): T | null {
  if (softReads === 0) {
    return checkedObject(json, shape, what);
  }
  const parsed: unknown = parsedOf(json);
  return shape(parsed) ? parsed : null;
}

// The one connection every store shares, its transactions and the meta table.
export class Db {
  private readonly db: DatabaseSync;
  // False only for a file opened read-only from before the meta table.
  private readonly hasMeta: boolean;

  // readOnly opens an existing file as it is, without creating or upgrading it,
  // so a check cannot change what it checks.
  constructor(path: string, readOnly: boolean) {
    // The CLI and the web server can have the file open at once, so a write
    // waits for the other instead of failing on the first lock.
    this.db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS, readOnly });
    this.hasMeta =
      !readOnly || (this.db.prepare("PRAGMA table_info(meta)").all() as unknown as ColumnRow[]).length > 0;
  }

  prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  get isTransaction(): boolean {
    return this.db.isTransaction;
  }

  close(): void {
    this.db.close();
  }

  metaValue(key: string): string | null {
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

  // Runs fn in one write transaction and commits it, or rolls it all back if fn
  // throws. With commit, what fn returned is kept only when commit says so of it,
  // and otherwise rolled back and still returned. Steps that open a transaction
  // of their own cannot run inside one, so a nested call throws instead of
  // failing part way.
  transaction<T>(fn: () => T, commit: (result: T) => boolean = (): boolean => true): T {
    if (this.db.isTransaction) {
      throw new Error("A ledger transaction is already open");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result: T = fn();
      this.db.exec(commit(result) ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
}

import type { Db } from "./db.js";

// A waiter for a currency lock that has not asked again for this long has gone,
// for example because its process stopped, and loses its place. It asks every
// 200 ms, and a write can wait up to BUSY_TIMEOUT_MS for another process.
const WAITER_GONE_MS: number = 10_000;

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

// The lease per currency and its fair queue (currency_locks,
// currency_lock_waiters).
export class LockStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Throws LeaseLostError unless lease still holds its currency's lock. Run
  // inside the write transaction that writes what the lock guards, so the lock
  // cannot be lost between the check and the write.
  requireLease(lease: Lease): void {
    const held: unknown = this.db
      .prepare(
        "SELECT 1 FROM currency_locks WHERE currency = ? AND holder = ? AND expires_at > ?",
      )
      .get(lease.currency, lease.holder, new Date().toISOString());
    if (held === undefined) {
      throw new LeaseLostError(lease.currency);
    }
  }

  // Takes the lease on a currency for holder until the given time, if nobody
  // holds it or the last holder's lease has run out, and nobody has been waiting
  // longer. True when taken. Otherwise holder joins the queue, or keeps its place
  // in it, so the holders waiting take the lock in the order they asked, across
  // processes. A holder that stops asking for WAITER_GONE_MS loses its place.
  takeCurrencyLock(currency: string, holder: string, until: number): boolean {
    return this.db.transaction((): boolean => {
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

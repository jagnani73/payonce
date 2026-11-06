import { storedStrings, type Db } from "./db.js";
import type { InvoiceStore, ObligationOrigin, ObligationState } from "./invoices.js";
import type { EventKind, LedgerEvent, Timelines } from "./timeline.js";

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

export interface RailFailureRow {
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

export function toRailFailure(row: RailFailureRow): RailFailure {
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

export interface OutageHoldRow {
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

// Rail failures, outages and what each outage held.
export class OutageStore {
  private readonly db: Db;
  private readonly invoices: InvoiceStore;
  private readonly timelines: Timelines;

  constructor(db: Db, invoices: InvoiceStore, timelines: Timelines) {
    this.db = db;
    this.invoices = invoices;
    this.timelines = timelines;
  }

  // When this ledger first counted failures toward outages, as an ISO time.
  outagesSince(): string {
    return this.db.metaValue("outages_since") ?? this.db.startedAt();
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
    return this.db.transaction((): Outage | undefined => {
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
        if (invoiceId === null || this.invoices.obligation(invoiceId) === undefined) {
          continue;
        }
        this.db
          .prepare(
            `INSERT OR IGNORE INTO outage_holds (outage_id, invoice_id, what, held_at)
             VALUES (?, ?, 'counted', ?)`,
          )
          .run(outage.id, invoiceId, new Date(now).toISOString());
        this.timelines.appendEvent(invoiceId, "outage", text, null);
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
    return this.db.transaction((): boolean => {
      if (this.db.prepare("SELECT 1 FROM outages WHERE id = ? AND state = 'active'").get(outageId) === undefined) {
        return false;
      }
      const held: boolean = this.insertHold(outageId, subject, what, new Date().toISOString());
      if ("invoiceId" in subject) {
        if (held) {
          this.timelines.appendEvent(subject.invoiceId, "outage", line, null);
        }
        if (standing !== null && standing.wanted(this.timelines.events(subject.invoiceId))) {
          this.timelines.appendEvent(subject.invoiceId, standing.kind, standing.message, standing.topic);
        }
      } else {
        if (held) {
          this.timelines.addRunEventRow(subject.runId, "outage", line, null);
        }
        if (standing !== null && standing.wanted(this.timelines.runEvents(subject.runId))) {
          this.timelines.addRunEventRow(subject.runId, standing.kind, standing.message, standing.topic);
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
    return this.db.transaction((): OutageHold[] | undefined => {
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
          this.timelines.appendEvent(
            hold.invoiceId,
            "outage",
            invoiceLine(outage, this.invoices.obligation(hold.invoiceId)?.state ?? null),
            null,
          );
          this.db
            .prepare(
              `UPDATE obligations SET look_at = ?
                WHERE invoice_id = ? AND state IN ('open', 'escalated')`,
            )
            .run(now, hold.invoiceId);
        } else if (hold.runId !== null) {
          this.timelines.addRunEventRow(hold.runId, "outage", runLine(outage), null);
        }
      }
      return holds;
    });
  }
}

import type { Db } from "./db.js";

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

// Alert conditions and the alerts queued for them (alert_conditions, alerts).
export class AlertStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
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
    return this.db.transaction((): RecordedConditions => {
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
}

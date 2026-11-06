import { isUniqueViolation, type Db } from "./db.js";
import type { Timelines } from "./timeline.js";

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

export interface DraftRow {
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

// Message drafts for a person to send (outbox).
export class DraftStore {
  private readonly db: Db;
  private readonly timelines: Timelines;

  constructor(db: Db, timelines: Timelines) {
    this.db = db;
    this.timelines = timelines;
  }

  // Stores a draft and its chained timeline line in one write transaction, so a
  // draft never exists without the line that records its hash. A draft of the
  // same template still open on the invoice refuses it.
  createDraft(input: NewDraft, line: (id: number) => string): number {
    try {
      return this.db.transaction((): number => {
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
        this.timelines.appendEvent(input.invoiceId, "outbox", line(id), `outbox:${id}`);
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
    return this.db.transaction((): boolean => {
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
      this.timelines.appendEvent(invoiceId, "outbox", line, `outbox:${id}`);
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

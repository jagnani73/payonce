import type { EmailAttachment } from "../reader/emails.js";
import { isUniqueViolation, storedList, storedStrings, type Db } from "./db.js";
import type { InvoiceStore, Obligation } from "./invoices.js";

// An email a person uploaded. waiting is in the inbox, delivered is on an
// invoice, and dismissed is final: a person decided it belongs to none.
export type UploadState = "waiting" | "delivered" | "dismissed";

export interface NewUpload {
  uploadedBy: string;
  source: "file" | "paste";
  fileName: string | null;
  rawSha256: string;
  rawBytes: number;
  contentHash: string;
  messageId: string | null;
  sender: string;
  senderName: string;
  fromAsWritten: string;
  replyTo: string[];
  dateAsWritten: string;
  subject: string;
  body: string;
  styleText: string;
  attachments: EmailAttachment[];
  notes: string[];
  partial: boolean;
}

export interface Upload extends NewUpload {
  id: number;
  uploadedAt: string;
  state: UploadState;
  invoiceId: string | null;
  deliveredBy: string | null;
  deliveredAt: string | null;
  dismissedBy: string | null;
  dismissedAt: string | null;
  dismissNote: string | null;
}

interface UploadRow {
  id: number;
  uploaded_by: string;
  uploaded_at: string;
  source: "file" | "paste";
  file_name: string | null;
  raw_sha256: string;
  raw_bytes: number;
  content_hash: string;
  message_id: string | null;
  sender: string;
  sender_name: string;
  from_as_written: string;
  reply_to: string;
  date_as_written: string;
  subject: string;
  body: string;
  style_text: string;
  attachments: string;
  notes: string;
  partial: number;
  state: UploadState;
  invoice_id: string | null;
  delivered_by: string | null;
  delivered_at: string | null;
  dismissed_by: string | null;
  dismissed_at: string | null;
  dismiss_note: string | null;
}

function toUpload(row: UploadRow): Upload {
  return {
    id: row.id,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    source: row.source,
    fileName: row.file_name,
    rawSha256: row.raw_sha256,
    rawBytes: row.raw_bytes,
    contentHash: row.content_hash,
    messageId: row.message_id,
    sender: row.sender,
    senderName: row.sender_name,
    fromAsWritten: row.from_as_written,
    replyTo: storedStrings(row.reply_to),
    dateAsWritten: row.date_as_written,
    subject: row.subject,
    body: row.body,
    styleText: row.style_text,
    attachments: storedList<EmailAttachment>(row.attachments),
    notes: storedStrings(row.notes),
    partial: row.partial === 1,
    state: row.state,
    invoiceId: row.invoice_id,
    deliveredBy: row.delivered_by,
    deliveredAt: row.delivered_at,
    dismissedBy: row.dismissed_by,
    dismissedAt: row.dismissed_at,
    dismissNote: row.dismiss_note,
  };
}

// A second upload of an email already in the inbox, in any state.
export class DuplicateUploadError extends Error {
  readonly upload: Upload;

  constructor(upload: Upload) {
    super(
      upload.state === "delivered"
        ? `This email was uploaded already, as upload ${upload.id}, and delivered to ${upload.invoiceId ?? ""} by ${upload.deliveredBy ?? ""}`
        : upload.state === "dismissed"
          ? `This email was uploaded already, as upload ${upload.id}, and dismissed by ${upload.dismissedBy ?? ""}: ${upload.dismissNote ?? ""}`
          : `This email was uploaded already and waits in the inbox as upload ${upload.id}`,
    );
    this.name = "DuplicateUploadError";
    this.upload = upload;
  }
}

// What delivering an upload did. Not waiting means another person or process
// delivered or dismissed it first.
export type DeliverResult =
  | { ok: true; upload: Upload; obligation: Obligation }
  | { ok: false; upload: Upload };

// The inbox as alerts see it. newest is null while nothing was ever uploaded.
export interface InboxWaiting {
  waiting: number;
  newest: number | null;
}

// Uploaded emails waiting in the inbox, delivered or dismissed (inbox).
export class InboxStore {
  private readonly db: Db;
  private readonly invoices: InvoiceStore;

  constructor(db: Db, invoices: InvoiceStore) {
    this.db = db;
    this.invoices = invoices;
  }

  // Stores an upload in the inbox, waiting. The unique index on content_hash
  // refuses a second upload of the same email inside the insert, so two
  // processes cannot both store it. Throws DuplicateUploadError naming the first.
  addUpload(input: NewUpload): Upload {
    try {
      const result: { lastInsertRowid: number | bigint } = this.db
        .prepare(
          `INSERT INTO inbox
             (uploaded_by, uploaded_at, source, file_name, raw_sha256, raw_bytes, content_hash,
              message_id, sender, sender_name, from_as_written, reply_to, date_as_written,
              subject, body, style_text, attachments, notes, partial)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.uploadedBy,
          new Date().toISOString(),
          input.source,
          input.fileName,
          input.rawSha256,
          input.rawBytes,
          input.contentHash,
          input.messageId,
          input.sender,
          input.senderName,
          input.fromAsWritten,
          JSON.stringify(input.replyTo),
          input.dateAsWritten,
          input.subject,
          input.body,
          input.styleText,
          JSON.stringify(input.attachments),
          JSON.stringify(input.notes),
          input.partial ? 1 : 0,
        );
      const upload: Upload | undefined = this.upload(Number(result.lastInsertRowid));
      if (upload === undefined) {
        throw new Error("The upload was not stored");
      }
      return upload;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        const first: UploadRow | undefined = this.db
          .prepare("SELECT * FROM inbox WHERE content_hash = ?")
          .get(input.contentHash) as unknown as UploadRow | undefined;
        if (first !== undefined) {
          throw new DuplicateUploadError(toUpload(first));
        }
      }
      throw error;
    }
  }

  upload(id: number): Upload | undefined {
    const row: UploadRow | undefined = this.db
      .prepare("SELECT * FROM inbox WHERE id = ?")
      .get(id) as unknown as UploadRow | undefined;
    return row === undefined ? undefined : toUpload(row);
  }

  // Every waiting upload, then the latest others, newest first.
  uploads(others: number): Upload[] {
    const rows: UploadRow[] = this.db
      .prepare(
        `SELECT * FROM (SELECT * FROM inbox WHERE state = 'waiting' ORDER BY id DESC)
         UNION ALL
         SELECT * FROM (SELECT * FROM inbox WHERE state <> 'waiting' ORDER BY id DESC LIMIT ?)`,
      )
      .all(others) as unknown as UploadRow[];
    return rows.map(toUpload);
  }

  // How many uploads wait for a person, and the newest upload's id in any state,
  // which changes only when an email is uploaded. Counts only: no sender, name,
  // subject or text, so alerts can read it.
  inboxWaiting(): InboxWaiting {
    const row: { waiting: number; newest: number | null } = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM inbox WHERE state = 'waiting') AS waiting,
                (SELECT MAX(id) FROM inbox) AS newest`,
      )
      .get() as unknown as { waiting: number; newest: number | null };
    return { waiting: Number(row.waiting), newest: row.newest === null ? null : Number(row.newest) };
  }

  // Other uploads with the same Message-ID, which say something different, since
  // the same email twice is refused.
  sameMessageId(upload: Upload): number[] {
    if (upload.messageId === null) {
      return [];
    }
    const rows: { id: number }[] = this.db
      .prepare("SELECT id FROM inbox WHERE message_id = ? AND id <> ? ORDER BY id")
      .all(upload.messageId, upload.id) as unknown as { id: number }[];
    return rows.map((row: { id: number }): number => row.id);
  }

  // Delivers a waiting upload to an invoice in one transaction: the upload moves
  // to delivered only if it is still waiting, the email joins the invoice's
  // thread, and an open or escalated invoice's next look is due at once, so a
  // watcher in another process reads it. A closed invoice keeps the email on file
  // and is not reopened. ok false when the upload was no longer waiting.
  deliverUpload(id: number, invoiceId: string, deliveredBy: string): DeliverResult {
    return this.db.transaction((): DeliverResult => {
      const before: Upload | undefined = this.upload(id);
      if (before === undefined) {
        throw new Error(`Upload ${id} is not in the inbox`);
      }
      const obligation: Obligation | undefined = this.invoices.obligation(invoiceId);
      if (obligation === undefined) {
        throw new Error(`${invoiceId} is not in the ledger`);
      }
      const now: string = new Date().toISOString();
      const moved: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE inbox SET state = 'delivered', invoice_id = ?, delivered_by = ?, delivered_at = ?
            WHERE id = ? AND state = 'waiting'`,
        )
        .run(invoiceId, deliveredBy, now, id);
      if (Number(moved.changes) !== 1) {
        return { ok: false, upload: before };
      }
      this.db
        .prepare(
          `INSERT INTO emails
             (invoice_id, sender, subject, body, inbox_id, reply_to, style_text, attachments, notes, partial)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          invoiceId,
          before.sender,
          before.subject,
          before.body,
          id,
          JSON.stringify(before.replyTo),
          before.styleText,
          JSON.stringify(before.attachments),
          JSON.stringify(before.notes),
          before.partial ? 1 : 0,
        );
      this.db
        .prepare(
          `UPDATE obligations SET look_at = ?
            WHERE invoice_id = ? AND state IN ('open', 'escalated')`,
        )
        .run(now, invoiceId);
      const after: Upload | undefined = this.upload(id);
      return { ok: true, upload: after ?? before, obligation };
    });
  }

  // Dismisses a waiting upload, for good. False when it was no longer waiting.
  dismissUpload(id: number, dismissedBy: string, note: string): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE inbox SET state = 'dismissed', dismissed_by = ?, dismissed_at = ?, dismiss_note = ?
          WHERE id = ? AND state = 'waiting'`,
      )
      .run(dismissedBy, new Date().toISOString(), note, id);
    return Number(result.changes) === 1;
  }
}

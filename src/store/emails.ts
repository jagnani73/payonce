import type { SupplierEmail } from "../domain/emails.js";
import { storedShape, type Db } from "./db.js";
import { emailsOnFile, isAttachmentList, isTextList } from "./stored.js";

interface EmailRow {
  sender: string;
  subject: string;
  body: string;
  inbox_id: number | null;
  // From the upload, null for a fixture thread's email.
  sender_name: string | null;
  style_text: string;
  reply_to: string;
  attachments: string;
  notes: string;
  partial: number;
}

interface FindingsRow {
  findings: string;
}

// Supplier emails on each invoice and the reader's findings (emails,
// email_findings).
export class EmailStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  addEmails(invoiceId: string, emails: SupplierEmail[]): void {
    for (const email of emails) {
      this.db
        .prepare(
          "INSERT INTO emails (invoice_id, sender, subject, body) VALUES (?, ?, ?, ?)",
        )
        .run(invoiceId, email.from, email.subject, email.body);
    }
  }

  // A fixture thread's emails have the three fields they were written with. An
  // uploaded one has the rest of what PayOnce read from it, and the display name
  // its upload keeps. Its lists are read by shape: strict, so a look on one that
  // is not in the shape PayOnce writes throws, and as none inside readingSoft.
  emails(invoiceId: string): SupplierEmail[] {
    const rows: EmailRow[] = this.db
      .prepare(
        `SELECT e.sender, e.subject, e.body, e.inbox_id, i.sender_name, e.reply_to, e.style_text,
                e.attachments, e.notes, e.partial
           FROM emails e LEFT JOIN inbox i ON i.id = e.inbox_id
          WHERE e.invoice_id = ? ORDER BY e.id`,
      )
      .all(invoiceId) as unknown as EmailRow[];
    return rows.map(
      (row: EmailRow): SupplierEmail =>
        row.inbox_id === null
          ? { from: row.sender, subject: row.subject, body: row.body }
          : {
              from: row.sender,
              subject: row.subject,
              body: row.body,
              uploadId: row.inbox_id,
              fromName: row.sender_name ?? "",
              replyTo: storedShape(row.reply_to, isTextList, emailsOnFile(invoiceId)) ?? [],
              styleText: row.style_text,
              attachments: storedShape(row.attachments, isAttachmentList, emailsOnFile(invoiceId)) ?? [],
              notes: storedShape(row.notes, isTextList, emailsOnFile(invoiceId)) ?? [],
              partial: row.partial === 1,
            },
    );
  }

  emailCount(invoiceId: string): number {
    const row: { count: number } = this.db
      .prepare("SELECT COUNT(*) AS count FROM emails WHERE invoice_id = ?")
      .get(invoiceId) as unknown as { count: number };
    return row.count;
  }

  // Findings are stored once per email thread so a later run reads the same
  // result instead of asking the reader again.
  saveFindings(invoiceId: string, findings: string): void {
    this.db
      .prepare(
        `INSERT INTO email_findings (invoice_id, findings) VALUES (?, ?)
         ON CONFLICT(invoice_id) DO UPDATE SET findings = excluded.findings`,
      )
      .run(invoiceId, findings);
  }

  findings(invoiceId: string): string | undefined {
    const row: FindingsRow | undefined = this.db
      .prepare("SELECT findings FROM email_findings WHERE invoice_id = ?")
      .get(invoiceId) as unknown as FindingsRow | undefined;
    return row?.findings;
  }
}

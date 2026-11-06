import type { Db } from "../db.js";

// What a search finds, by group, at most a few of each. Text PayOnce did not
// write (supplier names, subjects, senders, file names) comes back as stored.
export interface SearchRead {
  invoices: { invoiceId: string; supplier: string; beneficiaryId: string; amountMinor: number; currency: string }[];
  suppliers: { beneficiaryId: string; supplier: string }[];
  runs: { id: number; fileName: string }[];
  uploads: { id: number; subject: string; sender: string; state: string }[];
  transfers: { reference: string; invoiceId: string; kind: string }[];
}

interface InvoiceHit {
  invoice_id: string;
  supplier: string;
  beneficiary_id: string;
  amount_minor: number;
  currency: string;
}

interface SupplierHit {
  beneficiary_id: string;
  supplier: string;
}

interface RunHit {
  id: number;
  file_name: string;
}

interface UploadHit {
  id: number;
  subject: string;
  sender: string;
  state: string;
}

interface TransferHit {
  reference: string;
  invoice_id: string;
  kind: string;
}

interface NameRow {
  name: string;
}

// LIKE matches the text anywhere, case-insensitive for ASCII, with its own
// wildcards taken as plain characters.
function likeOf(q: string): string {
  return `%${q.replace(/[\\%_]/g, (character: string): string => `\\${character}`)}%`;
}

// Reads across the ledger's tables for finding things by what a person types,
// and the names people have typed. Each group comes newest first. Nothing here
// writes.
export class SearchReads {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  search(q: string, limit: number): SearchRead {
    const like: string = likeOf(q);
    const run: number | null = /^[1-9][0-9]{0,9}$/.test(q) ? Number(q) : null;
    return {
      invoices: (
        this.db
          .prepare(
            `SELECT invoice_id, supplier, beneficiary_id, amount_minor, currency FROM obligations
              WHERE invoice_id LIKE ? ESCAPE '\\' OR supplier LIKE ? ESCAPE '\\' OR beneficiary_id LIKE ? ESCAPE '\\'
              ORDER BY rowid DESC LIMIT ?`,
          )
          .all(like, like, like, limit) as unknown as InvoiceHit[]
      ).map((row: InvoiceHit) => ({
        invoiceId: row.invoice_id,
        supplier: row.supplier,
        beneficiaryId: row.beneficiary_id,
        amountMinor: row.amount_minor,
        currency: row.currency,
      })),
      suppliers: (
        this.db
          .prepare(
            `SELECT beneficiary_id, supplier FROM obligations
              WHERE supplier LIKE ? ESCAPE '\\' OR beneficiary_id LIKE ? ESCAPE '\\'
              GROUP BY beneficiary_id ORDER BY MAX(rowid) DESC LIMIT ?`,
          )
          .all(like, like, limit) as unknown as SupplierHit[]
      ).map((row: SupplierHit) => ({ beneficiaryId: row.beneficiary_id, supplier: row.supplier })),
      runs: (
        this.db
          .prepare(`SELECT id, file_name FROM runs WHERE id = ? OR file_name LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`)
          .all(run, like, limit) as unknown as RunHit[]
      ).map((row: RunHit) => ({ id: row.id, fileName: row.file_name })),
      uploads: (
        this.db
          .prepare(
            `SELECT id, subject, sender, state FROM inbox
              WHERE subject LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\' OR sender_name LIKE ? ESCAPE '\\'
              ORDER BY id DESC LIMIT ?`,
          )
          .all(like, like, like, limit) as unknown as UploadHit[]
      ).map((row: UploadHit) => ({ id: row.id, subject: row.subject, sender: row.sender, state: row.state })),
      transfers: (
        this.db
          .prepare(
            `SELECT reference, invoice_id, kind FROM (
               SELECT reference, invoice_id, kind, opened_at AS at FROM attempts WHERE reference LIKE ? ESCAPE '\\'
               UNION ALL
               SELECT mismatched_reference, invoice_id, 'unrecognised', opened_at FROM attempts WHERE mismatched_reference LIKE ? ESCAPE '\\'
               UNION ALL
               SELECT reference, invoice_id, 'outside-payout', found_at FROM outside_payouts WHERE reference LIKE ? ESCAPE '\\'
             )
             ORDER BY at IS NULL, at DESC, reference LIMIT ?`,
          )
          .all(like, like, like, limit) as unknown as TransferHit[]
      ).map((row: TransferHit) => ({ reference: row.reference, invoiceId: row.invoice_id, kind: row.kind })),
    };
  }

  // Every name on file for a person who started, closed, approved, uploaded or
  // called back, as stored, most recent table first.
  knownNames(limit: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT name FROM (
             SELECT started_by AS name FROM obligations WHERE started_by IS NOT NULL
             UNION SELECT rejected_by FROM obligations WHERE rejected_by IS NOT NULL
             UNION SELECT approver FROM signoffs
             UNION SELECT approver FROM run_signoffs
             UNION SELECT uploaded_by FROM runs
             UNION SELECT uploaded_by FROM inbox
             UNION SELECT called_by FROM bank_changes
           ) ORDER BY name LIMIT ?`,
        )
        .all(limit) as unknown as NameRow[]
    ).map((row: NameRow): string => row.name);
  }
}

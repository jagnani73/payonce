import { sameName } from "../domain/approvers.js";
import {
  CALLBACK_REQUEST_VOIDED,
  confirmLine,
  ContactError,
  isNumberOnFile,
  lapsed,
  lapseLine,
  mismatchLine,
  notTheNumber,
  notWaiting,
  phoneDigits,
  proposalLine,
  proposalWaits,
  RUN_ROW_WAITS,
  runRequestVoided,
  sameNumber,
  scenarioLine,
  selfConfirm,
  withdrawLine,
  type Contact,
  type ContactField,
  type ContactOrigin,
  type ContactSource,
  type ContactState,
} from "../domain/contacts.js";
import type { ColumnRow, Db } from "./db.js";
import type { Timelines } from "./timeline.js";

// meta.contacts_seeded_at: when the phones on invoices became the records' phones
// on file, once.
const SEEDED_AT: string = "contacts_seeded_at";

interface ContactRow {
  id: number;
  beneficiary_id: string;
  field: ContactField;
  value: string;
  digits: string;
  replaces_id: number | null;
  state: ContactState;
  origin: ContactOrigin;
  proposed_by: string | null;
  proposed_at: string;
  proposed_source: string;
  proposed_note: string;
  seen_in_emails: number;
  seen_flagged: number;
  confirmed_by: string | null;
  confirmed_at: string | null;
  confirmed_source: string | null;
  confirmed_note: string | null;
  closed_by: string | null;
  closed_at: string | null;
  close_note: string | null;
  withdrawn_requests: number;
  // Absent on a file opened read-only from before the column.
  mismatched_confirms?: number;
}

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    beneficiaryId: row.beneficiary_id,
    field: row.field,
    value: row.value,
    digits: row.digits,
    replacesId: row.replaces_id,
    state: row.state,
    origin: row.origin,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
    proposedSource: row.proposed_source,
    proposedNote: row.proposed_note,
    seenInEmails: row.seen_in_emails,
    seenFlagged: row.seen_flagged,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    confirmedSource: row.confirmed_source,
    confirmedNote: row.confirmed_note,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    closeNote: row.close_note,
    withdrawnRequests: row.withdrawn_requests,
    mismatchedConfirms: row.mismatched_confirms ?? 0,
  };
}

// The first writable open with supplier_contacts, under the write lock that adds
// the columns, once: for each beneficiary record, the phone on its newest invoice
// that has one goes on file, with no person, and each callback gets that row
// when it was made on that number. A callback made on any other number has none,
// and none verifies bank details.
export function seedContacts(db: Db): void {
  if (db.metaValue(SEEDED_AT) !== null) {
    return;
  }
  const now: string = new Date().toISOString();
  const phones = db
    .prepare(
      `SELECT o.beneficiary_id, o.supplier_phone FROM obligations o
        WHERE o.rowid = (SELECT max(p.rowid) FROM obligations p
                          WHERE p.beneficiary_id = o.beneficiary_id AND trim(COALESCE(p.supplier_phone, '')) <> '')
        ORDER BY o.rowid`,
    )
    .all() as unknown as { beneficiary_id: string; supplier_phone: string }[];
  const insert = db.prepare(
    `INSERT INTO supplier_contacts (beneficiary_id, field, value, digits, state, origin, proposed_at)
     VALUES (?, 'phone', ?, ?, 'on_file', 'migrated', ?)`,
  );
  for (const row of phones) {
    const value: string = row.supplier_phone.trim();
    insert.run(row.beneficiary_id, value, phoneDigits(value), now);
  }
  const onFile = db.prepare(
    "SELECT id, value FROM supplier_contacts WHERE beneficiary_id = ? AND field = 'phone' AND state = 'on_file'",
  );
  const setContact = db.prepare("UPDATE bank_changes SET contact_id = ? WHERE id = ?");
  const callbacks = db.prepare("SELECT id, beneficiary_id, number_called FROM bank_changes ORDER BY id").all() as unknown as {
    id: number;
    beneficiary_id: string;
    number_called: string;
  }[];
  for (const callback of callbacks) {
    const contact = onFile.get(callback.beneficiary_id) as unknown as { id: number; value: string } | undefined;
    if (contact !== undefined && contact.value !== "" && isNumberOnFile(callback.number_called, contact.value)) {
      setContact.run(contact.id, callback.id);
    }
  }
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(SEEDED_AT, now);
}

// The supplier records' contacts as the ledger keeps them (supplier_contacts):
// reads only, so the invoice reads, the callbacks and the supplier view can use
// them on a read-only open too.
export class ContactReads {
  private readonly db: Db;
  private seen: boolean = false;

  constructor(db: Db) {
    this.db = db;
  }

  // False only for a file opened read-only from before the table, or before it
  // was seeded, whose invoices still hold their own phone.
  kept(): boolean {
    this.seen ||=
      (this.db.prepare("PRAGMA table_info(supplier_contacts)").all() as unknown as ColumnRow[]).length > 0 &&
      this.db.metaValue(SEEDED_AT) !== null;
    return this.seen;
  }

  // What an invoice read gives as its supplier's phone: the number on file for
  // the record it pays, or none, never the invoice's own column, which is still
  // written at open and not read again. A file from before reads the column.
  phoneColumn(): string {
    return this.kept()
      ? `(SELECT NULLIF(c.value, '') FROM supplier_contacts c
           WHERE c.beneficiary_id = obligations.beneficiary_id AND c.field = 'phone' AND c.state = 'on_file')`
      : "obligations.supplier_phone";
  }

  byId(id: number): Contact | undefined {
    if (!this.kept()) {
      return undefined;
    }
    const row: ContactRow | undefined = this.db
      .prepare("SELECT * FROM supplier_contacts WHERE id = ?")
      .get(id) as unknown as ContactRow | undefined;
    return row === undefined ? undefined : toContact(row);
  }

  private inState(beneficiaryId: string, field: ContactField, state: ContactState): Contact | undefined {
    if (!this.kept()) {
      return undefined;
    }
    const row: ContactRow | undefined = this.db
      .prepare("SELECT * FROM supplier_contacts WHERE beneficiary_id = ? AND field = ? AND state = ?")
      .get(beneficiaryId, field, state) as unknown as ContactRow | undefined;
    return row === undefined ? undefined : toContact(row);
  }

  // The row on file, '' for none on file once one was removed.
  onFile(beneficiaryId: string, field: ContactField): Contact | undefined {
    return this.inState(beneficiaryId, field, "on_file");
  }

  // The proposal waiting for a second person, lapsed or not.
  proposal(beneficiaryId: string, field: ContactField): Contact | undefined {
    return this.inState(beneficiaryId, field, "proposed");
  }

  // Every version of a record's contacts, oldest first, or of every record's when
  // beneficiaryId is null.
  of(beneficiaryId: string | null): Contact[] {
    if (!this.kept()) {
      return [];
    }
    return (
      (beneficiaryId === null
        ? this.db.prepare("SELECT * FROM supplier_contacts ORDER BY id").all()
        : this.db
            .prepare("SELECT * FROM supplier_contacts WHERE beneficiary_id = ? ORDER BY id")
            .all(beneficiaryId)) as unknown as ContactRow[]
    ).map(toContact);
  }

  // Every phone number the ledger keeps, in any state, every number a callback
  // was made on and every number an invoice still holds, for masking.
  storedPhones(): string[] {
    const rows = this.db
      .prepare(
        `SELECT number_called AS value FROM bank_changes
          UNION SELECT supplier_phone FROM obligations WHERE supplier_phone IS NOT NULL
          ${this.kept() ? "UNION SELECT value FROM supplier_contacts WHERE field = 'phone'" : ""}`,
      )
      .all() as unknown as { value: string }[];
    return rows.map((row: { value: string }): string => row.value);
  }
}

// What a person proposes, as checked: the value in its normal form and its digits.
export interface ProposedContact {
  beneficiaryId: string;
  field: ContactField;
  value: string;
  digits: string;
  proposedBy: string;
  source: ContactSource;
  note: string;
  seenInEmails: number;
  seenFlagged: number;
}

export interface ConfirmedContact {
  value: string;
  digits: string;
  confirmedBy: string;
  source: ContactSource;
  note: string;
}

// A change and the invoices whose looks it made due, for the caller to wake.
export interface ContactChange {
  contact: Contact;
  invoices: string[];
}

// Where a record's contact lines go: every open or escalated invoice of it; with
// none, its newest invoice; with no invoice, the waiting run that names it.
interface LineTargets {
  open: string[];
  invoices: string[];
  run: number | null;
}

// Proposing, confirming and withdrawing a record's contact, each in one
// transaction that writes its lines, the requests it withdraws and the looks it
// makes due.
export class ContactStore {
  private readonly db: Db;
  readonly reads: ContactReads;
  private readonly timelines: Timelines;

  constructor(db: Db, reads: ContactReads, timelines: Timelines) {
    this.db = db;
    this.reads = reads;
    this.timelines = timelines;
  }

  // In openObligation's transaction: a scenario's phone goes on file, with its
  // line on the new invoice, when the record has none on file and none waiting.
  seedScenario(invoiceId: string, beneficiaryId: string, value: string): void {
    const inserted: { changes: number | bigint } = this.db
      .prepare(
        `INSERT INTO supplier_contacts (beneficiary_id, field, value, digits, state, origin, proposed_at)
         SELECT ?, 'phone', ?, ?, 'on_file', 'scenario', ?
          WHERE NOT EXISTS (SELECT 1 FROM supplier_contacts
                             WHERE beneficiary_id = ? AND field = 'phone' AND state IN ('on_file', 'proposed'))`,
      )
      .run(beneficiaryId, value, phoneDigits(value), new Date().toISOString(), beneficiaryId);
    if (Number(inserted.changes) === 1) {
      this.timelines.appendEvent(invoiceId, "contact", scenarioLine(value), null);
    }
  }

  private targets(beneficiaryId: string): LineTargets {
    const ids = (sql: string): string[] =>
      (this.db.prepare(sql).all(beneficiaryId) as unknown as { invoice_id: string }[]).map(
        (row: { invoice_id: string }): string => row.invoice_id,
      );
    const open: string[] = ids(
      "SELECT invoice_id FROM obligations WHERE beneficiary_id = ? AND state IN ('open', 'escalated') ORDER BY rowid",
    );
    const invoices: string[] =
      open.length > 0 ? open : ids("SELECT invoice_id FROM obligations WHERE beneficiary_id = ? ORDER BY rowid DESC LIMIT 1");
    const run: { id: number } | undefined =
      invoices.length > 0
        ? undefined
        : (this.db
            .prepare(
              `SELECT runs.id FROM runs JOIN run_rows ON run_rows.run_id = runs.id
                WHERE runs.state = 'waiting' AND run_rows.beneficiary_id = ? ORDER BY runs.id DESC LIMIT 1`,
            )
            .get(beneficiaryId) as unknown as { id: number } | undefined);
    return { open, invoices, run: run?.id ?? null };
  }

  private line(targets: LineTargets, message: string): void {
    for (const invoiceId of targets.invoices) {
      this.timelines.appendEvent(invoiceId, "contact", message, null);
    }
    if (targets.run !== null) {
      this.timelines.addRunEventRow(targets.run, "contact", message, null);
    }
  }

  // The record's open and escalated invoices are looked at again now, so a
  // waiting line names the number on file and a callback form opens or closes.
  private lookNow(beneficiaryId: string, at: string): void {
    this.db
      .prepare("UPDATE obligations SET look_at = ? WHERE beneficiary_id = ? AND state IN ('open', 'escalated')")
      .run(at, beneficiaryId);
  }

  private known(beneficiaryId: string): LineTargets {
    const targets: LineTargets = this.targets(beneficiaryId);
    if (targets.invoices.length === 0 && targets.run === null) {
      throw new ContactError("unknown", `No invoice or pay run row in the ledger names supplier record ${beneficiaryId.slice(0, 20)}`);
    }
    return targets;
  }

  // A proposal waits for a second person. One that lapsed is closed first, with
  // its line. The checks and the insert run under one write lock, so two people
  // proposing at once cannot both open one.
  proposeContact(input: ProposedContact, now: number): ContactChange {
    return this.db.transaction((): ContactChange => {
      const at: string = new Date(now).toISOString();
      const targets: LineTargets = this.known(input.beneficiaryId);
      const onFile: Contact | undefined = this.reads.onFile(input.beneficiaryId, input.field);
      if (input.value === "" && (onFile === undefined || onFile.value === "")) {
        throw new ContactError("input", "No phone number is on file for this supplier, so there is none to remove");
      }
      if (onFile !== undefined && onFile.digits === input.digits) {
        throw new ContactError("input", "That is the phone number on file already");
      }
      const open: Contact | undefined = this.reads.proposal(input.beneficiaryId, input.field);
      if (open !== undefined && !lapsed(open, now)) {
        throw new ContactError("conflict", proposalWaits(open));
      }
      if (open !== undefined) {
        this.db
          .prepare(
            "UPDATE supplier_contacts SET state = 'lapsed', closed_at = ?, close_note = ? WHERE id = ? AND state = 'proposed'",
          )
          .run(at, "Not confirmed within 72 hours", open.id);
        this.line(targets, lapseLine(open));
      }
      const inserted: { lastInsertRowid: number | bigint } = this.db
        .prepare(
          `INSERT INTO supplier_contacts
             (beneficiary_id, field, value, digits, replaces_id, state, origin, proposed_by, proposed_at,
              proposed_source, proposed_note, seen_in_emails, seen_flagged)
           VALUES (?, ?, ?, ?, ?, 'proposed', 'person', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.beneficiaryId,
          input.field,
          input.value,
          input.digits,
          onFile?.id ?? null,
          input.proposedBy,
          at,
          input.source,
          input.note,
          input.seenInEmails,
          input.seenFlagged,
        );
      const proposal: Contact = this.require(Number(inserted.lastInsertRowid));
      this.line(targets, proposalLine(proposal, onFile));
      this.lookNow(input.beneficiaryId, at);
      return { contact: proposal, invoices: targets.open };
    });
  }

  // A second person puts the proposal on file by typing the number again from
  // their own source. A change of a number on file retires every callback made
  // on it (verifiedBankChange) and, in this transaction, withdraws every open or
  // approved request that relies on one, for this record's invoices and for the
  // waiting run's rows to it. While a released pay run row to the record waits to
  // be sent on a callback, a change is refused, since its send does not check
  // the callback again. A number that does not match is refused too, but it
  // could be someone trying a number they do not have, so it is kept first: the
  // proposal counts it, for the contact alert, and the record's timelines get a
  // line, and the refusal is thrown once that commits.
  confirmContact(beneficiaryId: string, id: number, input: ConfirmedContact, now: number): ContactChange {
    const done: ContactChange | ContactError = this.db.transaction((): ContactChange | ContactError => {
      const at: string = new Date(now).toISOString();
      const proposal: Contact = this.proposalOf(beneficiaryId, id);
      if (proposal.state !== "proposed") {
        throw new ContactError("conflict", notWaiting(proposal));
      }
      if (lapsed(proposal, now)) {
        throw new ContactError("conflict", `${lapseLine(proposal)}. Propose it again`);
      }
      if (proposal.proposedBy !== null && sameName(proposal.proposedBy, input.confirmedBy)) {
        throw new ContactError("refused", selfConfirm(proposal.proposedBy));
      }
      if (!sameNumber(proposal, input)) {
        this.db
          .prepare(
            "UPDATE supplier_contacts SET mismatched_confirms = mismatched_confirms + 1 WHERE id = ? AND state = 'proposed'",
          )
          .run(proposal.id);
        this.line(this.targets(beneficiaryId), mismatchLine(proposal, input.confirmedBy));
        return new ContactError("input", notTheNumber(proposal));
      }
      const onFile: Contact | undefined = this.reads.onFile(beneficiaryId, proposal.field);
      if ((onFile?.id ?? null) !== proposal.replacesId) {
        throw new ContactError(
          "conflict",
          "The phone number on file changed after this was proposed. Withdraw it and propose again",
        );
      }
      const change: boolean = onFile !== undefined && onFile.value !== "";
      if (change && this.releasedRowWaits(beneficiaryId)) {
        throw new ContactError("conflict", RUN_ROW_WAITS);
      }
      const targets: LineTargets = this.known(beneficiaryId);
      if (onFile !== undefined) {
        this.db
          .prepare(
            "UPDATE supplier_contacts SET state = 'replaced', closed_by = ?, closed_at = ?, close_note = ? WHERE id = ?",
          )
          .run(input.confirmedBy, at, `Replaced by ${proposal.id}`, onFile.id);
      }
      this.db
        .prepare(
          `UPDATE supplier_contacts SET state = 'on_file', confirmed_by = ?, confirmed_at = ?, confirmed_source = ?,
                  confirmed_note = ?
            WHERE id = ? AND state = 'proposed'`,
        )
        .run(input.confirmedBy, at, input.source, input.note, proposal.id);
      this.line(targets, confirmLine(this.require(proposal.id), onFile));
      if (change) {
        const withdrawn: number = this.voidCallbackRequests(beneficiaryId) + this.voidRunRequests(beneficiaryId);
        this.db.prepare("UPDATE supplier_contacts SET withdrawn_requests = ? WHERE id = ?").run(withdrawn, proposal.id);
      }
      this.lookNow(beneficiaryId, at);
      return { contact: this.require(proposal.id), invoices: targets.open };
    });
    if (done instanceof ContactError) {
      throw done;
    }
    return done;
  }

  withdrawContact(beneficiaryId: string, id: number, by: string, note: string, now: number): ContactChange {
    return this.db.transaction((): ContactChange => {
      const at: string = new Date(now).toISOString();
      const proposal: Contact = this.proposalOf(beneficiaryId, id);
      if (proposal.state !== "proposed") {
        throw new ContactError("conflict", notWaiting(proposal));
      }
      const targets: LineTargets = this.known(beneficiaryId);
      this.db
        .prepare(
          "UPDATE supplier_contacts SET state = 'withdrawn', closed_by = ?, closed_at = ?, close_note = ? WHERE id = ?",
        )
        .run(by, at, note, proposal.id);
      this.line(targets, withdrawLine(proposal, by, note));
      this.lookNow(beneficiaryId, at);
      return { contact: this.require(proposal.id), invoices: targets.open };
    });
  }

  private require(id: number): Contact {
    const contact: Contact | undefined = this.reads.byId(id);
    if (contact === undefined) {
      throw new Error(`Contact ${id} is not in the ledger`);
    }
    return contact;
  }

  private proposalOf(beneficiaryId: string, id: number): Contact {
    const proposal: Contact | undefined = this.reads.byId(id);
    if (proposal === undefined || proposal.beneficiaryId !== beneficiaryId) {
      throw new ContactError("unknown", `No proposed phone number ${id} for this supplier`);
    }
    return proposal;
  }

  // A released pay run row to the record, with the callback that verified its
  // account, that has not opened its payment yet.
  private releasedRowWaits(beneficiaryId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM obligations JOIN run_rows ON run_rows.id = obligations.run_row_id
            WHERE obligations.beneficiary_id = ? AND obligations.state = 'open'
              AND run_rows.bank_change_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.invoice_id = obligations.invoice_id)
            LIMIT 1`,
        )
        .get(beneficiaryId) !== undefined
    );
  }

  // Every open or approved request on the record's invoices whose terms carry a
  // callback, voided with a line on its invoice. Nothing is spent once this
  // commits: useApproval and releaseFor move only approved rows. How many.
  private voidCallbackRequests(beneficiaryId: string): number {
    const voided = this.db
      .prepare(
        `UPDATE approvals SET state = 'void'
          WHERE state IN ('requested', 'approved')
            AND invoice_id IN (SELECT invoice_id FROM obligations WHERE beneficiary_id = ?)
            AND CASE WHEN json_valid(terms) THEN json_type(terms, '$.evidence.bankChange') = 'object' ELSE 0 END
          RETURNING invoice_id`,
      )
      .all(beneficiaryId) as unknown as { invoice_id: string }[];
    for (const row of voided) {
      this.timelines.appendEvent(row.invoice_id, "approval", CALLBACK_REQUEST_VOIDED, null);
    }
    return voided.length;
  }

  // The waiting run's open or approved request, when a row of it to this record
  // relies on a callback, voided with a line on the run naming those rows. The
  // run's next check skips the rows until a callback on the number now on file.
  private voidRunRequests(beneficiaryId: string): number {
    const rows = this.db
      .prepare(
        `SELECT run_rows.run_id, run_rows.line FROM run_rows JOIN runs ON runs.id = run_rows.run_id
          WHERE runs.state = 'waiting' AND run_rows.beneficiary_id = ? AND run_rows.action = 'pay'
            AND run_rows.bank_change_id IS NOT NULL
          ORDER BY run_rows.run_id, run_rows.line`,
      )
      .all(beneficiaryId) as unknown as { run_id: number; line: number }[];
    let voided: number = 0;
    for (const runId of new Set<number>(rows.map((row: { run_id: number }): number => row.run_id))) {
      const result: { changes: number | bigint } = this.db
        .prepare("UPDATE run_approvals SET state = 'void' WHERE run_id = ? AND state IN ('requested', 'approved')")
        .run(runId);
      if (Number(result.changes) > 0) {
        voided += Number(result.changes);
        this.timelines.addRunEventRow(
          runId,
          "approval",
          runRequestVoided(
            rows
              .filter((row: { run_id: number }): boolean => row.run_id === runId)
              .map((row: { line: number }): number => row.line),
          ),
          null,
        );
      }
    }
    return voided;
  }
}

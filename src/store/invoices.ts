import {
  parseReason,
  reasonColumns,
  storedReason,
  type Reason,
  type ReasonColumns,
  type StoredReason,
} from "../domain/reasons.js";
import { storedStrings, type Db } from "./db.js";
import type { Timelines } from "./timeline.js";

// Every escalation writes the reason's text and its codes together, as
// reasonColumns gives them, in this order.
export const SET_REASON: string =
  "escalation_reason = ?, escalation_code = ?, escalation_clauses = ?, escalation_slots = ?";

interface ReasonRow {
  escalation_reason: string;
  escalation_code: string;
  escalation_clauses: string;
  escalation_slots: string;
}

// An invoice number PayOnce accepts. A found payout's reference becomes its
// invoice number only when it fits.
export const INVOICE_ID_PATTERN: RegExp = /^[A-Za-z0-9-]{1,40}$/;

// rejected is an invoice a person closed without paying, because it was a second
// bill for one the ledger already had.
export type ObligationState = "open" | "settled" | "escalated" | "rejected";

// Who sent the original: PayOnce, or someone outside it, such as a person in the
// Airwallex web app. The sweep finds the second kind.
export type ObligationOrigin = "payonce" | "outside";

export type TransferMethod = "LOCAL" | "SWIFT";

export interface NewObligation {
  invoiceId: string;
  supplier: string;
  supplierDomain: string;
  beneficiaryId: string;
  currency: string;
  amountMinor: number;
  transferMethod: TransferMethod;
  // A floor of the invoice's own, stricter than its currency's in RESERVE_FLOORS,
  // in the currency of the wallet it is paid from. 0 for none. Only the
  // low-reserve demo sets one.
  invoiceFloorMinor: number;
  // The name the person who started the incident gave. Null when PayOnce does
  // not know, as for a payout sent outside it.
  startedBy: string | null;
  // The supplier's phone number from the supplier record, for calling back about
  // a change of bank details. Null when none is on file.
  supplierPhone: string | null;
  // The wallet the invoice is paid from, when not its own currency's.
  sourceCurrency?: string;
  // When the supplier expects the money, as YYYY-MM-DD. Advice for people only:
  // it never changes a decision or a payment.
  dueDate?: string | null;
}

export interface Obligation extends NewObligation {
  // The invoice's own currency when it is not paid from another wallet.
  sourceCurrency: string;
  dueDate: string | null;
  origin: ObligationOrigin;
  state: ObligationState;
  // Why the invoice last went to a person. Empty if it never has.
  escalationReason: string;
  // A found invoice's payout reference, when it could not be the invoice number.
  payoutReference: string | null;
  // The invoices this one looked like a second bill for when PayOnce held it
  // before paying. Empty when it was never held as one.
  duplicateOf: string[];
  // Who closed it without paying, if anyone ever did.
  rejectedBy: string | null;
  // The pay run row it was released from. Null for any other invoice.
  runRowId: number | null;
}

// An invoice as the money committed to payments is worked out from it.
export type CashObligation = Pick<
  Obligation,
  "invoiceId" | "state" | "currency" | "sourceCurrency" | "amountMinor" | "transferMethod" | "origin" | "runRowId"
>;

// An invoice as the scans over every invoice compare it.
export type ScannedObligation = Pick<
  Obligation,
  "invoiceId" | "supplier" | "supplierDomain" | "beneficiaryId" | "currency" | "amountMinor" | "state" | "payoutReference"
>;

export interface ObligationRow {
  invoice_id: string;
  supplier: string;
  supplier_domain: string;
  beneficiary_id: string;
  currency: string;
  amount_minor: number;
  transfer_method: TransferMethod;
  invoice_floor_minor: number;
  origin: ObligationOrigin;
  state: ObligationState;
  escalation_reason: string;
  started_by: string | null;
  supplier_phone: string | null;
  payout_reference: string | null;
  duplicate_of: string | null;
  rejected_by: string | null;
  run_row_id: number | null;
  source_currency: string | null;
  due_date: string | null;
}

export interface InvoiceRow {
  invoice_id: string;
}

function toObligation(row: ObligationRow): Obligation {
  return {
    invoiceId: row.invoice_id,
    supplier: row.supplier,
    supplierDomain: row.supplier_domain,
    beneficiaryId: row.beneficiary_id,
    currency: row.currency,
    sourceCurrency: row.source_currency ?? row.currency,
    amountMinor: row.amount_minor,
    transferMethod: row.transfer_method,
    invoiceFloorMinor: row.invoice_floor_minor,
    origin: row.origin,
    state: row.state,
    escalationReason: row.escalation_reason,
    startedBy: row.started_by,
    supplierPhone: row.supplier_phone,
    payoutReference: row.payout_reference,
    duplicateOf: row.duplicate_of === null ? [] : storedStrings(row.duplicate_of),
    rejectedBy: row.rejected_by,
    runRowId: row.run_row_id,
    dueDate: row.due_date ?? null,
  };
}

// True when the invoice is paid from another currency's wallet, so each payment
// converts on a quote a person approved.
export function crossCurrency(obligation: Pick<Obligation, "sourceCurrency" | "currency">): boolean {
  return obligation.sourceCurrency !== obligation.currency;
}

// Null when the invoice is paid from its own currency, as the column keeps it.
export function sourceColumn(input: NewObligation): string | null {
  return input.sourceCurrency === undefined || input.sourceCurrency === input.currency
    ? null
    : input.sourceCurrency;
}

// The message for an invoice number the ledger already has.
export function alreadyInLedger(invoiceId: string): string {
  return `${invoiceId} is already in the ledger, and PayOnce pays an invoice number once`;
}

// Invoices (obligations): what each is, its state, its reason and when it is next
// looked at.
export class InvoiceStore {
  private readonly db: Db;
  private readonly timelines: Timelines;

  constructor(db: Db, timelines: Timelines) {
    this.db = db;
    this.timelines = timelines;
  }

  // Writes the invoice and its first timeline line in one transaction, so every
  // invoice has a line from the moment it exists, and an audit that finds one
  // with none knows its lines were removed.
  openObligation(input: NewObligation): Obligation {
    this.db.transaction((): void => {
      const opened: { changes: number | bigint } = this.db
        .prepare(
          `INSERT OR IGNORE INTO obligations
             (invoice_id, supplier, supplier_domain, beneficiary_id, currency,
              amount_minor, transfer_method, invoice_floor_minor, started_by,
              supplier_phone, source_currency, due_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.invoiceId,
          input.supplier,
          input.supplierDomain,
          input.beneficiaryId,
          input.currency,
          input.amountMinor,
          input.transferMethod,
          input.invoiceFloorMinor,
          input.startedBy,
          input.supplierPhone,
          sourceColumn(input),
          input.dueDate ?? null,
        );
      if (Number(opened.changes) === 1) {
        this.timelines.appendEvent(
          input.invoiceId,
          "payment",
          input.startedBy === null ? "Incident opened" : `Incident opened by ${input.startedBy}`,
          null,
        );
      }
    });
    const row: ObligationRow = this.db
      .prepare("SELECT * FROM obligations WHERE invoice_id = ?")
      .get(input.invoiceId) as unknown as ObligationRow;
    return toObligation(row);
  }

  obligation(invoiceId: string): Obligation | undefined {
    const row: ObligationRow | undefined = this.db
      .prepare("SELECT * FROM obligations WHERE invoice_id = ?")
      .get(invoiceId) as unknown as ObligationRow | undefined;
    return row === undefined ? undefined : toObligation(row);
  }

  // Newest first.
  obligations(): Obligation[] {
    const rows: ObligationRow[] = this.db
      .prepare("SELECT * FROM obligations ORDER BY rowid DESC")
      .all() as unknown as ObligationRow[];
    return rows.map(toObligation);
  }

  // The invoices that are not closed, newest first: the ones the board lists.
  openObligations(): Obligation[] {
    return (
      this.db
        .prepare("SELECT * FROM obligations WHERE state IN ('open', 'escalated') ORDER BY rowid DESC")
        .all() as unknown as ObligationRow[]
    ).map(toObligation);
  }

  // The invoices that pay one beneficiary record, newest first.
  obligationsFor(beneficiaryId: string): Obligation[] {
    return (
      this.db
        .prepare("SELECT * FROM obligations WHERE beneficiary_id = ? ORDER BY rowid DESC")
        .all(beneficiaryId) as unknown as ObligationRow[]
    ).map(toObligation);
  }

  // Every invoice as the scans that compare one with all the others read it:
  // likelyDuplicates, sameNumberForSupplier, a pay run's checks and the callback's
  // check for another payment starting. Only the columns they test, so a stored
  // list on another invoice that does not parse cannot stop a payment.
  scannedObligations(): ScannedObligation[] {
    return (
      this.db
        .prepare(
          `SELECT invoice_id, supplier, supplier_domain, beneficiary_id, currency, amount_minor, state,
                  payout_reference
             FROM obligations ORDER BY rowid DESC`,
        )
        .all() as unknown as ObligationRow[]
    ).map(
      (row: ObligationRow): ScannedObligation => ({
        invoiceId: row.invoice_id,
        supplier: row.supplier,
        supplierDomain: row.supplier_domain,
        beneficiaryId: row.beneficiary_id,
        currency: row.currency,
        amountMinor: row.amount_minor,
        state: row.state,
        payoutReference: row.payout_reference,
      }),
    );
  }

  // The invoice a payout's reference names: its invoice number, or the payout
  // reference a found invoice was recorded with.
  obligationForReference(reference: string): Obligation | undefined {
    if (reference === "") {
      return undefined;
    }
    const row: ObligationRow | undefined = this.db
      .prepare(
        `SELECT * FROM obligations WHERE invoice_id = ? OR payout_reference = ?
          ORDER BY rowid LIMIT 1`,
      )
      .get(reference, reference) as unknown as ObligationRow | undefined;
    return row === undefined ? undefined : toObligation(row);
  }

  // Makes an open or escalated invoice's next look due now, so a watcher in any
  // process looks at it, for a bank fact recorded outside its look.
  lookNow(invoiceId: string): void {
    this.db
      .prepare(
        `UPDATE obligations SET look_at = ?
          WHERE invoice_id = ? AND state IN ('open', 'escalated')`,
      )
      .run(new Date().toISOString(), invoiceId);
  }

  // Null means the agent waits for news and does not look by itself.
  lookAt(invoiceId: string, at: number | null): void {
    this.db
      .prepare("UPDATE obligations SET look_at = ? WHERE invoice_id = ?")
      .run(at === null ? null : new Date(at).toISOString(), invoiceId);
  }

  // Moves a look that is already due, or was never set, to a later time. For a
  // look that failed, so it is tried again later and not on every check.
  postponeDueLook(invoiceId: string, now: number, until: number): void {
    this.db
      .prepare(
        `UPDATE obligations SET look_at = ?
          WHERE invoice_id = ? AND (look_at IS NULL OR look_at <= ?)`,
      )
      .run(new Date(until).toISOString(), invoiceId, new Date(now).toISOString());
  }

  // When the agent's next look at the invoice is planned, as stored, or null
  // when it waits for news.
  nextCheckAt(invoiceId: string): string | null {
    const row: { look_at: string | null } | undefined = this.db
      .prepare("SELECT look_at FROM obligations WHERE invoice_id = ?")
      .get(invoiceId) as unknown as { look_at: string | null } | undefined;
    return row?.look_at ?? null;
  }

  // True when the agent has a look at the invoice planned for later than now.
  lookPlanned(invoiceId: string, now: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM obligations WHERE invoice_id = ? AND look_at > ?")
        .get(invoiceId, new Date(now).toISOString()) !== undefined
    );
  }

  // Open invoices whose next look is due.
  dueLooks(now: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT invoice_id FROM obligations
            WHERE look_at IS NOT NULL AND look_at <= ?
              AND state NOT IN ('settled', 'rejected')`,
        )
        .all(new Date(now).toISOString()) as unknown as InvoiceRow[]
    ).map((row: InvoiceRow): string => row.invoice_id);
  }

  // The reason an invoice read as obligation holds, as codes. The codes on file
  // are used while they render the text it was read with, so a reason another
  // process wrote since is never taken for the one read; otherwise that text is
  // parsed. Either way the reason renders obligation.escalationReason exactly.
  reasonOf(obligation: Pick<Obligation, "invoiceId" | "escalationReason">): StoredReason | null {
    const row: ReasonRow | undefined = this.db
      .prepare(
        `SELECT escalation_reason, escalation_code, escalation_clauses, escalation_slots
           FROM obligations WHERE invoice_id = ?`,
      )
      .get(obligation.invoiceId) as unknown as ReasonRow | undefined;
    return row !== undefined && row.escalation_reason === obligation.escalationReason
      ? storedReason({
          text: row.escalation_reason,
          code: row.escalation_code,
          clauses: row.escalation_clauses,
          slots: row.escalation_slots,
        })
      : obligation.escalationReason === ""
        ? null
        : parseReason(obligation.escalationReason);
  }

  escalate(invoiceId: string, reason: StoredReason | null): void {
    const columns: ReasonColumns = reasonColumns(reason);
    this.db
      .prepare(
        `UPDATE obligations SET state = 'escalated', ${SET_REASON}
          WHERE invoice_id = ?`,
      )
      .run(columns.text, columns.code, columns.clauses, columns.slots, invoiceId);
  }

  // escalate, unless the invoice is escalated already with this reason in every
  // column, so a look that finds it as it left it writes nothing.
  escalateIfChanged(invoiceId: string, reason: StoredReason | null): void {
    const columns: ReasonColumns = reasonColumns(reason);
    this.db
      .prepare(
        `UPDATE obligations SET state = 'escalated', ${SET_REASON}
          WHERE invoice_id = ?
            AND NOT (state = 'escalated' AND escalation_reason IS ? AND escalation_code IS ?
                     AND escalation_clauses IS ? AND escalation_slots IS ?)`,
      )
      .run(
        columns.text,
        columns.code,
        columns.clauses,
        columns.slots,
        invoiceId,
        columns.text,
        columns.code,
        columns.clauses,
        columns.slots,
      );
  }

  // Rewords the reason of an invoice that is still escalated with the reason it
  // was read with, so a close or another change from another process meanwhile
  // is left alone. True when it changed it.
  rewordEscalation(invoiceId: string, from: StoredReason | null, to: StoredReason): boolean {
    const columns: ReasonColumns = reasonColumns(to);
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE obligations SET ${SET_REASON}
          WHERE invoice_id = ? AND state = 'escalated' AND escalation_reason = ?`,
      )
      .run(columns.text, columns.code, columns.clauses, columns.slots, invoiceId, reasonColumns(from).text);
    return Number(result.changes) === 1;
  }

  // Holds an invoice for a person before anything is paid. duplicateOf lists the
  // invoices it looks like a second bill for, and is empty when it is held for
  // another reason.
  holdBeforePaying(invoiceId: string, duplicateOf: string[], reason: Reason): void {
    const columns: ReasonColumns = reasonColumns(reason);
    this.db
      .prepare(
        `UPDATE obligations SET state = 'escalated', ${SET_REASON}, duplicate_of = ?
          WHERE invoice_id = ?`,
      )
      .run(columns.text, columns.code, columns.clauses, columns.slots, JSON.stringify(duplicateOf), invoiceId);
  }

  // The invoices a held invoice looks like a second bill for, as they are now.
  setDuplicateOf(invoiceId: string, duplicateOf: string[]): void {
    this.db
      .prepare("UPDATE obligations SET duplicate_of = ? WHERE invoice_id = ?")
      .run(JSON.stringify(duplicateOf), invoiceId);
  }

  // The latest exchange rate quote taken for an invoice paid from another
  // currency's wallet, as JSON, whether or not a request opened on it.
  saveQuote(invoiceId: string, quote: string): void {
    this.db
      .prepare("UPDATE obligations SET last_quote = ? WHERE invoice_id = ?")
      .run(quote, invoiceId);
  }

  lastQuote(invoiceId: string): string | undefined {
    const row: { last_quote: string | null } | undefined = this.db
      .prepare("SELECT last_quote FROM obligations WHERE invoice_id = ?")
      .get(invoiceId) as unknown as { last_quote: string | null } | undefined;
    return row?.last_quote ?? undefined;
  }

  // Sends an open invoice to a person with reason. One already with a person keeps
  // the reason it went there for, and a closed one is left as it is, so a close
  // another process made meanwhile stands. True when the invoice is with a person.
  escalateIfOpen(invoiceId: string, reason: Reason): boolean {
    const columns: ReasonColumns = reasonColumns(reason);
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE obligations
            SET escalation_reason = CASE state WHEN 'escalated' THEN escalation_reason ELSE ? END,
                escalation_code = CASE state WHEN 'escalated' THEN escalation_code ELSE ? END,
                escalation_clauses = CASE state WHEN 'escalated' THEN escalation_clauses ELSE ? END,
                escalation_slots = CASE state WHEN 'escalated' THEN escalation_slots ELSE ? END,
                state = 'escalated'
          WHERE invoice_id = ? AND state IN ('open', 'escalated')`,
      )
      .run(columns.text, columns.code, columns.clauses, columns.slots, invoiceId);
    return Number(result.changes) === 1;
  }

  // Sends an invoice to a person unless it is settled, so a close another process
  // made meanwhile stands.
  escalateUnlessSettled(invoiceId: string, reason: Reason): void {
    const columns: ReasonColumns = reasonColumns(reason);
    this.db
      .prepare(
        `UPDATE obligations SET state = 'escalated', ${SET_REASON}
          WHERE invoice_id = ? AND state <> 'settled'`,
      )
      .run(columns.text, columns.code, columns.clauses, columns.slots, invoiceId);
  }
}

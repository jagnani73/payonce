import type { ApprovalState } from "../approvals.js";
import type { AttemptKind, AttemptState } from "../attempts.js";
import type { Contact } from "../../domain/contacts.js";
import type { BankChangeState, BankChangeStore } from "../bank-changes.js";
import type { ContactReads } from "../contacts.js";
import { stringsOf, type Db } from "../db.js";
import type { DraftRow, DraftState } from "../drafts.js";
import type { InvoiceStore, Obligation, ObligationState, TransferMethod } from "../invoices.js";
import {
  toRailFailure,
  type OutageHold,
  type OutageHoldRow,
  type OutageState,
  type RailFailure,
  type RailFailureRow,
} from "../outages.js";
import { payoutPays, toOutsidePayout, type OutsidePayout, type OutsideRow, type PayoutState } from "../payouts.js";
import type { RunRowAction, RunRowState, RunState } from "../runs.js";

interface SupplierObligationRow {
  invoice_id: string;
  beneficiary_id: string;
  supplier: string;
  state: ObligationState;
  escalation_reason: string;
  supplier_domain: string;
  supplier_phone: string | null;
  duplicate_of: string | null;
  currency: string;
  transfer_method: TransferMethod;
}

function toSupplierObligation(row: SupplierObligationRow): SupplierObligation {
  return {
    invoiceId: row.invoice_id,
    beneficiaryId: row.beneficiary_id,
    supplier: row.supplier,
    state: row.state,
    escalationReason: row.escalation_reason,
    supplierDomain: row.supplier_domain,
    supplierPhone: row.supplier_phone,
    duplicateOf: row.duplicate_of === null ? [] : stringsOf(row.duplicate_of),
    currency: row.currency,
    transferMethod: row.transfer_method,
  };
}

// A supplier read with every accountKey given as the routeKey of the same
// details where the ledger knows it (accountRoutes), so the view groups accounts
// by where the money goes and a bank name Airwallex rewrote makes no new one. A
// key the ledger knows no routeKey for stays as it is.
function routedRead<
  T extends {
    attempts: SupplierAttempt[];
    payouts: SupplierPayout[];
    approvals: SupplierApproval[];
    runRows: SupplierRunRow[];
  },
>(read: T, routes: Map<string, string>): T {
  const route = (key: string | null): string | null => (key === null ? null : (routes.get(key) ?? key));
  return {
    ...read,
    attempts: read.attempts.map((attempt: T["attempts"][number]) => ({
      ...attempt,
      accountKey: route(attempt.accountKey),
      sentKey: route(attempt.sentKey),
    })),
    payouts: read.payouts.map((payout: T["payouts"][number]) => ({ ...payout, sentKey: route(payout.sentKey) })),
    approvals: read.approvals.map((approval: SupplierApproval) => ({ ...approval, accountKey: route(approval.accountKey) })),
    runRows: read.runRows.map((row: SupplierRunRow) => ({ ...row, accountKey: route(row.accountKey) })),
  };
}

// What the list and a detail read of every attempt.
const SUPPLIER_ATTEMPT_COLUMNS: string = `attempts.invoice_id, obligations.beneficiary_id, attempts.transfer_id,
  attempts.state, attempts.failure_code, attempts.account_key, attempts.sent_key, attempts.sent_ending,
  attempts.misdirected, attempts.bank_created_at, attempts.opened_at, attempts.bank_status,
  attempts.found_late_at, attempts.mismatched_transfer_id, attempts.mismatched_status,
  CASE WHEN json_valid(attempts.arrival) THEN json_extract(attempts.arrival, '$.country') END AS country`;

interface SupplierAttemptRow {
  invoice_id: string;
  beneficiary_id: string;
  transfer_id: string | null;
  state: AttemptState;
  failure_code: string | null;
  account_key: string | null;
  sent_key: string | null;
  sent_ending: string | null;
  misdirected: number;
  bank_created_at: string | null;
  opened_at: string | null;
  bank_status: string | null;
  found_late_at: string | null;
  mismatched_transfer_id: string | null;
  mismatched_status: string | null;
  country: unknown;
}

function toSupplierAttempt(row: SupplierAttemptRow): SupplierAttempt {
  return {
    invoiceId: row.invoice_id,
    beneficiaryId: row.beneficiary_id,
    transferId: row.transfer_id,
    state: row.state,
    failureCode: row.failure_code,
    accountKey: row.account_key ?? null,
    sentKey: row.sent_key ?? null,
    sentEnding: row.sent_ending ?? null,
    misdirected: row.misdirected === 1,
    bankCreatedAt: row.bank_created_at ?? null,
    openedAt: row.opened_at ?? null,
    bankStatus: row.bank_status ?? null,
    foundLateAt: row.found_late_at ?? null,
    mismatchedTransferId: row.mismatched_transfer_id ?? null,
    mismatchedStatus: row.mismatched_status ?? null,
    country: typeof row.country === "string" && /^[A-Z]{2}$/.test(row.country) ? row.country : null,
  };
}

interface SupplierPaymentRow extends SupplierAttemptRow {
  kind: AttemptKind;
  reference: string | null;
  amount_minor: number | null;
  currency: string | null;
  fee_minor: number | null;
  fee_currency: string | null;
  rate_mismatch: number;
  mismatched_reference: string | null;
  arrival: string | null;
}

// What the list and a detail read of every payout sent outside PayOnce.
const SUPPLIER_PAYOUT_COLUMNS: string = `outside_payouts.invoice_id, obligations.beneficiary_id,
  outside_payouts.state, outside_payouts.found_at, outside_payouts.sent_key, outside_payouts.sent_ending`;

interface SupplierPayoutRow {
  invoice_id: string;
  beneficiary_id: string;
  state: PayoutState;
  found_at: string;
  sent_key: string | null;
  sent_ending: string | null;
}

function toSupplierPayout(row: SupplierPayoutRow): SupplierPayout {
  return {
    invoiceId: row.invoice_id,
    beneficiaryId: row.beneficiary_id,
    state: row.state,
    foundAt: row.found_at,
    sentKey: row.sent_key ?? null,
    sentEnding: row.sent_ending ?? null,
  };
}

interface SupplierApprovalRow {
  id: number;
  invoice_id: string;
  beneficiary_id: string;
  state: ApprovalState;
  requested_at: string | null;
  account_key: unknown;
}

interface SupplierCallbackRow {
  id: number;
  invoice_id: string;
  beneficiary_id: string;
  called_by: string;
  number_called: string;
  called_at: string;
  state: BankChangeState;
  applied_key: string | null;
  old_details: string;
  recorded_at: string;
  contact_id: number | null;
}

type SupplierDraftRow = Omit<DraftRow, "facts" | "subject" | "body" | "text_hash" | "dismiss_note">;

interface SupplierHoldRow extends OutageHoldRow {
  currency: string;
  method: string;
  outage_state: OutageState;
  ended_at: string | null;
}

interface SupplierRunRowRecord {
  id: number;
  run_id: number;
  run_state: RunState;
  checked_at: string;
  line: number;
  invoice_id: string | null;
  beneficiary_id: string | null;
  supplier: string | null;
  payee: string | null;
  currency: string | null;
  amount_minor: number | null;
  action: RunRowAction;
  state: RunRowState;
  new_payee: number;
  bank_change_id: number | null;
  account_key: string | null;
  skip_reasons: number | null;
}

// An invoice as the supplier list reads it: only what its cautions, counts and
// names use. A detail reads its record's invoices in full.
export type SupplierObligation = Pick<
  Obligation,
  | "invoiceId"
  | "beneficiaryId"
  | "supplier"
  | "state"
  | "escalationReason"
  | "supplierDomain"
  | "supplierPhone"
  | "duplicateOf"
  | "currency"
  | "transferMethod"
>;

// An attempt as the supplier view's accounts and cautions read it: with its
// invoice's beneficiary record, whether its transfer went to other details than
// it was meant for, where the transfer went as last read, and what liveAtBank
// tests.
export interface SupplierAttempt {
  invoiceId: string;
  beneficiaryId: string;
  transferId: string | null;
  state: AttemptState;
  failureCode: string | null;
  accountKey: string | null;
  sentKey: string | null;
  sentEnding: string | null;
  misdirected: boolean;
  bankCreatedAt: string | null;
  openedAt: string | null;
  bankStatus: string | null;
  foundLateAt: string | null;
  mismatchedTransferId: string | null;
  mismatchedStatus: string | null;
  // The bank's country of the details it was sent to, from its route advisory,
  // as Airwallex gave it. Null when none was kept.
  country: string | null;
}

// An attempt as a record's detail shows it. rateMismatch says only whether the
// rate did not match, and arrival is the route advisory's JSON as kept, read only
// for the payment that paid a listed invoice.
export interface SupplierPayment extends SupplierAttempt {
  kind: AttemptKind;
  reference: string | null;
  amountMinor: number | null;
  currency: string | null;
  feeMinor: number | null;
  feeCurrency: string | null;
  rateMismatch: boolean;
  mismatchedReference: string | null;
  arrival: string | null;
}

export interface SupplierPayout {
  invoiceId: string;
  beneficiaryId: string;
  state: PayoutState;
  foundAt: string;
  sentKey: string | null;
  sentEnding: string | null;
}

// A payout as a record's detail shows it.
export interface SupplierPayoutView extends SupplierPayout {
  transferId: string;
  reference: string;
  amountMinor: number | null;
  currency: string | null;
  feeMinor: number | null;
  feeCurrency: string | null;
  // True when it is paid and the last look found that it pays its invoice
  // (payoutPays). Only then is it what paid the invoice.
  pays: boolean;
}

// An approval request with the account its terms name, never the terms.
export interface SupplierApproval {
  id: number;
  invoiceId: string;
  beneficiaryId: string;
  state: ApprovalState;
  requestedAt: string | null;
  accountKey: string | null;
}

// A callback without what the person typed about it: nobody spoken to, nothing
// confirmed and no new details. oldDetails is read only for its account key and
// ending.
export interface SupplierCallback {
  id: number;
  invoiceId: string;
  beneficiaryId: string;
  calledBy: string;
  numberCalled: string;
  calledAt: string;
  state: BankChangeState;
  appliedKey: string | null;
  oldDetails: string;
  recordedAt: string;
  // Made on the phone number on file now, as verifiedBankChange asks before a
  // callback verifies an account. True on a file that keeps no numbers apart.
  onFilePhone: boolean;
}

// An email's addresses and whether it was read in full, for the sender check.
export interface SupplierEmailFacts {
  invoiceId: string;
  from: string;
  replyTo: string[];
  partial: boolean;
}

export interface SupplierFindings {
  invoiceId: string;
  findings: string;
}

// A draft without its subject, body, facts or dismiss note.
export interface SupplierDraft {
  id: number;
  invoiceId: string;
  template: string;
  audience: string;
  state: DraftState;
  createdBy: string;
  createdAt: string;
  copiedBy: string | null;
  copiedAt: string | null;
  sentBy: string | null;
  sentAt: string | null;
  dismissedBy: string | null;
  dismissedAt: string | null;
}

export interface SupplierHold extends OutageHold {
  currency: string;
  method: string;
  outageState: OutageState;
  endedAt: string | null;
}

export interface SupplierFailure extends RailFailure {
  beneficiaryId: string;
}

// A run row without its cells, reasons or pay-to line: only how many reasons it
// was skipped for.
export interface SupplierRunRow {
  id: number;
  runId: number;
  runState: RunState;
  checkedAt: string;
  line: number;
  invoiceId: string | null;
  beneficiaryId: string;
  supplier: string | null;
  currency: string | null;
  amountMinor: number | null;
  action: RunRowAction;
  state: RunRowState;
  newPayee: boolean;
  bankChangeId: number | null;
  accountKey: string | null;
  skipReasons: number;
}

interface SupplierShared {
  approvals: SupplierApproval[];
  callbacks: SupplierCallback[];
  // Every version of the phone on file, oldest first.
  contacts: Contact[];
  emails: SupplierEmailFacts[];
  findings: SupplierFindings[];
  failures: SupplierFailure[];
  // Newest run first, in file order within a run.
  runRows: SupplierRunRow[];
}

export interface SupplierListRead extends SupplierShared {
  // Newest first.
  obligations: SupplierObligation[];
  attempts: SupplierAttempt[];
  payouts: SupplierPayout[];
  // Empty: only a detail reads them.
  drafts: SupplierDraft[];
  holds: SupplierHold[];
}

export interface SupplierRead extends SupplierListRead {
  obligations: Obligation[];
  attempts: SupplierPayment[];
  payouts: SupplierPayoutView[];
}

export interface SupplierLinks {
  names: { beneficiaryId: string; name: string; newest: number }[];
  keys: { beneficiaryId: string; key: string }[];
  callbacks: { beneficiaryId: string; appliedKey: string | null; oldDetails: string }[];
  payees: { beneficiaryId: string; payee: string }[];
}

// What the supplier view reads, one query per table, inside readSnapshot.
export class SupplierReads {
  private readonly db: Db;
  private readonly invoices: InvoiceStore;
  private readonly bankChanges: BankChangeStore;
  private readonly contacts: ContactReads;

  constructor(db: Db, invoices: InvoiceStore, bankChanges: BankChangeStore, contacts: ContactReads) {
    this.db = db;
    this.invoices = invoices;
    this.bankChanges = bankChanges;
    this.contacts = contacts;
  }

  // What the supplier list reads for every record: only the columns its cautions
  // and counts use from invoices, attempts and payouts, and no drafts or outage
  // holds, which only a record's detail shows. Never an email's subject or body,
  // a callback's notes or typed details, or a timeline line. Each query runs once,
  // and it only reads, so it runs inside readSnapshot.
  supplierListRead(): SupplierListRead {
    const obligations: SupplierObligation[] = (
      this.db
        .prepare(
          `SELECT invoice_id, beneficiary_id, supplier, state, escalation_reason, supplier_domain,
                  ${this.contacts.phoneColumn()} AS supplier_phone, duplicate_of, currency, transfer_method
             FROM obligations ORDER BY rowid DESC`,
        )
        .all() as unknown as SupplierObligationRow[]
    ).map(toSupplierObligation);
    const attempts: SupplierAttempt[] = (
      this.db
        .prepare(
          `SELECT ${SUPPLIER_ATTEMPT_COLUMNS} FROM attempts
             JOIN obligations ON obligations.invoice_id = attempts.invoice_id ORDER BY attempts.rowid`,
        )
        .all() as unknown as SupplierAttemptRow[]
    ).map(toSupplierAttempt);
    const payouts: SupplierPayout[] = (
      this.db
        .prepare(
          `SELECT ${SUPPLIER_PAYOUT_COLUMNS} FROM outside_payouts
             JOIN obligations ON obligations.invoice_id = outside_payouts.invoice_id
            ORDER BY outside_payouts.rowid`,
        )
        .all() as unknown as SupplierPayoutRow[]
    ).map(toSupplierPayout);
    return routedRead({ obligations, attempts, payouts, ...this.supplierShared(null), drafts: [], holds: [] }, this.bankChanges.accountRoutes());
  }

  // What a record's detail reads of that one beneficiary record: what the list
  // reads, with the invoices in full and what the page shows of each payment, its
  // drafts by template and state, and its outage holds. Never a draft's text or
  // facts, nor anything supplierListRead leaves out.
  supplierRead(beneficiaryId: string): SupplierRead {
    const obligations: Obligation[] = this.invoices.obligationsFor(beneficiaryId);
    const attempts: SupplierPayment[] = (
      this.db
        .prepare(
          `SELECT ${SUPPLIER_ATTEMPT_COLUMNS}, attempts.kind, attempts.reference, attempts.amount_minor,
                  attempts.currency, attempts.fee_minor, attempts.fee_currency,
                  attempts.rate_mismatch IS NOT NULL AS rate_mismatch, attempts.mismatched_reference,
                  attempts.arrival
             FROM attempts JOIN obligations ON obligations.invoice_id = attempts.invoice_id
            WHERE obligations.beneficiary_id = ? ORDER BY attempts.rowid`,
        )
        .all(beneficiaryId) as unknown as SupplierPaymentRow[]
    ).map(
      (row: SupplierPaymentRow): SupplierPayment => ({
        ...toSupplierAttempt(row),
        kind: row.kind,
        reference: row.reference,
        amountMinor: row.amount_minor,
        currency: row.currency,
        feeMinor: row.fee_minor,
        feeCurrency: row.fee_currency,
        rateMismatch: row.rate_mismatch === 1,
        mismatchedReference: row.mismatched_reference ?? null,
        arrival: row.arrival ?? null,
      }),
    );
    const payouts: SupplierPayoutView[] = (
      this.db
        .prepare(
          `SELECT ${SUPPLIER_PAYOUT_COLUMNS}, outside_payouts.transfer_id, outside_payouts.reference,
                  outside_payouts.amount_minor, outside_payouts.currency, outside_payouts.fee_minor,
                  outside_payouts.fee_currency, outside_payouts.pays
             FROM outside_payouts JOIN obligations ON obligations.invoice_id = outside_payouts.invoice_id
            WHERE obligations.beneficiary_id = ? ORDER BY outside_payouts.rowid`,
        )
        .all(beneficiaryId) as unknown as (SupplierPayoutRow & OutsideRow)[]
    ).map((row: SupplierPayoutRow & OutsideRow): SupplierPayoutView => {
      const payout: OutsidePayout = toOutsidePayout(row);
      return { ...payout, ...toSupplierPayout(row), pays: payoutPays(payout) };
    });
    const drafts: SupplierDraft[] = (
      this.db
        .prepare(
          `SELECT outbox.id, outbox.invoice_id, outbox.template, outbox.audience, outbox.state,
                  outbox.created_by, outbox.created_at, outbox.copied_by, outbox.copied_at,
                  outbox.sent_by, outbox.sent_at, outbox.dismissed_by, outbox.dismissed_at
             FROM outbox JOIN obligations ON obligations.invoice_id = outbox.invoice_id
            WHERE obligations.beneficiary_id = ? ORDER BY outbox.id`,
        )
        .all(beneficiaryId) as unknown as SupplierDraftRow[]
    ).map(
      (row: SupplierDraftRow): SupplierDraft => ({
        id: row.id,
        invoiceId: row.invoice_id,
        template: row.template,
        audience: row.audience,
        state: row.state,
        createdBy: row.created_by,
        createdAt: row.created_at,
        copiedBy: row.copied_by,
        copiedAt: row.copied_at,
        sentBy: row.sent_by,
        sentAt: row.sent_at,
        dismissedBy: row.dismissed_by,
        dismissedAt: row.dismissed_at,
      }),
    );
    const holds: SupplierHold[] = (
      this.db
        .prepare(
          `SELECT outage_holds.*, outages.currency, outages.method, outages.state AS outage_state, outages.ended_at
             FROM outage_holds JOIN outages ON outages.id = outage_holds.outage_id
            WHERE outage_holds.invoice_id IN (SELECT invoice_id FROM obligations WHERE beneficiary_id = ?)
               OR outage_holds.run_id IN (SELECT run_id FROM run_rows WHERE beneficiary_id = ?)
            ORDER BY outage_holds.rowid`,
        )
        .all(beneficiaryId, beneficiaryId) as unknown as SupplierHoldRow[]
    ).map(
      (row: SupplierHoldRow): SupplierHold => ({
        outageId: row.outage_id,
        invoiceId: row.invoice_id,
        runId: row.run_id,
        what: row.what,
        heldAt: row.held_at,
        currency: row.currency,
        method: row.method,
        outageState: row.outage_state,
        endedAt: row.ended_at,
      }),
    );
    return routedRead(
      { obligations, attempts, payouts, ...this.supplierShared(beneficiaryId), drafts, holds },
      this.bankChanges.accountRoutes(),
    );
  }

  // What the list and a detail both read: approvals with only the account their
  // terms name, callbacks, emails' addresses, findings, rail failures and pay run
  // rows, for one record, or for every record when beneficiaryId is null.
  private supplierShared(beneficiaryId: string | null): SupplierShared {
    const one: boolean = beneficiaryId !== null;
    const args: string[] = beneficiaryId === null ? [] : [beneficiaryId];
    const where = (column: string): string => (one ? `WHERE ${column} = ?` : "");
    const all = <T>(sql: string): T[] => this.db.prepare(sql).all(...args) as unknown as T[];
    const approvals: SupplierApproval[] = all<SupplierApprovalRow>(
      `SELECT approvals.id, approvals.invoice_id, obligations.beneficiary_id, approvals.state,
              approvals.requested_at,
              CASE WHEN json_valid(approvals.terms) THEN json_extract(approvals.terms, '$.accountKey') END AS account_key
         FROM approvals JOIN obligations ON obligations.invoice_id = approvals.invoice_id
         ${where("obligations.beneficiary_id")} ORDER BY approvals.id`,
    ).map(
      (row: SupplierApprovalRow): SupplierApproval => ({
        id: row.id,
        invoiceId: row.invoice_id,
        beneficiaryId: row.beneficiary_id,
        state: row.state,
        requestedAt: row.requested_at,
        accountKey: typeof row.account_key === "string" ? row.account_key : null,
      }),
    );
    const kept: boolean = this.contacts.kept();
    const callbacks: SupplierCallback[] = all<SupplierCallbackRow>(
      `SELECT id, invoice_id, beneficiary_id, called_by, number_called, called_at, state,
              applied_key, old_details, recorded_at, contact_id
         FROM bank_changes ${where("beneficiary_id")} ORDER BY id`,
    ).map(
      (row: SupplierCallbackRow): SupplierCallback => ({
        id: row.id,
        invoiceId: row.invoice_id,
        beneficiaryId: row.beneficiary_id,
        calledBy: row.called_by,
        numberCalled: row.number_called,
        calledAt: row.called_at,
        state: row.state,
        appliedKey: row.applied_key,
        oldDetails: row.old_details,
        recordedAt: row.recorded_at,
        onFilePhone:
          !kept || (row.contact_id !== null && row.contact_id === (this.contacts.onFile(row.beneficiary_id, "phone")?.id ?? null)),
      }),
    );
    const emails: SupplierEmailFacts[] = all<{ invoice_id: string; sender: string; reply_to: string; partial: number }>(
      `SELECT emails.invoice_id, emails.sender, emails.reply_to, emails.partial FROM emails
         JOIN obligations ON obligations.invoice_id = emails.invoice_id
         ${where("obligations.beneficiary_id")} ORDER BY emails.id`,
    ).map(
      (row: { invoice_id: string; sender: string; reply_to: string; partial: number }): SupplierEmailFacts => ({
        invoiceId: row.invoice_id,
        from: row.sender,
        replyTo: stringsOf(row.reply_to),
        partial: row.partial === 1,
      }),
    );
    const findings: SupplierFindings[] = all<{ invoice_id: string; findings: string }>(
      `SELECT email_findings.invoice_id, email_findings.findings FROM email_findings
         JOIN obligations ON obligations.invoice_id = email_findings.invoice_id
         ${where("obligations.beneficiary_id")}`,
    ).map(
      (row: { invoice_id: string; findings: string }): SupplierFindings => ({
        invoiceId: row.invoice_id,
        findings: row.findings,
      }),
    );
    const failures: SupplierFailure[] = all<RailFailureRow & { beneficiary_id: string }>(
      `SELECT rail_failures.*, obligations.beneficiary_id FROM rail_failures
         JOIN obligations ON obligations.invoice_id = rail_failures.invoice_id
         ${where("obligations.beneficiary_id")} ORDER BY rail_failures.rowid`,
    ).map(
      (row: RailFailureRow & { beneficiary_id: string }): SupplierFailure => ({
        ...toRailFailure(row),
        beneficiaryId: row.beneficiary_id,
      }),
    );
    const runRows: SupplierRunRow[] = all<SupplierRunRowRecord>(
      `SELECT run_rows.id, run_rows.run_id, runs.state AS run_state, runs.checked_at, run_rows.line,
              run_rows.invoice_id, run_rows.beneficiary_id, run_rows.supplier, run_rows.payee,
              run_rows.currency, run_rows.amount_minor, run_rows.action, run_rows.state,
              run_rows.new_payee, run_rows.bank_change_id, run_rows.account_key,
              CASE WHEN json_valid(run_rows.reasons) THEN json_array_length(run_rows.reasons) END AS skip_reasons
         FROM run_rows JOIN runs ON runs.id = run_rows.run_id
         ${one ? "WHERE run_rows.beneficiary_id = ?" : "WHERE run_rows.beneficiary_id IS NOT NULL"}
         ORDER BY run_rows.run_id DESC, run_rows.line`,
    ).map(
      (row: SupplierRunRowRecord): SupplierRunRow => ({
        id: row.id,
        runId: row.run_id,
        runState: row.run_state,
        checkedAt: row.checked_at,
        line: row.line,
        invoiceId: row.invoice_id,
        beneficiaryId: row.beneficiary_id ?? "",
        supplier: row.payee ?? row.supplier,
        currency: row.currency,
        amountMinor: row.amount_minor,
        action: row.action,
        state: row.state,
        newPayee: row.new_payee === 1,
        bankChangeId: row.bank_change_id,
        accountKey: row.account_key,
        skipReasons: row.skip_reasons ?? 0,
      }),
    );
    return { approvals, callbacks, contacts: this.contacts.of(beneficiaryId), emails, findings, failures, runRows };
  }

  // When the bank paid one of PayOnce's transfers, by the paid_at trigger, and
  // the last four characters of the details Airwallex said it went to. Each is
  // null when not kept.
  paidTransfer(transferId: string): { paidAt: string | null; ending: string | null } | undefined {
    const row: { paid_at: string | null; sent_ending: string | null } | undefined = this.db
      .prepare("SELECT paid_at, sent_ending FROM attempts WHERE transfer_id = ? AND state = 'paid' LIMIT 1")
      .get(transferId) as unknown as { paid_at: string | null; sent_ending: string | null } | undefined;
    return row === undefined ? undefined : { paidAt: row.paid_at || null, ending: row.sent_ending ?? null };
  }

  // Whether an invoice, or a pay row of the waiting run, names this beneficiary
  // record, which is when the supplier view has a record for it.
  supplierNamed(beneficiaryId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM obligations WHERE beneficiary_id = ?
            UNION ALL
           SELECT 1 FROM run_rows JOIN runs ON runs.id = run_rows.run_id
            WHERE runs.state = 'waiting' AND run_rows.action = 'pay' AND run_rows.state = 'waiting'
              AND run_rows.beneficiary_id = ?
            LIMIT 1`,
        )
        .get(beneficiaryId, beneficiaryId) !== undefined
    );
  }

  // Every name and account the ledger keeps for each beneficiary record, for one
  // record's links to records that share a name or an account. The pay rows of
  // the waiting run count, since no invoice holds them yet. The accounts asked to
  // approve leave out except's own approvals, which its detail has read already,
  // so no terms JSON is parsed twice. The list builds the same from its own read.
  // Terms are read only inside CASE WHEN json_valid(...), as metricsRead reads
  // them, because SQLite promises no order for the two sides of an AND and a JSON
  // function throws on text that is not JSON.
  supplierLinks(except: string): SupplierLinks {
    const all = <T>(sql: string, ...params: string[]): T[] => this.db.prepare(sql).all(...params) as unknown as T[];
    // newest is the newest invoice with the name, and 0 for a waiting run's row.
    const names: { beneficiaryId: string; name: string; newest: number }[] = all<{
      beneficiary_id: string;
      name: string;
      newest: number;
    }>(
      `SELECT beneficiary_id, supplier AS name, max(rowid) AS newest FROM obligations
        GROUP BY beneficiary_id, supplier
        UNION
       SELECT run_rows.beneficiary_id, COALESCE(run_rows.payee, run_rows.supplier), 0 FROM run_rows
         JOIN runs ON runs.id = run_rows.run_id
        WHERE runs.state = 'waiting' AND run_rows.action = 'pay' AND run_rows.state = 'waiting'
          AND run_rows.beneficiary_id IS NOT NULL AND COALESCE(run_rows.payee, run_rows.supplier) IS NOT NULL`,
    ).map((row: { beneficiary_id: string; name: string; newest: number }) => ({
      beneficiaryId: row.beneficiary_id,
      name: row.name,
      newest: row.newest,
    }));
    const keys: { beneficiaryId: string; key: string }[] = all<{ beneficiary_id: string; key: string }>(
      `SELECT obligations.beneficiary_id, attempts.account_key AS key FROM attempts
         JOIN obligations ON obligations.invoice_id = attempts.invoice_id WHERE attempts.account_key IS NOT NULL
        UNION
       SELECT obligations.beneficiary_id, attempts.sent_key FROM attempts
         JOIN obligations ON obligations.invoice_id = attempts.invoice_id WHERE attempts.sent_key IS NOT NULL
        UNION
       SELECT obligations.beneficiary_id, outside_payouts.sent_key FROM outside_payouts
         JOIN obligations ON obligations.invoice_id = outside_payouts.invoice_id
        WHERE outside_payouts.sent_key IS NOT NULL
        UNION
       SELECT obligations.beneficiary_id, json_extract(approvals.terms, '$.accountKey') FROM approvals
         JOIN obligations ON obligations.invoice_id = approvals.invoice_id
        WHERE obligations.beneficiary_id <> ?
          AND CASE WHEN json_valid(approvals.terms) THEN json_type(approvals.terms, '$.accountKey') = 'text' ELSE 0 END
        UNION
       SELECT beneficiary_id, account_key FROM run_rows
        WHERE action = 'pay' AND account_key IS NOT NULL AND beneficiary_id IS NOT NULL`,
      except,
    ).map((row: { beneficiary_id: string; key: string }) => ({ beneficiaryId: row.beneficiary_id, key: row.key }));
    // By where the money goes, as the record's own read gives its keys.
    const routes: Map<string, string> = this.bankChanges.accountRoutes();
    for (const entry of keys) {
      entry.key = routes.get(entry.key) ?? entry.key;
    }
    const callbacks: { beneficiaryId: string; appliedKey: string | null; oldDetails: string }[] = all<{
      beneficiary_id: string;
      applied_key: string | null;
      old_details: string;
    }>("SELECT beneficiary_id, applied_key, old_details FROM bank_changes").map(
      (row: { beneficiary_id: string; applied_key: string | null; old_details: string }) => ({
        beneficiaryId: row.beneficiary_id,
        appliedKey: row.applied_key,
        oldDetails: row.old_details,
      }),
    );
    const payees: { beneficiaryId: string; payee: string }[] = all<{ beneficiary_id: string; payee: string }>(
      `SELECT DISTINCT obligations.beneficiary_id, rail_failures.payee FROM rail_failures
         JOIN obligations ON obligations.invoice_id = rail_failures.invoice_id`,
    ).map((row: { beneficiary_id: string; payee: string }) => ({ beneficiaryId: row.beneficiary_id, payee: row.payee }));
    return { names, keys, callbacks, payees };
  }
}

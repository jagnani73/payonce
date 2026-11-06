import { knownRoute } from "../domain/assess.js";
import { reasonColumns, type Reason, type ReasonColumns } from "../domain/reasons.js";
import { DuplicatePaymentError, type AttemptState, type AttemptStore } from "./attempts.js";
import { isUniqueViolation, type Db } from "./db.js";
import {
  SET_REASON,
  sourceColumn,
  type InvoiceRow,
  type InvoiceStore,
  type NewObligation,
  type Obligation,
} from "./invoices.js";
import type { Timelines } from "./timeline.js";

// A payout for the invoice bound as the parameter, sent outside PayOnce, that is
// in flight, paid or in a status PayOnce does not know.
export const LIVE_OUTSIDE_PAYOUT: string = `SELECT 1 FROM outside_payouts WHERE invoice_id = ?
  AND state <> 'failed'`;

// A payout sent outside PayOnce that keeps an invoice from being closed without
// paying: one in flight or in a status PayOnce does not know, or one paid that
// pays the invoice (payoutPays: a look found it pays). A paid one that only
// names the invoice, or that no look could check, does not.
export const BLOCKING_OUTSIDE_PAYOUT: string = `SELECT 1 FROM outside_payouts
  WHERE invoice_id = ? AND state <> 'failed' AND (state <> 'paid' OR pays = 1)`;

// What the bank last did with a payout sent outside PayOnce. unknown is a status
// PayOnce does not recognise.
export type PayoutState = "in_flight" | "paid" | "failed" | "unknown";

// A payout's amount and fee as last read from the transfer. The amount and
// currency are what it took from the wallet, before the fee: the source amount
// when it was paid from another currency. Null when it has not been read since
// PayOnce started keeping them.
export interface PayoutMoney {
  amountMinor: number | null;
  currency: string | null;
  feeMinor: number | null;
  feeCurrency: string | null;
  // The accountKey and routeKey of the bank details the transfer went to and
  // their last four characters. Only the routeKey decides anything: whether a
  // paid payout pays its invoice (payoutVerdict).
  sentKey?: string | null;
  sentRoute?: string | null;
  sentEnding?: string | null;
  // The beneficiary record the transfer was sent to, as Airwallex gave it.
  beneficiaryId?: string | null;
  // What it delivered: transfer_amount and transfer_currency, which differ from
  // the debit for a payout paid from another wallet. Whether a payout pays its
  // invoice goes by these.
  deliveredMinor?: number | null;
  deliveredCurrency?: string | null;
}

// A payout sent outside PayOnce whose reference names an invoice in the ledger.
export interface OutsidePayout extends PayoutMoney {
  transferId: string;
  // The bank's short reference.
  reference: string;
  state: PayoutState;
  // Whether it pays its invoice, as the last look found (payoutVerdict): false
  // when it does not or PayOnce could not tell, null until a look has judged it.
  // checked is false until this code has read the payout from Airwallex.
  pays?: boolean | null;
  checked?: boolean;
}

// A payout someone sent outside PayOnce, taken on as an invoice's original.
export interface FoundPayout {
  requestId: string;
  transferId: string;
  reference: string;
  state: AttemptState;
  failureCode: string | null;
  feeMinor: number | null;
  feeCurrency: string | null;
  amountMinor: number | null;
  currency: string | null;
  sentKey: string | null;
  sentRoute: string | null;
  sentEnding: string | null;
  // The transfer's created_at as Airwallex wrote it, as record keeps it, so the
  // original has it from take-on, before any look reads the transfer.
  bankCreatedAt: string | null;
}

export interface OutsideRow {
  transfer_id: string;
  reference: string;
  state: PayoutState;
  amount_minor: number | null;
  currency: string | null;
  fee_minor: number | null;
  fee_currency: string | null;
  sent_route?: string | null;
  sent_ending?: string | null;
  beneficiary_id?: string | null;
  delivered_minor?: number | null;
  delivered_currency?: string | null;
  checked_at?: string | null;
  pays?: number | null;
}

export function toOutsidePayout(row: OutsideRow): OutsidePayout {
  return {
    transferId: row.transfer_id,
    reference: row.reference,
    state: row.state,
    amountMinor: row.amount_minor,
    currency: row.currency,
    feeMinor: row.fee_minor,
    feeCurrency: row.fee_currency,
    sentRoute: row.sent_route ?? null,
    sentEnding: row.sent_ending ?? null,
    beneficiaryId: row.beneficiary_id ?? null,
    deliveredMinor: row.delivered_minor ?? null,
    deliveredCurrency: row.delivered_currency ?? null,
    checked: row.checked_at !== null && row.checked_at !== undefined,
    pays: row.pays === null || row.pays === undefined ? null : row.pays === 1,
  };
}

// Whether a paid payout sent outside PayOnce, tied to this invoice, pays it: it
// delivered the invoice's amount in the invoice's currency (transfer_amount and
// transfer_currency, so one paid from another wallet is judged by what it
// delivered), and went to the account PayOnce would pay the invoice's
// beneficiary now without a person (route, from payingRoute in the engine). The
// beneficiary id does not count, because one record can hold other details.
// Null when PayOnce cannot tell: what it delivered or where it went was not
// read, or was read under another route scheme. A look works it out and keeps
// it (Ledger.setPayoutVerdict).
export function payoutVerdict(
  obligation: Pick<Obligation, "amountMinor" | "currency">,
  payout: OutsidePayout,
  route: string | null,
): boolean | null {
  if (
    payout.deliveredMinor === null ||
    payout.deliveredMinor === undefined ||
    payout.deliveredCurrency === null ||
    payout.deliveredCurrency === undefined
  ) {
    return null;
  }
  if (payout.deliveredMinor !== obligation.amountMinor || payout.deliveredCurrency !== obligation.currency) {
    return false;
  }
  const sent: string | null = knownRoute(payout.sentRoute);
  return sent === null ? null : route !== null && sent === route;
}

// True when a payout sent outside PayOnce is paid and pays its invoice, as the
// last look found (payoutVerdict). Only such a payout counts as paying the
// invoice: paidOutside, a person's close as paid outside, the close card's kind,
// the alert's close need and the board's group. One that only names the
// invoice, or that no look could check, still holds PayOnce's own payments
// while it is not failed, and a person may close the invoice without paying.
// BLOCKING_OUTSIDE_PAYOUT is the same test in SQL.
export function payoutPays(payout: OutsidePayout): boolean {
  return payout.state === "paid" && payout.pays === true;
}

// Payouts sent outside PayOnce (outside_payouts), and a found payout taken on as a
// new invoice's original.
export class PayoutStore {
  private readonly db: Db;
  private readonly invoices: InvoiceStore;
  private readonly attempts: AttemptStore;
  private readonly timelines: Timelines;

  constructor(db: Db, invoices: InvoiceStore, attempts: AttemptStore, timelines: Timelines) {
    this.db = db;
    this.invoices = invoices;
    this.attempts = attempts;
    this.timelines = timelines;
  }

  // The invoices with a payout sent outside PayOnce in flight or in a status
  // PayOnce does not know: any state that is not final, as the watcher reads them
  // and an incident's watching counts them.
  invoicesWithPayoutInFlight(): Set<string> {
    const rows: { invoice_id: string }[] = this.db
      .prepare("SELECT DISTINCT invoice_id FROM outside_payouts WHERE state NOT IN ('paid', 'failed')")
      .all() as unknown as { invoice_id: string }[];
    return new Set(rows.map((row: { invoice_id: string }): string => row.invoice_id));
  }

  // Records a payout found in Airwallex as the original of a new invoice. Both
  // rows are written or neither is. The attempt takes the duplicate lock like
  // any other.
  // payoutReference is the payout's own reference when the invoice number had to
  // be something else, so a later payout with that reference is still tied to it.
  // line is the invoice's first timeline line, written in the same transaction,
  // so the invoice is never in the ledger without one.
  adoptPayout(
    input: NewObligation,
    payoutReference: string | null,
    found: FoundPayout,
    line: string,
  ): void {
    try {
      this.db.transaction((): void => {
        // A plain INSERT, so an invoice written by another process since the sweep
        // checked fails here instead of gaining a second original.
        this.db
          .prepare(
            `INSERT INTO obligations
               (invoice_id, supplier, supplier_domain, beneficiary_id, currency,
                amount_minor, transfer_method, invoice_floor_minor, origin,
                payout_reference, started_by, supplier_phone, source_currency, look_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outside', ?, ?, ?, ?, ?)`,
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
            payoutReference,
            input.startedBy,
            input.supplierPhone,
            sourceColumn(input),
            // Due at once, so a watcher looks at it even if the step that found it
            // stops before it wakes the invoice.
            new Date().toISOString(),
          );
        this.db
          .prepare(
            `INSERT INTO attempts
               (request_id, invoice_id, kind, transfer_id, reference, state, failure_code,
                fee_minor, fee_currency, amount_minor, currency, sent_key, sent_ending, sent_route,
                bank_created_at)
             VALUES (?, ?, 'original', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            found.requestId,
            input.invoiceId,
            found.transferId,
            found.reference,
            found.state,
            found.failureCode,
            found.feeMinor,
            found.feeCurrency,
            found.amountMinor,
            found.currency,
            found.sentKey,
            found.sentEnding,
            found.sentRoute,
            found.bankCreatedAt,
          );
        this.timelines.appendEvent(input.invoiceId, "bank", line, null);
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new DuplicatePaymentError(input.invoiceId);
      }
      throw error;
    }
  }

  // Ties a payout made outside PayOnce to the invoice its reference names. False
  // when it was tied already. What the tie decides is written in the same
  // transaction: a closed invoice is reopened with reopen when that is given, and
  // an open or escalated one gets a look due at once, so a step that stops after
  // the tie, as on a timeline line it could not write, leaves nothing undone.
  linkOutsidePayout(invoiceId: string, payout: OutsidePayout, reopen: Reason | null = null): boolean {
    const now: string = new Date().toISOString();
    return this.db.transaction((): boolean => {
      const result: { changes: number | bigint } = this.db
        .prepare(
          `INSERT OR IGNORE INTO outside_payouts
             (transfer_id, invoice_id, found_at, reference, state, amount_minor, currency,
              fee_minor, fee_currency, sent_key, sent_ending, sent_route, beneficiary_id,
              delivered_minor, delivered_currency, checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          payout.transferId,
          invoiceId,
          now,
          payout.reference,
          payout.state,
          payout.amountMinor,
          payout.currency,
          payout.feeMinor,
          payout.feeCurrency,
          payout.sentKey ?? null,
          payout.sentEnding ?? null,
          payout.sentRoute ?? null,
          payout.beneficiaryId ?? null,
          payout.deliveredMinor ?? null,
          payout.deliveredCurrency ?? null,
          now,
        );
      if (Number(result.changes) !== 1) {
        return false;
      }
      if (reopen !== null) {
        const columns: ReasonColumns = reasonColumns(reopen);
        this.db
          .prepare(
            `UPDATE obligations SET state = 'escalated', ${SET_REASON}
              WHERE invoice_id = ? AND state IN ('settled', 'rejected')`,
          )
          .run(columns.text, columns.code, columns.clauses, columns.slots, invoiceId);
      }
      this.invoices.lookNow(invoiceId);
      return true;
    });
  }

  outsidePayouts(invoiceId: string): OutsidePayout[] {
    return (
      this.db
        .prepare(
          `SELECT transfer_id, reference, state, amount_minor, currency, fee_minor, fee_currency,
                  sent_route, sent_ending, beneficiary_id, delivered_minor, delivered_currency,
                  checked_at, pays
             FROM outside_payouts WHERE invoice_id = ? ORDER BY rowid`,
        )
        .all(invoiceId) as unknown as OutsideRow[]
    ).map(toOutsidePayout);
  }

  // The paid payouts tied to this invoice that pay it (payoutPays), and the paid
  // ones that only name it or that no look could check, which count as not
  // paying it.
  payingPayouts(invoiceId: string): { pays: OutsidePayout[]; namesOnly: OutsidePayout[] } {
    const paid: OutsidePayout[] = this.outsidePayouts(invoiceId).filter(
      (payout: OutsidePayout): boolean => payout.state === "paid",
    );
    return {
      pays: paid.filter(payoutPays),
      namesOnly: paid.filter((payout: OutsidePayout): boolean => !payoutPays(payout)),
    };
  }

  // A value that could not be read keeps the one already on file.
  recordOutsidePayout(transferId: string, state: PayoutState, money: PayoutMoney): void {
    this.db
      .prepare(
        `UPDATE outside_payouts
            SET state = ?, amount_minor = COALESCE(?, amount_minor),
                currency = COALESCE(?, currency), fee_minor = COALESCE(?, fee_minor),
                fee_currency = COALESCE(?, fee_currency),
                sent_key = COALESCE(?, sent_key), sent_ending = COALESCE(?, sent_ending),
                sent_route = COALESCE(?, sent_route), beneficiary_id = COALESCE(?, beneficiary_id),
                delivered_minor = COALESCE(?, delivered_minor),
                delivered_currency = COALESCE(?, delivered_currency), checked_at = ?
          WHERE transfer_id = ?`,
      )
      .run(
        state,
        money.amountMinor,
        money.currency,
        money.feeMinor,
        money.feeCurrency,
        money.sentKey ?? null,
        money.sentEnding ?? null,
        money.sentRoute ?? null,
        money.beneficiaryId ?? null,
        money.deliveredMinor ?? null,
        money.deliveredCurrency ?? null,
        new Date().toISOString(),
        transferId,
      );
  }

  // Keeps whether a payout sent outside PayOnce pays its invoice, as a look just
  // worked it out (payoutVerdict), in one conditional statement, so the stored
  // verdict always ends as this one whatever another process wrote meanwhile.
  // Every test that lets a payout count as paying reads it from the row when it
  // decides (payoutPays, BLOCKING_OUTSIDE_PAYOUT).
  setPayoutVerdict(transferId: string, pays: boolean): void {
    const value: number = pays ? 1 : 0;
    this.db
      .prepare("UPDATE outside_payouts SET pays = ? WHERE transfer_id = ? AND pays IS NOT ?")
      .run(value, transferId, value);
  }

  // The invoice an outside payout is tied to, if any.
  outsideInvoiceOf(transferId: string): string | undefined {
    const row: InvoiceRow | undefined = this.db
      .prepare("SELECT invoice_id FROM outside_payouts WHERE transfer_id = ?")
      .get(transferId) as unknown as InvoiceRow | undefined;
    return row?.invoice_id;
  }

  // True when the transfer is one of PayOnce's attempts or a payout the sweep has
  // already tied to an invoice.
  knowsTransfer(requestId: string, transferId: string): boolean {
    return (
      this.attempts.attemptOf(requestId, transferId) !== undefined ||
      this.db
        .prepare("SELECT 1 FROM outside_payouts WHERE transfer_id = ?")
        .get(transferId) !== undefined
    );
  }
}

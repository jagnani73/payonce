import { storedReason, type StoredReason } from "../../domain/reasons.js";
import type { ApprovalState } from "../approvals.js";
import type { AttemptKind, LiveTested } from "../attempts.js";
import type { Db } from "../db.js";
import type { ObligationOrigin, ObligationState } from "../invoices.js";
import type { PayoutState } from "../payouts.js";

// What the metrics read of an invoice: never its supplier, phone, references or
// the invoices it was held for, only whether it was held as a likely second bill.
// startedAt is its first timeline line's time, and closedAt its latest closed
// line's, only while it is settled or rejected.
export interface MetricsObligation {
  invoiceId: string;
  currency: string;
  wallet: string;
  amountMinor: number;
  state: ObligationState;
  origin: ObligationOrigin;
  fromRun: boolean;
  transferMethod: string;
  escalationReason: string;
  // The reason as codes, read as Ledger.reasonOf reads them.
  reason: StoredReason | null;
  heldDuplicate: boolean;
  escalatedAt: string | null;
  startedAt: string | null;
  closedAt: string | null;
}

// What the metrics read of an attempt: what liveAtBank reads, and its times.
// amountMinor and currency are what its transfer took from the wallet as debitOf
// read it, the mismatched pair the same for a transfer kept beside it, and
// quoteAmountMinor the sell amount of the quote it was sent with, from the
// approval it was opened on, when that quote is the attempt's and sells from the
// invoice's wallet.
export interface MetricsAttempt extends LiveTested {
  invoiceId: string;
  kind: AttemptKind;
  failureCode: string | null;
  feeMinor: number | null;
  feeCurrency: string | null;
  amountMinor: number | null;
  currency: string | null;
  quoteAmountMinor: number | null;
  mismatchedAmountMinor: number | null;
  mismatchedCurrency: string | null;
  approved: boolean;
  bankCreatedAt: string | null;
  openedAt: string | null;
  triedAt: string | null;
  failedAt: string | null;
  paidAt: string | null;
  refusedAt: string | null;
}

export interface MetricsPayout {
  invoiceId: string;
  state: PayoutState;
  foundAt: string;
  feeMinor: number | null;
  feeCurrency: string | null;
  amountMinor: number | null;
  currency: string | null;
}

// An invoice's or a run's approval request, with no terms and no names. owner is
// the invoice or the run, and signoffs are the times of its signoffs in order.
export interface MetricsRequest {
  id: number;
  owner: string;
  state: ApprovalState;
  requestedAt: string | null;
  expiresAt: string | null;
  needed: number;
  signoffs: string[];
}

export interface MetricsOutage {
  id: number;
  currency: string;
  method: string;
  codes: string;
  state: string;
  declaredAt: string;
  endedAt: string | null;
  payees: number;
  // Hold rows by what they hold, without counted.
  held: Record<string, number>;
}

export interface MetricsRead {
  startedAt: string | null;
  obligations: MetricsObligation[];
  attempts: MetricsAttempt[];
  payouts: MetricsPayout[];
  requests: MetricsRequest[];
  runRequests: MetricsRequest[];
  outages: MetricsOutage[];
}

// As SQLite gives them, with 0 or 1 for the booleans.
interface MetricsObligationRow extends Omit<MetricsObligation, "fromRun" | "heldDuplicate" | "reason"> {
  fromRun: number;
  heldDuplicate: number;
  escalationCode: string;
  escalationClauses: string;
  escalationSlots: string;
}

interface MetricsAttemptRow extends Omit<MetricsAttempt, "approved"> {
  approved: number;
}

interface MetricsRequestRow {
  id: number;
  owner: string | number;
  state: ApprovalState;
  requestedAt: string | null;
  expiresAt: string | null;
  needed: number;
}

interface MetricsSignoffRow {
  approvalId: number;
  at: string;
}

// What the ops metrics read, one query per table, inside readSnapshot.
export class MetricsReads {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Everything the metrics read, one query per table, with only the columns they
  // use: no names, notes, references, facts or email text, of an approval's terms
  // only its quote's sell amount, a number compared in SQL, and of the timeline
  // only each invoice's first line's time and its latest closed line's.
  // It only reads, so it runs inside readSnapshot. Stored JSON is read only inside
  // CASE WHEN json_valid(...), because SQLite evaluates both sides of an AND and a
  // JSON function throws on text that is not JSON.
  metricsRead(): MetricsRead {
    const obligations: MetricsObligation[] = (
      this.db
        .prepare(
          `SELECT o.invoice_id AS invoiceId, o.currency, COALESCE(o.source_currency, o.currency) AS wallet,
                  o.amount_minor AS amountMinor, o.state, o.origin, o.run_row_id IS NOT NULL AS fromRun,
                  o.transfer_method AS transferMethod, o.escalation_reason AS escalationReason,
                  o.escalation_code AS escalationCode, o.escalation_clauses AS escalationClauses,
                  o.escalation_slots AS escalationSlots,
                  CASE WHEN json_valid(o.duplicate_of) THEN json_array_length(o.duplicate_of) > 0 ELSE 0 END
                    AS heldDuplicate,
                  o.escalated_at AS escalatedAt,
                  (SELECT at FROM events WHERE events.invoice_id = o.invoice_id ORDER BY id LIMIT 1) AS startedAt,
                  CASE WHEN o.state IN ('settled', 'rejected') THEN
                    (SELECT at FROM events WHERE events.invoice_id = o.invoice_id AND kind = 'closed'
                      ORDER BY id DESC LIMIT 1)
                  END AS closedAt
             FROM obligations o ORDER BY o.rowid`,
        )
        .all() as unknown as MetricsObligationRow[]
    ).map(
      ({ escalationCode, escalationClauses, escalationSlots, ...row }: MetricsObligationRow): MetricsObligation => ({
        ...row,
        reason: storedReason({
          text: row.escalationReason,
          code: escalationCode,
          clauses: escalationClauses,
          slots: escalationSlots,
        }),
        fromRun: row.fromRun === 1,
        heldDuplicate: row.heldDuplicate === 1,
      }),
    );
    const attempts: MetricsAttempt[] = (
      this.db
        .prepare(
          `SELECT a.invoice_id AS invoiceId, a.kind, a.transfer_id AS transferId, a.state,
                  a.failure_code AS failureCode, a.fee_minor AS feeMinor, a.fee_currency AS feeCurrency,
                  a.amount_minor AS amountMinor, a.currency,
                  CASE WHEN a.amount_minor IS NULL AND a.quote_id IS NOT NULL THEN
                    (SELECT CASE WHEN json_valid(ap.terms) THEN
                              CASE WHEN json_type(ap.terms, '$.fx.sellAmountMinor') = 'integer'
                                    AND json_extract(ap.terms, '$.fx.quoteId') IS a.quote_id
                                    AND json_extract(ap.terms, '$.fx.sellCurrency')
                                        IS COALESCE(o.source_currency, o.currency)
                                   THEN json_extract(ap.terms, '$.fx.sellAmountMinor') END
                            END
                       FROM approvals ap
                      WHERE ap.id = COALESCE(a.approval_id,
                              (SELECT MAX(id) FROM approvals WHERE approvals.invoice_id = a.invoice_id)))
                  END AS quoteAmountMinor,
                  a.mismatched_amount_minor AS mismatchedAmountMinor, a.mismatched_currency AS mismatchedCurrency,
                  a.approval_id IS NOT NULL AS approved,
                  a.bank_created_at AS bankCreatedAt, a.bank_status AS bankStatus, a.found_late_at AS foundLateAt,
                  a.mismatched_transfer_id AS mismatchedTransferId, a.mismatched_status AS mismatchedStatus,
                  a.opened_at AS openedAt, a.tried_at AS triedAt, a.failed_at AS failedAt, a.paid_at AS paidAt,
                  a.refused_at AS refusedAt
             FROM attempts a LEFT JOIN obligations o ON o.invoice_id = a.invoice_id ORDER BY a.rowid`,
        )
        .all() as unknown as MetricsAttemptRow[]
    ).map((row: MetricsAttemptRow): MetricsAttempt => ({ ...row, approved: row.approved === 1 }));
    const payouts: MetricsPayout[] = this.db
      .prepare(
        `SELECT invoice_id AS invoiceId, state, found_at AS foundAt, fee_minor AS feeMinor,
                fee_currency AS feeCurrency, amount_minor AS amountMinor, currency
           FROM outside_payouts ORDER BY rowid`,
      )
      .all() as unknown as MetricsPayout[];
    const requestsOf = (requests: string, signoffs: string, owner: string): MetricsRequest[] => {
      const times: Map<number, string[]> = new Map();
      for (const row of this.db
        .prepare(`SELECT approval_id AS approvalId, at FROM ${signoffs} ORDER BY approval_id, at, rowid`)
        .all() as unknown as MetricsSignoffRow[]) {
        const list: string[] = times.get(row.approvalId) ?? [];
        list.push(row.at);
        times.set(row.approvalId, list);
      }
      return (
        this.db
          .prepare(
            `SELECT id, ${owner} AS owner, state, requested_at AS requestedAt, expires_at AS expiresAt, needed
               FROM ${requests} ORDER BY id`,
          )
          .all() as unknown as MetricsRequestRow[]
      ).map(
        (row: MetricsRequestRow): MetricsRequest => ({
          ...row,
          owner: String(row.owner),
          signoffs: times.get(row.id) ?? [],
        }),
      );
    };
    const held: Map<number, Record<string, number>> = new Map();
    for (const row of this.db
      .prepare(
        `SELECT outage_id AS outageId, what, COUNT(*) AS n FROM outage_holds
          WHERE what <> 'counted' GROUP BY outage_id, what`,
      )
      .all() as unknown as { outageId: number; what: string; n: number }[]) {
      held.set(row.outageId, { ...held.get(row.outageId), [row.what]: row.n });
    }
    const outages: MetricsOutage[] = (
      this.db
        .prepare(
          `SELECT id, currency, method, codes, state, declared_at AS declaredAt, ended_at AS endedAt, payees
             FROM outages ORDER BY id`,
        )
        .all() as unknown as Omit<MetricsOutage, "held">[]
    ).map((row: Omit<MetricsOutage, "held">): MetricsOutage => ({ ...row, held: held.get(row.id) ?? {} }));
    return {
      startedAt: this.db.metaValue("started_at"),
      obligations,
      attempts,
      payouts,
      requests: requestsOf("approvals", "signoffs", "invoice_id"),
      runRequests: requestsOf("run_approvals", "run_signoffs", "run_id"),
      outages,
    };
  }
}

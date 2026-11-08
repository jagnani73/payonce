import { randomUUID } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import type { TransferBankDetails } from "../airwallex/transfers.js";
import type { AccountFailure, ApprovalTerms, FxTerms } from "../domain/approval.js";
import type { ArrivalTerms } from "../domain/arrival.js";
import {
  bankDetailsKey,
  FAILED_STATUS_LIST,
  failedStatus,
  keyHash,
  knownRoute,
  routeKeyOf,
  type Debit,
} from "../domain/assess.js";
import { ACCOUNT_FAILURE_CODES } from "../domain/failure-codes.js";
import type { Reason } from "../domain/reasons.js";
import { isUniqueViolation, storedObject, type Db } from "./db.js";
import {
  crossCurrency,
  type CashObligation,
  type InvoiceRow,
  type InvoiceStore,
  type Obligation,
  type ObligationRow,
  type TransferMethod,
} from "./invoices.js";
import type { Lease, LockStore } from "./locks.js";
import { RailOutageError, type Outage, type OutageStore } from "./outages.js";

// An attempt for the invoice bound as the parameter that became a transfer or may
// still become one. An invoice with none has sent nothing.
export const SENT_ATTEMPT: string = `SELECT 1 FROM attempts WHERE invoice_id = ?
  AND (transfer_id IS NOT NULL OR state <> 'failed')`;

const FAILED_IN_SQL: string = FAILED_STATUS_LIST.map((status: string): string => `'${status}'`).join(", ");

// A payment for the invoice bound as the parameter that the bank has live, the
// test liveAtBank makes in code: an attempt that is not failed, a transfer the
// ledger keeps failed while the bank shows it in flight, paid or in a status
// PayOnce does not know, or a transfer under an attempt's request id that does not
// match its invoice, while the bank has not failed it. A transfer found late
// whose status was never read counts as live.
export const LIVE_ATTEMPT: string = `SELECT 1 FROM attempts WHERE invoice_id = ?
  AND (state <> 'failed'
    OR (transfer_id IS NOT NULL AND CASE
      WHEN bank_status IS NULL THEN found_late_at IS NOT NULL
      ELSE bank_status NOT IN (${FAILED_IN_SQL}) END)
    OR (mismatched_transfer_id IS NOT NULL
      AND (mismatched_status IS NULL OR mismatched_status NOT IN (${FAILED_IN_SQL}))))`;

// A transfer under the request id of one of the invoice's attempts that does not
// match the invoice, which no person has closed the invoice over since.
export const UNCLEARED_MISMATCH: string = `SELECT 1 FROM attempts WHERE invoice_id = ?
  AND mismatched_transfer_id IS NOT NULL AND mismatched_cleared_at IS NULL`;

export type AttemptKind = "original" | "replacement";

export type AttemptState = "pending" | "in_flight" | "paid" | "failed";

export interface Attempt {
  requestId: string;
  invoiceId: string;
  kind: AttemptKind;
  transferId: string | null;
  // The bank's short reference, as shown to people.
  reference: string | null;
  state: AttemptState;
  failureCode: string | null;
  // What the payer paid Airwallex for the transfer, as last read from it. Null
  // until a transfer has been read.
  feeMinor: number | null;
  feeCurrency: string | null;
  // What the transfer took from the wallet, before the fee, as last read from it:
  // the source amount in the source currency for a payment from another
  // currency's wallet. Null until a transfer has been read since PayOnce started
  // keeping it.
  amountMinor: number | null;
  currency: string | null;
  // The quote a payment from another currency's wallet is sent with, and when it
  // runs out as Airwallex wrote it. Null on any other payment.
  quoteId: string | null;
  quoteValidTo: string | null;
  // The approval the attempt was opened on. Null on a payment no approval
  // released, and on one from before the column.
  approvalId: number | null;
  // Why the transfer did not go out on its approved quote. Null when it did, or
  // has not been checked. Only a person closes an invoice with one.
  rateMismatch: string | null;
  // The transfer's created_at and status as Airwallex last gave them, and when it
  // usually arrives as the route advisory worked it out when it was sent. Null
  // until read, and on payments from before these columns.
  bankCreatedAt: string | null;
  bankStatus: string | null;
  arrival: ArrivalTerms | null;
  // When PayOnce opened it. Null on attempts from before this was kept and on a
  // found payout's.
  openedAt: string | null;
  // When PayOnce last asked Airwallex to create its transfer. Null until the first
  // try, and on a found payout's.
  triedAt: string | null;
  // When Airwallex listed a transfer under its request id after PayOnce had
  // marked it failed with none. Null on every other attempt.
  foundLateAt: string | null;
  // A transfer under its request id that is not its invoice's payment by number,
  // amount and currency, on an attempt marked failed with none: its id, short
  // reference and last status read. Null on every other attempt.
  mismatchedTransferId: string | null;
  mismatchedReference: string | null;
  mismatchedStatus: string | null;
  // When a person closed the invoice after it was found. Until then PayOnce never
  // closes the invoice by itself.
  mismatchedClearedAt: string | null;
  // What that transfer took from the wallet it left before the fee, and that
  // wallet. Null until it has been read since PayOnce kept them.
  mismatchedAmountMinor: number | null;
  mismatchedCurrency: string | null;
  // The accountKey of the bank details it was decided or approved for. Null on a
  // found payout's, and on one from before it was kept that no approval or pay
  // run row named.
  accountKey: string | null;
  // The routeKey of those details: where the money goes. Null on attempts from
  // before it was kept that nothing on file gave it for, which are compared by
  // accountKey instead.
  routeKey: string | null;
  // True when its transfer went to other details than accountKey, or showed none
  // (checkAccount). Only a person closes an invoice paid by one.
  misdirected: boolean;
}

// An attempt as the cash lines read it: everything but its arrival estimate.
export type CashAttempt = Omit<Attempt, "arrival">;

// An account a payment is decided or approved for, or that a stored payment was
// checked against: its accountKey and, when known, its routeKey. Two accounts
// are the same when their routeKeys match, or, with either routeKey not known,
// their accountKeys.
export interface AccountRef {
  accountKey: string;
  routeKey: string | null;
}

// True when details hold the account ref names, by where the money goes. A ref
// whose routeKey is not known (knownRoute) is matched only by its full
// accountKey, every detail alike, so a key from another scheme never passes as
// the same account: anything else counts as changed.
export function holdsAccount(ref: AccountRef, details: TransferBankDetails): boolean {
  const route: string | null = knownRoute(ref.routeKey);
  return route !== null ? route === routeKeyOf(details) : ref.accountKey === keyHash(bankDetailsKey(details));
}

// The latest checked payment PayOnce made to a beneficiary, with the account it
// went to.
export interface LastPaid extends AccountRef {
  transferId: string;
  reference: string | null;
}

// The quote an attempt is sent with, from the terms of the approval it was opened
// on. Written with the attempt, before Airwallex is called, so a retry sends the
// same one.
export interface AttemptQuote {
  quoteId: string;
  validTo: string;
}

interface TransferRow {
  transfer_id: string;
}

interface FeeRow {
  fee_minor: number;
}

interface AttemptRow {
  request_id: string;
  invoice_id: string;
  kind: AttemptKind;
  transfer_id: string | null;
  reference: string | null;
  state: AttemptState;
  failure_code: string | null;
  fee_minor: number | null;
  fee_currency: string | null;
  amount_minor: number | null;
  currency: string | null;
  quote_id: string | null;
  quote_valid_to: string | null;
  approval_id: number | null;
  rate_mismatch: string | null;
  bank_created_at: string | null;
  bank_status: string | null;
  arrival: string | null;
  opened_at: string | null;
  tried_at: string | null;
  found_late_at: string | null;
  mismatched_transfer_id: string | null;
  mismatched_reference: string | null;
  mismatched_status: string | null;
  mismatched_cleared_at: string | null;
  mismatched_amount_minor: number | null;
  mismatched_currency: string | null;
  account_key: string | null;
  route_key: string | null;
  misdirected: number;
}

export class DuplicatePaymentError extends Error {
  readonly invoiceId: string;

  constructor(invoiceId: string) {
    super(`${invoiceId} already has a live payment`);
    this.name = "DuplicatePaymentError";
    this.invoiceId = invoiceId;
  }
}

function toAttempt(row: AttemptRow): Attempt {
  return {
    requestId: row.request_id,
    invoiceId: row.invoice_id,
    kind: row.kind,
    transferId: row.transfer_id,
    reference: row.reference,
    state: row.state,
    failureCode: row.failure_code,
    feeMinor: row.fee_minor,
    feeCurrency: row.fee_currency,
    amountMinor: row.amount_minor,
    currency: row.currency,
    quoteId: row.quote_id,
    quoteValidTo: row.quote_valid_to,
    approvalId: row.approval_id,
    rateMismatch: row.rate_mismatch,
    bankCreatedAt: row.bank_created_at ?? null,
    bankStatus: row.bank_status ?? null,
    arrival: row.arrival === null || row.arrival === undefined ? null : storedObject<ArrivalTerms>(row.arrival),
    openedAt: row.opened_at ?? null,
    triedAt: row.tried_at ?? null,
    foundLateAt: row.found_late_at ?? null,
    mismatchedTransferId: row.mismatched_transfer_id ?? null,
    mismatchedReference: row.mismatched_reference ?? null,
    mismatchedStatus: row.mismatched_status ?? null,
    mismatchedClearedAt: row.mismatched_cleared_at ?? null,
    mismatchedAmountMinor: row.mismatched_amount_minor ?? null,
    mismatchedCurrency: row.mismatched_currency ?? null,
    accountKey: row.account_key ?? null,
    routeKey: row.route_key ?? null,
    misdirected: row.misdirected === 1,
  };
}

// Payment attempts: the one gate that opens them, the duplicate lock, and what the
// bank last said of each.
export class AttemptStore {
  private readonly db: Db;
  private readonly invoices: InvoiceStore;
  private readonly outages: OutageStore;
  private readonly locks: LockStore;

  constructor(db: Db, invoices: InvoiceStore, outages: OutageStore, locks: LockStore) {
    this.db = db;
    this.invoices = invoices;
    this.outages = outages;
    this.locks = locks;
  }

  private insertAttempt(
    requestId: string,
    invoiceId: string,
    kind: AttemptKind,
    approvalId: number | null,
    quote: AttemptQuote | null,
    accountKey: string | null,
    openedAt: string = new Date().toISOString(),
    routeKey: string | null = null,
  ): void {
    // The unique index refuses a second attempt that is not failed. A transfer the
    // ledger keeps failed while the bank has it live refuses one too.
    if (this.db.prepare(LIVE_ATTEMPT).get(invoiceId) !== undefined) {
      throw new DuplicatePaymentError(invoiceId);
    }
    try {
      this.db
        .prepare(
          `INSERT INTO attempts
             (request_id, invoice_id, kind, state, quote_id, quote_valid_to, approval_id, opened_at, account_key,
              route_key)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          requestId,
          invoiceId,
          kind,
          quote?.quoteId ?? null,
          quote?.validTo ?? null,
          approvalId,
          openedAt,
          accountKey,
          routeKey,
        );
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new DuplicatePaymentError(invoiceId);
      }
      throw error;
    }
  }

  // Opens a payment's attempt, which counts its money as committed. Only inside a
  // write transaction, and only while lease holds the lock of the wallet the
  // payment leaves, so a holder that lost its lease, or holds another wallet's
  // lock, opens nothing. released is the approval that released the payment:
  // the attempt keeps it, and a payment from another currency's wallet keeps the
  // quote in its terms, so a retry sends the same one. Such a payment is opened
  // only on an approval with a quote. The attempt keeps the account it goes to:
  // the one the approval's terms name, or else decided, the one the agent
  // decided on. Every payment the engine opens names one. route is the routeKey
  // of the record the caller just checked holds that account. No payment is
  // opened on a rail with an active outage: RailOutageError rolls the caller's
  // transaction back, so an approval it would have spent stays approved.
  openAttempt(
    invoiceId: string,
    kind: AttemptKind,
    lease: Lease,
    released: number | null,
    decided: string | null,
    route: string | null = null,
  ): Attempt {
    if (!this.db.isTransaction) {
      throw new Error("An attempt is opened only inside a ledger transaction");
    }
    // A caller that leaves either out opens it on no approval, or no account.
    const approvalId: number | null = released ?? null;
    this.locks.requireLease(lease);
    const obligation: Obligation | undefined = this.invoices.obligation(invoiceId);
    if (obligation !== undefined && lease.currency !== obligation.sourceCurrency) {
      throw new Error(
        `${invoiceId} is paid from ${obligation.sourceCurrency}, and its payment was about to be opened under the ${lease.currency} lock`,
      );
    }
    const outage: Outage | undefined =
      obligation === undefined ? undefined : this.outages.activeOutage(obligation.currency, obligation.transferMethod);
    if (outage !== undefined) {
      throw new RailOutageError(outage, approvalId === null ? kind : "approved");
    }
    const quote: AttemptQuote | null = approvalId === null ? null : this.approvedQuote(approvalId);
    const key: string | null = approvalId === null ? (decided ?? null) : this.approvedAccountKey(approvalId);
    if (obligation !== undefined && crossCurrency(obligation) && quote === null) {
      throw new Error(
        `${invoiceId} is paid from ${obligation.sourceCurrency}, so PayOnce pays it only on an approved exchange rate quote. Nothing was sent`,
      );
    }
    const requestId: string = randomUUID();
    const openedAt: string = new Date().toISOString();
    this.insertAttempt(requestId, invoiceId, kind, approvalId, quote, key, openedAt, key === null ? null : route);
    return {
      requestId,
      invoiceId,
      kind,
      transferId: null,
      reference: null,
      state: "pending",
      failureCode: null,
      feeMinor: null,
      feeCurrency: null,
      amountMinor: null,
      currency: null,
      quoteId: quote?.quoteId ?? null,
      quoteValidTo: quote?.validTo ?? null,
      approvalId,
      rateMismatch: null,
      bankCreatedAt: null,
      bankStatus: null,
      arrival: null,
      openedAt,
      triedAt: null,
      foundLateAt: null,
      mismatchedTransferId: null,
      mismatchedReference: null,
      mismatchedStatus: null,
      mismatchedClearedAt: null,
      mismatchedAmountMinor: null,
      mismatchedCurrency: null,
      accountKey: key,
      routeKey: key === null ? null : route,
      misdirected: false,
    };
  }

  // The account an approval's terms name.
  private approvedAccountKey(approvalId: number): string | null {
    const row: { terms: string } | undefined = this.db
      .prepare("SELECT terms FROM approvals WHERE id = ?")
      .get(approvalId) as unknown as { terms: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.terms) as ApprovalTerms).accountKey;
  }

  // The quote in an approval's terms, for a payment from another currency's
  // wallet. Null when its terms carry none.
  private approvedQuote(approvalId: number): AttemptQuote | null {
    const row: { terms: string } | undefined = this.db
      .prepare("SELECT terms FROM approvals WHERE id = ?")
      .get(approvalId) as unknown as { terms: string } | undefined;
    const fx: FxTerms | undefined =
      row === undefined ? undefined : (JSON.parse(row.terms) as ApprovalTerms).fx;
    return fx === undefined ? null : { quoteId: fx.quoteId, validTo: fx.validTo };
  }

  // Opens a replacement attempt the way openAttempt does and always rolls it back,
  // so nothing is left for a later look to send. Throws DuplicatePaymentError when
  // the lock refuses it.
  tryLock(invoiceId: string): void {
    this.db.transaction(
      (): void => this.insertAttempt(randomUUID(), invoiceId, "replacement", null, null, null),
      (): boolean => false,
    );
  }

  attempts(invoiceId: string): Attempt[] {
    const rows: AttemptRow[] = this.db
      .prepare("SELECT * FROM attempts WHERE invoice_id = ? ORDER BY rowid")
      .all(invoiceId) as unknown as AttemptRow[];
    return rows.map(toAttempt);
  }

  // What money committed to payments is worked out from: every invoice that is
  // not closed, and its attempts, with only the columns committedMinor reads. A
  // stored list or object it does not read, such as another invoice's
  // duplicate_of or an attempt's arrival, is never parsed, so one that does not
  // parse stops only its own invoice's looks and not every payment.
  committedRead(): { obligations: CashObligation[]; attempts: Map<string, CashAttempt[]> } {
    const obligations: CashObligation[] = (
      this.db
        .prepare(
          `SELECT invoice_id, state, currency, source_currency, amount_minor, transfer_method, origin, run_row_id
             FROM obligations WHERE state IN ('open', 'escalated') ORDER BY rowid DESC`,
        )
        .all() as unknown as ObligationRow[]
    ).map(
      (row: ObligationRow): CashObligation => ({
        invoiceId: row.invoice_id,
        state: row.state,
        currency: row.currency,
        sourceCurrency: row.source_currency ?? row.currency,
        amountMinor: row.amount_minor,
        transferMethod: row.transfer_method,
        origin: row.origin,
        runRowId: row.run_row_id,
      }),
    );
    const attempts: Map<string, CashAttempt[]> = new Map<string, CashAttempt[]>();
    const rows: AttemptRow[] = this.db
      .prepare(
        `SELECT attempts.* FROM attempts JOIN obligations ON obligations.invoice_id = attempts.invoice_id
          WHERE obligations.state IN ('open', 'escalated') ORDER BY attempts.rowid`,
      )
      .all() as unknown as AttemptRow[];
    for (const row of rows) {
      const { arrival: _arrival, ...attempt }: Attempt = toAttempt({ ...row, arrival: null });
      const list: CashAttempt[] = attempts.get(attempt.invoiceId) ?? [];
      list.push(attempt);
      attempts.set(attempt.invoiceId, list);
    }
    return { obligations, attempts };
  }

  // The attempt a transfer belongs to. The request_id is PayOnce's own, so it
  // finds the attempt even before the transfer id has been recorded.
  attemptOf(requestId: string, transferId: string): Attempt | undefined {
    const row: AttemptRow | undefined = this.db
      .prepare("SELECT * FROM attempts WHERE request_id = ? OR transfer_id = ? LIMIT 1")
      .get(requestId, transferId) as unknown as AttemptRow | undefined;
    return row === undefined ? undefined : toAttempt(row);
  }

  // A null state leaves the stored state as it is, and a null fee, amount,
  // creation time or bank status the stored one. An attempt the ledger has as
  // failed whose transfer the bank shows live while another payment for the
  // invoice holds the duplicate lock keeps its failed state, so the lock still
  // holds one live payment, and the rest is recorded: bank_status says what the
  // bank shows. Once the lock is free, the next record takes the bank's state, so
  // the lock holds it from then on. A status PayOnce does not know counts as
  // live, so a failed attempt the bank shows in one is recorded in flight.
  record(
    requestId: string,
    transferId: string,
    reference: string,
    state: AttemptState | null,
    failureCode: string | null,
    feeMinor: number | null,
    feeCurrency: string | null,
    amountMinor: number | null,
    currency: string | null,
    bankCreatedAt: string | null = null,
    bankStatus: string | null = null,
  ): void {
    const unknownLive: number =
      state === null && bankStatus !== null && !failedStatus(bankStatus) ? 1 : 0;
    const update = (written: AttemptState | null, revive: number): { changes: number | bigint } =>
      this.db
        .prepare(
          `UPDATE attempts
              SET transfer_id = ?, reference = ?,
                  state = COALESCE(?, CASE WHEN state = 'failed' AND ? = 1 THEN 'in_flight' ELSE state END),
                  failure_code = ?, fee_minor = COALESCE(?, fee_minor),
                  fee_currency = COALESCE(?, fee_currency),
                  amount_minor = COALESCE(?, amount_minor), currency = COALESCE(?, currency),
                  bank_created_at = COALESCE(?, bank_created_at),
                  bank_status = COALESCE(?, bank_status)
            WHERE request_id = ?`,
        )
        .run(
          transferId,
          reference,
          written,
          revive,
          failureCode,
          feeMinor,
          feeCurrency,
          amountMinor,
          currency,
          bankCreatedAt,
          bankStatus,
          requestId,
        );
    let result: { changes: number | bigint };
    try {
      result = update(state, unknownLive);
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      result = update(null, 0);
    }
    if (Number(result.changes) !== 1) {
      throw new Error(`No payment attempt has request_id ${requestId}`);
    }
  }

  // Where an attempt's transfer went, as last read, for the supplier view only.
  // Its own write after record, so the duplicate lock's write is untouched, and
  // a value that could not be read keeps the one on file.
  recordSentTo(requestId: string, sentKey: string | null, sentRoute: string | null, sentEnding: string | null): void {
    this.db
      .prepare(
        `UPDATE attempts SET sent_key = COALESCE(?, sent_key), sent_route = COALESCE(?, sent_route),
                sent_ending = COALESCE(?, sent_ending)
          WHERE request_id = ?`,
      )
      .run(sentKey, sentRoute, sentEnding, requestId);
  }

  // Marks an attempt PayOnce had failed with no transfer as one Airwallex now
  // lists a transfer for, before that transfer is recorded on it. False when the
  // attempt has a transfer or is not failed, as when another step recorded it.
  foundLate(requestId: string, at: number): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE attempts SET found_late_at = ?
          WHERE request_id = ? AND state = 'failed' AND transfer_id IS NULL`,
      )
      .run(new Date(at).toISOString(), requestId);
    return Number(result.changes) === 1;
  }

  // Failed transfers, PayOnce's and payouts sent outside it, whose fee has not
  // been recorded, such as those failed before fees were kept. Only those never
  // tried, or last tried at triedBefore or earlier, and the least recently tried
  // first, so a transfer that cannot be read does not keep the others waiting.
  failedWithoutFee(limit: number, triedBefore: number): string[] {
    const before: string = new Date(triedBefore).toISOString();
    return (
      this.db
        .prepare(
          `SELECT transfer_id, fee_tried_at FROM attempts
            WHERE state = 'failed' AND transfer_id IS NOT NULL AND fee_minor IS NULL
              AND (fee_tried_at IS NULL OR fee_tried_at <= ?)
           UNION
           SELECT transfer_id, fee_tried_at FROM outside_payouts
            WHERE state = 'failed' AND fee_minor IS NULL
              AND (fee_tried_at IS NULL OR fee_tried_at <= ?)
           ORDER BY fee_tried_at, transfer_id
           LIMIT ?`,
        )
        .all(before, before, limit) as unknown as TransferRow[]
    ).map((row: TransferRow): string => row.transfer_id);
  }

  // Notes that the fee of a transfer is being read, so it goes to the back of
  // failedWithoutFee's list whether or not the read works.
  feeTried(transferId: string, at: number): void {
    for (const table of ["attempts", "outside_payouts"]) {
      this.db
        .prepare(`UPDATE ${table} SET fee_tried_at = ? WHERE transfer_id = ?`)
        .run(new Date(at).toISOString(), transferId);
    }
  }

  // Writes only the fee of a transfer that has none on file, so it never changes
  // what a look decides on and is safe outside the invoice's turn.
  recordFee(transferId: string, feeMinor: number, feeCurrency: string): void {
    for (const table of ["attempts", "outside_payouts"]) {
      this.db
        .prepare(
          `UPDATE ${table} SET fee_minor = ?, fee_currency = ?
            WHERE transfer_id = ? AND fee_minor IS NULL`,
        )
        .run(feeMinor, feeCurrency, transferId);
    }
  }

  // The fee most recently recorded for a payment in this currency by this
  // transfer method, or null when the ledger has none.
  latestFee(currency: string, method: TransferMethod): number | null {
    const row: FeeRow | undefined = this.db
      .prepare(
        `SELECT attempts.fee_minor FROM attempts
           JOIN obligations ON obligations.invoice_id = attempts.invoice_id
          WHERE attempts.fee_minor IS NOT NULL AND attempts.fee_currency = ?
            AND obligations.transfer_method = ?
          ORDER BY attempts.rowid DESC LIMIT 1`,
      )
      .get(currency, method) as unknown as FeeRow | undefined;
    return row?.fee_minor ?? null;
  }

  // For a transfer that did not go out on its approved quote.
  markRateMismatch(requestId: string, reason: string): void {
    this.db
      .prepare("UPDATE attempts SET rate_mismatch = ? WHERE request_id = ?")
      .run(reason, requestId);
  }

  // Written just before each call that creates the attempt's transfer, so a look
  // in another process counts a bank deadline from the latest try.
  tried(requestId: string, at: number): void {
    this.db
      .prepare("UPDATE attempts SET tried_at = ? WHERE request_id = ?")
      .run(new Date(at).toISOString(), requestId);
  }

  // For an attempt that never became a transfer: Airwallex refused to create it
  // (refused, with or without a code), or lists none under its request id long
  // after it was opened. It releases the lock. One a look has since found a
  // transfer for is kept. True when it changed the attempt.
  failAttempt(requestId: string, failureCode: string | null, refused: boolean): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE attempts SET state = 'failed', failure_code = ?, refused_at = ?
          WHERE request_id = ? AND state = 'pending' AND transfer_id IS NULL`,
      )
      .run(failureCode, refused ? new Date().toISOString() : null, requestId);
    return Number(result.changes) === 1;
  }

  // Ties a transfer Airwallex lists under the request id of an attempt marked
  // failed with none, which does not match its invoice, to that attempt, with what
  // it took from its wallet (debit). False when the attempt already has one, has
  // a transfer, or is not failed. In the same transaction the invoice goes to a
  // person with reason unless it is settled, and gets a look due at once.
  addMismatched(
    requestId: string,
    transferId: string,
    reference: string,
    status: string | null,
    debit: Debit | null,
    reason: Reason,
  ): boolean {
    return this.db.transaction((): boolean => {
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE attempts
              SET mismatched_transfer_id = ?, mismatched_reference = ?, mismatched_status = ?,
                  mismatched_amount_minor = ?, mismatched_currency = ?
            WHERE request_id = ? AND state = 'failed' AND transfer_id IS NULL
              AND mismatched_transfer_id IS NULL`,
        )
        .run(transferId, reference, status, debit?.minor ?? null, debit?.currency ?? null, requestId);
      if (Number(result.changes) !== 1) {
        return false;
      }
      const invoice: InvoiceRow | undefined = this.db
        .prepare("SELECT invoice_id FROM attempts WHERE request_id = ?")
        .get(requestId) as unknown as InvoiceRow | undefined;
      if (invoice !== undefined) {
        this.invoices.escalateUnlessSettled(invoice.invoice_id, reason);
        this.invoices.lookNow(invoice.invoice_id);
      }
      return true;
    });
  }

  // The status a look or the sweep last read for such a transfer, and what it
  // took from its wallet, which a null debit leaves as it is. True when the status
  // changed, and then, in the same transaction, the invoice gets a look due at
  // once.
  setMismatchedStatus(transferId: string, status: string, debit: Debit | null = null): boolean {
    return this.db.transaction((): boolean => {
      this.db
        .prepare(
          `UPDATE attempts
              SET mismatched_amount_minor = COALESCE(?, mismatched_amount_minor),
                  mismatched_currency = COALESCE(?, mismatched_currency)
            WHERE mismatched_transfer_id = ?`,
        )
        .run(debit?.minor ?? null, debit?.currency ?? null, transferId);
      const changed: InvoiceRow[] = this.db
        .prepare(
          `UPDATE attempts SET mismatched_status = ?
            WHERE mismatched_transfer_id = ? AND mismatched_status IS NOT ?
            RETURNING invoice_id`,
        )
        .all(status, transferId, status) as unknown as InvoiceRow[];
      for (const row of changed) {
        this.invoices.lookNow(row.invoice_id);
      }
      return changed.length >= 1;
    });
  }

  // A person closed the invoice over these transfers found under its request ids
  // that did not match it, so they no longer keep it from closing by itself. One
  // found after the close was reviewed is left as it is. The caller holds the
  // write transaction that closes the invoice.
  clearMismatched(invoiceId: string, transferIds: string[]): void {
    const at: string = new Date().toISOString();
    const clear: StatementSync = this.db.prepare(
      `UPDATE attempts SET mismatched_cleared_at = ?
        WHERE invoice_id = ? AND mismatched_transfer_id = ? AND mismatched_cleared_at IS NULL`,
    );
    for (const transferId of transferIds) {
      clear.run(at, invoiceId, transferId);
    }
  }

  // A transfer that went to other bank details than the ones it was approved or
  // decided for.
  markMisdirected(requestId: string): void {
    this.db.prepare("UPDATE attempts SET misdirected = 1 WHERE request_id = ?").run(requestId);
  }

  // The latest payment PayOnce sent this beneficiary that the bank paid, to the
  // details it was decided or approved for, with that account's key. Only a
  // checked payment counts: one that kept the account it was meant for and did
  // not go elsewhere or show no bank details (misdirected). Payouts sent outside
  // PayOnce do not count, so a record changed and paid in the web app does not
  // become the account on file, and nor does a payment from before the account
  // was kept that nothing checked (lastPaidUnchecked).
  lastPaidTransfer(beneficiaryId: string): LastPaid | undefined {
    const row: { transfer_id: string; reference: string | null; account_key: string; route_key: string | null } | undefined = this.db
      .prepare(
        `SELECT attempts.transfer_id, attempts.reference, attempts.account_key, attempts.route_key FROM attempts
           JOIN obligations ON obligations.invoice_id = attempts.invoice_id
          WHERE obligations.beneficiary_id = ? AND obligations.origin = 'payonce'
            AND attempts.state = 'paid' AND attempts.transfer_id IS NOT NULL
            AND attempts.misdirected = 0 AND attempts.account_key IS NOT NULL
          ORDER BY attempts.rowid DESC LIMIT 1`,
      )
      .get(beneficiaryId) as unknown as
      | { transfer_id: string; reference: string | null; account_key: string; route_key: string | null }
      | undefined;
    return row === undefined
      ? undefined
      : {
          transferId: row.transfer_id,
          reference: row.reference,
          accountKey: row.account_key,
          routeKey: row.route_key ?? null,
        };
  }

  // True when PayOnce has paid this beneficiary on a person's approval: a payment
  // the bank paid that was opened on an approval that was used (approval_id), or
  // the original of a released row of an approved pay run. An automatic payment,
  // a single incident's original or an automatic replacement, counts as the
  // account PayOnce last paid but not here, so paying a payee once by itself never
  // stands in for the two approvers a payee nobody approved a payment to takes.
  // Attempts from before approval_id was kept do not count.
  paidOnApproval(beneficiaryId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM attempts JOIN obligations ON obligations.invoice_id = attempts.invoice_id
            WHERE obligations.beneficiary_id = ? AND obligations.origin = 'payonce'
              AND attempts.state = 'paid' AND attempts.transfer_id IS NOT NULL AND attempts.misdirected = 0
              AND ((attempts.approval_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM approvals WHERE approvals.id = attempts.approval_id
                                 AND approvals.state = 'used'))
                OR (attempts.kind = 'original' AND obligations.run_row_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM run_rows WHERE run_rows.id = obligations.run_row_id
                                 AND run_rows.state = 'released')))
            LIMIT 1`,
        )
        .get(beneficiaryId) !== undefined
    );
  }

  // The latest transfer that failed on this account with an account-level code
  // (ACCOUNT_FAILURE_CODES), when no payment opened after it was paid to the
  // account. Any attempt counts, a found payout's original included, on any
  // record, because the account is where the money goes. A failure counts for the
  // account it was meant for or went to, by routeKey or by full accountKey. A
  // later payment counts only when the bank paid it to the account it was meant
  // for (not misdirected), so the caution lifts only on money that arrived there.
  accountFailure(accountKey: string, routeKey: string): AccountFailure | undefined {
    const codes: string[] = [...ACCOUNT_FAILURE_CODES];
    const row: { reference: string | null; failure_code: string } | undefined = this.db
      .prepare(
        `SELECT failed.reference, failed.failure_code FROM attempts AS failed
          WHERE failed.state = 'failed'
            AND failed.failure_code IN (${codes.map((): string => "?").join(", ")})
            AND (failed.route_key = ? OR failed.sent_route = ? OR failed.account_key = ? OR failed.sent_key = ?)
            AND NOT EXISTS (
              SELECT 1 FROM attempts AS paid
               WHERE paid.rowid > failed.rowid AND paid.state = 'paid' AND paid.misdirected = 0
                 AND (paid.route_key = ? OR paid.sent_route = ? OR paid.account_key = ? OR paid.sent_key = ?))
          ORDER BY failed.rowid DESC LIMIT 1`,
      )
      .get(...codes, routeKey, routeKey, accountKey, accountKey, routeKey, routeKey, accountKey, accountKey) as unknown as
      | { reference: string | null; failure_code: string }
      | undefined;
    return row === undefined ? undefined : { reference: row.reference, failureCode: row.failure_code };
  }

  // The latest payment PayOnce sent this beneficiary that the bank paid and that
  // kept no account: one from before attempts kept the account each payment went
  // to, which nothing on file shows was checked. Undefined when there is none.
  lastPaidUnchecked(beneficiaryId: string): { transferId: string; reference: string | null } | undefined {
    const row: { transfer_id: string; reference: string | null } | undefined = this.db
      .prepare(
        `SELECT attempts.transfer_id, attempts.reference FROM attempts
           JOIN obligations ON obligations.invoice_id = attempts.invoice_id
          WHERE obligations.beneficiary_id = ? AND obligations.origin = 'payonce'
            AND attempts.state = 'paid' AND attempts.transfer_id IS NOT NULL
            AND attempts.misdirected = 0 AND attempts.account_key IS NULL
          ORDER BY attempts.rowid DESC LIMIT 1`,
      )
      .get(beneficiaryId) as unknown as { transfer_id: string; reference: string | null } | undefined;
    return row === undefined ? undefined : { transferId: row.transfer_id, reference: row.reference };
  }

  // When the payment usually arrives, as the route advisory worked it out when it
  // was sent. Advice for people only.
  setArrival(requestId: string, arrival: ArrivalTerms): void {
    this.db.prepare("UPDATE attempts SET arrival = ? WHERE request_id = ?").run(JSON.stringify(arrival), requestId);
  }
}

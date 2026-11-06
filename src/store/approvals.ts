import { LIVE_ATTEMPT, SENT_ATTEMPT, type Attempt, type AttemptStore } from "./attempts.js";
import { isUniqueViolation, type Db } from "./db.js";
import type { Lease } from "./locks.js";
import { LIVE_OUTSIDE_PAYOUT } from "./payouts.js";

export type ApprovalState = "requested" | "approved" | "used" | "void";

// One approver's approval of a request, with the binding of the terms they saw.
export interface Signoff {
  approver: string;
  binding: string;
  at: string;
}

// terms is the JSON shown to the approver, binding is its hash. A request is
// approved once it has as many signoffs as it needs. approver names everyone who
// approved it.
export interface Approval {
  id: number;
  invoiceId: string;
  binding: string;
  terms: string;
  state: ApprovalState;
  approver: string | null;
  // ISO times. A request recorded before requests expired has none, and counts
  // as expired.
  requestedAt: string | null;
  expiresAt: string | null;
  needed: number;
  // Why it needs more than one approver. Empty when it needs one.
  neededWhy: string;
  signoffs: Signoff[];
}

// What a new approval request asks for.
export interface ApprovalRequest {
  binding: string;
  terms: string;
  needed: number;
  neededWhy: string;
  expiresAt: number;
  // The routeKey of the account an invoice's terms name. A run's rows keep theirs.
  routeKey?: string | null;
}

interface ApprovalRow {
  id: number;
  invoice_id: string;
  binding: string;
  terms: string;
  state: ApprovalState;
  approver: string | null;
  requested_at: string | null;
  expires_at: string | null;
  needed: number;
  needed_why: string;
}

function toApproval(row: ApprovalRow, signoffs: Signoff[]): Approval {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    binding: row.binding,
    terms: row.terms,
    state: row.state,
    approver: row.approver,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    needed: row.needed,
    neededWhy: row.needed_why,
    signoffs,
  };
}

// When a request stops covering a payment, in epoch milliseconds. One recorded
// before requests expired counts as expired already. Works for invoice and run
// requests alike.
export function expiryOf(approval: { expiresAt: string | null }): number {
  const at: number = approval.expiresAt === null ? Number.NaN : Date.parse(approval.expiresAt);
  return Number.isFinite(at) ? at : 0;
}

export function isExpired(approval: { expiresAt: string | null }, now: number = Date.now()): boolean {
  return expiryOf(approval) <= now;
}

// Everyone who approved, as the timeline names them.
export function signersOf(signoffs: Signoff[]): string {
  const names: string[] = signoffs.map((signoff: Signoff): string => signoff.approver);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// A request to approve a run, shaped like an invoice's.
export interface RunApproval {
  id: number;
  runId: number;
  binding: string;
  terms: string;
  state: ApprovalState;
  approver: string | null;
  requestedAt: string;
  expiresAt: string;
  needed: number;
  neededWhy: string;
  signoffs: Signoff[];
}

export interface RunApprovalRow {
  id: number;
  run_id: number;
  binding: string;
  terms: string;
  state: ApprovalState;
  approver: string | null;
  requested_at: string;
  expires_at: string;
  needed: number;
  needed_why: string;
}

// Spending an approval is kept only when it opened the payment's attempt, and
// rolled back otherwise.
function opened(attempt: Attempt | undefined): boolean {
  return attempt !== undefined;
}

// Approval requests and signoffs for invoices (approvals, signoffs) and pay runs
// (run_approvals, run_signoffs), and spending an approval.
export class ApprovalStore {
  private readonly db: Db;
  private readonly attempts: AttemptStore;

  constructor(db: Db, attempts: AttemptStore) {
    this.db = db;
    this.attempts = attempts;
  }

  // Spends the approval to pay a held invoice, hands the invoice back to the
  // agent and opens its original's attempt, in one transaction, so a crash or a
  // failed write cannot leave it open with nothing sent. Undefined, with nothing
  // changed, when the approval is no longer approved or has expired, or the
  // invoice is no longer held: a person closed it, it has sent something, or a
  // payout for it sent outside PayOnce is live. Also when unchanged, run under
  // the write lock, returns false. The attempt keeps the approval, and the quote
  // in its terms for a payment from another currency's wallet.
  releaseFor(
    invoiceId: string,
    approvalId: number,
    lease: Lease,
    unchanged: () => boolean,
    route: string | null = null,
  ): Attempt | undefined {
    return this.db.transaction((): Attempt | undefined => {
      if (!unchanged()) {
        return undefined;
      }
      const used: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE approvals SET state = 'used'
            WHERE id = ? AND invoice_id = ? AND state = 'approved' AND expires_at > ?`,
        )
        .run(approvalId, invoiceId, new Date().toISOString());
      const released: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE obligations SET state = 'open'
            WHERE invoice_id = ? AND state = 'escalated' AND rejected_by IS NULL
              AND NOT EXISTS (${SENT_ATTEMPT}) AND NOT EXISTS (${LIVE_OUTSIDE_PAYOUT})
              AND NOT EXISTS (${LIVE_ATTEMPT})`,
        )
        .run(invoiceId, invoiceId, invoiceId, invoiceId);
      if (Number(used.changes) !== 1 || Number(released.changes) !== 1) {
        return undefined;
      }
      return this.attempts.openAttempt(invoiceId, "original", lease, approvalId, null, route);
    }, opened);
  }

  // Voids a request or approval for the invoice that is still open. False when
  // there was none.
  voidOpenApprovals(invoiceId: string): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE approvals SET state = 'void'
          WHERE invoice_id = ? AND state IN ('requested', 'approved')`,
      )
      .run(invoiceId);
    return Number(result.changes) > 0;
  }

  // A new request voids any earlier one for the invoice that is still open. Only
  // an invoice with a person gets one, so a request cannot land on an invoice
  // another process has just closed. False when none was opened.
  requestApproval(invoiceId: string, request: ApprovalRequest): boolean {
    return this.db.transaction((): boolean => {
      this.voidOpenApprovals(invoiceId);
      const result: { changes: number | bigint } = this.db
        .prepare(
          `INSERT INTO approvals
             (invoice_id, binding, terms, requested_at, expires_at, needed, needed_why, route_key)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM obligations WHERE invoice_id = ? AND state = 'escalated')`,
        )
        .run(
          invoiceId,
          request.binding,
          request.terms,
          new Date().toISOString(),
          new Date(request.expiresAt).toISOString(),
          request.needed,
          request.neededWhy,
          request.routeKey ?? null,
          invoiceId,
        );
      return Number(result.changes) === 1;
    });
  }

  latestApproval(invoiceId: string): Approval | undefined {
    const row: ApprovalRow | undefined = this.db
      .prepare(
        "SELECT * FROM approvals WHERE invoice_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(invoiceId) as unknown as ApprovalRow | undefined;
    return row === undefined ? undefined : toApproval(row, this.signoffs(row.id));
  }

  // Every approval request for the invoice, oldest first.
  approvalsFor(invoiceId: string): Approval[] {
    return (
      this.db
        .prepare("SELECT * FROM approvals WHERE invoice_id = ? ORDER BY id")
        .all(invoiceId) as unknown as ApprovalRow[]
    ).map((row: ApprovalRow): Approval => toApproval(row, this.signoffs(row.id)));
  }

  approval(id: number): Approval | undefined {
    const row: ApprovalRow | undefined = this.db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(id) as unknown as ApprovalRow | undefined;
    return row === undefined ? undefined : toApproval(row, this.signoffs(row.id));
  }

  // The approval an attempt was opened on. An attempt no approval released, or one
  // from before the column, has the latest.
  approvalOf(attempt: Pick<Attempt, "approvalId" | "invoiceId">): Approval | undefined {
    return attempt.approvalId === null
      ? this.latestApproval(attempt.invoiceId)
      : this.approval(attempt.approvalId);
  }

  private signoffs(approvalId: number): Signoff[] {
    return this.db
      .prepare(
        "SELECT approver, binding, at FROM signoffs WHERE approval_id = ? ORDER BY rowid",
      )
      .all(approvalId) as unknown as Signoff[];
  }

  // Records one approver's approval of a request that is still waiting and has
  // not expired, for the binding they were shown. The request becomes approved
  // once it has as many as it needs, and then has useWithinMs to be used, so a
  // request completed just before it expired is not lost to a slow look. Both
  // happen in one transaction, so approvals arriving together from the page and
  // the CLI are each counted once. Returns the request as it now stands.
  signOff(
    approvalId: number,
    approver: string,
    binding: string,
    useWithinMs: number,
  ): Approval {
    this.db.transaction((): void => {
      const row: ApprovalRow | undefined = this.db
        .prepare("SELECT * FROM approvals WHERE id = ?")
        .get(approvalId) as unknown as ApprovalRow | undefined;
      if (row === undefined || row.state !== "requested") {
        throw new Error("This approval request is no longer waiting for approval");
      }
      if (row.binding !== binding) {
        throw new Error("These are not the terms of the approval request");
      }
      const expiresAt: number = row.expires_at === null ? 0 : Date.parse(row.expires_at);
      if (!(expiresAt > Date.now())) {
        throw new Error("This approval request has expired. PayOnce opens a new one on its next look");
      }
      try {
        this.db
          .prepare(
            "INSERT INTO signoffs (approval_id, approver, binding, at) VALUES (?, ?, ?, ?)",
          )
          .run(approvalId, approver, binding, new Date().toISOString());
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          throw new Error(`${approver} has approved this already`);
        }
        throw error;
      }
      const signoffs: Signoff[] = this.signoffs(approvalId);
      if (signoffs.length >= row.needed) {
        const useBy: number = Math.max(expiresAt, Date.now() + useWithinMs);
        this.db
          .prepare(
            "UPDATE approvals SET state = 'approved', approver = ?, expires_at = ? WHERE id = ?",
          )
          .run(signersOf(signoffs), new Date(useBy).toISOString(), approvalId);
        // The next look is due now, so a watcher in another process uses the
        // approval on its next check and not when the look it had planned comes.
        this.db
          .prepare("UPDATE obligations SET look_at = ? WHERE invoice_id = ?")
          .run(new Date().toISOString(), row.invoice_id);
      }
    });
    const row: ApprovalRow = this.db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(approvalId) as unknown as ApprovalRow;
    return toApproval(row, this.signoffs(approvalId));
  }

  // Spends an approval on one replacement and opens its attempt, in one
  // transaction, so the money is counted as approved or as being sent at every
  // moment and never as neither. Undefined, with nothing changed, when it is no
  // longer approved, for example because another process voided it in the
  // meantime, or when it has expired since the look checked it. Also when the
  // invoice is no longer escalated, as when a person closed it, a person once
  // closed it without paying, a payout for it sent outside PayOnce is live, or
  // another payment for it is live at the bank.
  // Also when unchanged, run under the write lock, returns false. The attempt
  // keeps the approval, and the quote in its terms for a payment from another
  // currency's wallet.
  useApproval(
    invoiceId: string,
    approvalId: number,
    lease: Lease,
    unchanged: () => boolean,
    route: string | null = null,
  ): Attempt | undefined {
    return this.db.transaction((): Attempt | undefined => {
      if (!unchanged()) {
        return undefined;
      }
      const result: { changes: number | bigint } = this.db
        .prepare(
          `UPDATE approvals SET state = 'used'
            WHERE id = ? AND invoice_id = ? AND state = 'approved' AND expires_at > ?
              AND EXISTS (SELECT 1 FROM obligations WHERE invoice_id = ? AND state = 'escalated'
                AND rejected_by IS NULL)
              AND NOT EXISTS (${LIVE_OUTSIDE_PAYOUT}) AND NOT EXISTS (${LIVE_ATTEMPT})`,
        )
        .run(approvalId, invoiceId, new Date().toISOString(), invoiceId, invoiceId, invoiceId);
      if (Number(result.changes) !== 1) {
        return undefined;
      }
      return this.attempts.openAttempt(invoiceId, "replacement", lease, approvalId, null, route);
    }, opened);
  }

  setApprovalState(
    id: number,
    state: ApprovalState,
    approver: string | null = null,
  ): void {
    this.db
      .prepare(
        "UPDATE approvals SET state = ?, approver = COALESCE(?, approver) WHERE id = ?",
      )
      .run(state, approver, id);
  }

  voidOpenRunApprovals(runId: number): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE run_approvals SET state = 'void'
          WHERE run_id = ? AND state IN ('requested', 'approved')`,
      )
      .run(runId);
    return Number(result.changes) > 0;
  }

  // A new request voids any earlier one for the run that is still open. Only a
  // run still waiting gets one. False when none was opened.
  requestRunApproval(runId: number, request: ApprovalRequest): boolean {
    return this.db.transaction((): boolean => this.addRunApproval(runId, request));
  }

  // requestRunApproval inside a transaction the caller holds, such as the one
  // setRunRows opens, so a check's rows and its request are written together.
  addRunApproval(runId: number, request: ApprovalRequest): boolean {
    if (!this.db.isTransaction) {
      throw new Error("A run's request is opened only inside a ledger transaction");
    }
    this.voidOpenRunApprovals(runId);
    const result: { changes: number | bigint } = this.db
      .prepare(
        `INSERT INTO run_approvals
           (run_id, binding, terms, requested_at, expires_at, needed, needed_why)
         SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND state = 'waiting')`,
      )
      .run(
        runId,
        request.binding,
        request.terms,
        new Date().toISOString(),
        new Date(request.expiresAt).toISOString(),
        request.needed,
        request.neededWhy,
        runId,
      );
    return Number(result.changes) === 1;
  }

  private runSignoffs(approvalId: number): Signoff[] {
    return this.db
      .prepare(
        "SELECT approver, binding, at FROM run_signoffs WHERE approval_id = ? ORDER BY rowid",
      )
      .all(approvalId) as unknown as Signoff[];
  }

  private toRunApproval(row: RunApprovalRow): RunApproval {
    return {
      id: row.id,
      runId: row.run_id,
      binding: row.binding,
      terms: row.terms,
      state: row.state,
      approver: row.approver,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      needed: row.needed,
      neededWhy: row.needed_why,
      signoffs: this.runSignoffs(row.id),
    };
  }

  latestRunApproval(runId: number): RunApproval | undefined {
    const row: RunApprovalRow | undefined = this.db
      .prepare("SELECT * FROM run_approvals WHERE run_id = ? ORDER BY id DESC LIMIT 1")
      .get(runId) as unknown as RunApprovalRow | undefined;
    return row === undefined ? undefined : this.toRunApproval(row);
  }

  // Records one approver's approval of a run request that is still waiting and
  // has not expired, for the binding they were shown, as signOff does for an
  // invoice. Returns the request as it now stands.
  signOffRun(
    approvalId: number,
    approver: string,
    binding: string,
    useWithinMs: number,
  ): RunApproval {
    this.db.transaction((): void => {
      const row: RunApprovalRow | undefined = this.db
        .prepare("SELECT * FROM run_approvals WHERE id = ?")
        .get(approvalId) as unknown as RunApprovalRow | undefined;
      if (row === undefined || row.state !== "requested") {
        throw new Error("This approval request is no longer waiting for approval");
      }
      if (row.binding !== binding) {
        throw new Error("These are not the terms of the approval request");
      }
      const expiresAt: number = Date.parse(row.expires_at);
      if (!(expiresAt > Date.now())) {
        throw new Error("This approval request has expired. Check the run again to open a new one");
      }
      try {
        this.db
          .prepare(
            "INSERT INTO run_signoffs (approval_id, approver, binding, at) VALUES (?, ?, ?, ?)",
          )
          .run(approvalId, approver, binding, new Date().toISOString());
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          throw new Error(`${approver} has approved this already`);
        }
        throw error;
      }
      const signoffs: Signoff[] = this.runSignoffs(approvalId);
      if (signoffs.length >= row.needed) {
        const useBy: number = Math.max(expiresAt, Date.now() + useWithinMs);
        this.db
          .prepare(
            "UPDATE run_approvals SET state = 'approved', approver = ?, expires_at = ? WHERE id = ?",
          )
          .run(signersOf(signoffs), new Date(useBy).toISOString(), approvalId);
      }
    });
    const row: RunApprovalRow = this.db
      .prepare("SELECT * FROM run_approvals WHERE id = ?")
      .get(approvalId) as unknown as RunApprovalRow;
    return this.toRunApproval(row);
  }
}

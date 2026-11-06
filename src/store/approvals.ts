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

function toRunApproval(row: RunApprovalRow, signoffs: Signoff[]): RunApproval {
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
    signoffs,
  };
}

// What a request row holds that signing off reads.
interface RequestRow {
  id: number;
  binding: string;
  state: ApprovalState;
  expires_at: string | null;
  needed: number;
}

// What tells the invoices' requests from the pay runs'. Run approvals are kept
// apart from invoice approvals because a run has no invoice until it is
// released, so each has its tables, the column naming what a request is for,
// and open, the test a request opens only while, on the owner bound as its one
// parameter. kept are the columns a request keeps beside its terms, outside the
// binding. approved runs in the write transaction once a request has every
// signoff it needs.
interface RequestShape<Row extends RequestRow, Request> {
  requests: string;
  signoffs: string;
  owner: string;
  open: string;
  kept: { column: string; of: (request: ApprovalRequest) => string | null }[];
  expired: string;
  toRequest: (row: Row, signoffs: Signoff[]) => Request;
  approved?: (db: Db, row: Row) => void;
}

const INVOICE_REQUESTS: RequestShape<ApprovalRow, Approval> = {
  requests: "approvals",
  signoffs: "signoffs",
  owner: "invoice_id",
  // Only an invoice with a person gets one, so a request cannot land on an
  // invoice another process has just closed.
  open: "SELECT 1 FROM obligations WHERE invoice_id = ? AND state = 'escalated'",
  kept: [{ column: "route_key", of: (request: ApprovalRequest): string | null => request.routeKey ?? null }],
  expired: "This approval request has expired. PayOnce opens a new one on its next look",
  toRequest: toApproval,
  // The next look is due now, so a watcher in another process uses the
  // approval on its next check and not when the look it had planned comes.
  approved: (db: Db, row: ApprovalRow): void => {
    db.prepare("UPDATE obligations SET look_at = ? WHERE invoice_id = ?").run(new Date().toISOString(), row.invoice_id);
  },
};

const RUN_REQUESTS: RequestShape<RunApprovalRow, RunApproval> = {
  requests: "run_approvals",
  signoffs: "run_signoffs",
  owner: "run_id",
  // Only a run still waiting gets one.
  open: "SELECT 1 FROM runs WHERE id = ? AND state = 'waiting'",
  kept: [],
  expired: "This approval request has expired. Check the run again to open a new one",
  toRequest: toRunApproval,
};

// One owner's approval requests and their signoffs, for invoices and pay runs
// alike.
class RequestBook<Owner extends string | number, Row extends RequestRow, Request> {
  private readonly db: Db;
  private readonly shape: RequestShape<Row, Request>;

  constructor(db: Db, shape: RequestShape<Row, Request>) {
    this.db = db;
    this.shape = shape;
  }

  // Voids a request or approval that is still open. False when there was none.
  void(owner: Owner): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        `UPDATE ${this.shape.requests} SET state = 'void'
          WHERE ${this.shape.owner} = ? AND state IN ('requested', 'approved')`,
      )
      .run(owner);
    return Number(result.changes) > 0;
  }

  // A new request voids any earlier one that is still open. The caller holds the
  // write transaction. False when none was opened.
  add(owner: Owner, request: ApprovalRequest): boolean {
    this.void(owner);
    const columns: string[] = [
      this.shape.owner,
      "binding",
      "terms",
      "requested_at",
      "expires_at",
      "needed",
      "needed_why",
      ...this.shape.kept.map((kept: { column: string }): string => kept.column),
    ];
    const result: { changes: number | bigint } = this.db
      .prepare(
        `INSERT INTO ${this.shape.requests}
           (${columns.join(", ")})
         SELECT ${columns.map((): string => "?").join(", ")}
          WHERE EXISTS (${this.shape.open})`,
      )
      .run(
        owner,
        request.binding,
        request.terms,
        new Date().toISOString(),
        new Date(request.expiresAt).toISOString(),
        request.needed,
        request.neededWhy,
        ...this.shape.kept.map((kept: { of: (request: ApprovalRequest) => string | null }): string | null =>
          kept.of(request),
        ),
        owner,
      );
    return Number(result.changes) === 1;
  }

  latest(owner: Owner): Request | undefined {
    const row: Row | undefined = this.db
      .prepare(`SELECT * FROM ${this.shape.requests} WHERE ${this.shape.owner} = ? ORDER BY id DESC LIMIT 1`)
      .get(owner) as unknown as Row | undefined;
    return row === undefined ? undefined : this.shape.toRequest(row, this.signoffs(row.id));
  }

  // Oldest first.
  all(owner: Owner): Request[] {
    return (
      this.db
        .prepare(`SELECT * FROM ${this.shape.requests} WHERE ${this.shape.owner} = ? ORDER BY id`)
        .all(owner) as unknown as Row[]
    ).map((row: Row): Request => this.shape.toRequest(row, this.signoffs(row.id)));
  }

  byId(id: number): Request | undefined {
    const row: Row | undefined = this.db
      .prepare(`SELECT * FROM ${this.shape.requests} WHERE id = ?`)
      .get(id) as unknown as Row | undefined;
    return row === undefined ? undefined : this.shape.toRequest(row, this.signoffs(row.id));
  }

  private signoffs(approvalId: number): Signoff[] {
    return this.db
      .prepare(`SELECT approver, binding, at FROM ${this.shape.signoffs} WHERE approval_id = ? ORDER BY rowid`)
      .all(approvalId) as unknown as Signoff[];
  }

  // Records one approver's approval of a request that is still waiting and has
  // not expired, for the binding they were shown. The request becomes approved
  // once it has as many as it needs, and then has useWithinMs to be used, so a
  // request completed just before it expired is not lost to a slow look. Both
  // happen in one transaction, so approvals arriving together from the page and
  // the CLI are each counted once. Returns the request as it now stands.
  signOff(approvalId: number, approver: string, binding: string, useWithinMs: number): Request {
    this.db.transaction((): void => {
      const row: Row | undefined = this.db
        .prepare(`SELECT * FROM ${this.shape.requests} WHERE id = ?`)
        .get(approvalId) as unknown as Row | undefined;
      if (row === undefined || row.state !== "requested") {
        throw new Error("This approval request is no longer waiting for approval");
      }
      if (row.binding !== binding) {
        throw new Error("These are not the terms of the approval request");
      }
      const expiresAt: number = row.expires_at === null ? 0 : Date.parse(row.expires_at);
      if (!(expiresAt > Date.now())) {
        throw new Error(this.shape.expired);
      }
      try {
        this.db
          .prepare(`INSERT INTO ${this.shape.signoffs} (approval_id, approver, binding, at) VALUES (?, ?, ?, ?)`)
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
          .prepare(`UPDATE ${this.shape.requests} SET state = 'approved', approver = ?, expires_at = ? WHERE id = ?`)
          .run(signersOf(signoffs), new Date(useBy).toISOString(), approvalId);
        this.shape.approved?.(this.db, row);
      }
    });
    const row: Row = this.db
      .prepare(`SELECT * FROM ${this.shape.requests} WHERE id = ?`)
      .get(approvalId) as unknown as Row;
    return this.shape.toRequest(row, this.signoffs(approvalId));
  }
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
  private readonly invoiceRequests: RequestBook<string, ApprovalRow, Approval>;
  private readonly runRequests: RequestBook<number, RunApprovalRow, RunApproval>;

  constructor(db: Db, attempts: AttemptStore) {
    this.db = db;
    this.attempts = attempts;
    this.invoiceRequests = new RequestBook<string, ApprovalRow, Approval>(db, INVOICE_REQUESTS);
    this.runRequests = new RequestBook<number, RunApprovalRow, RunApproval>(db, RUN_REQUESTS);
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
    return this.invoiceRequests.void(invoiceId);
  }

  // A new request voids any earlier one for the invoice that is still open. Only
  // an invoice with a person gets one, so a request cannot land on an invoice
  // another process has just closed. False when none was opened.
  requestApproval(invoiceId: string, request: ApprovalRequest): boolean {
    return this.db.transaction((): boolean => this.invoiceRequests.add(invoiceId, request));
  }

  latestApproval(invoiceId: string): Approval | undefined {
    return this.invoiceRequests.latest(invoiceId);
  }

  // Every approval request for the invoice, oldest first.
  approvalsFor(invoiceId: string): Approval[] {
    return this.invoiceRequests.all(invoiceId);
  }

  approval(id: number): Approval | undefined {
    return this.invoiceRequests.byId(id);
  }

  // The approval an attempt was opened on. An attempt no approval released, or one
  // from before the column, has the latest.
  approvalOf(attempt: Pick<Attempt, "approvalId" | "invoiceId">): Approval | undefined {
    return attempt.approvalId === null
      ? this.latestApproval(attempt.invoiceId)
      : this.approval(attempt.approvalId);
  }

  // Once the request has every signoff it needs, the invoice's next look is due
  // now (RequestBook.signOff).
  signOff(
    approvalId: number,
    approver: string,
    binding: string,
    useWithinMs: number,
  ): Approval {
    return this.invoiceRequests.signOff(approvalId, approver, binding, useWithinMs);
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
    return this.runRequests.void(runId);
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
    return this.runRequests.add(runId, request);
  }

  latestRunApproval(runId: number): RunApproval | undefined {
    return this.runRequests.latest(runId);
  }

  // Every request for the run, oldest first.
  runApprovalsFor(runId: number): RunApproval[] {
    return this.runRequests.all(runId);
  }

  signOffRun(
    approvalId: number,
    approver: string,
    binding: string,
    useWithinMs: number,
  ): RunApproval {
    return this.runRequests.signOff(approvalId, approver, binding, useWithinMs);
  }
}

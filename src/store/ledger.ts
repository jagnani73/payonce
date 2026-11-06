import type { TransferBankDetails } from "../airwallex/transfers.js";
import type { ArrivalTerms } from "../domain/arrival.js";
import type { Debit } from "../domain/assess.js";
import type { Reason, StoredReason } from "../domain/reasons.js";
import type { SupplierEmail } from "../reader/emails.js";
import { AlertStore, type Alert, type AlertFinish, type FoundCondition, type RecordedConditions } from "./alerts.js";
import {
  ApprovalStore,
  type Approval,
  type ApprovalRequest,
  type ApprovalState,
  type RunApproval,
} from "./approvals.js";
import {
  AttemptStore,
  type Attempt,
  type AttemptKind,
  type AttemptState,
  type CashAttempt,
  type LastPaid,
} from "./attempts.js";
import type { AuditSnapshot, ChainedEvent, LedgerReport, RunAuditSnapshot } from "./audit-trail.js";
import { BankChangeStore, type BankChange, type BankChangeState, type NewBankChange } from "./bank-changes.js";
import { CloseStore } from "./closes.js";
import { Db } from "./db.js";
import { DraftStore, type Draft, type DraftMove, type DraftState, type NewDraft } from "./drafts.js";
import { EmailStore } from "./emails.js";
import { InboxStore, type DeliverResult, type InboxWaiting, type NewUpload, type Upload } from "./inbox.js";
import {
  InvoiceStore,
  type CashObligation,
  type NewObligation,
  type Obligation,
  type ObligationState,
  type ScannedObligation,
  type TransferMethod,
} from "./invoices.js";
import { LockStore, type Lease } from "./locks.js";
import {
  OutageStore,
  type NewRailFailure,
  type Outage,
  type OutageCount,
  type OutageHold,
  type OutageHoldKind,
  type OutageSubject,
  type OutageSubjectHeld,
  type RailFailure,
  type StandingLine,
} from "./outages.js";
import { PayoutStore, type FoundPayout, type OutsidePayout, type PayoutMoney, type PayoutState } from "./payouts.js";
import { MetricsReads, type MetricsRead } from "./read/metrics.js";
import { SearchReads, type SearchRead } from "./read/search.js";
import { SupplierReads, type SupplierLinks, type SupplierListRead, type SupplierRead } from "./read/suppliers.js";
import { ReconStore } from "./recon-store.js";
import {
  RunStore,
  type CheckedRow,
  type NewRun,
  type PayRunRow,
  type ReleasedRun,
  type ReleaseRow,
  type Run,
  type RunRow,
} from "./runs.js";
import { Schema } from "./schema.js";
import { Timelines, type EventKind, type LedgerEvent } from "./timeline.js";
import { WebhookEventStore } from "./webhook-events.js";

export type { Alert, AlertFinish, AlertState, FoundCondition, RecordedConditions } from "./alerts.js";
export { expiryOf, isExpired, signersOf } from "./approvals.js";
export type { Approval, ApprovalRequest, ApprovalState, RunApproval, Signoff } from "./approvals.js";
export {
  DuplicatePaymentError,
  holdsAccount,
  lateBesideLive,
  liveAtBank,
  mismatchedLive,
  ownLive,
  withBank,
} from "./attempts.js";
export type {
  AccountRef,
  Attempt,
  AttemptKind,
  AttemptQuote,
  AttemptState,
  CashAttempt,
  LastPaid,
  LiveTested,
} from "./attempts.js";
export type { BankChange, BankChangeState, NewBankChange } from "./bank-changes.js";
export { LEDGER_PATH, readingSoft, storedList, storedObject, storedStrings } from "./db.js";
export { DraftOpenError } from "./drafts.js";
export type { Draft, DraftMove, DraftState, NewDraft } from "./drafts.js";
export { DuplicateUploadError } from "./inbox.js";
export type { DeliverResult, InboxWaiting, NewUpload, Upload, UploadState } from "./inbox.js";
export { alreadyInLedger, crossCurrency, INVOICE_ID_PATTERN } from "./invoices.js";
export type {
  CashObligation,
  NewObligation,
  Obligation,
  ObligationOrigin,
  ObligationState,
  ScannedObligation,
  TransferMethod,
} from "./invoices.js";
export { LeaseLostError } from "./locks.js";
export type { Lease } from "./locks.js";
export { RailOutageError } from "./outages.js";
export type {
  FailureSeenBy,
  NewRailFailure,
  Outage,
  OutageCount,
  OutageHold,
  OutageHoldKind,
  OutageState,
  OutageSubject,
  OutageSubjectHeld,
  RailFailure,
  StandingLine,
} from "./outages.js";
export { payoutPays, payoutVerdict } from "./payouts.js";
export type { FoundPayout, OutsidePayout, PayoutMoney, PayoutState } from "./payouts.js";
export type {
  MetricsAttempt,
  MetricsObligation,
  MetricsOutage,
  MetricsPayout,
  MetricsRead,
  MetricsRequest,
} from "./read/metrics.js";
export type { SearchRead } from "./read/search.js";
export type {
  SupplierApproval,
  SupplierAttempt,
  SupplierCallback,
  SupplierDraft,
  SupplierEmailFacts,
  SupplierFailure,
  SupplierFindings,
  SupplierHold,
  SupplierLinks,
  SupplierListRead,
  SupplierObligation,
  SupplierPayment,
  SupplierPayout,
  SupplierPayoutView,
  SupplierRead,
  SupplierRunRow,
} from "./read/suppliers.js";
export { NothingToPayError, SameFileError, skipRow, WaitingRunError } from "./runs.js";
export type {
  CheckedRow,
  NewRun,
  PayRunRow,
  ReleasedRun,
  ReleaseRow,
  Run,
  RunRow,
  RunRowAction,
  RunRowState,
  RunState,
} from "./runs.js";
export type { EventKind, LedgerEvent } from "./timeline.js";

interface Repositories {
  db: Db;
  bankChanges: BankChangeStore;
  schema: Schema;
  timelines: Timelines;
  invoices: InvoiceStore;
  outages: OutageStore;
  locks: LockStore;
  attempts: AttemptStore;
  payouts: PayoutStore;
  approvals: ApprovalStore;
  closes: CloseStore;
  emails: EmailStore;
  inbox: InboxStore;
  runs: RunStore;
  alerts: AlertStore;
  drafts: DraftStore;
  webhookEvents: WebhookEventStore;
  suppliers: SupplierReads;
  metrics: MetricsReads;
  search: SearchReads;
}

// The ledger as the rest of PayOnce sees it. Each method hands over to the
// store that owns its tables, all on one connection.
export class Ledger {
  private readonly repos: Repositories;
  private readonly reconStore: ReconStore;

  // readOnly opens an existing file as it is, without creating or upgrading it,
  // so a check cannot change what it checks.
  constructor(path: string, readOnly: boolean = false) {
    const db: Db = new Db(path, readOnly);
    this.reconStore = new ReconStore(db);
    const bankChanges: BankChangeStore = new BankChangeStore(db);
    const schema: Schema = new Schema(db, bankChanges);
    const timelines: Timelines = new Timelines(db, schema);
    const invoices: InvoiceStore = new InvoiceStore(db, timelines);
    const outages: OutageStore = new OutageStore(db, invoices, timelines);
    const locks: LockStore = new LockStore(db);
    const attempts: AttemptStore = new AttemptStore(db, invoices, outages, locks);
    const payouts: PayoutStore = new PayoutStore(db, invoices, attempts, timelines);
    const approvals: ApprovalStore = new ApprovalStore(db, attempts);
    const closes: CloseStore = new CloseStore(db, attempts, payouts, approvals);
    const emails: EmailStore = new EmailStore(db);
    const inbox: InboxStore = new InboxStore(db, invoices);
    const runs: RunStore = new RunStore(db, invoices, outages, locks, timelines, approvals);
    const alerts: AlertStore = new AlertStore(db);
    const drafts: DraftStore = new DraftStore(db, timelines);
    const webhookEvents: WebhookEventStore = new WebhookEventStore(db);
    const suppliers: SupplierReads = new SupplierReads(db, invoices, bankChanges);
    const metrics: MetricsReads = new MetricsReads(db);
    const search: SearchReads = new SearchReads(db);
    this.repos = {
      db,
      bankChanges,
      schema,
      timelines,
      invoices,
      outages,
      locks,
      attempts,
      payouts,
      approvals,
      closes,
      emails,
      inbox,
      runs,
      alerts,
      drafts,
      webhookEvents,
      suppliers,
      metrics,
      search,
    };
    if (readOnly) {
      return;
    }
    schema.create();
    timelines.startChain();
    timelines.startRunChain();
    this.reconStore.ensure();
  }

  close(): void {
    this.repos.db.close();
  }

  // Reconciliation's tables and chain, on this connection. It reads the ledger's
  // own tables only to match transfers, and writes none of them.
  recon(): ReconStore {
    return this.reconStore;
  }

  accountRoutes(): Map<string, string> {
    return this.repos.bankChanges.accountRoutes();
  }

  chainStarted(): boolean {
    return this.repos.timelines.chainStarted();
  }

  runChainStarted(): boolean {
    return this.repos.timelines.runChainStarted();
  }

  hasRunTable(): boolean {
    return this.repos.schema.hasRunTable();
  }

  hasRunLines(): boolean {
    return this.repos.timelines.hasRunLines();
  }

  schemaGaps(): string[] {
    return this.repos.schema.schemaGaps();
  }

  startedAt(): string {
    return this.repos.db.startedAt();
  }

  outagesSince(): string {
    return this.repos.outages.outagesSince();
  }

  activeOutage(currency: string, method: string): Outage | undefined {
    return this.repos.outages.activeOutage(currency, method);
  }

  outage(id: number): Outage | undefined {
    return this.repos.outages.outage(id);
  }

  outages(): Outage[] {
    return this.repos.outages.outages();
  }

  outageHolds(outageId: number): OutageHold[] {
    return this.repos.outages.outageHolds(outageId);
  }

  railFailure(transferId: string): RailFailure | undefined {
    return this.repos.outages.railFailure(transferId);
  }

  recordRailFailure(
    failure: NewRailFailure,
    count: OutageCount,
    line: (outage: Outage, counted: RailFailure[]) => string,
  ): Outage | undefined {
    return this.repos.outages.recordRailFailure(failure, count, line);
  }

  holdForOutage(
    outageId: number,
    subject: OutageSubject,
    what: OutageHoldKind,
    line: string,
    standing: StandingLine | null = null,
  ): boolean {
    return this.repos.outages.holdForOutage(outageId, subject, what, line, standing);
  }

  endOutage(
    id: number,
    endedBy: string,
    note: string,
    invoiceLine: (outage: Outage, state: ObligationState | null) => string,
    runLine: (outage: Outage) => string,
    listed: (outage: Outage) => OutageSubjectHeld[] = (): OutageSubjectHeld[] => [],
  ): OutageHold[] | undefined {
    return this.repos.outages.endOutage(id, endedBy, note, invoiceLine, runLine, listed);
  }

  openObligation(input: NewObligation): Obligation {
    return this.repos.invoices.openObligation(input);
  }

  obligation(invoiceId: string): Obligation | undefined {
    return this.repos.invoices.obligation(invoiceId);
  }

  obligations(): Obligation[] {
    return this.repos.invoices.obligations();
  }

  openObligations(): Obligation[] {
    return this.repos.invoices.openObligations();
  }

  obligationsFor(beneficiaryId: string): Obligation[] {
    return this.repos.invoices.obligationsFor(beneficiaryId);
  }

  addEvent(
    invoiceId: string,
    kind: EventKind,
    message: string,
    topic: string | null = null,
  ): void {
    this.repos.timelines.addEvent(invoiceId, kind, message, topic);
  }

  transaction<T>(fn: () => T): T {
    return this.repos.db.transaction(fn);
  }

  readSnapshot<T>(fn: () => T): T {
    return this.repos.db.readSnapshot(fn);
  }

  changeStamp(): string {
    return this.repos.db.changeStamp();
  }

  metricsRead(): MetricsRead {
    return this.repos.metrics.metricsRead();
  }

  auditSnapshot(invoiceId: string | null): AuditSnapshot {
    return this.repos.timelines.auditSnapshot(invoiceId);
  }

  events(invoiceId: string): LedgerEvent[] {
    return this.repos.timelines.events(invoiceId);
  }

  unlinedInvoices(): string[] {
    return this.repos.timelines.unlinedInvoices();
  }

  unlinedRuns(): number[] {
    return this.repos.timelines.unlinedRuns();
  }

  firstEvent(invoiceId: string): LedgerEvent | undefined {
    return this.repos.timelines.firstEvent(invoiceId);
  }

  chainedEvents(invoiceId: string): ChainedEvent[] {
    return this.repos.timelines.chainedEvents(invoiceId);
  }

  headlines(): Map<string, string> {
    return this.repos.timelines.headlines();
  }

  runIdsByInvoice(): Map<string, number> {
    return this.repos.runs.runIdsByInvoice();
  }

  attemptsMaybeWithBank(): Attempt[] {
    return this.repos.attempts.attemptsMaybeWithBank();
  }

  invoicesWithPayoutInFlight(): Set<string> {
    return this.repos.payouts.invoicesWithPayoutInFlight();
  }

  runningHashCheck(now: number = Date.now()): LedgerReport {
    return this.repos.timelines.runningHashCheck(now);
  }

  openAttempt(
    invoiceId: string,
    kind: AttemptKind,
    lease: Lease,
    released: number | null,
    decided: string | null,
    route: string | null = null,
  ): Attempt {
    return this.repos.attempts.openAttempt(invoiceId, kind, lease, released, decided, route);
  }

  tryLock(invoiceId: string): void {
    this.repos.attempts.tryLock(invoiceId);
  }

  attempts(invoiceId: string): Attempt[] {
    return this.repos.attempts.attempts(invoiceId);
  }

  committedRead(): { obligations: CashObligation[]; attempts: Map<string, CashAttempt[]> } {
    return this.repos.attempts.committedRead();
  }

  scannedObligations(): ScannedObligation[] {
    return this.repos.invoices.scannedObligations();
  }

  attemptOf(requestId: string, transferId: string): Attempt | undefined {
    return this.repos.attempts.attemptOf(requestId, transferId);
  }

  adoptPayout(
    input: NewObligation,
    payoutReference: string | null,
    found: FoundPayout,
    line: string,
  ): void {
    this.repos.payouts.adoptPayout(input, payoutReference, found, line);
  }

  obligationForReference(reference: string): Obligation | undefined {
    return this.repos.invoices.obligationForReference(reference);
  }

  linkOutsidePayout(invoiceId: string, payout: OutsidePayout, reopen: Reason | null = null): boolean {
    return this.repos.payouts.linkOutsidePayout(invoiceId, payout, reopen);
  }

  lookNow(invoiceId: string): void {
    this.repos.invoices.lookNow(invoiceId);
  }

  outsidePayouts(invoiceId: string): OutsidePayout[] {
    return this.repos.payouts.outsidePayouts(invoiceId);
  }

  payingPayouts(invoiceId: string): { pays: OutsidePayout[]; namesOnly: OutsidePayout[] } {
    return this.repos.payouts.payingPayouts(invoiceId);
  }

  recordOutsidePayout(transferId: string, state: PayoutState, money: PayoutMoney): void {
    this.repos.payouts.recordOutsidePayout(transferId, state, money);
  }

  setPayoutVerdict(transferId: string, pays: boolean): void {
    this.repos.payouts.setPayoutVerdict(transferId, pays);
  }

  outsideInvoiceOf(transferId: string): string | undefined {
    return this.repos.payouts.outsideInvoiceOf(transferId);
  }

  knowsTransfer(requestId: string, transferId: string): boolean {
    return this.repos.payouts.knowsTransfer(requestId, transferId);
  }

  lookAt(invoiceId: string, at: number | null): void {
    this.repos.invoices.lookAt(invoiceId, at);
  }

  postponeDueLook(invoiceId: string, now: number, until: number): void {
    this.repos.invoices.postponeDueLook(invoiceId, now, until);
  }

  nextCheckAt(invoiceId: string): string | null {
    return this.repos.invoices.nextCheckAt(invoiceId);
  }

  lookPlanned(invoiceId: string, now: number): boolean {
    return this.repos.invoices.lookPlanned(invoiceId, now);
  }

  dueLooks(now: number): string[] {
    return this.repos.invoices.dueLooks(now);
  }

  firstDelivery(eventId: string, name: string): boolean {
    return this.repos.webhookEvents.firstDelivery(eventId, name);
  }

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
    this.repos.attempts.record(
      requestId,
      transferId,
      reference,
      state,
      failureCode,
      feeMinor,
      feeCurrency,
      amountMinor,
      currency,
      bankCreatedAt,
      bankStatus,
    );
  }

  recordSentTo(requestId: string, sentKey: string | null, sentRoute: string | null, sentEnding: string | null): void {
    this.repos.attempts.recordSentTo(requestId, sentKey, sentRoute, sentEnding);
  }

  foundLate(requestId: string, at: number): boolean {
    return this.repos.attempts.foundLate(requestId, at);
  }

  failedWithoutFee(limit: number, triedBefore: number): string[] {
    return this.repos.attempts.failedWithoutFee(limit, triedBefore);
  }

  feeTried(transferId: string, at: number): void {
    this.repos.attempts.feeTried(transferId, at);
  }

  recordFee(transferId: string, feeMinor: number, feeCurrency: string): void {
    this.repos.attempts.recordFee(transferId, feeMinor, feeCurrency);
  }

  latestFee(currency: string, method: TransferMethod): number | null {
    return this.repos.attempts.latestFee(currency, method);
  }

  markRateMismatch(requestId: string, reason: string): void {
    this.repos.attempts.markRateMismatch(requestId, reason);
  }

  tried(requestId: string, at: number): void {
    this.repos.attempts.tried(requestId, at);
  }

  failAttempt(requestId: string, failureCode: string | null, refused: boolean): boolean {
    return this.repos.attempts.failAttempt(requestId, failureCode, refused);
  }

  reasonOf(obligation: Pick<Obligation, "invoiceId" | "escalationReason">): StoredReason | null {
    return this.repos.invoices.reasonOf(obligation);
  }

  escalate(invoiceId: string, reason: StoredReason | null): void {
    this.repos.invoices.escalate(invoiceId, reason);
  }

  rewordEscalation(invoiceId: string, from: StoredReason | null, to: StoredReason): boolean {
    return this.repos.invoices.rewordEscalation(invoiceId, from, to);
  }

  holdBeforePaying(invoiceId: string, duplicateOf: string[], reason: Reason): void {
    this.repos.invoices.holdBeforePaying(invoiceId, duplicateOf, reason);
  }

  releaseFor(
    invoiceId: string,
    approvalId: number,
    lease: Lease,
    unchanged: () => boolean,
    route: string | null = null,
  ): Attempt | undefined {
    return this.repos.approvals.releaseFor(invoiceId, approvalId, lease, unchanged, route);
  }

  setDuplicateOf(invoiceId: string, duplicateOf: string[]): void {
    this.repos.invoices.setDuplicateOf(invoiceId, duplicateOf);
  }

  saveQuote(invoiceId: string, quote: string): void {
    this.repos.invoices.saveQuote(invoiceId, quote);
  }

  lastQuote(invoiceId: string): string | undefined {
    return this.repos.invoices.lastQuote(invoiceId);
  }

  reject(invoiceId: string, rejectedBy: string, covered: string[] = []): boolean {
    return this.repos.closes.reject(invoiceId, rejectedBy, covered);
  }

  rejectAgain(invoiceId: string, byPerson: boolean = false, covered: string[] = []): boolean {
    return this.repos.closes.rejectAgain(invoiceId, byPerson, covered);
  }

  addMismatched(
    requestId: string,
    transferId: string,
    reference: string,
    status: string | null,
    debit: Debit | null,
    reason: Reason,
  ): boolean {
    return this.repos.attempts.addMismatched(requestId, transferId, reference, status, debit, reason);
  }

  setMismatchedStatus(transferId: string, status: string, debit: Debit | null = null): boolean {
    return this.repos.attempts.setMismatchedStatus(transferId, status, debit);
  }

  escalateIfOpen(invoiceId: string, reason: Reason): boolean {
    return this.repos.invoices.escalateIfOpen(invoiceId, reason);
  }

  escalateUnlessSettled(invoiceId: string, reason: Reason): void {
    this.repos.invoices.escalateUnlessSettled(invoiceId, reason);
  }

  addEmails(invoiceId: string, emails: SupplierEmail[]): void {
    this.repos.emails.addEmails(invoiceId, emails);
  }

  emails(invoiceId: string): SupplierEmail[] {
    return this.repos.emails.emails(invoiceId);
  }

  emailCount(invoiceId: string): number {
    return this.repos.emails.emailCount(invoiceId);
  }

  addUpload(input: NewUpload): Upload {
    return this.repos.inbox.addUpload(input);
  }

  upload(id: number): Upload | undefined {
    return this.repos.inbox.upload(id);
  }

  uploads(others: number): Upload[] {
    return this.repos.inbox.uploads(others);
  }

  inboxWaiting(): InboxWaiting {
    return this.repos.inbox.inboxWaiting();
  }

  sameMessageId(upload: Upload): number[] {
    return this.repos.inbox.sameMessageId(upload);
  }

  deliverUpload(id: number, invoiceId: string, deliveredBy: string): DeliverResult {
    return this.repos.inbox.deliverUpload(id, invoiceId, deliveredBy);
  }

  dismissUpload(id: number, dismissedBy: string, note: string): boolean {
    return this.repos.inbox.dismissUpload(id, dismissedBy, note);
  }

  saveFindings(invoiceId: string, findings: string): void {
    this.repos.emails.saveFindings(invoiceId, findings);
  }

  findings(invoiceId: string): string | undefined {
    return this.repos.emails.findings(invoiceId);
  }

  voidOpenApprovals(invoiceId: string): boolean {
    return this.repos.approvals.voidOpenApprovals(invoiceId);
  }

  requestApproval(invoiceId: string, request: ApprovalRequest): boolean {
    return this.repos.approvals.requestApproval(invoiceId, request);
  }

  latestApproval(invoiceId: string): Approval | undefined {
    return this.repos.approvals.latestApproval(invoiceId);
  }

  approvalsFor(invoiceId: string): Approval[] {
    return this.repos.approvals.approvalsFor(invoiceId);
  }

  approval(id: number): Approval | undefined {
    return this.repos.approvals.approval(id);
  }

  approvalOf(attempt: Pick<Attempt, "approvalId" | "invoiceId">): Approval | undefined {
    return this.repos.approvals.approvalOf(attempt);
  }

  signOff(
    approvalId: number,
    approver: string,
    binding: string,
    useWithinMs: number,
  ): Approval {
    return this.repos.approvals.signOff(approvalId, approver, binding, useWithinMs);
  }

  useApproval(
    invoiceId: string,
    approvalId: number,
    lease: Lease,
    unchanged: () => boolean,
    route: string | null = null,
  ): Attempt | undefined {
    return this.repos.approvals.useApproval(invoiceId, approvalId, lease, unchanged, route);
  }

  setApprovalState(
    id: number,
    state: ApprovalState,
    approver: string | null = null,
  ): void {
    this.repos.approvals.setApprovalState(id, state, approver);
  }

  addBankChange(input: NewBankChange): number {
    return this.repos.bankChanges.addBankChange(input);
  }

  finishBankChange(id: number, state: BankChangeState, appliedKey: string | null): void {
    this.repos.bankChanges.finishBankChange(id, state, appliedKey);
  }

  verifiedBankChange(beneficiaryId: string, details: TransferBankDetails): BankChange | undefined {
    return this.repos.bankChanges.verifiedBankChange(beneficiaryId, details);
  }

  bankChangeRecorders(beneficiaryId: string, detailsKey: string): string[] {
    return this.repos.bankChanges.bankChangeRecorders(beneficiaryId, detailsKey);
  }

  callbackRecorders(invoiceId: string): string[] {
    return this.repos.bankChanges.callbackRecorders(invoiceId);
  }

  appliedKeys(beneficiaryId: string): string[] {
    return this.repos.bankChanges.appliedKeys(beneficiaryId);
  }

  paidOnce(invoiceId: string): boolean {
    return this.repos.closes.paidOnce(invoiceId);
  }

  paidMismatched(invoiceId: string): boolean {
    return this.repos.closes.paidMismatched(invoiceId);
  }

  paidOutside(invoiceId: string): boolean {
    return this.repos.closes.paidOutside(invoiceId);
  }

  settle(
    invoiceId: string,
    byPerson: boolean = false,
    from: ObligationState | null = null,
    covered: string[] = [],
  ): boolean {
    return this.repos.closes.settle(invoiceId, byPerson, from, covered);
  }

  markMisdirected(requestId: string): void {
    this.repos.attempts.markMisdirected(requestId);
  }

  lastPaidTransfer(beneficiaryId: string): LastPaid | undefined {
    return this.repos.attempts.lastPaidTransfer(beneficiaryId);
  }

  paidOnApproval(beneficiaryId: string): boolean {
    return this.repos.attempts.paidOnApproval(beneficiaryId);
  }

  lastPaidUnchecked(beneficiaryId: string): { transferId: string; reference: string | null } | undefined {
    return this.repos.attempts.lastPaidUnchecked(beneficiaryId);
  }

  bankChange(id: number): BankChange | undefined {
    return this.repos.bankChanges.bankChange(id);
  }

  supplierListRead(): SupplierListRead {
    return this.repos.suppliers.supplierListRead();
  }

  supplierRead(beneficiaryId: string): SupplierRead {
    return this.repos.suppliers.supplierRead(beneficiaryId);
  }

  supplierNamed(beneficiaryId: string): boolean {
    return this.repos.suppliers.supplierNamed(beneficiaryId);
  }

  supplierLinks(except: string): SupplierLinks {
    return this.repos.suppliers.supplierLinks(except);
  }

  search(q: string, limit: number): SearchRead {
    return this.repos.search.search(q, limit);
  }

  knownNames(limit: number): string[] {
    return this.repos.search.knownNames(limit);
  }

  run(id: number): Run | undefined {
    return this.repos.runs.run(id);
  }

  runs(): Run[] {
    return this.repos.runs.runs();
  }

  waitingRun(): Run | undefined {
    return this.repos.runs.waitingRun();
  }

  liveRunForFile(fileHash: string): Run | undefined {
    return this.repos.runs.liveRunForFile(fileHash);
  }

  runRows(runId: number): RunRow[] {
    return this.repos.runs.runRows(runId);
  }

  runRow(id: number): RunRow | undefined {
    return this.repos.runs.runRow(id);
  }

  runRowOf(invoiceId: string): RunRow | undefined {
    return this.repos.runs.runRowOf(invoiceId);
  }

  waitingRunRow(invoiceId: string): RunRow | undefined {
    return this.repos.runs.waitingRunRow(invoiceId);
  }

  createRun(input: NewRun, rows: CheckedRow[]): number {
    return this.repos.runs.createRun(input, rows);
  }

  setRunRows<T>(
    runId: number,
    rows: CheckedRow[],
    cash: string,
    voiding: number | null,
    settle: () => T,
  ): T | undefined {
    return this.repos.runs.setRunRows(runId, rows, cash, voiding, settle);
  }

  setRunArrivals(runId: number, rows: CheckedRow[]): void {
    this.repos.runs.setRunArrivals(runId, rows);
  }

  cancelRun(runId: number, cancelledBy: string, note: string): boolean {
    return this.repos.runs.cancelRun(runId, cancelledBy, note);
  }

  releaseRun(
    runId: number,
    approvalId: number,
    uploadedBy: string,
    rows: ReleaseRow[],
    runLine: string,
    leases: Lease[],
  ): ReleasedRun | undefined {
    return this.repos.runs.releaseRun(runId, approvalId, uploadedBy, rows, runLine, leases);
  }

  addRunEvent(runId: number, kind: EventKind, message: string, topic: string | null = null): void {
    this.repos.timelines.addRunEvent(runId, kind, message, topic);
  }

  runAuditSnapshot(runId: number | null): RunAuditSnapshot {
    return this.repos.timelines.runAuditSnapshot(runId);
  }

  runEvents(runId: number): LedgerEvent[] {
    return this.repos.timelines.runEvents(runId);
  }

  voidOpenRunApprovals(runId: number): boolean {
    return this.repos.approvals.voidOpenRunApprovals(runId);
  }

  requestRunApproval(runId: number, request: ApprovalRequest): boolean {
    return this.repos.approvals.requestRunApproval(runId, request);
  }

  addRunApproval(runId: number, request: ApprovalRequest): boolean {
    return this.repos.approvals.addRunApproval(runId, request);
  }

  latestRunApproval(runId: number): RunApproval | undefined {
    return this.repos.approvals.latestRunApproval(runId);
  }

  runApprovalsFor(runId: number): RunApproval[] {
    return this.repos.approvals.runApprovalsFor(runId);
  }

  signOffRun(
    approvalId: number,
    approver: string,
    binding: string,
    useWithinMs: number,
  ): RunApproval {
    return this.repos.approvals.signOffRun(approvalId, approver, binding, useWithinMs);
  }

  approvedRuns(): number[] {
    return this.repos.runs.approvedRuns();
  }

  unsentRunInvoices(): { invoiceId: string; runId: number }[] {
    return this.repos.runs.unsentRunInvoices();
  }

  payRunRows(now: number = Date.now()): PayRunRow[] {
    return this.repos.runs.payRunRows(now);
  }

  takeCurrencyLock(currency: string, holder: string, until: number): boolean {
    return this.repos.locks.takeCurrencyLock(currency, holder, until);
  }

  leaveCurrencyQueue(currency: string, holder: string): void {
    this.repos.locks.leaveCurrencyQueue(currency, holder);
  }

  renewCurrencyLock(currency: string, holder: string, until: number): boolean {
    return this.repos.locks.renewCurrencyLock(currency, holder, until);
  }

  releaseCurrencyLock(currency: string, holder: string): void {
    this.repos.locks.releaseCurrencyLock(currency, holder);
  }

  recordConditions(
    found: FoundCondition[],
    summary: FoundCondition,
    now: number,
    settleMs: number,
    clearAfterMs: number,
    unknownPrefixes: string[],
  ): RecordedConditions {
    return this.repos.alerts.recordConditions(found, summary, now, settleMs, clearAfterMs, unknownPrefixes);
  }

  skipStaleAlert(id: number, holder: string): boolean {
    return this.repos.alerts.skipStaleAlert(id, holder);
  }

  claimAlert(holder: string, now: number, claimMs: number): Alert | undefined {
    return this.repos.alerts.claimAlert(holder, now, claimMs);
  }

  finishAlert(id: number, holder: string, finish: AlertFinish): boolean {
    return this.repos.alerts.finishAlert(id, holder, finish);
  }

  recentAlerts(limit: number): Alert[] {
    return this.repos.alerts.recentAlerts(limit);
  }

  setArrival(requestId: string, arrival: ArrivalTerms): void {
    this.repos.attempts.setArrival(requestId, arrival);
  }

  createDraft(input: NewDraft, line: (id: number) => string): number {
    return this.repos.drafts.createDraft(input, line);
  }

  markDraft(
    invoiceId: string,
    id: number,
    move: DraftMove,
    from: DraftState[],
    by: string | null,
    note: string | null,
    line: string,
  ): boolean {
    return this.repos.drafts.markDraft(invoiceId, id, move, from, by, note, line);
  }

  drafts(invoiceId: string): Draft[] {
    return this.repos.drafts.drafts(invoiceId);
  }

  draft(id: number): Draft | undefined {
    return this.repos.drafts.draft(id);
  }
}

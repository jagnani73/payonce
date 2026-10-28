import { getAvailableMinor } from "./airwallex/balances.js";
import {
  findBeneficiary,
  getBankDetails,
  type BeneficiaryRecord,
} from "./airwallex/beneficiaries.js";
import type { AirwallexClient } from "./airwallex/client.js";
import { createQuote, type Quote } from "./airwallex/fx.js";
import {
  findTransferByRequestId,
  getTransfer,
  listTransfersSince,
  type Transfer,
  type TransferBankDetails,
} from "./airwallex/transfers.js";
import {
  accountKeyOf,
  bindingOf,
  changedFields,
  conversionText,
  describeRate,
  fxTermsOf,
  heldTermsFor,
  keyHash,
  markupOf,
  paidWith,
  paymentAmount,
  rateMismatch,
  termsFor,
  withArrival,
  withFeeEstimate,
  type ApprovalTerms,
  type DuplicateEvidence,
  type FxTerms,
  type HeldPaymentTerms,
  type LastQuote,
  type ReplacementTerms,
} from "./approval.js";
import {
  APPROVED_USE_WITHIN_MS,
  checkSigner,
  eligibleApprovers,
  signoffProblem,
  signoffsNeeded,
  type ApprovalPolicy,
  type Approver,
  type Barred,
  type SignoffRule,
} from "./approvers.js";
import {
  arrivalFor,
  atRisk,
  ifSentOn,
  replacementArrivalText,
  sentArrivalText,
  today,
  type ArrivalTerms,
} from "./arrival.js";
import {
  attemptStateOf,
  bankDetailsKey,
  debitOf,
  feeOf,
  originalStateOf,
  resendCanFix,
  sameBankDetails,
  type Debit,
  type Fee,
} from "./assess.js";
import { committedAcross, committedByInvoice, committedMinor } from "./cash-position.js";
import { withCurrencyLock } from "./currency-lock.js";
import { deadlineMinutes, deadlineOf, describeDeadline, isOverdue } from "./deadlines.js";
import {
  decide,
  floorReason,
  NO_FLOOR_CLAUSE,
  NO_FLOOR_REASON,
  OUTSIDE_PAYOUT_REASON,
} from "./decide.js";
import { likelyDuplicates, nearlyPays, sameNumberForSupplier } from "./duplicates.js";
import {
  unverifiedSenders,
  type EmailFindings,
  type EmailReader,
  type SupplierEmail,
} from "./emails.js";
import { quoteValidity } from "./fx.js";
import type { Decision, Incident, OriginalTransferState } from "./incident.js";
import {
  crossCurrency,
  DuplicatePaymentError,
  expiryOf,
  isExpired,
  signersOf,
  type Approval,
  type Attempt,
  type AttemptKind,
  type BankChange,
  type AttemptState,
  type EventKind,
  type Lease,
  type Ledger,
  type LedgerEvent,
  type Obligation,
  type ObligationState,
  type OutsidePayout,
  type PayoutMoney,
  type PayoutState,
  type RunRow,
  type Signoff,
} from "./ledger.js";
import { formatMoney, toMajor, toMinor } from "./money.js";
import { sendAttempt, syncTransfer, wasRejected } from "./payments.js";
import { debitCurrency, floorFor, type ReservePolicy } from "./reserve.js";

// What the reader found. unverifiedSenders is kept for display; the policy works
// the sender check out again from the stored emails. unread marks a thread the
// reader failed on. emailsRead is how many emails of the thread were read.
interface StoredFindings extends EmailFindings {
  unverifiedSenders?: string[];
  unread?: boolean;
  emailsRead?: number;
}

const NO_FINDINGS: StoredFindings = {
  claimsNonReceipt: false,
  asksForNewBankDetails: false,
  summary: "no emails on file",
};

const UNREAD_FINDINGS: EmailFindings = {
  claimsNonReceipt: false,
  asksForNewBankDetails: false,
  summary: "the emails could not be read",
};

// Told about each payment PayOnce sends. In the sandbox it plays the bank, so the
// payment moves on. In production there is none, because the bank moves it.
export interface Bank {
  sent(invoiceId: string, kind: AttemptKind, transferId: string): void;
}

export interface Engine {
  client: AirwallexClient;
  ledger: Ledger;
  reader: EmailReader;
  approvals: ApprovalPolicy;
  reserve: ReservePolicy;
  bank?: Bank;
}

// The quote a payment from another currency's wallet is approved at. fresh is
// true for one no request has shown, which a new request may open on. endsAt is
// when it runs out by this machine's clock, and NaN for one taken from an open
// request.
interface Rate {
  fx: FxTerms;
  fresh: boolean;
  endsAt: number;
}

interface Assessment {
  original: Transfer;
  incident: Incident;
  findings: StoredFindings;
  unverified: string[];
  bankDetails: TransferBankDetails;
  // The callback that verified the bank details on file, when they are not the
  // ones the original went to. Null when none matches them.
  bankChange: BankChange | null;
  // The quote a replacement from another currency's wallet would be paid at.
  // Null for any other invoice, and before the original has failed.
  rate: Rate | null;
  // When a replacement sent now usually arrives. Null for an invoice with no due
  // date, so its terms are as they were before.
  arrival: ArrivalTerms | null;
  decision: Decision;
  // The floor reason added to the decision's reason, or null when none was.
  floor: string | null;
  // A paid invoice this one looks like a second bill for, once the original has
  // failed. Null when there is none.
  paidDuplicate: string | null;
}

// An approval request ends this long before its quote does, after the time an
// approval given at the last moment has to be used, so a slow look or a clock
// that differs from Airwallex's never sends on a quote that has run out.
const QUOTE_MARGIN_MS: number = 2 * 60_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// What a standing line is about. A standing line says how things are now and is
// written again on every check. A line with no topic records something that
// happened.
export type Topic =
  | "decision"
  | "waiting"
  | "approval"
  | "cost"
  | "bank-details"
  | "floor"
  | "second-bill";

// True when the timeline's last word on a topic is this message and nothing has
// happened since. A pay run's timeline uses it too.
export function stillSays(events: LedgerEvent[], topic: string, message: string): boolean {
  for (const event of [...events].reverse()) {
    if (event.topic === topic) {
      return event.message === message;
    }
    if (event.topic === null) {
      return false;
    }
  }
  return false;
}

// Adds a line to the incident's timeline and prints it. A line identical to the
// previous one is skipped. So is a standing line the timeline still says, which
// keeps a check that finds nothing new from repeating the decision.
export function note(
  ledger: Ledger,
  invoiceId: string,
  kind: EventKind,
  message: string,
  topic: Topic | null = null,
): void {
  const events: LedgerEvent[] = ledger.events(invoiceId);
  const last: LedgerEvent | undefined = events.at(-1);
  if (last?.kind === kind && last.message === message) {
    return;
  }
  if (topic !== null && stillSays(events, topic, message)) {
    return;
  }
  ledger.addEvent(invoiceId, kind, message, topic);
  console.log(`  ${kind.padEnd(8)} ${message}`);
}

// Puts a failure on the incident's timeline. It must not throw, because it runs
// from error handlers.
export function noteError(ledger: Ledger, invoiceId: string, error: unknown): void {
  console.error(error);
  try {
    note(ledger, invoiceId, "error", messageOf(error));
  } catch (inner: unknown) {
    console.error(`Could not record the error for ${invoiceId}: ${messageOf(inner)}`);
  }
}

// An obligation recorded before the domain column existed has none on file, and
// there is nothing to compare its senders with.
function sendersNotOnFile(obligation: Obligation, emails: SupplierEmail[]): string[] {
  return obligation.supplierDomain === ""
    ? []
    : unverifiedSenders(emails, obligation.supplierDomain);
}

function describe(transfer: Transfer): string {
  const failure: string =
    transfer.failure?.code === undefined
      ? ""
      : `, ${transfer.failure.code} ${transfer.failure.message ?? ""}`.trimEnd();
  return `${transfer.short_reference_id} ${transfer.status}${failure}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function money(obligation: Obligation): string {
  return formatMoney(obligation.amountMinor, obligation.currency);
}

// A payout's amount, payee and status, as the timeline shows it.
export function payoutSummary(transfer: Transfer): string {
  const failure: string =
    transfer.failure?.code === undefined ? "" : `, ${transfer.failure.code}`;
  const payee: string =
    transfer.beneficiary?.bank_details?.account_name ?? "an unnamed payee";
  return `${formatMoney(toMinor(transfer.transfer_amount), transfer.transfer_currency)} to ${payee}, ${transfer.status}${failure}`;
}

// A payout's amount and fee for the ledger, each in the currency it was taken in.
// One that cannot be read is null, so tying the payout never fails on it.
function payoutMoney(transfer: Transfer): PayoutMoney {
  const fee: Fee | null = feeOf(transfer);
  const debit: Debit | null = debitOf(transfer);
  return {
    amountMinor: debit?.minor ?? null,
    currency: debit?.currency ?? null,
    feeMinor: fee?.minor ?? null,
    feeCurrency: fee?.currency ?? null,
  };
}

// A payout whose reference names an invoice PayOnce has may pay that invoice a
// second time. It goes on the invoice's timeline, and the policy holds every
// payment while it is live. A settled invoice, or one closed without paying, is
// reopened for a person to check. exact is false when the reference only nearly
// matches the invoice number. Call it in the invoice's turn. False when the
// payout was tied already.
export function linkOutsidePayout(
  engine: Engine,
  invoiceId: string,
  transfer: Transfer,
  exact: boolean = true,
): boolean {
  const state: PayoutState = originalStateOf(transfer);
  const linked: boolean = engine.ledger.linkOutsidePayout(invoiceId, {
    transferId: transfer.id,
    reference: transfer.short_reference_id,
    state,
    ...payoutMoney(transfer),
  });
  if (!linked) {
    return false;
  }
  note(
    engine.ledger,
    invoiceId,
    "warning",
    exact
      ? `Payout ${transfer.short_reference_id} for this invoice was sent outside PayOnce: ${payoutSummary(transfer)}`
      : `Payout ${transfer.short_reference_id} was sent outside PayOnce with reference ${transfer.reference}, which matches this invoice's number apart from case, spacing, leading zeros or letters added at the end. It went to the same supplier for the same amount: ${payoutSummary(transfer)}`,
  );
  const now: ObligationState | undefined = engine.ledger.obligation(invoiceId)?.state;
  if ((now === "settled" || now === "rejected") && state !== "failed") {
    engine.ledger.escalate(invoiceId, OUTSIDE_PAYOUT_REASON);
  }
  return true;
}

// Looks in Airwallex for payouts for this invoice that PayOnce has not seen, and
// ties them to it: one whose reference names it, or one it nearlyPays whose
// reference names no invoice exactly. It runs before an original or a replacement
// goes out, so a payment someone made outside PayOnce is not paid a second time,
// even when the reference also nearly matches an older invoice. True when it tied
// any.
async function linkUnseenPayouts(engine: Engine, invoiceId: string): Promise<boolean> {
  const obligation: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (obligation === undefined) {
    return false;
  }
  let linked: boolean = false;
  const transfers: Transfer[] = await listTransfersSince(
    engine.client,
    engine.ledger.startedAt(),
  );
  for (const transfer of transfers) {
    if (engine.ledger.knowsTransfer(transfer.request_id ?? "", transfer.id)) {
      continue;
    }
    const named: Obligation | undefined = engine.ledger.obligationForReference(
      transfer.reference ?? "",
    );
    if (named !== undefined ? named.invoiceId === invoiceId : nearlyPays(obligation, transfer)) {
      linked = linkOutsidePayout(engine, invoiceId, transfer, named !== undefined) || linked;
    }
  }
  return linked;
}

// Reads each outside payout the bank has not finished with, and notes any it has
// paid or failed since. Returns them all as they now stand.
async function syncOutsidePayouts(
  engine: Engine,
  invoiceId: string,
): Promise<OutsidePayout[]> {
  for (const payout of engine.ledger.outsidePayouts(invoiceId)) {
    if (payout.state === "paid" || payout.state === "failed") {
      continue;
    }
    const transfer: Transfer = await getTransfer(engine.client, payout.transferId);
    const state: PayoutState = originalStateOf(transfer);
    engine.ledger.recordOutsidePayout(payout.transferId, state, payoutMoney(transfer));
    if (state === payout.state) {
      continue;
    }
    if (state === "paid" || state === "failed") {
      note(engine.ledger, invoiceId, "bank", `Payout sent outside PayOnce ${describe(transfer)}`);
    }
  }
  return engine.ledger.outsidePayouts(invoiceId);
}

// A status PayOnce does not recognise counts as live.
function anyLive(payouts: OutsidePayout[]): boolean {
  return payouts.some((payout: OutsidePayout): boolean => payout.state !== "failed");
}

// The inbox: stores emails that arrived for an invoice, puts them on its timeline
// and checks their senders against the domain on file. The agent reads them the
// next time it looks at the invoice.
export function deliver(
  ledger: Ledger,
  obligation: Obligation,
  emails: SupplierEmail[],
): void {
  const invoiceId: string = obligation.invoiceId;
  ledger.addEmails(invoiceId, emails);
  for (const email of emails) {
    note(ledger, invoiceId, "email", `Email from ${email.from}: ${email.subject}`);
  }
  for (const sender of sendersNotOnFile(obligation, emails)) {
    note(
      ledger,
      invoiceId,
      "warning",
      `Sender ${sender} does not match the supplier's domain on file (${obligation.supplierDomain})`,
    );
  }
}

// Reads the whole thread once emails have arrived since it was last read, and
// keeps the findings so later looks see the same result. If the reader fails,
// the thread is marked unread so the policy escalates and does not act on
// findings from before these emails arrived. It is read again on the next look.
async function readNewEmails(engine: Engine, obligation: Obligation): Promise<void> {
  const invoiceId: string = obligation.invoiceId;
  const thread: SupplierEmail[] = engine.ledger.emails(invoiceId);
  const stored: string | undefined = engine.ledger.findings(invoiceId);
  const previous: StoredFindings | undefined =
    stored === undefined ? undefined : (JSON.parse(stored) as StoredFindings);
  // Findings saved before the count was kept cover the whole thread.
  const readCount: number =
    previous === undefined ? 0 : (previous.emailsRead ?? thread.length);
  if (readCount >= thread.length) {
    return;
  }

  let read: EmailFindings = UNREAD_FINDINGS;
  let unread: boolean = false;
  try {
    read = await engine.reader.read(thread);
  } catch (error: unknown) {
    unread = true;
    note(
      engine.ledger,
      invoiceId,
      "error",
      `Supplier emails could not be read: ${messageOf(error)}`,
    );
  }
  const findings: StoredFindings = {
    ...read,
    unverifiedSenders: sendersNotOnFile(obligation, thread),
    unread,
    emailsRead: unread ? 0 : thread.length,
    ...(unread ? {} : { readBy: read.readBy ?? engine.reader.name }),
  };
  engine.ledger.saveFindings(invoiceId, JSON.stringify(findings));
  note(engine.ledger, invoiceId, "email", `Emails read: ${findings.summary}`);
}

// The floor as the cost line names it.
function floorText(floorMinor: number | null, currency: string): string {
  if (floorMinor === null) {
    return `no reserve floor is set for ${currency}`;
  }
  return Number.isFinite(floorMinor)
    ? `reserve floor ${formatMoney(floorMinor, currency)}`
    : "the reserve floor setting could not be read";
}

function quoteFits(fx: FxTerms, obligation: Obligation): boolean {
  return (
    fx.sellCurrency === obligation.sourceCurrency &&
    fx.buyCurrency === obligation.currency &&
    fx.buyAmountMinor === obligation.amountMinor
  );
}

// The quote a payment of this invoice from another currency's wallet is offered
// at. While an approval request is open, every look builds its terms on that
// request's own quote, so its binding holds still. Any other time it offers the
// invoice's last quote if no request has shown it and it holds long enough for
// one, so a look that opens no request takes no quote, and otherwise takes a
// fresh one. A new request never opens on a quote an earlier one showed.
// feeEstimateMinor is the fee the payment should cost, in the sell currency.
async function rateFor(
  engine: Engine,
  obligation: Obligation,
  feeEstimateMinor: number | null,
): Promise<Rate> {
  const latest: Approval | undefined = engine.ledger.latestApproval(obligation.invoiceId);
  const shown: FxTerms | undefined =
    latest === undefined ? undefined : (JSON.parse(latest.terms) as ApprovalTerms).fx;
  const open: FxTerms | undefined =
    latest !== undefined &&
    (latest.state === "requested" || latest.state === "approved") &&
    !isExpired(latest)
      ? shown
      : undefined;
  if (open !== undefined && quoteFits(open, obligation)) {
    return { fx: withFeeEstimate(open, feeEstimateMinor), fresh: false, endsAt: Number.NaN };
  }
  // Every request opens on the last quote, so only the latest can have shown it.
  // It is offered while a request opened on it would stay open at least as long
  // as an approval has to be used.
  const kept: string | undefined = engine.ledger.lastQuote(obligation.invoiceId);
  const last: LastQuote | undefined =
    kept === undefined ? undefined : (JSON.parse(kept) as LastQuote);
  if (
    last !== undefined &&
    last.fx.quoteId !== shown?.quoteId &&
    quoteFits(last.fx, obligation) &&
    last.endsAt - Date.now() > 2 * APPROVED_USE_WITHIN_MS + QUOTE_MARGIN_MS
  ) {
    return { fx: withFeeEstimate(last.fx, feeEstimateMinor), fresh: true, endsAt: last.endsAt };
  }
  const quote: Quote = await createQuote(
    engine.client,
    obligation.sourceCurrency,
    obligation.currency,
    toMajor(obligation.amountMinor),
    quoteValidity(),
  );
  const receivedAt: number = Date.now();
  const fx: FxTerms = fxTermsOf(quote, obligation, feeEstimateMinor);
  // This clock and Airwallex's may differ, so the quote is taken to hold no
  // longer than its validity counted from when it arrived.
  const validTo: number = Date.parse(quote.valid_to_at);
  const endsAt: number = Math.min(validTo, receivedAt + (validTo - Date.parse(quote.valid_from_at)));
  if (!(endsAt - receivedAt > APPROVED_USE_WITHIN_MS + QUOTE_MARGIN_MS)) {
    throw new Error(
      `The exchange rate quote Airwallex sent holds until ${quote.valid_to_at}, too briefly for an approval request, so PayOnce offers nothing on it`,
    );
  }
  const taken: LastQuote = { fx, endsAt };
  engine.ledger.saveQuote(obligation.invoiceId, JSON.stringify(taken));
  return { fx, fresh: true, endsAt };
}

// The day an invoice's arrival estimate counts from. While an approval request is
// requested or approved and has not expired, it is that request's day, so its
// binding holds past midnight. Otherwise it is today. awaitApproval never opens
// a new request on an estimate from another day.
function arrivalFrom(ledger: Ledger, invoiceId: string): string {
  const latest: Approval | undefined = ledger.latestApproval(invoiceId);
  const open: ArrivalTerms | undefined =
    latest !== undefined &&
    (latest.state === "requested" || latest.state === "approved") &&
    !isExpired(latest)
      ? (JSON.parse(latest.terms) as ApprovalTerms).arrival
      : undefined;
  return open?.from ?? today();
}

// When a payment of the invoice to these bank details usually arrives, or null
// when the invoice has no due date.
function arrivalOf(
  ledger: Ledger,
  obligation: Obligation,
  bankDetails: TransferBankDetails,
): ArrivalTerms | null {
  return obligation.dueDate === null
    ? null
    : arrivalFor(
        obligation.transferMethod,
        obligation.currency,
        bankDetails,
        obligation.dueDate,
        arrivalFrom(ledger, obligation.invoiceId),
      );
}

// What the decision line adds about when a replacement would arrive: only for an
// invoice with a due date whose original failed and no payout sent outside
// PayOnce may pay. It counts from today, also while an open request keeps the day
// it opened on.
function arrivalClause(assessment: Assessment): string {
  return assessment.arrival === null ||
    assessment.incident.originalState !== "failed" ||
    assessment.incident.outsidePayoutLive
    ? ""
    : `. ${replacementArrivalText(ifSentOn(assessment.arrival, today()))}`;
}

// The terms a new request opens on. Terms that kept an open request's arrival
// estimate, counted from a day that is not today, count from today. Only the
// dates change.
function countedFromToday<T extends ApprovalTerms>(terms: T): T {
  return terms.arrival !== undefined && terms.arrival.from !== today()
    ? withArrival(terms, ifSentOn(terms.arrival, today()))
    : terms;
}

// The email evidence a person sees and approves against.
function evidenceSummary(assessment: Assessment): string {
  return assessment.unverified.length === 0
    ? assessment.findings.summary
    : `${assessment.findings.summary}, sender ${assessment.unverified.join(", ")} does not match the supplier on file`;
}

async function assess(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<Assessment> {
  const original: Transfer = await getTransfer(engine.client, originalId);
  const emails: SupplierEmail[] = engine.ledger.emails(obligation.invoiceId);
  const stored: string | undefined = engine.ledger.findings(obligation.invoiceId);
  const findings: StoredFindings =
    stored === undefined ? NO_FINDINGS : (JSON.parse(stored) as StoredFindings);
  const unverified: string[] = sendersNotOnFile(obligation, emails);
  // A replacement is paid by beneficiary id, so what counts is the account that
  // record points to now, not the one the original went to.
  const bankDetails: TransferBankDetails = await getBankDetails(
    engine.client,
    obligation.beneficiaryId,
  );
  // Read fresh on every look. The cash panel's cached balance never feeds a decision.
  const wallet: string = debitCurrency(obligation);
  // The original was paid from the same wallet, so its fee is in that currency. A
  // fee in any other is not added to it, and the policy then cannot read the cash.
  const feeMinor: number =
    original.fee_currency === undefined || original.fee_currency === wallet
      ? toMinor(original.fee_amount)
      : Number.NaN;
  // Counted before the balance is read, so a payment that gets its transfer in
  // between is counted twice, as committed and as debited, and never not at all.
  const committed: number = committedMinor(engine.ledger, wallet, {
    invoiceId: obligation.invoiceId,
  });
  const availableMinor: number = await getAvailableMinor(engine.client, wallet);
  const floorMinor: number | null = floorFor(engine.reserve, obligation);
  const originalState: OriginalTransferState = originalStateOf(original);
  const converts: boolean = crossCurrency(obligation);
  // A replacement from another wallet is priced on a quote, which the cash check
  // and the approval both go by. Only a failed original leaves one to price.
  const rate: Rate | null =
    converts && originalState === "failed"
      ? await rateFor(engine, obligation, Number.isFinite(feeMinor) ? feeMinor : null)
      : null;
  const incident: Incident = {
    invoiceId: obligation.invoiceId,
    supplier: obligation.supplier,
    currency: obligation.currency,
    amountMinor: obligation.amountMinor,
    crossCurrency: converts,
    sourceCurrency: wallet,
    sourceAmountMinor: converts ? (rate?.fx.sellAmountMinor ?? Number.NaN) : obligation.amountMinor,
    transferFeeMinor: feeMinor,
    originalState,
    bankOverdue: originalState === "in_flight" && isOverdue(original),
    resendCanFix: resendCanFix(original),
    sentOutsidePayOnce: obligation.origin === "outside",
    // The look that called this has just read them from Airwallex.
    outsidePayoutLive: anyLive(engine.ledger.outsidePayouts(obligation.invoiceId)),
    replacementFailed: engine.ledger
      .attempts(obligation.invoiceId)
      .some(
        (attempt: Attempt): boolean =>
          attempt.kind === "replacement" && attempt.state === "failed",
      ),
    supplierReportsNonReceipt: findings.claimsNonReceipt === true,
    supplierAsksForNewBankDetails: findings.asksForNewBankDetails === true,
    beneficiaryChanged: !sameBankDetails(
      original.beneficiary?.bank_details,
      bankDetails,
    ),
    emailFromUnverifiedSender: unverified.length > 0,
    emailsUnread:
      findings.unread === true || (emails.length > 0 && stored === undefined),
    availableBalanceMinor: availableMinor,
    committedMinor: committed,
    reserveFloorMinor: floorMinor,
    twoApproversAboveMinor: engine.approvals.twoApproversAboveMinor,
  };

  // Said whatever the policy escalates for, because it checks other things first.
  if (incident.beneficiaryChanged) {
    note(
      engine.ledger,
      obligation.invoiceId,
      "warning",
      "The supplier's bank details on file are not the ones the original payment went to",
      "bank-details",
    );
  }

  // A failed transfer keeps its fee, so a replacement pays the fee a second time.
  // Money committed to other payments is taken off as well, so the numbers behind
  // a floor decision are on the timeline.
  if (
    incident.originalState === "failed" &&
    Number.isFinite(feeMinor) &&
    Number.isFinite(incident.sourceAmountMinor) &&
    (feeMinor > 0 || committed > 0)
  ) {
    const costMinor: number = incident.sourceAmountMinor + feeMinor;
    const afterMinor: number = availableMinor - committed - costMinor;
    const fee: string =
      feeMinor > 0 ? ` with a second ${formatMoney(feeMinor, wallet)} transfer fee` : "";
    const others: string =
      committed > 0
        ? `, and ${formatMoney(committed, wallet)} is committed to other payments not sent yet`
        : "";
    const replacement: string = converts ? `A replacement of ${money(obligation)}` : "A replacement";
    note(
      engine.ledger,
      obligation.invoiceId,
      floorMinor !== null && afterMinor >= floorMinor ? "payment" : "warning",
      `${replacement} costs ${formatMoney(costMinor, wallet)}${fee}${others}. Cash after it: ${formatMoney(afterMinor, wallet)}, ${floorText(floorMinor, wallet)}`,
      "cost",
    );
  }

  // Looked for whenever a replacement could be asked for, so every look, and so
  // every request, names it (namingPaidDuplicate).
  const paid: string | null =
    originalState === "failed" ? paidDuplicate(engine.ledger, obligation) : null;
  const decision: Decision = secondBill(decide(incident), paid);
  // Once an invoice has gone to a person, the policy no longer acts for itself.
  const held: string =
    obligation.state !== "escalated"
      ? ""
      : decision.action === "replace"
        ? ". This invoice was escalated, so it still needs a person's approval"
        : decision.action === "close"
          ? ". This invoice was escalated, so a person closes it"
          : "";
  const bankChange: BankChange | null = incident.beneficiaryChanged
    ? (engine.ledger.verifiedBankChange(obligation.beneficiaryId, bankDetailsKey(bankDetails)) ??
      null)
    : null;
  const arrival: ArrivalTerms | null = arrivalOf(engine.ledger, obligation, bankDetails);
  const assessment: Assessment = {
    original,
    incident,
    findings,
    unverified,
    bankDetails,
    bankChange,
    rate,
    arrival,
    decision,
    floor: null,
    paidDuplicate: paid,
  };
  // The arrival is advice for people. The policy decided without it.
  note(
    engine.ledger,
    obligation.invoiceId,
    "decision",
    `${capitalise(decision.action)}: ${decision.reason}${held}${arrivalClause(assessment)}`,
    "decision",
  );
  return assessment;
}

// The first invoice this one looks like a second bill for that is paid, by
// PayOnce or by a payout sent outside it. Null when there is none.
function paidDuplicate(ledger: Ledger, obligation: Obligation): string | null {
  return (
    likelyDuplicates(ledger, obligation).find((other: Obligation): boolean =>
      isPaid(ledger, other.invoiceId),
    )?.invoiceId ?? null
  );
}

function secondBillReason(invoiceId: string): string {
  return `it looks like a second bill for ${invoiceId}, which is paid`;
}

// A replacement for what looks like a second bill of a paid invoice goes to a
// person.
function secondBill(decision: Decision, paid: string | null): Decision {
  return paid !== null && decision.action === "replace"
    ? { action: "escalate", reason: secondBillReason(paid) }
    : decision;
}

// The beneficiary record no longer holds the account a payment was decided or
// approved for.
export class AccountChangedError extends Error {
  constructor(what: string) {
    super(
      `The supplier's bank details changed after the ${what}, so PayOnce sent nothing. Check again to look at the new details`,
    );
    this.name = "AccountChangedError";
  }
}

// A transfer is paid to the beneficiary record as it is when it is created, so a
// replacement first checks that the record still holds the account it was
// decided or approved for. Throws AccountChangedError, sending nothing, when it
// does not.
async function requireAccount(
  engine: Engine,
  obligation: Obligation,
  accountKey: string,
  what: string,
): Promise<void> {
  const now: TransferBankDetails = await getBankDetails(engine.client, obligation.beneficiaryId);
  if (accountKeyOf(now) !== accountKey) {
    throw new AccountChangedError(what);
  }
}

// A payment from another currency's wallet must go out on the quote a person
// approved. Checked wherever an attempt first becomes a transfer: when it is
// sent, when a retry creates it, and when it is found by its request_id. The
// money has moved by then, so a transfer at any other rate goes to a person, and
// only a person closes the invoice.
function checkRate(
  engine: Engine,
  obligation: Obligation,
  attempt: Attempt,
  transfer: Transfer,
): void {
  if (attempt.quoteId === null) {
    return;
  }
  // The approval the attempt was opened on, so a request another process opened
  // since does not count.
  const approval: Approval | undefined = engine.ledger.approvalOf(attempt);
  const approved: FxTerms | undefined =
    approval?.state === "used" ? (JSON.parse(approval.terms) as ApprovalTerms).fx : undefined;
  const problem: string | null = rateMismatch(
    approved?.quoteId === attempt.quoteId ? approved : undefined,
    transfer,
  );
  if (problem === null) {
    return;
  }
  const reason: string = `${attempt.kind} ${transfer.short_reference_id} ${problem}`;
  engine.ledger.markRateMismatch(attempt.requestId, reason);
  engine.ledger.escalate(obligation.invoiceId, reason);
  note(engine.ledger, obligation.invoiceId, "warning", capitalise(reason));
}

// Sends an attempt already written to the ledger.
async function send(
  engine: Engine,
  obligation: Obligation,
  attempt: Attempt,
  accountKey: string | null,
): Promise<Transfer> {
  const kind: AttemptKind = attempt.kind;
  let created: Transfer;
  try {
    created = await sendAttempt(engine.client, engine.ledger, obligation, attempt);
  } catch (error: unknown) {
    throw new Error(
      wasRejected(error)
        ? `${capitalise(kind)} payment was refused and nothing was sent. ${messageOf(error)}`
        : `${capitalise(kind)} payment request did not complete, so the transfer may or may not exist. Run ${obligation.invoiceId} again to reconcile it. ${messageOf(error)}`,
      { cause: error },
    );
  }

  // Noted as soon as the transfer exists, so a later failure cannot hide it. The
  // fee is charged in the wallet the payment left.
  const fee: string =
    created.fee_amount > 0
      ? `, plus a ${formatMoney(toMinor(created.fee_amount), created.fee_currency ?? obligation.sourceCurrency)} transfer fee`
      : "";
  note(
    engine.ledger,
    obligation.invoiceId,
    "payment",
    `${capitalise(kind)} ${created.short_reference_id} sent: ${money(obligation)} to ${obligation.supplier}${conversionText(created)}${fee}`,
  );
  checkRate(engine, obligation, attempt, created);
  // The record could still change between the check and the transfer.
  const sentTo: TransferBankDetails | undefined = created.beneficiary?.bank_details;
  if (accountKey !== null && sentTo !== undefined && accountKeyOf(sentTo) !== accountKey) {
    const reason: string = `${kind} ${created.short_reference_id} went to bank details that are not the ones it was approved for`;
    // So it never counts as the account PayOnce last paid this supplier.
    engine.ledger.markMisdirected(attempt.requestId);
    engine.ledger.escalate(obligation.invoiceId, reason);
    note(engine.ledger, obligation.invoiceId, "warning", capitalise(reason));
  }
  // When it usually arrives, counted from the day the transfer was created, which
  // is earlier than today for a pending attempt found by its request_id, against
  // the due date. Advice for people: nothing PayOnce decides reads it.
  const createdAt: number = Date.parse(created.created_at);
  const arrival: ArrivalTerms = arrivalFor(
    obligation.transferMethod,
    obligation.currency,
    sentTo,
    obligation.dueDate,
    Number.isNaN(createdAt) ? today() : today(new Date(createdAt)),
  );
  engine.ledger.setArrival(attempt.requestId, arrival);
  note(
    engine.ledger,
    obligation.invoiceId,
    atRisk(arrival) ? "warning" : "payment",
    sentArrivalText(`${capitalise(kind)} ${created.short_reference_id}`, arrival),
  );
  engine.bank?.sent(obligation.invoiceId, kind, created.id);
  return created;
}

function close(engine: Engine, invoiceId: string): boolean {
  if (!engine.ledger.settle(invoiceId)) {
    return false;
  }
  const replaced: boolean = engine.ledger
    .attempts(invoiceId)
    .some((attempt: Attempt): boolean => attempt.kind === "replacement");
  note(
    engine.ledger,
    invoiceId,
    "closed",
    replaced
      ? "Incident closed: the original failed and one replacement was paid"
      : "Incident closed: the original payment arrived",
  );
  return true;
}

// The time of the next look the agent takes by itself, in epoch milliseconds.
// Null when it waits for news or for a person.
type NextLook = number | null;

const RETRY_FAILED_LOOK_MS: number = 60_000;

// Leaves the invoice waiting on the bank until the transfer's deadline, when the
// agent looks again if nothing has woken it before.
function waitForBank(
  engine: Engine,
  invoiceId: string,
  kind: AttemptKind,
  transfer: Transfer,
): NextLook {
  note(
    engine.ledger,
    invoiceId,
    "payment",
    kind === "replacement"
      ? `Waiting for the bank to pay replacement ${transfer.short_reference_id}. If it has not paid or failed it within ${describeDeadline(transfer)} of sending, a person hears about it`
      : `Waiting for the bank to pay or fail original ${transfer.short_reference_id}. If it has done neither within ${describeDeadline(transfer)} of sending, a person hears about it`,
    "waiting",
  );
  return deadlineLook(transfer);
}

// The look at a transfer's deadline. A deadline that cannot be read is due now,
// and the look then finds the transfer overdue.
function deadlineLook(transfer: Transfer): number {
  const deadline: number = deadlineOf(transfer);
  return Number.isFinite(deadline) ? deadline : Date.now();
}

export const REPLACEMENT_DEADLINE_REASON: string =
  "the bank has not paid or failed the replacement by its deadline";

// A replacement the bank sits on is never followed by another payment. A person
// hears about it, and the incident still closes if the bank pays it.
function replacementOverdue(
  engine: Engine,
  invoiceId: string,
  replacement: Transfer,
): NextLook {
  const reason: string = REPLACEMENT_DEADLINE_REASON;
  engine.ledger.escalate(invoiceId, reason);
  note(engine.ledger, invoiceId, "decision", `Escalate: ${reason}`, "decision");
  note(
    engine.ledger,
    invoiceId,
    "approval",
    `Waiting on a person. Replacement ${replacement.short_reference_id} is still with the bank, so PayOnce sends nothing more`,
    "waiting",
  );
  return null;
}

function termsOf(obligation: Obligation, assessment: Assessment): ReplacementTerms {
  return termsFor(
    obligation,
    assessment.original,
    assessment.decision,
    evidenceSummary(assessment),
    assessment.bankDetails,
    assessment.bankChange,
    assessment.rate?.fx ?? null,
    assessment.arrival,
  );
}

// The people who may not approve a payment of this invoice to the account with
// this accountKey, and why: whoever started the incident, and everyone who
// recorded a callback verifying that account.
function barredFrom(ledger: Ledger, obligation: Obligation, accountKey: string | undefined): Barred[] {
  const barred: Barred[] = [];
  if (obligation.startedBy !== null) {
    barred.push({
      name: obligation.startedBy,
      why: obligation.runRowId === null ? "started this incident" : "uploaded the pay run it came from",
    });
  }
  for (const detailsKey of ledger.appliedKeys(obligation.beneficiaryId)) {
    if (accountKey === undefined || keyHash(detailsKey) !== accountKey) {
      continue;
    }
    for (const name of ledger.bankChangeRecorders(obligation.beneficiaryId, detailsKey)) {
      barred.push({ name, why: "recorded the callback for the new bank details" });
    }
  }
  return barred;
}

function ruleFor(
  engine: Engine,
  obligation: Obligation,
  terms: ApprovalTerms,
  newAccount: boolean,
): SignoffRule {
  return signoffsNeeded(engine.approvals, paymentAmount(terms), newAccount, obligation.startedBy);
}

// Why an approval no longer covers the payment under the approval policy as it
// is now, or null when it still does.
function approvalProblem(
  engine: Engine,
  obligation: Obligation,
  rule: SignoffRule,
  approval: Approval,
): string | null {
  const approved: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  return signoffProblem(
    engine.approvals,
    rule,
    approval,
    paymentAmount(approved),
    barredFrom(engine.ledger, obligation, approved.accountKey),
  );
}

// Voids an approval that no longer covers the payment, and says why: it expired
// before it was used, the terms changed, or the approval policy as it is now
// refuses it. True when it was voided.
function voidIfStale(
  engine: Engine,
  obligation: Obligation,
  approval: Approval,
  current: ApprovalTerms,
  rule: SignoffRule,
): boolean {
  let why: string | null = null;
  if (isExpired(approval)) {
    why = "expired before it was used";
  } else if (bindingOf(current) !== approval.binding) {
    const approved: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
    why = `is void: ${changedFields(approved, current).join(", ")} changed`;
  } else {
    const problem: string | null = approvalProblem(engine, obligation, rule, approval);
    why = problem === null ? null : `is void: ${problem}`;
  }
  if (why === null) {
    return false;
  }
  engine.ledger.setApprovalState(approval.id, "void");
  note(engine.ledger, obligation.invoiceId, "approval", `Approval by ${approval.approver} ${why}`);
  return true;
}

// Nothing is sent while a payout for the invoice sent outside PayOnce may pay it.
function holdForOutsidePayout(engine: Engine, invoiceId: string): NextLook {
  if (engine.ledger.voidOpenApprovals(invoiceId)) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      "Approval request withdrawn: a payout for this invoice was sent outside PayOnce",
    );
  }
  note(
    engine.ledger,
    invoiceId,
    "approval",
    "Waiting on a person. A payout sent outside PayOnce may already pay this invoice, so PayOnce sends nothing",
    "waiting",
  );
  return null;
}

// When a request opened now on this quote stops covering a payment: its TTL, or
// earlier, so that an approval given at the last moment is used, or void, before
// the quote runs out.
function requestExpiry(engine: Engine, rate: Rate | null, now: number): number {
  const ttl: number = now + engine.approvals.expiresAfterMs;
  return rate === null ? ttl : Math.min(ttl, rate.endsAt - APPROVED_USE_WITHIN_MS - QUOTE_MARGIN_MS);
}

// "Quote for 4,000.00 EUR: 4,478.04 USD at 1 EUR = 1.119509 USD, ..." with the
// last request's rate when it was another.
function quoteLine(obligation: Obligation, fx: FxTerms, previous: FxTerms | undefined): string {
  const until: string = new Date(Date.parse(fx.validTo)).toISOString().slice(11, 16);
  const was: string =
    previous === undefined || previous.quoteId === fx.quoteId
      ? ""
      : `. The last request's quote was ${describeRate(previous)} (${formatMoney(previous.sellAmountMinor, previous.sellCurrency)})`;
  return `Quote for ${money(obligation)}: ${formatMoney(fx.sellAmountMinor, fx.sellCurrency)} at ${describeRate(fx)}, ${markupOf(fx)} from mid-market, held until ${until} UTC${was}`;
}

// Asks the approvers to approve a payment under the approval policy, and says
// what the invoice is waiting on. A request still open for the same terms is kept.
// Returns when the request expires, so the look then can open a new one. rate is
// the quote a payment from another currency's wallet is offered at, and a new
// request opens only on a quote this look took for it.
function awaitApproval(
  engine: Engine,
  obligation: Obligation,
  given: ApprovalTerms,
  rule: SignoffRule,
  rate: Rate | null,
): NextLook {
  const invoiceId: string = obligation.invoiceId;
  let terms: ApprovalTerms = given;
  let binding: string = bindingOf(terms);

  // A request nobody on the list could approve would only expire and be opened
  // again, so none is opened until the approver list changes.
  const eligible: Approver[] = eligibleApprovers(
    engine.approvals,
    paymentAmount(terms),
    barredFrom(engine.ledger, obligation, terms.accountKey),
  );
  if (engine.approvals.problem !== null || eligible.length < rule.needed) {
    if (engine.ledger.voidOpenApprovals(invoiceId)) {
      note(
        engine.ledger,
        invoiceId,
        "approval",
        "Approval request withdrawn: nobody on the approver list can approve it",
      );
    }
    const able: string =
      eligible.length === 0
        ? "nobody on the approver list can"
        : `only ${eligible.map((approver: Approver): string => approver.name).join(" and ")} can`;
    // No request opens, so no rate is named: only about what the payment takes
    // from its wallet, which the limits are compared with.
    const fx: string =
      terms.fx === undefined
        ? ""
        : `, about ${formatMoney(terms.fx.sellAmountMinor, terms.fx.sellCurrency)},`;
    const payment: string =
      terms.action === "replace"
        ? `A replacement of ${money(obligation)}${fx}`
        : `Paying ${money(obligation)} for this invoice${fx}`;
    note(
      engine.ledger,
      invoiceId,
      "approval",
      engine.approvals.problem !== null
        ? `Waiting on a person. Approvals are refused: ${engine.approvals.problem}`
        : `Waiting on a person. ${payment} needs ${rule.needed === 1 ? "one approver" : `${rule.needed} approvers, because ${rule.why},`} and ${able} approve it. Change APPROVERS, restart and check again`,
      "waiting",
    );
    return null;
  }

  let latest: Approval | undefined = engine.ledger.latestApproval(invoiceId);
  const sameRequest: boolean =
    latest?.state === "requested" && latest.binding === binding && latest.needed >= rule.needed;
  const opening: boolean = !sameRequest || latest === undefined || isExpired(latest);
  // Terms built on an open request's quote that now need a new request: that one
  // is withdrawn, and the next look, at once, takes a fresh quote for its own.
  if (opening && terms.fx !== undefined && rate?.fresh !== true) {
    const signed: Signoff[] = latest?.state === "requested" ? latest.signoffs : [];
    if (engine.ledger.voidOpenApprovals(invoiceId)) {
      note(
        engine.ledger,
        invoiceId,
        "approval",
        signed.length > 0
          ? `Approval by ${signersOf(signed)} no longer counts: the terms changed, so PayOnce takes a new exchange rate quote and opens a new request`
          : "Approval request withdrawn: the terms changed, so PayOnce takes a new exchange rate quote and opens a new request",
      );
    }
    return Date.now();
  }
  if (opening) {
    terms = countedFromToday(terms);
    binding = bindingOf(terms);
  }
  const previous: FxTerms | undefined =
    latest === undefined ? undefined : (JSON.parse(latest.terms) as ApprovalTerms).fx;
  // A partly signed request that expired is reported as expired, even when the
  // terms have changed since. So is a request on a quote, which is replaced on a
  // fresh quote once it expires, so its terms differ even when nothing else
  // changed, and one with an arrival estimate, which may count from a new day.
  const expiredRequest: boolean =
    latest?.state === "requested" &&
    isExpired(latest) &&
    (sameRequest ||
      latest.signoffs.length > 0 ||
      terms.fx !== undefined ||
      terms.arrival !== undefined);
  if (expiredRequest && latest !== undefined) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      `Approval request expired before ${latest.signoffs.length === 0 ? "anyone approved it" : "enough people approved it"}, so PayOnce opened a new one`,
    );
  } else if (!sameRequest && latest?.state === "requested" && latest.signoffs.length > 0) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      `Approval by ${signersOf(latest.signoffs)} no longer counts: the terms changed, so PayOnce opened a new request`,
    );
  }
  if (opening) {
    const opened: boolean = engine.ledger.requestApproval(invoiceId, {
      binding,
      terms: JSON.stringify(terms),
      needed: rule.needed,
      neededWhy: rule.why,
      expiresAt: requestExpiry(engine, terms.fx === undefined ? null : rate, Date.now()),
    });
    // Another process closed the invoice meanwhile.
    if (!opened) {
      return null;
    }
    // Written only for a quote a request opens on, so the timeline names no rate
    // nothing could be paid at.
    if (terms.fx !== undefined) {
      note(engine.ledger, invoiceId, "payment", quoteLine(obligation, terms.fx, previous));
    }
    latest = engine.ledger.latestApproval(invoiceId);
  }
  if (latest === undefined) {
    return null;
  }
  // A held invoice can be closed without paying instead.
  const payment: string = `${money(obligation)} to ${terms.payTo} (the account on file)${paidWith(terms.fx)}`;
  note(
    engine.ledger,
    invoiceId,
    "approval",
    terms.action === "replace"
      ? latest.needed === 1
        ? `Waiting on a person to approve ${payment}`
        : `Waiting on ${latest.needed} approvers for ${payment}, because ${latest.neededWhy}`
      : latest.needed === 1
        ? `Waiting on a person to approve paying ${payment}, or to close the invoice without paying`
        : `Waiting on ${latest.needed} approvers to pay ${payment}, because ${latest.neededWhy}, or on a person to close the invoice without paying`,
    "waiting",
  );
  return expiryOf(latest);
}

// A replacement is only on offer when the original has failed, and it goes to the
// beneficiary on file. A paid original leaves nothing to pay, so the person closes
// the incident. Any other escalation has no payment a person could approve yet.
// Returns when to look again: when an open request expires, so a new one can be
// opened.
function escalate(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
): NextLook {
  // An invoice that is already with a person keeps the reason it went there for
  // when the policy would now do something else.
  engine.ledger.escalate(
    obligation.invoiceId,
    assessment.decision.action === "escalate"
      ? assessment.decision.reason
      : obligation.escalationReason,
  );
  if (assessment.incident.outsidePayoutLive) {
    return holdForOutsidePayout(engine, obligation.invoiceId);
  }
  // An invoice already paid once, by the original or a replacement, has nothing
  // left to approve.
  const originalState: OriginalTransferState = originalStateOf(assessment.original);
  if (originalState === "paid" || engine.ledger.paidOnce(obligation.invoiceId)) {
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      "Waiting on a person to check with the supplier and close the incident. PayOnce will not send a second payment",
      "waiting",
    );
    return null;
  }
  if (originalState !== "failed") {
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      originalState === "in_flight"
        ? `Waiting on a person. Original ${assessment.original.short_reference_id} is still with the bank, so PayOnce sends nothing more`
        : "Waiting on a person",
      "waiting",
    );
    return null;
  }

  // An account the original did not go to is paid only once a person has called
  // the supplier on the number on file and the record matches what they confirmed.
  if (assessment.incident.beneficiaryChanged && assessment.bankChange === null) {
    if (engine.ledger.voidOpenApprovals(obligation.invoiceId)) {
      note(
        engine.ledger,
        obligation.invoiceId,
        "approval",
        "Approval request withdrawn: the bank details on file have not been verified by a callback",
      );
    }
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      obligation.supplierPhone === null
        ? "Waiting on a person. The bank details on file are not the ones the original went to, and no phone number is on file to verify them by calling the supplier back"
        : `Waiting on a person to call the supplier on ${obligation.supplierPhone}, the number on file, and record the callback. PayOnce pays an account the original did not go to only after that`,
      "waiting",
    );
    noteFloor(engine, obligation, assessment, false);
    noteSecondBill(engine, obligation, assessment, false);
    return null;
  }

  const terms: ReplacementTerms = termsOf(obligation, assessment);
  const next: NextLook = awaitApproval(
    engine,
    obligation,
    terms,
    ruleFor(engine, obligation, terms, assessment.incident.beneficiaryChanged),
    assessment.rate,
  );
  // No request is open when nobody on the approver list could approve it, or when
  // a request on an old quote was withdrawn so the next look takes a fresh one. A
  // request awaitApproval opened just now counts its arrival from today.
  const latest: Approval | undefined = engine.ledger.latestApproval(obligation.invoiceId);
  const requested: boolean =
    latest?.state === "requested" &&
    !isExpired(latest) &&
    (latest.binding === bindingOf(terms) || latest.binding === bindingOf(countedFromToday(terms)));
  noteFloor(engine, obligation, assessment, requested);
  noteSecondBill(engine, obligation, assessment, requested);
  return next;
}

// Says that the floor reason was added to the policy's, and that the approval
// request says so too only when one is open.
function noteFloor(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  requested: boolean,
): void {
  if (assessment.floor === null) {
    return;
  }
  note(
    engine.ledger,
    obligation.invoiceId,
    "warning",
    requested
      ? `Also, ${assessment.floor}. The approval request says this too, and only an approval of that request releases a replacement`
      : `Also, ${assessment.floor}`,
    "floor",
  );
}

// Says that the invoice also looks like a second bill for a paid one when the
// policy sent it to a person for another reason, so the decision line did not
// say so.
function noteSecondBill(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  requested: boolean,
): void {
  const paid: string | null = assessment.paidDuplicate;
  if (paid === null || decide(assessment.incident).action === "replace") {
    return;
  }
  note(
    engine.ledger,
    obligation.invoiceId,
    "warning",
    requested
      ? `Also, ${secondBillReason(paid)}. The approval request says this too`
      : `Also, ${secondBillReason(paid)}`,
    "second-bill",
  );
}

// A replacement that takes cash below its floor, or that no floor can be checked
// for, is paid only on an approval whose request said so. The policy checks some
// reasons before the cash, such as a payment sent outside PayOnce, so when one of
// those sent the invoice to a person the floor reason is added to it. The request
// then names both, and an approval of terms that did not is void.
function namingFloor(assessment: Assessment): Assessment {
  const decision: Decision = assessment.decision;
  const incident: Incident = assessment.incident;
  if (
    decision.action !== "escalate" ||
    incident.originalState !== "failed" ||
    incident.outsidePayoutLive
  ) {
    return assessment;
  }
  const floor: string | null = floorReason(incident);
  if (floor === null || floor === decision.reason) {
    return assessment;
  }
  const clause: string = floor === NO_FLOOR_REASON ? NO_FLOOR_CLAUSE : floor;
  return {
    ...assessment,
    decision: { action: "escalate", reason: `${decision.reason}, and ${clause}` },
    floor: clause,
  };
}

// A replacement request names a paid invoice this one looks like a second bill
// for, whatever else sent it to a person, so the binding carries it and an
// approval given without it is void. It comes after the floor, so the policy's
// reason and the floor read as they do without one.
function namingPaidDuplicate(assessment: Assessment): Assessment {
  const decision: Decision = assessment.decision;
  const incident: Incident = assessment.incident;
  const paid: string | null = assessment.paidDuplicate;
  if (
    paid === null ||
    decision.action !== "escalate" ||
    incident.originalState !== "failed" ||
    incident.outsidePayoutLive ||
    decision.reason === secondBillReason(paid)
  ) {
    return assessment;
  }
  return {
    ...assessment,
    decision: { action: "escalate", reason: `${decision.reason}, and ${secondBillReason(paid)}` },
  };
}

// namingFloor and namingPaidDuplicate, and a line on the timeline once the floor
// stops applying after a line said it applied. The line says an approval still
// counts only when an open request or approval named the floor.
function withFloorReason(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
): Assessment {
  const lastFloorLine: LedgerEvent | undefined = [...engine.ledger.events(obligation.invoiceId)]
    .reverse()
    .find((event: LedgerEvent): boolean => event.topic === "floor");
  if (floorReason(assessment.incident) === null && lastFloorLine?.kind === "warning") {
    const approval: Approval | undefined = engine.ledger.latestApproval(obligation.invoiceId);
    const above: string =
      "A replacement and its transfer fee would now leave cash above the reserve floor";
    note(
      engine.ledger,
      obligation.invoiceId,
      "payment",
      requestedDecision(obligation, assessment, approval) === undefined
        ? above
        : `${above}. An approval of a request that named the floor still counts`,
      "floor",
    );
  }
  return namingPaidDuplicate(namingFloor(assessment));
}

// The decision an open request or approval was made under, when the floor applied
// then and does not now: cash was below it, could not be read, or no floor was
// set. Only the floor is changed, so the policy gives the reason it gave then.
// Undefined when no open request or approval named the floor.
function requestedDecision(
  obligation: Obligation,
  assessment: Assessment,
  approval: Approval | undefined,
): Decision | undefined {
  if (
    approval === undefined ||
    (approval.state !== "requested" && approval.state !== "approved") ||
    isExpired(approval) ||
    floorReason(assessment.incident) !== null
  ) {
    return undefined;
  }
  for (const floorMinor of [Number.MAX_SAFE_INTEGER, Number.NaN, null]) {
    const incident: Incident = { ...assessment.incident, reserveFloorMinor: floorMinor };
    const requested: Assessment = namingPaidDuplicate(
      namingFloor({ ...assessment, incident, decision: secondBill(decide(incident), assessment.paidDuplicate) }),
    );
    if (bindingOf(termsOf(obligation, requested)) === approval.binding) {
      return requested.decision;
    }
  }
  return undefined;
}

// The assessment as an open request or approval that named the floor saw it, so
// an approval given with less cash than there is now still covers the
// replacement. Otherwise the assessment as it is.
function asRequested(
  obligation: Obligation,
  assessment: Assessment,
  approval: Approval | undefined,
): Assessment {
  const decision: Decision | undefined = requestedDecision(obligation, assessment, approval);
  return decision === undefined ? assessment : { ...assessment, decision };
}

async function continueEscalated(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<NextLook> {
  // Once an invoice has gone to a person, only an approval releases a payment and
  // only a person closes it, even if the policy would now do either unprompted.
  const assessed: Assessment = withFloorReason(
    engine,
    obligation,
    await assess(engine, obligation, originalId),
  );
  const approval: Approval | undefined = engine.ledger.latestApproval(
    obligation.invoiceId,
  );
  const assessment: Assessment = asRequested(obligation, assessed, approval);
  const current: ReplacementTerms = termsOf(obligation, assessment);
  const rule: SignoffRule = ruleFor(engine, obligation, current, assessment.incident.beneficiaryChanged);
  // A request that stays open keeps the terms it was opened with. A new one, after
  // a void or because more approvers are needed, gives the terms as they are now.
  if (approval?.state !== "approved") {
    return escalate(
      engine,
      obligation,
      approval?.state === "requested" && approval.needed >= rule.needed ? assessment : assessed,
    );
  }
  if (voidIfStale(engine, obligation, approval, current, rule)) {
    return escalate(engine, obligation, assessed);
  }

  // A payout tied to the invoice now is looked at before anything is sent, and the
  // approval is left as it is until then. Another process may have tied one while
  // the list was being read.
  if (
    (await linkUnseenPayouts(engine, obligation.invoiceId)) ||
    anyLive(engine.ledger.outsidePayouts(obligation.invoiceId))
  ) {
    return Date.now();
  }
  // The currency lock is taken before anything is spent and held from the account
  // check to the recorded transfer, so a payment that cannot get its turn leaves
  // the approval unspent.
  return withCurrencyLock(engine.ledger, debitCurrency(obligation), async (lease: Lease): Promise<NextLook> => {
    // Checked before the approval is spent, so a failed check leaves it unspent.
    await requireAccount(engine, obligation, current.accountKey, "replacement was approved");
    // One approval covers one attempt, so it is spent as the attempt is opened.
    // Another process may have voided it since it was read, or recorded paid an
    // invoice this one looks like a second bill for since assess looked. Then
    // nothing is spent, and the next look names that invoice in a new request.
    const attempt: Attempt | undefined = engine.ledger.useApproval(
      obligation.invoiceId,
      approval.id,
      lease,
      (): boolean => paidDuplicate(engine.ledger, obligation) === assessment.paidDuplicate,
    );
    if (attempt === undefined) {
      return Date.now();
    }
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      `Approval by ${approval.approver} matches the current terms`,
    );
    const replacement: Transfer = await send(engine, obligation, attempt, current.accountKey);
    return waitForBank(engine, obligation.invoiceId, "replacement", replacement);
  });
}

// What the ledger shows of the invoices a held one looks like a second bill for,
// listed or found now: each one's state and the payments for it that reached the
// bank. duplicateEvidence reads its terms from these, so a release compares this
// under the lease with what it was when the terms were taken.
function duplicatesOnFile(ledger: Ledger, held: Obligation): string {
  const found: string[] = likelyDuplicates(ledger, held).map(
    (other: Obligation): string => other.invoiceId,
  );
  return JSON.stringify(
    [...new Set([...held.duplicateOf, ...found])].map((invoiceId: string): unknown[] => [
      invoiceId,
      ledger.obligation(invoiceId)?.state ?? null,
      [...ledger.attempts(invoiceId), ...ledger.outsidePayouts(invoiceId)]
        .filter((payment: { transferId: string | null }): boolean => payment.transferId !== null)
        .map((payment: { transferId: string | null; state: string }): string[] => [
          payment.transferId ?? "",
          payment.state,
        ]),
    ]),
  );
}

// The invoices a held one looks like a second bill for, as they stand now, and
// whether the payment that paid each, or one still with the bank, went to the
// account with this accountKey.
async function duplicateEvidence(
  engine: Engine,
  obligation: Obligation,
  accountKey: string,
): Promise<DuplicateEvidence[]> {
  const evidence: DuplicateEvidence[] = [];
  for (const invoiceId of obligation.duplicateOf) {
    const other: Obligation | undefined = engine.ledger.obligation(invoiceId);
    if (other === undefined) {
      continue;
    }
    const payments: { reference: string | null; transferId: string | null; state: string }[] = [
      ...engine.ledger.attempts(invoiceId),
      ...engine.ledger.outsidePayouts(invoiceId),
    ].filter((payment: { transferId: string | null }): boolean => payment.transferId !== null);
    const paid: { reference: string | null; transferId: string | null } | undefined = payments.find(
      (payment: { state: string }): boolean => payment.state === "paid",
    );
    const sent: { transferId: string | null } | undefined =
      paid ?? payments.find((payment: { state: string }): boolean => payment.state === "in_flight");
    let sameAccount: boolean | null = null;
    if (sent !== undefined && sent.transferId !== null) {
      const details: TransferBankDetails | undefined = (
        await getTransfer(engine.client, sent.transferId)
      ).beneficiary?.bank_details;
      sameAccount = details === undefined ? null : accountKeyOf(details) === accountKey;
    }
    evidence.push({ invoiceId, state: other.state, paidBy: paid?.reference ?? null, sameAccount });
  }
  return evidence;
}

// True when a payment for the invoice, PayOnce's or one sent outside it, is paid.
function isPaid(ledger: Ledger, invoiceId: string): boolean {
  return (
    ledger.attempts(invoiceId).some((attempt: Attempt): boolean => attempt.state === "paid") ||
    ledger.outsidePayouts(invoiceId).some((payout: OutsidePayout): boolean => payout.state === "paid")
  );
}

// True for an invoice with a person that has sent nothing: PayOnce held it before
// paying, or Airwallex refused every payment it was sent with.
export function heldBeforePaying(ledger: Ledger, obligation: Obligation): boolean {
  return (
    obligation.state === "escalated" &&
    ledger
      .attempts(obligation.invoiceId)
      .every((attempt: Attempt): boolean => attempt.transferId === null && attempt.state === "failed")
  );
}

function listOf(invoiceIds: string[]): string {
  return invoiceIds.length <= 1
    ? (invoiceIds[0] ?? "")
    : `${invoiceIds.slice(0, -1).join(", ")} and ${invoiceIds.at(-1)}`;
}

// The reason a pay run row is held at send when paying it would take cash below
// the floor. It stays the same whatever the numbers, so it does not void an
// approval by its wording.
export const CASH_HOLD_REASON: string =
  "paying it now would take cash below the reserve floor";

function waitingForFirst(ledger: Ledger, invoiceId: string): Obligation | undefined {
  const now: Obligation | undefined = ledger.obligation(invoiceId);
  return now?.state === "open" && ledger.attempts(invoiceId).length === 0 ? now : undefined;
}

// What startPayment found once every check had run: an attempt to send, or a
// reason to hold the invoice, written already. sameNumber lists the invoices in
// duplicateOf that only share its number, for another amount or currency.
type FirstPayment =
  | { kind: "send"; obligation: Obligation; attempt: Attempt }
  | { kind: "held"; duplicateOf: string[]; sameNumber: string[]; reason: string; detail: string | null };

// Puts a hold startPayment wrote on the timelines, after its transaction.
function noteHold(engine: Engine, invoiceId: string, held: Extract<FirstPayment, { kind: "held" }>): void {
  note(engine.ledger, invoiceId, "decision", `Escalate: ${held.reason}`, "decision");
  if (held.detail !== null) {
    note(engine.ledger, invoiceId, "warning", held.detail, "cost");
  }
  for (const other of held.duplicateOf) {
    note(
      engine.ledger,
      other,
      "warning",
      held.sameNumber.includes(other)
        ? `${invoiceId} has the same invoice number as this invoice, for the same supplier, so PayOnce held it before paying`
        : `${invoiceId} looks like a second bill for this invoice, so PayOnce held it before paying`,
    );
  }
}

// Why a pay run row is not sent to the record as it is now, or null when the
// record still holds the account the run was approved for.
async function accountProblem(
  engine: Engine,
  obligation: Obligation,
  accountKey: string,
): Promise<string | null> {
  const record: BeneficiaryRecord | undefined = await findBeneficiary(
    engine.client,
    obligation.beneficiaryId,
  );
  const details: TransferBankDetails | undefined = record?.beneficiary?.bank_details;
  if (details === undefined) {
    return "the beneficiary is no longer in Airwallex";
  }
  return accountKeyOf(details) === accountKey
    ? null
    : "its bank details changed after the pay run was approved";
}

// Why a new invoice is held before paying because of other invoices: it looks
// like a second bill for one, it has the number of another invoice to the same
// supplier, for any amount, or a payout for it sent outside PayOnce is live.
// Undefined when none of these holds. Reads only the ledger, so it runs in the
// transaction that would open the attempt.
function heldForOthers(
  ledger: Ledger,
  obligation: Obligation,
): Extract<FirstPayment, { kind: "held" }> | undefined {
  const duplicates: string[] = likelyDuplicates(ledger, obligation).map(
    (other: Obligation): string => other.invoiceId,
  );
  const sameNumber: string[] = sameNumberForSupplier(ledger, obligation)
    .map((other: Obligation): string => other.invoiceId)
    .filter((other: string): boolean => !duplicates.includes(other));
  const duplicateOf: string[] = [...duplicates, ...sameNumber];
  if (duplicateOf.length === 0 && !anyLive(ledger.outsidePayouts(obligation.invoiceId))) {
    return undefined;
  }
  const reason: string =
    duplicates.length > 0
      ? `it looks like a second bill for ${listOf(duplicates)}: the same supplier and amount, and the same invoice number apart from case, spacing, leading zeros or letters added at the end`
      : sameNumber.length > 0
        ? `it has the same invoice number as ${listOf(sameNumber)}, apart from case, spacing, leading zeros or letters added at the end, for the same supplier, and PayOnce pays an invoice number once`
        : OUTSIDE_PAYOUT_REASON;
  return { kind: "held", duplicateOf, sameNumber, reason, detail: null };
}

// Sends a new invoice's original, unless it looks like a second bill for an
// invoice the ledger already has, has the number of another invoice to the same
// supplier, a payout for it sent outside PayOnce may already pay it, or it is
// paid from another currency's wallet, so a person approves the rate. Then it
// holds the invoice for a person, sends nothing and returns null. accountKey is
// the account a pay run approved, and a pay run's row is held too when the
// record no longer holds it, or when paying it would take cash below the floor.
// A pay run's row is never paid from another currency's wallet. Call it in the
// invoice's turn.
//
// It holds the currency lock of the wallet the money leaves throughout. The reads
// from Airwallex come first, with the beneficiary record last, and every check
// after them runs in the transaction that opens the attempt, so nothing is
// awaited between the last check and the attempt. When it throws, the next look
// comes a minute later and tries again: it sends the original if no attempt was
// opened, and retries a pending one under its request_id.
export async function startPayment(
  engine: Engine,
  obligation: Obligation,
  accountKey: string | null = null,
): Promise<Transfer | null> {
  const invoiceId: string = obligation.invoiceId;
  if (waitingForFirst(engine.ledger, invoiceId) === undefined) {
    throw new Error(`${invoiceId} is not waiting for its first payment`);
  }
  // Pay runs do not pay across currencies: a row pays in its own currency from
  // that currency's wallet.
  if (obligation.runRowId !== null && crossCurrency(obligation)) {
    throw new Error(
      `${invoiceId} is a pay run row paid from ${obligation.sourceCurrency}, and a pay run pays each row from its own currency's wallet, so PayOnce sent nothing`,
    );
  }
  const wallet: string = debitCurrency(obligation);
  try {
    return await withCurrencyLock(engine.ledger, wallet, async (lease: Lease): Promise<Transfer | null> => {
      // A pay run's row is held to the floor. A single incident's original is not.
      // The money committed elsewhere is counted before the balance read and again
      // in the transaction.
      const before: Map<string, number> = committedByInvoice(engine.ledger, wallet, { invoiceId });
      const availableMinor: number | null =
        obligation.runRowId === null ? null : await getAvailableMinor(engine.client, wallet);
      await linkUnseenPayouts(engine, invoiceId);
      // Read last, so the record is checked as close to the attempt as a read
      // from Airwallex can be.
      const wrongAccount: string | null =
        accountKey === null ? null : await accountProblem(engine, obligation, accountKey);

      const first: FirstPayment = engine.ledger.transaction((): FirstPayment => {
        // Another process may have held or paid it while Airwallex was read.
        const now: Obligation | undefined = waitingForFirst(engine.ledger, invoiceId);
        if (now === undefined) {
          throw new Error(`${invoiceId} is not waiting for its first payment`);
        }
        if (wrongAccount !== null) {
          engine.ledger.holdBeforePaying(invoiceId, [], wrongAccount);
          return { kind: "held", duplicateOf: [], sameNumber: [], reason: wrongAccount, detail: null };
        }
        const held: Extract<FirstPayment, { kind: "held" }> | undefined = heldForOthers(engine.ledger, now);
        if (held !== undefined) {
          engine.ledger.holdBeforePaying(invoiceId, held.duplicateOf, held.reason);
          return held;
        }
        // The agent never pays at a rate nobody has seen, so this is the least
        // serious reason to hold it and comes after the others.
        if (crossCurrency(now)) {
          const reason: string = `it is paid from ${now.sourceCurrency}, so a person approves the exchange rate before PayOnce pays it`;
          engine.ledger.holdBeforePaying(invoiceId, [], reason);
          return { kind: "held", duplicateOf: [], sameNumber: [], reason, detail: null };
        }
        if (availableMinor !== null) {
          const short: string | null = floorBreach(engine, now, availableMinor, before);
          if (short !== null) {
            engine.ledger.holdBeforePaying(invoiceId, [], CASH_HOLD_REASON);
            return { kind: "held", duplicateOf: [], sameNumber: [], reason: CASH_HOLD_REASON, detail: short };
          }
        }
        return { kind: "send", obligation: now, attempt: engine.ledger.openAttempt(invoiceId, "original", lease) };
      });
      if (first.kind === "held") {
        noteHold(engine, invoiceId, first);
        return null;
      }
      try {
        const original: Transfer = await send(engine, first.obligation, first.attempt, accountKey);
        // The look at its deadline is planned as soon as it is with the bank, so it
        // comes even if nothing wakes the invoice before, for example when the
        // sandbox bank's script fails.
        engine.ledger.lookAt(invoiceId, deadlineLook(original));
        return original;
      } catch (error: unknown) {
        const refused: Attempt | undefined = engine.ledger.attempts(invoiceId).at(-1);
        if (refused?.state !== "failed" || refused.transferId !== null) {
          throw error;
        }
        note(engine.ledger, invoiceId, "error", messageOf(error));
        holdRefused(engine, first.obligation, refused);
        return null;
      }
    });
  } catch (error: unknown) {
    // The transfer may exist, or nothing was opened at all, for example when the
    // lock never came free. A look tries again a minute later, as after a look
    // that failed, so an invoice started from the page is never left with no
    // payment and no look.
    const at: number = Date.now();
    engine.ledger.postponeDueLook(invoiceId, at, at + RETRY_FAILED_LOOK_MS);
    throw error;
  }
}

// What is wrong with paying a pay run's row now, against the floor of its
// currency, or null when it fits. Money promised elsewhere is taken off,
// including the run's other rows not sent yet. A currency with no floor set does
// not stop a row, because a person approved the run.
function floorBreach(
  engine: Engine,
  obligation: Obligation,
  availableMinor: number,
  committedBefore: Map<string, number>,
): string | null {
  const wallet: string = debitCurrency(obligation);
  const floorMinor: number | null = floorFor(engine.reserve, obligation);
  if (floorMinor === null) {
    return null;
  }
  if (!Number.isFinite(floorMinor)) {
    return "The reserve floor setting could not be read, so PayOnce did not pay this invoice";
  }
  const feeMinor: number = engine.ledger.latestFee(wallet, obligation.transferMethod) ?? 0;
  const afterMinor: number =
    availableMinor -
    committedAcross(
      committedBefore,
      committedByInvoice(engine.ledger, wallet, { invoiceId: obligation.invoiceId }),
    ) -
    obligation.amountMinor -
    feeMinor;
  return afterMinor >= floorMinor
    ? null
    : `Paying it now would leave ${formatMoney(afterMinor, wallet)}, ${formatMoney(floorMinor - afterMinor, wallet)} below the reserve floor of ${formatMoney(floorMinor, wallet)}`;
}

// Airwallex refused every original the invoice was sent with, so nothing was
// paid. It goes to a person and pays only on an approval, like a held invoice.
function holdRefused(engine: Engine, obligation: Obligation, refused: Attempt): Obligation {
  const reason: string = `Airwallex refused the original payment${refused.failureCode === null ? "" : ` (${refused.failureCode})`}, so nothing was sent`;
  engine.ledger.escalate(obligation.invoiceId, reason);
  note(engine.ledger, obligation.invoiceId, "decision", `Escalate: ${reason}`, "decision");
  return { ...obligation, state: "escalated", escalationReason: reason };
}

// An invoice held before paying waits for a person. Once the approvers approve
// paying it, the agent sends the original and the invoice carries on like any
// other. A person can instead close it without paying. A payout for it sent
// outside PayOnce holds everything, as it does on any invoice.
async function continueHeld(engine: Engine, obligation: Obligation): Promise<NextLook> {
  const invoiceId: string = obligation.invoiceId;
  if (anyLive(await syncOutsidePayouts(engine, invoiceId))) {
    return holdForOutsidePayout(engine, invoiceId);
  }
  // A person decided not to pay it, and a payout sent outside PayOnce reopened it.
  // That payout has failed, so it is closed again and nobody is asked to pay it.
  if (obligation.rejectedBy !== null) {
    if (engine.ledger.reject(invoiceId, obligation.rejectedBy)) {
      note(
        engine.ledger,
        invoiceId,
        "closed",
        `Closed without paying again. The payout sent outside PayOnce failed, and ${obligation.rejectedBy} had already closed this invoice without paying`,
      );
    }
    return null;
  }
  // The invoices it was held for, and any that match it now: one started after
  // it, or one that came first while this one was held for another reason.
  const added: string[] = likelyDuplicates(engine.ledger, obligation)
    .map((other: Obligation): string => other.invoiceId)
    .filter((other: string): boolean => !obligation.duplicateOf.includes(other));
  const held: Obligation = { ...obligation, duplicateOf: [...obligation.duplicateOf, ...added] };
  if (added.length > 0) {
    engine.ledger.setDuplicateOf(invoiceId, held.duplicateOf);
    note(
      engine.ledger,
      invoiceId,
      "warning",
      `This invoice also looks like a second bill for ${listOf(added)}: the same supplier and amount, and the same invoice number apart from case, spacing, leading zeros or letters added at the end`,
    );
  }
  const record: BeneficiaryRecord | undefined = await findBeneficiary(
    engine.client,
    obligation.beneficiaryId,
  );
  const bankDetails: TransferBankDetails | undefined = record?.beneficiary?.bank_details;
  if (bankDetails === undefined) {
    return waitWithoutPaying(
      engine,
      invoiceId,
      "the beneficiary is no longer in Airwallex",
      "Waiting on a person. The beneficiary is no longer in Airwallex, so there is nothing to pay it to. Close the invoice without paying",
    );
  }
  const accountKey: string = accountKeyOf(bankDetails);
  // A pay run approved one account. Another is paid only once a callback verified
  // it, and then by two approvers.
  const row: RunRow | undefined =
    obligation.runRowId === null ? undefined : engine.ledger.runRow(obligation.runRowId);
  if (
    row !== undefined &&
    row.accountKey !== accountKey &&
    engine.ledger.verifiedBankChange(obligation.beneficiaryId, bankDetailsKey(bankDetails)) ===
      undefined
  ) {
    return waitWithoutPaying(
      engine,
      invoiceId,
      "the bank details on file are not the ones the pay run approved",
      "Waiting on a person. The bank details on file are not the ones the pay run approved, so PayOnce does not pay this invoice. Close it without paying, or restore the approved details in Airwallex and check again",
    );
  }
  const onFile: string = duplicatesOnFile(engine.ledger, held);
  const duplicates: DuplicateEvidence[] = await duplicateEvidence(engine, held, accountKey);
  // Paid from another currency's wallet, it is approved at a quote. Nothing has
  // been sent, so no fee is known yet.
  const rate: Rate | null = crossCurrency(obligation) ? await rateFor(engine, obligation, null) : null;
  const terms: HeldPaymentTerms = heldTermsFor(
    held,
    bankDetails,
    duplicates,
    rate?.fx ?? null,
    arrivalOf(engine.ledger, obligation, bankDetails),
  );
  // A second bill paid to a different account from the first is the pattern of an
  // invoice resent with new bank details, so it needs two approvers.
  const elsewhere: DuplicateEvidence | undefined = duplicates.find(
    (duplicate: DuplicateEvidence): boolean => duplicate.sameAccount === false,
  );
  if (elsewhere !== undefined) {
    note(
      engine.ledger,
      invoiceId,
      "warning",
      `The account on file for this invoice is not the one ${elsewhere.invoiceId} was sent to`,
      "bank-details",
    );
  }
  // A pay run row keeps the run's rules: two approvers for a payee PayOnce has
  // never paid, and for an account it has not paid this supplier before.
  const payee: SignoffRule | null = row === undefined ? null : await payeeRule(engine, obligation, accountKey);
  const rule: SignoffRule =
    elsewhere !== undefined
      ? { needed: 2, why: `it pays a different account from the one ${elsewhere.invoiceId} was sent to` }
      : (payee ??
        signoffsNeeded(engine.approvals, paymentAmount(terms), false, obligation.startedBy));
  const approval: Approval | undefined = engine.ledger.latestApproval(invoiceId);
  if (approval?.state !== "approved" || voidIfStale(engine, held, approval, terms, rule)) {
    return awaitApproval(engine, held, terms, rule, rate);
  }

  if (
    (await linkUnseenPayouts(engine, invoiceId)) ||
    anyLive(engine.ledger.outsidePayouts(invoiceId))
  ) {
    return Date.now();
  }
  return withCurrencyLock(engine.ledger, debitCurrency(obligation), async (lease: Lease): Promise<NextLook> => {
    // Checked before the invoice is released, so a failed check leaves it held
    // with its approval unspent.
    await requireAccount(engine, obligation, terms.accountKey, "payment was approved");
    // Another process may have voided the approval, closed the invoice or tied a
    // payout to it since it was read, or changed what the terms say of the
    // invoices it looks like a second bill for. A match the terms do not list,
    // even one found before onFile was taken, refuses it too. The next look sees
    // which, and adds a new match to the terms.
    const attempt: Attempt | undefined = engine.ledger.releaseFor(
      invoiceId,
      approval.id,
      lease,
      (): boolean =>
        duplicatesOnFile(engine.ledger, held) === onFile &&
        likelyDuplicates(engine.ledger, held).every((other: Obligation): boolean =>
          held.duplicateOf.includes(other.invoiceId),
        ),
    );
    if (attempt === undefined) {
      return Date.now();
    }
    note(
      engine.ledger,
      invoiceId,
      "approval",
      `Approval by ${approval.approver} matches the current terms, so PayOnce pays the invoice`,
    );
    const original: Transfer = await send(
      engine,
      { ...held, state: "open" },
      attempt,
      terms.accountKey,
    );
    return waitForBank(engine, invoiceId, "original", original);
  });
}

// Two approvers for a payment to a beneficiary PayOnce has never paid, or to an
// account it has not paid this supplier before. Null when PayOnce last paid this
// very account.
async function payeeRule(
  engine: Engine,
  obligation: Obligation,
  accountKey: string,
): Promise<SignoffRule | null> {
  const last: { transferId: string } | undefined = engine.ledger.lastPaidTransfer(
    obligation.beneficiaryId,
  );
  if (last === undefined) {
    return { needed: 2, why: "PayOnce has never paid this beneficiary" };
  }
  const details: TransferBankDetails | undefined = (await getTransfer(engine.client, last.transferId))
    .beneficiary?.bank_details;
  return details !== undefined && accountKeyOf(details) === accountKey
    ? null
    : { needed: 2, why: "it pays an account PayOnce has not paid this supplier before" };
}

// A held invoice with nothing a person could approve paying: any open request is
// withdrawn, and the timeline says what the invoice waits on.
function waitWithoutPaying(
  engine: Engine,
  invoiceId: string,
  withdrawn: string,
  waiting: string,
): NextLook {
  if (engine.ledger.voidOpenApprovals(invoiceId)) {
    note(engine.ledger, invoiceId, "approval", `Approval request withdrawn: ${withdrawn}`);
  }
  note(engine.ledger, invoiceId, "approval", waiting, "waiting");
  return null;
}

// An automatic replacement, while holding the currency lock. The balance is read
// again under the lock and the policy decides again on it, with the money
// committed elsewhere as it is now, so two replacements in one currency cannot
// both pass on the same cash. The decision runs in the transaction that opens
// the attempt, so nothing is awaited between them.
async function replaceUnderLock(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  lease: Lease,
): Promise<NextLook> {
  const invoiceId: string = obligation.invoiceId;
  // A payout tied to the invoice now is looked at before anything is sent.
  if (await linkUnseenPayouts(engine, invoiceId)) {
    return Date.now();
  }
  const accountKey: string = accountKeyOf(assessment.bankDetails);
  await requireAccount(engine, obligation, accountKey, "decision");
  const wallet: string = debitCurrency(obligation);
  const before: Map<string, number> = committedByInvoice(engine.ledger, wallet, { invoiceId });
  const availableMinor: number = await getAvailableMinor(engine.client, wallet);

  let incident: Incident = assessment.incident;
  let paid: string | null = assessment.paidDuplicate;
  const next: Attempt | Decision = engine.ledger.transaction((): Attempt | Decision => {
    incident = {
      ...assessment.incident,
      availableBalanceMinor: availableMinor,
      committedMinor: committedAcross(
        before,
        committedByInvoice(engine.ledger, wallet, { invoiceId }),
      ),
    };
    // assess makes this check too. Made again here for an invoice paid since.
    paid = paidDuplicate(engine.ledger, obligation);
    const decision: Decision = secondBill(decide(incident), paid);
    // Opening the attempt takes the duplicate lock, so this throws if the invoice
    // already has a live payment.
    return decision.action === "replace"
      ? engine.ledger.openAttempt(invoiceId, "replacement", lease)
      : decision;
  });
  if ("action" in next) {
    note(engine.ledger, invoiceId, "decision", `Escalate: ${next.reason}${arrivalClause(assessment)}`, "decision");
    // The first request names the floor as well, as every later one does.
    return escalate(
      engine,
      obligation,
      withFloorReason(engine, obligation, { ...assessment, incident, decision: next, paidDuplicate: paid }),
    );
  }
  const replacement: Transfer = await send(engine, obligation, next, accountKey);
  return waitForBank(engine, invoiceId, "replacement", replacement);
}

// Carries out a decision: replace, close, hand over to a person, or wait for the
// bank until the original's deadline.
async function act(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
): Promise<NextLook> {
  switch (assessment.decision.action) {
    case "replace":
      return withCurrencyLock(
        engine.ledger,
        debitCurrency(obligation),
        (lease: Lease): Promise<NextLook> => replaceUnderLock(engine, obligation, assessment, lease),
      );
    case "wait":
      return waitForBank(engine, obligation.invoiceId, "original", assessment.original);
    case "escalate":
      // The first request names the floor as well, as every later one does.
      return escalate(engine, obligation, withFloorReason(engine, obligation, assessment));
    case "close":
      if (!close(engine, obligation.invoiceId)) {
        note(
          engine.ledger,
          obligation.invoiceId,
          "error",
          "The ledger does not show this invoice as paid once, so the incident stays open",
        );
      }
      return null;
  }
}

// True for an attempt sent on a quote that ran out a bank deadline ago. Airwallex
// refuses to create a transfer on a quote that has run out, and a transfer
// created before then has had that long to show.
function quoteLapsed(obligation: Obligation, attempt: Attempt): boolean {
  if (attempt.quoteValidTo === null) {
    return false;
  }
  const deadline: number =
    Date.parse(attempt.quoteValidTo) + deadlineMinutes(obligation.transferMethod) * 60_000;
  return !(Date.now() < deadline);
}

// Looks at an invoice again, after a webhook, a status check, new emails, a
// person's action or a deadline. It syncs each payment with Airwallex, retrying an
// attempt that has no transfer yet under its original request_id, and notes any
// payment the bank has paid or failed since the last look. Then it reads new
// emails, decides and acts. A replacement already out is waited on until its
// deadline, never approved a second time. An escalated invoice pays only on a
// matching approval. sendRunRow lets the look send a pay run row's first
// payment, which only the release and the server's watcher pass.
export async function resumeIncident(
  engine: Engine,
  invoiceId: string,
  sendRunRow: boolean = false,
): Promise<void> {
  let next: NextLook;
  try {
    next = await look(engine, invoiceId, sendRunRow);
  } catch (error: unknown) {
    // A deadline already passed stays due, and the watcher has the agent try
    // again a minute later rather than on every check.
    const now: number = Date.now();
    engine.ledger.postponeDueLook(invoiceId, now, now + RETRY_FAILED_LOOK_MS);
    throw error;
  }
  engine.ledger.lookAt(invoiceId, next);
}

// Sends an attempt still pending with no transfer again, under its request_id,
// holding the currency lock of the wallet the money leaves. A retry pays the
// record as it is now, so a replacement, an original paid on an approval after a
// hold, or a pay run's original goes out only to the account it was approved or
// decided for. The approval is the one the attempt was opened on, so a request
// another process opened since does not count. A used approval names the account
// before the run row does, since a person may have approved another account after
// the row was held.
//
// Once its quote has run out a bank deadline ago, a payment from another
// currency's wallet has one last try, which fails it if Airwallex refuses its
// quote and lists no transfer for it. Null then: nothing was sent, and a person
// approves it on a new quote.
async function retry(
  engine: Engine,
  obligation: Obligation,
  attempt: Attempt,
  original: Transfer | null,
): Promise<Transfer | null> {
  const approval: Approval | undefined = engine.ledger.approvalOf(attempt);
  const approved: ApprovalTerms | undefined =
    approval?.state === "used" ? (JSON.parse(approval.terms) as ApprovalTerms) : undefined;
  const row: RunRow | undefined =
    obligation.runRowId === null ? undefined : engine.ledger.runRow(obligation.runRowId);
  if (attempt.kind === "replacement") {
    await requireAccount(
      engine,
      obligation,
      approved?.action === "replace"
        ? approved.accountKey
        : accountKeyOf(original?.beneficiary?.bank_details),
      "replacement was approved",
    );
  } else if (approved?.action === "pay") {
    await requireAccount(engine, obligation, approved.accountKey, "payment was approved");
  } else if (row?.accountKey !== undefined && row.accountKey !== null) {
    await requireAccount(engine, obligation, row.accountKey, "pay run was approved");
  }
  const lapsed: boolean = quoteLapsed(obligation, attempt);
  try {
    return await sendAttempt(engine.client, engine.ledger, obligation, attempt, lapsed ? "lapsed" : "retry");
  } catch (error: unknown) {
    // Nothing was sent only if the last try failed the attempt on a refusal.
    // Anything else, such as a failed listing, fails the look, which is retried.
    const failed: boolean = engine.ledger
      .attempts(obligation.invoiceId)
      .some(
        (current: Attempt): boolean =>
          current.requestId === attempt.requestId && current.state === "failed",
      );
    if (!lapsed || !wasRejected(error) || !failed) {
      throw error;
    }
    note(
      engine.ledger,
      obligation.invoiceId,
      "payment",
      `${capitalise(attempt.kind)} payment never became a transfer: its exchange rate quote ran out, and Airwallex refused a last try under the same request id and lists no transfer with it (${error.code ?? String(error.status)}). Nothing was sent, so it needs a new approval on a new quote`,
    );
    return null;
  }
}

// The first payment of an open invoice with no attempt. A pay run's row sends its
// original, to the account the run approved, only in its turn: when the release
// or the server's watcher passes sendRunRow. Any other look leaves it for that
// turn. Any other invoice is here only when its first send failed before an
// attempt was opened, and the look tries it again. When startPayment holds it
// instead, the next look comes at once, and asks a person.
async function startFirst(
  engine: Engine,
  obligation: Obligation,
  sendRunRow: boolean,
): Promise<NextLook> {
  const invoiceId: string = obligation.invoiceId;
  let accountKey: string | null = null;
  if (obligation.runRowId !== null) {
    const row: RunRow | undefined = engine.ledger.runRow(obligation.runRowId);
    if (row === undefined || row.accountKey === null) {
      throw new Error(`${invoiceId} has no pay run row to send it from`);
    }
    if (!sendRunRow) {
      note(
        engine.ledger,
        invoiceId,
        "payment",
        `Waiting for its turn in pay run ${row.runId}. The server sends the run's first payments one at a time`,
        "waiting",
      );
      // Due at once, so the server's watcher gives it its turn.
      return Date.now();
    }
    accountKey = row.accountKey;
  }
  const original: Transfer | null = await startPayment(engine, obligation, accountKey);
  return original === null ? Date.now() : waitForBank(engine, invoiceId, "original", original);
}

async function look(engine: Engine, invoiceId: string, sendRunRow: boolean): Promise<NextLook> {
  const read: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (read === undefined) {
    throw new Error(`${invoiceId} is not in the ledger`);
  }
  let obligation: Obligation = read;

  let originalId: string | null = null;
  let original: Transfer | null = null;
  let liveReplacement: Transfer | null = null;
  for (const attempt of engine.ledger.attempts(invoiceId)) {
    // An attempt Airwallex refused never became a transfer. Only one still
    // pending is retried.
    if (attempt.transferId === null && attempt.state !== "pending") {
      continue;
    }
    let transfer: Transfer;
    const existing: Transfer | undefined =
      attempt.transferId === null
        ? await findTransferByRequestId(engine.client, attempt.requestId)
        : undefined;
    if (existing !== undefined) {
      transfer = await syncTransfer(engine.client, engine.ledger, existing.id);
      checkRate(engine, obligation, attempt, transfer);
      engine.bank?.sent(invoiceId, attempt.kind, transfer.id);
    } else if (attempt.transferId === null) {
      const paying: Obligation = obligation;
      const sent: Transfer | null = await withCurrencyLock(
        engine.ledger,
        debitCurrency(paying),
        (): Promise<Transfer | null> => retry(engine, paying, attempt, original),
      );
      if (sent === null) {
        continue;
      }
      transfer = sent;
      checkRate(engine, obligation, attempt, transfer);
      engine.bank?.sent(invoiceId, attempt.kind, transfer.id);
    } else {
      transfer = await syncTransfer(engine.client, engine.ledger, attempt.transferId);
    }
    const state: AttemptState | null = attemptStateOf(transfer);
    if (state !== attempt.state && (state === "paid" || state === "failed")) {
      note(engine.ledger, invoiceId, "bank", `${capitalise(attempt.kind)} ${describe(transfer)}`);
    }
    if (attempt.kind === "original") {
      originalId = transfer.id;
      original = transfer;
    } else if (originalStateOf(transfer) === "in_flight") {
      liveReplacement = transfer;
    }
    console.log(`  ${attempt.kind} ${describe(transfer)}`);
  }
  // A transfer found at a rate nobody approved may have escalated it above.
  obligation = engine.ledger.obligation(invoiceId) ?? obligation;

  if (originalId === null) {
    const refused: Attempt | undefined = engine.ledger.attempts(invoiceId).at(-1);
    if (refused === undefined && obligation.state === "open") {
      return startFirst(engine, obligation, sendRunRow);
    }
    if (refused !== undefined && obligation.state === "open") {
      return continueHeld(engine, holdRefused(engine, obligation, refused));
    }
    return heldBeforePaying(engine.ledger, obligation) ? continueHeld(engine, obligation) : null;
  }
  const outside: OutsidePayout[] = await syncOutsidePayouts(engine, invoiceId);
  await readNewEmails(engine, obligation);
  if (engine.ledger.paidOnce(invoiceId)) {
    // Closed already, by the policy or by a person.
    if (obligation.state === "settled") {
      return null;
    }
    // A paid replacement was sent on a decision already made, so it closes the
    // incident. A paid original goes to the policy, which may want a person. So
    // does an invoice with a live payout sent outside PayOnce.
    if (paidOriginal(engine.ledger, invoiceId) === undefined && !anyLive(outside)) {
      // Refused when a payment went out at a rate nobody approved.
      if (!close(engine, invoiceId)) {
        note(
          engine.ledger,
          invoiceId,
          "approval",
          "Waiting on a person to check the exchange rate a payment went out at and close the incident. PayOnce will not send another payment",
          "waiting",
        );
      }
      return null;
    }
  }
  if (liveReplacement !== null) {
    return isOverdue(liveReplacement)
      ? replacementOverdue(engine, invoiceId, liveReplacement)
      : waitForBank(engine, invoiceId, "replacement", liveReplacement);
  }
  if (obligation.state === "escalated") {
    return continueEscalated(engine, obligation, originalId);
  }
  return act(engine, obligation, await assess(engine, obligation, originalId));
}

const ATTEMPT_STATE_WORDS: Record<AttemptState, string> = {
  pending: "pending",
  in_flight: "in flight",
  paid: "paid",
  failed: "failed",
};

export interface PayAgainResult {
  refused: boolean;
  message: string;
}

// A person asks for the invoice to be paid again. The request takes the duplicate
// lock like any payment, inside a transaction that is always rolled back, so it
// never reaches Airwallex. When every payment has failed the lock has nothing to
// refuse, but a replacement still goes through the policy and any approval, so
// nothing is sent from here either.
export function payAgain(ledger: Ledger, invoiceId: string): PayAgainResult {
  try {
    ledger.tryLock(invoiceId);
  } catch (error: unknown) {
    if (!(error instanceof DuplicatePaymentError)) {
      throw error;
    }
    const holder: Attempt | undefined = ledger
      .attempts(invoiceId)
      .find((attempt: Attempt): boolean => attempt.state !== "failed");
    const held: string =
      holder === undefined
        ? ""
        : `: ${holder.kind} ${holder.reference ?? "with no reference yet"} is ${ATTEMPT_STATE_WORDS[holder.state]}`;
    const message: string = `Pay again refused by the duplicate lock${held}. An invoice can have one live payment`;
    note(ledger, invoiceId, "lock", message);
    return { refused: true, message };
  }
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  const message: string =
    obligation?.state === "settled"
      ? "Pay again not sent. The incident is closed, so PayOnce pays nothing more for this invoice"
      : obligation?.state === "rejected"
        ? "Pay again not sent. A person closed this invoice without paying, because it was a second bill for another invoice"
        : anyLive(ledger.outsidePayouts(invoiceId))
          ? "Pay again not sent. A payout sent outside PayOnce may already pay this invoice"
          : obligation !== undefined && heldBeforePaying(ledger, obligation)
            ? "Pay again not sent. PayOnce is holding this invoice before paying it, so it pays only on an approval"
            : "Pay again not sent. No payment for this invoice is live, so a replacement goes through the policy, and through a person's approval once the invoice is with a person";
  note(ledger, invoiceId, "warning", message);
  return { refused: false, message };
}

// The original, when it is the one payment the invoice has been paid with.
function paidOriginal(ledger: Ledger, invoiceId: string): Attempt | undefined {
  if (!ledger.paidOnce(invoiceId)) {
    return undefined;
  }
  return ledger
    .attempts(invoiceId)
    .find(
      (attempt: Attempt): boolean =>
        attempt.kind === "original" && attempt.state === "paid",
    );
}

// What a person is shown before closing an escalated invoice the bank reports as
// paid once: by PayOnce's original or replacement, or by a payout sent outside
// PayOnce after every payment PayOnce sent failed. kind duplicate is an invoice
// held before paying as a second bill for others, and its reference lists them.
// kind unpaid is any other invoice that has sent nothing, such as one whose
// original Airwallex refused. Closing either leaves it unpaid.
export interface CloseReview {
  kind: AttemptKind | "outside" | "duplicate" | "unpaid";
  reference: string | null;
  reason: string;
}

export function pendingClose(
  ledger: Ledger,
  invoiceId: string,
): CloseReview | undefined {
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  if (obligation?.state !== "escalated") {
    return undefined;
  }
  const reason: string = obligation.escalationReason;
  if (ledger.paidOnce(invoiceId)) {
    const paid: Attempt | undefined = ledger
      .attempts(invoiceId)
      .find((attempt: Attempt): boolean => attempt.state === "paid");
    // A payment at a rate nobody approved is why it was not closed by itself.
    return paid === undefined
      ? undefined
      : { kind: paid.kind, reference: paid.reference, reason: paid.rateMismatch ?? reason };
  }
  if (ledger.paidOutside(invoiceId)) {
    const paid: OutsidePayout | undefined = ledger
      .outsidePayouts(invoiceId)
      .find((payout: OutsidePayout): boolean => payout.state === "paid");
    return paid === undefined
      ? undefined
      : { kind: "outside", reference: paid.reference, reason };
  }
  // Not while a payout sent outside PayOnce may be paying it.
  if (heldBeforePaying(ledger, obligation) && !anyLive(ledger.outsidePayouts(invoiceId))) {
    return obligation.duplicateOf.length > 0
      ? { kind: "duplicate", reference: listOf(obligation.duplicateOf), reason }
      : { kind: "unpaid", reference: null, reason };
  }
  return undefined;
}

// Records a person closing such an invoice. It moves no money, so it is not bound
// to terms the way an approval is. A held duplicate is closed without paying, and
// the invoices it duplicated say so on their timelines.
export function closeIncident(
  ledger: Ledger,
  invoiceId: string,
  closedBy: string,
  finding: string,
): void {
  const review: CloseReview | undefined = pendingClose(ledger, invoiceId);
  if (review?.kind === "duplicate" || review?.kind === "unpaid") {
    const duplicateOf: string[] = ledger.obligation(invoiceId)?.duplicateOf ?? [];
    if (!ledger.reject(invoiceId, closedBy)) {
      throw new Error(`${invoiceId} is not waiting on a person to close it`);
    }
    note(
      ledger,
      invoiceId,
      "closed",
      duplicateOf.length > 0
        ? `Closed without paying by ${closedBy}, as a second bill for ${listOf(duplicateOf)}: ${finding}`
        : `Closed without paying by ${closedBy}: ${finding}`,
    );
    for (const other of duplicateOf) {
      note(
        ledger,
        other,
        "warning",
        `${invoiceId} was closed without paying by ${closedBy}, as a second bill for this invoice`,
      );
    }
    return;
  }
  if (review === undefined || !ledger.settle(invoiceId, true)) {
    throw new Error(`${invoiceId} is not waiting on a person to close it`);
  }
  note(ledger, invoiceId, "closed", `Incident closed by ${closedBy}: ${finding}`);
}

export interface PendingApproval {
  approval: Approval;
  terms: ApprovalTerms;
  // Who may not approve it, and why.
  barred: Barred[];
  expired: boolean;
}

// Returns the request an escalated invoice is waiting on, if there is one.
export function pendingApproval(
  ledger: Ledger,
  invoiceId: string,
): PendingApproval | undefined {
  const approval: Approval | undefined = ledger.latestApproval(invoiceId);
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  if (
    approval === undefined ||
    approval.state !== "requested" ||
    obligation?.state !== "escalated"
  ) {
    return undefined;
  }
  const terms: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  return {
    approval,
    terms,
    barred: barredFrom(ledger, obligation, terms.accountKey),
    expired: isExpired(approval),
  };
}

// Records one person's approval of a replacement, or of paying a held invoice,
// under the approval policy. approvalId is the request the approver was shown. If
// a newer one has replaced it, the approval is refused so nobody approves terms
// they did not see. A request that needs two approvers stays open after the first.
export function approvePayment(
  ledger: Ledger,
  policy: ApprovalPolicy,
  invoiceId: string,
  approver: string,
  approvalId: number,
): Approval {
  const pending: PendingApproval | undefined = pendingApproval(ledger, invoiceId);
  if (pending === undefined) {
    throw new Error(`No approval is waiting for ${invoiceId}`);
  }
  const { approval, terms } = pending;
  if (approval.id !== approvalId) {
    throw new Error(
      `The approval request for ${invoiceId} has changed. Review the current terms`,
    );
  }
  if (pending.expired) {
    throw new Error(
      `The approval request for ${invoiceId} has expired. PayOnce opens a new one on its next look`,
    );
  }
  const signer: Approver = checkSigner(
    policy,
    approver,
    paymentAmount(terms),
    pending.barred,
    approval.signoffs.map((signoff: Signoff): string => signoff.approver),
  );
  const after: Approval = ledger.signOff(
    approval.id,
    signer.name,
    approval.binding,
    APPROVED_USE_WITHIN_MS,
  );
  const payment: string = `${formatMoney(terms.amountMinor, terms.currency)} to ${terms.payTo} (the account on file)${paidWith(terms.fx)}`;
  const left: number = after.needed - after.signoffs.length;
  note(
    ledger,
    invoiceId,
    "approval",
    after.state === "approved"
      ? `Approved by ${signersOf(after.signoffs)}: ${payment}`
      : `${signer.name} approved ${payment}. It needs ${left} more approver${left === 1 ? "" : "s"}`,
    // Standing, so the check that follows does not restate the decision.
    "approval",
  );
  return after;
}

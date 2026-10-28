import { getAvailableMinor } from "./airwallex/balances.js";
import { getBankDetails } from "./airwallex/beneficiaries.js";
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
  withFeeEstimate,
  type ApprovalTerms,
  type DuplicateEvidence,
  type FxTerms,
  type HeldPaymentTerms,
  type ReplacementTerms,
} from "./approval.js";
import {
  APPROVED_USE_WITHIN_MS,
  checkSigner,
  eligibleApprovers,
  signoffsNeeded,
  type ApprovalPolicy,
  type Approver,
  type Barred,
  type SignoffRule,
} from "./approvers.js";
import {
  attemptStateOf,
  bankDetailsKey,
  feeOf,
  originalStateOf,
  resendCanFix,
  sameBankDetails,
  type Fee,
} from "./assess.js";
import { committedMinor } from "./cash-position.js";
import { deadlineMinutes, deadlineOf, describeDeadline, isOverdue } from "./deadlines.js";
import { decide, OUTSIDE_PAYOUT_REASON } from "./decide.js";
import { likelyDuplicates, nearlyPays } from "./duplicates.js";
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
  type AttemptQuote,
  type BankChange,
  type AttemptState,
  type EventKind,
  type Ledger,
  type LedgerEvent,
  type Obligation,
  type ObligationState,
  type OutsidePayout,
  type PayoutMoney,
  type PayoutState,
  type Signoff,
} from "./ledger.js";
import { formatMoney, readMinor, toMajor, toMinor } from "./money.js";
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
// true for one this look took. endsAt is when it runs out by this machine's
// clock, and NaN for one taken from an open request.
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
  decision: Decision;
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
export type Topic = "decision" | "waiting" | "approval" | "cost" | "bank-details";

// True when the timeline's last word on a topic is this message and nothing has
// happened since.
function stillSays(events: LedgerEvent[], topic: Topic, message: string): boolean {
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

// A payout's amount and fee for the ledger, as they left the wallet it was paid
// from. One that cannot be read is null, so tying the payout never fails on it.
function payoutMoney(transfer: Transfer): PayoutMoney {
  const fee: Fee | null = feeOf(transfer);
  return {
    amountMinor: readMinor(transfer.source_amount ?? transfer.transfer_amount),
    currency: transfer.source_currency ?? transfer.transfer_currency ?? null,
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

// The quote a payment of this invoice from another currency's wallet is offered
// at. While an approval request is open, every look builds its terms on that
// request's own quote, so its binding holds still. Any other time it takes a
// fresh quote, so a new request never opens on a quote an earlier one showed.
// feeEstimateMinor is the fee the payment should cost, in the sell currency.
async function rateFor(
  engine: Engine,
  obligation: Obligation,
  feeEstimateMinor: number | null,
): Promise<Rate> {
  const latest: Approval | undefined = engine.ledger.latestApproval(obligation.invoiceId);
  const open: FxTerms | undefined =
    latest !== undefined &&
    (latest.state === "requested" || latest.state === "approved") &&
    !isExpired(latest)
      ? (JSON.parse(latest.terms) as ApprovalTerms).fx
      : undefined;
  if (
    open !== undefined &&
    open.sellCurrency === obligation.sourceCurrency &&
    open.buyCurrency === obligation.currency &&
    open.buyAmountMinor === obligation.amountMinor
  ) {
    return { fx: withFeeEstimate(open, feeEstimateMinor), fresh: false, endsAt: Number.NaN };
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
  return { fx, fresh: true, endsAt };
}

// The quote an attempt is sent with, from the terms the approval approvalId
// approved.
function quoteOf(terms: ApprovalTerms, approvalId: number): AttemptQuote | null {
  return terms.fx === undefined
    ? null
    : { quoteId: terms.fx.quoteId, validTo: terms.fx.validTo, approvalId };
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
  const availableMinor: number = await getAvailableMinor(engine.client, wallet);
  const floorMinor: number | null = floorFor(engine.reserve, obligation);
  const committed: number = committedMinor(engine.ledger, wallet, obligation.invoiceId);
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

  const decision: Decision = decide(incident);
  // Once an invoice has gone to a person, the policy no longer acts for itself.
  const held: string =
    obligation.state !== "escalated"
      ? ""
      : decision.action === "replace"
        ? ". This invoice was escalated, so it still needs a person's approval"
        : decision.action === "close"
          ? ". This invoice was escalated, so a person closes it"
          : "";
  note(
    engine.ledger,
    obligation.invoiceId,
    "decision",
    `${capitalise(decision.action)}: ${decision.reason}${held}`,
    "decision",
  );
  const bankChange: BankChange | null = incident.beneficiaryChanged
    ? (engine.ledger.verifiedBankChange(obligation.beneficiaryId, bankDetailsKey(bankDetails)) ??
      null)
    : null;
  return { original, incident, findings, unverified, bankDetails, bankChange, rate, decision };
}

// A transfer is paid to the beneficiary record as it is when it is created, so a
// replacement first checks that the record still holds the account it was
// decided or approved for. Throws, sending nothing, when it does not.
async function requireAccount(
  engine: Engine,
  obligation: Obligation,
  accountKey: string,
  what: string,
): Promise<void> {
  const now: TransferBankDetails = await getBankDetails(engine.client, obligation.beneficiaryId);
  if (accountKeyOf(now) !== accountKey) {
    throw new Error(
      `The supplier's bank details changed after the ${what}, so PayOnce sent nothing. Check again to look at the new details`,
    );
  }
}

// accountKey is the account a payment was decided or approved for. quote is the
// approved quote a payment from another currency's wallet goes out on.
async function pay(
  engine: Engine,
  obligation: Obligation,
  kind: AttemptKind,
  accountKey: string | null = null,
  quote: AttemptQuote | null = null,
): Promise<Transfer> {
  if (crossCurrency(obligation) && quote === null) {
    throw new Error(
      `${obligation.invoiceId} is paid from ${obligation.sourceCurrency}, so PayOnce pays it only on an approved exchange rate quote. Nothing was sent`,
    );
  }
  if (accountKey !== null) {
    await requireAccount(engine, obligation, accountKey, "decision");
  }
  // Opening the attempt takes the duplicate lock, so this throws if the invoice
  // already has a live payment.
  return send(
    engine,
    obligation,
    engine.ledger.openAttempt(obligation.invoiceId, kind, quote),
    accountKey,
  );
}

// A payment from another currency's wallet must go out on the quote a person
// approved. Checked wherever an attempt first becomes a transfer: when it is
// sent, when a retry creates it, and when it is found by its request_id. The
// money has moved by then, so a transfer at any other rate goes to a person.
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
  // since does not count. An attempt from before that was kept has the latest.
  const approval: Approval | undefined =
    attempt.approvalId === null
      ? engine.ledger.latestApproval(obligation.invoiceId)
      : engine.ledger.approval(attempt.approvalId);
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
    engine.ledger.escalate(obligation.invoiceId, reason);
    note(engine.ledger, obligation.invoiceId, "warning", capitalise(reason));
  }
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
  // A deadline that cannot be read is due now, and the look then finds the
  // transfer overdue.
  const deadline: number = deadlineOf(transfer);
  return Number.isFinite(deadline) ? deadline : Date.now();
}

// A replacement the bank sits on is never followed by another payment. A person
// hears about it, and the incident still closes if the bank pays it.
function replacementOverdue(
  engine: Engine,
  invoiceId: string,
  replacement: Transfer,
): NextLook {
  const reason: string = "the bank has not paid or failed the replacement by its deadline";
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

// The bank pays the replacement later. The agent hears about it the way it heard
// about the original, and closes the incident then.
async function replace(
  engine: Engine,
  obligation: Obligation,
  accountKey: string,
  quote: AttemptQuote | null,
): Promise<NextLook> {
  const replacement: Transfer = await pay(engine, obligation, "replacement", accountKey, quote);
  return waitForBank(engine, obligation.invoiceId, "replacement", replacement);
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
  );
}

// The people who may not approve a payment of this invoice to the account with
// this accountKey, and why: whoever started the incident, and everyone who
// recorded a callback verifying that account.
function barredFrom(ledger: Ledger, obligation: Obligation, accountKey: string | undefined): Barred[] {
  const barred: Barred[] = [];
  if (obligation.startedBy !== null) {
    barred.push({ name: obligation.startedBy, why: "started this incident" });
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
// is now, or null when it still does. The policy may have changed since the
// approvers signed: an approver removed, a limit lowered, or a rule that now
// needs two.
function approvalProblem(
  engine: Engine,
  obligation: Obligation,
  rule: SignoffRule,
  approval: Approval,
): string | null {
  if (approval.signoffs.some((signoff: Signoff): boolean => signoff.binding !== approval.binding)) {
    return "an approver signed different terms";
  }
  const needed: number = Math.max(approval.needed, rule.needed);
  if (approval.signoffs.length < needed) {
    return `it now needs ${needed} approvers, because ${rule.why}`;
  }
  const approved: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  for (const signoff of approval.signoffs) {
    try {
      checkSigner(
        engine.approvals,
        signoff.approver,
        paymentAmount(approved),
        barredFrom(engine.ledger, obligation, approved.accountKey),
        approval.signoffs
          .filter((other: Signoff): boolean => other !== signoff)
          .map((other: Signoff): string => other.approver),
      );
    } catch (error: unknown) {
      return messageOf(error);
    }
  }
  return null;
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
  terms: ApprovalTerms,
  rule: SignoffRule,
  rate: Rate | null,
): NextLook {
  const invoiceId: string = obligation.invoiceId;
  const binding: string = bindingOf(terms);

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
    const fx: string = terms.fx === undefined ? "" : `${paidWith(terms.fx)},`;
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
  const previous: FxTerms | undefined =
    latest === undefined ? undefined : (JSON.parse(latest.terms) as ApprovalTerms).fx;
  // A request on a quote is replaced on a fresh quote once it expires, so its
  // terms differ even when nothing else changed.
  const expiredRequest: boolean =
    latest?.state === "requested" && isExpired(latest) && (sameRequest || terms.fx !== undefined);
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
    return null;
  }

  const terms: ReplacementTerms = termsOf(obligation, assessment);
  return awaitApproval(
    engine,
    obligation,
    terms,
    ruleFor(engine, obligation, terms, assessment.incident.beneficiaryChanged),
    assessment.rate,
  );
}

async function continueEscalated(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<NextLook> {
  // Once an invoice has gone to a person, only an approval releases a payment and
  // only a person closes it, even if the policy would now do either unprompted.
  const assessment: Assessment = await assess(engine, obligation, originalId);
  const approval: Approval | undefined = engine.ledger.latestApproval(
    obligation.invoiceId,
  );
  const current: ReplacementTerms = termsOf(obligation, assessment);
  if (
    approval?.state !== "approved" ||
    voidIfStale(
      engine,
      obligation,
      approval,
      current,
      ruleFor(engine, obligation, current, assessment.incident.beneficiaryChanged),
    )
  ) {
    return escalate(engine, obligation, assessment);
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
  // One approval covers one attempt, so it is spent before the payment is tried.
  // Another process may have voided it since it was read.
  if (!engine.ledger.useApproval(approval.id)) {
    return Date.now();
  }
  note(
    engine.ledger,
    obligation.invoiceId,
    "approval",
    `Approval by ${approval.approver} matches the current terms`,
  );
  return replace(engine, obligation, current.accountKey, quoteOf(current, approval.id));
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

// Sends a new invoice's original, unless it looks like a second bill for an
// invoice the ledger already has, a payout for it sent outside PayOnce may
// already pay it, or it is paid from another currency's wallet, so a person
// approves the rate. Then it holds the invoice for a person, sends nothing and
// returns null. Call it in the invoice's turn.
export async function startPayment(
  engine: Engine,
  obligation: Obligation,
): Promise<Transfer | null> {
  const invoiceId: string = obligation.invoiceId;
  const current: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (current?.state !== "open" || engine.ledger.attempts(invoiceId).length > 0) {
    throw new Error(`${invoiceId} is not waiting for its first payment`);
  }
  await linkUnseenPayouts(engine, invoiceId);
  // Another process may have held or paid it while the payouts were listed. From
  // here to the attempt nothing is awaited.
  const now: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (now?.state !== "open" || engine.ledger.attempts(invoiceId).length > 0) {
    throw new Error(`${invoiceId} is not waiting for its first payment`);
  }
  const duplicates: Obligation[] = likelyDuplicates(engine.ledger, now);
  const outsideLive: boolean = anyLive(engine.ledger.outsidePayouts(invoiceId));
  const converts: boolean = crossCurrency(now);
  if (duplicates.length === 0 && !outsideLive && !converts) {
    try {
      return await pay(engine, now, "original");
    } catch (error: unknown) {
      const refused: Attempt | undefined = engine.ledger.attempts(invoiceId).at(-1);
      if (refused?.state !== "failed" || refused.transferId !== null) {
        throw error;
      }
      note(engine.ledger, invoiceId, "error", messageOf(error));
      holdRefused(engine, now, refused);
      return null;
    }
  }

  const duplicateOf: string[] = duplicates.map((other: Obligation): string => other.invoiceId);
  // The more serious reason is the one given.
  const reason: string =
    duplicates.length > 0
      ? `it looks like a second bill for ${listOf(duplicateOf)}: the same supplier and amount, and the same invoice number apart from case, spacing, leading zeros or letters added at the end`
      : outsideLive
        ? OUTSIDE_PAYOUT_REASON
        : `it is paid from ${now.sourceCurrency}, so a person approves the exchange rate before PayOnce pays it`;
  engine.ledger.holdBeforePaying(invoiceId, duplicateOf, reason);
  note(engine.ledger, invoiceId, "decision", `Escalate: ${reason}`, "decision");
  for (const other of duplicateOf) {
    note(
      engine.ledger,
      other,
      "warning",
      `${invoiceId} looks like a second bill for this invoice, so PayOnce held it before paying`,
    );
  }
  return null;
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
  const bankDetails: TransferBankDetails = await getBankDetails(
    engine.client,
    obligation.beneficiaryId,
  );
  const accountKey: string = accountKeyOf(bankDetails);
  const duplicates: DuplicateEvidence[] = await duplicateEvidence(engine, held, accountKey);
  // Paid from another currency's wallet, it is approved at a quote. Nothing has
  // been sent, so no fee is known yet.
  const rate: Rate | null = crossCurrency(obligation) ? await rateFor(engine, obligation, null) : null;
  const terms: HeldPaymentTerms = heldTermsFor(held, bankDetails, duplicates, rate?.fx ?? null);
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
  const rule: SignoffRule =
    elsewhere === undefined
      ? signoffsNeeded(engine.approvals, paymentAmount(terms), false, obligation.startedBy)
      : { needed: 2, why: `it pays a different account from the one ${elsewhere.invoiceId} was sent to` };
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
  // Checked before the invoice is released, so a failed check leaves it held with
  // its approval unspent.
  await requireAccount(engine, obligation, terms.accountKey, "payment was approved");
  // Another process may have voided the approval, closed the invoice or tied a
  // payout to it since it was read. The next look sees which.
  const attempt: Attempt | undefined = engine.ledger.releaseFor(
    invoiceId,
    approval.id,
    quoteOf(terms, approval.id),
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
}

// Carries out a decision: replace, close, hand over to a person, or wait for the
// bank until the original's deadline.
async function act(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
): Promise<NextLook> {
  switch (assessment.decision.action) {
    case "replace": {
      // A payout tied to the invoice now is looked at before anything is sent.
      if (await linkUnseenPayouts(engine, obligation.invoiceId)) {
        return Date.now();
      }
      // A replacement for what looks like a second bill of a paid invoice goes to a
      // person, for example when the invoice was paid after this one was released.
      const paid: Obligation | undefined = likelyDuplicates(engine.ledger, obligation).find(
        (other: Obligation): boolean => isPaid(engine.ledger, other.invoiceId),
      );
      if (paid !== undefined) {
        const reason: string = `it looks like a second bill for ${paid.invoiceId}, which is paid`;
        note(engine.ledger, obligation.invoiceId, "decision", `Escalate: ${reason}`, "decision");
        return escalate(engine, obligation, {
          ...assessment,
          decision: { action: "escalate", reason },
        });
      }
      // The policy never replaces a payment from another currency's wallet by
      // itself, and pay refuses one with no approved quote.
      return replace(engine, obligation, accountKeyOf(assessment.bankDetails), null);
    }
    case "wait":
      return waitForBank(engine, obligation.invoiceId, "original", assessment.original);
    case "escalate":
      return escalate(engine, obligation, assessment);
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

// A payment sent on a quote that has run out, with no transfer in Airwallex to
// show for it. PayOnce cannot prove it was never created, so the attempt stays
// pending and keeps the duplicate lock, and a person checks Airwallex.
function unsentOnQuote(engine: Engine, obligation: Obligation, attempt: Attempt): NextLook {
  const invoiceId: string = obligation.invoiceId;
  const reason: string = `the exchange rate quote of the ${attempt.kind} payment ran out and Airwallex shows no transfer for it`;
  engine.ledger.escalate(invoiceId, reason);
  note(engine.ledger, invoiceId, "decision", `Escalate: ${reason}`, "decision");
  note(
    engine.ledger,
    invoiceId,
    "approval",
    `Waiting on a person to look in Airwallex for a transfer with request id ${attempt.requestId}. PayOnce keeps that payment open, so the duplicate lock holds and nothing more is sent for this invoice`,
    "waiting",
  );
  return null;
}

// Looks at an invoice again, after a webhook, a status check, new emails, a
// person's action or a deadline. It syncs each payment with Airwallex, retrying an
// attempt that has no transfer yet under its original request_id, and notes any
// payment the bank has paid or failed since the last look. Then it reads new
// emails, decides and acts. A replacement already out is waited on until its
// deadline, never approved a second time. An escalated invoice pays only on a
// matching approval.
export async function resumeIncident(
  engine: Engine,
  invoiceId: string,
): Promise<void> {
  let next: NextLook;
  try {
    next = await look(engine, invoiceId);
  } catch (error: unknown) {
    // A deadline already passed stays due, and the watcher has the agent try
    // again a minute later rather than on every check.
    const now: number = Date.now();
    engine.ledger.postponeDueLook(invoiceId, now, now + RETRY_FAILED_LOOK_MS);
    throw error;
  }
  engine.ledger.lookAt(invoiceId, next);
}

async function look(engine: Engine, invoiceId: string): Promise<NextLook> {
  const obligation: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (obligation === undefined) {
    throw new Error(`${invoiceId} is not in the ledger`);
  }

  let originalId: string | null = null;
  let original: Transfer | null = null;
  let liveReplacement: Transfer | null = null;
  let unsent: Attempt | null = null;
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
    } else if (attempt.transferId === null && quoteLapsed(obligation, attempt)) {
      // Airwallex can no longer create it, but nothing proves it never did.
      unsent = attempt;
      continue;
    } else if (attempt.transferId === null) {
      // A retry pays the record as it is now, so a replacement, or an original
      // paid on an approval after a hold, goes out only to the account it was
      // approved or decided for.
      const latest: Approval | undefined = engine.ledger.latestApproval(invoiceId);
      const approved: ApprovalTerms | undefined =
        latest?.state === "used" ? (JSON.parse(latest.terms) as ApprovalTerms) : undefined;
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
      }
      transfer = await sendAttempt(engine.client, engine.ledger, obligation, attempt, true);
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

  if (unsent !== null) {
    return unsentOnQuote(engine, obligation, unsent);
  }
  if (originalId === null) {
    const refused: Attempt | undefined = engine.ledger.attempts(invoiceId).at(-1);
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
      close(engine, invoiceId);
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
    return paid === undefined
      ? undefined
      : { kind: paid.kind, reference: paid.reference, reason };
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

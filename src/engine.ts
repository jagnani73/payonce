import { getAvailableMinor } from "./airwallex/balances.js";
import { getBankDetails } from "./airwallex/beneficiaries.js";
import type { AirwallexClient } from "./airwallex/client.js";
import {
  getTransfer,
  listTransfersSince,
  type Transfer,
  type TransferBankDetails,
} from "./airwallex/transfers.js";
import {
  bindingOf,
  changedFields,
  termsFor,
  type ApprovalTerms,
} from "./approval.js";
import {
  attemptStateOf,
  originalStateOf,
  resendCanFix,
  sameBankDetails,
} from "./assess.js";
import { deadlineOf, describeDeadline, isOverdue } from "./deadlines.js";
import { decide, OUTSIDE_PAYOUT_REASON } from "./decide.js";
import {
  unverifiedSenders,
  type EmailFindings,
  type EmailReader,
  type SupplierEmail,
} from "./emails.js";
import type { Decision, Incident, OriginalTransferState } from "./incident.js";
import {
  DuplicatePaymentError,
  type Approval,
  type Attempt,
  type AttemptKind,
  type AttemptState,
  type EventKind,
  type Ledger,
  type LedgerEvent,
  type Obligation,
  type OutsidePayout,
  type PayoutState,
} from "./ledger.js";
import { formatMoney, toMinor } from "./money.js";
import { sendAttempt, syncTransfer, wasRejected } from "./payments.js";

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
  bank?: Bank;
}

interface Assessment {
  original: Transfer;
  incident: Incident;
  findings: StoredFindings;
  unverified: string[];
  bankDetails: TransferBankDetails;
  decision: Decision;
}

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

// A payout whose reference names an invoice PayOnce has may pay that invoice a
// second time. It goes on the invoice's timeline, and the policy holds every
// payment while it is live. A settled invoice is reopened for a person to check.
// Call it in the invoice's turn. False when the payout was tied already.
export function linkOutsidePayout(
  engine: Engine,
  invoiceId: string,
  transfer: Transfer,
): boolean {
  const state: PayoutState = originalStateOf(transfer);
  const linked: boolean = engine.ledger.linkOutsidePayout(invoiceId, {
    transferId: transfer.id,
    reference: transfer.short_reference_id,
    state,
  });
  if (!linked) {
    return false;
  }
  note(
    engine.ledger,
    invoiceId,
    "warning",
    `Payout ${transfer.short_reference_id} for this invoice was sent outside PayOnce: ${payoutSummary(transfer)}`,
  );
  if (engine.ledger.obligation(invoiceId)?.state === "settled" && state !== "failed") {
    engine.ledger.escalate(invoiceId, OUTSIDE_PAYOUT_REASON);
  }
  return true;
}

// Looks in Airwallex for payouts naming this invoice that PayOnce has not seen,
// and ties them to it. It runs before a replacement goes out, so a resend someone
// made outside PayOnce a moment ago is not paid a second time. True when it tied
// any.
async function linkUnseenPayouts(engine: Engine, invoiceId: string): Promise<boolean> {
  let linked: boolean = false;
  const transfers: Transfer[] = await listTransfersSince(
    engine.client,
    engine.ledger.startedAt(),
  );
  for (const transfer of transfers) {
    if (
      !engine.ledger.knowsTransfer(transfer.request_id ?? "", transfer.id) &&
      engine.ledger.obligationForReference(transfer.reference ?? "")?.invoiceId ===
        invoiceId
    ) {
      linked = linkOutsidePayout(engine, invoiceId, transfer) || linked;
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
    if (state === payout.state) {
      continue;
    }
    engine.ledger.recordOutsidePayout(payout.transferId, state);
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
  const feeMinor: number = toMinor(original.fee_amount);
  const availableMinor: number = await getAvailableMinor(
    engine.client,
    obligation.currency,
  );
  const originalState: OriginalTransferState = originalStateOf(original);
  const incident: Incident = {
    invoiceId: obligation.invoiceId,
    supplier: obligation.supplier,
    currency: obligation.currency,
    amountMinor: obligation.amountMinor,
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
    reserveFloorMinor: obligation.reserveFloorMinor,
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
  if (incident.originalState === "failed" && feeMinor > 0) {
    const costMinor: number = obligation.amountMinor + feeMinor;
    const afterMinor: number = availableMinor - costMinor;
    const currency: string = obligation.currency;
    note(
      engine.ledger,
      obligation.invoiceId,
      afterMinor < obligation.reserveFloorMinor ? "warning" : "payment",
      `A replacement costs ${formatMoney(costMinor, currency)} with a second ${formatMoney(feeMinor, currency)} transfer fee. Cash after it: ${formatMoney(afterMinor, currency)}, reserve floor ${formatMoney(obligation.reserveFloorMinor, currency)}`,
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
  return { original, incident, findings, unverified, bankDetails, decision };
}

// Opening the attempt takes the duplicate lock, so this throws if the invoice
// already has a live payment.
async function pay(
  engine: Engine,
  obligation: Obligation,
  kind: AttemptKind,
): Promise<Transfer> {
  const attempt: Attempt = engine.ledger.openAttempt(obligation.invoiceId, kind);
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

  // Noted as soon as the transfer exists, so a later failure cannot hide it.
  const fee: string =
    created.fee_amount > 0
      ? `, plus a ${formatMoney(toMinor(created.fee_amount), obligation.currency)} transfer fee`
      : "";
  note(
    engine.ledger,
    obligation.invoiceId,
    "payment",
    `${capitalise(kind)} ${created.short_reference_id} sent: ${money(obligation)} to ${obligation.supplier}${fee}`,
  );
  engine.bank?.sent(obligation.invoiceId, kind, created.id);
  return created;
}

export function payOriginal(engine: Engine, obligation: Obligation): Promise<Transfer> {
  return pay(engine, obligation, "original");
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
async function replace(engine: Engine, obligation: Obligation): Promise<NextLook> {
  const replacement: Transfer = await pay(engine, obligation, "replacement");
  return waitForBank(engine, obligation.invoiceId, "replacement", replacement);
}

function termsOf(obligation: Obligation, assessment: Assessment): ApprovalTerms {
  return termsFor(
    obligation,
    assessment.original,
    assessment.decision,
    evidenceSummary(assessment),
    assessment.bankDetails,
  );
}

// A replacement is only on offer when the original has failed, and it goes to the
// beneficiary on file. A paid original leaves nothing to pay, so the person closes
// the incident. Any other escalation has no payment a person could approve yet.
function escalate(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
): void {
  // An invoice that is already with a person keeps the reason it went there for
  // when the policy would now do something else.
  engine.ledger.escalate(
    obligation.invoiceId,
    assessment.decision.action === "escalate"
      ? assessment.decision.reason
      : obligation.escalationReason,
  );
  if (assessment.incident.outsidePayoutLive) {
    if (engine.ledger.voidOpenApprovals(obligation.invoiceId)) {
      note(
        engine.ledger,
        obligation.invoiceId,
        "approval",
        "Approval request withdrawn: a payout for this invoice was sent outside PayOnce",
      );
    }
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      "Waiting on a person. A payout sent outside PayOnce may already pay this invoice, so PayOnce sends nothing",
      "waiting",
    );
    return;
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
    return;
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
    return;
  }

  const terms: ApprovalTerms = termsOf(obligation, assessment);
  const binding: string = bindingOf(terms);
  const latest: Approval | undefined = engine.ledger.latestApproval(
    obligation.invoiceId,
  );
  if (latest?.state !== "requested" || latest.binding !== binding) {
    engine.ledger.requestApproval(
      obligation.invoiceId,
      binding,
      JSON.stringify(terms),
    );
  }
  note(
    engine.ledger,
    obligation.invoiceId,
    "approval",
    `Waiting on a person to approve ${money(obligation)} to ${terms.payTo} (the account on file)`,
    "waiting",
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
  if (approval?.state !== "approved") {
    escalate(engine, obligation, assessment);
    return null;
  }

  const current: ApprovalTerms = termsOf(obligation, assessment);
  if (bindingOf(current) !== approval.binding) {
    const approved: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
    engine.ledger.setApprovalState(approval.id, "void");
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      `Approval by ${approval.approver} is void: ${changedFields(approved, current).join(", ")} changed`,
    );
    escalate(engine, obligation, assessment);
    return null;
  }

  // A payout tied to the invoice now is looked at before anything is sent, and the
  // approval is left as it is until then.
  if (await linkUnseenPayouts(engine, obligation.invoiceId)) {
    return Date.now();
  }
  // One approval covers one attempt, so it is spent before the payment is tried.
  engine.ledger.setApprovalState(approval.id, "used");
  note(
    engine.ledger,
    obligation.invoiceId,
    "approval",
    `Approval by ${approval.approver} matches the current terms`,
  );
  return replace(engine, obligation);
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
      // A payout tied to the invoice now is looked at before anything is sent.
      if (await linkUnseenPayouts(engine, obligation.invoiceId)) {
        return Date.now();
      }
      return replace(engine, obligation);
    case "wait":
      return waitForBank(engine, obligation.invoiceId, "original", assessment.original);
    case "escalate":
      escalate(engine, obligation, assessment);
      return null;
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
  let liveReplacement: Transfer | null = null;
  for (const attempt of engine.ledger.attempts(invoiceId)) {
    // An attempt Airwallex refused never became a transfer. Only one still
    // pending is retried.
    if (attempt.transferId === null && attempt.state !== "pending") {
      continue;
    }
    let transfer: Transfer;
    if (attempt.transferId === null) {
      transfer = await sendAttempt(engine.client, engine.ledger, obligation, attempt);
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
    } else if (originalStateOf(transfer) === "in_flight") {
      liveReplacement = transfer;
    }
    console.log(`  ${attempt.kind} ${describe(transfer)}`);
  }

  if (originalId === null) {
    return null;
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
  const message: string =
    ledger.obligation(invoiceId)?.state === "settled"
      ? "Pay again not sent. The incident is closed, so PayOnce pays nothing more for this invoice"
      : anyLive(ledger.outsidePayouts(invoiceId))
        ? "Pay again not sent. A payout sent outside PayOnce may already pay this invoice"
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
// PayOnce after every payment PayOnce sent failed.
export interface CloseReview {
  kind: AttemptKind | "outside";
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
  return undefined;
}

// Records a person closing such an invoice. It moves no money, so it is not bound
// to terms the way an approval is.
export function closeIncident(
  ledger: Ledger,
  invoiceId: string,
  closedBy: string,
  finding: string,
): void {
  if (pendingClose(ledger, invoiceId) === undefined || !ledger.settle(invoiceId, true)) {
    throw new Error(`${invoiceId} is not waiting on a person to close it`);
  }
  note(ledger, invoiceId, "closed", `Incident closed by ${closedBy}: ${finding}`);
}

// Returns the request an escalated invoice is waiting on, if there is one.
export function pendingApproval(
  ledger: Ledger,
  invoiceId: string,
): { id: number; terms: ApprovalTerms } | undefined {
  const approval: Approval | undefined = ledger.latestApproval(invoiceId);
  return approval === undefined || approval.state !== "requested"
    ? undefined
    : { id: approval.id, terms: JSON.parse(approval.terms) as ApprovalTerms };
}

// approvalId is the request the approver was shown. If a newer one has replaced
// it, the approval is refused so nobody approves terms they did not see.
export function approveReplacement(
  ledger: Ledger,
  invoiceId: string,
  approver: string,
  approvalId: number,
): ApprovalTerms {
  const approval: Approval | undefined = ledger.latestApproval(invoiceId);
  if (approval === undefined || approval.state !== "requested") {
    throw new Error(`No approval is waiting for ${invoiceId}`);
  }
  if (approval.id !== approvalId) {
    throw new Error(
      `The approval request for ${invoiceId} has changed. Review the current terms`,
    );
  }
  const terms: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  ledger.setApprovalState(approval.id, "approved", approver);
  note(
    ledger,
    invoiceId,
    "approval",
    `Approved by ${approver}: ${formatMoney(terms.amountMinor, terms.currency)} to ${terms.payTo} (the account on file)`,
    // Standing, so the check that follows does not restate the decision.
    "approval",
  );
  return terms;
}

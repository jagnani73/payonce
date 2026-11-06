import { findTransferByRequestId, getTransfer, type Transfer } from "../airwallex/transfers.js";
import { attemptStateOf, originalStateOf } from "../domain/assess.js";
import { isOverdue } from "../domain/deadlines.js";
import { keptFailedLive, mismatchedLive, paidByReplacement } from "../domain/live.js";
import { debitCurrency } from "../domain/reserve.js";
import { holdLine, railFailureSeen, waitingLine } from "../outages/outages.js";
import {
  RailOutageError,
  type Approval,
  type Attempt,
  type AttemptState,
  type Lease,
  type LedgerEvent,
  type Obligation,
  type Outage,
  type OutsidePayout,
} from "../store/ledger.js";
import { heldBeforePaying, paidTwice } from "../store/read/facts.js";
import { capitalise, say } from "../text/printable.js";
import { assess } from "./assessment.js";
import { close, closeRefused } from "./close.js";
import { withCurrencyLock } from "./currency-lock.js";
import { readNewEmails } from "./emails.js";
import {
  CONTINUE,
  nextLookAt,
  RETRY_FAILED_LOOK_MS,
  type Assessment,
  type Engine,
  type LookOptions,
  type NextLook,
  type StepResult,
} from "./engine.js";
import { continueEscalated, escalate } from "./escalated.js";
import { holdRefused, startFirst } from "./first-payment.js";
import { continueHeld } from "./held.js";
import { holdMismatched, holdPaidTwice, syncMismatched } from "./late-mismatched.js";
import { describe, lineWanted, note } from "./lines.js";
import { linkUnseenPayouts, syncOutsidePayouts } from "./outside.js";
import { syncTransfer } from "./payments.js";
import { reasonFor, type StoredReason } from "../domain/reasons.js";
import { withFloorReason } from "./reason-text.js";
import { replaceUnderLock } from "./replacement.js";
import { failNeverSent, holdPending, retryUnderLock, type Retried } from "./retry.js";
import { noteChecks, replacementOverdue, transferChecks, waitForBank, type TransferChecks } from "./send.js";

// An invoice whose payment an outage held waits for a person to end it. The hold
// line goes on its timeline once, and a standing line says what it waits on, both
// in the transaction that finds the outage still active, so neither lands after
// the end line. The look is tried again a minute later, which costs a ledger read
// while the outage lasts. If the outage has ended meanwhile, the next look is due
// at once.
export function waitOnOutage(engine: Engine, invoiceId: string, error: RailOutageError): void {
  const outage: Outage | undefined = engine.ledger.outage(error.outageId);
  const approval: Approval | undefined =
    error.what === "approved" ? engine.ledger.latestApproval(invoiceId) : undefined;
  const waiting: string =
    outage === undefined ? "" : waitingLine(outage, approval?.state === "approved" ? approval : undefined);
  if (
    outage?.state !== "active" ||
    !engine.ledger.holdForOutage(outage.id, { invoiceId }, error.what, holdLine(outage, error.what), {
      kind: "outage",
      message: waiting,
      topic: "waiting",
      wanted: (events: LedgerEvent[]): boolean => lineWanted(events, "outage", waiting, "waiting"),
    })
  ) {
    engine.ledger.lookAt(invoiceId, Date.now());
  }
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
      return escalate(engine, obligation, withFloorReason(engine, obligation, assessment), "decided");
    case "close":
      return close(engine, obligation.invoiceId, obligation.state)
        ? null
        : closeRefused(engine, obligation.invoiceId);
  }
}

// Looks at an invoice again, after a webhook, a status check, new emails, a
// person's action or a deadline. It syncs each payment with Airwallex, retrying an
// attempt that has no transfer yet under its original request_id, and notes any
// payment the bank has paid or failed since the last look. Then it reads new
// emails, decides and acts. A replacement already out is waited on until its
// deadline, never approved a second time. An escalated invoice pays only on a
// matching approval. A pay run row's first payment is sent only on a look with
// the run's turn (LookOptions).
export async function resumeIncident(
  engine: Engine,
  invoiceId: string,
  options: LookOptions,
): Promise<void> {
  let next: NextLook;
  try {
    next = await look(engine, invoiceId, options);
  } catch (error: unknown) {
    // A deadline already passed stays due, and the watcher has the agent try
    // again a minute later rather than on every check.
    const now: number = Date.now();
    engine.ledger.postponeDueLook(invoiceId, now, now + RETRY_FAILED_LOOK_MS);
    // An outage is no failure of the look, so it writes no error line.
    if (error instanceof RailOutageError) {
      waitOnOutage(engine, invoiceId, error);
      return;
    }
    throw error;
  }
  engine.ledger.lookAt(invoiceId, next);
}

// What a look knows as it goes: the invoice as it last read it, and the original
// the policy goes by and a replacement still with the bank, as read so far.
interface Look {
  readonly engine: Engine;
  readonly invoiceId: string;
  readonly options: LookOptions;
  obligation: Obligation;
  original: Transfer | null;
  liveReplacement: Transfer | null;
}

// A look at an invoice the bank has an original for, with the payouts sent
// outside PayOnce as it read them.
interface SentLook extends Look {
  original: Transfer;
  outside: OutsidePayout[];
}

// Once the look has read the payouts sent outside PayOnce and the new emails of
// an invoice the bank has an original for, these run in this order, and the
// policy decides when none ends the look.
const SENT_STEPS: readonly ((look: SentLook) => StepResult)[] = [
  leaveClosed,
  holdIfPaidTwice,
  waitOnKeptFailed,
  closeIfPaid,
  followReplacement,
  continueIfEscalated,
];

// The look reads what the bank has for the invoice, then holds it while a
// transfer that does not match it is live, starts or holds a first payment when
// the bank has no original, reads the payouts sent outside PayOnce and the new
// emails, and takes SENT_STEPS. Every await is here, in this order, so a look
// runs beside other looks and the sweep as it always has (see StepResult).
async function look(engine: Engine, invoiceId: string, options: LookOptions): Promise<NextLook> {
  const read: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (read === undefined) {
    throw new Error(`${invoiceId} is not in the ledger`);
  }
  const look: Look = { engine, invoiceId, options, obligation: read, original: null, liveReplacement: null };

  // A transfer kept beside an attempt because it does not match the invoice is
  // read like any payment with the bank.
  for (const attempt of engine.ledger.attempts(invoiceId).filter(mismatchedLive)) {
    if (attempt.mismatchedTransferId !== null && attempt.mismatchedStatus !== "PAID") {
      syncMismatched(engine, attempt, await getTransfer(engine.client, attempt.mismatchedTransferId));
    }
  }
  sayMismatchedFailed(look);
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
      const checks: TransferChecks = transferChecks(engine, look.obligation, attempt);
      transfer = await syncTransfer(engine.client, engine.ledger, existing.id, checks.decide);
      noteChecks(engine, invoiceId, checks);
      engine.bank?.sent(invoiceId, attempt.kind, transfer.id, transfer.short_reference_id);
    } else if (attempt.transferId === null) {
      const linked: boolean = await linkUnseenPayouts(engine, invoiceId);
      const outside: OutsidePayout[] = await syncOutsidePayouts(engine, invoiceId);
      const held: StepResult = holdPending(engine, look.obligation, attempt, outside, linked);
      if (held.kind === "next") {
        return held.at;
      }
      const paying: Obligation = look.obligation;
      const checks: TransferChecks = transferChecks(engine, paying, attempt);
      const retried: Retried = await retryUnderLock(engine, paying, attempt, look.original, checks);
      if (retried.kind === "account-changed" || retried.kind === "account-unknown") {
        return failNeverSent(engine, paying, attempt, retried);
      }
      // The next look, at once, holds or records it as the ledger now stands.
      if (retried.kind === "changed") {
        return Date.now();
      }
      if (retried.kind === "lapsed") {
        continue;
      }
      transfer = retried.transfer;
      noteChecks(engine, invoiceId, checks);
      engine.bank?.sent(invoiceId, attempt.kind, transfer.id, transfer.short_reference_id);
    } else {
      transfer = await syncTransfer(engine.client, engine.ledger, attempt.transferId);
    }
    notePayment(look, attempt, transfer);
  }
  // A transfer kept failed beside a payment that has failed since, in this look
  // or another, takes its own state now that the duplicate lock is free.
  for (const kept of engine.ledger.attempts(invoiceId).filter(keptFailedLive)) {
    if (kept.transferId === null) {
      continue;
    }
    const transfer: Transfer = await syncTransfer(engine.client, engine.ledger, kept.transferId);
    if (engine.ledger.attemptOf(kept.requestId, transfer.id)?.state !== "failed") {
      note(engine.ledger, invoiceId, "bank", `${capitalise(kept.kind)} ${describe(transfer)}`);
    }
  }
  // A transfer found at a rate nobody approved may have escalated it above.
  look.obligation = engine.ledger.obligation(invoiceId) ?? look.obligation;

  // Before anything is decided, held or released for a closed invoice reopened by
  // it, or for one with nothing sent. Payouts sent outside PayOnce are read first,
  // so one the bank has paid or failed since is recorded, and the watcher stops
  // waking the invoice for it.
  const mismatched: Attempt | undefined = engine.ledger.attempts(invoiceId).find(mismatchedLive);
  if (mismatched !== undefined && look.obligation.state !== "settled") {
    await syncOutsidePayouts(engine, invoiceId);
    return holdMismatched(engine, invoiceId, mismatched);
  }
  const original: Transfer | null = look.original;
  if (original === null) {
    return nothingSent(look);
  }
  const outside: OutsidePayout[] = await syncOutsidePayouts(engine, invoiceId);
  const sent: SentLook = { ...look, original, outside };
  await readNewEmails(engine, sent.obligation, false);
  for (const step of SENT_STEPS) {
    const result: StepResult = step(sent);
    if (result.kind === "next") {
      return result.at;
    }
  }
  return act(engine, sent.obligation, await assess(engine, sent.obligation, original.id));
}

// Once the bank has failed every transfer kept beside an attempt because it does
// not match the invoice, the reason the invoice waits for a person says so,
// unless another process has changed the reason or closed the invoice meanwhile.
function sayMismatchedFailed(look: Look): void {
  const { engine, invoiceId }: Look = look;
  const reason: StoredReason | null = engine.ledger.reasonOf(look.obligation);
  if (
    reason?.code === "unrecognised-transfer" &&
    reason.clauses.length === 0 &&
    !engine.ledger.attempts(invoiceId).some(mismatchedLive) &&
    engine.ledger.rewordEscalation(invoiceId, reason, reasonFor("unrecognised-transfer-failed"))
  ) {
    look.obligation = engine.ledger.obligation(invoiceId) ?? look.obligation;
  }
}

// What reading one payment found: a bank line when the bank paid or failed it
// since the last look, the rail failure, and which original and replacement the
// look goes by.
function notePayment(look: Look, attempt: Attempt, transfer: Transfer): void {
  const { engine, invoiceId }: Look = look;
  const state: AttemptState | null = attemptStateOf(transfer);
  // Not for a transfer the ledger keeps failed while another payment holds the
  // duplicate lock: paidTwice holds the invoice for a person below.
  if (
    state !== attempt.state &&
    (state === "paid" || state === "failed") &&
    engine.ledger.attemptOf(attempt.requestId, transfer.id)?.state === state
  ) {
    note(engine.ledger, invoiceId, "bank", `${capitalise(attempt.kind)} ${describe(transfer)}`);
  }
  // After the bank line, so an outage this failure declares reads after it.
  if (state === "failed") {
    railFailureSeen(engine.ledger, transfer, "look");
  }
  // The original the policy goes by is the latest the bank has not failed, so a
  // transfer found late that is live is never taken for a failed one and
  // replaced. With none live, it is the latest.
  if (
    attempt.kind === "original" &&
    (look.original === null ||
      originalStateOf(transfer) !== "failed" ||
      originalStateOf(look.original) === "failed")
  ) {
    look.original = transfer;
  } else if (attempt.kind === "replacement" && originalStateOf(transfer) === "in_flight") {
    look.liveReplacement = transfer;
  }
  say(`  ${attempt.kind} ${describe(transfer)}`);
}

// An invoice the bank has no original for: a new one sends its first payment, one
// Airwallex refused every original for goes to a person, and one held before
// paying waits for an approval.
function nothingSent(look: Look): NextLook | Promise<NextLook> {
  const { engine, invoiceId, obligation }: Look = look;
  const refused: Attempt | undefined = engine.ledger.attempts(invoiceId).at(-1);
  if (refused === undefined && obligation.state === "open") {
    return startFirst(engine, obligation, look.options);
  }
  if (refused !== undefined && obligation.state === "open") {
    return continueHeld(engine, holdRefused(engine, obligation, refused));
  }
  return heldBeforePaying(engine.ledger, obligation) ? continueHeld(engine, obligation) : null;
}

// Closed already, by the policy or by a person, so nothing is decided or sent,
// whatever its payments show now. A payment found late that may still pay it
// reopened it when it was recorded.
function leaveClosed(look: SentLook): StepResult {
  return look.obligation.state === "settled" || look.obligation.state === "rejected" ? nextLookAt(null) : CONTINUE;
}

// Before the policy, so its reason is not replaced, and before a paid payment
// could close the incident.
function holdIfPaidTwice(look: SentLook): StepResult {
  const twice: Attempt | undefined = paidTwice(look.engine.ledger, look.invoiceId);
  return twice === undefined ? CONTINUE : nextLookAt(holdPaidTwice(look.engine, look.invoiceId, twice));
}

// Still kept failed, as when another process opened or recorded a payment
// meanwhile: nothing is decided around a payment the bank has live, and the
// next look, at once, records it again.
function waitOnKeptFailed(look: SentLook): StepResult {
  return look.engine.ledger.attempts(look.invoiceId).some(keptFailedLive) ? nextLookAt(Date.now()) : CONTINUE;
}

// A paid replacement was sent on a decision already made, so it closes the
// incident. A paid original goes to the policy, which may want a person. So does
// an invoice with a live payout sent outside PayOnce. The close is refused when a
// payment went out at a rate nobody approved, or when another process changed
// the ledger since this look read it.
function closeIfPaid(look: SentLook): StepResult {
  const { engine, invoiceId }: SentLook = look;
  if (!paidByReplacement(engine.ledger.attempts(invoiceId), look.outside)) {
    return CONTINUE;
  }
  return nextLookAt(close(engine, invoiceId, look.obligation.state) ? null : closeRefused(engine, invoiceId));
}

// A replacement already out is waited on until its deadline, and then goes to a
// person. It is never followed by another payment.
function followReplacement(look: SentLook): StepResult {
  const replacement: Transfer | null = look.liveReplacement;
  if (replacement === null) {
    return CONTINUE;
  }
  return nextLookAt(
    isOverdue(replacement)
      ? replacementOverdue(look.engine, look.invoiceId, replacement)
      : waitForBank(look.engine, look.invoiceId, "replacement", replacement),
  );
}

// An invoice with a person pays only on a matching approval.
function continueIfEscalated(look: SentLook): StepResult {
  return look.obligation.state === "escalated"
    ? nextLookAt(continueEscalated(look.engine, look.obligation, look.original.id))
    : CONTINUE;
}

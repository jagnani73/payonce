import { findTransferByRequestId, getTransfer, type Transfer } from "../airwallex/transfers.js";
import { attemptStateOf, originalStateOf } from "../domain/assess.js";
import { isOverdue } from "../domain/deadlines.js";
import { debitCurrency } from "../domain/reserve.js";
import { holdLine, railFailureSeen, waitingLine } from "../outages/outages.js";
import {
  mismatchedLive,
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
import { capitalise, say } from "../text/printable.js";
import { assess } from "./assessment.js";
import { close, closeRefused } from "./close.js";
import { withCurrencyLock } from "./currency-lock.js";
import { readNewEmails } from "./emails.js";
import { RETRY_FAILED_LOOK_MS, type Assessment, type Engine, type NextLook } from "./engine.js";
import { continueEscalated, escalate } from "./escalated.js";
import { anyLive, heldBeforePaying, keptFailed, paidOriginal, paidTwice } from "./facts.js";
import { holdRefused, startFirst } from "./first-payment.js";
import { continueHeld } from "./held.js";
import { holdMismatched, holdPaidTwice, syncMismatched } from "./late-mismatched.js";
import { describe, lineWanted, note } from "./lines.js";
import { linkUnseenPayouts, syncOutsidePayouts } from "./outside.js";
import { syncTransfer } from "./payments.js";
import { MISMATCHED_FAILED_REASON, MISMATCHED_TRANSFER_REASON, withFloorReason } from "./reason-text.js";
import { replaceUnderLock } from "./replacement.js";
import {
  accountChangedCause,
  failNeverSent,
  holdRetryForOutsidePayout,
  lateTransferCause,
  mismatchedCause,
  namesOnlyCause,
  paidOutsideCause,
  retry,
} from "./retry.js";
import { AccountChangedError, noteChecks, replacementOverdue, transferChecks, waitForBank, type TransferChecks } from "./send.js";

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
      return escalate(engine, obligation, withFloorReason(engine, obligation, assessment));
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
    // An outage is no failure of the look, so it writes no error line.
    if (error instanceof RailOutageError) {
      waitOnOutage(engine, invoiceId, error);
      return;
    }
    throw error;
  }
  engine.ledger.lookAt(invoiceId, next);
}

async function look(engine: Engine, invoiceId: string, sendRunRow: boolean): Promise<NextLook> {
  const read: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (read === undefined) {
    throw new Error(`${invoiceId} is not in the ledger`);
  }
  let obligation: Obligation = read;

  // A transfer kept beside an attempt because it does not match the invoice is
  // read like any payment with the bank. Once the bank has failed every one, the
  // reason the invoice waits for a person says so, unless another process has
  // changed the reason or closed the invoice meanwhile.
  for (const attempt of engine.ledger.attempts(invoiceId).filter(mismatchedLive)) {
    if (attempt.mismatchedTransferId !== null && attempt.mismatchedStatus !== "PAID") {
      syncMismatched(engine, attempt, await getTransfer(engine.client, attempt.mismatchedTransferId));
    }
  }
  if (
    obligation.escalationReason === MISMATCHED_TRANSFER_REASON &&
    !engine.ledger.attempts(invoiceId).some(mismatchedLive) &&
    engine.ledger.rewordEscalation(invoiceId, MISMATCHED_TRANSFER_REASON, MISMATCHED_FAILED_REASON)
  ) {
    obligation = engine.ledger.obligation(invoiceId) ?? obligation;
  }
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
      const checks: TransferChecks = transferChecks(engine, obligation, attempt);
      transfer = await syncTransfer(engine.client, engine.ledger, existing.id, checks.decide);
      noteChecks(engine, invoiceId, checks);
      engine.bank?.sent(invoiceId, attempt.kind, transfer.id, transfer.short_reference_id);
    } else if (attempt.transferId === null) {
      // A payout sent outside PayOnce since the attempt was opened, for example in
      // the Airwallex web app while its create call went unanswered, may already
      // pay the invoice, so the attempt is not sent again while one is live. One
      // tied just now that has already failed holds nothing: the next look, at
      // once, sends the attempt, as before any other payment. Nor is it sent
      // while a payment found late may pay the invoice.
      const linked: boolean = await linkUnseenPayouts(engine, invoiceId);
      const outside: OutsidePayout[] = await syncOutsidePayouts(engine, invoiceId);
      // A transfer found late that the bank has live may pay the invoice. This
      // attempt waits for it as for a paid payout sent outside PayOnce, and is
      // marked failed if it never became a transfer, so the late one takes the
      // lock.
      const twice: Attempt | undefined = paidTwice(engine.ledger, invoiceId);
      if (twice !== undefined) {
        return failNeverSent(engine, obligation, attempt, lateTransferCause(engine, invoiceId, twice));
      }
      // A paid one that only names the invoice is held for in the same way, so
      // PayOnce sends nothing beside it, and once the attempt is marked failed a
      // person decides: it may be this invoice paid from another wallet, or not
      // this invoice's payment at all.
      const tied: { pays: OutsidePayout[]; namesOnly: OutsidePayout[] } = engine.ledger.payingPayouts(invoiceId);
      const paidBy: OutsidePayout | undefined = tied.pays.find(
        (payout: OutsidePayout): boolean => payout.state === "paid",
      );
      if (paidBy !== undefined) {
        return failNeverSent(engine, obligation, attempt, paidOutsideCause(engine, invoiceId, paidBy));
      }
      const namedBy: OutsidePayout | undefined = tied.namesOnly[0];
      if (namedBy !== undefined) {
        return failNeverSent(engine, obligation, attempt, namesOnlyCause(engine, obligation, namedBy));
      }
      if (anyLive(outside)) {
        return holdRetryForOutsidePayout(engine, invoiceId, attempt);
      }
      // A paid one is waited for as a paid payout sent outside PayOnce is, so the
      // attempt is marked failed if it never became a transfer.
      const mismatched: Attempt | undefined = engine.ledger.attempts(invoiceId).find(mismatchedLive);
      if (mismatched?.mismatchedStatus === "PAID") {
        return failNeverSent(engine, obligation, attempt, mismatchedCause(engine, invoiceId, mismatched));
      }
      if (mismatched !== undefined) {
        return holdMismatched(engine, invoiceId, mismatched);
      }
      if (linked) {
        return Date.now();
      }
      const paying: Obligation = obligation;
      const checks: TransferChecks = transferChecks(engine, obligation, attempt);
      let sent: Transfer | null | undefined;
      try {
        sent = await withCurrencyLock(
          engine.ledger,
          debitCurrency(paying),
          (): Promise<Transfer | null | undefined> => retry(engine, paying, attempt, original, checks),
        );
      } catch (error: unknown) {
        if (!(error instanceof AccountChangedError)) {
          throw error;
        }
        return failNeverSent(engine, obligation, attempt, accountChangedCause(engine, invoiceId, attempt.kind));
      }
      // The next look, at once, holds or records it as the ledger now stands.
      if (sent === undefined) {
        return Date.now();
      }
      if (sent === null) {
        continue;
      }
      transfer = sent;
      noteChecks(engine, invoiceId, checks);
      engine.bank?.sent(invoiceId, attempt.kind, transfer.id, transfer.short_reference_id);
    } else {
      transfer = await syncTransfer(engine.client, engine.ledger, attempt.transferId);
    }
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
      (original === null ||
        originalStateOf(transfer) !== "failed" ||
        originalStateOf(original) === "failed")
    ) {
      originalId = transfer.id;
      original = transfer;
    } else if (attempt.kind === "replacement" && originalStateOf(transfer) === "in_flight") {
      liveReplacement = transfer;
    }
    say(`  ${attempt.kind} ${describe(transfer)}`);
  }
  // A transfer kept failed beside a payment that has failed since, in this look
  // or another, takes its own state now that the duplicate lock is free.
  for (const kept of engine.ledger.attempts(invoiceId).filter(keptFailed)) {
    if (kept.transferId === null) {
      continue;
    }
    const transfer: Transfer = await syncTransfer(engine.client, engine.ledger, kept.transferId);
    if (engine.ledger.attemptOf(kept.requestId, transfer.id)?.state !== "failed") {
      note(engine.ledger, invoiceId, "bank", `${capitalise(kept.kind)} ${describe(transfer)}`);
    }
  }
  // A transfer found at a rate nobody approved may have escalated it above.
  obligation = engine.ledger.obligation(invoiceId) ?? obligation;
  // Before anything is decided, held or released for a closed invoice reopened by
  // it, or for one with nothing sent. Payouts sent outside PayOnce are read first,
  // so one the bank has paid or failed since is recorded, and the watcher stops
  // waking the invoice for it.
  const mismatched: Attempt | undefined = engine.ledger.attempts(invoiceId).find(mismatchedLive);
  if (mismatched !== undefined && obligation.state !== "settled") {
    await syncOutsidePayouts(engine, invoiceId);
    return holdMismatched(engine, invoiceId, mismatched);
  }

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
  await readNewEmails(engine, obligation, false);
  // Closed already, by the policy or by a person, so nothing is decided or sent,
  // whatever its payments show now. A payment found late that may still pay it
  // reopened it when it was recorded.
  if (obligation.state === "settled" || obligation.state === "rejected") {
    return null;
  }
  // Before the policy, so its reason is not replaced, and before a paid payment
  // could close the incident.
  const twice: Attempt | undefined = paidTwice(engine.ledger, invoiceId);
  if (twice !== undefined) {
    return holdPaidTwice(engine, invoiceId, twice);
  }
  // Still kept failed, as when another process opened or recorded a payment
  // meanwhile: nothing is decided around a payment the bank has live, and the
  // next look, at once, records it again.
  if (engine.ledger.attempts(invoiceId).some(keptFailed)) {
    return Date.now();
  }
  if (engine.ledger.paidOnce(invoiceId)) {
    // A paid replacement was sent on a decision already made, so it closes the
    // incident. A paid original goes to the policy, which may want a person. So
    // does an invoice with a live payout sent outside PayOnce.
    if (paidOriginal(engine.ledger, invoiceId) === undefined && !anyLive(outside)) {
      // Refused when a payment went out at a rate nobody approved, or when another
      // process changed the ledger since this look read it.
      return close(engine, invoiceId, obligation.state) ? null : closeRefused(engine, invoiceId);
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

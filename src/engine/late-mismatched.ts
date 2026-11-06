import type { Transfer } from "../airwallex/transfers.js";
import { attemptStateOf, debitOf } from "../domain/assess.js";
import { readMinor } from "../domain/money.js";
import { foundAfterClose, reasonFor } from "../domain/reasons.js";
import type { Attempt, AttemptState, Ledger, Obligation, ObligationState } from "../store/ledger.js";
import { anyLive, paidTwice } from "../store/read/facts.js";
import { capitalise } from "../domain/sentences.js";
import type { Engine, NextLook } from "./engine.js";
import { describe, note } from "./lines.js";
import { syncTransfer } from "./payments.js";
import { noteChecks, transferChecks, type TransferChecks } from "./send.js";

// The attempt a transfer Airwallex lists belongs to, when the ledger has no
// transfer on it: one still pending whose create went unanswered, or one marked
// failed because Airwallex listed nothing under its request id at the time. The
// transfer must also carry the invoice's number as its reference, and its amount
// and currency, as PayOnce sends them.
export function unrecordedAttemptOf(ledger: Ledger, transfer: Transfer): Attempt | undefined {
  const requestId: string = transfer.request_id ?? "";
  const attempt: Attempt | undefined =
    requestId === "" ? undefined : ledger.attemptOf(requestId, transfer.id);
  if (attempt?.requestId !== requestId || attempt.transferId !== null) {
    return undefined;
  }
  const obligation: Obligation | undefined = ledger.obligation(attempt.invoiceId);
  return obligation !== undefined &&
    transfer.reference === obligation.invoiceId &&
    transfer.transfer_currency === obligation.currency &&
    readMinor(transfer.transfer_amount) === obligation.amountMinor
    ? attempt
    : undefined;
}

// Such a transfer is not recorded as the attempt's payment, because it may not be
// this invoice's. It is kept beside the attempt with the status the bank gives
// it, and counts as live (liveAtBank) until the bank fails it, so nothing more is
// sent or released for the invoice meanwhile. The first time, the timeline says
// so in PayOnce's words and the invoice waits for a person, reopened unless it
// is settled. Later reads only update its status. True when it tied the transfer
// or its status changed, so the caller looks at the invoice again.
export function noteMismatchedTransfer(engine: Engine, transfer: Transfer): boolean {
  const requestId: string = transfer.request_id ?? "";
  const attempt: Attempt | undefined =
    requestId === "" ? undefined : engine.ledger.attemptOf(requestId, transfer.id);
  if (attempt?.requestId !== requestId || attempt.transferId !== null) {
    return false;
  }
  if (attempt.mismatchedTransferId === transfer.id) {
    return syncMismatched(engine, attempt, transfer);
  }
  if (
    attempt.state !== "failed" ||
    unrecordedAttemptOf(engine.ledger, transfer) !== undefined ||
    // The invoice goes to a person in the transaction that keeps the transfer.
    !engine.ledger.addMismatched(
      requestId,
      transfer.id,
      transfer.short_reference_id,
      transfer.status ?? null,
      debitOf(transfer),
      reasonFor("unrecognised-transfer"),
    )
  ) {
    return false;
  }
  const invoiceId: string = attempt.invoiceId;
  note(
    engine.ledger,
    invoiceId,
    "warning",
    `${capitalise(attempt.kind)} payment PayOnce had marked failed has a transfer under its request id that does not match this invoice: Airwallex lists ${transfer.short_reference_id} ${transfer.status} under it with another reference, amount or currency. PayOnce did not record it as the ${attempt.kind}, sends nothing for this invoice while the bank has it, and a person checks it`,
  );
  return true;
}

// Records the status the bank gives a transfer kept beside an attempt because it
// does not match the invoice, with a bank line when it is paid or failed. True
// when the status changed.
export function syncMismatched(engine: Engine, attempt: Attempt, transfer: Transfer): boolean {
  if (!engine.ledger.setMismatchedStatus(transfer.id, transfer.status, debitOf(transfer))) {
    return false;
  }
  const state: AttemptState | null = attemptStateOf(transfer);
  if (state === "paid" || state === "failed") {
    note(
      engine.ledger,
      attempt.invoiceId,
      "bank",
      `Transfer under the ${attempt.kind}'s request id that does not match this invoice: ${describe(transfer)}`,
    );
  }
  return true;
}

// Nothing is sent or released while a transfer under one of the invoice's request
// ids that does not match it is live at the bank, and any open request is
// withdrawn. A person checks it: once it is paid, a person can close the invoice,
// and once it has failed, the invoice carries on, but PayOnce never closes it by
// itself until a person has.
export function holdMismatched(engine: Engine, invoiceId: string, attempt: Attempt): NextLook {
  engine.ledger.escalateUnlessSettled(invoiceId, reasonFor("unrecognised-transfer"));
  if (engine.ledger.voidOpenApprovals(invoiceId)) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      "Approval request withdrawn: a transfer that does not match this invoice is live under one of its request ids",
    );
  }
  const reference: string = attempt.mismatchedReference ?? attempt.mismatchedTransferId ?? "";
  note(
    engine.ledger,
    invoiceId,
    "approval",
    attempt.mismatchedStatus === "PAID"
      ? `Waiting on a person. Transfer ${reference}, under the ${attempt.kind}'s request id, is paid but does not match this invoice. Check it with the supplier and close the incident. PayOnce sends nothing more`
      : `Waiting on a person. Transfer ${reference}, under the ${attempt.kind}'s request id, does not match this invoice and is still with the bank, so PayOnce sends nothing`,
    "waiting",
  );
  return null;
}

// Nothing more is sent while two payments may both pay the invoice, and any open
// request is withdrawn. The invoice waits for a person with a reason the policy
// never replaces, because the look holds it here before the policy runs, so the
// alert and the close card name it.
export function holdPaidTwice(engine: Engine, invoiceId: string, late: Attempt): NextLook {
  engine.ledger.escalate(invoiceId, reasonFor("late-transfer"));
  if (engine.ledger.voidOpenApprovals(invoiceId)) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      "Approval request withdrawn: the supplier may have been paid twice",
    );
  }
  note(
    engine.ledger,
    invoiceId,
    "approval",
    `Waiting on a person. ${capitalise(late.kind)} ${late.reference ?? late.transferId ?? ""} and another payment for this invoice may both pay the supplier, so PayOnce sends nothing`,
    "waiting",
  );
  return null;
}

// Records a transfer Airwallex lists only now under the request id of an attempt
// PayOnce had marked failed with none on it, in the state the bank gives it, and
// says so on the timeline. A pending attempt is left to its look, which lists it
// by request id and checks its transfer as it does any payment it sends. When
// another payment for the invoice has not failed either, the line is a warning
// and the invoice waits for a person with LATE_TRANSFER_REASON, reopened if it
// was closed. Any other closed invoice the transfer may still pay is reopened
// too. True when it recorded one, and the caller then looks at the invoice
// again.
export async function recordLateTransfer(engine: Engine, transfer: Transfer): Promise<boolean> {
  const attempt: Attempt | undefined = unrecordedAttemptOf(engine.ledger, transfer);
  if (attempt?.state !== "failed" || !engine.ledger.foundLate(attempt.requestId, Date.now())) {
    return false;
  }
  const invoiceId: string = attempt.invoiceId;
  const before: Obligation | undefined = engine.ledger.obligation(invoiceId);
  const checks: TransferChecks | undefined =
    before === undefined ? undefined : transferChecks(engine, before, attempt);
  let twice: boolean = false;
  let kept: boolean = false;
  // What it decides is written with the record, before any line: the checks, and
  // the escalation that reopens a closed invoice it may still pay. A line that
  // could not be written then leaves nothing undone, and a step that stops before
  // the record leaves the attempt with no transfer, for the next sweep.
  const recorded: Transfer = await syncTransfer(engine.client, engine.ledger, transfer.id, (read: Transfer): void => {
    const live: boolean = attemptStateOf(read) !== "failed";
    // It is checked against its approved quote, for a payment from another
    // currency's wallet, and against the account it was decided or approved for,
    // as when a look finds a transfer by request id. A failed one on a closed
    // invoice moved nothing, so it does not reopen it.
    if (checks !== undefined && before !== undefined && (live || before.state === "open" || before.state === "escalated")) {
      checks.decide(read);
    }
    twice = paidTwice(engine.ledger, invoiceId) !== undefined;
    // Live at the bank, but the ledger keeps it failed: another payment holds the lock.
    kept = live && engine.ledger.attemptOf(attempt.requestId, read.id)?.state === "failed";
    const state: ObligationState | undefined = engine.ledger.obligation(invoiceId)?.state;
    if (twice) {
      engine.ledger.escalate(invoiceId, reasonFor("late-transfer"));
    } else if (live && (state === "settled" || state === "rejected")) {
      engine.ledger.escalate(invoiceId, foundAfterClose(attempt.kind, read.short_reference_id));
    }
    engine.ledger.lookNow(invoiceId);
  });
  if (checks !== undefined) {
    noteChecks(engine, invoiceId, checks);
  }
  const other: string = anyLive(engine.ledger.outsidePayouts(invoiceId))
    ? "A payout sent outside PayOnce for this invoice"
    : "Another payment PayOnce sent for this invoice";
  note(
    engine.ledger,
    invoiceId,
    twice ? "warning" : "bank",
    `${capitalise(attempt.kind)} payment PayOnce had marked failed is a transfer after all: Airwallex now lists ${describe(recorded)} under its request id${twice ? `. ${other} has not failed either, so the supplier may have been paid twice` : ""}${kept ? `. PayOnce still lists the ${attempt.kind} as failed, because it keeps one live payment per invoice` : ""}`,
  );
  return true;
}

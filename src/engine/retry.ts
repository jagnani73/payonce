import { findTransferByRequestId, type Transfer } from "../airwallex/transfers.js";
import { accountKeyOf, type ApprovalTerms } from "../domain/approval.js";
import { deadlineMinutes } from "../domain/deadlines.js";
import { reasonFor, type Reason } from "../domain/reasons.js";
import { debitCurrency } from "../domain/reserve.js";
import {
  liveAtBank,
  mismatchedLive,
  payoutVerdict,
  type Approval,
  type Attempt,
  type Obligation,
  type ObligationState,
  type OutsidePayout,
  type RunRow,
} from "../store/ledger.js";
import { capitalise } from "../text/printable.js";
import { withCurrencyLock } from "./currency-lock.js";
import { CONTINUE, nextLookAt, type Engine, type NextLook, type StepResult } from "./engine.js";
import { anyLive, paidTwice } from "./facts.js";
import { holdMismatched, holdPaidTwice } from "./late-mismatched.js";
import { note } from "./lines.js";
import { holdForOutsidePayout } from "./outside.js";
import { sendAttempt, wasRejected } from "./payments.js";
import { AccountChangedError, requireAccount, type TransferChecks } from "./send.js";
import { requestTerms } from "./stored.js";

// A pending attempt is not sent again while a payout for the invoice sent outside
// PayOnce is live. It stays pending under its request id, which keeps the
// duplicate lock, so PayOnce opens no other payment for the invoice either. It is
// tried again on a look after that payout has failed.
function holdRetryForOutsidePayout(engine: Engine, invoiceId: string, attempt: Attempt): NextLook {
  engine.ledger.escalate(invoiceId, reasonFor("outside-payout"));
  note(
    engine.ledger,
    invoiceId,
    "warning",
    `${capitalise(attempt.kind)} payment not sent again: a payout for this invoice was sent outside PayOnce and may already pay it. The ${attempt.kind} stays open under its request id, and a later look sends it only if that payout fails`,
    "retry",
  );
  return holdForOutsidePayout(engine, invoiceId);
}

// When a pending attempt with no transfer counts as never sent: a bank deadline
// of its method after its latest create try, or after it was opened when it has
// had none. One with neither time on file is given a try time now, so it waits a
// full deadline and is never failed on the first look.
function neverSentAt(engine: Engine, obligation: Obligation, attempt: Attempt): number {
  let from: number = Date.parse(attempt.triedAt ?? attempt.openedAt ?? "");
  if (!Number.isFinite(from)) {
    from = Date.now();
    engine.ledger.tried(attempt.requestId, from);
  }
  return from + deadlineMinutes(obligation.transferMethod) * 60_000;
}

// Why a pending attempt with no transfer may never be sent: something else pays
// the invoice, or the record no longer holds the account the attempt keeps.
export type NeverSentCause =
  // A payout sent outside PayOnce that has paid the invoice.
  | { kind: "paid-outside"; payout: OutsidePayout }
  // A paid payout that names the invoice but does not pay it (payoutPays):
  // another amount, currency or account, or one PayOnce could not check. Nothing
  // more is sent beside it, and a person decides.
  | { kind: "names-only"; payout: OutsidePayout }
  // A transfer found late that the bank has live. The attempt is held while it
  // may pay the invoice. Once the attempt is marked failed, the duplicate lock is
  // free, and the next look, at once, records the late transfer in its own state
  // and follows it like any payment.
  | { kind: "late"; late: Attempt }
  // A paid transfer under the request id of another attempt that does not match
  // the invoice. Once the attempt is marked failed, a person can close the
  // invoice from the close card.
  | { kind: "mismatched"; mismatched: Attempt }
  // The record no longer holds the account the attempt was decided or approved
  // for, so it is not sent again. Restoring those details in Airwallex lets the
  // next look send it. Once it is marked failed, restoring them sends nothing by
  // itself: the invoice is with a person like any other whose payment failed,
  // held before paying for an original, or under the policy's bank-details rule
  // for a replacement, and pays only on an approval. The waiting line says so
  // until the next look, at once, says what the invoice waits on.
  | { kind: "account-changed" };

// A cause in PayOnce's words: payment says what pays the invoice, or why the
// attempt is not sent, then what marking the attempt failed leaves, and reason
// why the invoice waits for a person meanwhile.
interface CauseText {
  payment: string;
  then: string;
  reason: Reason;
}

function causeText(obligation: Obligation, cause: NeverSentCause): CauseText {
  switch (cause.kind) {
    case "paid-outside":
      return {
        payment: `payout ${cause.payout.reference} sent outside PayOnce has paid this invoice`,
        then: "a person can close the invoice",
        reason: reasonFor("outside-payout"),
      };
    case "names-only":
      return {
        payment:
          payoutVerdict(obligation, cause.payout, null) !== null
            ? `payout ${cause.payout.reference} sent outside PayOnce names this invoice and is paid, but does not match its amount, currency or account`
            : `payout ${cause.payout.reference} sent outside PayOnce names this invoice and is paid, but PayOnce could not check its amount, currency or account`,
        then: "a person checks it, and can close the invoice without paying",
        reason: reasonFor("outside-payout"),
      };
    case "late": {
      const named: string = `${cause.late.kind} ${cause.late.reference ?? cause.late.transferId ?? ""}`;
      return {
        payment: `${named}, found late, is live at the bank and may pay this invoice`,
        then: `${named} counts as this invoice's payment`,
        reason: reasonFor("late-transfer"),
      };
    }
    case "mismatched": {
      const reference: string = cause.mismatched.mismatchedReference ?? cause.mismatched.mismatchedTransferId ?? "";
      return {
        payment: `transfer ${reference} under the failed ${cause.mismatched.kind}'s request id is paid but does not match this invoice`,
        then: "a person can close the invoice",
        reason: reasonFor("unrecognised-transfer"),
      };
    }
    case "account-changed":
      return {
        payment: "the bank details on file are not the ones it was decided or approved for",
        then: "a person decides how to pay the invoice, or closes it without paying",
        reason: reasonFor("account-changed-before-send"),
      };
  }
}

// How the invoice waits while the attempt is held for its cause.
function holdFor(engine: Engine, invoiceId: string, cause: NeverSentCause): NextLook {
  switch (cause.kind) {
    case "paid-outside":
    case "names-only":
      return holdForOutsidePayout(engine, invoiceId);
    case "late":
      return holdPaidTwice(engine, invoiceId, cause.late);
    case "mismatched":
      return holdMismatched(engine, invoiceId, cause.mismatched);
    case "account-changed":
      note(
        engine.ledger,
        invoiceId,
        "approval",
        "Waiting on a person. The bank details on file are not the ones this payment was decided or approved for, so PayOnce does not send it again. Restore those details in Airwallex and check again to send it",
        "waiting",
      );
      return null;
  }
}

// What the look does once the attempt is marked failed for its cause.
function afterFail(engine: Engine, invoiceId: string, attempt: Attempt, cause: NeverSentCause): NextLook {
  switch (cause.kind) {
    case "paid-outside":
    case "names-only":
      return holdForOutsidePayout(engine, invoiceId);
    case "late":
      return Date.now();
    case "mismatched":
      return holdMismatched(engine, invoiceId, cause.mismatched);
    case "account-changed":
      note(
        engine.ledger,
        invoiceId,
        "approval",
        `Waiting on a person. The ${attempt.kind} was marked failed without being sent, so restoring those details no longer sends it: paying this invoice now takes a person's approval, or a person closes it without paying`,
        "waiting",
      );
      return Date.now();
  }
}

// A pending attempt with no transfer, on an invoice something else pays (cause).
// It is held as any retry is until neverSentAt, and the look comes back then.
// After that, if Airwallex still lists no transfer under its request id, it never
// became one: it is marked failed, which releases the duplicate lock. The attempt
// is read again, listed and failed under the lock of the wallet it pays from,
// which a retry holds from its create try to recording the transfer, so no try is
// under way meanwhile, and a try another process made since this look read it
// moves the deadline on. failAttempt changes only an attempt still pending with no
// transfer. A transfer listed by then is recorded by the next look, due at once.
export async function failNeverSent(
  engine: Engine,
  obligation: Obligation,
  attempt: Attempt,
  cause: NeverSentCause,
): Promise<NextLook> {
  const invoiceId: string = obligation.invoiceId;
  const kind: string = capitalise(attempt.kind);
  const text: CauseText = causeText(obligation, cause);
  engine.ledger.escalate(invoiceId, text.reason);
  let deadline: number = neverSentAt(engine, obligation, attempt);
  if (Date.now() >= deadline) {
    const failed: boolean | number = await withCurrencyLock(
      engine.ledger,
      debitCurrency(obligation),
      async (): Promise<boolean | number> => {
        const now: Attempt | undefined = engine.ledger
          .attempts(invoiceId)
          .find((current: Attempt): boolean => current.requestId === attempt.requestId);
        if (now === undefined || now.state !== "pending" || now.transferId !== null) {
          return false;
        }
        const due: number = neverSentAt(engine, obligation, now);
        if (Date.now() < due) {
          return due;
        }
        return (
          (await findTransferByRequestId(engine.client, attempt.requestId)) === undefined &&
          engine.ledger.failAttempt(attempt.requestId, null, false)
        );
      },
    );
    if (failed === false) {
      return Date.now();
    }
    if (failed === true) {
      note(
        engine.ledger,
        invoiceId,
        "payment",
        `${kind} payment marked failed: Airwallex lists no transfer under its request id a bank deadline after it was last tried, and ${text.payment}. PayOnce sent nothing for it, so ${text.then}`,
        "retry",
      );
      return afterFail(engine, invoiceId, attempt, cause);
    }
    deadline = failed;
  }
  note(
    engine.ledger,
    invoiceId,
    "warning",
    `${kind} payment not sent again: ${text.payment}. If Airwallex still lists no transfer for the ${attempt.kind} at ${new Date(deadline).toISOString().slice(11, 16)} UTC, a bank deadline after it was last tried, PayOnce marks it failed and ${text.then}`,
    "retry",
  );
  holdFor(engine, invoiceId, cause);
  return deadline;
}

// Whether a pending attempt that Airwallex lists no transfer for under its
// request_id is held instead of sent again, once the look has tied any unseen
// payout (linked) and read the payouts sent outside PayOnce (outside). A payout
// sent outside PayOnce since the attempt was opened, for example in the Airwallex
// web app while its create call went unanswered, may already pay the invoice, so
// the attempt is not sent again while one is live. One tied just now that has
// already failed holds nothing: the next look, at once, sends the attempt, as
// before any other payment. Nor is it sent while a payment found late may pay
// the invoice.
export function holdPending(
  engine: Engine,
  obligation: Obligation,
  attempt: Attempt,
  outside: OutsidePayout[],
  linked: boolean,
): StepResult {
  const invoiceId: string = obligation.invoiceId;
  // A transfer found late that the bank has live may pay the invoice. This
  // attempt waits for it as for a paid payout sent outside PayOnce, and is
  // marked failed if it never became a transfer, so the late one takes the
  // lock.
  const twice: Attempt | undefined = paidTwice(engine.ledger, invoiceId);
  if (twice !== undefined) {
    return nextLookAt(failNeverSent(engine, obligation, attempt, { kind: "late", late: twice }));
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
    return nextLookAt(failNeverSent(engine, obligation, attempt, { kind: "paid-outside", payout: paidBy }));
  }
  const namedBy: OutsidePayout | undefined = tied.namesOnly[0];
  if (namedBy !== undefined) {
    return nextLookAt(failNeverSent(engine, obligation, attempt, { kind: "names-only", payout: namedBy }));
  }
  if (anyLive(outside)) {
    return nextLookAt(holdRetryForOutsidePayout(engine, invoiceId, attempt));
  }
  // A paid one is waited for as a paid payout sent outside PayOnce is, so the
  // attempt is marked failed if it never became a transfer.
  const mismatched: Attempt | undefined = engine.ledger.attempts(invoiceId).find(mismatchedLive);
  if (mismatched?.mismatchedStatus === "PAID") {
    return nextLookAt(failNeverSent(engine, obligation, attempt, { kind: "mismatched", mismatched }));
  }
  if (mismatched !== undefined) {
    return nextLookAt(holdMismatched(engine, invoiceId, mismatched));
  }
  return linked ? nextLookAt(Date.now()) : CONTINUE;
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

// What sending a pending attempt again came to: Airwallex has its transfer
// (sent); nothing was sent because the record no longer holds the account the
// attempt keeps (account-changed); its quote had run out a bank deadline ago and
// Airwallex refused a last try and lists no transfer for it, so nothing was sent
// and a person approves it on a new quote (lapsed); or nothing was sent because
// the ledger changed while the look waited for the lock (changed): it shows a
// payout for the invoice sent outside PayOnce live, another payment for it live
// at the bank, such as a transfer found late (paidTwice), the invoice closed, or
// the attempt no longer pending with no transfer, just before the create call.
// Another process may have tied the payout, recorded the late transfer, closed
// the invoice, or failed or recorded the attempt meanwhile.
export type Retried =
  | { kind: "sent"; transfer: Transfer }
  | { kind: "account-changed" }
  | { kind: "lapsed" }
  | { kind: "changed" };

// Sends an attempt still pending with no transfer again, under its request_id,
// holding the currency lock of the wallet the money leaves. original is the
// original the look has read so far.
export function retryUnderLock(
  engine: Engine,
  obligation: Obligation,
  attempt: Attempt,
  original: Transfer | null,
  checks: TransferChecks,
): Promise<Retried> {
  return withCurrencyLock(
    engine.ledger,
    debitCurrency(obligation),
    (): Promise<Retried> => retry(engine, obligation, attempt, original, checks),
  );
}

// A retry pays the record as it is now, so every payment goes out only to the
// account it was decided or approved for, which the attempt keeps. An attempt
// from before the account was kept is checked as it was then: against the
// approval it was opened on, so a request another process opened since does not
// count, then the run row's account, since a person may have approved another
// account after the row was held. Once its quote has run out a bank deadline
// ago, a payment from another currency's wallet has one last try, which fails it
// if Airwallex refuses its quote and lists no transfer for it.
async function retry(
  engine: Engine,
  obligation: Obligation,
  attempt: Attempt,
  original: Transfer | null,
  checks: TransferChecks,
): Promise<Retried> {
  const approval: Approval | undefined = engine.ledger.approvalOf(attempt);
  const approved: ApprovalTerms | undefined =
    approval?.state === "used" ? requestTerms(approval) : undefined;
  const row: RunRow | undefined =
    obligation.runRowId === null ? undefined : engine.ledger.runRow(obligation.runRowId);
  try {
    if (attempt.accountKey !== null) {
      await requireAccount(
        engine,
        obligation,
        attempt.accountKey,
        attempt.approvalId === null ? "payment was decided" : "payment was approved",
      );
    } else if (attempt.kind === "replacement") {
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
  } catch (error: unknown) {
    if (error instanceof AccountChangedError) {
      return { kind: "account-changed" };
    }
    throw error;
  }
  const lapsed: boolean = quoteLapsed(obligation, attempt);
  const invoiceId: string = obligation.invoiceId;
  const state: ObligationState | undefined = engine.ledger.obligation(invoiceId)?.state;
  const attempts: Attempt[] = engine.ledger.attempts(invoiceId);
  if (
    (state !== "open" && state !== "escalated") ||
    anyLive(engine.ledger.outsidePayouts(invoiceId)) ||
    attempts.some(
      (current: Attempt): boolean => current.requestId !== attempt.requestId && liveAtBank(current),
    ) ||
    !attempts.some(
      (current: Attempt): boolean =>
        current.requestId === attempt.requestId &&
        current.state === "pending" &&
        current.transferId === null,
    )
  ) {
    return { kind: "changed" };
  }
  try {
    return {
      kind: "sent",
      transfer: await sendAttempt(
        engine.client,
        engine.ledger,
        obligation,
        attempt,
        lapsed ? "lapsed" : "retry",
        checks.decide,
      ),
    };
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
    return { kind: "lapsed" };
  }
}

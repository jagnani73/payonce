import type { Approval, Attempt, Obligation, OutsidePayout } from "../store/ledger.js";
import { failedStatus } from "./assess.js";
import type { StoredReason } from "./reasons.js";

// Every notion of "live" PayOnce has, each defined once: per transfer, per
// outside payout, per payment over its transfers and payouts, and per request.
// The SQL guards in the ledger's write transactions are these tests over rows:
// LIVE_ATTEMPT is liveAtBank, LIVE_OUTSIDE_PAYOUT payoutNotFailed,
// BLOCKING_OUTSIDE_PAYOUT payoutBlocking, UNCLEARED_MISMATCH
// unrecognisedUncleared and SENT_ATTEMPT sentSomething.

// What liveAtBank reads of an attempt.
export type LiveTested = Pick<
  Attempt,
  "state" | "transferId" | "bankStatus" | "foundLateAt" | "mismatchedTransferId" | "mismatchedStatus"
>;

type PayoutTested = Pick<OutsidePayout, "state" | "pays">;

type RequestTested = Pick<Approval, "id" | "state" | "expiresAt">;

const MS_PER_MINUTE: number = 60_000;

// ---------- one transfer ----------

// The attempt's own payment: not failed, or a transfer the ledger keeps failed
// that the bank has live.
export function ownLive(attempt: LiveTested): boolean {
  if (attempt.state !== "failed") {
    return true;
  }
  if (attempt.transferId === null) {
    return false;
  }
  return attempt.bankStatus === null ? attempt.foundLateAt !== null : !failedStatus(attempt.bankStatus);
}

// A transfer under the attempt's request id that does not match its invoice,
// which the bank has not failed.
export function mismatchedLive(attempt: LiveTested): boolean {
  return (
    attempt.mismatchedTransferId !== null &&
    (attempt.mismatchedStatus === null || !failedStatus(attempt.mismatchedStatus))
  );
}

// The duplicate lock's truth: anything under the attempt's request id the bank
// has live.
export function liveAtBank(attempt: LiveTested): boolean {
  return ownLive(attempt) || mismatchedLive(attempt);
}

// The attempt's own payment, live and not paid yet: being sent, in flight, or
// in a status PayOnce does not know.
export function withBank(attempt: LiveTested): boolean {
  return ownLive(attempt) && attempt.state !== "paid" && attempt.bankStatus !== "PAID";
}

// Opened, and its transfer not created yet.
export function sending(attempt: Pick<Attempt, "state" | "transferId">): boolean {
  return attempt.state === "pending" && attempt.transferId === null;
}

// A transfer the bank has and has not paid or failed.
export function inFlight(attempt: LiveTested): boolean {
  return attempt.transferId !== null && withBank(attempt);
}

// A transfer the bank has, in flight or paid.
export function sentToBank(attempt: LiveTested): boolean {
  return inFlight(attempt) || (attempt.transferId !== null && attempt.state === "paid");
}

// A transfer under the attempt's request id that does not match its invoice,
// live and not paid.
export function unrecognisedLive(attempt: LiveTested): boolean {
  return mismatchedLive(attempt) && attempt.mismatchedStatus !== "PAID";
}

export function unrecognisedPaid(attempt: LiveTested): boolean {
  return mismatchedLive(attempt) && attempt.mismatchedStatus === "PAID";
}

// Such a transfer that no person's close has cleared.
export function unrecognisedUncleared(attempt: Pick<Attempt, "mismatchedTransferId" | "mismatchedClearedAt">): boolean {
  return attempt.mismatchedTransferId !== null && attempt.mismatchedClearedAt === null;
}

// Anything under the attempt's request id that the bank has live and not paid.
export function stillWithBank(attempt: LiveTested): boolean {
  return withBank(attempt) || unrecognisedLive(attempt);
}

// The attempt's own payment failed at the bank, and nothing under its request id
// is still with it.
export function nothingWithBank(attempt: LiveTested): boolean {
  return !ownLive(attempt) && !stillWithBank(attempt);
}

// A transfer the ledger keeps failed while the bank has it live.
export function keptFailedLive(attempt: LiveTested): boolean {
  return attempt.state === "failed" && attempt.transferId !== null && liveAtBank(attempt);
}

// Failed with no transfer: held, refused, or never created.
export function neverSent(attempt: Pick<Attempt, "state" | "transferId">): boolean {
  return attempt.transferId === null && attempt.state === "failed";
}

export function sentSomething(attempt: Pick<Attempt, "state" | "transferId">): boolean {
  return attempt.transferId !== null || attempt.state !== "failed";
}

// A transfer the bank failed, with nothing left live under its request id.
export function failedForGood(attempt: LiveTested): boolean {
  return attempt.state === "failed" && attempt.transferId !== null && !liveAtBank(attempt);
}

// When the bank should have paid or failed the transfer, counted from the
// creation time Airwallex gave, or null when none can be read.
export function deadlineAt(attempt: Pick<Attempt, "bankCreatedAt">, deadlineMinutes: number): number | null {
  const created: number = attempt.bankCreatedAt === null ? Number.NaN : Date.parse(attempt.bankCreatedAt);
  return Number.isFinite(created) ? created + deadlineMinutes * MS_PER_MINUTE : null;
}

// Past its deadline by its creation time, or, with none on file, when the
// invoice went to a person for a bank deadline.
export function pastDeadline(
  attempt: Pick<Attempt, "bankCreatedAt">,
  deadlineMinutes: number,
  reason: StoredReason | null,
  now: number,
): boolean {
  const at: number | null = deadlineAt(attempt, deadlineMinutes);
  return at === null
    ? reason?.code === "deadline-original" || reason?.code === "deadline-replacement"
    : now >= at;
}

// ---------- one outside payout ----------

export function payoutLive(payout: PayoutTested): boolean {
  return payout.state === "in_flight" || payout.state === "unknown";
}

export function payoutNotFailed(payout: PayoutTested): boolean {
  return payout.state !== "failed";
}

// Paid, and pays its invoice as the last look found.
export function payoutPays(payout: PayoutTested): boolean {
  return payout.state === "paid" && payout.pays === true;
}

// Holds PayOnce's own payments and a person's close without paying.
export function payoutBlocking(payout: PayoutTested): boolean {
  return payout.state !== "failed" && (payout.state !== "paid" || payout.pays === true);
}

// Paid, and only names the invoice: it does not pay it, or no look could tell.
export function payoutNamesOnly(payout: PayoutTested): boolean {
  return payout.state === "paid" && payout.pays !== true;
}

// ---------- one payment ----------

// A transfer found late, or one the ledger keeps failed, that the bank has live,
// while another payment for the invoice is live too: the supplier may have been
// paid twice.
export function lateBesideLive<A extends LiveTested & Pick<Attempt, "requestId">>(
  attempts: A[],
  payouts: PayoutTested[],
): A | undefined {
  const late: A | undefined = attempts.find(
    (attempt: A): boolean =>
      attempt.transferId !== null && liveAtBank(attempt) && (attempt.state === "failed" || attempt.foundLateAt !== null),
  );
  if (late === undefined) {
    return undefined;
  }
  const other: boolean =
    attempts.some((attempt: A): boolean => attempt.requestId !== late.requestId && liveAtBank(attempt)) ||
    payouts.some(payoutNotFailed);
  return other ? late : undefined;
}

// Exactly one payment paid, and nothing under any request id still with the bank.
export function paidOnce(attempts: LiveTested[]): boolean {
  return (
    attempts.filter((attempt: LiveTested): boolean => attempt.state === "paid").length === 1 &&
    !attempts.some(stillWithBank)
  );
}

export function paidOutside(attempts: LiveTested[], payouts: PayoutTested[]): boolean {
  return attempts.every(nothingWithBank) && payouts.some(payoutPays);
}

export function paidMismatched(attempts: LiveTested[], payouts: PayoutTested[]): boolean {
  return (
    attempts.every(nothingWithBank) &&
    attempts.some(unrecognisedPaid) &&
    !payouts.some((payout: PayoutTested): boolean => payout.state !== "failed" && payout.state !== "paid")
  );
}

// With a person, and nothing live or paid, PayOnce's or sent outside it, so a
// person can still release a payment for it.
export function couldStillPay(
  obligation: Pick<Obligation, "state">,
  attempts: LiveTested[],
  payouts: PayoutTested[],
): boolean {
  return (
    obligation.state === "escalated" &&
    !attempts.some(liveAtBank) &&
    payouts.every((payout: PayoutTested): boolean => payout.state === "failed")
  );
}

// With a person, and nothing ever sent: held before paying, or refused.
export function heldBeforePaying(obligation: Pick<Obligation, "state">, attempts: Pick<Attempt, "state" | "transferId">[]): boolean {
  return obligation.state === "escalated" && attempts.every(neverSent);
}

// Something with the bank that PayOnce polls for.
export function watching(attempts: LiveTested[], payouts: PayoutTested[]): boolean {
  return attempts.some(withBank) || payouts.some(payoutLive);
}

// ---------- one request ----------

// When a request stops covering a payment. One recorded before requests expired
// counts as expired already.
export function expiryOf(request: Pick<Approval, "expiresAt">): number {
  const at: number = request.expiresAt === null ? Number.NaN : Date.parse(request.expiresAt);
  return Number.isFinite(at) ? at : 0;
}

export function isExpired(request: Pick<Approval, "expiresAt">, now: number): boolean {
  return expiryOf(request) <= now;
}

export function awaitingSignoffs(request: RequestTested | undefined, now: number): boolean {
  return request?.state === "requested" && !isExpired(request, now);
}

export function approvedUnspent(request: RequestTested | undefined, now: number): boolean {
  return request?.state === "approved" && !isExpired(request, now);
}

export function requestOpen(request: RequestTested | undefined, now: number): boolean {
  return awaitingSignoffs(request, now) || approvedUnspent(request, now);
}

export function requestExpired(request: RequestTested | undefined, now: number): boolean {
  return request !== undefined && (request.state === "requested" || request.state === "approved") && isExpired(request, now);
}

// A person approved and PayOnce is using it: approved and not expired, or used
// with its payment still being sent or with the bank.
export function approvedUnderway(
  request: RequestTested | undefined,
  attempts: Pick<Attempt, "approvalId" | "state">[],
  now: number,
): boolean {
  if (request?.state === "approved") {
    return !isExpired(request, now);
  }
  return (
    request?.state === "used" &&
    attempts.some(
      (attempt: Pick<Attempt, "approvalId" | "state">): boolean =>
        attempt.approvalId === request.id && (attempt.state === "pending" || attempt.state === "in_flight"),
    )
  );
}

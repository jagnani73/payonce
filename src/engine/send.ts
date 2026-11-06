import { getBankDetails } from "../airwallex/beneficiaries.js";
import type { Transfer, TransferBankDetails } from "../airwallex/transfers.js";
import { accountKeyOf, conversionText, rateMismatch, type ApprovalTerms, type FxTerms } from "../domain/approval.js";
import { arrivalFor, atRisk, sentArrivalText, today, type ArrivalTerms } from "../domain/arrival.js";
import { routeKeyOf } from "../domain/assess.js";
import { deadlineOf, describeDeadline } from "../domain/deadlines.js";
import { formatMoney, invoiceMoney, toMinor } from "../domain/money.js";
import type { Approval, Attempt, AttemptKind, Obligation } from "../store/ledger.js";
import { capitalise } from "../text/printable.js";
import type { Engine, NextLook } from "./engine.js";
import { messageOf, note } from "./lines.js";
import { sendAttempt, wasRejected, type Decide } from "./payments.js";
import { REPLACEMENT_DEADLINE_REASON } from "./reason-text.js";

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
// decided or approved for: every detail, by its full accountKey, so a change to
// any field after a decision or an approval stops the payment, and the next look
// decides or asks again. Throws AccountChangedError, sending nothing, when it
// does not. Gives the routeKey of the record it read, which the attempt opened
// next keeps.
export async function requireAccount(
  engine: Engine,
  obligation: Obligation,
  accountKey: string,
  what: string,
): Promise<string> {
  const now: TransferBankDetails = await getBankDetails(engine.client, obligation.beneficiaryId);
  if (accountKeyOf(now) !== accountKey) {
    throw new AccountChangedError(what);
  }
  return routeKeyOf(now);
}

// A payment from another currency's wallet must go out on the quote a person
// approved. The money has moved by then, so a transfer at any other rate goes to
// a person, and only a person closes the invoice. Why it did not, or null.
function rateProblem(engine: Engine, attempt: Attempt, transfer: Transfer): string | null {
  if (attempt.quoteId === null) {
    return null;
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
  return problem === null ? null : `${attempt.kind} ${transfer.short_reference_id} ${problem}`;
}

// A transfer is paid to the beneficiary record as it is when it is created, which
// can change between the account check and the create call. One that went to
// other details than the attempt was decided or approved for is marked
// misdirected, so it never counts as the account PayOnce last paid this supplier,
// and goes to a person. So does one that shows no bank details, which nobody
// could check, as a transfer with no conversion fails the rate check. Why, or
// null when it went to the account it was meant for.
function accountMismatch(attempt: Attempt, transfer: Transfer): string | null {
  const sentTo: TransferBankDetails | undefined = transfer.beneficiary?.bank_details;
  if (attempt.accountKey === null || (sentTo !== undefined && accountKeyOf(sentTo) === attempt.accountKey)) {
    return null;
  }
  return sentTo === undefined
    ? `${attempt.kind} ${transfer.short_reference_id} shows no bank details, so PayOnce cannot check they are the ones it was decided or approved for`
    : `${attempt.kind} ${transfer.short_reference_id} went to bank details that are not the ones it was decided or approved for`;
}

// The checks a transfer gets wherever its attempt first gains it: when it is
// sent, when a retry creates it, when it is found by its request_id, and when it
// is found late under the request id of an attempt marked failed. decide writes
// what they find, the mismatch or misdirected mark and the escalation, in the
// transaction that records the transfer (see Decide), so a step that stops after
// the record, such as on a timeline line it could not write, never leaves a
// transfer recorded and unchecked. warnings holds the lines for what decide
// found, which noteChecks writes after the record.
export interface TransferChecks {
  decide: Decide;
  warnings: string[];
}

export function transferChecks(engine: Engine, obligation: Obligation, attempt: Attempt): TransferChecks {
  const warnings: string[] = [];
  return {
    warnings,
    decide: (transfer: Transfer): void => {
      warnings.length = 0;
      const rate: string | null = rateProblem(engine, attempt, transfer);
      if (rate !== null) {
        engine.ledger.markRateMismatch(attempt.requestId, rate);
        engine.ledger.escalate(obligation.invoiceId, rate);
        warnings.push(capitalise(rate));
      }
      const account: string | null = accountMismatch(attempt, transfer);
      if (account !== null) {
        engine.ledger.markMisdirected(attempt.requestId);
        engine.ledger.escalate(obligation.invoiceId, account);
        warnings.push(capitalise(account));
      }
    },
  };
}

export function noteChecks(engine: Engine, invoiceId: string, checks: TransferChecks): void {
  for (const warning of checks.warnings) {
    note(engine.ledger, invoiceId, "warning", warning);
  }
}

// Sends an attempt already written to the ledger, to the account it keeps.
export async function send(
  engine: Engine,
  obligation: Obligation,
  attempt: Attempt,
): Promise<Transfer> {
  const kind: AttemptKind = attempt.kind;
  const checks: TransferChecks = transferChecks(engine, obligation, attempt);
  let created: Transfer;
  try {
    created = await sendAttempt(engine.client, engine.ledger, obligation, attempt, "first", checks.decide);
  } catch (error: unknown) {
    throw new Error(
      wasRejected(error)
        ? `${capitalise(kind)} payment was refused and nothing was sent. ${messageOf(error)}`
        : `${capitalise(kind)} payment request did not complete, so the transfer may or may not exist. Run ${obligation.invoiceId} again to reconcile it. ${messageOf(error)}`,
      { cause: error },
    );
  }

  // Noted as soon as the transfer exists, so a later failure cannot hide it, and
  // after the checks recorded what they found with it. The fee is charged in the
  // wallet the payment left.
  const fee: string =
    created.fee_amount > 0
      ? `, plus a ${formatMoney(toMinor(created.fee_amount), created.fee_currency ?? obligation.sourceCurrency)} transfer fee`
      : "";
  note(
    engine.ledger,
    obligation.invoiceId,
    "payment",
    `${capitalise(kind)} ${created.short_reference_id} sent: ${invoiceMoney(obligation)} to ${obligation.supplier}${conversionText(created)}${fee}`,
  );
  noteChecks(engine, obligation.invoiceId, checks);
  const sentTo: TransferBankDetails | undefined = created.beneficiary?.bank_details;
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
  engine.bank?.sent(obligation.invoiceId, kind, created.id, created.short_reference_id);
  return created;
}

// Leaves the invoice waiting on the bank until the transfer's deadline, when the
// agent looks again if nothing has woken it before.
export function waitForBank(
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
export function deadlineLook(transfer: Transfer): number {
  const deadline: number = deadlineOf(transfer);
  return Number.isFinite(deadline) ? deadline : Date.now();
}

// A replacement the bank sits on is never followed by another payment. A person
// hears about it, and the incident still closes if the bank pays it.
export function replacementOverdue(
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

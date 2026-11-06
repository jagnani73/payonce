import { findBeneficiary } from "../airwallex/beneficiaries.js";
import { getTransfer, listTransfersSince, type Transfer, type TransferBankDetails } from "../airwallex/transfers.js";
import { sentToOf } from "../domain/approval.js";
import { debitOf, feeOf, knownRoute, originalStateOf, routeKeyOf, type Debit, type Fee } from "../domain/assess.js";
import { reasonFor } from "../domain/reasons.js";
import { nearlyPays } from "../domain/duplicates.js";
import { readMinor } from "../domain/money.js";
import { railFailureSeen } from "../outages/outages.js";
import {
  holdsAccount,
  payoutVerdict,
  type Attempt,
  type LastPaid,
  type Ledger,
  type Obligation,
  type OutsidePayout,
  type PayoutMoney,
  type PayoutState,
} from "../store/ledger.js";
import type { Engine, NextLook } from "./engine.js";
import { noteMismatchedTransfer, recordLateTransfer, unrecordedAttemptOf } from "./late-mismatched.js";
import { describe, note, payoutSummary } from "./lines.js";

// A payout's amount and fee for the ledger, each in the currency it was taken in.
// One that cannot be read is null, so tying the payout never fails on it.
function payoutMoney(transfer: Transfer): PayoutMoney {
  const fee: Fee | null = feeOf(transfer);
  const debit: Debit | null = debitOf(transfer);
  const delivered: number | null = readMinor(transfer.transfer_amount);
  return {
    amountMinor: debit?.minor ?? null,
    currency: debit?.currency ?? null,
    feeMinor: fee?.minor ?? null,
    feeCurrency: fee?.currency ?? null,
    beneficiaryId: transfer.beneficiary_id ?? null,
    deliveredMinor: delivered,
    deliveredCurrency: delivered === null || typeof transfer.transfer_currency !== "string" ? null : transfer.transfer_currency,
    // Where it went, for the supplier view only. sentToOf never throws, so odd
    // bank details cannot stop the payout being tied or the check before a payment.
    ...sentToOf(transfer.beneficiary?.bank_details),
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
  // A closed invoice it may still pay is reopened in the transaction that ties it.
  const linked: boolean = engine.ledger.linkOutsidePayout(
    invoiceId,
    {
      transferId: transfer.id,
      reference: transfer.short_reference_id,
      state,
      ...payoutMoney(transfer),
    },
    state === "failed" ? null : reasonFor("outside-payout"),
  );
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
  return true;
}

// Looks in Airwallex for payouts for this invoice that PayOnce has not seen, and
// ties them to it: one whose reference names it, or one it nearlyPays whose
// reference names no invoice exactly. It runs before an original or a replacement
// goes out, so a payment someone made outside PayOnce is not paid a second time,
// even when the reference also nearly matches an older invoice. A transfer listed
// under the request id of one of its attempts marked failed with none on it is
// recorded on that attempt. A pending one is the look's own: it lists each by
// request id before this. True when it tied or recorded any.
export async function linkUnseenPayouts(engine: Engine, invoiceId: string): Promise<boolean> {
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
    const late: Attempt | undefined = unrecordedAttemptOf(engine.ledger, transfer);
    if (late?.invoiceId === invoiceId && late.state === "failed") {
      linked = (await recordLateTransfer(engine, transfer)) || linked;
      continue;
    }
    if (engine.ledger.knowsTransfer(transfer.request_id ?? "", transfer.id)) {
      if (engine.ledger.attemptOf(transfer.request_id ?? "", transfer.id)?.invoiceId === invoiceId) {
        linked = noteMismatchedTransfer(engine, transfer) || linked;
      }
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
// paid or failed since. One tied before PayOnce kept what a payout delivered and
// where it went is read once too, a paid one included. Then each paid one is
// judged against the beneficiary record as it is now (judgePayouts). Returns
// them all as they now stand.
export async function syncOutsidePayouts(
  engine: Engine,
  invoiceId: string,
): Promise<OutsidePayout[]> {
  for (const payout of engine.ledger.outsidePayouts(invoiceId)) {
    if ((payout.state === "paid" && payout.checked === true) || payout.state === "failed") {
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
    if (state === "failed") {
      railFailureSeen(engine.ledger, transfer, "look", engine.outageRule, engine.bankDeadlineMinutes);
    }
  }
  await judgePayouts(engine, invoiceId);
  return engine.ledger.outsidePayouts(invoiceId);
}

// Works out, for each paid payout sent outside PayOnce tied to the invoice,
// whether it pays it (payoutVerdict), against the account PayOnce would pay now
// (payingRoute), and keeps it. Reads the beneficiary record only when one is
// paid.
async function judgePayouts(engine: Engine, invoiceId: string): Promise<void> {
  const obligation: Obligation | undefined = engine.ledger.obligation(invoiceId);
  const paid: OutsidePayout[] = engine.ledger
    .outsidePayouts(invoiceId)
    .filter((payout: OutsidePayout): boolean => payout.state === "paid");
  if (obligation === undefined || paid.length === 0) {
    return;
  }
  const record: TransferBankDetails | undefined = (
    await findBeneficiary(engine.client, obligation.beneficiaryId)
  )?.beneficiary?.bank_details;
  const route: string | null = payingRoute(engine.ledger, obligation, record);
  // Always written, never decided from the row read above: another process may
  // have changed the stored verdict since, and it must end as the one just
  // worked out. One PayOnce could not work out is written as not paying.
  for (const payout of paid) {
    engine.ledger.setPayoutVerdict(payout.transferId, payoutVerdict(obligation, payout, route) === true);
  }
}

// The routeKey of the account PayOnce would pay this invoice's beneficiary now
// without a person, the account the first-payment hold and checkAccount expect:
// the record's when it holds the account of PayOnce's last checked payment to
// the beneficiary, when a verified callback matches it, or when PayOnce has
// never paid the beneficiary; else that last checked payment's account. Null
// when there is none, as for a beneficiary paid only before PayOnce kept which
// account each payment went to. Only a payout sent outside PayOnce that went
// there pays the invoice.
function payingRoute(
  ledger: Ledger,
  obligation: Obligation,
  record: TransferBankDetails | undefined,
): string | null {
  const last: LastPaid | undefined = ledger.lastPaidTransfer(obligation.beneficiaryId);
  if (record !== undefined) {
    const neverPaid: boolean = last === undefined && ledger.lastPaidUnchecked(obligation.beneficiaryId) === undefined;
    if (
      neverPaid ||
      (last !== undefined && holdsAccount(last, record)) ||
      ledger.verifiedBankChange(obligation.beneficiaryId, record) !== undefined
    ) {
      return routeKeyOf(record);
    }
  }
  return last === undefined ? null : knownRoute(last.routeKey);
}

// Nothing is sent while a payout for the invoice sent outside PayOnce may pay it.
export function holdForOutsidePayout(engine: Engine, invoiceId: string): NextLook {
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

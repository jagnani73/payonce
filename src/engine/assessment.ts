import { getAvailableMinor } from "../airwallex/balances.js";
import { getBankDetails } from "../airwallex/beneficiaries.js";
import { getTransfer, type Transfer, type TransferBankDetails } from "../airwallex/transfers.js";
import type { ArrivalTerms } from "../domain/arrival.js";
import { originalStateOf, resendCanFix, sameBankDetails } from "../domain/assess.js";
import { isOverdue } from "../domain/deadlines.js";
import { decide } from "../domain/decide.js";
import type { SupplierEmail } from "../domain/emails.js";
import type { Incident, OriginalTransferState } from "../domain/incident.js";
import { liveAtBank } from "../domain/live.js";
import { formatMoney, invoiceMoney, toMinor } from "../domain/money.js";
import { reasonText, type Reason } from "../domain/reasons.js";
import { debitCurrency, floorFor } from "../domain/reserve.js";
import { crossCurrency, type Attempt, type BankChange, type Obligation } from "../store/ledger.js";
import { committedMinor } from "../store/read/cash.js";
import { anyLive, paidDuplicate } from "../store/read/facts.js";
import { storedFindings, type StoredFindings } from "../store/stored.js";
import { capitalise } from "../text/printable.js";
import { emailsNotRead, sendersNotOnFile } from "./emails.js";
import type { Assessment, Decided, Engine, Rate } from "./engine.js";
import { note } from "./lines.js";
import { rateFor } from "./rates.js";
import { decided, namingNotToPay, secondBill } from "./reason-text.js";
import { arrivalClause, arrivalOf } from "./terms.js";

// The floor as the cost line names it.
function floorText(floorMinor: number | null, currency: string): string {
  if (floorMinor === null) {
    return `no reserve floor is set for ${currency}`;
  }
  return Number.isFinite(floorMinor)
    ? `reserve floor ${formatMoney(floorMinor, currency)}`
    : "the reserve floor setting could not be read";
}

export async function assess(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<Assessment> {
  const original: Transfer = await getTransfer(engine.client, originalId);
  const emails: SupplierEmail[] = engine.ledger.emails(obligation.invoiceId);
  const { findings, stored }: { findings: StoredFindings; stored: boolean } = storedFindings(
    engine.ledger,
    obligation.invoiceId,
    emails,
  );
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
    bankOverdue: originalState === "in_flight" && isOverdue(original, engine.bankDeadlineMinutes),
    resendCanFix: resendCanFix(original),
    sentOutsidePayOnce: obligation.origin === "outside",
    // The look that called this has just read them from Airwallex.
    outsidePayoutLive: anyLive(engine.ledger.outsidePayouts(obligation.invoiceId)),
    // Failed at the bank: a replacement the ledger keeps failed beside a live one
    // has not.
    replacementFailed: engine.ledger
      .attempts(obligation.invoiceId)
      .some(
        (attempt: Attempt): boolean =>
          attempt.kind === "replacement" && !liveAtBank(attempt),
      ),
    supplierReportsNonReceipt: findings.claimsNonReceipt === true,
    supplierAsksForNewBankDetails: findings.asksForNewBankDetails === true,
    supplierAsksNotToPay: findings.asksNotToPay === true,
    beneficiaryChanged: !sameBankDetails(
      original.beneficiary?.bank_details,
      bankDetails,
    ),
    emailFromUnverifiedSender: unverified.length > 0,
    emailsUnread: emailsNotRead(findings, stored, emails),
    emailPartlyUnread: emails.some((email: SupplierEmail): boolean => email.partial === true),
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
    const replacement: string = converts ? `A replacement of ${invoiceMoney(obligation)}` : "A replacement";
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
  const decision: Decided = secondBill(decided(decide(incident), incident), paid);
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
    ? (engine.ledger.verifiedBankChange(obligation.beneficiaryId, bankDetails) ?? null)
    : null;
  const arrival: ArrivalTerms | null = arrivalOf(engine.ledger, obligation, bankDetails);
  const assessment: Assessment = {
    original,
    incident,
    findings,
    unverified,
    emails,
    bankDetails,
    bankChange,
    rate,
    arrival,
    decision,
    floor: null,
    paidDuplicate: paid,
  };
  // The arrival is advice for people. The policy decided without it. The ask not
  // to pay is named here as the request and the alert name it. The floor and a
  // paid second bill have standing warnings of their own (noteFloor, noteSecondBill).
  const said: Reason =
    decision.action === "escalate"
      ? namingNotToPay(decision.reason, incident.supplierAsksNotToPay)
      : decision.reason;
  note(
    engine.ledger,
    obligation.invoiceId,
    "decision",
    `${capitalise(decision.action)}: ${reasonText(said)}${held}${arrivalClause(assessment)}`,
    "decision",
  );
  return assessment;
}

import type { Decision, Incident } from "./incident.js";

export const OUTSIDE_PAYOUT_REASON: string =
  "a payout for this invoice was sent outside PayOnce";

// How the no-floor reason reads when it is added to another reason, which already
// says why a person approves.
export const NO_FLOOR_CLAUSE: string = "no reserve floor is set for this currency";

export const NO_FLOOR_REASON: string = `${NO_FLOOR_CLAUSE}, so a person approves any replacement`;

export const BELOW_FLOOR_REASON: string =
  "a replacement and its transfer fee would push cash below the reserve floor";
export const UNREADABLE_CASH_REASON: string = "the cash position could not be read";
export const NEW_BANK_DETAILS_REASON: string = "supplier asked for payment to different bank details";
export const CHANGED_BANK_DETAILS_REASON: string =
  "the supplier's bank details on file changed after the original payment";
// Why a first payment is held when the record no longer holds the account
// PayOnce last paid this supplier and no callback verified the one it holds.
export const LAST_PAID_CHANGED_REASON: string =
  "the supplier's bank details on file changed since PayOnce last paid this supplier";
export const ORIGINAL_DEADLINE_REASON: string =
  "the bank has not paid or failed the original transfer by its deadline";
// Why the agent sent a replacement it would have sent by itself to a person. It
// is the invoice's escalation reason only, never in approval terms, which are
// built from the replace decision, so an outage changes no binding. Past tense,
// so it stays true once the outage has ended.
export const OUTAGE_REASON: string =
  "an outage was declared on this payment's currency and transfer method, so a person approves any replacement";
// The reasons supplier emails escalate for are PayOnce's own words, never the
// email's, because alerts post escalation reasons.
export const NOT_TO_PAY_REASON: string = "supplier asked to hold, cancel or not pay this invoice";
export const PARTLY_UNREAD_REASON: string = "part of a supplier email could not be read";
// How the ask not to pay reads when it is added to another reason.
export const NOT_TO_PAY_CLAUSE: string = "the supplier asks to hold, cancel or not pay this invoice";
// The policy's other reasons. Exported so the explanation of an incident can
// recognise them as PayOnce's own words. The strings are the ones stored in
// escalation reasons and approval terms, so no binding changes.
export const UNVERIFIED_SENDER_REASON: string =
  "an email came from an address that does not match the supplier on file";
export const EMAILS_UNREAD_REASON: string = "supplier emails are on file that could not be read";
export const UNKNOWN_STATUS_REASON: string =
  "original transfer is in a status the policy does not recognise";
export const NON_RECEIPT_REASON: string =
  "original transfer settled but the supplier reports non-receipt";
export const SETTLED_REASON: string =
  "original transfer settled and no supplier email reports it missing";
export const IN_FLIGHT_REASON: string =
  "original transfer is still in flight, a replacement risks a double payment";
export const REPLACEMENT_FAILED_REASON: string = "a replacement payment failed as well";
export const NOT_RESENDABLE_REASON: string = "original failed for a reason a resend cannot fix";
export const SENT_OUTSIDE_REASON: string =
  "the original was sent outside PayOnce, so a person approves any replacement";
export const TWO_APPROVERS_REASON: string = "a replacement this large needs two approvers";
export const REPLACE_REASON: string =
  "original failed, a resend can fix it and the beneficiary details are unchanged";

// The reason with the ask not to pay added, while that finding is on file and the
// reason does not already name it. A person can still approve paying the invoice.
// Without the finding the reason is returned as it is, so the approval terms of
// every other invoice keep their binding.
export function namingNotToPay(reason: string, asksNotToPay: boolean): string {
  return !asksNotToPay || reason.startsWith(NOT_TO_PAY_REASON) || reason.includes(`, and ${NOT_TO_PAY_CLAUSE}`)
    ? reason
    : `${reason}, and ${NOT_TO_PAY_CLAUSE}`;
}

// Why the cash keeps a replacement from being sent unprompted, or null when it
// and its fee leave the wallet above its floor. The policy and the check before
// an approved replacement is spent both use it, so they cannot disagree.
export function floorReason(incident: Incident): string | null {
  // With no floor set there is nothing to check the cash against.
  if (incident.reserveFloorMinor === null) {
    return NO_FLOOR_REASON;
  }

  // Money already promised to other payments is still in the available balance,
  // so it is taken off before the floor is checked. It is all in the wallet the
  // payment leaves.
  const replacementCostMinor: number =
    incident.sourceAmountMinor + incident.transferFeeMinor;
  const balanceAfterMinor: number =
    incident.availableBalanceMinor - incident.committedMinor - replacementCostMinor;

  // A NaN compares false against everything, so an unreadable cash position must
  // be caught here and not allowed to pass as "above the floor".
  if (!Number.isFinite(balanceAfterMinor) || !Number.isFinite(incident.reserveFloorMinor)) {
    return UNREADABLE_CASH_REASON;
  }

  if (balanceAfterMinor < incident.reserveFloorMinor) {
    return BELOW_FLOOR_REASON;
  }
  return null;
}

export function decide(incident: Incident): Decision {
  // PayOnce's lock only covers its own payments, so one sent by someone else
  // stops it sending anything until a person has looked.
  if (incident.outsidePayoutLive) {
    return { action: "escalate", reason: OUTSIDE_PAYOUT_REASON };
  }

  if (incident.supplierAsksForNewBankDetails) {
    return {
      action: "escalate",
      reason: NEW_BANK_DETAILS_REASON,
    };
  }

  if (incident.supplierAsksNotToPay) {
    return {
      action: "escalate",
      reason: NOT_TO_PAY_REASON,
    };
  }

  if (incident.beneficiaryChanged) {
    return {
      action: "escalate",
      reason: CHANGED_BANK_DETAILS_REASON,
    };
  }

  if (incident.emailFromUnverifiedSender) {
    return {
      action: "escalate",
      reason: UNVERIFIED_SENDER_REASON,
    };
  }

  if (incident.emailsUnread) {
    return {
      action: "escalate",
      reason: EMAILS_UNREAD_REASON,
    };
  }

  if (incident.emailPartlyUnread) {
    return {
      action: "escalate",
      reason: PARTLY_UNREAD_REASON,
    };
  }

  if (incident.originalState === "unknown") {
    return {
      action: "escalate",
      reason: UNKNOWN_STATUS_REASON,
    };
  }

  // A paid original holds the duplicate lock, so nothing more can be sent. What is
  // left to decide is whether a person has to hear about it.
  if (incident.originalState === "paid") {
    return incident.supplierReportsNonReceipt
      ? {
          action: "escalate",
          reason: NON_RECEIPT_REASON,
        }
      : {
          action: "close",
          reason: SETTLED_REASON,
        };
  }

  if (incident.originalState === "in_flight") {
    return incident.bankOverdue
      ? {
          action: "escalate",
          reason: ORIGINAL_DEADLINE_REASON,
        }
      : {
          action: "wait",
          reason: IN_FLIGHT_REASON,
        };
  }

  // A second failure says the route itself is broken, so sending a third payment
  // would only pay another fee.
  if (incident.replacementFailed) {
    return {
      action: "escalate",
      reason: REPLACEMENT_FAILED_REASON,
    };
  }

  if (!incident.resendCanFix) {
    return {
      action: "escalate",
      reason: NOT_RESENDABLE_REASON,
    };
  }

  // Checked before the cash, so the reason does not change with the balance or the
  // floor. An approval request for the replacement names the floor as well when
  // the cash is short.
  if (incident.sentOutsidePayOnce) {
    return {
      action: "escalate",
      reason: SENT_OUTSIDE_REASON,
    };
  }

  const cash: string | null = floorReason(incident);
  if (cash !== null && cash !== NO_FLOOR_REASON) {
    return { action: "escalate", reason: cash };
  }

  // The approval policy asks two people to approve a payment this size, so the
  // agent does not replace it by itself either.
  if (incident.sourceAmountMinor > incident.twoApproversAboveMinor) {
    return {
      action: "escalate",
      reason: TWO_APPROVERS_REASON,
    };
  }

  // The agent never pays at a rate nobody has seen, and a replacement needs a new
  // quote.
  if (incident.crossCurrency) {
    return {
      action: "escalate",
      reason: `a replacement paid from ${incident.sourceCurrency} takes a new exchange rate, so a person approves it`,
    };
  }

  // A currency with no floor set fails closed, as approvals do without APPROVERS.
  // It comes last, so it only stops a replacement the agent would otherwise send.
  if (cash !== null) {
    return { action: "escalate", reason: cash };
  }

  return {
    action: "replace",
    reason: REPLACE_REASON,
  };
}

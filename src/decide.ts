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
export const ORIGINAL_DEADLINE_REASON: string =
  "the bank has not paid or failed the original transfer by its deadline";

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
      reason: "supplier asked to hold, cancel or not pay this invoice",
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
      reason: "an email came from an address that does not match the supplier on file",
    };
  }

  if (incident.emailsUnread) {
    return {
      action: "escalate",
      reason: "supplier emails are on file that could not be read",
    };
  }

  if (incident.emailPartlyUnread) {
    return {
      action: "escalate",
      reason: "part of a supplier email could not be read",
    };
  }

  if (incident.originalState === "unknown") {
    return {
      action: "escalate",
      reason: "original transfer is in a status the policy does not recognise",
    };
  }

  // A paid original holds the duplicate lock, so nothing more can be sent. What is
  // left to decide is whether a person has to hear about it.
  if (incident.originalState === "paid") {
    return incident.supplierReportsNonReceipt
      ? {
          action: "escalate",
          reason: "original transfer settled but the supplier reports non-receipt",
        }
      : {
          action: "close",
          reason: "original transfer settled and no supplier email reports it missing",
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
          reason: "original transfer is still in flight, a replacement risks a double payment",
        };
  }

  // A second failure says the route itself is broken, so sending a third payment
  // would only pay another fee.
  if (incident.replacementFailed) {
    return {
      action: "escalate",
      reason: "a replacement payment failed as well",
    };
  }

  if (!incident.resendCanFix) {
    return {
      action: "escalate",
      reason: "original failed for a reason a resend cannot fix",
    };
  }

  // Checked before the cash, so the reason does not change with the balance or the
  // floor. An approval request for the replacement names the floor as well when
  // the cash is short.
  if (incident.sentOutsidePayOnce) {
    return {
      action: "escalate",
      reason: "the original was sent outside PayOnce, so a person approves any replacement",
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
      reason: "a replacement this large needs two approvers",
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
    reason: "original failed, a resend can fix it and the beneficiary details are unchanged",
  };
}

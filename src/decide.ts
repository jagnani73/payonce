import type { Decision, Incident } from "./incident.js";

export const OUTSIDE_PAYOUT_REASON: string =
  "a payout for this invoice was sent outside PayOnce";

export function decide(incident: Incident): Decision {
  // PayOnce's lock only covers its own payments, so one sent by someone else
  // stops it sending anything until a person has looked.
  if (incident.outsidePayoutLive) {
    return { action: "escalate", reason: OUTSIDE_PAYOUT_REASON };
  }

  if (incident.supplierAsksForNewBankDetails) {
    return {
      action: "escalate",
      reason: "supplier asked for payment to different bank details",
    };
  }

  if (incident.beneficiaryChanged) {
    return {
      action: "escalate",
      reason: "the supplier's bank details on file changed after the original payment",
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
          reason: "the bank has not paid or failed the original transfer by its deadline",
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

  const replacementCostMinor: number =
    incident.amountMinor + incident.transferFeeMinor;
  const balanceAfterMinor: number =
    incident.availableBalanceMinor - replacementCostMinor;

  // A NaN compares false against everything, so an unreadable cash position must
  // be caught here and not allowed to pass as "above the floor".
  if (
    !Number.isFinite(balanceAfterMinor) ||
    !Number.isFinite(incident.reserveFloorMinor)
  ) {
    return {
      action: "escalate",
      reason: "the cash position could not be read",
    };
  }

  if (balanceAfterMinor < incident.reserveFloorMinor) {
    return {
      action: "escalate",
      reason: "a replacement and its transfer fee would push cash below the reserve floor",
    };
  }

  if (incident.sentOutsidePayOnce) {
    return {
      action: "escalate",
      reason: "the original was sent outside PayOnce, so a person approves any replacement",
    };
  }

  return {
    action: "replace",
    reason: "original failed, a resend can fix it and the beneficiary details are unchanged",
  };
}

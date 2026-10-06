import type { Decision, Incident } from "./incident.js";

export function decide(incident: Incident): Decision {
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

  if (incident.originalState === "paid") {
    return {
      action: "escalate",
      reason: "original transfer settled but the supplier reports non-receipt",
    };
  }

  if (incident.originalState === "in_flight") {
    return {
      action: "wait",
      reason: "original transfer is still in flight, a replacement risks a double payment",
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

  return {
    action: "replace",
    reason: "original failed, a resend can fix it and the beneficiary details are unchanged",
  };
}

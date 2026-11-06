import { bindingOf } from "../domain/approval.js";
import { decide, floorReason, namingNotToPay, NO_FLOOR_CLAUSE, NO_FLOOR_REASON } from "../domain/decide.js";
import type { Decision, Incident } from "../domain/incident.js";
import { isExpired, type Approval, type LedgerEvent, type Obligation } from "../store/ledger.js";
import type { Assessment, Engine } from "./engine.js";
import { note } from "./lines.js";
import { termsOf } from "./terms.js";

// An email delivered before the first payment is read by a person first.
export const EMAILS_BEFORE_PAYMENT_REASON: string =
  "supplier emails arrived before the first payment, so a person reads them before PayOnce pays it";

// Why an invoice waits for a person when a transfer Airwallex listed late under
// the request id of a payment PayOnce had marked failed may pay it a second time.
// A fixed string, because alerts post escalation reasons.
export const LATE_TRANSFER_REASON: string =
  "a payment PayOnce marked as never sent reached the bank, so the supplier may have been paid twice";

// Why an invoice waits for a person when Airwallex lists a transfer under the
// request id of a payment PayOnce marked failed with none, and that transfer does
// not carry the invoice's number, amount and currency. A fixed string, because
// alerts post escalation reasons.
export const MISMATCHED_TRANSFER_REASON: string =
  "Airwallex lists a transfer under the request id of a payment PayOnce marked as never sent, and it does not match this invoice";

// The same reason once the bank has failed every such transfer for the invoice.
export const MISMATCHED_FAILED_REASON: string =
  "Airwallex listed a transfer under the request id of a payment PayOnce marked as never sent that did not match this invoice, and the bank has failed it";

export const REPLACEMENT_DEADLINE_REASON: string =
  "the bank has not paid or failed the replacement by its deadline";

// Why a pending payment with no transfer goes to a person when the record no
// longer holds the account it was decided or approved for. A fixed string, as
// alerts post it.
export const ACCOUNT_CHANGED_REASON: string =
  "the supplier's bank details on file changed after this payment was decided or approved, so PayOnce does not send it again";

// The reason a pay run row is held at send when paying it would take cash below
// the floor. It stays the same whatever the numbers, so it does not void an
// approval by its wording.
export const CASH_HOLD_REASON: string =
  "paying it now would take cash below the reserve floor";

// Why a pay run row waits for a person when the record no longer holds the
// account the run was approved for. A fixed string, as the supplier view tests it.
export const RUN_ACCOUNT_CHANGED_REASON: string =
  "its bank details changed after the pay run was approved";

// Why a held invoice needs two approvers when PayOnce has paid the beneficiary
// only with payments no person approved. A fixed string, which why-facts reads.
export const PAID_ONLY_BY_ITSELF: string = "PayOnce has never paid this beneficiary on a person's approval";

export function secondBillReason(invoiceId: string): string {
  return `it looks like a second bill for ${invoiceId}, which is paid`;
}

// A replacement for what looks like a second bill of a paid invoice goes to a
// person.
export function secondBill(decision: Decision, paid: string | null): Decision {
  return paid !== null && decision.action === "replace"
    ? { action: "escalate", reason: secondBillReason(paid) }
    : decision;
}

// A replacement that takes cash below its floor, or that no floor can be checked
// for, is paid only on an approval whose request said so. The policy checks some
// reasons before the cash, such as a payment sent outside PayOnce, so when one of
// those sent the invoice to a person the floor reason is added to it. The request
// then names both, and an approval of terms that did not is void.
function namingFloor(assessment: Assessment): Assessment {
  const decision: Decision = assessment.decision;
  const incident: Incident = assessment.incident;
  if (
    decision.action !== "escalate" ||
    incident.originalState !== "failed" ||
    incident.outsidePayoutLive
  ) {
    return assessment;
  }
  const floor: string | null = floorReason(incident);
  if (floor === null || floor === decision.reason) {
    return assessment;
  }
  const clause: string = floor === NO_FLOOR_REASON ? NO_FLOOR_CLAUSE : floor;
  return {
    ...assessment,
    decision: { action: "escalate", reason: `${decision.reason}, and ${clause}` },
    floor: clause,
  };
}

// A replacement request names a paid invoice this one looks like a second bill
// for, whatever else sent it to a person, so the binding carries it and an
// approval given without it is void. It comes after the floor, so the policy's
// reason and the floor read as they do without one.
function namingPaidDuplicate(assessment: Assessment): Assessment {
  const decision: Decision = assessment.decision;
  const incident: Incident = assessment.incident;
  const paid: string | null = assessment.paidDuplicate;
  if (
    paid === null ||
    decision.action !== "escalate" ||
    incident.originalState !== "failed" ||
    incident.outsidePayoutLive ||
    decision.reason === secondBillReason(paid)
  ) {
    return assessment;
  }
  return {
    ...assessment,
    decision: { action: "escalate", reason: `${decision.reason}, and ${secondBillReason(paid)}` },
  };
}

// The policy escalates for a supplier who asks not to pay, unless a payout sent
// outside PayOnce or new bank details come first. Then the reason names the ask
// as well, last, so the request, the alert and the card say it. Nothing is added
// without the finding, so every other invoice keeps its terms and its binding.
function namingNotToPayIn(assessment: Assessment): Assessment {
  const decision: Decision = assessment.decision;
  if (decision.action !== "escalate") {
    return assessment;
  }
  const reason: string = namingNotToPay(decision.reason, assessment.incident.supplierAsksNotToPay);
  return reason === decision.reason ? assessment : { ...assessment, decision: { action: "escalate", reason } };
}

// namingFloor, namingPaidDuplicate and namingNotToPayIn, and a line on the
// timeline once the floor stops applying after a line said it applied. The line
// says an approval still counts only when an open request or approval named the
// floor.
export function withFloorReason(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
): Assessment {
  const lastFloorLine: LedgerEvent | undefined = [...engine.ledger.events(obligation.invoiceId)]
    .reverse()
    .find((event: LedgerEvent): boolean => event.topic === "floor");
  if (floorReason(assessment.incident) === null && lastFloorLine?.kind === "warning") {
    const approval: Approval | undefined = engine.ledger.latestApproval(obligation.invoiceId);
    const above: string =
      "A replacement and its transfer fee would now leave cash above the reserve floor";
    note(
      engine.ledger,
      obligation.invoiceId,
      "payment",
      requestedDecision(obligation, assessment, approval) === undefined
        ? above
        : `${above}. An approval of a request that named the floor still counts`,
      "floor",
    );
  }
  return namingNotToPayIn(namingPaidDuplicate(namingFloor(assessment)));
}

// The decision an open request or approval was made under, when the floor applied
// then and does not now: cash was below it, could not be read, or no floor was
// set. Only the floor is changed, so the policy gives the reason it gave then.
// Undefined when no open request or approval named the floor.
function requestedDecision(
  obligation: Obligation,
  assessment: Assessment,
  approval: Approval | undefined,
): Decision | undefined {
  if (
    approval === undefined ||
    (approval.state !== "requested" && approval.state !== "approved") ||
    isExpired(approval) ||
    floorReason(assessment.incident) !== null
  ) {
    return undefined;
  }
  for (const floorMinor of [Number.MAX_SAFE_INTEGER, Number.NaN, null]) {
    const incident: Incident = { ...assessment.incident, reserveFloorMinor: floorMinor };
    const requested: Assessment = namingNotToPayIn(
      namingPaidDuplicate(
        namingFloor({ ...assessment, incident, decision: secondBill(decide(incident), assessment.paidDuplicate) }),
      ),
    );
    if (bindingOf(termsOf(obligation, requested)) === approval.binding) {
      return requested.decision;
    }
  }
  return undefined;
}

// The assessment as an open request or approval that named the floor saw it, so
// an approval given with less cash than there is now still covers the
// replacement. Otherwise the assessment as it is.
export function asRequested(
  obligation: Obligation,
  assessment: Assessment,
  approval: Approval | undefined,
): Assessment {
  const decision: Decision | undefined = requestedDecision(obligation, assessment, approval);
  return decision === undefined ? assessment : { ...assessment, decision };
}

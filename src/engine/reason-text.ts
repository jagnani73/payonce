import { bindingOf } from "../domain/approval.js";
import { decide, floorReason } from "../domain/decide.js";
import type { Decision, Incident } from "../domain/incident.js";
import { isExpired } from "../domain/live.js";
import {
  floorClause,
  NOT_TO_PAY,
  policyReason,
  secondBillPaid,
  withClause,
  type Clause,
  type Reason,
} from "../domain/reasons.js";
import type { Approval, LedgerEvent, Obligation } from "../store/ledger.js";
import type { Assessment, Decided, Engine } from "./engine.js";
import { note } from "./lines.js";
import { termsOf } from "./terms.js";

// Why a held invoice needs two approvers when PayOnce has paid the beneficiary
// only with payments no person approved. A fixed string, which why-facts reads.
export const PAID_ONLY_BY_ITSELF: string = "PayOnce has never paid this beneficiary on a person's approval";

// The policy's decision with its reason as codes.
export function decided(decision: Decision, incident: Incident): Decided {
  return { action: decision.action, reason: policyReason(decision.reason, incident.sourceCurrency) };
}

// A replacement for what looks like a second bill of a paid invoice goes to a
// person.
export function secondBill(decision: Decided, paid: string | null): Decided {
  return paid !== null && decision.action === "replace"
    ? { action: "escalate", reason: secondBillPaid(paid) }
    : decision;
}

// The reason with the ask not to pay added, last, while that finding is on file
// and the reason does not already name it. A person can still approve paying the
// invoice. Without the finding the reason is returned as it is, so the approval
// terms of every other invoice keep their binding.
export function namingNotToPay(reason: Reason, asksNotToPay: boolean): Reason {
  return asksNotToPay ? withClause(reason, NOT_TO_PAY) : reason;
}

function adding(reason: Reason, clause: Clause): Reason {
  return { ...reason, clauses: [...reason.clauses, clause] };
}

// A replacement that takes cash below its floor, or that no floor can be checked
// for, is paid only on an approval whose request said so. The policy checks some
// reasons before the cash, such as a payment sent outside PayOnce, so when one of
// those sent the invoice to a person the floor clause is added to it. The request
// then names both, and an approval of terms that did not is void.
function namingFloor(assessment: Assessment): Assessment {
  const decision: Decided = assessment.decision;
  const incident: Incident = assessment.incident;
  if (
    decision.action !== "escalate" ||
    incident.originalState !== "failed" ||
    incident.outsidePayoutLive
  ) {
    return assessment;
  }
  const floor: string | null = floorReason(incident);
  if (floor === null) {
    return assessment;
  }
  const clause: Clause = floorClause(floor);
  // The policy gave the floor as the reason itself.
  if (decision.reason.code === clause.code && decision.reason.clauses.length === 0) {
    return assessment;
  }
  return {
    ...assessment,
    decision: { action: "escalate", reason: adding(decision.reason, clause) },
    floor: clause,
  };
}

// A replacement request names a paid invoice this one looks like a second bill
// for, whatever else sent it to a person, so the binding carries it and an
// approval given without it is void. It comes after the floor, so the policy's
// reason and the floor read as they do without one.
function namingPaidDuplicate(assessment: Assessment): Assessment {
  const decision: Decided = assessment.decision;
  const incident: Incident = assessment.incident;
  const paid: string | null = assessment.paidDuplicate;
  if (
    paid === null ||
    decision.action !== "escalate" ||
    incident.originalState !== "failed" ||
    incident.outsidePayoutLive ||
    (decision.reason.code === "second-bill-paid" &&
      decision.reason.slots.invoice === paid &&
      decision.reason.clauses.length === 0)
  ) {
    return assessment;
  }
  return {
    ...assessment,
    decision: { action: "escalate", reason: adding(decision.reason, { code: "second-bill-paid", slots: { invoice: paid } }) },
  };
}

// The policy escalates for a supplier who asks not to pay, unless a payout sent
// outside PayOnce or new bank details come first. Then the reason names the ask
// as well, last, so the request, the alert and the card say it. Nothing is added
// without the finding, so every other invoice keeps its terms and its binding.
function namingNotToPayIn(assessment: Assessment): Assessment {
  const decision: Decided = assessment.decision;
  if (decision.action !== "escalate") {
    return assessment;
  }
  const reason: Reason = namingNotToPay(decision.reason, assessment.incident.supplierAsksNotToPay);
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
// Undefined when no open request or approval named the floor. The request's
// terms keep their reason as text, and the invoice's codes may name a later
// decision, so the decision is rebuilt with each floor and matched by binding.
function requestedDecision(
  obligation: Obligation,
  assessment: Assessment,
  approval: Approval | undefined,
): Decided | undefined {
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
        namingFloor({
          ...assessment,
          incident,
          decision: secondBill(decided(decide(incident), incident), assessment.paidDuplicate),
        }),
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
  const decision: Decided | undefined = requestedDecision(obligation, assessment, approval);
  return decision === undefined ? assessment : { ...assessment, decision };
}

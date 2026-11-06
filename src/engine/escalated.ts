import type { Transfer } from "../airwallex/transfers.js";
import { bindingOf, type ReplacementTerms } from "../domain/approval.js";
import type { SignoffRule } from "../domain/approvers.js";
import { originalStateOf, routeKeyOf } from "../domain/assess.js";
import { decide } from "../domain/decide.js";
import type { OriginalTransferState } from "../domain/incident.js";
import { clauseText, reasonFor, reasonText, secondBillPaid } from "../domain/reasons.js";
import { debitCurrency } from "../domain/reserve.js";
import {
  isExpired,
  RailOutageError,
  type Approval,
  type Attempt,
  type Lease,
  type Obligation,
  type Outage,
} from "../store/ledger.js";
import { assess } from "./assessment.js";
import { closeWaitingLine } from "./close.js";
import { withCurrencyLock } from "./currency-lock.js";
import { noteEvidenceUpgrade } from "./emails.js";
import type { Assessment, Engine, NextLook } from "./engine.js";
import { anyLive, paidDuplicate } from "./facts.js";
import { note } from "./lines.js";
import { holdForOutsidePayout, linkUnseenPayouts } from "./outside.js";
import { asRequested, withFloorReason } from "./reason-text.js";
import { awaitApproval, ruleFor, voidIfStale } from "./requests.js";
import { requireAccount, send, waitForBank } from "./send.js";
import { countedFromToday, termsOf } from "./terms.js";

// The reason escalate gives the invoice. decided gives the decision's when the
// policy escalates, and otherwise keeps the reason the invoice has. outage gives
// OUTAGE_REASON, for a replacement the policy would send on a rail with an
// outage: the terms still come from that replace decision.
export type EscalateAs = "decided" | "outage";

// A replacement is only on offer when the original has failed, and it goes to the
// beneficiary on file. A paid original leaves nothing to pay, so the person closes
// the incident. Any other escalation has no payment a person could approve yet.
// Returns when to look again: when an open request expires, so a new one can be
// opened.
export function escalate(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  as: EscalateAs,
): NextLook {
  // An invoice that is already with a person keeps the reason it went there for
  // when the policy would now do something else.
  engine.ledger.escalate(
    obligation.invoiceId,
    as === "outage"
      ? reasonFor("outage")
      : assessment.decision.action === "escalate"
        ? assessment.decision.reason
        : engine.ledger.reasonOf(obligation),
  );
  if (assessment.incident.outsidePayoutLive) {
    return holdForOutsidePayout(engine, obligation.invoiceId);
  }
  // An invoice already paid once, by the original or a replacement, has nothing
  // left to approve.
  const originalState: OriginalTransferState = originalStateOf(assessment.original);
  if (originalState === "paid" || engine.ledger.paidOnce(obligation.invoiceId)) {
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      closeWaitingLine(engine.ledger, obligation.invoiceId),
      "waiting",
    );
    return null;
  }
  if (originalState !== "failed") {
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      originalState === "in_flight"
        ? `Waiting on a person. Original ${assessment.original.short_reference_id} is still with the bank, so PayOnce sends nothing more`
        : "Waiting on a person",
      "waiting",
    );
    return null;
  }

  // A person closed it without paying, and continueEscalated could not close it
  // again, as when another process changed it meanwhile. Nobody is asked to
  // approve paying it.
  if (obligation.rejectedBy !== null) {
    if (engine.ledger.voidOpenApprovals(obligation.invoiceId)) {
      note(
        engine.ledger,
        obligation.invoiceId,
        "approval",
        `Approval request withdrawn: ${obligation.rejectedBy} closed this invoice without paying`,
      );
    }
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      `Waiting on a person. ${obligation.rejectedBy} closed this invoice without paying, so PayOnce asks nobody to approve paying it`,
      "waiting",
    );
    return null;
  }

  // An account the original did not go to is paid only once a person has called
  // the supplier on the number on file and the record matches what they confirmed.
  if (assessment.incident.beneficiaryChanged && assessment.bankChange === null) {
    if (engine.ledger.voidOpenApprovals(obligation.invoiceId)) {
      note(
        engine.ledger,
        obligation.invoiceId,
        "approval",
        "Approval request withdrawn: the bank details on file have not been verified by a callback",
      );
    }
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      obligation.supplierPhone === null
        ? "Waiting on a person. The bank details on file are not the ones the original went to, and no phone number is on file to verify them by calling the supplier back. Close the invoice without paying, or restore the details the original went to in Airwallex and check again"
        : `Waiting on a person to call the supplier on ${obligation.supplierPhone}, the number on file, and record the callback. PayOnce pays an account the original did not go to only after that`,
      "waiting",
    );
    noteFloor(engine, obligation, assessment, false);
    noteSecondBill(engine, obligation, assessment, false);
    return null;
  }

  const terms: ReplacementTerms = termsOf(obligation, assessment);
  const next: NextLook = awaitApproval(
    engine,
    obligation,
    terms,
    ruleFor(engine, obligation, terms, assessment.incident.beneficiaryChanged),
    assessment.rate,
    routeKeyOf(assessment.bankDetails),
  );
  // No request is open when nobody on the approver list could approve it, or when
  // a request on an old quote was withdrawn so the next look takes a fresh one. A
  // request awaitApproval opened just now counts its arrival from today.
  const latest: Approval | undefined = engine.ledger.latestApproval(obligation.invoiceId);
  const requested: boolean =
    latest?.state === "requested" &&
    !isExpired(latest) &&
    (latest.binding === bindingOf(terms) || latest.binding === bindingOf(countedFromToday(terms)));
  noteFloor(engine, obligation, assessment, requested);
  noteSecondBill(engine, obligation, assessment, requested);
  return next;
}

// Says that the floor reason was added to the policy's, and that the approval
// request says so too only when one is open.
function noteFloor(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  requested: boolean,
): void {
  if (assessment.floor === null) {
    return;
  }
  const floor: string = clauseText(assessment.floor);
  note(
    engine.ledger,
    obligation.invoiceId,
    "warning",
    requested
      ? `Also, ${floor}. The approval request says this too, and only an approval of that request releases a replacement`
      : `Also, ${floor}`,
    "floor",
  );
}

// Says that the invoice also looks like a second bill for a paid one when the
// policy sent it to a person for another reason, so the decision line did not
// say so.
function noteSecondBill(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  requested: boolean,
): void {
  const paid: string | null = assessment.paidDuplicate;
  if (paid === null || decide(assessment.incident).action === "replace") {
    return;
  }
  const secondBill: string = reasonText(secondBillPaid(paid));
  note(
    engine.ledger,
    obligation.invoiceId,
    "warning",
    requested ? `Also, ${secondBill}. The approval request says this too` : `Also, ${secondBill}`,
    "second-bill",
  );
}

export async function continueEscalated(
  engine: Engine,
  obligation: Obligation,
  originalId: string,
): Promise<NextLook> {
  // A person closed it without paying, and a payment found since reopened it. Once
  // every payment for it has failed at the bank, it is closed again and nobody is
  // asked to pay it.
  if (obligation.rejectedBy !== null && engine.ledger.rejectAgain(obligation.invoiceId)) {
    note(
      engine.ledger,
      obligation.invoiceId,
      "closed",
      `Closed without paying again. Every payment for this invoice has failed at the bank, and ${obligation.rejectedBy} had already closed it without paying`,
    );
    return null;
  }
  // Once an invoice has gone to a person, only an approval releases a payment and
  // only a person closes it, even if the policy would now do either unprompted.
  const assessed: Assessment = withFloorReason(
    engine,
    obligation,
    await assess(engine, obligation, originalId),
  );
  const approval: Approval | undefined = engine.ledger.latestApproval(
    obligation.invoiceId,
  );
  noteEvidenceUpgrade(engine, obligation.invoiceId, approval, assessed.emails.length);
  const assessment: Assessment = asRequested(obligation, assessed, approval);
  const current: ReplacementTerms = termsOf(obligation, assessment);
  const rule: SignoffRule = ruleFor(engine, obligation, current, assessment.incident.beneficiaryChanged);
  // A request that stays open keeps the terms it was opened with. A new one, after
  // a void or because more approvers are needed, gives the terms as they are now.
  if (approval?.state !== "approved") {
    return escalate(
      engine,
      obligation,
      approval?.state === "requested" && approval.needed >= rule.needed ? assessment : assessed,
      "decided",
    );
  }
  if (voidIfStale(engine, obligation, approval, current, rule)) {
    return escalate(engine, obligation, assessed, "decided");
  }
  // An approved payment on a rail with an outage waits with its approval, which
  // is neither spent nor void. useApproval refuses it too.
  const outage: Outage | undefined = engine.ledger.activeOutage(obligation.currency, obligation.transferMethod);
  if (outage !== undefined) {
    throw new RailOutageError(outage, "approved");
  }

  // A payout tied to the invoice now is looked at before anything is sent, and the
  // approval is left as it is until then. Another process may have tied one while
  // the list was being read.
  if (
    (await linkUnseenPayouts(engine, obligation.invoiceId)) ||
    anyLive(engine.ledger.outsidePayouts(obligation.invoiceId))
  ) {
    return Date.now();
  }
  // The currency lock is taken before anything is spent and held from the account
  // check to the recorded transfer, so a payment that cannot get its turn leaves
  // the approval unspent.
  return withCurrencyLock(engine.ledger, debitCurrency(obligation), async (lease: Lease): Promise<NextLook> => {
    // Checked before the approval is spent, so a failed check leaves it unspent.
    const route: string = await requireAccount(engine, obligation, current.accountKey, "replacement was approved");
    // One approval covers one attempt, so it is spent as the attempt is opened.
    // Another process may have voided it since it was read, recorded paid an
    // invoice this one looks like a second bill for since assess looked, or
    // delivered an email the approval did not see. Then nothing is spent, and the
    // next look names that invoice, or reads that email, in a new request.
    const attempt: Attempt | undefined = engine.ledger.useApproval(
      obligation.invoiceId,
      approval.id,
      lease,
      (): boolean =>
        paidDuplicate(engine.ledger, obligation) === assessment.paidDuplicate &&
        engine.ledger.emailCount(obligation.invoiceId) === assessment.emails.length,
      route,
    );
    if (attempt === undefined) {
      return Date.now();
    }
    note(
      engine.ledger,
      obligation.invoiceId,
      "approval",
      `Approval by ${approval.approver} matches the current terms`,
    );
    const replacement: Transfer = await send(engine, obligation, attempt);
    return waitForBank(engine, obligation.invoiceId, "replacement", replacement);
  });
}

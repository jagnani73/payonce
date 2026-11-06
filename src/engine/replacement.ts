import { getAvailableMinor } from "../airwallex/balances.js";
import type { Transfer } from "../airwallex/transfers.js";
import { accountKeyOf } from "../domain/approval.js";
import { decide, OUTAGE_REASON } from "../domain/decide.js";
import type { Decision, Incident } from "../domain/incident.js";
import { debitCurrency } from "../domain/reserve.js";
import { holdLine } from "../outages/outages.js";
import type { Attempt, Lease, Obligation, Outage } from "../store/ledger.js";
import { committedAcross, committedByInvoice } from "./cash-position.js";
import type { Assessment, Engine, NextLook } from "./engine.js";
import { escalate } from "./escalated.js";
import { anyLive, paidDuplicate } from "./facts.js";
import { note } from "./lines.js";
import { linkUnseenPayouts } from "./outside.js";
import { secondBill, withFloorReason } from "./reason-text.js";
import { requireAccount, send, waitForBank } from "./send.js";
import { arrivalClause } from "./terms.js";

// An automatic replacement, while holding the currency lock. The balance is read
// again under the lock and the policy decides again on it, with the money
// committed elsewhere as it is now, so two replacements in one currency cannot
// both pass on the same cash. The decision runs in the transaction that opens
// the attempt, so nothing is awaited between them.
export async function replaceUnderLock(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  lease: Lease,
): Promise<NextLook> {
  const invoiceId: string = obligation.invoiceId;
  // A payout tied to the invoice now is looked at before anything is sent.
  if (await linkUnseenPayouts(engine, invoiceId)) {
    return Date.now();
  }
  const accountKey: string = accountKeyOf(assessment.bankDetails);
  const route: string = await requireAccount(engine, obligation, accountKey, "decision");
  const wallet: string = debitCurrency(obligation);
  const before: Map<string, number> = committedByInvoice(engine.ledger, wallet, { invoiceId });
  const availableMinor: number = await getAvailableMinor(engine.client, wallet);

  let incident: Incident = assessment.incident;
  let paid: string | null = assessment.paidDuplicate;
  const next: Attempt | Decision | Outage | null = engine.ledger.transaction((): Attempt | Decision | Outage | null => {
    // Another process may have sent the invoice to a person, or a person may have
    // closed it without paying, while this look waited for the lock or read
    // Airwallex. Only an approval pays an invoice with a person, and nothing pays
    // a closed one, so the next look, at once, reads it as it is now.
    if (engine.ledger.obligation(invoiceId)?.state !== "open") {
      return null;
    }
    // A payout sent outside PayOnce that another process tied while this look
    // waited for the lock holds the replacement, as it holds an approved one.
    if (anyLive(engine.ledger.outsidePayouts(invoiceId))) {
      return null;
    }
    // An email delivered since assess read the thread is read before anything
    // is sent.
    if (engine.ledger.emailCount(invoiceId) !== assessment.emails.length) {
      return null;
    }
    incident = {
      ...assessment.incident,
      availableBalanceMinor: availableMinor,
      committedMinor: committedAcross(
        before,
        committedByInvoice(engine.ledger, wallet, { invoiceId }),
      ),
    };
    // assess makes this check too. Made again here for an invoice paid since.
    paid = paidDuplicate(engine.ledger, obligation);
    const decision: Decision = secondBill(decide(incident), paid);
    if (decision.action !== "replace") {
      return decision;
    }
    // No replacement is sent by itself on a rail with an outage. Read under the
    // write lock, so a declaration cannot land between this and the attempt.
    // Opening the attempt takes the duplicate lock, so this throws if the invoice
    // already has a live payment.
    return (
      engine.ledger.activeOutage(obligation.currency, obligation.transferMethod) ??
      engine.ledger.openAttempt(invoiceId, "replacement", lease, null, accountKey, route)
    );
  });
  if (next === null) {
    return Date.now();
  }
  if ("declaredAt" in next) {
    return escalateForOutage(engine, obligation, { ...assessment, incident, paidDuplicate: paid }, next);
  }
  if ("action" in next) {
    note(engine.ledger, invoiceId, "decision", `Escalate: ${next.reason}${arrivalClause(assessment)}`, "decision");
    // The first request names the floor as well, as every later one does.
    return escalate(
      engine,
      obligation,
      withFloorReason(engine, obligation, { ...assessment, incident, decision: next, paidDuplicate: paid }),
    );
  }
  const replacement: Transfer = await send(engine, obligation, next);
  return waitForBank(engine, invoiceId, "replacement", replacement);
}

// A replacement the policy would send by itself, on a rail with an outage, goes
// to a person. The approval request is built from the replace decision, so its
// terms, and its binding, say nothing of the outage. If the outage ended in the
// moment since it was read, the next look, at once, replaces as usual.
function escalateForOutage(
  engine: Engine,
  obligation: Obligation,
  assessment: Assessment,
  outage: Outage,
): NextLook {
  const invoiceId: string = obligation.invoiceId;
  if (engine.ledger.outage(outage.id)?.state !== "active") {
    return Date.now();
  }
  note(engine.ledger, invoiceId, "decision", `Escalate: ${OUTAGE_REASON}${arrivalClause(assessment)}`, "decision");
  if (!engine.ledger.holdForOutage(outage.id, { invoiceId }, "replacement", holdLine(outage, "replacement"))) {
    return Date.now();
  }
  return escalate(engine, obligation, assessment, OUTAGE_REASON);
}

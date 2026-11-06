import {
  bindingOf,
  changedFields,
  keyHash,
  paidWith,
  paymentAmount,
  type ApprovalTerms,
  type FxTerms,
} from "../domain/approval.js";
import {
  eligibleApprovers,
  knownName,
  signoffProblem,
  signoffsNeeded,
  type Approver,
  type Barred,
  type SignoffRule,
} from "../domain/approvers.js";
import { knownRoute, routeOfDetailsKey } from "../domain/assess.js";
import { formatMoney, invoiceMoney } from "../domain/money.js";
import {
  expiryOf,
  isExpired,
  signersOf,
  type Approval,
  type Ledger,
  type Obligation,
  type Signoff,
} from "../store/ledger.js";
import type { Engine, NextLook, Rate } from "./engine.js";
import { note } from "./lines.js";
import { quoteLine, requestExpiry } from "./rates.js";
import { countedFromToday } from "./terms.js";

// The people who may not approve a payment of this invoice to the account with
// this accountKey, and why: whoever started the incident, and everyone who
// recorded a callback verifying that account. A name stored before names were
// checked that does not follow the name rule bars nobody (knownName): such a
// starter counts as not known, so signoffsNeeded asks for two approvers, and a
// payment to a callback-verified account needs two already.
export function barredFrom(
  ledger: Ledger,
  obligation: Obligation,
  accountKey: string | undefined,
  routeKey: string | null = null,
): Barred[] {
  const barred: Barred[] = [];
  const starter: string | null = knownName(obligation.startedBy);
  if (starter !== null) {
    barred.push({
      name: starter,
      why: obligation.runRowId === null ? "started this incident" : "uploaded the pay run it came from",
    });
  }
  // The routeKey of the account, given or as the ledger keeps it with a request,
  // so a callback for the same account bars its recorder even when a bank name
  // changed since. When the account's route, or the callback's, is not known, the
  // recorder is barred: the bar never depends on a key PayOnce cannot check.
  const route: string | null = knownRoute(
    routeKey ?? (accountKey === undefined ? undefined : ledger.accountRoutes().get(accountKey)),
  );
  for (const detailsKey of ledger.appliedKeys(obligation.beneficiaryId)) {
    const applied: string | null = routeOfDetailsKey(detailsKey);
    if (
      accountKey === undefined ||
      (keyHash(detailsKey) !== accountKey && route !== null && applied !== null && applied !== route)
    ) {
      continue;
    }
    for (const stored of ledger.bankChangeRecorders(obligation.beneficiaryId, detailsKey)) {
      const name: string | null = knownName(stored);
      if (name !== null) {
        barred.push({ name, why: "recorded the callback for the new bank details" });
      }
    }
  }
  return barred;
}

export function ruleFor(
  engine: Engine,
  obligation: Obligation,
  terms: ApprovalTerms,
  newAccount: boolean,
): SignoffRule {
  return signoffsNeeded(engine.approvals, paymentAmount(terms), newAccount, obligation.startedBy);
}

// Why an approval no longer covers the payment under the approval policy as it
// is now, or null when it still does.
function approvalProblem(
  engine: Engine,
  obligation: Obligation,
  rule: SignoffRule,
  approval: Approval,
): string | null {
  const approved: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
  return signoffProblem(
    engine.approvals,
    rule,
    approval,
    paymentAmount(approved),
    barredFrom(engine.ledger, obligation, approved.accountKey),
  );
}

// Voids an approval that no longer covers the payment, and says why: it expired
// before it was used, the terms changed, or the approval policy as it is now
// refuses it. True when it was voided.
export function voidIfStale(
  engine: Engine,
  obligation: Obligation,
  approval: Approval,
  current: ApprovalTerms,
  rule: SignoffRule,
): boolean {
  let why: string | null = null;
  if (isExpired(approval)) {
    why = "expired before it was used";
  } else if (bindingOf(current) !== approval.binding) {
    const approved: ApprovalTerms = JSON.parse(approval.terms) as ApprovalTerms;
    why = `is void: ${changedFields(approved, current).join(", ")} changed`;
  } else {
    const problem: string | null = approvalProblem(engine, obligation, rule, approval);
    why = problem === null ? null : `is void: ${problem}`;
  }
  if (why === null) {
    return false;
  }
  engine.ledger.setApprovalState(approval.id, "void");
  note(engine.ledger, obligation.invoiceId, "approval", `Approval by ${approval.approver} ${why}`);
  return true;
}

// Asks the approvers to approve a payment under the approval policy, and says
// what the invoice is waiting on. A request still open for the same terms is kept.
// Returns when the request expires, so the look then can open a new one. rate is
// the quote a payment from another currency's wallet is offered at, and a new
// request opens only on a quote this look took for it.
export function awaitApproval(
  engine: Engine,
  obligation: Obligation,
  given: ApprovalTerms,
  rule: SignoffRule,
  rate: Rate | null,
  routeKey: string,
): NextLook {
  const invoiceId: string = obligation.invoiceId;
  let terms: ApprovalTerms = given;
  let binding: string = bindingOf(terms);

  // A request nobody on the list could approve would only expire and be opened
  // again, so none is opened until the approver list changes.
  const eligible: Approver[] = eligibleApprovers(
    engine.approvals,
    paymentAmount(terms),
    barredFrom(engine.ledger, obligation, terms.accountKey, routeKey),
  );
  if (engine.approvals.problem !== null || eligible.length < rule.needed) {
    if (engine.ledger.voidOpenApprovals(invoiceId)) {
      note(
        engine.ledger,
        invoiceId,
        "approval",
        "Approval request withdrawn: nobody on the approver list can approve it",
      );
    }
    const able: string =
      eligible.length === 0
        ? "nobody on the approver list can"
        : `only ${eligible.map((approver: Approver): string => approver.name).join(" and ")} can`;
    // No request opens, so no rate is named: only about what the payment takes
    // from its wallet, which the limits are compared with.
    const fx: string =
      terms.fx === undefined
        ? ""
        : `, about ${formatMoney(terms.fx.sellAmountMinor, terms.fx.sellCurrency)},`;
    const payment: string =
      terms.action === "replace"
        ? `A replacement of ${invoiceMoney(obligation)}${fx}`
        : `Paying ${invoiceMoney(obligation)} for this invoice${fx}`;
    note(
      engine.ledger,
      invoiceId,
      "approval",
      engine.approvals.problem !== null
        ? `Waiting on a person. Approvals are refused: ${engine.approvals.problem}`
        : `Waiting on a person. ${payment} needs ${rule.needed === 1 ? "one approver" : `${rule.needed} approvers, because ${rule.why},`} and ${able} approve it. Change APPROVERS, restart and check again`,
      "waiting",
    );
    return null;
  }

  let latest: Approval | undefined = engine.ledger.latestApproval(invoiceId);
  let sameRequest: boolean =
    latest?.state === "requested" && latest.binding === binding && latest.needed >= rule.needed;
  let opening: boolean = !sameRequest || latest === undefined || isExpired(latest);
  // Terms built on an open request's quote that now need a new request: that one
  // is withdrawn, and the next look, at once, takes a fresh quote for its own.
  if (opening && terms.fx !== undefined && rate?.fresh !== true) {
    const signed: Signoff[] = latest?.state === "requested" ? latest.signoffs : [];
    if (engine.ledger.voidOpenApprovals(invoiceId)) {
      note(
        engine.ledger,
        invoiceId,
        "approval",
        signed.length > 0
          ? `Approval by ${signersOf(signed)} no longer counts: the terms changed, so PayOnce takes a new exchange rate quote and opens a new request`
          : "Approval request withdrawn: the terms changed, so PayOnce takes a new exchange rate quote and opens a new request",
      );
    }
    return Date.now();
  }
  if (opening) {
    terms = countedFromToday(terms);
    binding = bindingOf(terms);
    // Another process may have opened today's request on these terms after the
    // look read the day an open request kept, so it is compared again.
    sameRequest =
      latest?.state === "requested" && latest.binding === binding && latest.needed >= rule.needed;
    opening = !sameRequest || latest === undefined || isExpired(latest);
  }
  const previous: FxTerms | undefined =
    latest === undefined ? undefined : (JSON.parse(latest.terms) as ApprovalTerms).fx;
  // A partly signed request that expired is reported as expired, even when the
  // terms have changed since. So is a request on a quote, which is replaced on a
  // fresh quote once it expires, so its terms differ even when nothing else
  // changed, and one with an arrival estimate, which may count from a new day.
  const expiredRequest: boolean =
    latest?.state === "requested" &&
    isExpired(latest) &&
    (sameRequest ||
      latest.signoffs.length > 0 ||
      terms.fx !== undefined ||
      terms.arrival !== undefined);
  if (expiredRequest && latest !== undefined) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      `Approval request expired before ${latest.signoffs.length === 0 ? "anyone approved it" : "enough people approved it"}, so PayOnce opened a new one`,
    );
  } else if (!sameRequest && latest?.state === "requested" && latest.signoffs.length > 0) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      `Approval by ${signersOf(latest.signoffs)} no longer counts: the terms changed, so PayOnce opened a new request`,
    );
  }
  if (opening) {
    const opened: boolean = engine.ledger.requestApproval(invoiceId, {
      binding,
      terms: JSON.stringify(terms),
      needed: rule.needed,
      neededWhy: rule.why,
      expiresAt: requestExpiry(engine, terms.fx === undefined ? null : rate, Date.now()),
      routeKey,
    });
    // Another process closed the invoice meanwhile.
    if (!opened) {
      return null;
    }
    // Written only for a quote a request opens on, so the timeline names no rate
    // nothing could be paid at.
    if (terms.fx !== undefined) {
      note(engine.ledger, invoiceId, "payment", quoteLine(obligation, terms.fx, previous));
    }
    latest = engine.ledger.latestApproval(invoiceId);
  }
  if (latest === undefined) {
    return null;
  }
  // A held invoice can be closed without paying instead.
  const payment: string = `${invoiceMoney(obligation)} to ${terms.payTo} (the account on file)${paidWith(terms.fx)}`;
  note(
    engine.ledger,
    invoiceId,
    "approval",
    terms.action === "replace"
      ? latest.needed === 1
        ? `Waiting on a person to approve ${payment}`
        : `Waiting on ${latest.needed} approvers for ${payment}, because ${latest.neededWhy}`
      : latest.needed === 1
        ? `Waiting on a person to approve paying ${payment}, or to close the invoice without paying`
        : `Waiting on ${latest.needed} approvers to pay ${payment}, because ${latest.neededWhy}, or on a person to close the invoice without paying`,
    "waiting",
  );
  return expiryOf(latest);
}

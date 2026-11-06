import {
  bindingOf,
  changedFields,
  paidWith,
  paymentAmount,
  type ApprovalTerms,
  type FxTerms,
} from "../domain/approval.js";
import {
  eligibleApprovers,
  signoffProblem,
  signoffsNeeded,
  type Approver,
  type SignoffRule,
} from "../domain/approvers.js";
import { expiryOf, isExpired } from "../domain/live.js";
import { formatMoney, invoiceMoney } from "../domain/money.js";
import { signersOf, type Approval, type Obligation, type Signoff } from "../store/ledger.js";
import { barredOnFile } from "../store/read/reviews.js";
import { requestTerms } from "../store/stored.js";
import type { Engine, NextLook, Rate } from "./engine.js";
import { note } from "./lines.js";
import { quoteLine, requestExpiry } from "./rates.js";
import { countedFromToday } from "./terms.js";

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
  const approved: ApprovalTerms = requestTerms(approval);
  return signoffProblem(
    engine.approvals,
    rule,
    approval,
    paymentAmount(approved),
    barredOnFile(engine.ledger, obligation, approved.accountKey),
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
    const approved: ApprovalTerms = requestTerms(approval);
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

/// Asks the approvers to approve a payment under the approval policy, and says
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
  // A request nobody on the list could approve would only expire and be opened
  // again, so none is opened until the approver list changes.
  const eligible: Approver[] = eligibleApprovers(
    engine.approvals,
    paymentAmount(given),
    barredOnFile(engine.ledger, obligation, given.accountKey, routeKey),
  );
  if (engine.approvals.problem !== null || eligible.length < rule.needed) {
    return waitForApproverList(engine, obligation, given, rule, eligible);
  }
  let latest: Approval | undefined = engine.ledger.latestApproval(invoiceId);
  let terms: ApprovalTerms = given;
  let request: RequestMatch = requestMatch(latest, bindingOf(terms), rule);
  // Terms built on an open request's quote that now need a new request: that one
  // is withdrawn, and the next look, at once, takes a fresh quote for its own.
  if (request.opening && terms.fx !== undefined && rate?.fresh !== true) {
    return withdrawForNewQuote(engine, invoiceId, latest);
  }
  if (request.opening) {
    terms = countedFromToday(terms);
    // Another process may have opened today's request on these terms after the
    // look read the day an open request kept, so it is compared again.
    request = requestMatch(latest, bindingOf(terms), rule);
  }
  // The last request's quote, named on the timeline only when a request opens on
  // a quote, so its terms are read only then.
  const previous: FxTerms | undefined =
    latest !== undefined && request.opening && terms.fx !== undefined ? requestTerms(latest).fx : undefined;
  noteReplacedRequest(engine, invoiceId, latest, terms, request);
  if (request.opening) {
    // Another process closed the invoice meanwhile.
    if (!openRequest(engine, obligation, terms, request, rule, rate, routeKey, previous)) {
      return null;
    }
    latest = engine.ledger.latestApproval(invoiceId);
  }
  return latest === undefined ? null : waitOnRequest(engine, obligation, terms, latest);
}

// The latest request held against the terms a look builds: whether it is still
// requested on them (binding) for at least the approvers the rule needs (same),
// and whether a new request opens (opening): when it is not, or it has expired.
interface RequestMatch {
  binding: string;
  same: boolean;
  opening: boolean;
}

function requestMatch(latest: Approval | undefined, binding: string, rule: SignoffRule): RequestMatch {
  const same: boolean =
    latest?.state === "requested" && latest.binding === binding && latest.needed >= rule.needed;
  return { binding, same, opening: !same || latest === undefined || isExpired(latest) };
}

// No request opens while too few people on the approver list could approve it,
// or approvals are refused, and any open one is withdrawn. The invoice waits for
// the list to change.
function waitForApproverList(
  engine: Engine,
  obligation: Obligation,
  terms: ApprovalTerms,
  rule: SignoffRule,
  eligible: Approver[],
): NextLook {
  const invoiceId: string = obligation.invoiceId;
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

// Withdraws a request on a quote whose terms need a new request, so the next
// look, at once, takes a fresh quote and opens one on it.
function withdrawForNewQuote(engine: Engine, invoiceId: string, latest: Approval | undefined): NextLook {
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

// Says what became of the latest request when a new one replaces it. A partly
// signed request that expired is reported as expired, even when the terms have
// changed since. So is a request on a quote, which is replaced on a fresh quote
// once it expires, so its terms differ even when nothing else changed, and one
// with an arrival estimate, which may count from a new day.
function noteReplacedRequest(
  engine: Engine,
  invoiceId: string,
  latest: Approval | undefined,
  terms: ApprovalTerms,
  request: RequestMatch,
): void {
  const expiredRequest: boolean =
    latest?.state === "requested" &&
    isExpired(latest) &&
    (request.same ||
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
  } else if (!request.same && latest?.state === "requested" && latest.signoffs.length > 0) {
    note(
      engine.ledger,
      invoiceId,
      "approval",
      `Approval by ${signersOf(latest.signoffs)} no longer counts: the terms changed, so PayOnce opened a new request`,
    );
  }
}

// Opens a request on the terms. False when the ledger refuses it, because
// another process closed the invoice. previous is the last request's quote.
function openRequest(
  engine: Engine,
  obligation: Obligation,
  terms: ApprovalTerms,
  request: RequestMatch,
  rule: SignoffRule,
  rate: Rate | null,
  routeKey: string,
  previous: FxTerms | undefined,
): boolean {
  const opened: boolean = engine.ledger.requestApproval(obligation.invoiceId, {
    binding: request.binding,
    terms: JSON.stringify(terms),
    needed: rule.needed,
    neededWhy: rule.why,
    expiresAt: requestExpiry(engine, terms.fx === undefined ? null : rate, Date.now()),
    routeKey,
  });
  if (!opened) {
    return false;
  }
  // Written only for a quote a request opens on, so the timeline names no rate
  // nothing could be paid at.
  if (terms.fx !== undefined) {
    note(engine.ledger, obligation.invoiceId, "payment", quoteLine(obligation, terms.fx, previous));
  }
  return true;
}

// Says who the open request waits on, and looks again when it expires. A held
// invoice can be closed without paying instead.
function waitOnRequest(engine: Engine, obligation: Obligation, terms: ApprovalTerms, latest: Approval): NextLook {
  const payment: string = `${invoiceMoney(obligation)} to ${terms.payTo} (the account on file)${paidWith(terms.fx)}`;
  note(
    engine.ledger,
    obligation.invoiceId,
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

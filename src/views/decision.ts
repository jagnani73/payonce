import { railWords, STATUS_PATTERN } from "../domain/patterns.js";
import { currencyFloor, debitCurrency, type CurrencyFloor } from "../domain/reserve.js";
import { payoutNamesOnly, unrecognisedPaid, unrecognisedUncleared } from "../domain/live.js";
import { aboutBankDetails, closeKindOf, type CloseKind, type InvoiceSnapshot, type Situation } from "../domain/situation.js";
import { sendsText, type OutageSend } from "../outages/outages.js";
import type { Outbox } from "../outbox/drafts.js";
import type { Settings } from "../settings.js";
import { payoutVerdict, type Attempt, type Obligation, type OutsidePayout } from "../store/ledger.js";
import { WAITING_KINDS, type CashLine, type CashReport, type CurrencyCash } from "../store/read/cash.js";
import { namingText, type NamingPayout } from "../store/read/reviews.js";
import { shownReference } from "../text/printable.js";
import type {
  Caution,
  CoveredTransferView,
  DecisionOption,
  DecisionPanel,
  HeadroomLine,
  NamingPayoutView,
  RequestView,
} from "./contract.js";
import { allowed, listOf, money, onceSignedOff, refused } from "./parts.js";

// The Decision panel: the request, the cautions, and every option that fits the
// payment now, each with what confirming it does and why it cannot be chosen
// when it cannot. The situation's can says what is allowed; this only words it.

export function coveredOf(snapshot: InvoiceSnapshot): CoveredTransferView[] {
  return snapshot.attempts.filter(unrecognisedUncleared).map(
    (attempt: Attempt): CoveredTransferView => ({
      transferId: attempt.mismatchedTransferId ?? "",
      reference: shownReference(attempt.mismatchedReference ?? attempt.mismatchedTransferId ?? ""),
      status: attempt.mismatchedStatus !== null && STATUS_PATTERN.test(attempt.mismatchedStatus) ? attempt.mismatchedStatus : null,
      kind: attempt.kind,
    }),
  );
}

function namesOnlyOf(snapshot: InvoiceSnapshot): NamingPayoutView[] {
  return snapshot.payouts.filter(payoutNamesOnly).map((payout: OutsidePayout): NamingPayoutView => {
    const naming: NamingPayout = {
      reference: payout.reference,
      amountMinor: payout.deliveredMinor ?? null,
      currency: payout.deliveredCurrency ?? null,
      ending: payout.sentEnding ?? null,
      checked: payoutVerdict(snapshot.obligation, payout, null) !== null,
    };
    return {
      reference: shownReference(naming.reference),
      delivered: naming.amountMinor === null || naming.currency === null ? null : money(naming.amountMinor, naming.currency),
      ending: naming.ending,
      checked: naming.checked,
      text: namingText(naming),
    };
  });
}

function paidReference(snapshot: InvoiceSnapshot, kind: CloseKind | undefined): string | null {
  if (kind === "outside") {
    return snapshot.payouts.find((payout: OutsidePayout): boolean => payout.state === "paid" && payout.pays === true)?.reference ?? null;
  }
  if (kind === "mismatched") {
    return snapshot.attempts.find(unrecognisedPaid)?.mismatchedReference ?? null;
  }
  return snapshot.attempts.find((attempt: Attempt): boolean => attempt.state === "paid")?.reference ?? null;
}

// The wallet's headroom now and after the request is approved, from the cash
// panel as the server last read it.
export function headroomOf(snapshot: InvoiceSnapshot, settings: Settings, cash: CashReport | null): HeadroomLine | null {
  const wallet: string = debitCurrency(snapshot.obligation);
  const floor: CurrencyFloor = currencyFloor(settings.reserve, wallet);
  const found: CurrencyCash | undefined = cash?.currencies.find((entry: CurrencyCash): boolean => entry.currency === wallet);
  if (cash === null) {
    return null;
  }
  const waiting: number = (found?.lines ?? [])
    .filter((line: CashLine): boolean => line.invoiceId === snapshot.obligation.invoiceId && WAITING_KINDS.has(line.kind))
    .reduce((sum: number, line: CashLine): number => sum + line.amountMinor + line.feeMinor, 0);
  const now: number | null = found?.headroomMinor ?? null;
  return {
    wallet,
    now: now === null ? null : money(now, wallet),
    after: now === null ? null : money(now - waiting, wallet, waiting > 0),
    floor: floor.minor === null ? null : money(floor.minor, wallet),
    floorSource: floor.source,
  };
}

interface DecisionInput {
  snapshot: InvoiceSnapshot;
  situation: Situation;
  request: RequestView | null;
  cautions: Caution[];
  outbox: Outbox;
  sends: OutageSend[];
  headroom: HeadroomLine | null;
}

// A person's close, as person.ts writes its line: closed as paid, or closed
// without paying, as a second bill or not. The ledger keeps who closed an
// invoice without paying first, but no note, so the line is read for both.
const PERSON_CLOSE: RegExp[] = [
  /^Incident closed by ([^:]+?): ([\s\S]*)$/,
  /^Closed without paying by ([^,:]+?)(?:, as a second bill for [^:]+)?: ([\s\S]*)$/,
];

function closedPanel(input: DecisionInput): DecisionPanel["closed"] {
  const o: Obligation = input.snapshot.obligation;
  const line: string = input.snapshot.times.closedLine ?? "";
  const by: RegExpExecArray | null =
    PERSON_CLOSE.map((pattern: RegExp): RegExpExecArray | null => pattern.exec(line)).find(
      (found: RegExpExecArray | null): boolean => found !== null,
    ) ?? null;
  return {
    kind: o.state === "settled" ? "paid" : "unpaid",
    by: by?.[1] ?? o.rejectedBy,
    at: input.snapshot.times.closedAt,
    note: by?.[2] ?? null,
  };
}

function options(input: DecisionInput): DecisionOption[] {
  const snapshot: InvoiceSnapshot = input.snapshot;
  const situation: Situation = input.situation;
  const request: RequestView | null = input.request;
  const o: Obligation = snapshot.obligation;
  const kind: CloseKind | undefined = closeKindOf(snapshot);
  const found: DecisionOption[] = [];
  const state: string = situation.state;
  if (request !== null && request.state === "waiting") {
    const signed: number = request.signoffs.length;
    const floorClause: boolean = request.terms.reason.clauses.some((clause: { code: string }): boolean => clause.code === "below-floor");
    found.push({
      kind: "approve",
      title: request.terms.title,
      consequence: [
        `${onceSignedOff(signed, request.needed)}, PayOnce sends ${request.terms.pay.text} to ${request.terms.account.label} at its next check.`,
        ...(floorClause ? ["The terms say this takes cash below the reserve floor."] : []),
        ...(snapshot.outage === null ? [] : [`Outage ${snapshot.outage.outage.id} is active, so the payment waits until someone ends it.`]),
      ],
      can: situation.can.approve,
      suggested: state === "needs-approval",
      requestId: request.id,
      approvers: request.approvers,
    });
  }
  if (o.state === "escalated" && (aboutBankDetails(snapshot) || state === "needs-callback" || state === "needs-phone")) {
    const open: boolean = request !== null && (request.state === "waiting" || request.state === "approved");
    found.push({
      kind: "callback",
      title: "Record a callback",
      consequence: [
        `PayOnce updates the supplier record in Airwallex to the details you confirm${open && request !== null ? `, withdraws request #${request.id}` : ""}, and opens a new request that needs two approvers. You cannot approve it.`,
      ],
      can: situation.can.recordCallback,
      suggested: state === "needs-callback",
      phoneEnding: (o.supplierPhone ?? "").replace(/[^0-9]/g, "").slice(-4) || null,
      formPath: `/api/incidents/${encodeURIComponent(o.invoiceId)}/bank-details`,
    });
  }
  if (situation.can.closeAsPaid.allowed) {
    const paidBy: string | null = paidReference(snapshot, kind);
    const covers: CoveredTransferView[] = coveredOf(snapshot);
    found.push({
      kind: "close-paid",
      title: "Close as paid",
      consequence: [
        `Records that ${paidBy ?? "the payment on file"} paid this and closes it. Nothing is sent.`,
        ...covers.map((covered: CoveredTransferView): string => `Covers unrecognised transfer ${covered.reference}.`),
      ],
      can: situation.can.closeAsPaid,
      suggested: state === "ready-to-close",
      paidBy,
      covers,
      namesOnly: namesOnlyOf(snapshot),
    });
  }
  if (o.state === "escalated" && !situation.can.closeAsPaid.allowed) {
    const open: boolean = request !== null && (request.state === "waiting" || request.state === "approved");
    const approvedBy: string[] = open ? (request?.signoffs.map((signoff: { name: string }): string => signoff.name) ?? []) : [];
    const secondBillOf: string[] = kind === "duplicate" ? o.duplicateOf : [];
    found.push({
      kind: "close-unpaid",
      title: "Close without paying",
      consequence: [
        "Ends this payment. Nothing is sent.",
        ...(open && request !== null
          ? [`Withdraws request #${request.id}${approvedBy.length === 0 ? "" : ` (approved by ${listOf(approvedBy)})`}.`]
          : []),
        ...(secondBillOf.length === 0 ? [] : [`Notes on ${listOf(secondBillOf)} that this was a second bill.`]),
      ],
      can: situation.can.closeUnpaid,
      suggested: ["needs-decision", "no-approvers", "needs-phone"].includes(state),
      covers: coveredOf(snapshot),
      secondBillOf,
      withdraws: open && request !== null ? { requestId: request.id, approvedBy } : null,
    });
  }
  if (snapshot.outage !== null && state === "paused-by-outage") {
    found.push({
      kind: "end-outage",
      title: `End outage ${snapshot.outage.outage.id} on ${railWords(snapshot.outage.outage.currency, snapshot.outage.outage.method)}`,
      consequence: [`Ending it sends ${sendsText(input.sends)}.`],
      can: situation.can.endOutage,
      suggested: true,
      outageId: snapshot.outage.outage.id,
      rail: railWords(snapshot.outage.outage.currency, snapshot.outage.outage.method),
      enders: snapshot.outage.enders,
      sends: input.sends.map((send: OutageSend) => ({ payments: send.payments, total: money(send.minor, send.currency, send.estimated) })),
    });
  }
  if (state === "bank-late") {
    const offered: boolean = input.outbox.offers.some((offer: { template: string }): boolean => offer.template === "bank-trace");
    found.push({
      kind: "trace",
      title: "Draft a trace request to Airwallex",
      consequence: ["Drafts a trace request to Airwallex for you to send. PayOnce sends nothing."],
      can: !situation.can.draftTrace.allowed
        ? situation.can.draftTrace
        : offered
          ? allowed()
          : refused("drafted", "A trace request is already drafted or sent for this transfer. It is on the Messages tab."),
      suggested: true,
      template: "bank-trace",
    });
  }
  // The one that fits goes first; the rest keep their order.
  return [...found.filter((option: DecisionOption): boolean => option.suggested), ...found.filter((option: DecisionOption): boolean => !option.suggested)];
}

export function decisionPanel(input: DecisionInput): DecisionPanel {
  const closed: boolean = input.snapshot.obligation.state === "settled" || input.snapshot.obligation.state === "rejected";
  return {
    open: closed
      ? null
      : { request: input.request, cautions: input.cautions, options: options(input), headroom: input.headroom },
    closed: closed ? closedPanel(input) : null,
    checkNow: input.situation.can.checkNow,
  };
}

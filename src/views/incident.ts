import type { FxTerms } from "../domain/approval.js";
import { today } from "../domain/arrival.js";
import { failedStatus } from "../domain/assess.js";
import { deadlineAt, inFlight, keptFailedLive, pastDeadline, watching } from "../domain/live.js";
import { debitCurrency } from "../domain/reserve.js";
import {
  incidentOf,
  situationOf,
  type InvoiceSnapshot,
  type RequestSnapshot,
  type Situation,
} from "../domain/situation.js";
import { attemptLostFee, type CashReport } from "../engine/cash-position.js";
import { noteTexts } from "../intake/eml.js";
import type { DraftMove } from "../store/ledger.js";
import { MOVES_FROM, outboxOf, type DraftOffer, type DraftView as StoredDraftView, type NotOffered, type Outbox } from "../outbox/drafts.js";
import type { OutageSend } from "../outages/outages.js";
import { unverifiedSenders, type SupplierEmail } from "../reader/emails.js";
import type { Settings } from "../settings.js";
import {
  crossCurrency,
  readingSoft,
  storedObject,
  type Attempt,
  type Ledger,
  type Obligation,
  type OutsidePayout,
  type Upload,
} from "../store/ledger.js";
import { shownReference } from "../text/printable.js";
import { boardEntriesFor, outageHolding, type BoardEntry, type BoardMoney } from "./incident-board.js";
import { invoiceIndex, type InvoiceIndex } from "../intake/intake.js";
import { supplierDetail, type AccountView as SupplierAccount, type Caution as SupplierCaution, type SupplierDetail } from "./suppliers.js";
import type {
  Can,
  Caution,
  DraftOfferView,
  DraftView,
  EmailsTab,
  EmailView,
  HeadroomLine,
  IncidentView,
  MessagesTab,
  Money,
  PaymentFacts,
  RequestView,
  SupplierBrief,
  TransferState,
  TransferView,
  Tone,
} from "./contract.js";
import { cautionsOf } from "./cautions.js";
import { incidentPhone } from "./contacts.js";
import { isBusy, snapshotOptions, supplierKeyOf, type Live } from "./context.js";
import { decisionPanel, headroomOf } from "./decision.js";
import {
  accountView,
  activityOf,
  allowed,
  arrivalView,
  failureView,
  fxView,
  invoiceAuditLine,
  iso,
  lastFour,
  money,
  plural,
  refused,
  timelineView,
} from "./parts.js";
import { duplicateIds, duplicateView, requestView, situationsOf } from "./requests.js";
import { originOf } from "./rows.js";
import { readInvoiceSnapshot, readInvoiceSnapshots } from "./snapshot.js";
import { summaryOf } from "./summary.js";

// One payment as its page shows it: the facts, the situation, what happened, the
// Decision panel, every transfer, the emails, the messages, the timeline and the
// audit line, the supplier and the money.

function utc(at: number | null): string {
  return at === null ? "" : `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

const TONES: Record<TransferState, Tone> = {
  "being-sent": "progress",
  "with-bank": "progress",
  paid: "done",
  failed: "blocked",
  refused: "blocked",
  "never-sent": "blocked",
  "unknown-status": "act",
};

function transferState(attempt: Attempt): TransferState {
  if (attempt.state === "paid") {
    return "paid";
  }
  if (attempt.transferId === null) {
    return attempt.state === "pending" ? "being-sent" : attempt.failureCode === null ? "never-sent" : "refused";
  }
  if (attempt.state === "failed" && !keptFailedLive(attempt)) {
    return "failed";
  }
  return "with-bank";
}

function stateLabel(state: TransferState, attempt: { failureCode: string | null }, due: number | null): string {
  switch (state) {
    case "paid":
      return "Paid";
    case "failed": {
      const words: string = failureView(attempt.failureCode)?.words ?? "no failure code";
      return `Failed: ${words}`;
    }
    case "refused":
      return `Refused by Airwallex (${failureView(attempt.failureCode)?.code ?? "no code"})`;
    case "never-sent":
      return "Never sent";
    case "being-sent":
      return "Being sent";
    case "with-bank":
      return due === null ? "With the bank" : `With the bank, due ${utc(due)}`;
    case "unknown-status":
      return "In a status PayOnce does not know";
  }
}

function ownTransfer(snapshot: InvoiceSnapshot, attempt: Attempt, now: number): TransferView {
  const state: TransferState = transferState(attempt);
  const due: number | null = deadlineAt(attempt, snapshot.deadlineMinutes);
  const request: RequestSnapshot | undefined = snapshot.requests.find(
    (item: RequestSnapshot): boolean => item.approval.id === attempt.approvalId,
  );
  const fx: FxTerms | undefined = request?.terms?.fx;
  const payTo: string | null = request?.terms?.payTo ?? null;
  return {
    kind: attempt.kind,
    reference: attempt.reference === null ? null : shownReference(attempt.reference),
    state,
    stateLabel: stateLabel(state, attempt, due),
    tone: TONES[state],
    failure: failureView(attempt.failureCode),
    took: attempt.amountMinor === null || attempt.currency === null ? null : money(attempt.amountMinor, attempt.currency),
    fee: attempt.feeMinor === null || attempt.feeCurrency === null ? null : money(attempt.feeMinor, attempt.feeCurrency),
    sentAt: attempt.bankCreatedAt,
    deadlineAt: iso(due),
    pastDeadline: inFlight(attempt) && pastDeadline(attempt, snapshot.deadlineMinutes, snapshot.reason, now),
    account:
      attempt.transferId === null
        ? null
        : {
            ...(accountView(payTo) ?? { label: "an account PayOnce did not keep", ending: null }),
            check: attempt.misdirected ? "misdirected" : attempt.accountKey === null ? "not-kept" : "matches",
          },
    onRequest:
      request === undefined
        ? null
        : { id: request.approval.id, approvedBy: request.approval.signoffs.map((signoff: { approver: string }): string => signoff.approver) },
    fx: fx === undefined || fx.quoteId !== attempt.quoteId ? null : fxView(fx),
    rateMismatch: attempt.rateMismatch !== null,
    foundLateAt: attempt.foundLateAt,
    pays: null,
    arrival: attempt.arrival === null ? null : arrivalView(attempt.arrival, false, now),
    details: { transferId: attempt.transferId, requestId: attempt.requestId, bankStatus: attempt.bankStatus, createdAt: attempt.bankCreatedAt },
  };
}

function unrecognisedTransfer(attempt: Attempt): TransferView {
  const status: string | null = attempt.mismatchedStatus;
  const state: TransferState = status === "PAID" ? "paid" : status !== null && failedStatus(status) ? "failed" : "with-bank";
  return {
    kind: "unrecognised",
    reference: attempt.mismatchedReference === null ? null : shownReference(attempt.mismatchedReference),
    state,
    stateLabel: state === "failed" ? "Failed" : stateLabel(state, { failureCode: null }, null),
    tone: state === "with-bank" ? "urgent" : TONES[state],
    failure: null,
    took:
      attempt.mismatchedAmountMinor === null || attempt.mismatchedCurrency === null
        ? null
        : money(attempt.mismatchedAmountMinor, attempt.mismatchedCurrency),
    fee: null,
    sentAt: null,
    deadlineAt: null,
    pastDeadline: false,
    account: null,
    onRequest: null,
    fx: null,
    rateMismatch: false,
    foundLateAt: null,
    pays: null,
    arrival: null,
    details: { transferId: attempt.mismatchedTransferId, requestId: attempt.requestId, bankStatus: status, createdAt: null },
  };
}

const PAYOUT_STATES: Record<OutsidePayout["state"], TransferState> = {
  in_flight: "with-bank",
  paid: "paid",
  failed: "failed",
  unknown: "unknown-status",
};

function payoutTransfer(snapshot: InvoiceSnapshot, payout: OutsidePayout, index: number): TransferView {
  const state: TransferState = PAYOUT_STATES[payout.state];
  return {
    kind: "outside-payout",
    reference: shownReference(payout.reference),
    state,
    stateLabel: state === "failed" ? "Failed" : stateLabel(state, { failureCode: null }, null),
    tone: TONES[state],
    failure: null,
    took: payout.amountMinor === null || payout.currency === null ? null : money(payout.amountMinor, payout.currency),
    fee: payout.feeMinor === null || payout.feeCurrency === null ? null : money(payout.feeMinor, payout.feeCurrency),
    sentAt: snapshot.times.foundAt[index] ?? null,
    deadlineAt: null,
    pastDeadline: false,
    account: { ...(accountView(null, payout.sentEnding ?? null) ?? { label: "an account PayOnce did not read", ending: null }), check: "outside" },
    onRequest: null,
    fx: null,
    rateMismatch: false,
    foundLateAt: null,
    pays: payout.pays ?? null,
    arrival: null,
    details: { transferId: payout.transferId, requestId: null, bankStatus: payout.state, createdAt: null },
  };
}

// Original, replacement, unrecognised transfers and payouts sent outside
// PayOnce, newest first.
function transfersOf(snapshot: InvoiceSnapshot, now: number): TransferView[] {
  const own: TransferView[] = snapshot.attempts.flatMap((attempt: Attempt): TransferView[] =>
    attempt.mismatchedTransferId === null ? [ownTransfer(snapshot, attempt, now)] : [ownTransfer(snapshot, attempt, now), unrecognisedTransfer(attempt)],
  );
  const payouts: TransferView[] = snapshot.payouts.map((payout: OutsidePayout, index: number): TransferView => payoutTransfer(snapshot, payout, index));
  return [...own, ...payouts].reverse();
}

// ---------- emails and messages ----------

// What the findings JSON holds, as the engine stores it.
interface StoredFindings {
  summary?: string;
  claimsNonReceipt?: boolean;
  asksForNewBankDetails?: boolean;
  asksNotToPay?: boolean;
  readBy?: string;
  emailsRead?: number;
}

function storedFindingsOf(ledger: Ledger, invoiceId: string): StoredFindings | null {
  const stored: string | undefined = ledger.findings(invoiceId);
  return stored === undefined ? null : storedObject<StoredFindings>(stored);
}

function emailsTab(ledger: Ledger, snapshot: InvoiceSnapshot): EmailsTab {
  const o: Obligation = snapshot.obligation;
  const emails: SupplierEmail[] = ledger.emails(o.invoiceId);
  const flagged: string[] = o.supplierDomain === "" ? [] : unverifiedSenders(emails, o.supplierDomain);
  const stored: StoredFindings | null = storedFindingsOf(ledger, o.invoiceId);
  const unreadCount: number = Math.max(0, emails.length - (stored?.emailsRead ?? emails.length)) || (snapshot.emails.unread ? 1 : 0);
  return {
    count: emails.length,
    findings:
      stored === null
        ? null
        : {
            summary: stored.summary ?? "",
            claimsNonReceipt: stored.claimsNonReceipt === true,
            asksForNewBankDetails: stored.asksForNewBankDetails === true,
            asksNotToPay: stored.asksNotToPay === true,
            readBy: stored.readBy ?? null,
          },
    unread:
      snapshot.emails.count > 0 && snapshot.emails.unread
        ? { count: unreadCount, text: `${plural(unreadCount, "email has", "emails have")} not been read yet. PayOnce reads ${unreadCount === 1 ? "it" : "them"} at its next check.` }
        : null,
    senderWarnings: flagged.map((sender: string): string => `${sender} does not match ${o.supplierDomain}, the email domain on file`),
    emails: [...emails].reverse().map((email: SupplierEmail): EmailView => {
      const upload: Upload | undefined = email.uploadId === undefined ? undefined : ledger.upload(email.uploadId);
      return {
        from: email.from,
        fromName: email.fromName ?? null,
        replyTo: email.replyTo ?? [],
        subject: email.subject,
        body: email.body,
        styleText: email.styleText === undefined || email.styleText === "" ? null : email.styleText,
        attachments: email.attachments ?? [],
        notes: noteTexts(email.notes ?? []),
        partial: email.partial === true,
        senderMatches: !flagged.includes(email.from),
        uploadedBy: upload?.uploadedBy ?? null,
        uploadId: email.uploadId ?? null,
        dateAsWritten: upload === undefined || upload.dateAsWritten === "" ? null : upload.dateAsWritten,
        uploadedAt: upload?.uploadedAt ?? null,
      };
    }),
  };
}

const DRAFT_STATES: Record<DraftView["state"], string> = {
  draft: "Draft",
  copied: "Copied",
  sent: "Marked as sent",
  dismissed: "Dismissed",
};

function offerView(offer: DraftOffer): DraftOfferView {
  return { template: offer.template, label: offer.label, audience: offer.audience, suggested: offer.suggested, why: offer.why };
}

function messagesTab(outbox: Outbox): MessagesTab {
  return {
    drafts: outbox.drafts.map((draft: StoredDraftView): DraftView => {
      const move = (to: DraftMove): Can =>
        MOVES_FROM[to].includes(draft.state) ? allowed() : refused(draft.state, `The draft is ${DRAFT_STATES[draft.state].toLowerCase()}.`);
      return {
        id: draft.id,
        template: draft.template,
        label: draft.label,
        audience: draft.audience === "bank" ? "bank" : "supplier",
        subject: draft.subject,
        body: draft.body,
        state: draft.state,
        stateLabel: DRAFT_STATES[draft.state],
        createdBy: draft.createdBy,
        createdAt: draft.createdAt,
        copiedBy: draft.copiedBy,
        copiedAt: draft.copiedAt,
        sentBy: draft.sentBy,
        sentAt: draft.sentAt,
        dismissedBy: draft.dismissedBy,
        dismissedAt: draft.dismissedAt,
        dismissNote: draft.dismissNote,
        intact: draft.intact,
        changed: draft.changed,
        noLongerFits: draft.noLongerFits,
        can: { copy: move("copied"), markSent: move("sent"), dismiss: move("dismissed") },
      };
    }),
    offers: outbox.offers.map(offerView),
    withheld: outbox.withheld.map(offerView),
    notOffered: outbox.notOffered.map((item: NotOffered) => ({ label: item.label, why: item.why })),
  };
}

// ---------- the supplier and the money ----------

// The callback the latest request relies on, while it is open.
function requestCallback(snapshot: InvoiceSnapshot): number | null {
  const latest: RequestSnapshot | undefined = snapshot.requests.at(-1);
  const open: boolean = latest?.approval.state === "requested" || latest?.approval.state === "approved";
  return open ? (latest?.terms?.evidence.bankChange?.id ?? null) : null;
}

function supplierBrief(
  ledger: Ledger,
  snapshot: InvoiceSnapshot,
  detail: SupplierDetail | null,
  request: RequestView | null,
  now: number,
): SupplierBrief {
  const o: Obligation = snapshot.obligation;
  const cautions: SupplierCaution[] = (detail?.cautions ?? []).filter((caution: SupplierCaution): boolean => caution.level === "caution");
  const lastPaid: SupplierAccount | undefined =
    detail?.accounts.find((account: SupplierAccount): boolean => account.lastPaid) ??
    detail?.accounts.find((account: SupplierAccount): boolean => account.recordLastStored);
  return {
    key: supplierKeyOf(o.beneficiaryId),
    name: o.supplier,
    account: request !== null ? request.terms.account : accountView(null, lastPaid?.ending ?? null),
    phoneEnding: lastFour(o.supplierPhone),
    phone: incidentPhone(ledger, detail, requestCallback(snapshot), now),
    emailDomain: o.supplierDomain === "" ? null : o.supplierDomain,
    cautions: { count: cautions.length, top: cautions[0]?.text ?? null },
  };
}

function facts(snapshot: InvoiceSnapshot, now: number): PaymentFacts {
  const o: Obligation = snapshot.obligation;
  return {
    invoiceId: o.invoiceId,
    supplier: o.supplier,
    supplierKey: supplierKeyOf(o.beneficiaryId),
    amount: money(o.amountMinor, o.currency),
    wallet: debitCurrency(o),
    crossCurrency: crossCurrency(o),
    method: o.transferMethod,
    origin: originOf(snapshot),
    dueDate: o.dueDate,
    dueDatePassed: o.dueDate !== null && o.dueDate < today(new Date(now)),
    startedBy: o.startedBy,
    run: snapshot.run === null ? null : { id: snapshot.run.run.id, line: snapshot.run.row.line },
  };
}

function feesKept(snapshot: InvoiceSnapshot): Money[] {
  return snapshot.attempts
    .filter((attempt: Attempt): boolean => attemptLostFee(attempt) && attempt.feeMinor !== null && attempt.feeCurrency !== null)
    .map((attempt: Attempt): Money => money(attempt.feeMinor ?? 0, attempt.feeCurrency ?? ""));
}

// cash: the server's cash panel from its balance cache, for the headroom lines.
// Null where no balance has been read, as in the CLI and MCP.
export function incidentView(
  ledger: Ledger,
  settings: Settings,
  now: number,
  invoiceId: string,
  live: Live | null = null,
  cash: CashReport | null = null,
): IncidentView | null {
  return readingSoft((): IncidentView | null => {
    const snapshot: InvoiceSnapshot | undefined = readInvoiceSnapshot(ledger, invoiceId, snapshotOptions(settings, live), now);
    if (snapshot === undefined) {
      return null;
    }
    const o: Obligation = snapshot.obligation;
    const situation: Situation = situationOf(snapshot, now);
    const others: Map<string, Situation> = situationsOf(
      readInvoiceSnapshots(ledger, snapshotOptions(settings, live), now, duplicateIds(snapshot)),
      now,
    );
    const request: RequestView | null = requestView(snapshot, others, now);
    const cautions: Caution[] = cautionsOf(snapshot, situation, request);
    const outbox: Outbox = outboxOf(ledger, o, now);
    const sends: OutageSend[] = snapshot.outage === null ? [] : outageHolding(ledger, now)(snapshot.outage.outage).sends;
    const headroom: HeadroomLine | null = headroomOf(snapshot, settings, cash);
    const entry: BoardEntry | undefined = boardEntriesFor(ledger, [o], o.beneficiaryId, now, (): InvoiceIndex => invoiceIndex(ledger)).entries.find(
      (item: BoardEntry): boolean => item.kind === "invoice" && item.invoiceId === o.invoiceId,
    );
    const wallet: BoardMoney | undefined = entry?.atRisk.find((item: BoardMoney): boolean => item.currency === debitCurrency(o));
    const key: string | null = supplierKeyOf(o.beneficiaryId);
    return {
      view: "incident",
      generatedAt: new Date(now).toISOString(),
      payment: facts(snapshot, now),
      situation,
      incident: incidentOf(snapshot),
      summary: summaryOf(snapshot, situation, headroom),
      decision: decisionPanel({ snapshot, situation, request, cautions, outbox, sends, headroom }),
      transfers: transfersOf(snapshot, now),
      emails: emailsTab(ledger, snapshot),
      messages: messagesTab(outbox),
      timeline: timelineView(ledger.events(o.invoiceId)),
      audit: invoiceAuditLine(ledger, o.invoiceId, now),
      supplier: supplierBrief(ledger, snapshot, key === null ? null : supplierDetail(ledger, key, now), request, now),
      money: {
        amount: money(o.amountMinor, o.currency),
        fromWallet: wallet === undefined ? null : money(wallet.minor, wallet.currency, wallet.estimated || wallet.feeUnknown > 0),
        feesKept: feesKept(snapshot),
        headroom,
      },
      related: {
        secondBills: o.duplicateOf.map((id: string) => duplicateView(id, others.get(id) ?? null, null)),
        inbox: snapshot.inbox,
        outage: snapshot.outage === null ? null : { id: snapshot.outage.outage.id, rail: `${snapshot.outage.outage.currency} ${snapshot.outage.outage.method}` },
      },
      askWhy: situation.can.askWhy,
      activity: activityOf(isBusy(live, o.invoiceId), watching(snapshot.attempts, snapshot.payouts)),
    };
  });
}

import { crossCurrency, type Obligation } from "../store/ledger.js";
import { watching } from "../domain/live.js";
import {
  incidentOf,
  runSituationOf,
  situationOf,
  type InvoiceSnapshot,
  type PaymentState,
  type QueueGroup,
  type RunSnapshot,
  type RunSituation,
  type Situation,
} from "../domain/situation.js";
import { runCounts, type RunCounts } from "../runs/runs.js";
import type { BoardEntry, BoardMoney } from "./incident-board.js";
import type { IncidentRow, Money, Origin, RowActionKind, RowTag, RunRowItem } from "./contract.js";
import { boardMoney, isBusy, supplierKeyOf, type Live } from "./context.js";
import { activityOf, money } from "./parts.js";

// One payment or one pay run as a row in a list, with the one action that fits
// it now. Nothing irreversible happens from a row: its action opens the payment
// with that option chosen.

export const GROUP_ORDER: Record<QueueGroup, number> = { "needs-you": 0, "bank-late": 1, "with-bank": 2, payonce: 3, closed: 4 };

export const GROUP_LABELS: Record<QueueGroup, string> = {
  "needs-you": "Needs you",
  "bank-late": "Bank is late",
  "with-bank": "With the bank",
  payonce: "PayOnce is handling",
  closed: "Closed",
};

const PRIMARY: Partial<Record<PaymentState, { kind: RowActionKind; label: string }>> = {
  "needs-approval": { kind: "approve", label: "Review and approve" },
  "needs-callback": { kind: "callback", label: "Record callback" },
  "ready-to-close": { kind: "close-paid", label: "Close as paid" },
  "paused-by-outage": { kind: "end-outage", label: "End outage" },
  "bank-late": { kind: "trace", label: "Draft trace request" },
  "paid-twice": { kind: "review", label: "Review" },
  "unrecognised-transfer": { kind: "review", label: "Review" },
  "needs-phone": { kind: "review", label: "Review" },
  "no-approvers": { kind: "review", label: "Review" },
  "needs-decision": { kind: "review", label: "Review" },
};

export function paymentHref(invoiceId: string): string {
  return `#incident/${encodeURIComponent(invoiceId)}`;
}

function primaryOf(invoiceId: string, situation: Situation): IncidentRow["primary"] {
  const found: { kind: RowActionKind; label: string } | undefined = PRIMARY[situation.state];
  if (found === undefined) {
    return { kind: "open", label: "Open", href: paymentHref(invoiceId) };
  }
  return {
    kind: found.kind,
    label: found.label,
    href: found.kind === "review" ? paymentHref(invoiceId) : `${paymentHref(invoiceId)}?do=${found.kind}`,
  };
}

export function originOf(snapshot: InvoiceSnapshot): Origin {
  return snapshot.obligation.runRowId !== null ? "pay-run" : snapshot.obligation.origin;
}

function tagsOf(snapshot: InvoiceSnapshot, situation: Situation): RowTag[] {
  const tags: RowTag[] = [];
  if (snapshot.outage !== null) {
    tags.push({ code: "outage", text: `Outage ${snapshot.outage.outage.id}` });
  }
  if (snapshot.inbox.offered > 0) {
    tags.push({
      code: "inbox-offered",
      text: snapshot.inbox.offered === 1 ? "1 email in the inbox" : `${snapshot.inbox.offered} emails in the inbox`,
    });
  }
  if (snapshot.inbox.named > 0) {
    tags.push({ code: "inbox-named", text: "An email in the inbox may be about it" });
  }
  if (situation.state === "bank-late" || situation.also.some((line: string): boolean => line.endsWith("is past its bank deadline."))) {
    tags.push({ code: "past-deadline", text: "Past bank deadline" });
  }
  if (snapshot.run !== null) {
    tags.push({ code: "pay-run", text: `From pay run ${snapshot.run.run.id}` });
  }
  if (snapshot.obligation.origin === "outside") {
    tags.push({ code: "outside", text: "Sent outside PayOnce" });
  }
  if (situation.blockers.length > 0) {
    tags.push({ code: "blocked", text: "Blocked" });
  }
  if (crossCurrency(snapshot.obligation)) {
    tags.push({ code: "cross-currency", text: `From the ${snapshot.obligation.sourceCurrency} wallet` });
  }
  return tags;
}

// What leaves the wallet, when it is not the invoice's own amount in its own
// currency: the board's money at risk in the wallet the payment leaves.
function fromWalletOf(snapshot: InvoiceSnapshot, entry: BoardEntry | undefined): Money | null {
  if (!crossCurrency(snapshot.obligation) || entry === undefined) {
    return null;
  }
  const found: BoardMoney | undefined = entry.atRisk.find((item: BoardMoney): boolean => item.currency === entry.wallet);
  return found === undefined ? null : money(found.minor, found.currency, found.estimated || found.feeUnknown > 0);
}

export function incidentRow(
  snapshot: InvoiceSnapshot,
  situation: Situation,
  entry: BoardEntry | undefined,
  live: Live | null,
): IncidentRow {
  const o: Obligation = snapshot.obligation;
  return {
    invoiceId: o.invoiceId,
    supplier: o.supplier,
    supplierKey: supplierKeyOf(o.beneficiaryId),
    amount: money(o.amountMinor, o.currency),
    fromWallet: fromWalletOf(snapshot, entry),
    origin: originOf(snapshot),
    runId: snapshot.run?.run.id ?? null,
    dueDate: o.dueDate,
    situation,
    incident: incidentOf(snapshot),
    inPlay: entry === undefined ? [] : boardMoney(entry.atRisk),
    waitingSince: situation.since ?? entry?.waitingSince ?? null,
    tags: tagsOf(snapshot, situation),
    primary: primaryOf(o.invoiceId, situation),
    activity: activityOf(isBusy(live, o.invoiceId), watching(snapshot.attempts, snapshot.payouts)),
  };
}

function sinceMs(at: string | null): number {
  const ms: number = at === null ? Number.NaN : Date.parse(at);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function rankMinor(row: IncidentRow): number {
  return Math.max(row.amount.minor, ...row.inPlay.map((item: Money): number => item.minor));
}

// By group, urgent first, then the most money, then the oldest, then the number.
export function byRank(a: IncidentRow, b: IncidentRow): number {
  return (
    GROUP_ORDER[a.situation.group] - GROUP_ORDER[b.situation.group] ||
    Number(b.situation.urgent) - Number(a.situation.urgent) ||
    rankMinor(b) - rankMinor(a) ||
    sinceMs(a.waitingSince) - sinceMs(b.waitingSince) ||
    a.invoiceId.localeCompare(b.invoiceId)
  );
}

// Every invoice snapshot as a row, ranked, with the board's money where it has
// an entry for it.
export function incidentRows(
  snapshots: InvoiceSnapshot[],
  entries: BoardEntry[],
  live: Live | null,
  now: number,
): IncidentRow[] {
  const byInvoice: Map<string, BoardEntry> = new Map<string, BoardEntry>(
    entries
      .filter((entry: BoardEntry): boolean => entry.kind === "invoice")
      .map((entry: BoardEntry): [string, BoardEntry] => [entry.invoiceId, entry]),
  );
  return snapshots
    .map(
      (snapshot: InvoiceSnapshot): IncidentRow =>
        incidentRow(snapshot, situationOf(snapshot, now), byInvoice.get(snapshot.obligation.invoiceId), live),
    )
    .sort(byRank);
}

// ---------- pay runs ----------

export function runHref(runId: number): string {
  return `#run/${runId}`;
}

const RUN_PRIMARY: Partial<Record<RunSituation["state"], { kind: RunRowItem["primary"]["kind"]; label: string }>> = {
  "needs-approval": { kind: "approve", label: "Review and approve" },
  "request-expired": { kind: "recheck", label: "Re-check run" },
  "needs-recheck": { kind: "recheck", label: "Re-check run" },
  "paused-by-outage": { kind: "end-outage", label: "End outage" },
};

export function runRowItem(snapshot: RunSnapshot, situation: RunSituation): RunRowItem {
  const counts: RunCounts = runCounts(snapshot.rows);
  const found: { kind: RunRowItem["primary"]["kind"]; label: string } | undefined = RUN_PRIMARY[situation.state];
  return {
    runId: snapshot.run.id,
    fileName: snapshot.run.fileName,
    state: situation.state,
    label: situation.label,
    next: situation.next,
    tone: situation.tone,
    payments: counts.pay,
    totals: counts.totals.map((total: { currency: string; amountMinor: number }): Money => money(total.amountMinor, total.currency)),
    waitingSince: snapshot.request?.approval.requestedAt ?? snapshot.run.uploadedAt,
    primary:
      found === undefined
        ? { kind: "open", label: "Open", href: runHref(snapshot.run.id) }
        : {
            kind: found.kind,
            label: found.label,
            href: found.kind === "end-outage" ? runHref(snapshot.run.id) : `${runHref(snapshot.run.id)}?do=${found.kind}`,
          },
  };
}

export function runItems(snapshots: RunSnapshot[], now: number): { snapshot: RunSnapshot; situation: RunSituation; item: RunRowItem }[] {
  return snapshots.map((snapshot: RunSnapshot) => {
    const situation: RunSituation = runSituationOf(snapshot, now);
    return { snapshot, situation, item: runRowItem(snapshot, situation) };
  });
}

import { situationOf, type InvoiceSnapshot, type Situation } from "../domain/situation.js";
import { sendsText, type HoldingOf, type OutageSend } from "../outages/outages.js";
import type { Settings } from "../settings.js";
import { readingSoft, type Ledger, type Obligation, type Outage } from "../store/ledger.js";
import { boardEntriesFor, outageHolding, type BoardEntry } from "./incident-board.js";
import { invoiceIndex, type InvoiceIndex } from "../intake/intake.js";
import {
  supplierDetail,
  supplierList,
  type AccountView as RecordAccount,
  type BankChangeView,
  type Caution as RecordCaution,
  type CautionCode,
  type DraftSummary,
  type DuplicateGroup,
  type DuplicateMember,
  type FailureView as RecordFailure,
  type InboxView,
  type InvoiceView,
  type OutageBrief,
  type RelatedRecord,
  type RunRowView as RecordRunRow,
  type SupplierDetail,
  type SupplierList,
  type SupplierSummary,
} from "./suppliers.js";
import type { IncidentRow, SupplierAccountView, SupplierCaution, SupplierListRow, SupplierView, SuppliersView } from "./contract.js";
import { snapshotOptions, type Live } from "./context.js";
import { walletTotals } from "./incidents.js";
import { failureView, plural, refused } from "./parts.js";
import { duplicateView } from "./requests.js";
import { incidentRows } from "./rows.js";
import { readInvoiceSnapshots } from "./snapshot.js";

// Supplier records, keyed by the Airwallex beneficiary id: the list, and one
// record with its cautions, contact on file, accounts and payments. The read
// model in suppliers.ts works them out; these shape them for the page.

// Short words for each caution code, as a list row's chips show them.
export const CAUTION_LABELS: Record<CautionCode, string> = {
  "account-changed": "Bank details changed",
  "callback-verified": "Verified by callback",
  "new-payee": "New payee",
  "unconfirmed-account": "Account never confirmed",
  misdirected: "Paid to other details",
  "shared-account": "Account shared with another record",
  "account-failure": "Account failed",
  "domain-changed": "Email domain changed",
  "asks-not-to-pay": "Asks not to pay",
  "asks-new-details": "Asks for new bank details",
  "paid-twice": "May be paid twice",
  "no-phone": "No phone on file",
  "recent-failures": "Recent failures",
  "non-receipt": "Says not received",
  "flagged-senders": "Unmatched email senders",
  "no-domain": "No email domain on file",
  "outside-payout": "Payout sent outside PayOnce",
  "held-duplicate": "Possible second bill held",
  outage: "Rail outage",
};

const METHOD_WORDS: Record<string, string> = { LOCAL: "Local", SWIFT: "SWIFT" };

const DRAFT_STATES: Record<string, string> = { draft: "Draft", copied: "Copied", sent: "Marked as sent", dismissed: "Dismissed" };

function hintOf(currencies: string[], methods: string[], key: string | null, sameName: number): string {
  return [
    ...(currencies.length === 0 ? [] : [currencies.join(", ")]),
    ...(methods.length === 0 ? [] : [methods.map((method: string): string => METHOD_WORDS[method] ?? method).join(", ")]),
    ...(sameName > 0 && key !== null ? [`record ${key.slice(0, 8)}`] : []),
  ].join(" · ");
}

export function suppliersView(ledger: Ledger, _settings: Settings, now: number, q: string | null = null): SuppliersView {
  return readingSoft((): SuppliersView => {
    const list: SupplierList = supplierList(ledger, now);
    const byRecord: Map<string, Obligation[]> = new Map();
    for (const obligation of ledger.obligations()) {
      byRecord.set(obligation.beneficiaryId, [...(byRecord.get(obligation.beneficiaryId) ?? []), obligation]);
    }
    const lower: string | null = q === null ? null : q.toLowerCase();
    return {
      view: "suppliers",
      rows: list.suppliers
        .filter(
          (summary: SupplierSummary): boolean =>
            lower === null || summary.name.toLowerCase().includes(lower) || (summary.key ?? "").toLowerCase().includes(lower),
        )
        .map((summary: SupplierSummary): SupplierListRow => {
          const invoices: Obligation[] = summary.key === null ? [] : (byRecord.get(summary.key) ?? []);
          const currencies: string[] = [...new Set(invoices.map((obligation: Obligation): string => obligation.currency))].sort();
          const methods: string[] = [...new Set(invoices.map((obligation: Obligation): string => obligation.transferMethod))].sort();
          return {
            key: summary.key,
            name: summary.name,
            hint: hintOf(currencies, methods, summary.key, summary.sameName.length),
            sameName: summary.sameName.length,
            country: null,
            currencies,
            methods: methods.filter((method: string): method is "LOCAL" | "SWIFT" => method === "LOCAL" || method === "SWIFT"),
            accountEnding: null,
            payments: { open: summary.invoices.open + summary.invoices.escalated, total: summary.invoices.total },
            cautions: summary.cautions.map((code: CautionCode) => ({ code, text: CAUTION_LABELS[code] })),
          };
        }),
    };
  });
}

function accountOf(account: RecordAccount): SupplierAccountView {
  return {
    label: account.ending === null ? "an account PayOnce did not read" : `the account ending ${account.ending}`,
    ending: account.ending,
    letter: account.label,
    seenAs: account.seenAs,
    firstSeen: account.firstSeen,
    lastSeen: account.lastSeen,
    lastPaid: account.lastPaid ? { reference: account.lastPaidReference } : null,
    verifiedBy: account.verifiedBy,
    barred: account.barred,
    alsoOn: account.alsoOn,
  };
}

function runRowLabel(row: RecordRunRow): string {
  if (row.action === "skip") {
    return `Skipped (${plural(row.skipReasons, "reason", "reasons")})`;
  }
  return row.state === "released" ? "Released" : row.state === "dropped" ? "Not released" : "Pays";
}

export function supplierView(ledger: Ledger, settings: Settings, now: number, key: string, live: Live | null = null): SupplierView | null {
  return readingSoft((): SupplierView | null => {
    const detail: SupplierDetail | null = supplierDetail(ledger, key, now);
    if (detail === null) {
      return null;
    }
    const ids: string[] = [
      ...detail.invoices.map((invoice: InvoiceView): string => invoice.invoiceId),
      ...detail.duplicates.flatMap((group: DuplicateGroup): string[] => group.invoices.map((member: DuplicateMember): string => member.invoiceId)),
    ];
    const snapshots: InvoiceSnapshot[] = readInvoiceSnapshots(ledger, snapshotOptions(settings, live), now, [...new Set(ids)]);
    const situations: Map<string, Situation> = new Map(
      snapshots.map((snapshot: InvoiceSnapshot): [string, Situation] => [snapshot.obligation.invoiceId, situationOf(snapshot, now)]),
    );
    const mine: InvoiceSnapshot[] = snapshots.filter((snapshot: InvoiceSnapshot): boolean => snapshot.obligation.beneficiaryId === key);
    const entries: BoardEntry[] = boardEntriesFor(
      ledger,
      mine.map((snapshot: InvoiceSnapshot): Obligation => snapshot.obligation),
      key,
      now,
      (): InvoiceIndex => invoiceIndex(ledger),
    ).entries;
    const rows: IncidentRow[] = incidentRows(mine, entries, live, now);
    const holding: HoldingOf = outageHolding(ledger, now);
    return {
      view: "supplier",
      generatedAt: new Date(now).toISOString(),
      key: detail.key,
      name: detail.name,
      otherNames: detail.names.filter((name: string): boolean => name !== detail.name),
      hint: hintOf(detail.currencies, detail.methods, detail.key, detail.related.filter((item: RelatedRecord): boolean => item.why.includes("same-name")).length),
      cautions: detail.cautions.map(
        (caution: RecordCaution): SupplierCaution => ({
          code: caution.code,
          level: caution.level,
          text: caution.text,
          invoices: caution.invoices,
          accounts: caution.accounts,
          since: caution.since,
        }),
      ),
      contact: {
        phoneEnding: detail.phoneLast4,
        emailDomains: detail.domains.map((domain: SupplierDetail["domains"][number]) => ({ domain: domain.domain, payments: domain.invoices, newest: domain.newest })),
        changedBy: null,
        changedAt: null,
        pending: null,
        actions: {},
      },
      accounts: detail.accounts.map(accountOf),
      payments: {
        open: rows.filter((row: IncidentRow): boolean => row.situation.group !== "closed"),
        closed: {
          paid: detail.closed.settled,
          unpaid: detail.closed.rejected,
          listed: rows.filter((row: IncidentRow): boolean => row.situation.group === "closed"),
        },
      },
      callbacks: detail.bankChanges.map((change: BankChangeView) => ({
        id: change.id,
        invoiceId: change.invoiceId,
        calledBy: change.calledBy,
        numberEnding: change.numberCalledLast4,
        calledAt: change.calledAt,
        from: change.from,
        to: change.to,
        state: change.state,
      })),
      secondBills: detail.duplicates.map((group: DuplicateGroup) => ({
        kind: group.kind,
        invoices: group.invoices.map((member: DuplicateMember) => duplicateView(member.invoiceId, situations.get(member.invoiceId) ?? null, null)),
      })),
      runRows: detail.runs.map((row: RecordRunRow) => ({ runId: row.runId, line: row.line, invoiceId: row.invoiceId, label: runRowLabel(row) })),
      inbox: detail.inbox.map((item: InboxView) => ({ uploadId: item.uploadId, invoices: item.invoices, suggested: item.suggested })),
      drafts: detail.drafts.map((draft: DraftSummary) => ({
        id: draft.id,
        invoiceId: draft.invoiceId,
        label: draft.label ?? "A message PayOnce no longer has a template for",
        stateLabel: DRAFT_STATES[draft.state] ?? draft.state,
      })),
      outages: {
        active: detail.outages.active.flatMap((brief: OutageBrief) => {
          const outage: Outage | undefined = ledger.outage(brief.id);
          if (outage === undefined || outage.state !== "active") {
            return [];
          }
          const sends: OutageSend[] = holding(outage).sends;
          return [{ id: brief.id, rail: brief.rail ?? `${outage.currency} ${outage.method}`, pausing: brief.invoices.length, sendsText: `Ending it sends ${sendsText(sends)}.` }];
        }),
        failures: detail.outages.failures.map((failure: RecordFailure) => ({
          reference: failure.reference,
          failure: failureView(failure.code),
          at: failure.failedAt,
          outageId: failure.outageId,
        })),
      },
      related: detail.related.map((item: RelatedRecord) => ({ key: item.key, name: item.name, why: item.why })),
      money: detail.money.map(walletTotals),
      can: { newPayment: refused("not-built", "Starting a payment from the supplier record comes with the New payment page.") },
    };
  });
}

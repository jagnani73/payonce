import { runSituationOf, situationOf, type InvoiceSnapshot, type RunSnapshot, type Situation } from "../domain/situation.js";
import type { Settings } from "../settings.js";
import { readingSoft, type Ledger, type SearchRead } from "../store/ledger.js";
import type { SearchView, SupplierListRow } from "./contract.js";
import { snapshotOptions, supplierKeyOf } from "./context.js";
import { money } from "./parts.js";
import { paymentHref } from "./rows.js";
import { readInvoiceSnapshots, readRunSnapshot } from "./snapshot.js";
import { supplierRows } from "./supplier-pages.js";

// Search across payments, supplier records, pay runs, inbox emails and bank
// references. An exact invoice number or reference opens its payment directly.

export const SEARCH_LIMIT: number = 8;
export const MAX_QUERY_LENGTH: number = 100;

const UPLOAD_LABELS: Record<string, string> = { waiting: "In the inbox", delivered: "Delivered", dismissed: "Dismissed" };

export function searchView(ledger: Ledger, settings: Settings, now: number, q: string): SearchView {
  return readingSoft((): SearchView => {
    const found: SearchRead = ledger.search(q, SEARCH_LIMIT);
    // The supplier list's hint, read only when a record is found.
    let hint: Map<string, string> | undefined;
    const hints = (): Map<string, string> =>
      (hint ??= new Map<string, string>(
        supplierRows(ledger, now).flatMap((row: SupplierListRow): [string, string][] => (row.key === null ? [] : [[row.key, row.hint]])),
      ));
    const snapshots: InvoiceSnapshot[] = readInvoiceSnapshots(
      ledger,
      snapshotOptions(settings, null),
      now,
      found.invoices.map((invoice: SearchRead["invoices"][number]): string => invoice.invoiceId),
    );
    const exactInvoice: string | undefined = ledger.obligation(q)?.invoiceId;
    const exactTransfer: string | undefined = found.transfers.find(
      (transfer: SearchRead["transfers"][number]): boolean => transfer.reference === q,
    )?.invoiceId;
    const exact: string | undefined = exactInvoice ?? exactTransfer;
    return {
      view: "search",
      q,
      exact: exact === undefined ? null : { href: paymentHref(exact) },
      payments: snapshots.map((snapshot: InvoiceSnapshot) => {
        const situation: Situation = situationOf(snapshot, now);
        return {
          invoiceId: snapshot.obligation.invoiceId,
          supplier: snapshot.obligation.supplier,
          amount: money(snapshot.obligation.amountMinor, snapshot.obligation.currency),
          label: situation.label,
          tone: situation.tone,
        };
      }),
      suppliers: found.suppliers.flatMap((supplier: SearchRead["suppliers"][number]) => {
        const key: string | null = supplierKeyOf(supplier.beneficiaryId);
        return key === null ? [] : [{ key, name: supplier.supplier, hint: hints().get(key) ?? "" }];
      }),
      runs: found.runs.map((run: SearchRead["runs"][number]) => {
        const snapshot: RunSnapshot | undefined = readRunSnapshot(ledger, run.id, snapshotOptions(settings, null), now);
        return { id: run.id, fileName: run.fileName, label: snapshot === undefined ? "Not in the ledger" : runSituationOf(snapshot, now).label };
      }),
      emails: found.uploads.map((upload: SearchRead["uploads"][number]) => ({
        id: upload.id,
        subject: upload.subject,
        from: upload.sender,
        label: UPLOAD_LABELS[upload.state] ?? upload.state,
      })),
      transfers: found.transfers,
      limit: SEARCH_LIMIT,
    };
  });
}

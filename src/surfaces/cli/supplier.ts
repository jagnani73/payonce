import { loadEnvIfPresent } from "../../env-file.js";
import { loadSettings, type Settings } from "../../settings.js";
import { Ledger, LEDGER_PATH } from "../../store/ledger.js";
import { say, shownReference } from "../../text/printable.js";
import type {
  DuplicateView,
  IncidentRow,
  OutageStrip,
  SupplierAccountView,
  SupplierCaution,
  SupplierListRow,
  SupplierView,
  SuppliersView,
} from "../../views/contract.js";
import { supplierView, suppliersView } from "../../views/supplier-pages.js";
import { resolveSupplier, type Resolved } from "../../views/suppliers.js";
import { count, heading, listOf, paymentRow, put, putAll, putRows, table, utc, walletLine, type Listed } from "./view-text.js";

// Supplier records in the terminal: every record, or one record with what its
// page shows. It reads only the ledger, with no Airwallex call, and opens it as
// pnpm board does, so an older file gets the schema upgrade any CLI open makes
// and nothing else. It loads .env only if there is one, for the bank deadlines
// the situations need.
const USAGE: string = `Usage: pnpm supplier [RECORD|INVOICE]
With no argument: every supplier record. With a beneficiary id: that record. With an invoice number: the record its payment pays`;

// How each source saw an account.
const SEEN_WORDS: Record<SupplierAccountView["seenAs"][number], string> = {
  decided: "decided for",
  sent: "sent to",
  approval: "asked to approve",
  "pay-run": "in a pay run",
  callback: "verified by a callback",
  "before-callback": "on the record before a callback",
  outside: "paid outside PayOnce",
};

function fail(message: string): void {
  say(message);
  process.exitCode = 1;
}

function name(text: string): string {
  return text.trim() === "" ? "(no name)" : text;
}

function printList(view: SuppliersView, now: string): void {
  put(`Supplier records at ${utc(now)}, from the ledger only`);
  if (view.rows.length === 0) {
    heading("No supplier records yet. Start a payment with pnpm recover, or with New payment in pnpm ui");
    return;
  }
  put(`${count(view.rows.length, "record", "records")}, those that need someone listed first`);
  for (const row of view.rows) {
    heading(`${name(row.name)}${row.hint === "" ? "" : `  (${row.hint})`}`);
    putAll(
      [
        row.key === null ? "A record id PayOnce cannot link" : `Record ${row.key}`,
        `${row.payments.open} not closed of ${count(row.payments.total, "payment", "payments")}`,
        ...(row.cautions.length === 0 ? [] : [`Cautions: ${row.cautions.map((caution: SupplierListRow["cautions"][number]): string => caution.text).join(", ")}`]),
        ...(row.sameName === 0 ? [] : [`Same name as ${count(row.sameName, "other record", "other records")}, which may be another company`]),
      ],
      1,
    );
  }
  heading("One record: pnpm supplier RECORD, or pnpm supplier INVOICE for the record a payment pays");
}

function section(title: string, lines: string[], indent: number = 1): void {
  if (lines.length > 0) {
    heading(title);
    putAll(lines, indent);
  }
}

function cautionLines(caution: SupplierCaution): string[] {
  const links: string[] = [...caution.invoices, ...caution.accounts.map((letter: string): string => `account ${letter}`)];
  return [`${caution.level === "caution" ? "!" : "i"} ${caution.text}`, ...(links.length === 0 ? [] : [`  ${links.join(", ")}`])];
}

function accountLines(account: SupplierAccountView): string[] {
  const lastPaid: string =
    account.lastPaid === null
      ? ""
      : `, last paid${account.lastPaid.reference === null ? "" : ` by ${shownReference(account.lastPaid.reference)}`}`;
  return [
    `${account.letter}  ${account.label}${lastPaid}`,
    `  Seen as ${listOf(account.seenAs.map((source: SupplierAccountView["seenAs"][number]): string => SEEN_WORDS[source]))}; first ${utc(account.firstSeen)}, last ${utc(account.lastSeen)}`,
    ...(account.verifiedBy === null
      ? []
      : [`  Verified by a callback from ${account.verifiedBy.calledBy} at ${utc(account.verifiedBy.calledAt)} (${account.verifiedBy.invoiceId})`]),
    ...(account.barred.length === 0 ? [] : [`  ${listOf(account.barred)} cannot approve payments to it`]),
    ...(account.alsoOn.length === 0 ? [] : [`  Also on ${account.alsoOn.map((key: string): string => `record ${key}`).join(", ")}`]),
  ];
}

function duplicateText(duplicate: DuplicateView): string {
  return `${duplicate.invoiceId} (${duplicate.label})`;
}

function outageLine(outage: OutageStrip): string {
  return `Outage ${outage.id} on ${outage.rail} is active, pausing ${outage.pausing}. ${outage.sendsText}`;
}

function putPayments(title: string, rows: IncidentRow[], now: string): void {
  if (rows.length > 0) {
    heading(title);
    putRows(rows.map((row: IncidentRow): Listed => paymentRow(row, now)));
  }
}

function printDetail(view: SupplierView): void {
  put(name(view.name));
  put(`Record ${view.key}${view.hint === "" ? "" : `  (${view.hint})`}`);
  if (view.otherNames.length > 0) {
    put(`Also on file as ${listOf(view.otherNames)}`);
  }
  const domains: string =
    view.contact.emailDomains.length === 0
      ? "No email domain on file"
      : `Email ${view.contact.emailDomains.length === 1 ? "domain" : "domains"} ${view.contact.emailDomains
          .map((domain: SupplierView["contact"]["emailDomains"][number]): string => `${domain.domain} (${count(domain.payments, "payment", "payments")}, ${domain.first === domain.newest ? domain.first : `${domain.first} to ${domain.newest}`})`)
          .join(", ")}`;
  put(`${view.contact.phoneEnding === null ? "No phone on file" : `Phone on file ending ${view.contact.phoneEnding}`}. ${domains}`);
  section("Cautions", view.cautions.flatMap(cautionLines));
  section("Money by wallet", view.money.length === 0 ? ["Nothing in play"] : table(view.money.map(walletLine)));
  section("Accounts", view.accounts.length === 0 ? ["PayOnce has not kept an account for this record"] : view.accounts.flatMap(accountLines));
  putPayments(`Payments not closed (${view.payments.open.length})`, view.payments.open, view.generatedAt);
  const closed: number = view.payments.closed.paid + view.payments.closed.unpaid;
  putPayments(
    `Closed: ${view.payments.closed.paid} paid, ${view.payments.closed.unpaid} closed without paying${closed > view.payments.closed.listed.length ? `, the ${view.payments.closed.listed.length} newest listed` : ""}`,
    view.payments.closed.listed,
    view.generatedAt,
  );
  section(
    "Callbacks",
    view.callbacks.map(
      (callback: SupplierView["callbacks"][number]): string =>
        `Callback ${callback.id} on ${callback.invoiceId} by ${callback.calledBy} to ${callback.numberEnding === null ? "a number not on file" : `the number ending ${callback.numberEnding}`} at ${utc(callback.calledAt)}: ${callback.state}${callback.from === null ? "" : `, from account ${callback.from}`}${callback.to === null ? "" : ` to account ${callback.to}`}`,
    ),
  );
  section(
    "Possible second bills",
    view.secondBills.map(
      (group: SupplierView["secondBills"][number]): string =>
        `${group.kind === "same-bill" ? "Same bill" : "Same invoice number"}: ${group.invoices.map(duplicateText).join(", ")}`,
    ),
  );
  section(
    "Pay run rows",
    view.runRows.map(
      (row: SupplierView["runRows"][number]): string => `Pay run ${row.runId}, row ${row.line}: ${row.invoiceId ?? "no invoice number"}, ${row.label}`,
    ),
  );
  section(
    "Inbox",
    view.inbox.map(
      (upload: SupplierView["inbox"][number]): string =>
        `Upload ${upload.uploadId} is waiting and names ${listOf(upload.invoices)}${upload.suggested ? " (suggested)" : ""}`,
    ),
  );
  section(
    "Messages",
    view.drafts.map((draft: SupplierView["drafts"][number]): string => `Draft ${draft.id} on ${draft.invoiceId}: ${draft.label}, ${draft.stateLabel}`),
  );
  section("Outages", [
    ...view.outages.active.map(outageLine),
    ...view.outages.failures.map(
      (failure: SupplierView["outages"]["failures"][number]): string =>
        `${failure.reference === null ? "A payout" : shownReference(failure.reference)} failed with ${failure.failure === null ? "no failure code" : `${failure.failure.code} (${failure.failure.words})`} at ${utc(failure.at)}${failure.outageId === null ? "" : `, counted by outage ${failure.outageId}`}`,
    ),
  ]);
  section(
    "Related records",
    view.related.map(
      (related: SupplierView["related"][number]): string =>
        `Record ${related.key}, ${name(related.name)}: ${related.why.map((why: string): string => (why === "same-name" ? "same name, may be another company" : "same account")).join("; ")}`,
    ),
  );
  heading("PayOnce has no exchange rates, so amounts in different currencies are never added together.");
}

function main(): void {
  const args: string[] = process.argv.slice(2);
  if (args.length > 1) {
    fail(USAGE);
    return;
  }
  // Without a .env the default deadlines apply, and nothing is printed about it.
  loadEnvIfPresent();
  const settings: Settings = loadSettings();
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  try {
    const now: number = Date.now();
    const word: string | undefined = args[0]?.trim();
    if (word === undefined) {
      printList(suppliersView(ledger, settings, now), new Date(now).toISOString());
      return;
    }
    const resolved: Resolved | null = resolveSupplier(ledger, word);
    const view: SupplierView | null = resolved === null ? null : supplierView(ledger, settings, now, resolved.key);
    if (resolved === null || view === null) {
      fail(USAGE);
      return;
    }
    if (resolved.viaInvoice !== null) {
      put(`${resolved.viaInvoice} pays supplier record ${resolved.key}`);
      put();
    }
    printDetail(view);
  } finally {
    ledger.close();
  }
}

main();

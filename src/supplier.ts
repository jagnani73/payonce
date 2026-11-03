import { loadEnvIfPresent } from "./env-file.js";
import type { BoardMoney, BoardTotal } from "./incident-board.js";
import { Ledger, LEDGER_PATH } from "./ledger.js";
import { formatMoney } from "./money.js";
import { printable, say, shownFailureCode, shownReference, UNSHOWN_FAILURE_CODE, utcTime } from "./printable.js";
import {
  resolveSupplier,
  supplierDetail,
  supplierList,
  type AccountView,
  type BankChangeView,
  type Caution,
  type DuplicateGroup,
  type InvoiceView,
  type PaidBy,
  type PaymentCheck,
  type PaymentView,
  type RecordStored,
  type Resolved,
  type RunRowView,
  type SupplierDetail,
  type SupplierList,
  type SupplierSummary,
} from "./suppliers.js";

// The supplier view in the terminal: every supplier record, or one record with
// what the page shows of it. It reads only the ledger, with no Airwallex call,
// and opens it as pnpm board does, so an older file gets the schema upgrade any
// CLI open makes and nothing else. It loads .env only if there is one, for the
// bank deadlines the board groups need.
const USAGE: string = `Usage: pnpm supplier [RECORD|INVOICE]
With no argument: every supplier record. With a beneficiary id: that record. With an invoice number: the record its invoice pays`;

const INDENT: string = "    ";

const CHECK_WORDS: Record<PaymentCheck, string> = {
  checked: "checked",
  misdirected: "went to other details",
  "not-kept": "account not kept",
  "not-sent": "not sent",
  outside: "sent outside PayOnce",
};

const SOURCE_WORDS: Record<string, string> = {
  decided: "decided for",
  sent: "sent to",
  approval: "asked to approve",
  "pay-run": "in a pay run",
  callback: "verified by a callback",
  "before-callback": "on the record before a callback",
  outside: "paid outside PayOnce",
};

const GROUP_WORDS: Record<string, string> = {
  person: "waiting on a person",
  deadline: "past the bank deadline",
  bank: "with the bank",
  open: "open",
};

function fail(message: string): void {
  say(message);
  process.exitCode = 1;
}

function utc(at: string | null): string {
  return at === null ? "a time not on file" : utcTime(at);
}

function day(at: string | null): string {
  return at === null ? "a day not on file" : at.slice(0, 10);
}

function moneyText(money: BoardMoney): string {
  const notes: string[] = [];
  if (money.estimated) {
    notes.push("estimated");
  }
  if (money.feeUnknown > 0) {
    notes.push("fee not known");
  }
  return `${formatMoney(money.minor, printable(money.currency))}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}

function amount(minor: number | null, currency: string | null): string {
  return minor === null ? "amount not on file" : formatMoney(minor, printable(currency ?? ""));
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function totalLine(total: BoardTotal): string {
  const parts: string[] = [
    [total.promisedMinor, "approved or being sent"],
    [total.waitingMinor, "waiting on a person"],
    [total.outageMinor, "waiting on an outage"],
    [total.runWaitingMinor, "pay run waiting for approval"],
    [total.withBankMinor, "with the bank"],
  ]
    .filter(([minor]: (string | number)[]): boolean => minor !== 0)
    .map(([minor, what]: (string | number)[]): string => `${formatMoney(Number(minor), "").trim()} ${what}`);
  return `  ${printable(total.currency)}  ${parts.join(", ")}${total.estimated ? " (part estimated)" : ""}`;
}

function listLine(summary: SupplierSummary): string[] {
  const groups: string[] = Object.entries(summary.groups)
    .filter(([group, n]: [string, number]): boolean => group !== "open" && n > 0)
    .map(([group, n]: [string, number]): string => `${n} ${GROUP_WORDS[group] ?? group}`);
  const open: number = summary.invoices.open + summary.invoices.escalated;
  const facts: string[] = [
    `${open} open of ${count(summary.invoices.total, "invoice", "invoices")}`,
    ...(summary.runRows === 0 ? [] : [count(summary.runRows, "pay run row waiting", "pay run rows waiting")]),
    ...groups,
    ...(summary.cautions.length === 0 ? [] : [count(summary.cautions.length, "caution", "cautions")]),
    ...(summary.atRisk.length === 0 ? [] : [`at risk ${summary.atRisk.map(moneyText).join(", ")}`]),
  ];
  return [
    `  ${printable(summary.name) || "(no name)"}`,
    `${INDENT}${summary.key === null ? "Record id PayOnce cannot link" : `Record ${summary.key}`}${summary.otherNames > 0 ? `, ${count(summary.otherNames, "other name", "other names")} on file` : ""}`,
    `${INDENT}${facts.join(", ")}`,
    ...(summary.sameName.length === 0
      ? []
      : [`${INDENT}Same name as ${summary.sameName.map((key: string): string => `record ${key}`).join(", ")} (may be another company)`]),
  ];
}

function printList(list: SupplierList): void {
  say(`Supplier records at ${utc(list.generatedAt)}, from the ledger only`);
  if (list.suppliers.length === 0) {
    say("");
    say("No supplier records yet. Start an incident with pnpm recover, or with the new incident form in pnpm ui");
    return;
  }
  say(`${count(list.suppliers.length, "record", "records")}, those waiting on a person first`);
  for (const summary of list.suppliers) {
    say("");
    for (const line of listLine(summary)) {
      say(line);
    }
  }
  say("");
  say("One record: pnpm supplier RECORD, or pnpm supplier INVOICE for the record an invoice pays");
}

function cautionLine(caution: Caution): string[] {
  const links: string[] = [
    ...caution.invoices.map(printable),
    ...caution.runs.map((id: number): string => `pay run ${id}`),
    ...caution.keys.map((key: string): string => `record ${key}`),
  ];
  return [
    `  ${caution.level === "caution" ? "!" : "i"} ${caution.text}`,
    ...(links.length === 0 ? [] : [`${INDENT}${links.join(", ")}`]),
  ];
}

function accountLine(account: AccountView): string[] {
  const facts: string[] = [];
  if (account.lastPaid) {
    facts.push(
      `last paid and checked${account.lastPaidReference === null ? "" : ` (${shownReference(account.lastPaidReference)})`}`,
    );
  }
  if (account.recordLastStored) {
    facts.push("what the record held when PayOnce last stored it");
  }
  const paid: string[] = [];
  if (account.payonce.total > 0) {
    paid.push(`PayOnce: ${account.payonce.paid} paid, ${account.payonce.failed} failed, ${account.payonce.live} with the bank`);
  }
  if (account.outside.total > 0) {
    paid.push(`outside PayOnce: ${account.outside.paid} paid, ${account.outside.failed} failed, ${account.outside.live} with the bank`);
  }
  const lines: string[] = [
    `  ${account.label}  ${account.ending === null ? "ending not on file" : `ending ${printable(account.ending)}`}  ${[facts.join(", "), ...paid].filter((part: string): boolean => part !== "").join("; ") || "no payment to it"}`,
    `${INDENT}Seen as ${account.seenAs.map((source: string): string => SOURCE_WORDS[source] ?? source).join(", ")}; first ${day(account.firstSeen)}, last ${day(account.lastSeen)}`,
  ];
  if (account.verifiedBy !== null) {
    lines.push(
      `${INDENT}Verified by a callback from ${printable(account.verifiedBy.calledBy)} on ${day(account.verifiedBy.calledAt)} (${printable(account.verifiedBy.invoiceId)})`,
    );
  }
  if (account.superseded.length > 0) {
    lines.push(`${INDENT}Older callbacks for it: ${account.superseded.map((id: number): string => `${id}`).join(", ")}`);
  }
  if (account.barred.length > 0) {
    lines.push(`${INDENT}${account.barred.map(printable).join(", ")} cannot approve payments to it`);
  }
  if (account.alsoOn.length > 0) {
    lines.push(`${INDENT}Also on ${account.alsoOn.map((key: string): string => `record ${key}`).join(", ")}`);
  }
  return lines;
}

function paidByText(paid: PaidBy): string {
  return `paid by ${paid.reference === null ? "a payment" : shownReference(paid.reference)}, ${paid.kind === "outside" ? "found" : "sent"} on ${day(paid.sentAt)}${paid.account === null ? "" : ` to ${paid.account}`} (${CHECK_WORDS[paid.check]})${paid.arrivesBy === null ? "" : `, usually arrives by ${paid.arrivesBy}`}`;
}

function paymentLine(payment: PaymentView): string {
  const failure: string =
    payment.failureCode === null
      ? ""
      : `, ${shownFailureCode(payment.failureCode)} (${payment.failureWords ?? "a code PayOnce has no words for"})`;
  const extra: string[] = [
    ...(payment.foundLate ? ["found late"] : []),
    ...(payment.rateMismatch ? ["rate did not match its approval"] : []),
    ...(payment.mismatchedReference === null
      ? []
      : [`transfer ${shownReference(payment.mismatchedReference)} under its request id does not match the invoice${payment.mismatchedStatus === null ? "" : ` (${printable(payment.mismatchedStatus)})`}`]),
  ];
  // A payment with no transfer went nowhere and was never sent, so it has no
  // account or send time to give.
  const where: string =
    payment.check === "not-sent"
      ? `${payment.amountMinor === null ? "" : `${amount(payment.amountMinor, payment.currency)}, `}${CHECK_WORDS[payment.check]}`
      : `${amount(payment.amountMinor, payment.currency)}, ${payment.account === null ? "account not on file" : `to ${payment.account}`} (${CHECK_WORDS[payment.check]}), ${payment.kind === "outside" ? "found" : "sent"} at ${utc(payment.sentAt)}`;
  return `${INDENT}${payment.kind} ${payment.reference === null ? "(no reference)" : shownReference(payment.reference)}  ${printable(payment.state)}${payment.bankStatus === null ? "" : `, bank status ${printable(payment.bankStatus)}`}${failure}, ${where}${extra.length === 0 ? "" : `, ${extra.join(", ")}`}`;
}

function invoiceLines(invoice: InvoiceView): string[] {
  const head: string = `  ${printable(invoice.invoiceId)}  ${invoice.state.padEnd(9)}  ${formatMoney(invoice.amountMinor, printable(invoice.currency)).padStart(16)}${invoice.wallet === invoice.currency ? "" : ` from ${printable(invoice.wallet)}`}  ${invoice.board?.label ?? (invoice.paidBy === null ? "" : paidByText(invoice.paidBy))}`;
  const lines: string[] = [head];
  if (invoice.board !== null) {
    lines.push(`${INDENT}${invoice.board.why}`);
    for (const also of invoice.board.also) {
      lines.push(`${INDENT}Also: ${also}`);
    }
    if (invoice.paidBy !== null) {
      lines.push(`${INDENT}${paidByText(invoice.paidBy)}`);
    }
  }
  const facts: string[] = [
    ...(invoice.origin === "outside" ? ["found in Airwallex"] : []),
    ...(invoice.runId === null ? [] : [`pay run ${invoice.runId}, row ${invoice.runLine ?? ""}`]),
    ...(invoice.startedBy === null ? [] : [`started by ${printable(invoice.startedBy)}`]),
    ...(invoice.rejectedBy === null ? [] : [`closed without paying by ${printable(invoice.rejectedBy)}`]),
    ...(invoice.dueDate === null ? [] : [`due ${printable(invoice.dueDate)}`]),
    ...(invoice.duplicateOf.length === 0 ? [] : [`held as a likely second bill for ${invoice.duplicateOf.map(printable).join(", ")}`]),
  ];
  if (facts.length > 0) {
    lines.push(`${INDENT}${facts.join(", ")}`);
  }
  for (const payment of invoice.payments) {
    lines.push(paymentLine(payment));
  }
  if (invoice.emails !== null) {
    const emails = invoice.emails;
    lines.push(
      `${INDENT}${count(emails.count, "email", "emails")}${emails.partlyUnread === 0 ? "" : `, ${emails.partlyUnread} partly unread`}${emails.sendersFlagged === 0 ? "" : `, ${count(emails.sendersFlagged, "sender", "senders")} flagged`}${emails.findings === null ? ", not read yet" : `: ${emails.findings.summary}${emails.findings.readBy === null ? "" : ` (read by ${printable(emails.findings.readBy)})`}`}`,
    );
  }
  return lines;
}

function bankChangeLine(change: BankChangeView): string {
  return `  Callback ${change.id} on ${printable(change.invoiceId)} by ${printable(change.calledBy)} to ${change.numberCalledLast4 === null ? "a number not on file" : `…${change.numberCalledLast4}`} on ${utc(change.calledAt)}: ${change.state}${change.from === null ? "" : `, from ${change.from}`}${change.to === null ? "" : ` to ${change.to}`}${change.latest ? ", the latest applied" : ""}${change.barred.length === 0 ? "" : `. ${change.barred.map(printable).join(", ")} cannot approve payments to it`}`;
}

function duplicateLine(group: DuplicateGroup): string {
  return `  ${group.kind === "same-bill" ? "Same bill" : "Same number"}: ${group.invoices
    .map(
      (member: DuplicateGroup["invoices"][number]): string =>
        `${printable(member.invoiceId)} (${member.state}${member.held ? ", held" : ""}${member.thisRecord ? "" : `, record ${member.key ?? "PayOnce cannot link"}`})`,
    )
    .join(", ")}`;
}

function runLine(row: RunRowView): string {
  const facts: string[] = [
    ...(row.newPayee ? ["new payee"] : []),
    ...(row.callbackVerified ? ["account verified by a callback"] : []),
    ...(row.account === null ? [] : [`account ${row.account}`]),
  ];
  const action: string = row.action === "pay" ? "pays" : `skipped for ${count(row.skipReasons, "reason", "reasons")}`;
  return `  Pay run ${row.runId} (${row.runState}), row ${row.line}: ${row.invoiceId === null ? "no invoice number" : printable(row.invoiceId)}, ${action}, row ${row.state}, ${amount(row.amountMinor, row.currency)}${facts.length === 0 ? "" : `, ${facts.join(", ")}`}`;
}

function section(title: string, lines: string[]): void {
  if (lines.length === 0) {
    return;
  }
  say("");
  say(title);
  for (const line of lines) {
    say(line);
  }
}

function printDetail(detail: SupplierDetail): void {
  say(printable(detail.name) || "(no name)");
  const header: string[] = [
    `Record ${detail.key}`,
    detail.phoneLast4 === null ? "No phone on file" : `Phone on file …${detail.phoneLast4}`,
    detail.domains.length === 0
      ? "No email domain on file"
      : `${detail.domains.length === 1 ? "Domain" : "Domains"} ${detail.domains.map((entry: { domain: string }): string => printable(entry.domain)).join(", ")}`,
  ];
  say(`${header.join(". ")}`);
  if (detail.names.length > 0) {
    say(`Also on file as ${detail.names.map((name: string): string => printable(name)).join(", ")}`);
  }
  if (detail.currencies.length > 0) {
    say(`Pays in ${detail.currencies.join(", ")}${detail.methods.length === 0 ? "" : ` by ${detail.methods.join(", ")}`}`);
  }
  for (const related of detail.related) {
    const why: string[] = [
      ...(related.why.includes("same-name") ? ["same name, may be another company"] : []),
      ...(related.why.includes("same-account")
        ? [related.accounts.length === 0 ? "same account" : `shares account ${related.accounts.join(", ")}`]
        : []),
    ];
    say(`Related: record ${related.key}, ${printable(related.name) || "(no name)"} (${why.join("; ")})`);
  }
  if (detail.recordStored !== null) {
    const stored: RecordStored = detail.recordStored;
    const where: string =
      stored.invoiceId !== null
        ? ` (${printable(stored.invoiceId)})`
        : stored.runId !== null
          ? ` (${stored.runLine === null ? "" : `row ${stored.runLine} of `}pay run ${stored.runId})`
          : "";
    say(
      `PayOnce last stored what this record held on ${utc(stored.at)}${where}, account ${stored.account}. It reads the record again before every payment.`,
    );
  } else {
    say("PayOnce has not stored what this record holds. It reads the record again before every payment.");
  }
  section("Cautions", detail.cautions.flatMap(cautionLine));
  section(
    "At risk now",
    detail.money.length === 0 ? ["  Nothing"] : detail.money.map(totalLine),
  );
  section(
    "Accounts",
    detail.accounts.length === 0
      ? ["  PayOnce has not kept an account for this record"]
      : detail.accounts.flatMap(accountLine),
  );
  const open: number = detail.invoices.length - detail.closed.listed;
  const closed: number = detail.closed.settled + detail.closed.rejected;
  section(`Invoices: ${open} open, ${closed} closed${closed > detail.closed.listed ? `, the ${detail.closed.listed} newest listed` : ""}`, [
    ...detail.invoices.flatMap(invoiceLines),
    ...(closed > detail.closed.listed
      ? [`  ${closed - detail.closed.listed} older closed invoices are not listed. pnpm board and the incident list have them`]
      : []),
  ]);
  section("Bank details changes", detail.bankChanges.map(bankChangeLine));
  section("Likely duplicates", detail.duplicates.map(duplicateLine));
  section("Outages", [
    ...detail.outages.active.map(
      (outage: SupplierDetail["outages"]["active"][number]): string =>
        `  Outage ${outage.id} on ${outage.rail ?? "a rail"} is active, since ${utc(outage.declaredAt)}: ${outage.invoices.map(printable).join(", ")}`,
    ),
    ...detail.outages.holds.map(
      (hold: SupplierDetail["outages"]["holds"][number]): string =>
        `  Outage ${hold.outageId}${hold.rail === null ? "" : ` on ${hold.rail}`} held ${hold.invoiceId === null ? `pay run ${hold.runId ?? ""}` : printable(hold.invoiceId)} (${hold.what}) at ${utc(hold.heldAt)}, ${hold.state}${hold.endedAt === null ? "" : ` at ${utc(hold.endedAt)}`}`,
    ),
    ...detail.outages.failures.map(
      (failure: SupplierDetail["outages"]["failures"][number]): string =>
        `  ${failure.reference === null ? "A payout" : shownReference(failure.reference)} failed with ${failure.code === null ? UNSHOWN_FAILURE_CODE : `${shownFailureCode(failure.code)} (${failure.codeWords ?? "rail failure"})`} at ${utc(failure.failedAt)}${failure.invoiceId === null ? "" : `, ${printable(failure.invoiceId)}`}${failure.outageId === null ? "" : `, counted by outage ${failure.outageId}`}`,
    ),
  ]);
  section("Pay runs", detail.runs.map(runLine));
  section(
    "Inbox",
    detail.inbox.map(
      (upload: SupplierDetail["inbox"][number]): string =>
        `  Upload ${upload.uploadId} waits and names ${upload.invoices.map(printable).join(", ")}${upload.suggested ? ", offered first" : ""}`,
    ),
  );
  section(
    "Messages",
    detail.drafts.map(
      (draft: SupplierDetail["drafts"][number]): string =>
        `  Draft ${draft.id} on ${printable(draft.invoiceId)}: ${draft.label ?? "a template PayOnce does not have"} for the ${draft.audience ?? "unknown audience"}, ${draft.state}, created by ${printable(draft.createdBy)} at ${utc(draft.createdAt)}${draft.copiedBy === null ? "" : `, copied by ${printable(draft.copiedBy)}`}${draft.sentBy === null ? "" : `, marked sent by ${printable(draft.sentBy)}`}${draft.dismissedBy === null ? "" : `, dismissed by ${printable(draft.dismissedBy)}`}`,
    ),
  );
  say("");
  say("PayOnce has no exchange rates, so amounts in different currencies are never added together.");
}

function main(): void {
  const args: string[] = process.argv.slice(2);
  if (args.length > 1) {
    fail(USAGE);
    return;
  }
  // Without a .env the default deadlines apply, and nothing is printed about it.
  loadEnvIfPresent();
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  try {
    const word: string | undefined = args[0]?.trim();
    if (word === undefined) {
      printList(supplierList(ledger));
      return;
    }
    const resolved: Resolved | null = resolveSupplier(ledger, word);
    const detail: SupplierDetail | null = resolved === null ? null : supplierDetail(ledger, resolved.key);
    if (resolved === null || detail === null) {
      fail(USAGE);
      return;
    }
    if (resolved.viaInvoice !== null) {
      say(`${printable(resolved.viaInvoice)} pays supplier record ${resolved.key}`);
      say("");
    }
    printDetail(detail);
  } finally {
    ledger.close();
  }
}

main();

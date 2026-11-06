import { existsSync } from "node:fs";
import { loadSettings, type Settings } from "../../settings.js";
import type { CoveredTransfer } from "../../engine/facts.js";
import { closeIncident, pendingClose, type CloseReview } from "../../engine/person.js";
import { personName } from "../../domain/approvers.js";
import { Ledger, LEDGER_PATH } from "../../store/ledger.js";
import { say, shownReference } from "../../text/printable.js";
import { notAnInvoiceText } from "../../runs/runs.js";
import type { CoveredTransferView, DecisionOption, EmailsTab, IncidentView, NamingPayoutView } from "../../views/contract.js";
import { incidentView } from "../../views/incident.js";
import { count, heading, put, putAll, putCautions, putConsequence, putPayment } from "./view-text.js";

const COVERS_FLAG: string = "--covers=";
// Airwallex's transfer ids are UUIDs. Anything else is not printed.
const TRANSFER_ID: RegExp = /^[A-Za-z0-9-]{1,64}$/;

function names(name: string, transfer: CoveredTransfer): boolean {
  return name === transfer.reference || name === transfer.transferId;
}

// How --covers names a transfer: by its short reference, else by its transfer id.
function coverName(transfer: CoveredTransfer): string {
  if (shownReference(transfer.reference) === transfer.reference) {
    return transfer.reference;
  }
  return TRANSFER_ID.test(transfer.transferId) ? transfer.transferId : "<TRANSFER>";
}

function emailsLine(emails: EmailsTab): string | null {
  if (emails.count === 0) {
    return null;
  }
  return `Emails: ${count(emails.count, "email", "emails")} on file${emails.findings === null ? ", not read yet" : ` (${emails.findings.summary})`}`;
}

// The payment and the close that fits it, as the payment page's Decision panel
// offers it.
function show(view: IncidentView, unpaid: boolean): void {
  putPayment(view);
  const emails: string | null = emailsLine(view.emails);
  if (emails !== null) {
    put(emails);
  }
  putCautions(view.decision.open?.cautions ?? [], view.situation.also);
  const option: DecisionOption | undefined = view.decision.open?.options.find(
    (item: DecisionOption): boolean => item.kind === (unpaid ? "close-unpaid" : "close-paid"),
  );
  if (option === undefined || (option.kind !== "close-paid" && option.kind !== "close-unpaid")) {
    return;
  }
  heading(option.title);
  putConsequence(option);
  if (option.kind === "close-paid" && option.namesOnly.length > 0) {
    put("Payouts that name it but do not pay it:", 1);
    putAll(option.namesOnly.map((payout: NamingPayoutView): string => payout.text), 2);
  }
  if (option.covers.length > 0) {
    put("This close covers these unrecognised transfers, listed under its request ids:", 1);
    putAll(option.covers.map((transfer: CoveredTransferView): string => transfer.text), 2);
  }
}

// Without a name it only shows what is waiting. With a name and a note of what
// the person confirmed, it closes the payment. A close that covers transfers
// listed under the payment's request ids that do not match it names each one
// with --covers, by the bank's short reference or the transfer id, so the person
// confirms the list they were shown.
function main(): void {
  const settings: Settings = loadSettings();
  const invoiceId: string | undefined = process.argv[2];
  const closedBy: string | undefined = process.argv[3];
  const rest: string[] = process.argv.slice(4);
  const named: string[] = rest
    .filter((arg: string): boolean => arg.startsWith(COVERS_FLAG))
    .flatMap((arg: string): string[] => arg.slice(COVERS_FLAG.length).split(","))
    .map((name: string): string => name.trim())
    .filter((name: string): boolean => name !== "");
  const finding: string = rest
    .filter((arg: string): boolean => !arg.startsWith(COVERS_FLAG))
    .join(" ")
    .trim();
  if (invoiceId === undefined || invoiceId.startsWith(COVERS_FLAG)) {
    say("Usage: pnpm close <INVOICE> [NAME] [NOTE] [--covers=REF,...]");
    process.exitCode = 1;
    return;
  }

  // Opening a ledger that is not there would make an empty one.
  if (!existsSync(LEDGER_PATH)) {
    say(`There is no ${LEDGER_PATH} here. Start an incident first.`);
    process.exitCode = 1;
    return;
  }
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  if (ledger.obligation(invoiceId) === undefined) {
    say(notAnInvoiceText(ledger, invoiceId));
    process.exitCode = 1;
    return;
  }
  const review: CloseReview | undefined = pendingClose(ledger, invoiceId);
  if (review === undefined) {
    say(`${invoiceId} is not waiting on a person to close it`);
    process.exitCode = 1;
    return;
  }

  const unpaid: boolean = review.kind === "duplicate" || review.kind === "unpaid";
  const view: IncidentView | null = incidentView(ledger, settings, Date.now(), invoiceId);
  if (view !== null) {
    show(view, unpaid);
    say();
  }
  const covers: string =
    review.covered.length === 0 ? "" : ` ${COVERS_FLAG}${review.covered.map(coverName).join(",")}`;
  if (closedBy === undefined || closedBy.startsWith(COVERS_FLAG) || finding === "") {
    say(`To close it ${unpaid ? "without paying" : "as paid"}: pnpm close ${invoiceId} <NAME> <NOTE>${covers}`);
    return;
  }
  let by: string;
  try {
    by = personName(closedBy);
  } catch (error: unknown) {
    say(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  // Every transfer the close covers, and nothing else, so a list that changed
  // since the person looked is refused.
  const unknown: string[] = named.filter(
    (name: string): boolean => !review.covered.some((transfer: CoveredTransfer): boolean => names(name, transfer)),
  );
  const missing: boolean = review.covered.some(
    (transfer: CoveredTransfer): boolean => !named.some((name: string): boolean => names(name, transfer)),
  );
  if (missing || unknown.length > 0) {
    say(
      review.covered.length === 0
        ? `Not closed: nothing listed under ${invoiceId}'s request ids needs naming, so leave out --covers (${unknown.join(", ")} not on file)`
        : `Not closed: name every transfer listed above, and only those${unknown.length > 0 ? ` (${unknown.join(", ")} not on the list)` : ""}: pnpm close ${invoiceId} <NAME> <NOTE>${covers}`,
    );
    process.exitCode = 1;
    return;
  }
  closeIncident(
    ledger,
    invoiceId,
    by,
    finding,
    review.covered.map((transfer: CoveredTransfer): string => transfer.transferId),
  );
  say(unpaid ? "Closed without paying" : "Closed as paid. Nothing more is sent");
}

main();

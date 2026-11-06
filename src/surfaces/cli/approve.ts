import { existsSync } from "node:fs";
import { approvePayment } from "../../engine/person.js";
import { loadEnvIfPresent } from "../../env-file.js";
import { notAnInvoiceText } from "../../runs/runs.js";
import { loadSettings, type Settings } from "../../settings.js";
import { Ledger, LEDGER_PATH, type Approval, type Obligation } from "../../store/ledger.js";
import { pendingApproval, type PendingApproval } from "../../store/read/reviews.js";
import { say, shownReference } from "../../text/printable.js";
import type { DecisionOption, DuplicateView, IncidentView, RequestView, TermsView } from "../../views/contract.js";
import { incidentView } from "../../views/incident.js";
import { readableTerms } from "./terms-shape.js";
import { heading, money, putCautions, putConsequence, putFields, putPayment, signingFields, utc, type Field } from "./view-text.js";

function unreadableText(invoiceId: string, requestId: number | null): string {
  return `${requestId === null ? "The approval request" : `Request ${requestId}`} for ${invoiceId} holds terms PayOnce cannot read, so there is nothing to show or approve`;
}

function duplicateText(duplicate: DuplicateView): string {
  const paid: string = duplicate.paidBy === null ? "" : `, paid by ${shownReference(duplicate.paidBy)}`;
  const account: string = duplicate.sameAccount === null ? "" : duplicate.sameAccount ? ", same account" : ", another account";
  return `${duplicate.invoiceId}, ${duplicate.label}${paid}${account}`;
}

// What an approval covers: who is paid, how much, to which account, at which
// rate and why.
function termsFields(terms: TermsView): Field[] {
  const fields: Field[] = [["Pay", money(terms.pay)]];
  if (terms.fx !== null) {
    fields.push(
      ["Rate", `${terms.fx.rate} (${terms.fx.markup ?? "no mid-market rate"})`],
      ["From", `${money(terms.fx.takes)} from the ${terms.fx.takes.currency} wallet`],
      ["Quote", `${terms.fx.quoteId}, until ${utc(terms.fx.validTo)}`],
      ["Fee", terms.feeEstimate === null ? `charged in ${terms.fx.takes.currency} when it is sent` : `about ${money(terms.feeEstimate)}`],
    );
  }
  fields.push(["To", `${terms.account.label} (${terms.accountOnFile ? "the account on file" : "the details a callback confirmed"})`]);
  if (terms.callback !== null) {
    const callback: NonNullable<TermsView["callback"]> = terms.callback;
    fields.push([
      "Callback",
      `${callback.calledBy} called ${callback.numberEnding === null ? "the number on file" : `the number ending ${callback.numberEnding}`} at ${utc(callback.calledAt)}, spoke to ${callback.spokeTo} and confirmed ${callback.confirmed}`,
    ]);
  }
  if (terms.arrival !== null) {
    fields.push(["Arrival", [terms.arrival.text, ...(terms.arrival.sentToday === null ? [] : [terms.arrival.sentToday.text]), terms.arrival.note]]);
  }
  fields.push(["Because", terms.reason.text]);
  if (terms.original !== null) {
    const failure: string = terms.original.failure === null ? "" : ` (${terms.original.failure.code}, ${terms.original.failure.words})`;
    fields.push(["Original", `${terms.original.reference === null ? "no reference" : shownReference(terms.original.reference)}, ${terms.original.stateLabel}${failure}`]);
  }
  if (terms.emails !== null) {
    fields.push(["Emails", terms.emails]);
  }
  if (terms.duplicates.length > 0) {
    fields.push(["Looks like", terms.duplicates.map(duplicateText)]);
  }
  return fields;
}

function show(view: IncidentView, request: RequestView): void {
  putPayment(view);
  heading(`Request #${request.id}: ${request.terms.title}`);
  putFields([["State", request.label], ...termsFields(request.terms), ...signingFields(request)]);
  putCautions(view.decision.open?.cautions ?? [], view.situation.also);
  const option: DecisionOption | undefined = view.decision.open?.options.find((item: DecisionOption): boolean => item.kind === "approve");
  if (option !== undefined) {
    heading("If you approve");
    putConsequence(option);
  }
  say();
}

// Without a name it only shows the terms. With the request number it showed and
// a name, it records that person's approval of that request, under the approval
// policy. A request opened since is refused, so nobody approves terms they did
// not see.
function main(): void {
  // For APPROVERS. Without it every approval is refused, and the approvers say so.
  loadEnvIfPresent();
  const settings: Settings = loadSettings();
  const invoiceId: string | undefined = process.argv[2];
  const requestId: number = Number(process.argv[3]);
  const approver: string | undefined = process.argv.slice(4).join(" ").trim() || undefined;
  if (invoiceId === undefined || (process.argv[3] !== undefined && !Number.isInteger(requestId))) {
    say("Usage: pnpm approve <INVOICE> [REQUEST NAME]");
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
  let obligation: Obligation | undefined;
  let pending: PendingApproval | undefined;
  try {
    obligation = ledger.obligation(invoiceId);
    pending = obligation === undefined ? undefined : pendingApproval(ledger, invoiceId);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    say(unreadableText(invoiceId, ledger.latestApproval(invoiceId)?.id ?? null));
    process.exitCode = 1;
    return;
  }
  if (obligation === undefined) {
    say(notAnInvoiceText(ledger, invoiceId));
    process.exitCode = 1;
    return;
  }
  if (pending === undefined) {
    say(`No approval is waiting for ${invoiceId}`);
    process.exitCode = 1;
    return;
  }
  // The view prints the terms, and approving reads them, only in their shape.
  const view: IncidentView | null = readableTerms(pending.terms as unknown) ? incidentView(ledger, settings, Date.now(), invoiceId) : null;
  const request: RequestView | null = view?.decision.open?.request ?? null;
  if (view === null || request === null) {
    say(unreadableText(invoiceId, pending.approval.id));
    process.exitCode = 1;
    return;
  }

  show(view, request);
  // An expired request can no longer be approved, so no command is offered for it.
  if (pending.expired) {
    say("This request has expired. PayOnce opens a new request at its next check, and pnpm approve shows it then");
    if (approver !== undefined) {
      process.exitCode = 1;
    }
    return;
  }
  if (approver === undefined) {
    say(`To approve these terms: pnpm approve ${invoiceId} ${pending.approval.id} <NAME>`);
    return;
  }
  try {
    const after: Approval = approvePayment(ledger, settings.approvals, invoiceId, approver, requestId);
    say(
      after.state === "approved"
        ? "Approved. The approval covers these terms only"
        : `Recorded. It needs ${after.needed - after.signoffs.length} more signoff before PayOnce sends it`,
    );
  } catch (error: unknown) {
    say(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();

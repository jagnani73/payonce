import type { ApprovalTerms } from "../domain/approval.js";
import { summarise, unverifiedSenders, type EmailFindings, type SupplierEmail } from "../domain/emails.js";
import { isExpired } from "../domain/live.js";
import { ModelReadError, triesText } from "../reader/reader-error.js";
import { checkedObject, type Approval, type Ledger, type Obligation } from "../store/ledger.js";
import { findingsOnFile, isStoredFindings, requestTerms, type StoredFindings } from "../store/stored.js";
import { lineAbout, sayWarning } from "../text/printable.js";
import type { Engine } from "./engine.js";
import { messageOf, note } from "./lines.js";

const UNREAD_SUMMARY: string = "the emails could not be read";

// With no domain on file every sender is flagged, since nothing can vouch for it.
export function sendersNotOnFile(obligation: Obligation, emails: SupplierEmail[]): string[] {
  return unverifiedSenders(emails, obligation.supplierDomain);
}

// True while an email on file has not been read: the reader failed on it, or it
// arrived after the findings were saved, for example from another process during
// this look.
export function emailsNotRead(findings: StoredFindings, stored: boolean, emails: SupplierEmail[]): boolean {
  return (
    findings.unread === true ||
    (emails.length > 0 && !stored) ||
    (findings.emailsRead ?? emails.length) < emails.length
  );
}

// Puts the sender check on the timeline: each From and Reply-To address the
// domain on file does not vouch for.
export function noteSenders(ledger: Ledger, obligation: Obligation, emails: SupplierEmail[]): void {
  const invoiceId: string = obligation.invoiceId;
  const domain: string = obligation.supplierDomain;
  const fromOnly: SupplierEmail[] = emails.map((email: SupplierEmail): SupplierEmail => ({ ...email, replyTo: [] }));
  const replies: SupplierEmail[] = emails.flatMap((email: SupplierEmail): SupplierEmail[] =>
    (email.replyTo ?? []).map((address: string): SupplierEmail => ({ from: address, subject: "", body: "" })),
  );
  for (const sender of unverifiedSenders(fromOnly, domain)) {
    note(
      ledger,
      invoiceId,
      "warning",
      domain === ""
        ? `No supplier domain is on file for this invoice, so sender ${sender} cannot be checked`
        : `Sender ${sender} does not match the supplier's domain on file (${domain})`,
    );
  }
  for (const address of unverifiedSenders(replies, domain)) {
    note(
      ledger,
      invoiceId,
      "warning",
      domain === ""
        ? `No supplier domain is on file for this invoice, so Reply-To address ${address} cannot be checked`
        : `Replies to this email go to ${address}, which does not match the supplier's domain on file (${domain})`,
    );
  }
}

// The inbox: stores emails that arrived for an invoice, puts them on its timeline
// and checks their senders against the domain on file. The agent reads them the
// next time it looks at the invoice.
export function deliver(
  ledger: Ledger,
  obligation: Obligation,
  emails: SupplierEmail[],
): void {
  const invoiceId: string = obligation.invoiceId;
  ledger.addEmails(invoiceId, emails);
  for (const email of emails) {
    note(ledger, invoiceId, "email", `Email from ${email.from}: ${email.subject}`);
  }
  noteSenders(ledger, obligation, emails);
}

// Reads the emails that arrived since the thread was last read, one at a time,
// and keeps the findings so later looks see the same result. One email at a time
// means an instruction in one cannot change how another is read. Findings only
// ever add caution: each read is ORed with what earlier reads found, so a later
// email cannot clear a finding. If the reader fails, the thread is marked unread
// so the policy escalates, and the count stays at the emails read so far, so the
// next look reads from the one that failed. held is true for an invoice held
// before paying, whose next look after a failure comes a minute later.
export async function readNewEmails(engine: Engine, obligation: Obligation, held: boolean): Promise<void> {
  const invoiceId: string = obligation.invoiceId;
  const thread: SupplierEmail[] = engine.ledger.emails(invoiceId);
  const stored: string | undefined = engine.ledger.findings(invoiceId);
  const previous: StoredFindings | undefined =
    stored === undefined ? undefined : checkedObject(stored, isStoredFindings, findingsOnFile(invoiceId));
  // Findings saved before the count was kept cover the whole thread.
  const readCount: number =
    previous === undefined ? 0 : (previous.emailsRead ?? thread.length);
  if (readCount >= thread.length) {
    return;
  }

  let claimsNonReceipt: boolean = previous?.claimsNonReceipt === true;
  let asksForNewBankDetails: boolean = previous?.asksForNewBankDetails === true;
  let asksNotToPay: boolean = previous?.asksNotToPay === true;
  let readBy: string | undefined = previous?.readBy;
  let emailsRead: number = readCount;
  let unread: boolean = false;
  // What the emails read in this look said, apart from the invoice's findings so
  // far, so the timeline does not pin an earlier email's finding on a new one.
  let newNonReceipt: boolean = false;
  let newBankDetails: boolean = false;
  let newNotToPay: boolean = false;
  for (const email of thread.slice(readCount)) {
    try {
      const read: EmailFindings = await engine.reader.read([email]);
      newNonReceipt = newNonReceipt || read.claimsNonReceipt;
      newBankDetails = newBankDetails || read.asksForNewBankDetails;
      newNotToPay = newNotToPay || read.asksNotToPay === true;
      claimsNonReceipt = claimsNonReceipt || read.claimsNonReceipt;
      asksForNewBankDetails = asksForNewBankDetails || read.asksForNewBankDetails;
      asksNotToPay = asksNotToPay || read.asksNotToPay === true;
      readBy = read.readBy ?? engine.reader.name;
      emailsRead += 1;
    } catch (error: unknown) {
      unread = true;
      note(engine.ledger, invoiceId, "email", readFailureLine(error, held));
      if (!(error instanceof ModelReadError)) {
        sayWarning(lineAbout(invoiceId, "reader", messageOf(error), true));
      }
      break;
    }
  }
  const found: string = summarise(claimsNonReceipt, asksForNewBankDetails, asksNotToPay);
  const findings: StoredFindings = {
    claimsNonReceipt,
    asksForNewBankDetails,
    asksNotToPay,
    summary: !unread
      ? found
      : claimsNonReceipt || asksForNewBankDetails || asksNotToPay
        ? `${found}, and some emails could not be read`
        : UNREAD_SUMMARY,
    unverifiedSenders: sendersNotOnFile(obligation, thread),
    unread,
    emailsRead,
    ...(readBy === undefined ? {} : { readBy }),
  };
  engine.ledger.saveFindings(invoiceId, JSON.stringify(findings));
  const count: number = emailsRead - readCount;
  const said: string = summarise(newNonReceipt, newBankDetails, newNotToPay);
  const soFar: string = `Findings for this invoice so far: ${findings.summary}`;
  const which: string = `${count} ${readCount === 0 ? "" : "new "}${count === 1 ? "email" : "emails"}`;
  note(
    engine.ledger,
    invoiceId,
    "email",
    count === 0 ? soFar : said === findings.summary ? `Read ${which}: ${said}` : `Read ${which}: ${said}. ${soFar}`,
  );
}

// A reader failure in PayOnce's words: what each model did, and never what the
// service wrote, which the reader printed to the console with the key cut out.
function readFailureLine(error: unknown, held: boolean): string {
  const tries: string = error instanceof ModelReadError ? `: ${triesText(error.tries)}` : "";
  return `The email reader could not read a supplier email${tries}. PayOnce reads it again on its next look${held ? ", in about a minute" : " at this invoice"}`;
}

// Approval terms counted the emails from this version on, and named no sender
// address. A request opened before then no longer matches its terms once the
// invoice has emails. This line says only why. What happens to the request, a
// new one or none, and whether approvals given on it still count, is said once,
// by the step that does it.
const EMAIL_COUNT: RegExp = /\b[0-9]+ emails? on file\b/;

export function noteEvidenceUpgrade(engine: Engine, invoiceId: string, approval: Approval | undefined, emails: number): void {
  if (
    emails === 0 ||
    approval === undefined ||
    (approval.state !== "requested" && approval.state !== "approved") ||
    isExpired(approval)
  ) {
    return;
  }
  const terms: ApprovalTerms = requestTerms(approval);
  const evidence: string | undefined = terms.action === "replace" ? terms.evidence.emails : undefined;
  if (evidence === undefined || EMAIL_COUNT.test(evidence)) {
    return;
  }
  note(
    engine.ledger,
    invoiceId,
    "approval",
    `Approval terms now count the supplier emails on file and name no sender address, so the open ${approval.state === "approved" ? "approval" : "request"} no longer matches them`,
  );
}

import { readFileSync } from "node:fs";

// An attachment listed by name, type and size. PayOnce never decodes, stores or
// opens one.
export interface EmailAttachment {
  name: string;
  type: string;
  bytes: number;
}

export interface SupplierEmail {
  from: string;
  subject: string;
  body: string;
  // Set on an email a person uploaded, never on a fixture thread's.
  uploadId?: number;
  // The display name in From. Never compared, but a mail client shows it, so the
  // reader reads it.
  fromName?: string;
  replyTo?: string[];
  // Text found inside the email's styles and scripts, which a mail client could
  // draw. Read and shown apart from the body.
  styleText?: string;
  attachments?: EmailAttachment[];
  // PayOnce's notes about the email, in its own words and never in the body.
  notes?: string[];
  // Part of its text was not read, so it counts as unread.
  partial?: boolean;
}

// The only thing a reader hands to the policy. It carries no amounts and no bank
// details, so a reader cannot change what gets paid or to whom.
export interface EmailFindings {
  claimsNonReceipt: boolean;
  asksForNewBankDetails: boolean;
  // The supplier asks to hold, cancel or not pay the invoice. Findings saved
  // before it existed have none, which reads as false.
  asksNotToPay: boolean;
  summary: string;
  // What read the thread, when that is more exact than the reader's name.
  readBy?: string;
}

// The summary a person reads. It is written here from the findings, so no
// wording from an email or from a model reaches the approval card.
export function summarise(
  claimsNonReceipt: boolean,
  asksForNewBankDetails: boolean,
  asksNotToPay: boolean,
): string {
  const parts: string[] = [];
  if (claimsNonReceipt) {
    parts.push("supplier reports the payment has not arrived");
  }
  if (asksForNewBankDetails) {
    parts.push("asks for payment to a different account");
  }
  if (asksNotToPay) {
    parts.push("asks to hold, cancel or not pay the invoice");
  }
  return parts.length > 0 ? parts.join(", ") : "nothing relevant found";
}

export interface EmailReader {
  // Shown next to the findings, so a person knows what read the emails.
  readonly name: string;
  read(emails: SupplierEmail[]): Promise<EmailFindings>;
}

// Lowercases A to Z only. toLowerCase also folds some letters outside ASCII into
// it: the Kelvin sign U+212A becomes k, which would let K-raft.test pass as
// kraft.test.
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter: string): string => letter.toLowerCase());
}

// An address of printable ASCII only. Anything else never matches a domain.
const PRINTABLE_ASCII: RegExp = /^[\x21-\x7e]+$/;

// Senders whose domain is not the one on file for the supplier, Reply-To
// addresses included, since replies going to another domain is how business
// email compromise usually works. This is a plain comparison in code, so it holds
// whatever the reader makes of the text. An address with any character outside
// printable ASCII is flagged, and the rest is compared with only A to Z
// lowercased. With no domain on file, as for a pay run row or a payout found
// outside PayOnce, there is nothing to check against, so every sender is flagged.
export function unverifiedSenders(
  emails: SupplierEmail[],
  domainOnFile: string,
): string[] {
  const expected: string = asciiLower(domainOnFile.trim());
  const senders: string[] = emails
    .flatMap((email: SupplierEmail): string[] => [email.from, ...(email.replyTo ?? [])])
    .map((address: string): string => asciiLower(address.trim()))
    .filter(
      (address: string): boolean =>
        expected === "" ||
        !PRINTABLE_ASCII.test(address) ||
        address.slice(address.lastIndexOf("@") + 1) !== expected,
    );
  return [...new Set<string>(senders)];
}

// The email evidence a person approves against: PayOnce's summary of the
// findings, how many emails are on file, how many have text nobody read, and how
// many senders the check flags. Never an address, a subject or any other text
// from an email. The count changes with every new email, so a new email voids an
// open approval and the approvers look again.
export function emailEvidence(
  summary: string,
  emails: SupplierEmail[],
  domainOnFile: string,
): string {
  if (emails.length === 0) {
    return summary;
  }
  const count: string = `${emails.length} ${emails.length === 1 ? "email" : "emails"} on file`;
  const partial: number = emails.filter((email: SupplierEmail): boolean => email.partial === true).length;
  const unread: string = partial === 0 ? "" : `, ${partial} with text PayOnce could not read`;
  const flagged: number = unverifiedSenders(emails, domainOnFile).length;
  const senders: string =
    flagged === 0
      ? ""
      : domainOnFile.trim() === ""
        ? `, no supplier domain on file to check ${flagged === 1 ? "1 sender" : `${flagged} senders`} against`
        : `, ${flagged} ${flagged === 1 ? "sender does" : "senders do"} not match the supplier on file`;
  return `${summary}, ${count}${unread}${senders}`;
}

// Fixture threads refer to their invoice as {{invoice}}.
export function loadEmails(name: string, invoiceId: string): SupplierEmail[] {
  const url: URL = new URL(`../fixtures/emails/${name}.json`, import.meta.url);
  const text: string = readFileSync(url, "utf8").replaceAll("{{invoice}}", invoiceId);
  return JSON.parse(text) as SupplierEmail[];
}

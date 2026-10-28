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
  replyTo?: string[];
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
  summary: string;
  // What read the thread, when that is more exact than the reader's name.
  readBy?: string;
}

// The summary a person reads. It is written here from the two findings, so no
// wording from an email or from a model reaches the approval card.
export function summarise(
  claimsNonReceipt: boolean,
  asksForNewBankDetails: boolean,
): string {
  const parts: string[] = [];
  if (claimsNonReceipt) {
    parts.push("supplier reports the payment has not arrived");
  }
  if (asksForNewBankDetails) {
    parts.push("asks for payment to a different account");
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

// Senders whose domain is not the one on file for the supplier. This is a plain
// comparison in code, so it holds whatever the reader makes of the text. An
// address with any character outside printable ASCII is flagged, and the rest is
// compared with only A to Z lowercased.
export function unverifiedSenders(
  emails: SupplierEmail[],
  domainOnFile: string,
): string[] {
  const expected: string = asciiLower(domainOnFile.trim());
  const senders: string[] = emails
    .map((email: SupplierEmail): string => asciiLower(email.from.trim()))
    .filter(
      (from: string): boolean =>
        !PRINTABLE_ASCII.test(from) || from.slice(from.lastIndexOf("@") + 1) !== expected,
    );
  return [...new Set<string>(senders)];
}

// Fixture threads refer to their invoice as {{invoice}}.
export function loadEmails(name: string, invoiceId: string): SupplierEmail[] {
  const url: URL = new URL(`../fixtures/emails/${name}.json`, import.meta.url);
  const text: string = readFileSync(url, "utf8").replaceAll("{{invoice}}", invoiceId);
  return JSON.parse(text) as SupplierEmail[];
}

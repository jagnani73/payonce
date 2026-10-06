import { readFileSync } from "node:fs";

export interface SupplierEmail {
  from: string;
  subject: string;
  body: string;
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

// Senders whose domain is not the one on file for the supplier. This is a plain
// comparison in code, so it holds whatever the reader makes of the text.
export function unverifiedSenders(
  emails: SupplierEmail[],
  domainOnFile: string,
): string[] {
  const expected: string = domainOnFile.toLowerCase();
  const senders: string[] = emails
    .map((email: SupplierEmail): string => email.from.trim().toLowerCase())
    .filter(
      (from: string): boolean => from.slice(from.lastIndexOf("@") + 1) !== expected,
    );
  return [...new Set<string>(senders)];
}

// Fixture threads refer to their invoice as {{invoice}}.
export function loadEmails(name: string, invoiceId: string): SupplierEmail[] {
  const url: URL = new URL(`../fixtures/emails/${name}.json`, import.meta.url);
  const text: string = readFileSync(url, "utf8").replaceAll("{{invoice}}", invoiceId);
  return JSON.parse(text) as SupplierEmail[];
}

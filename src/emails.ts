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
}

export interface EmailReader {
  read(emails: SupplierEmail[]): Promise<EmailFindings>;
}

export function loadEmails(name: string): SupplierEmail[] {
  const url: URL = new URL(`../fixtures/emails/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as SupplierEmail[];
}

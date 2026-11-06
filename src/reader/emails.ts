import { readFileSync } from "node:fs";
import type { EmailFindings, SupplierEmail } from "../domain/emails.js";

export interface EmailReader {
  // Shown next to the findings, so a person knows what read the emails.
  readonly name: string;
  read(emails: SupplierEmail[]): Promise<EmailFindings>;
}

// Fixture threads refer to their invoice as {{invoice}}.
export function loadEmails(name: string, invoiceId: string): SupplierEmail[] {
  const url: URL = new URL(`../../fixtures/emails/${name}.json`, import.meta.url);
  const text: string = readFileSync(url, "utf8").replaceAll("{{invoice}}", invoiceId);
  return JSON.parse(text) as SupplierEmail[];
}

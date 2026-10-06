import {
  summarise,
  type EmailFindings,
  type EmailReader,
  type SupplierEmail,
} from "./emails.js";

// Matches a handful of phrases and understands nothing else. It reads the emails
// when no model is set up, and runs beside the model when one is.
const NON_RECEIPT_PATTERNS: RegExp[] = [
  /(not|n't) (yet )?(been )?received/i,
  /(not|n't) (yet )?arrived/i,
  /nothing (has )?arrived/i,
  /still waiting (for|on)/i,
];

const NEW_BANK_DETAILS_PATTERNS: RegExp[] = [
  /new (bank )?account/i,
  /different (bank )?account/i,
  /(updated|changed) (our )?bank(ing)? details/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern: RegExp): boolean => pattern.test(text));
}

export class KeywordReader implements EmailReader {
  readonly name: string = "keyword placeholder";

  read(emails: SupplierEmail[]): Promise<EmailFindings> {
    const text: string = emails
      .map((email: SupplierEmail): string => `${email.subject}\n${email.body}`)
      .join("\n");
    const claimsNonReceipt: boolean = matchesAny(text, NON_RECEIPT_PATTERNS);
    const asksForNewBankDetails: boolean = matchesAny(
      text,
      NEW_BANK_DETAILS_PATTERNS,
    );
    return Promise.resolve({
      claimsNonReceipt,
      asksForNewBankDetails,
      summary: summarise(claimsNonReceipt, asksForNewBankDetails),
    });
  }
}

import type { EmailFindings, EmailReader, SupplierEmail } from "./emails.js";

// Placeholder until a model is connected. It matches a handful of phrases and
// understands nothing else.
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
  read(emails: SupplierEmail[]): Promise<EmailFindings> {
    const text: string = emails
      .map((email: SupplierEmail): string => `${email.subject}\n${email.body}`)
      .join("\n");
    const claimsNonReceipt: boolean = matchesAny(text, NON_RECEIPT_PATTERNS);
    const asksForNewBankDetails: boolean = matchesAny(
      text,
      NEW_BANK_DETAILS_PATTERNS,
    );

    const parts: string[] = [];
    if (claimsNonReceipt) {
      parts.push("supplier reports the payment has not arrived");
    }
    if (asksForNewBankDetails) {
      parts.push("asks for payment to a different account");
    }
    return Promise.resolve({
      claimsNonReceipt,
      asksForNewBankDetails,
      summary: parts.length > 0 ? parts.join(", ") : "nothing relevant found",
    });
  }
}

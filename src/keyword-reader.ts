import {
  summarise,
  type EmailFindings,
  type EmailReader,
  type SupplierEmail,
} from "./emails.js";

// Matches a handful of phrases and understands nothing else. It reads the emails
// when no model is set up, and runs beside the model when one is. The text is
// normalised first, so the single spaces and straight apostrophes below also
// match wrapped lines and typographic quotes.
const NON_RECEIPT_PATTERNS: RegExp[] = [
  /(not|n't) (yet )?(been )?received/i,
  /(not|n't) (yet )?arrived/i,
  /nothing (has )?arrived/i,
  /still waiting (for|on)/i,
  /never (been )?(arrived|received)/i,
  /did ?(not|n't) (yet )?(receive|arrive|get)/i,
  /\bmissing\b/i,
];

const NEW_BANK_DETAILS_PATTERNS: RegExp[] = [
  /new (bank )?account/i,
  /different (bank )?account/i,
  /(updated|changed) (our )?bank(ing)? details/i,
];

// Letters that draw as a blank, which a sender can put between two words.
const BLANK_LETTERS: RegExp = /[ᅟᅠㅤﾠ⠀]/g;
// Characters a mail client does not draw, such as soft hyphens, zero-width
// spaces, joiners and bidi controls.
const INVISIBLE: RegExp = /\p{Default_Ignorable_Code_Point}/gu;
const APOSTROPHES: RegExp = /[‘’ʼ′＇]/g;

// What the patterns read: fullwidth letters folded by NFKC, invisible characters
// gone, apostrophes straight and every run of whitespace, line breaks included,
// one space.
export function keywordText(text: string): string {
  return text
    .replace(BLANK_LETTERS, " ")
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .replace(APOSTROPHES, "'")
    .replace(/\s+/g, " ");
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern: RegExp): boolean => pattern.test(text));
}

export class KeywordReader implements EmailReader {
  readonly name: string = "keyword placeholder";

  read(emails: SupplierEmail[]): Promise<EmailFindings> {
    const text: string = keywordText(
      emails.map((email: SupplierEmail): string => `${email.subject}\n${email.body}`).join("\n"),
    );
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

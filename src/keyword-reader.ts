import {
  summarise,
  type EmailAttachment,
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

// Holding a payment, an invoice or a transfer counts. Holding the next shipment
// does not.
const NOT_TO_PAY_PATTERNS: RegExp[] = [
  /\b(do ?not|don't) (yet )?(pay|process|send|release|remit)\b/i,
  /\b(hold|stop|cancel|void|withdraw|suspend|pause|halt) (the |this |that |our |any |your )?(payment|invoice|transfer|remittance|bill)/i,
  /\b(sent|issued|raised|billed) (to you )?in error\b/i,
  /\bplease (disregard|ignore)\b/i,
  /\b(disregard|ignore) (the |this |that |our |my )?(previous |last |earlier |attached |above )?(invoice|bill|payment request)/i,
  /\b(invoice|bill|payment request) (has been |was |is )?(cancell?ed|withdrawn|voided|void)\b/i,
  /\balready (been )?(paid|settled) (by|via|through|outside|separately|another)\b/i,
];

// Letters that draw as a blank, which a sender can put between two words.
const BLANK_LETTERS: RegExp = /[\u115F\u1160\u3164\uFFA0\u2800]/g;
// Characters a mail client does not draw, such as soft hyphens, zero-width
// spaces, joiners and bidi controls.
const INVISIBLE: RegExp = /\p{Default_Ignorable_Code_Point}/gu;
const APOSTROPHES: RegExp = /[\u2018\u2019\u02BC\u2032\uFF07]/g;

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

// The subject, the text, the text found inside its styles and the names of the
// attachments, which a person sees too, so a file named "new bank details.pdf"
// counts.
function readable(email: SupplierEmail): string {
  return [
    email.subject,
    email.body,
    email.styleText ?? "",
    ...(email.attachments ?? []).map((attachment: EmailAttachment): string => attachment.name),
  ].join("\n");
}

export class KeywordReader implements EmailReader {
  readonly name: string = "keyword placeholder";

  read(emails: SupplierEmail[]): Promise<EmailFindings> {
    const text: string = keywordText(emails.map(readable).join("\n"));
    const claimsNonReceipt: boolean = matchesAny(text, NON_RECEIPT_PATTERNS);
    const asksForNewBankDetails: boolean = matchesAny(
      text,
      NEW_BANK_DETAILS_PATTERNS,
    );
    const asksNotToPay: boolean = matchesAny(text, NOT_TO_PAY_PATTERNS);
    return Promise.resolve({
      claimsNonReceipt,
      asksForNewBankDetails,
      asksNotToPay,
      summary: summarise(claimsNonReceipt, asksForNewBankDetails, asksNotToPay),
    });
  }
}

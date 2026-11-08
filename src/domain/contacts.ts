// A supplier record's phone number on file: what a person may type, where they
// say it came from, the blind re-key, the emails it appears in, when a proposal
// lapses and the timeline lines. Pure: the ledger keeps the rows
// (store/contacts.ts) and runs each change in one transaction.

export type ContactField = "phone";

// proposed waits for a second person. on_file is the record's number, '' for none
// on file once one was removed. replaced, withdrawn and lapsed are closed.
export type ContactState = "proposed" | "on_file" | "replaced" | "withdrawn" | "lapsed";

// person: two people put it on file. scenario: the demo scenario did.
// migrated: it was on an invoice before PayOnce kept who set it.
export type ContactOrigin = "person" | "scenario" | "migrated";

// Where a person says the number comes from. Never an email or the Airwallex
// record.
export type ContactSource = "contract" | "website" | "known-number" | "in-person" | "other";

export interface Contact {
  id: number;
  beneficiaryId: string;
  field: ContactField;
  value: string;
  digits: string;
  replacesId: number | null;
  state: ContactState;
  origin: ContactOrigin;
  proposedBy: string | null;
  proposedAt: string;
  proposedSource: string;
  proposedNote: string;
  seenInEmails: number;
  seenFlagged: number;
  confirmedBy: string | null;
  confirmedAt: string | null;
  confirmedSource: string | null;
  confirmedNote: string | null;
  closedBy: string | null;
  closedAt: string | null;
  closeNote: string | null;
  // How many approval requests the change withdrew when it went on file.
  withdrawnRequests: number;
}

// What a refusal is: what was typed, who typed it, a proposal that is not there,
// or the ledger as it is now.
export type ContactRefusal = "input" | "refused" | "unknown" | "conflict";

export class ContactError extends Error {
  readonly why: ContactRefusal;

  constructor(why: ContactRefusal, message: string) {
    super(message);
    this.why = why;
  }
}

export const CONTACT_SOURCES: Record<ContactSource, { words: string; label: string }> = {
  contract: { words: "the supplier's contract or onboarding form", label: "supplier's contract" },
  website: { words: "the supplier's website", label: "supplier's website" },
  "known-number": { words: "a call to a number already known for the supplier", label: "call to a known number" },
  "in-person": { words: "the supplier in person", label: "in person" },
  other: { words: "another source", label: "other source" },
};

export const PROPOSAL_LAPSES_MS: number = 72 * 60 * 60_000;
// A number that replaced another this recently is shown as changed.
export const CHANGED_RECENTLY_MS: number = 7 * 24 * 60 * 60_000;

const MIN_DIGITS: number = 8;
const MAX_DIGITS: number = 15;
// A number written without its country code, as it may be in an email.
const NATIONAL_DIGITS: number = 10;
const MAX_NOTE_LENGTH: number = 200;

export const CONTACT_NOTICE: string =
  "PayOnce never takes a phone number from an email or from the Airwallex record. Check it in the supplier's contract or on their website, or call the number on file, before you propose it.";
export const PROPOSAL_BLOCKS_CALLBACK: string =
  "A new phone number for this supplier is waiting for a second person. Record the callback once it is confirmed or withdrawn";
export const PHONE_CHANGED_WHILE_RECORDING: string =
  "The phone number on file changed while you recorded the callback. Call the number on file now and record it again";
export const RUN_ROW_WAITS: string =
  "A pay run row to this supplier was released on a callback and has not gone to the bank yet. Change the phone number once it has";
export const CALLBACK_REQUEST_VOIDED: string =
  "Approval request withdrawn: the supplier's phone number on file changed after the callback it relies on";

export function isContactSource(value: string): value is ContactSource {
  return Object.hasOwn(CONTACT_SOURCES, value);
}

export function phoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

export function phoneEnding(value: string | null): string | null {
  const digits: string = phoneDigits(value ?? "");
  return digits === "" ? null : digits.slice(-4);
}

// The number dialled is the one on file, with or without its country code.
export function isNumberOnFile(dialled: string, onFile: string): boolean {
  const typed: string = phoneDigits(dialled);
  const file: string = phoneDigits(onFile);
  return typed === file || (typed.length >= 10 && file.endsWith(typed));
}

// A phone number a person typed, in international form: a +, the country code
// and the number, 8 to 15 digits, split by spaces, dashes, dots or brackets, kept
// with each run of those as one space. '' is none on file, for a removal.
export function typedPhone(typed: string): { value: string; digits: string } {
  const text: string = typed.trim();
  if (text === "") {
    return { value: "", digits: "" };
  }
  const digits: string = phoneDigits(text);
  if (!/^\+\s*[1-9][0-9 ().-]*$/.test(text) || digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
    throw new ContactError(
      "input",
      "Enter the phone number in international form: a + and the country code, then the number, 8 to 15 digits in all, such as +44 20 7946 0958",
    );
  }
  return { value: `+${text.slice(1).replace(/[\s().-]+/g, " ").trim()}`, digits };
}

export function sourceOf(typed: string): ContactSource {
  if (!isContactSource(typed)) {
    throw new ContactError(
      "input",
      "Pick where the number comes from: the supplier's contract or onboarding form, their website, a call to a number already known for them, in person, or another source",
    );
  }
  return typed;
}

// A note, which another source must have.
export function noteFor(source: ContactSource, note: string): string {
  if (note.length > MAX_NOTE_LENGTH) {
    throw new ContactError("input", `Keep the note to ${MAX_NOTE_LENGTH} characters`);
  }
  if (source === "other" && note === "") {
    throw new ContactError("input", "Say in the note what the other source is");
  }
  return note;
}

export function withdrawNote(note: string): string {
  if (note === "" || note.length > MAX_NOTE_LENGTH) {
    throw new ContactError("input", "Say in a note of up to 200 characters why you withdraw it");
  }
  return note;
}

// The blind re-key: the confirmer typed the number from their own source.
export function sameNumber(proposed: Pick<Contact, "digits">, typed: { digits: string }): boolean {
  return proposed.digits === typed.digits;
}

export function lapsed(proposal: Pick<Contact, "proposedAt">, now: number): boolean {
  const at: number = Date.parse(proposal.proposedAt);
  return !Number.isFinite(at) || now - at >= PROPOSAL_LAPSES_MS;
}

export function lapsesAt(proposal: Pick<Contact, "proposedAt">): string | null {
  const at: number = Date.parse(proposal.proposedAt);
  return Number.isFinite(at) ? new Date(at + PROPOSAL_LAPSES_MS).toISOString() : null;
}

// A proposal still waiting for a second person.
export function waiting(contact: Pick<Contact, "state" | "proposedAt">, now: number): boolean {
  return contact.state === "proposed" && !lapsed(contact, now);
}

// One email's text and whether the sender check flags who sent it.
export interface EmailText {
  text: string;
  flagged: boolean;
}

// How many supplier emails on file hold these digits, written with any spacing,
// in full or without their country code, and how many of those the sender
// check flags. A warning, never a refusal: a real signature carries the real
// number.
export function seenInEmails(digits: string, emails: EmailText[]): { seen: number; flagged: number } {
  if (digits === "") {
    return { seen: 0, flagged: 0 };
  }
  const spaced = (part: string): string => part.split("").join("[\\s().-]*");
  const national: string = digits.slice(-Math.min(digits.length, NATIONAL_DIGITS));
  const pattern: RegExp = new RegExp(`(?<!\\d)(?:${spaced(digits)}|${spaced(national)})(?!\\d)`);
  const holding: EmailText[] = emails.filter((email: EmailText): boolean => pattern.test(email.text));
  return { seen: holding.length, flagged: holding.filter((email: EmailText): boolean => email.flagged).length };
}

function emailsClause(seen: number, flagged: number): string {
  if (seen === 0) {
    return "";
  }
  return `. A number with these digits appears in ${seen} supplier ${seen === 1 ? "email" : "emails"} on file${flagged === 0 ? "" : `, ${flagged} from a sender the check flags`}`;
}

function wordsOf(source: string | null): string {
  return source !== null && isContactSource(source) ? CONTACT_SOURCES[source].words : "a source PayOnce does not know";
}

export function sourceLabel(source: string | null): string | null {
  return source !== null && isContactSource(source) ? CONTACT_SOURCES[source].label : null;
}

function endingText(value: string): string {
  const ending: string | null = phoneEnding(value);
  return ending === null ? "the one on file" : `the one on file ending ${ending}`;
}

// The proposal's line. replaced is the number on file it would take the place of.
export function proposalLine(proposal: Contact, replaced: Contact | undefined): string {
  const by: string = proposal.proposedBy ?? "Someone";
  const from: string = wordsOf(proposal.proposedSource);
  const seen: string = emailsClause(proposal.seenInEmails, proposal.seenFlagged);
  const old: string | null = replaced === undefined || replaced.value === "" ? null : replaced.value;
  if (proposal.value === "") {
    const removed: string | null = old === null ? null : phoneEnding(old);
    return `${by} proposed removing the phone number on file${removed === null ? "" : ` ending ${removed}`} for this supplier, from ${from}. It comes off file only when someone else confirms it from their own source`;
  }
  const ending: string = phoneEnding(proposal.value) ?? "";
  const what: string =
    old === null
      ? `a phone number ending ${ending} for this supplier`
      : `a new phone number ending ${ending} for this supplier in place of ${endingText(old)}`;
  return `${by} proposed ${what}, from ${from}. It goes on file only when someone else finds the same number in their own source and confirms it${seen}`;
}

// The confirm's line, the record of what went on file, with the full number.
export function confirmLine(confirmed: Contact, replaced: Contact | undefined): string {
  const by: string = confirmed.confirmedBy ?? "Someone";
  const proposer: string = confirmed.proposedBy ?? "someone";
  const from: string = wordsOf(confirmed.confirmedSource);
  const old: string | null = replaced === undefined || replaced.value === "" ? null : replaced.value;
  const retired: string = old === null ? "" : `. A callback made on the old number no longer verifies bank details`;
  if (confirmed.value === "") {
    return `${by} confirmed the removal ${proposer} proposed, from ${from}, so this supplier has no phone number on file${old === null ? "" : ` in place of ${old}`}${retired}`;
  }
  return `${by} confirmed the phone number ${proposer} proposed, from ${from}, and ${confirmed.value} is now this supplier's phone number on file${old === null ? "" : ` in place of ${old}`}${retired}`;
}

export function withdrawLine(proposal: Contact, by: string, note: string): string {
  return proposal.value === ""
    ? `${by} withdrew the proposed removal of the phone number on file: ${note}`
    : `${by} withdrew the proposed phone number ending ${phoneEnding(proposal.value) ?? ""}: ${note}`;
}

export function lapseLine(proposal: Pick<Contact, "value">): string {
  return proposal.value === ""
    ? "The proposed removal of the phone number on file was not confirmed within 72 hours, so it lapsed"
    : `The proposed phone number ending ${phoneEnding(proposal.value) ?? ""} was not confirmed within 72 hours, so it lapsed`;
}

export function scenarioLine(value: string): string {
  return `The demo scenario put ${value} on file as the supplier's phone number`;
}

// "row 3 pays", "rows 3 and 5 pay"
export function runRequestVoided(lines: number[]): string {
  const rows: string =
    lines.length === 1
      ? `row ${lines[0]} pays`
      : `rows ${lines.slice(0, -1).join(", ")} and ${lines.at(-1)} pay`;
  return lines.length === 1
    ? `Approval request withdrawn: the phone number on file for the supplier ${rows} changed after the callback the row relies on`
    : `Approval request withdrawn: the phone number on file for the supplier ${rows} changed after the callbacks the rows rely on`;
}

export function proposalWaits(proposal: Pick<Contact, "proposedBy">): string {
  return `A new phone number for this supplier is waiting for a second person (proposed by ${proposal.proposedBy ?? "someone"}). Confirm or withdraw it first`;
}

// Why the person who proposed or confirmed the number on file may not record a
// callback on it.
export function setterCalls(name: string, role: "proposed" | "confirmed"): string {
  return `${name} ${role} the phone number on file, so someone else calls it and records the callback`;
}

export function selfConfirm(name: string): string {
  return `${name} proposed this phone number, so someone else confirms it from their own source`;
}

export function notTheNumber(proposal: Contact): string {
  return `That is not the number ${proposal.proposedBy ?? "the proposer"} proposed. Check your source again. If the proposal is wrong, withdraw it`;
}

const CLOSED_WORDS: Record<ContactState, string> = {
  proposed: "is waiting",
  on_file: "was confirmed",
  replaced: "was confirmed and has been replaced since",
  withdrawn: "was withdrawn",
  lapsed: "lapsed",
};

export function notWaiting(proposal: Contact): string {
  return `That proposal is no longer waiting: it ${CLOSED_WORDS[proposal.state]}`;
}

// Why the phone setters of a callback may not approve payments to the account it
// verified.
export function setterBarWhy(role: "proposed" | "confirmed"): string {
  return `${role} the phone number the callback was made on`;
}

import { personName } from "../domain/approvers.js";
import {
  ContactError,
  noteFor,
  seenInEmails,
  sourceOf,
  typedPhone,
  withdrawNote,
  type ContactField,
  type ContactSource,
  type EmailText,
} from "../domain/contacts.js";
import { unverifiedSenders, type SupplierEmail } from "../reader/emails.js";
import type { ContactChange, Ledger, Obligation } from "../store/ledger.js";

// A person putting a phone number on file for a supplier record, or changing or
// removing it: one proposes it, a different person confirms it by typing it
// again from their own source, and anyone may withdraw a proposal. The number
// only ever comes from what a person types here, never from an email, the
// reader, the Airwallex record or a pay run file. None of these runs in an
// invoice's turn: each is one ledger transaction, and the caller wakes the
// invoices it returns.

export interface ContactProposal {
  field: string;
  value: string;
  name: string;
  source: string;
  note: string;
}

export interface ContactConfirmation {
  value: string;
  name: string;
  source: string;
  note: string;
}

function fieldOf(typed: string): ContactField {
  if (typed !== "phone") {
    throw new ContactError("input", "Only a phone number can be put on file here");
  }
  return typed;
}

// Every supplier email on file for the record's invoices, with whether the
// sender check flags who sent it, for the seen-in-email count.
function emailTexts(ledger: Ledger, beneficiaryId: string): EmailText[] {
  return ledger.obligationsFor(beneficiaryId).flatMap((obligation: Obligation): EmailText[] =>
    ledger.emails(obligation.invoiceId).map(
      (email: SupplierEmail): EmailText => ({
        text: [email.subject, email.body, email.styleText ?? ""].join("\n"),
        flagged: unverifiedSenders([email], obligation.supplierDomain).length > 0,
      }),
    ),
  );
}

export function proposeContact(
  ledger: Ledger,
  beneficiaryId: string,
  input: ContactProposal,
  now: number = Date.now(),
): ContactChange {
  const field: ContactField = fieldOf(input.field);
  const proposedBy: string = personName(input.name);
  const typed: { value: string; digits: string } = typedPhone(input.value);
  const source: ContactSource = sourceOf(input.source);
  const note: string = noteFor(source, input.note);
  const seen: { seen: number; flagged: number } = seenInEmails(typed.digits, emailTexts(ledger, beneficiaryId));
  return ledger.proposeContact(
    {
      beneficiaryId,
      field,
      value: typed.value,
      digits: typed.digits,
      proposedBy,
      source,
      note,
      seenInEmails: seen.seen,
      seenFlagged: seen.flagged,
    },
    now,
  );
}

export function confirmContact(
  ledger: Ledger,
  beneficiaryId: string,
  id: number,
  input: ContactConfirmation,
  now: number = Date.now(),
): ContactChange {
  const confirmedBy: string = personName(input.name);
  const typed: { value: string; digits: string } = typedPhone(input.value);
  const source: ContactSource = sourceOf(input.source);
  return ledger.confirmContact(
    beneficiaryId,
    id,
    { value: typed.value, digits: typed.digits, confirmedBy, source, note: noteFor(source, input.note) },
    now,
  );
}

export function withdrawContact(
  ledger: Ledger,
  beneficiaryId: string,
  id: number,
  name: string,
  note: string,
  now: number = Date.now(),
): ContactChange {
  return ledger.withdrawContact(beneficiaryId, id, personName(name), withdrawNote(note), now);
}

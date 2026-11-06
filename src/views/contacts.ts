import { CONTACT_NOTICE, lapseLine, proposalWaits, type Contact } from "../domain/contacts.js";
import type { Ledger } from "../store/ledger.js";
import type {
  Can,
  IncidentPhoneView,
  PhoneOnFileView,
  PhoneProposalView,
  PhoneVersionView,
  SupplierContactDetail,
  SupplierContactView,
} from "./contract.js";
import { allowed, refused } from "./parts.js";
import { supplierDetail, type ContactBlock, type PhoneOnFile, type PhoneProposal, type PhoneVersion, type SupplierDetail } from "./suppliers.js";

// The supplier record's phone on file as the record page, the payment page's
// callback and approval cards and the contact route show it, from the supplier
// read model's contact block.

const ORIGIN_TEXT: Record<PhoneOnFile["origin"], string> = {
  person: "",
  scenario: "put on file by the demo scenario",
  migrated: "on file before PayOnce kept who set it",
};

const HOUR_MS: number = 60 * 60_000;

// "2 hours ago", "3 days ago"
function ago(at: string | null, now: number): string {
  const ms: number = now - Date.parse(at ?? "");
  if (!Number.isFinite(ms)) {
    return "recently";
  }
  const hours: number = Math.floor(ms / HOUR_MS);
  if (hours < 1) {
    return "less than an hour ago";
  }
  if (hours < 48) {
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  return `${Math.floor(hours / 24)} days ago`;
}

export function phoneOnFileView(phone: PhoneOnFile | null, now: number): PhoneOnFileView | null {
  if (phone === null) {
    return null;
  }
  return {
    contactId: phone.id,
    ending: phone.ending,
    removed: phone.removed,
    origin: phone.origin,
    originText: ORIGIN_TEXT[phone.origin],
    // A migrated number's own time is when PayOnce moved it, not when it went on file.
    since: phone.origin === "migrated" ? null : phone.since,
    proposedBy: phone.proposedBy,
    proposedSource: phone.proposedSource,
    confirmedBy: phone.confirmedBy,
    confirmedSource: phone.confirmedSource,
    replacedEnding: phone.replacedEnding,
    changed: phone.changedRecently
      ? {
          text: `This number replaced the one on file ${ago(phone.since, now)}. A changed number shortly before new bank details is how callback fraud works.`,
        }
      : null,
  };
}

function proposalView(proposal: PhoneProposal | null): PhoneProposalView | null {
  return proposal === null
    ? null
    : {
        contactId: proposal.id,
        ending: proposal.ending,
        removal: proposal.removal,
        replacesEnding: proposal.replacesEnding,
        proposedBy: proposal.proposedBy,
        proposedAt: proposal.proposedAt,
        source: proposal.source,
        note: proposal.note,
        seenInEmails: proposal.seenInEmails,
        seenFlagged: proposal.seenFlagged,
        lapsesAt: proposal.lapsesAt,
        lapsed: proposal.lapsed,
      };
}

function versionView(version: PhoneVersion): PhoneVersionView {
  return {
    contactId: version.id,
    ending: version.ending,
    state: version.state,
    origin: version.origin,
    proposedBy: version.proposedBy,
    proposedAt: version.proposedAt,
    confirmedBy: version.confirmedBy,
    confirmedAt: version.confirmedAt,
    closedBy: version.closedBy,
    closedAt: version.closedAt,
    closeNote: version.closeNote,
  };
}

// A refusal PayOnce words as a thrown message, as a sentence for the page.
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// What a person can do with the record's phone now: propose a number unless one
// waits, and confirm or withdraw the one that waits.
function actionsOf(proposal: PhoneProposal | null): Record<string, Can> {
  const none: Can = refused("no-phone-proposal", "No new phone number for this supplier waits for a second person.");
  if (proposal === null) {
    return { propose: allowed(), confirm: none, withdraw: none };
  }
  const value: string = proposal.removal ? "" : (proposal.ending ?? "");
  return {
    propose: proposal.lapsed ? allowed() : refused("phone-proposal-waits", sentence(proposalWaits(proposal))),
    confirm: proposal.lapsed ? refused("phone-proposal-lapsed", `${lapseLine({ value })}. Propose it again.`) : allowed(),
    withdraw: allowed(),
  };
}

export function contactView(detail: SupplierDetail, now: number): SupplierContactView {
  const block: ContactBlock = detail.contact;
  const person: boolean = block.phone?.origin === "person";
  return {
    phoneEnding: detail.phoneLast4,
    emailDomains: detail.domains.map((domain: SupplierDetail["domains"][number]) => ({
      domain: domain.domain,
      payments: domain.invoices,
      first: domain.first,
      newest: domain.newest,
    })),
    changedBy: person ? (block.phone?.confirmedBy ?? null) : null,
    changedAt: person ? (block.phone?.since ?? null) : null,
    pending:
      block.proposal === null || block.proposal.lapsed
        ? []
        : [
            {
              field: "phone",
              ending: block.proposal.ending,
              proposedBy: block.proposal.proposedBy ?? "",
              proposedAt: block.proposal.proposedAt ?? "",
            },
          ],
    actions: actionsOf(block.proposal),
    phone: phoneOnFileView(block.phone, now),
    proposal: proposalView(block.proposal),
    history: block.history.map(versionView),
    callbackBarred: block.callbackBarred,
    notice: CONTACT_NOTICE,
  };
}

// The payment page's part: the record's phone on file, a proposal waiting, and
// whether the latest request's callback was made on the number on file now.
export function incidentPhone(ledger: Ledger, detail: SupplierDetail | null, callbackId: number | null, now: number): IncidentPhoneView {
  const block: ContactBlock | null = detail?.contact ?? null;
  const proposal: PhoneProposal | null = block?.proposal ?? null;
  const contactId: number | null = callbackId === null ? null : (ledger.bankChange(callbackId)?.contactId ?? null);
  return {
    onFile: phoneOnFileView(block?.phone ?? null, now),
    pending:
      proposal === null || proposal.lapsed
        ? null
        : { ending: proposal.ending, proposedBy: proposal.proposedBy, proposedAt: proposal.proposedAt },
    requestCallbackOnFile: callbackId === null ? null : contactId !== null && contactId === (block?.phone?.id ?? null),
  };
}

// GET /api/suppliers/:key/contact, or null for a record nothing names.
export function contactDetailView(ledger: Ledger, key: string, now: number): SupplierContactDetail | null {
  const detail: SupplierDetail | null = supplierDetail(ledger, key, now);
  if (detail === null) {
    return null;
  }
  const onFile: Contact | undefined = ledger.contactOnFile(key, "phone");
  const phone: PhoneOnFileView | null = phoneOnFileView(detail.contact.phone, now);
  return {
    view: "supplier-contact",
    key,
    phone: phone === null || onFile?.id !== phone.contactId ? null : { ...phone, value: onFile.value },
    proposal: proposalView(detail.contact.proposal),
    history: detail.contact.history.map(versionView),
    notice: CONTACT_NOTICE,
  };
}

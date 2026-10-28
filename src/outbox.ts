import {
  createDraft,
  DRAFT_TEMPLATES,
  isTemplate,
  markDraft,
  outboxOf,
  type DraftView,
  type Outbox,
} from "./drafts.js";
import { INVOICE_ID_PATTERN, Ledger, LEDGER_PATH, type Obligation } from "./ledger.js";

// Messages to the supplier or the bank for a person to send. PayOnce never sends
// them. Reads and writes only the ledger, with no Airwallex call.
const USAGE: string = `Usage:
  pnpm outbox <INVOICE>                          drafts and the messages that fit now
  pnpm outbox <INVOICE> draft <TEMPLATE> <NAME>  draft one and print it
  pnpm outbox <INVOICE> show <DRAFT>             print a draft, whether it is intact, and what changed
  pnpm outbox <INVOICE> sent <DRAFT> <NAME>      record that you sent it
  pnpm outbox <INVOICE> dismiss <DRAFT> <NAME> [NOTE]
Templates: ${DRAFT_TEMPLATES.join(", ")}`;

const MAX_NAME_LENGTH: number = 80;
const MAX_NOTE_LENGTH: number = 200;

function fail(message: string): void {
  console.log(message);
  process.exitCode = 1;
}

function printDraft(draft: DraftView): void {
  console.log(`Draft ${draft.id} for the ${draft.audience}: ${draft.label} (${draft.state})`);
  console.log(`  drafted by ${draft.createdBy} at ${draft.createdAt}`);
  if (draft.sentBy !== null) {
    console.log(`  marked sent by ${draft.sentBy} at ${draft.sentAt ?? ""}`);
  }
  if (draft.dismissedBy !== null) {
    console.log(`  dismissed by ${draft.dismissedBy}${draft.dismissNote === null ? "" : `: ${draft.dismissNote}`}`);
  }
  console.log(`  text SHA-256 ${draft.textHash}`);
  if (!draft.intact) {
    console.log("  WARNING: this text no longer matches the hash recorded on the timeline when it was drafted");
  }
  if (draft.noLongerFits !== null) {
    console.log(`  Since it was drafted, it no longer fits: ${draft.noLongerFits}`);
  } else if (draft.changed !== null && draft.changed.length > 0) {
    console.log(`  Since it was drafted, ${draft.changed.join(", ")}`);
  }
  console.log("");
  console.log(`Subject: ${draft.subject}`);
  console.log("");
  console.log(draft.body);
}

function list(outbox: Outbox, invoiceId: string): void {
  if (outbox.drafts.length === 0) {
    console.log(`${invoiceId} has no message drafts`);
  }
  for (const draft of outbox.drafts) {
    const note: string =
      draft.noLongerFits !== null
        ? `, no longer fits: ${draft.noLongerFits}`
        : draft.changed !== null && draft.changed.length > 0
          ? `, changed since: ${draft.changed.join(", ")}`
          : "";
    console.log(`  draft ${String(draft.id).padEnd(4)} ${draft.state.padEnd(9)} ${draft.label} (${draft.audience})${draft.intact ? "" : ", text does not match its hash"}${note}`);
  }
  if (outbox.offers.length > 0) {
    console.log("Messages that fit now:");
  }
  for (const offer of outbox.offers) {
    console.log(`  ${offer.suggested ? "suggested" : "         "} ${offer.template.padEnd(17)} ${offer.label} (${offer.audience})${offer.why === null ? "" : `: ${offer.why}`}`);
  }
  for (const item of outbox.notOffered) {
    console.log(`  not offered: ${item.label}. ${item.why}`);
  }
  if (outbox.withheld.length > 0) {
    console.log(
      `No message to the supplier is suggested, because they asked to hold, cancel or not pay this invoice. To draft one anyway: pnpm outbox ${invoiceId} draft <TEMPLATE> <NAME>`,
    );
  }
  for (const offer of outbox.withheld) {
    console.log(`  held back ${offer.template.padEnd(17)} ${offer.label} (${offer.audience})`);
  }
  console.log("PayOnce never sends these. Copy one into your own email, send it to the contact on file, then record it with pnpm outbox <INVOICE> sent <DRAFT> <NAME>.");
}

function draftId(raw: string | undefined): number | null {
  return raw !== undefined && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : null;
}

function main(): void {
  const [invoiceId, action, arg, name, ...rest] = process.argv.slice(2);
  if (invoiceId === undefined || !INVOICE_ID_PATTERN.test(invoiceId)) {
    fail(USAGE);
    return;
  }
  const ledger: Ledger = new Ledger(LEDGER_PATH);
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  if (obligation === undefined) {
    fail(`${invoiceId} is not in the ledger`);
    return;
  }
  const person: string = (name ?? "").trim();
  if (person.length > MAX_NAME_LENGTH) {
    fail("That name is too long");
    return;
  }
  try {
    if (action === undefined) {
      list(outboxOf(ledger, obligation), invoiceId);
    } else if (action === "draft") {
      if (!isTemplate(arg) || person === "") {
        fail(USAGE);
        return;
      }
      printDraft(createDraft(ledger, obligation, arg, person));
    } else if (action === "show") {
      const id: number | null = draftId(arg);
      const draft: DraftView | undefined = outboxOf(ledger, obligation).drafts.find(
        (item: DraftView): boolean => item.id === id,
      );
      if (draft === undefined) {
        fail(`Draft ${arg ?? ""} is not a draft for ${invoiceId}`);
        return;
      }
      printDraft(draft);
    } else if (action === "sent" || action === "dismiss") {
      const id: number | null = draftId(arg);
      const note: string = rest.join(" ").trim();
      if (id === null || person === "" || note.length > MAX_NOTE_LENGTH) {
        fail(USAGE);
        return;
      }
      markDraft(ledger, obligation, id, action === "sent" ? "sent" : "dismissed", person, note === "" ? null : note);
    } else {
      fail(USAGE);
    }
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main();

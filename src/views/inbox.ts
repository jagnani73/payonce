import { situationOf, type InvoiceSnapshot, type Situation } from "../domain/situation.js";
import { MAX_EMAIL_BYTES, noteTexts } from "../intake/eml.js";
import { candidatesFor, invoiceIndex, type Candidate, type InvoiceIndex, type Match } from "../intake/intake.js";
import type { Settings } from "../settings.js";
import { readingSoft, storedObject, type Ledger, type Upload, type UploadState } from "../store/ledger.js";
import { capitalise } from "../text/printable.js";
import type { CandidateView, Can, InboxItemView, InboxListView, UploadRow } from "./contract.js";
import { readerOf, snapshotOptions } from "./context.js";
import { allowed, money, refused } from "./parts.js";
import { readInvoiceSnapshots } from "./snapshot.js";

// The inbox of uploaded supplier emails: the list by tab, and one upload with
// the payments it may be about.

// Uploads that are not waiting, shown after the waiting ones.
const OTHERS_SHOWN: number = 50;

const TABS: { state: UploadState; label: string }[] = [
  { state: "waiting", label: "Waiting" },
  { state: "delivered", label: "Delivered" },
  { state: "dismissed", label: "Dismissed" },
];

const READER_NOTICE: string = "A model on Google's free tier reads uploaded emails. Don't upload anything you can't share with Google.";

function labelOf(upload: Upload, suggested: string | null): string {
  switch (upload.state) {
    case "waiting":
      return suggested === null ? "No match" : `Suggests ${suggested}`;
    case "delivered":
      return `Delivered to ${upload.invoiceId ?? "a payment"}`;
    case "dismissed":
      return `Dismissed by ${upload.dismissedBy ?? "a person"}`;
  }
}

function rowOf(upload: Upload, suggested: string | null): UploadRow {
  return {
    id: upload.id,
    from: upload.sender,
    fromName: upload.senderName === "" ? null : upload.senderName,
    subject: upload.subject,
    uploadedBy: upload.uploadedBy,
    uploadedAt: upload.uploadedAt,
    state: upload.state,
    label: labelOf(upload, suggested),
    partial: upload.partial,
    suggested,
    invoiceId: upload.invoiceId,
  };
}

// tab: the uploads in one state, or every upload the inbox shows.
export function inboxView(ledger: Ledger, settings: Settings, _now: number, tab: UploadState | null = null): InboxListView {
  return readingSoft((): InboxListView => {
    const uploads: Upload[] = ledger.uploads(OTHERS_SHOWN);
    let index: InvoiceIndex | undefined;
    const reader: { name: string; isModel: boolean } = readerOf(settings);
    return {
      view: "inbox",
      tabs: TABS.map((item: { state: UploadState; label: string }) => ({
        ...item,
        count: uploads.filter((upload: Upload): boolean => upload.state === item.state).length,
      })),
      rows: uploads
        .filter((upload: Upload): boolean => tab === null || upload.state === tab)
        .map((upload: Upload): UploadRow =>
          rowOf(upload, upload.state === "waiting" ? candidatesFor(ledger, upload, (index ??= invoiceIndex(ledger))).suggested : null),
        ),
      limits: { maxEmailBytes: MAX_EMAIL_BYTES, readerIsModel: reader.isModel, readerNotice: reader.isModel ? READER_NOTICE : null },
    };
  });
}

const WHERE_WORDS: Record<Candidate["where"], string> = {
  subject: "in the subject",
  body: "in the body",
  attachment: "in an attachment's name",
};

function candidateView(candidate: Candidate, match: Match, situation: Situation | undefined): CandidateView {
  const suggested: boolean = match.suggested === candidate.invoiceId;
  return {
    invoiceId: candidate.invoiceId,
    supplier: candidate.supplier,
    amount: money(candidate.amountMinor, candidate.currency),
    situation: { label: situation?.label ?? "Not in the ledger", tone: situation?.tone ?? "done" },
    where: candidate.where,
    exact: candidate.exact,
    amongDigits: candidate.amongDigits,
    senderOnFile: candidate.senderOnFile,
    senderText:
      candidate.supplierDomain === ""
        ? "No email domain is on file for this payment's supplier."
        : candidate.senderOnFile
          ? `The sender matches ${candidate.supplierDomain}, the email domain on file.`
          : `The sender does not match ${candidate.supplierDomain}, the email domain on file.`,
    why: suggested
      ? `The only invoice number this email names (${WHERE_WORDS[candidate.where]}).`
      : `${candidate.exact ? "Named" : "Nearly named"} ${WHERE_WORDS[candidate.where]}${candidate.amongDigits ? ", among other digits" : ""}.`,
  };
}

// Whether PayOnce has read the open payment an upload was delivered to, and once
// it has, what the reader found. The findings are the payment's, from all its emails.
function readingOf(ledger: Ledger, target: InvoiceSnapshot): { state: "unread" } | { state: "read"; summary: string; readBy: string | null } {
  const stored: string | undefined = target.emails.unread ? undefined : ledger.findings(target.obligation.invoiceId);
  const findings: { summary?: string; readBy?: string } | null = stored === undefined ? null : storedObject<{ summary?: string; readBy?: string }>(stored);
  return findings === null
    ? { state: "unread" }
    : { state: "read", summary: capitalise(findings.summary ?? ""), readBy: findings.readBy ?? null };
}

export function inboxItemView(ledger: Ledger, settings: Settings, now: number, uploadId: number): InboxItemView | null {
  return readingSoft((): InboxItemView | null => {
    const upload: Upload | undefined = ledger.upload(uploadId);
    if (upload === undefined) {
      return null;
    }
    const match: Match = upload.state === "waiting" ? candidatesFor(ledger, upload) : { candidates: [], suggested: null };
    const ids: string[] = [...match.candidates.map((candidate: Candidate): string => candidate.invoiceId), ...(upload.invoiceId === null ? [] : [upload.invoiceId])];
    const snapshots: InvoiceSnapshot[] = readInvoiceSnapshots(ledger, snapshotOptions(settings, null), now, ids);
    const situations: Map<string, Situation> = new Map(
      snapshots.map((snapshot: InvoiceSnapshot): [string, Situation] => [snapshot.obligation.invoiceId, situationOf(snapshot, now)]),
    );
    const target: InvoiceSnapshot | undefined = snapshots.find(
      (snapshot: InvoiceSnapshot): boolean => snapshot.obligation.invoiceId === upload.invoiceId,
    );
    const closed: boolean = target !== undefined && situations.get(target.obligation.invoiceId)?.group === "closed";
    const waiting: boolean = upload.state === "waiting";
    const notWaiting: Can = refused("not-waiting", `The email is ${upload.state === "delivered" ? "delivered" : "dismissed"} already.`);
    return {
      view: "inbox-item",
      upload: {
        ...rowOf(upload, match.suggested),
        replyTo: upload.replyTo,
        dateAsWritten: upload.dateAsWritten,
        body: upload.body,
        styleText: upload.styleText === "" ? null : upload.styleText,
        attachments: upload.attachments,
        notes: noteTexts(upload.notes),
        messageId: upload.messageId,
        deliveredBy: upload.deliveredBy,
        deliveredAt: upload.deliveredAt,
        dismissedBy: upload.dismissedBy,
        dismissedAt: upload.dismissedAt,
        dismissNote: upload.dismissNote,
      },
      candidates: match.candidates.map((candidate: Candidate): CandidateView => candidateView(candidate, match, situations.get(candidate.invoiceId))),
      suggested: match.suggested,
      sameMessageId: ledger.sameMessageId(upload),
      afterDelivery:
        upload.state !== "delivered" || target === undefined
          ? null
          : closed
            ? `${target.obligation.invoiceId} is closed, so the email stays on file and changes nothing.`
            : target.emails.unread
              ? "PayOnce reads it at its next check."
              : "PayOnce has read it with the payment's other emails.",
      reading: upload.state !== "delivered" || target === undefined || closed ? null : readingOf(ledger, target),
      can: { deliver: waiting ? allowed() : notWaiting, dismiss: waiting ? allowed() : notWaiting },
    };
  });
}

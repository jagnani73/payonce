import { Worker } from "node:worker_threads";
import { numberOf, numbersOf, type InvoiceNumber } from "./duplicates.js";
import { noteTexts, PARTIAL_NOTES, type EmailNote, type ParsedEmail, type ParsedUpload, type UploadSource } from "./eml.js";
import { unverifiedSenders, type SupplierEmail } from "./emails.js";
import { note, noteSenders } from "./engine.js";
import {
  type DeliverResult,
  type Ledger,
  type Obligation,
  type ObligationState,
  type Upload,
} from "./ledger.js";

// Uploaded emails: stored in the inbox, matched to the invoices they name, and
// delivered to one by a person. Nothing is delivered by itself, because a wrong
// match is silent and a click costs a second. Matching reads only the subject,
// the text and the attachment names, never the sender, the amount or the
// supplier's name, which are forgeable or vague.

const MAX_TOKENS: number = 5_000;
// Longer tokens are skipped before any check on them.
const MAX_TOKEN_LENGTH: number = 128;
const TOKEN: RegExp = /[A-Za-z0-9]+(?:[-_./#][A-Za-z0-9]+)*/g;

// An upload PayOnce cannot read. tooLarge is the 2 MB limit.
export class EmailRefusedError extends Error {
  readonly tooLarge: boolean;

  constructor(message: string, tooLarge: boolean) {
    super(message);
    this.name = "EmailRefusedError";
    this.tooLarge = tooLarge;
  }
}

// How long one parse may run once the worker has started, and how much memory it
// may take. parseEmail is linear and its 2 MiB worst cases take a few hundred
// milliseconds at most, so a parse past either limit is a slow path nobody has
// found yet. It then refuses one upload instead of stalling the dispatcher, the
// watcher and the page.
const PARSE_BUDGET_MS: number = 2_000;
const PARSE_HEAP_MB: number = 256;
// Starting a worker takes about a tenth of a second, and longer the first time
// tsx compiles the parser.
const WORKER_START_MS: number = 15_000;

const TOO_SLOW: string = `PayOnce stopped reading this email after ${PARSE_BUDGET_MS / 1000} seconds and did not keep it. Read it in your own mail client, and report the email, because no email should take this long`;
const TOO_MUCH_MEMORY: string = "PayOnce stopped reading this email because it needed more memory than any email should, and did not keep it. Read it in your own mail client, and report the email";

// One parse at a time, so uploads arriving together cost one worker's memory.
let parsing: Promise<unknown> = Promise.resolve();

// Parses an upload in a worker thread, off the thread that runs the agent and
// the page. Throws EmailRefusedError for an email PayOnce cannot read, or one
// that took longer than PARSE_BUDGET_MS or more than PARSE_HEAP_MB to read.
export function parseUpload(raw: Buffer, source: UploadSource): Promise<ParsedEmail> {
  const next: Promise<ParsedEmail> = parsing.then((): Promise<ParsedEmail> => parseInWorker(raw, source));
  parsing = next.catch((): void => undefined);
  return next;
}

function parseInWorker(raw: Buffer, source: UploadSource): Promise<ParsedEmail> {
  return new Promise<ParsedEmail>((resolve, reject): void => {
    const worker: Worker = new Worker(new URL("./parse-worker.ts", import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: PARSE_HEAP_MB, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    let settled: boolean = false;
    let timer: NodeJS.Timeout;
    const finish = (outcome: ParsedUpload | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (outcome instanceof Error) {
        reject(outcome);
      } else if (outcome.ok) {
        resolve(outcome.email);
      } else {
        reject(new EmailRefusedError(outcome.error, outcome.tooLarge));
      }
    };
    timer = setTimeout((): void => finish(new Error("The email parser did not start")), WORKER_START_MS);
    worker.on("message", (message: unknown): void => {
      if (message !== "ready") {
        finish(message as ParsedUpload);
        return;
      }
      // The budget starts with the parse, not with the worker.
      clearTimeout(timer);
      timer = setTimeout((): void => finish(new EmailRefusedError(TOO_SLOW, false)), PARSE_BUDGET_MS);
      // A copy of its own, so moving it to the worker detaches nothing else.
      const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(raw.length);
      bytes.set(raw);
      worker.postMessage({ raw: bytes, source }, [bytes.buffer]);
    });
    worker.on("error", (error: Error): void => {
      finish(
        (error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY"
          ? new EmailRefusedError(TOO_MUCH_MEMORY, false)
          : error,
      );
    });
    worker.on("exit", (): void => finish(new Error("The email parser stopped before it answered")));
  });
}

// Stores a parsed upload, waiting. Throws DuplicateUploadError for one already in
// the inbox.
export function storeUpload(
  ledger: Ledger,
  email: ParsedEmail,
  uploadedBy: string,
  source: UploadSource,
  fileName: string | null,
): Upload {
  return ledger.addUpload({
    uploadedBy,
    source,
    fileName,
    rawSha256: email.rawSha256,
    rawBytes: email.rawBytes,
    contentHash: email.contentHash,
    messageId: email.messageId,
    sender: email.from,
    senderName: email.fromName,
    fromAsWritten: email.fromAsWritten,
    replyTo: email.replyTo,
    dateAsWritten: email.dateAsWritten,
    subject: email.subject,
    body: email.body,
    styleText: email.styleText,
    attachments: email.attachments,
    notes: email.notes,
    partial: email.partial,
  });
}

// The upload as the reader and the sender check take it.
export function asEmail(upload: Upload): SupplierEmail {
  return {
    from: upload.sender,
    subject: upload.subject,
    body: upload.body,
    uploadId: upload.id,
    fromName: upload.senderName,
    replyTo: upload.replyTo,
    styleText: upload.styleText,
    attachments: upload.attachments,
    notes: upload.notes,
    partial: upload.partial,
  };
}

export type Where = "subject" | "body" | "attachment";

// An invoice an upload names. exact is false when the number only nearly
// matches, as INV-42A does INV-42. amongDigits is true for an all-digit number
// found next to other digits, as in a phone number, which is never pre-selected.
export interface Candidate {
  invoiceId: string;
  state: ObligationState;
  supplier: string;
  amountMinor: number;
  currency: string;
  supplierDomain: string;
  exact: boolean;
  where: Where;
  amongDigits: boolean;
  // The sender check passes for this invoice's domain on file.
  senderOnFile: boolean;
}

export interface Match {
  candidates: Candidate[];
  // The one invoice to offer first, or null: exactly one invoice is named, not
  // only among other digits, and it is still open or with a person.
  suggested: string | null;
}

interface Found {
  key: InvoiceNumber;
  where: Where;
  amongDigits: boolean;
}

// True when digits sit next to the token in the text, past spaces and brackets.
function nextToDigits(text: string, start: number, end: number): boolean {
  let before: number = start - 1;
  while (before >= 0 && start - before <= 4 && " ()+".includes(text.charAt(before))) {
    before -= 1;
  }
  let after: number = end;
  while (after < text.length && after - end < 4 && " ()+".includes(text.charAt(after))) {
    after += 1;
  }
  return /[0-9]/.test(text.charAt(before)) || /[0-9]/.test(text.charAt(after));
}

// A token such as INV-5001.pdf without its extension: two to four letters after
// the last dot, with a digit before it. Null for any other token.
function withoutExtension(token: string): string | null {
  const dot: number = token.lastIndexOf(".");
  const extension: string = dot < 0 ? "" : token.slice(dot + 1);
  const stem: string = dot < 0 ? "" : token.slice(0, dot);
  return extension.length >= 2 && extension.length <= 4 && /^[A-Za-z]+$/.test(extension) && /[0-9]/.test(stem)
    ? stem
    : null;
}

// The numbers in a text that could be invoice numbers: tokens with a digit, a
// token with a file extension without it, and a word followed by a number, so
// "INV 5001" and "inv #5001" read as INV-5001.
function numbersIn(text: string, where: Where, found: Found[]): void {
  let previous: { text: string; end: number } | null = null;
  TOKEN.lastIndex = 0;
  for (let match: RegExpExecArray | null = TOKEN.exec(text); match !== null; match = TOKEN.exec(text)) {
    if (found.length >= MAX_TOKENS) {
      return;
    }
    const token: string = match[0];
    const start: number = match.index;
    const end: number = start + token.length;
    // An invoice number has at most 40 characters, so a longer token is none.
    if (token.length > MAX_TOKEN_LENGTH) {
      previous = null;
      continue;
    }
    if (/[0-9]/.test(token)) {
      const amongDigits: boolean = /^[0-9]+$/.test(token) && nextToDigits(text, start, end);
      found.push({ key: numberOf(token), where, amongDigits });
      const stem: string | null = withoutExtension(token);
      if (stem !== null) {
        found.push({ key: numberOf(stem), where, amongDigits });
      }
      if (previous !== null && /^[A-Za-z]+$/.test(previous.text) && /^[0-9]/.test(token) && /^[ #:]{1,3}$/.test(text.slice(previous.end, start))) {
        found.push({ key: numberOf(`${previous.text} ${token}`), where, amongDigits: false });
      }
    }
    previous = { text: token, end };
  }
}

function add(map: Map<string, Obligation[]>, key: string, obligation: Obligation): void {
  if (key === "") {
    return;
  }
  const list: Obligation[] = map.get(key) ?? [];
  if (!list.includes(obligation)) {
    list.push(obligation);
  }
  map.set(key, list);
}

// The invoices in the ledger an upload names, worked out from the ledger as it
// is now, so an invoice started after the upload is found too. Each number is
// looked up by its keys, so the work grows with the numbers found, not with
// numbers times invoices. Exact matches come first, then the subject before the
// text before the attachment names.
export function candidatesFor(ledger: Ledger, upload: Upload): Match {
  const byFull: Map<string, Obligation[]> = new Map<string, Obligation[]>();
  const byBase: Map<string, Obligation[]> = new Map<string, Obligation[]>();
  for (const obligation of ledger.obligations()) {
    for (const number of numbersOf(obligation)) {
      const key: InvoiceNumber = numberOf(number);
      add(byFull, key.full, obligation);
      add(byBase, key.base, obligation);
    }
  }
  const found: Found[] = [];
  numbersIn(upload.subject, "subject", found);
  numbersIn(upload.body, "body", found);
  for (const attachment of upload.attachments) {
    numbersIn(attachment.name, "attachment", found);
  }
  const email: SupplierEmail = asEmail(upload);
  const best: Map<string, Candidate> = new Map<string, Candidate>();
  const rank = (candidate: Candidate): number =>
    (candidate.exact ? 0 : 3) + ["subject", "body", "attachment"].indexOf(candidate.where);
  for (const number of found) {
    const exact: Obligation[] = byFull.get(number.key.full) ?? [];
    const near: Obligation[] = [...(byFull.get(number.key.base) ?? []), ...(byBase.get(number.key.full) ?? [])];
    for (const [obligation, isExact] of [
      ...exact.map((entry: Obligation): [Obligation, boolean] => [entry, true]),
      ...near.map((entry: Obligation): [Obligation, boolean] => [entry, false]),
    ] as [Obligation, boolean][]) {
      const candidate: Candidate = {
        invoiceId: obligation.invoiceId,
        state: obligation.state,
        supplier: obligation.supplier,
        amountMinor: obligation.amountMinor,
        currency: obligation.currency,
        supplierDomain: obligation.supplierDomain,
        exact: isExact,
        where: number.where,
        amongDigits: number.amongDigits,
        senderOnFile: unverifiedSenders([email], obligation.supplierDomain).length === 0,
      };
      const held: Candidate | undefined = best.get(obligation.invoiceId);
      if (held === undefined) {
        best.set(obligation.invoiceId, candidate);
      } else if (rank(candidate) < rank(held) || (held.amongDigits && !candidate.amongDigits && candidate.exact === held.exact)) {
        best.set(obligation.invoiceId, { ...candidate, amongDigits: held.amongDigits && candidate.amongDigits });
      }
    }
  }
  const candidates: Candidate[] = [...best.values()].sort((a: Candidate, b: Candidate): number => rank(a) - rank(b));
  const only: Candidate | undefined = candidates.length === 1 ? candidates[0] : undefined;
  return {
    candidates,
    suggested:
      only !== undefined && !only.amongDigits && (only.state === "open" || only.state === "escalated")
        ? only.invoiceId
        : null,
  };
}

// The waiting upload is no longer waiting: another person delivered or
// dismissed it first.
export class UploadNotWaitingError extends Error {
  readonly upload: Upload;

  constructor(upload: Upload) {
    super(
      upload.state === "delivered"
        ? `Upload ${upload.id} was delivered to ${upload.invoiceId ?? ""} by ${upload.deliveredBy ?? ""} already`
        : `Upload ${upload.id} was dismissed by ${upload.dismissedBy ?? ""} already`,
    );
    this.name = "UploadNotWaitingError";
    this.upload = upload;
  }
}

// Delivers a waiting upload to an invoice and puts it on the invoice's timeline,
// with PayOnce's words first and the email's subject last. Call it in the
// invoice's turn. True when the invoice is open or with a person, so the agent
// should look at it now. Throws UploadNotWaitingError when it was not waiting.
export function deliverUpload(ledger: Ledger, uploadId: number, invoiceId: string, deliveredBy: string): boolean {
  const before: Upload | undefined = ledger.upload(uploadId);
  const named: Match | null = before === undefined ? null : candidatesFor(ledger, before);
  const result: DeliverResult = ledger.deliverUpload(uploadId, invoiceId, deliveredBy);
  if (!result.ok) {
    throw new UploadNotWaitingError(result.upload);
  }
  const upload: Upload = result.upload;
  const obligation: Obligation = result.obligation;
  note(
    ledger,
    invoiceId,
    "email",
    `Email from ${upload.sender}, upload ${upload.id}, uploaded by ${upload.uploadedBy} and delivered by ${deliveredBy}. Subject: ${upload.subject}`,
  );
  noteSenders(ledger, obligation, [asEmail(upload)]);
  const unread: string[] = noteTexts(upload.notes.filter((code: string): boolean => PARTIAL_NOTES.has(code as EmailNote)));
  if (upload.partial) {
    note(ledger, invoiceId, "warning", `Part of upload ${upload.id} could not be read, so a person reads it: ${unread.join("; ")}`);
  }
  const elsewhere: string[] = (named?.candidates ?? [])
    .filter((candidate: Candidate): boolean => candidate.exact && candidate.invoiceId !== invoiceId)
    .map((candidate: Candidate): string => candidate.invoiceId);
  const here: boolean = (named?.candidates ?? []).some(
    (candidate: Candidate): boolean => candidate.exact && candidate.invoiceId === invoiceId,
  );
  if (elsewhere.length > 0 && !here) {
    note(ledger, invoiceId, "warning", `Upload ${upload.id} names ${elsewhere.join(", ")}, not this invoice`);
  }
  for (const other of ledger.sameMessageId(upload)) {
    note(ledger, invoiceId, "warning", `Upload ${upload.id} has the same Message-ID as upload ${other}, which says something different`);
  }
  const live: boolean = obligation.state === "open" || obligation.state === "escalated";
  if (!live) {
    note(ledger, invoiceId, "email", "This incident is closed. The email is on file and does not reopen it");
  }
  return live;
}

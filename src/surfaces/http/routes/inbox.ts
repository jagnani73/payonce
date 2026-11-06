import type { IncomingMessage } from "node:http";
import { noteTexts, TOO_LARGE_TEXT, type ParsedEmail } from "../../../intake/eml.js";
import {
  candidatesFor,
  deliverUpload,
  EmailRefusedError,
  parseUpload,
  ParserBusyError,
  storeUpload,
  takeParsePlace,
  UploadNotWaitingError,
  type Match,
} from "../../../intake/intake.js";
import { cleanFileName } from "../../../runs/run-file.js";
import { DuplicateUploadError, readingSoft, type Obligation, type Upload } from "../../../store/ledger.js";
import type { HttpApp } from "../app.js";
import {
  HttpError,
  MAX_FINDING_LENGTH,
  name,
  readJson,
  RUN_ID_PATTERN,
  sendJson,
  text,
  UPLOAD_BODY_MS,
} from "../http.js";
import type { Route } from "../router.js";

// An uploaded email travels as base64 inside JSON: 2 MB of email is about 2.7 MB.
const MAX_INBOX_BODY_BYTES: number = 3 * 1024 * 1024;
const BASE64: RegExp = /^[A-Za-z0-9+/]*={0,2}$/;
// Uploads that are not waiting, shown after the waiting ones.
const INBOX_OTHERS_SHOWN: number = 50;

// The inbox of uploaded supplier emails.
export function inboxRoutes(app: HttpApp): Route[] {
  const { engine, agent, requireObligation, inTurn } = app;

  function requireUpload(raw: string): Upload {
    const upload: Upload | undefined = RUN_ID_PATTERN.test(raw) ? engine.ledger.upload(Number(raw)) : undefined;
    if (upload === undefined) {
      throw new HttpError(404, `Upload ${raw.slice(0, 20)} is not in the inbox`);
    }
    return upload;
  }

  // What the inbox list shows of an upload. Candidates are worked out only for one
  // upload at a time, so the list costs nothing on every poll.
  function uploadSummary(upload: Upload): unknown {
    return {
      id: upload.id,
      uploadedBy: upload.uploadedBy,
      uploadedAt: upload.uploadedAt,
      sender: upload.sender,
      subject: upload.subject,
      state: upload.state,
      partial: upload.partial,
      invoiceId: upload.invoiceId,
    };
  }

  function uploadDetail(raw: string): unknown {
    const upload: Upload = requireUpload(raw);
    const match: Match = upload.state === "waiting" ? candidatesFor(engine.ledger, upload) : { candidates: [], suggested: null };
    return {
      upload: {
        ...upload,
        contentHash: undefined,
        notes: noteTexts(upload.notes),
      },
      candidates: match.candidates,
      suggested: match.suggested,
      sameMessageId: engine.ledger.sameMessageId(upload),
    };
  }

  // The page sends the file's bytes, or the pasted source as UTF-8, base64 inside
  // JSON, so the guard's Origin and content type checks cover an upload and
  // nothing parses multipart. Its place in the parse queue is taken before the
  // body is read, so bodies still being read count as waiting too, and a body that
  // takes longer than UPLOAD_BODY_MS to arrive is refused and gives its place back.
  async function addUpload(request: IncomingMessage): Promise<unknown> {
    let giveBack: () => void;
    try {
      giveBack = takeParsePlace();
    } catch (error: unknown) {
      throw error instanceof ParserBusyError ? new HttpError(503, error.message) : error;
    }
    try {
      return await readUpload(request);
    } finally {
      giveBack();
    }
  }

  async function readUpload(request: IncomingMessage): Promise<unknown> {
    // A body too large to hold a 2 MB email gets the parser's wording, not a
    // generic one.
    const body: Record<string, unknown> = await readJson(
      request,
      MAX_INBOX_BODY_BYTES,
      TOO_LARGE_TEXT,
      UPLOAD_BODY_MS,
    );
    const uploadedBy: string = name(body, "uploadedBy", "Enter your name");
    const source: unknown = body["source"];
    if (source !== "file" && source !== "paste") {
      throw new HttpError(400, "Say whether the email is a file or pasted source");
    }
    const eml: unknown = body["eml"];
    if (typeof eml !== "string" || eml === "" || eml.length % 4 !== 0 || !BASE64.test(eml)) {
      throw new HttpError(400, "Choose an .eml file or paste the email's source");
    }
    const fileName: string | null =
      source === "file" && typeof body["fileName"] === "string" ? cleanFileName(body["fileName"]) || null : null;
    try {
      // Parsed in a worker thread. What follows on this thread is one insert and
      // matching over at most 32,000 characters.
      const email: ParsedEmail = await parseUpload(Buffer.from(eml, "base64"), source);
      const upload: Upload = storeUpload(engine.ledger, email, uploadedBy, source, fileName);
      const match: Match = candidatesFor(engine.ledger, upload);
      return { id: upload.id, candidates: match.candidates, suggested: match.suggested };
    } catch (error: unknown) {
      if (error instanceof EmailRefusedError) {
        throw new HttpError(error.tooLarge ? 413 : 400, error.message);
      }
      if (error instanceof DuplicateUploadError) {
        throw new HttpError(409, error.message, {
          id: error.upload.id,
          state: error.upload.state,
          invoiceId: error.upload.invoiceId,
        });
      }
      throw error;
    }
  }

  // A person delivers a waiting upload to an invoice, in the invoice's turn, and
  // the agent then looks at an open or escalated invoice, which reads the email.
  async function deliverUploadByPerson(request: IncomingMessage, raw: string): Promise<unknown> {
    const upload: Upload = requireUpload(raw);
    const body: Record<string, unknown> = await readJson(request);
    const deliveredBy: string = name(body, "deliveredBy", "Enter your name");
    const obligation: Obligation = requireObligation(text(body, "invoiceId"));
    const live: boolean = await inTurn(obligation.invoiceId, (): boolean =>
      deliverUpload(engine.ledger, upload.id, obligation.invoiceId, deliveredBy),
    );
    if (live) {
      agent.wake(obligation.invoiceId);
    }
    return { ok: true, invoiceId: obligation.invoiceId };
  }

  async function dismissUploadByPerson(request: IncomingMessage, raw: string): Promise<unknown> {
    const upload: Upload = requireUpload(raw);
    const body: Record<string, unknown> = await readJson(request);
    const dismissedBy: string = name(body, "dismissedBy", "Enter your name");
    const note: string = text(body, "note");
    if (note === "" || note.length > MAX_FINDING_LENGTH) {
      throw new HttpError(400, "Say why the email belongs to no invoice");
    }
    if (!engine.ledger.dismissUpload(upload.id, dismissedBy, note)) {
      throw new HttpError(409, new UploadNotWaitingError(engine.ledger.upload(upload.id) ?? upload).message);
    }
    return { ok: true };
  }

  return [
    {
      method: "GET",
      pattern: "/api/inbox",
      // A list the page polls, so it reads stored JSON soft, as the incident list does.
      handler: ({ response }): void =>
        sendJson(
          response,
          200,
          readingSoft(() => ({ uploads: engine.ledger.uploads(INBOX_OTHERS_SHOWN).map(uploadSummary) })),
        ),
    },
    {
      method: "POST",
      pattern: "/api/inbox",
      handler: async ({ request, response }): Promise<void> => sendJson(response, 201, await addUpload(request)),
    },
    { method: "GET", pattern: "api/inbox/:id", handler: ({ response }, id: string): void => sendJson(response, 200, uploadDetail(id)) },
    {
      method: "POST",
      pattern: "api/inbox/:id/deliver",
      handler: async ({ request, response }, id: string): Promise<void> =>
        sendJson(response, 200, await deliverUploadByPerson(request, id)),
    },
    {
      method: "POST",
      pattern: "api/inbox/:id/dismiss",
      handler: async ({ request, response }, id: string): Promise<void> =>
        sendJson(response, 200, await dismissUploadByPerson(request, id)),
    },
  ];
}

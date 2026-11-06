import type { IncomingMessage } from "node:http";
import { TOO_LARGE_TEXT, type ParsedEmail } from "../../../intake/eml.js";
import {
  deliverUpload,
  EmailRefusedError,
  parseUpload,
  ParserBusyError,
  storeUpload,
  takeParsePlace,
  UploadNotWaitingError,
} from "../../../intake/intake.js";
import { cleanFileName } from "../../../runs/run-file.js";
import { DuplicateUploadError, type Obligation, type Upload, type UploadState } from "../../../store/ledger.js";
import type { Acted, InboxItemView, InboxListView, UploadEmailResult } from "../../../views/contract.js";
import { inboxItemView, inboxView } from "../../../views/inbox.js";
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
const TABS: UploadState[] = ["waiting", "delivered", "dismissed"];

// The inbox of uploaded supplier emails. Every step on an upload answers the
// upload as it is after it.
export function inboxRoutes(app: HttpApp): Route[] {
  const { engine, settings, agent, requireObligation, inTurn } = app;

  function requireUpload(raw: string): Upload {
    const upload: Upload | undefined = RUN_ID_PATTERN.test(raw) ? engine.ledger.upload(Number(raw)) : undefined;
    if (upload === undefined) {
      throw new HttpError(404, `Upload ${raw.slice(0, 20)} is not in the inbox`);
    }
    return upload;
  }

  function list(params: URLSearchParams): InboxListView {
    const tab: string = params.get("tab") ?? "";
    if (tab !== "" && !(TABS as string[]).includes(tab)) {
      throw new HttpError(400, "The tab is waiting, delivered or dismissed");
    }
    return inboxView(engine.ledger, settings, Date.now(), tab === "" ? null : (tab as UploadState));
  }

  function item(raw: string): InboxItemView {
    const view: InboxItemView | null = RUN_ID_PATTERN.test(raw) ? inboxItemView(engine.ledger, settings, Date.now(), Number(raw)) : null;
    if (view === null) {
      throw new HttpError(404, `Upload ${raw.slice(0, 20)} is not in the inbox`);
    }
    return view;
  }

  // The page sends the file's bytes, or the pasted source as UTF-8, base64 inside
  // JSON, so the guard's Origin and content type checks cover an upload and
  // nothing parses multipart. Its place in the parse queue is taken before the
  // body is read, so bodies still being read count as waiting too, and a body that
  // takes longer than UPLOAD_BODY_MS to arrive is refused and gives its place back.
  async function addUpload(request: IncomingMessage): Promise<UploadEmailResult> {
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

  async function readUpload(request: IncomingMessage): Promise<UploadEmailResult> {
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
    let upload: Upload;
    try {
      // Parsed in a worker thread. What follows on this thread is one insert, and
      // the view's matching over at most 32,000 characters.
      const email: ParsedEmail = await parseUpload(Buffer.from(eml, "base64"), source);
      upload = storeUpload(engine.ledger, email, uploadedBy, source, fileName);
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
    const view: InboxItemView = item(String(upload.id));
    return {
      id: upload.id,
      view,
      notice: {
        tone: "success",
        text:
          view.suggested === null
            ? `Email ${upload.id} uploaded. Choose the payment it is about.`
            : `Email ${upload.id} uploaded. PayOnce suggests ${view.suggested}.`,
      },
    };
  }

  // A person delivers a waiting upload to an invoice, in the invoice's turn, and
  // the agent then looks at an open or escalated invoice, which reads the email.
  async function deliverUploadByPerson(request: IncomingMessage, raw: string): Promise<Acted<InboxItemView>> {
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
    return { view: item(raw), notice: { tone: "success", text: `Delivered to ${obligation.invoiceId}.` } };
  }

  async function dismissUploadByPerson(request: IncomingMessage, raw: string): Promise<Acted<InboxItemView>> {
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
    return { view: item(raw), notice: { tone: "success", text: `Email ${upload.id} dismissed.` } };
  }

  return [
    { method: "GET", pattern: "/api/inbox", handler: ({ response, url }): void => sendJson(response, 200, list(url.searchParams)) },
    {
      method: "POST",
      pattern: "/api/inbox",
      handler: async ({ request, response }): Promise<void> => sendJson(response, 201, await addUpload(request)),
    },
    { method: "GET", pattern: "api/inbox/:id", handler: ({ response }, id: string): void => sendJson(response, 200, item(id)) },
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

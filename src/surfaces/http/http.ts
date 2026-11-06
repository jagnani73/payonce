import type { IncomingMessage, ServerResponse } from "node:http";
import { NameError, personName } from "../../domain/approvers.js";
import { oneLine } from "../../text/printable.js";

// Request bodies, answers and the typed fields every route reads.

const MAX_BODY_BYTES: number = 64 * 1024;
const BODY_TOO_LARGE_TEXT: string = "Request body is too large";
// How long an uploaded email or pay run file may take to arrive. An upload holds
// its parse place while its body is read, so a slow one gives it back after this
// instead of after Node's five minute request timeout.
export const UPLOAD_BODY_MS: number = 30_000;
const SLOW_UPLOAD_TEXT: string = `The upload took more than ${UPLOAD_BODY_MS / 1000} seconds to arrive, so PayOnce stopped reading it and kept nothing. Try again`;
export const MAX_FINDING_LENGTH: number = 200;
export const RUN_ID_PATTERN: RegExp = /^[1-9][0-9]{0,9}$/;

// extra is merged into the error's JSON, such as a file's problems or the run a
// refused upload names. headers go on the response, such as Retry-After.
export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    message: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.status = status;
    this.extra = extra;
    this.headers = headers;
  }
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

// within, when given, is how long the body may take to arrive. Past it the read
// is refused with 408, and the connection is closed once that answer is sent.
export async function readJson(
  request: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
  tooLarge: string = BODY_TOO_LARGE_TEXT,
  within: number | null = null,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size: number = 0;
  const reading: Promise<void> = (async (): Promise<void> => {
    for await (const chunk of request) {
      const buffer: Buffer = chunk as Buffer;
      size += buffer.length;
      if (size > maxBytes) {
        throw new HttpError(413, tooLarge);
      }
      chunks.push(buffer);
    }
  })();
  if (within === null) {
    await reading;
  } else {
    // The read left running ends when the connection closes, so its error is dropped.
    reading.catch((): void => undefined);
    let timer: NodeJS.Timeout | undefined;
    const late: Promise<never> = new Promise<never>((_resolve, reject): void => {
      timer = setTimeout((): void => reject(new HttpError(408, SLOW_UPLOAD_TEXT)), within);
    });
    try {
      await Promise.race([reading, late]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object");
  }
}

// A typed field as one line: a line break or other control character becomes a
// space, so a name or a note cannot start a line of its own on a timeline, a card
// or a terminal.
export function text(body: Record<string, unknown>, field: string): string {
  return typeof body[field] === "string" ? oneLine(body[field]).trim() : "";
}

// A typed field exactly as sent, for a name that personName checks itself.
export function typed(body: Record<string, unknown>, field: string): string {
  return typeof body[field] === "string" ? body[field] : "";
}

// A name a person typed, as PayOnce records it (personName), or 400 with what a
// name may hold. It reads the field as sent, not through text, so a line break or
// any other control character in a name is refused instead of becoming a space.
export function name(body: Record<string, unknown>, field: string, missing: string): string {
  try {
    return personName(typed(body, field), missing);
  } catch (error: unknown) {
    if (error instanceof NameError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

// A name a person chose, given in the query, as personName records it, or null
// when none is given.
export function queryName(params: URLSearchParams, field: string): string | null {
  const raw: string = params.get(field) ?? "";
  return raw.trim() === "" ? null : name({ [field]: raw }, field, "");
}

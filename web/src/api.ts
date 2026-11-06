import { cleanLine } from "./text";
import type { ApiError as ApiErrorBody } from "./types";

// The one way the page talks to the server: JSON GETs and POSTs to /api/. A
// refusal becomes an ApiError with the server's words, cleaned, and its body, so
// a form can read the fields or the extra facts it carries.

export class ApiError extends Error {
  // 0 when the server did not answer at all.
  readonly status: number;
  readonly body: ApiErrorBody | null;

  constructor(status: number, message: string, body: ApiErrorBody | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

const NO_ANSWER: string = "PayOnce's server did not answer. Check that pnpm ui is still running.";
const UNREADABLE: string = "This page couldn't read the server's answer.";

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  return new ApiError(0, error instanceof Error && error.name === "AbortError" ? "The request was stopped." : NO_ANSWER);
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin" });
  } catch (error: unknown) {
    throw asApiError(error);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const refusal: ApiErrorBody | null =
      typeof body === "object" && body !== null && typeof (body as ApiErrorBody).error === "string" ? (body as ApiErrorBody) : null;
    const said: string = cleanLine(refusal?.error);
    throw new ApiError(response.status, said === "" ? `The server answered ${response.status}.` : said, refusal);
  }
  if (typeof body !== "object" || body === null) {
    throw new ApiError(response.status, UNREADABLE);
  }
  return body as T;
}

export function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return send<T>(path, { method: "GET", headers: { Accept: "application/json" }, signal: signal ?? null });
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return send<T>(path, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A path with its query, leaving out empty values: query("/api/home", { me }).
export function query(path: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const search: URLSearchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "" && value !== false) {
      search.set(key, String(value));
    }
  }
  const text: string = search.toString();
  return text === "" ? path : `${path}?${text}`;
}

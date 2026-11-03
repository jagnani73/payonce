import { cleanLine } from "../eml.js";
import { redactKey } from "../redact.js";

const DEFAULT_BASE_URL: string = "https://api.sandbox.airwallex.com";
// The sandbox API hosts Airwallex documents: api.sandbox.airwallex.com in its API
// reference and quick starts, and api-demo.airwallex.com, the older name of the
// same sandbox. This code moves money, so it talks to nothing else.
export const SANDBOX_HOSTS: readonly string[] = ["api.sandbox.airwallex.com", "api-demo.airwallex.com"];
// The offline host, for running PayOnce with no Airwallex at all: every call fails
// as Airwallex being unreachable. .invalid is reserved and never resolves, and no
// public certificate can exist for it, so the key cannot leave over TLS.
export const OFFLINE_HOST: string = "sandbox.invalid";
const ALLOWED_HOSTS: readonly string[] = [...SANDBOX_HOSTS, OFFLINE_HOST];
const ALLOWED_TEXT: string = `${SANDBOX_HOSTS.map((host: string): string => `https://${host}`).join(", ")} or https://${OFFLINE_HOST}`;
const LOGIN_PATH: string = "/api/v1/authentication/login";
export const LOGIN_REQUEST: string = `POST ${LOGIN_PATH}`;
const TOKEN_REFRESH_MARGIN_MS: number = 60_000;
const REQUEST_TIMEOUT_MS: number = 30_000;
const MAX_ERROR_TEXT: number = 300;
const ERROR_CODE: RegExp = /^[A-Za-z0-9_.-]{1,64}$/;
const REDIRECT_TEXT: string =
  "Airwallex answered with a redirect, which PayOnce never follows, so the API key and token go only to the sandbox host";

export type HttpMethod = "GET" | "POST";

interface LoginResponse {
  token: string;
  expires_at: string;
}

interface ErrorBody {
  code?: string;
  message?: string;
  source?: string;
}

// What a request sent that Airwallex could echo back: the client id, the API key
// and the bearer token, each with the label it is cut to.
interface Secret {
  value: string;
  label: string;
}

// Text with every secret cut out, in every form redactKey cuts, before and after
// it is cleaned to one line, since cleaning can join two parts of one.
function withoutSecrets(text: string, secrets: readonly Secret[], cap: number): string {
  const cut = (line: string): string =>
    secrets.reduce((done: string, secret: Secret): string => redactKey(done, secret.value, secret.label), line);
  return cut(cleanLine(cut(text), cap));
}

// Airwallex answered with an error status. The message reaches the timeline, the
// page and the terminal, so Airwallex's words are cut to one cleaned line, and a
// code is kept only when it looks like one. An answer that is not JSON, such as a
// gateway's HTML page, is not quoted: the message says only that it was a page
// that is not JSON. An answer can echo the client id, the API key or the token,
// so each is cut out of every part kept, and a code that held one is dropped.
export class AirwallexError extends Error {
  // The method and path, such as LOGIN_REQUEST, with no query string.
  readonly request: string;
  readonly status: number;
  readonly code: string | undefined;
  readonly source: string | undefined;

  constructor(request: string, status: number, body: ErrorBody, fallback: string, secrets: readonly Secret[]) {
    const code: string | undefined =
      typeof body.code === "string" &&
      ERROR_CODE.test(body.code) &&
      withoutSecrets(body.code, secrets, MAX_ERROR_TEXT) === body.code
        ? body.code
        : undefined;
    const said: string = withoutSecrets(typeof body.message === "string" ? body.message : fallback, secrets, MAX_ERROR_TEXT);
    super(`${request} failed with ${status}${code === undefined ? "" : ` ${code}`}: ${said}`);
    this.name = "AirwallexError";
    this.request = request;
    this.status = status;
    this.code = code;
    this.source = typeof body.source === "string" ? withoutSecrets(body.source, secrets, MAX_ERROR_TEXT) : undefined;
  }
}

// No answer came back, so whether Airwallex acted on the request is unknown. The
// cause is not kept, because a refused header value names the value, so only its
// message is, with the secrets cut out.
export class AirwallexUnreachableError extends Error {
  readonly request: string;
  // The host the call went to, one of ALLOWED_HOSTS.
  readonly host: string;

  constructor(request: string, host: string, cause: unknown, secrets: readonly Secret[]) {
    const inner: unknown = cause instanceof Error ? (cause.cause ?? cause) : cause;
    const detail: string = withoutSecrets(inner instanceof Error ? inner.message : String(inner), secrets, MAX_ERROR_TEXT);
    super(`${request} did not complete: ${detail}`);
    this.name = "AirwallexUnreachableError";
    this.request = request;
    this.host = host;
  }
}

// What a person can do about a call that failed, in PayOnce's words. Only the
// status, the request and the host decide it, never Airwallex's text, and no
// credential is named but by its setting. Empty when trying again cannot help.
export function airwallexAdvice(error: AirwallexError | AirwallexUnreachableError): string {
  if (error instanceof AirwallexUnreachableError) {
    return error.host === OFFLINE_HOST
      ? `AWX_BASE_URL is the offline host, https://${OFFLINE_HOST}, so no call reaches Airwallex.`
      : "Try again in a minute.";
  }
  if (error.request === LOGIN_REQUEST && (error.status === 401 || error.status === 403)) {
    return "Airwallex refused the API key. Check AWX_CLIENT_ID and AWX_API_KEY in .env, then start PayOnce again.";
  }
  // Past the login, a 401 is most likely the key or its token refused for this
  // call, as when the token ran out, and a 403 a scoped key without the
  // permission the call needs.
  if (error.status === 401) {
    return "Airwallex refused the API key or its token for this call. Start PayOnce again, and if it keeps happening, check AWX_CLIENT_ID and AWX_API_KEY in .env.";
  }
  if (error.status === 403) {
    return "Airwallex refused the API key for this call. Check the key's permissions in the Airwallex web app.";
  }
  return error.status >= 500 || error.status === 429 ? "Try again in a minute." : "";
}

// The start-up line: the host every call goes to, and whether any reaches Airwallex.
export function describeAirwallex(client: AirwallexClient): string {
  return client.host === OFFLINE_HOST
    ? `Airwallex calls go to ${OFFLINE_HOST}, the offline host, so no call reaches Airwallex and nothing can be paid`
    : `Airwallex calls go to ${client.host}`;
}

function requireEnv(name: string): string {
  const value: string | undefined = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

// Why AWX_BASE_URL cannot be used. Only the host of the value is ever named, and
// a value with | in it is the list of choices .env.example gives.
function baseUrlProblem(baseUrl: string, host: string | null): string {
  const what: string =
    host === null
      ? "AWX_BASE_URL is not an address PayOnce can use"
      : `Refusing the Airwallex address in AWX_BASE_URL (host ${cleanLine(host, 100)})`;
  const list: string = baseUrl.includes("|")
    ? ". It holds |, so it looks like the list of choices from .env.example. Keep one of them"
    : "";
  return `${what}${list}. PayOnce talks only to the sandbox: set AWX_BASE_URL to ${ALLOWED_TEXT}, the last to run with no Airwallex`;
}

async function send<T>(
  request: string,
  host: string,
  url: string,
  init: RequestInit,
  secrets: readonly Secret[],
): Promise<T> {
  let response: Response;
  let text: string;
  try {
    // A redirect would carry x-client-id and x-api-key, or the token, to whatever
    // host it names, so none is followed.
    response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error: unknown) {
    throw new AirwallexUnreachableError(request, host, error, secrets);
  }

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new AirwallexError(request, response.status, {}, REDIRECT_TEXT, secrets);
  }
  if (!response.ok) {
    let body: ErrorBody | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      body = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as ErrorBody) : {};
    } catch {
      body = null;
    }
    throw new AirwallexError(
      request,
      response.status,
      body ?? {},
      body !== null || text.trim() === ""
        ? text || response.statusText
        : "Airwallex answered with a page that is not JSON",
      secrets,
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export class AirwallexClient {
  // The host every call goes to: one of the sandbox hosts or the offline host.
  readonly host: string;
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly apiKey: string;
  private token: string | null = null;
  private tokenExpiresAtMs: number = 0;

  constructor(baseUrl: string, clientId: string, apiKey: string) {
    // This code moves money, so it refuses to talk to anything but the sandbox, or
    // the offline host: https on the default port, with no user name or password,
    // path, query or fragment in the address.
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error(baseUrlProblem(baseUrl, null));
    }
    if (
      url.protocol !== "https:" ||
      !ALLOWED_HOSTS.includes(url.hostname) ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error(baseUrlProblem(baseUrl, url.hostname));
    }
    this.host = url.hostname;
    // The parsed origin, never the text, so an empty ? or #, a backslash or a tab
    // the parser drops cannot put every call on another path.
    this.baseUrl = url.origin;
    this.clientId = clientId;
    this.apiKey = apiKey;
  }

  static fromEnv(): AirwallexClient {
    return new AirwallexClient(
      // Left empty, as NAME= in .env, it is the default, as when it is not set.
      process.env["AWX_BASE_URL"] || DEFAULT_BASE_URL,
      requireEnv("AWX_CLIENT_ID"),
      requireEnv("AWX_API_KEY"),
    );
  }

  private async bearer(): Promise<string> {
    if (
      this.token !== null &&
      Date.now() < this.tokenExpiresAtMs - TOKEN_REFRESH_MARGIN_MS
    ) {
      return this.token;
    }

    const login: LoginResponse = await send<LoginResponse>(
      LOGIN_REQUEST,
      this.host,
      `${this.baseUrl}${LOGIN_PATH}`,
      {
        method: "POST",
        headers: { "x-client-id": this.clientId, "x-api-key": this.apiKey },
      },
      this.secrets(this.token),
    );
    this.token = login.token;
    this.tokenExpiresAtMs = new Date(login.expires_at).getTime();
    return login.token;
  }

  async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const token: string = await this.bearer();
    // The query string can carry ids, so only the path goes into error messages.
    const request: string = `${method} ${path.split("?")[0] ?? path}`;
    return send<T>(
      request,
      this.host,
      `${this.baseUrl}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      this.secrets(token),
    );
  }

  // The token goes first, then the key, then the client id, so a shorter secret
  // found inside a longer one cannot leave part of the longer one behind.
  private secrets(token: string | null): Secret[] {
    return [
      ...(token === null ? [] : [{ value: token, label: "[token]" }]),
      { value: this.apiKey, label: "[key]" },
      { value: this.clientId, label: "[client id]" },
    ];
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}

const DEFAULT_BASE_URL: string = "https://api.sandbox.airwallex.com";
const TOKEN_REFRESH_MARGIN_MS: number = 60_000;
const REQUEST_TIMEOUT_MS: number = 30_000;

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

// Airwallex answered with an error status.
export class AirwallexError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly source: string | undefined;

  constructor(request: string, status: number, body: ErrorBody, fallback: string) {
    const code: string = body.code === undefined ? "" : ` ${body.code}`;
    super(`${request} failed with ${status}${code}: ${body.message ?? fallback}`);
    this.name = "AirwallexError";
    this.status = status;
    this.code = body.code;
    this.source = body.source;
  }
}

// No answer came back, so whether Airwallex acted on the request is unknown.
export class AirwallexUnreachableError extends Error {
  constructor(request: string, cause: unknown) {
    const inner: unknown = cause instanceof Error ? (cause.cause ?? cause) : cause;
    const detail: string = inner instanceof Error ? inner.message : String(inner);
    super(`${request} did not complete: ${detail}`, { cause });
    this.name = "AirwallexUnreachableError";
  }
}

function requireEnv(name: string): string {
  const value: string | undefined = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

async function send<T>(
  request: string,
  url: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error: unknown) {
    throw new AirwallexUnreachableError(request, error);
  }

  if (!response.ok) {
    let body: ErrorBody = {};
    try {
      body = JSON.parse(text) as ErrorBody;
    } catch {
      body = {};
    }
    throw new AirwallexError(
      request,
      response.status,
      body,
      text || response.statusText,
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export class AirwallexClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly apiKey: string;
  private token: string | null = null;
  private tokenExpiresAtMs: number = 0;

  constructor(baseUrl: string, clientId: string, apiKey: string) {
    // This code moves money, so it refuses to talk to anything but the sandbox.
    if (!new URL(baseUrl).hostname.includes("sandbox")) {
      throw new Error(`Refusing non-sandbox Airwallex host: ${baseUrl}`);
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.clientId = clientId;
    this.apiKey = apiKey;
  }

  static fromEnv(): AirwallexClient {
    return new AirwallexClient(
      process.env["AWX_BASE_URL"] ?? DEFAULT_BASE_URL,
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

    const path: string = "/api/v1/authentication/login";
    const login: LoginResponse = await send<LoginResponse>(
      `POST ${path}`,
      `${this.baseUrl}${path}`,
      {
        method: "POST",
        headers: { "x-client-id": this.clientId, "x-api-key": this.apiKey },
      },
    );
    this.token = login.token;
    this.tokenExpiresAtMs = new Date(login.expires_at).getTime();
    return login.token;
  }

  async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const token: string = await this.bearer();
    // The query string can carry ids, so only the path goes into error messages.
    const request: string = `${method} ${path.split("?")[0] ?? path}`;
    return send<T>(request, `${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}

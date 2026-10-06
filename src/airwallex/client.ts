const DEFAULT_BASE_URL: string = "https://api.sandbox.airwallex.com";
const TOKEN_REFRESH_MARGIN_MS: number = 60_000;

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

export class AirwallexError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly source: string | undefined;

  constructor(status: number, body: ErrorBody, fallback: string) {
    super(body.message ?? fallback);
    this.name = "AirwallexError";
    this.status = status;
    this.code = body.code;
    this.source = body.source;
  }
}

function requireEnv(name: string): string {
  const value: string | undefined = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

async function parse<T>(response: Response): Promise<T> {
  const text: string = await response.text();
  if (!response.ok) {
    let body: ErrorBody = {};
    try {
      body = JSON.parse(text) as ErrorBody;
    } catch {
      body = {};
    }
    throw new AirwallexError(
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

    const response: Response = await fetch(
      `${this.baseUrl}/api/v1/authentication/login`,
      {
        method: "POST",
        headers: { "x-client-id": this.clientId, "x-api-key": this.apiKey },
      },
    );
    const login: LoginResponse = await parse<LoginResponse>(response);
    this.token = login.token;
    this.tokenExpiresAtMs = new Date(login.expires_at).getTime();
    return login.token;
  }

  async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const token: string = await this.bearer();
    const response: Response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return parse<T>(response);
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}

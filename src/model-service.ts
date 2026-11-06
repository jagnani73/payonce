import { redactKeys } from "./redact.js";
import type { ModelTry } from "./reader-error.js";
import type { ModelFailure } from "./words.js";

// The model services the email reader and Ask why ask, and one request to a
// model over plain fetch, with no SDK. Claude answers on Anthropic's Messages
// API. Gemini answers on its OpenAI-compatible chat completions endpoint, and any
// service that speaks that format can stand in for it. The services are asked in
// order, Claude first, and each service's models in its list's order.

// Anthropic's Messages API. The host is fixed, so CLAUDE_API_KEY goes nowhere else.
export const CLAUDE_URL: string = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION: string = "2026-10-21";
// Measured on 2026-11-06 (docs/design/email-reader.md).
export const DEFAULT_CLAUDE_MODELS: string[] = ["claude-haiku-5-5", "claude-sonnet-5-5"];
// The Messages API needs a cap on the answer, and thinking counts against it.
// At low effort the models skipped thinking on these requests, and the timeout
// ends a request long before the cap.
const CLAUDE_MAX_TOKENS: number = 4_000;
// Gemini's OpenAI-compatible endpoint.
export const DEFAULT_GEMINI_BASE_URL: string = "https://generativelanguage.googleapis.com/v1beta/openai";
// Free-tier capacity comes and goes, so a second model is what keeps one busy
// model from sending an incident to a person.
export const DEFAULT_GEMINI_MODELS: string[] = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];
export const REQUEST_TIMEOUT_MS: number = 8_000;
const MAX_ERROR_LENGTH: number = 200;

// Anthropic's Messages API, or an OpenAI-compatible chat completions endpoint.
export type ModelApi = "messages" | "chat";

export interface ModelService {
  api: ModelApi;
  apiKey: string;
  // Where requests are posted.
  url: string;
  // The host requests go to, as the page names it.
  host: string;
  models: string[];
}

// What the page is told about a service: never its key or its full address.
export interface ServiceView {
  claude: boolean;
  // Its models in order, such as "gemini-3.5-flash, then gemini-3.1-flash-lite".
  models: string;
  host: string;
  // Google's endpoint, whose free tier Google may use to improve its products.
  googleFreeTier: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the address in READER_BASE_URL";
  }
}

export function claudeService(apiKey: string, models: string[]): ModelService {
  return {
    api: "messages",
    apiKey,
    url: CLAUDE_URL,
    host: hostOf(CLAUDE_URL),
    models: models.length > 0 ? models : DEFAULT_CLAUDE_MODELS,
  };
}

export function chatService(apiKey: string, baseUrl: string = DEFAULT_GEMINI_BASE_URL, models: string[] = []): ModelService {
  return {
    api: "chat",
    apiKey,
    url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
    host: hostOf(baseUrl),
    models: models.length > 0 ? models : DEFAULT_GEMINI_MODELS,
  };
}

export function serviceView(service: ModelService): ServiceView {
  return {
    claude: service.api === "messages",
    models: service.models.join(", then "),
    host: service.host,
    googleFreeTier: service.api === "chat" && service.host === hostOf(DEFAULT_GEMINI_BASE_URL),
  };
}

// Every model the services ask, in order.
export function modelsOf(services: readonly ModelService[]): string[] {
  return services.flatMap((service: ModelService): string[] => service.models);
}

// One request: the system message, the user message and the schema the answer
// must fit.
export interface ModelRequest {
  system: string;
  prompt: string;
  // The schema's name, which a chat completions request carries.
  schemaName: string;
  schema: Record<string, unknown>;
  // The answer's cap in tokens. A chat completions request carries it only when
  // it is set.
  maxTokens?: number;
}

// The service answered with an error status.
export class ModelError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    const detail: string = body.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_LENGTH);
    super(`The model service answered ${status}${detail === "" ? "" : `: ${detail}`}`);
    this.name = "ModelError";
    this.status = status;
  }
}

// The service answered, but with nothing PayOnce could use: cut is an answer the
// model stopped on its token budget, incomplete one it stopped for another reason
// or with no stop reason, such as a refusal, and unusable one that is not what
// was asked for.
export class ModelAnswerError extends Error {
  readonly failure: "cut" | "incomplete" | "unusable";

  constructor(failure: "cut" | "incomplete" | "unusable", message: string) {
    super(message);
    this.name = "ModelAnswerError";
    this.failure = failure;
  }
}

function finishFailure(cut: boolean): ModelAnswerError {
  return cut
    ? new ModelAnswerError("cut", "The model stopped on its token budget before the answer was complete")
    : new ModelAnswerError("incomplete", "The model gave no complete answer");
}

// What a model's failure was, from the error its request ended with. Anthropic
// answers 529 when it is overloaded, which is the same as Google's 503.
export function tryOf(model: string, error: unknown): ModelTry {
  if (error instanceof ModelError) {
    const status: number = error.status;
    const failure: ModelFailure =
      status === 401 || status === 403
        ? "key"
        : status === 429
          ? "limited"
          : status === 503 || status === 529
            ? "busy"
            : status >= 500
              ? "service"
              : "refused";
    return { model, failure, status, seconds: null };
  }
  if (error instanceof ModelAnswerError) {
    return { model, failure: error.failure, status: null, seconds: null };
  }
  const name: string = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { model, failure: "timeout", status: null, seconds: REQUEST_TIMEOUT_MS / 1000 };
  }
  // How fetch reports a connection that failed or broke off.
  if (error instanceof TypeError && (error.message === "fetch failed" || error.message === "terminated")) {
    return { model, failure: "unreachable", status: null, seconds: null };
  }
  return { model, failure: "failed", status: null, seconds: null };
}

// The service refused the key, so its other models will not take it either.
export function keyRefused(error: unknown): boolean {
  return error instanceof ModelError && (error.status === 401 || error.status === 403);
}

function headersOf(service: ModelService): Record<string, string> {
  return service.api === "messages"
    ? { "x-api-key": service.apiKey, "anthropic-version": ANTHROPIC_VERSION, "Content-Type": "application/json" }
    : { Authorization: `Bearer ${service.apiKey}`, "Content-Type": "application/json" };
}

function bodyOf(service: ModelService, model: string, request: ModelRequest): string {
  if (service.api === "messages") {
    return JSON.stringify({
      model,
      max_tokens: request.maxTokens ?? CLAUDE_MAX_TOKENS,
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
      // No thinking setting: low effort lets the model skip thinking, and the
      // same body works on every Claude model CLAUDE_MODEL may name.
      output_config: { effort: "low", format: { type: "json_schema", schema: request.schema } },
    });
  }
  return JSON.stringify({
    model,
    reasoning_effort: "low",
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.prompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: request.schemaName, strict: true, schema: request.schema },
    },
  });
}

interface ChatChoice {
  finish_reason?: string | null;
  message?: { content?: string | null };
}

interface ChatResponse {
  choices?: ChatChoice[];
}

interface MessagesBlock {
  type?: string;
  text?: unknown;
}

interface MessagesResponse {
  stop_reason?: string | null;
  content?: (MessagesBlock | null)[];
}

// The text of a complete answer, which the caller then checks.
function answerText(service: ModelService, text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ModelAnswerError("unusable", "The model service's answer was not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ModelAnswerError("unusable", "The model service's answer was not an object");
  }
  if (service.api === "messages") {
    const message: MessagesResponse = parsed as MessagesResponse;
    // Read by type, since a thinking block can come first.
    const texts: string[] = (Array.isArray(message.content) ? message.content : [])
      .filter((block: MessagesBlock | null): boolean => block?.type === "text" && typeof block.text === "string")
      .map((block: MessagesBlock | null): string => String(block?.text));
    if (message.stop_reason !== "end_turn" || texts.length === 0) {
      throw finishFailure(message.stop_reason === "max_tokens");
    }
    return texts.join("");
  }
  const choice: ChatChoice | undefined = (parsed as ChatResponse).choices?.[0];
  const content: string | null | undefined = choice?.message?.content;
  if (choice?.finish_reason !== "stop" || typeof content !== "string") {
    throw finishFailure(choice?.finish_reason === "length");
  }
  return content;
}

async function complete(
  service: ModelService,
  model: string,
  request: ModelRequest,
  keys: readonly string[],
  send: typeof fetch,
): Promise<string> {
  const response: Response = await send(service.url, {
    method: "POST",
    headers: headersOf(service),
    body: bodyOf(service, model, request),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text: string = await response.text();
  if (!response.ok) {
    // Some services echo the key back in an error.
    throw new ModelError(response.status, redactKeys(text, keys));
  }
  return answerText(service, text);
}

export type Outcome<T> =
  | { answered: true; value: T; model: string; ms: number }
  | { answered: false; tries: ModelTry[] };

// Asks each service's models in order, one request each, and gives the first
// answer parse accepts, with the model that gave it, or what each model did. A
// refused key skips the rest of that service's models, which share the key, and
// moves on to the next service. What a service said goes to warn only, with
// every service's key cut out, whatever part of an answer it came back in.
export async function firstAnswer<T>(
  services: readonly ModelService[],
  request: ModelRequest,
  parse: (content: string) => T,
  warn: (model: string, ms: number, detail: string) => void,
  send: typeof fetch,
): Promise<Outcome<T>> {
  const keys: string[] = services.map((service: ModelService): string => service.apiKey);
  const tries: ModelTry[] = [];
  for (const service of services) {
    for (const model of service.models) {
      const started: number = Date.now();
      try {
        const value: T = parse(await complete(service, model, request, keys, send));
        return { answered: true, value, model, ms: Date.now() - started };
      } catch (error: unknown) {
        tries.push(tryOf(model, error));
        warn(model, Date.now() - started, redactKeys(error instanceof Error ? error.message : String(error), keys));
        if (keyRefused(error)) {
          break;
        }
      }
    }
  }
  return { answered: false, tries };
}

import type { EmailReader } from "./emails.js";
import { KEYWORD_READER_NAME, KeywordReader } from "./keyword-reader.js";
import { ModelReader } from "./model-reader.js";
import {
  chatService,
  claudeService,
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_GEMINI_MODELS,
  type ModelService,
} from "./model-service.js";

// CLAUDE_MODEL and READER_MODEL are comma-separated lists, tried in order.
function modelsFromEnv(env: NodeJS.ProcessEnv, name: "CLAUDE_MODEL" | "READER_MODEL"): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((model: string): string => model.trim())
    .filter((model: string): boolean => model !== "");
}

// The model services the reader and the incident explainer share, in the order
// they are asked: Claude when CLAUDE_API_KEY is set, then the service
// READER_API_KEY is for, which is Gemini unless READER_BASE_URL names another.
// A list left unset takes its service's default models. Empty without either key.
export function modelServicesFromEnv(env: NodeJS.ProcessEnv = process.env): ModelService[] {
  const services: ModelService[] = [];
  const claudeKey: string | undefined = env["CLAUDE_API_KEY"];
  if (claudeKey) {
    services.push(claudeService(claudeKey, modelsFromEnv(env, "CLAUDE_MODEL")));
  }
  const readerKey: string | undefined = env["READER_API_KEY"];
  if (readerKey) {
    services.push(chatService(readerKey, env["READER_BASE_URL"] || undefined, modelsFromEnv(env, "READER_MODEL")));
  }
  return services;
}

// Every name the stored findings may give for whoever read an invoice's emails:
// the models either service is set up with, their default models and the keyword
// reader. "Ask why" passes on no other.
export function readerNamesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...new Set<string>([
      ...modelsFromEnv(env, "CLAUDE_MODEL"),
      ...DEFAULT_CLAUDE_MODELS,
      ...modelsFromEnv(env, "READER_MODEL"),
      ...DEFAULT_GEMINI_MODELS,
      KEYWORD_READER_NAME,
    ]),
  ];
}

// A model reads the emails when a key is set. Without one the keyword
// placeholder does, so the commands still run.
export function readerFromEnv(): EmailReader {
  const services: ModelService[] = modelServicesFromEnv();
  return services.length === 0 ? new KeywordReader() : new ModelReader(services);
}

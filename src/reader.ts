import type { EmailReader } from "./emails.js";
import { KEYWORD_READER_NAME, KeywordReader } from "./keyword-reader.js";
import { DEFAULT_MODELS, ModelReader } from "./model-reader.js";

// The model settings the reader and the incident explainer share. Null without
// READER_API_KEY. baseUrl and models are undefined when not set, so each takes
// its defaults.
export interface ReaderSettings {
  apiKey: string;
  baseUrl: string | undefined;
  models: string[] | undefined;
}

// READER_MODEL is a comma-separated list, tried in order.
function modelsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return (env["READER_MODEL"] ?? "")
    .split(",")
    .map((model: string): string => model.trim())
    .filter((model: string): boolean => model !== "");
}

export function readerSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ReaderSettings | null {
  const apiKey: string | undefined = env["READER_API_KEY"];
  if (!apiKey) {
    return null;
  }
  const models: string[] = modelsFromEnv(env);
  return {
    apiKey,
    baseUrl: env["READER_BASE_URL"] || undefined,
    models: models.length > 0 ? models : undefined,
  };
}

// Every name the stored findings may give for whoever read an invoice's emails:
// the models the reader is set up with, its default models and the keyword
// reader. "Ask why" passes on no other.
export function readerNamesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set<string>([...modelsFromEnv(env), ...DEFAULT_MODELS, KEYWORD_READER_NAME])];
}

// A model reads the emails when a key is set. Without one the keyword
// placeholder does, so the commands still run.
export function readerFromEnv(): EmailReader {
  const settings: ReaderSettings | null = readerSettingsFromEnv();
  if (settings === null) {
    return new KeywordReader();
  }
  return new ModelReader(settings.apiKey, settings.baseUrl, settings.models);
}

import type { EmailReader } from "./emails.js";
import { KeywordReader } from "./keyword-reader.js";
import { ModelReader } from "./model-reader.js";

// The model settings the reader and the incident explainer share. Null without
// READER_API_KEY. baseUrl and models are undefined when not set, so each takes
// its defaults.
export interface ReaderSettings {
  apiKey: string;
  baseUrl: string | undefined;
  models: string[] | undefined;
}

export function readerSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ReaderSettings | null {
  const apiKey: string | undefined = env["READER_API_KEY"];
  if (!apiKey) {
    return null;
  }
  // READER_MODEL is a comma-separated list, tried in order.
  const models: string[] = (env["READER_MODEL"] ?? "")
    .split(",")
    .map((model: string): string => model.trim())
    .filter((model: string): boolean => model !== "");
  return {
    apiKey,
    baseUrl: env["READER_BASE_URL"] || undefined,
    models: models.length > 0 ? models : undefined,
  };
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

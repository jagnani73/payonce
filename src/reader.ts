import type { EmailReader } from "./emails.js";
import { KeywordReader } from "./keyword-reader.js";
import { ModelReader } from "./model-reader.js";

// A model reads the emails when a key is set. Without one the keyword
// placeholder does, so the commands still run.
export function readerFromEnv(): EmailReader {
  const apiKey: string | undefined = process.env["READER_API_KEY"];
  if (!apiKey) {
    return new KeywordReader();
  }
  // READER_MODEL is a comma-separated list, tried in order.
  const models: string[] = (process.env["READER_MODEL"] ?? "")
    .split(",")
    .map((model: string): string => model.trim())
    .filter((model: string): boolean => model !== "");
  return new ModelReader(
    apiKey,
    process.env["READER_BASE_URL"] || undefined,
    models.length > 0 ? models : undefined,
  );
}

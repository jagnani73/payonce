import type { EmailReader } from "./emails.js";
import { KeywordReader } from "./keyword-reader.js";
import { ModelReader } from "./model-reader.js";

// A model reads the emails when a key is set. Without one the keyword
// placeholder does, so the commands still run.
export function readerFromEnv(): EmailReader {
  const apiKey: string | undefined = process.env["READER_API_KEY"];
  return apiKey
    ? new ModelReader(
        apiKey,
        process.env["READER_BASE_URL"] || undefined,
        process.env["READER_MODEL"] || undefined,
      )
    : new KeywordReader();
}

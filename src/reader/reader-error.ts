import { FAILURES_WITH_STATUS, MODEL_FAILURE_WORDS, type ModelFailure } from "../text/words.js";

// What each model the email reader or Ask why asked did when it gave no answer,
// in PayOnce's words, and the error the reader throws when every model failed. It
// imports only words.ts, so the engine reads a reader failure without importing
// the reader.

// Why one model gave no answer PayOnce could use, in the failures words.ts names.
// Nothing the service wrote is kept, so what a try says can go on the page, the
// timeline and the terminal.
export interface ModelTry {
  model: string;
  failure: ModelFailure;
  // The status the service answered with, for the failures that have one.
  status: number | null;
  // How long the model had before it timed out, for a timeout.
  seconds: number | null;
}

// One try in PayOnce's words, such as "gemini-3.5-flash was busy (503)".
export function tryText(attempt: ModelTry): string {
  const seconds: string = attempt.failure === "timeout" && attempt.seconds !== null ? ` ${attempt.seconds} s` : "";
  const status: string = attempt.status !== null && FAILURES_WITH_STATUS.has(attempt.failure) ? ` (${attempt.status})` : "";
  return `${attempt.model} ${MODEL_FAILURE_WORDS[attempt.failure]}${seconds}${status}`;
}

// Every try in order, such as "gemini-3.5-flash was busy (503), then
// gemini-3.1-flash-lite timed out after 8 s".
export function triesText(tries: readonly ModelTry[]): string {
  return tries.length === 0 ? "no model is set up" : tries.map(tryText).join(", then ");
}

// Every model gave no answer PayOnce could use. The message holds PayOnce's words
// only, so it can go on the timeline.
export class ModelReadError extends Error {
  readonly tries: ModelTry[];

  constructor(tries: ModelTry[]) {
    super(`The email reader could not read the email: ${triesText(tries)}`);
    this.name = "ModelReadError";
    this.tries = tries;
  }
}

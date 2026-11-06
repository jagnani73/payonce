import { inspect } from "node:util";
import { FAILURE_CODE_PATTERN, REFERENCE_PATTERN } from "../domain/patterns.js";

// What PayOnce prints to a terminal. Supplier and payee names and error text come
// from Airwallex, names and notes are typed, and a pay run file comes from
// anywhere, so any of them could hold a control character that moves the cursor,
// clears the screen, retitles the window or writes the clipboard. Every line
// PayOnce prints goes through here.

// C0 and C1 controls, DEL and the Unicode line and paragraph separators.
const CONTROL: RegExp = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
// Format characters (bidi controls, zero-width characters, the soft hyphen) and the
// tag block, which a terminal draws as nothing or uses to reorder a line.
const HIDDEN: RegExp = /[\p{Cf}\u{e0000}-\u{e007f}]/gu;
// The same characters one at a time, for JSON, where each is written as \uXXXX.
const UNSAFE_IN_JSON: RegExp = /[\u007f-\u009f\u2028\u2029\p{Cf}\u{e0000}-\u{e007f}]/gu;

export const UNSHOWN_REFERENCE: string = "a reference PayOnce cannot show";
export const UNSHOWN_FAILURE_CODE: string = "a code PayOnce cannot show";

// A short reference or a transfer reference from Airwallex, or PayOnce's words
// for one in any other form, so a stored value cannot print a line of its own.
export function shownReference(value: unknown): string {
  return typeof value === "string" && REFERENCE_PATTERN.test(value) ? value : UNSHOWN_REFERENCE;
}

// A failure code from Airwallex, or PayOnce's words for one in any other form.
export function shownFailureCode(value: unknown): string {
  return typeof value === "string" && FAILURE_CODE_PATTERN.test(value) ? value : UNSHOWN_FAILURE_CODE;
}

// A time as the terminal commands print it, "2026-11-03 01:49 UTC", whatever
// zone the stored time was written in.
export function utcTime(at: string | number): string {
  const time: number = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(time)
    ? `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "a time PayOnce cannot read";
}

// One line: a line break or any other control character becomes a space, and a
// format character goes.
export function printable(text: string): string {
  return text.replace(HIDDEN, "").replace(CONTROL, " ").trim();
}

// Several lines: the line breaks stay, and each line is cleaned as printable
// cleans one, keeping its indent.
export function printableLines(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line: string): string => line.replace(HIDDEN, "").replace(CONTROL, " ").trimEnd())
    .join("\n");
}

// A line PayOnce stores, such as a timeline line: every control character, a line
// break included, becomes one space, so a typed name or note or an Airwallex name
// cannot start a line of its own on the page or in a terminal. Format characters
// stay as written, because the page and printable drop them when they show it.
export function oneLine(text: string): string {
  return text.replace(CONTROL, " ");
}

// The same, trimmed, for the fields of an alert.
export function trimmedLine(text: string): string {
  return oneLine(text).trim();
}

// The text with its first character in capitals, such as a clause that starts a
// sentence.
export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// JSON with every character a terminal could act on written as \uXXXX.
// JSON.stringify escapes C0 controls already, so the text parses back to the same
// value and stays safe to print.
export function printableJson(json: string): string {
  return json.replace(UNSAFE_IN_JSON, (character: string): string =>
    [...character]
      .map((unit: string): string => {
        const code: number = unit.codePointAt(0) ?? 0;
        if (code <= 0xffff) {
          return `\\u${code.toString(16).padStart(4, "0")}`;
        }
        const high: number = Math.floor((code - 0x10000) / 0x400) + 0xd800;
        const low: number = ((code - 0x10000) % 0x400) + 0xdc00;
        return `\\u${high.toString(16)}\\u${low.toString(16)}`;
      })
      .join(""),
  );
}

// An error with its stack trace, or any other value, as text that is safe to print.
export function printableError(problem: unknown): string {
  return printableLines(typeof problem === "string" ? problem : inspect(problem));
}

export function say(text: string = ""): void {
  console.log(printableLines(text));
}

export function sayWarning(text: string): void {
  console.warn(printableLines(text));
}

export function sayError(problem: unknown): void {
  console.error(printableError(problem));
}

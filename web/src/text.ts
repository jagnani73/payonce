import type { Money } from "./types";

// Text PayOnce did not write is cleaned before it is shown, as pnpm ask prints
// it: format characters (bidi controls, zero-width characters and the rest of
// Unicode's Cf) and the tag block are dropped, so a name cannot reverse or hide
// the words around it, and control characters become spaces.

const HIDDEN: RegExp = /[\p{Cf}\u{e0000}-\u{e007f}]/gu;
const CONTROL: RegExp = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
// In a block (an email body, a draft) line breaks and tabs stay.
const BLOCK_CONTROL: RegExp = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]+/g;

// One line: what a name, a note or a cell shows.
export function cleanLine(text: string | null | undefined): string {
  return cleanRun(text).trim();
}

// A run of words inside a sentence, such as the words before a time: cleaned
// like a line, with the spaces at its ends kept.
export function cleanRun(text: string | null | undefined): string {
  return typeof text === "string" ? text.replace(HIDDEN, "").replace(CONTROL, " ") : "";
}

// Several lines, as written.
export function cleanBlock(text: string | null | undefined): string {
  return typeof text === "string"
    ? text.replace(HIDDEN, "").replace(/\r\n?/g, "\n").replace(BLOCK_CONTROL, " ")
    : "";
}

// "Alex", "Alex or Yash", "Alex, Kim or Sam".
export function joinNames(names: readonly string[], word: "or" | "and"): string {
  const clean: string[] = names.map(cleanLine);
  if (clean.length <= 1) {
    return clean[0] ?? "";
  }
  return `${clean.slice(0, -1).join(", ")} ${word} ${clean.at(-1) ?? ""}`;
}

// "1 payment", "4 payments".
export function count(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// "supplier emails arrived…" as the start of a line: a stored reason or summary
// starts in lower case, because PayOnce also writes it inside a sentence.
export function capitalised(text: string | null | undefined): string {
  const clean: string = cleanLine(text);
  return clean === "" ? clean : `${clean.charAt(0).toUpperCase()}${clean.slice(1)}`;
}

// A sentence ends with a full stop on the page, whether or not it came with one.
export function sentenceEnd(text: string): string {
  const trimmed: string = text.trim();
  return trimmed === "" || /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

const MINUS: string = String.fromCharCode(0x2212);

// "4,000.00 EUR" as the view writes it, with a true minus sign when negative
// ("−7.05 EUR", glossary.md section 4). bare: the figure without its currency,
// for a column or a row that names the wallet already.
export function moneyText(money: Money, bare: boolean = false): string {
  const suffix: string = ` ${money.currency}`;
  const figure: string = bare && money.currency !== "" && money.text.endsWith(suffix) ? money.text.slice(0, -suffix.length) : money.text;
  return money.minor < 0 ? `${MINUS}${figure.replace(/^[-−]/, "")}` : figure;
}

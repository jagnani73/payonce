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
  return typeof text === "string" ? text.replace(HIDDEN, "").replace(CONTROL, " ").trim() : "";
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

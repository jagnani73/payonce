// Cutting a secret out of text an outside service sent back. The email reader,
// Ask why and the Airwallex client share it, and it imports nothing, so the
// client does not import the email reader to use it.

// A run this long that is part of the key, in any form below, counts as the key.
// It is also the fewest letters and digits a key written with separators between
// its characters is matched on, so a short key cannot cut words out of ordinary
// text.
const KEY_RUN: number = 20;
// What can come between two characters of the key in an error and leave the key
// readable: anything but a letter or a digit, such as a space, a line break, a
// tab, a control character or punctuation, and anything a screen draws as
// nothing or a blank, such as a zero-width space, a soft hyphen or a Hangul
// filler.
const SEPARATOR: RegExp = /^(?:[^\p{L}\p{N}]|\p{Default_Ignorable_Code_Point})$/u;
// A backslash escape of a control character, as JSON and JavaScript write a line
// break or a tab.
const CONTROL_ESCAPE: RegExp = /^\\[bfnrtv]/;
// An escape that names a character by its code: \u0020 or \x20, as JSON and
// JavaScript write one, or %20, as a URL does.
const CODE_ESCAPE: RegExp = /^(?:\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})|%([0-7][0-9A-Fa-f]))/;

// The forms the key could take in a service's answer: as it is, URL-encoded with
// either case of hex, and base64 or base64url at each of the three byte
// alignments, cut to the characters the key alone decides.
function keyForms(key: string): string[] {
  const encoded: string = encodeURIComponent(key);
  const forms: Set<string> = new Set<string>([
    key,
    encoded,
    encoded.replace(/%[0-9A-F]{2}/g, (escape: string): string => escape.toLowerCase()),
  ]);
  const bytes: Buffer = Buffer.from(key, "utf8");
  for (let pad: number = 0; pad < 3; pad += 1) {
    const base64: string = Buffer.concat([Buffer.alloc(pad), bytes]).toString("base64");
    const core: string = base64.slice(Math.ceil((pad * 8) / 6), Math.floor(((pad + bytes.length) * 8) / 6));
    forms.add(core);
    forms.add(core.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return [...forms].filter((form: string): boolean => form !== "");
}

// A to Z as a to z and nothing else, so the text keeps its length and a match in
// it is a match at the same place in the text.
function folded(text: string): string {
  return text.replace(/[A-Z]/g, (letter: string): string => letter.toLowerCase());
}

// One letter or digit of a text, folded, and where it starts and ends in the text.
interface Kept {
  char: string;
  start: number;
  end: number;
}

// How long the separator at this place in the text is: an escape that writes a
// separator whole, or else the one character.
function separatorLength(text: string, at: number, char: string): number {
  const head: string = text.slice(at, at + 6);
  if (CONTROL_ESCAPE.test(head)) {
    return 2;
  }
  const escape: RegExpExecArray | null = CODE_ESCAPE.exec(head);
  const code: string | undefined = escape?.[1] ?? escape?.[2] ?? escape?.[3];
  return escape !== null && code !== undefined && SEPARATOR.test(String.fromCharCode(Number.parseInt(code, 16)))
    ? escape[0].length
    : char.length;
}

// The letters and digits of a text in order, with every separator left out.
function lettersAndDigits(text: string): Kept[] {
  const kept: Kept[] = [];
  for (let at: number = 0; at < text.length; ) {
    const char: string = String.fromCodePoint(text.codePointAt(at) ?? 0);
    if (SEPARATOR.test(char)) {
      at += separatorLength(text, at, char);
    } else {
      kept.push({ char: folded(char), start: at, end: at + char.length });
      at += char.length;
    }
  }
  return kept;
}

// Text with the key cut out, for any error that could carry it, since some
// services echo the key back. Every form of the key goes, and so does any run of
// KEY_RUN or more characters that is part of one, such as a key cut short, and any
// run of KEY_RUN or more of one's letters and digits in order with separators
// between them, such as a key split by spaces or line breaks. All are matched
// whatever the case of their letters, since a service can echo the key
// upper-cased. Each cut becomes the label.
export function redactKey(text: string, key: string, label: string = "[key]"): string {
  if (key === "") {
    return text;
  }
  const forms: string[] = [...new Set<string>(keyForms(key).map(folded))];
  let cut: string = text;
  for (const form of forms) {
    for (let at: number = folded(cut).indexOf(form); at !== -1; at = folded(cut).indexOf(form, at + label.length)) {
      cut = `${cut.slice(0, at)}${label}${cut.slice(at + form.length)}`;
    }
  }
  const runs: Set<string> = new Set<string>();
  for (const form of forms) {
    for (let at: number = 0; at + KEY_RUN <= form.length; at += 1) {
      runs.add(form.slice(at, at + KEY_RUN));
    }
  }
  const lower: string = folded(cut);
  const covered: Uint8Array = new Uint8Array(cut.length);
  for (let at: number = 0; at + KEY_RUN <= cut.length; at += 1) {
    if (runs.has(lower.slice(at, at + KEY_RUN))) {
      covered.fill(1, at, at + KEY_RUN);
    }
  }
  const spacedRuns: Set<string> = new Set<string>();
  for (const form of forms) {
    const formLetters: string[] = lettersAndDigits(form).map((one: Kept): string => one.char);
    for (let at: number = 0; at + KEY_RUN <= formLetters.length; at += 1) {
      spacedRuns.add(formLetters.slice(at, at + KEY_RUN).join(""));
    }
  }
  const kept: Kept[] = lettersAndDigits(cut);
  const letters: string[] = kept.map((one: Kept): string => one.char);
  for (let at: number = 0; at + KEY_RUN <= kept.length; at += 1) {
    if (spacedRuns.has(letters.slice(at, at + KEY_RUN).join(""))) {
      covered.fill(1, kept[at]?.start ?? 0, kept[at + KEY_RUN - 1]?.end ?? 0);
    }
  }
  let result: string = "";
  for (let at: number = 0; at < cut.length; ) {
    if (covered[at] === 1) {
      while (covered[at] === 1) {
        at += 1;
      }
      result += label;
    } else {
      result += cut[at] ?? "";
      at += 1;
    }
  }
  return result;
}

// Text with each of several keys cut out as redactKey cuts one, for the email
// reader and Ask why, which hold a key for each model service they ask.
export function redactKeys(text: string, keys: readonly string[], label: string = "[key]"): string {
  return keys.reduce((done: string, key: string): string => redactKey(done, key, label), text);
}

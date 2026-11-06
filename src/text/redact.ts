// Cutting a secret out of text an outside service sent back. The email reader,
// Ask why and the Airwallex client share it, and it imports nothing, so the
// client does not import the email reader to use it.

// A run this long that is part of the key, in any form below, counts as the key.
const KEY_RUN: number = 20;

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

// Text with the key cut out, for any error that could carry it, since some
// services echo the key back. Every form of the key goes, and so does any run of
// KEY_RUN or more characters that is part of one, such as a key cut short. Both
// are matched whatever the case of their letters, since a service can echo the key
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

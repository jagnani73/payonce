// Reads an email's CSS for text a mail client could draw from it. PayOnce does
// not try to tell which CSS draws text: it takes out every string, with CSS
// escapes decoded, and any text that is not CSS it can parse, and puts them in
// front of the reader and the person as "text found inside styles". A font name
// costs nothing there, and whatever a client could draw is there by
// construction. Past that, one rule fails closed: CSS that could make a client
// show characters that are not strings PayOnce took out marks the email partly
// unread, so a person reads it in their own client (scanCss lists the cases).
// The tokenizer follows CSS: comments are /* */ only, a string ends at its
// quote or a line break, and an unquoted url() runs to its ). It is one pass,
// linear in the input.

export interface CssScan {
  // Strings and loose text, in order.
  texts: string[];
  // CSS that could make a client show characters PayOnce did not take out as
  // strings, or that PayOnce cannot read at all.
  unreadable: boolean;
}

function isHex(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isNameCode(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 95 ||
    code >= 0x80
  );
}

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

// A CSS escape at the backslash at: up to six hex digits and one optional space,
// or the next character as it is. A line break after the backslash is a line
// continuation and reads as nothing.
function readEscape(css: string, at: number): { text: string; end: number } {
  let index: number = at + 1;
  if (index >= css.length) {
    return { text: "", end: index };
  }
  if (!isHex(css.charCodeAt(index))) {
    const code: number = css.charCodeAt(index);
    if (code === 10 || code === 12 || code === 13) {
      return { text: "", end: index + 1 };
    }
    const point: number = css.codePointAt(index) ?? code;
    return { text: String.fromCodePoint(point), end: index + (point > 0xffff ? 2 : 1) };
  }
  const start: number = index;
  while (index < css.length && index - start < 6 && isHex(css.charCodeAt(index))) {
    index += 1;
  }
  const value: number = Number.parseInt(css.slice(start, index), 16);
  if (css.charCodeAt(index) === 13 && css.charCodeAt(index + 1) === 10) {
    index += 2;
  } else if (isWhitespace(css.charCodeAt(index))) {
    index += 1;
  }
  const valid: boolean = value !== 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
  return { text: valid ? String.fromCodePoint(value) : "\uFFFD", end: index };
}

// A name, escapes decoded, from start to the first character that cannot be in one.
function readName(css: string, start: number): { name: string; end: number } {
  const parts: string[] = [];
  let run: number = start;
  let index: number = start;
  while (index < css.length) {
    const code: number = css.charCodeAt(index);
    if (isNameCode(code)) {
      index += 1;
    } else if (code === 92 && index + 1 < css.length && !isWhitespace(css.charCodeAt(index + 1))) {
      parts.push(css.slice(run, index));
      const escape: { text: string; end: number } = readEscape(css, index);
      parts.push(escape.text);
      index = escape.end;
      run = index;
    } else {
      break;
    }
  }
  parts.push(css.slice(run, index));
  return { name: parts.join(""), end: index };
}

// A quoted string at the quote at, escapes decoded. open is true when a line
// break or the end of the input came before the closing quote.
function readString(css: string, at: number): { text: string; end: number; open: boolean } {
  const quote: number = css.charCodeAt(at);
  const parts: string[] = [];
  let run: number = at + 1;
  let index: number = at + 1;
  while (index < css.length) {
    const code: number = css.charCodeAt(index);
    if (code === quote) {
      parts.push(css.slice(run, index));
      return { text: parts.join(""), end: index + 1, open: false };
    }
    if (code === 10 || code === 12 || code === 13) {
      parts.push(css.slice(run, index));
      return { text: parts.join(""), end: index, open: true };
    }
    if (code === 92) {
      parts.push(css.slice(run, index));
      const escape: { text: string; end: number } = readEscape(css, index);
      parts.push(escape.text);
      index = escape.end;
      run = index;
      continue;
    }
    index += 1;
  }
  parts.push(css.slice(run, index));
  return { text: parts.join(""), end: index, open: true };
}

// A URL inside the email: a cid: part, a data: URL or a fragment. Anything else
// is fetched from outside.
function insideEmail(url: string): boolean {
  const lower: string = url.trim().toLowerCase();
  return lower === "" || lower.startsWith("cid:") || lower.startsWith("data:") || lower.startsWith("#");
}

// Functions whose string arguments are URLs.
const URL_FUNCTIONS: ReadonlySet<string> = new Set<string>([
  "url",
  "src",
  "image",
  "image-set",
  "-webkit-image-set",
]);
// Functions that make a client draw characters that are in no string:
// counters and the value of an HTML attribute.
const DRAWING_FUNCTIONS: ReadonlySet<string> = new Set<string>(["counter", "counters", "attr"]);
// What a content value may hold besides strings, comments and spaces. Each draws
// nothing.
const CONTENT_WORDS: ReadonlySet<string> = new Set<string>(["none", "normal", "important"]);

// Characters that end a run of plain CSS.
function isSpecial(code: number): boolean {
  return (
    code === 34 || code === 39 || code === 47 || code === 92 || code === 64 || code === 58 ||
    code === 59 || code === 123 || code === 125 || code === 40 || code === 41 || isNameCode(code)
  );
}

// Reads a style sheet, or with declarations true the content of a style=""
// attribute, adding its strings and loose text to scan. Loose text is a
// statement at the top level that is not an at-rule and has no block, or a
// declaration with no colon: neither is CSS, and a client may treat it as text.
//
// One rule decides what is unreadable: CSS that could make a client show
// characters that are not strings PayOnce took out. So a content value with
// anything but strings (a counter, attr(), an identifier such as open-quote, a
// url(), var()), counter(), counters() or attr() anywhere, an @font-face with a
// src (a font can draw any character as any other), an @counter-style, a
// unicode-bidi other than normal (which can reverse a run of digits), an
// @import, a URL outside the email, and CSS left open.
export function scanCss(css: string, declarations: boolean, scan: CssScan): void {
  const floor: number = declarations ? 1 : 0;
  let depth: number = floor;
  let segment: string[] = [];
  let colon: boolean = false;
  let atRule: string | null = null;
  // The statement's first name, and once its colon is read, the property it
  // declares. Comments are tokens of their own, so one between a name and its
  // colon changes nothing.
  let first: string | null = null;
  let property: string | null = null;
  // The depth inside an @font-face block, or -1.
  let fontFace: number = -1;
  // The functions the scan is inside, innermost last. "" is a plain bracket.
  const functions: string[] = [];
  const unreadable = (): void => {
    scan.unreadable = true;
  };
  const finish = (opensBlock: boolean): void => {
    // <!-- and --> are allowed around a style sheet and mean nothing.
    const text: string = segment.join("").replace(/<!--|-->/g, " ").replace(/\s+/g, " ").trim();
    const declaration: boolean = colon;
    const at: string | null = atRule;
    segment = [];
    colon = false;
    atRule = null;
    first = null;
    property = null;
    functions.length = 0;
    if (at === "import" || at === "counter-style") {
      unreadable();
    }
    if (opensBlock && at === "font-face") {
      fontFace = depth + 1;
    }
    if (text === "" || opensBlock || at !== null) {
      return;
    }
    if (depth === 0 || !declaration) {
      scan.texts.push(text);
    }
  };
  let index: number = 0;
  while (index < css.length) {
    const code: number = css.charCodeAt(index);
    if (code === 47 && css.charCodeAt(index + 1) === 42) {
      const end: number = css.indexOf("*/", index + 2);
      if (end < 0) {
        unreadable();
        break;
      }
      segment.push(" ");
      index = end + 2;
    } else if (code === 34 || code === 39) {
      const read: { text: string; end: number; open: boolean } = readString(css, index);
      if (read.open || (URL_FUNCTIONS.has(functions.at(-1) ?? "") && !insideEmail(read.text))) {
        unreadable();
      }
      if (read.text.trim() !== "") {
        scan.texts.push(read.text);
      }
      segment.push(" ");
      index = read.end;
    } else if (code === 64) {
      const read: { name: string; end: number } = readName(css, index + 1);
      if (first === null) {
        atRule = read.name.toLowerCase();
      }
      first = first ?? `@${read.name.toLowerCase()}`;
      segment.push(`@${read.name}`);
      index = read.end;
    } else if (isNameCode(code) || code === 92) {
      const read: { name: string; end: number } = readName(css, index);
      // A backslash that starts no escape, before a line break.
      if (read.end === index) {
        index += 1;
        continue;
      }
      const name: string = read.name.toLowerCase();
      first = first ?? name;
      index = read.end;
      const call: boolean = css.charCodeAt(index) === 40;
      if (call && DRAWING_FUNCTIONS.has(name)) {
        unreadable();
      }
      if (property === "content" && (call || !CONTENT_WORDS.has(name))) {
        unreadable();
      }
      if (property === "unicode-bidi" && name !== "normal" && name !== "important") {
        unreadable();
      }
      if (call && name === "url") {
        let next: number = index + 1;
        while (next < css.length && isWhitespace(css.charCodeAt(next))) {
          next += 1;
        }
        if (css.charCodeAt(next) === 34 || css.charCodeAt(next) === 39) {
          functions.push("url");
          index = next;
        } else {
          // An unquoted url() runs to its ), and nothing in it is a comment.
          const close: number = css.indexOf(")", next);
          if (close < 0) {
            unreadable();
            break;
          }
          if (!insideEmail(css.slice(next, close))) {
            unreadable();
          }
          index = close + 1;
        }
        segment.push(" ");
        continue;
      }
      if (call) {
        functions.push(name);
        index += 1;
      }
      segment.push(read.name);
    } else if (code === 40) {
      if (property === "content") {
        unreadable();
      }
      functions.push("");
      segment.push("(");
      index += 1;
    } else if (code === 41) {
      functions.pop();
      segment.push(")");
      index += 1;
    } else if (code === 58) {
      if (!colon && depth > 0) {
        property = first;
        if (depth === fontFace && first === "src") {
          unreadable();
        }
      }
      colon = true;
      segment.push(":");
      index += 1;
    } else if (code === 123) {
      finish(true);
      depth += 1;
      index += 1;
    } else if (code === 59) {
      finish(false);
      index += 1;
    } else if (code === 125) {
      finish(false);
      if (depth === fontFace) {
        fontFace = -1;
      }
      depth = Math.max(floor, depth - 1);
      index += 1;
    } else {
      let end: number = index + 1;
      while (end < css.length && !isSpecial(css.charCodeAt(end))) {
        end += 1;
      }
      const run: string = css.slice(index, end);
      if (property === "content" && run.replace(/[\s!,]/g, "") !== "") {
        unreadable();
      }
      segment.push(run);
      index = end;
    }
  }
  finish(false);
}

// Reads an email's CSS for text a mail client could draw from it. PayOnce does
// not try to tell which CSS draws text: it takes out every string, with CSS
// escapes decoded, and any text that is not CSS it can parse, and puts them in
// front of the reader and the person as "text found inside styles". A font name
// costs nothing there, and whatever a client could draw is there by
// construction. What PayOnce cannot read at all marks the email partly unread:
// an @import, a url() that points outside the email, attr(), which draws an
// attribute's value, and a comment, string or url() left open. The tokenizer
// follows CSS: comments are /* */ only, a string ends at its quote or a line
// break, and an unquoted url() runs to its ). It is one pass, linear in the input.

export interface CssScan {
  // Strings and loose text, in order.
  texts: string[];
  // Something PayOnce cannot read: an @import, a url() outside the email,
  // attr(), or CSS left open.
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

// A url() whose content is inside the email: a cid: part, a data: URL or a
// fragment. Anything else is fetched from outside.
function insideEmail(url: string): boolean {
  const lower: string = url.trim().toLowerCase();
  return lower === "" || lower.startsWith("cid:") || lower.startsWith("data:") || lower.startsWith("#");
}

// Characters that end a run of plain CSS.
function isSpecial(code: number): boolean {
  return (
    code === 34 || code === 39 || code === 47 || code === 92 || code === 64 || code === 58 ||
    code === 59 || code === 123 || code === 125 || code === 40 || isNameCode(code)
  );
}

// Reads a style sheet, or with declarations true the content of a style=""
// attribute, adding its strings and loose text to scan. Loose text is a
// statement at the top level that is not an at-rule and has no block, or a
// declaration with no colon: neither is CSS, and a client may treat it as text.
export function scanCss(css: string, declarations: boolean, scan: CssScan): void {
  const floor: number = declarations ? 1 : 0;
  let depth: number = floor;
  let segment: string[] = [];
  let colon: boolean = false;
  let atRule: string | null = null;
  let urlString: boolean = false;
  // True until the statement has anything but whitespace and comments.
  let blank: boolean = true;
  const finish = (opensBlock: boolean): void => {
    // <!-- and --> are allowed around a style sheet and mean nothing.
    const text: string = segment.join("").replace(/<!--|-->/g, " ").replace(/\s+/g, " ").trim();
    const declaration: boolean = colon;
    const at: string | null = atRule;
    segment = [];
    colon = false;
    atRule = null;
    blank = true;
    if (at === "import") {
      scan.unreadable = true;
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
        scan.unreadable = true;
        break;
      }
      segment.push(" ");
      index = end + 2;
    } else if (code === 34 || code === 39) {
      const read: { text: string; end: number; open: boolean } = readString(css, index);
      if (read.open) {
        scan.unreadable = true;
      }
      if (urlString && !insideEmail(read.text)) {
        scan.unreadable = true;
      }
      urlString = false;
      if (read.text.trim() !== "") {
        scan.texts.push(read.text);
      }
      segment.push(" ");
      index = read.end;
    } else if (code === 64) {
      const read: { name: string; end: number } = readName(css, index + 1);
      if (blank) {
        atRule = read.name.toLowerCase();
      }
      segment.push(`@${read.name}`);
      blank = false;
      index = read.end;
    } else if (isNameCode(code) || code === 92) {
      const read: { name: string; end: number } = readName(css, index);
      // A backslash that starts no escape, before a line break.
      if (read.end === index) {
        index += 1;
        continue;
      }
      const name: string = read.name.toLowerCase();
      index = read.end;
      if (css.charCodeAt(index) === 40 && name === "attr") {
        scan.unreadable = true;
      }
      if (css.charCodeAt(index) === 40 && name === "url") {
        let next: number = index + 1;
        while (next < css.length && isWhitespace(css.charCodeAt(next))) {
          next += 1;
        }
        if (css.charCodeAt(next) === 34 || css.charCodeAt(next) === 39) {
          urlString = true;
          index = next;
        } else {
          const close: number = css.indexOf(")", next);
          if (close < 0) {
            scan.unreadable = true;
            break;
          }
          if (!insideEmail(css.slice(next, close))) {
            scan.unreadable = true;
          }
          index = close + 1;
        }
        segment.push(" ");
        continue;
      }
      segment.push(read.name);
      blank = false;
    } else if (code === 58) {
      colon = true;
      segment.push(":");
      blank = false;
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
      depth = Math.max(floor, depth - 1);
      index += 1;
    } else {
      let end: number = index + 1;
      while (end < css.length && !isSpecial(css.charCodeAt(end))) {
        end += 1;
      }
      const run: string = css.slice(index, end);
      segment.push(run);
      blank = blank && run.trim() === "";
      index = end;
    }
  }
  finish(false);
}

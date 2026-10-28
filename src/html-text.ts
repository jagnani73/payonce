// Turns an email's HTML into the text a person reads. It is one pass with no DOM,
// and it errs on reading more than a mail client shows. Only the content of
// script and style is dropped, and when that content reads like words for a
// person, such as a CSS content string, the result says so and the email counts
// as partly unread. A comment ends where a browser ends it, at --> or --!>, or at
// the end of the input. Nothing inside it opens or closes an element, and its
// text is kept with any markup taken out. Text a client hides with CSS, a title
// and a template are kept too. The reader and the page then see the same text,
// and reading more only adds caution. Every loop moves forward, so the work is
// linear in the input.

const DROPPED: ReadonlySet<string> = new Set<string>(["script", "style"]);
const BREAKS: ReadonlySet<string> = new Set<string>([
  "address", "article", "aside", "blockquote", "br", "caption", "center", "dd", "details",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "summary",
  "table", "tbody", "tfoot", "thead", "tr", "ul",
]);
const CELLS: ReadonlySet<string> = new Set<string>(["td", "th"]);
// A tag whose > is not this close is taken as text, and the scan goes on after
// that much of it, so a stray < costs at most this many characters once.
const MAX_TAG_LENGTH: number = 4096;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00A0", ndash: "\u2013",
  mdash: "\u2014", hellip: "\u2026", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C",
  rdquo: "\u201D", laquo: "\u00AB", raquo: "\u00BB", bull: "\u2022", middot: "\u00B7",
  copy: "\u00A9", reg: "\u00AE", trade: "\u2122", euro: "\u20AC", pound: "\u00A3",
  yen: "\u00A5", cent: "\u00A2", sect: "\u00A7", deg: "\u00B0", times: "\u00D7",
  divide: "\u00F7", shy: "\u00AD", zwnj: "\u200C", zwj: "\u200D", lrm: "\u200E",
  rlm: "\u200F", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009",
};
// Written without a semicolon, HTML still reads these.
const LEGACY: ReadonlySet<string> = new Set<string>(["amp", "lt", "gt", "nbsp"]);
// HTML reads numeric references 0x80 to 0x9F as windows-1252.
const WINDOWS_1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
const ENTITY: RegExp = /&(?:#([0-9]{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}))(;?)/g;
// What is left of comment and CDATA markup once their openers are gone.
const MARKUP_ENDS: RegExp = /--!?>|\]\]>/g;

function fromCode(code: number): string {
  if (code === 9 || code === 10 || code === 12 || code === 13) {
    return " ";
  }
  const mapped: number | undefined = WINDOWS_1252[code];
  if (mapped !== undefined) {
    return String.fromCodePoint(mapped);
  }
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
    return "\uFFFD";
  }
  return String.fromCodePoint(code);
}

// Decodes character references once, in text with no tags left in it, so
// &lt;script&gt; becomes the text <script> and nothing reads it as a tag.
export function decodeEntities(text: string): string {
  return text.replace(
    ENTITY,
    (whole: string, decimal: string | undefined, hex: string | undefined, name: string | undefined, semicolon: string): string => {
      if (decimal !== undefined) {
        return fromCode(Number.parseInt(decimal, 10));
      }
      if (hex !== undefined) {
        return fromCode(Number.parseInt(hex, 16));
      }
      const key: string = (name ?? "").toLowerCase();
      const value: string | undefined = ENTITIES[key];
      if (value !== undefined && (semicolon !== "" || LEGACY.has(key))) {
        return value;
      }
      // &nbspaccount reads as a no-break space and "account".
      const prefix: string | undefined =
        semicolon === "" ? [...LEGACY].find((legacy: string): boolean => key.startsWith(legacy)) : undefined;
      return prefix === undefined
        ? whole
        : `${ENTITIES[prefix] ?? ""}${(name ?? "").slice(prefix.length)}`;
    },
  );
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// A letter, /, ! or ? after < opens a tag.
function opensTag(code: number): boolean {
  return isLetter(code) || code === 47 || code === 33 || code === 63;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

// Where the tag that starts at from ends: the index of its >, honouring quoted
// attribute values, or -1 when there is none within MAX_TAG_LENGTH.
function tagEnd(html: string, from: number, quotes: boolean): number {
  const limit: number = Math.min(html.length, from + MAX_TAG_LENGTH);
  let quote: number = 0;
  let afterEquals: boolean = false;
  for (let index: number = from; index < limit; index += 1) {
    const code: number = html.charCodeAt(index);
    if (quote !== 0) {
      if (code === quote) {
        quote = 0;
      }
      continue;
    }
    if (code === 62) {
      return index;
    }
    if (!quotes) {
      continue;
    }
    if (afterEquals && (code === 34 || code === 39)) {
      quote = code;
      afterEquals = false;
    } else if (code === 61) {
      afterEquals = true;
    } else if (!isSpace(code)) {
      afterEquals = false;
    }
  }
  return -1;
}

function tagName(tag: string): string {
  let end: number = 0;
  while (end < tag.length && end < 32) {
    const code: number = tag.charCodeAt(end);
    if (!isLetter(code) && !(code >= 48 && code <= 57)) {
      break;
    }
    end += 1;
  }
  return tag.slice(0, end).toLowerCase();
}

interface Span {
  start: number;
  end: number;
}

// The element's closing tag: </name followed by whitespace, / or >, in any case,
// from its < to just after its >. Null when there is none, and missing remembers
// where a search found none, so a later search for the same name gives up at once.
function closeOf(html: string, from: number, name: string, missing: Map<string, number>): Span | null {
  const known: number | undefined = missing.get(name);
  if (known !== undefined && known <= from) {
    return null;
  }
  let position: number = from;
  for (;;) {
    const open: number = html.indexOf("</", position);
    if (open < 0) {
      missing.set(name, from);
      return null;
    }
    const after: number = open + 2 + name.length;
    if (html.slice(open + 2, after).toLowerCase() === name) {
      const next: number = after < html.length ? html.charCodeAt(after) : 62;
      if (isSpace(next) || next === 47 || next === 62) {
        const end: number = html.indexOf(">", after);
        return { start: open, end: end < 0 ? html.length : end + 1 };
      }
    }
    position = open + 2;
  }
}

// A comment whose content starts at from: the content runs to its --> or --!>,
// or to the end of the input, which ends an unclosed comment.
function commentOf(html: string, from: number): Span {
  let position: number = from;
  for (;;) {
    const dashes: number = html.indexOf("--", position);
    if (dashes < 0) {
      return { start: html.length, end: html.length };
    }
    if (html.charCodeAt(dashes + 2) === 62) {
      return { start: dashes, end: dashes + 3 };
    }
    if (html.startsWith("!>", dashes + 2)) {
      return { start: dashes, end: dashes + 4 };
    }
    position = dashes + 1;
  }
}

// A comment's content with anything tag-like taken out and its text kept, so an
// Outlook conditional comment reads as Outlook shows it. Nothing in it opens or
// closes an element.
function commentText(content: string): string {
  const parts: string[] = [];
  const condition: RegExpExecArray | null = /^\[if [^\]>]{0,100}\]>/.exec(content.slice(0, 110));
  let index: number = condition === null ? 0 : condition[0].length;
  const trimmed: string = content.trimEnd();
  const stop: number = trimmed.endsWith("<![endif]") ? trimmed.length - 9 : content.length;
  while (index < stop) {
    let open: number = content.indexOf("<", index);
    while (open >= 0 && open < stop && !opensTag(content.charCodeAt(open + 1))) {
      open = content.indexOf("<", open + 1);
    }
    if (open < 0 || open >= stop) {
      parts.push(content.slice(index, stop));
      break;
    }
    parts.push(content.slice(index, open));
    const end: number = tagEnd(content, open + 1, false);
    if (end < 0 || end >= stop) {
      const window: number = Math.min(stop, open + MAX_TAG_LENGTH);
      parts.push(content.slice(open, window));
      index = window;
      continue;
    }
    parts.push(" ");
    index = end + 1;
  }
  return parts.join("");
}

// Script and style with CSS and script comments taken out. Each kind of comment
// is searched for once from where the last one was found, so this stays linear.
function withoutCodeComments(code: string): string {
  const parts: string[] = [];
  let index: number = 0;
  let block: number = code.indexOf("/*");
  let line: number = code.indexOf("//");
  while (index < code.length) {
    if (block >= 0 && block < index) {
      block = code.indexOf("/*", index);
    }
    if (line >= 0 && line < index) {
      line = code.indexOf("//", index);
    }
    if (block < 0 && line < 0) {
      parts.push(code.slice(index));
      break;
    }
    const start: number = block < 0 ? line : line < 0 ? block : Math.min(block, line);
    parts.push(code.slice(index, start), " ");
    const close: number = start === block ? code.indexOf("*/", start + 2) : code.indexOf("\n", start + 2);
    index = close < 0 ? code.length : close + (start === block ? 2 : 1);
  }
  return parts.join("");
}

// Four or more words of letters in a row, which reads as something meant for a
// person. CSS such as "@media only screen and" stops short of it.
function wordRun(text: string): boolean {
  let run: number = 0;
  for (const token of text.split(/\s+/)) {
    const word: string = /[.,;:!?]$/.test(token) ? token.slice(0, -1) : token;
    run = word.length >= 2 && /^\p{L}+$/u.test(word) ? run + 1 : 0;
    if (run >= 4) {
      return true;
    }
  }
  return false;
}

// True when dropped script or style content holds words for a person: a run of
// them, or one inside a quoted string, such as content:"Pay our new account".
function looksVisible(content: string): boolean {
  const code: string = withoutCodeComments(content);
  if (wordRun(code)) {
    return true;
  }
  let index: number = 0;
  let double: number = code.indexOf("\"");
  let single: number = code.indexOf("'");
  while (index < code.length) {
    if (double >= 0 && double < index) {
      double = code.indexOf("\"", index);
    }
    if (single >= 0 && single < index) {
      single = code.indexOf("'", index);
    }
    const open: number = double < 0 ? single : single < 0 ? double : Math.min(double, single);
    if (open < 0) {
      return false;
    }
    const close: number = code.indexOf(code.charAt(open), open + 1);
    if (close < 0) {
      return false;
    }
    if (wordRun(code.slice(open + 1, close))) {
      return true;
    }
    index = close + 1;
  }
  return false;
}

function altOf(tag: string): string {
  const match: RegExpExecArray | null = /(?:^|\s)alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
  return match === null ? "" : decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
}

// The text of an HTML part. hiddenText is true when script or style content
// PayOnce dropped reads like words a person could be shown.
export interface HtmlText {
  text: string;
  hiddenText: boolean;
}

export function htmlToText(html: string): HtmlText {
  const out: string[] = [];
  const missing: Map<string, number> = new Map<string, number>();
  let preDepth: number = 0;
  let hiddenText: boolean = false;
  const text = (chunk: string): void => {
    if (chunk === "") {
      return;
    }
    const decoded: string = decodeEntities(chunk.replace(MARKUP_ENDS, ""));
    out.push(preDepth > 0 ? decoded : decoded.replace(/\s+/g, " "));
  };
  let index: number = 0;
  while (index < html.length) {
    // Only a < followed by a letter, /, ! or ? opens a tag in HTML. Any other is
    // text, and stays in the run around it.
    let open: number = html.indexOf("<", index);
    while (open >= 0 && !opensTag(html.charCodeAt(open + 1))) {
      open = html.indexOf("<", open + 1);
    }
    if (open < 0) {
      text(html.slice(index));
      break;
    }
    text(html.slice(index, open));
    index = open;
    if (html.startsWith("<!--", index)) {
      // <!--> and <!---> are whole comments in HTML.
      if (html.startsWith("<!-->", index) || html.startsWith("<!--->", index)) {
        index += html.startsWith("<!-->", index) ? 5 : 6;
        continue;
      }
      const comment: Span = commentOf(html, index + 4);
      text(commentText(html.slice(index + 4, comment.start)));
      index = comment.end;
      continue;
    }
    const next: number = html.charCodeAt(index + 1);
    // <!DOCTYPE>, <![CDATA[, <!x> and <?x> are bogus comments, which end at the
    // first >, quotes or not.
    const bogus: boolean = next === 33 || next === 63;
    const end: number = tagEnd(html, index + 1, !bogus);
    if (end < 0) {
      const stop: number = Math.min(html.length, index + MAX_TAG_LENGTH);
      text(html.slice(index, stop));
      index = stop;
      continue;
    }
    const tag: string = html.slice(index + 1, end);
    index = end + 1;
    if (bogus) {
      continue;
    }
    const closing: boolean = next === 47;
    const name: string = tagName(closing ? tag.slice(1) : tag);
    if (!closing && DROPPED.has(name)) {
      // With no closing tag the content is read as text, which shows more.
      const close: Span | null = closeOf(html, index, name, missing);
      if (close !== null) {
        hiddenText = hiddenText || looksVisible(html.slice(index, close.start));
        index = close.end;
      }
      continue;
    }
    if (name === "pre") {
      preDepth = Math.max(0, preDepth + (closing ? -1 : 1));
    }
    if (name === "li" && !closing) {
      out.push("\n- ");
    } else if (BREAKS.has(name)) {
      out.push("\n");
    } else if (CELLS.has(name)) {
      out.push(" ");
    } else if (name === "img" && !closing) {
      // Clients show the alt text while images are blocked.
      const alt: string = altOf(tag);
      if (alt !== "") {
        out.push(` [image: ${alt}] `);
      }
    }
  }
  return {
    text: out
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/ {2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    hiddenText,
  };
}

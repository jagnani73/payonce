import { createHash } from "node:crypto";
import { storable } from "./audit-trail.js";
import type { EmailAttachment } from "./emails.js";
import { htmlToText, type HtmlText } from "./html-text.js";

// Reads a raw email (an .eml file, or the source a mail client shows) into the
// sender, subject, text and attachment list PayOnce keeps. It works on bytes,
// needs no dependency and never throws on input: anything it cannot read is
// refused with PayOnce's own words, never the email's. Every byte is untrusted.
// Every scan moves forward, every loop and the nesting are capped, and nothing is
// fetched, opened or written, so a crafted file cannot hang or crash it.

export const MAX_EMAIL_BYTES: number = 2 * 1024 * 1024;
export const MAX_BODY_CHARS: number = 32_000;
// The text found inside styles and scripts, read and shown apart from the body.
export const MAX_STYLE_CHARS: number = 8_000;
// Neither has an @, so the sender check flags both.
export const SENDER_UNREADABLE: string = "(no sender address PayOnce could read)";
export const REPLY_TO_UNREADABLE: string = "(a Reply-To address PayOnce could not read)";

const MAX_HEADER_BLOCK: number = 64 * 1024;
const MAX_HEADER_TOTAL: number = 256 * 1024;
const MAX_FIELDS: number = 300;
const MAX_FIELD: number = 16 * 1024;
const MAX_ENCODED_WORDS: number = 64;
const MAX_PARAMS: number = 32;
const MAX_DEPTH: number = 8;
const MAX_PARTS: number = 100;
const MAX_TEXT_PARTS: number = 16;
const MAX_ATTACHMENTS: number = 50;
const MAX_REPLY_TO: number = 5;
const MAX_COMMENT_DEPTH: number = 8;
// The parts a signature may follow in multipart/signed.
const SIGNATURE_TYPES: ReadonlySet<string> = new Set<string>([
  "application/pgp-signature",
  "application/pkcs7-signature",
  "application/x-pkcs7-signature",
]);

// PayOnce's notes about an email. They are codes, shown in PayOnce's words and
// kept apart from the text a sender wrote, so an email cannot forge one.
export type EmailNote =
  | "cut"
  | "text-attachment"
  | "forwarded"
  | "sealed"
  | "too-many-text"
  | "undecodable"
  | "skipped-line"
  | "repeated-mime"
  | "encoded-header"
  | "two-subjects"
  | "unclosed-multipart"
  | "odd-type"
  | "early-padding"
  | "signed"
  | "message-id"
  | "versions-differ"
  | "only-attachments"
  | "more-attachments"
  | "style-unreadable"
  | "styles-cut"
  | "signed-parts";

export const NOTE_TEXT: Record<EmailNote, string> = {
  cut: `PayOnce kept the first ${MAX_BODY_CHARS.toLocaleString("en-US")} characters of its text. Nobody read the rest`,
  "text-attachment": "It has text in an attachment or a part PayOnce does not read",
  forwarded: "It carries a forwarded email, which PayOnce does not read",
  sealed: "It is encrypted, or signed in a way that hides its text, so PayOnce could not read it",
  "too-many-text": `It has more than ${MAX_TEXT_PARTS} text parts. PayOnce read the first ${MAX_TEXT_PARTS}`,
  undecodable: "Part of its text is in a character set or encoding PayOnce cannot decode",
  "skipped-line": "A line among its headers is not a header field, so PayOnce skipped it",
  "repeated-mime": "It repeats a Content-Type, Content-Transfer-Encoding, boundary or charset, and mail clients disagree on which one counts",
  "encoded-header": "A header has encoded text in a character set PayOnce cannot decode, so it is shown as written",
  "two-subjects": "It has two Subject fields, shown joined with a bar",
  "unclosed-multipart": "A multipart section has no closing boundary, so its last part runs to the end",
  "odd-type": "A Content-Type could not be read, so that part is shown as plain text, and a mail client may show it as HTML",
  "early-padding": "Its base64 text has padding before the end. PayOnce decoded all of it",
  signed: "It is signed. PayOnce does not check signatures",
  "message-id": "Its Message-ID could not be read",
  "versions-differ": "Its plain-text and HTML versions do not say the same thing, so both are shown",
  "only-attachments": "It has no text, only attachments, which PayOnce does not open",
  "more-attachments": `It has more than ${MAX_ATTACHMENTS} attachments. PayOnce lists the first ${MAX_ATTACHMENTS}`,
  "style-unreadable": "Its styles or markup could make a mail client show characters PayOnce did not read as text, such as a web font, a counter, a reversed run or a style sheet from outside the email. Read it in your own mail client",
  "styles-cut": `PayOnce kept the first ${MAX_STYLE_CHARS.toLocaleString("en-US")} characters of the text found inside its styles. Nobody read the rest`,
  "signed-parts": "Its signed section has more than two parts, and mail clients disagree on which to show",
};

// Notes about text nobody read. An email with any of them counts as partly
// unread, and the invoice goes to a person.
export const PARTIAL_NOTES: ReadonlySet<EmailNote> = new Set<EmailNote>([
  "cut",
  "text-attachment",
  "forwarded",
  "sealed",
  "too-many-text",
  "undecodable",
  "skipped-line",
  "repeated-mime",
  "encoded-header",
  "odd-type",
  "style-unreadable",
  "styles-cut",
  "signed-parts",
]);

// The notes as PayOnce words them. A code it does not know is left out.
export function noteTexts(codes: string[]): string[] {
  return codes
    .filter((code: string): code is EmailNote => Object.hasOwn(NOTE_TEXT, code))
    .map((code: EmailNote): string => NOTE_TEXT[code]);
}

export interface ParsedEmail {
  messageId: string | null;
  // The Date header as written, for display only. It never orders or decides.
  dateAsWritten: string;
  // A bare address, or SENDER_UNREADABLE.
  from: string;
  // The display name, never checked or compared.
  fromName: string;
  fromAsWritten: string;
  // Bare addresses, or [REPLY_TO_UNREADABLE].
  replyTo: string[];
  subject: string;
  body: string;
  // Text found inside the HTML's styles and scripts: every CSS string, style
  // text that is not CSS, and script text. Read and shown apart from the body.
  styleText: string;
  attachments: EmailAttachment[];
  notes: EmailNote[];
  partial: boolean;
  rawSha256: string;
  // The SHA-256 of the bytes with CRLF read as LF, so a second upload of the same
  // file, or of its source pasted, is found.
  contentHash: string;
  rawBytes: number;
}

export type ParsedUpload = { ok: true; email: ParsedEmail } | { ok: false; error: string; tooLarge: boolean };

export type UploadSource = "file" | "paste";

class Refusal extends Error {}

const NOT_SOURCE: string =
  "This does not look like raw email source. Save the email as an .eml file, or paste its source (Show original or View source in the mail client), not the text it shows";

// What a walk over the parts has found so far.
interface Walk {
  source: UploadSource;
  notes: Set<EmailNote>;
  texts: string[];
  styleTexts: string[];
  read: Set<string>;
  attachments: EmailAttachment[];
  moreAttachments: number;
  parts: number;
  textParts: number;
  headerBytes: number;
}

interface Headers {
  fields: Map<string, string[]>;
  bodyStart: number;
}

interface ContentType {
  type: string;
  params: Map<string, string>;
}

const FIELD_NAME: RegExp = /^([!-9;-~]+):/;
const UTF8: TextDecoder = new TextDecoder("utf-8");

// ---------- strings ----------

const CONTROLS: RegExp = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Spaces other than U+0020, and letters that draw as a blank.
const SPACES: RegExp = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0\u2800]/g;
// Characters a mail client does not draw: soft hyphens, zero-width spaces,
// joiners, bidi controls, variation selectors and the Unicode tag block.
const INVISIBLE: RegExp = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

// Every string kept from an email goes through this: no control character, so
// no terminal escape reaches a timeline line printed by note(), and nothing a
// client would not draw, so the reader and the page see the same text.
export function cleanText(text: string): string {
  return storable(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(SPACES, " ")
    .replace(INVISIBLE, "")
    .replace(CONTROLS, "");
}

// One line, every whitespace run one space, cut with an ellipsis.
export function cleanLine(text: string, cap: number): string {
  const line: string = cleanText(text).replace(/\s+/g, " ").trim();
  return line.length > cap ? `${storable(line.slice(0, cap - 1))}\u2026` : line;
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter: string): string => letter.toLowerCase());
}

// ---------- charsets ----------

// Labels mail uses that TextDecoder does not know.
const ALIASES: Record<string, string> = {
  cp932: "shift_jis",
  cp949: "euc-kr",
  cp936: "gbk",
  "euc-cn": "gbk",
};

// A decoder for a MIME charset label, by the WHATWG names TextDecoder takes, or
// null for one it refuses (utf-7, utf-32, iso-2022-kr, hz-gb-2312) and for
// x-user-defined, which maps bytes into the private use area. A UTF-16 part that
// starts with a big-endian byte order mark is read big-endian.
function decoderFor(label: string, bytes: Buffer | null): TextDecoder | null {
  // Every label is short, and a long one would only feed the quote trim below.
  if (label.length > 40) {
    return null;
  }
  const lower: string = asciiLower(label.trim().replace(/^["']+|["']+$/g, ""));
  const name: string = ALIASES[lower] ?? lower;
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(name, { fatal: false });
  } catch {
    return null;
  }
  if (decoder.encoding === "x-user-defined" || decoder.encoding === "replacement") {
    return null;
  }
  if (decoder.encoding === "utf-16le" && bytes !== null && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: false });
  }
  return decoder;
}

// ---------- transfer encodings ----------

const BASE64_VALUES: Int16Array = (() => {
  const table: Int16Array = new Int16Array(128).fill(-1);
  const alphabet: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let index: number = 0; index < alphabet.length; index += 1) {
    table[alphabet.charCodeAt(index)] = index;
  }
  return table;
})();

// Decodes the whole part, one quad at a time. Padding ends a quad, not the part,
// so a mailer that pads every line loses nothing, and neither does text hidden
// after an early =. Characters outside the alphabet are skipped.
function decodeBase64(bytes: Buffer, walk: Walk): Buffer {
  const out: Buffer = Buffer.alloc(Math.floor((bytes.length * 3) / 4) + 3);
  let length: number = 0;
  let quad: number = 0;
  let filled: number = 0;
  let padded: boolean = false;
  let early: boolean = false;
  for (const byte of bytes) {
    if (byte === 61) {
      if (filled === 2) {
        out[length++] = (quad >> 4) & 0xff;
      } else if (filled === 3) {
        out[length++] = (quad >> 10) & 0xff;
        out[length++] = (quad >> 2) & 0xff;
      }
      padded = padded || filled > 0;
      quad = 0;
      filled = 0;
      continue;
    }
    const value: number = byte < 128 ? (BASE64_VALUES[byte] ?? -1) : -1;
    if (value < 0) {
      continue;
    }
    early = early || padded;
    quad = (quad << 6) | value;
    filled += 1;
    if (filled === 4) {
      out[length++] = (quad >> 16) & 0xff;
      out[length++] = (quad >> 8) & 0xff;
      out[length++] = quad & 0xff;
      quad = 0;
      filled = 0;
    }
  }
  if (filled === 2) {
    out[length++] = (quad >> 4) & 0xff;
  } else if (filled === 3) {
    out[length++] = (quad >> 10) & 0xff;
    out[length++] = (quad >> 2) & 0xff;
  }
  if (early) {
    walk.notes.add("early-padding");
  }
  return out.subarray(0, length);
}

function hexValue(byte: number): number {
  if (byte >= 48 && byte <= 57) {
    return byte - 48;
  }
  if (byte >= 65 && byte <= 70) {
    return byte - 55;
  }
  if (byte >= 97 && byte <= 102) {
    return byte - 87;
  }
  return -1;
}

// =XX is a byte, in either case. = then optional spaces and a line end is a soft
// break. Any other = stays as written.
function decodeQuotedPrintable(bytes: Buffer): Buffer {
  const out: Buffer = Buffer.alloc(bytes.length);
  let length: number = 0;
  let index: number = 0;
  while (index < bytes.length) {
    const byte: number = bytes[index] ?? 0;
    if (byte !== 61) {
      out[length++] = byte;
      index += 1;
      continue;
    }
    const high: number = hexValue(bytes[index + 1] ?? 0);
    const low: number = hexValue(bytes[index + 2] ?? 0);
    if (high >= 0 && low >= 0) {
      out[length++] = high * 16 + low;
      index += 3;
      continue;
    }
    let next: number = index + 1;
    while (bytes[next] === 32 || bytes[next] === 9) {
      next += 1;
    }
    if (bytes[next] === 10) {
      index = next + 1;
    } else if (bytes[next] === 13 && bytes[next + 1] === 10) {
      index = next + 2;
    } else if (next >= bytes.length) {
      index = next;
    } else {
      out[length++] = byte;
      index += 1;
    }
  }
  return out.subarray(0, length);
}

// The part's bytes after its transfer encoding, or null for an encoding PayOnce
// does not decode, such as x-uuencode.
function decodeTransfer(bytes: Buffer, encoding: string, walk: Walk): Buffer | null {
  switch (encoding) {
    case "":
    case "7bit":
    case "8bit":
    case "binary":
      return bytes;
    case "quoted-printable":
      return decodeQuotedPrintable(bytes);
    case "base64":
      return decodeBase64(bytes, walk);
    default:
      return null;
  }
}

// ---------- headers ----------

// RFC 2047 encoded words, decoded only in unstructured text: a subject, a display
// name, a file name. Words next to each other lose the space between them, and
// words in one charset have their bytes joined first, so a character split across
// two words survives. A charset PayOnce cannot decode leaves the words as written.
function decodeWords(value: string, walk: Walk): string {
  const pattern: RegExp = /=\?([^?\s]{1,40})\?([BbQq])\?([^?\s]{0,1000})\?=/g;
  interface Piece {
    text: string;
    charset: string | null;
    bytes: Buffer | null;
  }
  const pieces: Piece[] = [];
  let last: number = 0;
  let count: number = 0;
  for (let match: RegExpExecArray | null = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    if (count >= MAX_ENCODED_WORDS) {
      break;
    }
    count += 1;
    const between: string = value.slice(last, match.index);
    const previous: Piece | undefined = pieces.at(-1);
    if (!(previous?.charset !== null && previous !== undefined && /^\s*$/.test(between))) {
      pieces.push({ text: between, charset: null, bytes: null });
    }
    const charset: string = asciiLower((match[1] ?? "").split("*")[0] ?? "");
    const encoded: string = match[3] ?? "";
    const bytes: Buffer =
      (match[2] ?? "").toUpperCase() === "B"
        ? decodeBase64(Buffer.from(encoded, "latin1"), { ...walk, notes: new Set<EmailNote>() })
        : decodeQuotedPrintable(Buffer.from(encoded.replaceAll("_", " "), "latin1"));
    const before: Piece | undefined = pieces.at(-1);
    if (before !== undefined && before.charset === charset && before.bytes !== null) {
      before.bytes = Buffer.concat([before.bytes, bytes]);
      before.text += match[0];
    } else {
      pieces.push({ text: match[0], charset, bytes });
    }
    last = match.index + match[0].length;
  }
  pieces.push({ text: value.slice(last), charset: null, bytes: null });
  return pieces
    .map((piece: Piece): string => {
      if (piece.charset === null || piece.bytes === null) {
        return piece.text;
      }
      const decoder: TextDecoder | null = decoderFor(piece.charset, piece.bytes);
      if (decoder === null) {
        walk.notes.add("encoded-header");
        return piece.text;
      }
      return decoder.decode(piece.bytes);
    })
    .join("");
}

// The header block that starts at start: its fields by lowercase name, in order,
// and where the body begins. It ends at the first line that is empty once a
// trailing CR is gone. A line that is neither a field nor a continuation is
// skipped, and noted, because a mail client may read it differently.
function readHeaders(raw: Buffer, start: number, end: number, walk: Walk): Headers {
  const fields: Map<string, string[]> = new Map<string, string[]>();
  let current: { name: string; value: string } | null = null;
  let count: number = 0;
  const finish = (): void => {
    if (current === null) {
      return;
    }
    const value: string = current.value.trim();
    if (value.length > MAX_FIELD) {
      if (["from", "content-type", "content-transfer-encoding", "reply-to"].includes(current.name)) {
        throw new Refusal(`Its ${current.name} header is longer than ${MAX_FIELD / 1024} KB`);
      }
    }
    const list: string[] = fields.get(current.name) ?? [];
    list.push(value.slice(0, MAX_FIELD));
    fields.set(current.name, list);
    current = null;
  };
  let position: number = start;
  let bodyStart: number = end;
  while (position < end) {
    let newline: number = raw.indexOf(0x0a, position);
    if (newline < 0 || newline >= end) {
      newline = end;
    }
    let lineEnd: number = newline;
    if (lineEnd > position && raw[lineEnd - 1] === 0x0d) {
      lineEnd -= 1;
    }
    if (lineEnd === position) {
      bodyStart = Math.min(newline + 1, end);
      break;
    }
    if (newline - start > MAX_HEADER_BLOCK) {
      throw new Refusal(`No blank line ends its headers within ${MAX_HEADER_BLOCK / 1024} KB`);
    }
    const line: string = UTF8.decode(raw.subarray(position, lineEnd));
    position = newline + 1;
    const first: number = line.charCodeAt(0);
    if ((first === 32 || first === 9) && current !== null) {
      const field: { name: string; value: string } = current;
      if (field.value.length <= MAX_FIELD) {
        field.value += line;
      }
      continue;
    }
    const match: RegExpExecArray | null = FIELD_NAME.exec(line);
    if (match === null) {
      finish();
      walk.notes.add("skipped-line");
      continue;
    }
    finish();
    count += 1;
    if (count > MAX_FIELDS) {
      throw new Refusal(`It has more than ${MAX_FIELDS} header fields in one block`);
    }
    current = { name: asciiLower(match[1] ?? ""), value: line.slice((match[0] ?? "").length) };
  }
  finish();
  walk.headerBytes += Math.min(bodyStart, end) - start;
  if (walk.headerBytes > MAX_HEADER_TOTAL) {
    throw new Refusal(`Its headers add up to more than ${MAX_HEADER_TOTAL / 1024} KB`);
  }
  return { fields, bodyStart: Math.min(bodyStart, end) };
}

// Splits at a character outside double quotes, which may hold \ escapes.
function splitOutsideQuotes(value: string, separator: string): string[] {
  const pieces: string[] = [];
  let piece: string = "";
  let quoted: boolean = false;
  for (let index: number = 0; index < value.length; index += 1) {
    const char: string = value.charAt(index);
    if (quoted && char === "\\") {
      piece += char + value.charAt(index + 1);
      index += 1;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
    }
    if (char === separator && !quoted) {
      pieces.push(piece);
      piece = "";
      continue;
    }
    piece += char;
  }
  pieces.push(piece);
  return pieces;
}

function unquote(value: string): string {
  const trimmed: string = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

function percentBytes(value: string): Buffer {
  const out: number[] = [];
  for (let index: number = 0; index < value.length; index += 1) {
    const code: number = value.charCodeAt(index);
    const high: number = hexValue(value.charCodeAt(index + 1));
    const low: number = hexValue(value.charCodeAt(index + 2));
    if (code === 37 && high >= 0 && low >= 0) {
      out.push(high * 16 + low);
      index += 2;
    } else {
      out.push(code & 0xff);
    }
  }
  return Buffer.from(out);
}

// A Content-Type or Content-Disposition value: the lowercase type and its
// parameters, with RFC 2231 values (name*=utf-8''%E2%82%AC, and name*0*, name*1*
// continuations) put together and decoded. A parameter given twice is noted.
function parseParameters(value: string, walk: Walk): ContentType {
  const [head, ...rest] = splitOutsideQuotes(value, ";");
  if (rest.length > MAX_PARAMS) {
    throw new Refusal(`A header has more than ${MAX_PARAMS} parameters`);
  }
  const plain: Map<string, string> = new Map<string, string>();
  const segments: Map<string, { index: number; value: string; extended: boolean }[]> = new Map();
  for (const piece of rest) {
    const equals: number = piece.indexOf("=");
    if (equals < 0) {
      continue;
    }
    const name: string = asciiLower(piece.slice(0, equals).trim());
    const raw: string = piece.slice(equals + 1).trim();
    const split: RegExpExecArray | null = /^([^*]+)\*(?:([0-9]{1,2})(\*)?)?$/.exec(name);
    if (split === null) {
      if (plain.has(name)) {
        walk.notes.add("repeated-mime");
        continue;
      }
      plain.set(name, unquote(raw));
      continue;
    }
    const base: string = split[1] ?? "";
    const list: { index: number; value: string; extended: boolean }[] = segments.get(base) ?? [];
    const index: number = split[2] === undefined ? 0 : Number(split[2]);
    if (list.some((segment: { index: number }): boolean => segment.index === index)) {
      walk.notes.add("repeated-mime");
      continue;
    }
    list.push({ index, value: unquote(raw), extended: split[2] === undefined || split[3] === "*" });
    segments.set(base, list);
  }
  const params: Map<string, string> = new Map<string, string>(plain);
  for (const [base, list] of segments) {
    list.sort((a: { index: number }, b: { index: number }): number => a.index - b.index);
    let charset: string = "us-ascii";
    const bytes: Buffer[] = list.map((segment: { index: number; value: string; extended: boolean }, position: number): Buffer => {
      let text: string = segment.value;
      if (position === 0 && segment.extended) {
        const parts: string[] = text.split("'");
        if (parts.length >= 3) {
          charset = parts[0] || "us-ascii";
          text = parts.slice(2).join("'");
        }
      }
      return segment.extended ? percentBytes(text) : Buffer.from(text, "latin1");
    });
    const joined: Buffer = Buffer.concat(bytes);
    const decoder: TextDecoder | null = decoderFor(charset, joined);
    if (decoder === null) {
      walk.notes.add("encoded-header");
      continue;
    }
    params.set(base, decoder.decode(joined));
  }
  return { type: asciiLower((head ?? "").trim()), params };
}

// ---------- addresses ----------

const LOCAL_PART: RegExp = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL: RegExp = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

// A bare addr-spec of printable ASCII: a dot-atom local part and a domain of at
// least two letter-digit-hyphen labels. A quoted local part, an address literal,
// a route or any character outside ASCII is not one. Case is kept as written.
export function validAddress(address: string): boolean {
  if (!/^[\x21-\x7e]{3,320}$/.test(address)) {
    return false;
  }
  const at: number = address.lastIndexOf("@");
  if (at < 1 || address.indexOf("@") !== at) {
    return false;
  }
  const local: string = address.slice(0, at);
  const domain: string = address.slice(at + 1);
  if (local.length > 64 || domain.length > 253 || !LOCAL_PART.test(local)) {
    return false;
  }
  const labels: string[] = domain.split(".");
  return labels.length >= 2 && labels.every((label: string): boolean => LABEL.test(label));
}

// A plain ASCII domain, as a pay run's supplier_domain must be.
export function validDomain(domain: string): boolean {
  return validAddress(`x@${domain}`);
}

interface Mailbox {
  address: string;
  name: string;
}

// The mailboxes of an address header, split at commas outside quotes, comments
// and angle brackets. Null when it cannot be read: an unclosed quote, comment or
// bracket, comments nested deeper than 8, or group syntax.
function splitMailboxes(value: string): string[] | null {
  const boxes: string[] = [];
  let box: string = "";
  let quoted: boolean = false;
  let depth: number = 0;
  let angled: boolean = false;
  for (let index: number = 0; index < value.length; index += 1) {
    const char: string = value.charAt(index);
    if ((quoted || depth > 0) && char === "\\") {
      box += char + value.charAt(index + 1);
      index += 1;
      continue;
    }
    if (quoted) {
      quoted = char !== "\"";
    } else if (depth > 0) {
      depth += char === "(" ? 1 : char === ")" ? -1 : 0;
      if (depth > MAX_COMMENT_DEPTH) {
        return null;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === "(") {
      depth = 1;
    } else if (char === "<") {
      angled = true;
    } else if (char === ">") {
      angled = false;
    } else if (!angled && (char === ":" || char === ";")) {
      return null;
    } else if (!angled && char === ",") {
      boxes.push(box);
      box = "";
      continue;
    }
    box += char;
  }
  if (quoted || depth > 0 || angled) {
    return null;
  }
  boxes.push(box);
  return boxes.filter((entry: string): boolean => entry.trim() !== "");
}

// One mailbox: exactly one <addr-spec>, with the display name before it, or a
// bare addr-spec. Comments are dropped. Anything else is null, so a display name
// that holds an address never wins over the angle address.
function readMailbox(value: string, walk: Walk): Mailbox | null {
  let name: string = "";
  let inside: string = "";
  let after: string = "";
  let quotedName: boolean = false;
  let place: "name" | "inside" | "after" = "name";
  let angles: number = 0;
  let depth: number = 0;
  let quoted: boolean = false;
  for (let index: number = 0; index < value.length; index += 1) {
    const char: string = value.charAt(index);
    if (depth > 0) {
      if (char === "\\") {
        index += 1;
      } else if (char === "(") {
        depth += 1;
        if (depth > MAX_COMMENT_DEPTH) {
          return null;
        }
      } else if (char === ")") {
        depth -= 1;
      }
      continue;
    }
    if (quoted) {
      if (char === "\\") {
        name += value.charAt(index + 1);
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        name += char;
      }
      continue;
    }
    if (char === "(") {
      depth = 1;
    } else if (char === "\"") {
      if (place !== "name") {
        return null;
      }
      quoted = true;
      quotedName = true;
    } else if (char === "<") {
      if (place !== "name") {
        return null;
      }
      place = "inside";
    } else if (char === ">") {
      if (place !== "inside") {
        return null;
      }
      place = "after";
      angles += 1;
    } else if (place === "name") {
      name += char;
    } else if (place === "inside") {
      inside += char;
    } else {
      after += char;
    }
  }
  if (depth > 0 || quoted || place === "inside" || after.trim() !== "") {
    return null;
  }
  if (angles === 1) {
    const address: string = inside.trim();
    return validAddress(address)
      ? { address, name: cleanLine(decodeWords(name, walk), 120) }
      : null;
  }
  const address: string = name.trim();
  return !quotedName && validAddress(address) ? { address, name: "" } : null;
}

// ---------- the parts ----------

function addAttachment(walk: Walk, attachment: EmailAttachment): void {
  if (walk.attachments.length >= MAX_ATTACHMENTS) {
    walk.moreAttachments += 1;
    walk.notes.add("more-attachments");
    return;
  }
  walk.attachments.push(attachment);
}

// The size of an attachment from its encoded length. It is never decoded.
function encodedSize(bytes: Buffer, encoding: string): number {
  if (encoding !== "base64") {
    return bytes.length;
  }
  let count: number = 0;
  for (const byte of bytes) {
    if (byte < 128 && (BASE64_VALUES[byte] ?? -1) >= 0) {
      count += 1;
    }
  }
  return Math.floor((count * 3) / 4);
}

function attachmentName(headers: Headers, type: ContentType, walk: Walk): string {
  const disposition: string | undefined = headers.fields.get("content-disposition")?.[0];
  const fromDisposition: string | undefined =
    disposition === undefined ? undefined : parseParameters(disposition, walk).params.get("filename");
  const raw: string = fromDisposition ?? type.params.get("name") ?? "";
  const base: string = decodeWords(raw, walk).split(/[\\/]/).at(-1) ?? "";
  const name: string = cleanLine(base, 120);
  return name === "" ? "(no name)" : name;
}

function listPart(raw: Buffer, headers: Headers, start: number, end: number, type: ContentType, encoding: string, walk: Walk): void {
  addAttachment(walk, {
    name: attachmentName(headers, type, walk),
    type: cleanLine(type.type, 100),
    bytes: encodedSize(raw.subarray(start, end), encoding),
  });
}

// A text part as it is compared with the others: cleaned, with whitespace
// collapsed and case folded, and hashed. Only a part identical to one read
// already is left out, so a plain and an HTML version that differ in an amount,
// an account number or a link are both read.
function sameTextKey(text: string): string {
  const folded: string = cleanText(text).replace(/\s+/g, " ").trim().toLowerCase();
  return folded === "" ? "" : sha256(folded);
}

// format=flowed: a line ending in a space continues on the next, and delsp=yes
// drops that space.
function reflow(text: string, deleteSpace: boolean): string {
  const lines: string[] = [];
  let current: string = "";
  for (const raw of text.split("\n")) {
    const line: string = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const unstuffed: string = line.startsWith(" ") ? line.slice(1) : line;
    if (unstuffed.endsWith(" ") && unstuffed !== "-- ") {
      current += deleteSpace ? unstuffed.slice(0, -1) : unstuffed;
    } else {
      lines.push(current + unstuffed);
      current = "";
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines.join("\n");
}

// A text part's charset: the MIME parameter, else for HTML a <meta charset> in
// its first 1,024 bytes, else UTF-8. Pasted source was decoded by the browser
// already, so its unencoded parts are UTF-8 whatever they say.
function charsetOf(bytes: Buffer, type: ContentType, encoding: string, walk: Walk): string {
  if (walk.source === "paste" && ["", "7bit", "8bit", "binary"].includes(encoding)) {
    return "utf-8";
  }
  const declared: string | undefined = type.params.get("charset");
  if (declared !== undefined && declared.trim() !== "") {
    return declared;
  }
  if (type.type === "text/html") {
    const meta: RegExpExecArray | null = /<meta[^>]{0,200}?charset\s*=\s*["']?([A-Za-z0-9_.:-]{1,40})/i.exec(
      bytes.subarray(0, 1024).toString("latin1"),
    );
    if (meta !== null) {
      return meta[1] ?? "utf-8";
    }
  }
  return "utf-8";
}

function readText(raw: Buffer, start: number, end: number, type: ContentType, encoding: string, walk: Walk): void {
  const bytes: Buffer | null = decodeTransfer(raw.subarray(start, end), encoding, walk);
  const decoder: TextDecoder | null =
    bytes === null ? null : decoderFor(charsetOf(bytes, type, encoding, walk), bytes);
  if (bytes === null || decoder === null) {
    walk.notes.add("undecodable");
    return;
  }
  const decoded: string = decoder.decode(bytes);
  let text: string = decoded;
  if (type.type === "text/html") {
    const html: HtmlText = htmlToText(decoded);
    if (html.unreadable) {
      walk.notes.add("style-unreadable");
    }
    for (const piece of html.styleText) {
      walk.styleTexts.push(piece);
    }
    text = html.text;
  } else if (asciiLower(type.params.get("format") ?? "") === "flowed") {
    text = reflow(decoded, asciiLower(type.params.get("delsp") ?? "") === "yes");
  }
  const key: string = sameTextKey(text);
  if (key === "" || walk.read.has(key)) {
    return;
  }
  walk.read.add(key);
  walk.texts.push(text);
}

const BOUNDARY: RegExp = /^[0-9A-Za-z'()+_,./:=? -]{0,69}[0-9A-Za-z'()+_,./:=?-]$/;

interface Range {
  start: number;
  end: number;
}

// The parts of a multipart body. A delimiter is a whole line: --boundary, an
// optional --, optional spaces, then the line end. The search position only moves
// forward. The preamble and epilogue are dropped. Null when no delimiter is found.
function splitParts(raw: Buffer, start: number, end: number, boundary: string, walk: Walk): Range[] | null {
  const delimiter: Buffer = Buffer.from(`--${boundary}`, "latin1");
  const ranges: Range[] = [];
  let position: number = start;
  let partStart: number = -1;
  let closed: boolean = false;
  let found: boolean = false;
  while (position < end) {
    const hit: number = raw.indexOf(delimiter, position);
    if (hit < 0 || hit + delimiter.length > end) {
      break;
    }
    if (hit !== start && raw[hit - 1] !== 0x0a) {
      position = hit + 1;
      continue;
    }
    let cursor: number = hit + delimiter.length;
    const closing: boolean = raw[cursor] === 0x2d && raw[cursor + 1] === 0x2d && cursor + 1 < end;
    if (closing) {
      cursor += 2;
    }
    while (cursor < end && (raw[cursor] === 0x20 || raw[cursor] === 0x09)) {
      cursor += 1;
    }
    let lineEnd: number;
    if (cursor >= end) {
      lineEnd = end;
    } else if (raw[cursor] === 0x0a) {
      lineEnd = cursor + 1;
    } else if (raw[cursor] === 0x0d && (cursor + 1 >= end || raw[cursor + 1] === 0x0a)) {
      lineEnd = Math.min(cursor + 2, end);
    } else {
      position = hit + 1;
      continue;
    }
    found = true;
    if (partStart >= 0) {
      let partEnd: number = hit;
      if (partEnd > partStart && raw[partEnd - 1] === 0x0a) {
        partEnd -= 1;
      }
      if (partEnd > partStart && raw[partEnd - 1] === 0x0d) {
        partEnd -= 1;
      }
      ranges.push({ start: partStart, end: partEnd });
      if (ranges.length > MAX_PARTS) {
        throw new Refusal(`It has more than ${MAX_PARTS} MIME parts`);
      }
    }
    if (closing) {
      closed = true;
      break;
    }
    partStart = lineEnd;
    position = lineEnd;
  }
  if (!found) {
    return null;
  }
  if (!closed) {
    walk.notes.add("unclosed-multipart");
    if (partStart >= 0) {
      ranges.push({ start: partStart, end });
    }
  }
  return ranges;
}

function walkPart(
  raw: Buffer,
  headers: Headers,
  end: number,
  depth: number,
  boundaries: string[],
  parent: string,
  walk: Walk,
): void {
  walk.parts += 1;
  if (walk.parts > MAX_PARTS) {
    throw new Refusal(`It has more than ${MAX_PARTS} MIME parts`);
  }
  const start: number = headers.bodyStart;
  const types: string[] = headers.fields.get("content-type") ?? [];
  const encodings: string[] = headers.fields.get("content-transfer-encoding") ?? [];
  // Mail clients disagree on which of two counts, so the email is partly unread.
  if (types.length > 1 || encodings.length > 1) {
    walk.notes.add("repeated-mime");
  }
  let type: ContentType =
    types[0] === undefined
      ? { type: parent === "multipart/digest" ? "message/rfc822" : "text/plain", params: new Map<string, string>() }
      : parseParameters(types[0], walk);
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type.type)) {
    walk.notes.add("odd-type");
    type = { type: "text/plain", params: type.params };
  }
  const encoding: string = asciiLower((encodings[0] ?? "").trim());
  const disposition: string | undefined = headers.fields.get("content-disposition")?.[0];
  const attached: boolean =
    disposition !== undefined && parseParameters(disposition, walk).type === "attachment";

  if (type.type.startsWith("multipart/")) {
    if (depth >= MAX_DEPTH) {
      throw new Refusal(`Its multipart sections are nested more than ${MAX_DEPTH} deep`);
    }
    if (type.type === "multipart/encrypted") {
      walk.notes.add("sealed");
      listPart(raw, headers, start, end, type, encoding, walk);
      return;
    }
    const boundary: string = type.params.get("boundary") ?? "";
    if (!BOUNDARY.test(boundary)) {
      throw new Refusal("A multipart section has no boundary PayOnce can read");
    }
    if (boundaries.some((outer: string): boolean => outer.startsWith(boundary) || boundary.startsWith(outer))) {
      throw new Refusal("A multipart boundary repeats, or starts, the boundary of a section around it");
    }
    const ranges: Range[] | null = splitParts(raw, start, end, boundary, walk);
    if (ranges === null) {
      // No part could be told apart, so the whole section is read as text.
      walk.notes.add("unclosed-multipart");
      readText(raw, start, end, { type: "text/plain", params: new Map<string, string>() }, encoding, walk);
      return;
    }
    // A signed section is the signed part and then its signature. Any other part
    // is walked like a part of any section, and a third part makes the email
    // partly unread, because clients disagree on which parts they show.
    const signed: boolean = type.type === "multipart/signed";
    if (signed) {
      walk.notes.add(ranges.length > 2 ? "signed-parts" : "signed");
    }
    const before: number = walk.texts.length;
    ranges.forEach((range: Range, index: number): void => {
      const part: Headers = readHeaders(raw, range.start, range.end, walk);
      const partType: string | undefined = part.fields.get("content-type")?.[0];
      if (signed && index === 1 && partType !== undefined) {
        const signature: ContentType = parseParameters(partType, walk);
        if (SIGNATURE_TYPES.has(signature.type)) {
          walk.parts += 1;
          listPart(raw, part, part.bodyStart, range.end, signature, asciiLower((part.fields.get("content-transfer-encoding")?.[0] ?? "").trim()), walk);
          return;
        }
      }
      walkPart(raw, part, range.end, depth + 1, [...boundaries, boundary], type.type, walk);
    });
    if (type.type === "multipart/alternative" && walk.texts.length - before > 1) {
      walk.notes.add("versions-differ");
    }
    return;
  }

  if (type.type === "message/rfc822" || type.type === "message/global") {
    walk.notes.add("forwarded");
    listPart(raw, headers, start, end, type, encoding, walk);
    return;
  }
  if (type.type === "application/pkcs7-mime" || type.type === "application/x-pkcs7-mime") {
    walk.notes.add("sealed");
    listPart(raw, headers, start, end, type, encoding, walk);
    return;
  }
  const readable: boolean = type.type === "text/plain" || type.type === "text/html";
  if (!readable || attached) {
    // Text a client may show inline, such as a .txt attachment or a calendar
    // invite, is text PayOnce did not read.
    if (type.type.startsWith("text/")) {
      walk.notes.add("text-attachment");
    }
    listPart(raw, headers, start, end, type, encoding, walk);
    return;
  }
  if (walk.textParts >= MAX_TEXT_PARTS) {
    walk.notes.add("too-many-text");
    listPart(raw, headers, start, end, type, encoding, walk);
    return;
  }
  walk.textParts += 1;
  readText(raw, start, end, type, encoding, walk);
}

// ---------- the email ----------

function refused(error: string, tooLarge: boolean = false): ParsedUpload {
  return { ok: false, error, tooLarge };
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function firstLine(raw: Buffer, start: number): string {
  let end: number = raw.indexOf(0x0a, start);
  if (end < 0 || end - start > 1000) {
    end = Math.min(raw.length, start + 1000);
  }
  return raw.subarray(start, end).toString("latin1");
}

function senderOf(fields: Map<string, string[]>, walk: Walk): Mailbox {
  const values: string[] = fields.get("from") ?? [];
  // Clients disagree on which of two From fields they show.
  if (values.length !== 1) {
    return { address: SENDER_UNREADABLE, name: "" };
  }
  const boxes: string[] | null = splitMailboxes(values[0] ?? "");
  const box: Mailbox | null = boxes === null || boxes.length !== 1 ? null : readMailbox(boxes[0] ?? "", walk);
  return box ?? { address: SENDER_UNREADABLE, name: "" };
}

function replyToOf(fields: Map<string, string[]>, walk: Walk): string[] {
  const values: string[] = fields.get("reply-to") ?? [];
  if (values.length === 0) {
    return [];
  }
  const boxes: string[] | null = values.length === 1 ? splitMailboxes(values[0] ?? "") : null;
  if (boxes === null || boxes.length === 0 || boxes.length > MAX_REPLY_TO) {
    return [REPLY_TO_UNREADABLE];
  }
  const addresses: string[] = [];
  for (const box of boxes) {
    const mailbox: Mailbox | null = readMailbox(box, walk);
    if (mailbox === null) {
      return [REPLY_TO_UNREADABLE];
    }
    addresses.push(mailbox.address);
  }
  return [...new Set<string>(addresses)];
}

function messageIdOf(fields: Map<string, string[]>, walk: Walk): string | null {
  const value: string | undefined = fields.get("message-id")?.[0];
  if (value === undefined) {
    return null;
  }
  const match: RegExpExecArray | null = /^\s*<([\x21-\x3d\x3f-\x7e]{1,250})>\s*$/.exec(value);
  if (match === null) {
    walk.notes.add("message-id");
    return null;
  }
  return match[1] ?? null;
}

// Reads an uploaded email, or says why it cannot.
export function parseEmail(raw: Buffer, source: UploadSource): ParsedUpload {
  if (raw.length > MAX_EMAIL_BYTES) {
    return refused("The email is larger than 2 MB. Forward it without attachments, or paste its source without the attachment parts", true);
  }
  if (raw.length >= 4 && raw[0] === 0xd0 && raw[1] === 0xcf && raw[2] === 0x11 && raw[3] === 0xe0) {
    return refused("This is an Outlook .msg file. Save the email as .eml, or paste its source");
  }
  try {
    let start: number = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
    // An mbox file's first line. Nothing splits mbox files, so only one email is read.
    if (firstLine(raw, start).startsWith("From ")) {
      const newline: number = raw.indexOf(0x0a, start);
      start = newline < 0 ? raw.length : newline + 1;
    }
    if (!FIELD_NAME.test(firstLine(raw, start))) {
      return refused(NOT_SOURCE);
    }
    const walk: Walk = {
      source,
      notes: new Set<EmailNote>(),
      texts: [],
      styleTexts: [],
      read: new Set<string>(),
      attachments: [],
      moreAttachments: 0,
      parts: 0,
      textParts: 0,
      headerBytes: 0,
    };
    const top: Headers = readHeaders(raw, start, raw.length, walk);
    if (!top.fields.has("from") && !top.fields.has("subject") && !top.fields.has("content-type")) {
      return refused(NOT_SOURCE);
    }
    walkPart(raw, top, raw.length, 0, [], "", walk);

    const sender: Mailbox = senderOf(top.fields, walk);
    const subjects: string[] = top.fields.get("subject") ?? [];
    if (subjects.length > 1) {
      walk.notes.add("two-subjects");
    }
    const subject: string = cleanLine(
      subjects.map((value: string): string => decodeWords(value, walk)).join(" | "),
      300,
    );
    // Line by line: a regex for spaces before a line break backtracks over a long
    // run of spaces with none after it.
    const joined: string = cleanText(walk.texts.join("\n\n"))
      .split("\n")
      .map((line: string): string => line.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    let body: string = joined;
    if (joined.length > MAX_BODY_CHARS) {
      body = storable(joined.slice(0, MAX_BODY_CHARS));
      walk.notes.add("cut");
    }
    if (body === "" && walk.attachments.length > 0) {
      walk.notes.add("only-attachments");
    }
    // One line per string or piece of loose text, each once, in order.
    const lines: string[] = [
      ...new Set<string>(
        walk.styleTexts
          .map((piece: string): string => cleanText(piece).replace(/\s+/g, " ").trim())
          .filter((piece: string): boolean => piece !== ""),
      ),
    ];
    let styleText: string = lines.join("\n");
    if (styleText.length > MAX_STYLE_CHARS) {
      styleText = storable(styleText.slice(0, MAX_STYLE_CHARS));
      walk.notes.add("styles-cut");
    }
    const messageId: string | null = messageIdOf(top.fields, walk);
    const fromAsWritten: string = cleanLine(decodeWords((top.fields.get("from") ?? []).join(" | "), walk), 400);
    const replyTo: string[] = replyToOf(top.fields, walk);
    const notes: EmailNote[] = [...walk.notes];
    return {
      ok: true,
      email: {
        messageId,
        dateAsWritten: cleanLine(top.fields.get("date")?.[0] ?? "", 100),
        from: sender.address,
        fromName: sender.name,
        fromAsWritten,
        replyTo,
        subject,
        body,
        styleText,
        attachments: walk.attachments,
        notes,
        partial: notes.some((note: EmailNote): boolean => PARTIAL_NOTES.has(note)),
        rawSha256: sha256(raw),
        contentHash: sha256(raw.toString("latin1").replace(/\r\n/g, "\n")),
        rawBytes: raw.length,
      },
    };
  } catch (error: unknown) {
    return refused(error instanceof Refusal ? `PayOnce cannot read this email. ${error.message}` : "PayOnce cannot read this email");
  }
}

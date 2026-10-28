import { createHash } from "node:crypto";
import { validDomain } from "./eml.js";
import { INVOICE_ID_PATTERN, type TransferMethod } from "./ledger.js";
import { PAID_OUTCOME, SANDBOX_OUTCOMES } from "./sandbox-bank.js";

// A column a pay run file can have. Nothing else is read from a file: no bank
// details and no phone number. supplier_domain is the domain the supplier's
// emails come from. Without it, every sender of an email about the row's
// invoice is flagged.
export interface RunColumn {
  name: string;
  required: boolean;
}

export const RUN_COLUMNS: RunColumn[] = [
  { name: "invoice", required: true },
  { name: "supplier", required: true },
  { name: "beneficiary_id", required: true },
  { name: "amount", required: true },
  { name: "currency", required: true },
  { name: "method", required: false },
  { name: "sandbox_outcome", required: false },
  { name: "supplier_domain", required: false },
];

// Columns that would name a wallet to pay from. A run pays each row in its own
// currency from that currency's wallet, so a file that names another is refused.
const SOURCE_COLUMNS: string[] = ["source_currency", "paid_from", "pay_from", "sell_currency"];

export const MAX_RUN_ROWS: number = 50;
// Small enough that the largest file fits the server's 64 KB request body.
export const MAX_RUN_FILE_CHARS: number = 40_000;
const MAX_CELL_LENGTH: number = 100;
const MAX_FILE_NAME_LENGTH: number = 100;

const BENEFICIARY_ID_PATTERN: RegExp = /^[A-Za-z0-9-]{1,64}$/;
const CURRENCY_PATTERN: RegExp = /^[A-Za-z]{3}$/;
const AMOUNT_PATTERN: RegExp = /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,2}))?$/;
const METHODS: readonly TransferMethod[] = ["LOCAL", "SWIFT"];
const MINOR_DIGITS: number = 2;

// One data row as read, with what its cells say and every problem in them.
export interface RunFileRow {
  // The file line the row starts on. Line 1 is the header.
  line: number;
  // The cells as read and trimmed, in the header's order.
  cells: string[];
  problems: string[];
  invoiceId: string | null;
  supplier: string | null;
  beneficiaryId: string | null;
  amountMinor: number | null;
  currency: string | null;
  // Null when the cell is blank, so the beneficiary's own method is used.
  method: TransferMethod | null;
  sandboxOutcome: string;
  // A plain ASCII domain, lowercased, or null when the cell is blank.
  supplierDomain: string | null;
}

export interface RunFile {
  fileName: string;
  // SHA-256 of the header and every row's trimmed cells, so a copy with other line
  // endings or a trailing newline hashes the same.
  hash: string;
  columns: string[];
  rows: RunFileRow[];
}

// A problem that refuses the whole file. line is null when it is not on one line.
export interface FileProblem {
  line: number | null;
  message: string;
}

export type ParsedRunFile = { ok: true; file: RunFile } | { ok: false; problems: FileProblem[] };

interface RawRecord {
  line: number;
  cells: string[];
}

// RFC 4180: commas, double quotes around a cell and "" for a quote inside one,
// CRLF or LF. Blank lines are skipped. A cell keeps any line break inside its
// quotes, and the row check reports it.
function readRecords(text: string): { records: RawRecord[]; problem: FileProblem | null } {
  const records: RawRecord[] = [];
  let line: number = 1;
  let start: number = 1;
  let cells: string[] = [];
  let cell: string = "";
  let quoted: boolean = false;
  let inQuotes: boolean = false;
  let quoteLine: number = 1;
  const endRecord = (): void => {
    cells.push(quoted ? cell : cell.trim());
    if (!(cells.length === 1 && cells[0] === "" && !quoted)) {
      records.push({ line: start, cells: cells.map((value: string): string => value.trim()) });
    }
    cells = [];
    cell = "";
    quoted = false;
  };
  for (let index: number = 0; index < text.length; index += 1) {
    const char: string = text.charAt(index);
    if (inQuotes) {
      if (char === '"' && text.charAt(index + 1) === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        if (char === "\n" || (char === "\r" && text.charAt(index + 1) !== "\n")) {
          line += 1;
        }
        cell += char;
      }
    } else if (char === '"' && cell.trim() === "" && !quoted) {
      inQuotes = true;
      quoted = true;
      quoteLine = line;
      cell = "";
    } else if (char === ",") {
      cells.push(quoted ? cell : cell.trim());
      cell = "";
      quoted = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text.charAt(index + 1) === "\n") {
        index += 1;
      }
      endRecord();
      line += 1;
      start = line;
    } else {
      cell += char;
    }
  }
  if (inQuotes) {
    return {
      records,
      problem: { line: quoteLine, message: "A quote opened on this line is never closed" },
    };
  }
  endRecord();
  return { records, problem: null };
}

function amountProblem(raw: string): string | null {
  if (raw === "") {
    return "The amount is empty";
  }
  if (/^[+-]/.test(raw)) {
    return `The amount ${raw} has a sign. Write the amount to pay with no plus or minus`;
  }
  if (/^[0-9.]+[eE][+-]?[0-9]+$/.test(raw)) {
    return `The amount ${raw} is written with an exponent. Write it out, such as 1000.00`;
  }
  if (raw.includes(",")) {
    return `The amount ${raw} has a thousands separator. Write it with none, such as 4000.00`;
  }
  if (/[^0-9.]/.test(raw)) {
    return `The amount ${raw} has a currency sign or other characters. Write only the number, such as 40.00`;
  }
  if (/^[0-9]+\.[0-9]{3,}$/.test(raw)) {
    return `The amount ${raw} has more than two decimals. PayOnce never rounds a payment`;
  }
  if (!AMOUNT_PATTERN.test(raw)) {
    return `The amount ${raw} is not an amount such as 40.00`;
  }
  return null;
}

// Read as a string, so 40.005 is refused instead of rounded.
function amountMinorOf(raw: string): number {
  const match: RegExpExecArray | null = AMOUNT_PATTERN.exec(raw);
  if (match === null) {
    return Number.NaN;
  }
  return Number(match[1]) * 10 ** MINOR_DIGITS + Number((match[2] ?? "").padEnd(MINOR_DIGITS, "0"));
}

function twoDecimals(currency: string): boolean {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits === MINOR_DIGITS
    );
  } catch {
    return false;
  }
}

// A row read from its cells and the header. The same rules run at upload and on
// every check, so a run's rows can be read again from what the ledger stored.
export function rowFromCells(line: number, columns: string[], cells: string[]): RunFileRow {
  const problems: string[] = [];
  if (cells.length !== columns.length) {
    problems.push(
      `The row has ${cells.length} ${cells.length === 1 ? "cell" : "cells"} and the header has ${columns.length}`,
    );
  }
  const value = (name: string): string => {
    const index: number = columns.indexOf(name);
    return index < 0 ? "" : (cells[index] ?? "");
  };
  columns.forEach((name: string, index: number): void => {
    const cell: string = cells[index] ?? "";
    if (/[\r\n]/.test(cell)) {
      problems.push(`The ${name} cell has a line break in it`);
    } else if (cell.length > MAX_CELL_LENGTH) {
      problems.push(`The ${name} cell is longer than ${MAX_CELL_LENGTH} characters`);
    }
    if (cell.includes("�")) {
      problems.push(`The ${name} cell has characters that are not UTF-8`);
    }
  });

  const invoice: string = value("invoice");
  let invoiceId: string | null = null;
  if (invoice === "") {
    problems.push("The invoice number is empty");
  } else if (!INVOICE_ID_PATTERN.test(invoice)) {
    problems.push(`The invoice number ${invoice.slice(0, 40)} is not 1 to 40 letters, digits and dashes`);
  } else {
    invoiceId = invoice;
  }

  const supplier: string = value("supplier");
  if (supplier === "") {
    problems.push("The supplier is empty");
  }

  const beneficiary: string = value("beneficiary_id");
  let beneficiaryId: string | null = null;
  if (beneficiary === "") {
    problems.push("The beneficiary id is empty");
  } else if (!BENEFICIARY_ID_PATTERN.test(beneficiary)) {
    problems.push("The beneficiary id is not 1 to 64 letters, digits and dashes");
  } else {
    beneficiaryId = beneficiary;
  }

  const amount: string = value("amount");
  const badAmount: string | null = amountProblem(amount);
  let amountMinor: number | null = null;
  if (badAmount !== null) {
    problems.push(badAmount);
  } else if (amountMinorOf(amount) <= 0) {
    problems.push("The amount must be above zero");
  } else {
    amountMinor = amountMinorOf(amount);
  }

  const code: string = value("currency");
  let currency: string | null = null;
  if (!CURRENCY_PATTERN.test(code)) {
    problems.push(code === "" ? "The currency is empty" : `The currency ${code} is not a three-letter code`);
  } else if (!twoDecimals(code.toUpperCase())) {
    problems.push(`${code.toUpperCase()} does not have two decimals. PayOnce handles two-decimal currencies only`);
  } else {
    currency = code.toUpperCase();
  }

  const methodCell: string = value("method").toUpperCase();
  const method: TransferMethod | null =
    METHODS.find((entry: TransferMethod): boolean => entry === methodCell) ?? null;
  if (methodCell !== "" && method === null) {
    problems.push(`The method ${value("method")} is not LOCAL or SWIFT`);
  }

  const outcomeCell: string = value("sandbox_outcome").toUpperCase();
  if (outcomeCell !== "" && !SANDBOX_OUTCOMES.includes(outcomeCell)) {
    problems.push(
      `The sandbox outcome ${value("sandbox_outcome")} is not one of ${SANDBOX_OUTCOMES.join(", ")}`,
    );
  }

  // Compared as ASCII only, so only A to Z is lowercased.
  const domainCell: string = value("supplier_domain");
  const domain: string = domainCell.replace(/[A-Z]/g, (letter: string): string => letter.toLowerCase());
  if (domainCell !== "" && !validDomain(domain)) {
    problems.push(
      `The supplier_domain ${domainCell.slice(0, 40)} is not a plain domain such as example.com, in letters, digits, hyphens and dots`,
    );
  }

  return {
    line,
    cells,
    problems,
    invoiceId,
    supplier: supplier === "" ? null : supplier,
    beneficiaryId,
    amountMinor,
    currency,
    method,
    sandboxOutcome: outcomeCell === "" || !SANDBOX_OUTCOMES.includes(outcomeCell) ? PAID_OUTCOME : outcomeCell,
    supplierDomain: domainCell === "" || !validDomain(domain) ? null : domain,
  };
}

// A file name as the page and the timeline show it: no folders, no control
// characters, 100 characters at most.
export function cleanFileName(name: string): string {
  const base: string = name.split(/[\\/]/).at(-1) ?? "";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_FILE_NAME_LENGTH);
}

// Reads a pay run file. A problem with the file as a whole refuses it, and nothing
// is stored. A problem in a row only marks that row, which is then skipped.
export function parseRunFile(fileName: string, text: string): ParsedRunFile {
  const name: string = cleanFileName(fileName);
  if (name === "") {
    return { ok: false, problems: [{ line: null, message: "The file has no name" }] };
  }
  if (text.length > MAX_RUN_FILE_CHARS) {
    return {
      ok: false,
      problems: [
        {
          line: null,
          message: `The file is ${text.length.toLocaleString("en-US")} characters long. A pay run file can be at most ${MAX_RUN_FILE_CHARS.toLocaleString("en-US")}`,
        },
      ],
    };
  }
  const read: { records: RawRecord[]; problem: FileProblem | null } = readRecords(
    text.replace(/^﻿/, ""),
  );
  if (read.problem !== null) {
    return { ok: false, problems: [read.problem] };
  }
  const [header, ...data] = read.records;
  if (header === undefined) {
    return { ok: false, problems: [{ line: null, message: "The file is empty" }] };
  }

  const problems: FileProblem[] = [];
  const columns: string[] = header.cells.map((cell: string): string => cell.trim().toLowerCase());
  const known: string[] = RUN_COLUMNS.map((column: RunColumn): string => column.name);
  columns.forEach((column: string, index: number): void => {
    if (column === "") {
      problems.push({ line: header.line, message: `Column ${index + 1} of the header has no name` });
    } else if (SOURCE_COLUMNS.includes(column)) {
      problems.push({
        line: header.line,
        message: `The header has a ${column} column. A pay run pays each row in its own currency from that currency's wallet, so pay an invoice from another currency on its own`,
      });
    } else if (!known.includes(column)) {
      problems.push({
        line: header.line,
        message: `The header has an unknown column "${column.slice(0, 40)}". The columns are ${known.join(", ")}`,
      });
    } else if (columns.indexOf(column) !== index) {
      problems.push({ line: header.line, message: `The column ${column} appears twice in the header` });
    }
  });
  for (const column of RUN_COLUMNS) {
    if (column.required && !columns.includes(column.name)) {
      problems.push({ line: header.line, message: `The header has no ${column.name} column` });
    }
  }
  if (data.length === 0) {
    problems.push({ line: null, message: "The file has no rows after the header" });
  } else if (data.length > MAX_RUN_ROWS) {
    problems.push({
      line: null,
      message: `The file has ${data.length} rows. A pay run takes at most ${MAX_RUN_ROWS}`,
    });
  }
  if (problems.length > 0) {
    return { ok: false, problems };
  }

  const rows: RunFileRow[] = data.map(
    (record: RawRecord): RunFileRow => rowFromCells(record.line, columns, record.cells),
  );
  const hash: string = createHash("sha256")
    .update(JSON.stringify([columns, ...rows.map((row: RunFileRow): string[] => row.cells)]))
    .digest("hex");
  return { ok: true, file: { fileName: name, hash, columns, rows } };
}

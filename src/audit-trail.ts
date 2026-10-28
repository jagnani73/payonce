import { createHash } from "node:crypto";

// The prev_hash of an invoice's first line, and the ledger's running hash before
// its first line.
export const GENESIS: string = "0".repeat(64);

export const HASH_METHOD: string =
  "SHA-256, in hex, of prevHash followed by the JSON object {at, invoice_id, kind, message, topic} as UTF-8, with the keys in that order and no spaces. Only quotes, backslashes and control characters are escaped, as JavaScript's JSON.stringify does; every other character is written as itself";
export const LEDGER_HEAD_METHOD: string =
  "SHA-256, in hex, of the running hash followed by a line's hash, taken over every line in the ledger in id order, starting from the genesis";
// A pay run's timeline is chained the same way, keyed by the run's number.
export const RUN_HASH_METHOD: string =
  "SHA-256, in hex, of prevHash followed by the JSON object {at, run_id, kind, message, topic} as UTF-8, with the keys in that order and no spaces. run_id is the run's number, written as a JSON number. Only quotes, backslashes and control characters are escaped, as JavaScript's JSON.stringify does; every other character is written as itself";
export const RUN_LEDGER_HEAD_METHOD: string =
  "SHA-256, in hex, of the running hash followed by a run line's hash, taken over every pay run line in the ledger in id order, starting from the genesis. It is kept apart from the running hash of invoice lines";

// What a line's hash covers.
export interface EventFields {
  invoiceId: string;
  at: string;
  kind: string;
  message: string;
  topic: string | null;
}

// A timeline line as stored. The hashes are null on a line written without them,
// such as one written by a process still running code from before the chain.
export interface ChainedEvent extends EventFields {
  id: number;
  prevHash: string | null;
  hash: string | null;
}

// What a pay run line's hash covers.
export interface RunEventFields {
  runId: number;
  at: string;
  kind: string;
  message: string;
  topic: string | null;
}

export interface ChainedRunEvent extends RunEventFields {
  id: number;
  prevHash: string | null;
  hash: string | null;
}

// What the ledger holds for an audit, read in one transaction.
export interface AuditSnapshot {
  // One invoice's lines, or every line in the ledger, in id order.
  events: ChainedEvent[];
  // Every line's hash in the ledger, in id order, and how many invoices the
  // lines are on.
  hashes: (string | null)[];
  invoices: number;
  // The running hash kept in meta. Null when it is missing.
  ledgerHead: string | null;
  // When the chain started, and the last line that was already there and was
  // hashed then. Zero when the ledger had no lines.
  chainStartedAt: string | null;
  backfilledThrough: number;
}

// The same for pay run timelines, which have a running hash of their own.
export interface RunAuditSnapshot {
  events: ChainedRunEvent[];
  hashes: (string | null)[];
  runs: number;
  ledgerHead: string | null;
  chainStartedAt: string | null;
  backfilledThrough: number;
}

// Where an invoice's chain breaks. line counts from 1 along its timeline.
export interface ChainBreak {
  line: number;
  id: number;
  at: string;
  problem: string;
}

export interface ChainReport {
  invoiceId: string;
  lines: number;
  // The last line's hash, which every earlier line leads to.
  head: string | null;
  breaks: ChainBreak[];
}

export interface RunChainReport {
  runId: number;
  lines: number;
  head: string | null;
  breaks: ChainBreak[];
}

export interface LedgerReport {
  lines: number;
  invoices: number;
  stored: string | null;
  computed: string;
  intact: boolean;
}

export interface RunLedgerReport {
  lines: number;
  runs: number;
  stored: string | null;
  computed: string;
  intact: boolean;
}

// SQLite keeps text as UTF-8, which cannot hold half of a surrogate pair, such as
// an emoji cut in two, so it reads back as U+FFFD. A line is hashed as it will
// read back, or its own text would no longer match its hash.
const LONE_SURROGATE: RegExp = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function storable(text: string): string {
  return text.replace(LONE_SURROGATE, "�");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// JSON.stringify keeps the keys in the order written here and adds no spaces, so
// anyone can rebuild the same text from an export.
export function canonicalEvent(event: EventFields): string {
  return JSON.stringify({
    at: event.at,
    invoice_id: event.invoiceId,
    kind: event.kind,
    message: event.message,
    topic: event.topic,
  });
}

export function eventHash(prevHash: string, event: EventFields): string {
  return sha256(prevHash + canonicalEvent(event));
}

export function canonicalRunEvent(event: RunEventFields): string {
  return JSON.stringify({
    at: event.at,
    run_id: event.runId,
    kind: event.kind,
    message: event.message,
    topic: event.topic,
  });
}

export function runEventHash(prevHash: string, event: RunEventFields): string {
  return sha256(prevHash + canonicalRunEvent(event));
}

// The ledger's running hash once a line with this hash joins any invoice's chain.
export function nextLedgerHead(ledgerHead: string, hash: string): string {
  return sha256(ledgerHead + hash);
}

interface ChainLine {
  id: number;
  at: string;
  kind: string;
  topic: string | null;
  message: string;
  prevHash: string | null;
  hash: string | null;
}

// Checks each line against the stored hash of the line before it and against its
// own content, so one changed line shows up once and not on every line after it.
// A line with no hash is skipped, as the ledger skips it when it adds the next.
function breaksOf<E extends ChainLine>(
  events: E[],
  hashOf: (prevHash: string, event: E) => string,
): ChainBreak[] {
  const breaks: ChainBreak[] = [];
  let previous: string = GENESIS;
  events.forEach((event: E, index: number): void => {
    const line: number = index + 1;
    const found = (problem: string): void => {
      breaks.push({ line, id: event.id, at: event.at, problem });
    };
    if (event.prevHash === null || event.hash === null) {
      found("has no hash, so it was written outside the chain");
      return;
    }
    if (event.prevHash !== previous) {
      found(
        line === 1
          ? "does not start the chain, so lines before it were removed"
          : `does not follow line ${line - 1}: a line between them was removed or added, or line ${line - 1} was rewritten with a new hash`,
      );
    }
    if (hashOf(event.prevHash, event) !== event.hash) {
      found("was changed after it was written");
    }
    previous = event.hash;
  });
  return breaks;
}

export function chainBreaks(events: ChainedEvent[]): ChainBreak[] {
  return breaksOf(events, eventHash);
}

export function chainReport(invoiceId: string, events: ChainedEvent[]): ChainReport {
  return {
    invoiceId,
    lines: events.length,
    head: events.at(-1)?.hash ?? null,
    breaks: chainBreaks(events),
  };
}

// One report per invoice that has lines, in the order its first line was written.
export function chainReports(events: ChainedEvent[]): ChainReport[] {
  const byInvoice: Map<string, ChainedEvent[]> = new Map();
  for (const event of events) {
    const lines: ChainedEvent[] = byInvoice.get(event.invoiceId) ?? [];
    lines.push(event);
    byInvoice.set(event.invoiceId, lines);
  }
  return [...byInvoice].map(
    ([invoiceId, lines]: [string, ChainedEvent[]]): ChainReport => chainReport(invoiceId, lines),
  );
}

export function runChainReport(runId: number, events: ChainedRunEvent[]): RunChainReport {
  return {
    runId,
    lines: events.length,
    head: events.at(-1)?.hash ?? null,
    breaks: breaksOf(events, runEventHash),
  };
}

// One report per run that has lines, in the order its first line was written.
export function runChainReports(events: ChainedRunEvent[]): RunChainReport[] {
  const byRun: Map<number, ChainedRunEvent[]> = new Map();
  for (const event of events) {
    const lines: ChainedRunEvent[] = byRun.get(event.runId) ?? [];
    lines.push(event);
    byRun.set(event.runId, lines);
  }
  return [...byRun].map(
    ([runId, lines]: [number, ChainedRunEvent[]]): RunChainReport => runChainReport(runId, lines),
  );
}

function runningHash(hashes: (string | null)[]): string {
  let computed: string = GENESIS;
  for (const hash of hashes) {
    if (hash !== null) {
      computed = nextLedgerHead(computed, hash);
    }
  }
  return computed;
}

// The running hash catches what an invoice's own chain cannot: its last lines, or
// all of them, removed.
export function ledgerReport(snapshot: AuditSnapshot): LedgerReport {
  const computed: string = runningHash(snapshot.hashes);
  return {
    lines: snapshot.hashes.length,
    invoices: snapshot.invoices,
    stored: snapshot.ledgerHead,
    computed,
    intact: snapshot.ledgerHead === computed,
  };
}

export function runLedgerReport(snapshot: RunAuditSnapshot): RunLedgerReport {
  const computed: string = runningHash(snapshot.hashes);
  return {
    lines: snapshot.hashes.length,
    runs: snapshot.runs,
    stored: snapshot.ledgerHead,
    computed,
    intact: snapshot.ledgerHead === computed,
  };
}

export function describeLedger(report: LedgerReport): string {
  if (report.intact) {
    return `${report.lines} ${report.lines === 1 ? "line" : "lines"} across ${report.invoices} ${report.invoices === 1 ? "invoice" : "invoices"}, and the running hash matches`;
  }
  if (report.stored === null) {
    return "the running hash is missing from the ledger, so lines removed from it cannot be ruled out";
  }
  return "the running hash does not match the lines, so lines were removed, reordered or rewritten somewhere in the ledger. A timeline with no breaks can still have lost its last lines, and this check cannot say which";
}

export function describeRunLedger(report: RunLedgerReport): string {
  if (report.intact) {
    return `${report.lines} ${report.lines === 1 ? "line" : "lines"} across ${report.runs} pay ${report.runs === 1 ? "run" : "runs"}, and their running hash matches`;
  }
  if (report.stored === null) {
    return "the running hash of pay run lines is missing from the ledger, so run lines removed from it cannot be ruled out";
  }
  return "the running hash of pay run lines does not match them, so run lines were removed, reordered or rewritten somewhere in the ledger. A run timeline with no breaks can still have lost its last lines, and this check cannot say which";
}

// The first break, as one sentence, with a count of any others.
export function describeBreaks(breaks: ChainBreak[]): string | null {
  const first: ChainBreak | undefined = breaks[0];
  if (first === undefined) {
    return null;
  }
  const more: number = breaks.length - 1;
  return `line ${first.line} ${first.problem}${more === 0 ? "" : `. ${more} more ${more === 1 ? "break" : "breaks"} after it`}`;
}

export interface AuditInvoice {
  invoiceId: string;
  supplier: string;
  currency: string;
  amountMinor: number;
  state: string;
}

export interface AuditLine {
  line: number;
  id: number;
  at: string;
  kind: string;
  topic: string | null;
  message: string;
  prevHash: string | null;
  hash: string | null;
  // True for a line that was in the ledger before the chain started and was
  // hashed then. The chain vouches for it only from that time.
  backfilled: boolean;
}

export interface AuditExport {
  // The invoice as it stands. Only the lines are in the chain.
  invoice: AuditInvoice;
  exportedAt: string;
  method: { hash: string; ledgerHead: string; genesis: string };
  chainStartedAt: string | null;
  lines: AuditLine[];
  head: string | null;
  intact: boolean;
  breaks: ChainBreak[];
  ledger: LedgerReport;
}

function auditLines(events: ChainLine[], backfilledThrough: number): AuditLine[] {
  return events.map(
    (event: ChainLine, index: number): AuditLine => ({
      line: index + 1,
      id: event.id,
      at: event.at,
      kind: event.kind,
      topic: event.topic,
      message: event.message,
      prevHash: event.prevHash,
      hash: event.hash,
      backfilled: event.id <= backfilledThrough,
    }),
  );
}

export function auditExport(invoice: AuditInvoice, snapshot: AuditSnapshot): AuditExport {
  const report: ChainReport = chainReport(invoice.invoiceId, snapshot.events);
  const ledger: LedgerReport = ledgerReport(snapshot);
  return {
    // Picked field by field, since an obligation passed here has many more.
    invoice: {
      invoiceId: invoice.invoiceId,
      supplier: invoice.supplier,
      currency: invoice.currency,
      amountMinor: invoice.amountMinor,
      state: invoice.state,
    },
    exportedAt: new Date().toISOString(),
    method: { hash: HASH_METHOD, ledgerHead: LEDGER_HEAD_METHOD, genesis: GENESIS },
    chainStartedAt: snapshot.chainStartedAt,
    lines: auditLines(snapshot.events, snapshot.backfilledThrough),
    head: report.head,
    intact: report.breaks.length === 0 && ledger.intact,
    breaks: report.breaks,
    ledger,
  };
}

export interface AuditRun {
  runId: number;
  fileName: string;
  fileHash: string;
  uploadedBy: string;
  state: string;
}

export interface RunAuditExport {
  // The run as it stands. Only the lines are in the chain.
  run: AuditRun;
  exportedAt: string;
  method: { hash: string; ledgerHead: string; genesis: string };
  chainStartedAt: string | null;
  lines: AuditLine[];
  head: string | null;
  intact: boolean;
  breaks: ChainBreak[];
  ledger: RunLedgerReport;
}

export function runAuditExport(run: AuditRun, snapshot: RunAuditSnapshot): RunAuditExport {
  const report: RunChainReport = runChainReport(run.runId, snapshot.events);
  const ledger: RunLedgerReport = runLedgerReport(snapshot);
  return {
    // Picked field by field, since a run passed here has more.
    run: {
      runId: run.runId,
      fileName: run.fileName,
      fileHash: run.fileHash,
      uploadedBy: run.uploadedBy,
      state: run.state,
    },
    exportedAt: new Date().toISOString(),
    method: { hash: RUN_HASH_METHOD, ledgerHead: RUN_LEDGER_HEAD_METHOD, genesis: GENESIS },
    chainStartedAt: snapshot.chainStartedAt,
    lines: auditLines(snapshot.events, snapshot.backfilledThrough),
    head: report.head,
    intact: report.breaks.length === 0 && ledger.intact,
    breaks: report.breaks,
    ledger,
  };
}

const CSV_COLUMNS: string[] = [
  "line",
  "id",
  "at",
  "kind",
  "topic",
  "message",
  "prev_hash",
  "hash",
  "backfilled",
];

// A spreadsheet runs a cell that starts with one of these as a formula, and a
// message can carry an email subject or an error from outside.
const FORMULA_START: RegExp = /^[=+\-@\t\r]/;

function csvCell(value: string | number | boolean | null): string {
  const text: string = value === null ? "" : String(value);
  const safe: string = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

// The lines as CSV for a spreadsheet. A cell that would start a formula gets a
// leading apostrophe, so the JSON is the form to check hashes against.
export function auditCsv(audit: { lines: AuditLine[] }): string {
  const rows: string[] = [CSV_COLUMNS.map(csvCell).join(",")];
  for (const line of audit.lines) {
    rows.push(
      [
        line.line,
        line.id,
        line.at,
        line.kind,
        line.topic,
        line.message,
        line.prevHash,
        line.hash,
        line.backfilled,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // The byte order mark makes Excel read the file as UTF-8.
  return `﻿${rows.join("\r\n")}\r\n`;
}

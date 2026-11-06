import { capitalise } from "../text/printable.js";
import { GENESIS, INVOICE_CHAIN, RECON_CHAIN, RUN_CHAIN, type HashedLine } from "./chain.js";

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

// When a running hash was found missing and started again from the genesis, as
// the ledger records it in meta, and the line it started again at: its id and
// the invoice, run or break it is on. A field the record does not give is null.
// The chain has no key, so a running hash removed with every line could
// otherwise start again unseen.
export interface HeadRestart {
  at: string | null;
  id: number | null;
  of: string | null;
}

export function restartOf(value: string | null): HeadRestart | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    const record: Record<string, unknown> =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const id: unknown = record["id"];
    return {
      at: typeof record["at"] === "string" ? record["at"] : null,
      id: typeof id === "number" && Number.isSafeInteger(id) ? id : null,
      of: typeof record["of"] === "string" ? record["of"] : null,
    };
  } catch {
    return { at: null, id: null, of: null };
  }
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
  // The first time the running hash was found missing and started again.
  restarted: HeadRestart | null;
  // Every invoice in the ledger with no timeline line, in the order they were
  // written. PayOnce writes a line with every invoice it opens.
  unlined: string[];
}

// The same for pay run timelines, which have a running hash of their own.
export interface RunAuditSnapshot {
  events: ChainedRunEvent[];
  hashes: (string | null)[];
  runs: number;
  ledgerHead: string | null;
  chainStartedAt: string | null;
  backfilledThrough: number;
  restarted: HeadRestart | null;
  // Every run with no line. PayOnce writes one when a run is uploaded.
  unlined: number[];
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
  restarted: HeadRestart | null;
  unlined: string[];
  intact: boolean;
}

export interface RunLedgerReport {
  lines: number;
  runs: number;
  stored: string | null;
  computed: string;
  restarted: HeadRestart | null;
  unlined: number[];
  intact: boolean;
}

// Reconciliation's record is one chain over every break, with a running hash of
// its own, so a line removed from its end is caught too.
export const RECON_HASH_METHOD: string =
  "SHA-256, in hex, of prevHash followed by the JSON object {at, break_id, kind, message} as UTF-8, with the keys in that order and no spaces. break_id is the break's number, written as a JSON number. Every reconciliation line is one chain in id order, so prevHash is the hash of the line before it, whatever break that line is about. Only quotes, backslashes and control characters are escaped, as JavaScript's JSON.stringify does";
export const RECON_LEDGER_HEAD_METHOD: string =
  "SHA-256, in hex, of the running hash followed by a reconciliation line's hash, over every reconciliation line in id order, starting from the genesis. It is kept apart from the running hashes of invoice and pay run lines";

export interface ReconEventFields {
  breakId: number;
  at: string;
  kind: string;
  message: string;
}

export interface ChainedReconEvent extends ReconEventFields {
  id: number;
  prevHash: string | null;
  hash: string | null;
}

export interface ReconAuditSnapshot {
  events: ChainedReconEvent[];
  ledgerHead: string | null;
  // When the chain's first line was written, kept apart from the lines. Null
  // until the chain has a line.
  chainStartedAt: string | null;
  restarted: HeadRestart | null;
  // Every break that has opened and has no line. A break gets its first line
  // when it opens.
  unlined: number[];
}

export interface ReconChainReport {
  lines: number;
  breaks: ChainBreak[];
  // The chain has started, and its first line is gone: it holds no line, or line
  // 1 is not the line it started with.
  lostStart: "empty" | "cut" | null;
  stored: string | null;
  computed: string;
  restarted: HeadRestart | null;
  unlined: number[];
  intact: boolean;
}

interface ChainLine extends HashedLine {
  kind: string;
  topic: string | null;
  message: string;
}

export function chainReport(invoiceId: string, events: ChainedEvent[]): ChainReport {
  return {
    invoiceId,
    lines: events.length,
    head: events.at(-1)?.hash ?? null,
    breaks: INVOICE_CHAIN.breaks(events),
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
    breaks: RUN_CHAIN.breaks(events),
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

// The running hash catches what an invoice's own chain cannot: its last lines, or
// all of them, removed. A running hash that went missing and started again, and
// an invoice with no line at all, are reported from then on, because removing
// every line and the running hash together would otherwise leave a chain that
// verifies.
export function ledgerReport(snapshot: AuditSnapshot): LedgerReport {
  const computed: string = INVOICE_CHAIN.running(snapshot.hashes);
  return {
    lines: snapshot.hashes.length,
    invoices: snapshot.invoices,
    stored: snapshot.ledgerHead,
    computed,
    restarted: snapshot.restarted,
    unlined: snapshot.unlined,
    intact: snapshot.ledgerHead === computed && snapshot.restarted === null && snapshot.unlined.length === 0,
  };
}

export function runLedgerReport(snapshot: RunAuditSnapshot): RunLedgerReport {
  const computed: string = RUN_CHAIN.running(snapshot.hashes);
  return {
    lines: snapshot.hashes.length,
    runs: snapshot.runs,
    stored: snapshot.ledgerHead,
    computed,
    restarted: snapshot.restarted,
    unlined: snapshot.unlined,
    intact: snapshot.ledgerHead === computed && snapshot.restarted === null && snapshot.unlined.length === 0,
  };
}

const LISTED: number = 5;

// Up to LISTED ids, then how many more.
function someOf(ids: readonly (string | number)[]): string {
  const shown: string = ids.slice(0, LISTED).join(", ");
  return ids.length > LISTED ? `${shown} and ${ids.length - LISTED} more` : shown;
}

// When and where a running hash started again, in PayOnce's words.
export function restartText(restart: HeadRestart, what: string): string {
  const when: string =
    restart.at === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(restart.at)
      ? "at a time PayOnce cannot read"
      : `on ${restart.at.slice(0, 16).replace("T", " ")} UTC`;
  const of: string = restart.of !== null && /^[A-Za-z0-9 ._-]{1,40}$/.test(restart.of) ? ` (${restart.of})` : "";
  const where: string = restart.id === null ? "" : ` at line ${restart.id}${of}`;
  return `the running hash of ${what} went missing and PayOnce started it again ${when}${where}, so lines removed before then cannot be ruled out`;
}

// What a running hash check found, one sentence each.
function headProblems(
  report: { stored: string | null; computed: string; restarted: HeadRestart | null },
  what: string,
  mismatch: string,
): string[] {
  const problems: string[] = [];
  if (report.stored === null) {
    problems.push(`the running hash of ${what} is missing from the ledger, so lines removed from it cannot be ruled out`);
  } else if (report.stored !== report.computed) {
    problems.push(mismatch);
  }
  if (report.restarted !== null) {
    problems.push(restartText(report.restarted, what));
  }
  return problems;
}

// One invoice, run or break, or several, with no line, though each gets one
// when it is written.
function lostLines(ids: readonly (string | number)[], one: string, many: string, rule: string): string {
  return ids.length === 1
    ? `${one} ${ids[0] ?? ""} has no line, though ${rule}, so its lines were removed`
    : `${ids.length} ${many} have no line (${someOf(ids)}), though ${rule}, so their lines were removed`;
}

function sentences(problems: string[]): string {
  return problems
    .map((problem: string, index: number): string =>
      index === 0 ? problem : capitalise(problem),
    )
    .join(". ");
}

export function describeLedger(report: LedgerReport): string {
  if (report.intact) {
    return `${report.lines} ${report.lines === 1 ? "line" : "lines"} across ${report.invoices} ${report.invoices === 1 ? "invoice" : "invoices"}, and the running hash matches`;
  }
  const problems: string[] = headProblems(
    report,
    "invoice lines",
    "the running hash does not match the lines, so lines were removed, reordered or rewritten somewhere in the ledger. A timeline with no breaks can still have lost its last lines, and this check cannot say which",
  );
  if (report.unlined.length > 0) {
    problems.push(lostLines(report.unlined, "invoice", "invoices", "PayOnce writes one when it opens an invoice"));
  }
  return sentences(problems);
}

// The chain line by line and the running hash, which catches the last lines
// removed.
export function reconChainReport(snapshot: ReconAuditSnapshot): ReconChainReport {
  const breaks: ChainBreak[] = RECON_CHAIN.breaks(snapshot.events);
  const computed: string = RECON_CHAIN.running(
    snapshot.events.map((event: ChainedReconEvent): string | null => event.hash),
  );
  const first: ChainedReconEvent | undefined = snapshot.events[0];
  const lostStart: ReconChainReport["lostStart"] =
    snapshot.chainStartedAt === null ? null : first === undefined ? "empty" : first.at !== snapshot.chainStartedAt ? "cut" : null;
  return {
    lines: snapshot.events.length,
    breaks,
    lostStart,
    stored: snapshot.ledgerHead,
    computed,
    restarted: snapshot.restarted,
    unlined: snapshot.unlined,
    intact:
      breaks.length === 0 &&
      lostStart === null &&
      snapshot.ledgerHead === computed &&
      snapshot.restarted === null &&
      snapshot.unlined.length === 0,
  };
}

// The problem with the chain as one sentence, or null when it verifies.
export function reconChainProblem(report: ReconChainReport): string | null {
  const broken: string | null = describeBreaks(report.breaks);
  if (broken !== null) {
    return broken;
  }
  if (report.lostStart === "empty") {
    return "the reconciliation record has started but holds no line, so its lines were removed";
  }
  if (report.lostStart === "cut") {
    return "line 1 is not the line the reconciliation record started with, so the lines before it were removed";
  }
  const problems: string[] = headProblems(
    report,
    "reconciliation lines",
    "the running hash of reconciliation lines does not match them, so lines were removed, reordered or rewritten",
  );
  if (report.unlined.length > 0) {
    problems.push(lostLines(report.unlined, "break", "breaks", "every break gets one when it opens"));
  }
  return problems.length === 0 ? null : sentences(problems);
}

export function describeRunLedger(report: RunLedgerReport): string {
  if (report.intact) {
    return `${report.lines} ${report.lines === 1 ? "line" : "lines"} across ${report.runs} pay ${report.runs === 1 ? "run" : "runs"}, and their running hash matches`;
  }
  const problems: string[] = headProblems(
    report,
    "pay run lines",
    "the running hash of pay run lines does not match them, so run lines were removed, reordered or rewritten somewhere in the ledger. A run timeline with no breaks can still have lost its last lines, and this check cannot say which",
  );
  if (report.unlined.length > 0) {
    problems.push(lostLines(report.unlined, "pay run", "pay runs", "PayOnce writes one when a run is uploaded"));
  }
  return sentences(problems);
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

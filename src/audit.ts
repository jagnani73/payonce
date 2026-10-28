import { existsSync } from "node:fs";
import {
  auditCsv,
  auditExport,
  chainReport,
  chainReports,
  describeBreaks,
  describeLedger,
  describeRunLedger,
  ledgerReport,
  runAuditExport,
  runChainReport,
  runChainReports,
  runLedgerReport,
  type AuditExport,
  type AuditSnapshot,
  type ChainBreak,
  type ChainReport,
  type LedgerReport,
  type RunAuditExport,
  type RunAuditSnapshot,
  type RunChainReport,
  type RunLedgerReport,
} from "./audit-trail.js";
import { Ledger, LEDGER_PATH, type Obligation, type Run } from "./ledger.js";

const FORMATS: string[] = ["json", "csv"];
const USAGE: string = "Usage: pnpm run audit [INVOICE] [json|csv], or pnpm run audit run <RUN> [json|csv]";
const NOT_CHAINED: string =
  "This ledger's pay run timelines are not a hash chain yet. The next pnpm ui or other command that opens it starts the chain";

function short(hash: string | null): string {
  return hash === null ? "none" : hash.slice(0, 16);
}

function printLedger(report: LedgerReport): void {
  console.log(`Ledger: ${describeLedger(report)}`);
  console.log(`  head     ${short(report.stored)}`);
  if (!report.intact) {
    console.log(`  lines    give ${short(report.computed)}`);
  }
}

function printRunLedger(report: RunLedgerReport): void {
  console.log(`Pay runs: ${describeRunLedger(report)}`);
  console.log(`  head     ${short(report.stored)}`);
  if (!report.intact) {
    console.log(`  lines    give ${short(report.computed)}`);
  }
}

// One timeline's chain, line by line, with a note on lines hashed when the chain
// started.
function printChain(
  name: string,
  report: { lines: number; head: string | null; breaks: ChainBreak[] },
  snapshot: { events: { id: number }[]; backfilledThrough: number; chainStartedAt: string | null },
): boolean {
  const intact: boolean = report.breaks.length === 0;
  console.log(
    `${name}: ${report.lines} ${report.lines === 1 ? "line" : "lines"}, ${intact ? "the chain is intact" : "the chain breaks"}`,
  );
  console.log(`  head     ${short(report.head)}`);
  for (const found of report.breaks) {
    console.log(`  line ${String(found.line).padEnd(4)} ${found.at}  ${found.problem}`);
  }
  const backfilled: number = snapshot.events.filter(
    (event: { id: number }): boolean => event.id <= snapshot.backfilledThrough,
  ).length;
  if (backfilled > 0) {
    console.log(
      `  earlier  lines 1 to ${backfilled} were written before the chain started on ${snapshot.chainStartedAt ?? "an unknown date"} and hashed then, so it vouches for them only from that date`,
    );
  }
  return intact;
}

// Re-checks one invoice's chain line by line, and the running hash over the
// whole ledger.
function auditInvoice(snapshot: AuditSnapshot, invoiceId: string): boolean {
  const intact: boolean = printChain(invoiceId, chainReport(invoiceId, snapshot.events), snapshot);
  const ledger: LedgerReport = ledgerReport(snapshot);
  printLedger(ledger);
  return intact && ledger.intact;
}

// The same for one pay run's timeline and the running hash over every run's.
function auditRun(snapshot: RunAuditSnapshot, runId: number): boolean {
  const intact: boolean = printChain(`Pay run ${runId}`, runChainReport(runId, snapshot.events), snapshot);
  const ledger: RunLedgerReport = runLedgerReport(snapshot);
  printRunLedger(ledger);
  return intact && ledger.intact;
}

// Re-checks every invoice's chain and the running hash.
function auditLedger(snapshot: AuditSnapshot): boolean {
  const reports: ChainReport[] = chainReports(snapshot.events);
  const width: number = Math.max(
    0,
    ...reports.map((report: ChainReport): number => report.invoiceId.length),
  );
  for (const report of reports) {
    const broken: string | null = describeBreaks(report.breaks);
    console.log(
      `${report.invoiceId.padEnd(width)}  ${String(report.lines).padStart(3)} ${report.lines === 1 ? "line " : "lines"}  ${broken === null ? "intact" : `breaks: ${broken}`}`,
    );
  }
  const ledger: LedgerReport = ledgerReport(snapshot);
  printLedger(ledger);
  return (
    ledger.intact &&
    reports.every((report: ChainReport): boolean => report.breaks.length === 0)
  );
}

// Re-checks every pay run's chain and their running hash.
function auditRuns(snapshot: RunAuditSnapshot): boolean {
  const reports: RunChainReport[] = runChainReports(snapshot.events);
  for (const report of reports) {
    const broken: string | null = describeBreaks(report.breaks);
    console.log(
      `run ${String(report.runId).padEnd(6)}  ${String(report.lines).padStart(3)} ${report.lines === 1 ? "line " : "lines"}  ${broken === null ? "intact" : `breaks: ${broken}`}`,
    );
  }
  const ledger: RunLedgerReport = runLedgerReport(snapshot);
  printRunLedger(ledger);
  return (
    ledger.intact &&
    reports.every((report: RunChainReport): boolean => report.breaks.length === 0)
  );
}

// Checks one pay run's timeline, or prints its audit trail as JSON or CSV.
function mainRun(ledger: Ledger, raw: string | undefined, format: string | undefined): void {
  const run: Run | undefined =
    raw !== undefined && /^[1-9][0-9]{0,9}$/.test(raw) ? ledger.run(Number(raw)) : undefined;
  if (run === undefined) {
    console.log(raw === undefined ? USAGE : `Run ${raw.slice(0, 20)} is not in the ledger`);
    process.exitCode = 1;
    return;
  }
  if (!ledger.runChainStarted()) {
    console.log(NOT_CHAINED);
    process.exitCode = 1;
    return;
  }
  const snapshot: RunAuditSnapshot = ledger.runAuditSnapshot(run.id);
  if (format === undefined) {
    process.exitCode = auditRun(snapshot, run.id) ? 0 : 1;
    return;
  }
  const audit: RunAuditExport = runAuditExport(
    { runId: run.id, fileName: run.fileName, fileHash: run.fileHash, uploadedBy: run.uploadedBy, state: run.state },
    snapshot,
  );
  process.stdout.write(format === "csv" ? auditCsv(audit) : `${JSON.stringify(audit, null, 2)}\n`);
  if (!audit.intact) {
    process.exitCode = 1;
  }
}

// Without an invoice it checks the whole ledger, pay run timelines included.
// With one it checks that invoice's timeline, or prints its audit trail as JSON
// or CSV. "run" and a run's number do the same for a pay run. A run number is
// digits, which are never a format, so "run 7" cannot be an invoice called run.
function main(): void {
  const first: string | undefined = process.argv[2];
  const runForm: boolean = first === "run" && /^[0-9]+$/.test(process.argv[3] ?? "");
  const invoiceId: string | undefined = first;
  const format: string | undefined = process.argv[runForm ? 4 : 3];
  if (format !== undefined && !FORMATS.includes(format)) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(LEDGER_PATH)) {
    console.log("There is no ledger yet, so there is nothing to check");
    process.exitCode = 1;
    return;
  }
  // Read-only, so checking the ledger never upgrades it or hashes its lines.
  const ledger: Ledger = new Ledger(LEDGER_PATH, true);
  if (!ledger.chainStarted()) {
    console.log(
      "This ledger's timelines are not a hash chain yet. The next pnpm ui or other command that opens it starts the chain",
    );
    process.exitCode = 1;
    return;
  }
  if (runForm) {
    mainRun(ledger, process.argv[3], format);
    return;
  }
  if (invoiceId === undefined) {
    let intact: boolean = auditLedger(ledger.auditSnapshot(null));
    if (ledger.runChainStarted()) {
      intact = auditRuns(ledger.runAuditSnapshot(null)) && intact;
    } else if (ledger.hasRunLines()) {
      console.log(NOT_CHAINED);
      intact = false;
    }
    process.exitCode = intact ? 0 : 1;
    return;
  }
  const obligation: Obligation | undefined = ledger.obligation(invoiceId);
  const snapshot: AuditSnapshot = ledger.auditSnapshot(invoiceId);
  if (obligation === undefined && snapshot.events.length === 0) {
    console.log(`${invoiceId} is not in the ledger`);
    process.exitCode = 1;
    return;
  }
  if (format === undefined) {
    process.exitCode = auditInvoice(snapshot, invoiceId) ? 0 : 1;
    return;
  }
  if (obligation === undefined) {
    console.log(
      `${invoiceId} has timeline lines but no invoice. Run pnpm run audit ${invoiceId} to check them`,
    );
    process.exitCode = 1;
    return;
  }
  const audit: AuditExport = auditExport(obligation, snapshot);
  process.stdout.write(
    format === "csv" ? auditCsv(audit) : `${JSON.stringify(audit, null, 2)}\n`,
  );
  if (!audit.intact) {
    process.exitCode = 1;
  }
}

main();

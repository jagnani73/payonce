import { existsSync } from "node:fs";
import {
  auditCsv,
  auditExport,
  chainReport,
  chainReports,
  describeBreaks,
  describeLedger,
  ledgerReport,
  type AuditExport,
  type AuditSnapshot,
  type ChainedEvent,
  type ChainReport,
  type LedgerReport,
} from "./audit-trail.js";
import { Ledger, LEDGER_PATH, type Obligation } from "./ledger.js";

const FORMATS: string[] = ["json", "csv"];

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

// Re-checks one invoice's chain line by line, and the running hash over the
// whole ledger.
function auditInvoice(snapshot: AuditSnapshot, invoiceId: string): boolean {
  const report: ChainReport = chainReport(invoiceId, snapshot.events);
  const intact: boolean = report.breaks.length === 0;
  console.log(
    `${invoiceId}: ${report.lines} ${report.lines === 1 ? "line" : "lines"}, ${intact ? "the chain is intact" : "the chain breaks"}`,
  );
  console.log(`  head     ${short(report.head)}`);
  for (const found of report.breaks) {
    console.log(`  line ${String(found.line).padEnd(4)} ${found.at}  ${found.problem}`);
  }
  const backfilled: number = snapshot.events.filter(
    (event: ChainedEvent): boolean => event.id <= snapshot.backfilledThrough,
  ).length;
  if (backfilled > 0) {
    console.log(
      `  earlier  lines 1 to ${backfilled} were written before the chain started on ${snapshot.chainStartedAt ?? "an unknown date"} and hashed then, so it vouches for them only from that date`,
    );
  }
  const ledger: LedgerReport = ledgerReport(snapshot);
  printLedger(ledger);
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

// Without an invoice it checks the whole ledger. With one it checks that
// invoice's timeline, or prints its audit trail as JSON or CSV.
function main(): void {
  const invoiceId: string | undefined = process.argv[2];
  const format: string | undefined = process.argv[3];
  if (format !== undefined && !FORMATS.includes(format)) {
    console.log("Usage: pnpm run audit [INVOICE] [json|csv]");
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
  if (invoiceId === undefined) {
    process.exitCode = auditLedger(ledger.auditSnapshot(null)) ? 0 : 1;
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

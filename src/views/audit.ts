import type { Settings } from "../settings.js";
import {
  auditExport,
  chainReports,
  describeBreaks,
  describeLedger,
  describeRunLedger,
  ledgerReport,
  reconChainProblem,
  reconChainReport,
  runAuditExport,
  runChainReports,
  runLedgerReport,
  type AuditExport,
  type AuditSnapshot,
  type ChainReport,
  type LedgerReport,
  type ReconChainReport,
  type RunAuditExport,
  type RunAuditSnapshot,
  type RunChainReport,
  type RunLedgerReport,
} from "../store/audit-trail.js";
import type { Ledger, Obligation, Run } from "../store/ledger.js";
import { capitalise } from "../text/printable.js";
import type { AuditCheckView } from "./contract.js";

// The audit trail of the whole ledger: every invoice's and pay run's timeline,
// their running hashes, and reconciliation's chain, each hashed again line by
// line, as pnpm run audit checks them. It reads every line, so a server keeps
// it by the ledger's change stamp.

type RunningHash = AuditCheckView["invoices"]["runningHash"];

function runningHashOf(report: { stored: string | null; computed: string; restarted: unknown; intact: boolean }): RunningHash {
  if (report.stored === null) {
    return "missing";
  }
  if (report.stored !== report.computed) {
    return "does not match";
  }
  return report.restarted !== null ? "started again" : "matches";
}

export function auditView(ledger: Ledger, _settings: Settings, now: number): AuditCheckView {
  const invoices: AuditSnapshot = ledger.auditSnapshot(null);
  const runs: RunAuditSnapshot = ledger.runAuditSnapshot(null);
  const invoiceReports: ChainReport[] = chainReports(invoices.events);
  const runReports: RunChainReport[] = runChainReports(runs.events);
  const whole: LedgerReport = ledgerReport(invoices);
  const wholeRuns: RunLedgerReport = runLedgerReport(runs);
  const recon: ReconChainReport = reconChainReport(ledger.recon().auditSnapshot());
  const reconProblem: string | null = reconChainProblem(recon);
  const problems: string[] = [
    ...invoiceReports.flatMap((report: ChainReport): string[] => {
      const broken: string | null = describeBreaks(report.breaks);
      return broken === null ? [] : [`${report.invoiceId}: ${broken}`];
    }),
    ...runReports.flatMap((report: RunChainReport): string[] => {
      const broken: string | null = describeBreaks(report.breaks);
      return broken === null ? [] : [`Pay run ${report.runId}: ${broken}`];
    }),
    ...(whole.intact ? [] : [capitalise(describeLedger(whole))]),
    ...(wholeRuns.intact ? [] : [capitalise(describeRunLedger(wholeRuns))]),
    ...(reconProblem === null ? [] : [capitalise(reconProblem)]),
  ];
  return {
    view: "audit",
    checkedAt: new Date(now).toISOString(),
    intact: problems.length === 0,
    invoices: {
      chains: invoiceReports.length,
      lines: whole.lines,
      broken: invoiceReports.filter((report: ChainReport): boolean => report.breaks.length > 0).map((report: ChainReport): string => report.invoiceId),
      runningHash: runningHashOf(whole),
    },
    runs: {
      chains: runReports.length,
      lines: wholeRuns.lines,
      broken: runReports.filter((report: RunChainReport): boolean => report.breaks.length > 0).map((report: RunChainReport): number => report.runId),
      runningHash: runningHashOf(wholeRuns),
    },
    recon: { lines: recon.lines, intact: reconProblem === null, problem: reconProblem },
    problems,
    exportPath: "/api/audit/export",
  };
}

// Everything at once, for GET /api/audit/export: every invoice's and pay run's
// export and reconciliation's chain report.
export interface LedgerAuditExport {
  exportedAt: string;
  invoices: AuditExport[];
  runs: RunAuditExport[];
  recon: ReconChainReport;
}

export function ledgerAuditExport(ledger: Ledger, now: number): LedgerAuditExport {
  return {
    exportedAt: new Date(now).toISOString(),
    invoices: ledger.obligations().map((obligation: Obligation): AuditExport => auditExport(obligation, ledger.auditSnapshot(obligation.invoiceId))),
    runs: ledger.runs().map(
      (run: Run): RunAuditExport =>
        runAuditExport(
          { runId: run.id, fileName: run.fileName, fileHash: run.fileHash, uploadedBy: run.uploadedBy, state: run.state },
          ledger.runAuditSnapshot(run.id),
        ),
    ),
    recon: reconChainReport(ledger.recon().auditSnapshot()),
  };
}

import { explainerFor } from "../explain/explainer.js";
import { readerFor } from "../reader/reader.js";
import { KeywordReader } from "../reader/keyword-reader.js";
import type { EmailReader } from "../reader/emails.js";
import { BENEFICIARY_ID_PATTERN } from "../runs/run-file.js";
import { runKey } from "../runs/runs.js";
import type { Settings } from "../settings.js";
import type { BoardMoney } from "./incident-board.js";
import { money } from "./parts.js";
import type { SnapshotOptions } from "./snapshot.js";
import type { Money } from "./contract.js";

// What a builder reads besides the ledger, the settings and the time. Every
// builder is a function of (ledger, settings, now) and these, and none of them
// writes or calls Airwallex.

// What only a running server knows about the work under way. The CLI, the MCP
// server and the dump pass none, and then nothing is busy.
export interface Live {
  // The agent or the sandbox bank is working on the invoice.
  busy: (invoiceId: string) => boolean;
  // A run's own step is running (its release or a re-check).
  runBusy: (runId: number) => boolean;
}

export function isBusy(live: Live | null, invoiceId: string): boolean {
  return live?.busy(invoiceId) ?? false;
}

export function isRunBusy(live: Live | null, runId: number): boolean {
  return live?.runBusy(runId) ?? false;
}

// The Live a server builds from its dispatcher and sandbox bank.
export function liveFrom(busy: (key: string) => boolean): Live {
  return { busy, runBusy: (runId: number): boolean => busy(runKey(runId)) };
}

export function askWhyOn(settings: Settings): boolean {
  return explainerFor(settings.models.askServices()) !== null;
}

export function readerOf(settings: Settings): { name: string; isModel: boolean } {
  const reader: EmailReader = readerFor(settings.models.readerServices());
  return { name: reader.name, isModel: !(reader instanceof KeywordReader) };
}

export function snapshotOptions(settings: Settings, live: Live | null): SnapshotOptions {
  return live === null
    ? { policy: settings.approvals, askWhy: askWhyOn(settings) }
    : { policy: settings.approvals, askWhy: askWhyOn(settings), busy: live.busy };
}

// The beneficiary id a supplier record is keyed by, or null for one the page
// cannot link to.
export function supplierKeyOf(beneficiaryId: string): string | null {
  return BENEFICIARY_ID_PATTERN.test(beneficiaryId) ? beneficiaryId : null;
}

export function boardMoney(items: BoardMoney[]): Money[] {
  return items.map((item: BoardMoney): Money => money(item.minor, item.currency, item.estimated || item.feeUnknown > 0));
}

import { getTransfer, type Transfer } from "./airwallex/transfers.js";
import { attemptStateOf } from "./assess.js";
import type { Dispatcher } from "./dispatcher.js";
import type { Engine } from "./engine.js";
import {
  isExpired,
  type Approval,
  type Attempt,
  type AttemptState,
  type OutsidePayout,
} from "./ledger.js";
import { runKey } from "./runs.js";
import { sweep } from "./sweep.js";

// A release that failed, for example because Airwallex could not be read, is
// tried again this much later, not on every check.
const RETRY_RELEASE_MS: number = 60_000;

// The fallback for webhooks. It checks every payment the ledger still shows in
// flight, PayOnce's own and those for its invoices sent outside it, and wakes the
// agent for an invoice whose payment the bank has moved on.
// It also wakes an invoice whose deadline has come, and one with an approval
// nobody has acted on yet, such as one given with pnpm approve while the server
// was running. Given a sweep interval, it also sweeps Airwallex for payouts
// PayOnce did not send.
// Given release, which only the server passes, it releases a run once its
// approval is complete, and wakes a released row that has not sent its first
// payment once the release has stopped going through the rows, one row per run
// per check. Without it, as in the CLI, it never touches such a row.
export class Watcher {
  private readonly engine: Engine;
  private readonly agent: Dispatcher;
  private readonly sweepEveryMs: number | null;
  private readonly release: ((runId: number) => void) | null;
  private intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSweep: number = 0;
  private sweepRequested: boolean = false;
  private readonly releaseTriedAt: Map<number, number> = new Map<number, number>();
  // When the last check that read every payment with the bank without an error
  // started. A state the ledger still shows is then at most that old, because a
  // change wakes the invoice. A check where any read failed leaves it as it was,
  // so it stays old while Airwallex cannot be reached. Null until such a check.
  lastCheckedAt: number | null = null;

  constructor(
    engine: Engine,
    agent: Dispatcher,
    intervalMs: number,
    sweepEveryMs: number | null = null,
    release: ((runId: number) => void) | null = null,
  ) {
    this.engine = engine;
    this.agent = agent;
    this.intervalMs = intervalMs;
    this.sweepEveryMs = sweepEveryMs;
    this.release = release;
  }

  start(): void {
    this.stop();
    this.timer = setTimeout((): void => {
      this.check()
        .catch((error: unknown): void => {
          console.warn(
            `  watcher  check failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally((): void => {
          if (this.timer !== null) {
            this.start();
          }
        });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  every(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.timer !== null) {
      this.start();
    }
  }

  // Sweeps on the next check, for a webhook about a transfer the ledger does not
  // know.
  sweepSoon(): void {
    this.sweepRequested = true;
  }

  async check(): Promise<void> {
    const now: number = Date.now();
    let readFailed: boolean = false;
    const due: ReadonlySet<string> = new Set<string>(this.engine.ledger.dueLooks(now));
    // Released rows that have not sent their first payment. Only the release, or
    // this check in the server once the release has stopped, sends them.
    const unsent: Map<string, number> = new Map(
      this.engine.ledger
        .unsentRunInvoices()
        .map((row: { invoiceId: string; runId: number }): [string, number] => [row.invoiceId, row.runId]),
    );
    const runsWoken: Set<number> = new Set<number>();
    for (const obligation of this.engine.ledger.obligations()) {
      const invoiceId: string = obligation.invoiceId;
      if (
        obligation.state === "settled" ||
        obligation.state === "rejected" ||
        this.agent.isBusy(invoiceId)
      ) {
        continue;
      }
      const runId: number | undefined = unsent.get(invoiceId);
      if (runId !== undefined) {
        if (
          this.release !== null &&
          due.has(invoiceId) &&
          !runsWoken.has(runId) &&
          !this.agent.isBusy(runKey(runId))
        ) {
          runsWoken.add(runId);
          this.agent.wake(invoiceId);
        }
        continue;
      }
      // An approval nobody has acted on yet, or a request that expired with no
      // look planned, such as one from before requests expired. A look that
      // failed on it has planned the next try, so it is not woken on every check.
      const approval: Approval | undefined = this.engine.ledger.latestApproval(invoiceId);
      const waiting: boolean =
        approval !== undefined &&
        (approval.state === "approved" ||
          (approval.state === "requested" && isExpired(approval, now))) &&
        !this.engine.ledger.lookPlanned(invoiceId, now);
      if (due.has(invoiceId) || waiting) {
        this.agent.wake(invoiceId);
        continue;
      }
      // PayOnce's own payments and payouts for the invoice sent outside it.
      const inFlight: string[] = [
        ...this.engine.ledger
          .attempts(invoiceId)
          .filter((attempt: Attempt): boolean => attempt.state === "in_flight")
          .map((attempt: Attempt): string | null => attempt.transferId),
        ...this.engine.ledger
          .outsidePayouts(invoiceId)
          .filter((payout: OutsidePayout): boolean => payout.state === "in_flight")
          .map((payout: OutsidePayout): string => payout.transferId),
      ].filter((id: string | null): id is string => id !== null);
      for (const transferId of inFlight) {
        try {
          const transfer: Transfer = await getTransfer(this.engine.client, transferId);
          const state: AttemptState | null = attemptStateOf(transfer);
          if (state !== null && state !== "in_flight") {
            this.agent.wake(invoiceId);
            break;
          }
        } catch (error: unknown) {
          readFailed = true;
          console.warn(
            `  watcher  ${transferId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    if (!readFailed) {
      this.lastCheckedAt = now;
    }
    if (this.release !== null) {
      for (const runId of this.engine.ledger.approvedRuns()) {
        const tried: number = this.releaseTriedAt.get(runId) ?? Number.NEGATIVE_INFINITY;
        if (!this.agent.isBusy(runKey(runId)) && Date.now() - tried >= RETRY_RELEASE_MS) {
          this.releaseTriedAt.set(runId, Date.now());
          this.release(runId);
        }
      }
    }
    if (
      this.sweepEveryMs !== null &&
      (this.sweepRequested || Date.now() - this.lastSweep >= this.sweepEveryMs)
    ) {
      this.sweepRequested = false;
      this.lastSweep = Date.now();
      await sweep(this.engine, this.agent);
    }
  }
}

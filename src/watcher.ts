import { getTransfer, type Transfer } from "./airwallex/transfers.js";
import { attemptStateOf } from "./assess.js";
import type { Dispatcher } from "./dispatcher.js";
import { isExpired, type Engine } from "./engine.js";
import type { Approval, Attempt, AttemptState, OutsidePayout } from "./ledger.js";
import { sweep } from "./sweep.js";

// The fallback for webhooks. It checks every payment the ledger still shows in
// flight, PayOnce's own and those for its invoices sent outside it, and wakes the
// agent for an invoice whose payment the bank has moved on.
// It also wakes an invoice whose deadline has come, and one with an approval
// nobody has acted on yet, such as one given with pnpm approve while the server
// was running. Given a sweep interval, it also sweeps Airwallex for payouts
// PayOnce did not send.
export class Watcher {
  private readonly engine: Engine;
  private readonly agent: Dispatcher;
  private readonly sweepEveryMs: number | null;
  private intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSweep: number = 0;
  private sweepRequested: boolean = false;

  constructor(
    engine: Engine,
    agent: Dispatcher,
    intervalMs: number,
    sweepEveryMs: number | null = null,
  ) {
    this.engine = engine;
    this.agent = agent;
    this.intervalMs = intervalMs;
    this.sweepEveryMs = sweepEveryMs;
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
    const due: ReadonlySet<string> = new Set<string>(this.engine.ledger.dueLooks(now));
    for (const obligation of this.engine.ledger.obligations()) {
      const invoiceId: string = obligation.invoiceId;
      if (obligation.state === "settled" || this.agent.isBusy(invoiceId)) {
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
          console.warn(
            `  watcher  ${transferId}: ${error instanceof Error ? error.message : String(error)}`,
          );
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

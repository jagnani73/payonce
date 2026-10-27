import { getTransfer, type Transfer } from "./airwallex/transfers.js";
import { attemptStateOf } from "./assess.js";
import type { Dispatcher } from "./dispatcher.js";
import type { Engine } from "./engine.js";
import type { AttemptState } from "./ledger.js";

// The fallback for webhooks. It checks every payment the ledger still shows in
// flight and wakes the agent for an invoice whose payment the bank has moved on.
// It also wakes an invoice with an approval nobody has acted on yet, such as one
// given with pnpm approve while the server was running.
export class Watcher {
  private readonly engine: Engine;
  private readonly agent: Dispatcher;
  private intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(engine: Engine, agent: Dispatcher, intervalMs: number) {
    this.engine = engine;
    this.agent = agent;
    this.intervalMs = intervalMs;
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

  async check(): Promise<void> {
    for (const obligation of this.engine.ledger.obligations()) {
      const invoiceId: string = obligation.invoiceId;
      if (obligation.state === "settled" || this.agent.isBusy(invoiceId)) {
        continue;
      }
      if (this.engine.ledger.latestApproval(invoiceId)?.state === "approved") {
        this.agent.wake(invoiceId);
        continue;
      }
      for (const attempt of this.engine.ledger.attempts(invoiceId)) {
        if (attempt.state !== "in_flight" || attempt.transferId === null) {
          continue;
        }
        try {
          const transfer: Transfer = await getTransfer(
            this.engine.client,
            attempt.transferId,
          );
          const state: AttemptState | null = attemptStateOf(transfer);
          if (state !== null && state !== "in_flight") {
            this.agent.wake(invoiceId);
            break;
          }
        } catch (error: unknown) {
          console.warn(
            `  watcher  ${attempt.reference ?? attempt.transferId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
}

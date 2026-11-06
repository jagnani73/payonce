import type { Engine, LookOptions } from "./engine.js";
import { noteError } from "./lines.js";
import { resumeIncident } from "./look.js";

const NO_RUN_TURN: LookOptions = { runTurn: false };

// Runs the agent's work one invoice at a time. A webhook, a status check, new
// emails and a person's action can all arrive together, so every step on an
// invoice waits for the one before it and two steps never act on it at once.
export class Dispatcher {
  private readonly engine: Engine;
  // The end of each invoice's queue. An invoice with nothing queued has none.
  private readonly tails: Map<string, Promise<void>> = new Map<string, Promise<void>>();
  // Invoices with a look queued that has not started yet, and whether it has the
  // pay run's turn. Another wake would only repeat it, because the queued look
  // will see whatever woke the agent.
  private readonly queued: Map<string, LookOptions> = new Map<string, LookOptions>();

  constructor(engine: Engine) {
    this.engine = engine;
  }

  isBusy(invoiceId: string): boolean {
    return this.tails.has(invoiceId);
  }

  // Resolves once everything queued for the invoice so far has run.
  whenIdle(invoiceId: string): Promise<void> {
    return this.tails.get(invoiceId) ?? Promise.resolve();
  }

  run<T>(invoiceId: string, step: () => Promise<T> | T): Promise<T> {
    const previous: Promise<void> = this.tails.get(invoiceId) ?? Promise.resolve();
    const result: Promise<T> = previous.then(step);
    const tail: Promise<void> = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.tails.set(invoiceId, tail);
    void tail.then((): void => {
      if (this.tails.get(invoiceId) === tail) {
        this.tails.delete(invoiceId);
      }
    });
    return result;
  }

  // Has the agent look at an invoice again: sync its payments with Airwallex,
  // read new emails, then decide and act. A failure goes on its timeline.
  // options.runTurn gives the look the pay run's turn, so it may send a pay run
  // row's first payment. Only the release and the server's watcher give it.
  wake(invoiceId: string, options: LookOptions = NO_RUN_TURN): void {
    const queued: LookOptions | undefined = this.queued.get(invoiceId);
    if (queued !== undefined) {
      if (options.runTurn && !queued.runTurn) {
        this.queued.set(invoiceId, options);
      }
      return;
    }
    this.queued.set(invoiceId, options);
    this.run(invoiceId, (): Promise<void> => {
      const look: LookOptions = this.queued.get(invoiceId) ?? NO_RUN_TURN;
      this.queued.delete(invoiceId);
      return resumeIncident(this.engine, invoiceId, look);
    }).catch((error: unknown): void => {
      noteError(this.engine.ledger, invoiceId, error);
    });
  }
}

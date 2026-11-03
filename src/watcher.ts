import { getTransfer, type Transfer } from "./airwallex/transfers.js";
import { attemptStateOf } from "./assess.js";
import type { Dispatcher } from "./dispatcher.js";
import type { Engine } from "./engine.js";
import {
  isExpired,
  mismatchedLive,
  readingSoft,
  withBank,
  type Approval,
  type Attempt,
  type AttemptState,
  type Obligation,
  type OutsidePayout,
} from "./ledger.js";
import { sayWarning } from "./printable.js";
import { runKey } from "./runs.js";
import { sweep } from "./sweep.js";

// A release that failed, for example because Airwallex could not be read, is
// tried again this much later, not on every check.
const RETRY_RELEASE_MS: number = 60_000;
// A read failure that keeps repeating is printed again at most this often.
const REPEAT_PRINT_MS: number = 60_000;

interface RepeatedFailure {
  printedAt: number;
  // Reads that failed with it since it was last printed.
  since: number;
  // The check that last saw it.
  seenAt: number;
}

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
  private readonly failures: Map<string, RepeatedFailure> = new Map<string, RepeatedFailure>();
  // The last check that failed as a whole, such as a sweep while Airwallex cannot
  // be reached, its message, and whether the sweep is what failed.
  private checkFailure: (RepeatedFailure & { message: string; fromSweep: boolean }) | null = null;
  // Whether the check under way has swept, and whether it is sweeping now.
  private swept: boolean = false;
  private sweeping: boolean = false;
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
        .then((): void => {
          this.checkPassed();
        })
        .catch((error: unknown): void => {
          this.checkFailed(error instanceof Error ? error.message : String(error), Date.now());
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

  // While Airwallex cannot be read, every transfer fails on every check, every
  // few seconds. A failure's message is printed the first time, then at most once
  // a minute while it repeats, with how many reads failed with it meanwhile. One
  // that stops repeating is forgotten, so it prints again if it comes back.
  private readFailed(transferId: string, message: string, now: number): void {
    const seen: RepeatedFailure | undefined = this.failures.get(message);
    if (seen === undefined) {
      sayWarning(`  watcher  ${transferId}: ${message}`);
      this.failures.set(message, { printedAt: now, since: 0, seenAt: now });
      return;
    }
    seen.since += 1;
    seen.seenAt = now;
    if (now - seen.printedAt >= REPEAT_PRINT_MS) {
      sayWarning(`  watcher  ${seen.since} more ${seen.since === 1 ? "read" : "reads"} failed: ${message}`);
      seen.printedAt = now;
      seen.since = 0;
    }
  }

  // A check that fails as a whole is printed the same way: the first at once, then
  // at most once a minute while the same message repeats, with how many checks
  // failed with it meanwhile.
  private checkFailed(message: string, now: number): void {
    const seen: (RepeatedFailure & { message: string; fromSweep: boolean }) | null = this.checkFailure;
    const fromSweep: boolean = this.sweeping;
    if (seen === null || seen.message !== message || seen.fromSweep !== fromSweep) {
      // The failure this one replaces says how often it repeated first.
      if (seen !== null && seen.since > 0) {
        sayWarning(`  watcher  ${seen.since} more ${seen.since === 1 ? "check" : "checks"} failed: ${seen.message}`);
      }
      sayWarning(`  watcher  check failed: ${message}`);
      this.checkFailure = { message, fromSweep, printedAt: now, since: 0, seenAt: now };
      return;
    }
    seen.since += 1;
    seen.seenAt = now;
    if (now - seen.printedAt >= REPEAT_PRINT_MS) {
      sayWarning(`  watcher  ${seen.since} more ${seen.since === 1 ? "check" : "checks"} failed: ${message}`);
      seen.printedAt = now;
      seen.since = 0;
    }
  }

  // A sweep runs on some checks only, so a check without one says nothing about a
  // failure a sweep gave: only a check that swept forgets it. Any check that passed
  // forgets any other failure. Checks that failed with it since it was last
  // printed are counted once as it goes, so a failure that comes back later prints
  // again at once.
  private checkPassed(): void {
    const seen: (RepeatedFailure & { message: string; fromSweep: boolean }) | null = this.checkFailure;
    if (seen === null || (seen.fromSweep && this.sweepEveryMs !== null && !this.swept)) {
      return;
    }
    if (seen.since > 0) {
      sayWarning(
        `  watcher  ${seen.since} more ${seen.since === 1 ? "check" : "checks"} failed before checks worked again: ${seen.message}`,
      );
    }
    this.checkFailure = null;
  }

  private failingNow(now: number): void {
    for (const [message, seen] of this.failures) {
      if (seen.seenAt < now) {
        this.failures.delete(message);
      }
    }
  }

  // Sweeps on the next check, for a webhook about a transfer the ledger does not
  // know.
  sweepSoon(): void {
    this.sweepRequested = true;
  }

  async check(): Promise<void> {
    const now: number = Date.now();
    this.swept = false;
    this.sweeping = false;
    let readFailed: boolean = false;
    const due: ReadonlySet<string> = new Set<string>(this.engine.ledger.dueLooks(now));
    // Released rows that have not sent their first payment, in file order. Only
    // the release, or this check in the server once the release has stopped,
    // sends them: each check wakes the first due row of each run, with its turn.
    const unsent: { invoiceId: string; runId: number }[] = this.engine.ledger.unsentRunInvoices();
    if (this.release !== null) {
      const runsWoken: Set<number> = new Set<number>();
      for (const { invoiceId, runId } of unsent) {
        if (
          due.has(invoiceId) &&
          !runsWoken.has(runId) &&
          !this.agent.isBusy(invoiceId) &&
          !this.agent.isBusy(runKey(runId))
        ) {
          runsWoken.add(runId);
          this.agent.wake(invoiceId, true);
        }
      }
    }
    const unsentIds: ReadonlySet<string> = new Set<string>(
      unsent.map((row: { invoiceId: string; runId: number }): string => row.invoiceId),
    );
    // Which invoices to wake is read soft, so a row a look cannot read does not stop
    // the watcher for every other invoice: that invoice's look throws, sends
    // nothing and is tried again a minute later.
    for (const obligation of readingSoft((): Obligation[] => this.engine.ledger.obligations())) {
      const invoiceId: string = obligation.invoiceId;
      if (
        obligation.state === "settled" ||
        obligation.state === "rejected" ||
        unsentIds.has(invoiceId) ||
        this.agent.isBusy(invoiceId)
      ) {
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
      // PayOnce's own payments and payouts for the invoice sent outside it. A
      // transfer the ledger keeps failed while the bank has it in flight is read
      // too, and so is one under a request id that does not match the invoice, so
      // the look comes when the bank pays or fails it. A payout sent outside
      // PayOnce is read in any state that is not final, so one a look stored as
      // unknown, such as one it read as OVERDUE, is read again.
      const attempts: Attempt[] = readingSoft((): Attempt[] => this.engine.ledger.attempts(invoiceId));
      const inFlight: string[] = [
        ...attempts
          .filter(
            (attempt: Attempt): boolean =>
              attempt.state === "in_flight" || (attempt.state === "failed" && withBank(attempt)),
          )
          .map((attempt: Attempt): string | null => attempt.transferId),
        ...attempts
          .filter((attempt: Attempt): boolean => mismatchedLive(attempt) && attempt.mismatchedStatus !== "PAID")
          .map((attempt: Attempt): string | null => attempt.mismatchedTransferId),
        ...this.engine.ledger
          .outsidePayouts(invoiceId)
          .filter((payout: OutsidePayout): boolean => payout.state !== "paid" && payout.state !== "failed")
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
          this.readFailed(transferId, error instanceof Error ? error.message : String(error), now);
        }
      }
    }
    if (!readFailed) {
      this.lastCheckedAt = now;
    }
    this.failingNow(now);
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
      this.sweeping = true;
      await sweep(this.engine, this.agent);
      this.sweeping = false;
      this.swept = true;
    }
  }
}

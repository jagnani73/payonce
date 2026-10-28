import { randomUUID } from "node:crypto";
import type { Ledger } from "./ledger.js";

// A lease runs out by itself, so a process that dies holding one blocks its
// currency for a minute at most. The holder renews it well before then.
const LEASE_MS: number = 60_000;
const RENEW_EVERY_MS: number = 20_000;
// How long a payment waits for its turn before the look fails and is tried again
// a minute later.
const WAIT_MS: number = 45_000;
const POLL_MS: number = 200;

// Another payment from the same wallet held the lock for longer than a payment
// waits.
export class CurrencyBusyError extends Error {
  constructor(currency: string) {
    super(
      `Another ${currency} payment was being sent for longer than PayOnce waits, so nothing was sent. PayOnce tries again in a minute`,
    );
    this.name = "CurrencyBusyError";
  }
}

// Runs step while holding the lease on a wallet's currency. Every payment
// PayOnce creates holds it from the balance read, through the floor check and
// the attempt, to creating and recording the transfer, so the next holder sees
// either a balance already debited or an attempt still being sent, never
// neither. The lease is a row in the ledger, so the CLI and the server, which are
// separate processes, take turns too. It is not re-entrant: step must not take
// the same currency again.
export async function withCurrencyLock<T>(
  ledger: Ledger,
  currency: string,
  step: () => Promise<T>,
): Promise<T> {
  const holder: string = `${process.pid}:${randomUUID()}`;
  const deadline: number = Date.now() + WAIT_MS;
  while (!ledger.takeCurrencyLock(currency, holder, Date.now() + LEASE_MS)) {
    if (Date.now() > deadline) {
      throw new CurrencyBusyError(currency);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
  const renew: ReturnType<typeof setInterval> = setInterval((): void => {
    try {
      if (!ledger.renewCurrencyLock(currency, holder, Date.now() + LEASE_MS)) {
        console.warn(`  lock     the ${currency} lease ran out before the payment finished`);
      }
    } catch (error: unknown) {
      console.warn(`  lock     ${error instanceof Error ? error.message : String(error)}`);
    }
  }, RENEW_EVERY_MS);
  try {
    return await step();
  } finally {
    clearInterval(renew);
    ledger.releaseCurrencyLock(currency, holder);
  }
}

// Takes several currencies in code order, so two holders never wait on each
// other.
export function withCurrencyLocks<T>(
  ledger: Ledger,
  currencies: string[],
  step: () => Promise<T>,
): Promise<T> {
  const [first, ...rest] = [...new Set(currencies)].sort((a: string, b: string): number =>
    a.localeCompare(b),
  );
  if (first === undefined) {
    return step();
  }
  return withCurrencyLock(ledger, first, (): Promise<T> => withCurrencyLocks(ledger, rest, step));
}

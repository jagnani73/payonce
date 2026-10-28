import { randomUUID } from "node:crypto";
import type { Lease, Ledger } from "./ledger.js";

// A lease runs out by itself, so a process that dies holding one blocks its
// currency for a minute at most. The holder renews it well before then.
const LEASE_MS: number = 60_000;
const RENEW_EVERY_MS: number = 20_000;
// How long a payment waits for its turn before it gives up, sends nothing and
// leaves the next try to a later look. Waiters take the lock in the order they
// asked, so this is the time the payments ahead of it take, not a race.
const WAIT_MS: number = 45_000;
const POLL_MS: number = 200;

// The payments ahead of this one in its currency held the lock for longer than a
// payment waits.
export class CurrencyBusyError extends Error {
  constructor(currency: string) {
    super(
      `Other ${currency} payments held the ${currency} lock for the ${WAIT_MS / 1000} seconds PayOnce waits for its turn, so it sent nothing. It tries again in a minute`,
    );
    this.name = "CurrencyBusyError";
  }
}

// Runs step while holding the lease on a wallet's currency. Every payment
// PayOnce creates holds it from the balance read, through the floor check and
// the attempt, to creating and recording the transfer. The ledger opens an
// attempt, or releases a run, only in a transaction that finds the lease still
// held, so a holder whose lease ran out writes nothing and the next holder sees
// either a balance already debited or an attempt still being sent. Payouts sent
// outside PayOnce take no lease. The lease is a row in the ledger, so the CLI
// and the server, which are separate processes, take turns too, and waiters take
// it in the order they asked. It is not re-entrant: step must not take the same
// currency again.
export async function withCurrencyLock<T>(
  ledger: Ledger,
  currency: string,
  step: (lease: Lease) => Promise<T>,
): Promise<T> {
  const lease: Lease = { currency, holder: `${process.pid}:${randomUUID()}` };
  const deadline: number = Date.now() + WAIT_MS;
  while (!ledger.takeCurrencyLock(currency, lease.holder, Date.now() + LEASE_MS)) {
    if (Date.now() > deadline) {
      ledger.leaveCurrencyQueue(currency, lease.holder);
      throw new CurrencyBusyError(currency);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
  // A renewal that finds the lease gone only warns. The step then fails at its
  // next write, because the ledger checks the lease there.
  const renew: ReturnType<typeof setInterval> = setInterval((): void => {
    try {
      if (!ledger.renewCurrencyLock(currency, lease.holder, Date.now() + LEASE_MS)) {
        console.warn(`  lock     the ${currency} lease ran out before the payment finished`);
      }
    } catch (error: unknown) {
      console.warn(`  lock     ${error instanceof Error ? error.message : String(error)}`);
    }
  }, RENEW_EVERY_MS);
  try {
    return await step(lease);
  } finally {
    clearInterval(renew);
    ledger.releaseCurrencyLock(currency, lease.holder);
  }
}

// Takes several currencies in code order, so two holders never wait on each
// other, and passes step every lease.
export function withCurrencyLocks<T>(
  ledger: Ledger,
  currencies: string[],
  step: (leases: Lease[]) => Promise<T>,
  held: Lease[] = [],
): Promise<T> {
  const [first, ...rest] = [...new Set(currencies)].sort((a: string, b: string): number =>
    a.localeCompare(b),
  );
  if (first === undefined) {
    return step(held);
  }
  return withCurrencyLock(
    ledger,
    first,
    (lease: Lease): Promise<T> => withCurrencyLocks(ledger, rest, step, [...held, lease]),
  );
}

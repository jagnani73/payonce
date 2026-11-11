import type { DailyPaymentCap } from "../../settings.js";
import type { Ledger } from "../../store/ledger.js";
import { HttpError } from "./http.js";

const DAY_MS: number = 24 * 60 * 60 * 1000;
// The longest places stay held while they wait for the ledger to show them, so a
// release that keeps failing does not hold them for the rest of the day.
const MAX_SETTLE_MS: number = 15 * 60 * 1000;

// The start of the UTC day now falls in.
function dayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

function payments(count: number): string {
  return `${count} ${count === 1 ? "payment" : "payments"}`;
}

// The start-up line for DAILY_PAYMENT_CAP, or null when it is unset.
export function describeDailyCap(setting: DailyPaymentCap): string | null {
  if (setting.problem !== null) {
    return setting.problem;
  }
  return setting.cap === null ? null : `The page starts at most ${payments(setting.cap)} a day (UTC), pay run rows included`;
}

// Places a route holds for payments it is about to start.
export interface Places {
  // The step started nothing, or the ledger counts what it started: let go.
  release: () => void;
  // The payments start later, as a released run's do: keep holding until shown
  // is true, which it is once the ledger counts them.
  settleWhen: (shown: () => boolean) => void;
}

interface Held {
  count: number;
  released: boolean;
  shown: (() => boolean) | null;
  since: number;
}

// The routes that start payments ask it before they start one: New payment, a
// scripted incident, a pay run upload and a pay run approval. It counts the day's
// payments from the ledger, so a payment pnpm recover started counts too, and it
// refuses with 429 past DAILY_PAYMENT_CAP. It never stops a payment already
// started: an approval, a retry or a replacement on one goes on as before.
export class DailyCap {
  private readonly ledger: Ledger;
  private readonly setting: DailyPaymentCap;
  // Places routes hold for payments the ledger does not show yet.
  private held: Held[] = [];

  constructor(ledger: Ledger, setting: DailyPaymentCap) {
    this.ledger = ledger;
    this.setting = setting;
  }

  // Checks that wanted more payments fit under today's cap and holds their places,
  // in one synchronous call, so two requests at once cannot both take the last
  // places while each awaits. Refuses with 429 otherwise. subject says what would
  // start them, such as "This file has 3 rows", or is null for one payment.
  hold(wanted: number, subject: string | null, now: number = Date.now()): Places {
    const cap: number | null = this.setting.cap;
    if (cap === null) {
      return { release: (): void => undefined, settleWhen: (): void => undefined };
    }
    this.held = this.held.filter(
      (entry: Held): boolean =>
        !entry.released && !(entry.shown !== null && (entry.shown() || now - entry.since > MAX_SETTLE_MS)),
    );
    const reserved: number = this.held.reduce((sum: number, entry: Held): number => sum + entry.count, 0);
    const started: number = this.ledger.paymentsStartedSince(new Date(dayStart(now)).toISOString()) + reserved;
    const left: number = Math.max(0, cap - started);
    if (wanted > left) {
      const retryAfter: number = Math.max(1, Math.ceil((dayStart(now) + DAY_MS - now) / 1000));
      const limit: string = `This server starts at most ${payments(cap)} a day (UTC), pay run rows included`;
      const text: string =
        subject === null || left === 0
          ? `${limit}, and ${started} started today. Try again after midnight UTC.`
          : `${subject}, and this server can start ${left} more ${left === 1 ? "payment" : "payments"} today. ${limit}. Try again after midnight UTC.`;
      throw new HttpError(429, text, { code: "daily-cap", cap, left }, { "Retry-After": String(retryAfter) });
    }
    const entry: Held = { count: wanted, released: false, shown: null, since: now };
    this.held.push(entry);
    return {
      release: (): void => {
        entry.released = true;
      },
      settleWhen: (shown: () => boolean): void => {
        entry.shown = shown;
        entry.since = Date.now();
      },
    };
  }

  // Holds one place while start runs. By the time it ends the ledger shows the
  // invoice it opened, or it opened none.
  async starting<T>(start: () => Promise<T>): Promise<T> {
    const places: Places = this.hold(1, null);
    try {
      return await start();
    } finally {
      places.release();
    }
  }
}

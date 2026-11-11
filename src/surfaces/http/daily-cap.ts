import type { DailyPaymentCap } from "../../settings.js";
import type { Ledger } from "../../store/ledger.js";
import { HttpError } from "./http.js";

const DAY_MS: number = 24 * 60 * 60 * 1000;

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

// The routes that start payments ask it before they start one: New payment, a
// scripted incident, a pay run upload and a pay run approval. It counts the day's
// payments from the ledger, so a payment pnpm recover started counts too, and it
// refuses with 429 past DAILY_PAYMENT_CAP. It never stops a payment already
// started: an approval, a retry or a replacement on one goes on as before.
export class DailyCap {
  private readonly ledger: Ledger;
  private readonly setting: DailyPaymentCap;
  // Payments a start has passed the check for and not yet written.
  private reserved: number = 0;

  constructor(ledger: Ledger, setting: DailyPaymentCap) {
    this.ledger = ledger;
    this.setting = setting;
  }

  // Refuses with 429 when wanted more payments would pass today's cap. subject
  // says what would start them, such as "This file has 3 rows", or is null for one
  // payment.
  check(wanted: number, subject: string | null, now: number = Date.now()): void {
    const cap: number | null = this.setting.cap;
    if (cap === null) {
      return;
    }
    const started: number = this.ledger.paymentsStartedSince(new Date(dayStart(now)).toISOString()) + this.reserved;
    const left: number = Math.max(0, cap - started);
    if (wanted <= left) {
      return;
    }
    const retryAfter: number = Math.max(1, Math.ceil((dayStart(now) + DAY_MS - now) / 1000));
    const limit: string = `This server starts at most ${payments(cap)} a day (UTC), pay run rows included`;
    const text: string =
      subject === null || left === 0
        ? `${limit}, and ${started} started today. Try again after midnight UTC.`
        : `${subject}, and this server can start ${left} more ${left === 1 ? "payment" : "payments"} today. ${limit}. Try again after midnight UTC.`;
    throw new HttpError(429, text, { code: "daily-cap", cap, left }, { "Retry-After": String(retryAfter) });
  }

  // Checks one payment and holds its place until start ends, so two starts at
  // once cannot both take the last place while each waits on Airwallex.
  async starting<T>(start: () => Promise<T>): Promise<T> {
    this.check(1, null);
    this.reserved += 1;
    try {
      return await start();
    } finally {
      this.reserved -= 1;
    }
  }
}

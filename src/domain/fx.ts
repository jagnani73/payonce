import type { QuoteValidity } from "../airwallex/fx.js";

const VALIDITY_WORDS: Record<QuoteValidity, string> = {
  MIN_30: "30 minutes",
  HR_1: "1 hour",
  HR_4: "4 hours",
  HR_8: "8 hours",
  HR_24: "24 hours",
};

// FX_QUOTE_VALIDITY as settings.ts reads it: how long the exchange rate quote
// behind an approval request holds, or why PayOnce takes no quote.
export type QuoteSetting = { validity: QuoteValidity; problem: null } | { validity: null; problem: string };

// Asked when a quote is taken, as the bank deadlines are. Throws on a value
// PayOnce does not take, so no quote is taken.
export function quoteValidity(setting: QuoteSetting): QuoteValidity {
  if (setting.validity === null) {
    throw new Error(setting.problem);
  }
  return setting.validity;
}

export function describeQuotes(setting: QuoteSetting): string {
  return setting.validity === null
    ? `Payments from another currency's wallet are held: ${setting.problem}`
    : `Exchange rate quotes hold for ${VALIDITY_WORDS[setting.validity]} (${setting.validity}), and every payment from another currency's wallet waits for a person to approve its rate`;
}

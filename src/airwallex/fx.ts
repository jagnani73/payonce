import type { AirwallexClient } from "./client.js";

// How long a quote holds. MIN_1 and MIN_15 are left out: neither leaves room for
// an approval request, the time an approval has to be used, and a margin.
export type QuoteValidity = "MIN_30" | "HR_1" | "HR_4" | "HR_8" | "HR_24";

export const QUOTE_VALIDITIES: QuoteValidity[] = ["MIN_30", "HR_1", "HR_4", "HR_8", "HR_24"];

// A locked exchange rate. client_rate is the rate for currency_pair in the
// market's convention: EURUSD 1.119541 is 1 EUR = 1.119541 USD, whichever way
// the money goes. Times read like 2026-10-28T13:28:58+0000.
export interface Quote {
  quote_id: string;
  currency_pair: string;
  client_rate: number;
  mid_rate: number;
  sell_currency: string;
  sell_amount: number;
  buy_currency: string;
  buy_amount: number;
  valid_from_at: string;
  valid_to_at: string;
}

// Buys exactly buyAmountMajor, so the supplier receives the invoice amount and
// the rate decides what leaves the sell currency's wallet.
export function createQuote(
  client: AirwallexClient,
  sellCurrency: string,
  buyCurrency: string,
  buyAmountMajor: number,
  validity: QuoteValidity,
): Promise<Quote> {
  return client.post<Quote>("/api/v1/fx/quotes/create", {
    sell_currency: sellCurrency,
    buy_currency: buyCurrency,
    buy_amount: buyAmountMajor,
    validity,
  });
}

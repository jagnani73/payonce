import { createQuote, type Quote } from "../airwallex/fx.js";
import {
  describeRate,
  fxTermsOf,
  markupOf,
  withFeeEstimate,
  type FxTerms,
  type LastQuote,
} from "../domain/approval.js";
import { APPROVED_USE_WITHIN_MS } from "../domain/approvers.js";
import { quoteValidity } from "../domain/fx.js";
import { isExpired } from "../domain/live.js";
import { formatMoney, invoiceMoney, toMajor } from "../domain/money.js";
import { currentSettings } from "../settings.js";
import { checkedObject, type Approval, type Obligation } from "../store/ledger.js";
import type { Engine, Rate } from "./engine.js";
import { isLastQuote, quoteOnFile, requestTerms } from "./stored.js";

// An approval request ends this long before its quote does, after the time an
// approval given at the last moment has to be used, so a slow look or a clock
// that differs from Airwallex's never sends on a quote that has run out.
const QUOTE_MARGIN_MS: number = 2 * 60_000;

function quoteFits(fx: FxTerms, obligation: Obligation): boolean {
  return (
    fx.sellCurrency === obligation.sourceCurrency &&
    fx.buyCurrency === obligation.currency &&
    fx.buyAmountMinor === obligation.amountMinor
  );
}

// The quote a payment of this invoice from another currency's wallet is offered
// at. While an approval request is open, every look builds its terms on that
// request's own quote, so its binding holds still. Any other time it offers the
// invoice's last quote if no request has shown it and it holds long enough for
// one, so a look that opens no request takes no quote, and otherwise takes a
// fresh one. A new request never opens on a quote an earlier one showed.
// feeEstimateMinor is the fee the payment should cost, in the sell currency.
export async function rateFor(
  engine: Engine,
  obligation: Obligation,
  feeEstimateMinor: number | null,
): Promise<Rate> {
  const latest: Approval | undefined = engine.ledger.latestApproval(obligation.invoiceId);
  const shown: FxTerms | undefined =
    latest === undefined ? undefined : requestTerms(latest).fx;
  const open: FxTerms | undefined =
    latest !== undefined &&
    (latest.state === "requested" || latest.state === "approved") &&
    !isExpired(latest)
      ? shown
      : undefined;
  if (open !== undefined && quoteFits(open, obligation)) {
    return { fx: withFeeEstimate(open, feeEstimateMinor), fresh: false, endsAt: Number.NaN };
  }
  // Every request opens on the last quote, so only the latest can have shown it.
  // It is offered while a request opened on it would stay open at least as long
  // as an approval has to be used.
  const kept: string | undefined = engine.ledger.lastQuote(obligation.invoiceId);
  const last: LastQuote | undefined =
    kept === undefined ? undefined : checkedObject(kept, isLastQuote, quoteOnFile(obligation.invoiceId));
  if (
    last !== undefined &&
    last.fx.quoteId !== shown?.quoteId &&
    quoteFits(last.fx, obligation) &&
    last.endsAt - Date.now() > 2 * APPROVED_USE_WITHIN_MS + QUOTE_MARGIN_MS
  ) {
    return { fx: withFeeEstimate(last.fx, feeEstimateMinor), fresh: true, endsAt: last.endsAt };
  }
  const quote: Quote = await createQuote(
    engine.client,
    obligation.sourceCurrency,
    obligation.currency,
    toMajor(obligation.amountMinor),
    quoteValidity(currentSettings().fxQuotes),
  );
  const receivedAt: number = Date.now();
  const fx: FxTerms = fxTermsOf(quote, obligation, feeEstimateMinor);
  // This clock and Airwallex's may differ, so the quote is taken to hold no
  // longer than its validity counted from when it arrived.
  const validTo: number = Date.parse(quote.valid_to_at);
  const endsAt: number = Math.min(validTo, receivedAt + (validTo - Date.parse(quote.valid_from_at)));
  if (!(endsAt - receivedAt > APPROVED_USE_WITHIN_MS + QUOTE_MARGIN_MS)) {
    throw new Error(
      `The exchange rate quote Airwallex sent holds until ${quote.valid_to_at}, too briefly for an approval request, so PayOnce offers nothing on it`,
    );
  }
  const taken: LastQuote = { fx, endsAt };
  engine.ledger.saveQuote(obligation.invoiceId, JSON.stringify(taken));
  return { fx, fresh: true, endsAt };
}

// When a request opened now on this quote stops covering a payment: its TTL, or
// earlier, so that an approval given at the last moment is used, or void, before
// the quote runs out.
export function requestExpiry(engine: Engine, rate: Rate | null, now: number): number {
  const ttl: number = now + engine.approvals.expiresAfterMs;
  return rate === null ? ttl : Math.min(ttl, rate.endsAt - APPROVED_USE_WITHIN_MS - QUOTE_MARGIN_MS);
}

// "Quote for 4,000.00 EUR: 4,478.04 USD at 1 EUR = 1.119509 USD, ..." with the
// last request's rate when it was another.
export function quoteLine(obligation: Obligation, fx: FxTerms, previous: FxTerms | undefined): string {
  const until: string = new Date(Date.parse(fx.validTo)).toISOString().slice(11, 16);
  const was: string =
    previous === undefined || previous.quoteId === fx.quoteId
      ? ""
      : `. The last request's quote was ${describeRate(previous)} (${formatMoney(previous.sellAmountMinor, previous.sellCurrency)})`;
  return `Quote for ${invoiceMoney(obligation)}: ${formatMoney(fx.sellAmountMinor, fx.sellCurrency)} at ${describeRate(fx)}, ${markupOf(fx)} from mid-market, held until ${until} UTC${was}`;
}

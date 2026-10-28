import { createHash } from "node:crypto";
import type { Quote } from "./airwallex/fx.js";
import type { Transfer, TransferBankDetails } from "./airwallex/transfers.js";
import { bankDetailsKey, originalStateOf } from "./assess.js";
import type { Decision, OriginalTransferState } from "./incident.js";
import type { BankChange, Obligation, ObligationState, TransferMethod } from "./ledger.js";
import { formatMoney, readMinor, toMinor } from "./money.js";

// The callback that verified the bank details the payment goes to, when they are
// not the ones the original went to.
export interface BankChangeEvidence {
  id: number;
  invoiceId: string;
  calledBy: string;
  numberCalled: string;
  calledAt: string;
  spokeTo: string;
  confirmed: string;
}

export interface ApprovalEvidence {
  originalReference: string;
  originalState: OriginalTransferState;
  failureCode: string | null;
  emails: string;
  reason: string;
  bankChange: BankChangeEvidence | null;
}

// An invoice a held one looks like a second bill for, as it stood when the terms
// were built. paidBy is the bank's reference for the payment that paid it, or
// null. sameAccount says whether that payment, or else one still with the bank,
// went to the account this one would, and is null when there is neither.
export interface DuplicateEvidence {
  invoiceId: string;
  state: ObligationState;
  paidBy: string | null;
  sameAccount: boolean | null;
}

export interface HeldEvidence {
  reason: string;
  duplicates: DuplicateEvidence[];
}

// The locked exchange rate a payment from another currency's wallet is sent
// with. clientRate is for currencyPair as Airwallex quotes it: EURUSD 1.119541 is
// 1 EUR = 1.119541 USD, whichever way the money goes. validTo is the quote's
// valid_to_at as Airwallex wrote it. feeEstimateMinor is in sellCurrency: the
// failed original's fee, or null before anything was sent.
export interface FxTerms {
  quoteId: string;
  currencyPair: string;
  clientRate: number;
  midRate: number;
  sellCurrency: string;
  sellAmountMinor: number;
  buyCurrency: string;
  buyAmountMinor: number;
  validTo: string;
  feeEstimateMinor: number | null;
}

// The latest quote taken for an invoice, as obligations.last_quote keeps it.
// endsAt is when it runs out by PayOnce's clock.
export interface LastQuote {
  fx: FxTerms;
  endsAt: number;
}

interface PaymentTerms {
  invoiceId: string;
  amountMinor: number;
  currency: string;
  beneficiaryId: string;
  payTo: string;
  // A hash of every bank detail the payment goes to. payTo shows only part of the
  // account, so this is what pins it.
  accountKey: string;
  // Only on a payment from another currency's wallet, so every other payment's
  // terms, and their binding, are as they were before FX.
  fx?: FxTerms;
}

// A second payment for an invoice whose original failed.
export interface ReplacementTerms extends PaymentTerms {
  action: "replace";
  evidence: ApprovalEvidence;
}

// The first payment for an invoice PayOnce held before paying, because it looks
// like a second bill for one the ledger already has.
export interface HeldPaymentTerms extends PaymentTerms {
  action: "pay";
  evidence: HeldEvidence;
}

// What a person is shown and what their approval covers. Always build it with
// termsFor or heldTermsFor so the key order, and with it the binding, stays
// stable.
export type ApprovalTerms = ReplacementTerms | HeldPaymentTerms;

// One pay row of a run as its approvers see it. heldFor lists the invoices in the
// ledger the row looks like a second bill for: it is released with the run, and
// PayOnce holds it for a person when it comes to send it.
export interface RunRowTerms {
  line: number;
  invoiceId: string;
  amountMinor: number;
  currency: string;
  beneficiaryId: string;
  transferMethod: TransferMethod;
  payTo: string;
  accountKey: string;
  heldFor: string[];
  // The callback that verified the account, when PayOnce last paid this supplier
  // another one.
  bankChange: number | null;
}

// A currency's pay rows. reserveFloorMinor is the floor the cash check used, null
// when none is set for the currency.
export interface RunTotal {
  currency: string;
  amountMinor: number;
  payments: number;
  reserveFloorMinor: number | null;
}

// What a run's approvers approve: every pay row in file order and the totals per
// currency, sorted by code. Skipped rows move no money and are left out. Build it
// only with runTermsFor so the key order, and with it the binding, stays stable.
export interface RunTerms {
  action: "run";
  runId: number;
  fileHash: string;
  uploadedBy: string;
  rows: RunRowTerms[];
  totals: RunTotal[];
}

export function runTermsFor(
  runId: number,
  fileHash: string,
  uploadedBy: string,
  rows: RunRowTerms[],
  totals: RunTotal[],
): RunTerms {
  return {
    action: "run",
    runId,
    fileHash,
    uploadedBy,
    rows: rows.map(
      (row: RunRowTerms): RunRowTerms => ({
        line: row.line,
        invoiceId: row.invoiceId,
        amountMinor: row.amountMinor,
        currency: row.currency,
        beneficiaryId: row.beneficiaryId,
        transferMethod: row.transferMethod,
        payTo: row.payTo,
        accountKey: row.accountKey,
        heldFor: row.heldFor,
        bankChange: row.bankChange,
      }),
    ),
    totals: totals.map(
      (total: RunTotal): RunTotal => ({
        currency: total.currency,
        amountMinor: total.amountMinor,
        payments: total.payments,
        reserveFloorMinor: total.reserveFloorMinor,
      }),
    ),
  };
}

// Who a payment goes to, as a person reads it: the account name, the bank and the
// last four characters of the account.
export function payTo(supplier: string, details: TransferBankDetails): string {
  const parts: string[] = [details.account_name ?? supplier];
  if (details.bank_name !== undefined) {
    parts.push(details.bank_name);
  }
  const account: string | undefined = details.account_number ?? details.iban;
  if (account !== undefined) {
    parts.push(`account ending ${account.slice(-4)}`);
  }
  return parts.join(", ");
}

// bankDetails is what the beneficiary record holds now, which is where a new
// transfer would go. It is not taken from the original transfer. bankChange is
// the callback that verified those details, if they changed. fx is the quote a
// payment from another currency's wallet is approved at.
export function termsFor(
  obligation: Obligation,
  original: Transfer,
  decision: Decision,
  emailSummary: string,
  bankDetails: TransferBankDetails,
  bankChange: BankChange | null,
  fx: FxTerms | null,
): ReplacementTerms {
  return {
    action: "replace",
    invoiceId: obligation.invoiceId,
    amountMinor: obligation.amountMinor,
    currency: obligation.currency,
    beneficiaryId: obligation.beneficiaryId,
    payTo: payTo(obligation.supplier, bankDetails),
    accountKey: accountKeyOf(bankDetails),
    ...(fx === null ? {} : { fx }),
    evidence: {
      originalReference: original.short_reference_id,
      originalState: originalStateOf(original),
      failureCode: original.failure?.code ?? null,
      emails: emailSummary,
      reason: decision.reason,
      bankChange:
        bankChange === null
          ? null
          : {
              id: bankChange.id,
              invoiceId: bankChange.invoiceId,
              calledBy: bankChange.calledBy,
              numberCalled: bankChange.numberCalled,
              calledAt: bankChange.calledAt,
              spokeTo: bankChange.spokeTo,
              confirmed: bankChange.confirmed,
            },
    },
  };
}

// bankDetails is what the beneficiary record holds now, which is where the payment
// would go. fx is the quote a payment from another currency's wallet is approved
// at.
export function heldTermsFor(
  obligation: Obligation,
  bankDetails: TransferBankDetails,
  duplicates: DuplicateEvidence[],
  fx: FxTerms | null,
): HeldPaymentTerms {
  return {
    action: "pay",
    invoiceId: obligation.invoiceId,
    amountMinor: obligation.amountMinor,
    currency: obligation.currency,
    beneficiaryId: obligation.beneficiaryId,
    payTo: payTo(obligation.supplier, bankDetails),
    accountKey: accountKeyOf(bankDetails),
    ...(fx === null ? {} : { fx }),
    evidence: {
      reason: obligation.escalationReason,
      duplicates,
    },
  };
}

// The accountKey for bank details already written by bankDetailsKey.
export function keyHash(detailsKey: string): string {
  return createHash("sha256").update(detailsKey).digest("hex").slice(0, 16);
}

export function accountKeyOf(details: TransferBankDetails | undefined): string {
  return keyHash(bankDetailsKey(details));
}

export function bindingOf(terms: ApprovalTerms | RunTerms): string {
  return createHash("sha256").update(JSON.stringify(terms)).digest("hex");
}

export function changedFields(
  approved: ApprovalTerms,
  current: ApprovalTerms,
): string[] {
  const changed: string[] = [];
  if (approved.action !== current.action) {
    changed.push("payment");
  }
  if (approved.amountMinor !== current.amountMinor) {
    changed.push("amount");
  }
  if (approved.currency !== current.currency) {
    changed.push("currency");
  }
  if (
    approved.beneficiaryId !== current.beneficiaryId ||
    approved.payTo !== current.payTo ||
    approved.accountKey !== current.accountKey
  ) {
    changed.push("beneficiary");
  }
  if (JSON.stringify(approved.fx ?? null) !== JSON.stringify(current.fx ?? null)) {
    changed.push("exchange rate");
  }
  if (JSON.stringify(approved.evidence) !== JSON.stringify(current.evidence)) {
    changed.push("evidence");
  }
  return changed;
}

// Builds the fx block in one key order, so a quote taken again from stored terms
// gives the same binding.
function fxBlock(fx: FxTerms): FxTerms {
  return {
    quoteId: fx.quoteId,
    currencyPair: fx.currencyPair,
    clientRate: fx.clientRate,
    midRate: fx.midRate,
    sellCurrency: fx.sellCurrency,
    sellAmountMinor: fx.sellAmountMinor,
    buyCurrency: fx.buyCurrency,
    buyAmountMinor: fx.buyAmountMinor,
    validTo: fx.validTo,
    feeEstimateMinor: fx.feeEstimateMinor,
  };
}

// A quote as terms a person approves. Throws, so nothing is offered on it, when
// it is not for this invoice's payment from its wallet or cannot be read.
export function fxTermsOf(
  quote: Quote,
  obligation: Obligation,
  feeEstimateMinor: number | null,
): FxTerms {
  const sell: string = obligation.sourceCurrency;
  const buy: string = obligation.currency;
  if (
    quote.sell_currency !== sell ||
    quote.buy_currency !== buy ||
    toMinor(quote.buy_amount) !== obligation.amountMinor
  ) {
    throw new Error(
      `Airwallex quoted ${quote.sell_currency} for ${String(quote.buy_amount)} ${quote.buy_currency}, not ${sell} for ${formatMoney(obligation.amountMinor, buy)}, so PayOnce offers nothing on it`,
    );
  }
  if (
    typeof quote.quote_id !== "string" ||
    quote.quote_id === "" ||
    (quote.currency_pair !== `${sell}${buy}` && quote.currency_pair !== `${buy}${sell}`) ||
    !(quote.client_rate > 0) ||
    !(quote.mid_rate > 0) ||
    !Number.isFinite(Date.parse(quote.valid_from_at)) ||
    !Number.isFinite(Date.parse(quote.valid_to_at))
  ) {
    throw new Error("Airwallex sent an exchange rate quote PayOnce cannot read, so it offers nothing on it");
  }
  return fxBlock({
    quoteId: quote.quote_id,
    currencyPair: quote.currency_pair,
    clientRate: quote.client_rate,
    midRate: quote.mid_rate,
    sellCurrency: quote.sell_currency,
    sellAmountMinor: toMinor(quote.sell_amount),
    buyCurrency: quote.buy_currency,
    buyAmountMinor: toMinor(quote.buy_amount),
    validTo: quote.valid_to_at,
    feeEstimateMinor,
  });
}

// The same quote with the fee estimate as it is now.
export function withFeeEstimate(fx: FxTerms, feeEstimateMinor: number | null): FxTerms {
  return fxBlock({ ...fx, feeEstimateMinor });
}

// "1 EUR = 1.119541 USD" for the pair EURUSD.
export function rateText(currencyPair: string, rate: number): string {
  return `1 ${currencyPair.slice(0, 3)} = ${String(rate)} ${currencyPair.slice(3)}`;
}

export function describeRate(fx: FxTerms): string {
  return rateText(fx.currencyPair, fx.clientRate);
}

// How far the quoted rate is from the mid-market rate, such as "0.54%".
export function markupOf(fx: FxTerms): string {
  return `${((Math.abs(fx.clientRate - fx.midRate) / fx.midRate) * 100).toFixed(2)}%`;
}

// ", paid with 4,478.04 USD at 1 EUR = 1.119509 USD", or nothing for a payment
// from the invoice's own currency.
export function paidWith(fx: FxTerms | undefined): string {
  return fx === undefined
    ? ""
    : `, paid with ${formatMoney(fx.sellAmountMinor, fx.sellCurrency)} at ${describeRate(fx)}`;
}

// What went out of the wallet on a transfer that converts, as the timeline says
// it. Empty when the transfer does not convert or cannot be read.
export function conversionText(transfer: Transfer): string {
  const source: number | null = readMinor(transfer.source_amount);
  if (transfer.conversion === undefined || source === null || transfer.source_currency === undefined) {
    return "";
  }
  return `, paid with ${formatMoney(source, transfer.source_currency)} at ${rateText(transfer.conversion.currency_pair, transfer.conversion.rate)}`;
}

// Why a transfer did not go out on its approved quote, or null when it did. fx is
// undefined when no approval covers the quote it was sent with. Rates are
// compared as Airwallex gives them, never inverted, and a transfer with no
// conversion on it does not match.
export function rateMismatch(fx: FxTerms | undefined, transfer: Transfer): string | null {
  const source: number | null = readMinor(transfer.source_amount);
  if (
    fx !== undefined &&
    transfer.conversion?.currency_pair === fx.currencyPair &&
    transfer.conversion.rate === fx.clientRate &&
    source === fx.sellAmountMinor &&
    transfer.source_currency === fx.sellCurrency
  ) {
    return null;
  }
  const actual: string =
    transfer.conversion === undefined
      ? "with no exchange rate on it"
      : `at ${rateText(transfer.conversion.currency_pair, transfer.conversion.rate)} (${source === null ? "amount not readable" : formatMoney(source, transfer.source_currency ?? "")})`;
  return fx === undefined
    ? `went out ${actual}, and no approval covers the quote it was sent with`
    : `went out ${actual}, not the approved ${describeRate(fx)} (${formatMoney(fx.sellAmountMinor, fx.sellCurrency)})`;
}

declare const fromTerms: unique symbol;

// What a payment takes from the company's wallet, which approval limits and the
// two-approver threshold are compared with: the quote's sell amount for a payment
// from another currency's wallet, the invoice amount otherwise. Only
// paymentAmount and runAmount build one, each from approved terms, and
// signoffsNeeded, eligibleApprovers, checkSigner and signoffProblem take nothing
// else, so the compiler refuses a bare amount passed to them. decide.ts is not
// covered: its two-approver check compares incident.sourceAmountMinor, which
// assess takes from the same quote.
export interface PaymentAmount {
  readonly minor: number;
  readonly currency: string;
  readonly [fromTerms]: true;
}

export function paymentAmount(terms: ApprovalTerms): PaymentAmount {
  return {
    minor: terms.fx?.sellAmountMinor ?? terms.amountMinor,
    currency: terms.fx?.sellCurrency ?? terms.currency,
  } as PaymentAmount;
}

// A pay run's largest currency total. A run's rows never pay across currencies,
// so each total is what leaves that currency's wallet. Approver limits are bare
// numbers, so a limit that covers the largest total covers every total.
export function runAmount(terms: RunTerms): PaymentAmount {
  const largest: RunTotal | undefined = terms.totals.reduce(
    (found: RunTotal | undefined, total: RunTotal): RunTotal | undefined =>
      found === undefined || total.amountMinor > found.amountMinor ? total : found,
    undefined,
  );
  return { minor: largest?.amountMinor ?? 0, currency: largest?.currency ?? "" } as PaymentAmount;
}

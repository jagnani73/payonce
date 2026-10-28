import { QUOTE_VALIDITIES, type QuoteValidity } from "./airwallex/fx.js";

const DEFAULT_VALIDITY: QuoteValidity = "HR_1";

const VALIDITY_WORDS: Record<QuoteValidity, string> = {
  MIN_30: "30 minutes",
  HR_1: "1 hour",
  HR_4: "4 hours",
  HR_8: "8 hours",
  HR_24: "24 hours",
};

// How long the exchange rate quote behind an approval request holds, from
// FX_QUOTE_VALIDITY. Read when a quote is taken, as the bank deadlines are. A
// longer quote costs a slightly worse rate and gives a person longer to approve.
// Throws on a value PayOnce does not take, so no quote is taken.
export function quoteValidity(env: NodeJS.ProcessEnv = process.env): QuoteValidity {
  const raw: string = (env["FX_QUOTE_VALIDITY"] ?? "").trim().toUpperCase();
  if (raw === "") {
    return DEFAULT_VALIDITY;
  }
  const validity: QuoteValidity | undefined = QUOTE_VALIDITIES.find(
    (candidate: QuoteValidity): boolean => candidate === raw,
  );
  if (validity === undefined) {
    throw new Error(
      `FX_QUOTE_VALIDITY must be one of ${QUOTE_VALIDITIES.join(", ")}, so PayOnce takes no exchange rate quote`,
    );
  }
  return validity;
}

export function describeQuotes(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const validity: QuoteValidity = quoteValidity(env);
    return `Exchange rate quotes hold for ${VALIDITY_WORDS[validity]} (${validity}), and every payment from another currency's wallet waits for a person to approve its rate`;
  } catch (error: unknown) {
    return `Payments from another currency's wallet are held: ${error instanceof Error ? error.message : String(error)}`;
  }
}

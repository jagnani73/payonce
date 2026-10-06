// Airwallex sends amounts in major units. Only two-decimal currencies are handled here.
const MINOR_UNITS_PER_MAJOR: number = 100;

// Throws on a missing or non-numeric amount. A NaN would pass every "is cash
// below the floor" comparison, so it must not reach the policy.
export function toMinor(amountMajor: number): number {
  if (typeof amountMajor !== "number" || !Number.isFinite(amountMajor)) {
    throw new Error(`Expected an amount, got ${String(amountMajor)}`);
  }
  return Math.round(amountMajor * MINOR_UNITS_PER_MAJOR);
}

export function toMajor(amountMinor: number): number {
  return amountMinor / MINOR_UNITS_PER_MAJOR;
}

export function formatMoney(amountMinor: number, currency: string): string {
  const amount: string = toMajor(amountMinor).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${amount} ${currency}`;
}

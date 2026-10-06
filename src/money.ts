// Airwallex sends amounts in major units. Only two-decimal currencies are handled here.
const MINOR_UNITS_PER_MAJOR: number = 100;

export function toMinor(amountMajor: number): number {
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

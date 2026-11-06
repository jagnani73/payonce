import type { JSX } from "preact";
import type { Money as MoneyView } from "../../types";

// Small formatters Treasury and Reports share. They only shape what the views
// already say: an amount as formatMoney writes it, a rail in the glossary's
// words, a duration in a table.

const MINUS: string = String.fromCharCode(0x2212);
const NBSP: string = String.fromCharCode(0xa0);

// "4,000.00 EUR" from minor units, as formatMoney writes it, for the few answers
// that carry minor units only (the metrics and the movements).
export function amountText(minor: number, currency: string): string {
  const amount: string = (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${minor < 0 ? MINUS : ""}${amount.replace(/^-/, "")} ${currency}`.trim();
}

// The rail as the glossary writes it: "USD local", "EUR SWIFT". It also mends a
// rail inside one of PayOnce's own sentences.
export function railWords(text: string): string {
  return text.replace(/\b([A-Z]{3}) LOCAL\b/g, "$1 local");
}

// A sentence PayOnce wrote without its full stop.
export function sentence(text: string): string {
  const trimmed: string = text.trim();
  return trimmed === "" || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// An amount in a wallet's own column: the figure without its currency, a true
// minus sign when negative, and "≈" when estimated. Null shows as "—".
export function Figure(props: { money: MoneyView | null; empty?: string; class?: string }): JSX.Element {
  const money: MoneyView | null = props.money;
  if (money === null) {
    return <span class={props.class === undefined ? "figure is-empty" : `figure is-empty ${props.class}`}>{props.empty ?? "—"}</span>;
  }
  const suffix: string = ` ${money.currency}`;
  const bare: string = money.currency !== "" && money.text.endsWith(suffix) ? money.text.slice(0, -suffix.length) : money.text;
  const shown: string = money.minor < 0 ? `${MINUS}${bare.replace(/^[-−]/, "")}` : bare;
  const classes: string = ["figure", money.minor < 0 ? "is-negative" : "", props.class ?? ""].filter((name: string): boolean => name !== "").join(" ");
  return (
    <span class={classes}>
      {shown}
      {money.estimated === true ? (
        <span class="money__estimated" title="Estimated from a quote, or a fee PayOnce hasn't read yet">
          {" ≈"}
        </span>
      ) : null}
    </span>
  );
}

// "3 s", "12 min", "2 h 5 min", "3 d 4 h": how long a measured step took.
export function secondsText(seconds: number | null): string {
  if (seconds === null) {
    return "none";
  }
  if (seconds < 60) {
    return `${seconds}${NBSP}s`;
  }
  const minutes: number = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}${NBSP}min`;
  }
  const hours: number = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours}${NBSP}h` : `${hours}${NBSP}h ${minutes % 60}${NBSP}min`;
  }
  const days: number = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}${NBSP}d` : `${days}${NBSP}d ${hours % 24}${NBSP}h`;
}

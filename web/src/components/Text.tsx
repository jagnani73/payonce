import type { JSX } from "preact";
import { cleanBlock, cleanLine } from "../text";
import {
  agoText,
  dayText,
  durationText,
  fullDayText,
  fullText,
  parseDay,
  parseIso,
  relativeText,
  timeText,
  useNow,
} from "../time";
import type { Money as MoneyView, Theirs as TheirsText } from "../types";

// The small pieces every screen writes with: money, times and text PayOnce did
// not write.

// "4,000.00 EUR", in tabular figures, with "≈" when the figure is estimated.
export function Money(props: { money: MoneyView | null | undefined; class?: string }): JSX.Element | null {
  const money: MoneyView | null | undefined = props.money;
  if (money === null || money === undefined) {
    return null;
  }
  return (
    <span class={props.class === undefined ? "money" : `money ${props.class}`}>
      {money.text}
      {money.estimated === true ? (
        <span class="money__estimated" title="Estimated: from a quote, or a fee PayOnce has not read yet">
          {" ≈"}
        </span>
      ) : null}
    </span>
  );
}

type TimeMode = "clock" | "until" | "ago" | "age";

// A time in the glossary's format, in a <time> with the ISO value and the full
// local time. clock: "14:20" / "6 Nov, 14:20". until: "15:25 (in 52 min)".
// ago: "12 min ago". age: "2 h" (how long since). Nothing when at is not a time.
export function Time(props: { at: string | null | undefined; mode?: TimeMode; class?: string }): JSX.Element | null {
  const now: Date = useNow();
  const date: Date | null = parseIso(props.at);
  if (date === null) {
    return null;
  }
  const mode: TimeMode = props.mode ?? "clock";
  const text: string =
    mode === "until"
      ? `${timeText(date, now)} (${relativeText(date, now)})`
      : mode === "ago"
        ? agoText(date, now)
        : mode === "age"
          ? durationText(now.getTime() - date.getTime())
          : timeText(date, now);
  return (
    <time class={props.class} dateTime={date.toISOString()} title={fullText(date)}>
      {text}
    </time>
  );
}

// A day as stored (YYYY-MM-DD): "8 Nov", "8 Nov 2027".
export function Day(props: { day: string | null | undefined; class?: string }): JSX.Element | null {
  const now: Date = useNow();
  const date: Date | null = parseDay(props.day);
  if (date === null || typeof props.day !== "string") {
    return null;
  }
  return (
    <time class={props.class} dateTime={props.day} title={fullDayText(date)}>
      {dayText(date, now)}
    </time>
  );
}

// Text PayOnce did not write: a supplier's or a person's name, a note, an email,
// an Airwallex message, a pay run cell. It is cleaned (see text.ts), isolated
// with <bdi> so its direction cannot reorder PayOnce's words around it, and only
// ever a text node. quote: a note inside PayOnce's sentence, in quotation marks.
// block: several lines (an email body), framed as text from outside.
export function Theirs(props: {
  text: TheirsText | null | undefined;
  quote?: boolean;
  block?: boolean;
  class?: string;
}): JSX.Element {
  const extra: string = props.class === undefined ? "" : ` ${props.class}`;
  if (props.block === true) {
    return (
      <div class={`theirs theirs--block${extra}`} dir="auto">
        {cleanBlock(props.text)}
      </div>
    );
  }
  const text: string = cleanLine(props.text);
  return props.quote === true ? (
    <bdi class={`theirs theirs--quote${extra}`}>{`“${text}”`}</bdi>
  ) : (
    <bdi class={`theirs${extra}`}>{text}</bdi>
  );
}

// An invoice number or a bank reference: headline text, in mono.
export function Ref(props: { children: string; class?: string }): JSX.Element {
  return <span class={props.class === undefined ? "ref" : `ref ${props.class}`}>{props.children}</span>;
}

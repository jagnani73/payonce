import { Fragment, type ComponentChildren, type JSX } from "preact";
import { paymentHref } from "../router";
import { cleanBlock, cleanLine, cleanRun, moneyText } from "../text";
import {
  agoText,
  clockOf,
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
import type { Money as MoneyView, Theirs as TheirsText, Timed, TimedPart } from "../types";

// The small pieces every screen writes with: money, times, text PayOnce did not
// write, and the joins between them.

function Estimated(props: { money: MoneyView }): JSX.Element | null {
  return props.money.estimated === true ? (
    <span class="money__estimated" title="Estimated from a quote, or a fee PayOnce hasn't read yet">
      {" ≈"}
    </span>
  ) : null;
}

// "4,000.00 EUR", in tabular figures, a true minus sign when negative, and "≈"
// when the figure is estimated.
export function Money(props: { money: MoneyView | null | undefined; class?: string }): JSX.Element | null {
  const money: MoneyView | null | undefined = props.money;
  if (money === null || money === undefined) {
    return null;
  }
  return (
    <span class={props.class === undefined ? "money" : `money ${props.class}`}>
      {moneyText(money)}
      <Estimated money={money} />
    </span>
  );
}

// An amount in a wallet's own column or row: the figure without its currency,
// in red when negative. Null shows as "—", or as empty says.
export function Figure(props: { money: MoneyView | null; empty?: string; class?: string }): JSX.Element {
  const money: MoneyView | null = props.money;
  if (money === null) {
    return <span class={props.class === undefined ? "figure is-empty" : `figure is-empty ${props.class}`}>{props.empty ?? "—"}</span>;
  }
  const classes: string = ["figure", money.minor < 0 ? "is-negative" : "", props.class ?? ""].filter((name: string): boolean => name !== "").join(" ");
  return (
    <span class={classes}>
      {moneyText(money, true)}
      <Estimated money={money} />
    </span>
  );
}

type TimeMode = "clock" | "until" | "ago" | "age" | "day";

// A time in the glossary's format, in a <time> with the ISO value and the full
// local time. clock: "14:20" / "6 Nov, 14:20". until: "15:25 (in 52 min)".
// ago: "12 min ago". age: "2 h" (how long since). day: "6 Nov", the day alone.
// Nothing when at is not a time.
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
          : mode === "day"
            ? dayText(date, now)
            : timeText(date, now);
  return (
    <time class={props.class} dateTime={date.toISOString()} title={fullText(date)}>
      {text}
    </time>
  );
}

// A time inside a sentence: "at 14:41" today, "on 6 Nov, 14:41" another day.
export function When(props: { at: string | null | undefined }): JSX.Element | null {
  const now: Date = useNow();
  const date: Date | null = parseIso(props.at);
  if (date === null) {
    return null;
  }
  return (
    <>
      {timeText(date, now) === clockOf(date) ? "at " : "on "}
      <Time at={props.at} />
    </>
  );
}

// A sentence the view gives with its times apart (contract.ts, Timed): its
// words, and each time in the viewer's zone. A deadline or an expiry also says
// how long is left. words renders each run of words, such as with its refs marked.
export function Said(props: { text: Timed | null | undefined; words?: (text: string) => ComponentChildren }): JSX.Element | null {
  if (props.text === null || props.text === undefined) {
    return null;
  }
  const words: (text: string) => ComponentChildren = props.words ?? ((text: string): ComponentChildren => text);
  return (
    <>
      {props.text.map(
        (part: TimedPart, index: number): ComponentChildren =>
          typeof part === "string" ? (
            <Fragment key={index}>{words(part)}</Fragment>
          ) : (
            <Time key={index} at={part.at} mode={part.deadline === true ? "until" : "clock"} />
          ),
      )}
    </>
  );
}

// The words of a sentence with its times as given, to tell two sentences apart.
export function saidKey(text: Timed): string {
  return text.map((part: TimedPart): string => (typeof part === "string" ? part : part.at)).join("");
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

// Parts with a grey " · " between them, leaving out the empty ones.
export function Dotted(props: { parts: ComponentChildren[]; class?: string }): JSX.Element | null {
  const parts: ComponentChildren[] = props.parts.filter(
    (part: ComponentChildren): boolean => part !== null && part !== undefined && part !== false && part !== "",
  );
  if (parts.length === 0) {
    return null;
  }
  return (
    <span class={props.class}>
      {parts.map(
        (part: ComponentChildren, index: number): JSX.Element => (
          <span key={index}>
            {index === 0 ? null : (
              <span class="sep" aria-hidden="true">
                {" · "}
              </span>
            )}
            {part}
          </span>
        ),
      )}
    </span>
  );
}

// An invoice number or a bank reference a sentence names.
export interface Mark {
  invoiceId?: string | null;
  reference?: string | null;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A sentence from the view with its invoice numbers as links and its bank
// references in mono. The sentence is the server's; only the refs are marked.
// It may be one run of a sentence with times (<Said>), so the spaces at its
// ends stay. self: the payment on show, whose number is not linked.
export function WithRefs(props: { text: string; refs: readonly Mark[]; self?: string }): JSX.Element {
  const text: string = cleanRun(props.text);
  const marks: string[] = props.refs
    .map((ref: Mark): string => ref.invoiceId ?? ref.reference ?? "")
    .filter((mark: string): boolean => mark !== "" && text.includes(mark));
  if (marks.length === 0) {
    return <>{text}</>;
  }
  const invoices: Set<string> = new Set<string>(props.refs.map((ref: Mark): string => ref.invoiceId ?? "").filter((id: string): boolean => id !== ""));
  const pattern: RegExp = new RegExp(`(${[...new Set<string>(marks)].sort((a: string, b: string): number => b.length - a.length).map(escaped).join("|")})`);
  return (
    <>
      {text.split(pattern).map((piece: string, index: number): ComponentChildren => {
        if (index % 2 === 0) {
          return piece;
        }
        return invoices.has(piece) && piece !== props.self ? (
          <a key={index} class="ref" href={paymentHref(piece)}>
            {piece}
          </a>
        ) : (
          <Ref key={index}>{piece}</Ref>
        );
      })}
    </>
  );
}

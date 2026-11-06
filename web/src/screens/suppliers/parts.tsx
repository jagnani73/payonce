import type { ComponentChildren, JSX } from "preact";
import { Time } from "../../components/Text";
import { paymentHref } from "../../router";
import { clockOf, parseIso, timeText, useNow } from "../../time";

// Small pieces the supplier screens share.

// A server sentence ends with a full stop on the page, whether or not it came
// with one: some refusals end bare.
export function sentence(text: string): string {
  const trimmed: string = text.trim();
  return trimmed === "" || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// "supplier's website" as a value of its own: "Supplier's website".
export function capital(text: string): string {
  return text === "" ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
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

// Parts with " · " between them, leaving out the empty ones.
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
            {index === 0 ? null : <span class="sep"> · </span>}
            {part}
          </span>
        ),
      )}
    </span>
  );
}

export function InvoiceLink(props: { id: string; tab?: string }): JSX.Element {
  return (
    <a class="ref" href={paymentHref(props.id, props.tab ?? null)}>
      {props.id}
    </a>
  );
}

// Invoice links with commas between them.
export function InvoiceLinks(props: { ids: readonly string[] }): JSX.Element {
  return (
    <>
      {props.ids.map(
        (id: string, index: number): JSX.Element => (
          <span key={`${index}-${id}`}>
            {index === 0 ? null : ", "}
            <InvoiceLink id={id} />
          </span>
        ),
      )}
    </>
  );
}

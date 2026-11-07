import type { ComponentChildren, JSX } from "preact";
import type { PhoneOnFileView } from "../types";
import { Icon } from "./Icon";
import { Callout } from "./Notice";
import { Theirs, Time, When } from "./Text";

// The supplier's phone on file, as the payment page's callback card and the
// supplier record's contact card show it: its last four digits, who put it there
// and when, and a warning when it changed lately. The full number shows only
// when the contact card's "Show number" has fetched it.

function Setter(props: { what: string; name: string | null; source: string | null }): JSX.Element | null {
  if (props.name === null) {
    return null;
  }
  return (
    <>
      {`, ${props.what} by `}
      <Theirs text={props.name} />
      {props.source === null ? null : ` (${props.source})`}
    </>
  );
}

// Where the number came from: "On file since 6 Nov, 14:02, proposed by Priya
// (supplier's contract), confirmed by Tom (supplier's website)."
export function PhoneProvenance(props: { phone: PhoneOnFileView }): JSX.Element {
  const phone: PhoneOnFileView = props.phone;
  // A migrated number's own time is when PayOnce moved it, so it has none.
  if (phone.origin === "migrated") {
    return <p class="contact__line">On file from before PayOnce kept who set it.</p>;
  }
  if (phone.origin === "scenario") {
    return (
      <p class="contact__line">
        {"Put on file by the demo scenario"}
        {phone.since === null ? null : (
          <>
            {" "}
            <When at={phone.since} />
          </>
        )}
        .
      </p>
    );
  }
  return (
    <p class="contact__line">
      {phone.removed ? "Taken off file" : "On file"}
      {phone.since === null ? null : phone.removed ? (
        <>
          {" "}
          <When at={phone.since} />
        </>
      ) : (
        <>
          {" since "}
          <Time at={phone.since} />
        </>
      )}
      <Setter what="proposed" name={phone.proposedBy} source={phone.proposedSource} />
      <Setter what="confirmed" name={phone.confirmedBy} source={phone.confirmedSource} />
      {"."}
      {phone.replacedEnding === null
        ? null
        : phone.removed
          ? ` It was the number ending ${phone.replacedEnding}.`
          : ` It replaced the number ending ${phone.replacedEnding}.`}
    </p>
  );
}

// ending: the last four digits on file, or null with none. label: what the line
// starts with, "Phone" inside a card already titled "Contact on file". full: the
// number itself, once fetched. actions: buttons beside it. children: lines
// under it.
export function PhoneOnFile(props: {
  phone: PhoneOnFileView | null;
  ending: string | null;
  label?: string;
  full?: string | null;
  actions?: ComponentChildren;
  children?: ComponentChildren;
}): JSX.Element {
  const phone: PhoneOnFileView | null = props.phone;
  const full: string | null = props.full ?? null;
  return (
    <div class="contact">
      <div class="contact__row">
        <Icon name="callback" />
        <span class="contact__value">
          {props.ending === null ? (
            "No phone on file"
          ) : (
            <>
              {`${props.label ?? "Phone on file"}: `}
              {full === null ? `ending ${props.ending}` : <Theirs text={full} class="mono" />}
            </>
          )}
        </span>
        {props.actions}
      </div>
      {phone === null ? null : <PhoneProvenance phone={phone} />}
      {/* The server also marks a removal as changed; its words are about a new number. */}
      {phone === null || phone.removed || phone.changed === null ? null : <Callout tone="warning">{phone.changed.text}</Callout>}
      {props.children}
    </div>
  );
}

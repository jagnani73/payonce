import type { JSX } from "preact";
import { Callout } from "../../components/Notice";
import { Theirs, Time } from "../../components/Text";
import { supplierHref } from "../../router";
import type { IncidentPhoneView, PhoneOnFileView } from "../../types";

// The supplier's phone on file as the callback card shows it: its last four
// digits, since when, who proposed and who confirmed it, a warning when it
// changed lately, and a new number waiting for a second person.

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

function OnFile(props: { phone: PhoneOnFileView }): JSX.Element {
  const p: PhoneOnFileView = props.phone;
  return (
    <p class="pay-phone__line">
      {`Number on file: ending ${p.ending}`}
      {p.since === null ? null : (
        <>
          {", on file since "}
          <Time at={p.since} />
        </>
      )}
      {p.origin === "person" ? (
        <>
          <Setter what="proposed" name={p.proposedBy} source={p.proposedSource} />
          <Setter what="confirmed" name={p.confirmedBy} source={p.confirmedSource} />
        </>
      ) : p.originText === "" ? null : (
        `, ${p.originText}`
      )}
    </p>
  );
}

// blocked: the card already says why the callback can't be recorded (no phone,
// or a new number waiting), so only the facts it does not say are added.
export function PhoneOnFile(props: { phone: IncidentPhoneView; supplierKey: string | null; blocked: boolean }): JSX.Element {
  const onFile: PhoneOnFileView | null = props.phone.onFile;
  const pending: IncidentPhoneView["pending"] = props.phone.pending;
  const none: boolean = onFile === null || onFile.removed || onFile.ending === null;
  return (
    <div class="pay-phone">
      {onFile !== null && !none ? (
        <OnFile phone={onFile} />
      ) : props.blocked ? null : (
        <p class="pay-phone__line">No phone number is on file for this supplier.</p>
      )}
      {onFile?.changed === null || onFile?.changed === undefined ? null : <Callout tone="warning">{onFile.changed.text}</Callout>}
      {pending === null ? null : (
        <p class="pay-phone__line pay-warn">
          {`Waiting: a new number${pending.ending === null ? "" : ` ending ${pending.ending}`}`}
          {pending.proposedBy === null ? null : (
            <>
              {", proposed by "}
              <Theirs text={pending.proposedBy} />
              {pending.proposedAt === null ? null : (
                <>
                  {" at "}
                  <Time at={pending.proposedAt} />
                </>
              )}
            </>
          )}
          .
        </p>
      )}
      {props.supplierKey === null || (!none && pending === null) ? null : (
        <a class="pay-phone__link" href={supplierHref(props.supplierKey)}>
          {none && pending === null ? "Put one on file on the supplier record" : "Open the supplier record"}
        </a>
      )}
    </div>
  );
}

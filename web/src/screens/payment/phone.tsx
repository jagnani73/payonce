import type { JSX } from "preact";
import { PhoneOnFile } from "../../components/Phone";
import { Theirs, When } from "../../components/Text";
import { supplierHref } from "../../router";
import type { IncidentPhoneView, PhoneOnFileView } from "../../types";

// The phone a callback would be made on, under the callback card: the number on
// file, a new number waiting for a second person, and a link to the supplier
// record when there is something to do there.

// blocked: the card already says why the callback can't be recorded (no phone,
// or a new number waiting), so a missing number is not said again.
export function CallbackPhone(props: { phone: IncidentPhoneView; supplierKey: string | null; blocked: boolean }): JSX.Element {
  const onFile: PhoneOnFileView | null = props.phone.onFile;
  const pending: IncidentPhoneView["pending"] = props.phone.pending;
  const ending: string | null = onFile === null || onFile.removed ? null : onFile.ending;
  return (
    <div class="pay-phone">
      {ending === null && props.blocked ? null : <PhoneOnFile phone={onFile} ending={ending} />}
      {pending === null ? null : (
        <p class="contact__line pay-warn">
          {`Waiting: a new number${pending.ending === null ? "" : ` ending ${pending.ending}`}`}
          {pending.proposedBy === null ? null : (
            <>
              {", proposed by "}
              <Theirs text={pending.proposedBy} />
              {pending.proposedAt === null ? null : (
                <>
                  {" "}
                  <When at={pending.proposedAt} />
                </>
              )}
            </>
          )}
          .
        </p>
      )}
      {props.supplierKey === null || (ending !== null && pending === null) ? null : (
        <a class="pay-phone__link" href={supplierHref(props.supplierKey)}>
          {ending === null && pending === null ? "Put one on file on the supplier record" : "Open the supplier record"}
        </a>
      )}
    </div>
  );
}

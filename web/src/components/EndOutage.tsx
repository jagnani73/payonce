import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { postJson } from "../api";
import { sameMe, useMe, useNameDraft } from "../me";
import { notify } from "../notices";
import { joinNames } from "../text";
import type { Can, EndOutageInput, EndOutageResult } from "../types";
import { ActionButton } from "./Action";
import { Field, NameField, type ControlProps } from "./Form";

// Ending an outage (ia.md 3.3 and 8.3), from a paused payment, a paused pay run
// or Treasury › Outages: who ends it, from the approver list when there is one
// and any name when there is none, and a note saying why the rail is back.

interface Missing {
  name: string | null;
  note: string | null;
}

const MAX_NOTE: number = 200;

// The enders as a select when there is an approver list, a free name otherwise.
function EnderField(props: { enders: string[] | null; value: string; onInput: (value: string) => void; error: string | null }): JSX.Element {
  const me: string | null = useMe();
  const enders: string[] | null = props.enders;
  if (enders === null) {
    return <NameField label="Ended by" value={props.value} onInput={props.onInput} error={props.error} hint="Anyone can end it while no approver list is set." />;
  }
  return (
    <Field label="Ended by" class="field--name" error={props.error} hint={enders.length === 0 ? undefined : `${joinNames(enders, "or")} can end it.`}>
      {(control: ControlProps): JSX.Element => (
        <select
          {...control}
          class="select"
          value={props.value}
          disabled={enders.length === 0}
          onChange={(event: Event): void => props.onInput((event.currentTarget as HTMLSelectElement).value)}
        >
          {props.value === "" ? <option value="">Choose a name</option> : null}
          {enders.map(
            (ender: string): JSX.Element => (
              <option key={ender} value={ender}>
                {me !== null && sameMe(ender, me) ? `${ender} (you)` : ender}
              </option>
            ),
          )}
        </select>
      )}
    </Field>
  );
}

// row: the fields side by side with the button at the end, as Treasury's cards
// lay them out; otherwise the boxed form under an option card.
export function EndOutageForm(props: {
  outageId: number;
  rail: string;
  enders: string[] | null;
  can?: Can;
  row?: boolean;
  onEnded: (result: EndOutageResult) => void;
  onRefused: () => void;
}): JSX.Element {
  const me: string | null = useMe();
  const [typed, setTyped] = useNameDraft();
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [missing, setMissing] = useState<Missing>({ name: null, note: null });
  const enders: string[] | null = props.enders;
  const listed: string = me === null ? "" : (enders?.find((ender: string): boolean => sameMe(ender, me)) ?? "");
  const endedBy: string = enders === null ? typed : (picked ?? listed);

  async function end(): Promise<void> {
    const problems: Missing = {
      name: endedBy.trim() === "" ? (enders === null ? "Enter your name." : "Choose who is ending it.") : null,
      note: note.trim() === "" ? "Add a note saying why the rail is back." : null,
    };
    setMissing(problems);
    if (problems.name !== null || problems.note !== null) {
      return;
    }
    const body: EndOutageInput = { endedBy: endedBy.trim(), note: note.trim() };
    const result: EndOutageResult = await postJson<EndOutageResult>(`/api/outages/${props.outageId}/end`, body);
    setNote("");
    notify(result.notice);
    props.onEnded(result);
  }

  return (
    <div class={props.row === true ? "form-row" : "option-form"}>
      <EnderField
        enders={enders}
        value={endedBy}
        error={missing.name}
        onInput={(value: string): void => {
          if (enders === null) {
            setTyped(value);
          } else {
            setPicked(value);
          }
          setMissing((now: Missing): Missing => ({ ...now, name: null }));
        }}
      />
      <Field label="Note" error={missing.note} class="form-row__wide">
        {(control: ControlProps): JSX.Element => (
          <input
            {...control}
            class="input"
            type="text"
            maxLength={MAX_NOTE}
            autocomplete="off"
            placeholder={`Airwallex confirmed ${props.rail} is back`}
            value={note}
            onInput={(event: Event): void => {
              setNote((event.currentTarget as HTMLInputElement).value);
              setMissing((now: Missing): Missing => ({ ...now, note: null }));
            }}
          />
        )}
      </Field>
      <ActionButton
        label={`End outage ${props.outageId}`}
        busyLabel="Ending…"
        kind="primary"
        disabled={props.can !== undefined && !props.can.allowed}
        reason={props.can?.why?.text ?? null}
        onAction={end}
        onError={(): void => props.onRefused()}
      />
    </div>
  );
}

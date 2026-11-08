import type { ComponentChildren, JSX } from "preact";
import { useId } from "preact/hooks";
import { sameMe } from "../me";
import type { ApproverChoice } from "../types";

// Form fields. A form keeps its drafts in its own state, so a poll that brings a
// new view never wipes what someone is typing.

export interface ControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": boolean | undefined;
}

// A labelled control with an optional hint and error. The control comes from
// children, which get the ids that tie it to its label, hint and error:
// <Field label="Why are you closing it?">{(control) => <textarea {...control} class="input" />}</Field>
export function Field(props: {
  label: string;
  hint?: ComponentChildren;
  error?: string | null;
  class?: string;
  children: (control: ControlProps) => ComponentChildren;
}): JSX.Element {
  const id: string = useId();
  const hint: string | undefined = props.hint === undefined ? undefined : `${id}-hint`;
  const error: string | undefined = props.error === null || props.error === undefined ? undefined : `${id}-error`;
  const described: string = [hint, error].filter((part: string | undefined): boolean => part !== undefined).join(" ");
  return (
    <div class={props.class === undefined ? "field" : `field ${props.class}`}>
      <label class="field__label" for={id}>
        {props.label}
      </label>
      {props.children({ id, "aria-describedby": described === "" ? undefined : described, "aria-invalid": error === undefined ? undefined : true })}
      {props.hint === undefined ? null : (
        <span class="field__hint" id={hint}>
          {props.hint}
        </span>
      )}
      {error === undefined ? null : (
        <span class="field__error" id={error} role="alert">
          {props.error}
        </span>
      )}
    </div>
  );
}

// A name field ("Closing as", "Uploaded by"), filled from You are and editable.
// Pair it with useNameDraft() from me.ts for its value.
export function NameField(props: {
  label: string;
  value: string;
  onInput: (value: string) => void;
  hint?: ComponentChildren;
  error?: string | null;
}): JSX.Element {
  return (
    <Field label={props.label} hint={props.hint} error={props.error ?? null} class="field--name">
      {(control: ControlProps): JSX.Element => (
        <input
          {...control}
          class="input"
          type="text"
          autocomplete="off"
          spellcheck={false}
          maxLength={80}
          value={props.value}
          onInput={(event: Event): void => props.onInput((event.currentTarget as HTMLInputElement).value)}
        />
      )}
    </Field>
  );
}

// The name to start an approver select on: You are, when that name can approve.
// Otherwise none, so another person is only ever chosen by hand.
export function firstApprover(choices: readonly ApproverChoice[], me: string | null): string {
  return choices.find((choice: ApproverChoice): boolean => me !== null && choice.canApprove && sameMe(choice.name, me))?.name ?? "";
}

// "Approving as": the approvers of one request. A name that cannot approve it is
// listed but disabled. With no name chosen the select says to choose one, and
// when You are is on the list but can't approve, why shows under it.
export function NamePicker(props: {
  label: string;
  choices: readonly ApproverChoice[];
  value: string;
  onChange: (name: string) => void;
  me: string | null;
}): JSX.Element {
  const mine: ApproverChoice | undefined = props.choices.find(
    (choice: ApproverChoice): boolean => props.me !== null && sameMe(choice.name, props.me),
  );
  const hint: string | undefined =
    props.value !== "" || mine === undefined || mine.canApprove ? undefined : mine.signed ? "You have signed this request." : (mine.why?.text ?? undefined);
  return (
    <Field label={props.label} class="field--name" hint={hint}>
      {(control: ControlProps): JSX.Element => (
        <select
          {...control}
          class="select"
          value={props.value}
          onChange={(event: Event): void => props.onChange((event.currentTarget as HTMLSelectElement).value)}
        >
          {props.value === "" ? (
            <option value="" disabled>
              Choose who is approving
            </option>
          ) : null}
          {props.choices.map(
            (choice: ApproverChoice): JSX.Element => (
              <option key={choice.name} value={choice.name} disabled={!choice.canApprove}>
                {`${choice.name}${props.me !== null && sameMe(choice.name, props.me) ? " (you)" : ""} · ${
                  choice.canApprove ? `up to ${choice.limit.text}` : choice.signed ? "signed already" : "can't approve"
                }`}
              </option>
            ),
          )}
        </select>
      )}
    </Field>
  );
}

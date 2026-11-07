import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { postJson } from "../../api";
import { ActionButton, Details } from "../../components/Action";
import { Field, NameField, type ControlProps } from "../../components/Form";
import { Ref } from "../../components/Text";
import { sameMe, useMe, useNameDraft } from "../../me";
import { notify } from "../../notices";
import { joinNames } from "../../text";
import type {
  Acted,
  ClosePaidOption,
  CloseUnpaidOption,
  CoveredTransferView,
  EndOutageOption,
  EndOutageResult,
  IncidentView,
  NamingPayoutView,
} from "../../types";
import type { Acts } from "./parts";

// The chosen option's form, under the cards (ia.md 3.3, item 6). Each keeps
// what is typed in its own state, so a poll never wipes it, and clears it once
// the action is done.

const MAX_NOTE: number = 200;

function NoteField(props: {
  label: string;
  placeholder: string;
  value: string;
  error: string | null;
  onInput: (value: string) => void;
}): JSX.Element {
  return (
    <Field label={props.label} error={props.error} hint={`Up to ${MAX_NOTE} characters.`}>
      {(control: ControlProps): JSX.Element => (
        <textarea
          {...control}
          class="textarea pay-note"
          rows={3}
          maxLength={MAX_NOTE}
          required
          placeholder={props.placeholder}
          value={props.value}
          onInput={(event: Event): void => props.onInput((event.currentTarget as HTMLTextAreaElement).value)}
        />
      )}
    </Field>
  );
}

function Covered(props: { covers: CoveredTransferView[] }): JSX.Element | null {
  if (props.covers.length === 0) {
    return null;
  }
  return (
    <div class="pay-covers">
      <h4 class="pay-covers__title">This close covers</h4>
      <ul class="pay-covers__list">
        {props.covers.map(
          (covered: CoveredTransferView): JSX.Element => (
            <li key={covered.transferId}>
              <span>
                {"Unrecognised transfer "}
                <Ref>{covered.reference}</Ref>
                {`${covered.status === null ? "" : `, ${covered.status}`}, under the ${covered.kind}'s request id`}
              </span>
              <Details rows={[{ label: "Transfer id", value: covered.transferId, copy: true }]} />
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function NamesOnly(props: { payouts: NamingPayoutView[] }): JSX.Element | null {
  if (props.payouts.length === 0) {
    return null;
  }
  return (
    <ul class="pay-form__notes">
      {props.payouts.map(
        (payout: NamingPayoutView): JSX.Element => (
          <li key={payout.reference}>{payout.text}</li>
        ),
      )}
    </ul>
  );
}

export function CloseForm(props: { option: ClosePaidOption | CloseUnpaidOption; acts: Acts }): JSX.Element {
  const paid: boolean = props.option.kind === "close-paid";
  const [note, setNote] = useState<string>("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [name, setName] = useNameDraft();
  const [nameError, setNameError] = useState<string | null>(null);
  return (
    <div class="option-form">
      <NoteField
        label={paid ? "What did you confirm?" : "Why are you closing it?"}
        placeholder={paid ? "Supplier confirmed by phone the payment arrived on 29 Oct" : "The supplier withdrew this invoice"}
        value={note}
        error={noteError}
        onInput={(value: string): void => {
          setNote(value);
          setNoteError(null);
        }}
      />
      <Covered covers={props.option.covers} />
      {props.option.kind === "close-paid" ? <NamesOnly payouts={props.option.namesOnly} /> : null}
      <NameField
        label="Closing as"
        value={name}
        error={nameError}
        onInput={(value: string): void => {
          setName(value);
          setNameError(null);
        }}
      />
      <ActionButton
        kind={paid ? "primary" : "danger"}
        label={props.option.title}
        busyLabel="Closing…"
        disabled={!props.option.can.allowed}
        reason={props.option.can.why?.text ?? null}
        onAction={async (): Promise<void> => {
          const finding: string = note.trim();
          if (finding === "" || name.trim() === "") {
            setNoteError(finding === "" ? (paid ? "Say what you confirmed." : "Say why you are closing it.") : null);
            setNameError(name.trim() === "" ? "Enter your name." : null);
            return;
          }
          const acted: Acted<IncidentView> = await postJson<Acted<IncidentView>>(`${props.acts.path}/close`, {
            closedBy: name.trim(),
            finding,
            covered: props.option.covers.map((covered: CoveredTransferView): string => covered.transferId),
            as: paid ? "paid" : "unpaid",
          });
          setNote("");
          props.acts.done(acted);
        }}
        onError={props.acts.refresh}
      />
    </div>
  );
}

// The enders as a select when there is an approver list, a free name otherwise.
function EnderField(props: { enders: string[] | null; value: string; onInput: (value: string) => void; error: string | null }): JSX.Element {
  const enders: string[] | null = props.enders;
  if (enders === null) {
    return <NameField label="Ended by" value={props.value} onInput={props.onInput} error={props.error} hint="Anyone can end it while no approver list is set." />;
  }
  return (
    <Field label="Ended by" class="field--name" error={props.error} hint={`${joinNames(enders, "or")} can end it.`}>
      {(control: ControlProps): JSX.Element => (
        <select
          {...control}
          class="select"
          value={props.value}
          onChange={(event: Event): void => props.onInput((event.currentTarget as HTMLSelectElement).value)}
        >
          {props.value === "" ? <option value="">Choose a name</option> : null}
          {enders.map(
            (ender: string): JSX.Element => (
              <option key={ender} value={ender}>
                {ender}
              </option>
            ),
          )}
        </select>
      )}
    </Field>
  );
}

export function OutageForm(props: { option: EndOutageOption; acts: Acts }): JSX.Element {
  const o: EndOutageOption = props.option;
  const me: string | null = useMe();
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const fromMe: string = me === null ? "" : (o.enders === null ? me : (o.enders.find((ender: string): boolean => sameMe(ender, me)) ?? ""));
  const name: string = picked ?? fromMe;
  return (
    <div class="option-form">
      <EnderField
        enders={o.enders}
        value={name}
        error={nameError}
        onInput={(value: string): void => {
          setPicked(value);
          setNameError(null);
        }}
      />
      <Field label="Note" error={noteError} hint="Say why the rail is back.">
        {(control: ControlProps): JSX.Element => (
          <input
            {...control}
            class="input"
            type="text"
            maxLength={MAX_NOTE}
            placeholder={`Airwallex confirmed ${o.rail} is back`}
            value={note}
            onInput={(event: Event): void => {
              setNote((event.currentTarget as HTMLInputElement).value);
              setNoteError(null);
            }}
          />
        )}
      </Field>
      <ActionButton
        kind="primary"
        label={`End outage ${o.outageId}`}
        busyLabel="Ending…"
        disabled={!o.can.allowed}
        reason={o.can.why?.text ?? null}
        onAction={async (): Promise<void> => {
          if (note.trim() === "" || name.trim() === "") {
            setNoteError(note.trim() === "" ? "Add a note saying why the rail is back." : null);
            setNameError(name.trim() === "" ? "Choose who is ending it." : null);
            return;
          }
          const ended: EndOutageResult = await postJson<EndOutageResult>(`/api/outages/${o.outageId}/end`, {
            endedBy: name.trim(),
            note: note.trim(),
          });
          setNote("");
          notify(ended.notice);
          props.acts.refresh();
        }}
        onError={props.acts.refresh}
      />
    </div>
  );
}

export function TraceForm(props: { acts: Acts; allowed: boolean; why: string | null }): JSX.Element {
  const [name, setName] = useNameDraft();
  const [nameError, setNameError] = useState<string | null>(null);
  return (
    <div class="option-form">
      <NameField
        label="Drafting as"
        value={name}
        error={nameError}
        onInput={(value: string): void => {
          setName(value);
          setNameError(null);
        }}
      />
      <ActionButton
        kind="primary"
        label="Draft trace request"
        busyLabel="Drafting…"
        disabled={!props.allowed}
        reason={props.why}
        onAction={async (): Promise<void> => {
          if (name.trim() === "") {
            setNameError("Enter your name.");
            return;
          }
          const acted: Acted<IncidentView> & { draftId: number } = await postJson<Acted<IncidentView> & { draftId: number }>(
            `${props.acts.path}/outbox`,
            { template: "bank-trace", createdBy: name.trim() },
          );
          props.acts.done(acted);
          props.acts.openDraft(acted.draftId);
        }}
        onError={props.acts.refresh}
      />
    </div>
  );
}

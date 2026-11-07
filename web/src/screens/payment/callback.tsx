import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { asApiError, getJson, postJson } from "../../api";
import { ActionButton } from "../../components/Action";
import { Field, NameField, type ControlProps } from "../../components/Form";
import { Callout } from "../../components/Notice";
import { Theirs, Time } from "../../components/Text";
import { useNameDraft } from "../../me";
import type { Acted, BankDetailsForm, CallbackOption, IncidentView } from "../../types";
import type { Acts } from "./parts";

// Record a callback (ia.md 3.3, item 6): the number on file, when the call was,
// who confirmed what, and every bank field the supplier's record has, typed as
// the supplier read it out. Opening the form reads the record in Airwallex, so
// it shows what the record holds now.

type Load = { state: "loading" } | { state: "failed"; error: string } | { state: "ready"; form: BankDetailsForm };

interface Draft {
  numberCalled: string;
  calledAt: string;
  spokeTo: string;
  confirmed: string;
  details: Record<string, string>;
}

const two = (n: number): string => String(n).padStart(2, "0");

// A datetime-local value in the browser's time zone.
function localValue(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

// The call cannot be before the payment it is compared with, so the time starts
// at the later of now and when Airwallex created that payment.
function startDraft(form: BankDetailsForm | null): Draft {
  const sent: number = form?.comparedSentAt === null || form?.comparedSentAt === undefined ? Number.NaN : Date.parse(form.comparedSentAt);
  const at: Date = new Date(Number.isFinite(sent) ? Math.max(Date.now(), sent) : Date.now());
  return { numberCalled: "", calledAt: localValue(at), spokeTo: "", confirmed: "", details: {} };
}

function TextField(props: {
  label: string;
  value: string;
  onInput: (value: string) => void;
  hint?: JSX.Element | string;
  type?: string;
  maxLength: number;
  placeholder?: string;
  error?: string | null;
}): JSX.Element {
  return (
    <Field label={props.label} hint={props.hint} error={props.error ?? null}>
      {(control: ControlProps): JSX.Element => (
        <input
          {...control}
          class="input"
          type={props.type ?? "text"}
          autocomplete="off"
          spellcheck={false}
          maxLength={props.maxLength}
          placeholder={props.placeholder}
          value={props.value}
          onInput={(event: Event): void => props.onInput((event.currentTarget as HTMLInputElement).value)}
        />
      )}
    </Field>
  );
}

function Form(props: { form: BankDetailsForm; acts: Acts }): JSX.Element {
  const form: BankDetailsForm = props.form;
  const [draft, setDraft] = useState<Draft>((): Draft => startDraft(form));
  const [name, setName] = useNameDraft();
  const [problem, setProblem] = useState<string | null>(null);
  const set = (field: keyof Omit<Draft, "details">) => (value: string): void => {
    setDraft((now: Draft): Draft => ({ ...now, [field]: value }));
    setProblem(null);
  };
  const setDetail = (field: string) => (value: string): void => {
    setDraft((now: Draft): Draft => ({ ...now, details: { ...now.details, [field]: value } }));
    setProblem(null);
  };
  const sent: Date | null = form.comparedSentAt === null ? null : new Date(form.comparedSentAt);
  return (
    <div class="option-form">
      <p class="pay-form__intro">Call the number on file, never one from an email. A callback is the only way new bank details enter PayOnce.</p>
      <div class="pay-form__grid">
        <TextField
          label="Number you called"
          type="tel"
          maxLength={40}
          value={draft.numberCalled}
          onInput={set("numberCalled")}
          placeholder={form.phoneOnFile ?? undefined}
          hint={
            form.phoneOnFile === null ? undefined : (
              <>
                {"On file: "}
                <Theirs text={form.phoneOnFile} class="mono" />
                {". The number you type must match it."}
              </>
            )
          }
        />
        <Field
          label="When you called"
          hint={
            sent === null ? undefined : (
              <>
                {"Not before "}
                <Time at={form.comparedSentAt} />
                {", when the transfer it is checked against was sent."}
              </>
            )
          }
        >
          {(control: ControlProps): JSX.Element => (
            <input
              {...control}
              class="input"
              type="datetime-local"
              min={sent === null ? undefined : localValue(sent)}
              value={draft.calledAt}
              onInput={(event: Event): void => set("calledAt")((event.currentTarget as HTMLInputElement).value)}
            />
          )}
        </Field>
        <TextField label="Who you spoke to" maxLength={80} value={draft.spokeTo} onInput={set("spokeTo")} />
        <TextField
          label="What they confirmed"
          maxLength={200}
          value={draft.confirmed}
          onInput={set("confirmed")}
          placeholder="Account moved to a new bank, read back to them"
        />
      </div>
      <div class="pay-bank" role="group" aria-label="New bank details">
        <p class="pay-bank__intro">Type every field as the supplier confirmed it on the call, including any that did not change.</p>
        <div class="pay-bank__head" aria-hidden="true">
          <span>Bank field</span>
          <span>Now in Airwallex</span>
          <span>New value</span>
        </div>
        {form.fields.map(
          (field: BankDetailsForm["fields"][number]): JSX.Element => (
            <div class="pay-bank__row" key={field.name}>
              <label class="pay-bank__label" for={`bank-${field.name}`}>
                {field.label}
              </label>
              <span class="pay-bank__now">
                <span class="pay-bank__now-label">Now: </span>
                {field.current === "" ? "nothing" : <Theirs text={field.current} />}
              </span>
              <input
                id={`bank-${field.name}`}
                class="input"
                type="text"
                autocomplete="off"
                spellcheck={false}
                maxLength={70}
                placeholder="New value"
                value={draft.details[field.name] ?? ""}
                onInput={(event: Event): void => setDetail(field.name)((event.currentTarget as HTMLInputElement).value)}
              />
            </div>
          ),
        )}
      </div>
      <NameField label="Recording as" value={name} onInput={setName} />
      {problem === null ? null : (
        <p class="field__error" role="alert">
          {problem}
        </p>
      )}
      <ActionButton
        kind="primary"
        label="Record callback"
        busyLabel="Recording…"
        onAction={async (): Promise<void> => {
          const calledAt: number = Date.parse(draft.calledAt);
          const missing: string | null =
            draft.numberCalled.trim() === ""
              ? "Enter the number you called."
              : !Number.isFinite(calledAt)
                ? "Enter when you called."
                : draft.spokeTo.trim() === ""
                  ? "Enter who you spoke to."
                  : draft.confirmed.trim() === ""
                    ? "Enter what they confirmed."
                    : form.fields.some((field: BankDetailsForm["fields"][number]): boolean => (draft.details[field.name] ?? "").trim() === "")
                      ? "Type every bank field as the supplier confirmed it."
                      : name.trim() === ""
                        ? "Enter your name."
                        : null;
          if (missing !== null) {
            setProblem(missing);
            return;
          }
          const acted: Acted<IncidentView> = await postJson<Acted<IncidentView>>(`${props.acts.path}/bank-change`, {
            calledBy: name.trim(),
            numberCalled: draft.numberCalled.trim(),
            calledAt: new Date(calledAt).toISOString(),
            spokeTo: draft.spokeTo.trim(),
            confirmed: draft.confirmed.trim(),
            details: Object.fromEntries(
              form.fields.map((field: BankDetailsForm["fields"][number]): [string, string] => [field.name, (draft.details[field.name] ?? "").trim()]),
            ),
          });
          setDraft(startDraft(form));
          props.acts.done(acted);
        }}
        onError={props.acts.refresh}
      />
      <p class="pay-form__note">
        Recording the callback updates the supplier's record in Airwallex. Two approvers other than you then approve the payment to the new account.
      </p>
    </div>
  );
}

export function CallbackForm(props: { option: CallbackOption; acts: Acts }): JSX.Element {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState<number>(0);
  useEffect((): (() => void) => {
    let gone: boolean = false;
    setLoad({ state: "loading" });
    getJson<BankDetailsForm>(props.option.formPath)
      .then((form: BankDetailsForm): void => {
        if (!gone) {
          setLoad({ state: "ready", form });
        }
      })
      .catch((error: unknown): void => {
        if (!gone) {
          setLoad({ state: "failed", error: asApiError(error).message });
        }
      });
    return (): void => {
      gone = true;
    };
  }, [props.option.formPath, attempt]);

  if (load.state === "loading") {
    return (
      <div class="option-form">
        <p class="muted" role="status">
          Reading the supplier's bank details in Airwallex…
        </p>
      </div>
    );
  }
  if (load.state === "failed") {
    return (
      <div class="option-form">
        <p class="inline-error" role="alert">{`Couldn't read the bank details on file. ${load.error}`}</p>
        <div>
          <button type="button" class="btn btn--secondary" onClick={(): void => setAttempt(attempt + 1)}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (load.form.blocked !== null) {
    return (
      <div class="option-form">
        <Callout tone="warning">{load.form.blocked}</Callout>
      </div>
    );
  }
  if (load.form.fields.length === 0) {
    return (
      <div class="option-form">
        <Callout tone="warning">The supplier's record in Airwallex has no bank details PayOnce can change.</Callout>
      </div>
    );
  }
  return <Form form={load.form} acts={props.acts} />;
}

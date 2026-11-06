import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { getJson, query, asApiError } from "../api";
import { Field, type ControlProps } from "../components/Form";
import { Icon } from "../components/Icon";
import { InlineError } from "../components/Notice";
import { useDismiss } from "../hooks";
import { sameMe, setMe, useMe } from "../me";
import { useSettings } from "../settings";
import { timeZone } from "../time";
import type { SettingsView } from "../types";

// "You are" (ia.md section 0.3): who this browser acts as. The approvers are
// listed with their limits; anyone else types a name, which the server checks by
// its own name rule before the page keeps it.

// A colon is in no name PayOnce takes, so no approver can be called this.
const OTHER: string = ":other";

type Approver = SettingsView["approvals"]["approvers"][number];

function Picker(props: { onDone: () => void }): JSX.Element {
  const me: string | null = useMe();
  const settings: SettingsView | null = useSettings();
  const approvers: Approver[] = settings?.approvals.approvers ?? [];
  const listed: Approver | undefined = me === null ? undefined : approvers.find((approver: Approver): boolean => sameMe(approver.name, me));
  const [choice, setChoice] = useState<string>(listed?.name ?? (me === null ? "" : OTHER));
  const [typed, setTyped] = useState<string>(listed === undefined ? (me ?? "") : "");
  const [checking, setChecking] = useState<boolean>(false);
  const [problem, setProblem] = useState<string | null>(null);

  function pick(value: string): void {
    setChoice(value);
    setProblem(null);
    if (value === "") {
      setMe(null);
    } else if (value !== OTHER) {
      setMe(value);
      props.onDone();
    }
  }

  // The server's own name rule decides: Home answers 400 for a name it refuses.
  async function keepTyped(event: Event): Promise<void> {
    event.preventDefault();
    setChecking(true);
    setProblem(null);
    try {
      await getJson(query("/api/home", { me: typed }));
      setMe(typed);
      props.onDone();
    } catch (error: unknown) {
      setProblem(asApiError(error).message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div class="me-picker">
      <Field label="You are">
        {(control: ControlProps): JSX.Element => (
          <select {...control} class="select" value={choice} onChange={(event: Event): void => pick((event.currentTarget as HTMLSelectElement).value)}>
            <option value="">Choose a name</option>
            {approvers.map(
              (approver: Approver): JSX.Element => (
                <option key={approver.name} value={approver.name}>
                  {`${approver.name} · up to ${approver.limit.text}`}
                </option>
              ),
            )}
            <option value={OTHER}>Someone else…</option>
          </select>
        )}
      </Field>
      {choice === OTHER ? (
        <form class="me-picker__other" onSubmit={(event: Event): void => void keepTyped(event)}>
          <Field label="Your name" hint="Letters, digits, spaces, dots, hyphens, apostrophes and underscores">
            {(control: ControlProps): JSX.Element => (
              <input
                {...control}
                class="input"
                type="text"
                autocomplete="name"
                maxLength={80}
                value={typed}
                onInput={(event: Event): void => setTyped((event.currentTarget as HTMLInputElement).value)}
              />
            )}
          </Field>
          <span class="action">
            <button type="submit" class="btn btn--primary" disabled={checking || typed.trim() === ""}>
              {checking ? "Checking…" : "Use this name"}
            </button>
            <InlineError message={problem} />
          </span>
        </form>
      ) : null}
      <p class="me-picker__note">
        PayOnce has no login. It runs on this computer only, and the name you choose is recorded on everything you do here.
        Approvals are checked against the approver list, its limits and who is barred.
      </p>
      <p class="me-picker__note muted">Times are in your time zone ({timeZone()}).</p>
    </div>
  );
}

// inline: in the phone menu sheet the picker opens in place, not as a popover.
export function MePicker(props: { inline?: boolean }): JSX.Element {
  const me: string | null = useMe();
  const [open, setOpen] = useState<boolean>(false);
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(open && props.inline !== true, (): void => setOpen(false), pop, button);
  return (
    <div class={props.inline === true ? "me me--inline" : "popover-anchor me"}>
      <button
        ref={button}
        type="button"
        class="btn btn--secondary me__button"
        aria-expanded={open}
        aria-controls="me-pop"
        onClick={(): void => setOpen(!open)}
      >
        <Icon name="user" />
        <span>{me === null ? "You are: choose" : `You are: ${me}`}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open ? (
        <div ref={pop} id="me-pop" class={props.inline === true ? "me__sheet" : "popover"} role="dialog" aria-label="You are">
          <Picker onDone={(): void => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

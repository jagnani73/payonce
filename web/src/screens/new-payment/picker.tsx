import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { query } from "../../api";
import { Icon } from "../../components/Icon";
import { Callout } from "../../components/Notice";
import { Loading } from "../../components/States";
import { Theirs, Time } from "../../components/Text";
import { usePoll, type Polled } from "../../poll";
import { cleanLine } from "../../text";
import type { BeneficiaryOption, BeneficiaryPickerView, TransferMethod } from "../../types";

// The New payment form's supplier field: the Airwallex beneficiaries, searched
// on the server (GET /api/beneficiaries?q=), as radio cards. The one picked
// stays on screen while another search runs or leaves it out. Once one is
// picked the list folds to it, so the rest of the form follows on a phone,
// until the person searches again or asks for the whole list.

const SEARCH_MS: number = 250;
// The list changes only in the Airwallex web app, and the server keeps it a
// minute, so the page reads it again at that pace.
const LIST_MS: number = 60_000;
const SHOWN: number = 20;

const METHOD_WORDS: Record<TransferMethod, string> = { LOCAL: "Local", SWIFT: "SWIFT" };

// "US · USD · Local, SWIFT · ···6789 · nickname “Example LLC”"
function factsOf(option: BeneficiaryOption): string {
  const parts: string[] = [
    cleanLine(option.country),
    cleanLine(option.currency),
    option.methods.map((method: TransferMethod): string => METHOD_WORDS[method]).join(", "),
    option.account === null ? "" : option.account.ending !== null ? `···${option.account.ending}` : cleanLine(option.account.label),
    option.nickname === null || cleanLine(option.nickname) === "" ? "" : `nickname “${cleanLine(option.nickname)}”`,
  ];
  return parts.filter((part: string): boolean => part !== "").join(" · ");
}

// "Last paid 2 Nov to ···6789, P2611…".
function LastPaid(props: { option: BeneficiaryOption }): JSX.Element {
  const paid: BeneficiaryOption["lastPaid"] = props.option.lastPaid;
  if (paid === null) {
    return <span class="np-option__paid">Never paid by PayOnce</span>;
  }
  return (
    <span class="np-option__paid">
      {"Last paid "}
      {paid.at === null ? null : <Time at={paid.at} mode="day" />}
      {paid.ending === null ? null : ` to ···${paid.ending}`}
      {paid.reference === null ? null : (
        <>
          {paid.at === null && paid.ending === null ? "by PayOnce: " : ", "}
          <span class="mono">{cleanLine(paid.reference)}</span>
        </>
      )}
    </span>
  );
}

function OptionCard(props: { option: BeneficiaryOption; picked: boolean; onPick: (option: BeneficiaryOption) => void }): JSX.Element {
  const option: BeneficiaryOption = props.option;
  return (
    <label class={props.picked ? "np-option is-picked" : "np-option"}>
      <input
        type="radio"
        name="np-beneficiary"
        class="np-option__radio"
        value={option.key}
        checked={props.picked}
        onChange={(): void => props.onPick(option)}
      />
      <span class="np-option__body">
        <Theirs text={option.name} class="np-option__name" />
        <span class="np-option__facts">{factsOf(option)}</span>
        <LastPaid option={option} />
        {option.cautions.map(
          (caution: string): JSX.Element => (
            <span class="np-option__caution" key={caution}>
              <Icon name="warning" size={14} />
              {cleanLine(caution)}
            </span>
          ),
        )}
      </span>
    </label>
  );
}

function countLine(view: BeneficiaryPickerView): string {
  const n: number = view.options.length;
  if (view.q !== "") {
    const q: string = cleanLine(view.q);
    return n === 0
      ? ""
      : n === SHOWN
        ? `The first ${SHOWN} beneficiaries that match “${q}”`
        : `${n} ${n === 1 ? "beneficiary matches" : "beneficiaries match"} “${q}”`;
  }
  return n === SHOWN
    ? `The first ${SHOWN} beneficiaries in this Airwallex account. Search to find others.`
    : `${n} ${n === 1 ? "beneficiary" : "beneficiaries"} in this Airwallex account`;
}

export function BeneficiaryPicker(props: {
  picked: BeneficiaryOption | null;
  onPick: (option: BeneficiaryOption) => void;
  error: string | null;
  inputId: string;
  describedBy: string | undefined;
}): JSX.Element {
  const [typed, setTyped] = useState<string>("");
  const [q, setQ] = useState<string>("");
  // The list shows every match while nothing is picked, and after a pick only
  // once the person searches or opens it again.
  const [browsing, setBrowsing] = useState<boolean>(false);
  useEffect((): (() => void) => {
    const timer: number = window.setTimeout((): void => setQ(typed.trim()), SEARCH_MS);
    return (): void => window.clearTimeout(timer);
  }, [typed]);
  // keep: the last list stays on screen while a search runs.
  const list: Polled<BeneficiaryPickerView> = usePoll<BeneficiaryPickerView>(query("/api/beneficiaries", { q }), (): number => LIST_MS, { keep: true });
  const view: BeneficiaryPickerView | null = list.data;
  const options: BeneficiaryOption[] = view?.options ?? [];
  const picked: BeneficiaryOption | null = props.picked;
  const folded: boolean = picked !== null && !browsing;
  const pickedShown: boolean = !folded && picked !== null && options.some((option: BeneficiaryOption): boolean => option.key === picked.key);
  const pick = (option: BeneficiaryOption): void => {
    setBrowsing(false);
    props.onPick(option);
  };

  return (
    <div class="np-picker">
      <div class="search-field">
        <Icon name="search" />
        <input
          id={props.inputId}
          class="input"
          type="search"
          autocomplete="off"
          spellcheck={false}
          maxLength={100}
          placeholder="Search by name, nickname or account ending"
          aria-describedby={props.describedBy}
          aria-invalid={props.error === null ? undefined : true}
          value={typed}
          onInput={(event: Event): void => {
            setTyped((event.currentTarget as HTMLInputElement).value);
            setBrowsing(true);
          }}
        />
      </div>
      {folded && picked !== null ? (
        <div class="np-options" role="radiogroup" aria-label="Airwallex beneficiaries">
          <OptionCard option={picked} picked onPick={pick} />
          <button type="button" class="btn btn--secondary np-picker__more" onClick={(): void => setBrowsing(true)}>
            Choose another beneficiary
          </button>
        </div>
      ) : view === null ? (
        list.error === null ? (
          <Loading rows={2} label="Loading beneficiaries" />
        ) : (
          <Callout tone="danger">
            <p>{`Couldn't read beneficiaries: ${list.error.message}`}</p>
          </Callout>
        )
      ) : view.problem !== null ? (
        <Callout tone="danger">
          <div class="np-problem">
            <p>
              <strong>{view.problem.text}</strong>
              {view.readAt === null ? null : (
                <span class="np-problem__when">
                  {" Last tried "}
                  <Time at={view.readAt} />.
                </span>
              )}
            </p>
            <button type="button" class="btn" onClick={(): void => list.refresh()}>
              <Icon name="refresh" />
              Try again
            </button>
          </div>
        </Callout>
      ) : (
        <>
          <p class="np-picker__count" aria-live="polite">
            {countLine(view)}
          </p>
          {options.length === 0 ? (
            <p class="np-picker__none">
              {view.q === ""
                ? "No beneficiaries in this Airwallex account. Add one in the Airwallex web app, then search again."
                : "No beneficiary matches that search. Add one in the Airwallex web app, then search again."}
            </p>
          ) : null}
        </>
      )}
      {!folded && (picked !== null || options.length > 0) ? (
        <div class="np-options" role="radiogroup" aria-label="Airwallex beneficiaries" aria-busy={view !== null && view.q !== q}>
          {picked !== null && !pickedShown ? <OptionCard option={picked} picked onPick={pick} /> : null}
          {options.map(
            (option: BeneficiaryOption): JSX.Element => (
              <OptionCard key={option.key} option={option} picked={picked?.key === option.key} onPick={pick} />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

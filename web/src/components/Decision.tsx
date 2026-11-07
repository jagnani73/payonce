import type { ComponentChildren, JSX } from "preact";
import { useId, useState } from "preact/hooks";
import { sameMe, useMe } from "../me";
import type { ApproverChoice, Barred, Can, RequestView } from "../types";
import { ActionButton } from "./Action";
import { firstApprover, NamePicker } from "./Form";
import { Dotted, Theirs, Time, When } from "./Text";

// The parts of a Decision panel the payment page and a waiting pay run share
// (ia.md 3.3 and section 6): the card with its heading and request line, who has
// signed and who can, the options as radio cards, and the approve form.

// What both kinds of request show: a payment's and a pay run's.
export type Signable = Pick<RequestView, "id" | "state" | "label" | "expiresAt" | "needed" | "neededWhy" | "signoffs" | "approvers" | "barred">;

// What an option card shows: a payment's or a pay run's option.
export interface Choosable {
  kind: string;
  title: string;
  consequence: string[];
  can: Can;
  suggested: boolean;
}

// The accent card, its "Decision" heading and what sits beside it.
export function DecisionCard(props: { aside?: ComponentChildren; id?: string; children: ComponentChildren }): JSX.Element {
  const heading: string = useId();
  return (
    <section class="card card--accent decision" id={props.id} aria-labelledby={heading} tabIndex={props.id === undefined ? undefined : -1}>
      <div class="decision__head">
        <h2 class="decision__title" id={heading}>
          Decision
        </h2>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

// "Request #11 · open until 15:25 (in 52 min)", "Run request #4 expired at
// 14:20.", or the request's state. none: what to say with no request.
export function RequestLine(props: { request: Signable | null; noun: string; none?: string }): JSX.Element | null {
  const r: Signable | null = props.request;
  if (r === null) {
    return props.none === undefined ? null : <span class="decision__request">{props.none}</span>;
  }
  const head: string = `${props.noun} #${r.id}`;
  if ((r.state === "waiting" || r.state === "approved") && r.expiresAt !== null) {
    return (
      <span class="decision__request">
        {`${head} · ${r.state === "approved" ? "approved, usable until" : "open until"} `}
        <Time at={r.expiresAt} mode="until" />
      </span>
    );
  }
  if (r.state === "expired") {
    return (
      <span class="decision__request decision__request--warn">
        {`${head} expired`}
        {r.expiresAt === null ? null : (
          <>
            {" "}
            <When at={r.expiresAt} />
          </>
        )}
        .
      </span>
    );
  }
  return <span class="decision__request">{`${head} · ${r.label}`}</span>;
}

function Name(props: { name: string; me: string | null }): JSX.Element {
  return props.me !== null && sameMe(props.name, props.me) ? (
    <strong class="signers__me">
      <Theirs text={props.name} />
    </strong>
  ) : (
    <Theirs text={props.name} />
  );
}

function cannot(choice: ApproverChoice): string {
  return choice.why?.code === "over-limit" ? `limit ${choice.limit.text}` : (choice.why?.text ?? "can't approve");
}

// "0 of 1 signoffs" or "1 of 2: approved by Alex at 14:02", then, while the
// request waits, who can approve it and who can't, the You are name in bold.
// explain: say why it needs two signoffs, when the terms don't already.
export function Signers(props: { request: Signable; explain?: boolean }): JSX.Element {
  const me: string | null = useMe();
  const r: Signable = props.request;
  const waiting: boolean = r.state === "waiting";
  const can: ApproverChoice[] = r.approvers.filter((choice: ApproverChoice): boolean => choice.canApprove);
  const isBarred = (name: string): boolean => r.barred.some((entry: Barred): boolean => sameMe(entry.name, name));
  const cant: ApproverChoice[] = r.approvers.filter((choice: ApproverChoice): boolean => !choice.canApprove && !choice.signed && !isBarred(choice.name));
  return (
    <div class="signers">
      <div class="signers__group signers__group--first">
        <span class="signers__label">Signoffs</span>
        <span class="signers__value">
          {r.signoffs.length === 0 ? (
            `0 of ${r.needed} signoffs`
          ) : (
            <>
              {`${r.signoffs.length} of ${r.needed}: approved by `}
              {r.signoffs.map(
                (signoff: Signable["signoffs"][number], index: number): JSX.Element => (
                  <span key={`${signoff.name}-${signoff.at}`}>
                    {index === 0 ? null : index === r.signoffs.length - 1 ? " and " : ", "}
                    <Name name={signoff.name} me={me} /> <When at={signoff.at} />
                  </span>
                ),
              )}
            </>
          )}
        </span>
        {props.explain === true && r.needed > 1 && r.neededWhy !== null ? (
          <span class="signers__why">{`Needs two signoffs because ${r.neededWhy.text}.`}</span>
        ) : null}
      </div>
      {waiting ? (
        <div class="signers__group">
          <span class="signers__label">Can approve</span>
          <span>
            {can.length === 0 ? (
              "Nobody left who can approve"
            ) : (
              <Dotted
                parts={can.map(
                  (choice: ApproverChoice): JSX.Element => (
                    <>
                      <Name name={choice.name} me={me} />
                      {` (up to ${choice.limit.text})`}
                    </>
                  ),
                )}
              />
            )}
          </span>
        </div>
      ) : null}
      {!waiting || (r.barred.length === 0 && cant.length === 0) ? null : (
        <div class="signers__group">
          <span class="signers__label">Can't approve</span>
          <span class="signers__off">
            <Dotted
              parts={[
                ...r.barred.map(
                  (entry: Barred): JSX.Element => (
                    <>
                      <Name name={entry.name} me={me} />
                      {`: ${entry.why.text}`}
                    </>
                  ),
                ),
                ...cant.map(
                  (choice: ApproverChoice): JSX.Element => (
                    <>
                      <Name name={choice.name} me={me} />
                      {`: ${cannot(choice)}`}
                    </>
                  ),
                ),
              ]}
            />
          </span>
        </div>
      )}
    </div>
  );
}

// "Choose what to do": the options, one radio card each.
export function Options(props: { children: ComponentChildren }): JSX.Element {
  return (
    <fieldset class="options">
      <legend class="options__legend">Choose what to do</legend>
      {props.children}
    </fieldset>
  );
}

// One option as a radio card: its title, what confirming it does and, when it
// is off, why. children: what the card shows under it, such as the phone a
// callback would be made on.
export function OptionCard(props: { option: Choosable; name: string; chosen: boolean; onPick: () => void; children?: ComponentChildren }): JSX.Element {
  const o: Choosable = props.option;
  const off: boolean = !o.can.allowed;
  const classes: string = ["option", props.chosen ? "is-on" : "", off ? "is-off" : ""].filter((name: string): boolean => name !== "").join(" ");
  return (
    <div class={classes}>
      <label class="option__pick">
        <input type="radio" class="option__radio" name={props.name} value={o.kind} checked={props.chosen} disabled={off} onChange={props.onPick} />
        <span class="option__body">
          <span class="option__title">
            {o.title}
            {o.suggested && !off ? <span class="pill pill--accent">Suggested</span> : null}
          </span>
          {o.consequence.map(
            (line: string): JSX.Element => (
              <span class="option__line" key={line}>
                {line}
              </span>
            ),
          )}
          {off && o.can.why !== null ? <span class="option__why">{o.can.why.text}</span> : null}
        </span>
      </label>
      {props.children === undefined || props.children === null ? null : <div class="option__more">{props.children}</div>}
    </div>
  );
}

// "Approving as", from the request's approvers, and Approve. After a signoff
// the picker moves on to the next who can approve. empty: the button's label
// before a name is chosen.
export function ApproveForm(props: {
  approvers: ApproverChoice[];
  can: Can;
  empty: string;
  onApprove: (approver: string) => Promise<void>;
  onRefused: () => void;
}): JSX.Element {
  const me: string | null = useMe();
  const [picked, setPicked] = useState<string | null>(null);
  const choices: ApproverChoice[] = props.approvers;
  const name: string = picked !== null && choices.some((choice: ApproverChoice): boolean => choice.name === picked) ? picked : firstApprover(choices, me);
  const choice: ApproverChoice | undefined = choices.find((item: ApproverChoice): boolean => item.name === name);
  return (
    <div class="option-form">
      {choices.length === 0 ? (
        <p class="muted">No approver list is set, so nobody can approve this.</p>
      ) : (
        <NamePicker label="Approving as" choices={choices} value={name} onChange={setPicked} me={me} />
      )}
      <div>
        <ActionButton
          kind="primary"
          label={name === "" ? props.empty : `Approve as ${name}`}
          busyLabel="Approving…"
          disabled={!props.can.allowed || choice?.canApprove !== true}
          reason={props.can.allowed ? null : (props.can.why?.text ?? null)}
          onAction={async (): Promise<void> => {
            await props.onApprove(name);
            setPicked(null);
          }}
          onError={(): void => props.onRefused()}
        />
      </div>
    </div>
  );
}

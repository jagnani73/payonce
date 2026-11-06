import type { JSX } from "preact";
import { useEffect, useId, useState } from "preact/hooks";
import { Callout } from "../../components/Notice";
import { Money, Said, Theirs, Time } from "../../components/Text";
import { useMe } from "../../me";
import type { Caution, DecisionOption, DecisionPanel, HeadroomLine, IncidentPhoneView, IncidentView, RequestView } from "../../types";
import { CallbackForm } from "./callback";
import { ApproveForm, CloseForm, OutageForm, TraceForm } from "./forms";
import { sentence, type Acts } from "./parts";
import { PhoneOnFile } from "./phone";
import { Signers, Terms } from "./terms";

// The Decision panel (ia.md 3.3): the one place to act on a payment. The request
// and what an approval covers, the cautions, who has signed, then every option
// the view gives as one choice, each with what it does, and the chosen one's
// form. An option the view does not allow stays on show, off, with its reason.

type Kind = DecisionOption["kind"];

const KINDS: readonly Kind[] = ["approve", "callback", "close-paid", "close-unpaid", "end-outage", "trace"];

export function isKind(value: string | null): value is Kind {
  return value !== null && (KINDS as readonly string[]).includes(value);
}

function Closed(props: { closed: NonNullable<DecisionPanel["closed"]> }): JSX.Element {
  const c: NonNullable<DecisionPanel["closed"]> = props.closed;
  if (c.by === null) {
    return (
      <p class="pay-closed">
        {c.kind === "paid" ? "Paid. Closed by PayOnce" : "Closed without paying"}
        {c.at === null ? null : (
          <>
            {" at "}
            <Time at={c.at} />
          </>
        )}
        .
      </p>
    );
  }
  return (
    <p class="pay-closed">
      {c.kind === "paid" ? "Closed as paid by " : "Closed without paying by "}
      <Theirs text={c.by} />
      {c.at === null ? null : (
        <>
          {" at "}
          <Time at={c.at} />
        </>
      )}
      {c.note === null ? "." : (
        <>
          {": "}
          <Theirs text={c.note} />
        </>
      )}
    </p>
  );
}

// "Request #11 · open until 15:25 (in 52 min)" in the panel's heading row.
function RequestLine(props: { request: RequestView }): JSX.Element | null {
  const r: RequestView = props.request;
  if ((r.state !== "waiting" && r.state !== "approved") || r.expiresAt === null) {
    return null;
  }
  return (
    <span class="pay-decision__request">
      {`Request #${r.id} · ${r.state === "approved" ? "approved, usable until" : "open until"} `}
      <Time at={r.expiresAt} mode="until" />
    </span>
  );
}

// A request that no longer waits: expired, used, replaced or withdrawn.
function RequestState(props: { request: RequestView; nextCheckAt: string | null }): JSX.Element {
  const r: RequestView = props.request;
  if (r.state === "expired") {
    return (
      <p class="pay-decision__state">
        {`Request #${r.id} expired`}
        {r.expiresAt === null ? null : (
          <>
            {" at "}
            <Time at={r.expiresAt} />
          </>
        )}
        {". PayOnce opens a new request at its next check"}
        {props.nextCheckAt === null ? null : (
          <>
            {" ("}
            <Time at={props.nextCheckAt} />
            {")"}
          </>
        )}
        .
      </p>
    );
  }
  return <p class="pay-decision__state">{`Request #${r.id}: ${r.label}.`}</p>;
}

function Headroom(props: { line: HeadroomLine }): JSX.Element | null {
  const h: HeadroomLine = props.line;
  if (h.now === null) {
    return null;
  }
  return (
    <p class="pay-headroom">
      {`${h.wallet} headroom now `}
      <Money money={h.now} />
      {h.after === null || h.after.minor === h.now.minor ? null : (
        <>
          {" · after this "}
          <Money money={h.after} />
        </>
      )}
      {h.floorSource === "not-set" ? " · no reserve floor is set" : null}
    </p>
  );
}

// One option as a radio card: its title, what confirming it does and, when it
// is off, why. The callback card also shows the phone it would be made on.
function OptionCard(props: {
  option: DecisionOption;
  chosen: boolean;
  name: string;
  onPick: () => void;
  phone: IncidentPhoneView;
  supplierKey: string | null;
}): JSX.Element {
  const o: DecisionOption = props.option;
  const off: boolean = !o.can.allowed;
  const classes: string = ["pay-option", props.chosen ? "is-on" : "", off ? "is-off" : ""].filter((name: string): boolean => name !== "").join(" ");
  return (
    <div class={classes}>
      <label class="pay-option__pick">
        <input type="radio" class="pay-option__radio" name={props.name} value={o.kind} checked={props.chosen} disabled={off} onChange={props.onPick} />
        <span class="pay-option__body">
          <span class="pay-option__title">
            {o.title}
            {o.suggested && !off ? <span class="pay-pill">Suggested</span> : null}
          </span>
          {o.consequence.map(
            (line: string): JSX.Element => (
              <span class="pay-option__line" key={line}>
                {line}
              </span>
            ),
          )}
          {off && o.can.why !== null ? <span class="pay-option__why">{sentence(o.can.why.text)}</span> : null}
        </span>
      </label>
      {o.kind === "callback" ? <PhoneOnFile phone={props.phone} supplierKey={props.supplierKey} blocked={off} /> : null}
    </div>
  );
}

function OptionForm(props: { option: DecisionOption; acts: Acts }): JSX.Element {
  const o: DecisionOption = props.option;
  switch (o.kind) {
    case "approve":
      return <ApproveForm option={o} acts={props.acts} />;
    case "callback":
      return <CallbackForm option={o} acts={props.acts} />;
    case "close-paid":
    case "close-unpaid":
      return <CloseForm option={o} acts={props.acts} />;
    case "end-outage":
      return <OutageForm option={o} acts={props.acts} />;
    case "trace":
      return <TraceForm acts={props.acts} allowed={o.can.allowed} why={o.can.why?.text ?? null} />;
  }
}

// The option a link asked for, else the one the server suggests. Nothing is
// chosen for the person when no option fits better than the others.
function firstChoice(options: DecisionOption[], want: Kind | null): Kind | null {
  const wanted: DecisionOption | undefined = options.find((option: DecisionOption): boolean => option.kind === want && option.can.allowed);
  return (wanted ?? options.find((option: DecisionOption): boolean => option.suggested && option.can.allowed))?.kind ?? null;
}

function Options(props: {
  options: DecisionOption[];
  acts: Acts;
  want: Kind | null;
  phone: IncidentPhoneView;
  supplierKey: string | null;
}): JSX.Element {
  const name: string = useId();
  const [picked, setPicked] = useState<Kind | null>(null);
  // Forms stay mounted once opened, so going back to one keeps what was typed.
  const [opened, setOpened] = useState<ReadonlySet<Kind>>(new Set<Kind>());
  useEffect((): void => {
    if (props.want !== null) {
      setPicked(props.want);
    }
  }, [props.want]);
  const options: DecisionOption[] = props.options;
  const usable = (kind: Kind | null): boolean =>
    kind !== null && options.some((option: DecisionOption): boolean => option.kind === kind && option.can.allowed);
  const chosen: Kind | null = usable(picked) ? picked : firstChoice(options, props.want);
  useEffect((): void => {
    if (chosen !== null && !opened.has(chosen)) {
      setOpened(new Set<Kind>([...opened, chosen]));
    }
  }, [chosen]);
  if (options.length === 0) {
    return <p class="muted">Nothing needs a decision on this payment now.</p>;
  }
  return (
    <>
      <fieldset class="pay-options">
        <legend class="pay-options__legend">Choose what to do</legend>
        {options.map(
          (option: DecisionOption): JSX.Element => (
            <OptionCard
              key={option.kind}
              option={option}
              chosen={option.kind === chosen}
              name={name}
              onPick={(): void => setPicked(option.kind)}
              phone={props.phone}
              supplierKey={props.supplierKey}
            />
          ),
        )}
      </fieldset>
      {options
        .filter((option: DecisionOption): boolean => option.can.allowed && (opened.has(option.kind) || option.kind === chosen))
        .map(
          (option: DecisionOption): JSX.Element => (
            <div key={option.kind} class="pay-chosen" hidden={option.kind !== chosen}>
              <OptionForm option={option} acts={props.acts} />
            </div>
          ),
        )}
    </>
  );
}

export function Decision(props: { view: IncidentView; acts: Acts; want: Kind | null }): JSX.Element {
  const id: string = useId();
  const me: string | null = useMe();
  const v: IncidentView = props.view;
  const panel: DecisionPanel = v.decision;
  const open: NonNullable<DecisionPanel["open"]> | null = panel.open;
  const request: RequestView | null = open?.request ?? null;
  const live: boolean = request !== null && (request.state === "waiting" || request.state === "approved");
  return (
    <section class="card card--accent pay-decision" id="decision" aria-labelledby={id} tabIndex={-1}>
      <div class="pay-decision__head">
        <h2 class="pay-decision__title" id={id}>
          Decision
        </h2>
        {request === null ? null : <RequestLine request={request} />}
      </div>
      {panel.closed !== null ? <Closed closed={panel.closed} /> : null}
      {open === null ? null : (
        <>
          {request === null ? null : live ? (
            <Terms terms={request.terms} wallet={v.payment.wallet} callbackOnFile={v.supplier.phone.requestCallbackOnFile} />
          ) : (
            <RequestState request={request} nextCheckAt={v.situation.nextCheckAt} />
          )}
          {open.cautions.length === 0 ? null : (
            <div class="pay-cautions">
              {open.cautions.map(
                (caution: Caution): JSX.Element => (
                  <Callout tone="warning" key={caution.code}>
                    <Said text={caution.text} />
                  </Callout>
                ),
              )}
            </div>
          )}
          {request !== null && live ? <Signers request={request} me={me} /> : null}
          <Options options={open.options} acts={props.acts} want={props.want} phone={v.supplier.phone} supplierKey={v.payment.supplierKey} />
          {open.headroom === null ? null : <Headroom line={open.headroom} />}
        </>
      )}
    </section>
  );
}

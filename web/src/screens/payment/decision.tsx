import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { postJson } from "../../api";
import { ApproveForm, DecisionCard, OptionCard, Options, RequestLine, Signers } from "../../components/Decision";
import { EndOutageForm } from "../../components/EndOutage";
import { Callout } from "../../components/Notice";
import { Money, Said, Theirs, Time, When } from "../../components/Text";
import type { Acted, Caution, DecisionOption, DecisionPanel, HeadroomLine, IncidentPhoneView, IncidentView, RequestView } from "../../types";
import { CallbackForm } from "./callback";
import { CloseForm, TraceForm } from "./forms";
import type { Acts } from "./parts";
import { CallbackPhone } from "./phone";
import { Terms } from "./terms";

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
  const at: JSX.Element | null =
    c.at === null ? null : (
      <>
        {" "}
        <When at={c.at} />
      </>
    );
  if (c.by === null) {
    return (
      <p class="pay-closed">
        {c.kind === "paid" ? "Paid. Closed by PayOnce" : "Closed without paying"}
        {at}.
      </p>
    );
  }
  return (
    <p class="pay-closed">
      {c.kind === "paid" ? "Closed as paid by " : "Closed without paying by "}
      <Theirs text={c.by} />
      {at}
      {c.note === null ? (
        "."
      ) : (
        <>
          {": "}
          <Theirs text={c.note} />
        </>
      )}
    </p>
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
            {" "}
            <When at={r.expiresAt} />
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

function OptionForm(props: { option: DecisionOption; acts: Acts }): JSX.Element {
  const o: DecisionOption = props.option;
  const acts: Acts = props.acts;
  switch (o.kind) {
    case "approve":
      return (
        <ApproveForm
          key={o.requestId}
          approvers={o.approvers}
          can={o.can}
          empty="Approve"
          onApprove={async (approver: string): Promise<void> => {
            acts.done(await postJson<Acted<IncidentView>>(`${acts.path}/approve`, { approver, approvalId: o.requestId }));
          }}
          onRefused={acts.refresh}
        />
      );
    case "callback":
      return <CallbackForm option={o} acts={acts} />;
    case "close-paid":
    case "close-unpaid":
      return <CloseForm option={o} acts={acts} />;
    case "end-outage":
      return <EndOutageForm outageId={o.outageId} rail={o.rail} enders={o.enders} can={o.can} onEnded={acts.refresh} onRefused={acts.refresh} />;
    case "trace":
      return <TraceForm acts={acts} allowed={o.can.allowed} why={o.can.why?.text ?? null} />;
  }
}

// What the options are now: which there are, which are allowed and suggested,
// and the request an approval would sign.
function shapeOf(options: DecisionOption[]): string {
  return options
    .map((option: DecisionOption): string => `${option.kind}:${option.can.allowed}:${option.suggested}:${option.kind === "approve" ? option.requestId : ""}`)
    .join(",");
}

// The option a link asked for, else the one the server suggests. Nothing is
// chosen for the person when no option fits better than the others.
function firstChoice(options: DecisionOption[], want: Kind | null): Kind | null {
  const wanted: DecisionOption | undefined = options.find((option: DecisionOption): boolean => option.kind === want && option.can.allowed);
  return (wanted ?? options.find((option: DecisionOption): boolean => option.suggested && option.can.allowed))?.kind ?? null;
}

function Choices(props: {
  options: DecisionOption[];
  acts: Acts;
  want: Kind | null;
  phone: IncidentPhoneView;
  supplierKey: string | null;
}): JSX.Element {
  const name: string = useId();
  const [picked, setPicked] = useState<Kind | null>(null);
  // The option the link asked for, until the options change.
  const [asked, setAsked] = useState<Kind | null>(props.want);
  // Forms stay mounted once opened, so going back to one keeps what was typed.
  const [opened, setOpened] = useState<ReadonlySet<Kind>>(new Set<Kind>());
  useEffect((): void => {
    if (props.want !== null) {
      setPicked(props.want);
      setAsked(props.want);
    }
  }, [props.want]);
  const options: DecisionOption[] = props.options;
  // Once an action or a look changes the options (a callback opens a new
  // request, a signoff lands), the panel moves on to the one that fits now.
  const shape: string = shapeOf(options);
  const shown = useRef<string>(shape);
  useEffect((): void => {
    if (shown.current !== shape) {
      shown.current = shape;
      setPicked(null);
      setAsked(null);
    }
  }, [shape]);
  const usable = (kind: Kind | null): boolean =>
    kind !== null && options.some((option: DecisionOption): boolean => option.kind === kind && option.can.allowed);
  const chosen: Kind | null = usable(picked) ? picked : firstChoice(options, asked);
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
      <Options>
        {options.map(
          (option: DecisionOption): JSX.Element => (
            <OptionCard key={option.kind} option={option} name={name} chosen={option.kind === chosen} onPick={(): void => setPicked(option.kind)}>
              {option.kind === "callback" ? <CallbackPhone phone={props.phone} supplierKey={props.supplierKey} blocked={!option.can.allowed} /> : null}
            </OptionCard>
          ),
        )}
      </Options>
      {options
        .filter((option: DecisionOption): boolean => option.can.allowed && (opened.has(option.kind) || option.kind === chosen))
        .map(
          (option: DecisionOption): JSX.Element => (
            <div key={option.kind} hidden={option.kind !== chosen}>
              <OptionForm option={option} acts={props.acts} />
            </div>
          ),
        )}
    </>
  );
}

export function Decision(props: { view: IncidentView; acts: Acts; want: Kind | null }): JSX.Element {
  const v: IncidentView = props.view;
  const panel: DecisionPanel = v.decision;
  const open: NonNullable<DecisionPanel["open"]> | null = panel.open;
  const request: RequestView | null = open?.request ?? null;
  const live: boolean = request !== null && (request.state === "waiting" || request.state === "approved");
  return (
    <DecisionCard id="decision" aside={live ? <RequestLine request={request} noun="Request" /> : null}>
      {panel.closed !== null ? <Closed closed={panel.closed} /> : null}
      {open === null ? null : (
        <>
          {request === null ? null : live ? (
            <Terms terms={request.terms} wallet={v.payment.wallet} callbackOnFile={v.supplier.phone.requestCallbackOnFile} />
          ) : (
            <RequestState request={request} nextCheckAt={v.situation.nextCheckAt} />
          )}
          {open.cautions.length === 0 ? null : (
            <div class="decision__cautions">
              {open.cautions.map(
                (caution: Caution): JSX.Element => (
                  <Callout tone="warning" key={caution.code}>
                    <Said text={caution.text} />
                  </Callout>
                ),
              )}
            </div>
          )}
          {request !== null && live ? <Signers request={request} explain /> : null}
          <Choices options={open.options} acts={props.acts} want={props.want} phone={v.supplier.phone} supplierKey={v.payment.supplierKey} />
          {open.headroom === null ? null : <Headroom line={open.headroom} />}
        </>
      )}
    </DecisionCard>
  );
}

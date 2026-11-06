import type { ComponentChildren, JSX } from "preact";
import { ActionButton } from "../../components/Action";
import { Icon } from "../../components/Icon";
import { Day, Money, Theirs, Time } from "../../components/Text";
import { SituationHeader } from "../../components/Tone";
import { postJson } from "../../api";
import { runHref, supplierHref } from "../../router";
import { parseDay, useNow } from "../../time";
import type { Acted, IncidentView, PaymentFacts, Situation } from "../../types";
import { Dotted, methodText, type Acts } from "./parts";

// The payment page's header (ia.md 3.1): what the payment is, its one state with
// the next step and what blocks it, the incident on it, and Check now.

// The view writes the state's deadline into the detail in UTC ("open until 06:21
// UTC", "due 09:03 UTC"). The page shows it in local time with how long is left.
const UTC_DEADLINE: RegExp = /( · open until|, due) \d{2}:\d{2} UTC$/;

function localised(situation: Situation): { situation: Situation; extra: ComponentChildren } {
  const found: RegExpExecArray | null = situation.detail === null ? null : UTC_DEADLINE.exec(situation.detail);
  if (found === null || situation.detail === null || situation.deadlineAt === null) {
    return { situation, extra: undefined };
  }
  return {
    situation: { ...situation, detail: situation.detail.slice(0, found.index) },
    extra: (
      <>
        {`${found[1]} `}
        <Time at={situation.deadlineAt} mode="until" />
      </>
    ),
  };
}

function Due(props: { day: string }): JSX.Element {
  const now: Date = useNow();
  const due: Date | null = parseDay(props.day);
  const today: Date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const passed: boolean = due !== null && due.getTime() < today.getTime();
  return (
    <span class={passed ? "pay-due pay-due--passed" : "pay-due"}>
      {"Due "}
      <Day day={props.day} />
      {passed ? ", passed" : null}
    </span>
  );
}

function Facts(props: { payment: PaymentFacts }): JSX.Element {
  const p: PaymentFacts = props.payment;
  return (
    <p class="pay-head__facts">
      <Dotted
        parts={[
          p.supplierKey === null ? (
            <Theirs text={p.supplier} class="pay-head__supplier" />
          ) : (
            <a class="pay-head__supplier" href={supplierHref(p.supplierKey)}>
              <Theirs text={p.supplier} />
            </a>
          ),
          <Money money={p.amount} class="pay-head__amount" />,
          methodText(p.method),
          `from the ${p.wallet} wallet`,
          p.dueDate === null ? null : <Due day={p.dueDate} />,
        ]}
      />
    </p>
  );
}

function CheckNow(props: { view: IncidentView; acts: Acts }): JSX.Element | null {
  const v: IncidentView = props.view;
  if (v.decision.closed !== null || !v.decision.checkNow.allowed) {
    return null;
  }
  const busy: boolean = v.activity.busy;
  return (
    <span class="pay-head__check">
      <ActionButton
        label={busy ? "Working…" : "Check now"}
        busyLabel="Working…"
        icon={<Icon name="refresh" />}
        disabled={busy}
        onAction={async (): Promise<void> => {
          props.acts.done(await postJson<Acted<IncidentView>>(`${props.acts.path}/check`, {}));
        }}
      />
    </span>
  );
}

export function Header(props: { view: IncidentView; acts: Acts }): JSX.Element {
  const v: IncidentView = props.view;
  const p: PaymentFacts = v.payment;
  const shown: { situation: Situation; extra: ComponentChildren } = localised(v.situation);
  return (
    <header class="card pay-head">
      <div class="pay-head__top">
        <span class="pay-eyebrow">Payment</span>
        {v.incident === null ? null : <span class="pay-badge">Incident</span>}
        {v.activity.busy ? (
          <span class="working" role="status">
            <span class="working__dot" aria-hidden="true" />
            Working
          </span>
        ) : null}
        <CheckNow view={v} acts={props.acts} />
      </div>
      <h1 class="pay-head__id ref">{p.invoiceId}</h1>
      <Facts payment={p} />
      <SituationHeader situation={shown.situation} extra={shown.extra} />
      {p.run === null ? null : (
        <p class="pay-head__line">
          <a href={runHref(p.run.id)}>{`From pay run ${p.run.id}, row ${p.run.line}`}</a>
        </p>
      )}
      {p.origin === "outside" ? <p class="pay-head__line">Sent outside PayOnce: found in Airwallex's transfer list</p> : null}
      {v.incident === null && p.startedBy === null ? null : (
        <p class="pay-head__incident">
          <Dotted
            parts={[
              v.incident === null ? null : `Incident: ${v.incident.cause}`,
              v.incident?.openedAt === null || v.incident?.openedAt === undefined ? null : (
                <>
                  {"since "}
                  <Time at={v.incident.openedAt} />
                </>
              ),
              p.startedBy === null ? null : (
                <>
                  {"Started by "}
                  <Theirs text={p.startedBy} />
                </>
              ),
            ]}
          />
        </p>
      )}
    </header>
  );
}

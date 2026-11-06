import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { postJson, type ApiError } from "../../api";
import { ActionButton } from "../../components/Action";
import { Field, NameField, type ControlProps } from "../../components/Form";
import { Card } from "../../components/Layout";
import { Callout } from "../../components/Notice";
import { Empty, LoadError, Loading } from "../../components/States";
import { Ref, Theirs, Time } from "../../components/Text";
import { ToneBadge } from "../../components/Tone";
import { sameMe, useMe, useNameDraft } from "../../me";
import { notify } from "../../notices";
import type { Polled } from "../../poll";
import { paymentHref, runHref } from "../../router";
import type { EndOutageInput, EndOutageResult, OutageCardView, OutagesView } from "../../types";
import { railWords, sentence } from "./format";
import { useScrollTo } from "./scroll";

// Treasury › Outages (ia.md section 8.3): the rule, each active outage with what
// it counted and what it pauses, the form to end it, and the outages that ended.
// The Treasury screen polls GET /api/outages, since its tab shows the count.

// What a form still needs, shown under its field.
interface Missing {
  name: string | null;
  note: string | null;
}

type Pausing = OutageCardView["pausing"][number];

export function outageAnchor(id: number): string {
  return `outage-${id}`;
}

// "INV-1 (first transfer)" with the payment or the run linked.
function PausingItem(props: { item: Pausing }): JSX.Element {
  const { invoiceId, runId, label } = props.item;
  const subject: string = invoiceId ?? (runId === null ? "" : `pay run ${runId}`);
  const rest: string = label.startsWith(subject) ? label.slice(subject.length) : ` ${label}`;
  return (
    <span>
      {invoiceId !== null ? (
        <a class="ref" href={paymentHref(invoiceId)}>
          {invoiceId}
        </a>
      ) : runId !== null ? (
        <a href={runHref(runId)}>{`pay run ${runId}`}</a>
      ) : null}
      {rest}
    </span>
  );
}

function List(props: { children: JSX.Element[] }): JSX.Element {
  return (
    <>
      {props.children.map(
        (child: JSX.Element, index: number): JSX.Element => (
          <span key={index}>
            {index === 0 ? null : ", "}
            {child}
          </span>
        ),
      )}
    </>
  );
}

// Who ends it: the approver list when there is one, any name when there is none.
function EndForm(props: { card: OutageCardView; polled: Polled<OutagesView> }): JSX.Element {
  const card: OutageCardView = props.card;
  const me: string | null = useMe();
  const enders: string[] | null = card.end.enders;
  const [typed, setTyped] = useNameDraft();
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [missing, setMissing] = useState<Missing>({ name: null, note: null });
  const listed: string = enders?.find((name: string): boolean => me !== null && sameMe(name, me)) ?? enders?.[0] ?? "";
  const endedBy: string = enders === null ? typed : (chosen ?? listed);

  async function end(): Promise<void> {
    const problems: Missing = {
      name: endedBy.trim() === "" ? "Enter your name." : null,
      note: note.trim() === "" ? "Add a note saying why the rail is back." : null,
    };
    setMissing(problems);
    if (problems.name !== null || problems.note !== null) {
      return;
    }
    const body: EndOutageInput = { endedBy: endedBy.trim(), note: note.trim() };
    const result: EndOutageResult = await postJson<EndOutageResult>(`/api/outages/${card.id}/end`, body);
    props.polled.replace(result.view);
    notify(result.notice);
  }

  return (
    <div class="form-row outage__form">
      {enders === null ? (
        <NameField
          label="Ended by"
          value={typed}
          error={missing.name}
          onInput={(value: string): void => {
            setTyped(value);
            setMissing((now: Missing): Missing => ({ ...now, name: null }));
          }}
        />
      ) : (
        <Field label="Ended by" class="field--name" error={missing.name}>
          {(control: ControlProps): JSX.Element => (
            <select
              {...control}
              class="select"
              value={endedBy}
              disabled={enders.length === 0}
              onChange={(event: Event): void => setChosen((event.currentTarget as HTMLSelectElement).value)}
            >
              {enders.map(
                (name: string): JSX.Element => (
                  <option key={name} value={name}>
                    {me !== null && sameMe(name, me) ? `${name} (you)` : name}
                  </option>
                ),
              )}
            </select>
          )}
        </Field>
      )}
      <Field label="Note" error={missing.note} class="form-row__wide">
        {(control: ControlProps): JSX.Element => (
          <input
            {...control}
            class="input"
            type="text"
            maxLength={200}
            autocomplete="off"
            placeholder={`Airwallex confirmed ${railWords(card.rail)} is back`}
            value={note}
            onInput={(event: Event): void => {
              setNote((event.currentTarget as HTMLInputElement).value);
              setMissing((now: Missing): Missing => ({ ...now, note: null }));
            }}
          />
        )}
      </Field>
      <ActionButton
        label={`End outage ${card.id}`}
        busyLabel="Ending…"
        kind="primary"
        onError={(error: ApiError): void => {
          if (error.status === 404 || error.status === 409) {
            props.polled.refresh();
          }
        }}
        onAction={end}
      />
    </div>
  );
}

function ActiveCard(props: { card: OutageCardView; polled: Polled<OutagesView> }): JSX.Element {
  const card: OutageCardView = props.card;
  const titleId: string = `${outageAnchor(card.id)}-title`;
  return (
    <article class="card outage" id={outageAnchor(card.id)} aria-labelledby={titleId} tabIndex={-1}>
      <div class="outage__head">
        <ToneBadge tone="blocked" label="Active" />
        <h2 class="outage__title" id={titleId}>{`Outage ${card.id} on ${railWords(card.rail)}`}</h2>
        <span class="muted">
          {"active since "}
          <Time at={card.declaredAt} />
        </span>
      </div>
      <p>{sentence(railWords(card.text))}</p>
      <dl class="facts">
        <dt>Codes</dt>
        <dd>
          {card.codes.length === 0
            ? "none on file"
            : card.codes.map((code: OutageCardView["codes"][number]): string => `${code.code} ${code.label}`).join(", ")}
        </dd>
        <dt>Counted</dt>
        <dd>
          {card.counted.length === 0 ? (
            "none on file"
          ) : (
            <>
              <List>
                {card.counted.map(
                  (payout: OutageCardView["counted"][number]): JSX.Element =>
                    payout.invoiceId === null ? (
                      <Ref>{payout.reference}</Ref>
                    ) : (
                      <a class="ref" href={paymentHref(payout.invoiceId)} title={payout.invoiceId}>
                        {payout.reference}
                      </a>
                    ),
                )}
              </List>
              {` (${card.payees} payees)`}
            </>
          )}
        </dd>
        <dt>Pausing</dt>
        <dd>
          {card.pausing.length === 0 ? (
            "nothing yet"
          ) : (
            <List>{card.pausing.map((item: Pausing): JSX.Element => <PausingItem item={item} />)}</List>
          )}
        </dd>
      </dl>
      {card.sendsText === null ? null : <p class="outage__sends">{card.sendsText}</p>}
      {card.end.allowed ? (
        <EndForm card={card} polled={props.polled} />
      ) : (
        <p class="outage__form outage__refused">{card.end.why?.text ?? "Nobody can end this outage now."}</p>
      )}
    </article>
  );
}

function EndedLine(props: { card: OutageCardView }): JSX.Element {
  const card: OutageCardView = props.card;
  return (
    <li class="ended" id={outageAnchor(card.id)} tabIndex={-1}>
      {`Outage ${card.id} on ${railWords(card.rail)} · `}
      <Time at={card.declaredAt} />
      {card.endedAt === null ? null : (
        <>
          {" to "}
          <Time at={card.endedAt} />
        </>
      )}
      {" · ended by "}
      <Theirs text={card.endedBy ?? "a person"} />
      {card.endNote === null || card.endNote === "" ? null : (
        <>
          {": "}
          <Theirs text={card.endNote} />
        </>
      )}
    </li>
  );
}

function Outages(props: { view: OutagesView; polled: Polled<OutagesView>; focus: number | null }): JSX.Element {
  const view: OutagesView = props.view;
  // #outage/N opens at that outage.
  useScrollTo(props.focus === null ? null : outageAnchor(props.focus), true);
  return (
    <>
      <p class="outage-rule">{view.rule.text}</p>
      {view.rule.problem === null ? null : <Callout tone="danger">{view.rule.problem}</Callout>}
      {view.active.length === 0 ? (
        <Empty title="No outages. PayOnce watches every rail for repeated failures." />
      ) : (
        view.active.map((card: OutageCardView): JSX.Element => <ActiveCard key={card.id} card={card} polled={props.polled} />)
      )}
      {view.ended.length === 0 ? null : (
        <Card title="Ended">
          <ul class="ended-list">
            {view.ended.map((card: OutageCardView): JSX.Element => <EndedLine key={card.id} card={card} />)}
          </ul>
        </Card>
      )}
    </>
  );
}

export function OutagesTab(props: { polled: Polled<OutagesView>; focus: number | null }): JSX.Element {
  const outages: Polled<OutagesView> = props.polled;
  return (
    <div class="tab-panel" role="region" aria-label="Outages">
      <LoadError what="outages" error={outages.error} />
      {outages.data === null ? (
        outages.error === null ? <Loading rows={2} label="Loading outages" /> : null
      ) : (
        <Outages view={outages.data} polled={outages} focus={props.focus} />
      )}
    </div>
  );
}

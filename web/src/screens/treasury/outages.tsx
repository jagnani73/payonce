import type { JSX } from "preact";
import { EndOutageForm } from "../../components/EndOutage";
import { Card } from "../../components/Layout";
import { Callout } from "../../components/Notice";
import { Empty, LoadError, Loading } from "../../components/States";
import { Ref, Theirs, Time } from "../../components/Text";
import { ToneBadge } from "../../components/Tone";
import { useScrollTo } from "../../hooks";
import type { Polled } from "../../poll";
import { paymentHref, runHref } from "../../router";
import type { EndOutageResult, OutageCardView, OutagesView } from "../../types";

// Treasury › Outages (ia.md section 8.3): the rule, each active outage with what
// it counted and what it pauses, the form to end it, and the outages that ended.
// The Treasury screen polls GET /api/outages, since its tab shows the count.

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

function ActiveCard(props: { card: OutageCardView; polled: Polled<OutagesView> }): JSX.Element {
  const card: OutageCardView = props.card;
  const titleId: string = `${outageAnchor(card.id)}-title`;
  return (
    <article class="card outage" id={outageAnchor(card.id)} aria-labelledby={titleId} tabIndex={-1}>
      <div class="outage__head">
        <ToneBadge tone="blocked" label="Active" />
        <h2 class="outage__title" id={titleId}>{`Outage ${card.id} on ${card.rail}`}</h2>
        <span class="muted">
          {"active since "}
          <Time at={card.declaredAt} />
        </span>
      </div>
      <p>{card.text}</p>
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
        <div class="outage__form">
          <EndOutageForm
            outageId={card.id}
            rail={card.rail}
            enders={card.end.enders}
            row
            onEnded={(result: EndOutageResult): void => props.polled.replace(result.view)}
            onRefused={props.polled.refresh}
          />
        </div>
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
      {`Outage ${card.id} on ${card.rail} · `}
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

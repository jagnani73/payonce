import type { ComponentChildren, JSX } from "preact";
import { paymentHref, runHref } from "../router";
import type { Blocker, IncidentRow, Money as MoneyView, QueueItem, RowTag, RunRowItem } from "../types";
import { waitingOnText } from "../words";
import { LinkButton, type ButtonKind } from "./Action";
import { Icon } from "./Icon";
import { Money, Said, saidKey, Theirs, Time } from "./Text";
import { Tag, ToneBadge } from "./Tone";

// One payment or one pay run as a row of a queue: Home's lists, and the cards
// Incidents shows on a phone. Nothing irreversible happens from a row: its one
// button opens the payment or the run with that option chosen.

// A row says these in words already, so their tags would repeat them.
const SAID_IN_ROW: ReadonlySet<RowTag["code"]> = new Set<RowTag["code"]>(["blocked", "cross-currency"]);

function Meta(props: { parts: ComponentChildren[] }): JSX.Element | null {
  const parts: ComponentChildren[] = props.parts.filter((part: ComponentChildren): boolean => part !== null && part !== false);
  if (parts.length === 0) {
    return null;
  }
  return (
    <span class="qrow__meta-text">
      {parts.map(
        (part: ComponentChildren, index: number): JSX.Element => (
          <span key={index}>
            {index === 0 ? null : " · "}
            {part}
          </span>
        ),
      )}
    </span>
  );
}

// "Waiting on: approvers · waiting 20 min · request open until 15:13".
function paymentMeta(row: IncidentRow): ComponentChildren[] {
  const s: IncidentRow["situation"] = row.situation;
  const who: string | null = waitingOnText(s.waitingOn);
  const deadline: string | null = s.deadlineAt;
  return [
    who === null ? null : `Waiting on: ${who}`,
    s.state === "bank-late" && deadline !== null ? (
      <>
        {"late since "}
        <Time at={deadline} />
      </>
    ) : null,
    row.waitingSince === null ? null : (
      <>
        {"waiting "}
        <Time at={row.waitingSince} mode="age" />
      </>
    ),
    deadline === null ? null : s.state === "needs-approval" ? (
      <>
        {"request open until "}
        <Time at={deadline} />
      </>
    ) : s.state === "paused-by-outage" ? (
      <>
        {"approval counts until "}
        <Time at={deadline} />
      </>
    ) : s.state === "with-bank" ? (
      <>
        {"due by "}
        <Time at={deadline} />
      </>
    ) : null,
  ];
}

function Amount(props: { amount: MoneyView; fromWallet: MoneyView | null; more?: MoneyView[] }): JSX.Element {
  return (
    <div class="qrow__money">
      <Money money={props.amount} class="qrow__amount" />
      {props.fromWallet === null ? null : (
        <span class="qrow__from">
          {`from the ${props.fromWallet.currency} wallet: `}
          <Money money={props.fromWallet} />
        </span>
      )}
      {(props.more ?? []).map(
        (money: MoneyView): JSX.Element => (
          <span class="qrow__from" key={money.currency}>
            {"and "}
            <Money money={money} />
          </span>
        ),
      )}
    </div>
  );
}

function PaymentRow(props: { row: IncidentRow; kind: ButtonKind; handling: boolean }): JSX.Element {
  const row: IncidentRow = props.row;
  const s: IncidentRow["situation"] = row.situation;
  const blocker: Blocker | undefined = s.blockers[0];
  const tags: RowTag[] = row.tags.filter((tag: RowTag): boolean => !SAID_IN_ROW.has(tag.code));
  return (
    <li class={props.handling ? "qrow qrow--handling" : "qrow"}>
      <div class="qrow__state">
        <ToneBadge tone={s.tone} label={s.label} />
        {s.detail === null || props.handling ? null : (
          <span class="qrow__detail">
            <Said text={s.detail} />
          </span>
        )}
        {row.activity.busy ? (
          <span class="working">
            <span class="working__dot" aria-hidden="true" />
            Working
          </span>
        ) : null}
      </div>
      <div class="qrow__main">
        <div class="qrow__title">
          <a class="ref qrow__id" href={paymentHref(row.invoiceId)}>
            {row.invoiceId}
          </a>
          <span class="sep" aria-hidden="true">
            ·
          </span>
          <Theirs text={row.supplier} class="qrow__who" />
        </div>
        {props.handling && blocker !== undefined ? (
          <p class="qrow__blocker">
            {"Blocked: "}
            <Said text={blocker.text} />
          </p>
        ) : (
          <>
            <p class="qrow__next">
              <Said text={s.next} />
            </p>
            {blocker === undefined || saidKey(blocker.text) === saidKey(s.next) ? null : (
              <p class="qrow__blocker">
                <Icon name="pause" />
                <Said text={blocker.text} />
              </p>
            )}
          </>
        )}
        {props.handling ? null : (
          <div class="qrow__meta">
            <Meta parts={paymentMeta(row)} />
            {tags.map(
              (tag: RowTag): JSX.Element => (
                <Tag key={tag.code}>{tag.text}</Tag>
              ),
            )}
          </div>
        )}
      </div>
      <Amount amount={row.amount} fromWallet={props.handling ? null : row.fromWallet} />
      <div class="qrow__action">
        {props.handling ? (
          <LinkButton href={paymentHref(row.invoiceId)}>Open</LinkButton>
        ) : row.primary === null ? null : (
          <LinkButton href={row.primary.href} kind={props.kind}>
            {row.primary.label}
          </LinkButton>
        )}
      </div>
    </li>
  );
}

function RunRow(props: { row: RunRowItem; kind: ButtonKind }): JSX.Element {
  const row: RunRowItem = props.row;
  const [first, ...more] = row.totals;
  return (
    <li class="qrow">
      <div class="qrow__state">
        <ToneBadge tone={row.tone} label={row.label} />
        <span class="qrow__detail">{row.payments === 1 ? "1 payment" : `${row.payments} payments`}</span>
      </div>
      <div class="qrow__main">
        <div class="qrow__title">
          <a class="qrow__run" href={runHref(row.runId)}>{`Pay run ${row.runId}`}</a>
          <span class="sep" aria-hidden="true">
            ·
          </span>
          <Theirs text={row.fileName} class="qrow__who" />
        </div>
        <p class="qrow__next">
          <Said text={row.next} />
        </p>
        <div class="qrow__meta">
          <Meta
            parts={[
              <>
                {"waiting "}
                <Time at={row.waitingSince} mode="age" />
              </>,
            ]}
          />
        </div>
      </div>
      {first === undefined ? <div class="qrow__money" /> : <Amount amount={first} fromWallet={null} more={more} />}
      <div class="qrow__action">
        <LinkButton href={row.primary.href} kind={props.kind}>
          {row.primary.label}
        </LinkButton>
      </div>
    </li>
  );
}

// kind: the style of each row's button. Home's "Waiting for your approval" uses
// primary; the queue uses secondary. handling: the shorter rows of "PayOnce is
// handling", with the blocker in place of the next step and only "Open".
export function QueueRows(props: { items: QueueItem[]; kind?: ButtonKind }): JSX.Element {
  const kind: ButtonKind = props.kind ?? "secondary";
  return (
    <ul class="qrows">
      {props.items.map(
        (item: QueueItem): JSX.Element =>
          item.type === "payment" ? (
            <PaymentRow key={`p-${item.row.invoiceId}`} row={item.row} kind={kind} handling={false} />
          ) : (
            <RunRow key={`r-${item.row.runId}`} row={item.row} kind={kind} />
          ),
      )}
    </ul>
  );
}

export function HandlingRows(props: { rows: IncidentRow[]; id?: string }): JSX.Element {
  return (
    <ul class="qrows" id={props.id}>
      {props.rows.map(
        (row: IncidentRow): JSX.Element => (
          <PaymentRow key={row.invoiceId} row={row} kind="secondary" handling />
        ),
      )}
    </ul>
  );
}

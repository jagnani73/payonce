import type { JSX } from "preact";
import { Icon } from "../../components/Icon";
import { ClickRow } from "../../components/Layout";
import { HandlingRows, QueueRows } from "../../components/Rows";
import { Day, Money, Said, saidKey, Theirs, Time } from "../../components/Text";
import { Tag, ToneBadge } from "../../components/Tone";
import { navigate, paymentHref } from "../../router";
import { count } from "../../text";
import type { Blocker, IncidentRow, Money as MoneyView, OutageStrip, QueueGroup, QueueItem, RowTag, WalletTotals } from "../../types";
import { waitingOnText } from "../../words";

// The parts of the Incidents list: the outage strip, the totals bar, and the
// payments as a table on a desktop or as queue cards on a phone.

export interface Group {
  group: QueueGroup;
  label: string;
  // Every row the group has, before any "Show more".
  total: number;
  rows: IncidentRow[];
}

// "Outage 3 on USD local is pausing 3 payments. Ending it sends 3 payments
// totalling 4,000.00 USD." The end form lives in Treasury and on each paused
// payment, so the strip only links there.
export function OutageStrips(props: { outages: OutageStrip[] }): JSX.Element {
  return (
    <>
      {props.outages.map(
        (outage: OutageStrip): JSX.Element => (
          <a class="istrip" href="#treasury/outages" key={outage.id}>
            <Icon name="pause" class="istrip__icon" />
            <span class="istrip__text">{`Outage ${outage.id} on ${outage.rail} is pausing ${count(outage.pausing, "payment")}. ${outage.sendsText}`}</span>
            <span class="istrip__go">Treasury › Outages</span>
          </a>
        ),
      )}
    </>
  );
}

function Figure(props: { label: string; money: MoneyView }): JSX.Element {
  // Nothing is estimated about nothing.
  const money: MoneyView = props.money.minor === 0 ? { ...props.money, estimated: false } : props.money;
  return (
    <span class="itotals__figure">
      <span class="itotals__label">{props.label}</span> <Money money={money} />
    </span>
  );
}

// Per wallet: promised, waiting on people, with the bank. The view counts every
// payment not yet closed in the wallet and origin chosen, whatever the tab.
export function Totals(props: { totals: WalletTotals[] }): JSX.Element {
  if (props.totals.length === 0) {
    return <p class="itotals itotals--none">No money in play.</p>;
  }
  return (
    <section class="itotals" aria-label="Money in play">
      <p class="itotals__caption">Money in play on every payment not yet closed</p>
      {props.totals.map(
        (total: WalletTotals): JSX.Element => (
          <div class="itotals__wallet" key={total.wallet}>
            <strong class="itotals__code">{total.wallet}</strong>
            <Figure label="Promised" money={total.promised} />
            <Figure label="Waiting on people" money={total.waitingOnPeople} />
            {total.pausedByOutage.minor === 0 ? null : <Figure label="Paused by an outage" money={total.pausedByOutage} />}
            <Figure label="With the bank" money={total.withBank} />
            {total.runWaiting.minor === 0 ? null : <Figure label="Pay runs waiting" money={total.runWaiting} />}
            {total.feeUnknown === 0 ? null : <span class="itotals__note">{`fee not known on ${total.feeUnknown}`}</span>}
          </div>
        ),
      )}
    </section>
  );
}

// A row says these in words already, as the queue cards leave them out.
const SAID_IN_ROW: ReadonlySet<RowTag["code"]> = new Set<RowTag["code"]>(["blocked", "cross-currency"]);

// "Approvers", "The bank", "Nobody".
function waitingOn(row: IncidentRow): string {
  const who: string | null = waitingOnText(row.situation.waitingOn);
  return who === null ? "Nobody" : `${who.charAt(0).toUpperCase()}${who.slice(1)}`;
}

function TableRow(props: { row: IncidentRow }): JSX.Element {
  const row: IncidentRow = props.row;
  const s: IncidentRow["situation"] = row.situation;
  const blocker: Blocker | undefined = s.blockers[0];
  const tags: RowTag[] = row.tags.filter((tag: RowTag): boolean => !SAID_IN_ROW.has(tag.code));
  return (
    <ClickRow class="itable__row" onOpen={(): void => navigate(paymentHref(row.invoiceId))}>
      <td>
        <div class="itable__state">
          <ToneBadge tone={s.tone} label={s.label} />
          {s.detail === null ? null : (
            <span class="itable__detail">
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
      </td>
      <td>
        <div class="itable__payment">
          <a class="ref itable__id" href={paymentHref(row.invoiceId)}>
            {row.invoiceId}
          </a>
          <Theirs text={row.supplier} class="itable__who" />
          {tags.length === 0 ? null : (
            <span class="itable__tags">
              {tags.map(
                (tag: RowTag): JSX.Element => (
                  <Tag key={tag.code}>{tag.text}</Tag>
                ),
              )}
            </span>
          )}
        </div>
      </td>
      <td class="is-end">
        <Money money={row.amount} class="itable__amount" />
        {row.fromWallet === null ? null : (
          <span class="itable__from">
            {`from the ${row.fromWallet.currency} wallet: `}
            <Money money={row.fromWallet} />
          </span>
        )}
      </td>
      <td>
        <p class="itable__next">
          <Said text={s.next} />
        </p>
        {blocker === undefined || saidKey(blocker.text) === saidKey(s.next) ? null : (
          <p class="itable__blocker">
            <Icon name="pause" />
            <span>
              <Said text={blocker.text} />
            </span>
          </p>
        )}
      </td>
      <td class="itable__soft">{waitingOn(row)}</td>
      <td class="itable__soft">
        <Time at={row.waitingSince} />
      </td>
      <td class="itable__soft">{row.dueDate === null ? "None" : <Day day={row.dueDate} />}</td>
    </ClickRow>
  );
}

// headings: the scope is All, so each group gets its heading.
export function PaymentsTable(props: { groups: Group[]; headings: boolean }): JSX.Element {
  return (
    <div class="itable-scroll">
      <table class="itable">
        <caption class="visually-hidden">Payments</caption>
        <thead>
          <tr>
            <th scope="col" class="itable__col-state">
              State
            </th>
            <th scope="col" class="itable__col-payment">
              Payment
            </th>
            <th scope="col" class="is-end itable__col-amount">
              Amount
            </th>
            <th scope="col">Next step</th>
            <th scope="col" class="itable__col-who">
              Waiting on
            </th>
            <th scope="col" class="itable__col-since">
              Since
            </th>
            <th scope="col" class="itable__col-due">
              Due
            </th>
          </tr>
        </thead>
        {props.groups.map(
          (group: Group): JSX.Element => (
            <tbody key={group.group}>
              {props.headings ? (
                <tr class="itable__group">
                  <th scope="colgroup" colSpan={7}>
                    {group.label}
                    <span class="count-pill">{group.total}</span>
                  </th>
                </tr>
              ) : null}
              {group.rows.map(
                (row: IncidentRow): JSX.Element => (
                  <TableRow row={row} key={row.invoiceId} />
                ),
              )}
            </tbody>
          ),
        )}
      </table>
    </div>
  );
}

// On a phone each payment is a queue card, as on Home. The payments PayOnce is
// handling, and closed ones, get Home's shorter cards with only Open: a queue
// card's "waiting 4 d" would read wrong on a closed payment.
export function PaymentCards(props: { groups: Group[]; headings: boolean }): JSX.Element {
  return (
    <>
      {props.groups.map(
        (group: Group): JSX.Element => (
          <section class="igroup" key={group.group} aria-label={props.headings ? undefined : group.label}>
            {props.headings ? (
              <h2 class="igroup__title">
                {group.label}
                <span class="count-pill">{group.total}</span>
              </h2>
            ) : null}
            {group.group === "payonce" || group.group === "closed" ? (
              <HandlingRows rows={group.rows} />
            ) : (
              <QueueRows items={group.rows.map((row: IncidentRow): QueueItem => ({ type: "payment", row }))} />
            )}
          </section>
        ),
      )}
    </>
  );
}

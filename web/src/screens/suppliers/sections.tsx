import type { ComponentChildren, JSX } from "preact";
import { useId, useState } from "preact/hooks";
import { Icon } from "../../components/Icon";
import { Card } from "../../components/Layout";
import { Money, Ref, Said, Theirs, Time } from "../../components/Text";
import { Tag, ToneBadge } from "../../components/Tone";
import { paymentHref, runHref, supplierHref } from "../../router";
import type { IncidentRow, SupplierAccountView, SupplierListRow, SupplierView, WalletTotals } from "../../types";
import { capital, Dotted, InvoiceLink, InvoiceLinks, When } from "./parts";
import { accountsText, CALLBACK_STATES, closedText, endingText, recordFacts, SECOND_BILL_KINDS, SEEN_AS } from "./words";

// The supplier record's sections after the contact card (ia.md section 7, items
// 4 to 6): accounts, payments, callbacks, possible second bills, pay run rows,
// emails in the inbox, messages, outages and related records. Each compact
// section is left out when it has nothing to show.

type View = SupplierView;

// Other records by key, from the supplier list, to tell them apart.
export type Others = ReadonlyMap<string, SupplierListRow>;

function OtherRecord(props: { supplierKey: string; name: string | null; others: Others }): JSX.Element {
  const row: SupplierListRow | undefined = props.others.get(props.supplierKey);
  return (
    <>
      <a href={supplierHref(props.supplierKey)}>
        <Theirs text={props.name ?? row?.name ?? "another record"} />
      </a>
      <span class="muted">{` (${row === undefined ? `record ${props.supplierKey.slice(0, 8)}` : recordFacts(row)})`}</span>
    </>
  );
}

// ---------- accounts ----------

function Seen(props: { account: SupplierAccountView }): JSX.Element {
  const a: SupplierAccountView = props.account;
  // Within one minute reads as one time.
  const range: ComponentChildren =
    a.firstSeen === null ? null : a.lastSeen === null || a.lastSeen.slice(0, 16) === a.firstSeen.slice(0, 16) ? (
      <>
        {"first seen "}
        <When at={a.firstSeen} />
      </>
    ) : (
      <>
        <Time at={a.firstSeen} />
        {" to "}
        <Time at={a.lastSeen} />
      </>
    );
  return (
    <p class="sup-account__seen">
      <Dotted parts={[a.seenAs.length === 0 ? null : `Seen as: ${a.seenAs.map((source: SupplierAccountView["seenAs"][number]): string => SEEN_AS[source]).join(", ")}`, range]} />
    </p>
  );
}

function Account(props: { account: SupplierAccountView; anyPaid: boolean; view: View; others: Others }): JSX.Element {
  const a: SupplierAccountView = props.account;
  const names: Map<string, string> = new Map(props.view.related.map((item: View["related"][number]): [string, string] => [item.key, item.name]));
  return (
    <article class="sup-account">
      <h3 class="sup-account__title">
        <span class={a.onFile ? "sup-letter sup-letter--on-file" : "sup-letter"} aria-hidden="true">
          {a.letter}
        </span>
        <span class="visually-hidden">{`Account ${a.letter}: `}</span>
        {a.ending === null ? <span>{capital(a.label)}</span> : <span class="mono">{endingText(a.ending)}</span>}
        {a.onFile ? <Tag>On file</Tag> : null}
      </h3>
      <Seen account={a} />
      {a.verifiedBy === null ? null : (
        <p>
          {"Verified by "}
          <Theirs text={a.verifiedBy.calledBy} />
          {"'s callback "}
          <When at={a.verifiedBy.calledAt} />
          {" ("}
          <InvoiceLink id={a.verifiedBy.invoiceId} />
          {")"}
        </p>
      )}
      {a.lastPaid !== null ? (
        <p>
          {"Last paid by "}
          {a.lastPaid.reference === null ? "a payment" : <Ref>{a.lastPaid.reference}</Ref>}
          {" (checked)"}
        </p>
      ) : props.anyPaid ? null : (
        <p class="muted">Not paid yet</p>
      )}
      {a.barred.length === 0 ? null : (
        <p class="sup-account__barred">
          {"Barred from approving payments to it: "}
          {a.barred.map(
            (name: string, index: number): JSX.Element => (
              <span key={`${index}-${name}`}>
                {index === 0 ? null : ", "}
                <Theirs text={name} />
              </span>
            ),
          )}
        </p>
      )}
      {a.alsoOn.map(
        (key: string): JSX.Element => (
          <p class="sup-account__also" key={key}>
            {"Also on "}
            <OtherRecord supplierKey={key} name={names.get(key) ?? null} others={props.others} />
          </p>
        ),
      )}
    </article>
  );
}

// The account on file first, then the newest.
export function Accounts(props: { view: View; others: Others }): JSX.Element {
  const accounts: SupplierAccountView[] = [...props.view.accounts].sort(
    (a: SupplierAccountView, b: SupplierAccountView): number => Number(b.onFile) - Number(a.onFile) || b.letter.localeCompare(a.letter),
  );
  const anyPaid: boolean = accounts.some((account: SupplierAccountView): boolean => account.lastPaid !== null);
  return (
    <Card title="Accounts" class="sup-accounts">
      {accounts.length === 0 ? (
        <p class="muted">PayOnce hasn't read an account for this record yet.</p>
      ) : (
        <div class="sup-stack">
          {accounts.map(
            (account: SupplierAccountView): JSX.Element => (
              <Account key={account.letter} account={account} anyPaid={anyPaid} view={props.view} others={props.others} />
            ),
          )}
        </div>
      )}
    </Card>
  );
}

// ---------- payments ----------

function PaymentLink(props: { row: IncidentRow }): JSX.Element {
  const row: IncidentRow = props.row;
  return (
    <li>
      <a class="sup-pay" href={paymentHref(row.invoiceId)}>
        <ToneBadge tone={row.situation.tone} label={row.situation.label} />
        <span class="ref sup-pay__id">{row.invoiceId}</span>
        {row.situation.detail === null ? null : (
          <span class="sup-pay__detail">
            <Said text={row.situation.detail} />
          </span>
        )}
        <Money money={row.amount} class="sup-pay__amount" />
      </a>
    </li>
  );
}

// "USD · Promised 4,000.00 USD · Waiting on people 8,499.92 USD".
function InPlay(props: { totals: WalletTotals[] }): JSX.Element | null {
  const lines: JSX.Element[] = props.totals.flatMap((total: WalletTotals): JSX.Element[] => {
    const parts: ComponentChildren[] = (
      [
        ["Promised", total.promised],
        ["Waiting on people", total.waitingOnPeople],
        ["Paused by an outage", total.pausedByOutage],
        ["Pay run waiting", total.runWaiting],
        ["With the bank", total.withBank],
      ] as const
    )
      .filter(([, money]): boolean => money.minor !== 0)
      .map(([label, money]): JSX.Element => (
        <>
          {`${label} `}
          <Money money={money} />
        </>
      ));
    if (parts.length === 0) {
      return [];
    }
    return [
      <p class="sup-inplay" key={total.wallet}>
        <Dotted parts={[<strong>{total.wallet}</strong>, ...parts, total.feeUnknown === 0 ? null : `fee not known on ${total.feeUnknown}`]} />
      </p>,
    ];
  });
  return lines.length === 0 ? null : <div class="sup-inplay-list">{lines}</div>;
}

export function Payments(props: { view: View }): JSX.Element {
  const { open, closed } = props.view.payments;
  const [showClosed, setShowClosed] = useState<boolean>(false);
  const id: string = useId();
  const closedCount: number = closed.paid + closed.unpaid;
  return (
    <Card title="Payments" class="sup-section">
      <InPlay totals={props.view.money} />
      {open.length === 0 && closedCount === 0 ? (
        <p class="muted">No payments yet.</p>
      ) : (
        <>
          {open.length === 0 ? (
            <p class="muted">No open payments.</p>
          ) : (
            <ul class="sup-pays">
              {open.map(
                (row: IncidentRow): JSX.Element => (
                  <PaymentLink key={row.invoiceId} row={row} />
                ),
              )}
            </ul>
          )}
          {closedCount === 0 ? null : (
            <>
              <button type="button" class="sup-toggle" aria-expanded={showClosed} aria-controls={id} onClick={(): void => setShowClosed(!showClosed)}>
                <Icon name="chevron-right" class={showClosed ? "disclosure__chevron is-open" : "disclosure__chevron"} />
                {closedText(closed)}
              </button>
              {showClosed ? (
                <div id={id}>
                  <ul class="sup-pays">
                    {closed.listed.map(
                      (row: IncidentRow): JSX.Element => (
                        <PaymentLink key={row.invoiceId} row={row} />
                      ),
                    )}
                  </ul>
                  {closed.listed.length >= closedCount ? null : (
                    <p class="sup-more">
                      {`This shows the newest ${closed.listed.length}. `}
                      <a href="#incidents?scope=closed">Incidents has every closed payment.</a>
                    </p>
                  )}
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </Card>
  );
}

// ---------- the compact sections ----------

function Section(props: { title: string; children: ComponentChildren }): JSX.Element {
  return (
    <Card title={props.title} class="sup-section">
      <ul class="sup-lines">{props.children}</ul>
    </Card>
  );
}

function callbackAccounts(from: string | null, to: string | null): string | null {
  if (to === null) {
    return from === null ? null : `from account ${from}`;
  }
  if (from === to) {
    return `confirmed account ${to}`;
  }
  return from === null ? `to account ${to}` : `account ${from} to account ${to}`;
}

export function Callbacks(props: { view: View }): JSX.Element | null {
  if (props.view.callbacks.length === 0) {
    return null;
  }
  return (
    <Section title="Callbacks">
      {props.view.callbacks.map(
        (callback: View["callbacks"][number]): JSX.Element => (
          <li key={callback.id}>
            <Dotted
              parts={[
                <Theirs text={callback.calledBy} />,
                <Time at={callback.calledAt} />,
                callback.numberEnding === null ? "number not on file" : `number ending ${callback.numberEnding}`,
                callbackAccounts(callback.from, callback.to),
                <>
                  {`${CALLBACK_STATES[callback.state] ?? callback.state} on `}
                  <InvoiceLink id={callback.invoiceId} />
                </>,
              ]}
            />
          </li>
        ),
      )}
    </Section>
  );
}

export function SecondBills(props: { view: View }): JSX.Element | null {
  if (props.view.secondBills.length === 0) {
    return null;
  }
  return (
    <Section title="Possible second bills">
      {props.view.secondBills.map(
        (group: View["secondBills"][number], index: number): JSX.Element => (
          <li key={`${group.kind}-${index}`}>
            <p class="sup-lines__lead">{SECOND_BILL_KINDS[group.kind]}</p>
            <ul class="sup-bills">
              {group.invoices.map(
                (bill: View["secondBills"][number]["invoices"][number]): JSX.Element => (
                  <li key={bill.invoiceId}>
                    <InvoiceLink id={bill.invoiceId} />
                    <span class="muted">{` ${bill.label}`}</span>
                  </li>
                ),
              )}
            </ul>
          </li>
        ),
      )}
    </Section>
  );
}

export function RunRows(props: { view: View }): JSX.Element | null {
  if (props.view.runRows.length === 0) {
    return null;
  }
  return (
    <Section title="Pay run rows">
      {props.view.runRows.map(
        (row: View["runRows"][number]): JSX.Element => (
          <li key={`${row.runId}-${row.line}`}>
            <Dotted
              parts={[
                <a href={runHref(row.runId)}>{`Pay run ${row.runId}, row ${row.line}`}</a>,
                row.invoiceId === null ? null : <span class="ref">{row.invoiceId}</span>,
                row.label,
              ]}
            />
          </li>
        ),
      )}
    </Section>
  );
}

export function InboxEmails(props: { view: View }): JSX.Element | null {
  if (props.view.inbox.length === 0) {
    return null;
  }
  return (
    <Section title="Emails in the inbox">
      {props.view.inbox.map(
        (item: View["inbox"][number]): JSX.Element => (
          <li key={item.uploadId}>
            <Dotted
              parts={[
                <a href={`#inbox/${item.uploadId}`}>{`Email ${item.uploadId}`}</a>,
                item.invoices.length === 0 ? (
                  "matches no payment yet"
                ) : (
                  <>
                    {item.suggested ? "PayOnce suggests " : "may belong to "}
                    <InvoiceLinks ids={item.invoices} />
                  </>
                ),
              ]}
            />
          </li>
        ),
      )}
    </Section>
  );
}

export function Messages(props: { view: View }): JSX.Element | null {
  if (props.view.drafts.length === 0) {
    return null;
  }
  return (
    <Section title="Messages">
      {props.view.drafts.map(
        (draft: View["drafts"][number]): JSX.Element => (
          <li key={draft.id}>
            <Dotted parts={[<InvoiceLink id={draft.invoiceId} tab="messages" />, draft.label, draft.stateLabel]} />
          </li>
        ),
      )}
    </Section>
  );
}

function failureNote(failure: View["outages"]["failures"][number]): ComponentChildren {
  if (failure.failure === null) {
    return null;
  }
  if (failure.failure.accountLevel) {
    return "an account-level failure, so it does not count toward an outage";
  }
  if (!failure.failure.railLevel) {
    return null;
  }
  return failure.outageId === null ? (
    "a rail-level failure"
  ) : (
    <>
      {"a rail-level failure, counted in "}
      <a href={`#outage/${failure.outageId}`}>{`outage ${failure.outageId}`}</a>
    </>
  );
}

export function Outages(props: { view: View }): JSX.Element | null {
  const { active, failures } = props.view.outages;
  if (active.length === 0 && failures.length === 0) {
    return null;
  }
  return (
    <Section title="Outages and rail failures">
      {active.map(
        (strip: View["outages"]["active"][number]): JSX.Element => (
          <li key={`outage-${strip.id}`}>
            <a href={`#outage/${strip.id}`}>{`Outage ${strip.id} on ${strip.rail}`}</a>
            {strip.pausing === 0
              ? " is active. New transfers on this rail wait until someone ends it."
              : ` is active. It pauses ${strip.pausing === 1 ? "1 of this supplier's payments" : `${strip.pausing} of this supplier's payments`} until someone ends it.`}
          </li>
        ),
      )}
      {failures.map(
        (failure: View["outages"]["failures"][number], index: number): JSX.Element => (
          <li class="sup-lines__quiet" key={`failure-${failure.reference ?? index}-${index}`}>
            <Dotted
              parts={[
                failure.reference === null ? "A transfer" : <Ref>{failure.reference}</Ref>,
                failure.failure === null ? "failed" : failure.failure.words,
                <Time at={failure.at} />,
                failureNote(failure),
              ]}
            />
          </li>
        ),
      )}
    </Section>
  );
}

export function Related(props: { view: View; others: Others }): JSX.Element | null {
  if (props.view.related.length === 0) {
    return null;
  }
  return (
    <Section title="Related records">
      {props.view.related.map((item: View["related"][number]): JSX.Element => {
        const shared: string[] = props.view.accounts
          .filter((account: SupplierAccountView): boolean => account.alsoOn.includes(item.key))
          .map((account: SupplierAccountView): string => account.letter);
        const sameName: boolean = item.why.includes("same-name");
        const sameAccount: boolean = item.why.includes("same-account");
        const why: string =
          sameName && sameAccount
            ? `Same name, and shares ${shared.length === 0 ? "an account" : accountsText(shared)}.`
            : sameName
              ? "Same name."
              : `Shares ${shared.length === 0 ? "an account" : accountsText(shared)}.`;
        return (
          <li key={item.key}>
            <OtherRecord supplierKey={item.key} name={item.name} others={props.others} />
            <p class="sup-lines__note">{`${why} PayOnce keeps the two records apart and copies nothing between them.`}</p>
          </li>
        );
      })}
    </Section>
  );
}

import type { ComponentChildren, JSX } from "preact";
import { useId } from "preact/hooks";
import { query } from "../../api";
import { LinkButton } from "../../components/Action";
import { Money, Theirs } from "../../components/Text";
import { paymentHref, runHref, supplierHref } from "../../router";
import { count } from "../../text";
import type { DuplicateView, IncidentView, Money as MoneyView, SupplierBrief } from "../../types";
import { sameMoney } from "./parts";

// The right rail (ia.md 3.5): the supplier, the money and what is related. On a
// narrow screen it follows the tabs.

function Box(props: { title: string; children: ComponentChildren }): JSX.Element {
  const id: string = useId();
  return (
    <section class="card pay-box" aria-labelledby={id}>
      <h2 class="pay-box__title" id={id}>
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function Supplier(props: { supplier: SupplierBrief }): JSX.Element {
  const s: SupplierBrief = props.supplier;
  const ending: string | null = s.phone.onFile?.removed === true ? null : (s.phone.onFile?.ending ?? s.phoneEnding);
  return (
    <Box title="Supplier">
      {s.key === null ? (
        <Theirs text={s.name} class="pay-box__lead" />
      ) : (
        <a class="pay-box__lead" href={supplierHref(s.key)}>
          <Theirs text={s.name} />
        </a>
      )}
      {s.account === null ? null : (
        <p>
          <Theirs text={s.account.label} />
        </p>
      )}
      <p class="pay-box__line">{ending === null ? "No phone on file" : `Phone on file: ending ${ending}`}</p>
      {s.phone.pending === null ? null : <p class="pay-box__line pay-warn">A new number waits for a second person.</p>}
      {s.emailDomain === null ? null : (
        <p class="pay-box__line">
          {"Email domain: "}
          <Theirs text={s.emailDomain} />
        </p>
      )}
      {s.cautions.length === 0 ? null : (
        <div class="pay-box__caution">
          <strong>{`${count(s.cautions.length, "caution")} on the supplier record`}</strong>
          <ul class="pay-box__cautions">
            {s.cautions.map(
              (caution: SupplierBrief["cautions"][number]): JSX.Element => (
                <li key={caution.code}>{caution.text}</li>
              ),
            )}
          </ul>
          {s.key === null ? null : (
            <a class="pay-box__caution-link" href={supplierHref(s.key)}>
              Open the supplier record
            </a>
          )}
        </div>
      )}
      {s.key === null ? null : (
        <LinkButton href={query("#new-payment", { supplier: s.key })} class="btn--block">
          New payment to this supplier
        </LinkButton>
      )}
    </Box>
  );
}

function MoneyBox(props: { view: IncidentView }): JSX.Element {
  const m: IncidentView["money"] = props.view.money;
  const wallet: string = props.view.payment.wallet;
  const from: MoneyView | null = m.fromWallet;
  return (
    <Box title="Money">
      <Money money={m.amount} class="pay-box__amount" />
      <p class="pay-box__line">{`Paid from the ${wallet} wallet`}</p>
      {from === null || sameMoney(from, m.amount) ? null : (
        <p class="pay-box__line">
          {"Promised, waiting or with the bank: "}
          <Money money={from} />
        </p>
      )}
      {m.feesKept.length === 0 ? null : (
        <p class="pay-box__line">
          {"Fees so far: "}
          {m.feesKept.map(
            (fee: MoneyView, index: number): JSX.Element => (
              <span key={index}>
                {index === 0 ? null : ", "}
                <Money money={fee} />
              </span>
            ),
          )}
          {" kept by the bank on failed transfers"}
        </p>
      )}
      {m.headroom === null || m.headroom.now === null ? null : (
        <p class="pay-box__line">
          {`${m.headroom.wallet} headroom: `}
          <Money money={m.headroom.now} />
        </p>
      )}
      <a class="pay-box__link" href="#treasury/cash">
        Open Treasury › Cash
      </a>
    </Box>
  );
}

function Related(props: { view: IncidentView }): JSX.Element {
  const v: IncidentView = props.view;
  const r: IncidentView["related"] = v.related;
  const inbox: number = r.inbox.offered + r.inbox.named;
  return (
    <Box title="Related">
      {r.outage === null ? null : (
        <a class="pay-box__link" href={`#outage/${r.outage.id}`}>{`Outage ${r.outage.id} on ${r.outage.rail}`}</a>
      )}
      {v.payment.run === null ? null : (
        <a class="pay-box__link" href={runHref(v.payment.run.id)}>{`Pay run ${v.payment.run.id}, row ${v.payment.run.line}`}</a>
      )}
      {r.secondBills.length === 0 ? (
        <p class="pay-box__line">No possible second bills.</p>
      ) : (
        <ul class="pay-box__list">
          {r.secondBills.map(
            (bill: DuplicateView): JSX.Element => (
              <li key={bill.invoiceId}>
                {"Possible second bill of "}
                <a class="ref" href={paymentHref(bill.invoiceId)}>
                  {bill.invoiceId}
                </a>
                {` · ${bill.label}`}
              </li>
            ),
          )}
        </ul>
      )}
      {inbox === 0 ? (
        <p class="pay-box__line">No emails in the inbox name this payment.</p>
      ) : (
        <a class="pay-box__link" href={query("#inbox", { for: v.payment.invoiceId })}>
          {inbox === 1 ? "1 email in the inbox may be about this payment" : `${inbox} emails in the inbox may be about this payment`}
        </a>
      )}
    </Box>
  );
}

export function Rail(props: { view: IncidentView }): JSX.Element {
  return (
    <aside class="pay-rail" aria-label="Supplier, money and related">
      <Supplier supplier={props.view.supplier} />
      <MoneyBox view={props.view} />
      <Related view={props.view} />
    </aside>
  );
}

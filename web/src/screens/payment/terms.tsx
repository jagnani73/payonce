import type { JSX } from "preact";
import { Money, Ref, Theirs, Time, When } from "../../components/Text";
import { paymentHref } from "../../router";
import { capitalised } from "../../text";
import type { DuplicateView, TermsView } from "../../types";
import { PayTo } from "./parts";

// What an approval covers (ia.md 3.3, item 1): the request's terms line by line.

function Original(props: { original: NonNullable<TermsView["original"]> }): JSX.Element {
  const o: NonNullable<TermsView["original"]> = props.original;
  const failure: string =
    o.failure === null ? "" : `, ${o.failure.words} (${o.failure.resendable ? "a resend can fix it" : "a resend cannot fix it"})`;
  return (
    <li>
      {"Original "}
      {o.reference === null ? null : <Ref>{o.reference}</Ref>}
      {`: ${o.stateLabel.toLowerCase()}${failure}`}
    </li>
  );
}

function SecondBill(props: { duplicate: DuplicateView }): JSX.Element {
  const d: DuplicateView = props.duplicate;
  const account: string = d.sameAccount === true ? ", to the same account" : d.sameAccount === false ? ", to another account" : "";
  return (
    <li>
      {"Looks like a second bill for "}
      <a class="ref" href={paymentHref(d.invoiceId)}>
        {d.invoiceId}
      </a>
      {` (${d.label}`}
      {d.paidBy === null ? null : (
        <>
          {", paid by "}
          <Ref>{d.paidBy}</Ref>
        </>
      )}
      {`${account})`}
    </li>
  );
}

// still: whether the number the callback was made on is still the one on file.
function Callback(props: { callback: NonNullable<TermsView["callback"]>; still: boolean | null }): JSX.Element {
  const c: NonNullable<TermsView["callback"]> = props.callback;
  return (
    <li>
      {"Bank details verified by "}
      <Theirs text={c.calledBy} />
      {"'s callback to the number on file then"}
      {c.numberEnding === null ? null : ` (ending ${c.numberEnding})`}
      {props.still === true ? ", still on file" : null}
      {c.calledAt === null ? null : (
        <>
          {", "}
          <When at={c.calledAt} />
        </>
      )}
      {". They spoke to "}
      <Theirs text={c.spokeTo} />
      {", who confirmed: "}
      <Theirs text={c.confirmed} quote />
      {props.still === false ? (
        <span class="pay-warn pay-terms__changed">That number is no longer on file: the supplier's phone changed after the call.</span>
      ) : null}
    </li>
  );
}

export function Terms(props: { terms: TermsView; wallet: string; callbackOnFile: boolean | null }): JSX.Element {
  const t: TermsView = props.terms;
  const arrival: { text: string; atRisk: boolean } | null =
    t.arrival === null ? null : (t.arrival.sentToday ?? { text: t.arrival.text, atRisk: t.arrival.atRisk });
  return (
    <div class="terms">
      <h3 class="terms__title">What an approval covers</h3>
      <ul class="terms__list">
        <li class="terms__lead">
          {"Pay "}
          <Money money={t.pay} />
          {" to "}
          <PayTo supplier={t.supplier} label={t.account.label} />
          {t.accountOnFile ? " (the account on file)" : null}
        </li>
        {t.fx === null ? (
          <li>{`From the ${props.wallet} wallet`}</li>
        ) : (
          <li>
            {"Takes "}
            <Money money={t.fx.takes} />
            {` from the ${t.fx.takes.currency} wallet at ${t.fx.rate}`}
            {t.fx.markup === null ? null : `, ${t.fx.markup}`}
            {t.feeEstimate === null ? null : (
              <>
                {" · transfer fee about "}
                <Money money={t.feeEstimate} />
              </>
            )}
            {" · quote ends "}
            <Time at={t.fx.validTo} mode="until" />
          </li>
        )}
        <li>{`Why: ${capitalised(t.reason.text)}`}</li>
        {t.original === null ? null : <Original original={t.original} />}
        {t.emails === null ? null : <li>{`Emails: ${t.emails}`}</li>}
        {t.duplicates.map(
          (duplicate: DuplicateView): JSX.Element => (
            <SecondBill key={duplicate.invoiceId} duplicate={duplicate} />
          ),
        )}
        {t.callback === null ? null : <Callback callback={t.callback} still={props.callbackOnFile} />}
        {arrival === null ? null : <li class={arrival.atRisk ? "pay-warn" : undefined}>{`Arrival: ${arrival.text}`}</li>}
      </ul>
      <p class="terms__foot">Approving covers these exact terms and one transfer. If anything changes, PayOnce opens a new request.</p>
    </div>
  );
}

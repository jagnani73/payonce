import type { JSX } from "preact";
import { Money, Ref, Theirs, Time } from "../../components/Text";
import { sameMe } from "../../me";
import { paymentHref } from "../../router";
import type { ApproverChoice, Barred, DuplicateView, RequestView, TermsView } from "../../types";
import { Dotted, PayTo, sentence } from "./parts";

// What an approval covers (ia.md 3.3, item 1): the request's terms line by line,
// then who has signed, who can and who can't.

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
          {", on "}
          <Time at={c.calledAt} />
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
    <div class="pay-terms">
      <h3 class="pay-terms__title">What an approval covers</h3>
      <ul class="pay-terms__list">
        <li class="pay-terms__lead">
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
        <li>{`Why: ${sentence(t.reason.text)}`}</li>
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
      <p class="pay-terms__foot">Approving covers these exact terms and one transfer. If anything changes, PayOnce opens a new request.</p>
    </div>
  );
}

function cannot(choice: ApproverChoice): string {
  return choice.why?.code === "over-limit" ? `limit ${choice.limit.text}` : (choice.why?.text ?? "can't approve");
}

function Name(props: { name: string; me: string | null }): JSX.Element {
  return props.me !== null && sameMe(props.name, props.me) ? (
    <strong>
      <Theirs text={props.name} />
    </strong>
  ) : (
    <Theirs text={props.name} />
  );
}

function Signoffs(props: { request: RequestView }): JSX.Element {
  const r: RequestView = props.request;
  if (r.signoffs.length === 0) {
    return <>{`0 of ${r.needed} signoffs`}</>;
  }
  return (
    <>
      {`${r.signoffs.length} of ${r.needed}: approved by `}
      {r.signoffs.map(
        (signoff: { name: string; at: string }, index: number): JSX.Element => (
          <span key={signoff.name}>
            {index === 0 ? null : " and "}
            <Theirs text={signoff.name} />
            {" at "}
            <Time at={signoff.at} />
          </span>
        ),
      )}
    </>
  );
}

// "0 of 1 signoffs" or "1 of 2: approved by Alex at 14:02", then, while the
// request waits, who can approve it and who can't, the You are name in bold.
export function Signers(props: { request: RequestView; me: string | null }): JSX.Element {
  const r: RequestView = props.request;
  const me: string | null = props.me;
  const waiting: boolean = r.state === "waiting";
  const can: ApproverChoice[] = r.approvers.filter((choice: ApproverChoice): boolean => choice.canApprove);
  const isBarred = (name: string): boolean => r.barred.some((entry: Barred): boolean => sameMe(entry.name, name));
  const cant: ApproverChoice[] = r.approvers.filter(
    (choice: ApproverChoice): boolean => !choice.canApprove && !choice.signed && !isBarred(choice.name),
  );
  return (
    <div class="pay-signers">
      <div class="pay-signers__group">
        <span class="pay-signers__label">Signoffs</span>
        <span class="pay-signers__value">
          <Signoffs request={r} />
        </span>
        {r.needed > 1 && r.neededWhy !== null ? <span class="pay-signers__why">{`Needs two signoffs because ${r.neededWhy.text}.`}</span> : null}
      </div>
      {waiting ? (
        <div class="pay-signers__group">
          <span class="pay-signers__label">Can approve</span>
          <span class="pay-signers__value">
            {can.length === 0 ? (
              "Nobody left who can approve"
            ) : (
              <Dotted
                parts={can.map(
                  (choice: ApproverChoice): JSX.Element => (
                    <>
                      <Name name={choice.name} me={me} />
                      {` (up to ${choice.limit.text})`}
                    </>
                  ),
                )}
              />
            )}
          </span>
        </div>
      ) : null}
      {!waiting || (r.barred.length === 0 && cant.length === 0) ? null : (
        <div class="pay-signers__group">
          <span class="pay-signers__label">Can't approve</span>
          <span class="pay-signers__value pay-signers__value--off">
            <Dotted
              parts={[
                ...r.barred.map(
                  (entry: Barred): JSX.Element => (
                    <>
                      <Name name={entry.name} me={me} />
                      {`: ${entry.why.text}`}
                    </>
                  ),
                ),
                ...cant.map(
                  (choice: ApproverChoice): JSX.Element => (
                    <>
                      <Name name={choice.name} me={me} />
                      {`: ${cannot(choice)}`}
                    </>
                  ),
                ),
              ]}
            />
          </span>
        </div>
      )}
    </div>
  );
}

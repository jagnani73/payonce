import type { JSX } from "preact";
import { Details } from "../../components/Action";
import { Dotted, Money, Ref, Theirs, Time } from "../../components/Text";
import { ToneBadge } from "../../components/Tone";
import { Empty } from "../../components/States";
import type { IncidentView, TransferView } from "../../types";

// The Transfers tab (ia.md 3.4): every transfer on the payment, newest first,
// each with its state, a failure in words, money, the account and what the
// bank or PayOnce found. Raw ids stay in Details.

const KIND_LABELS: Record<TransferView["kind"], string> = {
  original: "Original",
  replacement: "Replacement",
  "outside-payout": "Payout sent outside PayOnce",
  unrecognised: "Unrecognised transfer",
};

const FAILED: ReadonlySet<TransferView["state"]> = new Set<TransferView["state"]>(["failed", "refused", "never-sent"]);

function StateLine(props: { transfer: TransferView }): JSX.Element {
  const t: TransferView = props.transfer;
  return (
    <div class="pay-transfer__state">
      <ToneBadge tone={t.tone} label={t.stateLabel} />
      {t.state === "with-bank" && t.deadlineAt !== null ? (
        <span class={t.pastDeadline ? "pay-warn" : "muted"}>
          {t.pastDeadline ? "past its bank deadline, " : "due "}
          <Time at={t.deadlineAt} />
        </span>
      ) : null}
      {t.failure === null || !FAILED.has(t.state) ? null : (
        <span class="muted">{t.failure.resendable ? "a resend can fix it" : "a resend cannot fix it"}</span>
      )}
    </div>
  );
}

function AccountLine(props: { transfer: TransferView }): JSX.Element | null {
  const t: TransferView = props.transfer;
  const a: TransferView["account"] = t.account;
  if (t.sentAt === null && a === null) {
    return null;
  }
  const check: JSX.Element | string | null =
    a === null
      ? null
      : a.check === "misdirected"
        ? <span class="pay-warn">went to other bank details</span>
        : a.check === "matches"
          ? t.onRequest === null
            ? "matches the account on file at the time"
            : "matches the approved account"
          : a.check === "no-details"
            ? "Airwallex gave no bank details for it"
            : null;
  return (
    <p class="pay-transfer__line">
      <Dotted
        parts={[
          t.sentAt === null ? null : (
            <>
              {"Sent "}
              <Time at={t.sentAt} />
            </>
          ),
          a === null ? null : (
            <>
              {"to "}
              <Theirs text={a.label} />
            </>
          ),
          check,
        ]}
      />
    </p>
  );
}

function Transfer(props: { transfer: TransferView; wallet: string }): JSX.Element {
  const t: TransferView = props.transfer;
  return (
    <article class="pay-transfer">
      <h3 class="pay-transfer__title">
        {KIND_LABELS[t.kind]}
        {t.reference === null ? null : (
          <>
            {" "}
            <Ref>{t.reference}</Ref>
          </>
        )}
      </h3>
      <StateLine transfer={t} />
      {t.took === null && t.fee === null ? null : (
        <p class="pay-transfer__line">
          <Dotted
            parts={[
              t.took === null ? null : (
                <>
                  <Money money={t.took} />
                  {` from the ${props.wallet} wallet`}
                </>
              ),
              t.fee === null ? null : (
                <>
                  {"fee "}
                  <Money money={t.fee} />
                </>
              ),
            ]}
          />
        </p>
      )}
      <AccountLine transfer={t} />
      {t.paidAt === null ? null : (
        <p class="pay-transfer__line">
          {"Paid "}
          <Time at={t.paidAt} />
        </p>
      )}
      {t.onRequest === null ? null : (
        <p class="pay-transfer__line">
          {`On request #${t.onRequest.id}`}
          {t.onRequest.approvedBy.length === 0 ? null : (
            <>
              {", approved by "}
              {t.onRequest.approvedBy.map(
                (name: string, index: number): JSX.Element => (
                  <span key={name}>
                    {index === 0 ? null : " and "}
                    <Theirs text={name} />
                  </span>
                ),
              )}
            </>
          )}
        </p>
      )}
      {t.fx === null ? null : (
        <p class="pay-transfer__line">
          {`At ${t.fx.rate}`}
          {t.fx.markup === null ? null : `, ${t.fx.markup}`}
          {": takes "}
          <Money money={t.fx.takes} />
          {", delivers "}
          <Money money={t.fx.delivers} />
        </p>
      )}
      {t.rateMismatch ? <p class="pay-transfer__line pay-danger">Went out at a rate nobody approved</p> : null}
      {t.foundLateAt === null ? null : (
        <p class="pay-transfer__line pay-warn">
          {"Found late in Airwallex at "}
          <Time at={t.foundLateAt} />
        </p>
      )}
      {t.pays === null ? null : <p class="pay-transfer__line">{t.pays ? "Pays this payment" : "Does not match this payment"}</p>}
      {t.arrival === null || FAILED.has(t.state) ? null : (
        <details class="details pay-transfer__arrival">
          <summary>{t.arrival.atRisk ? `Arrival: may miss the due date` : "Arrival estimate"}</summary>
          <p class="pay-transfer__line">{t.arrival.sentToday?.text ?? t.arrival.text}</p>
          <p class="pay-transfer__line muted">{t.arrival.note}</p>
        </details>
      )}
      <Details
        rows={[
          { label: "Transfer id", value: t.details.transferId, copy: true },
          { label: "Request id", value: t.details.requestId, copy: true },
          { label: "Bank status", value: t.details.bankStatus },
          { label: "Failure code", value: t.failure?.code ?? null },
        ]}
      />
    </article>
  );
}

export function TransfersTab(props: { view: IncidentView }): JSX.Element {
  const transfers: TransferView[] = props.view.transfers;
  if (transfers.length === 0) {
    return <Empty title="No transfers yet. PayOnce sends the first one when its checks pass." />;
  }
  return (
    <div class="pay-list">
      {transfers.map(
        (transfer: TransferView, index: number): JSX.Element => (
          <Transfer key={`${transfer.kind}-${transfer.details.transferId ?? transfer.details.requestId ?? index}`} transfer={transfer} wallet={props.view.payment.wallet} />
        ),
      )}
    </div>
  );
}

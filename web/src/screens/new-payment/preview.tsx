import type { ComponentChildren, JSX } from "preact";
import { Icon, type IconName } from "../../components/Icon";
import { Money } from "../../components/Text";
import type { HeadroomLine, PaymentCheckView } from "../../types";

// "What happens next": the server's answer to POST /api/payments/check for the
// form as it is, one line each. The last answer stays on screen while the next
// check runs. The sandbox line sits apart in a box marked as the simulator's, so
// it never reads as part of the payment.

type LineTone = "plain" | "amber" | "muted";

function Line(props: { icon: IconName; tone: LineTone; children: ComponentChildren; live?: boolean }): JSX.Element {
  return (
    <li class={`np-next__line np-next__line--${props.tone}`} aria-live={props.live === true ? "polite" : undefined}>
      <Icon name={props.icon} class="np-next__icon" />
      <span>{props.children}</span>
    </li>
  );
}

const OUTCOME_LOOK: Record<PaymentCheckView["outcome"]["kind"], { icon: IconName; tone: LineTone }> = {
  send: { icon: "payment", tone: "plain" },
  hold: { icon: "pause", tone: "amber" },
  paused: { icon: "outage", tone: "amber" },
  unknown: { icon: "circle", tone: "muted" },
};

// The box already says it is the simulator's, so its line drops the server's
// "Sandbox: " lead.
function sandboxSentence(text: string): string {
  const rest: string = text.startsWith("Sandbox: ") ? text.slice("Sandbox: ".length) : text;
  return `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}


function HeadroomText(props: { headroom: HeadroomLine }): JSX.Element {
  const { wallet, now, after, floorSource } = props.headroom;
  const floorNote: string =
    floorSource === "not-set" ? ` ${wallet} has no reserve floor set.` : floorSource === "unreadable" ? ` PayOnce can't read the ${wallet} reserve floor.` : "";
  if (after !== null) {
    return (
      <>
        {`${wallet} headroom after it: `}
        <Money money={after} />
        {`.${floorNote}`}
      </>
    );
  }
  return (
    <>
      {`${wallet} headroom now: `}
      <Money money={now} />
      {`. PayOnce knows how much it takes from this wallet once a person approves the exchange rate.${floorNote}`}
    </>
  );
}

export function NextSteps(props: {
  check: PaymentCheckView | null;
  // The form lacks what a check needs: say what to fill in instead.
  waitingFor: string | null;
  // The form changed since the answer on screen.
  stale: boolean;
  // Fields the form marks, so the outcome can point at them.
  marked: boolean;
  error: string | null;
  // Show the headroom-unknown line: the amount and wallet are filled in.
  wantsHeadroom: boolean;
  sandboxError: string | null;
}): JSX.Element {
  const check: PaymentCheckView | null = props.check;
  const fieldProblems: boolean = check !== null && Object.keys(check.fields).length > 0;
  const outcomeText: string =
    props.waitingFor !== null
      ? props.waitingFor
      : check === null
        ? "PayOnce is checking the payment…"
        : fieldProblems
          ? props.marked
            ? "Fix the marked fields to see what happens next."
            : "Fill in the form to see what happens next."
          : check.outcome.text;
  const look: { icon: IconName; tone: LineTone } =
    props.waitingFor !== null || check === null || fieldProblems ? OUTCOME_LOOK.unknown : OUTCOME_LOOK[check.outcome.kind];

  const headroom: HeadroomLine | null = props.waitingFor === null ? (check?.headroom ?? null) : null;
  return (
    <aside class="card np-next" aria-labelledby="np-next-title" aria-busy={props.stale}>
      <div class="np-next__head">
        <h2 class="card__title" id="np-next-title">
          What happens next
        </h2>
        {props.stale ? <span class="np-next__checking">Checking…</span> : null}
      </div>
      <ul class="np-next__list">
        <Line icon={look.icon} tone={look.tone} live>
          {outcomeText}
        </Line>
        {props.waitingFor !== null || fieldProblems || check?.approvers === null || check?.approvers === undefined ? null : (
          <Line icon="approval" tone="plain">
            {check.approvers.text}
          </Line>
        )}

        {headroom !== null ? (
          <Line icon="bank" tone="plain">
            <HeadroomText headroom={headroom} />
          </Line>
        ) : props.wantsHeadroom && check !== null && !fieldProblems ? (
          <Line icon="bank" tone="muted">
            Headroom unknown: PayOnce hasn't read the wallet balances from Airwallex yet.
          </Line>
        ) : null}
        {props.waitingFor !== null
          ? null
          : (check?.warnings ?? []).map(
              (warning: string): JSX.Element => (
                <Line icon="warning" tone="amber" key={warning}>
                  {warning}
                </Line>
              ),
            )}
      </ul>
      {props.error === null ? null : (
        <p class="inline-error" role="alert">
          {`Couldn't check the payment: ${props.error}`}
        </p>
      )}
      <div class="np-sandbox">
        <span class="sandbox-tag">Sandbox tool</span>
        <p class="np-sandbox__text">
          {check?.sandbox === null || check?.sandbox === undefined
            ? "The simulator plays the bank for this payment's first transfer."
            : sandboxSentence(check.sandbox.text)}{" "}
          <a href="#sandbox">Change in the simulator</a>
        </p>
        {props.sandboxError === null ? null : (
          <p class="field__error" role="alert">
            {props.sandboxError}
          </p>
        )}
      </div>
    </aside>
  );
}

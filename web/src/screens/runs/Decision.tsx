import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { postJson } from "../../api";
import { ActionButton } from "../../components/Action";
import { ApproveForm, DecisionCard, OptionCard, Options, RequestLine, Signers } from "../../components/Decision";
import { EndOutageForm } from "../../components/EndOutage";
import { Field, NameField, type ControlProps } from "../../components/Form";
import { Callout } from "../../components/Notice";
import { Said, Theirs } from "../../components/Text";
import { useNameDraft } from "../../me";
import { notify } from "../../notices";
import { joinNames, moneyText } from "../../text";
import type { Acted, Caution, RunCashView, RunDecisionOption, RunRequestView, RunTermsView, RunView } from "../../types";

// A waiting pay run's Decision panel (ia.md section 6, as the payment page's
// 3.3): what an approval covers, the cautions, the signoffs, who can and can't
// approve, then one option chosen at a time with its form. Every action answers
// the fresh run, which the panel re-renders from; a refusal shows under its
// button and the run is read again, so the panel shows the request as it is now.

type Kind = RunDecisionOption["kind"];

const NUMBERS: readonly string[] = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function words(n: number): string {
  return NUMBERS[n] ?? String(n);
}

function rowsText(lines: number[]): string {
  const list: string = joinNames(lines.map(String), "and");
  return lines.length === 1 ? `Row ${list}` : `Rows ${list}`;
}

function Terms(props: { terms: RunTermsView; request: RunRequestView }): JSX.Element {
  const terms: RunTermsView = props.terms;
  const request: RunRequestView = props.request;
  const plain: RunTermsView["domains"] = terms.domains.filter((domain: RunTermsView["domains"][number]): boolean => !domain.caution);
  return (
    <div class="terms">
      <h3 class="terms__title">What an approval covers</h3>
      <ul class="terms__list">
        <li class="terms__lead">
          {`Pay ${terms.payments === 1 ? "1 payment" : `${terms.payments} payments`}: `}
          {terms.totals
            .map(
              (total: RunTermsView["totals"][number]): string =>
                `${moneyText(total.total)} (${total.floor === null ? "no floor set" : `floor ${moneyText(total.floor)}`})`,
            )
            .join(" · ")}
        </li>
        <li>
          {`Largest total ${moneyText(terms.largest)} is what approver limits are checked against.`}
          {request.needed > 1 ? (
            <>
              {` It needs ${words(request.needed)} signoffs`}
              {request.neededWhy === null ? "." : ": "}
              {request.neededWhy === null ? null : (
                <>
                  <Theirs text={request.neededWhy.text} />.
                </>
              )}
            </>
          ) : null}
        </li>
        {terms.newPayees.length === 0 ? null : (
          <li>{`${rowsText(terms.newPayees)} ${terms.newPayees.length === 1 ? "pays a new payee" : "pay new payees"}.`}</li>
        )}
        {terms.callbackRows.length === 0 ? null : (
          <li>{`A callback verified the bank details on ${rowsText(terms.callbackRows).toLowerCase()}.`}</li>
        )}
        {plain.map(
          (domain: RunTermsView["domains"][number]): JSX.Element => (
            <li key={`domain-${domain.line}`}>
              <Theirs text={domain.text} />
            </li>
          ),
        )}
      </ul>
      {terms.arrivals.length === 0 ? null : (
        <details class="details">
          <summary>{terms.arrivals.length === 1 ? "Arrival estimate for 1 row" : `Arrival estimates for ${terms.arrivals.length} rows`}</summary>
          <ul class="run-terms__arrivals">
            {terms.arrivals.map(
              (arrival: RunTermsView["arrivals"][number]): JSX.Element => (
                <li key={arrival.line} class={arrival.advice.atRisk ? "is-warn" : undefined}>
                  {`Row ${arrival.line} (${arrival.invoiceId}): ${arrival.advice.text}`}
                </li>
              ),
            )}
          </ul>
        </details>
      )}
      <p class="terms__foot">
        Approving covers these exact terms and one transfer per paying row. If anything changes before release, the run needs a re-check.
      </p>
    </div>
  );
}

function Cautions(props: { cautions: Caution[]; terms: RunTermsView | null }): JSX.Element | null {
  const domains: RunTermsView["domains"] = props.terms?.domains.filter((domain: RunTermsView["domains"][number]): boolean => domain.caution) ?? [];
  if (props.cautions.length === 0 && domains.length === 0) {
    return null;
  }
  return (
    <div class="decision__cautions">
      {props.cautions.map(
        (caution: Caution): JSX.Element => (
          <Callout tone="warning" key={caution.code}>
            <Said text={caution.text} />
          </Callout>
        ),
      )}
      {domains.map(
        (domain: RunTermsView["domains"][number]): JSX.Element => (
          <Callout tone="warning" key={`domain-${domain.line}`}>
            <Theirs text={domain.text} />
          </Callout>
        ),
      )}
    </div>
  );
}

function RecheckForm(props: { runId: number; onActed: (view: RunView) => void }): JSX.Element {
  return (
    <div class="option-form option-form--row">
      <ActionButton
        label="Re-check run"
        busyLabel="Re-checking…"
        kind="primary"
        onAction={async (): Promise<void> => {
          const acted: Acted<RunView> = await postJson<Acted<RunView>>(`/api/runs/${props.runId}/check`, {});
          props.onActed(acted.view);
          notify(acted.notice);
        }}
      />
      <span class="muted">Reads Airwallex only. Nothing is sent.</span>
    </div>
  );
}

function CancelForm(props: { runId: number; onActed: (view: RunView) => void }): JSX.Element {
  const [name, setName] = useNameDraft();
  const [note, setNote] = useState<string>("");
  const [missing, setMissing] = useState<boolean>(false);
  return (
    <div class="option-form">
      <Field label="Why are you cancelling it?" error={missing ? "Say why you are cancelling it." : null}>
        {(control: ControlProps): JSX.Element => (
          <input
            {...control}
            class="input"
            type="text"
            maxLength={200}
            required
            placeholder="Wrong file uploaded"
            value={note}
            onInput={(event: Event): void => {
              setNote((event.currentTarget as HTMLInputElement).value);
              setMissing(false);
            }}
          />
        )}
      </Field>
      <NameField label="Cancelling as" value={name} onInput={setName} />
      <div>
        <ActionButton
          label="Cancel run"
          busyLabel="Cancelling…"
          kind="danger"
          onAction={async (): Promise<void> => {
            if (note.trim() === "") {
              setMissing(true);
              return;
            }
            const acted: Acted<RunView> = await postJson<Acted<RunView>>(`/api/runs/${props.runId}/cancel`, {
              cancelledBy: name,
              note: note.trim(),
            });
            props.onActed(acted.view);
            notify(acted.notice);
          }}
        />
      </div>
    </div>
  );
}

function CashLine(props: { cash: RunCashView[] }): JSX.Element | null {
  if (props.cash.length === 0) {
    return null;
  }
  return (
    <p class="run-decision__cash">
      {"Cash after this run: "}
      {props.cash.map(
        (wallet: RunCashView, index: number): JSX.Element => (
          <span key={wallet.currency} class={wallet.short === null ? undefined : "is-warn"}>
            {index === 0 ? null : " · "}
            {`${wallet.currency} wallet ${wallet.left === null ? "not known" : `${moneyText(wallet.left)} left`}`}
            {wallet.floor === null ? ", no reserve floor set" : `, floor ${moneyText(wallet.floor)}`}
            {wallet.short === null ? null : `, short by ${moneyText(wallet.short)}`}
          </span>
        ),
      )}
    </p>
  );
}

const DO_WORDS: Record<string, Kind> = { approve: "approve", recheck: "recheck", cancel: "cancel", "end-outage": "end-outage" };

export function RunDecision(props: {
  view: RunView;
  decision: NonNullable<RunView["decision"]>;
  asked: string | null;
  onActed: (view: RunView) => void;
  refresh: () => void;
}): JSX.Element {
  const decision: NonNullable<RunView["decision"]> = props.decision;
  const runId: number = props.view.run.id;
  const request: RunRequestView | null = decision.request;
  const [picked, setPicked] = useState<Kind | null>(props.asked === null ? null : (DO_WORDS[props.asked] ?? null));
  const usable: RunDecisionOption[] = decision.options.filter((option: RunDecisionOption): boolean => option.can.allowed);
  const chosen: RunDecisionOption | undefined = usable.find((option: RunDecisionOption): boolean => option.kind === picked) ?? usable[0];
  return (
    <DecisionCard aside={<RequestLine request={request} noun="Run request" none="No request is open. Re-check the run to open one." />}>
      {request === null ? null : <Terms terms={request.terms} request={request} />}
      <Cautions cautions={decision.cautions} terms={request?.terms ?? null} />
      {request === null ? null : <Signers request={request} />}
      <Options>
        {decision.options.map(
          (option: RunDecisionOption): JSX.Element => (
            <OptionCard
              key={option.kind}
              option={option}
              name={`run-${runId}-decision`}
              chosen={option === chosen}
              onPick={(): void => setPicked(option.kind)}
            />
          ),
        )}
      </Options>
      {chosen === undefined ? null : chosen.kind === "approve" ? (
        <ApproveForm
          key={chosen.requestId}
          approvers={chosen.approvers}
          can={chosen.can}
          empty="Approve run"
          onApprove={async (approver: string): Promise<void> => {
            const acted: Acted<RunView> = await postJson<Acted<RunView>>(`/api/runs/${runId}/approve`, { approver, approvalId: chosen.requestId });
            props.onActed(acted.view);
            notify(acted.notice);
          }}
          onRefused={props.refresh}
        />
      ) : chosen.kind === "recheck" ? (
        <RecheckForm runId={runId} onActed={props.onActed} />
      ) : chosen.kind === "cancel" ? (
        <CancelForm runId={runId} onActed={props.onActed} />
      ) : (
        <EndOutageForm outageId={chosen.outageId} rail={chosen.rail} enders={chosen.enders} can={chosen.can} onEnded={props.refresh} onRefused={props.refresh} />
      )}
      <CashLine cash={props.view.cash.currencies} />
    </DecisionCard>
  );
}

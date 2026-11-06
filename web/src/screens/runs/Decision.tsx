import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { postJson } from "../../api";
import { ActionButton } from "../../components/Action";
import { Field, firstApprover, NameField, NamePicker, type ControlProps } from "../../components/Form";
import { Callout } from "../../components/Notice";
import { Theirs, Time } from "../../components/Text";
import { sameMe, useMe, useNameDraft } from "../../me";
import { notify } from "../../notices";
import { joinNames } from "../../text";
import type {
  Acted,
  ApproverChoice,
  Barred,
  Caution,
  EndOutageOption,
  EndOutageResult,
  RunCashView,
  RunDecisionOption,
  RunRequestView,
  RunTermsView,
  RunView,
} from "../../types";

// A waiting pay run's Decision panel (ia.md section 6, as the payment page's
// 3.3): what an approval covers, the cautions, the signoffs, who can and can't
// approve, then one option chosen at a time with its form. Every action answers
// the fresh run, which the panel re-renders from; a refusal shows under its
// button and the run is read again, so the panel shows the request as it is now.

type Kind = RunDecisionOption["kind"];
type ApproveOption = Extract<RunDecisionOption, { kind: "approve" }>;

const NUMBERS: readonly string[] = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function words(n: number): string {
  return NUMBERS[n] ?? String(n);
}

function rowsText(lines: number[]): string {
  const list: string = joinNames(lines.map(String), "and");
  return lines.length === 1 ? `Row ${list}` : `Rows ${list}`;
}

function RequestLine(props: { request: RunRequestView | null }): JSX.Element {
  const request: RunRequestView | null = props.request;
  if (request === null) {
    return <span class="run-decision__request">No request is open. Re-check the run to open one.</span>;
  }
  if (request.state === "waiting") {
    return (
      <span class="run-decision__request">
        {`Run request #${request.id} · open until `}
        <Time at={request.expiresAt} mode="until" />
      </span>
    );
  }
  if (request.state === "expired") {
    return (
      <span class="run-decision__request run-decision__request--warn">
        {`Run request #${request.id} expired at `}
        <Time at={request.expiresAt} />.
      </span>
    );
  }
  return <span class="run-decision__request">{`Run request #${request.id} · ${request.label}`}</span>;
}

function Terms(props: { terms: RunTermsView; request: RunRequestView }): JSX.Element {
  const terms: RunTermsView = props.terms;
  const request: RunRequestView = props.request;
  const plain: RunTermsView["domains"] = terms.domains.filter((domain: RunTermsView["domains"][number]): boolean => !domain.caution);
  return (
    <div class="run-terms">
      <h3 class="run-terms__title">What an approval covers</h3>
      <ul class="run-terms__list">
        <li class="run-terms__lead">
          {`Pay ${terms.payments === 1 ? "1 payment" : `${terms.payments} payments`}: `}
          {terms.totals
            .map(
              (total: RunTermsView["totals"][number]): string =>
                `${total.total.text} (${total.floor === null ? "no floor set" : `floor ${total.floor.text}`})`,
            )
            .join(" · ")}
        </li>
        <li>
          {`Largest total ${terms.largest.text} is what approver limits are checked against.`}
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
      <p class="run-terms__covers">
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
    <div class="run-decision__cautions">
      {props.cautions.map(
        (caution: Caution): JSX.Element => (
          <Callout tone="warning" key={caution.code}>
            {caution.text}
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

function Name(props: { name: string; me: string | null }): JSX.Element {
  return props.me !== null && sameMe(props.name, props.me) ? (
    <strong class="run-signers__me">
      <Theirs text={props.name} />
    </strong>
  ) : (
    <Theirs text={props.name} />
  );
}

function Signers(props: { request: RunRequestView; me: string | null }): JSX.Element {
  const request: RunRequestView = props.request;
  const can: ApproverChoice[] = request.approvers.filter((choice: ApproverChoice): boolean => choice.canApprove);
  const barredNames: Barred[] = request.barred;
  const over: ApproverChoice[] = request.approvers.filter(
    (choice: ApproverChoice): boolean => choice.why?.code === "over-limit",
  );
  const cannot: { name: string; text: string }[] = [
    ...barredNames.map((entry: Barred) => ({ name: entry.name, text: entry.why.text })),
    ...over.map((choice: ApproverChoice) => ({ name: choice.name, text: `limit ${choice.limit.text}` })),
  ];
  const signed: RunRequestView["signoffs"] = request.signoffs;
  return (
    <div class="run-signers">
      <div class="run-signers__group">
        <span class="run-signers__label">Signoffs</span>
        <span class="run-signers__value">
          {signed.length === 0 ? (
            `0 of ${request.needed} signoffs`
          ) : (
            <>
              {`${signed.length} of ${request.needed}: approved by `}
              {signed.map(
                (signoff: RunRequestView["signoffs"][number], index: number): JSX.Element => (
                  <span key={`${signoff.name}-${signoff.at}`}>
                    {index === 0 ? null : index === signed.length - 1 ? " and " : ", "}
                    <Name name={signoff.name} me={props.me} />
                    {" at "}
                    <Time at={signoff.at} />
                  </span>
                ),
              )}
            </>
          )}
        </span>
      </div>
      {request.state !== "waiting" ? null : (
        <div class="run-signers__group run-signers__group--wide">
          <span class="run-signers__label">Can approve</span>
          <span>
            {can.length === 0
              ? "Nobody left"
              : can.map(
                  (choice: ApproverChoice, index: number): JSX.Element => (
                    <span key={choice.name}>
                      {index === 0 ? null : " · "}
                      <Name name={choice.name} me={props.me} />
                      {` (up to ${choice.limit.text})`}
                    </span>
                  ),
                )}
          </span>
        </div>
      )}
      {request.state !== "waiting" || cannot.length === 0 ? null : (
        <div class="run-signers__group run-signers__group--wide">
          <span class="run-signers__label">Can't approve</span>
          <span class="run-signers__cannot">
            {cannot.map(
              (entry: { name: string; text: string }, index: number): JSX.Element => (
                <span key={`${entry.name}-${index}`}>
                  {index === 0 ? null : " · "}
                  <Name name={entry.name} me={props.me} />
                  {": "}
                  <Theirs text={entry.text} />
                </span>
              ),
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function Option(props: { option: RunDecisionOption; runId: number; on: boolean; onPick: (kind: Kind) => void }): JSX.Element {
  const option: RunDecisionOption = props.option;
  const off: boolean = !option.can.allowed;
  return (
    <label class={["run-option", props.on ? "is-on" : "", off ? "is-off" : ""].filter((name: string): boolean => name !== "").join(" ")}>
      <input
        type="radio"
        class="run-option__radio"
        name={`run-${props.runId}-decision`}
        value={option.kind}
        checked={props.on}
        disabled={off}
        onChange={(): void => props.onPick(option.kind)}
      />
      <span class="run-option__body">
        <span class="run-option__title">
          {option.title}
          {option.suggested ? <span class="run-option__pill">Suggested</span> : null}
        </span>
        {option.consequence.map(
          (line: string): JSX.Element => (
            <span class="run-option__line" key={line}>
              {line}
            </span>
          ),
        )}
        {off && option.can.why !== null ? <span class="run-option__why">{option.can.why.text}</span> : null}
      </span>
    </label>
  );
}

function ApproveForm(props: { option: ApproveOption; runId: number; onActed: (view: RunView) => void; onRefused: () => void }): JSX.Element {
  const me: string | null = useMe();
  const choices: ApproverChoice[] = props.option.approvers;
  const [picked, setPicked] = useState<string | null>(null);
  const approver: string =
    picked !== null && choices.some((choice: ApproverChoice): boolean => choice.name === picked) ? picked : firstApprover(choices, me);
  const chosen: ApproverChoice | undefined = choices.find((choice: ApproverChoice): boolean => choice.name === approver);
  return (
    <div class="run-form">
      <NamePicker label="Approving as" choices={choices} value={approver} onChange={setPicked} me={me} />
      <div>
        <ActionButton
          label={approver === "" ? "Approve run" : `Approve as ${approver}`}
          busyLabel="Approving…"
          kind="primary"
          disabled={chosen === undefined || !chosen.canApprove}
          onAction={async (): Promise<void> => {
            const acted: Acted<RunView> = await postJson<Acted<RunView>>(`/api/runs/${props.runId}/approve`, {
              approver,
              approvalId: props.option.requestId,
            });
            props.onActed(acted.view);
            notify(acted.notice);
          }}
          onError={props.onRefused}
        />
      </div>
    </div>
  );
}

function RecheckForm(props: { runId: number; onActed: (view: RunView) => void }): JSX.Element {
  return (
    <div class="run-form run-form--row">
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
    <div class="run-form">
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

function EndOutageForm(props: { option: EndOutageOption; onEnded: () => void }): JSX.Element {
  const [name, setName] = useNameDraft();
  const [note, setNote] = useState<string>("");
  const [missing, setMissing] = useState<boolean>(false);
  const enders: string[] | null = props.option.enders;
  return (
    <div class="run-form">
      <NameField
        label="Ending as"
        value={name}
        onInput={setName}
        hint={enders === null || enders.length === 0 ? undefined : `${joinNames(enders, "or")} can end it.`}
      />
      <Field label="What did you check?" error={missing ? "Say what you checked." : null}>
        {(control: ControlProps): JSX.Element => (
          <input
            {...control}
            class="input"
            type="text"
            maxLength={200}
            required
            placeholder="Airwallex status page shows USD local payouts working again"
            value={note}
            onInput={(event: Event): void => {
              setNote((event.currentTarget as HTMLInputElement).value);
              setMissing(false);
            }}
          />
        )}
      </Field>
      <div>
        <ActionButton
          label={`End outage ${props.option.outageId}`}
          busyLabel="Ending…"
          kind="primary"
          onAction={async (): Promise<void> => {
            if (note.trim() === "") {
              setMissing(true);
              return;
            }
            const result: EndOutageResult = await postJson<EndOutageResult>(`/api/outages/${props.option.outageId}/end`, {
              endedBy: name,
              note: note.trim(),
            });
            notify(result.notice);
            props.onEnded();
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
            {`${wallet.currency} wallet ${wallet.left === null ? "not known" : `${wallet.left.text} left`}`}
            {wallet.floor === null ? ", no reserve floor set" : `, floor ${wallet.floor.text}`}
            {wallet.short === null ? null : `, short by ${wallet.short.text}`}
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
  const me: string | null = useMe();
  const decision: NonNullable<RunView["decision"]> = props.decision;
  const runId: number = props.view.run.id;
  const request: RunRequestView | null = decision.request;
  const [picked, setPicked] = useState<Kind | null>(props.asked === null ? null : (DO_WORDS[props.asked] ?? null));
  const usable: RunDecisionOption[] = decision.options.filter((option: RunDecisionOption): boolean => option.can.allowed);
  const chosen: RunDecisionOption | undefined =
    usable.find((option: RunDecisionOption): boolean => option.kind === picked) ?? usable[0];
  return (
    <section class="card card--accent run-decision" aria-labelledby={`run-${runId}-decision`}>
      <div class="run-decision__head">
        <h2 id={`run-${runId}-decision`} class="run-decision__title">
          Decision
        </h2>
        <RequestLine request={request} />
      </div>
      {request === null ? null : <Terms terms={request.terms} request={request} />}
      <Cautions cautions={decision.cautions} terms={request?.terms ?? null} />
      {request === null ? null : <Signers request={request} me={me} />}
      <fieldset class="run-options">
        <legend class="run-options__legend">Choose what to do</legend>
        {decision.options.map(
          (option: RunDecisionOption): JSX.Element => (
            <Option key={option.kind} option={option} runId={runId} on={option === chosen} onPick={setPicked} />
          ),
        )}
      </fieldset>
      {chosen === undefined ? null : chosen.kind === "approve" ? (
        <ApproveForm option={chosen} runId={runId} onActed={props.onActed} onRefused={props.refresh} />
      ) : chosen.kind === "recheck" ? (
        <RecheckForm runId={runId} onActed={props.onActed} />
      ) : chosen.kind === "cancel" ? (
        <CancelForm runId={runId} onActed={props.onActed} />
      ) : (
        <EndOutageForm option={chosen} onEnded={props.refresh} />
      )}
      <CashLine cash={props.view.cash.currencies} />
    </section>
  );
}

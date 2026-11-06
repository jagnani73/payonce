import type { JSX } from "preact";
import { useId, useState } from "preact/hooks";
import { postJson } from "../../api";
import { ActionButton } from "../../components/Action";
import { Theirs, Time } from "../../components/Text";
import { useSettings } from "../../settings";
import type { AskWhyAnswer, IncidentView, SettingsView, SummaryBullet } from "../../types";
import { WithRefs, type Acts } from "./parts";

// "What happened" (ia.md 3.2): up to five bullets PayOnce builds from the ledger,
// and Ask why, where a model explains the same facts. The answer is never stored:
// it lives in this card until the page goes, and it is text PayOnce did not write.

const OFF_TEXT: string = "Turn on the email reader's model in Settings to ask why.";

function Answer(props: { answer: AskWhyAnswer; newestLine: number }): JSX.Element {
  const a: AskWhyAnswer = props.answer;
  return (
    <div class="pay-answer" aria-live="polite">
      <Theirs text={a.explanation} block class="pay-answer__text" />
      {a.notInFacts.trim() === "" ? null : (
        <p class="pay-answer__more">
          {"Not in the records: "}
          <Theirs text={a.notInFacts} />
        </p>
      )}
      {a.aliasesLeft && a.legend.length > 0 ? (
        <ul class="pay-answer__legend">
          {a.legend.map(
            (item: AskWhyAnswer["legend"][number]): JSX.Element => (
              <li key={item.alias}>
                <Theirs text={item.alias} />
                {" is "}
                <Theirs text={item.value} />
              </li>
            ),
          )}
        </ul>
      ) : null}
      <p class="pay-answer__by">
        {"Answered by "}
        <Theirs text={a.model} />
        {" at "}
        <Time at={a.at} />
        {` · from facts up to line ${a.asOf.lines}`}
        {a.cut ? " · cut to fit" : null}
      </p>
      {props.newestLine > a.asOf.lastEventId ? (
        <p class="pay-answer__stale">More has happened on this payment since this answer. Ask again to include it.</p>
      ) : null}
    </div>
  );
}

function AskWhy(props: { view: IncidentView; acts: Acts; onAnswer: (answer: AskWhyAnswer) => void }): JSX.Element {
  const settings: SettingsView | null = useSettings();
  const on: boolean = props.view.askWhy.allowed && settings?.reader.askWhy.on !== false;
  return (
    <div class="pay-ask">
      <ActionButton
        label="Ask why"
        busyLabel="Asking…"
        disabled={!on}
        onAction={async (): Promise<void> => {
          props.onAnswer(await postJson<AskWhyAnswer>(`${props.acts.path}/why`, {}));
        }}
      />
      <p class="pay-ask__note">{on ? "A model explains these facts. Nothing is stored." : OFF_TEXT}</p>
    </div>
  );
}

export function Summary(props: { view: IncidentView; acts: Acts }): JSX.Element {
  const id: string = useId();
  const [answer, setAnswer] = useState<AskWhyAnswer | null>(null);
  const v: IncidentView = props.view;
  return (
    <section class="card pay-summary" aria-labelledby={id}>
      <div class="pay-summary__main">
        <h2 class="card__title pay-summary__title" id={id}>
          What happened
        </h2>
        {v.summary.length === 0 ? (
          <p class="muted">Nothing has happened yet.</p>
        ) : (
          <ul class="pay-bullets">
            {v.summary.map(
              (bullet: SummaryBullet): JSX.Element => (
                <li key={bullet.lead}>
                  <strong>{bullet.lead}</strong>
                  {": "}
                  <WithRefs text={bullet.text} refs={bullet.refs} self={v.payment.invoiceId} />
                </li>
              ),
            )}
          </ul>
        )}
      </div>
      <AskWhy view={v} acts={props.acts} onAnswer={setAnswer} />
      {answer === null ? null : <Answer answer={answer} newestLine={v.timeline.lines[0]?.id ?? 0} />}
    </section>
  );
}

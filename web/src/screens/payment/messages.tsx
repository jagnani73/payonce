import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { postJson } from "../../api";
import { ActionButton } from "../../components/Action";
import { Field, NameField, type ControlProps } from "../../components/Form";
import { Empty } from "../../components/States";
import { Dotted, Theirs, Time } from "../../components/Text";
import { ToneBadge } from "../../components/Tone";
import { useNameDraft } from "../../me";
import type { Acted, DraftOfferView, DraftView, IncidentView, MessagesTab as MessagesView, Tone } from "../../types";
import type { Acts } from "./parts";

// The Messages tab (ia.md 3.4): messages PayOnce drafts for a person to send,
// suggested first, then the drafts on file. PayOnce never sends one: a person
// copies the text, sends it, and marks it sent.

const TONES: Record<DraftView["state"], Tone> = {
  draft: "act",
  copied: "progress",
  sent: "done",
  dismissed: "done",
};

function audience(to: "supplier" | "bank"): string {
  return to === "bank" ? "To Airwallex" : "To the supplier";
}

function Offer(props: { offer: DraftOfferView; acts: Acts; name: string; onNoName: () => void; onDrafted: (id: number) => void }): JSX.Element {
  const o: DraftOfferView = props.offer;
  return (
    <div class="pay-offer">
      <div class="pay-offer__text">
        <span class="pay-offer__title">{o.label}</span>
        <span class="muted">
          <Dotted parts={[audience(o.audience).toLowerCase(), o.suggested && o.why !== null ? `Suggested: ${o.why}` : o.why]} />
        </span>
      </div>
      <ActionButton
        kind={o.suggested ? "primary" : "secondary"}
        label="Draft it"
        busyLabel="Drafting…"
        onAction={async (): Promise<void> => {
          if (props.name.trim() === "") {
            props.onNoName();
            return;
          }
          const acted: Acted<IncidentView> & { draftId: number } = await postJson<Acted<IncidentView> & { draftId: number }>(
            `${props.acts.path}/outbox`,
            { template: o.template, createdBy: props.name.trim() },
          );
          props.acts.done(acted);
          props.onDrafted(acted.draftId);
        }}
        onError={props.acts.refresh}
      />
    </div>
  );
}

function History(props: { draft: DraftView }): JSX.Element {
  const d: DraftView = props.draft;
  return (
    <p class="pay-draft__meta">
      <Dotted
        parts={[
          <>
            {"Drafted by "}
            <Theirs text={d.createdBy} />
            {" at "}
            <Time at={d.createdAt} />
          </>,
          d.copiedAt === null ? null : (
            <>
              {"copied"}
              {d.copiedBy === null ? null : (
                <>
                  {" by "}
                  <Theirs text={d.copiedBy} />
                </>
              )}
              {" at "}
              <Time at={d.copiedAt} />
            </>
          ),
          d.sentAt === null ? null : (
            <>
              {"marked as sent by "}
              <Theirs text={d.sentBy ?? ""} />
              {" at "}
              <Time at={d.sentAt} />
            </>
          ),
          d.dismissedAt === null ? null : (
            <>
              {"dismissed by "}
              <Theirs text={d.dismissedBy ?? ""} />
              {" at "}
              <Time at={d.dismissedAt} />
              {d.dismissNote === null ? null : (
                <>
                  {": "}
                  <Theirs text={d.dismissNote} quote />
                </>
              )}
            </>
          ),
        ]}
      />
    </p>
  );
}

function Draft(props: { draft: DraftView; acts: Acts; name: string; fresh: boolean; onNoName: () => void }): JSX.Element {
  const d: DraftView = props.draft;
  const ref = useRef<HTMLElement>(null);
  const [dismissing, setDismissing] = useState<boolean>(false);
  const [note, setNote] = useState<string>("");
  const [copied, setCopied] = useState<string | null>(null);
  useEffect((): void => {
    if (props.fresh) {
      ref.current?.scrollIntoView({ block: "nearest" });
      ref.current?.focus({ preventScroll: true });
    }
  }, [props.fresh]);
  const move = async (to: "copied" | "sent" | "dismiss", body: Record<string, string>): Promise<void> => {
    props.acts.done(await postJson<Acted<IncidentView>>(`${props.acts.path}/outbox/${d.id}/${to}`, body));
  };
  const named = (): boolean => {
    if (props.name.trim() === "") {
      props.onNoName();
      return false;
    }
    return true;
  };
  return (
    <article class={props.fresh ? "pay-draft is-new" : "pay-draft"} ref={ref} tabIndex={-1} aria-label={d.label}>
      <div class="pay-draft__top">
        <h3 class="pay-draft__title">{d.label}</h3>
        <ToneBadge tone={TONES[d.state]} label={d.stateLabel} />
        <span class="muted">{audience(d.audience)}</span>
      </div>
      <History draft={d} />
      <p class="pay-draft__subject">
        {"Subject: "}
        <Theirs text={d.subject} />
      </p>
      <Theirs text={d.body} block />
      <p class="pay-draft__hint">Add your signature when you send it.</p>
      <p class={d.intact ? "pay-draft__hash" : "pay-draft__hash pay-warn"}>
        {d.intact ? "The text matches the hash PayOnce recorded when it was drafted." : "The text no longer matches the hash PayOnce recorded when it was drafted."}
      </p>
      {d.changed === null || d.changed.length === 0 ? null : <p class="pay-warn">{`Changed since drafted: ${d.changed.join("; ")}.`}</p>}
      {d.noLongerFits === null ? null : <p class="pay-warn">{`No longer fits: ${d.noLongerFits}`}</p>}
      <div class="pay-draft__actions">
        <span class="action">
          <button
            type="button"
            class="btn btn--secondary"
            onClick={async (): Promise<void> => {
              try {
                await navigator.clipboard.writeText(`Subject: ${d.subject}\n\n${d.body}`);
                setCopied("Copied");
              } catch {
                setCopied("Couldn't copy. Select the text instead.");
                return;
              } finally {
                window.setTimeout((): void => setCopied(null), 3_000);
              }
              if (d.can.copy.allowed) {
                await move("copied", { copiedBy: props.name.trim() }).catch((): void => props.acts.refresh());
              }
            }}
          >
            Copy text
          </button>
          {copied === null ? null : (
            <span class="copy-said" role="status">
              {copied}
            </span>
          )}
        </span>
        <ActionButton
          label="Mark as sent"
          busyLabel="Marking…"
          disabled={!d.can.markSent.allowed}
          onAction={async (): Promise<void> => {
            if (named()) {
              await move("sent", { sentBy: props.name.trim() });
            }
          }}
          onError={props.acts.refresh}
        />
        {d.can.dismiss.allowed && !dismissing ? (
          <button type="button" class="btn btn--quiet" onClick={(): void => setDismissing(true)}>
            Dismiss
          </button>
        ) : null}
      </div>
      {dismissing && d.can.dismiss.allowed ? (
        <div class="pay-draft__dismiss">
          <Field label="Why dismiss it?" hint="Optional, up to 200 characters.">
            {(control: ControlProps): JSX.Element => (
              <input
                {...control}
                class="input"
                type="text"
                maxLength={200}
                placeholder="Supplier called instead"
                value={note}
                onInput={(event: Event): void => setNote((event.currentTarget as HTMLInputElement).value)}
              />
            )}
          </Field>
          <div class="button-row">
            <ActionButton
              kind="danger"
              label="Dismiss draft"
              busyLabel="Dismissing…"
              onAction={async (): Promise<void> => {
                if (named()) {
                  await move("dismiss", { dismissedBy: props.name.trim(), note: note.trim() });
                  setDismissing(false);
                  setNote("");
                }
              }}
              onError={props.acts.refresh}
            />
            <button type="button" class="btn btn--quiet" onClick={(): void => setDismissing(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function MessagesTab(props: { view: IncidentView; acts: Acts; openDraft: number | null; onDrafted: (id: number) => void }): JSX.Element {
  const m: MessagesView = props.view.messages;
  const [name, setName] = useNameDraft();
  const [nameError, setNameError] = useState<string | null>(null);
  const noName = (): void => setNameError("Enter your name first.");
  const suggested: DraftOfferView[] = m.offers.filter((offer: DraftOfferView): boolean => offer.suggested);
  const others: DraftOfferView[] = m.offers.filter((offer: DraftOfferView): boolean => !offer.suggested);
  const nothing: boolean = m.drafts.length === 0 && m.offers.length === 0 && m.withheld.length === 0 && m.notOffered.length === 0;
  const offer = (item: DraftOfferView): JSX.Element => (
    <Offer key={item.template} offer={item} acts={props.acts} name={name} onNoName={noName} onDrafted={props.onDrafted} />
  );
  return (
    <div class="pay-list">
      <p class="pay-messages__lede">PayOnce drafts messages for you to send. It never sends them.</p>
      {nothing ? (
        <Empty title="No messages fit this payment now." />
      ) : (
        <>
          <NameField
            label="Your name"
            value={name}
            error={nameError}
            onInput={(value: string): void => {
              setName(value);
              setNameError(null);
            }}
          />
          {suggested.length === 0 ? null : <div class="pay-offers">{suggested.map(offer)}</div>}
          {others.length === 0 ? null : (
            <div class="pay-offers">
              <h3 class="pay-subhead">{suggested.length === 0 ? "Messages that fit" : "Other messages that fit"}</h3>
              {others.map(offer)}
            </div>
          )}
          {m.withheld.length === 0 ? null : (
            <div class="pay-offers">
              <p class="pay-warn">
                Messages to the supplier are not suggested: they asked to hold, cancel or not pay this invoice. You can still draft one.
              </p>
              {m.withheld.map(offer)}
            </div>
          )}
          {m.notOffered.map(
            (item: { label: string; why: string }): JSX.Element => (
              <p class="pay-offers__not" key={item.label}>
                {`Not offered: ${item.label}. ${item.why}`}
              </p>
            ),
          )}
          {m.drafts.map(
            (draft: DraftView): JSX.Element => (
              <Draft key={draft.id} draft={draft} acts={props.acts} name={name} fresh={draft.id === props.openDraft} onNoName={noName} />
            ),
          )}
        </>
      )}
    </div>
  );
}

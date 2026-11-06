import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { postJson } from "../../api";
import { ActionButton, Details, LinkButton } from "../../components/Action";
import { Field, NameField, type ControlProps } from "../../components/Form";
import { Icon } from "../../components/Icon";
import { Callout } from "../../components/Notice";
import { Empty, LoadError, Loading } from "../../components/States";
import { Ref, Theirs, Time } from "../../components/Text";
import { ToneBadge } from "../../components/Tone";
import { useNameDraft } from "../../me";
import { notify } from "../../notices";
import { SLOW_MS, usePoll, type Polled } from "../../poll";
import { paymentHref } from "../../router";
import { cleanLine } from "../../text";
import type { Acted, CandidateView, InboxItemView, StatusView } from "../../types";
import { useKept } from "./kept";

// One uploaded email (ia.md section 5, "Item"): its header, the sender check and
// the match card while it waits, what happened to it once delivered or
// dismissed, the body, and Dismiss. Every action answers the fresh item.

type Item = InboxItemView["upload"];

const STATUS_MS: number = 10_000;

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// "The only invoice number…" inside "PayOnce suggests INV-1: the only invoice number…".
function clause(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function senderDomain(address: string): string {
  const at: number = address.lastIndexOf("@");
  return at === -1 ? address : address.slice(at + 1);
}

function Header(props: { item: Item }): JSX.Element {
  const item: Item = props.item;
  const replyTo: string[] = item.replyTo.filter((address: string): boolean => address !== item.from);
  return (
    <header class="mail__head">
      <div class="mail__eyebrow">
        <span class="mail__number">{`Email ${item.id}`}</span>
        {item.partial ? <span class="mail-tag mail-tag--partial">Partly unreadable</span> : <span class="mail-tag">Fully readable</span>}
      </div>
      <h2 id="mail-subject" class="mail__subject">
        <Theirs text={item.subject === "" ? "(no subject)" : item.subject} />
      </h2>
      <dl class="mail__facts">
        <dt>From</dt>
        <dd>
          {item.fromName === null ? null : (
            <>
              <Theirs text={item.fromName} />{" "}
            </>
          )}
          <span class="mail__address">
            {"<"}
            <Theirs text={item.from} />
            {">"}
          </span>
        </dd>
        {replyTo.length === 0 ? null : (
          <>
            <dt>Reply-To</dt>
            <dd>
              <Theirs text={replyTo.join(", ")} />
            </dd>
          </>
        )}
        <dt>Date as written</dt>
        <dd>{item.dateAsWritten === "" ? <span class="muted">Not given</span> : <Theirs text={item.dateAsWritten} />}</dd>
        <dt>Uploaded</dt>
        <dd>
          {"By "}
          <Theirs text={item.uploadedBy} />
          {" at "}
          <Time at={item.uploadedAt} />
        </dd>
      </dl>
    </header>
  );
}

// The sender against the email domain on file for the payment it will go to.
function SenderCheck(props: { item: Item; candidate: CandidateView | null }): JSX.Element {
  const candidate: CandidateView | null = props.candidate;
  if (candidate === null) {
    return (
      <p class="sender-check sender-check--none">
        <Icon name="circle" />
        <span>
          {"Sent from "}
          <Theirs text={senderDomain(props.item.from)} />
          {". Pick a payment below and PayOnce checks this domain against the one on file for its supplier."}
        </span>
      </p>
    );
  }
  return (
    <p class={candidate.senderOnFile ? "sender-check sender-check--ok" : "sender-check sender-check--warn"}>
      <Icon name={candidate.senderOnFile ? "check" : "warning"} />
      <span>
        <Ref>{candidate.invoiceId}</Ref>
        {": "}
        <Theirs text={candidate.senderText} />
      </span>
    </p>
  );
}

function CandidateLine(props: { candidate: CandidateView }): JSX.Element {
  const candidate: CandidateView = props.candidate;
  return (
    <span class="candidate__facts">
      <Theirs text={candidate.supplier} />
      <span class="sep" aria-hidden="true">
        {" · "}
      </span>
      <span class="money">{candidate.amount.text}</span>
      <ToneBadge tone={candidate.situation.tone} label={candidate.situation.label} />
    </span>
  );
}

function Match(props: { view: InboxItemView; preferred: string | null; onActed: (view: InboxItemView) => void }): JSX.Element {
  const view: InboxItemView = props.view;
  const [name, setName] = useNameDraft();
  const [other, setOther] = useState<string>(
    props.preferred === null || view.candidates.some((candidate: CandidateView): boolean => candidate.invoiceId === props.preferred) ? "" : props.preferred,
  );
  const top: string | null = props.preferred ?? view.suggested;
  const primary: CandidateView | null = view.candidates.find((candidate: CandidateView): boolean => candidate.invoiceId === top) ?? null;
  const others: CandidateView[] = view.candidates.filter((candidate: CandidateView): boolean => candidate !== primary);
  const deliver = async (invoiceId: string): Promise<void> => {
    const acted: Acted<InboxItemView> = await postJson<Acted<InboxItemView>>(`/api/inbox/${view.upload.id}/deliver`, {
      invoiceId: invoiceId.trim(),
      deliveredBy: name,
    });
    props.onActed(acted.view);
    notify(acted.notice);
  };
  const can: InboxItemView["can"]["deliver"] = view.can.deliver;
  return (
    <section class="match" aria-labelledby="match-title">
      <h3 id="match-title" class="mail__section-title">
        Match
      </h3>
      <NameField label="Delivering as" value={name} onInput={setName} />
      {primary !== null ? (
        <div class="match__top">
          <p>
            {primary.invoiceId === view.suggested ? (
              <>
                {"PayOnce suggests "}
                <Ref>{primary.invoiceId}</Ref>
                {`: ${clause(primary.why)}`}
              </>
            ) : (
              <>
                {"You opened the inbox from "}
                <Ref>{primary.invoiceId}</Ref>
                {` (${clause(primary.why).replace(/\.$/, "")}).`}
              </>
            )}
          </p>
          <CandidateLine candidate={primary} />
          <div>
            <ActionButton
              label={`Deliver to ${primary.invoiceId}`}
              busyLabel="Delivering…"
              kind="primary"
              disabled={!can.allowed}
              reason={can.why?.text ?? null}
              onAction={(): Promise<void> => deliver(primary.invoiceId)}
            />
          </div>
        </div>
      ) : view.candidates.length === 0 ? (
        <p class="muted">PayOnce found no invoice number or bank reference in this email.</p>
      ) : (
        <p>This email names more than one payment. Choose the one it is about.</p>
      )}
      {others.length === 0 ? null : (
        <ul class="candidates">
          {others.map(
            (candidate: CandidateView): JSX.Element => (
              <li class="candidate" key={candidate.invoiceId}>
                <div class="candidate__main">
                  <span>
                    <Ref>{candidate.invoiceId}</Ref>
                    <span class="muted">{` · ${clause(candidate.why).replace(/\.$/, "")}`}</span>
                  </span>
                  <CandidateLine candidate={candidate} />
                  <span class={candidate.senderOnFile ? "candidate__sender" : "candidate__sender candidate__sender--warn"}>
                    <Theirs text={candidate.senderText} />
                  </span>
                </div>
                <ActionButton
                  label="Deliver"
                  busyLabel="Delivering…"
                  disabled={!can.allowed}
                  onAction={(): Promise<void> => deliver(candidate.invoiceId)}
                />
              </li>
            ),
          )}
        </ul>
      )}
      <div class="match__other">
        <Field label="Another payment" class="match__other-field">
          {(control: ControlProps): JSX.Element => (
            <input
              {...control}
              class="input mono"
              type="text"
              autocomplete="off"
              spellcheck={false}
              maxLength={40}
              placeholder="Invoice number"
              value={other}
              onInput={(event: Event): void => setOther((event.currentTarget as HTMLInputElement).value)}
            />
          )}
        </Field>
        <ActionButton
          label="Deliver"
          busyLabel="Delivering…"
          disabled={!can.allowed || other.trim() === ""}
          onAction={(): Promise<void> => deliver(other)}
        />
      </div>
      {view.sameMessageId.length === 0 ? null : (
        <Callout tone="warning">
          {"Same Message-ID as "}
          {view.sameMessageId.map(
            (id: number, index: number): JSX.Element => (
              <span key={id}>
                {index === 0 ? null : ", "}
                <a href={`#inbox/${id}`}>{`email ${id}`}</a>
              </span>
            ),
          )}
          . It may be the same email uploaded twice.
        </Callout>
      )}
    </section>
  );
}

// Delivered: what PayOnce does with it next, or what it read. While the payment's
// emails are unread and Airwallex does not answer, the check that reads them
// cannot run, so the box says it waits for Airwallex.
function Delivered(props: { view: InboxItemView }): JSX.Element {
  const view: InboxItemView = props.view;
  const item: Item = view.upload;
  const unread: boolean = view.reading?.state === "unread";
  const status: Polled<StatusView> = usePoll<StatusView>(unread ? "/api/status" : null, (): number => STATUS_MS);
  const airwallexDown: boolean = unread && status.data !== null && status.data.airwallex.state !== "ok" && status.data.airwallex.state !== "unknown";
  const reading: InboxItemView["reading"] = view.reading;
  return (
    <section class="mail__done mail__done--delivered" aria-label="Delivery">
      <p class="mail__done-lead">
        {`Delivered to ${item.invoiceId ?? "a payment"}`}
        {item.deliveredBy === null ? null : (
          <>
            {" by "}
            <Theirs text={item.deliveredBy} />
          </>
        )}
        {item.deliveredAt === null ? null : (
          <>
            {" at "}
            <Time at={item.deliveredAt} />
          </>
        )}
        .
      </p>
      {reading?.state === "read" ? (
        <dl class="mail__reading">
          <dt>What PayOnce read</dt>
          <dd>{reading.summary}</dd>
          {reading.readBy === null ? null : (
            <>
              <dt>Read by</dt>
              <dd>{reading.readBy}</dd>
            </>
          )}
        </dl>
      ) : (
        <p>{airwallexDown ? "Not read yet. PayOnce reads it at its next check, once Airwallex answers." : view.afterDelivery}</p>
      )}
      {item.invoiceId === null ? null : (
        <div>
          <LinkButton href={paymentHref(item.invoiceId)}>{`Open ${item.invoiceId}`}</LinkButton>
        </div>
      )}
    </section>
  );
}

function Dismissed(props: { item: Item }): JSX.Element {
  const item: Item = props.item;
  return (
    <section class="mail__done" aria-label="Dismissal">
      <p class="mail__done-lead">
        {"Dismissed"}
        {item.dismissedBy === null ? null : (
          <>
            {" by "}
            <Theirs text={item.dismissedBy} />
          </>
        )}
        {item.dismissedAt === null ? null : (
          <>
            {" at "}
            <Time at={item.dismissedAt} />
          </>
        )}
        {item.dismissNote === null ? "." : ": "}
        {item.dismissNote === null ? null : <Theirs text={item.dismissNote} />}
      </p>
    </section>
  );
}

function Body(props: { item: Item }): JSX.Element {
  const item: Item = props.item;
  return (
    <section class="mail__body" aria-label="Email body">
      <Theirs text={item.body === "" ? "(no text)" : item.body} block />
      {item.styleText === null ? null : (
        <details class="details">
          <summary>Text inside the email's styles and scripts</summary>
          <Theirs text={item.styleText} block />
        </details>
      )}
      {item.attachments.length === 0 ? (
        <p class="mail__attachments">No attachments</p>
      ) : (
        <ul class="mail__attachments">
          {item.attachments.map(
            (attachment: Item["attachments"][number], index: number): JSX.Element => (
              <li key={index}>
                {"Attachment: "}
                <Theirs text={attachment.name} />
                {" · "}
                <Theirs text={attachment.type} />
                {` · ${sizeText(attachment.bytes)}`}
              </li>
            ),
          )}
        </ul>
      )}
      {item.notes.map(
        (note: string): JSX.Element => (
          <p class="mail__note" key={note}>
            {note}
          </p>
        ),
      )}
      <Details rows={[{ label: "Message-ID", value: item.messageId, copy: true }]} />
    </section>
  );
}

function Dismiss(props: { view: InboxItemView; onActed: (view: InboxItemView) => void }): JSX.Element {
  const [name, setName] = useNameDraft();
  const [note, setNote] = useState<string>("");
  const [missing, setMissing] = useState<boolean>(false);
  const can: InboxItemView["can"]["dismiss"] = props.view.can.dismiss;
  const who: string = cleanLine(name);
  return (
    <section class="mail__dismiss" aria-labelledby="dismiss-title">
      <h3 id="dismiss-title" class="mail__section-title">
        This email belongs to no payment
      </h3>
      <Field label="Note" error={missing ? "Add a note saying why." : null}>
        {(control: ControlProps): JSX.Element => (
          <input
            {...control}
            class="input"
            type="text"
            maxLength={200}
            required
            placeholder="Why it belongs to no payment"
            value={note}
            onInput={(event: Event): void => {
              setNote((event.currentTarget as HTMLInputElement).value);
              setMissing(false);
            }}
          />
        )}
      </Field>
      <NameField label="Dismissing as" value={name} onInput={setName} />
      <div>
        <ActionButton
          label={who === "" ? "Dismiss" : `Dismiss as ${who}`}
          busyLabel="Dismissing…"
          disabled={!can.allowed}
          reason={can.why?.text ?? null}
          onAction={async (): Promise<void> => {
            if (note.trim() === "") {
              setMissing(true);
              return;
            }
            const acted: Acted<InboxItemView> = await postJson<Acted<InboxItemView>>(`/api/inbox/${props.view.upload.id}/dismiss`, {
              dismissedBy: name,
              note: note.trim(),
            });
            props.onActed(acted.view);
            notify(acted.notice);
          }}
        />
      </div>
    </section>
  );
}

// preferred: the payment the inbox was opened for (#inbox/N?for=ID).
export function InboxItem(props: { id: number; preferred: string | null; onActed: () => void }): JSX.Element {
  const path: string = `/api/inbox/${props.id}`;
  const polled: Polled<InboxItemView> = usePoll<InboxItemView>(path, (): number => SLOW_MS);
  const view: InboxItemView | null = useKept(path, polled);
  const acted = (fresh: InboxItemView): void => {
    polled.replace(fresh);
    props.onActed();
  };
  const top: CandidateView | null =
    view === null ? null : (view.candidates.find((candidate: CandidateView): boolean => candidate.invoiceId === (props.preferred ?? view.suggested)) ?? null);
  if (view === null && polled.error?.status === 404) {
    return (
      <Empty title={`Email ${props.id} isn't in the inbox.`}>
        <a href="#inbox">All emails</a>
      </Empty>
    );
  }
  return (
    <article class="card mail" aria-labelledby="mail-subject">
      <LoadError what="this email" error={polled.error} />
      {view === null ? (
        polled.error === null ? (
          <Loading rows={3} label="Loading the email" />
        ) : null
      ) : (
        <>
          <Header item={view.upload} />
          {view.upload.state === "waiting" ? (
            <>
              <SenderCheck item={view.upload} candidate={top} />
              <Match view={view} preferred={props.preferred} onActed={acted} />
            </>
          ) : view.upload.state === "delivered" ? (
            <Delivered view={view} />
          ) : (
            <Dismissed item={view.upload} />
          )}
          <Body item={view.upload} />
          {view.upload.state === "waiting" ? <Dismiss view={view} onActed={acted} /> : null}
        </>
      )}
    </article>
  );
}

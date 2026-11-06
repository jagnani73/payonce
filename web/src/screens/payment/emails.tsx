import type { JSX } from "preact";
import { query } from "../../api";
import { LinkButton } from "../../components/Action";
import { Icon } from "../../components/Icon";
import { Callout } from "../../components/Notice";
import { Empty } from "../../components/States";
import { Theirs, Time } from "../../components/Text";
import type { EmailsTab as EmailsTabView, EmailView, IncidentView } from "../../types";
import { sentence } from "./parts";

// The Emails tab (ia.md 3.4): what PayOnce read in the supplier's emails, the
// sender check, then each email as written. Everything in an email is text
// PayOnce did not write, so it goes through <Theirs>.

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Read(props: { tab: EmailsTabView }): JSX.Element | null {
  const t: EmailsTabView = props.tab;
  if (t.findings === null && t.unread === null && t.senderWarnings.length === 0) {
    return null;
  }
  return (
    <div class="pay-read">
      <h3 class="pay-read__title">What PayOnce read</h3>
      {t.findings === null ? null : (
        <>
          <p class="pay-read__summary">{t.findings.summary === "" ? "Nothing that affects this payment" : sentence(t.findings.summary)}</p>
          {t.findings.readBy === null ? null : (
            <p class="pay-read__line">
              {"Read by: "}
              <Theirs text={t.findings.readBy} />
            </p>
          )}
        </>
      )}
      {t.unread === null ? null : <p class="pay-read__line pay-warn">{t.unread.text}</p>}
      {t.senderWarnings.map(
        (warning: string): JSX.Element => (
          <Callout tone="warning" key={warning}>
            <Theirs text={warning} />.
          </Callout>
        ),
      )}
    </div>
  );
}

function Email(props: { email: EmailView }): JSX.Element {
  const e: EmailView = props.email;
  return (
    <article class="pay-email">
      <dl class="pay-email__head">
        <dt>From</dt>
        <dd>
          {e.fromName === null ? (
            <Theirs text={e.from} class="mono" />
          ) : (
            <>
              <Theirs text={e.fromName} />{" "}
              <span class="mono">
                {"<"}
                <Theirs text={e.from} />
                {">"}
              </span>
            </>
          )}
          {e.senderMatches ? null : <span class="pay-warn">{" · does not match the email domain on file"}</span>}
        </dd>
        {e.replyTo.length === 0 ? null : (
          <>
            <dt>Reply-To</dt>
            <dd class="mono">
              {e.replyTo.map(
                (address: string, index: number): JSX.Element => (
                  <span key={address}>
                    {index === 0 ? null : ", "}
                    <Theirs text={address} />
                  </span>
                ),
              )}
            </dd>
          </>
        )}
        {e.dateAsWritten === null ? null : (
          <>
            <dt>Date as written</dt>
            <dd>
              <Theirs text={e.dateAsWritten} />
            </dd>
          </>
        )}
        <dt>Subject</dt>
        <dd class="pay-email__subject">
          <Theirs text={e.subject} />
        </dd>
      </dl>
      <Theirs text={e.body} block />
      {e.styleText === null ? null : (
        <details class="details">
          <summary>Text inside the email's styles</summary>
          <Theirs text={e.styleText} block />
        </details>
      )}
      {e.attachments.length === 0 ? null : (
        <ul class="pay-email__files">
          {e.attachments.map(
            (file: EmailView["attachments"][number], index: number): JSX.Element => (
              <li key={`${file.name}-${index}`}>
                {"Attachment: "}
                <Theirs text={file.name} />
                {" · "}
                <Theirs text={file.type} />
                {` · ${size(file.bytes)}`}
              </li>
            ),
          )}
        </ul>
      )}
      {e.notes.map(
        (note: string): JSX.Element => (
          <p class="pay-email__note" key={note}>
            {note}
          </p>
        ),
      )}
      {e.partial ? <p class="pay-email__note pay-warn">Part of this email could not be read.</p> : null}
      <p class="pay-email__by">
        {e.uploadId === null ? (
          "Played by the sandbox simulator"
        ) : (
          <>
            {"Uploaded by "}
            {e.uploadedBy === null ? "someone" : <Theirs text={e.uploadedBy} />}
            {" from the inbox"}
            {e.uploadedAt === null ? null : (
              <>
                {" · "}
                <Time at={e.uploadedAt} />
              </>
            )}
          </>
        )}
      </p>
    </article>
  );
}

export function EmailsTab(props: { view: IncidentView }): JSX.Element {
  const t: EmailsTabView = props.view.emails;
  const upload: JSX.Element = (
    <LinkButton href={query("#inbox", { for: props.view.payment.invoiceId })}>
      <Icon name="mail" />
      Upload an email for this payment
    </LinkButton>
  );
  if (t.emails.length === 0) {
    return (
      <Empty title="No supplier emails on this payment.">
        <div>{upload}</div>
      </Empty>
    );
  }
  return (
    <div class="pay-list">
      <Read tab={t} />
      {t.emails.map(
        (email: EmailView, index: number): JSX.Element => (
          <Email key={`${email.uploadId ?? "sim"}-${index}`} email={email} />
        ),
      )}
      <div>{upload}</div>
    </div>
  );
}

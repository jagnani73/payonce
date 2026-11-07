import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useState } from "preact/hooks";
import { asApiError, getJson, postJson } from "../../api";
import { ActionButton } from "../../components/Action";
import { Field, NameField, type ControlProps } from "../../components/Form";
import { Icon } from "../../components/Icon";
import { Callout, InlineError } from "../../components/Notice";
import { PhoneOnFile } from "../../components/Phone";
import { Dotted, Theirs, Time, When } from "../../components/Text";
import { ToneBadge } from "../../components/Tone";
import { useNameDraft } from "../../me";
import { capitalised, joinNames } from "../../text";
import type {
  Acted,
  Can,
  PhoneOnFileView,
  PhoneProposalView,
  PhoneVersionView,
  SupplierAccountView,
  SupplierContactDetail,
  SupplierContactView,
  SupplierView,
} from "../../types";
import { actionOf, SOURCES, type ConfirmInput, type ContactSource, type ProposeInput, type WithdrawInput } from "./contact-model";
import { seenInEmailsText } from "./words";

// "Contact on file" on the supplier record (supplier-contacts.md section 7): the
// phone with who put it there and "Show number", a new number waiting for a
// second person with its blind re-key confirm and its withdraw, the email
// domains and the history. Every change takes two people; the page asks and the
// server decides, and a refusal shows beside the button in the server's words.
// Drafts live in each form's own state, so a poll never wipes them.

type Acting = (acted: Acted<SupplierView>) => void;

function contactPath(key: string, tail: string = ""): string {
  return `/api/suppliers/${encodeURIComponent(key)}/contact${tail}`;
}

function SourceSelect(props: { control: ControlProps; value: ContactSource | ""; onChange: (value: ContactSource | "") => void }): JSX.Element {
  return (
    <select
      {...props.control}
      class="select"
      value={props.value}
      onChange={(event: Event): void => {
        const picked: string = (event.currentTarget as HTMLSelectElement).value;
        props.onChange(SOURCES.find((source: { code: ContactSource }): boolean => source.code === picked)?.code ?? "");
      }}
    >
      <option value="" disabled>
        Choose one
      </option>
      {SOURCES.map(
        (source: { code: ContactSource; label: string }): JSX.Element => (
          <option key={source.code} value={source.code}>
            {source.label}
          </option>
        ),
      )}
    </select>
  );
}

function TextInput(props: { control: ControlProps; value: string; onInput: (value: string) => void; tel?: boolean; placeholder?: string }): JSX.Element {
  return (
    <input
      {...props.control}
      class="input"
      type={props.tel === true ? "tel" : "text"}
      inputMode={props.tel === true ? "tel" : undefined}
      autocomplete="off"
      spellcheck={false}
      maxLength={props.tel === true ? 40 : 200}
      placeholder={props.placeholder}
      value={props.value}
      onInput={(event: Event): void => props.onInput((event.currentTarget as HTMLInputElement).value)}
    />
  );
}

// What a form needs before anything is sent. The server checks the same, and
// its words show beside the button.
function sourceProblems(source: ContactSource | "", note: string): Record<string, string> {
  return {
    ...(source === "" ? { source: "Say where you found the number." } : {}),
    ...(source === "other" && note.trim() === "" ? { note: "Say what the other source is." } : {}),
  };
}

function Names(props: { names: readonly string[] }): JSX.Element {
  return (
    <>
      {props.names.map(
        (name: string, index: number): JSX.Element => (
          <span key={`${index}-${name}`}>
            {index === 0 ? null : index === props.names.length - 1 ? " and " : ", "}
            <Theirs text={name} />
          </span>
        ),
      )}
    </>
  );
}

// ---------- the phone on file ----------

// "Show number" asks GET …/contact for the number in full. It stays in the page
// only while shown, and goes when the number on file changes.
function PhoneLine(props: { supplierKey: string; contact: SupplierContactView }): JSX.Element {
  const phone: PhoneOnFileView | null = props.contact.phone;
  const ending: string | null = phone === null ? props.contact.phoneEnding : phone.removed ? null : phone.ending;
  const contactId: number | null = phone?.contactId ?? null;
  const [full, setFull] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  useEffect((): void => {
    setFull(null);
    setError(null);
  }, [ending, contactId]);

  async function show(): Promise<void> {
    if (full !== null) {
      setFull(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const detail: SupplierContactDetail = await getJson<SupplierContactDetail>(contactPath(props.supplierKey));
      if (detail.phone === null || detail.phone.value.trim() === "") {
        setError("The number on file just changed. Press Show number again.");
      } else {
        setFull(detail.phone.value);
      }
    } catch (caught: unknown) {
      setError(asApiError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  const barred: string[] = props.contact.callbackBarred;
  return (
    <div class={ending === null ? "sup-contact__line sup-contact__line--none" : "sup-contact__line"}>
      <PhoneOnFile
        phone={phone}
        ending={ending}
        label="Phone"
        full={full}
        actions={
          <>
            {ending === null ? null : (
              <button type="button" class="btn btn--secondary btn--small" aria-pressed={full !== null} disabled={busy} onClick={(): void => void show()}>
                {busy ? "Getting the number…" : full === null ? "Show number" : "Hide number"}
              </button>
            )}
            <InlineError message={error} />
          </>
        }
      >
        {ending !== null ? null : (
          <p class="contact__line">
            Nobody can record a callback to confirm new bank details for this supplier until a number is on file. Putting one on file takes two
            people: one proposes it, and someone else confirms it from their own source.
          </p>
        )}
        {barred.length === 0 ? null : (
          <p class="contact__line">
            <Names names={barred} />
            {" put this number on file, so someone else records any callback on it."}
          </p>
        )}
      </PhoneOnFile>
    </div>
  );
}

// ---------- a new number waiting for a second person ----------

function ConfirmForm(props: { supplierKey: string; proposal: PhoneProposalView; can: Can; onActed: Acting; onWithdraw: (() => void) | null }): JSX.Element {
  const removal: boolean = props.proposal.removal;
  const [value, setValue] = useState<string>("");
  const [source, setSource] = useState<ContactSource | "">("");
  const [note, setNote] = useState<string>("");
  const [name, setName] = useNameDraft();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const proposer: string = props.proposal.proposedBy ?? "";

  async function confirm(): Promise<void> {
    const problems: Record<string, string> = {
      ...(!removal && value.trim() === "" ? { value: "Type the number from your own source." } : {}),
      ...sourceProblems(source, note),
    };
    setErrors(problems);
    if (Object.keys(problems).length > 0 || source === "") {
      return;
    }
    const body: ConfirmInput = { value: removal ? "" : value.trim(), name: name.trim(), source, note: note.trim() };
    props.onActed(await postJson<Acted<SupplierView>>(contactPath(props.supplierKey, `/${props.proposal.contactId}/confirm`), body));
  }

  const withdrawButton: JSX.Element | null =
    props.onWithdraw === null ? null : (
      <button type="button" class="btn btn--secondary" onClick={props.onWithdraw}>
        Withdraw it instead
      </button>
    );
  return (
    <div class="sup-proposal__form">
      {props.can.allowed ? (
        <>
          <h4 class="sup-proposal__form-title">{removal ? "Confirm the removal from your own source" : "Confirm it from your own source"}</h4>
          <p class="sup-proposal__lede">
            {removal ? (
              "Check with your own source that the supplier has no number PayOnce should call."
            ) : (
              <>
                {"You don't see the number "}
                {proposer === "" ? "the proposer" : <Theirs text={proposer} />}
                {" typed. Find it yourself and type it here. It goes on file only if the two match."}
              </>
            )}
          </p>
          <div class="sup-form-grid">
            {removal ? null : (
              <Field label="The number from your source" error={errors["value"] ?? null}>
                {(control: ControlProps): JSX.Element => <TextInput control={control} value={value} onInput={setValue} tel placeholder="+1 212 555 …" />}
              </Field>
            )}
            <Field label="Your source" error={errors["source"] ?? null}>
              {(control: ControlProps): JSX.Element => <SourceSelect control={control} value={source} onChange={setSource} />}
            </Field>
            <Field label="Note" hint={source === "other" ? "Required for another source." : "Optional."} error={errors["note"] ?? null}>
              {(control: ControlProps): JSX.Element => <TextInput control={control} value={note} onInput={setNote} />}
            </Field>
            <NameField
              label="Confirming as"
              value={name}
              onInput={setName}
              hint={
                proposer === "" ? (
                  "Someone other than the proposer confirms it."
                ) : (
                  <>
                    <Theirs text={proposer} />
                    {" proposed it, so someone else confirms it."}
                  </>
                )
              }
            />
          </div>
          <div class="button-row">
            <ActionButton label={removal ? "Confirm the removal" : "Confirm"} busyLabel="Confirming…" kind="primary" onAction={confirm} />
            {withdrawButton}
          </div>
        </>
      ) : (
        <div class="sup-proposal__off">
          <p>{props.can.why?.text ?? "Nobody can confirm it now."}</p>
          {withdrawButton}
        </div>
      )}
    </div>
  );
}

function WithdrawForm(props: { supplierKey: string; proposal: PhoneProposalView; can: Can; onActed: Acting; onBack: (() => void) | null }): JSX.Element {
  const [note, setNote] = useState<string>("");
  const [name, setName] = useNameDraft();
  const [error, setError] = useState<string | null>(null);

  async function withdraw(): Promise<void> {
    if (note.trim() === "") {
      setError("Say why you are withdrawing it.");
      return;
    }
    setError(null);
    const body: WithdrawInput = { name: name.trim(), note: note.trim() };
    props.onActed(await postJson<Acted<SupplierView>>(contactPath(props.supplierKey, `/${props.proposal.contactId}/withdraw`), body));
  }

  return (
    <div class="sup-proposal__form">
      <h4 class="sup-proposal__form-title">Withdraw the proposal</h4>
      {props.can.allowed ? (
        <>
          <div class="sup-form-grid">
            <Field label="Why" error={error}>
              {(control: ControlProps): JSX.Element => (
                <TextInput control={control} value={note} onInput={setNote} placeholder="The number came from a look-alike email" />
              )}
            </Field>
            <NameField label="Withdrawing as" value={name} onInput={setName} />
          </div>
          <div class="button-row">
            <ActionButton label={name.trim() === "" ? "Withdraw" : `Withdraw as ${name.trim()}`} busyLabel="Withdrawing…" kind="danger" onAction={withdraw} />
            {props.onBack === null ? null : (
              <button type="button" class="btn btn--secondary" onClick={props.onBack}>
                Back
              </button>
            )}
          </div>
        </>
      ) : (
        <p class="sup-proposal__off">{props.can.why?.text ?? "Nobody can withdraw it now."}</p>
      )}
    </div>
  );
}

// What confirming it changes, from the record's own accounts and callbacks:
// the callback on the number it replaces stops verifying the account it
// verified. The notice after confirming says how many requests were withdrawn.
function Effect(props: { view: SupplierView; proposal: PhoneProposalView }): JSX.Element {
  const proposal: PhoneProposalView = props.proposal;
  const old: string | null = proposal.replacesEnding;
  const verified: SupplierAccountView[] =
    old === null
      ? []
      : props.view.accounts.filter(
          (account: SupplierAccountView): boolean =>
            account.verifiedBy !== null &&
            props.view.callbacks.some((callback: SupplierView["callbacks"][number]): boolean => callback.id === account.verifiedBy?.callbackId && callback.numberEnding === old),
        );
  const first: SupplierAccountView | undefined = verified[0];
  const what: ComponentChildren =
    old === null ? (
      "Every callback for this supplier then goes to this number."
    ) : first?.verifiedBy !== undefined && first.verifiedBy !== null ? (
      <>
        <Theirs text={first.verifiedBy.calledBy} />
        {`'s callback on the number ending ${old} stops verifying ${verified.length === 1 ? `account ${first.letter}` : `accounts ${joinNames(verified.map((account: SupplierAccountView): string => account.letter), "and")}`}, and any approval request that relies on it is withdrawn.`}
        {proposal.removal ? " With no number on file, nobody can record a callback until two people put one on file again." : null}
      </>
    ) : proposal.removal ? (
      "No number will be on file, so nobody can record a callback until two people put one on file again."
    ) : (
      `A callback made on the number ending ${old} no longer verifies bank details, and any approval request that relies on one is withdrawn.`
    );
  return (
    <p class="sup-proposal__effect">
      <strong>{proposal.removal ? "If it is confirmed: " : "If it goes on file: "}</strong>
      {what}
      {" Until then, nobody can record a callback on this supplier's payments."}
    </p>
  );
}

function Proposal(props: { supplierKey: string; view: SupplierView; proposal: PhoneProposalView; onActed: Acting }): JSX.Element {
  const proposal: PhoneProposalView = props.proposal;
  const contact: SupplierContactView = props.view.contact;
  const confirm: Can | null = actionOf(contact, "confirm");
  const withdraw: Can | null = actionOf(contact, "withdraw");
  const [mode, setMode] = useState<"confirm" | "withdraw">(confirm !== null ? "confirm" : "withdraw");
  const note: string = proposal.note.trim();
  return (
    <div class={proposal.lapsed ? "sup-proposal sup-proposal--lapsed" : "sup-proposal"}>
      <div class="sup-proposal__head">
        <ToneBadge tone={proposal.lapsed ? "done" : "act"} label={proposal.lapsed ? "Lapsed" : "Waits for a second person"} />
        <h3 class="sup-proposal__title">{proposal.removal ? "Take the phone number off file" : `New phone ending ${proposal.ending ?? ""}`}</h3>
      </div>
      <dl class="sup-facts">
        <dt>Proposed by</dt>
        <dd>
          {proposal.proposedBy === null ? "A person PayOnce did not record" : <Theirs text={proposal.proposedBy} />} <When at={proposal.proposedAt} />
        </dd>
        {proposal.source === null ? null : (
          <>
            <dt>Source</dt>
            <dd>{capitalised(proposal.source)}</dd>
          </>
        )}
        {note === "" ? null : (
          <>
            <dt>Note</dt>
            <dd>
              <Theirs text={note} />
            </dd>
          </>
        )}
        <dt>{proposal.removal ? "Takes off file" : "Replaces"}</dt>
        <dd>{proposal.replacesEnding === null ? "Nothing. It would be the first number on file." : `The number ending ${proposal.replacesEnding}`}</dd>
        {proposal.lapsesAt === null ? null : (
          <>
            <dt>{proposal.lapsed ? "Lapsed" : "Lapses"}</dt>
            <dd>
              {proposal.lapsed ? (
                <Time at={proposal.lapsesAt} />
              ) : (
                <>
                  <Time at={proposal.lapsesAt} mode="until" />
                  {" if nobody confirms it"}
                </>
              )}
            </dd>
          </>
        )}
      </dl>
      {proposal.seenInEmails === 0 ? null : <Callout tone="warning">{seenInEmailsText(proposal.seenInEmails, proposal.seenFlagged)}</Callout>}
      {proposal.lapsed ? null : <Effect view={props.view} proposal={proposal} />}
      {mode === "confirm" && confirm !== null ? (
        <ConfirmForm
          key={`confirm-${proposal.contactId}`}
          supplierKey={props.supplierKey}
          proposal={proposal}
          can={confirm}
          onActed={props.onActed}
          onWithdraw={withdraw === null || !withdraw.allowed ? null : (): void => setMode("withdraw")}
        />
      ) : withdraw !== null ? (
        <WithdrawForm
          key={`withdraw-${proposal.contactId}`}
          supplierKey={props.supplierKey}
          proposal={proposal}
          can={withdraw}
          onActed={props.onActed}
          onBack={confirm === null ? null : (): void => setMode("confirm")}
        />
      ) : null}
    </div>
  );
}

// ---------- proposing a number ----------

function ProposeForm(props: { supplierKey: string; first: boolean; onActed: Acting; onCancel: () => void }): JSX.Element {
  const [value, setValue] = useState<string>("");
  const [source, setSource] = useState<ContactSource | "">("");
  const [note, setNote] = useState<string>("");
  const [name, setName] = useNameDraft();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const id: string = useId();

  async function propose(): Promise<void> {
    const problems: Record<string, string> = {
      ...(value.trim() === "" ? { value: "Type the phone number." } : {}),
      ...sourceProblems(source, note),
    };
    setErrors(problems);
    if (Object.keys(problems).length > 0 || source === "") {
      return;
    }
    const body: ProposeInput = { field: "phone", value: value.trim(), name: name.trim(), source, note: note.trim() };
    props.onActed(await postJson<Acted<SupplierView>>(contactPath(props.supplierKey), body));
  }

  return (
    <div class="sup-propose" role="group" aria-labelledby={id}>
      <h3 class="sup-propose__title" id={id}>
        {props.first ? "Propose a phone number" : "Propose a new phone number"}
      </h3>
      <p class="sup-proposal__lede">
        Type the number from a source you trust. It goes on file only when someone else finds the same number in their own source and confirms it.
      </p>
      <div class="sup-form-grid">
        <Field label="Phone number" hint="With a + and the country code, such as +1 212 555 0147." error={errors["value"] ?? null}>
          {(control: ControlProps): JSX.Element => <TextInput control={control} value={value} onInput={setValue} tel />}
        </Field>
        <Field label="Where you found it" error={errors["source"] ?? null}>
          {(control: ControlProps): JSX.Element => <SourceSelect control={control} value={source} onChange={setSource} />}
        </Field>
        <Field label="Note" hint={source === "other" ? "Required for another source." : "Optional."} error={errors["note"] ?? null}>
          {(control: ControlProps): JSX.Element => <TextInput control={control} value={note} onInput={setNote} />}
        </Field>
        <NameField label="Proposing as" value={name} onInput={setName} />
      </div>
      <div class="button-row">
        <ActionButton label="Propose" busyLabel="Proposing…" kind="primary" onAction={propose} />
        <button type="button" class="btn btn--secondary" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------- the email domains and the history ----------

function Domains(props: { domains: SupplierContactView["emailDomains"] }): JSX.Element {
  if (props.domains.length === 0) {
    return (
      <div class="sup-contact__line">
        <div class="contact__row">
          <Icon name="email" />
          <span class="contact__value">Email domain: none on file</span>
        </div>
        <p class="contact__line">The sender check flags every email on these payments.</p>
      </div>
    );
  }
  return (
    <>
      {props.domains.map(
        (entry: SupplierContactView["emailDomains"][number]): JSX.Element => (
          <div class="sup-contact__line" key={entry.domain}>
            <div class="contact__row">
              <Icon name="email" />
              <span class="contact__value">
                {"Email domain: "}
                <Theirs text={entry.domain} />
              </span>
              <span class="sup-contact__meta">{entry.payments === 1 ? "on 1 payment" : `on ${entry.payments} payments`}</span>
            </div>
          </div>
        ),
      )}
    </>
  );
}

function phoneWords(ending: string | null): string {
  return ending === null ? "No phone on file" : `Phone ending ${ending}`;
}

function originWords(origin: PhoneVersionView["origin"]): string | null {
  return origin === "migrated" ? "on file before PayOnce kept who set it" : origin === "scenario" ? "put on file by the demo scenario" : null;
}

function Proposed(props: { by: string | null; at: string | null }): JSX.Element | null {
  return props.by === null ? null : (
    <>
      {"proposed by "}
      <Theirs text={props.by} />
      {props.at === null ? null : (
        <>
          {" "}
          <When at={props.at} />
        </>
      )}
    </>
  );
}

function ClosedVersion(props: { version: PhoneVersionView }): JSX.Element {
  const v: PhoneVersionView = props.version;
  const outcome: ComponentChildren =
    v.state === "proposed" ? (
      "waiting"
    ) : v.state === "on_file" ? (
      "on file"
    ) : (
      <>
        {v.state}
        {v.closedBy === null ? null : (
          <>
            {" by "}
            <Theirs text={v.closedBy} />
          </>
        )}{" "}
        <When at={v.closedAt} />
      </>
    );
  return (
    <li>
      <Dotted
        parts={[
          phoneWords(v.ending),
          originWords(v.origin) ?? <Proposed by={v.proposedBy} at={v.proposedAt} />,
          v.confirmedBy === null ? null : (
            <>
              {"confirmed by "}
              <Theirs text={v.confirmedBy} /> <When at={v.confirmedAt} />
            </>
          ),
          outcome,
        ]}
      />
    </li>
  );
}

// The number waiting, the number on file, then every closed version, newest first.
function History(props: { contact: SupplierContactView }): JSX.Element | null {
  const { proposal, phone, history } = props.contact;
  if (history.length === 0 && (proposal === null || phone === null)) {
    return null;
  }
  return (
    <details class="details sup-history">
      <summary>History</summary>
      <ul class="sup-history__list">
        {proposal === null ? null : (
          <li key={`p-${proposal.contactId}`}>
            <Dotted
              parts={[
                proposal.removal ? "Taking the number off file" : phoneWords(proposal.ending),
                <Proposed by={proposal.proposedBy} at={proposal.proposedAt} />,
                proposal.lapsed ? "lapsed" : "waiting",
              ]}
            />
          </li>
        )}
        {phone === null ? null : (
          <li key={`f-${phone.contactId}`}>
            <Dotted
              parts={[
                phone.removed ? "No phone on file" : phoneWords(phone.ending),
                phone.origin === "person" ? (
                  <>
                    <Proposed by={phone.proposedBy} at={null} />
                    {phone.confirmedBy === null ? null : (
                      <>
                        {", confirmed by "}
                        <Theirs text={phone.confirmedBy} />
                      </>
                    )}
                  </>
                ) : (
                  originWords(phone.origin)
                ),
                phone.since === null || phone.origin === "migrated" ? "on file" : (
                  <>
                    {"on file since "}
                    <Time at={phone.since} />
                  </>
                ),
              ]}
            />
          </li>
        )}
        {history.map(
          (version: PhoneVersionView): JSX.Element => (
            <ClosedVersion key={version.contactId} version={version} />
          ),
        )}
      </ul>
    </details>
  );
}

// ---------- the card ----------

export function ContactCard(props: { view: SupplierView; onActed: Acting }): JSX.Element {
  const contact: SupplierContactView = props.view.contact;
  const key: string = props.view.key;
  const heading: string = useId();
  const propose: Can | null = actionOf(contact, "propose");
  const [proposing, setProposing] = useState<boolean>(false);
  const first: boolean = contact.phoneEnding === null;
  const proposal: PhoneProposalView | null = contact.proposal;

  const acted = (answer: Acted<SupplierView>): void => {
    setProposing(false);
    props.onActed(answer);
  };

  return (
    <section class="card card--accent sup-contact" aria-labelledby={heading}>
      <div class="sup-contact__head">
        <h2 class="sup-contact__title" id={heading}>
          Contact on file
        </h2>
        {propose === null || proposing ? null : (
          <button type="button" class="btn btn--secondary" disabled={!propose.allowed} onClick={(): void => setProposing(true)}>
            {first ? "Propose a phone number" : "Propose a change"}
          </button>
        )}
      </div>
      {propose === null || propose.allowed || propose.why === null ? null : <p class="sup-contact__why">{propose.why.text}</p>}
      <PhoneLine supplierKey={key} contact={contact} />
      {proposing && propose !== null && propose.allowed ? (
        <ProposeForm supplierKey={key} first={first} onActed={acted} onCancel={(): void => setProposing(false)} />
      ) : null}
      {proposal === null ? null : <Proposal key={proposal.contactId} supplierKey={key} view={props.view} proposal={proposal} onActed={acted} />}
      <Domains domains={contact.emailDomains} />
      <p class="sup-contact__rule">{`${contact.notice} Every change needs two people.`}</p>
      <History contact={contact} />
    </section>
  );
}

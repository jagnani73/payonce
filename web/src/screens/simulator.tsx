import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { postJson, type ApiError } from "../api";
import { ActionButton } from "../components/Action";
import { Field, NameField, type ControlProps } from "../components/Form";
import { Icon } from "../components/Icon";
import { Callout } from "../components/Notice";
import { LoadError, Loading } from "../components/States";
import { Theirs, Time } from "../components/Text";
import { useNameDraft } from "../me";
import { notify } from "../notices";
import { usePoll, type Polled } from "../poll";
import { navigate, paymentHref, type Route } from "../router";
import { logAction, PAID, setSandboxOutcome, useSandboxOutcome, useSessionLog, type LogEntry } from "../sandbox";
import type { DuplicateLockResult, PaymentCreated, SandboxView, ScenarioInput } from "../types";
import "./simulator.css";

// The sandbox simulator (ia.md section 11): #sandbox opens this drawer over the
// screen that was on show, which `under` names. Closing it goes back there. It
// plays the bank and the supplier in the Airwallex sandbox, so it is drawn as a
// tool, not as part of the product: striped, dashed and labelled. Data: GET
// /api/sandbox (SandboxView).

// The lists only change when PayOnce restarts.
const SANDBOX_MS: number = 60_000;

type Choice = { id: string; label: string };

function labelOf(choices: readonly Choice[], id: string): string {
  return choices.find((choice: Choice): boolean => choice.id === id)?.label ?? id;
}

// The yellow and black band along the top of the drawer.
function Stripe(): JSX.Element {
  const id: string = useId();
  return (
    <svg class="sim__stripe" width="100%" height="12" aria-hidden="true" focusable="false">
      <defs>
        <pattern id={id} width="16" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="8" height="12" fill="#1f2430" />
        </pattern>
      </defs>
      <rect width="100%" height="12" fill="#f0b45a" />
      <rect width="100%" height="12" fill={`url(#${id})`} />
    </svg>
  );
}

function Section(props: { title: string; children: ComponentChildren }): JSX.Element {
  const id: string = useId();
  return (
    <section class="sim__section" aria-labelledby={id}>
      <h2 class="sim__heading" id={id}>
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function Select(props: { label: string; choices: readonly Choice[]; value: string; onChange: (id: string) => void; hint?: string }): JSX.Element {
  return (
    <Field label={props.label} hint={props.hint}>
      {(control: ControlProps): JSX.Element => (
        <select
          {...control}
          class="select"
          value={props.value}
          onChange={(event: Event): void => props.onChange((event.currentTarget as HTMLSelectElement).value)}
        >
          {props.choices.map(
            (choice: Choice): JSX.Element => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ),
          )}
        </select>
      )}
    </Field>
  );
}

function ScriptedIncident(props: { view: SandboxView }): JSX.Element {
  const { view } = props;
  const [scenario, setScenario] = useState<string>(view.defaults.scenario);
  const [outcome, setOutcome] = useState<string>(view.defaults.bankOutcome);
  const [emails, setEmails] = useState<string>(view.defaults.emails);
  const [invoice, setInvoice] = useState<string>("");
  const [due, setDue] = useState<string>("");
  const [name, setName] = useNameDraft();
  const [invoiceError, setInvoiceError] = useState<string | null>(null);

  async function start(): Promise<void> {
    setInvoiceError(null);
    const body: ScenarioInput = {
      scenario,
      bankOutcome: outcome,
      emails,
      invoiceId: invoice.trim(),
      dueDate: due === "" ? null : due,
      startedBy: name,
    };
    const created: PaymentCreated = await postJson<PaymentCreated>("/api/sandbox/scenarios", body);
    logAction(
      created.invoiceId,
      `Scripted incident started: ${labelOf(view.scenarios, scenario)} · ${labelOf(view.bankOutcomes, outcome)} · ${labelOf(view.emailThreads, emails)}`,
    );
    notify(created.notice);
    navigate(paymentHref(created.invoiceId));
  }

  return (
    <Section title="Run a scripted incident">
      <Select label="Scenario" choices={view.scenarios} value={scenario} onChange={setScenario} />
      <Select label="Bank outcome" choices={view.bankOutcomes} value={outcome} onChange={setOutcome} />
      <Select label="Supplier emails to play" choices={view.emailThreads} value={emails} onChange={setEmails} />
      <div class="sim__pair">
        <Field label="Invoice number (optional)" error={invoiceError}>
          {(control: ControlProps): JSX.Element => (
            <input
              {...control}
              class="input mono"
              type="text"
              autocomplete="off"
              spellcheck={false}
              maxLength={40}
              placeholder="PayOnce makes one"
              value={invoice}
              onInput={(event: Event): void => {
                setInvoice((event.currentTarget as HTMLInputElement).value);
                setInvoiceError(null);
              }}
            />
          )}
        </Field>
        <Field label="Due date (optional)">
          {(control: ControlProps): JSX.Element => (
            <input
              {...control}
              class="input"
              type="date"
              value={due}
              onInput={(event: Event): void => setDue((event.currentTarget as HTMLInputElement).value)}
            />
          )}
        </Field>
      </div>
      <NameField label="Started by" value={name} onInput={setName} hint="You won't be able to approve this payment's transfers." />
      <div>
        <ActionButton
          label="Start scripted incident"
          busyLabel="Starting…"
          kind="primary"
          disabled={name.trim() === ""}
          reason="Enter who is starting it."
          onAction={start}
          onError={(error: ApiError): void => {
            if (error.status === 409) {
              setInvoiceError(error.message);
            }
          }}
        />
      </div>
    </Section>
  );
}

function NextOutcome(props: { view: SandboxView }): JSX.Element {
  const stored: string = useSandboxOutcome();
  const known: boolean = props.view.bankOutcomes.some((choice: Choice): boolean => choice.id === stored);
  return (
    <Section title="Next payment's bank outcome">
      <Select
        label="Outcome"
        choices={props.view.bankOutcomes}
        value={known ? stored : PAID}
        onChange={(id: string): void => {
          setSandboxOutcome(id);
          logAction(null, `Next payment's bank outcome set to ${labelOf(props.view.bankOutcomes, id)}`);
        }}
        hint="Remembered in this browser. New payment uses it for the next first transfer."
      />
    </Section>
  );
}

interface LockTest {
  invoiceId: string;
  refused: boolean;
  text: string;
}

function DuplicateLock(props: { under: Route }): JSX.Element {
  const onPayment: string | null = props.under.screen === "payment" ? (props.under.segments[0] ?? null) : null;
  const [typed, setTyped] = useState<string>(onPayment ?? "");
  const [result, setResult] = useState<LockTest | null>(null);
  const invoiceId: string = typed.trim();

  async function test(): Promise<void> {
    const tested: string = invoiceId;
    const answer: DuplicateLockResult = await postJson<DuplicateLockResult>(`/api/sandbox/duplicate-lock/${encodeURIComponent(tested)}`, {});
    setResult({ invoiceId: tested, refused: answer.refused, text: answer.text });
    logAction(tested, answer.refused ? "Duplicate lock refused a second live transfer" : "Duplicate lock test: not refused. Nothing was sent.");
  }

  return (
    <Section title="Test the duplicate lock">
      <p class="sim__text">
        {invoiceId === ""
          ? "Open a payment to test its duplicate lock, or enter its invoice number."
          : `Asks the ledger to open a second live transfer for ${invoiceId}. The duplicate lock should refuse it. Nothing reaches Airwallex.`}
      </p>
      <Field label="Invoice number">
        {(control: ControlProps): JSX.Element => (
          <input
            {...control}
            class="input mono sim__invoice"
            type="text"
            autocomplete="off"
            spellcheck={false}
            maxLength={40}
            value={typed}
            onInput={(event: Event): void => setTyped((event.currentTarget as HTMLInputElement).value)}
          />
        )}
      </Field>
      <div>
        <ActionButton
          label={invoiceId === "" ? "Test the duplicate lock" : `Test the duplicate lock on ${invoiceId}`}
          busyLabel="Testing…"
          icon={<Icon name="lock" />}
          disabled={invoiceId === ""}
          reason="Enter an invoice number."
          onAction={test}
        />
      </div>
      {result === null ? null : (
        <Callout tone={result.refused ? "info" : "warning"}>
          <p class="sim__result">
            {result.refused
              ? `Refused by the duplicate lock: ${result.invoiceId} already has a transfer that is live or paid.`
              : "Not refused: nothing is live, so PayOnce would decide normally. Nothing was sent."}
          </p>
          <p class="sim__line">
            {"On the timeline: "}
            <Theirs text={result.text} />
          </p>
        </Callout>
      )}
    </Section>
  );
}

function SessionLog(): JSX.Element {
  const entries: LogEntry[] = useSessionLog();
  return (
    <Section title="This session">
      {entries.length === 0 ? (
        <p class="muted">Nothing yet. This list shows what you do here in this tab, newest first.</p>
      ) : (
        <ol class="sim__log">
          {entries.map(
            (entry: LogEntry, index: number): JSX.Element => (
              <li class="sim__log-row" key={`${entry.at}-${index}`}>
                <Time at={entry.at} class="sim__log-time" />
                <span class="sim__log-text">
                  {entry.invoiceId === null ? null : (
                    <>
                      <a class="ref sim__log-ref" href={paymentHref(entry.invoiceId)}>
                        {entry.invoiceId}
                      </a>{" "}
                    </>
                  )}
                  <Theirs text={entry.text} />
                </span>
              </li>
            ),
          )}
        </ol>
      )}
    </Section>
  );
}

const FOCUSABLE: string = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function Simulator(props: { under: Route }): JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const sandbox: Polled<SandboxView> = usePoll<SandboxView>("/api/sandbox", (): number => SANDBOX_MS);
  const close = (): void => navigate(props.under.hash);
  useEffect((): (() => void) => {
    heading.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
        return;
      }
      // Tab stays inside the drawer while it is open.
      if (event.key === "Tab" && panel.current !== null) {
        const stops: HTMLElement[] = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const first: HTMLElement | undefined = stops[0];
        const last: HTMLElement | undefined = stops.at(-1);
        if (first === undefined || last === undefined) {
          return;
        }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return (): void => document.removeEventListener("keydown", onKey);
  }, [props.under.hash]);
  const view: SandboxView | null = sandbox.data;
  return (
    <div class="drawer sim">
      <div class="drawer__backdrop" aria-hidden="true" onClick={close} />
      <aside class="drawer__panel sim__panel" role="dialog" aria-modal="true" aria-labelledby="sim-title" ref={panel}>
        <Stripe />
        <div class="sim__body">
          <div class="drawer__head">
            <div class="sim__titles">
              <span class="sim__tag">Sandbox tool</span>
              <h1 id="sim-title" class="drawer__title" tabIndex={-1} ref={heading}>
                <Icon name="flask" size={22} />
                Sandbox simulator
              </h1>
              <p class="sim__text">Plays the bank and the supplier in the Airwallex sandbox. Nothing here exists in production.</p>
            </div>
            <button type="button" class="icon-button icon-button--framed" aria-label="Close the simulator" onClick={close}>
              <Icon name="close" />
            </button>
          </div>
          <LoadError what="the simulator" error={sandbox.error} />
          {view === null ? (
            sandbox.error === null ? <Loading rows={3} label="Loading the simulator" /> : null
          ) : (
            <>
              <ScriptedIncident view={view} />
              <NextOutcome view={view} />
            </>
          )}
          <DuplicateLock under={props.under} />
          <Section title="Reset">
            <p class="sim__text">
              <code class="sim__code">pnpm reset</code> moves the ledger aside so the next start is empty. Run it in a terminal.
            </p>
          </Section>
          <SessionLog />
        </div>
      </aside>
    </div>
  );
}

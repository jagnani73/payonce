import type { JSX } from "preact";
import { useId, useState } from "preact/hooks";
import { getJson, postJson, query, type ApiError } from "../../api";
import { ActionButton } from "../../components/Action";
import { Field, NameField, type ControlProps } from "../../components/Form";
import { Icon } from "../../components/Icon";
import { Card } from "../../components/Layout";
import { Callout } from "../../components/Notice";
import { Empty, LoadError, Loading } from "../../components/States";
import { Ref, Theirs, Time } from "../../components/Text";
import { useNameDraft } from "../../me";
import { notify } from "../../notices";
import { FAST_MS, SLOW_MS, usePoll, type Polled } from "../../poll";
import { paymentHref } from "../../router";
import { count } from "../../text";
import type { Acted, BreakItemView, ExplainInput, ReconMovementView, ReconMovementsView, ReconView } from "../../types";


// Treasury › Reconciliation (ia.md section 8.2): the breaks that need a person
// first, each kind with its explain form, then what clears by itself, what is
// still inside its window, the wallets and what people explained. GET
// /api/reconcile reads the ledger only; Check now asks the server for one check.

type Group = ReconView["needsPerson"][number];
type Wallet = ReconView["wallets"][number];

// What a form still needs, shown under its field.
interface Missing {
  name: string | null;
  note: string | null;
}


function CheckBar(props: { view: ReconView; polled: Polled<ReconView> }): JSX.Element {
  const view: ReconView = props.view;
  const last: ReconView["lastCheck"] = view.lastCheck;
  return (
    <div class="stack-tight">
      <div class="cash-bar">
        <span class="cash-bar__read">
          {view.running ? "Checking now… · " : null}
          {last === null ? (
            "No check yet"
          ) : (
            <>
              {view.running ? "last check " : "Last check "}
              <Time at={last.at} />
            </>
          )}
          {view.running || view.nextCheckAt === null ? null : (
            <>
              {" · next "}
              <Time at={view.nextCheckAt} />
            </>
          )}
          {view.everyMinutes === null ? " · runs when asked" : ` · every ${count(view.everyMinutes, "minute")}`}
        </span>
        <ActionButton
          label="Check now"
          busyLabel="Starting a check…"
          disabled={!view.can.checkNow.allowed}
          reason={view.can.checkNow.why?.text ?? null}
          onAction={async (): Promise<void> => {
            await postJson<{ started: boolean }>("/api/reconcile/run", {});
            notify({ tone: "info", text: "Reconciliation check started. The page updates when it ends." });
            props.polled.refresh();
          }}
        />
      </div>
      {last === null || last.ok ? null : (
        <Callout tone="danger">
          {"The last check failed and changed no break"}
          {last.problem === null ? null : (
            <>
              {": "}
              <Theirs text={last.problem} />
            </>
          )}
          {". "}
          {last.lastOkAt === null ? (
            "No check has worked yet."
          ) : (
            <>
              {"The last one that worked ran at "}
              <Time at={last.lastOkAt} />
              {"."}
            </>
          )}
        </Callout>
      )}
    </div>
  );
}

function BreakRow(props: { item: BreakItemView; picked: boolean; onPick: (picked: boolean) => void }): JSX.Element {
  const item: BreakItemView = props.item;
  const id: string = useId();
  return (
    <li class="break">
      <input id={id} type="checkbox" class="break__box" checked={props.picked} onChange={(event: Event): void => props.onPick((event.currentTarget as HTMLInputElement).checked)} />
      <label for={id} class="break__text">
        <span>{item.text}</span>
        <span class="break__meta">
          {[
            item.currency,
            item.invoiceId === null ? null : (
              <a class="ref" href={paymentHref(item.invoiceId)}>
                {item.invoiceId}
              </a>
            ),
            item.reference === null ? null : <Ref>{item.reference}</Ref>,
            <>
              {"found "}
              <Time at={item.openedAt ?? item.foundAt} />
            </>,
          ]
            .filter((part: JSX.Element | string | null): boolean => part !== null)
            .map(
              (part: JSX.Element | string | null, index: number): JSX.Element => (
                <span key={index}>
                  {index === 0 ? null : " · "}
                  {part}
                </span>
              ),
            )}
        </span>
      </label>
    </li>
  );
}

// One kind of break, its breaks to tick and its explain form. The ticks and the
// note are this form's own drafts, so a poll never wipes them; a break that
// arrives later starts unticked.
function BreakGroup(props: { group: Group; can: boolean; why: string | null; polled: Polled<ReconView> }): JSX.Element {
  const group: Group = props.group;
  const [ticked, setTicked] = useState<ReadonlySet<number>>((): Set<number> => new Set(group.items.map((item: BreakItemView): number => item.id)));
  const [name, setName] = useNameDraft();
  const [note, setNote] = useState<string>("");
  const [missing, setMissing] = useState<Missing>({ name: null, note: null });
  const picked: BreakItemView[] = group.items.filter((item: BreakItemView): boolean => ticked.has(item.id));
  const pick = (item: BreakItemView, on: boolean): void => {
    const next: Set<number> = new Set(ticked);
    if (on) {
      next.add(item.id);
    } else {
      next.delete(item.id);
    }
    setTicked(next);
  };

  async function explain(): Promise<void> {
    const problems: Missing = {
      name: name.trim() === "" ? "Enter your name." : null,
      note: note.trim() === "" ? "Add a note saying what you found." : null,
    };
    setMissing(problems);
    if (problems.name !== null || problems.note !== null) {
      return;
    }
    const body: ExplainInput = {
      breaks: picked.map((item: BreakItemView) => ({ id: item.id, fingerprint: item.fingerprint })),
      explainedBy: name.trim(),
      note: note.trim(),
    };
    const acted: Acted<ReconView> = await postJson<Acted<ReconView>>("/api/reconcile/explain", body);
    setNote("");
    props.polled.replace(acted.view);
    notify(acted.notice);
  }

  return (
    <section class="break-group" aria-label={group.label}>
      <h3 class="break-group__title">{`${group.label} (${group.count})`}</h3>
      {group.action === "" ? null : <p class="break-group__action">{group.action}</p>}
      <ul class="breaks">
        {group.items.map(
          (item: BreakItemView): JSX.Element => (
            <BreakRow key={item.id} item={item} picked={ticked.has(item.id)} onPick={(on: boolean): void => pick(item, on)} />
          ),
        )}
      </ul>
      <div class="form-row">
        <Field label="Note" error={missing.note} class="form-row__wide">
          {(control: ControlProps): JSX.Element => (
            <input
              {...control}
              class="input"
              type="text"
              maxLength={200}
              autocomplete="off"
              placeholder="What you found in Airwallex"
              value={note}
              onInput={(event: Event): void => {
                setNote((event.currentTarget as HTMLInputElement).value);
                setMissing((now: Missing): Missing => ({ ...now, note: null }));
              }}
            />
          )}
        </Field>
        <NameField
          label="Explained by"
          value={name}
          error={missing.name}
          onInput={(value: string): void => {
            setName(value);
            setMissing((now: Missing): Missing => ({ ...now, name: null }));
          }}
        />
        <ActionButton
          label={picked.length === 0 ? "Explain" : `Explain ${count(picked.length, "break")}`}
          busyLabel="Explaining…"
          kind="primary"
          disabled={!props.can || picked.length === 0}
          reason={!props.can ? props.why : "Tick the breaks to explain."}
          onError={(error: ApiError): void => {
            if (error.status === 404 || error.status === 409) {
              props.polled.refresh();
            }
          }}
          onAction={explain}
        />
      </div>
      <p class="muted form-note">
        Explaining moves no money and changes no payment. It covers the ticked breaks with the facts shown here. If their facts change,
        they open again.
      </p>
    </section>
  );
}

function Breaks(props: { view: ReconView; polled: Polled<ReconView> }): JSX.Element {
  const view: ReconView = props.view;
  return (
    <Card title="Breaks that need a person" accent class="breaks-card">
      {view.needsPerson.length === 0 ? (
        <p class="muted">No breaks need a person.</p>
      ) : (
        view.needsPerson.map(
          (group: Group): JSX.Element => (
            <BreakGroup key={group.kind} group={group} can={view.can.explain.allowed} why={view.can.explain.why?.text ?? null} polled={props.polled} />
          ),
        )
      )}
    </Card>
  );
}

function Clearing(props: { view: ReconView }): JSX.Element | null {
  const groups: ReconView["clearingByThemselves"] = props.view.clearingByThemselves;
  if (groups.length === 0) {
    return null;
  }
  const total: number = groups.reduce((sum: number, group: { count: number }): number => sum + group.count, 0);
  return (
    <section class="card">
      <details class="fold">
        <summary class="fold__summary">{`Clearing by themselves (${total})`}</summary>
        <ul class="plain-list">
          {groups.map(
            (group: ReconView["clearingByThemselves"][number]): JSX.Element => (
              <li key={group.kind}>{`${group.label} · ${group.count}`}</li>
            ),
          )}
        </ul>
        <p class="muted form-note">These clear once the next check finds what they are waiting for.</p>
      </details>
    </section>
  );
}

function Waiting(props: { view: ReconView }): JSX.Element | null {
  const items: ReconView["waiting"] = props.view.waiting;
  if (items.length === 0) {
    return null;
  }
  return (
    <Card title="Waiting" level={2}>
      <ul class="plain-list">
        {items.map(
          (item: ReconView["waiting"][number], index: number): JSX.Element => (
            <li key={index}>
              {item.text}
              {item.dueAt === null ? null : (
                <>
                  {" · due by "}
                  <Time at={item.dueAt} />
                </>
              )}
            </li>
          ),
        )}
      </ul>
    </Card>
  );
}

interface Moves {
  rows: ReconMovementView[] | null;
  error: string | null;
}

function MovementList(props: { currency: string; moves: Moves }): JSX.Element {
  const { rows, error } = props.moves;
  if (error !== null) {
    return (
      <p class="inline-error" role="alert">
        {`Couldn't load the movements. ${error}`}
      </p>
    );
  }
  if (rows === null) {
    return <p class="muted">Loading movements…</p>;
  }
  if (rows.length === 0) {
    return <p class="muted">No movements are stored for this wallet.</p>;
  }
  return (
    <ol class="moves">
      {rows.map(
        (row: ReconMovementView): JSX.Element => (
          <li class="move" key={row.id}>
            <Time at={row.postedAt} class="move__when" />
            <span class="move__what">
              <span>{row.typeText}</span>
              <span class="move__how">
                {row.howText}
                {row.reference === null ? null : (
                  <>
                    {" · "}
                    <Ref>{row.reference}</Ref>
                  </>
                )}
                {row.invoiceId === null ? null : (
                  <>
                    {" · "}
                    <a class="ref" href={paymentHref(row.invoiceId)}>
                      {row.invoiceId}
                    </a>
                  </>
                )}
                {row.breakId === null ? null : ` · break ${row.breakId}`}
              </span>
            </span>
            <span class="move__amount">{row.amount === null ? "Can't be read" : row.amount.text}</span>
          </li>
        ),
      )}
    </ol>
  );
}

function WalletCard(props: { wallet: Wallet; breaks: number; moves: Moves | null; onToggle: () => void }): JSX.Element {
  const w: Wallet = props.wallet;
  return (
    <article class="recon-wallet">
      <h3 class="recon-wallet__title">{w.currency}</h3>
      <p>{`${count(w.movements, "movement")} · ${props.breaks === 0 ? "no breaks" : count(props.breaks, "break")}`}</p>
      <p class={w.addsUp ? "recon-wallet__status" : "recon-wallet__status recon-wallet__status--check"}>{w.text}</p>
      {w.reserved === null ? null : <p class="muted">{`Reserved by Airwallex: ${w.reserved.text}`}</p>}
      {w.movements === 0 ? null : (
        <button type="button" class="btn btn--secondary recon-wallet__toggle" aria-expanded={props.moves !== null} onClick={props.onToggle}>
          {props.moves === null ? "Show movements" : "Hide movements"}
        </button>
      )}
      {props.moves === null ? null : <MovementList currency={w.currency} moves={props.moves} />}
    </article>
  );
}

function Wallets(props: { view: ReconView }): JSX.Element | null {
  const view: ReconView = props.view;
  const [moves, setMoves] = useState<Record<string, Moves>>({});
  if (view.wallets.length === 0) {
    return null;
  }
  const busy: Wallet[] = view.wallets.filter((wallet: Wallet): boolean => !wallet.idle);
  const idle: Wallet[] = view.wallets.filter((wallet: Wallet): boolean => wallet.idle);
  const breaksIn = (currency: string): number =>
    view.needsPerson.reduce(
      (sum: number, group: Group): number => sum + group.items.filter((item: BreakItemView): boolean => item.currency === currency).length,
      0,
    );

  async function toggle(currency: string): Promise<void> {
    if (moves[currency] !== undefined) {
      const { [currency]: _closed, ...rest } = moves;
      setMoves(rest);
      return;
    }
    setMoves((now: Record<string, Moves>) => ({ ...now, [currency]: { rows: null, error: null } }));
    let next: Moves;
    try {
      const read: ReconMovementsView = await getJson<ReconMovementsView>(query("/api/reconcile/movements", { currency }));
      next = { rows: read.movements, error: null };
    } catch (error: unknown) {
      next = { rows: null, error: error instanceof Error ? error.message : "The server did not answer." };
    }
    setMoves((now: Record<string, Moves>) => (now[currency] === undefined ? now : { ...now, [currency]: next }));
  }

  return (
    <Card title="Wallets">
      {busy.length === 0 ? null : (
        <div class="recon-wallets">
          {busy.map(
            (wallet: Wallet): JSX.Element => (
              <WalletCard
                key={wallet.currency}
                wallet={wallet}
                breaks={breaksIn(wallet.currency)}
                moves={moves[wallet.currency] ?? null}
                onToggle={(): void => void toggle(wallet.currency)}
              />
            ),
          )}
        </div>
      )}
      {idle.length === 0 ? null : (
        <p class="muted recon-idle">{`${idle.map((wallet: Wallet): string => wallet.currency).join(", ")}: nothing to reconcile`}</p>
      )}
    </Card>
  );
}

function Explained(props: { view: ReconView }): JSX.Element {
  const view: ReconView = props.view;
  const audit: ReconView["audit"] = view.audit;
  return (
    <Card title="Recently explained">
      {view.explained.length === 0 ? (
        <p class="muted">No break has been explained yet.</p>
      ) : (
        <ul class="explained">
          {view.explained.map(
            (item: BreakItemView): JSX.Element => (
              <li key={item.id} class="explained__item">
                <p>
                  <Theirs text={item.explainedBy ?? "Someone"} />
                  {` explained "${item.label}"`}
                  {item.explainedAt === null ? null : (
                    <>
                      {" at "}
                      <Time at={item.explainedAt} />
                    </>
                  )}
                  {item.note === null ? "." : ": "}
                  {item.note === null ? null : <Theirs text={item.note} />}
                </p>
                <p class="muted">{item.text}</p>
              </li>
            ),
          )}
        </ul>
      )}
      <div class="audit-line recon-audit">
        <span class={audit.intact ? "audit-line__state" : "audit-line__state audit-line__state--broken"}>
          <Icon name={audit.intact ? "lock" : "warning"} />
          {`Reconciliation's audit trail: ${audit.intact ? "intact" : "broken"} · ${count(audit.lines, "line")}`}
        </span>
        {audit.problem === null ? null : <span class="inline-error">{audit.problem}</span>}
        <span class="audit-line__exports">
          <a class="btn btn--secondary" href={audit.exports.json} download>
            Export JSON
          </a>
        </span>
      </div>
    </Card>
  );
}

function Recon(props: { view: ReconView; polled: Polled<ReconView> }): JSX.Element {
  const view: ReconView = props.view;
  const never: boolean = view.lastCheck === null && view.wallets.length === 0 && view.explained.length === 0;
  return (
    <>
      <CheckBar view={view} polled={props.polled} />
      {never ? (
        <Empty
          title={
            view.everyMinutes === null
              ? "Reconciliation hasn't run yet. Press Check now to read Airwallex's balance history."
              : "Reconciliation hasn't run yet. It reads Airwallex's balance history a minute after PayOnce starts."
          }
        />
      ) : (
        <>
          <Breaks view={view} polled={props.polled} />
          {view.clearingByThemselves.length === 0 && view.waiting.length === 0 ? null : (
            <div class="two-up">
              <Clearing view={view} />
              <Waiting view={view} />
            </div>
          )}
          <Wallets view={view} />
          <Explained view={view} />
        </>
      )}
    </>
  );
}

export function ReconTab(): JSX.Element {
  const recon: Polled<ReconView> = usePoll<ReconView>("/api/reconcile", (view: ReconView | null): number =>
    view?.running === true ? FAST_MS : SLOW_MS,
  );
  return (
    <div class="tab-panel" role="region" aria-label="Reconciliation">
      <LoadError what="reconciliation" error={recon.error} />
      {recon.data === null ? (
        recon.error === null ? <Loading rows={3} label="Loading reconciliation" /> : null
      ) : (
        <Recon view={recon.data} polled={recon} />
      )}
    </div>
  );
}

import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { LinkButton } from "../components/Action";
import { Field, type ControlProps } from "../components/Form";
import { Icon } from "../components/Icon";
import { Tabs, type TabItem } from "../components/Layout";
import { Empty, LoadError, Loading } from "../components/States";
import { Theirs } from "../components/Text";
import { useMedia, useTitle, WIDE } from "../hooks";
import { useMe } from "../me";
import { usePoll, type Polled } from "../poll";
import { navigate, replaceRoute, type ScreenProps } from "../router";
import { count } from "../text";
import type { IncidentRow, IncidentScope, IncidentsView, Origin, QueueGroup } from "../types";
import { countOf, filtersHref, filtersOf, MAX_QUERY, narrowed, SCOPES, shownScope, viewPath, type Filters } from "./incidents/filters";
import { OutageStrips, PaymentCards, PaymentsTable, Totals, type Group } from "./incidents/list";
import "./incidents.css";

// Incidents (ia.md section 2): every payment, by scope, from GET /api/incidents.
// The filters live in the route. The view reads every payment's snapshot, so it
// is polled gently: every 10 s, and every 3 s while PayOnce is working on a
// payment shown.

const QUIET_MS: number = 10_000;
const BUSY_MS: number = 3_000;
// Typing in the search field changes the route once it pauses this long.
const TYPING_MS: number = 300;
// Closed payments are many; they show this many at a time.
const CLOSED_PAGE: number = 25;

const GROUPS: readonly QueueGroup[] = ["needs-you", "bank-late", "with-bank", "payonce", "closed"];

const EMPTY: Record<IncidentScope, string> = {
  "needs-you": "Nothing needs you right now.",
  "bank-late": "No transfers are late.",
  "with-bank": "Nothing is with the bank.",
  payonce: "PayOnce isn't handling anything.",
  closed: "No closed payments yet.",
  all: "No payments yet.",
};

const ORIGINS: { value: Origin; label: string }[] = [
  { value: "payonce", label: "Started in PayOnce" },
  { value: "outside", label: "Sent outside PayOnce" },
  { value: "pay-run", label: "Pay run" },
];

function pace(view: IncidentsView | null): number {
  return view !== null && view.rows.some((row: IncidentRow): boolean => row.activity.busy) ? BUSY_MS : QUIET_MS;
}

function labelOf(view: IncidentsView, scope: IncidentScope): string {
  return view.scopes.find((item: IncidentsView["scopes"][number]): boolean => item.scope === scope)?.label ?? scope;
}

function groupsOf(view: IncidentsView, scope: IncidentScope, closedLimit: number): Group[] {
  const rows: IncidentRow[] = view.rows.filter((row: IncidentRow): boolean => scope === "all" || row.situation.group === scope);
  return GROUPS.map((group: QueueGroup): Group => {
    const all: IncidentRow[] = rows.filter((row: IncidentRow): boolean => row.situation.group === group);
    return { group, label: labelOf(view, group), total: all.length, rows: group === "closed" ? all.slice(0, closedLimit) : all };
  }).filter((group: Group): boolean => group.total > 0);
}

// The payments the "clean" filter leaves out: closed ones that never had an
// incident. Known only when nothing else narrows the list.
function hiddenClean(view: IncidentsView, filters: Filters, me: string | null): number {
  return filters.clean || narrowed(filters, me) ? 0 : Math.max(0, view.ledgerCount - countOf(view, "all"));
}

function FiltersRow(props: {
  view: IncidentsView;
  filters: Filters;
  scope: IncidentScope;
  me: string | null;
  draft: string;
  onDraft: (text: string) => void;
  onCommit: () => void;
  go: (next: Partial<Filters>) => void;
}): JSX.Element {
  const { view, filters, me } = props;
  const wallets: string[] = [...new Set<string>([...view.wallets, ...(filters.currency === null ? [] : [filters.currency])])];
  return (
    <form
      class="ifilters"
      onSubmit={(event: Event): void => {
        event.preventDefault();
        props.onCommit();
      }}
    >
      <Field label="Search" class="ifilters__search">
        {(control: ControlProps): JSX.Element => (
          <input
            {...control}
            class="input"
            type="search"
            placeholder="Invoice, supplier or reference"
            autocomplete="off"
            spellcheck={false}
            maxLength={MAX_QUERY}
            value={props.draft}
            onInput={(event: Event): void => props.onDraft((event.currentTarget as HTMLInputElement).value)}
          />
        )}
      </Field>
      <Field label="Wallet" class="ifilters__pick">
        {(control: ControlProps): JSX.Element => (
          <select
            {...control}
            class="select"
            value={filters.currency ?? ""}
            onChange={(event: Event): void => {
              const value: string = (event.currentTarget as HTMLSelectElement).value;
              props.go({ currency: value === "" ? null : value });
            }}
          >
            <option value="">All</option>
            {wallets.map(
              (wallet: string): JSX.Element => (
                <option key={wallet} value={wallet}>
                  {wallet}
                </option>
              ),
            )}
          </select>
        )}
      </Field>
      <Field label="Origin" class="ifilters__pick ifilters__pick--wide">
        {(control: ControlProps): JSX.Element => (
          <select
            {...control}
            class="select"
            value={filters.origin ?? ""}
            onChange={(event: Event): void => {
              const value: string = (event.currentTarget as HTMLSelectElement).value;
              props.go({ origin: ORIGINS.find((origin: { value: Origin }): boolean => origin.value === value)?.value ?? null });
            }}
          >
            <option value="">All</option>
            {ORIGINS.map(
              (origin: { value: Origin; label: string }): JSX.Element => (
                <option key={origin.value} value={origin.value}>
                  {origin.label}
                </option>
              ),
            )}
          </select>
        )}
      </Field>
      <div class="ifilters__toggles">
        <label class={me === null ? "icheck is-off" : "icheck"}>
          <input
            type="checkbox"
            checked={filters.me && me !== null}
            disabled={me === null}
            onChange={(event: Event): void => props.go({ me: (event.currentTarget as HTMLInputElement).checked })}
          />
          <span>
            {"Waiting for me"}
            {me === null ? null : (
              <>
                {" ("}
                <Theirs text={me} />
                {")"}
              </>
            )}
          </span>
        </label>
        {me === null ? <span class="ifilters__hint">Choose your name in You are first.</span> : null}
        {props.scope === "closed" || props.scope === "all" ? (
          <label class="icheck">
            <input
              type="checkbox"
              checked={filters.clean}
              onChange={(event: Event): void => props.go({ clean: (event.currentTarget as HTMLInputElement).checked })}
            />
            <span>Include payments with no incident</span>
          </label>
        ) : null}
      </div>
    </form>
  );
}

function Nothing(props: {
  view: IncidentsView;
  filters: Filters;
  scope: IncidentScope;
  me: string | null;
  go: (next: Partial<Filters>) => void;
}): JSX.Element {
  const { view, filters, scope, me } = props;
  if (narrowed(filters, me)) {
    return (
      <Empty title="No payments match these filters.">
        <button type="button" class="btn btn--secondary" onClick={(): void => props.go({ q: "", currency: null, origin: null, me: false })}>
          Clear filters
        </button>
      </Empty>
    );
  }
  if (scope === "all" && view.ledgerCount === 0) {
    return (
      <Empty title={EMPTY.all}>
        <LinkButton href="#new-payment" kind="primary">
          New payment
        </LinkButton>
      </Empty>
    );
  }
  const hidden: number = hiddenClean(view, filters, me);
  if ((scope === "closed" || scope === "all") && hidden > 0) {
    return (
      <Empty title={scope === "all" ? "No payments with an incident." : "No closed payments with an incident."}>
        <p class="muted">{`${count(hidden, "payment was", "payments were")} paid by their first transfer and had no incident.`}</p>
        <button type="button" class="btn btn--secondary" onClick={(): void => props.go({ clean: true })}>
          Include payments with no incident
        </button>
      </Empty>
    );
  }
  return <Empty title={EMPTY[scope]} />;
}

function List(props: {
  view: IncidentsView;
  filters: Filters;
  scope: IncidentScope;
  me: string | null;
  go: (next: Partial<Filters>) => void;
}): JSX.Element {
  const { view, filters, scope, me } = props;
  const wide: boolean = useMedia(WIDE);
  const [closedLimit, setClosedLimit] = useState<number>(CLOSED_PAGE);
  const groups: Group[] = groupsOf(view, scope, closedLimit);
  if (groups.length === 0) {
    return <Nothing {...props} />;
  }
  const closed: Group | undefined = groups.find((group: Group): boolean => group.group === "closed");
  const hidden: number = scope === "closed" || scope === "all" ? hiddenClean(view, filters, me) : 0;
  const headings: boolean = scope === "all";
  return (
    <section class="ilist" aria-label="Payments">
      {wide ? <PaymentsTable groups={groups} headings={headings} /> : <PaymentCards groups={groups} headings={headings} />}
      {closed === undefined || closed.total <= closed.rows.length ? null : (
        <div class="ilist__foot">
          <span>{`Showing ${closed.rows.length} of ${closed.total} closed payments.`}</span>
          <button type="button" class="btn btn--secondary" onClick={(): void => setClosedLimit(closedLimit + CLOSED_PAGE)}>
            Show more
          </button>
        </div>
      )}
      {hidden === 0 ? null : (
        <div class="ilist__foot">
          <span>{`${count(hidden, "payment")} paid by their first transfer ${hidden === 1 ? "is" : "are"} hidden.`}</span>
          <button type="button" class="btn btn--quiet" onClick={(): void => props.go({ clean: true })}>
            Show them
          </button>
        </div>
      )}
    </section>
  );
}

export function Incidents(props: ScreenProps): JSX.Element {
  useTitle("Incidents");
  const filters: Filters = filtersOf(props.route.params);
  const me: string | null = useMe();
  // keep: a new filter keeps the old list on screen until its view lands.
  const incidents: Polled<IncidentsView> = usePoll<IncidentsView>(viewPath(filters, me), pace, { keep: true });
  const view: IncidentsView | null = incidents.data;

  // The search field's draft is the screen's own, so a poll never touches it.
  // It reaches the route once typing pauses, replacing the entry, so Back does
  // not step through every letter. A route change from elsewhere (Back, Clear
  // filters) puts its query in the field.
  const [draft, setDraft] = useState<string>(filters.q);
  const ours = useRef<string | null>(null);
  useEffect((): void => {
    if (filters.q !== ours.current && draft.trim() !== filters.q) {
      setDraft(filters.q);
    }
    ours.current = null;
  }, [filters.q]);

  const scope: IncidentScope = view === null ? (filters.scope ?? "needs-you") : shownScope(filters, view);

  // Any change pins the scope on show, so the default never moves under a filter.
  function go(next: Partial<Filters>, replace: boolean = false): void {
    const target: Filters = { ...filters, scope, q: draft, ...next };
    const href: string = filtersHref(target);
    if (href === props.route.hash) {
      return;
    }
    if (target.q.trim() !== filters.q) {
      ours.current = target.q.trim();
    }
    if (next.q !== undefined && next.q !== draft) {
      setDraft(next.q);
    }
    if (replace) {
      replaceRoute(href);
    } else {
      navigate(href);
    }
  }

  // The timer calls the latest go, so a tab picked while it waits is kept.
  const latest = useRef<typeof go>(go);
  latest.current = go;
  useEffect((): (() => void) | undefined => {
    if (draft.trim() === filters.q) {
      return undefined;
    }
    const timer: number = window.setTimeout((): void => latest.current({ q: draft }, true), TYPING_MS);
    return (): void => window.clearTimeout(timer);
  }, [draft, filters.q]);

  return (
    <div class="screen incidents">
      <header class="incidents__head">
        <h1 class="screen__title">Incidents</h1>
        <LinkButton href="#new-payment" kind="primary" class="incidents__new">
          <Icon name="plus" />
          New payment
        </LinkButton>
      </header>
      <LoadError what="Incidents" error={incidents.error} />
      {view === null ? (
        incidents.error === null ? (
          <Loading rows={5} label="Loading payments" />
        ) : null
      ) : (
        <>
          <Tabs
            label="Scope"
            tabs={SCOPES.map(
              (item: IncidentScope): TabItem => ({
                key: item,
                label: labelOf(view, item),
                count: countOf(view, item),
                href: filtersHref({ ...filters, scope: item, q: draft }),
              }),
            )}
            current={scope}
            flush
          />
          <FiltersRow
            view={view}
            filters={filters}
            scope={scope}
            me={me}
            draft={draft}
            onDraft={setDraft}
            onCommit={(): void => go({ q: draft }, true)}
            go={go}
          />
          {view.outages.length === 0 ? null : <OutageStrips outages={view.outages} />}
          <Totals totals={view.totals} />
          <List view={view} filters={filters} scope={scope} me={me} go={go} />
        </>
      )}
    </div>
  );
}

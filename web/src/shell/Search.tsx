import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { getJson, query } from "../api";
import { Icon } from "../components/Icon";
import { Theirs } from "../components/Text";
import { useDebouncedCheck, useDismiss, type Checked } from "../hooks";
import { navigate, paymentHref, runHref, supplierHref } from "../router";
import type { SearchView } from "../types";

// The search box (ia.md section 0, item 3). Typing shows up to 8 suggestions
// from GET /api/search, grouped. Enter opens an exact invoice number or bank
// reference straight away, and anything else on #search?q=….

const MAX_SHOWN: number = 8;
const WAIT_MS: number = 250;
const MAX_QUERY: number = 100;

interface Suggestion {
  key: string;
  href: string;
  lead: string;
  mono: boolean;
  rest: string | null;
}

interface Group {
  label: string;
  items: Suggestion[];
}

function groupsOf(view: SearchView): Group[] {
  const groups: Group[] = [
    {
      label: "Payments",
      items: view.payments.map((p) => ({ key: `p-${p.invoiceId}`, href: paymentHref(p.invoiceId), lead: p.invoiceId, mono: true, rest: p.supplier })),
    },
    {
      label: "Suppliers",
      items: view.suppliers.map((s) => ({ key: `s-${s.key}`, href: supplierHref(s.key), lead: s.name, mono: false, rest: s.hint })),
    },
    {
      label: "Pay runs",
      items: view.runs.map((r) => ({ key: `r-${r.id}`, href: runHref(r.id), lead: `Pay run ${r.id}`, mono: false, rest: r.fileName })),
    },
    {
      label: "Emails",
      items: view.emails.map((e) => ({ key: `e-${e.id}`, href: `#inbox/${e.id}`, lead: e.subject, mono: false, rest: e.from })),
    },
    {
      label: "Transfers",
      items: view.transfers.map((t) => ({ key: `t-${t.reference}`, href: paymentHref(t.invoiceId), lead: t.reference, mono: true, rest: t.invoiceId })),
    },
  ];
  let left: number = MAX_SHOWN;
  return groups
    .map((group: Group): Group => {
      const items: Suggestion[] = group.items.slice(0, Math.max(0, left));
      left -= items.length;
      return { label: group.label, items };
    })
    .filter((group: Group): boolean => group.items.length > 0);
}

export function Search(props: { onGo?: () => void }): JSX.Element {
  const [q, setQ] = useState<string>("");
  const [open, setOpen] = useState<boolean>(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useDismiss(open, (): void => setOpen(false), box, input);

  const wanted: string = q.trim();
  const suggested: Checked<SearchView> | null = useDebouncedCheck<SearchView>(
    wanted === "" || wanted.length > MAX_QUERY ? null : wanted,
    WAIT_MS,
    (asked: string): Promise<SearchView> => getJson<SearchView>(query("/api/search", { q: asked })),
  ).checked;
  const found: SearchView | null = suggested !== null && suggested.input === wanted ? suggested.answer : null;

  function go(href: string): void {
    setOpen(false);
    props.onGo?.();
    navigate(href);
  }

  function submit(event: Event): void {
    event.preventDefault();
    if (wanted === "") {
      return;
    }
    const exact: string | null = found?.exact?.href ?? null;
    go(exact ?? query("#search", { q: wanted.slice(0, MAX_QUERY) }));
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      const first: HTMLAnchorElement | null | undefined = list.current?.querySelector("a");
      if (first !== null && first !== undefined) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  const groups: Group[] = found === null ? [] : groupsOf(found);
  return (
    <div class="search" ref={box}>
      <form role="search" onSubmit={submit}>
        <label class="search-field">
          <span class="visually-hidden">Search</span>
          <Icon name="search" />
          <input
            ref={input}
            class="input search__input"
            type="search"
            placeholder="Search invoice, supplier or reference"
            autocomplete="off"
            spellcheck={false}
            maxLength={MAX_QUERY}
            value={q}
            onInput={(event: Event): void => {
              setQ((event.currentTarget as HTMLInputElement).value);
              setOpen(true);
            }}
            onFocus={(): void => setOpen(true)}
            onKeyDown={onKey}
          />
        </label>
      </form>
      {open && wanted !== "" && groups.length > 0 ? (
        <div class="search__list popover" ref={list}>
          {groups.map(
            (group: Group): JSX.Element => (
              <div class="search__group" key={group.label}>
                <p class="search__group-label">{group.label}</p>
                {group.items.map(
                  (item: Suggestion): JSX.Element => (
                    <a
                      key={item.key}
                      class="search__item"
                      href={item.href}
                      onClick={(event: Event): void => {
                        event.preventDefault();
                        go(item.href);
                      }}
                    >
                      {item.mono ? <span class="ref">{item.lead}</span> : <Theirs text={item.lead} class="search__lead" />}
                      {item.rest === null ? null : <Theirs text={item.rest} class="search__rest" />}
                    </a>
                  ),
                )}
              </div>
            ),
          )}
          <a
            class="search__all"
            href={query("#search", { q: wanted })}
            onClick={(event: Event): void => {
              event.preventDefault();
              go(query("#search", { q: wanted }));
            }}
          >
            See every result for “{wanted}”
          </a>
        </div>
      ) : null}
    </div>
  );
}

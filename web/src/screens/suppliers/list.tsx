import type { JSX } from "preact";
import { useEffect, useId, useState } from "preact/hooks";
import { query } from "../../api";
import { Icon } from "../../components/Icon";
import { Card } from "../../components/Layout";
import { Empty, LoadError, Loading } from "../../components/States";
import { Theirs } from "../../components/Text";
import { useTitle } from "../../hooks";
import { SLOW_MS, usePoll, type Polled } from "../../poll";
import { replaceRoute, supplierHref, type Route } from "../../router";
import type { SupplierListRow, SuppliersView } from "../../types";
import { endingText, paymentsText, phoneText } from "./words";

// The supplier list (ia.md section 7): one row per Airwallex beneficiary PayOnce
// has paid or a pay run names, from GET /api/suppliers?q=. Rows that share a
// name say so and are told apart by currency, method, account ending and phone.

// The search follows the hash (#suppliers?q=…) a moment after typing stops, so
// a link keeps it and typing never adds a history entry per key.
const TYPING_MS: number = 300;
const MAX_QUERY: number = 100;

function searchHash(q: string): string {
  return query("#suppliers", { q: q.trim() });
}

function SearchBox(props: { value: string; onInput: (value: string) => void; onSubmit: () => void }): JSX.Element {
  const id: string = useId();
  return (
    <form
      class="search-field sup-search screen__end"
      role="search"
      onSubmit={(event: Event): void => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <label class="visually-hidden" for={id}>
        Search suppliers
      </label>
      <Icon name="search" />
      <input
        id={id}
        class="input"
        type="search"
        autocomplete="off"
        spellcheck={false}
        maxLength={MAX_QUERY}
        placeholder="Name or record id"
        value={props.value}
        onInput={(event: Event): void => props.onInput((event.currentTarget as HTMLInputElement).value)}
      />
    </form>
  );
}

function Row(props: { row: SupplierListRow }): JSX.Element {
  const row: SupplierListRow = props.row;
  const body: JSX.Element = (
    <>
      <span class="sup-row__name">
        <Theirs text={row.name === "" ? "No name on file" : row.name} class="sup-row__who" />
        {row.sameName === 0 ? null : (
          <span class="sup-row__same">{`${row.sameName + 1} records share this name`}</span>
        )}
      </span>
      <span class="sup-row__hint">{row.hint === "" ? "No payments yet" : row.hint}</span>
      <span class={row.accountEnding === null ? "sup-row__account sup-row__account--none" : "sup-row__account mono"}>{endingText(row.accountEnding)}</span>
      <span class={row.phoneEnding === null ? "sup-row__phone sup-row__phone--none" : "sup-row__phone"}>{phoneText(row.phoneEnding)}</span>
      <span class="sup-row__payments">{paymentsText(row.payments)}</span>
      <span class="sup-row__cautions">
        {row.cautions.map(
          (caution: SupplierListRow["cautions"][number]): JSX.Element => (
            <span class="tag tag--warn" key={caution.code}>
              {caution.text}
            </span>
          ),
        )}
      </span>
    </>
  );
  return (
    <li>
      {row.key === null ? (
        <div class="sup-row sup-row--unlinked">
          {body}
          <span class="sup-row__note">Its record id can't be linked, so it has no page.</span>
        </div>
      ) : (
        <a class="sup-row" href={supplierHref(row.key)} title={`Record ${row.key.slice(0, 8)}`}>
          {body}
        </a>
      )}
    </li>
  );
}

function Rows(props: { view: SuppliersView; q: string; onClear: () => void }): JSX.Element {
  const rows: SupplierListRow[] = props.view.rows;
  if (rows.length === 0) {
    return props.q === "" ? (
      <Empty title="No supplier records yet.">
        <p class="muted">A record appears when PayOnce pays an Airwallex beneficiary or a pay run names one.</p>
      </Empty>
    ) : (
      <Empty title={`No supplier records match “${props.q}”.`}>
        <button type="button" class="btn btn--secondary" onClick={props.onClear}>
          Clear search
        </button>
      </Empty>
    );
  }
  return (
    <Card flush>
      <div class="sup-row sup-row--head" aria-hidden="true">
        <span>Supplier</span>
        <span>Wallet and method</span>
        <span>Account</span>
        <span>Phone</span>
        <span>Payments</span>
        <span>Cautions</span>
      </div>
      <ul class="sup-rows" aria-label="Supplier records">
        {rows.map(
          (row: SupplierListRow, index: number): JSX.Element => (
            <Row key={row.key ?? `unlinked-${index}`} row={row} />
          ),
        )}
      </ul>
    </Card>
  );
}

export function SupplierList(props: { route: Route }): JSX.Element {
  useTitle("Suppliers");
  const applied: string = (props.route.params.get("q") ?? "").trim();
  const [draft, setDraft] = useState<string>(applied);

  // Typing settles into the hash; a hash changed elsewhere (Back, a link) comes
  // back into the field.
  useEffect((): (() => void) | undefined => {
    if (draft.trim() === applied) {
      return undefined;
    }
    const timer: number = window.setTimeout((): void => replaceRoute(searchHash(draft)), TYPING_MS);
    return (): void => window.clearTimeout(timer);
  }, [draft]);
  useEffect((): void => {
    setDraft((now: string): string => (now.trim() === applied ? now : applied));
  }, [applied]);

  const list: Polled<SuppliersView> = usePoll<SuppliersView>(query("/api/suppliers", { q: applied }), (): number => SLOW_MS, { keep: true });
  return (
    <div class="screen sup">
      <header class="screen__bar">
        <h1 class="screen__title">Suppliers</h1>
        <SearchBox
          value={draft}
          onInput={setDraft}
          onSubmit={(): void => {
            if (draft.trim() !== applied) {
              replaceRoute(searchHash(draft));
            }
          }}
        />
      </header>
      <LoadError what="the suppliers" error={list.error} />
      {list.data === null ? (
        list.error === null ? (
          <Card flush>
            <Loading rows={3} label="Loading the suppliers" />
          </Card>
        ) : null
      ) : (
        <Rows
          view={list.data}
          q={applied}
          onClear={(): void => {
            setDraft("");
            replaceRoute("#suppliers");
          }}
        />
      )}
    </div>
  );
}

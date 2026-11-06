import type { ComponentChildren, JSX } from "preact";
import { useId } from "preact/hooks";
import { navigate } from "../router";

// Cards, tabs and tables: the boxes every screen is made of.

// A white box with an optional heading row. flush: the body has no padding, for
// a list of rows that draw their own dividers. accent: the blue border the
// Decision panel uses.
export function Card(props: {
  title?: string;
  level?: 2 | 3;
  sub?: ComponentChildren;
  actions?: ComponentChildren;
  flush?: boolean;
  accent?: boolean;
  class?: string;
  children?: ComponentChildren;
}): JSX.Element {
  const id: string = useId();
  const Heading: "h2" | "h3" = props.level === 3 ? "h3" : "h2";
  const classes: string = ["card", props.flush === true ? "card--flush" : "", props.accent === true ? "card--accent" : "", props.class ?? ""]
    .filter((name: string): boolean => name !== "")
    .join(" ");
  return (
    <section class={classes} aria-labelledby={props.title === undefined ? undefined : id}>
      {props.title === undefined ? null : (
        <div class="card__head">
          <Heading id={id} class="card__title">
            {props.title}
          </Heading>
          {props.sub === undefined ? null : <span class="card__sub">{props.sub}</span>}
          {props.actions === undefined ? null : <div class="card__actions">{props.actions}</div>}
        </div>
      )}
      {props.children}
    </section>
  );
}

export interface TabItem {
  key: string;
  label: string;
  count?: number | null;
  // A routed tab links to its hash; the others call onSelect.
  href?: string;
}

// Tabs above a card or a screen. A tab that is a route is a link with
// aria-current; on a phone the tabs become a select. Without hrefs they are
// toggle buttons and onSelect picks.
export function Tabs(props: {
  label: string;
  tabs: TabItem[];
  current: string;
  onSelect?: (key: string) => void;
}): JSX.Element {
  const id: string = useId();
  const pick = (key: string): void => {
    const tab: TabItem | undefined = props.tabs.find((item: TabItem): boolean => item.key === key);
    if (tab?.href !== undefined) {
      navigate(tab.href);
    } else {
      props.onSelect?.(key);
    }
  };
  const text = (tab: TabItem): string => (tab.count === null || tab.count === undefined ? tab.label : `${tab.label} ${tab.count}`);
  return (
    <div class="tabs">
      <nav class="tabs__row" aria-label={props.label}>
        {props.tabs.map((tab: TabItem): JSX.Element => {
          const on: boolean = tab.key === props.current;
          const body: JSX.Element = (
            <>
              {tab.label}
              {tab.count === null || tab.count === undefined ? null : <span class="tabs__count">{tab.count}</span>}
            </>
          );
          return tab.href !== undefined ? (
            <a key={tab.key} class="tabs__tab" href={tab.href} aria-current={on ? "page" : undefined}>
              {body}
            </a>
          ) : (
            <button key={tab.key} type="button" class="tabs__tab" aria-pressed={on} onClick={(): void => pick(tab.key)}>
              {body}
            </button>
          );
        })}
      </nav>
      <div class="tabs__select">
        <label class="visually-hidden" for={id}>
          {props.label}
        </label>
        <select id={id} class="select" value={props.current} onChange={(event: Event): void => pick((event.currentTarget as HTMLSelectElement).value)}>
          {props.tabs.map(
            (tab: TabItem): JSX.Element => (
              <option key={tab.key} value={tab.key}>
                {text(tab)}
              </option>
            ),
          )}
        </select>
      </div>
    </div>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  cell: (row: T) => ComponentChildren;
  align?: "start" | "end";
  // A column of figures: right-aligned, tabular.
  numeric?: boolean;
}

// A table that scrolls sideways inside its own box, so the page never does on a
// phone. caption names it for screen readers; minWidth keeps columns readable.
export function Table<T>(props: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  minWidth?: number;
  empty?: string;
}): JSX.Element {
  if (props.rows.length === 0 && props.empty !== undefined) {
    return <p class="muted">{props.empty}</p>;
  }
  return (
    <div class="table-scroll" role="region" aria-label={props.caption} tabIndex={0}>
      <table class="table" style={props.minWidth === undefined ? undefined : { minWidth: `${props.minWidth}px` }}>
        <caption class="visually-hidden">{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map(
              (column: Column<T>): JSX.Element => (
                <th key={column.key} scope="col" class={column.numeric === true || column.align === "end" ? "is-end" : undefined}>
                  {column.label}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {props.rows.map(
            (row: T): JSX.Element => (
              <tr key={props.rowKey(row)}>
                {props.columns.map(
                  (column: Column<T>): JSX.Element => (
                    <td
                      key={column.key}
                      class={column.numeric === true ? "is-end is-numeric" : column.align === "end" ? "is-end" : undefined}
                    >
                      {column.cell(row)}
                    </td>
                  ),
                )}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

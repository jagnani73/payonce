import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { query } from "../api";
import { Icon } from "../components/Icon";
import { Tabs } from "../components/Layout";
import { Empty, LoadError, Loading } from "../components/States";
import { Theirs, Time } from "../components/Text";
import { useMedia, useTitle } from "../hooks";
import { SLOW_MS, usePoll, type Polled } from "../poll";
import { navigate, type ScreenProps } from "../router";
import type { InboxListView, UploadRow, UploadState } from "../types";
import { InboxItem } from "./inbox/Item";
import { UploadDialog } from "./inbox/Upload";
import "./inbox.css";

// The inbox (ia.md section 5): supplier emails people uploaded, by tab, with the
// open one beside the list as the mockup draws it. Routes: #inbox?tab=…,
// #inbox/N, and #inbox?for=ID, which opens the upload dialog for that payment.
// Wide screens show the list and the open email side by side, opening the
// tab's first email when none is named; narrower ones show one at a time.

const TABS: readonly UploadState[] = ["waiting", "delivered", "dismissed"];
// Until the list answers with its own labels.
const TAB_LABELS: Record<UploadState, string> = { waiting: "Waiting", delivered: "Delivered", dismissed: "Dismissed" };
const SIDE_BY_SIDE: string = "(min-width: 1024px)";

const EMPTY: Record<UploadState, { title: string; line: string | null }> = {
  waiting: {
    title: "No emails waiting.",
    line: "When a supplier writes about a payment, upload the .eml file or paste its source here.",
  },
  delivered: { title: "No emails delivered yet.", line: null },
  dismissed: { title: "No emails dismissed.", line: null },
};

function tabOf(raw: string | null): UploadState {
  return TABS.find((tab: UploadState): boolean => tab === raw) ?? "waiting";
}

function idOf(raw: string | undefined): number | null {
  return raw !== undefined && /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : null;
}

function itemHref(id: number, tab: UploadState, preferred: string | null): string {
  return query(`#inbox/${id}`, { tab: tab === "waiting" ? null : tab, for: preferred });
}

function Row(props: { row: UploadRow; tab: UploadState; current: boolean; preferred: string | null }): JSX.Element {
  const row: UploadRow = props.row;
  const matched: boolean = row.suggested !== null || row.state === "delivered";
  return (
    <li>
      <a class="inbox-row" href={itemHref(row.id, props.tab, props.preferred)} aria-current={props.current ? "true" : undefined}>
        <span class="inbox-row__from">
          {row.fromName === null ? null : <Theirs text={row.fromName} class="inbox-row__name" />}
          <Theirs text={row.from} class="inbox-row__address" />
        </span>
        <Theirs text={row.subject === "" ? "(no subject)" : row.subject} class="inbox-row__subject" />
        <span class="inbox-row__meta">
          <span>
            {"Uploaded by "}
            <Theirs text={row.uploadedBy} />
            {" · "}
            <Time at={row.uploadedAt} />
          </span>
          <span class={matched ? "tag tag--act" : "tag"}>{row.label}</span>
          {row.partial ? <span class="tag tag--partial">Partly unreadable</span> : null}
        </span>
      </a>
    </li>
  );
}

function List(props: {
  view: InboxListView | null;
  polled: Polled<InboxListView>;
  tab: UploadState;
  shown: number | null;
  preferred: string | null;
}): JSX.Element {
  const view: InboxListView | null = props.view;
  const waiting: number = view?.tabs.find((tab: InboxListView["tabs"][number]): boolean => tab.state === "waiting")?.count ?? 0;
  const empty: { title: string; line: string | null } = EMPTY[props.tab];
  return (
    <section class="card card--flush inbox__list" aria-label="Uploaded emails">
      <Tabs
        label="Inbox"
        tabs={TABS.map((tab: UploadState) => ({
          key: tab,
          label: view?.tabs.find((item: InboxListView["tabs"][number]): boolean => item.state === tab)?.label ?? TAB_LABELS[tab],
          count: tab === "waiting" ? waiting : null,
          href: query("#inbox", { tab: tab === "waiting" ? null : tab, for: props.preferred }),
        }))}
        current={props.tab}
      />
      <LoadError what="the inbox" error={props.polled.error} />
      {view === null ? (
        props.polled.error === null ? (
          <Loading rows={3} label="Loading the inbox" />
        ) : null
      ) : view.rows.length === 0 ? (
        <Empty title={empty.title}>{empty.line === null ? null : <p class="muted">{empty.line}</p>}</Empty>
      ) : (
        <ul class="inbox-rows">
          {view.rows.map(
            (row: UploadRow): JSX.Element => (
              <Row key={row.id} row={row} tab={props.tab} current={row.id === props.shown} preferred={props.preferred} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

export function Inbox(props: ScreenProps): JSX.Element {
  useTitle("Inbox");
  const tab: UploadState = tabOf(props.route.params.get("tab"));
  const named: number | null = idOf(props.route.segments[0]);
  const preferred: string | null = props.route.params.get("for");
  const wide: boolean = useMedia(SIDE_BY_SIDE);
  const listPath: string = query("/api/inbox", { tab });
  const polled: Polled<InboxListView> = usePoll<InboxListView>(listPath, (): number => SLOW_MS, { remember: true });
  const list: InboxListView | null = polled.data;
  const [uploading, setUploading] = useState<boolean>(preferred !== null && named === null);
  // The email a wide screen opens when the route names none: the tab's first,
  // kept open even when an action moves it to another tab.
  const [opened, setOpened] = useState<{ tab: UploadState; id: number } | null>(null);
  const first: number | null = list?.rows[0]?.id ?? null;
  useEffect((): void => {
    if (named === null && first !== null && opened?.tab !== tab) {
      setOpened({ tab, id: first });
    }
  }, [named, first, tab]);
  const auto: number | null = opened?.tab === tab ? opened.id : first;
  const shown: number | null = named ?? (wide ? auto : null);
  const single: "list" | "item" = named === null ? "list" : "item";

  return (
    <div class="screen inbox">
      <header class="screen__head inbox__head">
        <div class="screen__bar">
          <h1 class="screen__title">Inbox</h1>
          <button type="button" class="btn btn--primary screen__end" onClick={(): void => setUploading(true)}>
            <Icon name="plus" />
            Upload email
          </button>
        </div>
        <p class="screen__lede">Supplier emails you uploaded that are not on a payment yet.</p>
      </header>
      <div class={wide ? "inbox__layout" : `inbox__layout inbox__layout--single inbox__layout--${single}`}>
        {wide || single === "list" ? <List view={list} polled={polled} tab={tab} shown={shown} preferred={preferred} /> : null}
        {!wide && single === "item" ? (
          <a class="inbox__back" href={query("#inbox", { tab: tab === "waiting" ? null : tab, for: preferred })}>
            <Icon name="chevron-right" class="inbox__back-icon" />
            All emails
          </a>
        ) : null}
        {shown !== null ? (
          <InboxItem key={shown} id={shown} preferred={preferred} onActed={(): void => polled.refresh()} />
        ) : wide && list !== null && list.rows.length > 0 ? (
          <Empty title="Choose an email from the list." />
        ) : null}
      </div>
      {uploading ? (
        <UploadDialog
          forInvoice={preferred}
          limits={list?.limits ?? null}
          onClose={(): void => setUploading(false)}
          onUploaded={(id: number): void => {
            setUploading(false);
            navigate(itemHref(id, "waiting", preferred));
          }}
        />
      ) : null}
    </div>
  );
}

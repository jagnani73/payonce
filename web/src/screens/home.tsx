import type { JSX } from "preact";
import { useId, useState } from "preact/hooks";
import { query } from "../api";
import { LinkButton } from "../components/Action";
import { Icon, type IconName } from "../components/Icon";
import { Card } from "../components/Layout";
import { HandlingRows, QueueRows } from "../components/Rows";
import { Delayed, LoadError, Loading } from "../components/States";
import { Time } from "../components/Text";
import { useTitle } from "../hooks";
import { useMe } from "../me";
import { FAST_MS, SLOW_MS, usePoll, type Polled } from "../poll";
import type { ScreenProps } from "../router";
import { count } from "../text";
import type { HomeView, IncidentRow, QueueItem, ReadinessItem, Tile } from "../types";
import "./home.css";

// Home, "Needs you" (ia.md section 1): what needs a person now, from GET
// /api/home?me=NAME. Polled every 5 s, and every 1.5 s while PayOnce is working
// on a listed payment. Not while one is merely with the bank: Home reads every
// payment, and a transfer can stay with the bank for days.

function rowsOf(view: HomeView): IncidentRow[] {
  const payments = (items: QueueItem[]): IncidentRow[] =>
    items.flatMap((item: QueueItem): IncidentRow[] => (item.type === "payment" ? [item.row] : []));
  return [...payments(view.needsYou), ...payments(view.waitingForMe ?? []), ...view.handling.rows];
}

function pace(view: HomeView | null): number {
  return view !== null && rowsOf(view).some((row: IncidentRow): boolean => row.activity.busy) ? FAST_MS : SLOW_MS;
}

// A tile's second line is a warning when it counts urgent or late payments.
function warns(tile: Tile): boolean {
  return tile.sub !== null && (tile.key === "needs-you" || tile.key === "with-bank");
}

function Tiles(props: { tiles: Tile[] }): JSX.Element {
  return (
    <div class="tiles">
      {props.tiles.map(
        (tile: Tile): JSX.Element => (
          <a class="tile" href={tile.href} key={tile.key}>
            <span class="tile__label">{tile.label}</span>
            <span class="tile__value">{tile.value}</span>
            <span class={warns(tile) ? "tile__sub tile__sub--warn" : "tile__sub"}>{tile.sub ?? ""}</span>
          </a>
        ),
      )}
    </div>
  );
}

const PLACEHOLDER_TILES: readonly string[] = ["Needs you", "With the bank", "PayOnce is handling", "Paid in the last 7 days"];

function HomeLoading(): JSX.Element {
  return (
    <Delayed>
      <div class="tiles" aria-hidden="true">
        {PLACEHOLDER_TILES.map(
          (label: string): JSX.Element => (
            <div class="tile" key={label}>
              <span class="tile__label">{label}</span>
              <span class="tile__value">—</span>
              <span class="tile__sub" />
            </div>
          ),
        )}
      </div>
      <Card flush>
        <Loading rows={3} label="Loading Home" />
      </Card>
    </Delayed>
  );
}

function InboxStrip(props: { inbox: HomeView["inbox"] }): JSX.Element {
  const { waiting, suggested } = props.inbox;
  return (
    <a class="strip" href="#inbox">
      <Icon name="mail" size={18} class="strip__icon" />
      <span class="strip__lead">{`${count(waiting, "email")} waiting`}</span>
      {suggested === 0 ? null : (
        <span class="muted">{suggested === 1 ? "1 suggests a payment" : `${suggested} suggest a payment`}</span>
      )}
      <span class="strip__go">Open inbox</span>
    </a>
  );
}

// Collapsed by default; opening it is kept while the view refreshes.
function Handling(props: { handling: HomeView["handling"] }): JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const id: string = useId();
  const { count: total, blocked, rows } = props.handling;
  return (
    <section class="card card--flush">
      <h2 class="disclosure-heading">
        <button type="button" class="disclosure" aria-expanded={open} aria-controls={id} onClick={(): void => setOpen(!open)}>
          <Icon name="chevron-right" class={open ? "disclosure__chevron is-open" : "disclosure__chevron"} />
          <span>{`PayOnce is handling ${count(total, "payment")}${blocked === 0 ? "" : `, ${blocked} blocked`}`}</span>
        </button>
      </h2>
      {open ? <HandlingRows rows={rows} id={id} /> : null}
    </section>
  );
}

function Quiet(props: { view: HomeView }): JSX.Element {
  const handling: number = props.view.handling.count;
  return (
    <Card>
      <div class="quiet">
        <h2 class="quiet__title">Nothing needs you right now.</h2>
        {handling === 0 ? null : <a href="#incidents?scope=payonce">{`PayOnce is handling ${count(handling, "payment")}`}</a>}
        {props.view.lastClosedAt === null ? null : (
          <p class="muted">
            {"Last incident closed "}
            <Time at={props.view.lastClosedAt} />
          </p>
        )}
      </div>
    </Card>
  );
}

const READINESS: Record<ReadinessItem["state"], { icon: IconName; word: string }> = {
  ok: { icon: "check", word: "Done" },
  missing: { icon: "cross", word: "Missing" },
  warning: { icon: "warning", word: "Check" },
  optional: { icon: "circle", word: "Optional" },
};

// An empty ledger: the first things to do, and the settings that make PayOnce work.
function FirstRun(props: { readiness: ReadinessItem[] }): JSX.Element {
  return (
    <Card>
      <div class="first-run">
        <h2 class="quiet__title">No payments yet.</h2>
        <div class="button-row">
          <LinkButton href="#new-payment" kind="primary">
            New payment
          </LinkButton>
          <LinkButton href="#runs/upload">Upload pay run</LinkButton>
          <LinkButton href="#sandbox">Try a scripted incident</LinkButton>
        </div>
        <div class="readiness">
          <h3 class="readiness__title">Before the first payment</h3>
          <ul class="readiness__list">
            {props.readiness.map(
              (item: ReadinessItem): JSX.Element => (
                <li key={item.key}>
                  <a class={`readiness__item readiness__item--${item.state}`} href={item.href}>
                    <Icon name={READINESS[item.state].icon} size={18} class="readiness__icon" />
                    <span class="visually-hidden">{`${READINESS[item.state].word}: `}</span>
                    <span class="readiness__label">{item.label}</span>
                    <span class="readiness__text">{item.text}</span>
                  </a>
                </li>
              ),
            )}
          </ul>
        </div>
      </div>
    </Card>
  );
}

function Queues(props: { view: HomeView; me: string | null }): JSX.Element {
  const view: HomeView = props.view;
  const mine: QueueItem[] = view.waitingForMe ?? [];
  return (
    <>
      <Tiles tiles={view.tiles} />
      {mine.length === 0 || props.me === null ? null : (
        <Card title="Waiting for your approval" sub={`Requests ${props.me} can sign now`} flush>
          <QueueRows items={mine} kind="primary" />
        </Card>
      )}
      {view.needsYou.length === 0 ? (
        <Quiet view={view} />
      ) : (
        <Card
          title="Needs you"
          sub={
            <>
              <span class="count-pill">{view.needsYou.length}</span>
              <span class="home__order">Urgent first, then the most money, then the oldest.</span>
            </>
          }
          actions={<a href="#incidents?scope=needs-you">Open in Incidents</a>}
          flush
        >
          <QueueRows items={view.needsYou} />
        </Card>
      )}
      {view.inbox.waiting === 0 ? null : <InboxStrip inbox={view.inbox} />}
      {view.handling.count === 0 || view.needsYou.length === 0 ? null : <Handling handling={view.handling} />}
    </>
  );
}

export function Home(_props: ScreenProps): JSX.Element {
  useTitle("Needs you");
  const me: string | null = useMe();
  // keep: picking another You are keeps Home on screen until its view lands.
  const home: Polled<HomeView> = usePoll<HomeView>(query("/api/home", { me }), pace, true);
  const view: HomeView | null = home.data;
  return (
    <div class="screen home">
      <header class="screen__head">
        <h1 class="screen__title">Needs you</h1>
        <p class="screen__lede">
          PayOnce pays each supplier invoice once on Airwallex, fixes what it safely can, and brings the rest here.
        </p>
      </header>
      <LoadError what="Home" error={home.error} />
      {view === null ? (
        home.error === null ? <HomeLoading /> : null
      ) : view.firstRun !== null ? (
        <FirstRun readiness={view.firstRun.readiness} />
      ) : (
        <Queues view={view} me={me} />
      )}
    </div>
  );
}

import type { ComponentChildren, JSX } from "preact";
import { Details } from "../components/Action";
import { Table, type Column } from "../components/Layout";
import { Callout } from "../components/Notice";
import { LoadError, Loading } from "../components/States";
import { Theirs, Time } from "../components/Text";
import { useTitle } from "../hooks";
import { usePoll, type Polled } from "../poll";
import type { ScreenProps } from "../router";
import { timeZone } from "../time";
import type { SettingRow, SettingsView } from "../types";
import { useScrollTo } from "./treasury/scroll";
import "./settings.css";

// Settings (ia.md section 10): what PayOnce read from its .env file, read-only.
// No secret is in the view; a variable's name shows only as a small label beside
// the value it sets. #settings/alerts and the like open at that section. It is
// read again every 10 s, since the recent alerts and the connection move.

const SETTINGS_MS: number = 10_000;

type Alert = SettingsView["alerts"]["recent"][number];

const SECTIONS: readonly { key: string; label: string }[] = [
  { key: "approvals", label: "Approvals" },
  { key: "cash", label: "Cash" },
  { key: "deadlines", label: "Bank deadlines" },
  { key: "outages", label: "Outages" },
  { key: "alerts", label: "Alerts" },
  { key: "reader", label: "Email reader and Ask why" },
  { key: "airwallex", label: "Airwallex" },
  { key: "people", label: "People and time" },
];

function anchor(key: string): string {
  return `settings-${key}`;
}

// The variables beside a value, or "Fixed" for one no setting changes.
function Vars(props: { names: readonly string[] | null }): JSX.Element {
  return props.names === null || props.names.length === 0 ? (
    <span class="set-fixed">Fixed</span>
  ) : (
    <span class="set-vars">
      {props.names.map(
        (name: string): JSX.Element => (
          <code class="set-var" key={name}>
            {name}
          </code>
        ),
      )}
    </span>
  );
}

function Line(props: { label?: string; children: ComponentChildren; vars: readonly string[] | null; problem?: string | null; tone?: "warn" | "off" }): JSX.Element {
  return (
    <div class="set-row">
      {props.label === undefined ? null : <span class="set-row__label">{props.label}</span>}
      <span class={props.tone === undefined ? "set-row__value" : `set-row__value set-row__value--${props.tone}`}>{props.children}</span>
      <Vars names={props.vars} />
      {props.problem === null || props.problem === undefined ? null : (
        <p class="set-row__problem" role="alert">
          {props.problem}
        </p>
      )}
    </div>
  );
}

function Row(props: { row: SettingRow }): JSX.Element {
  const row: SettingRow = props.row;
  return (
    <Line label={row.label} vars={row.variables} problem={row.problem}>
      {row.value}
    </Line>
  );
}

function Section(props: { id: string; title: string; children: ComponentChildren }): JSX.Element {
  return (
    <section class="card set-section" id={anchor(props.id)} aria-labelledby={`${anchor(props.id)}-title`} tabIndex={-1}>
      <h2 class="set-section__title" id={`${anchor(props.id)}-title`}>
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function Approvals(props: { view: SettingsView["approvals"] }): JSX.Element {
  const a: SettingsView["approvals"] = props.view;
  const approvers: Column<SettingsView["approvals"]["approvers"][number]>[] = [
    { key: "name", label: "Approver", cell: (approver) => <Theirs text={approver.name} /> },
    { key: "limit", label: "Limit", cell: (approver) => approver.limit.text, numeric: true },
  ];
  return (
    <Section id="approvals" title="Approvals">
      {a.problem === null ? null : <Callout tone="danger">{a.problem}</Callout>}
      <div class="set-approvers">
        {a.approvers.length === 0 ? (
          <p class="muted">No approvers are set, so PayOnce refuses every approval.</p>
        ) : (
          <div class="set-approvers__table">
            <Table caption="Approvers and their limits" columns={approvers} rows={a.approvers} rowKey={(approver) => approver.name} />
          </div>
        )}
        <Vars names={["APPROVERS"]} />
      </div>
      <p class="muted set-note">A limit applies in the currency a payment is paid from.</p>
      {a.rows
        .filter((row: SettingRow): boolean => !row.variables.includes("APPROVERS"))
        .map(
          (row: SettingRow): JSX.Element => (
            <Row key={row.label} row={row} />
          ),
        )}
      <Line label="Who can't approve" vars={null}>
        {a.barredRule}
      </Line>
      <Line label="Closing without paying" vars={null}>
        {a.closeRule}
      </Line>
    </Section>
  );
}

function Cash(props: { view: SettingsView["cash"] }): JSX.Element {
  const c: SettingsView["cash"] = props.view;
  const [floors, ...rest] = c.rows;
  return (
    <Section id="cash" title="Cash">
      {floors === undefined ? null : (
        <Line label={floors.label} vars={floors.variables} problem={floors.problem}>
          {c.floors.length === 0 ? (
            floors.value
          ) : (
            <span class="set-floors">
              {c.floors.map(
                (floor: SettingsView["cash"]["floors"][number]): JSX.Element => (
                  <span key={floor.currency} class="set-floor">
                    <strong>{floor.currency}</strong> {floor.floor === null ? <span class="set-unset">Not set</span> : floor.text}
                  </span>
                ),
              )}
            </span>
          )}
        </Line>
      )}
      <p class="muted set-note">A wallet with no floor sends every automatic replacement to a person.</p>
      {rest.map(
        (row: SettingRow): JSX.Element => (
          <Row key={row.label} row={row} />
        ),
      )}
    </Section>
  );
}

function RowsSection(props: { id: string; title: string; rows: SettingRow[] }): JSX.Element {
  return (
    <Section id={props.id} title={props.title}>
      {props.rows.map(
        (row: SettingRow): JSX.Element => (
          <Row key={row.label} row={row} />
        ),
      )}
    </Section>
  );
}

const FORMAT_WORDS: Record<NonNullable<SettingsView["alerts"]["format"]>, string> = { slack: "Slack", discord: "Discord" };

function Alerts(props: { view: SettingsView["alerts"] }): JSX.Element {
  const a: SettingsView["alerts"] = props.view;
  const columns: Column<Alert>[] = [
    { key: "time", label: "Time", cell: (alert: Alert) => <Time at={alert.createdAt} /> },
    { key: "kind", label: "Kind", cell: (alert: Alert) => alert.kind },
    { key: "title", label: "Title", cell: (alert: Alert) => <Theirs text={alert.title} /> },
    { key: "state", label: "State", cell: (alert: Alert) => `${alert.state.charAt(0).toUpperCase()}${alert.state.slice(1)}` },
    { key: "tries", label: "Tries", cell: (alert: Alert) => alert.tries, numeric: true },
    { key: "error", label: "Last error", cell: (alert: Alert) => (alert.lastError === null ? "None" : <Theirs text={alert.lastError} />) },
  ];
  return (
    <Section id="alerts" title="Alerts">
      {a.stopped === null ? null : <Callout tone="warning">{`Alerts stopped: ${a.stopped}. Nobody is told about new incidents.`}</Callout>}
      <Line label="Address" vars={a.variables.target} problem={a.problem} tone={a.on ? undefined : "off"}>
        {a.on ? ["On", a.format === null ? null : FORMAT_WORDS[a.format], a.host].filter((part: string | null): boolean => part !== null).join(" · ") : "Off: no alert address set"}
      </Line>
      <Line label="Test receiver" vars={a.variables.test}>
        {a.test ? "On: alerts go to the test receiver" : "Off"}
      </Line>
      <h3 class="set-subtitle">Last alerts</h3>
      <Table caption="The last alerts PayOnce posted" columns={columns} rows={a.recent} rowKey={(alert: Alert): string => String(alert.id)} empty="No alerts yet." minWidth={760} />
    </Section>
  );
}

function Reader(props: { view: SettingsView["reader"] }): JSX.Element {
  const r: SettingsView["reader"] = props.view;
  const ask: SettingsView["reader"]["askWhy"] = r.askWhy;
  return (
    <Section id="reader" title="Email reader and Ask why">
      <Line label="Email reader" vars={r.variables}>
        {r.isModel ? `Model reader: ${r.name}` : "Keyword reader: no model key is set, so PayOnce reads emails by keywords"}
      </Line>
      {r.notice === null ? null : <Callout tone="warning">{r.notice}</Callout>}
      <Line label="Ask why" vars={ask.variables} tone={ask.on ? undefined : "off"}>
        {ask.on ? `On · ${ask.models}` : "Off: Ask why needs a model key"}
      </Line>
      {ask.on
        ? ask.limits.map(
            (limit: SettingRow): JSX.Element => <Row key={limit.label} row={limit} />,
          )
        : null}
    </Section>
  );
}

function Airwallex(props: { view: SettingsView["airwallex"] }): JSX.Element {
  const a: SettingsView["airwallex"] = props.view;
  if (a === null) {
    return (
      <Section id="airwallex" title="Airwallex">
        <p class="muted">Only pnpm ui holds the Airwallex connection, so it isn't shown here.</p>
      </Section>
    );
  }
  const c: NonNullable<SettingsView["airwallex"]>["connection"] = a.connection;
  return (
    <Section id="airwallex" title="Airwallex">
      <Line label="Host" vars={a.variables.host} tone={a.offline ? "warn" : undefined}>
        {a.offline ? (
          <>
            {"Offline host "}
            <span class="mono">{a.host}</span>
            {": no call reaches Airwallex"}
          </>
        ) : (
          <>
            {"Sandbox host "}
            <span class="mono">{a.host}</span>
          </>
        )}
      </Line>
      <div class="set-row">
        <span class="set-row__label">Connection</span>
        <span class={c.state === "ok" ? "set-row__value" : "set-row__value set-row__value--warn"}>
          {a.offline ? "None: PayOnce is using the offline host" : c.text}
          {c.lastOkAt === null && c.failingSince === null ? null : (
            <span class="set-row__when">
              {c.lastOkAt === null ? "No good call yet" : "Last good call "}
              <Time at={c.lastOkAt} />
              {c.state !== "ok" && c.failingSince !== null ? (
                <>
                  {" · failing since "}
                  <Time at={c.failingSince} />
                </>
              ) : null}
            </span>
          )}
        </span>
        <span class="set-fixed">Live</span>
        {c.detail === null ? null : (
          <div class="set-row__details">
            <Details rows={[{ label: "Last error", value: c.detail, copy: true }]} />
          </div>
        )}
      </div>
      <Line label="Webhooks" vars={a.variables.webhooks}>
        {a.webhooks.on
          ? `On${a.webhooks.host === null ? "" : ` · ${a.webhooks.host}`}. PayOnce also checks payments with the bank every ${a.checksEverySeconds} s`
          : `Off, so PayOnce checks payments with the bank every ${a.checksEverySeconds} s`}
      </Line>
      <Line label="Transfer listing" vars={null}>
        {`PayOnce lists Airwallex transfers every ${a.listingEverySeconds} s`}
      </Line>
      <Line label="Reconciliation" vars={a.variables.recon}>
        {a.reconEveryMinutes === null ? "Only when someone presses Check now in Treasury › Reconciliation" : `Every ${a.reconEveryMinutes} minutes`}
      </Line>
    </Section>
  );
}

function People(props: { view: SettingsView["people"] }): JSX.Element {
  return (
    <Section id="people" title="People and time">
      <p class="set-lead">There is no login, by design.</p>
      <p>{props.view.noLogin}</p>
      <p class="muted">{`Times are in your time zone (${timeZone()}). Alerts and the CLI use UTC.`}</p>
    </Section>
  );
}

function SettingsBody(props: { view: SettingsView }): JSX.Element {
  const v: SettingsView = props.view;
  return (
    <div class="set-layout">
      <nav class="set-nav" aria-label="Settings sections">
        {SECTIONS.map(
          (section: { key: string; label: string }): JSX.Element => (
            <a key={section.key} class="set-nav__link" href={`#settings/${section.key}`}>
              {section.label}
            </a>
          ),
        )}
      </nav>
      <div class="set-sections">
        <Approvals view={v.approvals} />
        <Cash view={v.cash} />
        <RowsSection id="deadlines" title="Bank deadlines" rows={v.bankDeadlines} />
        <RowsSection id="outages" title="Outages" rows={v.outages} />
        <Alerts view={v.alerts} />
        <Reader view={v.reader} />
        <Airwallex view={v.airwallex} />
        <People view={v.people} />
      </div>
    </div>
  );
}

export function Settings(props: ScreenProps): JSX.Element {
  useTitle("Settings");
  const settings: Polled<SettingsView> = usePoll<SettingsView>("/api/settings", (): number => SETTINGS_MS);
  const target: string | null = SECTIONS.find((section: { key: string }): boolean => section.key === props.route.segments[0])?.key ?? null;
  // #settings/alerts opens at Alerts once the sections are on screen.
  useScrollTo(target === null ? null : anchor(target), settings.data !== null);

  return (
    <div class="screen settings">
      <header class="screen__head">
        <h1 class="screen__title">Settings</h1>
        <p class="screen__lede">Settings come from PayOnce's .env file. Change one there and restart PayOnce. Secrets are never shown.</p>
      </header>
      <LoadError what="Settings" error={settings.error} />
      {settings.data === null ? (
        settings.error === null ? <Loading rows={4} label="Loading Settings" /> : null
      ) : (
        <SettingsBody view={settings.data} />
      )}
    </div>
  );
}

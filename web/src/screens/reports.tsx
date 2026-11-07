import type { JSX } from "preact";
import { getJson, query } from "../api";
import { ActionButton } from "../components/Action";
import { Icon } from "../components/Icon";
import { Delayed, Empty, LoadError, Loading } from "../components/States";
import { Time } from "../components/Text";
import { useTitle } from "../hooks";
import { notify } from "../notices";
import { usePoll, type Polled } from "../poll";
import { navigate, type ScreenProps } from "../router";
import { count } from "../text";
import type { AuditCheckView, ReportsView } from "../types";
import { quiet, ReportTables } from "./reports/tables";
import { useScrollTo } from "./treasury/scroll";
import "./reports.css";

// Reports (ia.md section 9): the headline tiles and the eight tables for a
// period, from GET /api/reports?period=, and the ledger-wide audit trail from
// GET /api/audit. #reports/audit opens at the audit card.

type Period = ReportsView["period"];

const PERIODS: readonly { key: Period; label: string; words: string }[] = [
  { key: "7d", label: "Last 7 days", words: "the last 7 days" },
  { key: "30d", label: "Last 30 days", words: "the last 30 days" },
  { key: "all", label: "Since the ledger started", words: "everything since the ledger started" },
];

const REPORTS_MS: number = 30_000;
const AUDIT_MS: number = 60_000;
const AUDIT_ID: string = "audit";

function periodOf(params: URLSearchParams): Period {
  const asked: string | null = params.get("period");
  return PERIODS.find((period: { key: Period }): boolean => period.key === asked)?.key ?? "7d";
}

function wordsOf(period: Period): string {
  return PERIODS.find((item: { key: Period }): boolean => item.key === period)?.words ?? period;
}

function PeriodButtons(props: { period: Period }): JSX.Element {
  return (
    <div class="periods" role="group" aria-label="Period">
      {PERIODS.map(
        (item: { key: Period; label: string }): JSX.Element => (
          <button
            type="button"
            key={item.key}
            class="periods__button"
            aria-pressed={item.key === props.period}
            onClick={(): void => navigate(item.key === "7d" ? "#reports" : `#reports?period=${item.key}`)}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

function Tiles(props: { tiles: ReportsView["tiles"] }): JSX.Element {
  return (
    <div class="report-tiles">
      {props.tiles.map(
        (tile: ReportsView["tiles"][number]): JSX.Element => (
          <div class="report-tile" key={tile.key}>
            <span class="report-tile__label">{tile.label}</span>
            <span class="report-tile__value">{tile.value}</span>
            <span class="report-tile__sub">{tile.sub ?? ""}</span>
          </div>
        ),
      )}
    </div>
  );
}

const HASH_WORDS: Record<AuditCheckView["invoices"]["runningHash"], string> = {
  matches: "matches",
  "does not match": "doesn't match",
  missing: "is missing",
  "started again": "started again",
};

// "Intact · 412 lines on 11 payments · 18 lines on 1 pay run · 40 reconciliation
// lines · running hashes match · checked 14:20".
function AuditLine(props: { audit: AuditCheckView }): JSX.Element {
  const a: AuditCheckView = props.audit;
  const hashes: string =
    a.invoices.runningHash === "matches" && a.runs.runningHash === "matches"
      ? "running hashes match"
      : [
          a.invoices.runningHash === "matches" ? null : `the payments' running hash ${HASH_WORDS[a.invoices.runningHash]}`,
          a.runs.runningHash === "matches" ? null : `the pay runs' running hash ${HASH_WORDS[a.runs.runningHash]}`,
        ]
          .filter((part: string | null): boolean => part !== null)
          .join(", ");
  return (
    <p class={a.intact ? "audit-card__line" : "audit-card__line audit-card__line--broken"}>
      {`${a.intact ? "Intact" : "Broken"} · ${count(a.invoices.lines, "line")} on ${count(a.invoices.chains, "payment")} · ${count(a.runs.lines, "line")} on ${count(a.runs.chains, "pay run")} · ${count(a.recon.lines, "reconciliation line")} · ${hashes} · checked `}
      <Time at={a.checkedAt} />
    </p>
  );
}

function AuditCard(props: { polled: Polled<AuditCheckView> }): JSX.Element {
  const audit: AuditCheckView | null = props.polled.data;
  return (
    <section id={AUDIT_ID} class={audit !== null && !audit.intact ? "card audit-card audit-card--broken" : "card audit-card"} aria-labelledby="audit-title" tabIndex={-1}>
      <Icon name={audit !== null && !audit.intact ? "warning" : "lock"} size={20} class="audit-card__icon" />
      <div class="audit-card__body">
        <h2 class="card__title" id="audit-title">
          Audit trail
        </h2>
        <LoadError what="the audit trail" error={props.polled.error} />
        {audit === null ? (
          props.polled.error === null ? (
            <Delayed>
              <p class="muted">Checking every line…</p>
            </Delayed>
          ) : null
        ) : (
          <>
            <AuditLine audit={audit} />
            {audit.problems.length === 0 ? null : (
              <ul class="audit-card__problems">
                {audit.problems.map(
                  (problem: string, index: number): JSX.Element => (
                    <li key={index}>{problem}</li>
                  ),
                )}
              </ul>
            )}
          </>
        )}
      </div>
      <div class="audit-card__actions">
        <ActionButton
          label="Check now"
          busyLabel="Checking…"
          onAction={async (): Promise<void> => {
            const fresh: AuditCheckView = await getJson<AuditCheckView>("/api/audit");
            props.polled.replace(fresh);
            notify(
              fresh.intact
                ? { tone: "success", text: "Audit trail checked: every chain and running hash matches." }
                : { tone: "warning", text: `Audit trail checked: ${count(fresh.problems.length, "problem")} found.` },
            );
          }}
        />
        <a class="btn btn--secondary" href={audit?.exportPath ?? "/api/audit/export"} download="payonce-audit.json">
          Export everything (JSON)
        </a>
      </div>
    </section>
  );
}

function AsOf(props: { view: ReportsView; asked: Period }): JSX.Element {
  const m: ReportsView["metrics"] = props.view.metrics;
  return (
    <p class="muted reports__asof">
      {`Showing ${wordsOf(props.view.period)}`}
      {m.from === null ? null : (
        <>
          {", from "}
          <Time at={m.from} />
        </>
      )}
      {". As of "}
      <Time at={m.builtAt} />
      {props.view.period === props.asked ? "." : `. Loading ${wordsOf(props.asked)}…`}
    </p>
  );
}

export function Reports(props: ScreenProps): JSX.Element {
  useTitle("Reports");
  const period: Period = periodOf(props.route.params);
  // keep: another period keeps this one on screen until its answer lands.
  const reports: Polled<ReportsView> = usePoll<ReportsView>(query("/api/reports", { period }), (): number => REPORTS_MS, { keep: true });
  const audit: Polled<AuditCheckView> = usePoll<AuditCheckView>("/api/audit", (): number => AUDIT_MS);
  const view: ReportsView | null = reports.data;
  // #reports/audit opens at the audit card once it has its answer.
  useScrollTo(props.route.segments[0] === AUDIT_ID ? AUDIT_ID : null, audit.data !== null);

  return (
    <div class="screen reports">
      <header class="reports__head">
        <h1 class="screen__title">Reports</h1>
        <PeriodButtons period={period} />
      </header>
      <LoadError what="the reports" error={reports.error} />
      {view === null ? (
        reports.error === null ? <Loading rows={2} label="Loading reports" /> : null
      ) : (
        <>
          <AsOf view={view} asked={period} />
          <Tiles tiles={view.tiles} />
        </>
      )}
      <AuditCard polled={audit} />
      {view === null ? null : quiet(view.metrics) ? (
        <Empty title="Nothing in this period yet.">
          {view.period === "all" ? null : (
            <p class="muted">
              {"Try "}
              <a href="#reports?period=all">since the ledger started</a>
              {"."}
            </p>
          )}
        </Empty>
      ) : (
        <ReportTables metrics={view.metrics} />
      )}
    </div>
  );
}

import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Details } from "../../components/Action";
import { Icon } from "../../components/Icon";
import { Tabs } from "../../components/Layout";
import { Empty, LoadError, Loading } from "../../components/States";
import { Day, Money, Ref, Said, Theirs, Time } from "../../components/Text";
import { AuditLine, Timeline } from "../../components/Timeline";
import { SituationHeader, Tag, ToneBadge } from "../../components/Tone";
import { FAST_MS, SLOW_MS, usePoll, type Polled } from "../../poll";
import { paymentHref, runHref } from "../../router";
import type { Caution, RunCashView, RunRowView, RunTermsView, RunView, Tone } from "../../types";
import { RunDecision } from "./Decision";

// One pay run (ia.md section 6, "Run page"): the header, the Decision panel while
// it waits, and the Rows, Cash check, Timeline and Audit tabs, the tab in the
// route (#run/N/rows). Polled every 1.5 s while PayOnce works on it or one of its
// payments is with the bank, else every 5 s.

type RunTab = "rows" | "cash" | "timeline" | "audit";

const RUN_TABS: readonly RunTab[] = ["rows", "cash", "timeline", "audit"];

const ROW_TONES: Record<Exclude<RunRowView["state"], "released">, Tone> = {
  "will-pay": "progress",
  "second-bill-check": "progress",
  skipped: "done",
  "not-released": "done",
};

const METHODS: Record<string, string> = { LOCAL: "Local", SWIFT: "SWIFT" };

function tabOf(raw: string | undefined): RunTab {
  return RUN_TABS.find((tab: RunTab): boolean => tab === raw) ?? "rows";
}

function pace(view: RunView | null): number {
  return view !== null && (view.activity.busy || view.activity.watching) ? FAST_MS : SLOW_MS;
}

function Header(props: { view: RunView }): JSX.Element {
  const view: RunView = props.view;
  const run: RunView["run"] = view.run;
  const outage: Caution | undefined = view.decision?.cautions.find((caution: Caution): boolean => caution.code === "outage");
  return (
    <header class="card run-head">
      <span class="eyebrow">Pay run</span>
      <div class="run-head__title">
        <h2 class="run-head__name">{`Pay run ${run.id}`}</h2>
        <Theirs text={run.fileName} class="run-head__file" />
        {view.activity.busy ? (
          <span class="working">
            <span class="working__dot" aria-hidden="true" />
            Working
          </span>
        ) : null}
      </div>
      <SituationHeader situation={view.situation} />
      {outage === undefined || view.situation.state === "paused-by-outage" ? null : (
        <p class="situation__blocker">
          <Icon name="pause" />
          <span>
            <Said text={outage.text} />
          </span>
        </p>
      )}
      <p class="run-head__meta">
        {"Uploaded by "}
        <Theirs text={run.uploadedBy} />
        {" at "}
        <Time at={run.uploadedAt} />
        {" · checked "}
        <Time at={run.checkedAt} />
        {run.releasedAt === null ? null : (
          <>
            {" · released "}
            <Time at={run.releasedAt} />
          </>
        )}
      </p>
      <Details summary="File details" rows={[{ label: "File SHA-256", value: run.fileHash, copy: true }]} />
    </header>
  );
}

function summaryOf(view: RunView): string {
  const parts: string[] = [`${view.counts.pay} pay`];
  if (view.counts.held > 0) {
    parts.push(view.counts.held === 1 ? "1 possible second bill" : `${view.counts.held} possible second bills`);
  }
  if (view.counts.skip > 0) {
    const why: string = view.skippedSummary
      .map((entry: RunView["skippedSummary"][number]): string => `${entry.count > 1 ? `${entry.count} ` : ""}${entry.label.toLowerCase()}`)
      .join(", ");
    parts.push(`${view.counts.skip} skipped${why === "" ? "" : `: ${why}`}`);
  }
  return parts.join(" · ");
}

function DueCell(props: { row: RunRowView }): JSX.Element {
  const row: RunRowView = props.row;
  return (
    <span class="run-rows__due">
      {row.dueDate === null ? (
        <span class="muted">No due date</span>
      ) : (
        <span>
          {"Due "}
          <Day day={row.dueDate} />
        </span>
      )}
      {row.arrival?.latestDay === null || row.arrival === null ? null : (
        <span class={row.arrival.atRisk ? "run-rows__arrival is-warn" : "run-rows__arrival"}>
          {"arrives by "}
          <Day day={row.arrival.latestDay} />
        </span>
      )}
    </span>
  );
}

function StatusCell(props: { row: RunRowView; domain: boolean; open: boolean; onToggle: () => void; reasonsId: string }): JSX.Element {
  const row: RunRowView = props.row;
  const payment: RunRowView["payment"] = row.payment;
  return (
    <span class="run-rows__status">
      {row.state === "released" && payment !== null ? (
        <ToneBadge tone={payment.situation.tone} label={payment.situation.label} />
      ) : (
        <ToneBadge tone={row.state === "released" ? "done" : ROW_TONES[row.state]} label={row.state === "second-bill-check" ? "Pays" : row.label} />
      )}
      {row.state === "second-bill-check" ? (
        <span class="tag tag--warn">{`Possible second bill of ${row.secondBillOf.join(", ")}`}</span>
      ) : null}
      {row.newPayee ? <Tag>New payee</Tag> : null}
      {row.callbackVerified ? <Tag>Verified by callback</Tag> : null}
      {props.domain ? <span class="tag tag--warn">Domain caution</span> : null}
      {payment?.activity.busy === true ? (
        <span class="working">
          <span class="working__dot" aria-hidden="true" />
          Working
        </span>
      ) : null}
      {row.state === "skipped" ? (
        <button type="button" class="run-rows__toggle" aria-expanded={props.open} aria-controls={props.reasonsId} onClick={props.onToggle}>
          {props.open ? "Hide reason" : row.skipReasons.length === 1 ? "Show reason" : "Show reasons"}
        </button>
      ) : null}
    </span>
  );
}

function RowsTab(props: { view: RunView }): JSX.Element {
  const view: RunView = props.view;
  const [open, setOpen] = useState<Set<number>>(new Set());
  const terms: RunTermsView | null = view.decision?.request?.terms ?? null;
  const flagged: Set<number> = new Set(
    (terms?.domains ?? []).filter((domain: RunTermsView["domains"][number]): boolean => domain.caution).map((domain: RunTermsView["domains"][number]): number => domain.line),
  );
  const toggle = (line: number): void => {
    const next: Set<number> = new Set(open);
    if (next.has(line)) {
      next.delete(line);
    } else {
      next.add(line);
    }
    setOpen(next);
  };
  if (view.rows.length === 0) {
    return <p class="muted">This run has no rows.</p>;
  }
  return (
    <div class="run-panel">
      <p class="run-panel__summary">{summaryOf(view)}</p>
      <div class="table-scroll" role="region" aria-label="Rows" tabIndex={0}>
        <table class="table run-rows">
          <caption class="visually-hidden">{`Rows of pay run ${view.run.id}`}</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Invoice</th>
              <th scope="col">Supplier</th>
              <th scope="col" class="is-end">
                Amount
              </th>
              <th scope="col">Method</th>
              <th scope="col">Account</th>
              <th scope="col">Due / arrival</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          {view.rows.map((row: RunRowView): JSX.Element => {
            const shown: boolean = open.has(row.line);
            const reasonsId: string = `run-${view.run.id}-row-${row.line}-reasons`;
            return (
              <tbody key={row.line} class="run-rows__group">
                <tr>
                  <td class="muted">{row.line}</td>
                  <td>
                    {row.invoiceId === null ? (
                      <span class="muted">None</span>
                    ) : row.state === "released" ? (
                      <a class="ref" href={paymentHref(row.invoiceId)}>
                        {row.invoiceId}
                      </a>
                    ) : (
                      <Ref>{row.invoiceId}</Ref>
                    )}
                  </td>
                  <td>{row.supplier === null ? <span class="muted">None</span> : <Theirs text={row.supplier} />}</td>
                  <td class="is-end is-numeric">
                    <Money money={row.amount} class="run-rows__amount" />
                  </td>
                  <td>{row.method === null ? <span class="muted">None</span> : (METHODS[row.method] ?? row.method)}</td>
                  <td>
                    {row.account === null ? (
                      <span class="muted">None</span>
                    ) : row.account.ending === null ? (
                      <Theirs text={row.account.label} />
                    ) : (
                      <span class="mono">{`···${row.account.ending}`}</span>
                    )}
                  </td>
                  <td>
                    <DueCell row={row} />
                  </td>
                  <td>
                    <StatusCell row={row} domain={flagged.has(row.line)} open={shown} onToggle={(): void => toggle(row.line)} reasonsId={reasonsId} />
                  </td>
                </tr>
                {row.state === "skipped" && shown ? (
                  <tr class="run-rows__reasons" id={reasonsId}>
                    <td />
                    <td colSpan={7}>
                      <ul class="run-rows__reason-list">
                        {row.skipReasons.map(
                          (reason: RunRowView["skipReasons"][number], index: number): JSX.Element => (
                            <li key={index}>
                              <Theirs text={reason.text} />
                            </li>
                          ),
                        )}
                      </ul>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            );
          })}
        </table>
      </div>
    </div>
  );
}

function CashTab(props: { view: RunView }): JSX.Element {
  const cash: RunView["cash"] = props.view.cash;
  return (
    <div class="run-panel">
      <p class="run-panel__summary">
        {"Checked "}
        <Time at={cash.checkedAt} />
      </p>
      {cash.currencies.length === 0 ? (
        <p class="muted">No rows to pay, so no wallet was checked.</p>
      ) : (
        <div class="run-cash">
          {cash.currencies.map(
            (wallet: RunCashView): JSX.Element => (
              <section class="run-cash__wallet" key={wallet.currency} aria-labelledby={`cash-${wallet.currency}`}>
                <h3 id={`cash-${wallet.currency}`} class="run-cash__title">{`${wallet.currency} wallet`}</h3>
                <dl class="run-cash__list">
                  <dt>Balance</dt>
                  <dd>{wallet.balance === null ? <span class="muted">Not read</span> : <Money money={wallet.balance} />}</dd>
                  <dt>Committed elsewhere</dt>
                  <dd>
                    <Money money={wallet.committedElsewhere} />
                  </dd>
                  <dt>These rows</dt>
                  <dd>
                    <Money money={wallet.rows} />
                    {wallet.fees.minor > 0 ? (
                      <span class="run-cash__fees">{` (fees about ${wallet.fees.text})`}</span>
                    ) : wallet.fees.estimated === true ? (
                      <span class="run-cash__fees"> (fees not known yet)</span>
                    ) : null}
                  </dd>
                  <dt class="run-cash__strong">Left</dt>
                  <dd class="run-cash__strong">{wallet.left === null ? <span class="muted">Not known</span> : <Money money={wallet.left} />}</dd>
                  <dt>Reserve floor</dt>
                  <dd class={wallet.floor === null ? "is-warn" : undefined}>{wallet.floor === null ? "Not set" : <Money money={wallet.floor} />}</dd>
                  {wallet.short === null ? null : (
                    <>
                      <dt class="is-danger">Short by</dt>
                      <dd class="is-danger">
                        <Money money={wallet.short} />
                      </dd>
                    </>
                  )}
                </dl>
              </section>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function RunPage(props: { id: number; tab: string | undefined; asked: string | null }): JSX.Element {
  const path: string = `/api/runs/${props.id}`;
  const polled: Polled<RunView> = usePoll<RunView>(path, pace, { remember: true });
  const view: RunView | null = polled.data;
  const tab: RunTab = tabOf(props.tab);
  return (
    <div class="run-page" id={`run-${props.id}`}>
      <LoadError what={`pay run ${props.id}`} error={polled.error} />
      {view === null ? (
        polled.error === null ? (
          <div class="card card--flush">
            <Loading rows={3} label={`Loading pay run ${props.id}`} />
          </div>
        ) : polled.error.status === 404 ? (
          <Empty title={`Pay run ${props.id} isn't in the ledger.`}>
            <a href="#runs">All pay runs</a>
          </Empty>
        ) : null
      ) : (
        <>
          <Header view={view} />
          {view.decision === null ? null : (
            <RunDecision
              key={view.decision.request?.id ?? 0}
              view={view}
              decision={view.decision}
              asked={props.asked}
              onActed={(fresh: RunView): void => polled.replace(fresh)}
              refresh={(): void => polled.refresh()}
            />
          )}
          <section class="card card--flush run-record" aria-label="Pay run record">
            <Tabs
              label="Pay run record"
              tabs={[
                { key: "rows", label: "Rows", count: view.rows.length, href: `${runHref(view.run.id)}/rows` },
                { key: "cash", label: "Cash check", href: `${runHref(view.run.id)}/cash` },
                { key: "timeline", label: "Timeline", href: `${runHref(view.run.id)}/timeline` },
                { key: "audit", label: "Audit", href: `${runHref(view.run.id)}/audit` },
              ]}
              current={tab}
            />
            <div class="run-record__body">
              {tab === "rows" ? (
                <RowsTab view={view} />
              ) : tab === "cash" ? (
                <CashTab view={view} />
              ) : tab === "timeline" ? (
                <Timeline timeline={view.timeline} />
              ) : (
                <AuditLine audit={view.audit} />
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

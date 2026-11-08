import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Icon } from "../components/Icon";
import { ClickRow } from "../components/Layout";
import { Empty, LoadError, Loading } from "../components/States";
import { Money, Theirs, Time } from "../components/Text";
import { ToneBadge } from "../components/Tone";
import { useTitle } from "../hooks";
import { FAST_MS, SLOW_MS, usePoll, type Polled } from "../poll";
import { navigate, runHref, type ScreenProps } from "../router";
import type { Money as MoneyView, RunListRow, RunsView } from "../types";
import { RunPage } from "./runs/Run";
import { RunUpload } from "./runs/Upload";
import "./runs.css";

// Pay runs (ia.md section 6): the list of runs and, on #run/N, that run under
// it, as the mockup draws them. #runs/upload opens the upload panel. The list is
// polled every 5 s, and every 1.5 s while PayOnce works on a run.

const UPLOAD_ID: string = "run-upload";

function idOf(raw: string | undefined): number | null {
  return raw !== undefined && /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : null;
}

function pace(view: RunsView | null): number {
  return view !== null && view.rows.some((row: RunListRow): boolean => row.activity.busy) ? FAST_MS : SLOW_MS;
}

function countsText(row: RunListRow): string {
  const parts: string[] = [`${row.counts.pay} pay`];
  if (row.counts.held > 0) {
    parts.push(`${row.counts.held} possible second ${row.counts.held === 1 ? "bill" : "bills"}`);
  }
  if (row.counts.skip > 0) {
    parts.push(`${row.counts.skip} skipped`);
  }
  return parts.join(" · ");
}

function RunList(props: { view: RunsView; current: number | null }): JSX.Element {
  return (
    <section class="card card--flush run-list" aria-label="Pay runs">
      <div class="table-scroll run-list__scroll" role="region" aria-label="Pay runs" tabIndex={0}>
        <table class="table run-list__table">
          <caption class="visually-hidden">Pay runs</caption>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">File</th>
              <th scope="col">Uploaded</th>
              <th scope="col">State</th>
              <th scope="col">Rows</th>
              <th scope="col" class="is-end">
                Totals
              </th>
            </tr>
          </thead>
          <tbody>
            {props.view.rows.map((row: RunListRow): JSX.Element => {
              const on: boolean = row.id === props.current;
              return (
                <ClickRow key={row.id} class={on ? "is-current" : undefined} onOpen={(): void => navigate(runHref(row.id))}>
                  <td class="run-list__run">
                    <a class="run-list__link" href={runHref(row.id)} aria-current={on ? "page" : undefined}>
                      {`Pay run ${row.id}`}
                    </a>
                  </td>
                  <td data-label="File">
                    <Theirs text={row.fileName} class="mono run-list__file" />
                  </td>
                  <td data-label="Uploaded">
                    <Theirs text={row.uploadedBy} />
                    {" · "}
                    <Time at={row.uploadedAt} />
                  </td>
                  <td data-label="State">
                    <span class="run-list__state">
                      <ToneBadge tone={row.situation.tone} label={row.situation.label} />
                      {row.activity.busy ? (
                        <span class="working">
                          <span class="working__dot" aria-hidden="true" />
                          Working
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Rows">{countsText(row)}</td>
                  <td class="is-end" data-label="Totals">
                    <span class="run-list__totals">
                      {row.totals.length === 0 ? (
                        <span class="muted">Nothing to pay</span>
                      ) : (
                        row.totals.map(
                          (total: MoneyView): JSX.Element => <Money key={total.currency} money={total} class="run-list__total" />,
                        )
                      )}
                    </span>
                  </td>
                </ClickRow>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Runs(props: ScreenProps): JSX.Element {
  const route: ScreenProps["route"] = props.route;
  const runId: number | null = route.word === "run" ? idOf(route.segments[0]) : null;
  useTitle(runId === null ? "Pay runs" : `Pay run ${runId}`);
  const polled: Polled<RunsView> = usePoll<RunsView>("/api/runs", pace, { remember: true });
  const view: RunsView | null = polled.data;
  const [uploading, setUploading] = useState<boolean>(route.word === "runs" && route.segments[0] === "upload");

  return (
    <div class="screen runs">
      <header class="screen__head">
        <div class="screen__bar">
          <h1 class="screen__title">Pay runs</h1>
          <button
            type="button"
            class="btn btn--primary screen__end"
            aria-expanded={uploading}
            aria-controls={UPLOAD_ID}
            onClick={(): void => setUploading(!uploading)}
          >
            <Icon name="plus" />
            Upload pay run
          </button>
        </div>
        <p class="screen__lede">A CSV of supplier payments, checked and approved together, then sent one row at a time.</p>
      </header>
      {uploading ? <RunUpload runs={view} id={UPLOAD_ID} /> : null}
      <LoadError what="the pay runs" error={polled.error} />
      {view === null ? (
        polled.error === null ? (
          <div class="card card--flush">
            <Loading rows={3} label="Loading pay runs" />
          </div>
        ) : null
      ) : view.rows.length === 0 ? (
        <Empty title="No pay runs yet.">
          <p class="muted">Upload a CSV of supplier payments to check and approve them together.</p>
          <div class="button-row">
            {uploading ? null : (
              <button type="button" class="btn btn--primary" aria-controls={UPLOAD_ID} onClick={(): void => setUploading(true)}>
                Upload pay run
              </button>
            )}
            <a class="btn btn--secondary" href="/api/runs/example.csv" download>
              Download the example file
            </a>
          </div>
        </Empty>
      ) : (
        <RunList view={view} current={runId} />
      )}
      {runId === null ? (
        route.word === "run" ? (
          <Empty title="That isn't a pay run number.">
            <a href="#runs">All pay runs</a>
          </Empty>
        ) : null
      ) : (
        <RunPage id={runId} tab={route.segments[1]} asked={route.params.get("do")} onActed={(): void => polled.refresh()} />
      )}
    </div>
  );
}

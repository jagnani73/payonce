import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { ApiError, postJson } from "../../api";
import { ActionButton } from "../../components/Action";
import { Field, NameField, type ControlProps } from "../../components/Form";
import { Callout } from "../../components/Notice";
import { useNameDraft } from "../../me";
import { notify } from "../../notices";
import { navigate, runHref } from "../../router";
import { cleanLine } from "../../text";
import type { Acted, RunsView, RunView } from "../../types";
import { rememberView } from "../../poll";

// Upload pay run (ia.md section 6): the CSV's text and a name go to POST
// /api/runs, which checks every row against Airwallex (GETs only) before it
// answers. A refusal shows under the button: the file's problems by line, the
// run already waiting (only one waits at a time), the same file uploaded before,
// or every row skipped, with each row as RunRowView.

interface Problem {
  line: number | null;
  text: string;
}

interface SkippedRow {
  line: number | null;
  invoiceId: string | null;
  supplier: string | null;
  reasons: string[];
}

type Refusal =
  | { kind: "problems"; problems: Problem[] }
  | { kind: "waiting"; runId: number }
  | { kind: "same-file"; runId: number }
  | { kind: "skipped"; rows: SkippedRow[] }
  | { kind: "other" };

const UNKNOWN: Refusal = { kind: "other" };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textOr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function lineOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function problemsOf(value: unknown): Problem[] {
  return (Array.isArray(value) ? value : []).flatMap((item: unknown): Problem[] => {
    const found: Record<string, unknown> | null = record(item);
    const text: string | null = textOr(found?.["text"]);
    return found === null || text === null ? [] : [{ line: lineOf(found["line"]), text }];
  });
}

function skippedOf(value: unknown): SkippedRow[] {
  return (Array.isArray(value) ? value : []).flatMap((item: unknown): SkippedRow[] => {
    const row: Record<string, unknown> | null = record(item);
    if (row === null) {
      return [];
    }
    const reasons: unknown = row["skipReasons"];
    return [
      {
        line: lineOf(row["line"]),
        invoiceId: textOr(row["invoiceId"]),
        supplier: textOr(row["supplier"]),
        reasons: (Array.isArray(reasons) ? reasons : []).flatMap((reason: unknown): string[] => {
          const text: string | null = textOr(record(reason)?.["text"]);
          return text === null ? [] : [text];
        }),
      },
    ];
  });
}

function refusalOf(error: ApiError): Refusal {
  const body: Record<string, unknown> | null = error.body;
  const runId: number | null = lineOf(body?.["runId"]);
  if (error.status === 400 && Array.isArray(body?.["problems"])) {
    return { kind: "problems", problems: problemsOf(body?.["problems"]) };
  }
  if (error.status === 409 && runId !== null) {
    return body?.["code"] === "same-file" ? { kind: "same-file", runId } : { kind: "waiting", runId };
  }
  if (error.status === 422 && Array.isArray(body?.["rows"])) {
    return { kind: "skipped", rows: skippedOf(body?.["rows"]) };
  }
  return UNKNOWN;
}

// Data lines in the file, for "Checking 6 rows against Airwallex…".
function rowsIn(csv: string): number {
  return Math.max(0, csv.split(/\r\n|\r|\n/).filter((line: string): boolean => line.trim() !== "").length - 1);
}

function RefusalDetail(props: { refusal: Refusal }): JSX.Element | null {
  const refusal: Refusal = props.refusal;
  switch (refusal.kind) {
    case "problems":
      return refusal.problems.length === 0 ? null : (
        <ul class="run-upload__problems">
          {refusal.problems.map(
            (problem: Problem, index: number): JSX.Element => (
              <li key={index}>
                {problem.line === null ? null : <strong>{`Line ${problem.line}: `}</strong>}
                <bdi class="theirs">{cleanLine(problem.text)}</bdi>
              </li>
            ),
          )}
        </ul>
      );
    case "waiting":
      return (
        <Callout tone="danger">
          {`Pay run ${refusal.runId} is waiting for approval. Only one run waits at a time. `}
          <a href={runHref(refusal.runId)}>{`Open pay run ${refusal.runId}`}</a>
        </Callout>
      );
    case "same-file":
      return (
        <p>
          <a href={runHref(refusal.runId)}>{`Open pay run ${refusal.runId}`}</a>
        </p>
      );
    case "skipped":
      return (
        <div class="run-upload__skipped">
          <p>Every row was skipped, so nothing was stored:</p>
          <ul class="run-upload__problems">
            {refusal.rows.map(
              (row: SkippedRow, index: number): JSX.Element => (
                <li key={index}>
                  <strong>
                    {row.line === null ? "A row" : `Line ${row.line}`}
                    {row.invoiceId === null ? null : (
                      <>
                        {" ("}
                        <bdi class="theirs">{cleanLine(row.invoiceId)}</bdi>
                        {")"}
                      </>
                    )}
                    {": "}
                  </strong>
                  <bdi class="theirs">{row.reasons.map(cleanLine).join(" · ") || "skipped"}</bdi>
                </li>
              ),
            )}
          </ul>
        </div>
      );
    case "other":
      return null;
  }
}

export function RunUpload(props: { runs: RunsView | null; id: string }): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useNameDraft();
  const [checking, setChecking] = useState<number>(0);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const upload: RunsView["upload"] | null = props.runs?.upload ?? null;

  const maxChars: number = upload?.maxChars ?? 40_000;
  const required: RunsView["upload"]["columns"] = upload?.columns.filter((column: RunsView["upload"]["columns"][number]): boolean => column.required) ?? [];
  const optional: RunsView["upload"]["columns"] = upload?.columns.filter((column: RunsView["upload"]["columns"][number]): boolean => !column.required) ?? [];
  const busy: string = checking === 1 ? "Checking 1 row against Airwallex…" : `Checking ${checking} rows against Airwallex…`;

  async function check(): Promise<void> {
    setRefusal(null);
    // Four bytes a character at most, so a larger file is too long whatever it holds.
    if (file !== null && file.size > maxChars * 4) {
      throw new ApiError(413, `The file is too large. A pay run file can be at most ${maxChars.toLocaleString("en-US")} characters.`);
    }
    const csv: string = file === null ? "" : await file.text();
    setChecking(rowsIn(csv));
    const acted: Acted<RunView> = await postJson<Acted<RunView>>("/api/runs", { fileName: file?.name ?? "", csv, uploadedBy: name });
    rememberView(`/api/runs/${acted.view.run.id}`, acted.view);
    notify(acted.notice);
    navigate(runHref(acted.view.run.id));
  }

  return (
    <section id={props.id} class="card card--accent run-upload" aria-labelledby={`${props.id}-title`}>
      <h2 id={`${props.id}-title`} class="card__title">
        Upload pay run
      </h2>
      <div class="run-upload__fields">
        <Field
          label="CSV file"
          hint={`Up to ${maxChars.toLocaleString("en-US")} characters and ${upload?.maxRows ?? 50} rows.`}
        >
          {(control: ControlProps): JSX.Element => (
            <input
              {...control}
              class="input run-upload__file"
              type="file"
              accept=".csv,text/csv"
              onChange={(event: Event): void => {
                setFile((event.currentTarget as HTMLInputElement).files?.[0] ?? null);
                setRefusal(null);
              }}
            />
          )}
        </Field>
        <NameField label="Uploaded by" value={name} onInput={setName} hint="You won't be able to approve this run." />
      </div>
      <details class="details run-upload__columns">
        <summary>Columns</summary>
        <p>
          {"Required: "}
          {required.map(
            (column: RunsView["upload"]["columns"][number], index: number): JSX.Element => (
              <span key={column.name}>
                {index === 0 ? null : ", "}
                <code>{column.name}</code>
              </span>
            ),
          )}
          .
        </p>
        <p>
          {"Optional: "}
          {optional.map(
            (column: RunsView["upload"]["columns"][number], index: number): JSX.Element => (
              <span key={column.name}>
                {index === 0 ? null : ", "}
                <code>{column.name}</code>
                {column.name === "sandbox_outcome" ? " (sandbox only)" : null}
              </span>
            ),
          )}
          .
        </p>
        <dl class="run-upload__notes">
          {upload?.columns.map(
            (column: RunsView["upload"]["columns"][number]): JSX.Element => (
              <div key={column.name}>
                <dt>
                  <code>{column.name}</code>
                </dt>
                <dd>{column.note}</dd>
              </div>
            ),
          )}
        </dl>
        <p>
          <a href="/api/runs/example.csv" download>
            Download the example file
          </a>
        </p>
      </details>
      <div class="run-upload__actions">
        <ActionButton
          label="Check file"
          busyLabel={busy}
          kind="primary"
          onAction={check}
          onError={(error: ApiError): void => setRefusal(refusalOf(error))}
        />
      </div>
      {refusal === null ? null : <RefusalDetail refusal={refusal} />}
    </section>
  );
}

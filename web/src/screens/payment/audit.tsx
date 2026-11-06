import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { asApiError, getJson } from "../../api";
import { Table, type Column } from "../../components/Layout";
import { Loading } from "../../components/States";
import { Theirs } from "../../components/Text";
import { AuditLine } from "../../components/Timeline";
import type { IncidentAuditExport, IncidentView } from "../../types";

// The Audit tab (ia.md 3.4): whether the payment's hash chain checks out, the
// exports, and every stored line exactly as written, with its hash. The lines
// come from the JSON export, read again whenever the line count changes.

type AuditRow = IncidentAuditExport["lines"][number];

const COLUMNS: Column<AuditRow>[] = [
  { key: "n", label: "#", cell: (row: AuditRow): string => String(row.line), numeric: true },
  { key: "at", label: "Time (UTC)", cell: (row: AuditRow): JSX.Element => <span class="mono pay-nowrap">{row.at}</span> },
  { key: "kind", label: "Kind", cell: (row: AuditRow): string => row.kind },
  { key: "line", label: "Line", cell: (row: AuditRow): JSX.Element => <Theirs text={row.message} /> },
  {
    key: "hash",
    label: "Hash",
    cell: (row: AuditRow): JSX.Element | null =>
      row.hash === null ? null : (
        <span class="mono" title={row.hash}>
          {row.hash.slice(0, 12)}
        </span>
      ),
  },
];

export function AuditTab(props: { view: IncidentView }): JSX.Element {
  const audit: IncidentView["audit"] = props.view.audit;
  const [lines, setLines] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect((): (() => void) => {
    let gone: boolean = false;
    getJson<IncidentAuditExport>(audit.exports.json)
      .then((read: IncidentAuditExport): void => {
        if (!gone) {
          setLines(read.lines);
          setError(null);
        }
      })
      .catch((caught: unknown): void => {
        if (!gone) {
          setError(asApiError(caught).message);
        }
      });
    return (): void => {
      gone = true;
    };
  }, [audit.exports.json, audit.lines]);
  return (
    <div class="pay-list">
      <AuditLine audit={audit} />
      {error === null ? null : (
        <p class="inline-error" role="alert">{`Couldn't read the audit trail. ${error}`}</p>
      )}
      {lines === null ? (
        error === null ? <Loading rows={3} label="Loading the audit trail" /> : null
      ) : (
        <Table caption="Audit trail" columns={COLUMNS} rows={lines} rowKey={(row: AuditRow): string => String(row.id)} minWidth={880} empty="Nothing has happened yet." />
      )}
    </div>
  );
}

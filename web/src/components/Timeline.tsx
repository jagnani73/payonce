import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import type { AuditLineView, EventKind, TimelineLine, TimelineView } from "../types";
import { Icon, type IconName } from "./Icon";
import { Theirs, Time } from "./Text";

// A payment's or a pay run's timeline as the view shapes it: newest first, runs
// of system lines folded into one "Show N system lines" row, repeated errors
// already grouped by the server. A warning, a decision or an approval is never
// folded away, even when the system wrote it. New lines get a brief highlight;
// the page never scrolls by itself.

export type Filter = "all" | "decisions" | "bank" | "emails" | "approvals" | "messages";

const FILTERS: readonly [Filter, string][] = [
  ["all", "All"],
  ["decisions", "Decisions"],
  ["bank", "Bank"],
  ["emails", "Emails"],
  ["approvals", "Approvals"],
  ["messages", "Messages"],
];

const FILTER_OF: Partial<Record<EventKind, Filter>> = {
  decision: "decisions",
  bank: "bank",
  payment: "bank",
  outage: "bank",
  email: "emails",
  approval: "approvals",
  callback: "approvals",
  contact: "approvals",
  outbox: "messages",
};

const ICONS: Record<EventKind, IconName> = {
  payment: "payment",
  email: "email",
  bank: "bank",
  decision: "decision",
  approval: "approval",
  warning: "warning",
  lock: "lock",
  closed: "closed",
  callback: "callback",
  contact: "callback",
  error: "error",
  outbox: "message",
  outage: "outage",
};

type Item = { line: TimelineLine } | { folded: number; key: string };

const NEVER_FOLDED: ReadonlySet<EventKind> = new Set<EventKind>(["warning", "decision", "approval"]);

function foldable(line: TimelineLine): boolean {
  return line.system && !NEVER_FOLDED.has(line.kind);
}

function Line(props: { line: TimelineLine; fresh: boolean }): JSX.Element {
  const line: TimelineLine = props.line;
  const classes: string = [
    "tl__line",
    line.kind === "decision" ? "tl__line--decision" : "",
    line.system ? "tl__line--system" : "",
    props.fresh ? "is-new" : "",
  ]
    .filter((name: string): boolean => name !== "")
    .join(" ");
  return (
    <li class={classes}>
      <Time at={line.at} class="tl__time" />
      <span class="tl__kind">
        <Icon name={ICONS[line.kind]} />
        {line.kindLabel}
      </span>
      <span class="tl__text">
        {line.lead === null ? null : <span class="pill pill--accent tl__lead">{line.lead}</span>}
        <Theirs text={line.text} />
        {line.repeat === null ? null : (
          <span class="tl__repeat">
            {` · ${line.repeat.count} times, `}
            <Time at={line.repeat.firstAt} />
            {" to "}
            <Time at={line.repeat.lastAt} />
          </span>
        )}
      </span>
    </li>
  );
}

// filters: the chips to offer, all of them when left out. A pay run's timeline
// has no emails or messages.
export function Timeline(props: { timeline: TimelineView; empty?: string; filters?: readonly Filter[] }): JSX.Element {
  const [filter, setFilter] = useState<Filter>("all");
  const [showSystem, setShowSystem] = useState<boolean>(false);
  const seen = useRef<Set<number> | null>(null);

  const first: boolean = seen.current === null;
  const known: Set<number> = seen.current ?? new Set<number>();
  const fresh: Set<number> = new Set<number>(
    first ? [] : props.timeline.lines.filter((line: TimelineLine): boolean => !known.has(line.id)).map((line: TimelineLine): number => line.id),
  );
  for (const line of props.timeline.lines) {
    known.add(line.id);
  }
  seen.current = known;

  const shown: TimelineLine[] =
    filter === "all"
      ? props.timeline.lines
      : props.timeline.lines.filter((line: TimelineLine): boolean => !foldable(line) && FILTER_OF[line.kind] === filter);
  const items: Item[] = [];
  let folded: number = 0;
  for (const line of shown) {
    if (foldable(line) && !showSystem) {
      folded += 1;
      continue;
    }
    if (folded > 0) {
      items.push({ folded, key: `fold-${line.id}` });
      folded = 0;
    }
    items.push({ line });
  }
  if (folded > 0) {
    items.push({ folded, key: "fold-end" });
  }

  return (
    <div class="tl">
      <div class="chips" role="group" aria-label="Filter lines">
        {FILTERS.filter(([key]: [Filter, string]): boolean => key === "all" || props.filters === undefined || props.filters.includes(key)).map(
          ([key, label]: [Filter, string]): JSX.Element => (
            <button key={key} type="button" class="filter-chip" aria-pressed={filter === key} onClick={(): void => setFilter(key)}>
              {label}
            </button>
          ),
        )}
      </div>
      {shown.length === 0 ? (
        <p class="muted">{props.timeline.lines.length === 0 ? (props.empty ?? "Nothing has happened yet.") : "No lines of this kind yet."}</p>
      ) : (
        <ol class="tl__list">
          {items.map((item: Item): JSX.Element =>
            "line" in item ? (
              <Line key={item.line.id} line={item.line} fresh={fresh.has(item.line.id)} />
            ) : (
              <li key={item.key} class="tl__fold">
                <button type="button" class="tl__fold-button" aria-expanded={false} onClick={(): void => setShowSystem(true)}>
                  <Icon name="chevron-right" />
                  {item.folded === 1 ? "Show 1 system line" : `Show ${item.folded} system lines`}
                </button>
              </li>
            ),
          )}
        </ol>
      )}
      {showSystem && props.timeline.systemCount > 0 ? (
        <button type="button" class="btn btn--secondary tl__hide" onClick={(): void => setShowSystem(false)}>
          Hide system lines
        </button>
      ) : null}
    </div>
  );
}

// Whether a timeline's hash chain still checks out, with its exports.
export function AuditLine(props: { audit: AuditLineView }): JSX.Element {
  const audit: AuditLineView = props.audit;
  return (
    <div class="audit-line">
      <span class={audit.intact ? "audit-line__state" : "audit-line__state audit-line__state--broken"}>
        <Icon name={audit.intact ? "lock" : "warning"} />
        {audit.intact
          ? `Intact · ${audit.lines === 1 ? "1 line" : `${audit.lines} lines`} · running hash matches`
          : `Broken: ${audit.problem ?? "the hash chain doesn't verify"}`}
      </span>
      <span class="audit-line__exports">
        <a class="btn btn--secondary" href={audit.exports.json} download>
          Export JSON
        </a>
        {audit.exports.csv === null ? null : (
          <a class="btn btn--secondary" href={audit.exports.csv} download>
            Export CSV
          </a>
        )}
      </span>
    </div>
  );
}

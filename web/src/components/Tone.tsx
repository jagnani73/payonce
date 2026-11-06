import type { ComponentChildren, JSX } from "preact";
import type { Blocker, RunSituation, Situation, Tone } from "../types";
import { Icon } from "./Icon";

// The state chip. Each tone has its own fill, border and glyph, so tones differ
// in lightness and shape, not in hue alone: act is a filled dot on blue, urgent a
// triangle on a dark fill, progress a hollow ring, blocked pause bars with a
// dashed border, done a tick on grey.

const GLYPHS: Record<Tone, { d: string; filled: boolean }> = {
  act: { d: "M5 1.6a3.4 3.4 0 1 0 0.01 0z", filled: true },
  urgent: { d: "M5 1.2L9 8.8H1z", filled: true },
  progress: { d: "M5 1.8a3.2 3.2 0 1 0 0.01 0z", filled: false },
  blocked: { d: "M3.5 2v6M6.5 2v6", filled: false },
  done: { d: "M1.8 5.4l2.2 2.3L8.4 2.6", filled: false },
};

export function ToneBadge(props: { tone: Tone; label: string; size?: "small" | "large" }): JSX.Element {
  const glyph: { d: string; filled: boolean } = GLYPHS[props.tone];
  return (
    <span class={`chip chip--${props.tone}${props.size === "large" ? " chip--large" : ""}`}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        <path
          d={glyph.d}
          fill={glyph.filled ? "currentColor" : "none"}
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      {props.label}
    </span>
  );
}

// A small grey tag: "Outage 3", "From pay run 7".
export function Tag(props: { children: ComponentChildren }): JSX.Element {
  return <span class="tag">{props.children}</span>;
}

function isPayment(situation: Situation | RunSituation): situation is Situation {
  return "blockers" in situation;
}

// The state of a payment or a pay run as a header: the chip and its detail, the
// next step, then what blocks it and the also-lines. compact drops the also-lines
// and puts the next step in a smaller paragraph, for list rows.
export function SituationHeader(props: {
  situation: Situation | RunSituation;
  compact?: boolean;
  // Placed after the chip's detail, such as "· open until 15:25".
  extra?: ComponentChildren;
}): JSX.Element {
  const situation: Situation | RunSituation = props.situation;
  // A blocked "Approved, sending" already says its blocker as the next step.
  const blockers: Blocker[] = isPayment(situation)
    ? situation.blockers.filter((blocker: Blocker): boolean => blocker.text !== situation.next)
    : [];
  const also: string[] = isPayment(situation) && props.compact !== true ? situation.also : [];
  return (
    <div class={props.compact === true ? "situation situation--compact" : "situation"}>
      <div class="situation__state">
        <ToneBadge tone={situation.tone} label={situation.label} size={props.compact === true ? "small" : "large"} />
        {situation.detail === null && props.extra === undefined ? null : (
          <span class="situation__detail">
            {situation.detail}
            {props.extra}
          </span>
        )}
      </div>
      <p class="situation__next">
        {props.compact === true ? null : <strong>Next: </strong>}
        {situation.next}
      </p>
      {blockers.map(
        (blocker: Blocker): JSX.Element => (
          <p class="situation__blocker" key={blocker.code}>
            <Icon name="pause" />
            <span>{blocker.text}</span>
          </p>
        ),
      )}
      {also.map(
        (line: string): JSX.Element => (
          <p class="situation__also" key={line}>
            {line}
          </p>
        ),
      )}
    </div>
  );
}

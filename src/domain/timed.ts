// A sentence that names times (glossary.md section 4), in parts: PayOnce's words,
// and each time as its ISO value in UTC. deadline marks a deadline or an expiry,
// which the page writes with how long is left. The page writes every time in the
// viewer's zone, the CLI in UTC, and MCP passes the ISO value. A sentence with no
// time is one string.
export interface TimePart {
  at: string;
  deadline?: true;
}

export type TimedPart = string | TimePart;
export type Timed = TimedPart[];

export function timeAt(at: number | string | null | undefined, deadline: boolean = false): TimePart | null {
  const ms: number = typeof at === "string" ? Date.parse(at) : (at ?? Number.NaN);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const iso: string = new Date(ms).toISOString();
  return deadline ? { at: iso, deadline: true } : { at: iso };
}

// The parts in order, with the empty and missing ones left out and runs of words
// joined into one string.
export function timed(...parts: (TimedPart | Timed | null | undefined)[]): Timed {
  const out: Timed = [];
  for (const part of parts.flatMap((item: TimedPart | Timed | null | undefined): (TimedPart | null | undefined)[] =>
    Array.isArray(item) ? item : [item],
  )) {
    if (part === null || part === undefined || part === "") {
      continue;
    }
    const last: TimedPart | undefined = out.at(-1);
    if (typeof part === "string" && typeof last === "string") {
      out[out.length - 1] = `${last}${part}`;
    } else {
      out.push(part);
    }
  }
  return out;
}

// The sentence as text, each time written by write.
export function timedText(sentence: Timed, write: (at: string) => string): string {
  return sentence.map((part: TimedPart): string => (typeof part === "string" ? part : write(part.at))).join("");
}

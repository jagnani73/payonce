import type { Polled } from "../../poll";

// The last view each path answered while the page is open. The shell remounts a
// screen for another object (#inbox/3 to #inbox/4, #run/6 to #run/7), and its
// poll starts empty; the kept view stays on screen until the poll answers, so
// the list beside the open item never goes back to loading. An action that
// moves to another object keeps its answer here first, so it shows at once.

const MAX_KEPT: number = 40;
const kept: Map<string, unknown> = new Map();

export function keep<T>(path: string, view: T): void {
  kept.delete(path);
  kept.set(path, view);
  if (kept.size > MAX_KEPT) {
    const oldest: string | undefined = kept.keys().next().value;
    if (oldest !== undefined) {
      kept.delete(oldest);
    }
  }
}

// The polled view, or the one kept for this path until the poll answers.
export function useKept<T>(path: string | null, polled: Polled<T>): T | null {
  if (path === null) {
    return null;
  }
  if (polled.data !== null) {
    if (kept.get(path) !== polled.data) {
      keep(path, polled.data);
    }
    return polled.data;
  }
  return (kept.get(path) as T | undefined) ?? null;
}

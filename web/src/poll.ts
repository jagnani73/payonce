import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, asApiError, getJson } from "./api";

// The one poll scheduler. A screen reads its view with usePoll(path, every):
// the first read starts at once, the next one starts `every(view)` ms after the
// last answer, and a read still running is never started again. A failed read
// keeps the last good view on screen and tries again at the same pace. Only the
// screen on show polls, because the hook stops when its component goes.
//
// Polls never wipe what someone is typing: a new view only re-renders, and a
// form keeps its draft in its own component state, keyed by the object's id.

export const FAST_MS: number = 1_500;
export const SLOW_MS: number = 5_000;

export interface Polled<T> {
  // The latest view, or null before the first answer (or after the path changed).
  data: T | null;
  // The last read's failure, cleared by the next good answer.
  error: ApiError | null;
  // Nothing on screen yet and no failure: show <Loading>.
  loading: boolean;
  // Read again now. One already running is followed by another when it ends.
  refresh: () => void;
  // Put a view an action answered with on screen. A read that started before it
  // is dropped when it lands, so an older answer never replaces it.
  replace: (data: T) => void;
}

interface Held<T> {
  path: string | null;
  data: T | null;
  error: ApiError | null;
}

interface Control<T> {
  refresh: () => void;
  replace: (data: T) => void;
}

// keep: when the path changes (say a filter), the old view stays on screen until
// the new one lands, instead of going back to loading.
export function usePoll<T>(path: string | null, every: (data: T | null) => number, keep: boolean = false): Polled<T> {
  const [held, setHeld] = useState<Held<T>>({ path, data: null, error: null });
  const everyRef = useRef<(data: T | null) => number>(every);
  everyRef.current = every;
  const control = useRef<Control<T>>({ refresh: (): void => undefined, replace: (): void => undefined });

  useEffect((): (() => void) | undefined => {
    if (path === null) {
      return undefined;
    }
    let stopped: boolean = false;
    let timer: number = 0;
    let running: boolean = false;
    let again: boolean = false;
    let generation: number = 0;
    let latest: T | null = null;

    const schedule = (ms: number): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(read, ms);
    };

    async function read(): Promise<void> {
      window.clearTimeout(timer);
      if (running) {
        again = true;
        return;
      }
      running = true;
      const mine: number = generation;
      try {
        const data: T = await getJson<T>(path as string);
        if (!stopped && mine === generation) {
          latest = data;
          setHeld({ path, data, error: null });
        }
      } catch (error: unknown) {
        if (!stopped) {
          setHeld((now: Held<T>): Held<T> => ({ path, data: now.path === path || keep ? now.data : null, error: asApiError(error) }));
        }
      } finally {
        running = false;
      }
      if (stopped) {
        return;
      }
      if (again) {
        again = false;
        void read();
        return;
      }
      schedule(everyRef.current(latest));
    }

    control.current = {
      refresh: (): void => {
        if (!stopped) {
          void read();
        }
      },
      replace: (data: T): void => {
        if (stopped) {
          return;
        }
        generation += 1;
        latest = data;
        setHeld({ path, data, error: null });
        if (!running) {
          schedule(everyRef.current(data));
        }
      },
    };
    void read();
    return (): void => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [path]);

  const current: boolean = held.path === path;
  const data: T | null = current || keep ? held.data : null;
  const error: ApiError | null = current ? held.error : null;
  return {
    data,
    error,
    loading: data === null && error === null,
    refresh: (): void => control.current.refresh(),
    replace: (next: T): void => control.current.replace(next),
  };
}

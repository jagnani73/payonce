import { useEffect, useState } from "preact/hooks";

// What the sandbox simulator keeps in this browser, for the simulator drawer and
// New payment. Conveniences only: the server checks every value it is sent.
//
// The next payment's bank outcome: what the sandbox bank plays on the first
// transfer of the next payment started from New payment, kept in localStorage.
//
// This session: the last ten simulator actions taken in this tab, newest first,
// with the payment each one is about, kept in sessionStorage, so it lasts while
// the tab does and no other viewer sees it. The server keeps no such list: the
// payment's own timeline is the record.

export const PAID: string = "PAID";

export interface LogEntry {
  at: string;
  invoiceId: string | null;
  text: string;
}

const OUTCOME_KEY: string = "payonce.sandboxOutcome";
const LOG_KEY: string = "payonce.sandboxLog";
const KEPT: number = 10;

interface Shared<T> {
  get: () => T;
  set: (next: T) => void;
  use: () => T;
}

// A value every component that reads it sees, told of each change.
function shared<T>(first: T): Shared<T> {
  let value: T = first;
  const listeners: Set<(value: T) => void> = new Set();
  return {
    get: (): T => value,
    set: (next: T): void => {
      value = next;
      for (const listener of listeners) {
        listener(value);
      }
    },
    use: (): T => {
      const [shown, setShown] = useState<T>(value);
      useEffect((): (() => void) => {
        listeners.add(setShown);
        setShown(value);
        return (): void => {
          listeners.delete(setShown);
        };
      }, []);
      return shown;
    },
  };
}

function storedOutcome(): string {
  try {
    const value: string | null = window.localStorage.getItem(OUTCOME_KEY);
    return value === null || !/^[A-Z_]{1,40}$/.test(value) ? PAID : value;
  } catch {
    return PAID;
  }
}

function isEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry: Record<string, unknown> = value as Record<string, unknown>;
  return (
    typeof entry["at"] === "string" &&
    typeof entry["text"] === "string" &&
    (entry["invoiceId"] === null || typeof entry["invoiceId"] === "string")
  );
}

function storedLog(): LogEntry[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(LOG_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, KEPT) : [];
  } catch {
    return [];
  }
}

const outcome: Shared<string> = shared<string>(storedOutcome());
const log: Shared<LogEntry[]> = shared<LogEntry[]>(storedLog());

export function setSandboxOutcome(next: string): void {
  try {
    window.localStorage.setItem(OUTCOME_KEY, next);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  outcome.set(next);
}

// Another tab changed it.
window.addEventListener("storage", (event: StorageEvent): void => {
  if (event.key === OUTCOME_KEY) {
    outcome.set(storedOutcome());
  }
});

export function useSandboxOutcome(): string {
  return outcome.use();
}

export function logAction(invoiceId: string | null, text: string): void {
  const entries: LogEntry[] = [{ at: new Date().toISOString(), invoiceId, text }, ...log.get()].slice(0, KEPT);
  try {
    window.sessionStorage.setItem(LOG_KEY, JSON.stringify(entries));
  } catch {
    // Storage blocked: the log lasts until the page reloads.
  }
  log.set(entries);
}

export function useSessionLog(): LogEntry[] {
  return log.use();
}

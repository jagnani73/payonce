import { useEffect, useState } from "preact/hooks";

// The simulator's "Next payment's bank outcome": what the sandbox bank plays on
// the first transfer of the next payment started from New payment. Remembered in
// this browser (localStorage), a convenience only: the server checks the value
// against its own list of outcomes on every check and start.

const KEY: string = "payonce.sandboxOutcome";
export const PAID: string = "PAID";
const listeners: Set<(outcome: string) => void> = new Set();

function stored(): string {
  try {
    const value: string | null = window.localStorage.getItem(KEY);
    return value === null || !/^[A-Z_]{1,40}$/.test(value) ? PAID : value;
  } catch {
    return PAID;
  }
}

let outcome: string = stored();

function publish(): void {
  for (const listener of listeners) {
    listener(outcome);
  }
}

export function setSandboxOutcome(next: string): void {
  outcome = next;
  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  publish();
}

window.addEventListener("storage", (event: StorageEvent): void => {
  if (event.key === KEY) {
    outcome = stored();
    publish();
  }
});

export function useSandboxOutcome(): string {
  const [value, setValue] = useState<string>(outcome);
  useEffect((): (() => void) => {
    listeners.add(setValue);
    setValue(outcome);
    return (): void => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}

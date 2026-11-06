import { useEffect, useState } from "preact/hooks";

// The simulator's "This session": the last ten simulator actions taken in this
// tab, newest first, with the payment each one is about. Kept in sessionStorage,
// so it lasts while the tab does and no other viewer sees it. The server keeps
// no such list: the payment's own timeline is the record.

export interface LogEntry {
  at: string;
  invoiceId: string | null;
  text: string;
}

const KEY: string = "payonce.sandboxLog";
const KEPT: number = 10;
const listeners: Set<(entries: LogEntry[]) => void> = new Set();

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

function stored(): LogEntry[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, KEPT) : [];
  } catch {
    return [];
  }
}

let entries: LogEntry[] = stored();

export function logAction(invoiceId: string | null, text: string): void {
  entries = [{ at: new Date().toISOString(), invoiceId, text }, ...entries].slice(0, KEPT);
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Storage blocked: the log lasts until the page reloads.
  }
  for (const listener of listeners) {
    listener(entries);
  }
}

export function useSessionLog(): LogEntry[] {
  const [shown, setShown] = useState<LogEntry[]>(entries);
  useEffect((): (() => void) => {
    listeners.add(setShown);
    setShown(entries);
    return (): void => {
      listeners.delete(setShown);
    };
  }, []);
  return shown;
}

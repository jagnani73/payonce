import { useEffect, useState } from "preact/hooks";
import { cleanLine } from "./text";
import type { Notice } from "./types";

// Action results, shown as toasts by <Toasts> in the shell. Any screen calls
// notify(acted.notice) after an action; errors never come here, they show beside
// the button that caused them.

export interface Toast extends Notice {
  id: number;
}

const SHOWN_MS: number = 8_000;
const MAX_SHOWN: number = 3;
let toasts: Toast[] = [];
let nextId: number = 1;
const listeners: Set<(toasts: Toast[]) => void> = new Set();

function publish(next: Toast[]): void {
  toasts = next;
  for (const listener of listeners) {
    listener(toasts);
  }
}

export function dismiss(id: number): void {
  publish(toasts.filter((toast: Toast): boolean => toast.id !== id));
}

// A warning stays until it is dismissed; the others go after 8 seconds.
export function notify(notice: Notice): void {
  const toast: Toast = { id: nextId, tone: notice.tone, text: cleanLine(notice.text) };
  nextId += 1;
  publish([...toasts, toast].slice(-MAX_SHOWN));
  if (notice.tone !== "warning") {
    window.setTimeout((): void => dismiss(toast.id), SHOWN_MS);
  }
}

export function useToasts(): Toast[] {
  const [shown, setShown] = useState<Toast[]>(toasts);
  useEffect((): (() => void) => {
    listeners.add(setShown);
    return (): void => {
      listeners.delete(setShown);
    };
  }, []);
  return shown;
}

import { useEffect, useState } from "preact/hooks";
import { getJson } from "./api";
import type { SettingsView } from "./types";

// Settings come from .env and change only when PayOnce restarts, so the page
// reads them once and shares the answer: the approver list for "You are", the
// check pace for the status popover. A failed read is tried again on next use.

let settings: SettingsView | null = null;
let reading: Promise<SettingsView> | null = null;

function readSettings(): Promise<SettingsView> {
  reading ??= getJson<SettingsView>("/api/settings")
    .then((view: SettingsView): SettingsView => {
      settings = view;
      return view;
    })
    .finally((): void => {
      reading = null;
    });
  return reading;
}

export function useSettings(): SettingsView | null {
  const [view, setView] = useState<SettingsView | null>(settings);
  useEffect((): (() => void) => {
    let gone: boolean = false;
    if (settings === null) {
      readSettings()
        .then((read: SettingsView): void => {
          if (!gone) {
            setView(read);
          }
        })
        .catch((): void => undefined);
    }
    return (): void => {
      gone = true;
    };
  }, []);
  return view;
}

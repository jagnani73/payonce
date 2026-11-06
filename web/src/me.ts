import { useEffect, useState } from "preact/hooks";

// "You are": the name this browser acts as. PayOnce has no login, so it is a
// per-browser convenience kept in localStorage. It fills every name field (each
// stays editable) and turns on "Waiting for me". The server checks every name
// it is sent against the approver list, its limits and who is barred.

const KEY: string = "payonce.me";
const listeners: Set<(name: string | null) => void> = new Set();

function stored(): string | null {
  try {
    const value: string | null = window.localStorage.getItem(KEY);
    return value === null || value.trim() === "" ? null : value;
  } catch {
    return null;
  }
}

let me: string | null = stored();

export function getMe(): string | null {
  return me;
}

export function setMe(name: string | null): void {
  me = name === null || name.trim() === "" ? null : name.trim();
  try {
    if (me === null) {
      window.localStorage.removeItem(KEY);
    } else {
      window.localStorage.setItem(KEY, me);
    }
  } catch {
    // Storage blocked: the name lasts until the page reloads.
  }
  for (const listener of listeners) {
    listener(me);
  }
}

// Another tab of the page changed it.
window.addEventListener("storage", (event: StorageEvent): void => {
  if (event.key === KEY) {
    me = stored();
    for (const listener of listeners) {
      listener(me);
    }
  }
});

// Whether a name on screen is the You are name, for marking it and picking it
// first. The server decides who a name is; this only lines the two up.
export function sameMe(name: string, mine: string): boolean {
  const key = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return key(name) !== "" && key(name) === key(mine);
}

// The draft of a name field: You are until the person types in it.
export function useNameDraft(): [string, (value: string) => void] {
  const mine: string | null = useMe();
  const [draft, setDraft] = useState<{ value: string; edited: boolean }>({ value: mine ?? "", edited: false });
  useEffect((): void => {
    setDraft((now: { value: string; edited: boolean }) => (now.edited ? now : { value: mine ?? "", edited: false }));
  }, [mine]);
  return [draft.value, (value: string): void => setDraft({ value, edited: true })];
}

export function useMe(): string | null {
  const [name, setName] = useState<string | null>(me);
  useEffect((): (() => void) => {
    listeners.add(setName);
    setName(me);
    return (): void => {
      listeners.delete(setName);
    };
  }, []);
  return name;
}

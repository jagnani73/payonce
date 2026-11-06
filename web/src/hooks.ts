import type { RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";

// Small hooks the shell and the screens share.

// Whether a media query matches, following it as the window resizes.
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState<boolean>((): boolean => window.matchMedia(query).matches);
  useEffect((): (() => void) => {
    const list: MediaQueryList = window.matchMedia(query);
    const follow = (): void => setMatches(list.matches);
    follow();
    list.addEventListener("change", follow);
    return (): void => list.removeEventListener("change", follow);
  }, [query]);
  return matches;
}

// The top bar's two-tier layout needs 900 px; below it the menu sheet takes over.
export const WIDE: string = "(min-width: 900px)";

// "Needs you · PayOnce" in the tab.
export function useTitle(title: string): void {
  useEffect((): void => {
    document.title = title === "" ? "PayOnce" : `${title} · PayOnce`;
  }, [title]);
}

// Closes a popover on Escape or on a click outside it. Escape gives focus back
// to the button that opened it.
export function useDismiss(
  open: boolean,
  close: () => void,
  inside: RefObject<HTMLElement>,
  opener: RefObject<HTMLElement>,
): void {
  useEffect((): (() => void) | undefined => {
    if (!open) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
        opener.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent): void => {
      const target: Node | null = event.target instanceof Node ? event.target : null;
      if (target !== null && !(inside.current?.contains(target) ?? false) && !(opener.current?.contains(target) ?? false)) {
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return (): void => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);
}

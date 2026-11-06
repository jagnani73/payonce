import { useEffect } from "preact/hooks";

// Brings the element a route names into view once it is on screen: #outage/3,
// #reports/audit, #settings/alerts. The shell scrolls a new screen to the top
// in its own effect, which can run in the same flush as this one, so the scroll
// waits for the next task.
export function useScrollTo(id: string | null, ready: boolean): void {
  useEffect((): (() => void) | undefined => {
    if (id === null || !ready) {
      return undefined;
    }
    const timer: number = window.setTimeout((): void => {
      const target: HTMLElement | null = document.getElementById(id);
      target?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
    }, 0);
    return (): void => window.clearTimeout(timer);
  }, [id, ready]);
}

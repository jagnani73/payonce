import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ApiError } from "../api";
import { Icon } from "./Icon";

// What a screen shows before, instead of, or around its content.

// Nothing to list. title is the sentence ia.md gives ("Nothing needs you right
// now."); children add a line, a link or buttons.
export function Empty(props: { title: string; children?: ComponentChildren }): JSX.Element {
  return (
    <div class="empty">
      <p class="empty__title">{props.title}</p>
      {props.children}
    </div>
  );
}

// Its children, once the wait passes 250 ms, so a fast answer never flashes a
// loading state.
export function Delayed(props: { children: ComponentChildren }): JSX.Element | null {
  const [shown, setShown] = useState<boolean>(false);
  useEffect((): (() => void) => {
    const timer: number = window.setTimeout((): void => setShown(true), 250);
    return (): void => window.clearTimeout(timer);
  }, []);
  return shown ? <>{props.children}</> : null;
}

// Grey placeholder rows for a list that has nothing on screen yet.
export function Loading(props: { rows?: number; label?: string }): JSX.Element {
  return (
    <Delayed>
      <div class="loading" role="status" aria-label={props.label ?? "Loading"}>
        {Array.from(
          { length: props.rows ?? 3 },
          (_: unknown, index: number): JSX.Element => (
            <div class="loading__row" key={index} />
          ),
        )}
      </div>
    </Delayed>
  );
}

// A read that failed. It sits above the last good content, which stays on
// screen, and the poll keeps trying: "Could not load Home. Retrying…".
export function LoadError(props: { what: string; error: ApiError | null }): JSX.Element | null {
  if (props.error === null) {
    return null;
  }
  return (
    <div class="load-error" role="alert">
      <Icon name="warning" />
      <span>
        <strong>Could not load {props.what}. Retrying…</strong> {props.error.message}
      </span>
    </div>
  );
}

// A screen another agent has not built yet.
export function NotBuilt(props: { title: string; children?: ComponentChildren }): JSX.Element {
  return (
    <div class="screen">
      <header class="screen__head">
        <h1 class="screen__title">{props.title}</h1>
      </header>
      <Empty title="This screen isn't built yet.">
        <p class="muted">It is part of the new page and comes in a later step.</p>
        {props.children}
      </Empty>
    </div>
  );
}

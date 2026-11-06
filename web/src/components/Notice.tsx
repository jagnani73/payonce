import type { ComponentChildren, JSX } from "preact";
import { dismiss, useToasts, type Toast } from "../notices";
import { Icon, type IconName } from "./Icon";

// Toasts: action results, bottom right on a desktop and along the bottom on a
// phone. The region is always in the page, so a screen reader hears each one.
export function Toasts(): JSX.Element {
  const toasts: Toast[] = useToasts();
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map(
        (toast: Toast): JSX.Element => (
          <div class={`toast toast--${toast.tone}`} key={toast.id}>
            <span class="toast__text">{toast.text}</span>
            <button type="button" class="icon-button icon-button--on-dark" aria-label="Dismiss" onClick={(): void => dismiss(toast.id)}>
              <Icon name="close" />
            </button>
          </div>
        ),
      )}
    </div>
  );
}

const CALLOUT_ICONS: Record<"warning" | "info" | "danger", IconName> = {
  warning: "warning",
  info: "circle",
  danger: "error",
};

// A boxed line inside a card: a caution in amber, a note in blue, a problem in red.
export function Callout(props: { tone: "warning" | "info" | "danger"; children: ComponentChildren }): JSX.Element {
  return (
    <div class={`callout callout--${props.tone}`}>
      <Icon name={CALLOUT_ICONS[props.tone]} />
      <div class="callout__body">{props.children}</div>
    </div>
  );
}

// An error beside the button that caused it.
export function InlineError(props: { message: string | null }): JSX.Element | null {
  return props.message === null ? null : (
    <span class="inline-error" role="alert">
      {props.message}
    </span>
  );
}

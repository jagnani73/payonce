import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "../components/Icon";
import { Empty } from "../components/States";
import { navigate, type Route } from "../router";

// The sandbox simulator (ia.md section 11): #sandbox opens this drawer over the
// screen that was on show, which `under` names. Closing it goes back there.
// Data: GET /api/sandbox (SandboxView). Not built yet.
export function Simulator(props: { under: Route }): JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  const close = (): void => navigate(props.under.hash);
  useEffect((): (() => void) => {
    heading.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return (): void => document.removeEventListener("keydown", onKey);
  }, [props.under.hash]);
  return (
    <div class="drawer">
      <div class="drawer__backdrop" aria-hidden="true" onClick={close} />
      <aside class="drawer__panel" role="dialog" aria-modal="true" aria-labelledby="sim-title">
        <div class="drawer__head">
          <h1 id="sim-title" class="drawer__title" tabIndex={-1} ref={heading}>
            <Icon name="flask" size={20} />
            Sandbox simulator
          </h1>
          <button type="button" class="icon-button icon-button--framed" aria-label="Close the simulator" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <p class="muted">Plays the bank and the supplier in the Airwallex sandbox. Nothing here exists in production.</p>
        <Empty title="This screen isn't built yet.">
          <p class="muted">It is part of the new page and comes in a later step.</p>
        </Empty>
      </aside>
    </div>
  );
}

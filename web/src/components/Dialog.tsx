import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { Icon } from "./Icon";

// A modal dialog on the native <dialog>: showModal() keeps focus inside it and
// the page behind it inert, and Escape closes it. It opens when it mounts and
// closes when it goes. busy: Escape and the close button wait while an action
// in it runs.
export function Modal(props: { title: string; onClose: () => void; busy?: boolean; children: ComponentChildren }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading: string = useId();
  useEffect((): (() => void) => {
    const shown: HTMLDialogElement | null = dialog.current;
    if (shown !== null && !shown.open) {
      shown.showModal();
    }
    return (): void => {
      if (shown?.open === true) {
        shown.close();
      }
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      class="modal"
      aria-labelledby={heading}
      onClose={(): void => props.onClose()}
      onCancel={(event: Event): void => {
        if (props.busy === true) {
          event.preventDefault();
        }
      }}
    >
      <div class="modal__head">
        <h2 id={heading} class="modal__title">
          {props.title}
        </h2>
        <button type="button" class="icon-button icon-button--framed" aria-label="Close" disabled={props.busy === true} onClick={(): void => props.onClose()}>
          <Icon name="close" />
        </button>
      </div>
      {props.children}
    </dialog>
  );
}

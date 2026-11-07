import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { asApiError, type ApiError } from "../api";
import { cleanLine, sentenceEnd } from "../text";
import { Icon } from "./Icon";
import { InlineError } from "./Notice";

// Buttons that do something. Every action button shows a busy label while it
// runs, and a refusal shows beside it in the server's words, ended with a full
// stop (role="alert"), never at the top of the page. The action itself puts the fresh view on screen
// and calls notify() with the answer's notice.

export type ButtonKind = "primary" | "secondary" | "danger" | "quiet";

export function ActionButton(props: {
  label: string;
  // "Approving…"
  busyLabel: string;
  onAction: () => Promise<void>;
  kind?: ButtonKind;
  disabled?: boolean;
  // Why it is off, shown beside it in grey.
  reason?: string | null;
  // Told of every refusal. It returns true when the form shows the refusal
  // itself (field errors, say), so it is not said again beside the button.
  onError?: (error: ApiError) => boolean | void;
  icon?: ComponentChildren;
}): JSX.Element {
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef<boolean>(true);
  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  async function run(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onAction();
    } catch (caught: unknown) {
      const refusal: ApiError = asApiError(caught);
      const shown: boolean = props.onError?.(refusal) === true;
      if (mounted.current && !shown) {
        setError(sentenceEnd(refusal.message));
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
    }
  }

  const off: boolean = props.disabled === true || busy;
  return (
    <span class="action">
      <button type="button" class={`btn btn--${props.kind ?? "secondary"}`} disabled={off} aria-busy={busy} onClick={(): void => void run()}>
        {props.icon}
        {busy ? props.busyLabel : props.label}
      </button>
      {props.disabled === true && props.reason !== null && props.reason !== undefined ? <span class="action__reason">{props.reason}</span> : null}
      <InlineError message={error} />
    </span>
  );
}

// A link that looks like a button: a row's "Review and approve", "New payment".
export function LinkButton(props: { href: string; kind?: ButtonKind; children: ComponentChildren; class?: string }): JSX.Element {
  return (
    <a class={`btn btn--${props.kind ?? "secondary"}${props.class === undefined ? "" : ` ${props.class}`}`} href={props.href}>
      {props.children}
    </a>
  );
}

function CopyButton(props: { value: string; label: string }): JSX.Element {
  const [said, setSaid] = useState<string | null>(null);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.value);
      setSaid("Copied");
    } catch {
      setSaid("Couldn't copy. Select the text instead.");
    }
    window.setTimeout((): void => setSaid(null), 2_000);
  }
  return (
    <>
      <button type="button" class="icon-button" aria-label={`Copy ${props.label}`} title={`Copy ${props.label}`} onClick={(): void => void copy()}>
        <Icon name="copy" />
      </button>
      {said === null ? null : (
        <span class="copy-said" role="status">
          {said}
        </span>
      )}
    </>
  );
}

export interface DetailRow {
  label: string;
  value: string | null;
  // Raw ids get a copy button.
  copy?: boolean;
}

// Raw identifiers (transfer ids, request ids, hashes, Message-IDs) never make
// headline text: they live in this disclosure, in mono, with a copy button.
export function Details(props: { rows: DetailRow[]; summary?: string }): JSX.Element {
  return (
    <details class="details">
      <summary>{props.summary ?? "Details"}</summary>
      <dl class="details__list">
        {props.rows
          .filter((row: DetailRow): boolean => row.value !== null && row.value !== "")
          .map(
            (row: DetailRow): JSX.Element => (
              <div class="details__row" key={row.label}>
                <dt>{row.label}</dt>
                <dd>
                  <span class="mono">{cleanLine(row.value)}</span>
                  {row.copy === true && row.value !== null ? <CopyButton value={row.value} label={row.label.toLowerCase()} /> : null}
                </dd>
              </div>
            ),
          )}
      </dl>
    </details>
  );
}

import type { ComponentChildren, JSX } from "preact";
import { Ref, Theirs } from "../../components/Text";
import { paymentHref } from "../../router";
import { cleanLine } from "../../text";
import type { Acted, IncidentView, Money as MoneyView, SummaryBullet } from "../../types";

// What every part of the payment page needs to act on the payment.
export interface Acts {
  invoiceId: string;
  // /api/incidents/<id>, encoded.
  path: string;
  // Puts the view an action answered with on screen and shows its notice.
  done: (acted: Acted<IncidentView>) => void;
  // Reads the payment again now: after a refusal, so the panel shows what changed.
  refresh: () => void;
  // Opens the Messages tab on one draft, as Draft trace request does.
  openDraft: (draftId: number) => void;
}

// "original failed for a reason…" as the start of a line.
export function sentence(text: string): string {
  const clean: string = cleanLine(text);
  return clean === "" ? clean : `${clean.charAt(0).toUpperCase()}${clean.slice(1)}`;
}

// The method as the header writes it.
export function methodText(method: "LOCAL" | "SWIFT"): string {
  return method === "SWIFT" ? "SWIFT" : "Local transfer";
}

// Parts joined by a grey middle dot, leaving out the empty ones.
export function Dotted(props: { parts: ComponentChildren[]; class?: string }): JSX.Element {
  const parts: ComponentChildren[] = props.parts.filter(
    (part: ComponentChildren): boolean => part !== null && part !== undefined && part !== false && part !== "",
  );
  return (
    <span class={props.class}>
      {parts.map(
        (part: ComponentChildren, index: number): JSX.Element => (
          <span key={index}>
            {index === 0 ? null : (
              <span class="sep" aria-hidden="true">
                {" · "}
              </span>
            )}
            {part}
          </span>
        ),
      )}
    </span>
  );
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A sentence from the view with its invoice numbers as links and its bank
// references in mono. The sentence is the server's; only the refs are marked.
export function WithRefs(props: { text: string; refs: SummaryBullet["refs"]; self: string }): JSX.Element {
  const text: string = cleanLine(props.text);
  const marks: string[] = props.refs
    .map((ref: SummaryBullet["refs"][number]): string => ref.invoiceId ?? ref.reference ?? "")
    .filter((mark: string): boolean => mark !== "" && text.includes(mark));
  if (marks.length === 0) {
    return <>{text}</>;
  }
  const invoices: Set<string> = new Set<string>(
    props.refs.map((ref: SummaryBullet["refs"][number]): string => ref.invoiceId ?? "").filter((id: string): boolean => id !== ""),
  );
  const pattern: RegExp = new RegExp(`(${[...new Set<string>(marks)].sort((a, b) => b.length - a.length).map(escaped).join("|")})`);
  return (
    <>
      {text.split(pattern).map((piece: string, index: number): ComponentChildren => {
        if (index % 2 === 0) {
          return piece;
        }
        return invoices.has(piece) && piece !== props.self ? (
          <a key={index} class="ref" href={paymentHref(piece)}>
            {piece}
          </a>
        ) : (
          <Ref key={index}>{piece}</Ref>
        );
      })}
    </>
  );
}

// "Example Supplier LLC, Bank of America, NA, account ending 4321": the label
// already starts with the supplier's name, so it is not said twice.
export function PayTo(props: { supplier: string; label: string }): JSX.Element {
  const supplier: string = cleanLine(props.supplier);
  const label: string = cleanLine(props.label);
  return supplier === "" || label.startsWith(supplier) ? (
    <Theirs text={label} />
  ) : (
    <>
      <Theirs text={supplier} />
      {", "}
      <Theirs text={label} />
    </>
  );
}

export function sameMoney(a: MoneyView | null, b: MoneyView | null): boolean {
  return a !== null && b !== null && a.minor === b.minor && a.currency === b.currency;
}

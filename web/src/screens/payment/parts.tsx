import type { JSX } from "preact";
import { Theirs } from "../../components/Text";
import { cleanLine } from "../../text";
import type { Acted, IncidentView, Money as MoneyView } from "../../types";

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

// The method as the header writes it.
export function methodText(method: "LOCAL" | "SWIFT"): string {
  return method === "SWIFT" ? "SWIFT" : "Local transfer";
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

import type { JSX } from "preact";
import { paymentHref } from "../../router";

// The invoice links the supplier screens share.

export function InvoiceLink(props: { id: string; tab?: string }): JSX.Element {
  return (
    <a class="ref" href={paymentHref(props.id, props.tab ?? null)}>
      {props.id}
    </a>
  );
}

// Invoice links with commas between them.
export function InvoiceLinks(props: { ids: readonly string[] }): JSX.Element {
  return (
    <>
      {props.ids.map(
        (id: string, index: number): JSX.Element => (
          <span key={`${index}-${id}`}>
            {index === 0 ? null : ", "}
            <InvoiceLink id={id} />
          </span>
        ),
      )}
    </>
  );
}

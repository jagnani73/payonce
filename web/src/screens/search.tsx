import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { query } from "../api";
import { LinkButton } from "../components/Action";
import { Field, type ControlProps } from "../components/Form";
import { Card } from "../components/Layout";
import { LoadError, Loading } from "../components/States";
import { Money, Theirs } from "../components/Text";
import { Tag, ToneBadge } from "../components/Tone";
import { useTitle } from "../hooks";
import { usePoll, type Polled } from "../poll";
import { navigate, paymentHref, runHref, supplierHref, type ScreenProps } from "../router";
import type { SearchView } from "../types";
import "./search.css";

// Search results (ia.md section 12), from GET /api/search?q=. The top bar's
// search box sends the person here on Enter. Each result opens its own page.
// The answer is read again every 30 s, so a payment's state stays current.

const REFRESH_MS: number = 30_000;
const MAX_QUERY: number = 100;

const TRANSFER_KINDS: Record<string, string> = {
  original: "Original",
  replacement: "Replacement",
  unrecognised: "Unrecognised transfer",
  "outside-payout": "Payout sent outside PayOnce",
};

// What the exact match is, when the results show it. The server tries the
// invoice number first.
function exactKind(view: SearchView): string {
  if (view.payments.some((payment: SearchView["payments"][number]): boolean => payment.invoiceId === view.q)) {
    return "is a payment's invoice number.";
  }
  if (view.transfers.some((transfer: SearchView["transfers"][number]): boolean => transfer.reference === view.q)) {
    return "is a transfer's bank reference.";
  }
  return "is an invoice number or a bank reference.";
}

function Hit(props:{ href: string; children: ComponentChildren }): JSX.Element {
  return (
    <li>
      <a class="hit" href={props.href}>
        {props.children}
      </a>
    </li>
  );
}

function Group(props: { title: string; found: number; limit: number; children: ComponentChildren }): JSX.Element | null {
  if (props.found === 0) {
    return null;
  }
  return (
    <Card
      title={props.title}
      sub={
        <>
          <span class="count-pill">{props.found}</span>
          {props.found < props.limit ? null : <span>{`Showing the first ${props.limit}. Type more to narrow it.`}</span>}
        </>
      }
      flush
    >
      <ul class="hits">{props.children}</ul>
    </Card>
  );
}

function Results(props: { view: SearchView }): JSX.Element {
  const view: SearchView = props.view;
  const total: number = view.payments.length + view.suppliers.length + view.runs.length + view.emails.length + view.transfers.length;
  if (total === 0 && view.exact === null) {
    return (
      <div class="empty">
        <p class="empty__title">
          {"Nothing matches "}
          <Theirs text={view.q} quote />
          {"."}
        </p>
        <p class="muted">Search by invoice number, supplier name, bank reference (P2611…), pay run number or Airwallex record id.</p>
      </div>
    );
  }
  return (
    <>
      {view.exact === null ? null : (
        <div class="sresults__exact">
          <span>
            <Theirs text={view.q} quote />
            {` ${exactKind(view)}`}
          </span>
          <LinkButton href={view.exact.href} kind="primary">
            Open the payment
          </LinkButton>
        </div>
      )}
      <Group title="Payments" found={view.payments.length} limit={view.limit}>
        {view.payments.map(
          (payment: SearchView["payments"][number]): JSX.Element => (
            <Hit href={paymentHref(payment.invoiceId)} key={payment.invoiceId}>
              <span class="hit__state">
                <ToneBadge tone={payment.tone} label={payment.label} />
              </span>
              <span class="hit__main">
                <span class="ref hit__lead">{payment.invoiceId}</span>
                <Theirs text={payment.supplier} class="hit__rest" />
              </span>
              <Money money={payment.amount} class="hit__money" />
            </Hit>
          ),
        )}
      </Group>
      <Group title="Suppliers" found={view.suppliers.length} limit={view.limit}>
        {view.suppliers.map(
          (supplier: SearchView["suppliers"][number]): JSX.Element => (
            <Hit href={supplierHref(supplier.key)} key={supplier.key}>
              <span class="hit__main">
                <Theirs text={supplier.name} class="hit__lead" />
                <span class="hit__rest">{supplier.hint}</span>
              </span>
            </Hit>
          ),
        )}
      </Group>
      <Group title="Pay runs" found={view.runs.length} limit={view.limit}>
        {view.runs.map(
          (run: SearchView["runs"][number]): JSX.Element => (
            <Hit href={runHref(run.id)} key={run.id}>
              <span class="hit__main">
                <span class="hit__lead">{`Pay run ${run.id}`}</span>
                <Theirs text={run.fileName} class="hit__rest" />
              </span>
              <span class="hit__aside">
                <Tag>{run.label}</Tag>
              </span>
            </Hit>
          ),
        )}
      </Group>
      <Group title="Emails" found={view.emails.length} limit={view.limit}>
        {view.emails.map(
          (email: SearchView["emails"][number]): JSX.Element => (
            <Hit href={`#inbox/${email.id}`} key={email.id}>
              <span class="hit__main">
                {email.subject.trim() === "" ? <span class="hit__lead">No subject</span> : <Theirs text={email.subject} class="hit__lead" />}
                <Theirs text={email.from} class="hit__rest" />
              </span>
              <span class="hit__aside">
                <Tag>{email.label}</Tag>
              </span>
            </Hit>
          ),
        )}
      </Group>
      <Group title="Transfers" found={view.transfers.length} limit={view.limit}>
        {view.transfers.map(
          (transfer: SearchView["transfers"][number], index: number): JSX.Element => (
            <Hit href={paymentHref(transfer.invoiceId)} key={`${transfer.reference}-${index}`}>
              <span class="hit__main">
                <span class="ref hit__lead">{transfer.reference}</span>
                <span class="hit__rest">
                  {`${TRANSFER_KINDS[transfer.kind] ?? "Transfer"} for `}
                  <span class="ref">{transfer.invoiceId}</span>
                </span>
              </span>
            </Hit>
          ),
        )}
      </Group>
    </>
  );
}

export function SearchResults(props: ScreenProps): JSX.Element {
  useTitle("Search results");
  const q: string = (props.route.params.get("q") ?? "").trim().slice(0, MAX_QUERY);
  const found: Polled<SearchView> = usePoll<SearchView>(q === "" ? null : query("/api/search", { q }), (): number => REFRESH_MS);

  // The field starts from the route and follows it (Back, the top bar's box).
  const [draft, setDraft] = useState<string>(q);
  useEffect((): void => setDraft(q), [q]);

  function submit(event: Event): void {
    event.preventDefault();
    const wanted: string = draft.trim().slice(0, MAX_QUERY);
    if (wanted !== "" && wanted !== q) {
      navigate(query("#search", { q: wanted }));
    }
  }

  return (
    <div class="screen sresults">
      <header class="screen__head">
        <h1 class="screen__title">Search results</h1>
      </header>
      <form class="sresults__form" onSubmit={submit}>
        <Field label="Search for" class="sresults__field">
          {(control: ControlProps): JSX.Element => (
            <input
              {...control}
              class="input"
              type="search"
              placeholder="Invoice, supplier, reference, pay run or email"
              autocomplete="off"
              spellcheck={false}
              maxLength={MAX_QUERY}
              value={draft}
              onInput={(event: Event): void => setDraft((event.currentTarget as HTMLInputElement).value)}
            />
          )}
        </Field>
        <button type="submit" class="btn btn--secondary">
          Search
        </button>
      </form>
      {q === "" ? (
        <div class="empty">
          <p class="empty__title">Search for a payment, a supplier, a pay run or an email.</p>
          <p class="muted">Search by invoice number, supplier name, bank reference (P2611…), pay run number or Airwallex record id.</p>
        </div>
      ) : (
        <>
          <LoadError what="the search results" error={found.error} />
          {found.data === null ? (
            found.error === null ? (
              <Loading rows={3} label="Searching" />
            ) : null
          ) : (
            <Results view={found.data} />
          )}
        </>
      )}
    </div>
  );
}

import type { JSX } from "preact";
import { query } from "../../api";
import { Details, LinkButton } from "../../components/Action";
import { Icon } from "../../components/Icon";
import { Card } from "../../components/Layout";
import { Empty, LoadError, Loading } from "../../components/States";
import { Theirs, Time } from "../../components/Text";
import { useTitle } from "../../hooks";
import { notify } from "../../notices";
import { FAST_MS, SLOW_MS, usePoll, type Polled } from "../../poll";
import { supplierHref, type Route } from "../../router";
import { cleanLine } from "../../text";
import type { Acted, IncidentRow, SupplierAccountView, SupplierCaution, SupplierListRow, SuppliersView, SupplierView } from "../../types";
import { ContactCard } from "./contact";
import { Dotted, InvoiceLinks, sentence } from "./parts";
import { Accounts, Callbacks, InboxEmails, Messages, Outages, Payments, Related, RunRows, SecondBills, type Others } from "./sections";
import { accountsText, endingText, phoneText, recordFacts } from "./words";

// One supplier record (ia.md section 7), from GET /api/suppliers/:key, polled
// every 5 s, and every 1.5 s while PayOnce works on one of its payments. The
// header, the cautions, the contact on file, the accounts, then each compact
// section that has something to show.

const LIST_MS: number = 30_000;

function pace(view: SupplierView | null): number {
  return view !== null && view.payments.open.some((row: IncidentRow): boolean => row.activity.busy) ? FAST_MS : SLOW_MS;
}

function SameName(props: { view: SupplierView; others: Others }): JSX.Element | null {
  const same: SupplierView["related"] = props.view.related.filter((item: SupplierView["related"][number]): boolean => item.why.includes("same-name"));
  if (same.length === 0) {
    return null;
  }
  return (
    <p class="sup-header__same">
      {`${same.length + 1} records share this name. ${same.length === 1 ? "The other is" : "The others are"} `}
      {same.map((item: SupplierView["related"][number], index: number): JSX.Element => {
        const row: SupplierListRow | undefined = props.others.get(item.key);
        return (
          <span key={item.key}>
            {index === 0 ? null : index === same.length - 1 ? " and " : ", "}
            <a href={supplierHref(item.key)}>{row === undefined ? `record ${item.key.slice(0, 8)}` : recordFacts(row)}</a>
          </span>
        );
      })}
      .
    </p>
  );
}

function Header(props: { view: SupplierView; others: Others }): JSX.Element {
  const view: SupplierView = props.view;
  const onFile: SupplierAccountView | undefined = view.accounts.find((account: SupplierAccountView): boolean => account.onFile);
  return (
    <header class="card sup-header">
      <div class="sup-header__main">
        <span class="sup-eyebrow">Supplier record</span>
        <h1 class="sup-header__name">
          <Theirs text={view.name === "" ? "No name on file" : view.name} />
        </h1>
        {view.otherNames.length === 0 ? null : (
          <p class="sup-header__also">
            {"Also on file as "}
            {view.otherNames.map(
              (name: string, index: number): JSX.Element => (
                <span key={`${index}-${name}`}>
                  {index === 0 ? null : ", "}
                  <Theirs text={name} />
                </span>
              ),
            )}
          </p>
        )}
        <p class="sup-header__facts">
          <Dotted
            parts={[
              view.hint,
              view.accounts.length === 0 ? null : endingText(onFile?.ending ?? null),
              phoneText(view.contact.phoneEnding),
            ]}
          />
        </p>
        <SameName view={view} others={props.others} />
        <Details summary="Record details" rows={[{ label: "Airwallex beneficiary id", value: view.key, copy: true }]} />
      </div>
      <div class="sup-header__action">
        {view.can.newPayment.allowed ? (
          <LinkButton href={query("#new-payment", { supplier: view.key })} kind="primary">
            <Icon name="plus" />
            New payment to this supplier
          </LinkButton>
        ) : (
          <span class="action">
            <button type="button" class="btn btn--primary" disabled>
              <Icon name="plus" />
              New payment to this supplier
            </button>
            {view.can.newPayment.why === null ? null : <span class="action__reason">{sentence(view.can.newPayment.why.text)}</span>}
          </span>
        )}
      </div>
    </header>
  );
}

function CautionItem(props: { caution: SupplierCaution }): JSX.Element {
  const caution: SupplierCaution = props.caution;
  const info: boolean = caution.level === "info";
  const parts: JSX.Element[] = [
    ...(caution.invoices.length === 0 ? [] : [<InvoiceLinks ids={caution.invoices} />]),
    ...(caution.accounts.length === 0 ? [] : [<>{accountsText(caution.accounts)}</>]),
  ];
  return (
    <li class={info ? "sup-caution sup-caution--info" : "sup-caution"}>
      <Icon name={info ? "circle" : "warning"} class="sup-caution__icon" />
      <div class="sup-caution__body">
        <span class="visually-hidden">{info ? "Note: " : "Caution: "}</span>
        <p>{caution.text}</p>
        {parts.length === 0 && caution.since === null ? null : (
          <p class="sup-caution__meta">
            <Dotted
              parts={[
                ...parts,
                caution.since === null ? null : (
                  <>
                    {parts.length === 0 ? "Since " : "since "}
                    <Time at={caution.since} />
                  </>
                ),
              ]}
            />
          </p>
        )}
      </div>
    </li>
  );
}

// Cautions first, then the notes, each kind in the server's order.
function Cautions(props: { cautions: SupplierCaution[] }): JSX.Element | null {
  if (props.cautions.length === 0) {
    return null;
  }
  const ordered: SupplierCaution[] = [
    ...props.cautions.filter((caution: SupplierCaution): boolean => caution.level === "caution"),
    ...props.cautions.filter((caution: SupplierCaution): boolean => caution.level !== "caution"),
  ];
  return (
    <Card title="Cautions">
      <ul class="sup-cautions">
        {ordered.map(
          (caution: SupplierCaution, index: number): JSX.Element => (
            <CautionItem key={`${caution.code}-${index}`} caution={caution} />
          ),
        )}
      </ul>
    </Card>
  );
}

function Record(props: { view: SupplierView; others: Others; onActed: (acted: Acted<SupplierView>) => void }): JSX.Element {
  const view: SupplierView = props.view;
  return (
    <>
      <Header view={view} others={props.others} />
      <Cautions cautions={view.cautions} />
      <div class="sup-pair">
        <ContactCard view={view} onActed={props.onActed} />
        <Accounts view={view} others={props.others} />
      </div>
      <div class="sup-grid">
        <Payments view={view} />
        <Callbacks view={view} />
        <SecondBills view={view} />
        <RunRows view={view} />
        <InboxEmails view={view} />
        <Messages view={view} />
        <Outages view={view} />
        <Related view={view} others={props.others} />
      </div>
    </>
  );
}

export function SupplierRecord(props: { route: Route }): JSX.Element {
  const key: string = props.route.segments[0] ?? "";
  const record: Polled<SupplierView> = usePoll<SupplierView>(`/api/suppliers/${encodeURIComponent(key)}`, pace);
  const view: SupplierView | null = record.data;
  useTitle(view === null ? "Supplier record" : cleanLine(view.name) || "Supplier record");
  // The other records' facts tell same-named ones apart; read only when this
  // record has any.
  const list: Polled<SuppliersView> = usePoll<SuppliersView>(
    view !== null && view.related.length > 0 ? "/api/suppliers" : null,
    (): number => LIST_MS,
  );
  const others: Others = new Map(
    (list.data?.rows ?? []).flatMap((row: SupplierListRow): [string, SupplierListRow][] => (row.key === null ? [] : [[row.key, row]])),
  );
  const missing: boolean = view === null && record.error !== null && record.error.status === 404;
  return (
    <div class="screen sup">
      <p class="sup-crumb">
        <a href="#suppliers">Suppliers</a>
        <span class="sep" aria-hidden="true">
          {" › "}
        </span>
        {view === null ? "Supplier record" : <Theirs text={view.name === "" ? "No name on file" : view.name} />}
      </p>
      {missing ? null : <LoadError what="this supplier record" error={record.error} />}
      {view === null ? (
        missing ? (
          <Empty title="PayOnce has no supplier record with this id.">
            <p class="muted">{record.error?.message}</p>
            <a href="#suppliers">All suppliers</a>
          </Empty>
        ) : record.error === null ? (
          <Card flush>
            <Loading rows={4} label="Loading the supplier record" />
          </Card>
        ) : null
      ) : (
        <Record
          view={view}
          others={others}
          onActed={(acted: Acted<SupplierView>): void => {
            record.replace(acted.view);
            notify(acted.notice);
          }}
        />
      )}
    </div>
  );
}

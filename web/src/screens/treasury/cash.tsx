import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { getJson } from "../../api";
import { ActionButton } from "../../components/Action";
import { Icon } from "../../components/Icon";
import { ClickRow } from "../../components/Layout";
import { Callout } from "../../components/Notice";
import { Empty, LoadError, Loading } from "../../components/States";
import { Figure, Money, Ref, Time } from "../../components/Text";
import { FAST_MS, SLOW_MS, usePoll, type Polled } from "../../poll";
import { paymentHref, runHref } from "../../router";
import type { CashView, CashWorksheetGroup, WalletCashView } from "../../types";

// Treasury › Cash (ia.md section 8.1): one row per wallet down to its headroom,
// and the worksheet of the wallet a person opens. GET /api/cash answers from the
// balance cache and reads Airwallex again once the cache is 30 s old.

type Line = CashWorksheetGroup["lines"][number];

const LINES_SHOWN: number = 5;
const WORKSHEET_ID: string = "cash-worksheet";

const BUCKET_WORDS: Record<CashWorksheetGroup["bucket"], string> = {
  promised: "Promised",
  "waiting-on-people": "Waiting on people",
  "with-bank": "With the bank",
  "fees-kept": "Fees kept on failed transfers",
};

// Nothing promised, waiting on people, with the bank or kept as a fee, and a
// floor PayOnce can read.
function idle(wallet: WalletCashView): boolean {
  return wallet.worksheet.length === 0 && wallet.invoiceFloors.length === 0 && wallet.tone === "ok" && wallet.floor.source !== "unreadable";
}

function Floor(props: { wallet: WalletCashView }): JSX.Element {
  const floor: WalletCashView["floor"] = props.wallet.floor;
  if (floor.source === "not-set") {
    return (
      <span class="cash-floor cash-floor--unset" title={floor.text}>
        Not set
      </span>
    );
  }
  if (floor.source === "unreadable") {
    return (
      <span class="cash-floor cash-floor--unreadable" title={floor.text}>
        Can't read
      </span>
    );
  }
  return <Figure money={floor.amount} />;
}

function ReadLine(props: { view: CashView }): JSX.Element {
  const balances: CashView["balances"] = props.view.balances;
  if (balances.refreshing) {
    return <span class="cash-bar__read">Reading balances…</span>;
  }
  if (balances.readAt === null) {
    return <span class="cash-bar__read">Balances not read yet</span>;
  }
  return (
    <span class="cash-bar__read">
      {"Balances read "}
      <Time at={balances.readAt} />
      {" ("}
      <Time at={balances.readAt} mode="ago" />
      {")"}
    </span>
  );
}

function Problems(props: { view: CashView }): JSX.Element | null {
  const problem: CashView["balances"]["problem"] = props.view.balances.problem;
  const readAt: string | null = props.view.balances.readAt;
  if (problem === null && props.view.floorsProblem === null) {
    return null;
  }
  return (
    <div class="stack-tight">
      {problem === null ? null : (
        <Callout tone="warning">
          {"Couldn't read balances from Airwallex (since "}
          <Time at={problem.since} />
          {")."}
          {readAt === null ? (
            " No balance has been read yet, so headroom can't be worked out."
          ) : (
            <>
              {" Showing the last good read from "}
              <Time at={readAt} />
              {"."}
            </>
          )}
        </Callout>
      )}
      {props.view.floorsProblem === null ? null : <Callout tone="danger">{props.view.floorsProblem}</Callout>}
    </div>
  );
}

function WalletRow(props: { wallet: WalletCashView; open: boolean; onToggle: () => void }): JSX.Element {
  const w: WalletCashView = props.wallet;
  return (
    <ClickRow class={props.open ? "cash-row is-open" : "cash-row"} onOpen={props.onToggle}>
      <th scope="row">
        <button type="button" class="cash-row__wallet" aria-expanded={props.open} aria-controls={WORKSHEET_ID} onClick={props.onToggle}>
          <Icon name="chevron-right" size={14} class={props.open ? "disclosure__chevron is-open" : "disclosure__chevron"} />
          {w.wallet}
        </button>
      </th>
      <td class="is-end is-numeric">
        <Figure money={w.available} empty="Not read" />
      </td>
      <td class="is-end is-numeric">
        <Floor wallet={w} />
      </td>
      <td class="is-end is-numeric">
        <Figure money={w.promised} />
      </td>
      <td class="is-end is-numeric">
        <Figure money={w.waitingOnPeople} />
      </td>
      <td class={w.tone === "below" ? "is-end is-numeric cash-headroom is-below" : "is-end is-numeric cash-headroom"}>
        <Figure money={w.headroom} />
      </td>
      <td class={w.tone === "low" ? "is-end is-numeric is-low" : "is-end is-numeric"}>
        <Figure money={w.headroomIfApproved} />
      </td>
    </ClickRow>
  );
}

function WalletTable(props: { wallets: WalletCashView[]; open: string | null; onToggle: (wallet: string) => void }): JSX.Element {
  const [showIdle, setShowIdle] = useState<boolean>(false);
  const busy: WalletCashView[] = props.wallets.filter((wallet: WalletCashView): boolean => !idle(wallet));
  // When every wallet is idle there is nothing to fold away.
  const quiet: WalletCashView[] = busy.length === 0 ? [] : props.wallets.filter(idle);
  const shown: WalletCashView[] = busy.length === 0 ? props.wallets : busy;
  const row = (wallet: WalletCashView): JSX.Element => (
    <WalletRow key={wallet.wallet} wallet={wallet} open={props.open === wallet.wallet} onToggle={(): void => props.onToggle(wallet.wallet)} />
  );
  return (
    <div class="cash-wallets">
      <div class="table-scroll cash-table" role="region" aria-label="Wallets" tabIndex={0}>
        <table class="table">
          <caption class="visually-hidden">Wallets, down to their headroom. Open a wallet to see its worksheet.</caption>
          <thead>
            <tr>
              <th scope="col">Wallet</th>
              <th scope="col" class="is-end">
                Available
              </th>
              <th scope="col" class="is-end">
                Reserve floor
              </th>
              <th scope="col" class="is-end">
                Promised
              </th>
              <th scope="col" class="is-end">
                Waiting on people
              </th>
              <th scope="col" class="is-end">
                Headroom
              </th>
              <th scope="col" class="is-end">
                Headroom if approved
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map(row)}
            {showIdle ? quiet.map(row) : null}
          </tbody>
        </table>
      </div>
      {quiet.length === 0 ? null : (
        <button type="button" class="cash-idle" aria-expanded={showIdle} onClick={(): void => setShowIdle(!showIdle)}>
          <Icon name="chevron-right" size={14} class={showIdle ? "disclosure__chevron is-open" : "disclosure__chevron"} />
          {`${quiet.map((wallet: WalletCashView): string => wallet.wallet).join(", ")}: nothing promised, waiting on people or with the bank`}
        </button>
      )}
    </div>
  );
}

function LineRow(props: { line: Line }): JSX.Element {
  const line: Line = props.line;
  return (
    <li class="sheet-line">
      <span class="sheet-line__what">
        <a class="ref" href={paymentHref(line.invoiceId)}>
          {line.invoiceId}
        </a>
        {line.runId === null ? null : (
          <a class="sheet-line__run" href={runHref(line.runId)}>
            {`pay run ${line.runId}`}
          </a>
        )}
        {line.reference === null ? null : <Ref class="sheet-line__ref">{line.reference}</Ref>}
        {line.fee === null ? (
          <span class="sheet-line__fee">fee not read yet</span>
        ) : line.fee.minor === 0 ? null : (
          <span class="sheet-line__fee">
            {"fee "}
            <Money money={line.fee} />
          </span>
        )}
      </span>
      <Money money={line.amount} class="sheet-line__amount" />
    </li>
  );
}

function Group(props: { group: CashWorksheetGroup }): JSX.Element {
  const [all, setAll] = useState<boolean>(false);
  const group: CashWorksheetGroup = props.group;
  const bucket: string = BUCKET_WORDS[group.bucket];
  const lines: Line[] = all ? group.lines : group.lines.slice(0, LINES_SHOWN);
  const more: number = group.lines.length - lines.length;
  return (
    <section class="sheet-group" aria-label={group.label}>
      <div class="sheet-group__head">
        <h3 class="sheet-group__title">{group.label}</h3>
        {bucket === group.label ? null : <span class="sheet-group__bucket">{bucket}</span>}
        {group.feeUnknown === 0 ? null : (
          <span class="sheet-group__bucket">{group.feeUnknown === 1 ? "1 fee not read yet" : `${group.feeUnknown} fees not read yet`}</span>
        )}
        <Money money={group.total} class="sheet-group__total" />
      </div>
      <ul class="sheet-lines">
        {lines.map(
          (line: Line, index: number): JSX.Element => (
            <LineRow key={`${line.invoiceId}-${line.reference ?? ""}-${index}`} line={line} />
          ),
        )}
      </ul>
      {more === 0 && !all ? null : (
        <button type="button" class="btn btn--quiet sheet-group__more" onClick={(): void => setAll(!all)}>
          {all ? "Show the first five" : `and ${more} more`}
        </button>
      )}
    </section>
  );
}

// "INV-671104 keeps its own floor of 9,979,789.97 EUR.", with the payment linked.
function InvoiceFloor(props: { floor: WalletCashView["invoiceFloors"][number] }): JSX.Element {
  const { invoiceId, text } = props.floor;
  return (
    <p class="sheet-note">
      {text.startsWith(invoiceId) ? (
        <>
          <a class="ref" href={paymentHref(invoiceId)}>
            {invoiceId}
          </a>
          {text.slice(invoiceId.length)}
        </>
      ) : (
        text
      )}
    </p>
  );
}

function Worksheet(props: { wallet: WalletCashView | null }): JSX.Element {
  const w: WalletCashView | null = props.wallet;
  return (
    <section class="card worksheet" id={WORKSHEET_ID}>
      <h2 class="card__title">{w === null ? "Pick a wallet to see its worksheet" : `${w.wallet} worksheet`}</h2>
      {w === null ? null : (
        <>
          {w.floor.source === "setting" ? null : <Callout tone={w.floor.source === "unreadable" ? "danger" : "warning"}>{w.floor.text}</Callout>}
          {w.worksheet.length === 0 ? (
            <p class="muted">Nothing promised, waiting on people or with the bank in this wallet.</p>
          ) : (
            w.worksheet.map((group: CashWorksheetGroup): JSX.Element => <Group key={group.kind} group={group} />)
          )}
          {w.invoiceFloors.map(
            (floor: WalletCashView["invoiceFloors"][number]): JSX.Element => (
              <InvoiceFloor key={floor.invoiceId} floor={floor} />
            ),
          )}
        </>
      )}
    </section>
  );
}

function firstOpen(view: CashView): string | null {
  return (view.wallets.find((wallet: WalletCashView): boolean => !idle(wallet)) ?? view.wallets[0])?.wallet ?? null;
}

function Cash(props: { view: CashView; polled: Polled<CashView> }): JSX.Element {
  const view: CashView = props.view;
  // undefined: nobody has picked yet, so the first busy wallet is open.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const open: string | null = picked === undefined ? firstOpen(view) : picked;
  const wallet: WalletCashView | null = view.wallets.find((item: WalletCashView): boolean => item.wallet === open) ?? null;
  return (
    <>
      <div class="cash-bar">
        <ReadLine view={view} />
        <ActionButton
          label="Refresh"
          busyLabel="Reading balances…"
          icon={<Icon name="refresh" />}
          onAction={async (): Promise<void> => {
            props.polled.replace(await getJson<CashView>("/api/cash"));
          }}
        />
        {view.checksLastRanAt === null ? null : (
          <span class="cash-bar__checks">
            {"Payment checks last ran "}
            <Time at={view.checksLastRanAt} />
          </span>
        )}
      </div>
      <Problems view={view} />
      {view.wallets.length === 0 ? (
        <Empty title="No wallets to show yet." />
      ) : (
        <>
          <WalletTable wallets={view.wallets} open={open} onToggle={(name: string): void => setPicked(open === name ? null : name)} />
          <Worksheet wallet={wallet} />
        </>
      )}
    </>
  );
}

export function CashTab(): JSX.Element {
  const cash: Polled<CashView> = usePoll<CashView>("/api/cash", (view: CashView | null): number =>
    view?.balances.refreshing === true ? FAST_MS : SLOW_MS,
  );
  return (
    <div class="tab-panel" role="region" aria-label="Cash">
      <LoadError what="cash" error={cash.error} />
      {cash.data === null ? (
        cash.error === null ? <Loading rows={3} label="Loading cash" /> : null
      ) : (
        <Cash view={cash.data} polled={cash} />
      )}
    </div>
  );
}

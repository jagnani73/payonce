import type { JSX } from "preact";
import { Tabs, type TabItem } from "../components/Layout";
import { useTitle } from "../hooks";
import { SLOW_MS, usePoll, type Polled } from "../poll";
import type { Route, ScreenProps } from "../router";
import type { OutagesView } from "../types";
import { CashTab } from "./treasury/cash";
import { OutagesTab } from "./treasury/outages";
import { ReconTab } from "./treasury/recon";
import "./treasury.css";

// Treasury (ia.md section 8): Cash, Reconciliation and Outages, one route each.
// #treasury opens Cash, #recon opens Reconciliation, #outage/N opens Outages at
// outage N. The outages are read here, so the tab can count the active ones.

type TabKey = "cash" | "reconciliation" | "outages";

const TABS: readonly { key: TabKey; label: string }[] = [
  { key: "cash", label: "Cash" },
  { key: "reconciliation", label: "Reconciliation" },
  { key: "outages", label: "Outages" },
];

function tabOf(route: Route): TabKey {
  if (route.word === "outage") {
    return "outages";
  }
  const named: string = route.segments[0] ?? "";
  return TABS.find((tab: { key: TabKey }): boolean => tab.key === named)?.key ?? "cash";
}

// The outage #outage/N names, or null.
function focusOf(route: Route): number | null {
  const id: number = Number(route.segments[0] ?? "");
  return route.word === "outage" && Number.isInteger(id) && id > 0 ? id : null;
}

const TITLES: Record<TabKey, string> = { cash: "Cash", reconciliation: "Reconciliation", outages: "Outages" };

export function Treasury(props: ScreenProps): JSX.Element {
  const tab: TabKey = tabOf(props.route);
  useTitle(`${TITLES[tab]} · Treasury`);
  const outages: Polled<OutagesView> = usePoll<OutagesView>("/api/outages", (): number => SLOW_MS);
  const active: number = outages.data?.active.length ?? 0;
  const tabs: TabItem[] = TABS.map((item: { key: TabKey; label: string }) => ({
    key: item.key,
    label: item.label,
    href: `#treasury/${item.key}`,
    count: item.key === "outages" && active > 0 ? active : null,
  }));
  return (
    <div class="screen treasury">
      <header class="screen__head">
        <h1 class="screen__title">Treasury</h1>
      </header>
      <div class={active > 0 ? "treasury__tabs has-outage" : "treasury__tabs"}>
        <Tabs label="Treasury" tabs={tabs} current={tab} />
      </div>
      {tab === "cash" ? <CashTab /> : tab === "reconciliation" ? <ReconTab /> : <OutagesTab polled={outages} focus={focusOf(props.route)} />}
    </div>
  );
}

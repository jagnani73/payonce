import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Icon } from "../components/Icon";
import { useMedia, WIDE } from "../hooks";
import type { Polled } from "../poll";
import type { Route, Screen } from "../router";
import type { StatusView } from "../types";
import { MePicker } from "./MePicker";
import { Search } from "./Search";
import { StatusChip } from "./StatusChip";

// The top bar (ia.md section 0 and the TopBar mockup). From 900 px: two tiers,
// the wordmark, search and the right cluster above the navigation. Narrower: the
// wordmark, the status chip and a menu button, whose sheet stacks search, the
// navigation, New payment, You are and the simulator.

interface NavItem {
  key: string;
  label: string;
  href: string;
  badge: number;
  // Read after the badge's number by a screen reader.
  badgeText: string;
}

// The navigation item a screen sits under, if any.
const SECTION: Partial<Record<Screen, string>> = {
  home: "home",
  incidents: "incidents",
  payment: "incidents",
  inbox: "inbox",
  runs: "runs",
  suppliers: "suppliers",
  treasury: "treasury",
  reports: "reports",
  settings: "settings",
};

function navItems(status: StatusView | null): NavItem[] {
  const waiting: number = status?.inbox.waiting ?? 0;
  const runs: number = status?.runs.needsApproval ?? 0;
  return [
    { key: "home", label: "Home", href: "#home", badge: 0, badgeText: "" },
    { key: "incidents", label: "Incidents", href: "#incidents", badge: 0, badgeText: "" },
    { key: "inbox", label: "Inbox", href: "#inbox", badge: waiting, badgeText: waiting === 1 ? " email waiting" : " emails waiting" },
    { key: "runs", label: "Pay runs", href: "#runs", badge: runs, badgeText: runs === 1 ? " run needs approval" : " runs need approval" },
    { key: "suppliers", label: "Suppliers", href: "#suppliers", badge: 0, badgeText: "" },
    { key: "treasury", label: "Treasury", href: "#treasury", badge: 0, badgeText: "" },
    { key: "reports", label: "Reports", href: "#reports", badge: 0, badgeText: "" },
    { key: "settings", label: "Settings", href: "#settings", badge: 0, badgeText: "" },
  ];
}

function Nav(props: { route: Route; status: StatusView | null; sheet?: boolean }): JSX.Element {
  const current: string | undefined = SECTION[props.route.screen];
  return (
    <nav class={props.sheet === true ? "nav nav--sheet" : "nav"} aria-label="Main">
      {navItems(props.status).map(
        (item: NavItem): JSX.Element => (
          <a key={item.key} class="nav__item" href={item.href} aria-current={item.key === current ? "page" : undefined}>
            <span>{item.label}</span>
            {item.badge > 0 ? (
              <span class="nav__badge">
                {item.badge}
                <span class="visually-hidden">{item.badgeText}</span>
              </span>
            ) : null}
          </a>
        ),
      )}
    </nav>
  );
}

function Brand(): JSX.Element {
  return (
    <div class="brand">
      <a class="brand__mark" href="#home">
        <Icon name="brand" size={22} class="brand__icon" />
        PayOnce
      </a>
      <span class="pill pill--sandbox" title="Airwallex sandbox only. No real money moves.">
        Sandbox
      </span>
    </div>
  );
}

export function TopBar(props: { route: Route; status: Polled<StatusView> }): JSX.Element {
  const wide: boolean = useMedia(WIDE);
  const [menu, setMenu] = useState<boolean>(false);
  // Going anywhere closes the sheet.
  useEffect((): void => setMenu(false), [props.route.hash, wide]);

  if (wide) {
    return (
      <header class="topbar">
        <div class="topbar__row">
          <Brand />
          <Search />
          <div class="topbar__cluster">
            <StatusChip status={props.status} />
            <a class="btn btn--primary" href="#new-payment">
              <Icon name="plus" />
              New payment
            </a>
            <MePicker />
            <a class="btn btn--outline" href="#sandbox" title="Sandbox simulator">
              <Icon name="flask" />
              Simulator
            </a>
          </div>
        </div>
        <Nav route={props.route} status={props.status.data} />
      </header>
    );
  }
  return (
    <header class="topbar topbar--phone">
      <div class="topbar__row">
        <Brand />
        <StatusChip status={props.status} compact />
        <button
          type="button"
          class="icon-button icon-button--framed"
          aria-label="Menu"
          aria-expanded={menu}
          aria-controls="phone-menu"
          onClick={(): void => setMenu(!menu)}
        >
          <Icon name={menu ? "close" : "menu"} size={20} />
        </button>
      </div>
      {menu ? (
        <div class="sheet" id="phone-menu">
          <Search onGo={(): void => setMenu(false)} />
          <Nav route={props.route} status={props.status.data} sheet />
          <a class="btn btn--primary btn--block" href="#new-payment">
            New payment
          </a>
          <MePicker inline />
          <a class="btn btn--outline btn--block" href="#sandbox">
            <Icon name="flask" />
            Sandbox simulator
          </a>
        </div>
      ) : null}
    </header>
  );
}

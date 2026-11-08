import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { Toasts } from "./components/Notice";
import { onActed } from "./notices";
import { usePoll, type Polled } from "./poll";
import { useRoute, type Route, type Screen, type ScreenProps } from "./router";
import { Home } from "./screens/home";
import { Inbox } from "./screens/inbox";
import { Incidents } from "./screens/incidents";
import { NewPayment } from "./screens/new-payment";
import { Payment } from "./screens/payment";
import { Reports } from "./screens/reports";
import { Runs } from "./screens/runs";
import { SearchResults } from "./screens/search";
import { Settings } from "./screens/settings";
import { Simulator } from "./screens/simulator";
import { Suppliers } from "./screens/suppliers";
import { Treasury } from "./screens/treasury";
import { Banners } from "./shell/Banners";
import { TopBar } from "./shell/TopBar";
import type { StatusView } from "./types";

// The shell: the top bar, the banners, the screen the hash names and the toasts.
// #sandbox opens the simulator drawer over whichever screen was on show.

const STATUS_MS: number = 10_000;

const SCREENS: Record<Exclude<Screen, "sandbox">, (props: ScreenProps) => JSX.Element> = {
  home: Home,
  incidents: Incidents,
  payment: Payment,
  "new-payment": NewPayment,
  inbox: Inbox,
  runs: Runs,
  suppliers: Suppliers,
  treasury: Treasury,
  reports: Reports,
  settings: Settings,
  search: SearchResults,
};

const HOME: Route = { screen: "home", word: "home", segments: [], params: new URLSearchParams(), hash: "#home" };

// A screen keeps its state while only its tab or query changes, and starts
// afresh for another object: #incident/A to #incident/B remounts it.
function screenKey(route: Route): string {
  return `${route.word}/${route.segments[0] ?? ""}`;
}

export function App(): JSX.Element {
  const route: Route = useRoute();
  const status: Polled<StatusView> = usePoll<StatusView>("/api/status", (): number => STATUS_MS);
  // An action can change what the top bar counts, such as the inbox badge.
  useEffect((): (() => void) => onActed((): void => status.refresh()), [status.refresh]);
  const under = useRef<Route>(HOME);
  if (route.screen !== "sandbox") {
    under.current = route;
  }
  const page: Route = under.current;
  const Screen: (props: ScreenProps) => JSX.Element = SCREENS[page.screen === "sandbox" ? "home" : page.screen];

  // Another screen starts at the top, with focus on it for a screen reader. A
  // layout effect runs before any screen's effects, so a screen that scrolls to
  // what its route names (#outage/3, #settings/alerts) has the last word.
  const shown = useRef<string | null>(null);
  const key: string = screenKey(page);
  useLayoutEffect((): void => {
    if (shown.current !== null && shown.current !== key) {
      window.scrollTo(0, 0);
      document.getElementById("content")?.focus({ preventScroll: true });
    }
    shown.current = key;
  }, [key]);

  return (
    <>
      <button type="button" class="skip-link" onClick={(): void => document.getElementById("content")?.focus()}>
        Skip to content
      </button>
      <TopBar route={page} status={status} />
      <Banners status={status.data} />
      <main class="main" id="content" tabIndex={-1}>
        <Screen key={key} route={page} />
      </main>
      {route.screen === "sandbox" ? <Simulator under={page} /> : null}
      <Toasts />
    </>
  );
}

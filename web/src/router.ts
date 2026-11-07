import { useEffect, useState } from "preact/hooks";

// Hash routes (ia.md section 0.4). The first path segment, read undecoded, names
// the screen when it is a reserved word. Any other hash is a payment: "#INV-671104"
// opens #incident/INV-671104, as the links alerts already posted do. The page
// itself always links to a payment as #incident/<encodeURIComponent(id)>, so a
// payment called "recon" is #incident/recon, and the old "#%72econ" still opens it.

export type Screen =
  | "home"
  | "incidents"
  | "payment"
  | "new-payment"
  | "inbox"
  | "runs"
  | "suppliers"
  | "treasury"
  | "reports"
  | "settings"
  | "search"
  | "sandbox";

export interface Route {
  screen: Screen;
  // The reserved word the hash started with: "run" and "runs" are both the runs
  // screen, "supplier" and "suppliers" the suppliers screen, "outage" Treasury.
  word: string;
  // The segments after the word, decoded: #incident/INV-1/timeline is ["INV-1", "timeline"].
  segments: string[];
  params: URLSearchParams;
  // The hash as it is now, with its "#".
  hash: string;
}

// What the shell hands every screen.
export interface ScreenProps {
  route: Route;
}

const SCREENS: Record<string, Screen> = {
  home: "home",
  incidents: "incidents",
  incident: "payment",
  "new-payment": "new-payment",
  inbox: "inbox",
  runs: "runs",
  run: "runs",
  suppliers: "suppliers",
  supplier: "suppliers",
  treasury: "treasury",
  outage: "treasury",
  reports: "reports",
  settings: "settings",
  sandbox: "sandbox",
  search: "search",
};

// Old or short routes, and where they go now.
const REDIRECTS: Record<string, string> = {
  board: "#incidents",
  recon: "#treasury/reconciliation",
  metrics: "#reports",
};

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// The route for a hash, or a redirect to replace it with.
export function parse(hash: string): Route | { redirect: string } {
  const raw: string = hash.startsWith("#") ? hash.slice(1) : hash;
  const mark: number = raw.indexOf("?");
  const path: string = mark === -1 ? raw : raw.slice(0, mark);
  const params: URLSearchParams = new URLSearchParams(mark === -1 ? "" : raw.slice(mark + 1));
  const parts: string[] = path.split("/");
  const word: string = parts[0] ?? "";
  if (word === "") {
    return { screen: "home", word: "home", segments: [], params, hash: "#home" };
  }
  const redirect: string | undefined = REDIRECTS[word];
  if (redirect !== undefined) {
    return { redirect };
  }
  if (word === "treasury" && (parts[1] ?? "") === "") {
    return { redirect: "#treasury/cash" };
  }
  const screen: Screen | undefined = Object.hasOwn(SCREENS, word) ? SCREENS[word] : undefined;
  if (screen === undefined) {
    return { redirect: paymentHref(decoded(path)) };
  }
  return {
    screen,
    word,
    segments: parts.slice(1).filter((part: string): boolean => part !== "").map(decoded),
    params,
    hash: `#${raw}`,
  };
}

export function paymentHref(invoiceId: string, tab: string | null = null): string {
  return `#incident/${encodeURIComponent(invoiceId)}${tab === null ? "" : `/${tab}`}`;
}

export function runHref(runId: number): string {
  return `#run/${runId}`;
}

export function supplierHref(key: string): string {
  return `#supplier/${encodeURIComponent(key)}`;
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}

// What follows the route besides the hashchange event, which replaceRoute does
// not raise.
const followers: Set<() => void> = new Set();

// Puts a hash in place of the one on show, with no history entry: a search field
// settling into the route, so Back does not step through every letter.
export function replaceRoute(hash: string): void {
  if (hash === window.location.hash) {
    return;
  }
  window.history.replaceState(null, "", hash);
  for (const follow of followers) {
    follow();
  }
}

function current(): Route {
  for (let hops: number = 0; hops < 3; hops += 1) {
    const found: Route | { redirect: string } = parse(window.location.hash);
    if (!("redirect" in found)) {
      return found;
    }
    window.history.replaceState(null, "", found.redirect);
  }
  return { screen: "home", word: "home", segments: [], params: new URLSearchParams(), hash: "#home" };
}

// The route on show, following the hash.
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(current);
  useEffect((): (() => void) => {
    const follow = (): void => setRoute(current());
    window.addEventListener("hashchange", follow);
    followers.add(follow);
    return (): void => {
      window.removeEventListener("hashchange", follow);
      followers.delete(follow);
    };
  }, []);
  return route;
}

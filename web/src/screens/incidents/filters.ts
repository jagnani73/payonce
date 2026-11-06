import { query } from "../../api";
import type { IncidentScope, IncidentsView, Origin } from "../../types";

// The Incidents screen's filters live in its route (ia.md section 0.4), so a link
// shares the view and Back steps through it:
// #incidents?scope=closed&currency=USD&origin=outside&me=1&clean=1&q=acme.
// A value the page does not know is left out, as if it were not there.

export interface Filters {
  // Null: no scope in the route, so the screen picks the default.
  scope: IncidentScope | null;
  currency: string | null;
  origin: Origin | null;
  // "Waiting for me", for the You are name.
  me: boolean;
  // Include payments with no incident.
  clean: boolean;
  q: string;
}

export const SCOPES: readonly IncidentScope[] = ["needs-you", "bank-late", "with-bank", "payonce", "closed", "all"];
export const MAX_QUERY: number = 100;

const ORIGINS: readonly Origin[] = ["payonce", "outside", "pay-run"];
const CURRENCY: RegExp = /^[A-Z]{3}$/;

function isScope(value: string): value is IncidentScope {
  return (SCOPES as readonly string[]).includes(value);
}

function isOrigin(value: string): value is Origin {
  return (ORIGINS as readonly string[]).includes(value);
}

function on(value: string | null): boolean {
  return value === "1" || value === "true";
}

export function filtersOf(params: URLSearchParams): Filters {
  const scope: string = params.get("scope") ?? "";
  const currency: string = params.get("currency") ?? "";
  const origin: string = params.get("origin") ?? "";
  return {
    scope: isScope(scope) ? scope : null,
    currency: CURRENCY.test(currency) ? currency : null,
    origin: isOrigin(origin) ? origin : null,
    me: on(params.get("me")),
    clean: on(params.get("clean")),
    q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY),
  };
}

export function filtersHref(filters: Filters): string {
  return query("#incidents", {
    scope: filters.scope,
    currency: filters.currency,
    origin: filters.origin,
    me: filters.me ? 1 : null,
    clean: filters.clean ? 1 : null,
    q: filters.q.trim(),
  });
}

// The view for every scope at once: the tabs only pick which rows show, so
// switching tabs needs no new read. The other filters change the counts, so
// the server applies them. "Waiting for me" sends the You are name.
export function viewPath(filters: Filters, me: string | null): string {
  return query("/api/incidents", {
    scope: "all",
    currency: filters.currency,
    origin: filters.origin,
    me: filters.me ? me : null,
    clean: filters.clean ? "true" : null,
    q: filters.q.trim(),
  });
}

// Whether a filter beyond the scope narrows the list.
export function narrowed(filters: Filters, me: string | null): boolean {
  return filters.q.trim() !== "" || filters.currency !== null || filters.origin !== null || (filters.me && me !== null);
}

export function countOf(view: IncidentsView, scope: IncidentScope): number {
  return view.scopes.find((item: IncidentsView["scopes"][number]): boolean => item.scope === scope)?.count ?? 0;
}

// "Needs you" when it has anything, else "All" (ia.md section 2).
export function shownScope(filters: Filters, view: IncidentsView): IncidentScope {
  return filters.scope ?? (countOf(view, "needs-you") > 0 ? "needs-you" : "all");
}

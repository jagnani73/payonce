import type { SuppliersView, SupplierView } from "../../../views/contract.js";
import { MAX_QUERY_LENGTH } from "../../../views/search.js";
import { suppliersView, supplierView } from "../../../views/supplier-pages.js";
import type { HttpApp } from "../app.js";
import { HttpError, sendJson } from "../http.js";
import type { Route } from "../router.js";

// The supplier records, from the ledger alone.
export function supplierRoutes(app: HttpApp): Route[] {
  const { engine, settings, live } = app;

  function list(params: URLSearchParams): SuppliersView {
    const q: string = (params.get("q") ?? "").trim();
    if (q.length > MAX_QUERY_LENGTH) {
      throw new HttpError(400, `Search for 1 to ${MAX_QUERY_LENGTH} characters`);
    }
    return suppliersView(engine.ledger, settings, Date.now(), q === "" ? null : q);
  }

  // One supplier record by its beneficiary id.
  function record(raw: string): SupplierView {
    const view: SupplierView | null = supplierView(engine.ledger, settings, Date.now(), raw, live);
    if (view === null) {
      throw new HttpError(404, `No invoice or pay run row in the ledger names supplier record ${raw.slice(0, 20)}`);
    }
    return view;
  }

  return [
    { method: "GET", pattern: "/api/suppliers", handler: ({ response, url }): void => sendJson(response, 200, list(url.searchParams)) },
    { method: "GET", pattern: "api/suppliers/:key", handler: ({ response }, key: string): void => sendJson(response, 200, record(key)) },
  ];
}

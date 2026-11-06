import type { IncomingMessage } from "node:http";
import { ContactError } from "../../../domain/contacts.js";
import { confirmContact, proposeContact, withdrawContact } from "../../../engine/contacts.js";
import type { ContactChange } from "../../../store/ledger.js";
import { contactDetailView } from "../../../views/contacts.js";
import { liveFrom, type Live } from "../../../views/context.js";
import type { Acted, Notice, SupplierContactDetail, SupplierView } from "../../../views/contract.js";
import { supplierView } from "../../../views/supplier-pages.js";
import { SUPPLIER_KEY_PATTERN } from "../../../views/suppliers.js";
import type { HttpApp } from "../app.js";
import { HttpError, name, readJson, RUN_ID_PATTERN, sendJson, text, typed } from "../http.js";
import type { Route } from "../router.js";

const STATUS: Record<ContactError["why"], number> = { input: 400, refused: 403, unknown: 404, conflict: 409 };

// A supplier record's phone on file: the full number, and a person proposing,
// confirming or withdrawing one. None runs in an invoice's turn: each is one
// ledger transaction that moves no money, and the invoices whose looks it made
// due are then woken. A released pay run row that has not sent is left to the
// watcher, which gives it the run's turn.
export function contactRoutes(app: HttpApp): Route[] {
  const { engine, agent, settings, isBusy } = app;
  const live: Live = liveFrom(isBusy);

  function recordKey(raw: string): string {
    if (!SUPPLIER_KEY_PATTERN.test(raw)) {
      throw new HttpError(404, `No invoice or pay run row in the ledger names supplier record ${raw.slice(0, 20)}`);
    }
    return raw;
  }

  function contactId(raw: string): number {
    if (!RUN_ID_PATTERN.test(raw)) {
      throw new HttpError(404, `No proposed phone number ${raw.slice(0, 20)} for this supplier`);
    }
    return Number(raw);
  }

  function changed(key: string, change: () => ContactChange, notice: (change: ContactChange) => Notice): Acted<SupplierView> {
    let done: ContactChange;
    try {
      done = change();
    } catch (error: unknown) {
      throw error instanceof ContactError ? new HttpError(STATUS[error.why], error.message) : error;
    }
    const unsent: ReadonlySet<string> = new Set<string>(
      engine.ledger.unsentRunInvoices().map((row: { invoiceId: string }): string => row.invoiceId),
    );
    for (const invoiceId of done.invoices) {
      if (!unsent.has(invoiceId)) {
        agent.wake(invoiceId);
      }
    }
    const view: SupplierView | null = supplierView(engine.ledger, settings, Date.now(), key, live);
    if (view === null) {
      throw new HttpError(404, `No invoice or pay run row in the ledger names supplier record ${key.slice(0, 20)}`);
    }
    return { view, notice: notice(done) };
  }

  async function propose(request: IncomingMessage, raw: string): Promise<Acted<SupplierView>> {
    const key: string = recordKey(raw);
    const body: Record<string, unknown> = await readJson(request);
    const by: string = name(body, "name", "Enter your name");
    return changed(
      key,
      (): ContactChange =>
        proposeContact(engine.ledger, key, {
          field: typed(body, "field"),
          value: text(body, "value"),
          name: by,
          source: typed(body, "source"),
          note: text(body, "note"),
        }),
      (): Notice => ({
        tone: "info",
        text: "Proposed. It goes on file once someone else finds the same number in their own source and confirms it.",
      }),
    );
  }

  async function confirm(request: IncomingMessage, raw: string, rawId: string): Promise<Acted<SupplierView>> {
    const key: string = recordKey(raw);
    const id: number = contactId(rawId);
    const body: Record<string, unknown> = await readJson(request);
    const by: string = name(body, "name", "Enter your name");
    return changed(
      key,
      (): ContactChange =>
        confirmContact(engine.ledger, key, id, {
          value: text(body, "value"),
          name: by,
          source: typed(body, "source"),
          note: text(body, "note"),
        }),
      (change: ContactChange): Notice => ({
        tone: "success",
        text:
          change.contact.withdrawnRequests === 0
            ? "The phone number is on file."
            : `The phone number is on file. ${change.contact.withdrawnRequests === 1 ? "One approval request" : `${change.contact.withdrawnRequests} approval requests`} that relied on a callback on the old number ${change.contact.withdrawnRequests === 1 ? "was" : "were"} withdrawn.`,
      }),
    );
  }

  async function withdraw(request: IncomingMessage, raw: string, rawId: string): Promise<Acted<SupplierView>> {
    const key: string = recordKey(raw);
    const id: number = contactId(rawId);
    const body: Record<string, unknown> = await readJson(request);
    const by: string = name(body, "name", "Enter your name");
    return changed(
      key,
      (): ContactChange => withdrawContact(engine.ledger, key, id, by, text(body, "note")),
      (): Notice => ({ tone: "info", text: "Proposal withdrawn." }),
    );
  }

  function detail(raw: string): SupplierContactDetail {
    const found: SupplierContactDetail | null = contactDetailView(engine.ledger, recordKey(raw), Date.now());
    if (found === null) {
      throw new HttpError(404, `No invoice or pay run row in the ledger names supplier record ${raw.slice(0, 20)}`);
    }
    return found;
  }

  return [
    {
      method: "GET",
      pattern: "api/suppliers/:key/contact",
      handler: ({ response }, key: string): void => sendJson(response, 200, detail(key)),
    },
    {
      method: "POST",
      pattern: "api/suppliers/:key/contact",
      handler: async ({ request, response }, key: string): Promise<void> =>
        sendJson(response, 200, await propose(request, key)),
    },
    {
      method: "POST",
      pattern: "api/suppliers/:key/contact/:id/confirm",
      handler: async ({ request, response }, key: string, id: string): Promise<void> =>
        sendJson(response, 200, await confirm(request, key, id)),
    },
    {
      method: "POST",
      pattern: "api/suppliers/:key/contact/:id/withdraw",
      handler: async ({ request, response }, key: string, id: string): Promise<void> =>
        sendJson(response, 200, await withdraw(request, key, id)),
    },
  ];
}

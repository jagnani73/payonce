import { randomUUID } from "node:crypto";
import type { AirwallexClient } from "./client.js";

// Every transfer event there is. A subscription's events cannot be changed after
// it is created, so it takes all of them and the receiver picks what it needs.
export const TRANSFER_EVENTS: string[] = [
  "payout.transfer.in_approval",
  "payout.transfer.scheduled",
  "payout.transfer.overdue",
  "payout.transfer.processing",
  "payout.transfer.sent",
  "payout.transfer.paid",
  "payout.transfer.failed",
  "payout.transfer.cancellation_requested",
  "payout.transfer.cancelled",
];

// PayOnce finds its own subscription again by the request_id it created it with.
const REQUEST_ID_PREFIX: string = "payonce-transfers-";

export interface Webhook {
  id: string;
  url: string;
  secret: string;
  version: string;
  events: string[];
  // Can be missing on a subscription made in the web app.
  request_id?: string;
}

interface WebhookPage {
  items?: Webhook[];
  page_after?: string | null;
}

export async function listWebhooks(client: AirwallexClient): Promise<Webhook[]> {
  const webhooks: Webhook[] = [];
  let page: string | null | undefined = undefined;
  do {
    const query: string = page ? `?page=${encodeURIComponent(page)}` : "";
    const result: WebhookPage = await client.get<WebhookPage>(`/api/v1/webhooks${query}`);
    webhooks.push(...(result.items ?? []));
    page = result.page_after;
  } while (page);
  return webhooks;
}

// Points PayOnce's transfer subscription at url, creating it the first time, and
// returns its signing secret. A tunnel gets a new address each time it starts, so
// the one subscription is moved to it instead of a new one being added.
export async function subscribe(
  client: AirwallexClient,
  url: string,
  version: string,
): Promise<string> {
  const existing: Webhook | undefined = (await listWebhooks(client)).find(
    (webhook: Webhook): boolean =>
      webhook.request_id?.startsWith(REQUEST_ID_PREFIX) === true,
  );
  if (existing === undefined) {
    const created: Webhook = await client.post<Webhook>("/api/v1/webhooks/create", {
      // Airwallex takes at most 50 characters.
      request_id: `${REQUEST_ID_PREFIX}${randomUUID().slice(0, 8)}`,
      url,
      version,
      events: TRANSFER_EVENTS,
    });
    return created.secret;
  }
  if (existing.url === url) {
    return existing.secret;
  }
  const updated: Partial<Webhook> = await client.post<Partial<Webhook>>(
    `/api/v1/webhooks/${existing.id}/update`,
    { url },
  );
  return updated.secret ?? existing.secret;
}

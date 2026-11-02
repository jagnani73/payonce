import type { AirwallexClient } from "./client.js";

// Airwallex refuses a balance history range longer than this.
export const HISTORY_WINDOW_MS: number = 7 * 24 * 60 * 60_000;
const PAGE_SIZE: number = 500;
// A window with more pages than this is refused instead of read for ever.
const MAX_PAGES: number = 200;

// One row of the cash account's balance history, as Airwallex sends it. Nothing
// is trusted: every field is checked before it is kept. description and
// reference are never read, because they carry payee names and typed text.
export interface HistoryItem {
  id?: unknown;
  source?: unknown;
  amount?: unknown;
  currency?: unknown;
  balance?: unknown;
  posted_at?: unknown;
  source_type?: unknown;
  transaction_type?: unknown;
  account_type?: unknown;
}

interface HistoryPage {
  items?: HistoryItem[];
  has_more?: boolean;
  page_after?: string | null;
}

export class HistoryPagingError extends Error {
  constructor() {
    super(`GET /api/v1/balances/history gave more than ${MAX_PAGES} pages for one window, so PayOnce stopped reading it`);
    this.name = "HistoryPagingError";
  }
}

// Airwallex's form, to the second, as the probes sent it.
function postAt(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

// Every row of every wallet in the cash account posted in [fromMs, toMs), newest
// first, as Airwallex lists them. Both ends are whole seconds and the range is at
// most HISTORY_WINDOW_MS. pages counts the GETs.
export async function listBalanceHistory(
  client: AirwallexClient,
  fromMs: number,
  toMs: number,
  pages: { count: number },
): Promise<HistoryItem[]> {
  const items: HistoryItem[] = [];
  let page: string | null | undefined = undefined;
  for (let read: number = 0; ; read += 1) {
    if (read >= MAX_PAGES) {
      throw new HistoryPagingError();
    }
    const cursor: string = page ? `&page=${encodeURIComponent(page)}` : "";
    const answer: HistoryPage = await client.get<HistoryPage>(
      `/api/v1/balances/history?account_type=cash&from_post_at=${encodeURIComponent(postAt(fromMs))}&to_post_at=${encodeURIComponent(postAt(toMs))}&page_size=${PAGE_SIZE}${cursor}`,
    );
    pages.count += 1;
    items.push(...(Array.isArray(answer.items) ? answer.items : []));
    page = answer.has_more === false ? null : answer.page_after;
    if (!page) {
      return items;
    }
  }
}

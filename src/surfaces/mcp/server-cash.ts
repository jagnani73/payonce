import type { Balance, BalanceState } from "../../airwallex/balances.js";
import { CURRENCY_PATTERN } from "../../domain/patterns.js";
import type { ReservePolicy } from "../../domain/reserve.js";
import { SERVER_FLOORS_UNREADABLE } from "../../views/outside-fields.js";

// The balances PayOnce's server holds, from GET /api/cash/cached on this machine,
// which answers from its cache and never reads Airwallex. The MCP server works the
// cash panel out again on its own ledger from them, so the headroom is the page's.

const SERVER_TIMEOUT_MS: number = 1_500;
const MAX_ANSWER_BYTES: number = 4 * 1024 * 1024;
const BALANCE_MAX_AGE_MS: number = 30_000;

export const NO_BALANCES: BalanceState = {
  readAt: null,
  balances: [],
  refreshing: false,
  error: null,
  maxAgeMs: BALANCE_MAX_AGE_MS,
};

export interface CachedBalances {
  balances: BalanceState;
  reserve: ReservePolicy;
  statesCheckedAt: number | null;
}

// With none, why says which of the three it was: no server answers, the server
// has no such route (an older PayOnce answers 404), or the answer is not a cash
// panel. Each is PayOnce's own sentence with the port, never the server's words.
export type ServerBalances = { cached: CachedBalances; why: null } | { cached: null; why: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function minorOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function timeOf(value: unknown): number | null {
  const at: number = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
}

// GET /api/cash/cached's answer, number by number: the balances and the floors
// the server holds. Of its text only the error message is kept, as Airwallex's,
// and the cash view never shows it. Null for anything that is not a cash panel.
export function cachedBalances(answer: unknown): CachedBalances | null {
  if (
    !isRecord(answer) ||
    typeof answer["generatedAt"] !== "string" ||
    !Array.isArray(answer["currencies"]) ||
    !isRecord(answer["airwallex"])
  ) {
    return null;
  }
  const airwallex: Record<string, unknown> = answer["airwallex"];
  const balances: Balance[] = [];
  const floors: Map<string, number> = new Map<string, number>();
  for (const entry of answer["currencies"] as unknown[]) {
    const currency: unknown = isRecord(entry) ? entry["currency"] : undefined;
    if (!isRecord(entry) || typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      continue;
    }
    const floor: unknown = entry["floor"];
    const floorMinor: number | null = isRecord(floor) && floor["source"] === "setting" ? minorOf(floor["minor"]) : null;
    if (floorMinor !== null && floorMinor >= 0) {
      floors.set(currency, floorMinor);
    }
    const read: unknown = entry["airwallex"];
    if (isRecord(read)) {
      balances.push({
        currency,
        availableMinor: minorOf(read["availableMinor"]),
        reservedMinor: minorOf(read["reservedMinor"]),
        pendingMinor: minorOf(read["pendingMinor"]),
        prepaymentMinor: minorOf(read["prepaymentMinor"]),
        totalMinor: minorOf(read["totalMinor"]),
      });
    }
  }
  const unreadable: boolean = isRecord(answer["floors"]) && typeof answer["floors"]["problem"] === "string";
  const error: unknown = airwallex["error"];
  const maxAge: unknown = airwallex["maxAgeSeconds"];
  return {
    reserve: unreadable
      ? { floors: new Map<string, number>(), problem: SERVER_FLOORS_UNREADABLE }
      : { floors, problem: null },
    balances: {
      readAt: timeOf(airwallex["readAt"]),
      balances,
      refreshing: airwallex["refreshing"] === true,
      error:
        isRecord(error) && typeof error["message"] === "string"
          ? { message: error["message"], at: timeOf(error["at"]) ?? Date.now() }
          : null,
      maxAgeMs: typeof maxAge === "number" && Number.isFinite(maxAge) ? maxAge * 1000 : BALANCE_MAX_AGE_MS,
    },
    statesCheckedAt: isRecord(answer["ledger"]) ? timeOf(answer["ledger"]["statesCheckedAt"]) : null,
  };
}

export async function serverBalances(port: number): Promise<ServerBalances> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/cash/cached`, {
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    return {
      cached: null,
      why: `PayOnce's server (pnpm ui) is not answering on port ${port}, so no balance was read and there is no headroom. Run pnpm cash for one fresh read`,
    };
  }
  const notPanel: ServerBalances = {
    cached: null,
    why: `The server on port ${port} did not answer with a cash panel, so it may not be PayOnce's server. No balance was read and there is no headroom. Run pnpm cash for one fresh read`,
  };
  try {
    if (response.status === 404) {
      await response.body?.cancel();
      return {
        cached: null,
        why: `The server on port ${port} answered 404 for the cached cash panel, as a PayOnce server older than this MCP server does, so no balance was read and there is no headroom. Restart pnpm ui, or run pnpm cash for one fresh read`,
      };
    }
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      return notPanel;
    }
    const chunks: Uint8Array[] = [];
    let bytes: number = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_ANSWER_BYTES) {
        return notPanel;
      }
      chunks.push(chunk);
    }
    const cached: CachedBalances | null = cachedBalances(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
    return cached === null ? notPanel : { cached, why: null };
  } catch {
    return notPanel;
  }
}

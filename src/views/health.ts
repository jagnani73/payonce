import type { BalanceState } from "../airwallex/balances.js";
import { OFFLINE_HOST } from "../airwallex/client.js";
import type { AlertsStatus } from "../alerts/alerts.js";
import { latestLiveRun, type ReconRunner, type RunView } from "../recon/reconcile.js";
import type { Ledger } from "../store/ledger.js";
import type { AirwallexHealth } from "./contract.js";
import { iso } from "./parts.js";

// What only pnpm ui knows: the Airwallex host it calls, how its last reads went,
// its alerts and its timers. The status and settings views take it, and the CLI,
// MCP and the dump pass none.
export interface ServerFacts {
  host: string;
  balances: BalanceState;
  alerts: AlertsStatus;
  reconRunner: ReconRunner | null;
  checksEverySeconds: number;
  listingEverySeconds: number;
}

// How a read of Airwallex went, and when.
interface Outcome {
  at: number;
  ok: boolean;
  // The client's own message, with every secret already cut out.
  message: string | null;
}

// The client says "did not complete" when no answer came back, and "failed
// with" and the status when Airwallex answered with an error.
function unreachable(message: string): boolean {
  return / did not complete: /.test(message);
}

function outcomesOf(balances: BalanceState, recon: RunView | null): Outcome[] {
  const outcomes: Outcome[] = [];
  if (balances.readAt !== null) {
    outcomes.push({ at: balances.readAt, ok: true, message: null });
  }
  if (balances.error !== null) {
    outcomes.push({ at: balances.error.at, ok: false, message: balances.error.message });
  }
  const finished: number = recon?.finishedAt === null || recon === null ? Number.NaN : Date.parse(recon.finishedAt);
  if (recon !== null && Number.isFinite(finished)) {
    outcomes.push(
      recon.error === null
        ? { at: finished, ok: true, message: null }
        : { at: finished, ok: false, message: recon.error },
    );
  }
  return outcomes.sort((a: Outcome, b: Outcome): number => a.at - b.at);
}

// Whether PayOnce can reach Airwallex, from its latest reads: the balance cache's
// last good read and last failure, and the latest reconciliation check against
// Airwallex. The newest of them decides. PayOnce's words go in text, the
// client's message only in detail. Nothing answers on the offline host, so
// PayOnce says it is offline there until a read works, as one does against a
// stand-in bank, and from then on the reads decide.
export function airwallexHealth(ledger: Ledger, host: string, balances: BalanceState): AirwallexHealth {
  const outcomes: Outcome[] = outcomesOf(balances, latestLiveRun(ledger));
  const lastOk: Outcome | undefined = [...outcomes].reverse().find((outcome: Outcome): boolean => outcome.ok);
  const latest: Outcome | undefined = outcomes.at(-1);
  if (host === OFFLINE_HOST && lastOk === undefined) {
    return {
      state: "unreachable",
      lastOkAt: null,
      failingSince: null,
      text: "PayOnce is offline: it makes no calls to Airwallex.",
      detail: null,
    };
  }
  if (latest === undefined) {
    return { state: "unknown", lastOkAt: null, failingSince: null, text: "PayOnce has not read Airwallex yet.", detail: null };
  }
  if (latest.ok) {
    return { state: "ok", lastOkAt: iso(latest.at), failingSince: null, text: "Airwallex answered PayOnce's last read.", detail: null };
  }
  const since: Outcome | undefined = outcomes.find(
    (outcome: Outcome): boolean => !outcome.ok && (lastOk === undefined || outcome.at > lastOk.at),
  );
  const cannotReach: boolean = unreachable(latest.message ?? "");
  return {
    state: cannotReach ? "unreachable" : "error",
    lastOkAt: lastOk === undefined ? null : iso(lastOk.at),
    failingSince: iso(since?.at ?? latest.at),
    text: cannotReach
      ? "PayOnce cannot reach Airwallex. Payments wait and nothing is lost; PayOnce tries again every minute."
      : "Airwallex answered PayOnce's last read with an error. PayOnce tries again every minute.",
    detail: latest.message,
  };
}

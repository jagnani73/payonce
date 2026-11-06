import { keyHash } from "./approval.js";
import { knownName, type Barred } from "./approvers.js";
import { routeOfDetailsKey } from "./assess.js";
import { setterBarWhy } from "./contacts.js";

// What the ledger holds that bars people from approving a payment of an invoice:
// who started it, whether that was by uploading a pay run, and each set of bank
// details a callback applied to its beneficiary (as bankDetailsKey writes them)
// with everyone who recorded a callback for that account and who proposed or
// confirmed a phone number one of those callbacks was made on.
export interface BarFacts {
  startedBy: string | null;
  fromRun: boolean;
  callbacks: {
    detailsKey: string;
    recorders: string[];
    phoneSetters: { name: string; role: "proposed" | "confirmed" }[];
  }[];
}

// Why the starter of an invoice is barred, as approval refusals and the lines
// that void an approval quote it.
export const STARTED_WHY: string = "started this incident";

// Why someone is barred, in the words a person reads on the page (glossary.md):
// the payment, not the incident. Stored lines keep STARTED_WHY.
export function barredWords(why: string): string {
  return why === STARTED_WHY ? "started this payment" : why;
}

export function barredInWords(barred: Barred[]): Barred[] {
  return barred.map((entry: Barred): Barred => ({ name: entry.name, why: barredWords(entry.why) }));
}

// The people who may not approve a payment of the invoice to the account with
// this accountKey, and why: whoever started the incident, everyone who recorded
// a callback verifying that account, and whoever proposed or confirmed the
// phone number such a callback was made on, for good, whatever number is on
// file since. route is the account's routeKey,
// or null when it is not known, so a callback for the same account bars its
// recorder even when a bank name changed since. When the account's route, or
// the callback's, is not known, the recorder is barred: the bar never depends on
// a key PayOnce cannot check. A name stored before names were checked that does
// not follow the name rule bars nobody (knownName): such a starter counts as not
// known, so signoffsNeeded asks for two approvers, and a payment to a
// callback-verified account needs two already. With no accountKey only the
// starter is barred.
export function barredFrom(facts: BarFacts, accountKey: string | undefined, route: string | null): Barred[] {
  const barred: Barred[] = [];
  const starter: string | null = knownName(facts.startedBy);
  if (starter !== null) {
    barred.push({ name: starter, why: facts.fromRun ? "uploaded the pay run it came from" : STARTED_WHY });
  }
  for (const callback of facts.callbacks) {
    const applied: string | null = routeOfDetailsKey(callback.detailsKey);
    if (
      accountKey === undefined ||
      (keyHash(callback.detailsKey) !== accountKey && route !== null && applied !== null && applied !== route)
    ) {
      continue;
    }
    for (const stored of callback.recorders) {
      const name: string | null = knownName(stored);
      if (name !== null) {
        barred.push({ name, why: "recorded the callback for the new bank details" });
      }
    }
    for (const setter of callback.phoneSetters) {
      const name: string | null = knownName(setter.name);
      if (name !== null) {
        barred.push({ name, why: setterBarWhy(setter.role) });
      }
    }
  }
  return barred;
}

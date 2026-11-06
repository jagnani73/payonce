import { debitCurrency } from "../domain/reserve.js";
import type { ClauseCode } from "../domain/reasons.js";
import type { Blocker, InvoiceSnapshot, Situation } from "../domain/situation.js";
import type { Caution, FxView, RequestView } from "./contract.js";

// What a person should weigh before choosing an option, in PayOnce's words. Each
// comes from a code, a clause or a fixed line the situation already worked out,
// never from text another program wrote.

const SAME_ACCOUNT: string = "This replacement goes to the account the original failed on. Check the account with the supplier first.";
const OTHER_DETAILS: string = "The supplier asked to be paid to other bank details. This request pays the account on file.";

function utc(at: string): string {
  return `${at.slice(11, 16)} UTC`;
}

function clauseCaution(code: ClauseCode, wallet: string): Caution {
  switch (code) {
    case "below-floor":
      return { code: "below-floor", text: `A replacement and its transfer fee take ${wallet} cash below the reserve floor.` };
    case "cash-unreadable":
      return {
        code: "floor-unreadable",
        text: `PayOnce could not read the ${wallet} balance or its reserve floor when it decided, so it did not resend by itself.`,
      };
    case "no-floor":
      return { code: "no-floor", text: `No reserve floor is set for ${wallet}, so PayOnce sends every replacement there to a person.` };
    case "second-bill-paid":
      return { code: "second-bill", text: "An invoice this one looks like a second bill of has been paid already." };
    case "asks-not-to-pay":
      return { code: "asks-not-to-pay", text: "The supplier asked to hold, cancel or not pay this invoice." };
  }
}

export function cautionsOf(snapshot: InvoiceSnapshot, situation: Situation, request: RequestView | null): Caution[] {
  const wallet: string = debitCurrency(snapshot.obligation);
  const found: Caution[] = [];
  const add = (caution: Caution): void => {
    if (!found.some((other: Caution): boolean => other.code === caution.code)) {
      found.push(caution);
    }
  };
  const clauses: { code: ClauseCode }[] = request?.terms.reason.clauses ?? situation.why?.clauses ?? [];
  for (const clause of clauses) {
    add(clauseCaution(clause.code, wallet));
  }
  if (situation.also.includes(SAME_ACCOUNT)) {
    add({ code: "same-account-failed", text: SAME_ACCOUNT });
  }
  if (situation.also.includes(OTHER_DETAILS)) {
    add({ code: "bank-details-question", text: OTHER_DETAILS });
  }
  if (request?.terms.callback !== null && request?.terms.callback !== undefined) {
    add({
      code: "new-account",
      text: "This request pays bank details a callback verified, not the account the original went to. It needs two approvers.",
    });
  }
  const outage: Blocker | undefined = situation.blockers.find((blocker: Blocker): boolean => blocker.code === "outage");
  if (outage !== undefined) {
    add({ code: "outage", text: outage.text });
  }
  if (snapshot.emails.asksNotToPay) {
    add({ code: "asks-not-to-pay", text: "The supplier asked to hold, cancel or not pay this invoice." });
  }
  if (situation.why?.code === "unverified-sender") {
    add({
      code: "domain",
      text: "An email on this payment comes from an address that does not match the supplier's email domain on file.",
    });
  }
  const fx: FxView | null = request?.state === "waiting" ? request.terms.fx : null;
  const ends: number = fx === null ? Number.NaN : Date.parse(fx.validTo);
  if (fx !== null && Number.isFinite(ends)) {
    add({
      code: "fx-quote-ends",
      text: `The exchange-rate quote ends at ${utc(new Date(ends).toISOString())}. The request cannot be used after that, and PayOnce opens a new one on a new quote.`,
    });
  }
  return found;
}

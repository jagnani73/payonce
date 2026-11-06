import { count, joinNames } from "../../text";
import type { SupplierAccountView, SupplierListRow, SupplierView } from "../../types";

// The page's words for the structured fields of the supplier views. Sentences
// about cautions, payments and outages come from the server.

export const SEEN_AS: Record<SupplierAccountView["seenAs"][number], string> = {
  decided: "decided",
  sent: "sent",
  approval: "approval",
  "pay-run": "pay run",
  callback: "callback",
  "before-callback": "before a callback",
  outside: "sent outside PayOnce",
};

// "···6789", the way the page writes an account by its last four characters.
export function endingText(ending: string | null): string {
  return ending === null ? "account not read" : `···${ending}`;
}

export function phoneText(ending: string | null): string {
  return ending === null ? "no phone on file" : `phone ending ${ending}`;
}

// What tells same-named records apart: "US · USD · Local · ···6789 · no phone on file".
export function recordFacts(row: Pick<SupplierListRow, "hint" | "accountEnding" | "phoneEnding">): string {
  return [row.hint, endingText(row.accountEnding), phoneText(row.phoneEnding)].filter((part: string): boolean => part !== "").join(" · ");
}

export function paymentsText(payments: SupplierListRow["payments"]): string {
  return payments.total === 0 ? "No payments yet" : `${payments.open} open · ${payments.total} in all`;
}

// "account A", "accounts A and B".
export function accountsText(letters: readonly string[]): string {
  return letters.length === 1 ? `account ${letters[0] ?? ""}` : `accounts ${joinNames(letters, "and")}`;
}

export const CALLBACK_STATES: Record<string, string> = {
  applied: "applied",
  pending: "not applied yet",
  failed: "failed",
};

export const SECOND_BILL_KINDS: Record<SupplierView["secondBills"][number]["kind"], string> = {
  "same-bill": "Same invoice number and amount",
  "same-number": "Same invoice number",
};

// "14 closed (12 paid, 2 closed without paying)".
export function closedText(closed: SupplierView["payments"]["closed"]): string {
  const parts: string[] = [
    ...(closed.paid === 0 ? [] : [`${closed.paid} paid`]),
    ...(closed.unpaid === 0 ? [] : [`${closed.unpaid} closed without paying`]),
  ];
  return `${closed.paid + closed.unpaid} closed (${parts.join(", ")})`;
}

// "A number with these digits appears in 2 supplier emails on file, 1 from a sender the check flags."
export function seenInEmailsText(seen: number, flagged: number): string {
  const base: string = `A number with these digits appears in ${count(seen, "supplier email")} on file`;
  if (flagged === 0) {
    return `${base}.`;
  }
  if (seen === 1 && flagged === 1) {
    return `${base}, and it came from a sender the check flags.`;
  }
  return `${base}, ${flagged} from a sender the check flags.`;
}

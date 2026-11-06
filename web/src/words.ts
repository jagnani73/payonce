import { joinNames } from "./text";
import type { WaitingOn } from "./types";

// Words the page puts on structured fields the views hand it. Sentences and
// labels come from the server; these only name who a payment waits on.

// "approvers", "the bank", "Alex, Kim or Yash to end the outage". Null when it
// waits on nobody.
export function waitingOnText(waiting: WaitingOn): string | null {
  switch (waiting.who) {
    case "approvers":
      return "approvers";
    case "person":
      return "a person";
    case "outage-ender":
      return waiting.names === null || waiting.names.length === 0
        ? "anyone to end the outage"
        : `${joinNames(waiting.names, "or")} to end the outage`;
    case "admin":
      return "an admin";
    case "payonce":
      return "PayOnce";
    case "bank":
      return "the bank";
    case "bank-then-person":
      return "the bank, then a person";
    case "nobody":
      return null;
  }
}

import type { AirwallexClient } from "../airwallex/client.js";
import type { Transfer, TransferBankDetails } from "../airwallex/transfers.js";
import type { FxTerms } from "../domain/approval.js";
import type { ApprovalPolicy } from "../domain/approvers.js";
import type { ArrivalTerms } from "../domain/arrival.js";
import type { BankDeadlineMinutes } from "../domain/deadlines.js";
import type { SupplierEmail } from "../domain/emails.js";
import type { QuoteSetting } from "../domain/fx.js";
import type { Decision, Incident } from "../domain/incident.js";
import type { Clause, Reason } from "../domain/reasons.js";
import type { ReservePolicy } from "../domain/reserve.js";
import type { OutageRule } from "../outages/outages.js";
import type { EmailReader } from "../reader/emails.js";
import type { AttemptKind, BankChange, Ledger } from "../store/ledger.js";
import type { StoredFindings } from "../store/stored.js";

// Told about each payment PayOnce sends. In the sandbox it plays the bank, so the
// payment moves on. In production there is none, because the bank moves it.
// reference is the transfer's short reference, which the bank names when it
// cannot read the transfer.
export interface Bank {
  sent(invoiceId: string, kind: AttemptKind, transferId: string, reference?: string | null): void;
}

export interface Engine {
  client: AirwallexClient;
  ledger: Ledger;
  reader: EmailReader;
  approvals: ApprovalPolicy;
  reserve: ReservePolicy;
  bankDeadlineMinutes: BankDeadlineMinutes;
  fxQuotes: QuoteSetting;
  outageRule: OutageRule;
  bank?: Bank;
}

// The time of the next look the agent takes by itself, in epoch milliseconds.
// Null when it waits for news or for a person.
export type NextLook = number | null;

// How a look was asked for. runTurn gives it the pay run's turn, so it may send
// a pay run row's first payment. Only the release and the server's watcher give
// it, so no other look sends a row out of turn.
export interface LookOptions {
  runTurn: boolean;
}

// What one step of a look comes to: the look ends with the time of its next look,
// or with the work under way that gives it, or it goes on to the next step. A
// step is a plain function that awaits nothing itself: the look returns the work
// it started as it is, so a look takes no more turns of the event loop than its
// work does, and runs beside other looks and the sweep in the same order.
export type StepResult = { kind: "next"; at: NextLook | Promise<NextLook> } | { kind: "continue" };

export const CONTINUE: StepResult = { kind: "continue" };

export function nextLookAt(at: NextLook | Promise<NextLook>): StepResult {
  return { kind: "next", at };
}

// How long after a look that failed the agent tries again.
export const RETRY_FAILED_LOOK_MS: number = 60_000;

// The quote a payment from another currency's wallet is approved at. fresh is
// true for one no request has shown, which a new request may open on. endsAt is
// when it runs out by this machine's clock, and NaN for one taken from an open
// request.
export interface Rate {
  fx: FxTerms;
  fresh: boolean;
  endsAt: number;
}

// A decision with its reason as codes. The policy's reasons become codes as they
// leave decide.ts, and the text is rendered from them wherever it is written: an
// escalation, a timeline line or approval terms.
export interface Decided {
  action: Decision["action"];
  reason: Reason;
}

export interface Assessment {
  original: Transfer;
  incident: Incident;
  findings: StoredFindings;
  unverified: string[];
  // The emails on file when the look assessed the invoice.
  emails: SupplierEmail[];
  bankDetails: TransferBankDetails;
  // The callback that verified the bank details on file, when they are not the
  // ones the original went to. Null when none matches them.
  bankChange: BankChange | null;
  // The quote a replacement from another currency's wallet would be paid at.
  // Null for any other invoice, and before the original has failed.
  rate: Rate | null;
  // When a replacement sent now usually arrives. Null for an invoice with no due
  // date, so its terms are as they were before.
  arrival: ArrivalTerms | null;
  decision: Decided;
  // The floor clause added to the decision's reason, or null when none was.
  floor: Clause | null;
  // A paid invoice this one looks like a second bill for, once the original has
  // failed. Null when there is none.
  paidDuplicate: string | null;
}

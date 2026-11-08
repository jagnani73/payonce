import { AirwallexError, AirwallexUnreachableError } from "../airwallex/client.js";
import type { Transfer } from "../airwallex/transfers.js";
import { formatMoney, toMinor } from "../domain/money.js";
import type { EventKind, Ledger, LedgerEvent } from "../store/ledger.js";
import { LineError } from "../text/line-error.js";
import { errorAbout, lineAbout, oneLine, say, sayError } from "../text/printable.js";

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// What a standing line is about. A standing line says how things are now and is
// written again on every check. A line with no topic records something that
// happened.
export type Topic =
  | "decision"
  | "waiting"
  | "approval"
  | "cost"
  | "bank-details"
  | "last-paid"
  | "floor"
  | "second-bill"
  | "retry";

// True when the timeline's last word on a topic is this message and nothing has
// happened since. A pay run's timeline uses it too.
export function stillSays(events: LedgerEvent[], topic: string, message: string): boolean {
  for (const event of [...events].reverse()) {
    if (event.topic === topic) {
      return event.message === message;
    }
    if (event.topic === null) {
      return false;
    }
  }
  return false;
}

// False for a line identical to the timeline's last one, and for a standing line
// the timeline still says. A pay run's timeline uses it too.
export function lineWanted(events: LedgerEvent[], kind: EventKind, message: string, topic: string | null): boolean {
  const last: LedgerEvent | undefined = events.at(-1);
  if (last?.kind === kind && last.message === message) {
    return false;
  }
  return topic === null || !stillSays(events, topic, message);
}

// Adds a line to the incident's timeline and prints it, unless lineWanted says
// the timeline has it already, which keeps a check that finds nothing new from
// repeating the decision.
export function note(
  ledger: Ledger,
  invoiceId: string,
  kind: EventKind,
  message: string,
  topic: Topic | null = null,
): void {
  // One line, as the ledger stores it, so a line break in a name or a note cannot
  // print as a line of its own.
  const line: string = oneLine(message);
  if (!lineWanted(ledger.events(invoiceId), kind, line, topic)) {
    return;
  }
  ledger.addEvent(invoiceId, kind, line, topic);
  say(lineAbout(invoiceId, kind, line));
}

// Puts a failure on the incident's timeline. It must not throw, because it runs
// from error handlers. An Airwallex error says all there is in its message and
// repeats on every look while Airwallex is down, so it prints as one line, and so
// does the error behind a LineError, such as a sandbox bank failure, whose message
// is the timeline line, in PayOnce's words and its own kind; any other error
// prints with its stack trace.
export function noteError(ledger: Ledger, invoiceId: string, error: unknown): void {
  sayError(
    error instanceof AirwallexError || error instanceof AirwallexUnreachableError
      ? lineAbout(invoiceId, "error", messageOf(error), true)
      : error instanceof LineError
        ? lineAbout(invoiceId, error.kind, error.detail, true)
        : errorAbout(invoiceId, error),
  );
  try {
    note(ledger, invoiceId, error instanceof LineError ? error.kind : "error", messageOf(error));
  } catch (inner: unknown) {
    sayError(`Could not record the error for ${invoiceId}: ${messageOf(inner)}`);
  }
}

export function describe(transfer: Transfer): string {
  const failure: string =
    transfer.failure?.code === undefined
      ? ""
      : `, ${transfer.failure.code} ${transfer.failure.message ?? ""}`.trimEnd();
  return `${transfer.short_reference_id} ${transfer.status}${failure}`;
}

// A payout's amount, payee and status, as the timeline shows it.
export function payoutSummary(transfer: Transfer): string {
  const failure: string =
    transfer.failure?.code === undefined ? "" : `, ${transfer.failure.code}`;
  const payee: string =
    transfer.beneficiary?.bank_details?.account_name ?? "an unnamed payee";
  return `${formatMoney(toMinor(transfer.transfer_amount), transfer.transfer_currency)} to ${payee}, ${transfer.status}${failure}`;
}

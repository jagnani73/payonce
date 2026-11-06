import type { EventKind } from "../store/ledger.js";

// An error whose message is a timeline line in PayOnce's words, written with a
// kind of its own instead of error, and whose detail is the error it came from,
// which only the console gets. noteError in engine.ts writes it that way.
export class LineError extends Error {
  readonly kind: EventKind;
  readonly detail: string;

  constructor(message: string, kind: EventKind, detail: string) {
    super(message);
    this.name = "LineError";
    this.kind = kind;
    this.detail = detail;
  }
}

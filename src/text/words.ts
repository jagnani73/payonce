// Fixed words PayOnce writes, kept apart from the code that writes them, so the
// code that reads lines back (why-facts.ts) and the read-only views take them
// without importing the email reader or the sandbox bank. It imports nothing.

// The bank outcome that pays a transfer. Any other outcome is the failure type
// the simulator fails it with.
export const PAID_OUTCOME: string = "PAID";
// The bank outcome that leaves a transfer in SENT, so the agent's deadline for it
// runs out.
export const STAYS_IN_FLIGHT: string = "STAYS_IN_FLIGHT";

// What the sandbox bank can do with an original: fail it one of these ways, pay
// it, or leave it in flight past its deadline. A pay run file can name one per row.
export const SANDBOX_OUTCOMES: string[] = [
  "CHANNEL_TIMEOUT",
  "SYSTEM_ERROR",
  "BENEFICIARY_BANK_RETURNED",
  "ACCOUNT_CLOSED",
  "INVALID_ACCOUNT_NAME_OR_NUMBER",
  STAYS_IN_FLIGHT,
  PAID_OUTCOME,
];

// How a sandbox bank line ends: in the server, which keeps reading the transfer,
// in pnpm recover when its script fails and it stops, and in pnpm recover for a
// payment the bank hook was told about, which it reads while it runs.
export const SANDBOX_BANK_AFTER: string =
  "PayOnce keeps reading the transfer from Airwallex as usual, and if the bank has neither paid nor failed it by its deadline, a person hears about it";
export const SANDBOX_BANK_STOPPED: string =
  "PayOnce stopped here, and pnpm recover or pnpm ui reads the transfer again";
export const SANDBOX_BANK_RECOVER: string =
  "PayOnce reads the transfer while pnpm recover runs, and pnpm recover or pnpm ui reads it again after that";

// Why one model gave no answer PayOnce could use.
export type ModelFailure =
  | "busy"
  | "limited"
  | "key"
  | "refused"
  | "service"
  | "timeout"
  | "cut"
  | "incomplete"
  | "unusable"
  | "unreachable"
  | "failed";

// What each failure says after the model's name. A timeout adds its seconds, as
// "timed out after 8 s", and the failures in FAILURES_WITH_STATUS add the status
// the service answered with, as "was busy (503)".
export const MODEL_FAILURE_WORDS: Readonly<Record<ModelFailure, string>> = {
  busy: "was busy",
  limited: "was over its request limit",
  key: "refused the key",
  refused: "refused the request",
  service: "had an error on its side",
  timeout: "timed out after",
  cut: "cut its answer short",
  incomplete: "stopped before its answer was complete",
  unusable: "gave an answer PayOnce could not use",
  unreachable: "could not be reached",
  failed: "gave no answer",
};
export const FAILURES_WITH_STATUS: ReadonlySet<ModelFailure> = new Set<ModelFailure>([
  "busy",
  "limited",
  "key",
  "refused",
  "service",
]);

// The words after a model's name, as a regular expression source.
export const TRY_WORDS_SOURCE: string = (Object.entries(MODEL_FAILURE_WORDS) as [ModelFailure, string][])
  .map(([failure, words]: [ModelFailure, string]): string => {
    const escaped: string = words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return failure === "timeout"
      ? `${escaped} [0-9]{1,3} s`
      : `${escaped}${FAILURES_WITH_STATUS.has(failure) ? " \\([0-9]{3}\\)" : ""}`;
  })
  .join("|");

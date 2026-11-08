import { userInfo } from "node:os";
import { airwallexAdvice, AirwallexError, AirwallexUnreachableError } from "../../airwallex/client.js";
import { personName } from "../../domain/approvers.js";
import { createEngine, type EngineBuild } from "../../engine/create.js";
import { Dispatcher } from "../../engine/dispatcher.js";
import type { Engine } from "../../engine/engine.js";
import { note, noteError } from "../../engine/lines.js";
import { PaymentRefusedError } from "../../engine/new-payment.js";
import { loadEnvIfPresent } from "../../env-file.js";
import { describeQuotes } from "../../domain/fx.js";
import type { Ledger, Obligation, RunRow } from "../../store/ledger.js";
import { heldBeforePaying } from "../../store/read/facts.js";
import { LineError } from "../../text/line-error.js";
import { describeOutageRule } from "../../outages/outages.js";
import { printableJson, say } from "../../text/printable.js";
import { describeFloors } from "../../domain/reserve.js";
import { loadSettings, type Settings } from "../../settings.js";
import { SandboxBank, SandboxBankError } from "../../engine/sandbox-bank.js";
import {
  DEFAULT_EMAILS,
  DEFAULT_SCENARIO,
  newInvoiceId,
  openScenario,
  runScenario,
  untilAtRest,
} from "../../engine/scenario.js";
import { Watcher } from "../../engine/watcher.js";
import { SANDBOX_BANK_RECOVER, SANDBOX_BANK_STOPPED } from "../../text/words.js";

const DEFAULT_OUTCOME: string = "CHANNEL_TIMEOUT";
// The CLI has no webhook receiver, so it checks the bank often.
const CHECK_EVERY_MS: number = 2_000;

async function main(): Promise<void> {
  loadEnvIfPresent();
  const settings: Settings = loadSettings();
  const bankOutcome: string = process.argv[2] ?? DEFAULT_OUTCOME;
  // A credential missing from .env, or an address that is not the sandbox, in
  // PayOnce's words and with no stack trace. Nothing is stored or sent.
  const built: EngineBuild = createEngine(settings);
  if (built.problem !== null) {
    say(built.problem);
    process.exitCode = 1;
    return;
  }
  const ledger: Ledger = built.engine.ledger;
  // The sandbox bank's own failures say what this command does about them, which
  // is to read the transfer while it runs.
  const bank: SandboxBank = new SandboxBank(
    built.engine.client,
    built.engine.bankDeadlineMinutes,
    (invoiceId: string, error: unknown): void =>
      noteError(
        ledger,
        invoiceId,
        error instanceof SandboxBankError ? new LineError(`${error.what}. ${SANDBOX_BANK_RECOVER}`, error.kind, error.detail) : error,
      ),
    (invoiceId: string): string | null => ledger.runRowOf(invoiceId)?.sandboxOutcome ?? null,
  );
  const engine: Engine = { ...built.engine, bank };
  say(describeFloors(engine.reserve));
  say(describeQuotes(settings.fxQuotes));
  say(describeOutageRule(settings.outageRule));
  const agent: Dispatcher = new Dispatcher(engine);
  const watcher: Watcher = new Watcher(engine, agent, CHECK_EVERY_MS);
  const invoiceId: string = process.argv[3] ?? newInvoiceId(ledger);
  const emailsName: string = process.argv[4] ?? DEFAULT_EMAILS;
  const scenarioId: string = process.argv[5] ?? DEFAULT_SCENARIO;
  // Who started the incident. The login name stands in when none is given.
  const given: string = process.argv.slice(6).join(" ").trim();
  const login: string = userInfo().username;
  let startedBy: string;
  try {
    startedBy = personName(given || login);
  } catch (error: unknown) {
    const rule: string = error instanceof Error ? error.message : String(error);
    // The login name is quoted as JSON with every character a terminal could act
    // on escaped, so it shows as it is without moving the cursor.
    say(
      `${given === "" ? `Your login name, ${printableJson(JSON.stringify(login))}, is not a name PayOnce takes. ${rule}` : rule}. Give the name of who starts the incident as NAME: pnpm recover OUTCOME INVOICE EMAILS SCENARIO NAME`,
    );
    process.exitCode = 1;
    return;
  }

  // A pay run's invoice sends its first payment from the server, in the run's
  // order, and never from a scenario script. This watcher leaves such rows alone.
  const fromRun: RunRow | undefined = ledger.runRowOf(invoiceId);
  if (fromRun !== undefined && ledger.attempts(invoiceId).length === 0) {
    say(`${invoiceId} belongs to pay run ${fromRun.runId}, and the server sends it`);
    process.exitCode = 1;
    return;
  }

  watcher.start();
  let rested: boolean = true;
  try {
    const existing: Obligation | undefined = ledger.obligation(invoiceId);
    if (
      existing !== undefined &&
      (ledger.attempts(invoiceId).length > 0 || existing.state === "rejected")
    ) {
      say(`${invoiceId} is already in the ledger`);
      agent.wake(invoiceId);
      rested = await untilAtRest(ledger, agent, bank, invoiceId);
    } else {
      // An obligation with no payment yet is a run that stopped before paying, or
      // one PayOnce held before paying. A new one is announced once it is stored.
      const obligation: Obligation = existing ?? (await openScenario(engine, invoiceId, scenarioId, startedBy));
      say(`${existing === undefined ? "New incident" : "Starting"} ${invoiceId}`);
      rested = await runScenario(engine, agent, bank, obligation, { bankOutcome, emailsName });
    }
    // A payment still with the bank when the wait ran out, as when the sandbox bank
    // could not move it.
    if (!rested) {
      say(
        `${invoiceId} was still not at rest when the wait ran out, so PayOnce stopped. ${invoiceId} is in the ledger, and pnpm recover ${bankOutcome} ${invoiceId} or pnpm ui looks at it again.`,
      );
      process.exitCode = 1;
    } else {
      sayWaiting(ledger, invoiceId, `pnpm recover ${bankOutcome} ${invoiceId} ${emailsName}`);
    }
  } catch (error: unknown) {
    if (error instanceof AirwallexError || error instanceof AirwallexUnreachableError) {
      stopped(ledger, invoiceId, bankOutcome, error);
    } else if (error instanceof SandboxBankError) {
      sandboxStopped(ledger, invoiceId, bankOutcome, error);
    } else if (error instanceof PaymentRefusedError) {
      // Refused with nothing stored, so no timeline has a line for it.
      say(`${error.message}, so nothing was sent or stored`);
    } else {
      noteError(ledger, invoiceId, error);
    }
    process.exitCode = 1;
  } finally {
    watcher.stop();
  }
  const state: string | undefined = ledger.obligation(invoiceId)?.state;
  if (state !== undefined) {
    say(`  state: ${state}`);
  }
}

// A first payment that waits only for the approval every payment a person starts
// waits for: how to approve it, and the command that then sends it and plays the
// scenario.
function sayWaiting(ledger: Ledger, invoiceId: string, again: string): void {
  const held: Obligation | undefined = ledger.obligation(invoiceId);
  if (held === undefined || !heldBeforePaying(ledger, held) || ledger.reasonOf(held)?.code !== "person-started") {
    return;
  }
  say(
    ledger.latestApproval(invoiceId)?.state === "requested"
      ? `${invoiceId} waits for approval before its first transfer. pnpm approve ${invoiceId} shows the request and who can sign it. Once it is approved, ${again} sends it and plays the scenario.`
      : `${invoiceId} waits for approval before its first transfer, but PayOnce opened no request: approvals are refused, or too few people on the approver list could approve it. Fix APPROVERS, then run ${again} again.`,
  );
}

// Airwallex could not be reached or answered with an error, in PayOnce's words
// and with no stack trace. Before the invoice is stored nothing was sent. After
// it, a payment may be on its way, so the next look finds out.
function stopped(
  ledger: Ledger,
  invoiceId: string,
  bankOutcome: string,
  error: AirwallexError | AirwallexUnreachableError,
): void {
  const what: string =
    error instanceof AirwallexUnreachableError ? "Airwallex could not be reached" : "Airwallex answered with an error";
  const advice: string = airwallexAdvice(error);
  if (ledger.obligation(invoiceId) === undefined) {
    say(`${what}, so nothing was sent or stored.${advice === "" ? "" : ` ${advice}`}`);
    say(`  ${error.message}`);
    return;
  }
  say(
    `${what}, so PayOnce stopped. ${invoiceId} is in the ledger, and pnpm recover ${bankOutcome} ${invoiceId} or pnpm ui looks at it again.`,
  );
  note(ledger, invoiceId, "error", error.message);
}

// The scripted run's sandbox bank could not move the transfer it sent, as when
// the simulator answers 500. The run stops here and the watcher with it, so the
// line says so instead of the server's ending, and the terminal says how to look
// at the invoice again.
function sandboxStopped(ledger: Ledger, invoiceId: string, bankOutcome: string, error: SandboxBankError): void {
  say(
    `${error.what}, so PayOnce stopped. ${invoiceId} is in the ledger, and pnpm recover ${bankOutcome} ${invoiceId} or pnpm ui looks at it again.`,
  );
  say(`  ${error.detail}`);
  note(ledger, invoiceId, error.kind, `${error.what}. ${SANDBOX_BANK_STOPPED}`);
}

await main();

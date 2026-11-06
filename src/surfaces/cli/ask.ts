import { existsSync } from "node:fs";
import { loadEnvIfPresent } from "../../env-file.js";
import { EXPLAIN_SYSTEM, ExplainError, explainerFor, promptOf, shownAnswer, type Explainer, type ModelAnswer, type ShownAnswer } from "../../explain/explainer.js";
import { Ledger, LEDGER_PATH } from "../../store/ledger.js";
import { printable, printableJson, say, sayError, sayWarning } from "../../text/printable.js";
import { loadSettings, type Settings } from "../../settings.js";
import { whyFacts, type LegendEntry, type WhyBuild } from "../../explain/why-facts.js";

// Asks the model reader's models why PayOnce did what it did on one invoice, or
// with "facts" prints exactly what would be sent and asks nothing. It opens the
// ledger read-only and calls nothing in Airwallex. It has no rate limit: it is
// one request per run, typed by a person. It loads .env itself if there is one,
// for the key and the settings the facts quote, because Node's
// --env-file-if-exists says the file is missing once for tsx and again for the
// script.
const USAGE: string = `Usage: pnpm ask <INVOICE> [facts]
Without facts, asks the model reader's models why PayOnce did what it did on the invoice.
With facts, prints the facts and the legend exactly as they would be sent, and asks nothing.`;
const WIDTH: number = 80;
// Every line goes through printable.ts, as pnpm board prints names. The answer
// is cleaned after the legend swaps names and invoice numbers back in.

function fail(message: string): never {
  sayError(message);
  process.exit(1);
}

function wrapped(text: string): string {
  const lines: string[] = [];
  let line: string = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines.join("\n");
}

function legendText(legend: LegendEntry[]): string {
  return legend.length === 0
    ? "Legend: none"
    : `Legend (kept on this machine, never sent):\n${legend.map((entry: LegendEntry): string => `  ${entry.alias} = ${printable(entry.value)}`).join("\n")}`;
}

async function main(): Promise<void> {
  loadEnvIfPresent();
  const settings: Settings = loadSettings();
  const [invoiceId, mode, ...rest] = process.argv.slice(2);
  if (invoiceId === undefined || invoiceId === "" || (mode !== undefined && mode !== "facts") || rest.length > 0) {
    fail(USAGE);
  }
  if (!existsSync(LEDGER_PATH)) {
    fail(`There is no ${LEDGER_PATH} here. Start an incident first.`);
  }
  const ledger: Ledger = new Ledger(LEDGER_PATH, true);
  // Opened read-only, so an older file is never upgraded here, and its facts
  // cannot be read: a column the facts read may be missing.
  const gaps: string[] = ledger.schemaGaps();
  if (gaps.length > 0) {
    fail(
      `This ledger was written by an older PayOnce and lacks ${gaps.length} ${gaps.length === 1 ? "table or column" : "tables or columns"} (${gaps.slice(0, 3).join(", ")}). pnpm ask never upgrades a ledger. Restart pnpm ui, or run pnpm board once, which upgrades it, then ask again.`,
    );
  }
  const shownId: string = printable(invoiceId);
  const build: WhyBuild | undefined = whyFacts(ledger, invoiceId, {
    approvals: settings.approvals,
    reserve: settings.reserve,
    readers: settings.models.readerNames,
  });
  if (build === undefined) {
    fail(`${shownId} is not in the ledger`);
  }
  if (build.unrecognised > 0) {
    sayWarning(`  why      ${build.unrecognised} unrecognised reason${build.unrecognised === 1 ? "" : "s"} on ${shownId}`);
  }

  if (mode === "facts") {
    say("System message:");
    say(EXPLAIN_SYSTEM);
    say();
    say("User message:");
    // Escaped, not dropped, so what is printed parses back to what is sent.
    say(printableJson(promptOf(build.facts)));
    say();
    say(legendText(build.legend));
    return;
  }

  const explainer: Explainer | null = explainerFor(settings.models.askServices());
  if (explainer === null) {
    fail(
      `The model reader is off, so PayOnce cannot ask a model. Set CLAUDE_API_KEY or READER_API_KEY in .env, or run pnpm ask ${shownId} facts to see what would be sent`,
    );
  }
  let answer: ModelAnswer;
  try {
    answer = await explainer.explain(build.facts);
  } catch (error: unknown) {
    // Not process.exit: a request socket may still be closing, and exiting under
    // it trips an assertion in Node on Windows.
    sayError(error instanceof ExplainError ? error.message : `No model gave an explanation: ${String(error)}`);
    process.exitCode = 1;
    return;
  }
  const shown: ShownAnswer = shownAnswer(answer, build, Date.now(), false);
  const left: number = Object.values(build.facts.timelineLeftOut.linesNotPassedOn).reduce(
    (sum: number, count: number): number => sum + count,
    0,
  );
  say(`${shownId}: why PayOnce did what it did`);
  say(wrapped(printable(shown.explanation)));
  if (shown.notInFacts !== "") {
    say();
    say(wrapped(`Not in the records: ${printable(shown.notInFacts)}`));
  }
  if (shown.aliasesLeft) {
    say();
    say(legendText(shown.legend));
  }
  say();
  say(
    wrapped(
      `Written by ${printable(shown.model)} from PayOnce's records for this invoice (${build.asOf.lines} timeline lines, ${left} not passed on)${shown.cut ? ", shortened to fit" : ""}. A model can be wrong: the timeline is the record.`,
    ),
  );
}

await main();

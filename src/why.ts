import { existsSync } from "node:fs";
import { policyFromEnv } from "./approvers.js";
import { EXPLAIN_SYSTEM, ExplainError, explainerFromEnv, promptOf, shownAnswer, type Explainer, type ModelAnswer, type ShownAnswer } from "./explainer.js";
import { Ledger, LEDGER_PATH } from "./ledger.js";
import { reserveFromEnv } from "./reserve.js";
import { whyFacts, type LegendEntry, type WhyBuild } from "./why-facts.js";

// Asks the model reader's models why PayOnce did what it did on one invoice, or
// with "facts" prints exactly what would be sent and asks nothing. It opens the
// ledger read-only and calls nothing in Airwallex. It has no rate limit: it is
// one request per run, typed by a person. It loads .env itself if there is one,
// for the key and the settings the facts quote, because Node's
// --env-file-if-exists says the file is missing once for tsx and again for the
// script.
const USAGE: string = `Usage: pnpm why <INVOICE> [facts]
Without facts, asks the model reader's models why PayOnce did what it did on the invoice.
With facts, prints the facts and the legend exactly as they would be sent, and asks nothing.`;
const WIDTH: number = 80;

function loadEnv(): void {
  try {
    process.loadEnvFile(".env");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function fail(message: string): never {
  console.error(message);
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
    : `Legend (kept on this machine, never sent):\n${legend.map((entry: LegendEntry): string => `  ${entry.alias} = ${entry.value}`).join("\n")}`;
}

async function main(): Promise<void> {
  loadEnv();
  const [invoiceId, mode, ...rest] = process.argv.slice(2);
  if (invoiceId === undefined || invoiceId === "" || (mode !== undefined && mode !== "facts") || rest.length > 0) {
    fail(USAGE);
  }
  if (!existsSync(LEDGER_PATH)) {
    fail(`There is no ${LEDGER_PATH} here. Start an incident first.`);
  }
  const ledger: Ledger = new Ledger(LEDGER_PATH, true);
  const build: WhyBuild | undefined = whyFacts(ledger, invoiceId, {
    approvals: policyFromEnv(),
    reserve: reserveFromEnv(),
  });
  if (build === undefined) {
    fail(`${invoiceId} is not in the ledger`);
  }
  if (build.unrecognised > 0) {
    console.warn(`  why      ${build.unrecognised} unrecognised reason${build.unrecognised === 1 ? "" : "s"} on ${invoiceId}`);
  }

  if (mode === "facts") {
    console.log("System message:");
    console.log(EXPLAIN_SYSTEM);
    console.log("");
    console.log("User message:");
    console.log(promptOf(build.facts));
    console.log("");
    console.log(legendText(build.legend));
    return;
  }

  const explainer: Explainer | null = explainerFromEnv();
  if (explainer === null) {
    fail(
      `The model reader is off, so PayOnce cannot ask a model. Set READER_API_KEY in .env, or run pnpm why ${invoiceId} facts to see what would be sent`,
    );
  }
  let answer: ModelAnswer;
  try {
    answer = await explainer.explain(build.facts);
  } catch (error: unknown) {
    // Not process.exit: a request socket may still be closing, and exiting under
    // it trips an assertion in Node on Windows.
    console.error(error instanceof ExplainError ? error.message : `No model gave an explanation: ${String(error)}`);
    process.exitCode = 1;
    return;
  }
  const shown: ShownAnswer = shownAnswer(answer, build, Date.now(), false);
  const left: number = Object.values(build.facts.timelineLeftOut.linesNotPassedOn).reduce(
    (sum: number, count: number): number => sum + count,
    0,
  );
  console.log(`${invoiceId}: why PayOnce did what it did`);
  console.log(wrapped(shown.explanation));
  if (shown.notInFacts !== "") {
    console.log("");
    console.log(wrapped(`Not in the records: ${shown.notInFacts}`));
  }
  if (shown.aliasesLeft) {
    console.log("");
    console.log(legendText(shown.legend));
  }
  console.log("");
  console.log(
    wrapped(
      `Written by ${shown.model} from PayOnce's records for this invoice (${build.asOf.lines} timeline lines, ${left} not passed on)${shown.cut ? ", shortened to fit" : ""}. A model can be wrong: the timeline is the record.`,
    ),
  );
}

await main();

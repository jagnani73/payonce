import {
  closeIncident,
  coveredText,
  pendingClose,
  type CloseReview,
  type CoveredTransfer,
} from "./engine.js";
import { personName } from "./approvers.js";
import { Ledger, LEDGER_PATH } from "./ledger.js";
import { say } from "./printable.js";

const COVERS_FLAG: string = "--covers=";

function names(name: string, transfer: CoveredTransfer): boolean {
  return name === transfer.reference || name === transfer.transferId;
}

// Without a name it only shows what is waiting. With a name and a note of what
// the person confirmed, it closes the incident. A close that covers transfers
// listed under the invoice's request ids that do not match it names each one
// with --covers, by the bank's short reference or the transfer id, so the person
// confirms the list they were shown.
function main(): void {
  const invoiceId: string | undefined = process.argv[2];
  const closedBy: string | undefined = process.argv[3];
  const rest: string[] = process.argv.slice(4);
  const named: string[] = rest
    .filter((arg: string): boolean => arg.startsWith(COVERS_FLAG))
    .flatMap((arg: string): string[] => arg.slice(COVERS_FLAG.length).split(","))
    .map((name: string): string => name.trim())
    .filter((name: string): boolean => name !== "");
  const finding: string = rest
    .filter((arg: string): boolean => !arg.startsWith(COVERS_FLAG))
    .join(" ")
    .trim();
  if (invoiceId === undefined || invoiceId.startsWith(COVERS_FLAG)) {
    say("Usage: pnpm close <INVOICE> [NAME] [NOTE] [--covers=REF,...]");
    process.exitCode = 1;
    return;
  }

  const ledger: Ledger = new Ledger(LEDGER_PATH);
  const review: CloseReview | undefined = pendingClose(ledger, invoiceId);
  if (review === undefined) {
    say(`${invoiceId} is not waiting on a person to close it`);
    process.exitCode = 1;
    return;
  }

  const duplicate: boolean = review.kind === "duplicate" || review.kind === "unpaid";
  if (review.kind === "duplicate") {
    say(`${invoiceId} is held before paying, as a likely second bill for ${review.reference}`);
  } else if (review.kind === "unpaid") {
    say(`${invoiceId} is waiting on a person and nothing for it is paid`);
  } else {
    say(`${invoiceId} is paid and waiting on a person`);
    say(`  ${review.kind.padEnd(9)} ${review.reference ?? "no reference"} paid`);
  }
  say(`  because   ${review.reason}`);
  if (review.emails !== null) {
    say(`  emails    ${review.emails}`);
  }
  if (review.covered.length > 0) {
    say("  covers    transfers listed under its request ids that do not match it:");
    for (const transfer of review.covered) {
      say(`            ${coveredText(transfer)}`);
    }
  }
  const covers: string =
    review.covered.length === 0
      ? ""
      : ` ${COVERS_FLAG}${review.covered.map((transfer: CoveredTransfer): string => transfer.reference).join(",")}`;
  if (closedBy === undefined || closedBy.startsWith(COVERS_FLAG) || finding === "") {
    say(
      `To close it${duplicate ? " without paying" : ""}: pnpm close ${invoiceId} <NAME> <NOTE>${covers}`,
    );
    return;
  }
  let by: string;
  try {
    by = personName(closedBy);
  } catch (error: unknown) {
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  // Every transfer the close covers, and nothing else, so a list that changed
  // since the person looked is refused.
  const unknown: string[] = named.filter(
    (name: string): boolean => !review.covered.some((transfer: CoveredTransfer): boolean => names(name, transfer)),
  );
  const missing: boolean = review.covered.some(
    (transfer: CoveredTransfer): boolean => !named.some((name: string): boolean => names(name, transfer)),
  );
  if (missing || unknown.length > 0) {
    say(
      review.covered.length === 0
        ? `Not closed: nothing listed under ${invoiceId}'s request ids needs naming, so leave out --covers (${unknown.join(", ")} not on file)`
        : `Not closed: name every transfer listed above, and only those${unknown.length > 0 ? ` (${unknown.join(", ")} not on the list)` : ""}: pnpm close ${invoiceId} <NAME> <NOTE>${covers}`,
    );
    process.exitCode = 1;
    return;
  }
  closeIncident(
    ledger,
    invoiceId,
    by,
    finding,
    review.covered.map((transfer: CoveredTransfer): string => transfer.transferId),
  );
  say(duplicate ? "Closed without paying" : "Closed without a second payment");
}

main();

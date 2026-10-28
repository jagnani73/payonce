import { closeIncident, pendingClose, type CloseReview } from "./engine.js";
import { Ledger, LEDGER_PATH } from "./ledger.js";

// Without a name it only shows what is waiting. With a name and a note of what
// the person confirmed, it closes the incident.
function main(): void {
  const invoiceId: string | undefined = process.argv[2];
  const closedBy: string | undefined = process.argv[3];
  const finding: string = process.argv.slice(4).join(" ").trim();
  if (invoiceId === undefined) {
    console.log("Usage: pnpm close <INVOICE> [NAME] [NOTE]");
    process.exitCode = 1;
    return;
  }

  const ledger: Ledger = new Ledger(LEDGER_PATH);
  const review: CloseReview | undefined = pendingClose(ledger, invoiceId);
  if (review === undefined) {
    console.log(`${invoiceId} is not waiting on a person to close it`);
    process.exitCode = 1;
    return;
  }

  const duplicate: boolean = review.kind === "duplicate" || review.kind === "unpaid";
  if (review.kind === "duplicate") {
    console.log(`${invoiceId} is held before paying, as a likely second bill for ${review.reference}`);
  } else if (review.kind === "unpaid") {
    console.log(`${invoiceId} is waiting on a person and has sent nothing`);
  } else {
    console.log(`${invoiceId} is paid and waiting on a person`);
    console.log(`  ${review.kind.padEnd(9)} ${review.reference ?? "no reference"} paid`);
  }
  console.log(`  because   ${review.reason}`);
  if (review.emails !== null) {
    console.log(`  emails    ${review.emails}`);
  }
  if (closedBy === undefined || finding === "") {
    console.log(
      `To close it${duplicate ? " without paying" : ""}: pnpm close ${invoiceId} <NAME> <NOTE>`,
    );
    return;
  }
  closeIncident(ledger, invoiceId, closedBy, finding);
  console.log(duplicate ? "Closed without paying" : "Closed without a second payment");
}

main();

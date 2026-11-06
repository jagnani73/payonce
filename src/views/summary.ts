import { keptFailedLive } from "../domain/live.js";
import { reasonText } from "../domain/reasons.js";
import type { InvoiceSnapshot, Situation } from "../domain/situation.js";
import { timeAt, timed, type Timed, type TimePart } from "../domain/timed.js";
import { summarise } from "../reader/emails.js";
import type { Attempt, Obligation, OutsidePayout } from "../store/ledger.js";
import { shownReference } from "../text/printable.js";
import type { FailureView, HeadroomLine, SummaryBullet } from "./contract.js";
import { failureView, plural } from "./parts.js";

// "What happened", in at most five bullets from ledger fields and the
// situation, by fixed templates. No model writes any of it.

// " at" and the time, or nothing when the time is not on file.
function atTime(at: string | null): Timed {
  const time: TimePart | null = timeAt(at);
  return time === null ? [] : timed(" at ", time);
}

function named(attempt: Attempt): string {
  const kind: string = attempt.kind === "replacement" ? "Replacement" : "Original";
  return attempt.reference === null ? `The ${attempt.kind}` : `${kind} ${shownReference(attempt.reference)}`;
}

function refsOf(...references: (string | null)[]): SummaryBullet["refs"] {
  return references
    .filter((reference: string | null): reference is string => reference !== null)
    .map((reference: string): { reference: string } => ({ reference: shownReference(reference) }));
}

// A transfer the ledger keeps failed that the bank has live or paid, as the
// Transfers tab shows it: most often one Airwallex listed only after PayOnce had
// marked it never sent.
function lateText(attempt: Attempt): Timed {
  const where: string = attempt.bankStatus === "PAID" ? "was paid by the bank after all" : "is with the bank after all";
  return attempt.foundLateAt === null
    ? [`${named(attempt)} ${where}, though PayOnce had marked it failed.`]
    : timed(`${named(attempt)} ${where}: Airwallex listed it`, atTime(attempt.foundLateAt), " after PayOnce had marked it as never sent.");
}

function happened(snapshot: InvoiceSnapshot): SummaryBullet | null {
  const late: Attempt | undefined = snapshot.attempts.find(keptFailedLive);
  if (late !== undefined) {
    return { lead: "Happened", text: lateText(late), refs: refsOf(late.reference) };
  }
  const failed: Attempt | undefined = snapshot.attempts.find((attempt: Attempt): boolean => attempt.state === "failed");
  if (failed !== undefined) {
    const index: number = snapshot.attempts.indexOf(failed);
    const failure: FailureView | null = failureView(failed.failureCode);
    if (failed.transferId === null) {
      return {
        lead: "Happened",
        text: [failure === null ? `${named(failed)} was never sent.` : `Airwallex refused the ${failed.kind} (${failure.code}).`],
        refs: [],
      };
    }
    const words: string =
      failure === null
        ? " with no failure code"
        : `: ${failure.words} (${failure.resendable ? "a resend can fix it" : "a resend cannot fix it"})`;
    return {
      lead: "Happened",
      text: timed(`${named(failed)} failed at the bank`, atTime(snapshot.times.failedAt[index] ?? null), `${words}.`),
      refs: refsOf(failed.reference),
    };
  }
  const payout: OutsidePayout | undefined = snapshot.payouts[0];
  if (snapshot.obligation.origin === "outside" || payout !== undefined) {
    return {
      lead: "Happened",
      text: [
        payout === undefined
          ? "A payout sent outside PayOnce was found in Airwallex's transfer list."
          : `A payout sent outside PayOnce, ${shownReference(payout.reference)}, was found in Airwallex's transfer list.`,
      ],
      refs: refsOf(payout?.reference ?? null),
    };
  }
  const first: Attempt | undefined = snapshot.attempts[0];
  if (first !== undefined && first.transferId !== null) {
    return { lead: "Happened", text: timed(`${named(first)} went to the bank`, atTime(first.bankCreatedAt), "."), refs: refsOf(first.reference) };
  }
  return null;
}

function payonceDid(snapshot: InvoiceSnapshot): SummaryBullet | null {
  const o: Obligation = snapshot.obligation;
  const replacement: Attempt | undefined = snapshot.attempts.find(
    (attempt: Attempt): boolean => attempt.kind === "replacement" && attempt.approvalId === null,
  );
  if (snapshot.reason !== null && o.escalationReason !== "") {
    return {
      lead: "PayOnce did",
      text: [`It sent this to a person: ${reasonText(snapshot.reason)}.`],
      refs: o.duplicateOf.map((invoiceId: string): { invoiceId: string } => ({ invoiceId })),
    };
  }
  if (replacement !== undefined) {
    return {
      lead: "PayOnce did",
      text: [
        replacement.reference === null
          ? "It sent a replacement by itself."
          : `It sent replacement ${shownReference(replacement.reference)} by itself.`,
      ],
      refs: refsOf(replacement.reference),
    };
  }
  return o.state === "settled" && snapshot.times.closedLine === null
    ? { lead: "PayOnce did", text: ["It closed the payment when the bank paid it."], refs: [] }
    : null;
}

export function summaryOf(snapshot: InvoiceSnapshot, situation: Situation, headroom: HeadroomLine | null): SummaryBullet[] {
  const bullets: (SummaryBullet | null)[] = [
    happened(snapshot),
    payonceDid(snapshot),
    { lead: "Now", text: situation.next, refs: [] },
    snapshot.emails.count === 0
      ? null
      : {
          lead: "Supplier",
          text: [
            `${plural(snapshot.emails.count, "email", "emails")}: ${summarise(
              snapshot.emails.claimsNonReceipt,
              snapshot.emails.asksForNewBankDetails,
              snapshot.emails.asksNotToPay,
            )}.`,
          ],
          refs: [],
        },
    headroom?.after === null || headroom === null || situation.state !== "needs-approval"
      ? null
      : { lead: "Cash", text: [`${headroom.wallet} headroom after this payment: ${headroom.after.text}.`], refs: [] },
  ];
  return bullets.filter((bullet: SummaryBullet | null): bullet is SummaryBullet => bullet !== null);
}

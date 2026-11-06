import { findBeneficiary, type BeneficiaryRecord } from "../airwallex/beneficiaries.js";
import { getTransfer, type Transfer, type TransferBankDetails } from "../airwallex/transfers.js";
import {
  accountKeyOf,
  heldTermsFor,
  paymentAmount,
  type DuplicateEvidence,
  type HeldPaymentTerms,
} from "../domain/approval.js";
import { signoffsNeeded, type SignoffRule } from "../domain/approvers.js";
import { routeKeyOf } from "../domain/assess.js";
import { namingNotToPay } from "../domain/decide.js";
import { likelyDuplicates } from "../domain/duplicates.js";
import { debitCurrency } from "../domain/reserve.js";
import { emailEvidence, type SupplierEmail } from "../reader/emails.js";
import {
  crossCurrency,
  holdsAccount,
  RailOutageError,
  type Approval,
  type Attempt,
  type BankChange,
  type LastPaid,
  type Lease,
  type Ledger,
  type Obligation,
  type Outage,
  type RunRow,
  type ScannedObligation,
} from "../store/ledger.js";
import { withCurrencyLock } from "./currency-lock.js";
import { emailsNotRead, readNewEmails, storedFindings } from "./emails.js";
import { RETRY_FAILED_LOOK_MS, type Engine, type NextLook, type Rate, type StoredFindings } from "./engine.js";
import { anyLive } from "./facts.js";
import { listOf, note } from "./lines.js";
import { holdForOutsidePayout, linkUnseenPayouts, syncOutsidePayouts } from "./outside.js";
import { rateFor } from "./rates.js";
import { PAID_ONLY_BY_ITSELF } from "./reason-text.js";
import { awaitApproval, voidIfStale } from "./requests.js";
import { requireAccount, send, waitForBank } from "./send.js";
import { arrivalOf } from "./terms.js";

// Why an invoice with emails on file waits: the reader failed on one, or one
// arrived after the last read.
const EMAILS_NOT_READ: string = "supplier emails are on file that could not be read";

// What the ledger shows of the invoices a held one looks like a second bill for,
// listed or found now: each one's state and the payments for it that reached the
// bank. duplicateEvidence reads its terms from these, so a release compares this
// under the lease with what it was when the terms were taken.
function duplicatesOnFile(ledger: Ledger, held: Obligation): string {
  const found: string[] = likelyDuplicates(ledger, held).map(
    (other: ScannedObligation): string => other.invoiceId,
  );
  return JSON.stringify(
    [...new Set([...held.duplicateOf, ...found])].map((invoiceId: string): unknown[] => [
      invoiceId,
      ledger.obligation(invoiceId)?.state ?? null,
      [...ledger.attempts(invoiceId), ...ledger.outsidePayouts(invoiceId)]
        .filter((payment: { transferId: string | null }): boolean => payment.transferId !== null)
        .map((payment: { transferId: string | null; state: string }): string[] => [
          payment.transferId ?? "",
          payment.state,
        ]),
    ]),
  );
}

// The invoices a held one looks like a second bill for, as they stand now, and
// whether the payment that paid each, or one still with the bank, went to the
// account with this accountKey.
async function duplicateEvidence(
  engine: Engine,
  obligation: Obligation,
  accountKey: string,
): Promise<DuplicateEvidence[]> {
  const evidence: DuplicateEvidence[] = [];
  for (const invoiceId of obligation.duplicateOf) {
    const other: Obligation | undefined = engine.ledger.obligation(invoiceId);
    if (other === undefined) {
      continue;
    }
    const payments: { reference: string | null; transferId: string | null; state: string }[] = [
      ...engine.ledger.attempts(invoiceId),
      ...engine.ledger.outsidePayouts(invoiceId),
    ].filter((payment: { transferId: string | null }): boolean => payment.transferId !== null);
    const paid: { reference: string | null; transferId: string | null } | undefined = payments.find(
      (payment: { state: string }): boolean => payment.state === "paid",
    );
    const sent: { transferId: string | null } | undefined =
      paid ?? payments.find((payment: { state: string }): boolean => payment.state === "in_flight");
    let sameAccount: boolean | null = null;
    if (sent !== undefined && sent.transferId !== null) {
      const details: TransferBankDetails | undefined = (
        await getTransfer(engine.client, sent.transferId)
      ).beneficiary?.bank_details;
      sameAccount = details === undefined ? null : accountKeyOf(details) === accountKey;
    }
    evidence.push({ invoiceId, state: other.state, paidBy: paid?.reference ?? null, sameAccount });
  }
  return evidence;
}

// An invoice held before paying waits for a person. Once the approvers approve
// paying it, the agent sends the original and the invoice carries on like any
// other. A person can instead close it without paying. A payout for it sent
// outside PayOnce holds everything, as it does on any invoice.
export async function continueHeld(engine: Engine, obligation: Obligation): Promise<NextLook> {
  const invoiceId: string = obligation.invoiceId;
  if (anyLive(await syncOutsidePayouts(engine, invoiceId))) {
    return holdForOutsidePayout(engine, invoiceId);
  }
  // A person decided not to pay it, and a payout sent outside PayOnce reopened it.
  // That payout has failed, so it is closed again and nobody is asked to pay it.
  // A transfer found under one of its request ids that does not match it leaves
  // that to a person, on the close card.
  if (obligation.rejectedBy !== null) {
    if (engine.ledger.rejectAgain(invoiceId)) {
      note(
        engine.ledger,
        invoiceId,
        "closed",
        `Closed without paying again. The payout sent outside PayOnce failed, and ${obligation.rejectedBy} had already closed this invoice without paying`,
      );
    } else {
      note(
        engine.ledger,
        invoiceId,
        "approval",
        `Waiting on a person to close it again. ${obligation.rejectedBy} closed this invoice without paying, and PayOnce asks nobody to approve paying it`,
        "waiting",
      );
    }
    return null;
  }
  // A held invoice reads its emails like any other, and its terms carry what
  // they say. Until every email is read, nothing is offered for approval, and
  // the look comes again a minute later.
  await readNewEmails(engine, obligation, true);
  const emails: SupplierEmail[] = engine.ledger.emails(invoiceId);
  const { findings, stored }: { findings: StoredFindings; stored: boolean } = storedFindings(
    engine.ledger,
    invoiceId,
    emails,
  );
  // A supplier who asks to hold, cancel or not pay the invoice is named in the
  // reason it is held for, so the alert, the request and the card say so.
  const reason: string = namingNotToPay(obligation.escalationReason, findings.asksNotToPay === true);
  if (reason !== obligation.escalationReason) {
    // Another process changed the reason or the invoice since this look read it.
    // Terms built on the reason read would open a request the next look voids, so
    // the look comes again at once and reads the invoice as it is then.
    if (!engine.ledger.rewordEscalation(invoiceId, obligation.escalationReason, reason)) {
      return Date.now();
    }
    note(engine.ledger, invoiceId, "decision", `Escalate: ${reason}`, "decision");
  }
  if (emailsNotRead(findings, stored, emails)) {
    // An email delivered by another process while the others were read is read
    // on the next look, at once. One the reader failed on is tried a minute later.
    const failed: boolean = findings.unread === true;
    waitWithoutPaying(
      engine,
      invoiceId,
      EMAILS_NOT_READ,
      failed
        ? "Waiting on a person. Supplier emails are on file that PayOnce could not read yet, so it asks nobody to approve paying this invoice. It tries reading them again in a minute"
        : "Waiting on a person. A supplier email arrived while PayOnce read the others, so it asks nobody to approve paying this invoice until it has read that one too",
    );
    return failed ? Date.now() + RETRY_FAILED_LOOK_MS : Date.now();
  }
  const evidence: string | null =
    emails.length === 0 ? null : emailEvidence(findings.summary, emails, obligation.supplierDomain);
  // The invoices it was held for, and any that match it now: one started after
  // it, or one that came first while this one was held for another reason.
  const added: string[] = likelyDuplicates(engine.ledger, obligation)
    .map((other: ScannedObligation): string => other.invoiceId)
    .filter((other: string): boolean => !obligation.duplicateOf.includes(other));
  const held: Obligation = {
    ...obligation,
    escalationReason: reason,
    duplicateOf: [...obligation.duplicateOf, ...added],
  };
  if (added.length > 0) {
    engine.ledger.setDuplicateOf(invoiceId, held.duplicateOf);
    note(
      engine.ledger,
      invoiceId,
      "warning",
      `This invoice also looks like a second bill for ${listOf(added)}: the same supplier and amount, and the same invoice number apart from case, spacing, leading zeros or letters added at the end`,
    );
  }
  const record: BeneficiaryRecord | undefined = await findBeneficiary(
    engine.client,
    obligation.beneficiaryId,
  );
  const bankDetails: TransferBankDetails | undefined = record?.beneficiary?.bank_details;
  if (bankDetails === undefined) {
    return waitWithoutPaying(
      engine,
      invoiceId,
      "the beneficiary is no longer in Airwallex",
      "Waiting on a person. The beneficiary is no longer in Airwallex, so there is nothing to pay it to. Close the invoice without paying",
    );
  }
  const accountKey: string = accountKeyOf(bankDetails);
  // A pay run approved one account, every detail of it. Another is paid only once
  // a callback verified it, and then by two approvers.
  const row: RunRow | undefined =
    obligation.runRowId === null ? undefined : engine.ledger.runRow(obligation.runRowId);
  if (
    row !== undefined &&
    row.accountKey !== accountKey &&
    engine.ledger.verifiedBankChange(obligation.beneficiaryId, bankDetails) === undefined
  ) {
    return waitWithoutPaying(
      engine,
      invoiceId,
      "the bank details on file are not the ones the pay run approved",
      "Waiting on a person. The bank details on file are not the ones the pay run approved, so PayOnce does not pay this invoice. Close it without paying, or restore the approved details in Airwallex and check again",
    );
  }
  // Any other held invoice: an account PayOnce has not paid this supplier, when it
  // has paid them another, is paid only once a person has called the supplier on
  // the number on file and the record matches what they confirmed, as for a
  // replacement. A pay run approved its row's account against the one PayOnce
  // last paid already.
  const last: LastPaid | undefined =
    row === undefined ? engine.ledger.lastPaidTransfer(obligation.beneficiaryId) : undefined;
  const lastElsewhere: boolean = last !== undefined && !holdsAccount(last, bankDetails);
  const bankChange: BankChange | null = lastElsewhere
    ? (engine.ledger.verifiedBankChange(obligation.beneficiaryId, bankDetails) ?? null)
    : null;
  if (last !== undefined && lastElsewhere) {
    note(
      engine.ledger,
      invoiceId,
      "warning",
      `The bank details on file are not the ones PayOnce last paid this supplier, with ${last.reference ?? last.transferId}`,
      "last-paid",
    );
    if (bankChange === null) {
      return waitWithoutPaying(
        engine,
        invoiceId,
        "the bank details on file have not been verified by a callback",
        obligation.supplierPhone === null
          ? "Waiting on a person. The bank details on file are not the ones PayOnce last paid this supplier, and no phone number is on file to verify them by calling the supplier back. Close the invoice without paying, or restore the details PayOnce last paid in Airwallex and check again"
          : `Waiting on a person to call the supplier on ${obligation.supplierPhone}, the number on file, and record the callback. PayOnce pays an account it has not paid this supplier before only after that`,
      );
    }
  }
  const onFile: string = duplicatesOnFile(engine.ledger, held);
  const duplicates: DuplicateEvidence[] = await duplicateEvidence(engine, held, accountKey);
  // Paid from another currency's wallet, it is approved at a quote. Nothing has
  // been sent, so no fee is known yet.
  const rate: Rate | null = crossCurrency(obligation) ? await rateFor(engine, obligation, null) : null;
  const terms: HeldPaymentTerms = heldTermsFor(
    held,
    bankDetails,
    duplicates,
    rate?.fx ?? null,
    evidence,
    arrivalOf(engine.ledger, obligation, bankDetails),
    bankChange,
  );
  // A second bill paid to a different account from the first is the pattern of an
  // invoice resent with new bank details, so it needs two approvers.
  const elsewhere: DuplicateEvidence | undefined = duplicates.find(
    (duplicate: DuplicateEvidence): boolean => duplicate.sameAccount === false,
  );
  if (elsewhere !== undefined) {
    note(
      engine.ledger,
      invoiceId,
      "warning",
      `The account on file for this invoice is not the one ${elsewhere.invoiceId} was sent to`,
      "bank-details",
    );
  }
  // Two approvers for a payee PayOnce has never paid on a person's approval, and
  // for an account it has not paid this supplier before, as for a pay run's row.
  const payee: SignoffRule | null = payeeRule(engine, obligation, bankDetails);
  const rule: SignoffRule =
    elsewhere !== undefined
      ? { needed: 2, why: `it pays a different account from the one ${elsewhere.invoiceId} was sent to` }
      : (payee ??
        signoffsNeeded(engine.approvals, paymentAmount(terms), false, obligation.startedBy));
  const approval: Approval | undefined = engine.ledger.latestApproval(invoiceId);
  if (approval?.state !== "approved" || voidIfStale(engine, held, approval, terms, rule)) {
    return awaitApproval(engine, held, terms, rule, rate, routeKeyOf(bankDetails));
  }
  // Paying it waits for the end of an outage on its rail, with the approval kept.
  // releaseFor refuses it too.
  const outage: Outage | undefined = engine.ledger.activeOutage(obligation.currency, obligation.transferMethod);
  if (outage !== undefined) {
    throw new RailOutageError(outage, "approved");
  }

  if (
    (await linkUnseenPayouts(engine, invoiceId)) ||
    anyLive(engine.ledger.outsidePayouts(invoiceId))
  ) {
    return Date.now();
  }
  return withCurrencyLock(engine.ledger, debitCurrency(obligation), async (lease: Lease): Promise<NextLook> => {
    // Checked before the invoice is released, so a failed check leaves it held
    // with its approval unspent.
    const route: string = await requireAccount(engine, obligation, terms.accountKey, "payment was approved");
    // Another process may have voided the approval, closed the invoice or tied a
    // payout to it since it was read, or changed what the terms say of the
    // invoices it looks like a second bill for. A match the terms do not list,
    // even one found before onFile was taken, refuses it too. The next look sees
    // which, and adds a new match to the terms.
    const attempt: Attempt | undefined = engine.ledger.releaseFor(
      invoiceId,
      approval.id,
      lease,
      (): boolean =>
        duplicatesOnFile(engine.ledger, held) === onFile &&
        engine.ledger.emailCount(invoiceId) === emails.length &&
        likelyDuplicates(engine.ledger, held).every((other: ScannedObligation): boolean =>
          held.duplicateOf.includes(other.invoiceId),
        ),
      route,
    );
    if (attempt === undefined) {
      return Date.now();
    }
    note(
      engine.ledger,
      invoiceId,
      "approval",
      `Approval by ${approval.approver} matches the current terms, so PayOnce pays the invoice`,
    );
    const original: Transfer = await send(engine, { ...held, state: "open" }, attempt);
    return waitForBank(engine, invoiceId, "original", original);
  });
}

// Two approvers for a payment to a beneficiary PayOnce has never paid, to one it
// paid only before it kept which account each payment went to, to an account it
// has not paid this supplier before, by the account its last checked payment
// kept, or to one PayOnce has paid only by itself, with no person approving any
// payment to it (paidOnApproval). Null when PayOnce last paid this very account
// and a person has approved a payment to the beneficiary.
function payeeRule(engine: Engine, obligation: Obligation, bankDetails: TransferBankDetails): SignoffRule | null {
  const last: LastPaid | undefined = engine.ledger.lastPaidTransfer(obligation.beneficiaryId);
  if (last === undefined) {
    return engine.ledger.lastPaidUnchecked(obligation.beneficiaryId) === undefined
      ? { needed: 2, why: "PayOnce has never paid this beneficiary" }
      : { needed: 2, why: "PayOnce paid this supplier before it kept which account each payment went to" };
  }
  if (!holdsAccount(last, bankDetails)) {
    return { needed: 2, why: "it pays an account PayOnce has not paid this supplier before" };
  }
  return engine.ledger.paidOnApproval(obligation.beneficiaryId)
    ? null
    : { needed: 2, why: PAID_ONLY_BY_ITSELF };
}

// A held invoice with nothing a person could approve paying: any open request is
// withdrawn, and the timeline says what the invoice waits on.
function waitWithoutPaying(
  engine: Engine,
  invoiceId: string,
  withdrawn: string,
  waiting: string,
): NextLook {
  if (engine.ledger.voidOpenApprovals(invoiceId)) {
    note(engine.ledger, invoiceId, "approval", `Approval request withdrawn: ${withdrawn}`);
  }
  note(engine.ledger, invoiceId, "approval", waiting, "waiting");
  return null;
}

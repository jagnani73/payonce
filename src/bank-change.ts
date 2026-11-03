import {
  getBeneficiary,
  updateBankDetails,
  type BeneficiaryRecord,
} from "./airwallex/beneficiaries.js";
import { getTransfer, type Transfer, type TransferBankDetails } from "./airwallex/transfers.js";
import { personName } from "./approvers.js";
import { bankDetailsKey, NOT_ROUTING_FIELDS, routeValue } from "./assess.js";
import { note, type Engine } from "./engine.js";
import {
  liveAtBank,
  type Attempt,
  type Obligation,
  type OutsidePayout,
  type PayRunRow,
  type ScannedObligation,
} from "./ledger.js";
import { wasRejected } from "./payments.js";

// The bank details a person may change after a callback, with the label the page
// shows. Only the fields the supplier's record already has are offered.
const EDITABLE_FIELDS: Record<string, string> = {
  account_name: "Account name",
  account_number: "Account number",
  account_routing_value1: "Routing number",
  iban: "IBAN",
  swift_code: "SWIFT code",
  bank_name: "Bank name",
};

// Account numbers are shown only by their last four characters.
const MASKED_FIELDS: ReadonlySet<string> = new Set<string>(["account_number", "iban"]);
// Airwallex's own hash of the details. It changes with them, so it is not a
// detail a person confirms.
const FINGERPRINT: string = "fingerprint";
const FIELD_PATTERN: RegExp = /^[\p{L}\p{N} .,&'()/-]{1,70}$/u;
const MAX_NAME_LENGTH: number = 80;
const MAX_CONFIRMED_LENGTH: number = 200;
const CLOCK_SKEW_MS: number = 5 * 60_000;

export interface BankField {
  name: string;
  label: string;
  // What the record holds now, with account numbers cut to their last four.
  current: string;
}

// What a person needs to record a callback, or why one cannot be recorded now.
export interface BankChangeForm {
  phoneOnFile: string | null;
  fields: BankField[];
  blocked: string | null;
}

// What the person who called the supplier records. details holds the new bank
// details they read back on the call, by field name.
export interface CallbackInput {
  calledBy: string;
  numberCalled: string;
  calledAt: string;
  spokeTo: string;
  confirmed: string;
  details: Record<string, string>;
}

// Airwallex may change case or spacing when it stores a value, so values compare
// as routeKeyOf reads them.
function sameValue(a: unknown, b: string): boolean {
  return typeof a === "string" && routeValue(a) === routeValue(b);
}

function digits(phone: string): string {
  return phone.replace(/\D/g, "");
}

// The number dialled is the one on file, with or without its country code.
function isNumberOnFile(dialled: string, onFile: string): boolean {
  const typed: string = digits(dialled);
  const file: string = digits(onFile);
  return typed === file || (typed.length >= 10 && file.endsWith(typed));
}

// True when the details hold the account the entered fields name. Airwallex
// rewrites a bank name it works out from the routing number, so, as routeKeyOf
// reads details, every field but NOT_ROUTING_FIELDS counts.
function holdsAccount(details: TransferBankDetails, entered: Record<string, string>): boolean {
  return Object.entries(entered).every(
    ([name, value]: [string, string]): boolean =>
      NOT_ROUTING_FIELDS.has(name) || sameValue(details[name], value),
  );
}

function shown(field: string, value: unknown): string {
  const text: string = typeof value === "string" ? value : "";
  return MASKED_FIELDS.has(field) && text.length > 4 ? `ending ${text.slice(-4)}` : text;
}

function withoutFingerprint(details: TransferBankDetails | undefined): TransferBankDetails {
  const { [FINGERPRINT]: _fingerprint, ...rest } = details ?? {};
  return rest;
}

// The payment new bank details are compared with, and how people read it: the
// invoice's original, or for an invoice held before paying, the payment PayOnce
// last made to this supplier that the bank paid. Undefined when there is neither.
interface ComparedPayment {
  transferId: string;
  what: string;
}

function comparedPayment(engine: Engine, obligation: Obligation): ComparedPayment | undefined {
  // An original Airwallex refused never became a transfer, so the one paid on an
  // approval after it is the one to compare with.
  const original: Attempt | undefined = engine.ledger
    .attempts(obligation.invoiceId)
    .filter((attempt: Attempt): boolean => attempt.kind === "original" && attempt.transferId !== null)
    .at(-1);
  if (original?.transferId !== undefined && original.transferId !== null) {
    return { transferId: original.transferId, what: "original payment" };
  }
  const last: { transferId: string } | undefined = engine.ledger.lastPaidTransfer(obligation.beneficiaryId);
  return last === undefined
    ? undefined
    : { transferId: last.transferId, what: "payment PayOnce last made to this supplier" };
}

// True when another open invoice paid to the same beneficiary is about to pay it:
// a payment not yet with the bank, an approval not yet spent, or a pay run row
// approved or released and not sent yet. Changing the record then would change
// the account that payment goes to outside its turn.
function anotherPaymentStarting(engine: Engine, obligation: Obligation): boolean {
  return (
    engine.ledger.scannedObligations().some(
      (other: ScannedObligation): boolean =>
        other.invoiceId !== obligation.invoiceId &&
        other.beneficiaryId === obligation.beneficiaryId &&
        other.state !== "settled" &&
        other.state !== "rejected" &&
        (engine.ledger
          .attempts(other.invoiceId)
          .some((attempt: Attempt): boolean => attempt.state === "pending") ||
          engine.ledger.latestApproval(other.invoiceId)?.state === "approved"),
    ) ||
    engine.ledger
      .payRunRows()
      .some(
        (row: PayRunRow): boolean =>
          row.beneficiaryId === obligation.beneficiaryId && row.invoiceId !== obligation.invoiceId,
      )
  );
}

// Bank details can change only while the invoice is with a person and nothing
// is with the bank or paid: every payment PayOnce sent has failed, or it was held
// before paying a supplier PayOnce has paid before, no payout sent outside
// PayOnce is live, and no other invoice to the supplier is about to pay.
function blockedReason(engine: Engine, obligation: Obligation): string | null {
  if (obligation.supplierPhone === null) {
    return "No phone number is on file for this supplier, so there is no number to call back";
  }
  if (obligation.state !== "escalated") {
    return obligation.state === "settled"
      ? "The incident is closed"
      : "The incident is not waiting on a person";
  }
  const attempts: Attempt[] = engine.ledger.attempts(obligation.invoiceId);
  if (attempts.some(liveAtBank)) {
    return "A payment for this invoice is still with the bank or paid, so its bank details stay as they are";
  }
  if (comparedPayment(engine, obligation) === undefined) {
    return engine.ledger.lastPaidUnchecked(obligation.beneficiaryId) === undefined
      ? "PayOnce has not paid this supplier before, so there are no bank details to compare new ones with. Approve paying the account on file, or close the invoice without paying"
      : "PayOnce paid this supplier only before it kept which account each payment went to, so there are no checked bank details to compare new ones with. Approve paying the account on file, or close the invoice without paying";
  }
  if (
    engine.ledger
      .outsidePayouts(obligation.invoiceId)
      .some((payout: OutsidePayout): boolean => payout.state !== "failed")
  ) {
    return "A payout for this invoice sent outside PayOnce may already pay it";
  }
  if (anotherPaymentStarting(engine, obligation)) {
    return "Another invoice to this supplier is about to be paid. Record the callback once it has gone to the bank";
  }
  return null;
}

export async function bankChangeForm(engine: Engine, obligation: Obligation): Promise<BankChangeForm> {
  const blocked: string | null = blockedReason(engine, obligation);
  if (blocked !== null) {
    return { phoneOnFile: obligation.supplierPhone, fields: [], blocked };
  }
  const record: BeneficiaryRecord = await getBeneficiary(engine.client, obligation.beneficiaryId);
  const details: TransferBankDetails = record.beneficiary?.bank_details ?? {};
  return {
    phoneOnFile: obligation.supplierPhone,
    fields: Object.entries(EDITABLE_FIELDS)
      .filter(([name]: [string, string]): boolean => typeof details[name] === "string")
      .map(([name, label]: [string, string]): BankField => ({
        name,
        label,
        current: shown(name, details[name]),
      })),
    blocked: null,
  };
}

function requireText(value: string, what: string, max: number): string {
  const text: string = value.trim();
  if (text === "" || text.length > max) {
    throw new Error(`Enter ${what}`);
  }
  return text;
}

// Records a person's callback to the supplier on the number on file, and the new
// bank details the supplier confirmed on it, then updates the supplier's record
// in Airwallex. The details come only from the person: never from an email or
// the reader. The agent then offers a replacement to the new account under new
// terms, or for an invoice held before paying the first payment to it, which two
// approvers must approve, and the person who recorded the callback is not one of
// them. Call it in the invoice's turn, and have the agent
// look at the invoice afterwards whatever happens.
export async function recordBankChange(
  engine: Engine,
  invoiceId: string,
  input: CallbackInput,
): Promise<void> {
  const obligation: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (obligation === undefined) {
    throw new Error(`${invoiceId} is not in the ledger`);
  }
  const blocked: string | null = blockedReason(engine, obligation);
  if (blocked !== null || obligation.supplierPhone === null) {
    throw new Error(blocked ?? "No phone number is on file for this supplier");
  }
  const calledBy: string = personName(input.calledBy);
  const spokeTo: string = requireText(input.spokeTo, "who you spoke to", MAX_NAME_LENGTH);
  const confirmed: string = requireText(input.confirmed, "what they confirmed", MAX_CONFIRMED_LENGTH);
  if (!isNumberOnFile(input.numberCalled, obligation.supplierPhone)) {
    throw new Error(
      `That is not the number on file (${obligation.supplierPhone}). Call the supplier on the number on file, never on one from an email`,
    );
  }

  const compared: ComparedPayment | undefined = comparedPayment(engine, obligation);
  if (compared === undefined) {
    throw new Error("PayOnce has no payment to this supplier to compare new bank details with");
  }
  const original: Transfer = await getTransfer(engine.client, compared.transferId);
  const originalDetails: TransferBankDetails = original.beneficiary?.bank_details ?? {};
  const calledAtMs: number = Date.parse(input.calledAt);
  const sentAtMs: number = Date.parse(original.created_at);
  if (
    !Number.isFinite(calledAtMs) ||
    calledAtMs > Date.now() + CLOCK_SKEW_MS ||
    (Number.isFinite(sentAtMs) && calledAtMs < sentAtMs)
  ) {
    throw new Error(`Enter when you called, after the ${compared.what} was sent`);
  }

  const record: BeneficiaryRecord = await getBeneficiary(engine.client, obligation.beneficiaryId);
  const current: TransferBankDetails = record.beneficiary?.bank_details ?? {};
  for (const name of Object.keys(input.details)) {
    if (!(name in EDITABLE_FIELDS) || typeof current[name] !== "string") {
      throw new Error(`${name} cannot be changed here`);
    }
  }
  // A person confirms only the fields on the form, so every other detail must be
  // the one the compared payment went to, or it would pass as verified unseen.
  const unconfirmed: string[] = Object.keys(withoutFingerprint(current)).filter(
    (name: string): boolean =>
      !(name in EDITABLE_FIELDS) && JSON.stringify(current[name]) !== JSON.stringify(originalDetails[name]),
  );
  if (unconfirmed.length > 0) {
    throw new Error(
      `The supplier's record has other details that differ from the ${compared.what} (${unconfirmed.join(", ")}). Correct the record in Airwallex first`,
    );
  }
  const entered: Record<string, string> = {};
  for (const name of Object.keys(EDITABLE_FIELDS)) {
    if (typeof current[name] !== "string") {
      continue;
    }
    const value: string = (input.details[name] ?? "").trim().replace(/\s+/g, " ");
    if (!FIELD_PATTERN.test(value)) {
      throw new Error(`Enter the new ${EDITABLE_FIELDS[name]?.toLowerCase()} the supplier confirmed`);
    }
    entered[name] = value;
  }
  const wanted: TransferBankDetails = { ...withoutFingerprint(current), ...entered };
  if (holdsAccount(originalDetails, entered)) {
    throw new Error(
      compared.what === "original payment"
        ? "These are the details the original payment went to, so there is nothing to verify. Approve the replacement to the account on file instead"
        : `These are the details of the ${compared.what}, so there is nothing to verify. Approve paying the account on file instead`,
    );
  }
  const alreadyOnRecord: boolean = holdsAccount(current, entered);
  if (
    alreadyOnRecord &&
    engine.ledger.verifiedBankChange(obligation.beneficiaryId, current) !== undefined
  ) {
    throw new Error("A callback for the bank details on file is recorded already");
  }

  const id: number = engine.ledger.addBankChange({
    invoiceId,
    beneficiaryId: obligation.beneficiaryId,
    calledBy,
    numberCalled: obligation.supplierPhone,
    calledAt: new Date(calledAtMs).toISOString(),
    spokeTo,
    confirmed,
    oldDetails: JSON.stringify(current),
    newDetails: JSON.stringify(entered),
  });
  note(
    engine.ledger,
    invoiceId,
    "callback",
    `${calledBy} called the supplier on ${obligation.supplierPhone}, the number on file, and spoke to ${spokeTo}, who confirmed: ${confirmed}`,
  );
  // Whatever happens next, the request for the old details no longer stands.
  if (engine.ledger.voidOpenApprovals(invoiceId)) {
    note(engine.ledger, invoiceId, "approval", "Approval request withdrawn: it was for the old bank details");
  }

  let settled: boolean = false;
  try {
    let failure: string | null = null;
    if (!alreadyOnRecord) {
      try {
        await updateBankDetails(engine.client, obligation.beneficiaryId, record, wanted);
      } catch (error: unknown) {
        failure = error instanceof Error ? error.message : String(error);
        if (wasRejected(error)) {
          engine.ledger.finishBankChange(id, "failed", null);
          settled = true;
          note(engine.ledger, invoiceId, "error", `Airwallex refused the new bank details, so the record is unchanged: ${failure}`);
          throw new Error(`Airwallex refused the new bank details: ${failure}`, { cause: error });
        }
      }
    }
    // Read back what Airwallex holds, which also settles an update whose answer
    // was lost.
    const after: TransferBankDetails =
      (await getBeneficiary(engine.client, obligation.beneficiaryId)).beneficiary?.bank_details ?? {};
    const differ: string[] = Object.entries(entered)
      .filter(([name, value]: [string, string]): boolean => !sameValue(after[name], value))
      .map(([name]: [string, string]): string => name);
    if (differ.some((name: string): boolean => !NOT_ROUTING_FIELDS.has(name))) {
      engine.ledger.finishBankChange(id, "failed", null);
      settled = true;
      note(
        engine.ledger,
        invoiceId,
        "error",
        `The supplier's record in Airwallex does not hold the new ${differ.join(", ")}${failure === null ? "" : `: ${failure}`}. PayOnce pays no new account until a callback matches the record`,
      );
      throw new Error("The supplier's record in Airwallex could not be updated");
    }
    engine.ledger.finishBankChange(id, "applied", bankDetailsKey(after));
    settled = true;
    const now: string = Object.entries(entered)
      .map(([name, value]: [string, string]): string => `${EDITABLE_FIELDS[name]?.toLowerCase()} ${shown(name, value)}`)
      .join(", ");
    const rewritten: string =
      differ.length === 0
        ? ""
        : `. Airwallex holds its own ${differ.map((name: string): string => `${EDITABLE_FIELDS[name]?.toLowerCase()} "${shown(name, after[name])}"`).join(", ")}`;
    note(
      engine.ledger,
      invoiceId,
      "callback",
      alreadyOnRecord
        ? `The supplier's record in Airwallex already holds these details, and the callback verifies them: ${now}`
        : `Supplier's bank details updated in Airwallex: ${now}${rewritten}`,
    );
  } finally {
    if (!settled) {
      note(
        engine.ledger,
        invoiceId,
        "error",
        "PayOnce could not confirm whether the supplier's record changed. Record the callback again once Airwallex answers",
      );
    }
  }
}


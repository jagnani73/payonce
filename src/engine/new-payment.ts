import { findBeneficiary, type BeneficiaryRecord } from "../airwallex/beneficiaries.js";
import type { TransferBankDetails } from "../airwallex/transfers.js";
import { dueDateProblem } from "../domain/arrival.js";
import { NameError, personName } from "../domain/approvers.js";
import { CURRENCY_PATTERN, TRANSFER_METHODS } from "../domain/patterns.js";
import { BENEFICIARY_MISSING_REASON } from "../domain/reasons.js";
import { BENEFICIARY_ID_PATTERN, twoDecimals } from "../runs/run-file.js";
import {
  alreadyInLedger,
  INVOICE_ID_PATTERN,
  type Ledger,
  type NewObligation,
  type Obligation,
  type RunRow,
  type TransferMethod,
} from "../store/ledger.js";
import { capitalise } from "../text/printable.js";
import type { Engine } from "./engine.js";
import { UNNAMED_PAYEE } from "./sweep.js";

// A first payment a person or a scenario asks PayOnce to open: the invoice, how
// much in which currency, the wallet the money leaves (the invoice's own
// currency's, or another for a payment that converts), the transfer method, when
// the supplier expects the money, and who asks for it, as typed.
export interface NewPayment {
  invoiceId: string;
  amountMinor: number;
  currency: string;
  wallet: string;
  transferMethod: TransferMethod;
  dueDate: string | null;
  starter: string;
}

// Who the invoice pays, as the ledger keeps it with the invoice: the beneficiary
// record, the supplier's name, the email domain and phone on file, and a floor of
// the invoice's own (0 for none).
export interface Payee {
  beneficiaryId: string;
  supplier: string;
  supplierDomain: string;
  supplierPhone: string | null;
  invoiceFloorMinor: number;
}

// The New payment form's fields, as its problems name them.
export type PaymentField =
  | "supplierKey"
  | "invoiceId"
  | "amount"
  | "currency"
  | "wallet"
  | "method"
  | "dueDate"
  | "startedBy";

// taken: the invoice number is PayOnce's already, in the ledger or on a pay run
// waiting for approval.
export interface PaymentProblem {
  field: PaymentField;
  text: string;
  taken: boolean;
}

// PayOnce did not open the payment, for these reasons, and nothing was stored.
export class PaymentRefusedError extends Error {
  readonly problems: PaymentProblem[];

  constructor(problems: PaymentProblem[]) {
    super(problems[0]?.text ?? "PayOnce did not open the payment");
    this.name = "PaymentRefusedError";
    this.problems = problems;
  }
}

function problem(field: PaymentField, text: string, taken: boolean = false): PaymentProblem {
  return { field, text, taken };
}

// The number belongs to an invoice PayOnce has, or to a row of a pay run waiting
// for approval, and PayOnce pays an invoice number once.
function numberTaken(ledger: Ledger, invoiceId: string): PaymentProblem | null {
  if (ledger.obligation(invoiceId) !== undefined) {
    return problem("invoiceId", alreadyInLedger(invoiceId), true);
  }
  const row: RunRow | undefined = ledger.waitingRunRow(invoiceId);
  return row === undefined
    ? null
    : problem(
        "invoiceId",
        `${invoiceId} is on pay run ${row.runId}, which is waiting for approval, and PayOnce pays an invoice number once`,
        true,
      );
}

function currencyProblem(field: "currency" | "wallet", code: string): PaymentProblem | null {
  if (!CURRENCY_PATTERN.test(code)) {
    return problem(field, code === "" ? `The ${field} is empty` : `The ${field} is not a three-letter currency code`);
  }
  return twoDecimals(code) ? null : problem(field, `${code} does not have two decimals. PayOnce handles two-decimal currencies only`);
}

function nameProblem(typed: string): PaymentProblem | null {
  try {
    personName(typed);
    return null;
  } catch (error: unknown) {
    if (error instanceof NameError) {
      return problem("startedBy", error.message);
    }
    throw error;
  }
}

// What is wrong with a payment before anything is read from Airwallex, field by
// field. Empty when nothing is.
export function paymentProblems(ledger: Ledger, payment: NewPayment): PaymentProblem[] {
  const due: string | null = payment.dueDate === null ? null : dueDateProblem(payment.dueDate);
  return [
    nameProblem(payment.starter),
    INVOICE_ID_PATTERN.test(payment.invoiceId)
      ? numberTaken(ledger, payment.invoiceId)
      : problem("invoiceId", "An invoice number has up to 40 letters, digits and dashes"),
    Number.isSafeInteger(payment.amountMinor) && payment.amountMinor > 0
      ? null
      : problem("amount", "The amount must be above zero, with at most two decimals"),
    currencyProblem("currency", payment.currency),
    currencyProblem("wallet", payment.wallet),
    TRANSFER_METHODS.includes(payment.transferMethod) ? null : problem("method", "The transfer method is LOCAL or SWIFT"),
    due === null ? null : problem("dueDate", due),
  ].filter((found: PaymentProblem | null): found is PaymentProblem => found !== null);
}

function filled(text: unknown): string | undefined {
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
}

// Who a person's payment to this beneficiary record pays, or why PayOnce cannot
// pay it: Airwallex has no record with bank details, the record's account is in
// another currency, or it takes other transfer methods. The supplier is named as
// the record names it: its account name, else the company's, else its nickname.
// PayOnce keeps no email domain or phone for it yet, so every sender of an email
// about it is flagged and a callback needs a phone first. It has no floor of its
// own. Only values in their own patterns go into a problem's words.
export type PayeeCheck = { ok: true; payee: Payee } | { ok: false; problem: PaymentProblem };

export function checkedPayee(
  beneficiaryId: string,
  record: BeneficiaryRecord | undefined,
  payment: Pick<NewPayment, "currency" | "transferMethod">,
): PayeeCheck {
  const details: TransferBankDetails | undefined = record?.beneficiary?.bank_details;
  if (record === undefined || details === undefined) {
    return {
      ok: false,
      problem: problem("supplierKey", `${capitalise(BENEFICIARY_MISSING_REASON)}, or has no bank details, so there is no account to pay`),
    };
  }
  const account: string | undefined = details.account_currency;
  if (account !== undefined && CURRENCY_PATTERN.test(account) && account !== payment.currency) {
    return { ok: false, problem: problem("currency", `The beneficiary's account is in ${account}, so the payment must be in ${account}`) };
  }
  const methods: TransferMethod[] = TRANSFER_METHODS.filter((method: TransferMethod): boolean =>
    (record.transfer_methods ?? []).includes(method),
  );
  if (methods.length > 0 && !methods.includes(payment.transferMethod)) {
    return { ok: false, problem: problem("method", `The beneficiary takes ${methods.join(" and ")} transfers only`) };
  }
  return {
    ok: true,
    payee: {
      beneficiaryId,
      supplier:
        filled(details.account_name) ?? filled(record.beneficiary?.["company_name"]) ?? filled(record.nickname) ?? UNNAMED_PAYEE,
      supplierDomain: "",
      supplierPhone: null,
      invoiceFloorMinor: 0,
    },
  };
}

// Reads the record a person's payment pays, with a GET, and refuses the payment
// when PayOnce could not pay that record.
export async function recordPayee(engine: Engine, beneficiaryId: string, payment: NewPayment): Promise<Payee> {
  if (!BENEFICIARY_ID_PATTERN.test(beneficiaryId)) {
    throw new PaymentRefusedError([problem("supplierKey", "Pick a beneficiary from the list")]);
  }
  const checked: PayeeCheck = checkedPayee(beneficiaryId, await findBeneficiary(engine.client, beneficiaryId), payment);
  if (!checked.ok) {
    throw new PaymentRefusedError([checked.problem]);
  }
  return checked.payee;
}

// The invoice openPayment writes for this payment to this payee.
export function newObligation(payment: NewPayment, payee: Payee): NewObligation {
  return {
    invoiceId: payment.invoiceId,
    supplier: payee.supplier,
    supplierDomain: payee.supplierDomain,
    beneficiaryId: payee.beneficiaryId,
    currency: payment.currency,
    amountMinor: payment.amountMinor,
    transferMethod: payment.transferMethod,
    invoiceFloorMinor: payee.invoiceFloorMinor,
    startedBy: personName(payment.starter),
    supplierPhone: payee.supplierPhone,
    sourceCurrency: payment.wallet,
    dueDate: payment.dueDate,
  };
}

// The invoice as the ledger reads it back once opened, with nothing paid or held.
export function asOpened(input: NewObligation): Obligation {
  return {
    ...input,
    sourceCurrency: input.sourceCurrency ?? input.currency,
    dueDate: input.dueDate ?? null,
    origin: "payonce",
    state: "open",
    escalationReason: "",
    payoutReference: null,
    duplicateOf: [],
    rejectedBy: null,
    runRowId: null,
  };
}

// Opens a first payment as an invoice in the ledger, with nothing sent, and
// returns it. What is wrong with the payment is refused first, then payee reads
// who it pays from Airwallex, and the invoice is written with nothing awaited
// after its number is checked again, because openObligation leaves an invoice
// already there as it is. A refusal is a PaymentRefusedError and stores nothing.
// The invoice's look, or startPayment, pays it.
export async function openPayment(engine: Engine, payment: NewPayment, payee: () => Promise<Payee>): Promise<Obligation> {
  const problems: PaymentProblem[] = paymentProblems(engine.ledger, payment);
  if (problems.length > 0) {
    throw new PaymentRefusedError(problems);
  }
  const to: Payee = await payee();
  const taken: PaymentProblem | null = numberTaken(engine.ledger, payment.invoiceId);
  if (taken !== null) {
    throw new PaymentRefusedError([taken]);
  }
  return engine.ledger.openObligation(newObligation(payment, to));
}

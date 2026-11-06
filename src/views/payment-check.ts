import { findBeneficiary, type BeneficiaryRecord } from "../airwallex/beneficiaries.js";
import { AirwallexError, AirwallexUnreachableError, type AirwallexClient } from "../airwallex/client.js";
import { phoneEnding } from "../domain/contacts.js";
import { formatMoney } from "../domain/money.js";
import { reasonText, reasonView } from "../domain/reasons.js";
import { currencyFloor, type CurrencyFloor } from "../domain/reserve.js";
import type { CashReport, CurrencyCash } from "../engine/cash-position.js";
import { firstPaymentFacts, firstPaymentHold, firstPaymentOutage, type FirstPaymentHold } from "../engine/first-payment.js";
import { asOpened, checkedPayee, newObligation, type NewPayment, type Payee, type PayeeCheck } from "../engine/new-payment.js";
import { railWords } from "../domain/patterns.js";
import type { Settings } from "../settings.js";
import { readingSoft, type Ledger, type Obligation, type Outage, type TransferMethod } from "../store/ledger.js";
import { PAID_OUTCOME, STAYS_IN_FLIGHT } from "../text/words.js";
import type { HeadroomLine, PaymentCheckView } from "./contract.js";
import { money } from "./parts.js";

// The New payment form's "What happens next": what PayOnce would do with the
// payment if it started now, from the ledger, the beneficiary record as last
// read and the cash panel. It asks startPayment's own outage gate and holds, in
// their order, on facts read without a lease, so it says what the start would
// do. It writes nothing.

const METHOD_WORDS: Record<TransferMethod, string> = { LOCAL: "local transfer", SWIFT: "SWIFT" };

// A read of one beneficiary record: the record, undefined when Airwallex has
// none, or why it could not be read.
export type RecordRead = { kind: "read"; record: BeneficiaryRecord | undefined } | { kind: "failed"; problem: string };

// One GET of a beneficiary record. A failed read is an answer too: the form says
// so and checks again.
export async function readRecord(client: AirwallexClient, beneficiaryId: string): Promise<RecordRead> {
  try {
    return { kind: "read", record: await findBeneficiary(client, beneficiaryId) };
  } catch (error: unknown) {
    if (error instanceof AirwallexUnreachableError) {
      return { kind: "failed", problem: "Couldn't read the beneficiary from Airwallex: the sandbox host did not answer." };
    }
    if (error instanceof AirwallexError) {
      return { kind: "failed", problem: `Couldn't read the beneficiary from Airwallex: it answered ${error.status}.` };
    }
    throw error;
  }
}

// What the form sent, read: the payment with its invoice number, the beneficiary,
// the problems found reading the form, by field, the record (null when the form
// names no beneficiary to read) and the sandbox bank's outcome, if one was chosen.
export interface PaymentCheckInput {
  payment: NewPayment;
  beneficiaryId: string;
  fields: Record<string, string>;
  record: RecordRead | null;
  bankOutcome: string | null;
}

// The wallet's headroom above its floor now, from the cash panel as the server
// last read it, and after this payment's first transfer and its fee, taken from
// the last transfer on the same rail. Unknown after for a payment that converts,
// whose amount in the wallet's currency waits for a rate.
function headroomAfter(ledger: Ledger, settings: Settings, payment: NewPayment, cash: CashReport | null): HeadroomLine | null {
  if (cash === null) {
    return null;
  }
  const wallet: string = payment.wallet;
  const floor: CurrencyFloor = currencyFloor(settings.reserve, wallet);
  const now: number | null =
    cash.currencies.find((entry: CurrencyCash): boolean => entry.currency === wallet)?.headroomMinor ?? null;
  const fee: number | null = ledger.latestFee(wallet, payment.transferMethod);
  return {
    wallet,
    now: now === null ? null : money(now, wallet),
    after:
      now === null || wallet !== payment.currency ? null : money(now - payment.amountMinor - (fee ?? 0), wallet, fee !== 0),
    floor: floor.minor === null ? null : money(floor.minor, wallet),
    floorSource: floor.source,
  };
}

// The contact the payment would have, as the payment page shows it: the last
// four digits of the record's phone on file, which a callback for it dials, and
// the email domain the payee carries, once the record is read.
function contactOf(ledger: Ledger, beneficiaryId: string, payee: Payee | null): PaymentCheckView["contact"] {
  return {
    phoneEnding: phoneEnding(ledger.contactOnFile(beneficiaryId, "phone")?.value ?? null),
    emailDomain: payee === null || payee.supplierDomain === "" ? null : payee.supplierDomain,
  };
}

function sandboxLine(payment: NewPayment, outcome: string): PaymentCheckView["sandbox"] {
  const text: string =
    payment.wallet !== payment.currency
      ? "Sandbox: the simulator does not move a transfer that converts currency, so this payment's first transfer stays in PROCESSING."
      : outcome === PAID_OUTCOME
        ? "Sandbox: the bank will pay this payment's first transfer."
        : outcome === STAYS_IN_FLIGHT
          ? "Sandbox: the bank will leave this payment's first transfer in flight."
          : `Sandbox: the bank will fail this payment's first transfer with ${outcome}.`;
  return { bankOutcome: outcome, text };
}

function outcomeOf(
  ledger: Ledger,
  settings: Settings,
  input: PaymentCheckInput,
  fields: Record<string, string>,
  checked: PayeeCheck | null,
): PaymentCheckView["outcome"] {
  if (Object.keys(fields).length > 0) {
    return { kind: "unknown", text: "PayOnce can't start it until the problems in the form are fixed." };
  }
  if (input.record?.kind !== "read" || checked === null || !checked.ok) {
    return {
      kind: "unknown",
      text: `${input.record?.kind === "failed" ? `${input.record.problem} ` : ""}PayOnce can't say what happens next until it can read the beneficiary.`,
    };
  }
  const { payment }: PaymentCheckInput = input;
  const obligation: Obligation = asOpened(newObligation(payment, checked.payee));
  const outage: Outage | undefined = firstPaymentOutage(ledger, obligation);
  if (outage !== undefined) {
    return {
      kind: "paused",
      outageId: outage.id,
      text: `It will wait: outage ${outage.id} on ${railWords(outage.currency, outage.method)} is active. PayOnce sends it once a person ends the outage.`,
    };
  }
  const held: FirstPaymentHold | null = firstPaymentHold(
    { ledger, reserve: settings.reserve },
    firstPaymentFacts(obligation, input.record.record?.beneficiary?.bank_details),
  );
  if (held !== null) {
    return { kind: "hold", reason: reasonView(held.reason), text: `It will wait for a person: ${reasonText(held.reason)}.` };
  }
  return {
    kind: "send",
    text: `PayOnce sends ${formatMoney(payment.amountMinor, payment.currency)} by ${METHOD_WORDS[payment.transferMethod]} from the ${payment.wallet} wallet as soon as you start it.`,
  };
}

export function paymentCheckView(
  ledger: Ledger,
  settings: Settings,
  input: PaymentCheckInput,
  cash: CashReport | null,
): PaymentCheckView {
  return readingSoft((): PaymentCheckView => {
    const { payment }: PaymentCheckInput = input;
    const fields: Record<string, string> = { ...input.fields };
    const checked: PayeeCheck | null =
      input.record?.kind === "read" ? checkedPayee(input.beneficiaryId, input.record.record, payment) : null;
    if (checked !== null && !checked.ok) {
      fields[checked.problem.field] ??= checked.problem.text;
    }
    const headroom: HeadroomLine | null = ["amount", "currency", "wallet", "method"].some(
      (field: string): boolean => fields[field] !== undefined,
    )
      ? null
      : headroomAfter(ledger, settings, payment, cash);
    const below: boolean =
      headroom?.after !== null && headroom?.after !== undefined && headroom.floorSource === "setting" && headroom.after.minor < 0;
    return {
      view: "payment-check",
      fields,
      outcome: outcomeOf(ledger, settings, input, fields, checked),
      approvers: null,
      headroom,
      warnings: below
        ? [`This would leave ${payment.wallet} below its reserve floor. PayOnce doesn't check a single payment's first transfer against the floor.`]
        : [],
      sandbox: sandboxLine(payment, input.bankOutcome ?? PAID_OUTCOME),
      invoiceId: payment.invoiceId,
      contact:
        input.fields["supplierKey"] === undefined
          ? contactOf(ledger, input.beneficiaryId, checked?.ok === true ? checked.payee : null)
          : null,
    };
  });
}

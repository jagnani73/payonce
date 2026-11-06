import type { IncomingMessage } from "node:http";
import { airwallexAdvice, AirwallexError, AirwallexUnreachableError } from "../../../airwallex/client.js";
import { TRANSFER_METHODS } from "../../../domain/patterns.js";
import { firstPaymentOutage } from "../../../engine/first-payment.js";
import {
  openPayment,
  paymentProblems,
  PaymentRefusedError,
  recordPayee,
  type NewPayment,
  type Payee,
  type PaymentProblem,
} from "../../../engine/new-payment.js";
import { newInvoiceId } from "../../../engine/scenario.js";
import { railWords } from "../../../domain/patterns.js";
import { amountMinorOf, amountProblem, BENEFICIARY_ID_PATTERN } from "../../../runs/run-file.js";
import { readingSoft, type Obligation, type Outage, type TransferMethod } from "../../../store/ledger.js";
import { SANDBOX_OUTCOMES } from "../../../text/words.js";
import type { IncidentView, Notice, PaymentCheckView, PaymentCreated } from "../../../views/contract.js";
import { incidentView } from "../../../views/incident.js";
import { paymentCheckView, readRecord, type RecordRead } from "../../../views/payment-check.js";
import type { HttpApp } from "../app.js";
import { HttpError, name, readJson, sendJson, text } from "../http.js";
import type { Route } from "../router.js";

// The New payment form: what would happen if a payment started now, and starting
// it. The check reads the ledger, the cash panel's cache and the beneficiary
// record, kept a minute, and writes nothing. Starting reads the record again,
// opens the invoice and wakes it, so its first look sends or holds its first
// payment in its turn, as for any payment.

// A beneficiary record the check read is read again once it is this old.
const RECORD_EVERY_MS: number = 60_000;
// Twelve digits, a point and two decimals, with room to spare.
const MAX_AMOUNT_LENGTH: number = 20;

// What the form sent, read field by field: the payment, with the invoice number
// given or one PayOnce made, the beneficiary, the sandbox bank's outcome if one
// was chosen, and what is wrong with them, by field.
interface PaymentForm {
  payment: NewPayment;
  beneficiaryId: string;
  bankOutcome: string | null;
  fields: Record<string, string>;
  // The invoice number is PayOnce's already.
  taken: boolean;
}

export function paymentRoutes(app: HttpApp): Route[] {
  const { engine, agent, bank, settings, live, cash } = app;
  const records: Map<string, { at: number; read: Promise<RecordRead> }> = new Map();

  function readForm(body: Record<string, unknown>): PaymentForm {
    const fields: Record<string, string> = {};
    const beneficiaryId: string = text(body, "supplierKey");
    if (!BENEFICIARY_ID_PATTERN.test(beneficiaryId)) {
      fields["supplierKey"] = beneficiaryId === "" ? "Pick a beneficiary" : "Pick a beneficiary from the list";
    }
    const amount: string = text(body, "amount");
    // The problem names what was typed, so an amount far longer than any is not
    // repeated back.
    const badAmount: string | null =
      amount.length > MAX_AMOUNT_LENGTH ? "The amount is not an amount such as 40.00" : amountProblem(amount);
    if (badAmount !== null) {
      fields["amount"] = badAmount;
    }
    const methodText: string = text(body, "method").toUpperCase();
    const method: TransferMethod | undefined = TRANSFER_METHODS.find((entry: TransferMethod): boolean => entry === methodText);
    if (method === undefined) {
      fields["method"] = "Pick local transfer or SWIFT";
    }
    const due: unknown = body["dueDate"];
    if (due !== undefined && due !== null && typeof due !== "string") {
      fields["dueDate"] = "The due date is not a date written like 2026-11-02";
    }
    let starter: string = "";
    try {
      starter = name(body, "startedBy", "Enter your name");
    } catch (error: unknown) {
      if (!(error instanceof HttpError)) {
        throw error;
      }
      fields["startedBy"] = error.message;
    }
    const sandbox: unknown = body["sandbox"];
    const outcome: unknown =
      typeof sandbox === "object" && sandbox !== null && !Array.isArray(sandbox)
        ? (sandbox as Record<string, unknown>)["bankOutcome"]
        : undefined;
    const bankOutcome: string | null = typeof outcome === "string" && SANDBOX_OUTCOMES.includes(outcome) ? outcome : null;
    if (sandbox !== undefined && sandbox !== null && bankOutcome === null) {
      fields["sandbox"] = "Unknown bank outcome";
    }
    const given: string = text(body, "invoiceId");
    const currency: string = text(body, "currency").toUpperCase();
    const payment: NewPayment = {
      invoiceId: given === "" ? newInvoiceId(engine.ledger) : given,
      amountMinor: badAmount === null ? amountMinorOf(amount) : 0,
      currency,
      wallet: text(body, "wallet").toUpperCase() || currency,
      transferMethod: method ?? "LOCAL",
      dueDate: text(body, "dueDate") || null,
      starter,
    };
    const problems: PaymentProblem[] = paymentProblems(engine.ledger, payment);
    for (const problem of problems) {
      fields[problem.field] ??= problem.text;
    }
    return {
      payment,
      beneficiaryId,
      bankOutcome,
      fields,
      taken: problems.some((problem: PaymentProblem): boolean => problem.taken),
    };
  }

  // At most one read of a record at a time, kept a minute. A failed read is not
  // kept, so the next check reads again.
  function recordFor(beneficiaryId: string): Promise<RecordRead> {
    const now: number = Date.now();
    for (const [key, kept] of records) {
      if (now - kept.at >= RECORD_EVERY_MS) {
        records.delete(key);
      }
    }
    const kept: { at: number; read: Promise<RecordRead> } | undefined = records.get(beneficiaryId);
    if (kept !== undefined) {
      return kept.read;
    }
    const read: Promise<RecordRead> = readRecord(engine.client, beneficiaryId).then((answer: RecordRead): RecordRead => {
      if (answer.kind === "failed") {
        records.delete(beneficiaryId);
      }
      return answer;
    });
    records.set(beneficiaryId, { at: now, read });
    return read;
  }

  async function check(request: IncomingMessage): Promise<PaymentCheckView> {
    const form: PaymentForm = readForm(await readJson(request));
    const record: RecordRead | null =
      form.fields["supplierKey"] === undefined ? await recordFor(form.beneficiaryId) : null;
    return paymentCheckView(
      engine.ledger,
      settings,
      { payment: form.payment, beneficiaryId: form.beneficiaryId, fields: form.fields, record, bankOutcome: form.bankOutcome },
      readingSoft(cash),
    );
  }

  // 409 when the invoice number is PayOnce's already, else 400, with every
  // problem by field.
  function refusal(problems: { field: string; text: string }[], taken: boolean): HttpError {
    const fields: Record<string, string> = {};
    for (const problem of problems) {
      fields[problem.field] ??= problem.text;
    }
    const lead: { text: string } | undefined = taken
      ? problems.find((problem: { field: string }): boolean => problem.field === "invoiceId")
      : problems[0];
    return new HttpError(taken ? 409 : 400, lead?.text ?? "PayOnce did not start the payment", {
      code: taken ? "duplicate-invoice" : "fields",
      fields,
    });
  }

  // Airwallex is read before the invoice is written, so nothing is stored. The
  // person reads PayOnce's words first and Airwallex's after them.
  function notOpened(error: unknown): unknown {
    if (error instanceof PaymentRefusedError) {
      return refusal(error.problems, error.problems.some((problem: PaymentProblem): boolean => problem.taken));
    }
    if (error instanceof AirwallexUnreachableError || error instanceof AirwallexError) {
      const what: string =
        error instanceof AirwallexUnreachableError ? "Airwallex could not be reached" : "Airwallex answered with an error";
      const advice: string = airwallexAdvice(error);
      return new HttpError(502, `${what}, so nothing was sent or stored.${advice === "" ? "" : ` ${advice}`} ${error.message}`, {
        code: "airwallex-unreachable",
      });
    }
    return error;
  }

  // What the person is told once the first look has run: it sent the first
  // transfer, held it for a person, or waits on an outage, or the look could not
  // finish and the next comes in a minute.
  function noticeFor(invoiceId: string): Notice {
    const obligation: Obligation | undefined = engine.ledger.obligation(invoiceId);
    if (obligation?.state === "escalated") {
      return { tone: "warning", text: `${invoiceId} is on hold: ${obligation.escalationReason}.` };
    }
    if (engine.ledger.attempts(invoiceId).length > 0) {
      return { tone: "success", text: `${invoiceId} started. PayOnce is sending the first transfer.` };
    }
    const outage: Outage | undefined = obligation === undefined ? undefined : firstPaymentOutage(engine.ledger, obligation);
    return outage !== undefined
      ? {
          tone: "info",
          text: `${invoiceId} is waiting: outage ${outage.id} on ${railWords(outage.currency, outage.method)} is active. PayOnce sends it once a person ends the outage.`,
        }
      : {
          tone: "warning",
          text: `${invoiceId} started, but its first transfer has not gone out yet. PayOnce tries again in a minute.`,
        };
  }

  async function start(request: IncomingMessage): Promise<PaymentCreated> {
    const form: PaymentForm = readForm(await readJson(request));
    if (Object.keys(form.fields).length > 0) {
      throw refusal(
        Object.entries(form.fields).map(([field, problem]: [string, string]): { field: string; text: string } => ({ field, text: problem })),
        form.taken,
      );
    }
    const { payment, beneficiaryId }: PaymentForm = form;
    let obligation: Obligation;
    try {
      obligation = await openPayment(engine, payment, (): Promise<Payee> => recordPayee(engine, beneficiaryId, payment));
    } catch (error: unknown) {
      throw notOpened(error);
    }
    const invoiceId: string = obligation.invoiceId;
    if (form.bankOutcome !== null) {
      bank.expectOriginal(invoiceId, form.bankOutcome);
    }
    agent.wake(invoiceId);
    await agent.whenIdle(invoiceId);
    const view: IncidentView | null = incidentView(engine.ledger, settings, Date.now(), invoiceId, live, readingSoft(cash));
    if (view === null) {
      throw new Error(`${invoiceId} is not in the ledger`);
    }
    return { invoiceId, view, notice: noticeFor(invoiceId) };
  }

  return [
    {
      method: "POST",
      pattern: "/api/payments/check",
      handler: async ({ request, response }): Promise<void> => sendJson(response, 200, await check(request)),
    },
    {
      method: "POST",
      pattern: "/api/payments",
      handler: async ({ request, response }): Promise<void> => sendJson(response, 201, await start(request)),
    },
  ];
}

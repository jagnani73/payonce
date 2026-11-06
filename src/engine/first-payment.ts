import { getAvailableMinor } from "../airwallex/balances.js";
import { findBeneficiary, type BeneficiaryRecord } from "../airwallex/beneficiaries.js";
import type { Transfer, TransferBankDetails } from "../airwallex/transfers.js";
import { accountKeyOf } from "../domain/approval.js";
import { routeKeyOf } from "../domain/assess.js";
import { likelyDuplicates, sameNumberForSupplier } from "../domain/duplicates.js";
import { formatMoney } from "../domain/money.js";
import {
  heldAsSecondBill,
  heldForRate,
  heldForSameNumber,
  reasonFor,
  reasonText,
  refusedOriginal,
  type Reason,
} from "../domain/reasons.js";
import { debitCurrency, floorFor } from "../domain/reserve.js";
import {
  crossCurrency,
  holdsAccount,
  RailOutageError,
  type AccountRef,
  type Attempt,
  type LastPaid,
  type Lease,
  type Ledger,
  type Obligation,
  type Outage,
  type RunRow,
  type ScannedObligation,
} from "../store/ledger.js";
import { committedAcross, committedByInvoice } from "../store/read/cash.js";
import { anyLive } from "../store/read/facts.js";
import { withCurrencyLock } from "./currency-lock.js";
import { RETRY_FAILED_LOOK_MS, type Engine, type LookOptions, type NextLook } from "./engine.js";
import { messageOf, note } from "./lines.js";
import { linkUnseenPayouts } from "./outside.js";
import { deadlineLook, send, waitForBank } from "./send.js";

function waitingForFirst(ledger: Ledger, invoiceId: string): Obligation | undefined {
  const now: Obligation | undefined = ledger.obligation(invoiceId);
  return now?.state === "open" && ledger.attempts(invoiceId).length === 0 ? now : undefined;
}

// A hold a first payment meets: its reason, the invoices it looks like a second
// bill for (duplicateOf), those of them that only share its number, for another
// amount or currency (sameNumber), and a cost line to note with it, or null.
export interface FirstPaymentHold {
  reason: Reason;
  duplicateOf: string[];
  sameNumber: string[];
  detail: string | null;
}

// What a first payment's holds are decided on: the invoice, as the ledger has it
// or as it would be opened, and what was read from Airwallex for it. record is the
// beneficiary record's bank details, undefined when Airwallex has none and for a
// pay run row, whose record accountProblem checks. account is what is wrong with
// the account the payment would go to, or null. cash is a pay run row's wallet as
// read under the lease, and null for any other first payment, which is not held
// to the floor.
export interface FirstPaymentFacts {
  obligation: Obligation;
  record: TransferBankDetails | undefined;
  account: Reason | null;
  cash: { availableMinor: number; committedBefore: Map<string, number> } | null;
}

// What the holds read besides the facts.
type HoldReads = Pick<Engine, "ledger" | "reserve">;

type HoldCheck = (engine: HoldReads, facts: FirstPaymentFacts) => FirstPaymentHold | null;

// What startPayment found once every check had run: an attempt to send, or a
// reason to hold the invoice, written already.
type FirstPayment =
  | { kind: "send"; obligation: Obligation; attempt: Attempt }
  | ({ kind: "held" } & FirstPaymentHold);

function heldFor(reason: Reason, detail: string | null = null): FirstPaymentHold {
  return { reason, duplicateOf: [], sameNumber: [], detail };
}

// Puts a hold startPayment wrote on the timelines, after its transaction.
function noteHold(engine: Engine, invoiceId: string, held: FirstPaymentHold): void {
  note(engine.ledger, invoiceId, "decision", `Escalate: ${reasonText(held.reason)}`, "decision");
  if (held.detail !== null) {
    note(engine.ledger, invoiceId, "warning", held.detail, "cost");
  }
  for (const other of held.duplicateOf) {
    note(
      engine.ledger,
      other,
      "warning",
      held.sameNumber.includes(other)
        ? `${invoiceId} has the same invoice number as this invoice, for the same supplier, so PayOnce held it before paying`
        : `${invoiceId} looks like a second bill for this invoice, so PayOnce held it before paying`,
    );
  }
}

// Why a pay run row is not sent to the record as it is now, or null when the
// record still holds the account the run was approved for.
async function accountProblem(
  engine: Engine,
  obligation: Obligation,
  account: AccountRef,
): Promise<{ problem: Reason | null; route: string | null }> {
  const record: BeneficiaryRecord | undefined = await findBeneficiary(
    engine.client,
    obligation.beneficiaryId,
  );
  const details: TransferBankDetails | undefined = record?.beneficiary?.bank_details;
  if (details === undefined) {
    return { problem: reasonFor("beneficiary-missing"), route: null };
  }
  return accountKeyOf(details) === account.accountKey
    ? { problem: null, route: routeKeyOf(details) }
    : { problem: reasonFor("run-account-changed"), route: null };
}

// Why a first payment to the record as it is now waits for a person because of
// where PayOnce last paid this supplier, or null. last-paid-account-changed when
// the record no longer holds the account of PayOnce's last checked payment to
// it, whether or not a callback verified the one it holds: continueHeld then
// waits for a callback, and once there is one needs two approvers and bars
// whoever recorded it. account-unconfirmed when PayOnce paid this supplier only
// before it kept which account each payment went to. A supplier PayOnce has
// never paid is not held for this. Reads only the ledger.
function lastPaidHold(ledger: Ledger, obligation: Obligation, record: TransferBankDetails): Reason | null {
  const last: LastPaid | undefined = ledger.lastPaidTransfer(obligation.beneficiaryId);
  if (last !== undefined) {
    return holdsAccount(last, record) ? null : reasonFor("last-paid-account-changed");
  }
  return ledger.lastPaidUnchecked(obligation.beneficiaryId) === undefined ? null : reasonFor("account-unconfirmed");
}

// What is wrong with the account a first payment other than a pay run row's would
// go to, as the record was read, and the route its details take.
function recordAccount(record: TransferBankDetails | undefined): { problem: Reason | null; route: string | null } {
  return record === undefined
    ? { problem: reasonFor("beneficiary-missing"), route: null }
    : { problem: null, route: routeKeyOf(record) };
}

// The facts of a first payment that is not a pay run row's, from a record read
// with no lease held, for a preview of what startPayment would do with it.
export function firstPaymentFacts(obligation: Obligation, record: TransferBankDetails | undefined): FirstPaymentFacts {
  return { obligation, record, account: recordAccount(record).problem, cash: null };
}

// The active outage on the rail a first payment goes by, which holds it before
// anything is read from Airwallex.
export function firstPaymentOutage(ledger: Ledger, obligation: Obligation): Outage | undefined {
  return ledger.activeOutage(obligation.currency, obligation.transferMethod);
}

// The beneficiary is no longer in Airwallex, or a pay run row's record no longer
// holds the account the run was approved for.
function heldForAccount(_engine: HoldReads, facts: FirstPaymentFacts): FirstPaymentHold | null {
  return facts.account === null ? null : heldFor(facts.account);
}

// Why a new invoice is held before paying because of other invoices: it looks
// like a second bill for one, it has the number of another invoice to the same
// supplier, for any amount, or a payout for it sent outside PayOnce is live.
function heldForOthers(engine: HoldReads, facts: FirstPaymentFacts): FirstPaymentHold | null {
  const { ledger }: HoldReads = engine;
  const obligation: Obligation = facts.obligation;
  const duplicates: string[] = likelyDuplicates(ledger, obligation).map(
    (other: ScannedObligation): string => other.invoiceId,
  );
  const sameNumber: string[] = sameNumberForSupplier(ledger, obligation)
    .map((other: ScannedObligation): string => other.invoiceId)
    .filter((other: string): boolean => !duplicates.includes(other));
  const duplicateOf: string[] = [...duplicates, ...sameNumber];
  if (duplicateOf.length === 0 && !anyLive(ledger.outsidePayouts(obligation.invoiceId))) {
    return null;
  }
  const reason: Reason =
    duplicates.length > 0
      ? heldAsSecondBill(duplicates)
      : sameNumber.length > 0
        ? heldForSameNumber(sameNumber)
        : reasonFor("outside-payout");
  return { duplicateOf, sameNumber, reason, detail: null };
}

// An account PayOnce has not paid this supplier, when it has paid them another,
// waits for a person, as a replacement does: a callback first, then two
// approvers. So does any account of a supplier PayOnce paid only before it kept
// which account each payment went to.
function heldForLastPaid(engine: HoldReads, facts: FirstPaymentFacts): FirstPaymentHold | null {
  const reason: Reason | null =
    facts.record === undefined ? null : lastPaidHold(engine.ledger, facts.obligation, facts.record);
  return reason === null ? null : heldFor(reason);
}

// A supplier who wrote before anything was paid may be asking not to pay it, or
// to pay elsewhere, so a person reads the email first. That includes a pay run
// row waiting its turn.
function heldForEmails(engine: HoldReads, facts: FirstPaymentFacts): FirstPaymentHold | null {
  return engine.ledger.emailCount(facts.obligation.invoiceId) > 0 ? heldFor(reasonFor("emails-before-payment")) : null;
}

// The agent never pays at a rate nobody has seen, so this is the least serious
// reason to hold it and comes after the others.
function heldForExchangeRate(_engine: HoldReads, facts: FirstPaymentFacts): FirstPaymentHold | null {
  return crossCurrency(facts.obligation) ? heldFor(heldForRate(facts.obligation.sourceCurrency)) : null;
}

// A pay run's row that would take cash below the floor.
function heldForFloor(engine: HoldReads, facts: FirstPaymentFacts): FirstPaymentHold | null {
  if (facts.cash === null) {
    return null;
  }
  const short: string | null = floorBreach(engine, facts.obligation, facts.cash.availableMinor, facts.cash.committedBefore);
  return short === null ? null : heldFor(reasonFor("run-row-below-floor"), short);
}

// The holds a first payment meets, in the order they are checked. The first that
// applies holds it.
const FIRST_PAYMENT_HOLDS: readonly HoldCheck[] = [
  heldForAccount,
  heldForOthers,
  heldForLastPaid,
  heldForEmails,
  heldForExchangeRate,
  heldForFloor,
];

// The hold a first payment meets on these facts, or null when it goes out.
// startPayment asks it in the transaction that would open the attempt, and the
// New payment preview on facts read without a lease. It reads only the ledger.
export function firstPaymentHold(engine: HoldReads, facts: FirstPaymentFacts): FirstPaymentHold | null {
  for (const check of FIRST_PAYMENT_HOLDS) {
    const held: FirstPaymentHold | null = check(engine, facts);
    if (held !== null) {
      return held;
    }
  }
  return null;
}

// Sends a new invoice's original, unless it looks like a second bill for an
// invoice the ledger already has, has the number of another invoice to the same
// supplier, a payout for it sent outside PayOnce may already pay it, or it is
// paid from another currency's wallet, so a person approves the rate. Then it
// holds the invoice for a person, sends nothing and returns null. accountKey is
// the account a pay run approved, and a pay run's row is held too when the
// record no longer holds it, or when paying it would take cash below the floor.
// Any other first payment is decided on the record as it is read here, and is
// held when PayOnce last paid this supplier another account, even one a callback
// verified, or paid it only before it kept which account each payment went to
// (lastPaidHold). A supplier PayOnce has never paid is not held for this. The
// attempt keeps the account either way, so every retry is checked against it.
// A pay run's row is never paid from another currency's wallet. Call it in the
// invoice's turn.
//
// It holds the currency lock of the wallet the money leaves throughout. The reads
// from Airwallex come first, with the beneficiary record last, and every check
// after them runs in the transaction that opens the attempt, so nothing is
// awaited between the last check and the attempt. When it throws, the next look
// comes a minute later and tries again: it sends the original if no attempt was
// opened, and retries a pending one under its request_id.
export async function startPayment(
  engine: Engine,
  obligation: Obligation,
  account: AccountRef | null = null,
): Promise<Transfer | null> {
  const invoiceId: string = obligation.invoiceId;
  if (waitingForFirst(engine.ledger, invoiceId) === undefined) {
    throw new Error(`${invoiceId} is not waiting for its first payment`);
  }
  // Pay runs do not pay across currencies: a row pays in its own currency from
  // that currency's wallet.
  if (obligation.runRowId !== null && crossCurrency(obligation)) {
    throw new Error(
      `${invoiceId} is a pay run row paid from ${obligation.sourceCurrency}, and a pay run pays each row from its own currency's wallet, so PayOnce sent nothing`,
    );
  }
  const wallet: string = debitCurrency(obligation);
  try {
    // A first payment on a rail with an outage waits, unsent and with no attempt,
    // and every check runs once the outage has ended. openAttempt refuses it too.
    const outage: Outage | undefined = firstPaymentOutage(engine.ledger, obligation);
    if (outage !== undefined) {
      throw new RailOutageError(outage, "original");
    }
    return await withCurrencyLock(engine.ledger, wallet, async (lease: Lease): Promise<Transfer | null> => {
      // A pay run's row is held to the floor. A single incident's original is not.
      // The money committed elsewhere is counted before the balance read and again
      // in the transaction.
      const before: Map<string, number> = committedByInvoice(engine.ledger, wallet, { invoiceId });
      const availableMinor: number | null =
        obligation.runRowId === null ? null : await getAvailableMinor(engine.client, wallet);
      await linkUnseenPayouts(engine, invoiceId);
      // Read last, so the record is checked as close to the attempt as a read
      // from Airwallex can be.
      const record: TransferBankDetails | undefined =
        account === null
          ? (await findBeneficiary(engine.client, obligation.beneficiaryId))?.beneficiary?.bank_details
          : undefined;
      const checked: { problem: Reason | null; route: string | null } =
        account !== null ? await accountProblem(engine, obligation, account) : recordAccount(record);
      const decidedKey: string | null = account?.accountKey ?? (record === undefined ? null : accountKeyOf(record));

      const first: FirstPayment = engine.ledger.transaction((): FirstPayment => {
        // Another process may have held or paid it while Airwallex was read.
        const now: Obligation | undefined = waitingForFirst(engine.ledger, invoiceId);
        if (now === undefined) {
          throw new Error(`${invoiceId} is not waiting for its first payment`);
        }
        const held: FirstPaymentHold | null = firstPaymentHold(engine, {
          obligation: now,
          record,
          account: checked.problem,
          cash: availableMinor === null ? null : { availableMinor, committedBefore: before },
        });
        if (held !== null) {
          engine.ledger.holdBeforePaying(invoiceId, held.duplicateOf, held.reason);
          return { kind: "held", ...held };
        }
        return {
          kind: "send",
          obligation: now,
          attempt: engine.ledger.openAttempt(invoiceId, "original", lease, null, decidedKey, checked.route),
        };
      });
      if (first.kind === "held") {
        noteHold(engine, invoiceId, first);
        return null;
      }
      try {
        const original: Transfer = await send(engine, first.obligation, first.attempt);
        // The look at its deadline is planned as soon as it is with the bank, so it
        // comes even if nothing wakes the invoice before, for example when the
        // sandbox bank's script fails.
        engine.ledger.lookAt(invoiceId, deadlineLook(original));
        return original;
      } catch (error: unknown) {
        const refused: Attempt | undefined = engine.ledger.attempts(invoiceId).at(-1);
        if (refused?.state !== "failed" || refused.transferId !== null) {
          throw error;
        }
        note(engine.ledger, invoiceId, "error", messageOf(error));
        holdRefused(engine, first.obligation, refused);
        return null;
      }
    });
  } catch (error: unknown) {
    // The transfer may exist, or nothing was opened at all, for example when the
    // lock never came free. A look tries again a minute later, as after a look
    // that failed, so an invoice started from the page is never left with no
    // payment and no look.
    const at: number = Date.now();
    engine.ledger.postponeDueLook(invoiceId, at, at + RETRY_FAILED_LOOK_MS);
    throw error;
  }
}

// What is wrong with paying a pay run's row now, against the floor of its
// currency, or null when it fits. Money promised elsewhere is taken off,
// including the run's other rows not sent yet. A currency with no floor set does
// not stop a row, because a person approved the run.
function floorBreach(
  engine: HoldReads,
  obligation: Obligation,
  availableMinor: number,
  committedBefore: Map<string, number>,
): string | null {
  const wallet: string = debitCurrency(obligation);
  const floorMinor: number | null = floorFor(engine.reserve, obligation);
  if (floorMinor === null) {
    return null;
  }
  if (!Number.isFinite(floorMinor)) {
    return "The reserve floor setting could not be read, so PayOnce did not pay this invoice";
  }
  const feeMinor: number = engine.ledger.latestFee(wallet, obligation.transferMethod) ?? 0;
  const afterMinor: number =
    availableMinor -
    committedAcross(
      committedBefore,
      committedByInvoice(engine.ledger, wallet, { invoiceId: obligation.invoiceId }),
    ) -
    obligation.amountMinor -
    feeMinor;
  return afterMinor >= floorMinor
    ? null
    : `Paying it now would leave ${formatMoney(afterMinor, wallet)}, ${formatMoney(floorMinor - afterMinor, wallet)} below the reserve floor of ${formatMoney(floorMinor, wallet)}`;
}

// Airwallex refused every original the invoice was sent with, so nothing was
// paid. It goes to a person and pays only on an approval, like a held invoice.
// The invoice is returned as the ledger holds it once escalated.
export function holdRefused(engine: Engine, obligation: Obligation, refused: Attempt): Obligation {
  const invoiceId: string = obligation.invoiceId;
  const reason: Reason = refusedOriginal(refused.failureCode);
  engine.ledger.escalate(invoiceId, reason);
  const held: Obligation | undefined = engine.ledger.obligation(invoiceId);
  if (held === undefined) {
    throw new Error(`${invoiceId} is not in the ledger`);
  }
  note(engine.ledger, invoiceId, "decision", `Escalate: ${reasonText(reason)}`, "decision");
  return held;
}

// The first payment of an open invoice with no attempt. A pay run's row sends its
// original, to the account the run approved, only in its turn: when the release
// or the server's watcher gives the look the run's turn. Any other look leaves it
// for that turn. Any other invoice is here only when its first send failed before
// an attempt was opened, and the look tries it again. When startPayment holds it
// instead, the next look comes at once, and asks a person.
export async function startFirst(
  engine: Engine,
  obligation: Obligation,
  options: LookOptions,
): Promise<NextLook> {
  const invoiceId: string = obligation.invoiceId;
  let account: AccountRef | null = null;
  if (obligation.runRowId !== null) {
    const row: RunRow | undefined = engine.ledger.runRow(obligation.runRowId);
    if (row === undefined || row.accountKey === null) {
      throw new Error(`${invoiceId} has no pay run row to send it from`);
    }
    if (!options.runTurn) {
      note(
        engine.ledger,
        invoiceId,
        "payment",
        `Waiting for its turn in pay run ${row.runId}. The server sends the run's first payments one at a time`,
        "waiting",
      );
      // Due at once, so the server's watcher gives it its turn.
      return Date.now();
    }
    account = { accountKey: row.accountKey, routeKey: row.routeKey };
  }
  const original: Transfer | null = await startPayment(engine, obligation, account);
  return original === null ? Date.now() : waitForBank(engine, invoiceId, "original", original);
}

import { getAvailableMinor } from "../airwallex/balances.js";
import { findBeneficiary, type BeneficiaryRecord } from "../airwallex/beneficiaries.js";
import type { Transfer, TransferBankDetails } from "../airwallex/transfers.js";
import { accountKeyOf } from "../domain/approval.js";
import { routeKeyOf } from "../domain/assess.js";
import { LAST_PAID_CHANGED_REASON, OUTSIDE_PAYOUT_REASON, UNCONFIRMED_ACCOUNT_REASON } from "../domain/decide.js";
import { likelyDuplicates, sameNumberForSupplier } from "../domain/duplicates.js";
import { formatMoney } from "../domain/money.js";
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
import { committedAcross, committedByInvoice } from "./cash-position.js";
import { withCurrencyLock } from "./currency-lock.js";
import { RETRY_FAILED_LOOK_MS, type Engine, type NextLook } from "./engine.js";
import { anyLive } from "./facts.js";
import { listOf, messageOf, note } from "./lines.js";
import { linkUnseenPayouts } from "./outside.js";
import { CASH_HOLD_REASON, EMAILS_BEFORE_PAYMENT_REASON, RUN_ACCOUNT_CHANGED_REASON } from "./reason-text.js";
import { deadlineLook, send, waitForBank } from "./send.js";

function waitingForFirst(ledger: Ledger, invoiceId: string): Obligation | undefined {
  const now: Obligation | undefined = ledger.obligation(invoiceId);
  return now?.state === "open" && ledger.attempts(invoiceId).length === 0 ? now : undefined;
}

// What startPayment found once every check had run: an attempt to send, or a
// reason to hold the invoice, written already. sameNumber lists the invoices in
// duplicateOf that only share its number, for another amount or currency.
type FirstPayment =
  | { kind: "send"; obligation: Obligation; attempt: Attempt }
  | { kind: "held"; duplicateOf: string[]; sameNumber: string[]; reason: string; detail: string | null };

// Puts a hold startPayment wrote on the timelines, after its transaction.
function noteHold(engine: Engine, invoiceId: string, held: Extract<FirstPayment, { kind: "held" }>): void {
  note(engine.ledger, invoiceId, "decision", `Escalate: ${held.reason}`, "decision");
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
): Promise<{ problem: string | null; route: string | null }> {
  const record: BeneficiaryRecord | undefined = await findBeneficiary(
    engine.client,
    obligation.beneficiaryId,
  );
  const details: TransferBankDetails | undefined = record?.beneficiary?.bank_details;
  if (details === undefined) {
    return { problem: "the beneficiary is no longer in Airwallex", route: null };
  }
  return accountKeyOf(details) === account.accountKey
    ? { problem: null, route: routeKeyOf(details) }
    : { problem: RUN_ACCOUNT_CHANGED_REASON, route: null };
}

// Why a first payment to the record as it is now waits for a person because of
// where PayOnce last paid this supplier, or null. LAST_PAID_CHANGED_REASON when
// the record no longer holds the account of PayOnce's last checked payment to
// it, whether or not a callback verified the one it holds: continueHeld then
// waits for a callback, and once there is one needs two approvers and bars
// whoever recorded it. UNCONFIRMED_ACCOUNT_REASON when PayOnce paid this
// supplier only before it kept which account each payment went to. A supplier
// PayOnce has never paid is not held for this. Reads only the ledger.
function lastPaidHold(ledger: Ledger, obligation: Obligation, record: TransferBankDetails): string | null {
  const last: LastPaid | undefined = ledger.lastPaidTransfer(obligation.beneficiaryId);
  if (last !== undefined) {
    return holdsAccount(last, record) ? null : LAST_PAID_CHANGED_REASON;
  }
  return ledger.lastPaidUnchecked(obligation.beneficiaryId) === undefined ? null : UNCONFIRMED_ACCOUNT_REASON;
}

// Why a new invoice is held before paying because of other invoices: it looks
// like a second bill for one, it has the number of another invoice to the same
// supplier, for any amount, or a payout for it sent outside PayOnce is live.
// Undefined when none of these holds. Reads only the ledger, so it runs in the
// transaction that would open the attempt.
function heldForOthers(
  ledger: Ledger,
  obligation: Obligation,
): Extract<FirstPayment, { kind: "held" }> | undefined {
  const duplicates: string[] = likelyDuplicates(ledger, obligation).map(
    (other: ScannedObligation): string => other.invoiceId,
  );
  const sameNumber: string[] = sameNumberForSupplier(ledger, obligation)
    .map((other: ScannedObligation): string => other.invoiceId)
    .filter((other: string): boolean => !duplicates.includes(other));
  const duplicateOf: string[] = [...duplicates, ...sameNumber];
  if (duplicateOf.length === 0 && !anyLive(ledger.outsidePayouts(obligation.invoiceId))) {
    return undefined;
  }
  const reason: string =
    duplicates.length > 0
      ? `it looks like a second bill for ${listOf(duplicates)}: the same supplier and amount, and the same invoice number apart from case, spacing, leading zeros or letters added at the end`
      : sameNumber.length > 0
        ? `it has the same invoice number as ${listOf(sameNumber)}, apart from case, spacing, leading zeros or letters added at the end, for the same supplier, and PayOnce pays an invoice number once`
        : OUTSIDE_PAYOUT_REASON;
  return { kind: "held", duplicateOf, sameNumber, reason, detail: null };
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
    const outage: Outage | undefined = engine.ledger.activeOutage(obligation.currency, obligation.transferMethod);
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
      const checked: { problem: string | null; route: string | null } =
        account !== null
          ? await accountProblem(engine, obligation, account)
          : record === undefined
            ? { problem: "the beneficiary is no longer in Airwallex", route: null }
            : { problem: null, route: routeKeyOf(record) };
      const wrongAccount: string | null = checked.problem;
      const decidedKey: string | null = account?.accountKey ?? (record === undefined ? null : accountKeyOf(record));

      const first: FirstPayment = engine.ledger.transaction((): FirstPayment => {
        // Another process may have held or paid it while Airwallex was read.
        const now: Obligation | undefined = waitingForFirst(engine.ledger, invoiceId);
        if (now === undefined) {
          throw new Error(`${invoiceId} is not waiting for its first payment`);
        }
        if (wrongAccount !== null) {
          engine.ledger.holdBeforePaying(invoiceId, [], wrongAccount);
          return { kind: "held", duplicateOf: [], sameNumber: [], reason: wrongAccount, detail: null };
        }
        const held: Extract<FirstPayment, { kind: "held" }> | undefined = heldForOthers(engine.ledger, now);
        if (held !== undefined) {
          engine.ledger.holdBeforePaying(invoiceId, held.duplicateOf, held.reason);
          return held;
        }
        // An account PayOnce has not paid this supplier, when it has paid them
        // another, waits for a person, as a replacement does: a callback first,
        // then two approvers. So does any account of a supplier PayOnce paid only
        // before it kept which account each payment went to.
        const lastPaid: string | null = record === undefined ? null : lastPaidHold(engine.ledger, now, record);
        if (lastPaid !== null) {
          engine.ledger.holdBeforePaying(invoiceId, [], lastPaid);
          return { kind: "held", duplicateOf: [], sameNumber: [], reason: lastPaid, detail: null };
        }
        // A supplier who wrote before anything was paid may be asking not to pay
        // it, or to pay elsewhere, so a person reads the email first. That
        // includes a pay run row waiting its turn.
        if (engine.ledger.emailCount(invoiceId) > 0) {
          engine.ledger.holdBeforePaying(invoiceId, [], EMAILS_BEFORE_PAYMENT_REASON);
          return { kind: "held", duplicateOf: [], sameNumber: [], reason: EMAILS_BEFORE_PAYMENT_REASON, detail: null };
        }
        // The agent never pays at a rate nobody has seen, so this is the least
        // serious reason to hold it and comes after the others.
        if (crossCurrency(now)) {
          const reason: string = `it is paid from ${now.sourceCurrency}, so a person approves the exchange rate before PayOnce pays it`;
          engine.ledger.holdBeforePaying(invoiceId, [], reason);
          return { kind: "held", duplicateOf: [], sameNumber: [], reason, detail: null };
        }
        if (availableMinor !== null) {
          const short: string | null = floorBreach(engine, now, availableMinor, before);
          if (short !== null) {
            engine.ledger.holdBeforePaying(invoiceId, [], CASH_HOLD_REASON);
            return { kind: "held", duplicateOf: [], sameNumber: [], reason: CASH_HOLD_REASON, detail: short };
          }
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
  engine: Engine,
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
export function holdRefused(engine: Engine, obligation: Obligation, refused: Attempt): Obligation {
  const reason: string = `Airwallex refused the original payment${refused.failureCode === null ? "" : ` (${refused.failureCode})`}, so nothing was sent`;
  engine.ledger.escalate(obligation.invoiceId, reason);
  note(engine.ledger, obligation.invoiceId, "decision", `Escalate: ${reason}`, "decision");
  return { ...obligation, state: "escalated", escalationReason: reason };
}

// The first payment of an open invoice with no attempt. A pay run's row sends its
// original, to the account the run approved, only in its turn: when the release
// or the server's watcher passes sendRunRow. Any other look leaves it for that
// turn. Any other invoice is here only when its first send failed before an
// attempt was opened, and the look tries it again. When startPayment holds it
// instead, the next look comes at once, and asks a person.
export async function startFirst(
  engine: Engine,
  obligation: Obligation,
  sendRunRow: boolean,
): Promise<NextLook> {
  const invoiceId: string = obligation.invoiceId;
  let account: AccountRef | null = null;
  if (obligation.runRowId !== null) {
    const row: RunRow | undefined = engine.ledger.runRow(obligation.runRowId);
    if (row === undefined || row.accountKey === null) {
      throw new Error(`${invoiceId} has no pay run row to send it from`);
    }
    if (!sendRunRow) {
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

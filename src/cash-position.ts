import type { Balance, BalanceState } from "./airwallex/balances.js";
import {
  isExpired,
  type Approval,
  type Attempt,
  type Ledger,
  type Obligation,
  type OutsidePayout,
  type PayRunRow,
} from "./ledger.js";
import {
  currencyFloor,
  debitCurrency,
  type CurrencyFloor,
  type FloorSource,
  type ReservePolicy,
} from "./reserve.js";

// What a line of money is. sending, approved and pay-run are promised and still in
// the available balance, so headroom takes them off. awaiting-approval and
// awaiting-person wait on a person and only the second headroom figure takes them
// off. with-bank, outside and fee-lost have already left the available balance.
export type CashKind =
  | "sending"
  | "approved"
  | "pay-run"
  | "awaiting-approval"
  | "awaiting-person"
  | "with-bank"
  | "outside"
  | "fee-lost";

export const CASH_KINDS: CashKind[] = [
  "sending",
  "approved",
  "pay-run",
  "awaiting-approval",
  "awaiting-person",
  "with-bank",
  "outside",
  "fee-lost",
];

const FIRM_KINDS: ReadonlySet<CashKind> = new Set<CashKind>(["sending", "approved", "pay-run"]);
const WAITING_KINDS: ReadonlySet<CashKind> = new Set<CashKind>([
  "awaiting-approval",
  "awaiting-person",
]);

export interface CashLine {
  kind: CashKind;
  invoiceId: string;
  // The wallet the money leaves.
  currency: string;
  // For fee-lost, the fee.
  amountMinor: number;
  // 0 when not known, and for fee-lost.
  feeMinor: number;
  feeKnown: boolean;
  // The bank's short reference, when the money is a transfer.
  reference: string | null;
  // The amount is the invoice's, because the transfer's was never read.
  estimated: boolean;
  // The pay run a pay-run line belongs to. Null on every other line.
  runId: number | null;
}

interface FeeEstimate {
  feeMinor: number;
  feeKnown: boolean;
}

// The fee a payment not sent yet should cost: the invoice's latest recorded fee,
// else the latest the ledger recorded in the same currency by the same transfer
// method, else 0 and not known.
function feeEstimate(ledger: Ledger, obligation: Obligation, attempts: Attempt[]): FeeEstimate {
  for (const attempt of [...attempts].reverse()) {
    if (attempt.feeMinor !== null) {
      return { feeMinor: attempt.feeMinor, feeKnown: true };
    }
  }
  const latest: number | null = ledger.latestFee(debitCurrency(obligation), obligation.transferMethod);
  return latest === null ? { feeMinor: 0, feeKnown: false } : { feeMinor: latest, feeKnown: true };
}

// An escalated invoice with nothing live or paid, PayOnce's or sent outside it, so
// a person can still release a payment for it: one held before paying, or one
// whose payments all failed.
function couldStillPay(
  obligation: Obligation,
  attempts: Attempt[],
  payouts: OutsidePayout[],
): boolean {
  return (
    obligation.state === "escalated" &&
    attempts.every((attempt: Attempt): boolean => attempt.state === "failed") &&
    payouts.every((payout: OutsidePayout): boolean => payout.state === "failed")
  );
}

function feeLost(
  invoiceId: string,
  currency: string,
  feeMinor: number | null,
  reference: string | null,
): CashLine {
  return {
    kind: "fee-lost",
    invoiceId,
    currency,
    amountMinor: feeMinor ?? 0,
    feeMinor: 0,
    feeKnown: feeMinor !== null,
    reference,
    estimated: false,
    runId: null,
  };
}

// Every line of money the ledger knows about, in every currency. Closed invoices
// add only the fees their failed transfers kept.
export function cashLines(ledger: Ledger, now: number = Date.now()): CashLine[] {
  const lines: CashLine[] = [];
  for (const obligation of ledger.obligations()) {
    const invoiceId: string = obligation.invoiceId;
    const wallet: string = debitCurrency(obligation);
    const attempts: Attempt[] = ledger.attempts(invoiceId);
    const payouts: OutsidePayout[] = ledger.outsidePayouts(invoiceId);

    // A fee of 0 lost nothing. One not recorded yet is listed as not known.
    for (const attempt of attempts) {
      if (attempt.state === "failed" && attempt.transferId !== null && attempt.feeMinor !== 0) {
        lines.push(feeLost(invoiceId, attempt.feeCurrency ?? wallet, attempt.feeMinor, attempt.reference));
      }
    }
    for (const payout of payouts) {
      if (payout.state === "failed" && payout.feeMinor !== 0) {
        lines.push(feeLost(invoiceId, payout.feeCurrency ?? wallet, payout.feeMinor, payout.reference));
      }
    }
    if (obligation.state === "settled" || obligation.state === "rejected") {
      continue;
    }

    for (const attempt of attempts) {
      if (attempt.state === "pending" && attempt.transferId === null) {
        lines.push({
          kind: "sending",
          invoiceId,
          currency: wallet,
          amountMinor: obligation.amountMinor,
          ...feeEstimate(ledger, obligation, attempts),
          reference: null,
          estimated: false,
          runId: null,
        });
      } else if (attempt.state === "pending" || attempt.state === "in_flight") {
        // A found invoice's original is a payout someone sent outside PayOnce.
        lines.push({
          kind: obligation.origin === "outside" && attempt.kind === "original" ? "outside" : "with-bank",
          invoiceId,
          currency: wallet,
          amountMinor: obligation.amountMinor,
          feeMinor: attempt.feeMinor ?? 0,
          feeKnown: attempt.feeMinor !== null,
          reference: attempt.reference,
          estimated: false,
          runId: null,
        });
      }
    }
    for (const payout of payouts) {
      if (payout.state === "in_flight" || payout.state === "unknown") {
        lines.push({
          kind: "outside",
          invoiceId,
          currency: payout.currency ?? wallet,
          amountMinor: payout.amountMinor ?? obligation.amountMinor,
          feeMinor: payout.feeMinor ?? 0,
          feeKnown: payout.feeMinor !== null,
          reference: payout.reference === "" ? null : payout.reference,
          estimated: payout.amountMinor === null,
          runId: null,
        });
      }
    }

    if (couldStillPay(obligation, attempts, payouts)) {
      const approval: Approval | undefined = ledger.latestApproval(invoiceId);
      const open: boolean = approval !== undefined && !isExpired(approval, now);
      lines.push({
        kind:
          open && approval?.state === "approved"
            ? "approved"
            : open && approval?.state === "requested"
              ? "awaiting-approval"
              : "awaiting-person",
        invoiceId,
        currency: wallet,
        amountMinor: obligation.amountMinor,
        ...feeEstimate(ledger, obligation, attempts),
        reference: null,
        estimated: false,
        runId: null,
      });
    }
  }
  return lines;
}

// Pay-run rows whose payment has not been opened yet, one line each with kind
// pay-run: the pay rows of a waiting run whose approval is approved and not
// expired, and released rows whose invoice is open with no attempt. Both come from
// the state of the rows, so a row drops out in the transaction that opens its
// attempt and is never counted twice. The fee is the latest the ledger recorded in
// the currency by the row's transfer method.
export function payRunLines(ledger: Ledger, now: number = Date.now()): CashLine[] {
  return ledger.payRunRows(now).map((row: PayRunRow): CashLine => {
    const fee: number | null = ledger.latestFee(row.currency, row.transferMethod);
    return {
      kind: "pay-run",
      invoiceId: row.invoiceId,
      currency: row.currency,
      amountMinor: row.amountMinor,
      feeMinor: fee ?? 0,
      feeKnown: fee !== null,
      reference: null,
      estimated: false,
      runId: row.runId,
    };
  });
}

// What committedMinor leaves out: the invoice being paid, or the run being
// released, whose own money is the payment in question.
export interface CommittedExcept {
  invoiceId?: string;
  runId?: number;
}

// Money promised to payments from this wallet that has not left its available
// balance yet, on every invoice and run but the one excepted: payments being sent
// with no transfer yet, approvals not used or expired, and pay-run rows approved or
// released and not sent. The policy takes it off before an automatic replacement
// and a pay run's checks do the same, and the panel's headroom takes off the same
// lines, so they always agree.
export function committedMinor(
  ledger: Ledger,
  currency: string,
  except: CommittedExcept,
): number {
  return [...cashLines(ledger), ...payRunLines(ledger)]
    .filter(
      (line: CashLine): boolean =>
        FIRM_KINDS.has(line.kind) &&
        line.currency === currency &&
        line.invoiceId !== except.invoiceId &&
        (except.runId === undefined || line.runId !== except.runId),
    )
    .reduce((sum: number, line: CashLine): number => sum + line.amountMinor + line.feeMinor, 0);
}

export interface KindTotal {
  minor: number;
  count: number;
  // Lines whose fee is not known, and so is not in minor.
  feeUnknown: number;
}

export interface InvoiceFloor {
  invoiceId: string;
  floorMinor: number;
}

export interface CurrencyCash {
  currency: string;
  // Null when the last good read had no balance in this currency, or there has
  // been no good read.
  airwallex: Omit<Balance, "currency"> | null;
  floor: {
    minor: number | null;
    source: FloorSource;
    // Open invoices held to a stricter floor of their own.
    invoiceFloors: InvoiceFloor[];
  };
  totals: Record<CashKind, KindTotal>;
  lines: CashLine[];
  // available - floor - promised. Null when available or the floor setting
  // cannot be read.
  headroomMinor: number | null;
  // headroom less every payment waiting on a person.
  headroomIfApprovedMinor: number | null;
}

export interface CashReport {
  generatedAt: string;
  airwallex: {
    readAt: string | null;
    ageSeconds: number | null;
    maxAgeSeconds: number;
    refreshing: boolean;
    error: { message: string; at: string } | null;
  };
  // When the watcher last checked the payments the ledger shows with the bank.
  // Null where no watcher runs.
  ledger: { statesCheckedAt: string | null };
  floors: { problem: string | null };
  // Null where pay runs are not counted.
  payRuns: { built: true } | null;
  currencies: CurrencyCash[];
}

export interface CashInput {
  ledger: Ledger;
  reserve: ReservePolicy;
  balances: BalanceState;
  statesCheckedAt: number | null;
  payRunLines: CashLine[] | null;
  now?: number;
}

function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

function totalsOf(lines: CashLine[]): Record<CashKind, KindTotal> {
  const totals: Record<CashKind, KindTotal> = Object.fromEntries(
    CASH_KINDS.map((kind: CashKind): [CashKind, KindTotal] => [
      kind,
      { minor: 0, count: 0, feeUnknown: 0 },
    ]),
  ) as Record<CashKind, KindTotal>;
  for (const line of lines) {
    const total: KindTotal = totals[line.kind];
    total.minor += line.amountMinor + line.feeMinor;
    total.count += 1;
    total.feeUnknown += line.feeKnown ? 0 : 1;
  }
  return totals;
}

function sumOf(totals: Record<CashKind, KindTotal>, kinds: ReadonlySet<CashKind>): number {
  return [...kinds].reduce((sum: number, kind: CashKind): number => sum + totals[kind].minor, 0);
}

// Per currency: what Airwallex holds, the floor, and what the ledger has promised,
// sent or lost, worked out to the headroom left above the floor. A currency is
// listed when it has a floor set, a line in the ledger, an invoice floor, or a
// balance that is not zero.
export function cashReport(input: CashInput): CashReport {
  const now: number = input.now ?? Date.now();
  const state: BalanceState = input.balances;
  const lines: CashLine[] = [...cashLines(input.ledger, now), ...(input.payRunLines ?? [])];
  const open: Obligation[] = input.ledger
    .obligations()
    .filter(
      (obligation: Obligation): boolean =>
        obligation.state !== "settled" &&
        obligation.state !== "rejected" &&
        obligation.invoiceFloorMinor > 0,
    );

  const codes: Set<string> = new Set<string>([
    ...input.reserve.floors.keys(),
    ...lines.map((line: CashLine): string => line.currency),
    ...open.map(debitCurrency),
  ]);
  for (const balance of state.balances) {
    if ((balance.totalMinor ?? balance.availableMinor ?? 0) !== 0) {
      codes.add(balance.currency);
    }
  }

  const currencies: CurrencyCash[] = [...codes]
    .sort((a: string, b: string): number => a.localeCompare(b))
    .map((currency: string): CurrencyCash => {
      const own: CashLine[] = lines.filter((line: CashLine): boolean => line.currency === currency);
      const totals: Record<CashKind, KindTotal> = totalsOf(own);
      const balance: Balance | undefined = state.balances.find(
        (entry: Balance): boolean => entry.currency === currency,
      );
      const floor: CurrencyFloor = currencyFloor(input.reserve, currency);
      const available: number | null = balance?.availableMinor ?? null;
      const headroom: number | null =
        available === null || floor.source === "unreadable"
          ? null
          : available - (floor.minor ?? 0) - sumOf(totals, FIRM_KINDS);
      return {
        currency,
        airwallex:
          balance === undefined
            ? null
            : {
                availableMinor: balance.availableMinor,
                reservedMinor: balance.reservedMinor,
                pendingMinor: balance.pendingMinor,
                prepaymentMinor: balance.prepaymentMinor,
                totalMinor: balance.totalMinor,
              },
        floor: {
          minor: floor.minor,
          source: floor.source,
          invoiceFloors: open
            .filter(
              (obligation: Obligation): boolean =>
                debitCurrency(obligation) === currency &&
                obligation.invoiceFloorMinor > (floor.minor ?? 0),
            )
            .map(
              (obligation: Obligation): InvoiceFloor => ({
                invoiceId: obligation.invoiceId,
                floorMinor: obligation.invoiceFloorMinor,
              }),
            ),
        },
        totals,
        lines: own,
        headroomMinor: headroom,
        headroomIfApprovedMinor: headroom === null ? null : headroom - sumOf(totals, WAITING_KINDS),
      };
    });

  return {
    generatedAt: new Date(now).toISOString(),
    airwallex: {
      readAt: iso(state.readAt),
      ageSeconds: state.readAt === null ? null : Math.max(0, Math.round((now - state.readAt) / 1000)),
      maxAgeSeconds: Math.round(state.maxAgeMs / 1000),
      refreshing: state.refreshing,
      error: state.error === null ? null : { message: state.error.message, at: new Date(state.error.at).toISOString() },
    },
    ledger: { statesCheckedAt: iso(input.statesCheckedAt) },
    floors: { problem: input.reserve.problem },
    payRuns: input.payRunLines === null ? null : { built: true },
    currencies,
  };
}

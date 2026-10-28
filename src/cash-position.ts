import type { Balance, BalanceState } from "./airwallex/balances.js";
import type { ApprovalTerms, FxTerms, LastQuote } from "./approval.js";
import {
  crossCurrency,
  isExpired,
  type Approval,
  type Attempt,
  type Ledger,
  type Obligation,
  type OutsidePayout,
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
  // The amount is not exact: the invoice's, because the transfer's was never
  // read, or for a payment from another currency's wallet, one from a quote no
  // request or attempt is on, or none at all.
  estimated: boolean;
  // The amount is an exchange rate quote's sell amount, not yet a transfer's.
  fromQuote?: boolean;
}

interface FeeEstimate {
  feeMinor: number;
  feeKnown: boolean;
}

interface Debit {
  amountMinor: number;
  estimated: boolean;
  fromQuote: boolean;
}

// What a payment takes from its wallet, before the fee. One from another
// currency's wallet takes what its quote sells, so until its transfer has been
// read only a quote knows it: exactly the quote an attempt was sent with or a
// request still open is on, and otherwise about the invoice's last quote, which
// may be on no request, as when nobody on the list can approve it. Before any
// quote it is 0, estimated. attempt is null for a payment not opened yet.
function debitOf(ledger: Ledger, obligation: Obligation, attempt: Attempt | null, now: number): Debit {
  if (!crossCurrency(obligation)) {
    return { amountMinor: obligation.amountMinor, estimated: false, fromQuote: false };
  }
  if (attempt !== null && attempt.sourceAmountMinor !== null) {
    return { amountMinor: attempt.sourceAmountMinor, estimated: false, fromQuote: false };
  }
  const approval: Approval | undefined = ledger.latestApproval(obligation.invoiceId);
  const fx: FxTerms | undefined =
    approval === undefined ? undefined : (JSON.parse(approval.terms) as ApprovalTerms).fx;
  const open: boolean =
    approval !== undefined &&
    (approval.state === "requested" || approval.state === "approved") &&
    !isExpired(approval, now);
  if (fx !== undefined && (attempt !== null ? attempt.quoteId === fx.quoteId : open)) {
    return { amountMinor: fx.sellAmountMinor, estimated: false, fromQuote: true };
  }
  const kept: string | undefined = ledger.lastQuote(obligation.invoiceId);
  const last: FxTerms | undefined = kept === undefined ? fx : (JSON.parse(kept) as LastQuote).fx;
  return last === undefined
    ? { amountMinor: 0, estimated: true, fromQuote: false }
    : { amountMinor: last.sellAmountMinor, estimated: true, fromQuote: true };
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
        const debit: Debit = debitOf(ledger, obligation, attempt, now);
        lines.push({
          kind: "sending",
          invoiceId,
          currency: wallet,
          amountMinor: debit.amountMinor,
          ...feeEstimate(ledger, obligation, attempts),
          reference: null,
          estimated: debit.estimated,
          fromQuote: debit.fromQuote,
        });
      } else if (attempt.state === "pending" || attempt.state === "in_flight") {
        const debit: Debit = debitOf(ledger, obligation, attempt, now);
        // A found invoice's original is a payout someone sent outside PayOnce.
        lines.push({
          kind: obligation.origin === "outside" && attempt.kind === "original" ? "outside" : "with-bank",
          invoiceId,
          currency: wallet,
          amountMinor: debit.amountMinor,
          feeMinor: attempt.feeMinor ?? 0,
          feeKnown: attempt.feeMinor !== null,
          reference: attempt.reference,
          estimated: debit.estimated,
          fromQuote: debit.fromQuote,
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
        });
      }
    }

    if (couldStillPay(obligation, attempts, payouts)) {
      const approval: Approval | undefined = ledger.latestApproval(invoiceId);
      const open: boolean = approval !== undefined && !isExpired(approval, now);
      const debit: Debit = debitOf(ledger, obligation, null, now);
      lines.push({
        kind:
          open && approval?.state === "approved"
            ? "approved"
            : open && approval?.state === "requested"
              ? "awaiting-approval"
              : "awaiting-person",
        invoiceId,
        currency: wallet,
        amountMinor: debit.amountMinor,
        ...feeEstimate(ledger, obligation, attempts),
        reference: null,
        estimated: debit.estimated,
        fromQuote: debit.fromQuote,
      });
    }
  }
  return lines;
}

// Approved pay-run rows whose payment has not been opened yet, one line each with
// kind pay-run. A row must drop out in the transaction that opens its attempt, or
// it is counted twice. Pay runs are not built yet, so there are none to count and
// the panel says so.
export function payRunLines(_ledger: Ledger): CashLine[] | null {
  return null;
}

// Money promised to payments from this wallet that has not left its available
// balance yet, on every invoice but exceptInvoiceId: payments being sent with no
// transfer yet, approvals not used or expired, and approved pay-run rows. The
// policy takes it off before an automatic replacement, and the panel's headroom
// takes off the same lines, so the two always agree.
export function committedMinor(
  ledger: Ledger,
  currency: string,
  exceptInvoiceId: string,
): number {
  return [...cashLines(ledger), ...(payRunLines(ledger) ?? [])]
    .filter(
      (line: CashLine): boolean =>
        FIRM_KINDS.has(line.kind) &&
        line.currency === currency &&
        line.invoiceId !== exceptInvoiceId,
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

import { createHash } from "node:crypto";
import { deadlineMinutes } from "./deadlines.js";
import { INVOICE_ID_PATTERN } from "./ledger.js";
import { formatMoney } from "./money.js";

// Reconciliation's matcher: Airwallex's wallet movements and transfers against
// each other and against PayOnce's ledger. It is pure. It reads nothing and
// writes nothing, so a run, the offline check and the movements view all match
// the same way, and the store records what it found.

export type BreakKind =
  | "debit-missing"
  | "debited-twice"
  | "debit-differs"
  | "fee-differs"
  | "refund-missing"
  | "refund-differs"
  | "refund-unexpected"
  | "paid-then-returned"
  | "untied-payout"
  | "unexplained-credit"
  | "unexplained-debit"
  | "unreadable-movement"
  | "balance-gap"
  | "balance-differs";

export const BREAK_KINDS: readonly BreakKind[] = [
  "paid-then-returned",
  "refund-missing",
  "refund-differs",
  "refund-unexpected",
  "debited-twice",
  "debit-differs",
  "debit-missing",
  "fee-differs",
  "untied-payout",
  "unexplained-credit",
  "unexplained-debit",
  "unreadable-movement",
  "balance-gap",
  "balance-differs",
];

// These close on the first run whose reads no longer show them. Every other kind
// stays open until a person explains it, however the reads change.
const BY_ITSELF: ReadonlySet<BreakKind> = new Set<BreakKind>([
  "debit-missing",
  "refund-missing",
  "unreadable-movement",
  "balance-gap",
  "balance-differs",
]);

// These open on the first live run that finds them, since each waits out its
// window first. Every other kind opens only when two live runs in a row find the
// same facts.
const AT_ONCE: ReadonlySet<BreakKind> = new Set<BreakKind>(["debit-missing", "refund-missing"]);

// Every kind whose subject is a transfer, which a transfer held for a run keeps.
const TRANSFER_KINDS: readonly BreakKind[] = [
  "debit-missing",
  "debited-twice",
  "debit-differs",
  "fee-differs",
  "refund-missing",
  "refund-differs",
  "refund-unexpected",
  "paid-then-returned",
  "untied-payout",
];

export function clearsByItself(kind: BreakKind): boolean {
  return BY_ITSELF.has(kind);
}

export function opensAtOnce(kind: BreakKind): boolean {
  return AT_ONCE.has(kind);
}

// Why a break no longer found clears: Airwallex's records no longer show a kind
// that clears by itself, or the sweep has tied a payout to an invoice. Null keeps
// it open for a person.
export type ClearReason = "airwallex" | "tied";

export function clearReason(kind: BreakKind, subject: string, result: MatchResult): ClearReason | null {
  if (clearsByItself(kind)) {
    return "airwallex";
  }
  return kind === "untied-payout" && result.tied.has(subject) ? "tied" : null;
}

export function isBreakKind(value: unknown): value is BreakKind {
  return typeof value === "string" && (BREAK_KINDS as readonly string[]).includes(value);
}

export const KIND_LABELS: Record<BreakKind, string> = {
  "debit-missing": "Debit missing",
  "debited-twice": "Debited more than once",
  "debit-differs": "Debit differs from the transfer",
  "fee-differs": "Fee differs from the transfer",
  "refund-missing": "Refund missing",
  "refund-differs": "Refund differs",
  "refund-unexpected": "Money came back unexpectedly",
  "paid-then-returned": "Paid, then returned",
  "untied-payout": "Payout tied to no invoice",
  "unexplained-credit": "Money in that no transfer explains",
  "unexplained-debit": "Money out that no transfer explains",
  "unreadable-movement": "Movement PayOnce cannot read",
  "balance-gap": "Movements do not add up",
  "balance-differs": "Balance differs from Airwallex's",
};

// What a person does about each kind, in PayOnce's words.
export const KIND_ACTIONS: Record<BreakKind, string> = {
  "debit-missing":
    "Open the transfer in the Airwallex web app. A transfer that was never funded fails or is cancelled with nothing to refund. This clears by itself once the debit posts.",
  "debited-twice": "Ask Airwallex for the extra debit back, quoting the transfer's reference.",
  "debit-differs": "Raise it with Airwallex, quoting the transfer's reference.",
  "fee-differs": "Check the fee with Airwallex. A third-party or FX cancellation fee after a failure lands here too.",
  "refund-missing": "Ask Airwallex where the refund is. This clears by itself when the refund lands.",
  "refund-differs": "Compare it with the fee kept. If the fee came back too, nothing is lost.",
  "refund-unexpected":
    "The supplier's bank may have returned it after the transfer was paid. Check the invoice before paying it again.",
  "paid-then-returned":
    "Check with the supplier before paying again. PayOnce does not reopen the invoice by itself.",
  "untied-payout":
    "This clears by itself when the sweep ties the payout to an invoice. Otherwise a person explains it, saying what it paid.",
  "unexplained-credit": "Say what it is, such as a top-up.",
  "unexplained-debit": "Say what it is, or raise it with Airwallex.",
  "unreadable-movement":
    "Look at the wallet in the Airwallex web app. This clears by itself once Airwallex lists the movement in a form PayOnce can read.",
  "balance-gap":
    "Look at the wallet's movements around that point in the Airwallex web app. This clears by itself once they add up.",
  "balance-differs": "Check again. If it stays, a movement is missing from what Airwallex lists.",
};

// A wallet movement as the store keeps it. A field PayOnce could not read is
// null, or currency is "", and the movement then counts as unreadable.
export interface Movement {
  id: string;
  currency: string;
  amountMinor: number | null;
  balanceMinor: number | null;
  postedMs: number;
  // Its place in the read it came from, 0 for the newest, for movements posted in
  // the same second.
  seq: number;
  sourceId: string | null;
  sourceType: string | null;
  transactionType: string | null;
}

// A transfer as the store keeps it. found is false when Airwallex has no
// transfer by that id.
export interface ReconTransfer {
  transferId: string;
  found: boolean;
  reference: string | null;
  status: string | null;
  method: string | null;
  createdMs: number | null;
  updatedMs: number | null;
  debitMinor: number | null;
  debitCurrency: string | null;
  transferMinor: number | null;
  transferCurrency: string | null;
  feeMinor: number | null;
  feeCurrency: string | null;
  // When a run first read it failed or cancelled.
  failedSeenMs: number | null;
  // When a run first read it paid, or first found the ledger recording it paid.
  // Kept, so a payment later read as failed is still known to have been paid.
  paidSeenMs: number | null;
}

// A transfer PayOnce's ledger holds, matched by transfer id only: an attempt's
// own, one kept beside an attempt because it does not match the invoice, or a
// payout sent outside PayOnce tied to an invoice.
export interface LedgerTransfer {
  transferId: string;
  invoiceId: string;
  how: "attempt" | "mismatched" | "outside";
  paid: boolean;
}

// An invoice the ledger closed as paid (settled), with the wallet it is paid from.
export interface ClosedInvoice {
  invoiceId: string;
  currency: string;
}

// Available balances read just before and just after the history, by currency.
export interface BalancePair {
  before: number | null;
  after: number | null;
}

export interface MatchInput {
  now: number;
  startedMs: number;
  movements: Movement[];
  transfers: ReconTransfer[];
  ledger: LedgerTransfer[];
  closed: ClosedInvoice[];
  // Transfers movements name that Airwallex refused to show, not read since.
  refused: Set<string>;
  // Null when nothing was read, as offline.
  balances: Map<string, BalancePair> | null;
  // Facts of the pending, open or explained break on each key, for the ones that
  // carry something over.
  prior: Map<string, string>;
}

export interface DebitMissingFacts {
  kind: "debit-missing";
  currency: string;
  transferId: string;
  reference: string | null;
  expectedMinor: number | null;
}

export interface DebitedTwiceFacts {
  kind: "debited-twice";
  currency: string;
  transferId: string;
  reference: string | null;
  count: number;
  totalMinor: number;
  movements: string[];
}

export interface AmountDiffersFacts {
  kind: "debit-differs" | "fee-differs" | "refund-differs";
  currency: string;
  transferId: string;
  reference: string | null;
  foundMinor: number;
  expectedMinor: number | null;
  movements: string[];
}

export interface RefundMissingFacts {
  kind: "refund-missing";
  currency: string;
  transferId: string;
  reference: string | null;
  expectedMinor: number;
}

export interface RefundUnexpectedFacts {
  kind: "refund-unexpected";
  currency: string;
  transferId: string;
  reference: string | null;
  foundMinor: number;
  movements: string[];
}

export interface PaidReturnedFacts {
  kind: "paid-then-returned";
  currency: string;
  // Null when only the invoice shows it: the ledger closed it as paid, and none of
  // its payments is recorded as paid now.
  transferId: string | null;
  reference: string | null;
  invoiceId: string;
  // How the ledger holds the transfer: its own payment, a transfer kept beside an
  // attempt because it does not match the invoice, or a payout sent outside
  // PayOnce. Null with no transfer.
  payment: LedgerTransfer["how"] | null;
  // Null while only the transfer's status says it failed.
  returnedMinor: number | null;
  movements: string[];
}

export interface UntiedFacts {
  kind: "untied-payout";
  currency: string;
  transferId: string;
  reference: string | null;
  debitMinor: number;
  refundedMinor: number;
}

export interface UnexplainedFacts {
  kind: "unexplained-credit" | "unexplained-debit";
  currency: string;
  movementId: string;
  amountMinor: number;
  type: string | null;
}

export interface UnreadableFacts {
  kind: "unreadable-movement";
  currency: string;
  movementId: string;
  // The transfer it names, which waits while the movement cannot be read. Null
  // when its source cannot be read either, so its wallet's transfers wait.
  transferId: string | null;
}

export interface GapFacts {
  kind: "balance-gap";
  currency: string;
  movementId: string;
  foundMinor: number;
  expectedMinor: number;
}

export interface DiffersFacts {
  kind: "balance-differs";
  currency: string;
  differenceMinor: number;
  // The newest movement when this difference was first found, kept while it
  // stands, so the facts do not change with every payment.
  sinceMovementId: string;
}

export type BreakFacts =
  | DebitMissingFacts
  | DebitedTwiceFacts
  | AmountDiffersFacts
  | RefundMissingFacts
  | RefundUnexpectedFacts
  | PaidReturnedFacts
  | UntiedFacts
  | UnexplainedFacts
  | UnreadableFacts
  | GapFacts
  | DiffersFacts;

export interface FoundBreak {
  key: string;
  kind: BreakKind;
  subject: string;
  currency: string;
  invoiceId: string | null;
  transferId: string | null;
  facts: string;
  fingerprint: string;
}

export type WaitingKind = "debit" | "refund" | "untied" | "unread" | "refused" | "unfunded";

// Something inside its window, which is not a break yet. dueAt is when it
// becomes one, null when no time is set.
export interface WaitingItem {
  kind: WaitingKind;
  currency: string;
  reference: string | null;
  amountMinor: number | null;
  status: string | null;
  dueAt: string | null;
}

export type WalletStatus =
  | "adds-up"
  | "gap"
  | "differs"
  | "moved"
  | "unchecked"
  | "empty"
  | "not-two-decimal"
  | "unreadable";

export interface WalletSummary {
  currency: string;
  movements: number;
  openingMinor: number | null;
  inMinor: number;
  outMinor: number;
  holdsMinor: number;
  closingMinor: number | null;
  availableMinor: number | null;
  status: WalletStatus;
  // How the wallet's movements are explained.
  payonce: number;
  mismatched: number;
  outside: number;
  untied: number;
  before: number;
  holds: number;
  waiting: number;
  unexplained: number;
}

export type MovementHow =
  | "payonce"
  | "mismatched"
  | "outside"
  | "untied"
  | "before"
  | "hold"
  | "waiting"
  | "unexplained"
  | "unreadable"
  | "not-two-decimal";

export interface MovementLabel {
  how: MovementHow;
  invoiceId: string | null;
  reference: string | null;
}

export interface MatchResult {
  breaks: FoundBreak[];
  // Transfer ids the ledger ties to an invoice. A payout tied to no invoice that
  // is here now was tied by the sweep, so its break clears.
  tied: Set<string>;
  // Keys this run could not check, which keep the state they had.
  unchecked: Set<string>;
  wallets: WalletSummary[];
  waiting: WaitingItem[];
  labels: Map<string, MovementLabel>;
  // Transfers movements name that PayOnce has not read, to read by id.
  unread: string[];
}

const MS_PER_MINUTE: number = 60_000;
const FAILED: ReadonlySet<string> = new Set<string>(["FAILED", "CANCELLED"]);
// Not funded yet, so no debit is expected.
const UNFUNDED: ReadonlySet<string> = new Set<string>(["SCHEDULED", "OVERDUE"]);
// The rows Airwallex's bank feed guide leaves out, which the web app's wallet
// transactions do not show either.
const HOLD_TYPES: ReadonlySet<string> = new Set<string>([
  "HOLD",
  "HOLD_RELEASE",
  "PAYMENT_RESERVE_HOLD",
  "PAYMENT_RESERVE_RELEASE",
  "ISSUING_AUTHORISATION_HOLD",
  "ISSUING_AUTHORISATION_RELEASE",
]);
const TRANSFER_SOURCES: ReadonlySet<string> = new Set<string>(["PAYOUT", "BATCH_PAYOUT", "FEE"]);
const TRANSFER_TYPES: ReadonlySet<string> = new Set<string>(["PAYOUT", "PAYOUT_FAILURE", "PAYOUT_REVERSAL", "FEE"]);

// transaction_type in PayOnce's words. Anything else is "another kind".
const TYPE_WORDS: Record<string, string> = {
  DEPOSIT: "a deposit",
  DEPOSIT_REVERSAL: "a deposit reversal",
  ADJUSTMENT: "an adjustment",
  CONVERSION_SELL: "a conversion",
  CONVERSION_BUY: "a conversion",
  CONVERSION_REVERSAL: "a conversion reversal",
  FEE: "a fee",
  PAYOUT: "a payout",
  PAYOUT_FAILURE: "a payout failure",
  PAYOUT_REVERSAL: "a payout reversal",
  TRANSFER: "a transfer between accounts",
};

export function typeWords(type: unknown): string {
  return typeof type === "string" && Object.hasOwn(TYPE_WORDS, type) ? (TYPE_WORDS[type] ?? "another kind") : "another kind";
}

// The same, as a label: "Deposit", "Payout reversal", "Another kind".
export function typeName(type: unknown): string {
  const words: string = typeWords(type).replace(/^(a|an) /, "");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function twoDecimal(currency: string): boolean {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits === 2
    );
  } catch {
    return false;
  }
}

export function fingerprintOf(facts: string): string {
  return createHash("sha256").update(facts, "utf8").digest("hex");
}

function found(
  kind: BreakKind,
  subject: string,
  currency: string,
  invoiceId: string | null,
  transferId: string | null,
  facts: BreakFacts,
): FoundBreak {
  const text: string = JSON.stringify(facts);
  return { key: `${kind}:${subject}`, kind, subject, currency, invoiceId, transferId, facts: text, fingerprint: fingerprintOf(text) };
}

function readable(movement: Movement): boolean {
  return movement.amountMinor !== null && movement.balanceMinor !== null && movement.currency !== "";
}

function isHold(movement: Movement): boolean {
  return (
    (movement.transactionType !== null && HOLD_TYPES.has(movement.transactionType)) ||
    movement.sourceType === "PAYMENT_RESERVE"
  );
}

function isFee(movement: Movement): boolean {
  return movement.transactionType === "FEE" || movement.sourceType === "FEE";
}

function namesTransfer(movement: Movement): boolean {
  return (
    movement.sourceId !== null &&
    ((movement.sourceType !== null && TRANSFER_SOURCES.has(movement.sourceType)) ||
      (movement.transactionType !== null && TRANSFER_TYPES.has(movement.transactionType)))
  );
}

function sum(movements: Movement[]): number {
  return movements.reduce((total: number, movement: Movement): number => total + (movement.amountMinor ?? 0), 0);
}

function ids(movements: Movement[]): string[] {
  return movements.map((movement: Movement): string => movement.id);
}

// Oldest first. Airwallex lists newest first, so within one second the movement
// read later in its window is the older.
function chronological(a: Movement, b: Movement): number {
  return a.postedMs - b.postedMs || b.seq - a.seq;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// The earliest time a failed transfer can have failed, by what PayOnce knows: its
// updated_at, and when a run first read it failed. Both come after the failure.
export function failedBy(transfer: ReconTransfer): number | null {
  const times: number[] = [transfer.updatedMs, transfer.failedSeenMs].filter(
    (time: number | null): time is number => time !== null,
  );
  return times.length === 0 ? null : Math.min(...times);
}

function windowMs(transfer: ReconTransfer): number {
  return deadlineMinutes(transfer.method ?? "") * MS_PER_MINUTE;
}

export function match(input: MatchInput): MatchResult {
  const breaks: FoundBreak[] = [];
  const waiting: WaitingItem[] = [];
  const labels: Map<string, MovementLabel> = new Map();
  const unchecked: Set<string> = new Set();
  const unread: Set<string> = new Set();

  const transfers: Map<string, ReconTransfer> = new Map();
  const known: Set<string> = new Set();
  for (const transfer of input.transfers) {
    known.add(transfer.transferId);
    if (transfer.found) {
      transfers.set(transfer.transferId, transfer);
    }
  }
  const tied: Map<string, LedgerTransfer> = new Map();
  for (const entry of input.ledger) {
    if (!tied.has(entry.transferId)) {
      tied.set(entry.transferId, entry);
    }
  }

  // A movement PayOnce cannot read may be any of its transfer's movements, so
  // that transfer waits for this run: none of its breaks opens, changes or
  // clears. With no source to read, every transfer in its wallet waits, or in
  // every wallet when its currency cannot be read either.
  const heldTransfers: Set<string> = new Set();
  const heldWallets: Set<string> = new Set();
  const reconciled: Movement[] = [];
  for (const movement of input.movements) {
    if (!readable(movement)) {
      labels.set(movement.id, { how: "unreadable", invoiceId: null, reference: null });
      if (movement.sourceId !== null) {
        heldTransfers.add(movement.sourceId);
      } else {
        heldWallets.add(movement.currency);
      }
      breaks.push(
        found("unreadable-movement", movement.id, movement.currency, null, movement.sourceId, {
          kind: "unreadable-movement",
          currency: movement.currency,
          movementId: movement.id,
          transferId: movement.sourceId,
        }),
      );
      continue;
    }
    if (!twoDecimal(movement.currency)) {
      labels.set(movement.id, { how: "not-two-decimal", invoiceId: null, reference: null });
      continue;
    }
    reconciled.push(movement);
  }

  const bySource: Map<string, Movement[]> = new Map();
  for (const movement of reconciled) {
    if (isHold(movement)) {
      labels.set(movement.id, { how: "hold", invoiceId: null, reference: null });
      continue;
    }
    if (movement.sourceId !== null && (namesTransfer(movement) || transfers.has(movement.sourceId))) {
      const list: Movement[] = bySource.get(movement.sourceId) ?? [];
      list.push(movement);
      bySource.set(movement.sourceId, list);
    }
  }

  // Every transfer created since the ledger started, against the movements that
  // name it.
  const returnedInvoices: Set<string> = new Set();
  for (const transfer of transfers.values()) {
    const movements: Movement[] = bySource.get(transfer.transferId) ?? [];
    const tie: LedgerTransfer | undefined = tied.get(transfer.transferId);
    const reference: string | null = transfer.reference;
    const before: boolean = transfer.createdMs !== null && transfer.createdMs < input.startedMs;
    const how: MovementHow = tie === undefined ? (before ? "before" : "untied") : tie.how === "attempt" ? "payonce" : tie.how;
    for (const movement of movements) {
      labels.set(movement.id, { how, invoiceId: tie?.invoiceId ?? null, reference });
    }
    const fees: Movement[] = movements.filter(isFee);
    const main: Movement[] = movements.filter((movement: Movement): boolean => !isFee(movement));
    const debits: Movement[] = main.filter((movement: Movement): boolean => (movement.amountMinor ?? 0) < 0);
    const credits: Movement[] = main.filter((movement: Movement): boolean => (movement.amountMinor ?? 0) > 0);
    const failed: boolean = transfer.status !== null && FAILED.has(transfer.status);
    const wallet: string = transfer.debitCurrency ?? debits[0]?.currency ?? "";
    // A transfer from a wallet in a currency without two decimals is not
    // reconciled, as that wallet's movements are not: they were set aside above,
    // so no break about it could ever clear. The wallet decides, never the
    // currency the transfer pays in, so a USD wallet's debit for a JPY transfer
    // is reconciled like any other.
    if (
      heldTransfers.has(transfer.transferId) ||
      heldWallets.has(wallet) ||
      heldWallets.has("") ||
      (wallet !== "" && !twoDecimal(wallet))
    ) {
      for (const kind of TRANSFER_KINDS) {
        unchecked.add(`${kind}:${transfer.transferId}`);
      }
      continue;
    }

    // Paid, by the ledger now or by what a run read or found before, and Airwallex
    // now shows it failed or gave money back. What was read before is kept, so a
    // look that later records the payment as failed does not hide it.
    const returned: boolean = tie !== undefined && (tie.paid || transfer.paidSeenMs !== null) && (failed || credits.length > 0);
    if (tie !== undefined && returned) {
      returnedInvoices.add(tie.invoiceId);
      breaks.push(
        found("paid-then-returned", transfer.transferId, credits[0]?.currency ?? wallet, tie.invoiceId, transfer.transferId, {
          kind: "paid-then-returned",
          currency: credits[0]?.currency ?? wallet,
          transferId: transfer.transferId,
          reference,
          invoiceId: tie.invoiceId,
          payment: tie.how,
          returnedMinor: credits.length === 0 ? null : sum(credits),
          movements: ids(credits),
        }),
      );
    }
    // A transfer from before the ledger started is matched only for that.
    if (before) {
      continue;
    }
    const due: number | null = transfer.createdMs === null ? null : transfer.createdMs + windowMs(transfer);
    if (tie === undefined && movements.length > 0) {
      if (due !== null && input.now < due) {
        waiting.push({ kind: "untied", currency: wallet, reference, amountMinor: -sum(debits), status: null, dueAt: iso(due) });
      } else {
        breaks.push(
          found("untied-payout", transfer.transferId, wallet, null, transfer.transferId, {
            kind: "untied-payout",
            currency: wallet,
            transferId: transfer.transferId,
            reference,
            debitMinor: -sum(debits),
            refundedMinor: sum(credits),
          }),
        );
      }
    }

    if (debits.length === 0) {
      if (failed) {
        if (credits.length > 0) {
          breaks.push(
            found("refund-differs", transfer.transferId, credits[0]?.currency ?? wallet, tie?.invoiceId ?? null, transfer.transferId, {
              kind: "refund-differs",
              currency: credits[0]?.currency ?? wallet,
              transferId: transfer.transferId,
              reference,
              foundMinor: sum(credits),
              expectedMinor: 0,
              movements: ids(credits),
            }),
          );
        }
      } else if (transfer.status !== null && UNFUNDED.has(transfer.status)) {
        waiting.push({ kind: "unfunded", currency: wallet, reference, amountMinor: transfer.debitMinor, status: transfer.status, dueAt: null });
      } else if (due !== null && input.now < due) {
        waiting.push({ kind: "debit", currency: wallet, reference, amountMinor: transfer.debitMinor, status: null, dueAt: iso(due) });
      } else {
        breaks.push(
          found("debit-missing", transfer.transferId, wallet, tie?.invoiceId ?? null, transfer.transferId, {
            kind: "debit-missing",
            currency: wallet,
            transferId: transfer.transferId,
            reference,
            expectedMinor: transfer.debitMinor,
          }),
        );
      }
      continue;
    }

    const debitCurrency: string = debits[0]?.currency ?? wallet;
    const debited: number = -sum(debits);
    if (debits.length > 1) {
      breaks.push(
        found("debited-twice", transfer.transferId, debitCurrency, tie?.invoiceId ?? null, transfer.transferId, {
          kind: "debited-twice",
          currency: debitCurrency,
          transferId: transfer.transferId,
          reference,
          count: debits.length,
          totalMinor: debited,
          movements: ids(debits),
        }),
      );
    } else if (transfer.debitMinor === null || debited !== transfer.debitMinor || debitCurrency !== transfer.debitCurrency) {
      breaks.push(
        found("debit-differs", transfer.transferId, debitCurrency, tie?.invoiceId ?? null, transfer.transferId, {
          kind: "debit-differs",
          currency: debitCurrency,
          transferId: transfer.transferId,
          reference,
          foundMinor: debited,
          expectedMinor: debitCurrency === transfer.debitCurrency ? transfer.debitMinor : null,
          movements: ids(debits),
        }),
      );
    }

    // The fee the wallet shows against the transfer's own, in the fee's wallet.
    if (transfer.feeMinor !== null && transfer.feeCurrency !== null) {
      const feeCurrency: string = transfer.feeCurrency;
      const elsewhere: Movement[] = fees.filter((movement: Movement): boolean => movement.currency !== feeCurrency);
      const charged: number = -sum(fees.filter((movement: Movement): boolean => movement.currency === feeCurrency));
      if (elsewhere.length > 0 || charged !== transfer.feeMinor) {
        const shown: string = elsewhere[0]?.currency ?? feeCurrency;
        breaks.push(
          found("fee-differs", transfer.transferId, shown, tie?.invoiceId ?? null, transfer.transferId, {
            kind: "fee-differs",
            currency: shown,
            transferId: transfer.transferId,
            reference,
            foundMinor: elsewhere.length > 0 ? -sum(elsewhere) : charged,
            expectedMinor: elsewhere.length > 0 ? null : transfer.feeMinor,
            movements: ids(fees),
          }),
        );
      }
    }

    if (failed) {
      if (credits.length === 0) {
        const since: number | null = failedBy(transfer);
        const refundDue: number | null = since === null ? null : since + windowMs(transfer);
        if (refundDue !== null && input.now < refundDue) {
          waiting.push({ kind: "refund", currency: debitCurrency, reference, amountMinor: debited, status: null, dueAt: iso(refundDue) });
        } else {
          breaks.push(
            found("refund-missing", transfer.transferId, debitCurrency, tie?.invoiceId ?? null, transfer.transferId, {
              kind: "refund-missing",
              currency: debitCurrency,
              transferId: transfer.transferId,
              reference,
              expectedMinor: debited,
            }),
          );
        }
      } else {
        // The full debit back in the wallet it left, or, for a transfer that
        // converts, the transfer amount in the transfer currency, as Airwallex
        // refunds one by default.
        const back: number = sum(credits.filter((movement: Movement): boolean => movement.currency === debitCurrency));
        const converted: boolean =
          transfer.transferCurrency !== null && transfer.transferCurrency !== debitCurrency;
        const backConverted: number = converted
          ? sum(credits.filter((movement: Movement): boolean => movement.currency === transfer.transferCurrency))
          : 0;
        const whole: boolean =
          (back === debited && backConverted === 0) ||
          (converted && back === 0 && backConverted === transfer.transferMinor);
        if (!whole) {
          const shown: string = credits[0]?.currency ?? debitCurrency;
          breaks.push(
            found("refund-differs", transfer.transferId, shown, tie?.invoiceId ?? null, transfer.transferId, {
              kind: "refund-differs",
              currency: shown,
              transferId: transfer.transferId,
              reference,
              foundMinor: sum(credits.filter((movement: Movement): boolean => movement.currency === shown)),
              expectedMinor: shown === debitCurrency ? debited : transfer.transferMinor,
              movements: ids(credits),
            }),
          );
        }
      }
    } else if (credits.length > 0 && !returned) {
      const shown: string = credits[0]?.currency ?? debitCurrency;
      breaks.push(
        found("refund-unexpected", transfer.transferId, shown, tie?.invoiceId ?? null, transfer.transferId, {
          kind: "refund-unexpected",
          currency: shown,
          transferId: transfer.transferId,
          reference,
          foundMinor: sum(credits.filter((movement: Movement): boolean => movement.currency === shown)),
          movements: ids(credits),
        }),
      );
    }
  }

  // Every movement no transfer above explains.
  for (const movement of reconciled) {
    if (labels.has(movement.id)) {
      continue;
    }
    const source: string | null = movement.sourceId;
    const tie: LedgerTransfer | undefined = source === null ? undefined : tied.get(source);
    if (tie !== undefined) {
      labels.set(movement.id, { how: tie.how === "attempt" ? "payonce" : tie.how, invoiceId: tie.invoiceId, reference: null });
      continue;
    }
    if (source !== null && heldTransfers.has(source)) {
      labels.set(movement.id, { how: "waiting", invoiceId: null, reference: null });
      unchecked.add(`unexplained-credit:${movement.id}`);
      unchecked.add(`unexplained-debit:${movement.id}`);
      continue;
    }
    if (source !== null && namesTransfer(movement) && !known.has(source)) {
      const refused: boolean = input.refused.has(source);
      labels.set(movement.id, { how: "waiting", invoiceId: null, reference: null });
      waiting.push({
        kind: refused ? "refused" : "unread",
        currency: movement.currency,
        reference: null,
        amountMinor: movement.amountMinor,
        status: null,
        dueAt: null,
      });
      unread.add(source);
      continue;
    }
    const amount: number = movement.amountMinor ?? 0;
    labels.set(movement.id, { how: "unexplained", invoiceId: null, reference: null });
    const kind: BreakKind = amount >= 0 ? "unexplained-credit" : "unexplained-debit";
    breaks.push(
      found(kind, movement.id, movement.currency, null, null, {
        kind,
        currency: movement.currency,
        movementId: movement.id,
        amountMinor: Math.abs(amount),
        type: movement.transactionType,
      }),
    );
  }

  // An invoice the ledger closed as paid that none of its payments pays now, as
  // when a look later reads its paid payment as failed. Left out when a break
  // names one of its transfers, now or on file.
  const paidNow: Set<string> = new Set();
  const namedOnFile: Set<string> = new Set();
  for (const entry of input.ledger) {
    if (entry.paid) {
      paidNow.add(entry.invoiceId);
    }
    if (input.prior.has(`paid-then-returned:${entry.transferId}`)) {
      namedOnFile.add(entry.invoiceId);
    }
  }
  for (const invoice of input.closed) {
    if (paidNow.has(invoice.invoiceId) || returnedInvoices.has(invoice.invoiceId) || namedOnFile.has(invoice.invoiceId)) {
      continue;
    }
    breaks.push(
      found("paid-then-returned", `invoice:${invoice.invoiceId}`, invoice.currency, invoice.invoiceId, null, {
        kind: "paid-then-returned",
        currency: invoice.currency,
        transferId: null,
        reference: null,
        invoiceId: invoice.invoiceId,
        payment: null,
        returnedMinor: null,
        movements: [],
      }),
    );
  }

  const currencies: Set<string> = new Set();
  for (const movement of input.movements) {
    if (movement.currency !== "") {
      currencies.add(movement.currency);
    }
  }
  for (const [currency, pair] of input.balances ?? new Map<string, BalancePair>()) {
    if (pair.after !== 0 || pair.before !== 0) {
      currencies.add(currency);
    }
  }
  for (const transfer of transfers.values()) {
    if (transfer.debitCurrency !== null && (transfer.createdMs === null || transfer.createdMs >= input.startedMs)) {
      currencies.add(transfer.debitCurrency);
    }
  }

  const wallets: WalletSummary[] = [];
  for (const currency of [...currencies].sort()) {
    const all: Movement[] = input.movements.filter((movement: Movement): boolean => movement.currency === currency);
    const pair: BalancePair | undefined = input.balances?.get(currency);
    const summary: WalletSummary = {
      currency,
      movements: all.length,
      openingMinor: null,
      inMinor: 0,
      outMinor: 0,
      holdsMinor: 0,
      closingMinor: null,
      availableMinor: pair?.after ?? null,
      status: "empty",
      payonce: 0,
      mismatched: 0,
      outside: 0,
      untied: 0,
      before: 0,
      holds: 0,
      waiting: 0,
      unexplained: 0,
    };
    wallets.push(summary);
    const differsKey: string = `balance-differs:${currency}`;
    if (!twoDecimal(currency)) {
      summary.status = "not-two-decimal";
      continue;
    }
    for (const movement of all) {
      const label: MovementLabel | undefined = labels.get(movement.id);
      const how: MovementHow = label?.how ?? "unexplained";
      if (how === "payonce") summary.payonce += 1;
      else if (how === "mismatched") summary.mismatched += 1;
      else if (how === "outside") summary.outside += 1;
      else if (how === "untied") summary.untied += 1;
      else if (how === "before") summary.before += 1;
      else if (how === "hold") summary.holds += 1;
      else if (how === "waiting") summary.waiting += 1;
      else summary.unexplained += 1;
    }
    if (all.length === 0) {
      unchecked.add(differsKey);
      continue;
    }
    if (all.some((movement: Movement): boolean => !readable(movement))) {
      // The running balance cannot be followed, so a gap found before neither
      // clears nor changes.
      summary.status = "unreadable";
      unchecked.add(differsKey);
      for (const [key, facts] of input.prior) {
        if (key.startsWith("balance-gap:") && factsCurrency(facts) === currency) {
          unchecked.add(key);
        }
      }
      continue;
    }
    const ordered: Movement[] = [...all].sort(chronological);
    const first: Movement = ordered[0] as Movement;
    const last: Movement = ordered.at(-1) as Movement;
    summary.openingMinor = (first.balanceMinor ?? 0) - (first.amountMinor ?? 0);
    summary.closingMinor = last.balanceMinor;
    for (const movement of ordered) {
      const amount: number = movement.amountMinor ?? 0;
      if (isHold(movement)) {
        summary.holdsMinor += amount;
      } else if (amount > 0) {
        summary.inMinor += amount;
      } else {
        summary.outMinor += amount;
      }
    }
    let gap: boolean = false;
    for (let index: number = 1; index < ordered.length; index += 1) {
      const previous: Movement = ordered[index - 1] as Movement;
      const movement: Movement = ordered[index] as Movement;
      const expected: number = (previous.balanceMinor ?? 0) + (movement.amountMinor ?? 0);
      if (movement.balanceMinor !== expected) {
        gap = true;
        breaks.push(
          found("balance-gap", movement.id, currency, null, null, {
            kind: "balance-gap",
            currency,
            movementId: movement.id,
            foundMinor: movement.balanceMinor ?? 0,
            expectedMinor: expected,
          }),
        );
        break;
      }
    }
    summary.status = gap ? "gap" : "adds-up";
    if (pair === undefined || pair.before === null || pair.after === null) {
      unchecked.add(differsKey);
      if (!gap) {
        summary.status = "unchecked";
      }
      continue;
    }
    if (pair.before !== pair.after) {
      unchecked.add(differsKey);
      if (!gap) {
        summary.status = "moved";
      }
      continue;
    }
    const difference: number = (last.balanceMinor ?? 0) - pair.after;
    if (difference !== 0) {
      if (!gap) {
        summary.status = "differs";
      }
      const prior: unknown = JSON.parse(input.prior.get(differsKey) ?? "null");
      const kept: string | null =
        typeof prior === "object" &&
        prior !== null &&
        (prior as DiffersFacts).differenceMinor === difference &&
        typeof (prior as DiffersFacts).sinceMovementId === "string"
          ? (prior as DiffersFacts).sinceMovementId
          : null;
      breaks.push(
        found("balance-differs", currency, currency, null, null, {
          kind: "balance-differs",
          currency,
          differenceMinor: difference,
          sinceMovementId: kept ?? last.id,
        }),
      );
    }
  }

  return { breaks, tied: new Set(tied.keys()), unchecked, wallets, waiting, labels, unread: [...unread] };
}

function factsCurrency(raw: string): unknown {
  try {
    return (JSON.parse(raw) as { currency?: unknown }).currency;
  } catch {
    return null;
  }
}

// ---------- wording ----------

const CURRENCY: RegExp = /^[A-Z]{3}$/;
const REFERENCE: RegExp = /^[A-Z0-9-]{1,30}$/;
const STATUS: RegExp = /^[A-Z_]{1,30}$/;

// Every slot is checked again as it is read back, whatever the store holds, so a
// fact that does not fit reads in PayOnce's words instead of as itself.
function walletOf(value: unknown): string {
  return typeof value === "string" && CURRENCY.test(value) ? `the ${value} wallet` : "a wallet";
}

function walletOwn(value: unknown): string {
  return typeof value === "string" && CURRENCY.test(value) ? `The ${value} wallet's` : "A wallet's";
}

function transferOf(value: unknown): string {
  return typeof value === "string" && REFERENCE.test(value) ? `transfer ${value}` : "a transfer";
}

function moneyOf(minor: unknown, currency: unknown): string {
  return typeof minor === "number" && Number.isSafeInteger(minor) && typeof currency === "string" && CURRENCY.test(currency)
    ? formatMoney(minor, currency)
    : "an amount PayOnce cannot show";
}

function invoiceOf(value: unknown): string {
  return typeof value === "string" && INVOICE_ID_PATTERN.test(value) ? value : "an invoice";
}

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function shownReference(value: unknown): string | null {
  return typeof value === "string" && REFERENCE.test(value) ? value : null;
}

export function shownInvoice(value: unknown): string | null {
  return typeof value === "string" && INVOICE_ID_PATTERN.test(value) ? value : null;
}

export function shownCurrency(value: unknown): string | null {
  return typeof value === "string" && CURRENCY.test(value) ? value : null;
}

export function shownStatus(value: unknown): string | null {
  return typeof value === "string" && STATUS.test(value) ? value : null;
}

// The break in PayOnce's words, from its stored facts. No time is in it, so it
// cannot disagree with the times the page shows in the browser's zone.
export function breakText(kind: BreakKind, raw: string): string {
  let facts: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    facts = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    facts = {};
  }
  const cur: unknown = facts["currency"];
  const wallet: string = walletOf(cur);
  const transfer: string = transferOf(facts["reference"]);
  const money = (field: string): string => moneyOf(facts[field], cur);
  switch (kind) {
    case "debit-missing":
      return `Airwallex lists ${transfer}, but no debit for it has reached ${wallet}. PayOnce expected ${money("expectedMinor")}.`;
    case "debited-twice": {
      const count: unknown = facts["count"];
      const times: string = typeof count === "number" && Number.isSafeInteger(count) ? `${count} times` : "more than once";
      return `${sentence(transfer)} took money from ${wallet} ${times}, ${money("totalMinor")} in all.`;
    }
    case "debit-differs":
      return facts["expectedMinor"] === null
        ? `${sentence(transfer)} took ${money("foundMinor")} from ${wallet}, which is not the wallet Airwallex's transfer names.`
        : `${sentence(transfer)} took ${money("foundMinor")} from ${wallet}. Airwallex's transfer says ${money("expectedMinor")}.`;
    case "fee-differs":
      return facts["expectedMinor"] === null
        ? `${sentence(wallet)} shows a fee of ${money("foundMinor")} for ${transfer}, which is not the wallet the transfer's fee is in.`
        : `${sentence(wallet)} shows a fee of ${money("foundMinor")} for ${transfer}. The transfer says ${money("expectedMinor")}.`;
    case "refund-missing":
      return `${sentence(transfer)} failed, and ${money("expectedMinor")} has not come back to ${wallet}.`;
    case "refund-differs":
      return `${sentence(transfer)} failed. ${money("foundMinor")} came back to ${wallet}, and PayOnce expected ${money("expectedMinor")}.`;
    case "refund-unexpected":
      return `${money("foundMinor")} came back to ${wallet} for ${transfer}, which Airwallex does not show as failed.`;
    case "paid-then-returned": {
      const invoice: string = invoiceOf(facts["invoiceId"]);
      if (facts["transferId"] === null) {
        return `PayOnce closed ${invoice} as paid, and none of its payments is recorded as paid now. The supplier may not have been paid.`;
      }
      const back: string =
        facts["returnedMinor"] === null
          ? "and Airwallex now shows it failed"
          : `then ${money("returnedMinor")} came back to ${wallet}`;
      if (facts["payment"] === "mismatched") {
        return `${sentence(transfer)}, kept beside a payment on ${invoice} because it does not match the invoice, was recorded as paid, ${back}.`;
      }
      const which: string =
        facts["payment"] === "outside" ? `${transfer}, sent outside PayOnce for ${invoice},` : `${transfer} on ${invoice}`;
      return `${sentence(which)} was recorded as paid, ${back}. The supplier may not have been paid.`;
    }
    case "untied-payout": {
      const refunded: unknown = facts["refundedMinor"];
      const back: string = typeof refunded === "number" && refunded > 0 ? ` ${money("refundedMinor")} came back.` : "";
      return `${sentence(transfer)}, sent outside PayOnce, took ${money("debitMinor")} from ${wallet} and is tied to no invoice.${back}`;
    }
    case "unexplained-credit":
      return `${money("amountMinor")} came into ${wallet} as ${typeWords(facts["type"])}, and no transfer explains it.`;
    case "unexplained-debit":
      return `${money("amountMinor")} left ${wallet} as ${typeWords(facts["type"])}, and no transfer explains it.`;
    case "unreadable-movement": {
      const waits: string =
        typeof facts["transferId"] === "string"
          ? "the transfer it names"
          : typeof cur === "string" && CURRENCY.test(cur)
            ? "that wallet's transfers"
            : "any transfer";
      return `A movement in ${wallet} has an amount, balance, time or currency PayOnce cannot read. Until it can, PayOnce does not match ${waits}.`;
    }
    case "balance-gap":
      return `${walletOwn(cur)} movements do not add up: after one movement the balance reads ${money("foundMinor")}, and the movements before it give ${money("expectedMinor")}.`;
    case "balance-differs": {
      const difference: unknown = facts["differenceMinor"];
      const by: string =
        typeof difference === "number" && Number.isSafeInteger(difference)
          ? `${moneyOf(Math.abs(difference), cur)} ${difference > 0 ? "above" : "below"}`
          : "away from";
      return `${walletOwn(cur)} movements end ${by} Airwallex's available balance.`;
    }
  }
}

// A waiting item in PayOnce's words. The due time is shown apart.
export function waitingText(item: WaitingItem): string {
  const wallet: string = walletOf(item.currency);
  const transfer: string = transferOf(item.reference);
  const amount: string = moneyOf(item.amountMinor, item.currency);
  switch (item.kind) {
    case "debit":
      return `Waiting for the debit of ${transfer} to reach ${wallet}.`;
    case "refund":
      return `Waiting for ${amount} to come back to ${wallet} for ${transfer}, which failed.`;
    case "untied":
      return `${sentence(transfer)}, sent outside PayOnce, is tied to no invoice yet. The sweep may still tie it.`;
    case "unread":
      return `A movement of ${amount} in ${wallet} names a transfer PayOnce has not read yet.`;
    case "refused":
      return `A movement of ${amount} in ${wallet} names a transfer Airwallex refused to show. PayOnce asks again on a later check.`;
    case "unfunded": {
      const status: string | null = shownStatus(item.status);
      return `${sentence(transfer)} is ${status ?? "not funded yet"}, so no debit is expected yet.`;
    }
  }
}

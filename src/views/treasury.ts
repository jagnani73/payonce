import type { BalanceState } from "../airwallex/balances.js";
import type { BankDeadlineMinutes } from "../domain/deadlines.js";
import { formatMoney } from "../domain/money.js";
import { railWords } from "../domain/patterns.js";
import {
  outageRuleText,
  outagesReport,
  sendsText,
  type CountedPayout,
  type HeldItem,
  type OutageSend,
  type OutagesReport,
  type OutageView,
} from "../outages/outages.js";
import {
  movementsView,
  reconReport,
  type BreakView,
  type KindCount,
  type MovementView,
  type ReconReport,
  type ReconRunner,
  type WaitingView,
} from "../recon/reconcile.js";
import { WALLET_STATUS_TEXT, type BreakKind, type MovementHow, type WalletSummary } from "../recon/recon-match.js";
import {
  CASH_KINDS,
  cashReport,
  FIRM_KINDS,
  payRunLines,
  WAITING_KINDS,
  type CashKind,
  type CashLine,
  type CashReport,
  type CurrencyCash,
  type InvoiceFloor,
} from "../store/read/cash.js";
import { capitalise } from "../text/printable.js";
import type { Settings } from "../settings.js";
import { readingSoft, type Ledger, type OutageHoldKind } from "../store/ledger.js";
import type {
  BreakItemView,
  CashLineKind,
  CashView,
  CashWorksheetGroup,
  Money,
  OutageCardView,
  OutagesView,
  ReconMovementsView,
  ReconView,
  WalletCashView,
} from "./contract.js";
import { outageHolding } from "./incident-board.js";
import { allowed, failureView, iso, money, refused } from "./parts.js";

// Treasury: cash per wallet down to its headroom, the rail outages, and
// reconciliation against Airwallex's balance history. Each reuses its read
// model as it is and only shapes it.

// ---------- cash ----------

const KIND_WORDS: Record<CashKind, { label: string; bucket: CashWorksheetGroup["bucket"] }> = {
  sending: { label: "Being sent", bucket: "promised" },
  approved: { label: "Approved", bucket: "promised" },
  "pay-run": { label: "Pay run rows", bucket: "promised" },
  "awaiting-approval": { label: "Waiting for approval", bucket: "waiting-on-people" },
  "awaiting-person": { label: "Waiting on a decision", bucket: "waiting-on-people" },
  "waiting-outage": { label: "Paused by an outage", bucket: "waiting-on-people" },
  "with-bank": { label: "With the bank", bucket: "with-bank" },
  outside: { label: "Outside payouts with the bank", bucket: "with-bank" },
  "fee-lost": { label: "Fees kept on failed transfers", bucket: "fees-kept" },
};

const WITH_BANK: ReadonlySet<CashKind> = new Set<CashKind>(["with-bank", "outside"]);

// In place of the setting's own problem, which Settings shows beside it.
const FLOORS_UNREADABLE: string =
  "PayOnce can't read the reserve floors, so it sends every replacement to a person. Settings shows what to fix.";

function sumOf(cash: CurrencyCash, kinds: ReadonlySet<CashKind>): Money {
  const lines: CashLine[] = cash.lines.filter((line: CashLine): boolean => kinds.has(line.kind));
  return money(
    lines.reduce((sum: number, line: CashLine): number => sum + line.amountMinor + line.feeMinor, 0),
    cash.currency,
    lines.some((line: CashLine): boolean => line.estimated || !line.feeKnown),
  );
}

function walletOf(cash: CurrencyCash): WalletCashView {
  const of = (minor: number | null): Money | null => (minor === null ? null : money(minor, cash.currency));
  const floorText: string =
    cash.floor.source === "unreadable"
      ? "Can't read the reserve floors"
      : cash.floor.minor === null
        ? "Not set: every automatic replacement in this currency goes to a person"
        : formatMoney(cash.floor.minor, cash.currency);
  return {
    wallet: cash.currency,
    available: of(cash.airwallex?.availableMinor ?? null),
    floor: { amount: of(cash.floor.minor), source: cash.floor.source, text: floorText },
    promised: sumOf(cash, FIRM_KINDS),
    waitingOnPeople: sumOf(cash, WAITING_KINDS),
    withBank: sumOf(cash, WITH_BANK),
    feesKept: sumOf(cash, new Set<CashKind>(["fee-lost"])),
    headroom: of(cash.headroomMinor),
    headroomIfApproved: of(cash.headroomIfApprovedMinor),
    tone:
      cash.headroomMinor !== null && cash.headroomMinor < 0
        ? "below"
        : cash.headroomIfApprovedMinor !== null && cash.headroomIfApprovedMinor < 0
          ? "low"
          : "ok",
    invoiceFloors: cash.floor.invoiceFloors.map((floor: InvoiceFloor) => ({
      invoiceId: floor.invoiceId,
      floor: money(floor.floorMinor, cash.currency),
      text: `${floor.invoiceId} keeps its own floor of ${formatMoney(floor.floorMinor, cash.currency)}.`,
    })),
    worksheet: CASH_KINDS.flatMap((kind: CashKind): CashWorksheetGroup[] => {
      const lines: CashLine[] = cash.lines.filter((line: CashLine): boolean => line.kind === kind);
      return lines.length === 0
        ? []
        : [
            {
              kind: kind as CashLineKind,
              label: KIND_WORDS[kind].label,
              bucket: KIND_WORDS[kind].bucket,
              total: sumOf(cash, new Set<CashKind>([kind])),
              feeUnknown: lines.filter((line: CashLine): boolean => !line.feeKnown).length,
              lines: lines.map((line: CashLine) => ({
                invoiceId: line.invoiceId,
                runId: line.runId,
                reference: line.reference,
                amount: money(line.amountMinor, line.currency, line.estimated),
                fee: line.feeKnown ? money(line.feeMinor, line.currency) : null,
              })),
            },
          ];
    }),
  };
}

// balances: the server's balance cache as it is. statesCheckedAt: when its
// watcher last read every payment with the bank, null where none runs.
export function cashView(
  ledger: Ledger,
  settings: Settings,
  now: number,
  balances: BalanceState,
  statesCheckedAt: number | null = null,
): CashView {
  return readingSoft((): CashView => {
    const report: CashReport = cashReport({
      ledger,
      reserve: settings.reserve,
      balances,
      statesCheckedAt,
      payRunLines: payRunLines(ledger, now),
      now,
    });
    return {
      view: "cash",
      generatedAt: report.generatedAt,
      balances: {
        readAt: report.airwallex.readAt,
        refreshing: report.airwallex.refreshing,
        problem:
          report.airwallex.error === null
            ? null
            : {
                text:
                  report.airwallex.readAt === null
                    ? "Couldn't read balances from Airwallex, and there's no earlier read to show."
                    : "Couldn't read balances from Airwallex. The last good read is shown.",
                since: report.airwallex.error.at,
              },
      },
      checksLastRanAt: report.ledger.statesCheckedAt,
      floorsProblem: report.floors.problem === null ? null : FLOORS_UNREADABLE,
      wallets: report.currencies.map(walletOf),
    };
  });
}

// ---------- outages ----------

const HELD_WORDS: Record<OutageHoldKind, string> = {
  counted: "counted failure",
  original: "first transfer",
  replacement: "replacement waiting for approval",
  approved: "approved transfer",
  run: "pay run release",
};

function sendsOf(sends: OutageSend[]): { payments: number; total: Money }[] {
  return sends.map((send: OutageSend) => ({ payments: send.payments, total: money(send.minor, send.currency, send.estimated) }));
}

function cardOf(view: OutageView, report: OutagesReport): OutageCardView {
  return {
    id: view.id,
    rail: railWords(view.currency, view.method),
    state: view.state,
    text: view.text,
    codes: view.codes,
    declaredAt: view.declaredAt,
    payees: view.payees,
    counted: view.counted.map((payout: CountedPayout) => ({
      reference: payout.reference,
      invoiceId: payout.invoiceId,
      failure: failureView(payout.code),
      failedAt: payout.failedAt,
    })),
    pausing: view.held
      .filter((item: HeldItem): boolean => item.what !== "counted")
      .map((item: HeldItem) => ({
        invoiceId: item.invoiceId,
        runId: item.runId,
        what: item.what,
        label: `${item.invoiceId ?? (item.runId === null ? "" : `pay run ${item.runId}`)} (${HELD_WORDS[item.what]})`,
      })),
    sends: sendsOf(view.sends),
    sendsText: view.state === "active" ? `Ending it sends ${sendsText(view.sends)}.` : null,
    endedAt: view.endedAt,
    endedBy: view.endedBy,
    endNote: view.endNote,
    end: {
      ...(view.state !== "active"
        ? refused("ended", `Ended by ${view.endedBy ?? "a person"}.`)
        : report.endRefused !== null
          ? refused("policy-unreadable", report.endRefused)
          : allowed()),
      enders: report.enders,
    },
  };
}

export function outagesView(ledger: Ledger, settings: Settings, now: number): OutagesView {
  const report: OutagesReport = outagesReport(ledger, settings.approvals, outageHolding(ledger, now));
  return {
    view: "outages",
    rule: { text: outageRuleText(settings.outageRule), problem: report.rule.problem },
    active: report.active.map((view: OutageView): OutageCardView => cardOf(view, report)),
    ended: report.recent.map((view: OutageView): OutageCardView => cardOf(view, report)),
  };
}

// ---------- reconciliation ----------

function breakItem(item: BreakView): BreakItemView {
  return {
    id: item.id,
    kind: item.kind,
    label: item.label,
    text: item.text,
    currency: item.currency,
    invoiceId: item.invoiceId,
    reference: item.reference,
    fingerprint: item.fingerprint,
    state: item.state as BreakItemView["state"],
    clearsByItself: item.clearsByItself,
    foundAt: item.foundAt,
    openedAt: item.openedAt,
    explainedBy: item.explainedBy,
    explainedAt: item.explainedAt,
    note: item.note,
  };
}


const HOW_WORDS: Record<MovementHow, string> = {
  payonce: "PayOnce's payment",
  mismatched: "Kept beside a payment because it doesn't match its invoice",
  outside: "Sent outside PayOnce, tied to an invoice",
  untied: "Sent outside PayOnce, tied to no invoice",
  before: "From before the ledger",
  hold: "Reserved by Airwallex",
  waiting: "Waiting for its transfer to be read",
  unexplained: "Not explained",
  unreadable: "Can't be read",
  "not-two-decimal": "Not reconciled",
};

// One wallet's stored movements, newest first, with their money and what
// explains each in PayOnce's words.
export function reconMovementsView(
  ledger: Ledger,
  currency: string,
  deadlines: BankDeadlineMinutes,
  now: number,
): ReconMovementsView {
  return readingSoft((): ReconMovementsView => {
    const of = (minor: number | null): Money | null => (minor === null ? null : money(minor, currency));
    return {
      currency,
      movements: movementsView(ledger, currency, deadlines, now).map((movement: MovementView) => ({
        id: movement.id,
        postedAt: movement.postedAt,
        typeText: movement.typeText,
        amount: of(movement.amountMinor),
        balance: of(movement.balanceMinor),
        how: movement.how,
        howText: HOW_WORDS[movement.how],
        invoiceId: movement.invoiceId,
        reference: movement.reference,
        breakId: movement.breakId,
      })),
    };
  });
}

// Movements that chain from one running balance to the next.
const ADDS_UP: ReadonlySet<WalletSummary["status"]> = new Set<WalletSummary["status"]>(["adds-up", "differs", "moved", "unchecked"]);

function grouped(items: BreakItemView[], kinds: KindCount[], actions: Map<BreakKind, string>): ReconView["needsPerson"] {
  return kinds
    .map((kind: KindCount) => {
      const mine: BreakItemView[] = items.filter((item: BreakItemView): boolean => item.kind === kind.kind);
      return { kind: kind.kind, label: kind.label, action: actions.get(kind.kind) ?? "", count: mine.length, items: mine };
    })
    .filter((group: { count: number }): boolean => group.count > 0);
}

export function reconView(ledger: Ledger, _settings: Settings, now: number, runner: ReconRunner | null = null): ReconView {
  return readingSoft((): ReconView => {
    const report: ReconReport = reconReport(ledger, runner);
    const open: BreakItemView[] = report.open.map(breakItem);
    const actions: Map<BreakKind, string> = new Map(report.open.map((item: BreakView): [BreakKind, string] => [item.kind, item.action]));
    const timeOf = (run: ReconReport["lastRun"]): string | null => run?.finishedAt ?? run?.startedAt ?? null;
    const okAt: string | null = timeOf(report.lastRun);
    const lastAt: string | null = report.lastProblem === null ? okAt : timeOf(report.lastProblem);
    const lastMs: number = lastAt === null ? Number.NaN : Date.parse(lastAt);
    const needsPerson: ReconView["needsPerson"] = grouped(
      open.filter((item: BreakItemView): boolean => !item.clearsByItself),
      report.byKind,
      actions,
    );
    const breaksIn: Set<string> = new Set(open.map((item: BreakItemView): string => item.currency ?? ""));
    return {
      view: "reconciliation",
      lastCheck:
        lastAt === null
          ? null
          : { at: lastAt, ok: report.lastProblem === null, problem: report.lastProblem?.error ?? null, lastOkAt: okAt },
      nextCheckAt: report.everyMinutes === null || !Number.isFinite(lastMs) ? null : iso(lastMs + report.everyMinutes * 60_000),
      everyMinutes: report.everyMinutes,
      running: report.running,
      needsPerson,
      clearingByThemselves: grouped(
        open.filter((item: BreakItemView): boolean => item.clearsByItself),
        report.byKind,
        actions,
      ).map((group: ReconView["needsPerson"][number]) => ({ kind: group.kind, label: group.label, count: group.count })),
      waiting: report.waiting.map((item: WaitingView) => ({ text: item.text, currency: item.currency, dueAt: item.dueAt })),
      wallets: report.wallets.map((wallet: WalletSummary) => ({
        currency: wallet.currency,
        movements: wallet.movements,
        addsUp: ADDS_UP.has(wallet.status),
        endsAtBalance: wallet.status === "adds-up",
        reserved: wallet.holdsMinor === 0 ? null : money(wallet.holdsMinor, wallet.currency),
        idle: wallet.movements === 0 && !breaksIn.has(wallet.currency),
        text: `${capitalise(WALLET_STATUS_TEXT[wallet.status] ?? "not checked")}.`,
      })),
      explained: report.explained.map(breakItem),
      audit: {
        lines: report.audit.lines,
        intact: report.audit.problem === null,
        problem: report.audit.problem,
        exports: { json: "/api/audit/export", csv: null },
      },
      can: {
        checkNow:
          runner === null
            ? refused("not-running", "Only pnpm ui runs reconciliation checks. Use pnpm reconcile here.")
            : report.running
              ? refused("running", "A check is already running.")
              : allowed(),
        explain: needsPerson.length > 0 ? allowed() : refused("nothing-open", "No break waits on a person."),
      },
    };
  });
}

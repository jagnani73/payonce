import type { Transfer, TransferBankDetails } from "./airwallex/transfers.js";
import { ACCOUNT_FIELDS, routeKeyOf, routeValue } from "./assess.js";
import { NameError, personName, sameName, type ApprovalPolicy, type Approver } from "./approvers.js";
import { originalStateOf } from "./assess.js";
import { deadlineMinutes } from "./deadlines.js";
import { cleanLine } from "./eml.js";
import { formatMoney } from "./money.js";
import {
  readingSoft,
  type Approval,
  type Attempt,
  type FailureSeenBy,
  type Ledger,
  type Obligation,
  type ObligationOrigin,
  type ObligationState,
  type Outage,
  type OutageCount,
  type OutageHold,
  type OutageHoldKind,
  type OutageState,
  type OutageSubjectHeld,
  type RailFailure,
} from "./ledger.js";
import { say, sayWarning, shownFailureCode } from "./printable.js";

// The failure codes that say the rail failed, not the payee's account. Each has
// PayOnce's own label. Account codes (account closed, invalid account,
// beneficiary bank returned, recall, duplication return), unknown codes and a
// transfer with no code never count.
export const RAIL_FAILURE_CODES: Readonly<Record<string, string>> = {
  "91401": "system error",
  "91402": "channel timeout",
  "99901": "unable to apply",
  "99902": "other",
};

const DEFAULT_FAILURES: number = 3;
const DEFAULT_WINDOW_MINUTES: number = 30;
const MAX_NOTE_LENGTH: number = 200;
const MINUTE_MS: number = 60_000;
const ENDED_SHOWN: number = 20;


export interface OutageRule extends OutageCount {
  // Why a setting was not used, or null when both were read.
  problem: string | null;
}

// OUTAGE_FAILURES, a whole number from 2 to 100, and OUTAGE_WINDOW_MINUTES, from
// 1 to 1440. A value outside the range falls back to the default, and the
// start-up line says so. Read when a failure is counted, as the bank deadlines
// are.
export function outageRuleFromEnv(env: NodeJS.ProcessEnv = process.env): OutageRule {
  const problems: string[] = [];
  const read = (name: string, min: number, max: number, fallback: number): number => {
    const raw: string = (env[name] ?? "").trim();
    if (raw === "") {
      return fallback;
    }
    const value: number = /^[0-9]{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
    if (value >= min && value <= max) {
      return value;
    }
    problems.push(`${name} is not a whole number from ${min} to ${max}, so ${fallback} is used`);
    return fallback;
  };
  return {
    failures: read("OUTAGE_FAILURES", 2, 100, DEFAULT_FAILURES),
    windowMinutes: read("OUTAGE_WINDOW_MINUTES", 1, 1440, DEFAULT_WINDOW_MINUTES),
    problem: problems.length === 0 ? null : problems.join(". "),
  };
}

export function describeOutageRule(rule: OutageRule): string {
  return `Outages: PayOnce opens no new payment on a currency and transfer method once payouts to ${rule.failures} different payees fail there with a rail-level code (${Object.keys(RAIL_FAILURE_CODES).join(", ")}) within ${rule.windowMinutes} minutes, until a person ends the outage${rule.problem === null ? "" : `. ${rule.problem}`}`;
}

export function railOf(outage: { currency: string; method: string }): string {
  return `${outage.currency} ${outage.method}`;
}

// "91402 (channel timeout) and 91401 (system error)", or, for an outage whose
// stored codes could not be read, "a rail-level code" as the alert says. A stored
// code in any form Airwallex does not give reads in PayOnce's words.
export function codesText(codes: string[]): string {
  const named: string[] = codes.map(
    (code: string): string => `${shownFailureCode(code)} (${RAIL_FAILURE_CODES[code] ?? "rail failure"})`,
  );
  return named.length <= 1 ? (named[0] ?? "a rail-level code") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

// HH:MM of an ISO time PayOnce wrote, which is UTC.
function clock(iso: string | null): string {
  return iso === null ? "" : `${iso.slice(11, 16)} UTC`;
}

// The account a payout went to, as one key: its routeKey, so two beneficiary
// records for one account are one payee and a bank name Airwallex rewrote does
// not make another. Its beneficiary when the payout carries no account fields.
export function payeeOf(transfer: Transfer): string {
  const details: TransferBankDetails = transfer.beneficiary?.bank_details ?? {};
  if (ACCOUNT_FIELDS.every((field: string): boolean => routeValue(details[field]) === "")) {
    return `beneficiary:${transfer.beneficiary_id ?? transfer.id}`;
  }
  return routeKeyOf(details);
}

function declaredLine(outage: Outage, counted: RailFailure[]): string {
  const references: string = counted.map((failure: RailFailure): string => failure.reference).join(", ");
  return `Outage ${outage.id} declared on ${railOf(outage)}: payouts to ${outage.payees} payees failed with ${codesText(outage.codes)} within ${outage.windowMinutes} minutes (${references}). PayOnce opens no new payment on ${railOf(outage)} until a person ends the outage`;
}

// Records a payout PayOnce read as failed, when its code is a rail-level one and
// it is fresh enough to date by when PayOnce saw it, and declares an outage when
// that makes enough payees. Called by a look and by the sweep. It never throws:
// a failure it could not record is recorded by the next look or sweep, because
// the transfer id makes the record idempotent.
export function railFailureSeen(
  ledger: Ledger,
  transfer: Transfer,
  seenBy: FailureSeenBy,
  now: number = Date.now(),
): Outage | undefined {
  try {
    const code: string = transfer.failure?.code ?? "";
    if (
      originalStateOf(transfer) !== "failed" ||
      !Object.hasOwn(RAIL_FAILURE_CODES, code) ||
      ledger.railFailure(transfer.id) !== undefined
    ) {
      return undefined;
    }
    const rule: OutageRule = outageRuleFromEnv();
    const method: string = transfer.transfer_method.toUpperCase();
    // A failure is dated by the transfer's updated_at, when Airwallex last changed
    // it, which for a failed transfer is when it failed or was cancelled after.
    // One already older than the window cannot count, so it is left out. Without
    // an updated_at PayOnce can read, it is dated by when PayOnce first sees it,
    // and left out once the transfer's creation time plus the bank deadline plus
    // the window has passed, as after PayOnce was down. Either way a transfer
    // created before outages were counted is left out, and one whose creation time
    // cannot be read counts.
    const created: number = Date.parse(transfer.created_at);
    const updated: number = Date.parse(transfer.updated_at ?? "");
    const dated: boolean = Number.isFinite(updated);
    if (
      (Number.isFinite(created) && created < Date.parse(ledger.outagesSince())) ||
      (dated
        ? updated <= now - rule.windowMinutes * MINUTE_MS
        : Number.isFinite(created) && now > created + (deadlineMinutes(method) + rule.windowMinutes) * MINUTE_MS)
    ) {
      return undefined;
    }
    const attempt: Attempt | undefined = ledger.attemptOf(transfer.request_id ?? "", transfer.id);
    const invoiceId: string | null = attempt?.invoiceId ?? ledger.outsideInvoiceOf(transfer.id) ?? null;
    const obligation: Obligation | undefined = invoiceId === null ? undefined : ledger.obligation(invoiceId);
    const origin: ObligationOrigin =
      attempt !== undefined && !(obligation?.origin === "outside" && attempt.kind === "original")
        ? "payonce"
        : "outside";
    const outage: Outage | undefined = ledger.recordRailFailure(
      {
        transferId: transfer.id,
        currency: transfer.transfer_currency,
        method,
        code,
        payee: payeeOf(transfer),
        reference: transfer.short_reference_id ?? transfer.id,
        invoiceId,
        origin,
        createdAt: transfer.created_at ?? "",
        seenBy,
        failedAt: new Date(dated ? updated : now).toISOString(),
      },
      rule,
      declaredLine,
    );
    if (outage !== undefined) {
      say(
        `  outage   Outage ${outage.id} declared on ${railOf(outage)}: payouts to ${outage.payees} payees failed with ${codesText(outage.codes)}`,
      );
    }
    return outage;
  } catch (error: unknown) {
    sayWarning(
      `  outage   ${transfer.short_reference_id ?? transfer.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

// The first line an outage puts on an invoice it holds, one per outage.
export function holdLine(outage: Outage, what: OutageHoldKind): string {
  const lead: string = `Outage ${outage.id} on ${railOf(outage)}, declared at ${clock(outage.declaredAt)}`;
  switch (what) {
    case "original":
      return `${lead}, holds this invoice's first payment. PayOnce sends it once a person ends the outage, after the checks it makes before any payment`;
    case "replacement":
      return `${lead}: PayOnce does not send a replacement by itself while it lasts, so a person approves it. An approval given now is kept until the outage ends and still expires when it would`;
    case "approved":
      return `${lead}, holds the approved payment. The approval stays approved and unspent, and PayOnce sends the payment once a person ends the outage, if the approval has not expired by then`;
    case "counted":
    case "run":
      return `${lead}, holds this invoice's payments`;
  }
}

// The standing line while an invoice waits on an outage. An approval kept for it
// is named with when it stops counting.
export function waitingLine(outage: Outage, approval: Approval | undefined): string {
  const kept: string =
    approval === undefined
      ? ""
      : `. The approval by ${approval.approver ?? ""} is kept and counts until ${clock(approval.expiresAt)}`;
  return `Waiting on a person to end outage ${outage.id} on ${railOf(outage)}. PayOnce checks again every minute${kept}`;
}

// The first line an outage puts on a pay run whose release it holds.
export function runHoldLine(outage: Outage, lines: number[], approver: string, expiresAt: string | null): string {
  const rows: string = lines.length === 1 ? `row ${lines[0]} pays` : `rows ${lines.join(", ")} pay`;
  return `Outage ${outage.id} on ${railOf(outage)}, declared at ${clock(outage.declaredAt)}, holds the release: ${rows} on it, and the run is released whole. The approval by ${approver} is kept and counts until ${clock(expiresAt)}. PayOnce releases the run once a person ends the outage. Another pay run cannot be uploaded until this one is released or cancelled`;
}

export function runWaitingLine(outage: Outage): string {
  return `Waiting on a person to end outage ${outage.id} on ${railOf(outage)}. PayOnce tries the release again every minute`;
}

function endedLead(outage: Outage, unlisted: boolean): string {
  const anyone: string = unlisted ? " No approver list was set, so any named person could end it." : "";
  return `Outage ${outage.id} on ${railOf(outage)} ended by ${outage.endedBy ?? ""}: ${outage.endNote ?? ""}. It was declared at ${clock(outage.declaredAt)}.${anyone}`;
}

// An invoice closed by the time the outage ends gets no look.
function endLine(outage: Outage, unlisted: boolean, state: ObligationState | null): string {
  return state === "open" || state === "escalated"
    ? `${endedLead(outage, unlisted)} PayOnce opens payments on ${railOf(outage)} again and looks at this invoice now`
    : `${endedLead(outage, unlisted)} PayOnce opens payments on ${railOf(outage)} again. This invoice is already closed, so PayOnce sends nothing for it`;
}

function runEndLine(outage: Outage, unlisted: boolean): string {
  return `${endedLead(outage, unlisted)} PayOnce releases the run on its next check if the approval still counts`;
}

// Who may end an outage: the names in APPROVERS, since ending one lets payments
// go out on the rail again. Null when the list is unset or cannot be read, and
// then any named person may, so an outage can always be ended.
export function outageEnders(policy: ApprovalPolicy): string[] | null {
  return policy.problem === null && policy.approvers.length > 0
    ? policy.approvers.map((approver: Approver): string => approver.name)
    : null;
}

export type EndRefusal = "input" | "approver" | "unknown" | "ended";

export class EndRefusedError extends Error {
  readonly why: EndRefusal;
  readonly outage: Outage | null;

  constructor(why: EndRefusal, message: string, outage: Outage | null = null) {
    super(message);
    this.name = "EndRefusedError";
    this.why = why;
    this.outage = outage;
  }
}

function alreadyEnded(outage: Outage): EndRefusedError {
  return new EndRefusedError(
    "ended",
    `Outage ${outage.id} on ${railOf(outage)} was already ended by ${outage.endedBy ?? "someone"} at ${clock(outage.endedAt)}`,
    outage,
  );
}

export interface EndedOutage {
  outage: Outage;
  holds: OutageHold[];
}

// What ending an outage sends in one currency: one payment for each first
// payment, approved payment and pay run row it holds, and their total from the
// board's cash lines, amount and fee.
export interface OutageSend {
  currency: string;
  payments: number;
  minor: number;
  estimated: boolean;
}

// What an active outage holds now, as the incident board lists it: the invoices,
// with what of each it holds, the pay runs, and what ending it sends.
export interface OutageHolding {
  invoices: { invoiceId: string; what: OutageHoldKind }[];
  runs: number[];
  sends: OutageSend[];
}

// "2 payments totalling 1,700.00 USD and 1 payment totalling 400.00 EUR", or "no
// payment" when the outage holds none that ending it sends.
export function sendsText(sends: OutageSend[]): string {
  const parts: string[] = sends.map(
    (send: OutageSend): string =>
      `${send.payments} ${send.payments === 1 ? "payment" : "payments"} totalling ${formatMoney(send.minor, send.currency)}${send.estimated ? " (estimated)" : ""}`,
  );
  return parts.length === 0
    ? "no payment"
    : parts.length === 1
      ? (parts[0] ?? "")
      : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

// Works out an active outage's holding. The board provides it (incident-board.ts
// outageHolding), so this file needs no board code.
export type HoldingOf = (outage: Outage) => OutageHolding;

// A person ends an outage with their name and a note. It moves no money and calls
// no bank: it changes the outage, writes the end on every timeline it held and
// makes their looks due, and the watcher then picks them up. holdingOf gives what
// the board lists as held, read in the same transaction before the end, so every
// invoice and run the board showed gets its hold and its end line.
export function endOutage(
  ledger: Ledger,
  policy: ApprovalPolicy,
  id: number,
  name: string,
  note: string,
  holdingOf: HoldingOf | null = null,
): EndedOutage {
  let who: string;
  try {
    who = personName(name);
  } catch (error: unknown) {
    throw new EndRefusedError("input", error instanceof NameError ? error.message : String(error));
  }
  const why: string = cleanLine(note, MAX_NOTE_LENGTH + 1);
  if (why === "" || why.length > MAX_NOTE_LENGTH) {
    throw new EndRefusedError("input", "Say why the outage is over, in up to 200 characters");
  }
  const outage: Outage | undefined = ledger.outage(id);
  if (outage === undefined) {
    throw new EndRefusedError("unknown", `Outage ${id} is not in the ledger`);
  }
  if (outage.state !== "active") {
    throw alreadyEnded(outage);
  }
  const enders: string[] | null = outageEnders(policy);
  const ender: string | undefined =
    enders === null ? who : enders.find((listed: string): boolean => sameName(listed, who));
  if (ender === undefined) {
    throw new EndRefusedError(
      "approver",
      `Only a name in APPROVERS may end an outage, because ending it lets PayOnce pay on ${railOf(outage)} again: ${(enders ?? []).join(", ")}`,
      outage,
    );
  }
  const unlisted: boolean = enders === null;
  const holds: OutageHold[] | undefined = ledger.endOutage(
    id,
    ender,
    why,
    (ended: Outage, state: ObligationState | null): string => endLine(ended, unlisted, state),
    (ended: Outage): string => runEndLine(ended, unlisted),
    (active: Outage): OutageSubjectHeld[] => {
      const holding: OutageHolding | undefined = holdingOf?.(active);
      return holding === undefined
        ? []
        : [
            ...holding.invoices.map(
              (item: { invoiceId: string; what: OutageHoldKind }): OutageSubjectHeld => ({
                subject: { invoiceId: item.invoiceId },
                what: item.what,
              }),
            ),
            ...holding.runs.map((runId: number): OutageSubjectHeld => ({ subject: { runId }, what: "run" })),
          ];
    },
  );
  const after: Outage = ledger.outage(id) ?? outage;
  if (holds === undefined) {
    throw alreadyEnded(after);
  }
  say(`  outage   Outage ${id} on ${railOf(after)} ended by ${ender}: ${why}`);
  return { outage: after, holds };
}

export interface OutageCode {
  code: string;
  label: string;
}

export interface CountedPayout {
  reference: string;
  invoiceId: string | null;
  origin: ObligationOrigin;
  code: string;
  // When it failed (Airwallex's updated_at, or when PayOnce first read it).
  failedAt: string;
  seenAt: string;
}

export interface HeldItem {
  invoiceId: string | null;
  runId: number | null;
  what: OutageHoldKind;
  // The invoice's or the run's state now. Null when it is no longer in the ledger.
  state: string | null;
}

// An outage as the page, the CLI and the board show it, from the ledger only.
// text is PayOnce's own sentence about it.
export interface OutageView {
  id: number;
  rail: string;
  currency: string;
  method: string;
  state: OutageState;
  codes: OutageCode[];
  declaredAt: string;
  payees: number;
  threshold: number;
  windowMinutes: number;
  counted: CountedPayout[];
  // For an active outage given a holding, what the board lists as held now.
  // Otherwise the hold rows.
  held: HeldItem[];
  // What ending it sends, per currency. Empty for an ended outage and when no
  // holding was given.
  sends: OutageSend[];
  endedAt: string | null;
  endedBy: string | null;
  endNote: string | null;
  text: string;
}

function codesOf(codes: string[]): OutageCode[] {
  return codes.map((code: string): OutageCode => ({
    code: shownFailureCode(code),
    label: RAIL_FAILURE_CODES[code] ?? "rail failure",
  }));
}

function invoiceState(ledger: Ledger, invoiceId: string): string | null {
  return ledger.obligation(invoiceId)?.state ?? null;
}

// A view, so it reads stored JSON soft.
export function outageView(ledger: Ledger, outage: Outage, holding: OutageHolding | null = null): OutageView {
  return readingSoft((): OutageView => viewOf(ledger, outage, holding));
}

function viewOf(ledger: Ledger, outage: Outage, holding: OutageHolding | null): OutageView {
  const counted: CountedPayout[] = outage.counted
    .map((transferId: string): RailFailure | undefined => ledger.railFailure(transferId))
    .filter((failure: RailFailure | undefined): failure is RailFailure => failure !== undefined)
    .map(
      (failure: RailFailure): CountedPayout => ({
        reference: failure.reference,
        invoiceId: failure.invoiceId,
        origin: failure.origin,
        code: failure.code,
        failedAt: failure.failedAt,
        seenAt: failure.seenAt,
      }),
    );
  const listed: OutageHolding | null = outage.state === "active" ? holding : null;
  const held: HeldItem[] =
    listed !== null
      ? [
          ...listed.invoices.map(
            (item: { invoiceId: string; what: OutageHoldKind }): HeldItem => ({
              invoiceId: item.invoiceId,
              runId: null,
              what: item.what,
              state: invoiceState(ledger, item.invoiceId),
            }),
          ),
          ...listed.runs.map(
            (runId: number): HeldItem => ({ invoiceId: null, runId, what: "run", state: ledger.run(runId)?.state ?? null }),
          ),
        ]
      : ledger.outageHolds(outage.id).map(
          (hold: OutageHold): HeldItem => ({
            invoiceId: hold.invoiceId,
            runId: hold.runId,
            what: hold.what,
            state:
              hold.invoiceId !== null
                ? invoiceState(ledger, hold.invoiceId)
                : hold.runId !== null
                  ? (ledger.run(hold.runId)?.state ?? null)
                  : null,
          }),
        );
  // No time is in the sentence: the page shows declaredAt and endedAt in the
  // viewer's time zone, and the CLI prints them as they are stored.
  const text: string =
    outage.state === "active"
      ? `Outage ${outage.id} on ${railOf(outage)}: payouts to ${outage.payees} payees failed with ${codesText(outage.codes)} within ${outage.windowMinutes} minutes. PayOnce opens no new payment on ${railOf(outage)} until a person ends it`
      : `Outage ${outage.id} on ${railOf(outage)} was ended by ${outage.endedBy ?? ""}`;
  return {
    id: outage.id,
    rail: railOf(outage),
    currency: outage.currency,
    method: outage.method,
    state: outage.state,
    codes: codesOf(outage.codes),
    declaredAt: outage.declaredAt,
    payees: outage.payees,
    threshold: outage.threshold,
    windowMinutes: outage.windowMinutes,
    counted,
    held,
    sends: listed?.sends ?? [],
    endedAt: outage.endedAt,
    endedBy: outage.endedBy,
    endNote: outage.endNote,
    text,
  };
}

export interface OutagesReport {
  rule: { failures: number; windowMinutes: number; codes: OutageCode[]; problem: string | null };
  // The names that may end an outage, or null when any named person may.
  enders: string[] | null;
  // Oldest first.
  active: OutageView[];
  // The latest ended outages, newest first.
  recent: OutageView[];
}

// GET /api/outages and pnpm outage. Ledger reads only, no Airwallex call. Given
// holdingOf, an active outage lists what the board lists as held. A view, so it
// reads stored JSON soft.
export function outagesReport(
  ledger: Ledger,
  policy: ApprovalPolicy,
  holdingOf: HoldingOf | null = null,
): OutagesReport {
  return readingSoft((): OutagesReport => reportOf(ledger, policy, holdingOf));
}

function reportOf(ledger: Ledger, policy: ApprovalPolicy, holdingOf: HoldingOf | null): OutagesReport {
  const rule: OutageRule = outageRuleFromEnv();
  const all: Outage[] = ledger.outages();
  return {
    rule: {
      failures: rule.failures,
      windowMinutes: rule.windowMinutes,
      codes: codesOf(Object.keys(RAIL_FAILURE_CODES)),
      problem: rule.problem,
    },
    enders: outageEnders(policy),
    active: all
      .filter((outage: Outage): boolean => outage.state === "active")
      .reverse()
      .map((outage: Outage): OutageView => outageView(ledger, outage, holdingOf?.(outage) ?? null)),
    recent: all
      .filter((outage: Outage): boolean => outage.state === "ended")
      .slice(0, ENDED_SHOWN)
      .map((outage: Outage): OutageView => outageView(ledger, outage)),
  };
}

import type { TransferBankDetails } from "./airwallex/transfers.js";
import { accountKeyOf, endingOf, keyHash } from "./approval.js";
import { knownName } from "./approvers.js";
import { CHANGED_BANK_DETAILS_REASON, LAST_PAID_CHANGED_REASON } from "./decide.js";
import { templateLabel } from "./drafts.js";
import { numberOf, numbersOf, sameInvoiceNumber, supplierNameKey } from "./duplicates.js";
import { summarise, unverifiedSenders, type SupplierEmail } from "./emails.js";
import { ACCOUNT_CHANGED_REASON, LATE_TRANSFER_REASON } from "./engine.js";
import {
  boardReport,
  GROUP_LABELS,
  type BoardEntry,
  type BoardFilters,
  type BoardGroup,
  type BoardMoney,
  type BoardReport,
  type BoardTotal,
} from "./incident-board.js";
import { candidatesFor, invoiceIndex, type InvoiceIndex, type Match } from "./intake.js";
import {
  liveAtBank,
  type Ledger,
  type Obligation,
  type ObligationOrigin,
  type ObligationState,
  type Outage,
  type OutageHoldKind,
  type OutageState,
  type RunRowAction,
  type RunRowState,
  type RunState,
  type SupplierApproval,
  type SupplierAttempt,
  type SupplierCallback,
  type SupplierDraft,
  type SupplierFailure,
  type SupplierHold,
  type SupplierLinks,
  type SupplierPayout,
  type SupplierRead,
  type SupplierRunRow,
  type Upload,
} from "./ledger.js";
import { RAIL_FAILURE_CODES, railOf } from "./outages.js";
import { debitCurrency } from "./reserve.js";
import { BENEFICIARY_ID_PATTERN } from "./run-file.js";
import { FAILURE_WORDS } from "./why-facts.js";

// The supplier view: one Airwallex beneficiary record, the key every control
// already checks the next payment against, with what PayOnce owed it, sent it,
// to which account, what changed, who called whom, what the emails said in
// PayOnce's words, what is still at risk and what to be careful of. It reads the
// ledger only, in one snapshot, and acts on nothing: every row links to the card
// that does. Records are never merged; records that share a name or an account
// are linked. Its money and groups are the board's own entries.

export const SUPPLIER_KEY_PATTERN: RegExp = BENEFICIARY_ID_PATTERN;

// "Recent" in the cautions, as a constant rather than a setting.
const RECENT_MS: number = 30 * 24 * 60 * 60_000;
const CLOSED_LISTED: number = 25;
const LINKS_LISTED: number = 25;

// What PayOnce shows of Airwallex's text: references, statuses and codes only in
// their own forms, and the last four characters of an account only as letters
// and digits.
const REFERENCE: RegExp = /^[A-Z0-9-]{1,30}$/;
const STATUS: RegExp = /^[A-Z_]{1,30}$/;
const FAILURE_CODE: RegExp = /^[A-Za-z0-9_]{1,40}$/;
const ENDING: RegExp = /^[A-Za-z0-9]{1,4}$/;
const RAIL_NAME: RegExp = /^[A-Z]{3} [A-Z_]{1,20}$/;
const CURRENCY: RegExp = /^[A-Z]{3}$/;
const METHOD: RegExp = /^(LOCAL|SWIFT)$/;

// Codes that say the account itself is closed or wrong, not the rail.
const ACCOUNT_LEVEL_CODES: ReadonlySet<string> = new Set<string>(["90701", "90101", "90802"]);
const ACCOUNT_REASONS: readonly string[] = [
  CHANGED_BANK_DETAILS_REASON,
  LAST_PAID_CHANGED_REASON,
  ACCOUNT_CHANGED_REASON,
];

const NO_FILTERS: BoardFilters = { group: null, currency: null, origin: null };

export type CautionCode =
  | "account-changed"
  | "callback-verified"
  | "new-payee"
  | "unconfirmed-account"
  | "misdirected"
  | "shared-account"
  | "account-failure"
  | "domain-changed"
  | "asks-not-to-pay"
  | "asks-new-details"
  | "paid-twice"
  | "no-phone"
  | "recent-failures"
  | "non-receipt"
  | "flagged-senders"
  | "no-domain"
  | "outside-payout"
  | "held-duplicate"
  | "outage";

export type CautionLevel = "caution" | "info";

interface CautionKind {
  level: CautionLevel;
  // Must: changes what a person does next. Could: mostly what each invoice's
  // board group says already.
  must: boolean;
}

// In the order they are listed, cautions before infos.
const CAUTIONS: Record<CautionCode, CautionKind> = {
  "account-changed": { level: "caution", must: true },
  "callback-verified": { level: "info", must: true },
  "new-payee": { level: "info", must: true },
  "unconfirmed-account": { level: "caution", must: true },
  misdirected: { level: "caution", must: true },
  "shared-account": { level: "caution", must: true },
  "account-failure": { level: "caution", must: true },
  "domain-changed": { level: "caution", must: true },
  "asks-not-to-pay": { level: "caution", must: true },
  "asks-new-details": { level: "caution", must: true },
  "paid-twice": { level: "caution", must: true },
  "no-phone": { level: "info", must: true },
  "recent-failures": { level: "info", must: false },
  "non-receipt": { level: "info", must: false },
  "flagged-senders": { level: "caution", must: false },
  "no-domain": { level: "info", must: false },
  "outside-payout": { level: "caution", must: false },
  "held-duplicate": { level: "caution", must: false },
  outage: { level: "caution", must: false },
};
const CAUTION_ORDER: CautionCode[] = Object.keys(CAUTIONS) as CautionCode[];

// A caution's text is PayOnce's fixed words, with at most an account label, a
// code word from FAILURE_WORDS, a count, or a rail in its own form. Names,
// domains, endings, references and invoice numbers go in the arrays.
export interface Caution {
  code: CautionCode;
  level: CautionLevel;
  text: string;
  invoices: string[];
  // Account labels on this page, such as A.
  accounts: string[];
  // Other supplier records, by key.
  keys: string[];
  runs: number[];
  // The earliest time behind it, when there is one.
  since: string | null;
}

// Where an account was seen. decided and approval: the record held it when a
// payment was decided or a request opened. sent: a transfer went there. pay-run:
// the record held it at a run's check. callback: a callback verified it.
// before-callback: the record held it when a callback was recorded. outside: a
// payout sent outside PayOnce went there.
export type AccountSource = "decided" | "sent" | "approval" | "pay-run" | "callback" | "before-callback" | "outside";
const SOURCE_ORDER: AccountSource[] = ["decided", "sent", "approval", "pay-run", "callback", "before-callback", "outside"];

export interface PaymentCount {
  paid: number;
  failed: number;
  live: number;
  total: number;
}

export interface Verification {
  callbackId: number;
  invoiceId: string;
  calledBy: string;
  calledAt: string | null;
}

export interface AccountView {
  // A, B, C on this page, in the order first seen.
  label: string;
  // accountKeyOf the bank details: the key approval terms carry.
  accountKey: string;
  ending: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  seenAs: AccountSource[];
  payonce: PaymentCount;
  outside: PaymentCount;
  // The account of PayOnce's last checked payment to the record, by
  // Ledger.lastPaidTransfer, and that payment's reference.
  lastPaid: boolean;
  lastPaidReference: string | null;
  // What the record held the last time PayOnce stored it.
  recordLastStored: boolean;
  // The latest applied callback for the record, when it verified this account.
  verifiedBy: Verification | null;
  // Older applied callbacks for this account.
  superseded: number[];
  // Who recorded an applied callback for it, so may not approve payments to it.
  barred: string[];
  // Other supplier records it is on.
  alsoOn: string[];
}

// checked: the account it was meant for is kept and its transfer went there.
// misdirected: its transfer went to other details or showed none. not-kept: no
// account was kept, as before the column. not-sent: no transfer. outside: sent
// outside PayOnce, which checked nothing.
export type PaymentCheck = "checked" | "misdirected" | "not-kept" | "not-sent" | "outside";

export interface PaymentView {
  kind: "original" | "replacement" | "outside";
  reference: string | null;
  state: string;
  bankStatus: string | null;
  failureCode: string | null;
  // PayOnce's words for the code, null when it has none.
  failureWords: string | null;
  amountMinor: number | null;
  currency: string | null;
  feeMinor: number | null;
  feeCurrency: string | null;
  // When the bank created the transfer, or when the payout was found.
  sentAt: string | null;
  account: string | null;
  check: PaymentCheck;
  foundLate: boolean;
  // Only whether the rate did not match, never why.
  rateMismatch: boolean;
  mismatchedReference: string | null;
  mismatchedStatus: string | null;
}

export interface PaidBy {
  kind: "original" | "replacement" | "outside";
  reference: string | null;
  sentAt: string | null;
  account: string | null;
  check: PaymentCheck;
  // The route advisory's latest usual day, when it was worked out.
  arrivesBy: string | null;
}

export interface EmailsView {
  count: number;
  partlyUnread: number;
  sendersFlagged: number;
  findings: {
    claimsNonReceipt: boolean;
    asksForNewBankDetails: boolean;
    asksNotToPay: boolean;
    // summarise from the three, never the stored summary.
    summary: string;
    unread: boolean;
    readBy: string | null;
  } | null;
}

export interface InvoiceBoard {
  group: BoardGroup;
  label: string;
  why: string;
  also: string[];
}

export interface InvoiceView {
  invoiceId: string;
  state: ObligationState;
  origin: ObligationOrigin;
  // The name on this invoice.
  supplier: string;
  amountMinor: number;
  currency: string;
  wallet: string;
  method: string;
  dueDate: string | null;
  runId: number | null;
  runLine: number | null;
  startedBy: string | null;
  rejectedBy: string | null;
  board: InvoiceBoard | null;
  atRisk: BoardMoney[];
  duplicateOf: string[];
  paidBy: PaidBy | null;
  payments: PaymentView[];
  emails: EmailsView | null;
}

export interface BankChangeView {
  id: number;
  invoiceId: string;
  calledBy: string;
  numberCalledLast4: string | null;
  calledAt: string | null;
  state: string;
  // Account labels: what the record held before, and what the callback verified.
  from: string | null;
  to: string | null;
  recordedAt: string | null;
  latest: boolean;
  barred: string[];
}

export interface DuplicateMember {
  invoiceId: string;
  // The supplier record it is on, null when that id cannot be linked.
  key: string | null;
  thisRecord: boolean;
  state: ObligationState;
  amountMinor: number;
  currency: string;
  held: boolean;
}

export interface DuplicateGroup {
  // same-bill: amount and currency match too, as likelyDuplicates holds them.
  // same-number: only the number, as sameNumberForSupplier holds them.
  kind: "same-bill" | "same-number";
  invoices: DuplicateMember[];
}

export interface OutageBrief {
  id: number;
  rail: string | null;
  declaredAt: string | null;
  invoices: string[];
}

export interface HoldView {
  outageId: number;
  rail: string | null;
  invoiceId: string | null;
  runId: number | null;
  what: OutageHoldKind;
  heldAt: string | null;
  state: OutageState;
  endedAt: string | null;
}

export interface FailureView {
  reference: string | null;
  code: string | null;
  codeWords: string | null;
  failedAt: string | null;
  invoiceId: string | null;
  // The outage that counted it, if any.
  outageId: number | null;
}

export interface RunRowView {
  runId: number;
  runState: RunState;
  line: number;
  invoiceId: string | null;
  action: RunRowAction;
  state: RunRowState;
  amountMinor: number | null;
  currency: string | null;
  account: string | null;
  newPayee: boolean;
  callbackVerified: boolean;
  // How many reasons it was skipped for, never their text.
  skipReasons: number;
}

export interface InboxView {
  uploadId: number;
  invoices: string[];
  // The inbox offers it to one of these invoices first.
  suggested: boolean;
}

export interface DraftSummary {
  id: number;
  invoiceId: string;
  label: string | null;
  audience: "supplier" | "bank" | null;
  state: string;
  createdBy: string;
  createdAt: string | null;
  copiedBy: string | null;
  copiedAt: string | null;
  sentBy: string | null;
  sentAt: string | null;
  dismissedBy: string | null;
  dismissedAt: string | null;
}

export interface RelatedRecord {
  key: string;
  name: string;
  why: ("same-name" | "same-account")[];
  // Labels on this page of the accounts both records share.
  accounts: string[];
}

export interface RecordStored {
  at: string | null;
  invoiceId: string | null;
  runId: number | null;
  account: string;
}

export interface SupplierDetail {
  generatedAt: string;
  key: string;
  name: string;
  // The other names on file for the record, newest first.
  names: string[];
  phoneLast4: string | null;
  domains: { domain: string; invoices: number; first: string; newest: string }[];
  currencies: string[];
  methods: string[];
  related: RelatedRecord[];
  recordStored: RecordStored | null;
  cautions: Caution[];
  money: BoardTotal[];
  accounts: AccountView[];
  invoices: InvoiceView[];
  closed: { listed: number; settled: number; rejected: number };
  bankChanges: BankChangeView[];
  duplicates: DuplicateGroup[];
  outages: { active: OutageBrief[]; holds: HoldView[]; failures: FailureView[] };
  runs: RunRowView[];
  inbox: InboxView[];
  drafts: DraftSummary[];
}

export interface SupplierSummary {
  // The beneficiary id, null when it breaks SUPPLIER_KEY_PATTERN and so cannot be
  // linked.
  key: string | null;
  name: string;
  otherNames: number;
  sameName: string[];
  invoices: { total: number; open: number; escalated: number; settled: number; rejected: number };
  // Pay rows of the waiting run, not released.
  runRows: number;
  groups: Record<BoardGroup, number>;
  atRisk: BoardMoney[];
  // Level caution only.
  cautions: CautionCode[];
}

export interface SupplierList {
  generatedAt: string;
  suppliers: SupplierSummary[];
}

// ---------- the record's facts ----------

interface Findings {
  claimsNonReceipt: boolean;
  asksForNewBankDetails: boolean;
  asksNotToPay: boolean;
  unread: boolean;
  readBy: string | null;
}

interface RecordFacts {
  id: string;
  obligations: Obligation[];
  attempts: SupplierAttempt[];
  payouts: SupplierPayout[];
  approvals: SupplierApproval[];
  callbacks: SupplierCallback[];
  // By invoice: only the addresses and whether each was read in full.
  emails: Map<string, SupplierEmail[]>;
  findings: Map<string, Findings>;
  drafts: SupplierDraft[];
  holds: SupplierHold[];
  failures: SupplierFailure[];
  runRows: SupplierRunRow[];
}

function blankFacts(id: string): RecordFacts {
  return {
    id,
    obligations: [],
    attempts: [],
    payouts: [],
    approvals: [],
    callbacks: [],
    emails: new Map<string, SupplierEmail[]>(),
    findings: new Map<string, Findings>(),
    drafts: [],
    holds: [],
    failures: [],
    runRows: [],
  };
}

function findingsOf(json: string): Findings | null {
  try {
    const parsed: Record<string, unknown> = JSON.parse(json) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    return {
      claimsNonReceipt: parsed["claimsNonReceipt"] === true,
      asksForNewBankDetails: parsed["asksForNewBankDetails"] === true,
      asksNotToPay: parsed["asksNotToPay"] === true,
      unread: parsed["unread"] === true,
      readBy: typeof parsed["readBy"] === "string" ? parsed["readBy"] : null,
    };
  } catch {
    return null;
  }
}

// A pay row of the waiting run that no invoice holds yet.
function waitingPayRow(row: SupplierRunRow): boolean {
  return row.runState === "waiting" && row.action === "pay" && row.state === "waiting";
}

// Every record the read names, with its facts. A record exists when an invoice
// pays it or a pay row of the waiting run would. A skip row never makes one,
// since its id may be one Airwallex does not have.
function recordsOf(read: SupplierRead): Map<string, RecordFacts> {
  const records: Map<string, RecordFacts> = new Map<string, RecordFacts>();
  const facts = (id: string): RecordFacts => {
    const found: RecordFacts = records.get(id) ?? blankFacts(id);
    records.set(id, found);
    return found;
  };
  for (const obligation of read.obligations) {
    facts(obligation.beneficiaryId).obligations.push(obligation);
  }
  for (const row of read.runRows) {
    if (waitingPayRow(row) && row.beneficiaryId !== "") {
      facts(row.beneficiaryId);
    }
  }
  const known = (id: string): RecordFacts | undefined => records.get(id);
  for (const attempt of read.attempts) {
    known(attempt.beneficiaryId)?.attempts.push(attempt);
  }
  for (const payout of read.payouts) {
    known(payout.beneficiaryId)?.payouts.push(payout);
  }
  for (const approval of read.approvals) {
    known(approval.beneficiaryId)?.approvals.push(approval);
  }
  for (const callback of read.callbacks) {
    known(callback.beneficiaryId)?.callbacks.push(callback);
  }
  const beneficiaryOf: Map<string, string> = new Map<string, string>(
    read.obligations.map((obligation: Obligation): [string, string] => [obligation.invoiceId, obligation.beneficiaryId]),
  );
  for (const email of read.emails) {
    const id: string | undefined = beneficiaryOf.get(email.invoiceId);
    const record: RecordFacts | undefined = id === undefined ? undefined : known(id);
    if (record !== undefined) {
      const list: SupplierEmail[] = record.emails.get(email.invoiceId) ?? [];
      list.push({ from: email.from, replyTo: email.replyTo, subject: "", body: "", partial: email.partial });
      record.emails.set(email.invoiceId, list);
    }
  }
  for (const found of read.findings) {
    const parsed: Findings | null = findingsOf(found.findings);
    const id: string | undefined = beneficiaryOf.get(found.invoiceId);
    if (parsed !== null && id !== undefined) {
      known(id)?.findings.set(found.invoiceId, parsed);
    }
  }
  for (const draft of read.drafts) {
    const id: string | undefined = beneficiaryOf.get(draft.invoiceId);
    if (id !== undefined) {
      known(id)?.drafts.push(draft);
    }
  }
  for (const failure of read.failures) {
    known(failure.beneficiaryId)?.failures.push(failure);
  }
  const runsOf: Map<number, Set<string>> = new Map<number, Set<string>>();
  for (const row of read.runRows) {
    known(row.beneficiaryId)?.runRows.push(row);
    const ids: Set<string> = runsOf.get(row.runId) ?? new Set<string>();
    ids.add(row.beneficiaryId);
    runsOf.set(row.runId, ids);
  }
  for (const hold of read.holds) {
    if (hold.invoiceId !== null) {
      const id: string | undefined = beneficiaryOf.get(hold.invoiceId);
      if (id !== undefined) {
        known(id)?.holds.push(hold);
      }
    } else if (hold.runId !== null) {
      for (const id of runsOf.get(hold.runId) ?? []) {
        known(id)?.holds.push(hold);
      }
    }
  }
  return records;
}

// ---------- accounts ----------

interface Sighting {
  key: string;
  source: AccountSource;
  at: number;
  ending: string | null;
  invoiceId: string | null;
  runId: number | null;
}

function ms(at: string | null): number {
  const parsed: number = at === null ? Number.NaN : Date.parse(at);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function iso(at: string | null): string | null {
  const parsed: number = ms(at);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function isoOf(at: number): string | null {
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

function ending(value: string | null): string | null {
  return value !== null && ENDING.test(value) ? value : null;
}

// The account key and ending of bank details stored as bankDetailsKey writes
// them, as a callback's applied_key holds them.
function appliedAccount(appliedKey: string): { key: string; ending: string | null } {
  let ending: string | null = null;
  try {
    const entries: unknown = JSON.parse(appliedKey);
    if (Array.isArray(entries)) {
      ending = endingOf(Object.fromEntries(entries.filter((entry: unknown): boolean => Array.isArray(entry))));
    }
  } catch {
    ending = null;
  }
  return { key: keyHash(appliedKey), ending };
}

// The account the record held before a callback, from the JSON the callback
// kept, or null when it cannot be read.
function beforeAccount(oldDetails: string): { key: string; ending: string | null } | null {
  try {
    const details: unknown = JSON.parse(oldDetails);
    if (details === null || typeof details !== "object" || Array.isArray(details)) {
      return null;
    }
    return { key: accountKeyOf(details as TransferBankDetails), ending: endingOf(details) };
  } catch {
    return null;
  }
}

// The account a payment's transfer went to: where it went as last read, else the
// account it was meant for when it has a transfer that did not go elsewhere.
function attemptKey(attempt: SupplierAttempt): string | null {
  if (attempt.sentKey !== null) {
    return attempt.sentKey;
  }
  return attempt.accountKey !== null && !attempt.misdirected && attempt.transferId !== null ? attempt.accountKey : null;
}

function checkOf(attempt: SupplierAttempt): PaymentCheck {
  if (attempt.transferId === null) {
    return "not-sent";
  }
  if (attempt.misdirected) {
    return "misdirected";
  }
  return attempt.accountKey === null ? "not-kept" : "checked";
}

function sentAtOf(attempt: SupplierAttempt): number {
  const created: number = ms(attempt.bankCreatedAt);
  return Number.isNaN(created) ? ms(attempt.openedAt) : created;
}

function sightingsOf(facts: RecordFacts): Sighting[] {
  const seen: Sighting[] = [];
  const add = (sighting: Omit<Sighting, "invoiceId" | "runId"> & { invoiceId?: string | null; runId?: number | null }): void => {
    seen.push({ invoiceId: null, runId: null, ...sighting });
  };
  for (const attempt of facts.attempts) {
    if (attempt.accountKey !== null) {
      add({ key: attempt.accountKey, source: "decided", at: ms(attempt.openedAt), ending: null, invoiceId: attempt.invoiceId });
    }
    if (attempt.sentKey !== null) {
      add({
        key: attempt.sentKey,
        source: "sent",
        at: sentAtOf(attempt),
        ending: ending(attempt.sentEnding),
        invoiceId: attempt.invoiceId,
      });
    }
  }
  for (const approval of facts.approvals) {
    if (approval.accountKey !== null) {
      add({ key: approval.accountKey, source: "approval", at: ms(approval.requestedAt), ending: null, invoiceId: approval.invoiceId });
    }
  }
  for (const row of facts.runRows) {
    if (row.action === "pay" && row.accountKey !== null) {
      add({
        key: row.accountKey,
        source: "pay-run",
        at: ms(row.checkedAt),
        ending: null,
        invoiceId: row.invoiceId,
        runId: row.runId,
      });
    }
  }
  for (const callback of facts.callbacks) {
    if (callback.state === "applied" && callback.appliedKey !== null) {
      const applied: { key: string; ending: string | null } = appliedAccount(callback.appliedKey);
      add({ ...applied, source: "callback", at: ms(callback.recordedAt), invoiceId: callback.invoiceId });
    }
    const before: { key: string; ending: string | null } | null = beforeAccount(callback.oldDetails);
    if (before !== null) {
      add({ ...before, source: "before-callback", at: ms(callback.recordedAt), invoiceId: callback.invoiceId });
    }
  }
  for (const payout of facts.payouts) {
    if (payout.sentKey !== null) {
      add({
        key: payout.sentKey,
        source: "outside",
        at: ms(payout.foundAt),
        ending: ending(payout.sentEnding),
        invoiceId: payout.invoiceId,
      });
    }
  }
  return seen;
}

function letters(index: number): string {
  let out: string = "";
  let rest: number = index;
  do {
    out = String.fromCharCode(65 + (rest % 26)) + out;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return out;
}

// The order to label accounts in: first seen first, an unknown time last, then
// by key.
function firstOrder(a: { key: string; first: number }, b: { key: string; first: number }): number {
  const x: number = Number.isNaN(a.first) ? Number.POSITIVE_INFINITY : a.first;
  const y: number = Number.isNaN(b.first) ? Number.POSITIVE_INFINITY : b.first;
  return x - y || a.key.localeCompare(b.key);
}

function blankCount(): PaymentCount {
  return { paid: 0, failed: 0, live: 0, total: 0 };
}

function countAttempt(count: PaymentCount, attempt: SupplierAttempt): void {
  count.total += 1;
  if (attempt.state === "paid") {
    count.paid += 1;
  } else if (liveAtBank(attempt)) {
    count.live += 1;
  } else {
    count.failed += 1;
  }
}

function countPayout(count: PaymentCount, payout: SupplierPayout): void {
  count.total += 1;
  if (payout.state === "paid") {
    count.paid += 1;
  } else if (payout.state === "failed") {
    count.failed += 1;
  } else {
    count.live += 1;
  }
}

// Which records each account key and each failing payee is on, across the
// ledger, for the links between records.
interface Owners {
  byKey: Map<string, Set<string>>;
  byPayee: Map<string, Set<string>>;
  byName: Map<string, Set<string>>;
  newestName: Map<string, { name: string; newest: number }>;
}

function addOwner(map: Map<string, Set<string>>, key: string, id: string): void {
  const ids: Set<string> = map.get(key) ?? new Set<string>();
  ids.add(id);
  map.set(key, ids);
}

function ownersOf(links: SupplierLinks): Owners {
  const owners: Owners = {
    byKey: new Map<string, Set<string>>(),
    byPayee: new Map<string, Set<string>>(),
    byName: new Map<string, Set<string>>(),
    newestName: new Map<string, { name: string; newest: number }>(),
  };
  for (const { beneficiaryId, key } of links.keys) {
    addOwner(owners.byKey, key, beneficiaryId);
  }
  for (const callback of links.callbacks) {
    if (callback.appliedKey !== null) {
      addOwner(owners.byKey, keyHash(callback.appliedKey), callback.beneficiaryId);
    }
    const before: { key: string } | null = beforeAccount(callback.oldDetails);
    if (before !== null) {
      addOwner(owners.byKey, before.key, callback.beneficiaryId);
    }
  }
  for (const { beneficiaryId, payee } of links.payees) {
    addOwner(owners.byPayee, payee, beneficiaryId);
  }
  for (const { beneficiaryId, name, newest } of links.names) {
    addOwner(owners.byName, supplierNameKey(name), beneficiaryId);
    const held: { name: string; newest: number } | undefined = owners.newestName.get(beneficiaryId);
    if (held === undefined || newest > held.newest) {
      owners.newestName.set(beneficiaryId, { name, newest });
    }
  }
  return owners;
}

function others(ids: Set<string> | undefined, self: string): string[] {
  return [...(ids ?? [])].filter((id: string): boolean => id !== self);
}

interface Accounts {
  views: AccountView[];
  labelOf: Map<string, string>;
  lastPaid: { transferId: string; reference: string | null; accountKey: string } | undefined;
  unchecked: { transferId: string; reference: string | null } | undefined;
  stored: { key: string; at: number; invoiceId: string | null; runId: number | null } | null;
  latestApplied: SupplierCallback | undefined;
}

function accountsOf(ledger: Ledger, facts: RecordFacts, owners: Owners): Accounts {
  const seen: Sighting[] = sightingsOf(facts);
  const byKey: Map<string, Sighting[]> = new Map<string, Sighting[]>();
  for (const sighting of seen) {
    const list: Sighting[] = byKey.get(sighting.key) ?? [];
    list.push(sighting);
    byKey.set(sighting.key, list);
  }
  const ordered: { key: string; first: number }[] = [...byKey.entries()]
    .map(([key, list]: [string, Sighting[]]) => ({
      key,
      first: list.reduce(
        (first: number, sighting: Sighting): number =>
          Number.isNaN(sighting.at) ? first : Number.isNaN(first) ? sighting.at : Math.min(first, sighting.at),
        Number.NaN,
      ),
    }))
    .sort(firstOrder);
  const labelOf: Map<string, string> = new Map<string, string>(
    ordered.map(({ key }: { key: string }, index: number): [string, string] => [key, letters(index)]),
  );
  const lastPaid = ledger.lastPaidTransfer(facts.id);
  const unchecked = lastPaid === undefined ? ledger.lastPaidUnchecked(facts.id) : undefined;
  const storedSighting: Sighting | undefined = seen
    .filter(
      (sighting: Sighting): boolean =>
        (sighting.source === "decided" ||
          sighting.source === "approval" ||
          sighting.source === "pay-run" ||
          sighting.source === "callback") &&
        !Number.isNaN(sighting.at),
    )
    .sort((a: Sighting, b: Sighting): number => a.at - b.at)
    .at(-1);
  const stored: Accounts["stored"] =
    storedSighting === undefined
      ? null
      : { key: storedSighting.key, at: storedSighting.at, invoiceId: storedSighting.invoiceId, runId: storedSighting.runId };
  const applied: SupplierCallback[] = facts.callbacks.filter(
    (callback: SupplierCallback): boolean => callback.state === "applied" && callback.appliedKey !== null,
  );
  const latestApplied: SupplierCallback | undefined = applied.at(-1);
  const views: AccountView[] = ordered.map(({ key }: { key: string }): AccountView => {
    const list: Sighting[] = byKey.get(key) ?? [];
    const times: number[] = list.map((sighting: Sighting): number => sighting.at).filter((at: number): boolean => !Number.isNaN(at));
    const payonce: PaymentCount = blankCount();
    for (const attempt of facts.attempts) {
      if (attemptKey(attempt) === key) {
        countAttempt(payonce, attempt);
      }
    }
    const outside: PaymentCount = blankCount();
    for (const payout of facts.payouts) {
      if (payout.sentKey === key) {
        countPayout(outside, payout);
      }
    }
    const verifying: SupplierCallback[] = applied.filter(
      (callback: SupplierCallback): boolean => keyHash(callback.appliedKey ?? "") === key,
    );
    const latest: SupplierCallback | undefined =
      latestApplied !== undefined && verifying.includes(latestApplied) ? latestApplied : undefined;
    const barred: Set<string> = new Set<string>();
    for (const appliedKey of new Set<string>(verifying.map((callback: SupplierCallback): string => callback.appliedKey ?? ""))) {
      for (const stored of ledger.bankChangeRecorders(facts.id, appliedKey)) {
        const name: string | null = knownName(stored);
        if (name !== null) {
          barred.add(name);
        }
      }
    }
    const payeesHere: Set<string> = new Set<string>();
    for (const failure of facts.failures) {
      const attempt: SupplierAttempt | undefined = facts.attempts.find(
        (candidate: SupplierAttempt): boolean => candidate.transferId === failure.transferId,
      );
      if (attempt !== undefined && attemptKey(attempt) === key) {
        payeesHere.add(failure.payee);
      }
    }
    const alsoOn: Set<string> = new Set<string>(others(owners.byKey.get(key), facts.id));
    for (const payee of payeesHere) {
      for (const id of others(owners.byPayee.get(payee), facts.id)) {
        alsoOn.add(id);
      }
    }
    return {
      label: labelOf.get(key) ?? "",
      accountKey: key,
      ending: list.map((sighting: Sighting): string | null => sighting.ending).find((value: string | null): boolean => value !== null) ?? null,
      firstSeen: times.length === 0 ? null : isoOf(Math.min(...times)),
      lastSeen: times.length === 0 ? null : isoOf(Math.max(...times)),
      seenAs: SOURCE_ORDER.filter((source: AccountSource): boolean => list.some((sighting: Sighting): boolean => sighting.source === source)),
      payonce,
      outside,
      lastPaid: lastPaid?.accountKey === key,
      lastPaidReference:
        lastPaid?.accountKey === key && lastPaid.reference !== null && REFERENCE.test(lastPaid.reference) ? lastPaid.reference : null,
      recordLastStored: stored?.key === key,
      verifiedBy:
        latest === undefined
          ? null
          : { callbackId: latest.id, invoiceId: latest.invoiceId, calledBy: latest.calledBy, calledAt: iso(latest.calledAt) },
      superseded: verifying
        .filter((callback: SupplierCallback): boolean => callback !== latest)
        .map((callback: SupplierCallback): number => callback.id),
      barred: [...barred],
      alsoOn: [...alsoOn].filter((id: string): boolean => SUPPLIER_KEY_PATTERN.test(id)).sort(),
    };
  });
  return { views, labelOf, lastPaid, unchecked, stored, latestApplied };
}

// ---------- cautions ----------

function open(obligation: Obligation): boolean {
  return obligation.state === "open" || obligation.state === "escalated";
}

function joined(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function earliest(times: number[]): string | null {
  const known: number[] = times.filter((at: number): boolean => !Number.isNaN(at));
  return known.length === 0 ? null : isoOf(Math.min(...known));
}

function railName(currency: string, method: string): string | null {
  const rail: string = railOf({ currency, method });
  return RAIL_NAME.test(rail) ? rail : null;
}

interface CautionDraft {
  code: CautionCode;
  text: string;
  invoices?: string[];
  accounts?: string[];
  keys?: string[];
  runs?: number[];
  since?: string | null;
}

function cautionOf(draft: CautionDraft): Caution {
  return {
    code: draft.code,
    level: CAUTIONS[draft.code].level,
    text: draft.text,
    invoices: (draft.invoices ?? []).slice(0, LINKS_LISTED),
    accounts: draft.accounts ?? [],
    keys: draft.keys ?? [],
    runs: draft.runs ?? [],
    since: draft.since ?? null,
  };
}

function failedAttempt(attempt: SupplierAttempt): boolean {
  return attempt.state === "failed" && attempt.transferId !== null && !liveAtBank(attempt);
}

function cautionsOf(ledger: Ledger, facts: RecordFacts, accounts: Accounts, owners: Owners, now: number): Caution[] {
  const found: CautionDraft[] = [];
  const openOnes: Obligation[] = facts.obligations.filter(open);
  const ids = (list: Obligation[]): string[] => list.map((obligation: Obligation): string => obligation.invoiceId);
  const label = (key: string | undefined | null): string[] => {
    const value: string | undefined = key === undefined || key === null ? undefined : accounts.labelOf.get(key);
    return value === undefined ? [] : [value];
  };
  const { lastPaid, unchecked, stored, latestApplied } = accounts;
  const appliedKey: string | null = latestApplied?.appliedKey === null || latestApplied === undefined ? null : keyHash(latestApplied.appliedKey);
  const lastPaidAttempt: SupplierAttempt | undefined =
    lastPaid === undefined
      ? undefined
      : facts.attempts.find((attempt: SupplierAttempt): boolean => attempt.transferId === lastPaid.transferId);
  const lastPaidAt: number = lastPaidAttempt === undefined ? Number.NaN : sentAtOf(lastPaidAttempt);

  // The record holds other details than the account last paid, and no callback
  // since has verified them.
  const callbackSince: boolean =
    latestApplied !== undefined && (Number.isNaN(lastPaidAt) || ms(latestApplied.recordedAt) > lastPaidAt);
  const held: Obligation[] = callbackSince
    ? []
    : openOnes.filter((obligation: Obligation): boolean =>
        ACCOUNT_REASONS.some((reason: string): boolean => obligation.escalationReason.startsWith(reason)),
      );
  const storedChanged: boolean =
    stored !== null && lastPaid !== undefined && stored.key !== lastPaid.accountKey && appliedKey !== stored.key;
  if (held.length > 0 || storedChanged) {
    found.push({
      code: "account-changed",
      text: "PayOnce found this record holding bank details other than the account it last paid and checked, and no callback has verified them. It pays nothing to them until someone calls the number on file and records the call.",
      invoices: ids(held),
      accounts: storedChanged ? label(stored?.key) : [],
      since: storedChanged ? isoOf(stored?.at ?? Number.NaN) : null,
    });
  }
  if (appliedKey !== null && stored?.key === appliedKey && appliedKey !== lastPaid?.accountKey) {
    const shown: string[] = label(appliedKey);
    found.push({
      code: "callback-verified",
      text: `A callback verified account ${shown[0] ?? "on file"}. Until a payment to it is paid, every first payment and replacement to it needs two approvers, and whoever recorded the callback cannot approve.`,
      invoices: latestApplied === undefined ? [] : [latestApplied.invoiceId],
      accounts: shown,
      since: iso(latestApplied?.recordedAt ?? null),
    });
  }
  if (lastPaid === undefined && unchecked === undefined) {
    found.push({
      code: "new-payee",
      text: "PayOnce has never paid this record. Paying a held invoice to it, or a pay run row, needs two approvers.",
    });
  }
  if (lastPaid === undefined && unchecked !== undefined) {
    const paid: SupplierAttempt | undefined = facts.attempts.find(
      (attempt: SupplierAttempt): boolean => attempt.transferId === unchecked.transferId,
    );
    found.push({
      code: "unconfirmed-account",
      text: "PayOnce paid this record only before it kept which account each payment went to, so its next first payment waits for two approvers.",
      invoices: paid === undefined ? [] : [paid.invoiceId],
    });
  }
  const misdirected: SupplierAttempt[] = facts.attempts.filter((attempt: SupplierAttempt): boolean => attempt.misdirected);
  if (misdirected.length > 0) {
    found.push({
      code: "misdirected",
      text: "A transfer went to bank details other than the ones it was decided or approved for, so it never counts as the account PayOnce last paid.",
      invoices: [...new Set<string>(misdirected.map((attempt: SupplierAttempt): string => attempt.invoiceId))],
      since: earliest(misdirected.map(sentAtOf)),
    });
  }
  const shared: AccountView[] = accounts.views.filter((view: AccountView): boolean => view.alsoOn.length > 0);
  const sharedPayees: string[] = [
    ...new Set<string>(facts.failures.flatMap((failure: SupplierFailure): string[] => others(owners.byPayee.get(failure.payee), facts.id))),
  ];
  const sharedKeys: string[] = [
    ...new Set<string>([...shared.flatMap((view: AccountView): string[] => view.alsoOn), ...sharedPayees]),
  ].filter((id: string): boolean => SUPPLIER_KEY_PATTERN.test(id));
  if (sharedKeys.length > 0) {
    const labels: string[] = shared.map((view: AccountView): string => view.label);
    found.push({
      code: "shared-account",
      text:
        labels.length === 0
          ? "An account this record paid is also on another supplier record. PayOnce treats the two as separate suppliers: a callback or a payment on one does not count for the other."
          : `${labels.length === 1 ? "Account" : "Accounts"} ${joined(labels)} ${labels.length === 1 ? "is" : "are"} also on another supplier record. PayOnce treats the two as separate suppliers: a callback or a payment on one does not count for the other.`,
      accounts: labels,
      keys: sharedKeys.sort(),
    });
  }
  for (const key of new Set<string>([lastPaid?.accountKey ?? "", stored?.key ?? ""])) {
    if (key === "") {
      continue;
    }
    const failed: SupplierAttempt[] = facts.attempts.filter(
      (attempt: SupplierAttempt): boolean =>
        failedAttempt(attempt) &&
        attemptKey(attempt) === key &&
        ACCOUNT_LEVEL_CODES.has(attempt.failureCode ?? "") &&
        now - sentAtOf(attempt) <= RECENT_MS,
    );
    const latest: SupplierAttempt | undefined = failed.at(-1);
    if (latest !== undefined) {
      found.push({
        code: "account-failure",
        text: `A payment to account ${label(key)[0] ?? "on file"} failed in the last 30 days with an account-level code (${FAILURE_WORDS[latest.failureCode ?? ""] ?? "another code"}). The account may be closed or wrong.`,
        invoices: [...new Set<string>(failed.map((attempt: SupplierAttempt): string => attempt.invoiceId))],
        accounts: label(key),
        since: earliest(failed.map(sentAtOf)),
      });
    }
  }
  const withDomain: Obligation[] = facts.obligations.filter((obligation: Obligation): boolean => obligation.supplierDomain !== "");
  const domains: Set<string> = new Set<string>(withDomain.map((obligation: Obligation): string => obligation.supplierDomain));
  const [newest, before] = withDomain;
  if (domains.size >= 2 && newest !== undefined && before !== undefined && newest.supplierDomain !== before.supplierDomain) {
    found.push({
      code: "domain-changed",
      text: "Invoices give this record more than one email domain, and the newest differs from the one before it. The sender check trusts each invoice's own domain.",
      invoices: [newest.invoiceId, before.invoiceId],
    });
  }
  const asked = (test: (findings: Findings) => boolean): Obligation[] =>
    openOnes.filter((obligation: Obligation): boolean => {
      const findings: Findings | undefined = facts.findings.get(obligation.invoiceId);
      return findings !== undefined && test(findings);
    });
  const notToPay: Obligation[] = asked((findings: Findings): boolean => findings.asksNotToPay);
  if (notToPay.length > 0) {
    found.push({
      code: "asks-not-to-pay",
      text: "The supplier asks to hold, cancel or not pay these invoices. PayOnce suggests no message to them.",
      invoices: ids(notToPay),
    });
  }
  const newDetails: Obligation[] = asked((findings: Findings): boolean => findings.asksForNewBankDetails);
  if (newDetails.length > 0) {
    found.push({
      code: "asks-new-details",
      text: "An email asks for payment to a different account. PayOnce never takes bank details from an email: a person calls the number on file first.",
      invoices: ids(newDetails),
    });
  }
  const twice: Obligation[] = openOnes.filter((obligation: Obligation): boolean =>
    obligation.escalationReason.startsWith(LATE_TRANSFER_REASON),
  );
  if (twice.length > 0) {
    found.push({ code: "paid-twice", text: "PayOnce may have paid these invoices twice.", invoices: ids(twice) });
  }
  if (!facts.obligations.some((obligation: Obligation): boolean => (obligation.supplierPhone ?? "").trim() !== "")) {
    found.push({
      code: "no-phone",
      text: "No phone number is on file for this record, so nobody can record a callback for it.",
    });
  }
  const recent: SupplierAttempt[] = facts.attempts.filter(
    (attempt: SupplierAttempt): boolean => failedAttempt(attempt) && now - sentAtOf(attempt) <= RECENT_MS,
  );
  if (recent.length > 0) {
    const byWords: Map<string, number> = new Map<string, number>();
    let other: number = 0;
    for (const attempt of recent) {
      const words: string | undefined = FAILURE_WORDS[attempt.failureCode ?? ""];
      if (words === undefined) {
        other += 1;
      } else {
        byWords.set(words, (byWords.get(words) ?? 0) + 1);
      }
    }
    const parts: string[] = [
      ...[...byWords.entries()].map(([words, count]: [string, number]): string => `${count} ${words}`),
      ...(other === 0 ? [] : [`${other} with a code PayOnce has no words for`]),
    ];
    found.push({
      code: "recent-failures",
      text: `${plural(recent.length, "payment", "payments")} failed in the last 30 days: ${joined(parts)}.`,
      invoices: [...new Set<string>(recent.map((attempt: SupplierAttempt): string => attempt.invoiceId))].reverse(),
      since: earliest(recent.map(sentAtOf)),
    });
  }
  const nonReceipt: Obligation[] = facts.obligations.filter(
    (obligation: Obligation): boolean => facts.findings.get(obligation.invoiceId)?.claimsNonReceipt === true,
  );
  if (nonReceipt.length > 0) {
    found.push({
      code: "non-receipt",
      text: "The supplier reports that a payment has not arrived on these invoices.",
      invoices: ids(nonReceipt),
    });
  }
  const flagged: Obligation[] = withDomain.filter(
    (obligation: Obligation): boolean => unverifiedSenders(emailsOf(facts, obligation.invoiceId), obligation.supplierDomain).length > 0,
  );
  if (flagged.length > 0) {
    found.push({
      code: "flagged-senders",
      text: "Emails on these invoices come from addresses that do not match the domain on file.",
      invoices: ids(flagged),
    });
  }
  const noDomain: Obligation[] = facts.obligations.filter((obligation: Obligation): boolean => obligation.supplierDomain === "");
  if (noDomain.length > 0) {
    found.push({
      code: "no-domain",
      text: `${plural(noDomain.length, "invoice has", "invoices have")} no email domain on file, so every sender on ${noDomain.length === 1 ? "it" : "them"} is flagged.`,
      invoices: ids([...noDomain.filter(open), ...noDomain.filter((obligation: Obligation): boolean => !open(obligation))]),
    });
  }
  const outsideLive: string[] = [
    ...new Set<string>(
      facts.payouts
        .filter((payout: SupplierPayout): boolean => payout.state === "in_flight" || payout.state === "unknown")
        .map((payout: SupplierPayout): string => payout.invoiceId),
    ),
  ];
  if (outsideLive.length > 0) {
    found.push({
      code: "outside-payout",
      text: "A payout sent outside PayOnce is live on these invoices, so PayOnce sends nothing for them.",
      invoices: outsideLive,
    });
  }
  const heldDuplicates: Obligation[] = facts.obligations.filter(
    (obligation: Obligation): boolean =>
      obligation.state === "escalated" &&
      obligation.duplicateOf.length > 0 &&
      facts.attempts
        .filter((attempt: SupplierAttempt): boolean => attempt.invoiceId === obligation.invoiceId)
        .every((attempt: SupplierAttempt): boolean => attempt.transferId === null && attempt.state === "failed"),
  );
  if (heldDuplicates.length > 0) {
    found.push({ code: "held-duplicate", text: "These invoices are held as likely second bills.", invoices: ids(heldDuplicates) });
  }
  for (const brief of activeOutages(ledger, openOnes)) {
    found.push({
      code: "outage",
      text:
        brief.rail === null
          ? "An outage is active on the rail these invoices pay on."
          : `An outage is active on ${brief.rail}, which these invoices pay on.`,
      invoices: brief.invoices,
      since: brief.declaredAt,
    });
  }
  return found
    .map(cautionOf)
    .sort(
      (a: Caution, b: Caution): number =>
        Number(a.level === "info") - Number(b.level === "info") ||
        CAUTION_ORDER.indexOf(a.code) - CAUTION_ORDER.indexOf(b.code),
    );
}

function emailsOf(facts: RecordFacts, invoiceId: string): SupplierEmail[] {
  return facts.emails.get(invoiceId) ?? [];
}

// The active outages on the rails these open invoices pay on, oldest first.
function activeOutages(ledger: Ledger, openOnes: Obligation[]): OutageBrief[] {
  const byId: Map<number, OutageBrief> = new Map<number, OutageBrief>();
  for (const obligation of openOnes) {
    const outage: Outage | undefined = ledger.activeOutage(obligation.currency, obligation.transferMethod);
    if (outage === undefined) {
      continue;
    }
    const brief: OutageBrief = byId.get(outage.id) ?? {
      id: outage.id,
      rail: railName(outage.currency, outage.method),
      declaredAt: iso(outage.declaredAt),
      invoices: [],
    };
    brief.invoices.push(obligation.invoiceId);
    byId.set(outage.id, brief);
  }
  return [...byId.values()].sort((a: OutageBrief, b: OutageBrief): number => a.id - b.id);
}

// ---------- the detail's sections ----------

function failureWordsOf(code: string | null): string | null {
  return code === null ? null : (FAILURE_WORDS[code] ?? null);
}

function paymentView(attempt: SupplierAttempt, labelOf: Map<string, string>): PaymentView {
  const key: string | null = attemptKey(attempt);
  const code: string | null = attempt.failureCode !== null && FAILURE_CODE.test(attempt.failureCode) ? attempt.failureCode : null;
  return {
    kind: attempt.kind === "replacement" ? "replacement" : "original",
    reference: attempt.reference !== null && REFERENCE.test(attempt.reference) ? attempt.reference : null,
    state: attempt.state,
    bankStatus: attempt.bankStatus !== null && STATUS.test(attempt.bankStatus) ? attempt.bankStatus : null,
    failureCode: code,
    failureWords: failureWordsOf(code),
    amountMinor: attempt.amountMinor,
    currency: attempt.currency,
    feeMinor: attempt.feeMinor,
    feeCurrency: attempt.feeCurrency,
    sentAt: iso(attempt.bankCreatedAt),
    account: key === null ? null : (labelOf.get(key) ?? null),
    check: checkOf(attempt),
    foundLate: attempt.foundLateAt !== null,
    rateMismatch: attempt.rateMismatch !== null,
    mismatchedReference:
      attempt.mismatchedReference !== null && REFERENCE.test(attempt.mismatchedReference) ? attempt.mismatchedReference : null,
    mismatchedStatus:
      attempt.mismatchedStatus !== null && STATUS.test(attempt.mismatchedStatus) ? attempt.mismatchedStatus : null,
  };
}

function payoutView(payout: SupplierPayout, labelOf: Map<string, string>): PaymentView {
  return {
    kind: "outside",
    reference: REFERENCE.test(payout.reference) ? payout.reference : null,
    state: payout.state,
    bankStatus: null,
    failureCode: null,
    failureWords: null,
    amountMinor: payout.amountMinor,
    currency: payout.currency,
    feeMinor: payout.feeMinor,
    feeCurrency: payout.feeCurrency,
    sentAt: iso(payout.foundAt),
    account: payout.sentKey === null ? null : (labelOf.get(payout.sentKey) ?? null),
    check: "outside",
    foundLate: false,
    rateMismatch: false,
    mismatchedReference: null,
    mismatchedStatus: null,
  };
}

function paidByOf(attempts: SupplierAttempt[], payouts: SupplierPayout[], labelOf: Map<string, string>): PaidBy | null {
  const paid: SupplierAttempt | undefined = attempts.filter((attempt: SupplierAttempt): boolean => attempt.state === "paid").at(-1);
  if (paid !== undefined) {
    const view: PaymentView = paymentView(paid, labelOf);
    const latest: string | null = paid.arrival?.latest ?? null;
    return {
      kind: view.kind,
      reference: view.reference,
      sentAt: view.sentAt,
      account: view.account,
      check: view.check,
      arrivesBy: latest !== null && /^\d{4}-\d{2}-\d{2}$/.test(latest) ? latest : null,
    };
  }
  const outside: SupplierPayout | undefined = payouts.filter((payout: SupplierPayout): boolean => payout.state === "paid").at(-1);
  if (outside === undefined) {
    return null;
  }
  const view: PaymentView = payoutView(outside, labelOf);
  return { kind: "outside", reference: view.reference, sentAt: view.sentAt, account: view.account, check: "outside", arrivesBy: null };
}

function emailsView(facts: RecordFacts, obligation: Obligation): EmailsView | null {
  const emails: SupplierEmail[] = emailsOf(facts, obligation.invoiceId);
  const findings: Findings | undefined = facts.findings.get(obligation.invoiceId);
  if (emails.length === 0 && findings === undefined) {
    return null;
  }
  return {
    count: emails.length,
    partlyUnread: emails.filter((email: SupplierEmail): boolean => email.partial === true).length,
    sendersFlagged: unverifiedSenders(emails, obligation.supplierDomain).length,
    findings:
      findings === undefined
        ? null
        : {
            claimsNonReceipt: findings.claimsNonReceipt,
            asksForNewBankDetails: findings.asksForNewBankDetails,
            asksNotToPay: findings.asksNotToPay,
            summary: summarise(findings.claimsNonReceipt, findings.asksForNewBankDetails, findings.asksNotToPay),
            unread: findings.unread,
            readBy: findings.readBy,
          },
  };
}

function boardOf(entry: BoardEntry | undefined): InvoiceBoard | null {
  return entry === undefined ? null : { group: entry.group, label: GROUP_LABELS[entry.group], why: entry.why, also: entry.also };
}

function invoiceView(
  facts: RecordFacts,
  obligation: Obligation,
  entry: BoardEntry | undefined,
  attempts: SupplierAttempt[],
  payouts: SupplierPayout[],
  labelOf: Map<string, string>,
): InvoiceView {
  const row: SupplierRunRow | undefined =
    obligation.runRowId === null ? undefined : facts.runRows.find((candidate: SupplierRunRow): boolean => candidate.id === obligation.runRowId);
  return {
    invoiceId: obligation.invoiceId,
    state: obligation.state,
    origin: obligation.origin,
    supplier: obligation.supplier,
    amountMinor: obligation.amountMinor,
    currency: obligation.currency,
    wallet: debitCurrency(obligation),
    method: obligation.transferMethod,
    dueDate: obligation.dueDate,
    runId: row?.runId ?? null,
    runLine: row?.line ?? null,
    startedBy: obligation.startedBy,
    rejectedBy: obligation.rejectedBy,
    board: boardOf(entry),
    atRisk: entry?.atRisk ?? [],
    duplicateOf: obligation.duplicateOf,
    paidBy: paidByOf(attempts, payouts, labelOf),
    payments: [
      ...attempts.map((attempt: SupplierAttempt): PaymentView => paymentView(attempt, labelOf)),
      ...payouts.map((payout: SupplierPayout): PaymentView => payoutView(payout, labelOf)),
    ],
    emails: emailsView(facts, obligation),
  };
}

function lastFourDigits(phone: string | null): string | null {
  const digits: string = (phone ?? "").replace(/[^0-9]/g, "");
  return digits === "" ? null : digits.slice(-4);
}

function bankChangesOf(ledger: Ledger, facts: RecordFacts, accounts: Accounts): BankChangeView[] {
  return facts.callbacks.map((callback: SupplierCallback): BankChangeView => {
    const before: { key: string } | null = beforeAccount(callback.oldDetails);
    const applied: { key: string } | null =
      callback.state === "applied" && callback.appliedKey !== null ? appliedAccount(callback.appliedKey) : null;
    const barred: string[] =
      callback.state === "applied" && callback.appliedKey !== null
        ? ledger
            .bankChangeRecorders(facts.id, callback.appliedKey)
            .map(knownName)
            .filter((name: string | null): name is string => name !== null)
        : [];
    return {
      id: callback.id,
      invoiceId: callback.invoiceId,
      calledBy: callback.calledBy,
      numberCalledLast4: lastFourDigits(callback.numberCalled),
      calledAt: iso(callback.calledAt),
      state: callback.state,
      from: before === null ? null : (accounts.labelOf.get(before.key) ?? null),
      to: applied === null ? null : (accounts.labelOf.get(applied.key) ?? null),
      recordedAt: iso(callback.recordedAt),
      latest: callback === accounts.latestApplied,
      barred,
    };
  });
}

// Groups of invoices whose numbers sameInvoiceNumber matches, across this record
// and the records that share its name, each with at least one of this record's
// invoices. Numbers are bucketed by their base first, since two numbers it
// matches always share one, so the work grows with the invoices, not their
// pairs.
function duplicatesOf(facts: RecordFacts, sameName: Obligation[]): DuplicateGroup[] {
  const pool: Obligation[] = [...facts.obligations, ...sameName];
  const buckets: Map<string, Obligation[]> = new Map<string, Obligation[]>();
  for (const obligation of pool) {
    for (const number of numbersOf(obligation)) {
      const base: string = numberOf(number).base;
      if (base === "") {
        continue;
      }
      const list: Obligation[] = buckets.get(base) ?? [];
      if (!list.includes(obligation)) {
        list.push(obligation);
      }
      buckets.set(base, list);
    }
  }
  const parent: Map<string, string> = new Map<string, string>();
  const find = (id: string): string => {
    let at: string = id;
    while ((parent.get(at) ?? at) !== at) {
      at = parent.get(at) ?? at;
    }
    return at;
  };
  for (const list of buckets.values()) {
    for (let i: number = 0; i < list.length; i += 1) {
      for (let j: number = i + 1; j < list.length; j += 1) {
        const a: Obligation | undefined = list[i];
        const b: Obligation | undefined = list[j];
        if (
          a !== undefined &&
          b !== undefined &&
          numbersOf(a).some((x: string): boolean => numbersOf(b).some((y: string): boolean => sameInvoiceNumber(x, y)))
        ) {
          parent.set(find(b.invoiceId), find(a.invoiceId));
        }
      }
    }
  }
  const groups: Map<string, Obligation[]> = new Map<string, Obligation[]>();
  for (const obligation of pool) {
    const root: string = find(obligation.invoiceId);
    const list: Obligation[] = groups.get(root) ?? [];
    if (!list.includes(obligation)) {
      list.push(obligation);
    }
    groups.set(root, list);
  }
  const mine: Set<string> = new Set<string>(facts.obligations.map((obligation: Obligation): string => obligation.invoiceId));
  return [...groups.values()]
    .filter((list: Obligation[]): boolean => list.length > 1 && list.some((obligation: Obligation): boolean => mine.has(obligation.invoiceId)))
    .map((list: Obligation[]): DuplicateGroup => {
      const first: Obligation | undefined = list[0];
      const sameBill: boolean = list.every(
        (obligation: Obligation): boolean =>
          obligation.currency === first?.currency && obligation.amountMinor === first.amountMinor,
      );
      return {
        kind: sameBill ? "same-bill" : "same-number",
        invoices: [...list].reverse().map(
          (obligation: Obligation): DuplicateMember => ({
            invoiceId: obligation.invoiceId,
            key: SUPPLIER_KEY_PATTERN.test(obligation.beneficiaryId) ? obligation.beneficiaryId : null,
            thisRecord: mine.has(obligation.invoiceId),
            state: obligation.state,
            amountMinor: obligation.amountMinor,
            currency: obligation.currency,
            held: obligation.duplicateOf.length > 0,
          }),
        ),
      };
    });
}

function outagesOf(ledger: Ledger, facts: RecordFacts): SupplierDetail["outages"] {
  const countedBy: Map<string, number> = new Map<string, number>();
  for (const outage of ledger.outages()) {
    for (const transferId of outage.counted) {
      countedBy.set(transferId, outage.id);
    }
  }
  return {
    active: activeOutages(ledger, facts.obligations.filter(open)),
    holds: facts.holds.map(
      (hold: SupplierHold): HoldView => ({
        outageId: hold.outageId,
        rail: railName(hold.currency, hold.method),
        invoiceId: hold.invoiceId,
        runId: hold.runId,
        what: hold.what,
        heldAt: iso(hold.heldAt),
        state: hold.outageState,
        endedAt: iso(hold.endedAt),
      }),
    ),
    failures: facts.failures.map(
      (failure: SupplierFailure): FailureView => ({
        reference: REFERENCE.test(failure.reference) ? failure.reference : null,
        code: FAILURE_CODE.test(failure.code) ? failure.code : null,
        codeWords: RAIL_FAILURE_CODES[failure.code] ?? null,
        failedAt: iso(failure.failedAt),
        invoiceId: failure.invoiceId,
        outageId: countedBy.get(failure.transferId) ?? null,
      }),
    ),
  };
}

function runsOf(facts: RecordFacts, labelOf: Map<string, string>): RunRowView[] {
  return facts.runRows.map(
    (row: SupplierRunRow): RunRowView => ({
      runId: row.runId,
      runState: row.runState,
      line: row.line,
      invoiceId: row.invoiceId,
      action: row.action,
      state: row.state,
      amountMinor: row.amountMinor,
      currency: row.currency,
      account: row.action === "pay" && row.accountKey !== null ? (labelOf.get(row.accountKey) ?? null) : null,
      newPayee: row.action === "pay" && row.newPayee,
      callbackVerified: row.action === "pay" && row.bankChangeId !== null,
      skipReasons: row.action === "skip" ? row.skipReasons : 0,
    }),
  );
}

// Waiting uploads that name this record's invoices, matched with one index.
function inboxOf(ledger: Ledger, facts: RecordFacts): InboxView[] {
  const waiting: Upload[] = ledger.uploads(0).filter((upload: Upload): boolean => upload.state === "waiting");
  if (waiting.length === 0) {
    return [];
  }
  const mine: Set<string> = new Set<string>(facts.obligations.map((obligation: Obligation): string => obligation.invoiceId));
  const index: InvoiceIndex = invoiceIndex(ledger);
  const found: InboxView[] = [];
  for (const upload of waiting) {
    const match: Match = candidatesFor(ledger, upload, index);
    const invoices: string[] = match.candidates
      .map((candidate: { invoiceId: string }): string => candidate.invoiceId)
      .filter((id: string): boolean => mine.has(id));
    if (invoices.length > 0) {
      found.push({ uploadId: upload.id, invoices, suggested: match.suggested !== null && mine.has(match.suggested) });
    }
  }
  return found;
}

function draftsOf(facts: RecordFacts): DraftSummary[] {
  return facts.drafts.map(
    (draft: SupplierDraft): DraftSummary => ({
      id: draft.id,
      invoiceId: draft.invoiceId,
      label: templateLabel(draft.template),
      audience: draft.audience === "supplier" || draft.audience === "bank" ? draft.audience : null,
      state: draft.state,
      createdBy: draft.createdBy,
      createdAt: iso(draft.createdAt),
      copiedBy: draft.copiedBy,
      copiedAt: iso(draft.copiedAt),
      sentBy: draft.sentBy,
      sentAt: iso(draft.sentAt),
      dismissedBy: draft.dismissedBy,
      dismissedAt: iso(draft.dismissedAt),
    }),
  );
}

function domainsOf(facts: RecordFacts): SupplierDetail["domains"] {
  const byDomain: Map<string, Obligation[]> = new Map<string, Obligation[]>();
  for (const obligation of facts.obligations) {
    if (obligation.supplierDomain === "") {
      continue;
    }
    const list: Obligation[] = byDomain.get(obligation.supplierDomain) ?? [];
    list.push(obligation);
    byDomain.set(obligation.supplierDomain, list);
  }
  return [...byDomain.entries()].map(([domain, list]: [string, Obligation[]]) => ({
    domain,
    invoices: list.length,
    first: list.at(-1)?.invoiceId ?? "",
    newest: list[0]?.invoiceId ?? "",
  }));
}

// The names on file for a record, newest first, one per name sameSupplier takes
// for one, as its newest invoice spells it.
function namesOf(facts: RecordFacts, run: SupplierRunRow | undefined): string[] {
  const names: string[] = [];
  const keys: Set<string> = new Set<string>();
  const spellings: string[] = [
    ...facts.obligations.map((obligation: Obligation): string => obligation.supplier),
    ...(run?.supplier === null || run === undefined ? [] : [run.supplier]),
  ];
  for (const name of spellings) {
    const key: string = supplierNameKey(name);
    if (!keys.has(key)) {
      keys.add(key);
      names.push(name);
    }
  }
  return names;
}

function relatedOf(facts: RecordFacts, accounts: Accounts, owners: Owners, names: string[]): RelatedRecord[] {
  const why: Map<string, Set<"same-name" | "same-account">> = new Map<string, Set<"same-name" | "same-account">>();
  const shared: Map<string, Set<string>> = new Map<string, Set<string>>();
  const mark = (id: string, reason: "same-name" | "same-account"): void => {
    const reasons: Set<"same-name" | "same-account"> = why.get(id) ?? new Set<"same-name" | "same-account">();
    reasons.add(reason);
    why.set(id, reasons);
  };
  for (const name of names) {
    for (const id of others(owners.byName.get(supplierNameKey(name)), facts.id)) {
      mark(id, "same-name");
    }
  }
  for (const view of accounts.views) {
    for (const id of view.alsoOn) {
      mark(id, "same-account");
      const labels: Set<string> = shared.get(id) ?? new Set<string>();
      labels.add(view.label);
      shared.set(id, labels);
    }
  }
  for (const failure of facts.failures) {
    for (const id of others(owners.byPayee.get(failure.payee), facts.id)) {
      mark(id, "same-account");
    }
  }
  return [...why.entries()]
    .filter(([id]: [string, Set<string>]): boolean => SUPPLIER_KEY_PATTERN.test(id))
    .map(
      ([id, reasons]: [string, Set<"same-name" | "same-account">]): RelatedRecord => ({
        key: id,
        name: owners.newestName.get(id)?.name ?? "",
        why: (["same-name", "same-account"] as const).filter((reason: "same-name" | "same-account"): boolean => reasons.has(reason)),
        accounts: [...(shared.get(id) ?? [])].sort(),
      }),
    )
    .sort((a: RelatedRecord, b: RelatedRecord): number => a.key.localeCompare(b.key));
}

// ---------- the list and the detail ----------

function needsBoard(facts: RecordFacts[]): boolean {
  return facts.some(
    (record: RecordFacts): boolean =>
      record.obligations.some(open) || record.runRows.some(waitingPayRow),
  );
}

function sumMoney(entries: BoardEntry[]): BoardMoney[] {
  const byCurrency: Map<string, BoardMoney> = new Map<string, BoardMoney>();
  for (const entry of entries) {
    for (const money of entry.atRisk) {
      const sum: BoardMoney = byCurrency.get(money.currency) ?? { currency: money.currency, minor: 0, estimated: false, feeUnknown: 0 };
      sum.minor += money.minor;
      sum.estimated = sum.estimated || money.estimated;
      sum.feeUnknown += money.feeUnknown;
      byCurrency.set(money.currency, sum);
    }
  }
  return [...byCurrency.values()].sort((a: BoardMoney, b: BoardMoney): number => a.currency.localeCompare(b.currency));
}

function nameOf(facts: RecordFacts): string {
  return (
    facts.obligations[0]?.supplier ??
    facts.runRows.find((row: SupplierRunRow): boolean => waitingPayRow(row) && row.supplier !== null)?.supplier ??
    ""
  );
}

function summaryOf(
  ledger: Ledger,
  facts: RecordFacts,
  entries: BoardEntry[],
  owners: Owners,
  now: number,
): SupplierSummary & { mustCaution: boolean } {
  const accounts: Accounts = accountsOf(ledger, facts, owners);
  const cautions: Caution[] = cautionsOf(ledger, facts, accounts, owners, now);
  const groups: Record<BoardGroup, number> = { person: 0, deadline: 0, bank: 0, open: 0 };
  for (const entry of entries) {
    groups[entry.group] += 1;
  }
  const count = (state: ObligationState): number =>
    facts.obligations.filter((obligation: Obligation): boolean => obligation.state === state).length;
  const names: string[] = namesOf(facts, undefined);
  const sameName: Set<string> = new Set<string>();
  for (const name of names) {
    for (const id of others(owners.byName.get(supplierNameKey(name)), facts.id)) {
      if (SUPPLIER_KEY_PATTERN.test(id)) {
        sameName.add(id);
      }
    }
  }
  const caution: Caution[] = cautions.filter((entry: Caution): boolean => entry.level === "caution");
  return {
    key: SUPPLIER_KEY_PATTERN.test(facts.id) ? facts.id : null,
    name: nameOf(facts),
    otherNames: Math.max(0, names.length - 1),
    sameName: [...sameName].sort(),
    invoices: {
      total: facts.obligations.length,
      open: count("open"),
      escalated: count("escalated"),
      settled: count("settled"),
      rejected: count("rejected"),
    },
    runRows: facts.runRows.filter(waitingPayRow).length,
    groups,
    atRisk: sumMoney(entries),
    cautions: [...new Set<CautionCode>(caution.map((entry: Caution): CautionCode => entry.code))],
    mustCaution: caution.some((entry: Caution): boolean => CAUTIONS[entry.code].must),
  };
}

function largest(money: BoardMoney[]): number {
  return money.reduce((most: number, entry: BoardMoney): number => Math.max(most, entry.minor), 0);
}

// Every supplier record, a record with an entry waiting on a person first, then
// one with a must-tier caution, then the most money at risk (amounts in
// different currencies compared as plain numbers, as the board does), then by
// name and key.
export function supplierList(ledger: Ledger, now: number = Date.now()): SupplierList {
  return ledger.readSnapshot((): SupplierList => {
    const read: SupplierRead = ledger.supplierRead(null);
    const records: Map<string, RecordFacts> = recordsOf(read);
    const owners: Owners = ownersOf(ledger.supplierLinks());
    const report: BoardReport | null = needsBoard([...records.values()]) ? boardReport(ledger, NO_FILTERS, now) : null;
    const entriesOf: Map<string, BoardEntry[]> = new Map<string, BoardEntry[]>();
    for (const entry of report?.entries ?? []) {
      const list: BoardEntry[] = entriesOf.get(entry.beneficiaryId) ?? [];
      list.push(entry);
      entriesOf.set(entry.beneficiaryId, list);
    }
    const summaries: (SupplierSummary & { mustCaution: boolean })[] = [...records.values()].map(
      (facts: RecordFacts) => summaryOf(ledger, facts, entriesOf.get(facts.id) ?? [], owners, now),
    );
    summaries.sort(
      (a: SupplierSummary & { mustCaution: boolean }, b: SupplierSummary & { mustCaution: boolean }): number =>
        Number(b.groups.person > 0) - Number(a.groups.person > 0) ||
        Number(b.mustCaution) - Number(a.mustCaution) ||
        largest(b.atRisk) - largest(a.atRisk) ||
        supplierNameKey(a.name).localeCompare(supplierNameKey(b.name)) ||
        (a.key ?? "").localeCompare(b.key ?? ""),
    );
    return {
      generatedAt: new Date(now).toISOString(),
      suppliers: summaries.map(({ mustCaution, ...summary }: SupplierSummary & { mustCaution: boolean }): SupplierSummary => {
        void mustCaution;
        return summary;
      }),
    };
  });
}

// One supplier record, or null when the key breaks the pattern or nothing in the
// ledger names it.
export function supplierDetail(ledger: Ledger, key: string, now: number = Date.now()): SupplierDetail | null {
  if (!SUPPLIER_KEY_PATTERN.test(key)) {
    return null;
  }
  return ledger.readSnapshot((): SupplierDetail | null => {
    const read: SupplierRead = ledger.supplierRead(key);
    const facts: RecordFacts | undefined = recordsOf(read).get(key);
    if (facts === undefined) {
      return null;
    }
    const owners: Owners = ownersOf(ledger.supplierLinks());
    const accounts: Accounts = accountsOf(ledger, facts, owners);
    const report: BoardReport | null = needsBoard([facts]) ? boardReport(ledger, NO_FILTERS, now, key) : null;
    const entries: Map<string, BoardEntry> = new Map<string, BoardEntry>(
      (report?.entries ?? [])
        .filter((entry: BoardEntry): boolean => entry.kind === "invoice")
        .map((entry: BoardEntry): [string, BoardEntry] => [entry.invoiceId, entry]),
    );
    const attemptsBy: Map<string, SupplierAttempt[]> = new Map<string, SupplierAttempt[]>();
    for (const attempt of facts.attempts) {
      attemptsBy.set(attempt.invoiceId, [...(attemptsBy.get(attempt.invoiceId) ?? []), attempt]);
    }
    const payoutsBy: Map<string, SupplierPayout[]> = new Map<string, SupplierPayout[]>();
    for (const payout of facts.payouts) {
      payoutsBy.set(payout.invoiceId, [...(payoutsBy.get(payout.invoiceId) ?? []), payout]);
    }
    const openOnes: Obligation[] = facts.obligations.filter(open);
    const closed: Obligation[] = facts.obligations.filter((obligation: Obligation): boolean => !open(obligation));
    const listed: Obligation[] = [...openOnes, ...closed.slice(0, CLOSED_LISTED)];
    const run: SupplierRunRow | undefined = facts.runRows.find(
      (row: SupplierRunRow): boolean => waitingPayRow(row) && row.supplier !== null,
    );
    const names: string[] = namesOf(facts, run);
    const name: string = nameOf(facts);
    const sameNameIds: Set<string> = new Set<string>();
    for (const each of names) {
      for (const id of others(owners.byName.get(supplierNameKey(each)), key)) {
        sameNameIds.add(id);
      }
    }
    const sameName: Obligation[] = [...sameNameIds].flatMap((id: string): Obligation[] => ledger.obligationsFor(id));
    const phone: Obligation | undefined = facts.obligations.find(
      (obligation: Obligation): boolean => (obligation.supplierPhone ?? "").trim() !== "",
    );
    const stored: Accounts["stored"] = accounts.stored;
    return {
      generatedAt: new Date(now).toISOString(),
      key,
      name,
      names: names.filter((each: string): boolean => supplierNameKey(each) !== supplierNameKey(name)),
      phoneLast4: lastFourDigits(phone?.supplierPhone ?? null),
      domains: domainsOf(facts),
      currencies: [...new Set<string>(facts.obligations.map((obligation: Obligation): string => obligation.currency))]
        .filter((currency: string): boolean => CURRENCY.test(currency))
        .sort(),
      methods: [...new Set<string>(facts.obligations.map((obligation: Obligation): string => obligation.transferMethod))]
        .filter((method: string): boolean => METHOD.test(method))
        .sort(),
      related: relatedOf(facts, accounts, owners, names),
      recordStored:
        stored === null
          ? null
          : {
              at: isoOf(stored.at),
              invoiceId: stored.invoiceId,
              runId: stored.runId,
              account: accounts.labelOf.get(stored.key) ?? "",
            },
      cautions: cautionsOf(ledger, facts, accounts, owners, now),
      money: report?.totals ?? [],
      accounts: accounts.views,
      invoices: listed.map(
        (obligation: Obligation): InvoiceView =>
          invoiceView(
            facts,
            obligation,
            entries.get(obligation.invoiceId),
            attemptsBy.get(obligation.invoiceId) ?? [],
            payoutsBy.get(obligation.invoiceId) ?? [],
            accounts.labelOf,
          ),
      ),
      closed: {
        listed: Math.min(closed.length, CLOSED_LISTED),
        settled: closed.filter((obligation: Obligation): boolean => obligation.state === "settled").length,
        rejected: closed.filter((obligation: Obligation): boolean => obligation.state === "rejected").length,
      },
      bankChanges: bankChangesOf(ledger, facts, accounts),
      duplicates: duplicatesOf(facts, sameName),
      outages: outagesOf(ledger, facts),
      runs: runsOf(facts, accounts.labelOf),
      inbox: inboxOf(ledger, facts),
      drafts: draftsOf(facts),
    };
  });
}

export interface Resolved {
  key: string;
  // The invoice number the word was, when it was one and not a record.
  viaInvoice: string | null;
}

// A word as pnpm supplier and the MCP take it: a beneficiary id the ledger
// names, else an invoice number, which gives its invoice's record. Null for
// anything else.
export function resolveSupplier(ledger: Ledger, word: string): Resolved | null {
  if (!SUPPLIER_KEY_PATTERN.test(word)) {
    return null;
  }
  if (ledger.supplierLinks().names.some((entry: { beneficiaryId: string }): boolean => entry.beneficiaryId === word)) {
    return { key: word, viaInvoice: null };
  }
  const obligation: Obligation | undefined = ledger.obligation(word);
  if (obligation !== undefined) {
    return { key: obligation.beneficiaryId, viaInvoice: word };
  }
  const row: { beneficiaryId: string | null } | undefined = ledger.waitingRunRow(word);
  return row?.beneficiaryId === null || row === undefined ? null : { key: row.beneficiaryId, viaInvoice: word };
}

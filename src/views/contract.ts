// PayOnce's view contract: what the server, the MCP server and the CLI hand to
// whatever shows PayOnce to a person. It lives at src/views/contract.ts. The
// view builders in src/views/ return these types; HTTP sends them as JSON, MCP
// projects them (McpProjection below) and the CLI prints them. The page only
// renders them: it keeps no copy of a rule, a failure-code table or a wording.
//
// Conventions:
// - Every `...At` field is an ISO 8601 UTC string (Iso). Days are YYYY-MM-DD.
// - Every amount is a Money: minor units, a currency, and PayOnce's own text.
// - A field typed Theirs holds text PayOnce did not write (supplier names, email
//   text, typed names and notes, Airwallex messages, pay run cells). The page puts
//   it in text nodes through whyText, MCP wraps it as outside text, alerts defang
//   it. Every other string is PayOnce's own words or a value in a closed pattern.
// - "Can do and why not" is a Can: { allowed, why }. why is null when allowed.
// - Every action answers with the fresh view of what it changed and a Notice.
//
// The situation of a payment or a run, its reason and what a person can do are
// worked out once in the domain (domain/situation.ts, domain/reasons.ts), and
// their types are re-exported here unchanged, so no view defines them again.
// Types that carry over unchanged are imported by type only.

import type { ReasonView } from "../domain/reasons.js";
import type {
  Blocker,
  Can,
  IncidentBrief,
  PaymentState,
  QueueGroup,
  RequestState,
  RunPhase,
  RunRowState,
  RunSituation,
  Situation,
  Tone,
  WaitingOn,
  Why,
} from "../domain/situation.js";
import type { BreakKind } from "../recon/recon-match.js";
import type { BreakState } from "../store/recon-store.js";
import type { AuditExport, RunAuditExport } from "../store/audit-trail.js";
import type { MetricsReport } from "./metrics.js";

export type { ClauseCode, ReasonCode, ReasonFamily, ReasonView } from "../domain/reasons.js";
export type {
  Blocker,
  BlockerCode,
  Can,
  IncidentBrief,
  PaymentState,
  PersonAction,
  QueueGroup,
  RequestState,
  RunPhase,
  RunRowState,
  RunSituation,
  Situation,
  Tone,
  WaitingOn,
  Why,
} from "../domain/situation.js";

// ---------- primitives ----------

export type Iso = string;
export type Day = string;
export type InvoiceId = string;
// An Airwallex beneficiary id: the supplier record's key.
export type SupplierKey = string;
export type RunId = number;
export type RequestId = number;
export type UploadId = number;
export type DraftId = number;
export type OutageId = number;
// The bank's short reference, /^[A-Z0-9-]{1,30}$/.
export type Reference = string;
// Text PayOnce did not write. See the conventions above.
export type Theirs = string;
// A name a person typed, as personName records it. Text PayOnce did not write.
export type PersonName = Theirs;

export type TransferMethod = "LOCAL" | "SWIFT";
export type Origin = "payonce" | "outside" | "pay-run";

export interface Money {
  minor: number;
  currency: string;
  // formatMoney: "4,000.00 EUR", "−7.05 EUR".
  text: string;
  // Not exact: from an estimate or a quote, or a fee not read yet.
  estimated?: boolean;
}

// What a person is told after an action, as a toast.
export interface Notice {
  tone: "success" | "info" | "warning";
  text: string;
}

// Live work on an object: the agent or the sandbox bank is on it, or a payment
// is with the bank. The page polls every 1.5 s while either is true. HTTP only.
export interface Activity {
  busy: boolean;
  watching: boolean;
}

// An error any route answers with, as today's HttpError JSON plus a code.
export interface ApiError {
  error: string;
  code?: string;
  // Field-level problems for a form.
  fields?: Record<string, string>;
  // Extra facts some refusals carry today (draftId, runId, endedBy, retryAfterSeconds...).
  [extra: string]: unknown;
}

// ---------- shared pieces ----------

export interface FailureView {
  // The bank's or Airwallex's code, shown only in its own pattern.
  code: string;
  // One table for the whole product (domain/failure-codes.ts).
  words: string;
  resendable: boolean;
  railLevel: boolean;
  accountLevel: boolean;
}

export interface AccountView {
  // "COMMERZBANK AG ···3000", built by PayOnce from the record (bank name is Airwallex's).
  label: Theirs;
  ending: string | null;
}

export interface FxView {
  // "1 EUR = 1.119541 USD"
  rate: string;
  // "0.42% from mid-market 1.115"
  markup: string | null;
  takes: Money;
  delivers: Money;
  quoteId: string;
  validTo: Iso;
}

export interface ArrivalView {
  // The server's words (arrivalAdvice), unchanged.
  text: string;
  route: string;
  due: string | null;
  atRisk: boolean;
  sentToday: { text: string; atRisk: boolean } | null;
  note: string;
  latestDay: Day | null;
}

export interface Caution {
  code:
    | "below-floor"
    | "floor-unreadable"
    | "no-floor"
    | "same-account-failed"
    | "new-account"
    | "bank-details-question"
    | "outage"
    | "second-bill"
    | "asks-not-to-pay"
    | "domain"
    | "fx-quote-ends";
  text: string;
}

export interface SupplierBrief {
  key: SupplierKey | null;
  name: Theirs;
  account: AccountView | null;
  // Last four digits of the phone on file, never more.
  phoneEnding: string | null;
  phone: IncidentPhoneView;
  emailDomain: Theirs | null;
  cautions: { count: number; top: string | null };
}

// The phone on file as the callback and approval cards show it: where it came
// from and who put it there, a new number waiting for a second person (which
// blocks the callback form), and whether the number the latest request's
// callback was made on is still on file (null with no such request).
export interface IncidentPhoneView {
  onFile: PhoneOnFileView | null;
  pending: { ending: string | null; proposedBy: PersonName | null; proposedAt: Iso | null } | null;
  requestCallbackOnFile: boolean | null;
}

// ---------- approval requests ----------

export interface ApproverChoice {
  name: string;
  // In the currency the request's amount is paid from.
  limit: Money;
  // Passes checkSigner for this request now.
  canApprove: boolean;
  signed: boolean;
  // code: "barred" | "signed" | "over-limit" | "not-approver" | "policy-unreadable" | "expired" | "not-waiting"
  why: Why | null;
}

export interface Barred {
  name: PersonName;
  // code: "started" | "uploaded-run" | "recorded-callback" | "set-callback-phone"
  why: Why;
}

export interface CallbackEvidenceView {
  calledBy: PersonName;
  numberEnding: string | null;
  calledAt: Iso | null;
  spokeTo: Theirs;
  confirmed: Theirs;
}

export interface DuplicateView {
  invoiceId: InvoiceId;
  // Null when the invoice is no longer in the ledger.
  state: PaymentState | null;
  label: string;
  paidBy: Reference | null;
  sameAccount: boolean | null;
}

export interface TermsView {
  action: "replace" | "pay";
  // "Approve this replacement" / "Approve paying this held invoice".
  title: string;
  pay: Money;
  supplier: Theirs;
  account: AccountView;
  // payTo is the account on file when the request opened.
  accountOnFile: boolean;
  fx: FxView | null;
  feeEstimate: Money | null;
  // The terms' own reason, parsed. The stored text is in reason.text exactly.
  reason: ReasonView;
  original: { reference: Reference | null; stateLabel: string; failure: FailureView | null } | null;
  // emailEvidence, PayOnce's words.
  emails: string | null;
  duplicates: DuplicateView[];
  callback: CallbackEvidenceView | null;
  arrival: ArrivalView | null;
}

export interface RequestView {
  id: RequestId;
  state: RequestState;
  // "Waiting for signoffs (0 of 1)", "Replaced by request #12"...
  label: string;
  requestedAt: Iso | null;
  expiresAt: Iso | null;
  needed: number;
  // code from reasons.md section 5.1
  neededWhy: Why | null;
  signoffs: { name: PersonName; at: Iso }[];
  approvers: ApproverChoice[];
  barred: Barred[];
  terms: TermsView;
  replacedBy: RequestId | null;
}

// ---------- the payment page ----------

export interface PaymentFacts {
  invoiceId: InvoiceId;
  supplier: Theirs;
  supplierKey: SupplierKey | null;
  amount: Money;
  // The wallet it is paid from, when not its own currency's.
  wallet: string;
  crossCurrency: boolean;
  method: TransferMethod;
  origin: Origin;
  dueDate: Day | null;
  dueDatePassed: boolean;
  startedBy: PersonName | null;
  run: { id: RunId; line: number } | null;
}

export interface SummaryBullet {
  lead: "Happened" | "PayOnce did" | "Now" | "Supplier" | "Cash";
  text: string;
  // Invoice numbers and references in the text, for links.
  refs: { invoiceId?: InvoiceId; reference?: Reference }[];
}

export interface CoveredTransferView {
  transferId: string;
  reference: Reference;
  status: string | null;
  kind: "original" | "replacement";
  // coveredText
  text: string;
}

export interface NamingPayoutView {
  reference: Reference;
  delivered: Money | null;
  ending: string | null;
  checked: boolean;
  // namingText
  text: string;
}

interface OptionBase {
  title: string;
  // Each line a sentence: what happens if the person confirms.
  consequence: string[];
  can: Can;
  // The server's pick for this situation, listed first.
  suggested: boolean;
}

export interface ApproveOption extends OptionBase {
  kind: "approve";
  requestId: RequestId;
  approvers: ApproverChoice[];
}

export interface CallbackOption extends OptionBase {
  kind: "callback";
  phoneEnding: string | null;
  // The form needs Airwallex's record: GET /api/incidents/:id/bank-details.
  formPath: string;
}

export interface ClosePaidOption extends OptionBase {
  kind: "close-paid";
  paidBy: Reference | null;
  covers: CoveredTransferView[];
  namesOnly: NamingPayoutView[];
}

export interface CloseUnpaidOption extends OptionBase {
  kind: "close-unpaid";
  covers: CoveredTransferView[];
  // A held second bill: the invoices it duplicated, which get a line.
  secondBillOf: InvoiceId[];
  // The request this close withdraws, and who approved it, when one is open.
  withdraws: { requestId: RequestId; approvedBy: PersonName[] } | null;
}

export interface EndOutageOption extends OptionBase {
  kind: "end-outage";
  outageId: OutageId;
  rail: string;
  // Null: any named person may end it (no APPROVERS).
  enders: string[] | null;
  sends: { payments: number; total: Money }[];
}

export interface TraceOption extends OptionBase {
  kind: "trace";
  template: "bank-trace";
}

export type DecisionOption =
  | ApproveOption
  | CallbackOption
  | ClosePaidOption
  | CloseUnpaidOption
  | EndOutageOption
  | TraceOption;

export interface HeadroomLine {
  wallet: string;
  now: Money | null;
  after: Money | null;
  floor: Money | null;
  // "not-set" | "unreadable" | "setting"
  floorSource: "setting" | "not-set" | "unreadable";
}

export interface DecisionPanel {
  // Null on a closed payment.
  open: {
    request: RequestView | null;
    cautions: Caution[];
    options: DecisionOption[];
    headroom: HeadroomLine | null;
  } | null;
  closed: { kind: "paid" | "unpaid"; by: PersonName | null; at: Iso | null; note: Theirs | null } | null;
  // Always allowed on an open payment.
  checkNow: Can;
}

export type TransferState =
  | "being-sent"
  | "with-bank"
  | "paid"
  | "failed"
  | "refused"
  | "never-sent"
  | "unknown-status";

export interface TransferView {
  kind: "original" | "replacement" | "outside-payout" | "unrecognised";
  reference: Reference | null;
  state: TransferState;
  // "Failed: channel timeout", "With the bank, due 14:32"...
  stateLabel: string;
  tone: Tone;
  failure: FailureView | null;
  took: Money | null;
  fee: Money | null;
  sentAt: Iso | null;
  deadlineAt: Iso | null;
  pastDeadline: boolean;
  account: (AccountView & { check: "matches" | "misdirected" | "not-kept" | "no-details" | "outside" }) | null;
  onRequest: { id: RequestId; approvedBy: PersonName[] } | null;
  fx: FxView | null;
  rateMismatch: boolean;
  foundLateAt: Iso | null;
  // For an outside payout: whether it pays this payment (payoutVerdict).
  pays: boolean | null;
  arrival: ArrivalView | null;
  details: { transferId: string | null; requestId: string | null; bankStatus: string | null; createdAt: Iso | null };
}

export interface EmailView {
  from: Theirs;
  fromName: Theirs | null;
  replyTo: Theirs[];
  subject: Theirs;
  body: Theirs;
  styleText: Theirs | null;
  attachments: { name: Theirs; type: Theirs; bytes: number }[];
  notes: string[];
  partial: boolean;
  senderMatches: boolean;
  uploadedBy: PersonName | null;
  uploadId: UploadId | null;
}

export interface EmailsTab {
  count: number;
  findings: {
    summary: string;
    claimsNonReceipt: boolean;
    asksForNewBankDetails: boolean;
    asksNotToPay: boolean;
    readBy: string | null;
  } | null;
  unread: { count: number; text: string } | null;
  senderWarnings: string[];
  emails: EmailView[];
}

export type DraftTemplate = "payment-sent" | "replacement-sent" | "checking" | "callback-notice" | "bank-trace" | "refund-trace";

export interface DraftOfferView {
  template: DraftTemplate;
  label: string;
  audience: "supplier" | "bank";
  suggested: boolean;
  why: string | null;
}

export interface DraftView {
  id: DraftId;
  template: string;
  label: string;
  audience: "supplier" | "bank";
  subject: string;
  body: string;
  state: "draft" | "copied" | "sent" | "dismissed";
  stateLabel: string;
  createdBy: PersonName;
  createdAt: Iso;
  copiedBy: PersonName | null;
  copiedAt: Iso | null;
  sentBy: PersonName | null;
  sentAt: Iso | null;
  dismissedBy: PersonName | null;
  dismissedAt: Iso | null;
  dismissNote: Theirs | null;
  intact: boolean;
  changed: string[] | null;
  noLongerFits: string | null;
  can: { copy: Can; markSent: Can; dismiss: Can };
}

export interface MessagesTab {
  drafts: DraftView[];
  offers: DraftOfferView[];
  withheld: DraftOfferView[];
  notOffered: { label: string; why: string }[];
}

export type EventKind =
  | "payment"
  | "email"
  | "bank"
  | "decision"
  | "approval"
  | "warning"
  | "lock"
  | "closed"
  | "callback"
  | "error"
  | "outbox"
  | "outage"
  | "contact";

export interface TimelineLine {
  id: number;
  at: Iso;
  kind: EventKind;
  // "Decision", "Bank", "Supplier email", "Duplicate lock"...
  kindLabel: string;
  // For decision lines, the chip read from the stored prefix.
  lead: "Sent to a person" | "Waiting" | "Resending" | "Closing" | null;
  // The stored line, less the decision prefix when lead is set. Can quote names
  // and notes people typed, so the page treats it as Theirs.
  text: Theirs;
  topic: string | null;
  // Collapsed by default: errors, superseded standing lines, arrival and cost lines.
  system: boolean;
  // Identical consecutive error lines folded into this one.
  repeat: { count: number; firstAt: Iso; lastAt: Iso } | null;
}

export interface TimelineView {
  // Newest first.
  lines: TimelineLine[];
  total: number;
  systemCount: number;
}

export interface AuditLineView {
  lines: number;
  intact: boolean;
  problem: string | null;
  // Reconciliation's chain has a JSON export only.
  exports: { json: string; csv: string | null };
}

export interface IncidentView {
  view: "incident";
  generatedAt: Iso;
  payment: PaymentFacts;
  situation: Situation;
  incident: IncidentBrief | null;
  summary: SummaryBullet[];
  decision: DecisionPanel;
  transfers: TransferView[];
  emails: EmailsTab;
  messages: MessagesTab;
  timeline: TimelineView;
  audit: AuditLineView;
  supplier: SupplierBrief;
  money: {
    amount: Money;
    fromWallet: Money | null;
    feesKept: Money[];
    headroom: HeadroomLine | null;
  };
  related: {
    secondBills: DuplicateView[];
    inbox: { offered: number; named: number };
    outage: { id: OutageId; rail: string } | null;
  };
  askWhy: Can;
  activity: Activity;
}

// ---------- lists: Home, Incidents, Search ----------

export type RowActionKind =
  | "approve"
  | "callback"
  | "close-paid"
  | "close-unpaid"
  | "end-outage"
  | "trace"
  | "review"
  | "open";

export interface RowTag {
  code: "outage" | "inbox-offered" | "inbox-named" | "past-deadline" | "pay-run" | "outside" | "blocked" | "cross-currency";
  text: string;
}

export interface IncidentRow {
  invoiceId: InvoiceId;
  supplier: Theirs;
  supplierKey: SupplierKey | null;
  amount: Money;
  // What leaves the wallet, when it differs from amount (cross-currency, fees).
  fromWallet: Money | null;
  origin: Origin;
  runId: RunId | null;
  dueDate: Day | null;
  situation: Situation;
  incident: IncidentBrief | null;
  // Per wallet: promised + waiting + with the bank, amount and fee (board atRisk).
  inPlay: Money[];
  waitingSince: Iso | null;
  tags: RowTag[];
  primary: { kind: RowActionKind; label: string; href: string } | null;
  activity: Activity;
}

// A pay run in a queue, as one row.
export interface RunRowItem {
  runId: RunId;
  fileName: Theirs;
  state: RunPhase;
  label: string;
  next: string;
  tone: Tone;
  payments: number;
  totals: Money[];
  waitingSince: Iso;
  primary: { kind: "approve" | "recheck" | "end-outage" | "open"; label: string; href: string };
}

export type QueueItem = { type: "payment"; row: IncidentRow } | { type: "run"; row: RunRowItem };

export interface WalletTotals {
  wallet: string;
  promised: Money;
  waitingOnPeople: Money;
  pausedByOutage: Money;
  runWaiting: Money;
  withBank: Money;
  estimated: boolean;
  feeUnknown: number;
}

export interface Tile {
  key: "needs-you" | "with-bank" | "payonce" | "paid-week";
  label: string;
  value: string;
  sub: string | null;
  href: string;
}

export interface ReadinessItem {
  key: "airwallex" | "approvers" | "floors" | "alerts" | "reader";
  label: string;
  state: "ok" | "missing" | "warning" | "optional";
  text: string;
  href: string;
}

export interface HomeView {
  view: "home";
  generatedAt: Iso;
  tiles: Tile[];
  // Set when ?me= names someone: requests that person can sign now.
  waitingForMe: QueueItem[] | null;
  needsYou: QueueItem[];
  inbox: { waiting: number; suggested: number };
  handling: { count: number; blocked: number; rows: IncidentRow[] };
  // Ledger empty: the readiness checklist and first actions.
  firstRun: { readiness: ReadinessItem[] } | null;
  lastClosedAt: Iso | null;
}

export type IncidentScope = QueueGroup | "all";

export interface IncidentsQuery {
  scope: IncidentScope;
  currency: string | null;
  origin: Origin | null;
  // Only payments and runs this name can approve now.
  me: string | null;
  // Include payments that never had an incident.
  clean: boolean;
  q: string | null;
}

export interface OutageStrip {
  id: OutageId;
  rail: string;
  pausing: number;
  sendsText: string;
}

export interface IncidentsView {
  view: "incidents";
  generatedAt: Iso;
  query: IncidentsQuery;
  scopes: { scope: IncidentScope; label: string; count: number }[];
  wallets: string[];
  outages: OutageStrip[];
  totals: WalletTotals[];
  // Ranked: group order, the most money first, then the oldest.
  rows: IncidentRow[];
  // Payments in the ledger, closed included.
  ledgerCount: number;
}

export interface SearchView {
  view: "search";
  q: string;
  // An exact invoice number or bank reference: open it directly.
  exact: { href: string } | null;
  payments: { invoiceId: InvoiceId; supplier: Theirs; amount: Money; label: string; tone: Tone }[];
  suppliers: { key: SupplierKey; name: Theirs; hint: string }[];
  runs: { id: RunId; fileName: Theirs; label: string }[];
  emails: { id: UploadId; subject: Theirs; from: Theirs; label: string }[];
  transfers: { reference: Reference; invoiceId: InvoiceId; kind: string }[];
}

// ---------- New payment ----------

export interface BeneficiaryOption {
  key: SupplierKey;
  name: Theirs;
  nickname: Theirs | null;
  country: string | null;
  currency: string | null;
  methods: TransferMethod[];
  account: AccountView | null;
  // From the ledger.
  lastPaid: { at: Iso | null; reference: Reference | null; ending: string | null } | null;
  cautions: string[];
}

export interface BeneficiaryPickerView {
  view: "beneficiaries";
  q: string;
  options: BeneficiaryOption[];
  // Airwallex could not be read: the page shows it and a retry.
  problem: Why | null;
  readAt: Iso | null;
}

export interface NewPaymentInput {
  supplierKey: SupplierKey;
  // Empty: PayOnce makes one (INV-NNNNNN).
  invoiceId: string;
  // Major units as typed, "4000.00", parsed with toMinor.
  amount: string;
  currency: string;
  // The wallet to pay from; equal to currency for a same-currency payment.
  wallet: string;
  method: TransferMethod;
  dueDate: Day | null;
  startedBy: string;
  // Sandbox only: the bank outcome the simulator plays on the first transfer.
  sandbox?: { bankOutcome: string } | null;
}

export interface PaymentCheckView {
  view: "payment-check";
  // Field problems as the create route would answer them.
  fields: Record<string, string>;
  // "send" or the hold it will hit, in PayOnce's words.
  outcome:
    | { kind: "send"; text: string }
    | { kind: "hold"; reason: ReasonView; text: string }
    | { kind: "paused"; outageId: OutageId; text: string }
    | { kind: "unknown"; text: string };
  approvers: { needed: number; why: Why | null } | null;
  headroom: HeadroomLine | null;
  warnings: string[];
  sandbox: { bankOutcome: string; text: string } | null;
}

export interface PaymentCreated {
  invoiceId: InvoiceId;
  view: IncidentView;
  notice: Notice;
}

// ---------- Inbox ----------

export type UploadState = "waiting" | "delivered" | "dismissed";

export interface UploadRow {
  id: UploadId;
  from: Theirs;
  fromName: Theirs | null;
  subject: Theirs;
  uploadedBy: PersonName;
  uploadedAt: Iso;
  state: UploadState;
  label: string;
  partial: boolean;
  suggested: InvoiceId | null;
  invoiceId: InvoiceId | null;
}

export interface InboxListView {
  view: "inbox";
  tabs: { state: UploadState; label: string; count: number }[];
  rows: UploadRow[];
  limits: { maxEmailBytes: number; readerIsModel: boolean; readerNotice: string | null };
}

export interface CandidateView {
  invoiceId: InvoiceId;
  supplier: Theirs;
  amount: Money;
  situation: { label: string; tone: Tone };
  where: "subject" | "body" | "attachment";
  exact: boolean;
  amongDigits: boolean;
  senderOnFile: boolean;
  senderText: string;
  why: string;
}

export interface InboxItemView {
  view: "inbox-item";
  upload: UploadRow & {
    replyTo: Theirs[];
    dateAsWritten: Theirs;
    body: Theirs;
    styleText: Theirs | null;
    attachments: { name: Theirs; type: Theirs; bytes: number }[];
    notes: string[];
    messageId: Theirs | null;
    deliveredBy: PersonName | null;
    deliveredAt: Iso | null;
    dismissedBy: PersonName | null;
    dismissedAt: Iso | null;
    dismissNote: Theirs | null;
  };
  candidates: CandidateView[];
  suggested: InvoiceId | null;
  sameMessageId: UploadId[];
  // After delivery: what happens next.
  afterDelivery: string | null;
  can: { deliver: Can; dismiss: Can };
}

// ---------- Pay runs ----------

export interface RunListRow {
  id: RunId;
  fileName: Theirs;
  uploadedBy: PersonName;
  uploadedAt: Iso;
  situation: RunSituation;
  counts: { pay: number; held: number; skip: number };
  totals: Money[];
  activity: Activity;
}

export interface RunsView {
  view: "runs";
  rows: RunListRow[];
  // Only one run waits at a time.
  waiting: RunId | null;
  upload: { maxRows: number; maxChars: number; columns: { name: string; required: boolean; note: string }[] };
}

export interface RunRowView {
  line: number;
  invoiceId: InvoiceId | null;
  supplier: Theirs | null;
  payee: Theirs | null;
  amount: Money | null;
  method: TransferMethod | null;
  account: AccountView | null;
  dueDate: Day | null;
  arrival: ArrivalView | null;
  feeSeen: string | null;
  state: RunRowState;
  label: string;
  newPayee: boolean;
  callbackVerified: boolean;
  secondBillOf: InvoiceId[];
  skipReasons: { code: string; text: Theirs }[];
  // A released row's payment.
  payment: { situation: { label: string; tone: Tone }; activity: Activity } | null;
  // No sandbox_outcome here: it shows only in the simulator's log.
}

export interface RunTermsView {
  payments: number;
  totals: { total: Money; payments: number; floor: Money | null }[];
  largest: Money;
  newPayees: number[];
  callbackRows: number[];
  domains: { line: number; domain: Theirs; caution: boolean; text: string }[];
  arrivals: { line: number; invoiceId: InvoiceId; advice: ArrivalView }[];
}

export interface RunRequestView {
  id: RequestId;
  state: RequestState;
  label: string;
  requestedAt: Iso;
  expiresAt: Iso;
  replacedBy: RequestId | null;
  needed: number;
  neededWhy: Why | null;
  signoffs: { name: PersonName; at: Iso }[];
  approvers: ApproverChoice[];
  barred: Barred[];
  terms: RunTermsView;
}

export type RunDecisionOption =
  | (OptionBase & { kind: "approve"; requestId: RequestId; approvers: ApproverChoice[] })
  | (OptionBase & { kind: "recheck" })
  | (OptionBase & { kind: "cancel" })
  | EndOutageOption;

export interface RunCashView {
  currency: string;
  balance: Money | null;
  committedElsewhere: Money;
  rows: Money;
  fees: Money;
  left: Money | null;
  floor: Money | null;
  short: Money | null;
}

export interface RunView {
  view: "run";
  generatedAt: Iso;
  run: {
    id: RunId;
    fileName: Theirs;
    fileHash: string;
    uploadedBy: PersonName;
    uploadedAt: Iso;
    checkedAt: Iso;
    releasedAt: Iso | null;
    cancelledBy: PersonName | null;
    cancelNote: Theirs | null;
  };
  situation: RunSituation;
  counts: { pay: number; held: number; skip: number };
  decision: {
    request: RunRequestView | null;
    cautions: Caution[];
    options: RunDecisionOption[];
  } | null;
  rows: RunRowView[];
  skippedSummary: { code: string; label: string; count: number }[];
  cash: { checkedAt: Iso; currencies: RunCashView[] };
  timeline: TimelineView;
  audit: AuditLineView;
  activity: Activity;
}

// ---------- Suppliers ----------

export interface SupplierCaution {
  code: string;
  level: "caution" | "info";
  text: string;
  invoices: InvoiceId[];
  accounts: string[];
  since: Iso | null;
}

export interface SupplierListRow {
  key: SupplierKey | null;
  name: Theirs;
  // "US · Local · ···6789", tells same-named records apart.
  hint: string;
  sameName: number;
  country: string | null;
  currencies: string[];
  methods: TransferMethod[];
  accountEnding: string | null;
  payments: { open: number; total: number };
  cautions: { code: string; text: string }[];
}

export interface SuppliersView {
  view: "suppliers";
  rows: SupplierListRow[];
}

// The record's phone on file, by its last four digits only. GET
// /api/suppliers/:key/contact gives the full number. removed: two people took it
// off file, so none is on file. originText is PayOnce's words for a number no
// person put on file, "" for one two people did. changed: it replaced another
// number in the last 7 days, with PayOnce's warning.
export interface PhoneOnFileView {
  contactId: number;
  ending: string | null;
  removed: boolean;
  origin: "person" | "scenario" | "migrated";
  originText: string;
  since: Iso | null;
  proposedBy: PersonName | null;
  // "supplier's contract", "supplier's website", "call to a known number", "in person", "other source".
  proposedSource: string | null;
  confirmedBy: PersonName | null;
  confirmedSource: string | null;
  replacedEnding: string | null;
  changed: { text: string } | null;
}

// A new number waiting for a second person, by its ending only, so whoever
// confirms it types it from their own source. seenInEmails and seenFlagged count
// the supplier emails on file that hold its digits, and those from senders the
// check flags.
export interface PhoneProposalView {
  contactId: number;
  ending: string | null;
  removal: boolean;
  replacesEnding: string | null;
  proposedBy: PersonName | null;
  proposedAt: Iso | null;
  source: string | null;
  note: PersonName;
  seenInEmails: number;
  seenFlagged: number;
  lapsesAt: Iso | null;
  lapsed: boolean;
}

export interface PhoneVersionView {
  contactId: number;
  ending: string | null;
  state: "proposed" | "on_file" | "replaced" | "withdrawn" | "lapsed";
  origin: "person" | "scenario" | "migrated";
  proposedBy: PersonName | null;
  proposedAt: Iso | null;
  confirmedBy: PersonName | null;
  confirmedAt: Iso | null;
  closedBy: PersonName | null;
  closedAt: Iso | null;
}

// The supplier's contact on file: the phone, which two people put there or
// change (supplier-contacts.md), and the email domains the payments give.
export interface SupplierContactView {
  phoneEnding: string | null;
  // The payments that give each domain, and the first and newest of them.
  emailDomains: { domain: Theirs; payments: number; first: InvoiceId; newest: InvoiceId }[];
  // Who confirmed the phone on file, and when.
  changedBy: PersonName | null;
  changedAt: Iso | null;
  // A change waiting for a second person, by field.
  pending: { field: "phone" | "domain"; ending: string | null; proposedBy: PersonName; proposedAt: Iso }[] | null;
  // propose, confirm and withdraw.
  actions: Record<string, Can>;
  phone: PhoneOnFileView | null;
  proposal: PhoneProposalView | null;
  // Every other version, newest first.
  history: PhoneVersionView[];
  // Who proposed or confirmed the number on file, and so may not record a callback on it.
  callbackBarred: PersonName[];
  // Where a number may come from, in PayOnce's words.
  notice: string;
}

// GET /api/suppliers/:key/contact: the phone on file in full, which no list or
// view gives. Never in MCP. A waiting proposal stays by its ending only.
export interface SupplierContactDetail {
  view: "supplier-contact";
  key: SupplierKey;
  phone: (PhoneOnFileView & { value: string }) | null;
  proposal: PhoneProposalView | null;
  history: PhoneVersionView[];
  notice: string;
}

export interface SupplierAccountView extends AccountView {
  // A, B, C on this page, in the order first seen.
  letter: string;
  seenAs: ("decided" | "sent" | "approval" | "pay-run" | "callback" | "before-callback" | "outside")[];
  firstSeen: Iso | null;
  lastSeen: Iso | null;
  lastPaid: { reference: Reference | null } | null;
  verifiedBy: { callbackId: number; invoiceId: InvoiceId; calledBy: PersonName; calledAt: Iso | null } | null;
  barred: PersonName[];
  alsoOn: SupplierKey[];
}

export interface SupplierView {
  view: "supplier";
  generatedAt: Iso;
  key: SupplierKey;
  name: Theirs;
  otherNames: Theirs[];
  hint: string;
  cautions: SupplierCaution[];
  contact: SupplierContactView;
  accounts: SupplierAccountView[];
  payments: { open: IncidentRow[]; closed: { paid: number; unpaid: number; listed: IncidentRow[] } };
  callbacks: { id: number; invoiceId: InvoiceId; calledBy: PersonName; numberEnding: string | null; calledAt: Iso | null; from: string | null; to: string | null; state: string }[];
  secondBills: { kind: "same-bill" | "same-number"; invoices: DuplicateView[] }[];
  runRows: { runId: RunId; line: number; invoiceId: InvoiceId | null; label: string }[];
  inbox: { uploadId: UploadId; invoices: InvoiceId[]; suggested: boolean }[];
  drafts: { id: DraftId; invoiceId: InvoiceId; label: string; stateLabel: string }[];
  outages: { active: OutageStrip[]; failures: { reference: Reference | null; failure: FailureView | null; at: Iso | null; outageId: OutageId | null }[] };
  related: { key: SupplierKey; name: Theirs; why: ("same-name" | "same-account")[] }[];
  money: WalletTotals[];
  can: { newPayment: Can };
}

// ---------- Treasury ----------

export type CashLineKind =
  | "sending"
  | "approved"
  | "pay-run"
  | "awaiting-approval"
  | "awaiting-person"
  | "waiting-outage"
  | "with-bank"
  | "outside"
  | "fee-lost";

export interface CashWorksheetGroup {
  kind: CashLineKind;
  // "Being sent", "Approved", "Pay run rows", "Waiting for approval", "Waiting on a decision",
  // "Paused by an outage", "With the bank", "Outside payouts with the bank", "Fees kept on failed transfers"
  label: string;
  bucket: "promised" | "waiting-on-people" | "with-bank" | "fees-kept";
  total: Money;
  feeUnknown: number;
  lines: { invoiceId: InvoiceId; runId: RunId | null; reference: Reference | null; amount: Money; fee: Money | null }[];
}

export interface WalletCashView {
  wallet: string;
  available: Money | null;
  floor: { amount: Money | null; source: "setting" | "not-set" | "unreadable"; text: string };
  promised: Money;
  waitingOnPeople: Money;
  withBank: Money;
  feesKept: Money;
  headroom: Money | null;
  headroomIfApproved: Money | null;
  tone: "ok" | "low" | "below";
  invoiceFloors: { invoiceId: InvoiceId; floor: Money; text: string }[];
  worksheet: CashWorksheetGroup[];
}

export interface CashView {
  view: "cash";
  generatedAt: Iso;
  balances: { readAt: Iso | null; refreshing: boolean; problem: { text: string; since: Iso } | null };
  checksLastRanAt: Iso | null;
  floorsProblem: string | null;
  wallets: WalletCashView[];
}

export interface BreakItemView {
  id: number;
  kind: BreakKind;
  label: string;
  text: string;
  currency: string | null;
  invoiceId: InvoiceId | null;
  reference: Reference | null;
  fingerprint: string;
  state: BreakState;
  clearsByItself: boolean;
  foundAt: Iso;
  openedAt: Iso | null;
  explainedBy: PersonName | null;
  explainedAt: Iso | null;
  note: Theirs | null;
}

export interface ReconView {
  view: "reconciliation";
  lastCheck: { at: Iso; ok: boolean; problem: string | null } | null;
  nextCheckAt: Iso | null;
  everyMinutes: number | null;
  running: boolean;
  needsPerson: { kind: BreakKind; label: string; action: string; count: number; items: BreakItemView[] }[];
  clearingByThemselves: { kind: BreakKind; label: string; count: number }[];
  waiting: { text: string; currency: string | null; dueAt: Iso | null }[];
  wallets: { currency: string; movements: number; addsUp: boolean; endsAtBalance: boolean; reserved: Money | null; idle: boolean; text: string }[];
  explained: BreakItemView[];
  audit: AuditLineView;
  can: { checkNow: Can; explain: Can };
}

export interface OutageCardView {
  id: OutageId;
  rail: string;
  state: "active" | "ended";
  text: string;
  codes: { code: string; label: string }[];
  declaredAt: Iso;
  payees: number;
  counted: { reference: Reference; invoiceId: InvoiceId | null; failure: FailureView | null; failedAt: Iso }[];
  pausing: { invoiceId: InvoiceId | null; runId: RunId | null; what: "original" | "replacement" | "approved" | "run" | "counted"; label: string }[];
  sends: { payments: number; total: Money }[];
  sendsText: string | null;
  endedAt: Iso | null;
  endedBy: PersonName | null;
  endNote: Theirs | null;
  end: Can & { enders: string[] | null };
}

export interface OutagesView {
  view: "outages";
  rule: { text: string; problem: string | null };
  active: OutageCardView[];
  ended: OutageCardView[];
}

// ---------- Reports ----------

export interface ReportsView {
  view: "reports";
  period: "7d" | "30d" | "all";
  tiles: { key: "first-time" | "recovered" | "needed-person" | "fees-kept" | "second-bills"; label: string; value: string; sub: string | null }[];
  // Unchanged from metrics.ts.
  metrics: MetricsReport;
}

export interface AuditCheckView {
  view: "audit";
  checkedAt: Iso;
  intact: boolean;
  invoices: { chains: number; lines: number; broken: InvoiceId[]; runningHash: "matches" | "does not match" | "missing" | "started again" };
  runs: { chains: number; lines: number; broken: RunId[]; runningHash: "matches" | "does not match" | "missing" | "started again" };
  recon: { lines: number; intact: boolean; problem: string | null };
  problems: string[];
  exportPath: string;
}

// ---------- Settings and status ----------

export interface SettingRow {
  label: string;
  value: string;
  // The .env variable, shown small. Never a secret's value.
  variable: string | null;
  problem: string | null;
}

export interface SettingsView {
  view: "settings";
  approvals: {
    approvers: { name: string; limit: Money }[];
    rows: SettingRow[];
    barredRule: string;
    closeRule: string;
    problem: string | null;
  };
  cash: { floors: { currency: string; floor: Money | null; text: string }[]; rows: SettingRow[] };
  bankDeadlines: SettingRow[];
  outages: SettingRow[];
  alerts: {
    on: boolean;
    format: "slack" | "discord" | null;
    host: string | null;
    test: boolean;
    problem: string | null;
    stopped: string | null;
    recent: { id: number; kind: string; title: string; state: string; tries: number; lastError: string | null; createdAt: Iso; sentAt: Iso | null }[];
  };
  reader: { name: string; isModel: boolean; notice: string | null; askWhy: { on: boolean; models: string; perMinute: number; perDay: number } };
  // Null outside pnpm ui, which alone holds the client and its timers.
  airwallex: {
    host: string;
    offline: boolean;
    connection: AirwallexHealth;
    webhooks: { on: boolean; host: string | null };
    checksEverySeconds: number;
    listingEverySeconds: number;
    reconEveryMinutes: number | null;
  } | null;
  people: { noLogin: string; names: string[] };
  // The one failure-code table, for any client that needs words for a code.
  failureCodes: { code: string; words: string; resendable: boolean; railLevel: boolean; accountLevel: boolean }[];
  limits: { maxEmailBytes: number; maxRunRows: number; maxRunFileChars: number };
}

export interface AirwallexHealth {
  state: "ok" | "unreachable" | "error" | "unknown";
  lastOkAt: Iso | null;
  failingSince: Iso | null;
  // PayOnce's words; the raw message stays in a details disclosure.
  text: string;
  detail: Theirs | null;
}

export interface StatusView {
  view: "status";
  generatedAt: Iso;
  chip: { tone: "ok" | "warning" | "danger" | "starting"; label: string };
  banners: { code: "audit" | "airwallex" | "outage" | "alerts"; tone: "warning" | "danger"; text: string; href: string }[];
  airwallex: AirwallexHealth;
  outages: OutageStrip[];
  alerts: { on: boolean; text: string; lastSentAt: Iso | null };
  audit: { intact: boolean; checkedAt: Iso | null };
  recon: { lastCheckAt: Iso | null; needsPerson: number };
  reader: string;
  inbox: { waiting: number };
  runs: { needsApproval: number };
}

// ---------- Sandbox simulator ----------

export interface SandboxView {
  view: "sandbox";
  scenarios: { id: string; label: string }[];
  bankOutcomes: { id: string; label: string }[];
  emailThreads: { id: string; label: string }[];
  defaults: { scenario: string; bankOutcome: string; emails: string };
}

export interface ScenarioInput {
  scenario: string;
  bankOutcome: string;
  emails: string;
  invoiceId: string;
  dueDate: Day | null;
  startedBy: string;
}

export interface DuplicateLockResult {
  refused: boolean;
  // The stored timeline line (payAgain's message).
  text: string;
  view: IncidentView;
}

// ---------- action requests and responses ----------

// Every action response: the fresh view and a notice.
export interface Acted<V> {
  view: V;
  notice: Notice;
}

export interface ApproveInput {
  approver: string;
  // The request on screen, so nobody approves terms they did not see.
  approvalId: RequestId;
}

export interface CloseInput {
  closedBy: string;
  finding: string;
  // Transfer ids of the covered transfers the panel showed. Required while any is on file.
  covered: string[] | null;
  // Which option the person chose. The server checks it against closeKind and
  // refuses a mismatch (409), so a person never closes as paid what is unpaid.
  as: "paid" | "unpaid";
}

export interface CallbackInput {
  calledBy: string;
  numberCalled: string;
  calledAt: Iso;
  spokeTo: string;
  confirmed: string;
  details: Record<string, string>;
}

export interface BankDetailsForm {
  phoneOnFile: string | null;
  fields: { name: string; label: string; current: string }[];
  blocked: string | null;
  comparedSentAt: Iso | null;
}

export interface DraftInput {
  template: DraftTemplate;
  createdBy: string;
}

export interface DraftMoveInput {
  // copied: optional name; sent and dismissed: required.
  by: string | null;
  note?: string;
}

export interface UploadEmailInput {
  uploadedBy: string;
  source: "file" | "paste";
  fileName: string | null;
  // Strict base64 of the bytes.
  eml: string;
}

export interface UploadEmailResult {
  id: UploadId;
  view: InboxItemView;
  notice: Notice;
}

export interface DeliverInput {
  invoiceId: InvoiceId;
  deliveredBy: string;
}

export interface DismissUploadInput {
  dismissedBy: string;
  note: string;
}

export interface UploadRunInput {
  fileName: string;
  csv: string;
  uploadedBy: string;
}

export interface UploadRunRefusal extends ApiError {
  problems?: { line: number | null; text: string }[];
  runId?: RunId;
  rows?: RunRowView[];
}

export interface RunApproveInput {
  approver: string;
  approvalId: RequestId;
}

export interface RunCancelInput {
  cancelledBy: string;
  note: string;
}

export interface EndOutageInput {
  endedBy: string;
  note: string;
}

export interface EndOutageResult {
  view: OutagesView;
  invoices: InvoiceId[];
  runs: RunId[];
  notice: Notice;
}

export interface ExplainInput {
  breaks: { id: number; fingerprint: string }[];
  explainedBy: string;
  note: string;
}

export interface AskWhyAnswer {
  explanation: string;
  notInFacts: string;
  cut: boolean;
  model: string;
  at: Iso;
  cached: boolean;
  asOf: { lines: number; lastEventId: number };
  legend: { alias: string; value: string }[];
  aliasesLeft: boolean;
}

// The full audit exports keep their shapes.
export type IncidentAuditExport = AuditExport;
export type RunAuditExportView = RunAuditExport;

// ---------- MCP and CLI ----------

// MCP tools answer the same views with three changes, applied by one projection
// (marked, in surfaces/mcp/mcp-text.ts) instead of hand copies:
// - activity is dropped, and so is askWhy, which needs settings MCP never loads;
// - every Theirs field is wrapped as { outsideText, from }, using the field list
//   the views declare (views/outside-fields.ts), not path rules;
// - long lists are capped: timeline to the newest `lines` lines (default 20),
//   rows of lists to `limit`.
// The MCP tools map to views: board -> IncidentsView (scope needs-you by default),
// incidents -> IncidentsView, incident -> IncidentView, cash -> CashView, runs ->
// RunsView, run -> RunView, audit -> AuditCheckView or the exports, outages ->
// OutagesView, suppliers -> SuppliersView, supplier -> SupplierView, metrics ->
// ReportsView. New tool: waiting_for(name) -> HomeView.waitingForMe ("what's
// waiting on me?").
export interface McpProjection {
  dropActivity: true;
  wrapTheirs: true;
  timelineLines: number;
}

// The CLI prints from the same views: pnpm board prints IncidentsView, pnpm
// approve prints IncidentView.decision.open.request, pnpm close prints its
// close options, pnpm payrun show prints RunView. Times in UTC (glossary.md).

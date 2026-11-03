const POLL_BUSY_MS = 1500;
const POLL_IDLE_MS = 5000;
// After an action the backend is about to work, so keep polling fast and follow the timeline.
const EXPECT_WORK_MS = 15000;
// A new incident may not be readable until the backend has written it.
const STARTING_GRACE_MS = 30000;
// Keep the previous incident on screen this long before showing a loading state.
const LOADING_DELAY_MS = 250;
const STARTED_BY_KEY = "payonce.startedBy";
// Which currencies of the cash panel are open, by currency code.
const CASH_OPEN_KEY = "payonce.cashOpen";
// Invoice numbers listed on one line of the cash panel before "and N more".
const CASH_INVOICES_SHOWN = 5;

const OBLIGATION_STATES = {
  open: { label: "Open", tone: "active" },
  escalated: { label: "Waiting on a person", tone: "waiting" },
  settled: { label: "Closed", tone: "paid" },
  rejected: { label: "Closed without paying", tone: "neutral" },
};

const ATTEMPT_KINDS = {
  original: "Original",
  replacement: "Replacement",
};

const ATTEMPT_STATES = {
  pending: { label: "Pending", tone: "neutral" },
  in_flight: { label: "In flight", tone: "active" },
  paid: { label: "Paid", tone: "paid" },
  failed: { label: "Failed", tone: "failed" },
};

const APPROVAL_STATES = {
  requested: { label: "Waiting for approval", tone: "waiting" },
  approved: { label: "Approved", tone: "active" },
  used: { label: "Used", tone: "paid" },
  void: { label: "Void", tone: "neutral" },
};

// A request still marked requested after its time has run out.
const EXPIRED_REQUEST = { label: "Expired", tone: "neutral" };

// How a pay run stands, as the server's runStatus names it.
const RUN_STATES = {
  "waiting-approval": { label: "Waiting for approval", tone: "waiting" },
  approved: { label: "Approved", tone: "active" },
  expired: { label: "Request expired", tone: "neutral" },
  "needs-check": { label: "Waiting on a person", tone: "waiting" },
  released: { label: "Released", tone: "paid" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

// A run's row before release: paid, held for a person when sent, skipped, or not released.
const ROW_ACTIONS = {
  pay: { label: "Pay", tone: "active" },
  held: { label: "Held when sent", tone: "waiting" },
  skip: { label: "Skipped", tone: "neutral" },
  dropped: { label: "Not released", tone: "failed" },
};

const EVENT_KINDS = {
  payment: "Payment",
  email: "Supplier email",
  bank: "Bank",
  decision: "Decision",
  approval: "Approval",
  callback: "Callback",
  warning: "Warning",
  lock: "Duplicate refused",
  closed: "Closed",
  error: "Error",
  outbox: "Message draft",
  outage: "Outage",
};

const OUTAGE_STATES = {
  active: { label: "Active", tone: "failed" },
  ended: { label: "Ended", tone: "neutral" },
};

// How long an ended outage stays on the page.
const OUTAGE_ENDED_SHOWN_MS = 24 * 60 * 60 * 1000;

const AUDIENCES = {
  supplier: "Supplier",
  bank: "Bank",
};

const DRAFT_STATES = {
  draft: { label: "Draft", tone: "waiting" },
  copied: { label: "Copied", tone: "active" },
  sent: { label: "Marked sent", tone: "paid" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};

// Airwallex failure codes seen in the sandbox, as listed in the repo's CLAUDE.md.
const FAILURE_CODES = {
  90101: "invalid account name or number",
  90701: "account closed",
  90802: "beneficiary bank returned",
  91001: "recall requested",
  91301: "duplication return",
  91401: "system error",
  91402: "channel timeout",
  99901: "unable to apply",
  99902: "other",
};

const SVG_NS = "http://www.w3.org/2000/svg";

function byId(id) {
  return document.getElementById(id);
}

const els = {
  form: byId("new-form"),
  scenarioField: byId("scenario-field"),
  scenario: byId("scenario"),
  bankOutcome: byId("bank-outcome"),
  emailThread: byId("email-thread"),
  invoiceNumber: byId("invoice-number"),
  dueDate: byId("due-date"),
  startedBy: byId("started-by"),
  startButton: byId("start-button"),
  newError: byId("new-error"),
  listError: byId("list-error"),
  listEmpty: byId("list-empty"),
  list: byId("incident-list"),
  sidebar: document.querySelector(".sidebar"),
  connection: byId("connection"),
  placeholder: byId("placeholder"),
  placeholderTitle: byId("placeholder-title"),
  placeholderText: byId("placeholder-text"),
  detail: byId("detail"),
  header: byId("detail-header"),
  timeline: byId("timeline"),
  timelineEmpty: byId("timeline-empty"),
  working: byId("working"),
  audit: byId("audit"),
  why: byId("why"),
  review: byId("review"),
  bankChange: byId("bank-change"),
  approval: byId("approval"),
  outbox: byId("outbox"),
  payments: byId("payments"),
  payAgain: byId("pay-again"),
  payAgainResult: byId("pay-again-result"),
  emails: byId("emails"),
  findings: byId("findings"),
  outages: byId("outages"),
  cash: byId("cash"),
  cashFresh: byId("cash-fresh"),
  cashProblem: byId("cash-problem"),
  cashCurrencies: byId("cash-currencies"),
  runForm: byId("run-form"),
  runFile: byId("run-file"),
  runUploadedBy: byId("run-uploaded-by"),
  runButton: byId("run-button"),
  runColumns: byId("run-columns"),
  runError: byId("run-error"),
  runsError: byId("runs-error"),
  runsEmpty: byId("runs-empty"),
  runList: byId("run-list"),
  runDetail: byId("run-detail"),
  runHeader: byId("run-header"),
  runRows: byId("run-rows"),
  runTimeline: byId("run-timeline"),
  runWorking: byId("run-working"),
  runAudit: byId("run-audit"),
  runApproval: byId("run-approval"),
  runCash: byId("run-cash"),
  runCancel: byId("run-cancel"),
  emailForm: byId("email-form"),
  emailFile: byId("email-file"),
  emailPaste: byId("email-paste"),
  emailUploadedBy: byId("email-uploaded-by"),
  emailButton: byId("email-button"),
  emailReader: byId("email-reader"),
  emailFreeTier: byId("email-free-tier"),
  emailError: byId("email-error"),
  inboxError: byId("inbox-error"),
  inboxEmpty: byId("inbox-empty"),
  inboxList: byId("inbox-list"),
  inboxDetail: byId("inbox-detail"),
  inboxHeader: byId("inbox-header"),
  inboxEmail: byId("inbox-email"),
  inboxMatch: byId("inbox-match"),
  inboxDismiss: byId("inbox-dismiss"),
  boardButton: byId("board-button"),
  reconButton: byId("recon-button"),
  metricsButton: byId("metrics-button"),
  metrics: byId("metrics"),
  metricsAsOf: byId("metrics-asof"),
  metricsError: byId("metrics-error"),
  metricsCards: byId("metrics-cards"),
  metricsPeriods: [...document.querySelectorAll("#metrics [data-period]")],
  recon: byId("recon"),
  reconCheck: byId("recon-check"),
  reconError: byId("recon-error"),
  reconLast: byId("recon-last"),
  reconWallets: byId("recon-wallets"),
  reconOpen: byId("recon-open"),
  reconWaiting: byId("recon-waiting"),
  reconExplained: byId("recon-explained"),
  reconAudit: byId("recon-audit"),
  board: byId("board"),
  boardOutages: byId("board-outages"),
  boardGroup: byId("board-group"),
  boardCurrency: byId("board-currency"),
  boardOrigin: byId("board-origin"),
  boardEmpty: byId("board-empty"),
  boardError: byId("board-error"),
  boardTotals: byId("board-totals"),
  boardGroups: byId("board-groups"),
  suppliersError: byId("suppliers-error"),
  suppliersEmpty: byId("suppliers-empty"),
  supplierList: byId("supplier-list"),
  supplierDetail: byId("supplier-detail"),
  supplierHeader: byId("supplier-header"),
  supplierCautions: byId("supplier-cautions"),
  supplierMoney: byId("supplier-money"),
  supplierAccounts: byId("supplier-accounts"),
  supplierInvoices: byId("supplier-invoices"),
  supplierChanges: byId("supplier-changes"),
  supplierEmails: byId("supplier-emails"),
  supplierMessages: byId("supplier-messages"),
  supplierDuplicates: byId("supplier-duplicates"),
  supplierOutages: byId("supplier-outages"),
  supplierRuns: byId("supplier-runs"),
};

const state = {
  options: null,
  optionsError: null,
  incidents: null,
  listError: null,
  selectedId: null,
  selectedAt: 0,
  revealSelected: false,
  detail: null,
  detailId: null,
  detailError: null,
  creating: false,
  createError: null,
  started: null,
  approving: false,
  approveError: null,
  closing: false,
  closeError: null,
  resuming: false,
  resumeError: null,
  payingAgain: false,
  // What the last pay again on screen came back with, kept with the invoice it was for.
  payAgainResult: null,
  fastUntil: 0,
  drafts: new Map(),
  closeDrafts: new Map(),
  // The callback form: which invoice has it open, what loading it returned, and drafts by invoice.
  bankOpen: null,
  bankLoad: null,
  bankFocusPending: null,
  bankSaving: false,
  bankError: null,
  bankDrafts: new Map(),
  // The cash panel as /api/cash last returned it, kept when a later load fails.
  cash: null,
  cashError: null,
  // Outages as /api/outages last returned them, the outage being ended, what that
  // came back with, and the names and notes typed on each end form.
  outages: null,
  outagesError: null,
  outageEnding: null,
  outageError: null,
  outageDrafts: new Map(),
  // Pay runs: the list, the run on screen, and what the last action on one came back with.
  runs: null,
  runsError: null,
  run: null,
  runId: null,
  runError: null,
  uploading: false,
  uploadError: null,
  runApproving: false,
  runApproveError: null,
  runChecking: false,
  runCheckError: null,
  runCancelling: false,
  runCancelError: null,
  runDrafts: new Map(),
  // The inbox: the list, the upload on screen, and what the last action on one came back with.
  inbox: null,
  inboxError: null,
  upload: null,
  uploadId: null,
  uploadLoadError: null,
  adding: false,
  addError: null,
  delivering: false,
  deliverError: null,
  // The match card's choices by upload, so a poll that rebuilds the card keeps them.
  matchDrafts: new Map(),
  dismissing: false,
  dismissError: null,
  // Messages to send: the name typed on the card, notes typed per draft, and the
  // action under way with any error it came back with.
  outboxName: null,
  outboxNotes: new Map(),
  outboxBusy: null,
  outboxError: null,
  // The incident board as /api/board last returned it, and the filters chosen, "" for all.
  board: null,
  boardError: null,
  boardFilters: { group: "", currency: "", origin: "" },
  // Ask why: per invoice, whether an ask is under way, the last answer and the last
  // error, for this page's session only. whyRetryAt is when the server's limit
  // lets the next ask start, for every invoice.
  why: new Map(),
  whyRetryAt: 0,
  // Suppliers: the list, fetched only while its sidebar section is on screen,
  // and the record on screen with the key and time of the last ask, so it is not
  // fetched more than once an idle poll.
  suppliers: null,
  suppliersError: null,
  suppliersShown: false,
  supplier: null,
  supplierKey: null,
  supplierError: null,
  supplierAsked: null,
  // Reconciliation as /api/reconcile last returned it, the check or explanation
  // under way and what it came back with, the forms' drafts by kind, and each
  // wallet's movements list.
  recon: null,
  reconError: null,
  reconChecking: false,
  reconCheckError: null,
  reconExplaining: null,
  reconExplainError: null,
  reconDrafts: new Map(),
  reconMovements: new Map(),
  // The metrics as /api/metrics last returned them, the period and time last
  // asked for, and the period picked, which is kept in memory only.
  metrics: null,
  metricsError: null,
  metricsAsked: null,
  metricsPeriod: "7d",
};

// "#recon" is the reconciliation view. An invoice called recon is written
// "#%72econ", so the two never meet.
const RECON_ID = "recon/";
// "#metrics" is the metrics view, and an invoice called metrics is "#%6Detrics".
const METRICS_ID = "metrics/";
// The metrics are read when the view opens and then every 30 seconds while it
// is on screen, not on every poll.
const METRICS_EVERY_MS = 30000;

// Signatures of what each section last drew, so an unchanged poll touches nothing.
const painted = new Map();
let approvalRefs = null;
let reviewRefs = null;
let bankRefs = null;
let headerRefs = null;

// ---------- helpers ----------

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (key === "class") {
      node.className = value;
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function setText(node, text) {
  const next = text ?? "";
  if (node.textContent !== next) {
    node.textContent = next;
  }
}

function setClass(node, className) {
  if (node.className !== className) {
    node.className = className;
  }
}

function showMessage(node, message) {
  const text = message ?? "";
  setText(node, text);
  node.hidden = text === "";
}

function changed(key, value) {
  const signature = JSON.stringify(value) ?? "";
  if (painted.get(key) === signature) {
    return false;
  }
  painted.set(key, signature);
  return true;
}

function badge(entry, fallback, large) {
  const tone = entry?.tone ?? "neutral";
  const size = large ? " badge--large" : "";
  return h("span", { class: `badge tone-${tone}${size}` }, entry?.label ?? humanize(fallback));
}

function badgeClass(entry) {
  return `badge tone-${entry?.tone ?? "neutral"}`;
}

function humanize(value) {
  const text = String(value ?? "")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sentence(value) {
  const text = String(value ?? "").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function withPeriod(value) {
  const text = String(value ?? "").trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function formatMoney(amountMinor, currency) {
  const code = String(currency ?? "").trim();
  if (typeof amountMinor !== "number" || !Number.isFinite(amountMinor)) {
    return code;
  }
  const whole = Math.round(Math.abs(amountMinor));
  const major = Math.floor(whole / 100).toLocaleString("en-US");
  const minor = String(whole % 100).padStart(2, "0");
  const sign = amountMinor < 0 ? "-" : "";
  return `${sign}${major}.${minor} ${code}`.trim();
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const minuteFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const zonedMinuteFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

const zonedDayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

// Null for anything that is not a time on file. new Date(null) is 1970, not an
// invalid date, so a balance never read would otherwise read as read at 1970.
function parseDate(value) {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Airwallex's short reference and failure code are kept as Airwallex sent them,
// so each is shown only in the form Airwallex gives it, and otherwise in
// PayOnce's words, as pnpm close and pnpm outage print them.
const REFERENCE = /^[A-Z0-9-]{1,30}$/;
const FAILURE_CODE = /^[A-Za-z0-9_]{1,40}$/;

function shownReference(value) {
  return typeof value === "string" && REFERENCE.test(value) ? value : "a reference PayOnce cannot show";
}

function failureText(code) {
  if (code === null || code === undefined || code === "") {
    return null;
  }
  if (!FAILURE_CODE.test(String(code))) {
    return "A failure code PayOnce cannot show";
  }
  const meaning = FAILURE_CODES[String(code)];
  return meaning === undefined ? `Failure code ${code}` : `Failure code ${code} (${meaning})`;
}

function shortId(value) {
  return String(value).slice(0, 8);
}

// The server treats names that differ only in case or spacing as one person.
function sameName(a, b) {
  const key = (name) => String(name).trim().replace(/\s+/g, " ").toLowerCase();
  return key(a) === key(b);
}

// A time on an outage card, in this browser's time zone like the rest of the
// page, with the zone named: "03:03 GMT+5:30", or "Oct 28, 21:33 GMT+5:30" on
// another day. Null when it cannot be read.
function zonedTime(value) {
  const date = parseDate(value);
  if (date === null) {
    return null;
  }
  const format = date.toDateString() === new Date().toDateString() ? zonedMinuteFormat : zonedDayFormat;
  return h("time", { datetime: date.toISOString(), title: dateTimeFormat.format(date) }, format.format(date));
}

function isToday(date) {
  return date.toDateString() === new Date().toDateString();
}

// A time as the page shows it: the time alone today, and with its day on any
// other day, so lines days apart never read as one day.
function stampText(date) {
  return isToday(date) ? timeFormat.format(date) : `${dayFormat.format(date)}, ${timeFormat.format(date)}`;
}

// A time to the minute, with its day when it is not today, so a time on another
// day never reads as one still to come today.
function minuteText(date) {
  return isToday(date) ? minuteFormat.format(date) : `${dayFormat.format(date)}, ${minuteFormat.format(date)}`;
}

function timeNode(value) {
  const date = parseDate(value);
  return date === null
    ? null
    : h(
        "time",
        { datetime: date.toISOString(), title: dateTimeFormat.format(date) },
        stampText(date),
      );
}

// Storage can be missing or refuse access. The page works the same without it.
function readStoredName() {
  try {
    return (window.localStorage.getItem(STARTED_BY_KEY) ?? "").slice(0, 80);
  } catch {
    return "";
  }
}

function storeName(value) {
  try {
    window.localStorage.setItem(STARTED_BY_KEY, value);
  } catch {
    // The name is not remembered.
  }
}

function readCashOpen() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(CASH_OPEN_KEY) ?? "{}");
    return stored !== null && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

function storeCashOpen(currency, open) {
  try {
    const stored = readCashOpen();
    stored[currency] = open;
    window.localStorage.setItem(CASH_OPEN_KEY, JSON.stringify(stored));
  } catch {
    // Which currencies are open is not remembered.
  }
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new Error("Cannot reach the server.");
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    // A refusal can quote a stored name, such as who delivered an email, so it is
    // cleaned the way names are.
    const said = data === null ? "" : whyText(data.error);
    const message = said !== "" ? said : `The server returned ${response.status}.`;
    // A refused upload says more than its message: the file's problems, or the run it names.
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  if (data === null || typeof data !== "object") {
    throw new Error("The server sent a reply this page could not read.");
  }
  return data;
}

function incidentPath(invoiceId) {
  return `/api/incidents/${encodeURIComponent(invoiceId)}`;
}

// ---------- loading and polling ----------

async function loadOptions() {
  if (state.options !== null) {
    return;
  }
  try {
    const options = await api("/api/options");
    const policy = options.approvalPolicy ?? {};
    state.options = {
      bankOutcomes: Array.isArray(options.bankOutcomes) ? options.bankOutcomes : [],
      emailThreads: Array.isArray(options.emailThreads) ? options.emailThreads : [],
      scenarios: Array.isArray(options.scenarios) ? options.scenarios : [],
      approvers: Array.isArray(options.approvers)
        ? options.approvers.filter(
            (approver) => typeof approver?.name === "string" && approver.name.trim() !== "",
          )
        : [],
      approvalProblem:
        typeof policy.problem === "string" && policy.problem.trim() !== ""
          ? policy.problem.trim()
          : null,
      runColumns: Array.isArray(options.runColumns) ? options.runColumns : [],
      maxRunRows: typeof options.maxRunRows === "number" ? options.maxRunRows : null,
      maxRunFileChars: typeof options.maxRunFileChars === "number" ? options.maxRunFileChars : null,
      maxEmailBytes: typeof options.maxEmailBytes === "number" ? options.maxEmailBytes : null,
      reader: typeof options.reader === "string" ? options.reader : "",
      readerIsModel: options.readerIsModel === true,
      explainer: {
        on: options.explainer?.on === true,
        models: typeof options.explainer?.models === "string" ? options.explainer.models : "",
        host: typeof options.explainer?.host === "string" ? options.explainer.host : "",
        googleFreeTier: options.explainer?.googleFreeTier === true,
      },
    };
    state.optionsError = null;
  } catch (error) {
    state.optionsError = `Could not load the options. ${error.message}`;
  }
}

async function loadList() {
  try {
    const data = await api("/api/incidents");
    state.incidents = Array.isArray(data.incidents) ? data.incidents : [];
    state.listError = null;
  } catch (error) {
    state.listError = `Could not refresh the list. ${error.message}`;
  }
}

async function loadCash() {
  try {
    const cash = await api("/api/cash");
    if (!Array.isArray(cash.currencies) || cash.airwallex === null || typeof cash.airwallex !== "object") {
      throw new Error("The server sent a cash position this page could not read.");
    }
    state.cash = cash;
    state.cashError = null;
  } catch (error) {
    state.cashError = `Could not refresh the cash position. ${error.message}`;
  }
}

async function loadOutages() {
  try {
    const report = await api("/api/outages");
    if (!Array.isArray(report.active) || !Array.isArray(report.recent)) {
      throw new Error("The server sent outages this page could not read.");
    }
    state.outages = report;
    state.outagesError = null;
  } catch (error) {
    state.outagesError = `Could not refresh the outages. ${error.message}`;
  }
}

// The board is loaded only while it is on screen.
async function loadBoard() {
  if (state.selectedId !== null) {
    return;
  }
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(state.boardFilters)) {
    if (value !== "") {
      params.set(name, value);
    }
  }
  const query = params.toString();
  try {
    const board = await api(query === "" ? "/api/board" : `/api/board?${query}`);
    if (!Array.isArray(board.entries) || !Array.isArray(board.totals) || !Array.isArray(board.groups)) {
      throw new Error("The server sent a board this page could not read.");
    }
    state.board = board;
    state.boardError = null;
  } catch (error) {
    state.boardError = `Could not refresh the board. ${error.message}`;
  }
}

async function loadRuns() {
  try {
    const data = await api("/api/runs");
    state.runs = Array.isArray(data.runs) ? data.runs : [];
    state.runsError = null;
  } catch (error) {
    state.runsError = `Could not refresh the pay runs. ${error.message}`;
  }
}

// "run/7" is pay run 7. A slash cannot be in an invoice number.
function runIdOf(id) {
  const match = /^run\/([1-9][0-9]{0,9})$/.exec(String(id ?? ""));
  return match === null ? null : Number(match[1]);
}

async function loadRunDetail(runId) {
  const id = state.selectedId;
  try {
    const detail = await api(`/api/runs/${runId}`);
    if (state.selectedId !== id) {
      return;
    }
    if (detail.run === null || typeof detail.run !== "object" || !Array.isArray(detail.rows)) {
      throw new Error("The server sent a pay run this page could not read.");
    }
    state.run = detail;
    state.runId = runId;
    state.runError = null;
  } catch (error) {
    if (state.selectedId === id) {
      state.runError = error.message;
    }
  }
}

async function loadInbox() {
  try {
    const data = await api("/api/inbox");
    state.inbox = Array.isArray(data.uploads) ? data.uploads : [];
    state.inboxError = null;
  } catch (error) {
    state.inboxError = `Could not refresh the inbox. ${error.message}`;
  }
}

// "inbox/12" is upload 12. A slash cannot be in an invoice number.
function inboxIdOf(id) {
  const match = /^inbox\/([1-9][0-9]{0,9})$/.exec(String(id ?? ""));
  return match === null ? null : Number(match[1]);
}

async function loadUploadDetail(uploadId) {
  const id = state.selectedId;
  try {
    const detail = await api(`/api/inbox/${uploadId}`);
    if (state.selectedId !== id) {
      return;
    }
    if (detail.upload === null || typeof detail.upload !== "object" || !Array.isArray(detail.candidates)) {
      throw new Error("The server sent an upload this page could not read.");
    }
    state.upload = detail;
    state.uploadId = uploadId;
    state.uploadLoadError = null;
  } catch (error) {
    if (state.selectedId === id) {
      state.uploadLoadError = error.message;
    }
  }
}

// Only while the Suppliers section of the sidebar is on screen, and then on
// every refresh, as the incident list is.
async function loadSuppliers() {
  if (!state.suppliersShown) {
    return;
  }
  try {
    const data = await api("/api/suppliers");
    state.suppliers = Array.isArray(data.suppliers) ? data.suppliers : [];
    state.suppliersError = null;
  } catch (error) {
    state.suppliersError = `Could not refresh the suppliers. ${error.message}`;
  }
}

// The Suppliers section coming on screen, as the sidebar scrolls or the window
// changes, loads the list at once. Without IntersectionObserver it counts as
// always shown.
function watchSupplierList() {
  const section = els.supplierList.closest("section") ?? els.supplierList;
  if (typeof IntersectionObserver !== "function") {
    state.suppliersShown = true;
    return;
  }
  new IntersectionObserver((entries) => {
    const shown = entries.some((entry) => entry.isIntersecting);
    const appeared = shown && !state.suppliersShown;
    state.suppliersShown = shown;
    if (appeared) {
      loadSuppliers().then(renderSupplierList);
    }
  }).observe(section);
}

// "supplier/6170b987-..." is a supplier record, by its beneficiary id. A slash
// cannot be in an invoice number.
function supplierKeyOf(id) {
  const match = /^supplier\/([A-Za-z0-9-]{1,64})$/.exec(String(id ?? ""));
  return match === null ? null : match[1];
}

// Only while the record is on screen, and at most once every idle poll.
async function loadSupplierDetail(key) {
  const id = state.selectedId;
  const asked = state.supplierAsked;
  if (asked !== null && asked.key === key && Date.now() - asked.at < POLL_IDLE_MS) {
    return;
  }
  state.supplierAsked = { key, at: Date.now() };
  try {
    const detail = await api(`/api/suppliers/${key}`);
    if (state.selectedId !== id) {
      return;
    }
    if (typeof detail.key !== "string" || !Array.isArray(detail.invoices) || !Array.isArray(detail.cautions)) {
      throw new Error("The server sent a supplier record this page could not read.");
    }
    state.supplier = detail;
    state.supplierKey = key;
    state.supplierError = null;
  } catch (error) {
    if (state.selectedId === id) {
      state.supplierError = error.message;
    }
  }
}

function currentSupplier() {
  const key = supplierKeyOf(state.selectedId);
  return key !== null && state.supplierKey === key ? state.supplier : null;
}

async function loadDetail() {
  const id = state.selectedId;
  if (id === null) {
    return;
  }
  const supplierKey = supplierKeyOf(id);
  if (supplierKey !== null) {
    await loadSupplierDetail(supplierKey);
    return;
  }
  const runId = runIdOf(id);
  if (runId !== null) {
    await loadRunDetail(runId);
    return;
  }
  const uploadId = inboxIdOf(id);
  if (uploadId !== null) {
    await loadUploadDetail(uploadId);
    return;
  }
  if (id === RECON_ID) {
    await loadRecon();
    return;
  }
  if (id === METRICS_ID) {
    await loadMetrics();
    return;
  }
  try {
    const detail = await api(incidentPath(id));
    if (state.selectedId !== id) {
      return;
    }
    if (detail.obligation === null || typeof detail.obligation !== "object") {
      throw new Error("The server sent an incident this page could not read.");
    }
    state.detail = detail;
    state.detailId = id;
    state.detailError = null;
  } catch (error) {
    if (state.selectedId === id) {
      state.detailError = error.message;
    }
  }
}

function currentDetail() {
  return state.detailId === state.selectedId ? state.detail : null;
}

function currentRun() {
  const runId = runIdOf(state.selectedId);
  return runId !== null && state.runId === runId ? state.run : null;
}

function isStarting(id) {
  return (
    state.started !== null &&
    state.started.id === id &&
    Date.now() - state.started.at < STARTING_GRACE_MS
  );
}

function expectsWork() {
  if (Date.now() < state.fastUntil) {
    return true;
  }
  const detail = currentDetail();
  if (detail === null && state.selectedId !== null && isStarting(state.selectedId)) {
    return true;
  }
  if (detail?.busy === true || detail?.watching === true) {
    return true;
  }
  const run = currentRun();
  if (run?.busy === true || run?.watching === true || run?.status === "approved") {
    return true;
  }
  if (state.selectedId === RECON_ID && state.recon?.running === true) {
    return true;
  }
  if ((state.runs ?? []).some((entry) => entry.busy === true || entry.watching === true)) {
    return true;
  }
  // A balance read under way shows up as soon as it lands, so an old read is not
  // left on screen for a whole idle poll.
  if (state.cash?.airwallex.refreshing === true) {
    return true;
  }
  // A payment with the bank can change at any moment, by webhook or status check.
  return (state.incidents ?? []).some(
    (incident) => incident.busy === true || incident.watching === true,
  );
}

let pollTimer = 0;
let refreshing = null;
let refreshAgain = false;

// One refresh runs at a time. A call made while one is running asks it to go round again.
function refresh() {
  if (refreshing !== null) {
    refreshAgain = true;
    return refreshing;
  }
  clearTimeout(pollTimer);
  refreshing = (async () => {
    do {
      refreshAgain = false;
      await Promise.all([
        loadOptions(),
        loadList(),
        loadRuns(),
        loadInbox(),
        loadDetail(),
        loadCash(),
        loadOutages(),
        loadBoard(),
        loadSuppliers(),
      ]);
      render();
    } while (refreshAgain);
  })().finally(() => {
    refreshing = null;
    pollTimer = setTimeout(refresh, expectsWork() ? POLL_BUSY_MS : POLL_IDLE_MS);
  });
  return refreshing;
}

// ---------- selection ----------

function idFromHash() {
  const raw = window.location.hash.slice(1);
  if (raw === "") {
    return null;
  }
  if (raw === "recon") {
    return RECON_ID;
  }
  if (raw === "metrics") {
    return METRICS_ID;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// reveal scrolls the sidebar to the incident picked once the list shows it.
function setSelected(id, reveal = true) {
  state.selectedId = id;
  state.selectedAt = Date.now();
  state.revealSelected = reveal && id !== null;
  state.detailError = null;
  state.approveError = null;
  state.closeError = null;
  state.resumeError = null;
  state.bankError = null;
  state.runError = null;
  state.runApproveError = null;
  state.runCheckError = null;
  state.runCancelError = null;
  state.uploadLoadError = null;
  state.deliverError = null;
  state.dismissError = null;
  // A record picked again is asked for at once.
  state.supplierError = null;
  state.supplierAsked = null;
  const hash =
    id === null
      ? ""
      : id === RECON_ID
        ? "#recon"
        : id === "recon"
          ? "#%72econ"
          : id === METRICS_ID
            ? "#metrics"
            : id === "metrics"
              ? "#%6Detrics"
              : runIdOf(id) !== null || inboxIdOf(id) !== null || supplierKeyOf(id) !== null
                ? `#${id}`
                : `#${encodeURIComponent(id)}`;
  if (window.location.hash !== hash) {
    window.history.replaceState(null, "", hash === "" ? window.location.pathname : hash);
  }
}

// Picking a view starts at its top, whether it was picked from the top bar, a
// list, a board entry or a link, so nobody lands partway down the new view.
function select(id, reveal = true) {
  if (id === state.selectedId) {
    return;
  }
  window.scrollTo(0, 0);
  if (id === null) {
    // The board is not loaded while it is off screen, so the one held is old.
    state.board = null;
    state.boardError = null;
  }
  setSelected(id, reveal);
  render();
  window.setTimeout(render, LOADING_DELAY_MS + 20);
  if (id === null && refreshing !== null) {
    // The refresh under way skipped the board, so it is loaded now, not after it.
    loadBoard().then(render);
  }
  refresh();
}

// ---------- new incident form ----------

function fillSelect(select, entries) {
  const previous = select.value;
  select.replaceChildren(
    ...entries.map((entry) => h("option", { value: entry.value }, entry.label)),
  );
  if (entries.some((entry) => entry.value === previous)) {
    select.value = previous;
  }
}

function renderForm() {
  const options = state.options;
  if (options !== null && changed("options", options)) {
    fillSelect(
      els.bankOutcome,
      options.bankOutcomes.map((value) => ({ value, label: humanize(value) })),
    );
    fillSelect(
      els.emailThread,
      options.emailThreads.map((value) => ({ value, label: humanize(value) })),
    );
    fillSelect(
      els.scenario,
      options.scenarios.map((scenario) => ({
        value: String(scenario.id),
        label: String(scenario.label ?? scenario.id),
      })),
    );
    els.scenarioField.hidden = options.scenarios.length === 0;
  }
  const ready =
    options !== null && options.bankOutcomes.length > 0 && options.emailThreads.length > 0;
  const locked = !ready || state.creating;
  els.scenario.disabled = locked;
  els.bankOutcome.disabled = locked;
  els.emailThread.disabled = locked;
  // Read-only rather than disabled, so the name keeps focus while the incident starts.
  els.startedBy.readOnly = state.creating;
  els.invoiceNumber.readOnly = state.creating;
  els.dueDate.readOnly = state.creating;
  els.startButton.disabled = locked;
  setText(els.startButton, state.creating ? "Starting" : "Start incident");
  showMessage(els.newError, state.createError ?? state.optionsError);
}

async function startIncident(event) {
  event.preventDefault();
  if (state.creating || state.options === null) {
    return;
  }
  const startedBy = els.startedBy.value.trim();
  if (startedBy === "") {
    state.createError = "Enter your name to start an incident.";
    renderForm();
    els.startedBy.focus();
    return;
  }
  const body = {
    bankOutcome: els.bankOutcome.value,
    emails: els.emailThread.value,
    startedBy,
  };
  const invoiceNumber = els.invoiceNumber.value.trim();
  if (invoiceNumber !== "") {
    body.invoiceId = invoiceNumber;
  }
  // The date input gives YYYY-MM-DD, or nothing when it is empty or incomplete.
  if (els.dueDate.validity.badInput) {
    state.createError = "Finish the due date, or clear it.";
    renderForm();
    els.dueDate.focus();
    return;
  }
  if (els.dueDate.value !== "") {
    body.dueDate = els.dueDate.value;
  }
  if (state.options.scenarios.length > 0 && els.scenario.value !== "") {
    body.scenario = els.scenario.value;
  }
  state.creating = true;
  state.createError = null;
  renderForm();
  try {
    const created = await api("/api/incidents", { method: "POST", body });
    if (typeof created.invoiceId !== "string" || created.invoiceId === "") {
      throw new Error("The server did not name the new incident.");
    }
    state.started = { id: created.invoiceId, at: Date.now() };
    els.invoiceNumber.value = "";
    els.dueDate.value = "";
    state.fastUntil = Date.now() + EXPECT_WORK_MS;
    // The sidebar stays where it is, so the form stays on screen for the next start.
    select(created.invoiceId, false);
  } catch (error) {
    state.createError = error.message;
  } finally {
    state.creating = false;
    renderForm();
  }
}

// ---------- incident list ----------

function createIncidentNode(invoiceId) {
  const button = h(
    "button",
    { class: "incident", type: "button" },
    h(
      "span",
      { class: "incident__top" },
      h("span", { class: "incident__id" }),
      h("span", { class: "incident__marks" }, h("span", { class: "badge" }), h("span", { class: "tag", hidden: true })),
    ),
    h(
      "span",
      { class: "incident__meta" },
      h("span", { class: "incident__amount" }),
      h("span", { class: "incident__supplier" }),
    ),
    h("span", { class: "incident__headline" }),
    h("span", { class: "incident__busy", hidden: true }, h("span", { class: "pulse" }), "Working"),
  );
  button.addEventListener("click", () => {
    select(invoiceId);
  });
  return h("li", { dataset: { id: invoiceId } }, button);
}

function updateIncidentNode(node, incident) {
  const button = node.firstElementChild;
  const stateEntry = OBLIGATION_STATES[incident.state];
  const badgeNode = button.querySelector(".badge");
  setText(button.querySelector(".incident__id"), incident.invoiceId);
  setClass(badgeNode, badgeClass(stateEntry));
  setText(badgeNode, stateEntry?.label ?? humanize(incident.state));
  // The board's group too, when it is not the catch-all and the badge does not say it already.
  const group = incident.board !== null && typeof incident.board === "object" ? incident.board : null;
  const groupNode = button.querySelector(".tag");
  const groupText =
    group !== null && group.group !== "open" && group.label !== (stateEntry?.label ?? null) ? String(group.label) : "";
  setText(groupNode, groupText);
  groupNode.hidden = groupText === "";
  setText(
    button.querySelector(".incident__amount"),
    formatMoney(incident.amountMinor, incident.currency),
  );
  setText(button.querySelector(".incident__supplier"), whyText(incident.supplier));
  setText(button.querySelector(".incident__headline"), whyText(incident.headline));
  button.querySelector(".incident__busy").hidden = incident.busy !== true;
  if (incident.invoiceId === state.selectedId) {
    button.setAttribute("aria-current", "true");
  } else {
    button.removeAttribute("aria-current");
  }
}

// Updates a keyed list in place: existing nodes stay, new ones are inserted, gone ones removed.
function reconcile(container, items, keyOf, obtain) {
  const existing = new Map();
  for (const node of [...container.children]) {
    if (existing.has(node.dataset.id)) {
      node.remove();
    } else {
      existing.set(node.dataset.id, node);
    }
  }
  const seen = new Set();
  let previous = null;
  items.forEach((item, index) => {
    let key = keyOf(item, index);
    if (seen.has(key)) {
      key = `${key}#${index}`;
    }
    seen.add(key);
    const node = obtain(existing.get(key) ?? null, item, key);
    existing.delete(key);
    const expected = previous === null ? container.firstElementChild : previous.nextElementSibling;
    if (node !== expected) {
      container.insertBefore(node, expected);
    }
    previous = node;
  });
  for (const node of existing.values()) {
    node.remove();
  }
}

function renderList() {
  const incidents = state.incidents ?? [];
  reconcile(
    els.list,
    incidents,
    (incident) => String(incident.invoiceId),
    (node, incident, key) => {
      const target = node ?? createIncidentNode(key);
      updateIncidentNode(target, incident);
      return target;
    },
  );
  els.listEmpty.hidden = state.incidents === null || incidents.length > 0;
  showMessage(els.listError, state.listError);
  if (state.revealSelected) {
    const selected = els.list.querySelector('[aria-current="true"]');
    if (selected !== null) {
      state.revealSelected = false;
      revealInScroller(selected);
    }
  }
}

// Scrolls the list, never the page, so the selected incident is in view.
function revealInScroller(node) {
  for (const scroller of [els.list, els.sidebar]) {
    if (scroller.scrollHeight <= scroller.clientHeight + 1) {
      continue;
    }
    const box = node.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    if (box.top < frame.top) {
      scroller.scrollTop -= frame.top - box.top + 12;
    } else if (box.bottom > frame.bottom) {
      scroller.scrollTop += box.bottom - frame.bottom + 12;
    }
    return;
  }
}

// ---------- incident detail ----------

function renderPlaceholder() {
  const id = state.selectedId;
  let title = "Loading";
  let text = "";
  if (id !== null) {
    if (isStarting(id)) {
      title = `Starting ${id}`;
      text = "Waiting for the first step.";
    } else if (state.detailError !== null) {
      title = `Could not load ${id}`;
      text = state.detailError;
    } else {
      title = `Loading ${id}`;
    }
  } else if (state.incidents === null) {
    if (state.listError !== null) {
      title = "Cannot reach the server";
      text = "Trying again every few seconds.";
    }
  } else if (state.incidents.length === 0) {
    title = "No incidents yet";
    text = "Start one with the new incident form.";
  } else {
    title = "No incident selected";
    text = "Pick one from the list.";
  }
  setText(els.placeholderTitle, title);
  setText(els.placeholderText, text);
}

// A message from a failed action stays until the section it sits in next changes.
function actionError(section, message) {
  return { message, shownWith: painted.get(section) };
}

function liveMessage(section, error) {
  return error !== null && error.shownWith === painted.get(section) ? error.message : null;
}

function renderHeader(detail) {
  const obligation = detail.obligation;
  const invoiceId = obligation.invoiceId;
  const busy = detail.busy === true;
  // An incident that stopped part-way is picked up again from here.
  const canResume = !busy && obligation.state !== "settled" && obligation.state !== "rejected";
  // A name stored before the name rule can hold format characters, so every stored
  // name goes through whyText, as Airwallex's names do.
  const startedBy = whyText(obligation.startedBy) || null;
  // Set when the invoice is paid from another currency's wallet.
  const paidFrom =
    typeof obligation.sourceCurrency === "string" && obligation.sourceCurrency !== obligation.currency
      ? obligation.sourceCurrency
      : null;
  const dueDate = typeof obligation.dueDate === "string" ? obligation.dueDate : null;
  const duePassed = dueDate !== null && dueDate < localToday();
  if (
    changed("header", [
      invoiceId,
      obligation.supplier,
      obligation.beneficiaryId,
      obligation.currency,
      obligation.amountMinor,
      paidFrom,
      dueDate,
      duePassed,
      obligation.state,
      obligation.origin,
      startedBy,
      busy,
      detail.run ?? null,
    ])
  ) {
    const fromRun =
      detail.run !== null && typeof detail.run === "object" && Number.isInteger(detail.run.id)
        ? detail.run
        : null;
    const hadFocus =
      headerRefs !== null &&
      headerRefs.button !== null &&
      document.activeElement === headerRefs.button;
    let button = null;
    if (canResume) {
      button = h("button", { class: "button button--small", type: "button" }, "Check again");
      button.addEventListener("click", () => {
        resumeIncident(invoiceId);
      });
    }
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    els.header.replaceChildren(
      h(
        "div",
        { class: "detail__title" },
        h("p", { class: "eyebrow" }, "Incident"),
        h("h1", null, invoiceId),
        h("p", { class: "detail__supplier" }, supplierLink(obligation.beneficiaryId, whyText(obligation.supplier))),
        startedBy !== null &&
          h(
            "p",
            { class: "detail__started" },
            fromRun === null ? `Started by ${startedBy}` : `Uploaded by ${startedBy}`,
          ),
        fromRun !== null &&
          h(
            "p",
            { class: "detail__started" },
            "From ",
            h("a", { href: `#run/${fromRun.id}` }, `pay run ${fromRun.id}`),
            `, row ${fromRun.line}`,
          ),
        obligation.origin === "outside" &&
          h("p", { class: "hint" }, "Sent outside PayOnce. The sweep found it in Airwallex."),
      ),
      h(
        "div",
        { class: "detail__facts" },
        h(
          "p",
          { class: "detail__amount" },
          formatMoney(obligation.amountMinor, obligation.currency),
        ),
        paidFrom !== null && h("p", { class: "hint" }, `Paid from ${paidFrom}`),
        dueDate !== null &&
          h(
            "p",
            { class: duePassed ? "hint hint--caution" : "hint" },
            duePassed ? `Due ${dueDate}, which has passed` : `Due ${dueDate}`,
          ),
        h(
          "div",
          { class: "detail__state" },
          busy && h("span", { class: "working-pill" }, h("span", { class: "pulse" }), "Working"),
          button,
          badge(OBLIGATION_STATES[obligation.state], obligation.state, true),
        ),
      ),
      error,
    );
    headerRefs = { button, error };
    if (hadFocus && button !== null) {
      button.focus();
    }
  }
  syncHeaderControls();
}

function syncHeaderControls() {
  if (headerRefs === null) {
    return;
  }
  if (headerRefs.button !== null) {
    headerRefs.button.disabled = state.resuming;
    setText(headerRefs.button, state.resuming ? "Checking" : "Check again");
  }
  if (liveMessage("header", state.resumeError) === null) {
    state.resumeError = null;
  }
  showMessage(headerRefs.error, state.resumeError?.message);
}

async function resumeIncident(invoiceId) {
  if (state.resuming) {
    return;
  }
  state.resuming = true;
  state.resumeError = null;
  syncHeaderControls();
  let failure = null;
  try {
    await api(`${incidentPath(invoiceId)}/resume`, { method: "POST", body: {} });
    state.fastUntil = Date.now() + EXPECT_WORK_MS;
  } catch (error) {
    failure = error.message;
  }
  try {
    await refresh();
  } finally {
    state.resuming = false;
    if (failure !== null && state.selectedId === invoiceId) {
      state.resumeError = actionError("header", failure);
    }
    syncHeaderControls();
  }
}

// What a timeline line is drawn from. Whether its time is today is part of it,
// so after midnight yesterday's lines are drawn again with their day.
function eventSignature(event) {
  const date = parseDate(event.at);
  return JSON.stringify([event.kind, event.at, event.message, date !== null && isToday(date)]);
}

function createEventNode(event, key, signature) {
  const known = Object.hasOwn(EVENT_KINDS, event.kind);
  const kind = known ? event.kind : "other";
  const label = known ? EVENT_KINDS[event.kind] : humanize(event.kind) || "Event";
  const date = parseDate(event.at);
  return h(
    "li",
    { class: `event event--${kind}`, dataset: { id: key, signature } },
    h(
      "time",
      {
        class: "event__time",
        datetime: date === null ? null : date.toISOString(),
        title: date === null ? null : dateTimeFormat.format(date),
      },
      // The time column is narrow, so a line from another day puts its day under
      // the time.
      date === null
        ? ""
        : isToday(date)
          ? timeFormat.format(date)
          : [timeFormat.format(date), h("span", { class: "event__day" }, dayFormat.format(date))],
    ),
    h("span", { class: "event__marker", "aria-hidden": "true" }, icon(kind)),
    h(
      "div",
      { class: "event__body" },
      h("p", { class: "event__kind" }, label),
      h("p", { class: "event__message" }, whyText(event.message)),
    ),
  );
}

// The newest thing in the timeline card: the working line while a step runs,
// otherwise the last event.
function timelineTail() {
  return els.working.hidden ? (els.timeline.lastElementChild ?? els.timeline) : els.working;
}

function inView(node) {
  const box = node.getBoundingClientRect();
  return box.bottom > 0 && box.top < window.innerHeight;
}

function renderTimeline(detail) {
  const invoiceId = detail.obligation.invoiceId;
  const events = Array.isArray(detail.events) ? detail.events : [];
  const busy = detail.busy === true;
  // Events that arrive while an incident is on screen fade in. A newly opened one does not.
  const fresh = els.timeline.dataset.invoice !== invoiceId;
  if (fresh) {
    els.timeline.replaceChildren();
    els.timeline.dataset.invoice = invoiceId;
  }
  // A long timeline runs past the bottom of the window. The page follows new
  // lines while the newest one is on screen, or just after an action.
  const follow = !fresh && (Date.now() < state.fastUntil || inView(timelineTail()));
  const linesBefore = els.timeline.childElementCount;
  reconcile(
    els.timeline,
    events,
    (event, index) => String(event.id ?? `row-${index}`),
    (node, event, key) => {
      const signature = eventSignature(event);
      if (node !== null && node.dataset.signature === signature) {
        return node;
      }
      const next = createEventNode(event, key, signature);
      if (node !== null) {
        node.replaceWith(next);
      } else if (!fresh) {
        next.classList.add("event--new");
      }
      return next;
    },
  );
  els.timeline.classList.toggle("is-busy", busy);
  els.working.hidden = !busy;
  els.timelineEmpty.hidden = events.length > 0 || busy;
  if (follow && els.timeline.childElementCount > linesBefore) {
    timelineTail().scrollIntoView({ block: "nearest" });
  }
}

// Under the timeline: whether its hash chain still holds, and the export links.
function renderAudit(detail) {
  const invoiceId = detail.obligation.invoiceId;
  const audit = detail.audit ?? null;
  if (!changed("audit", [invoiceId, audit])) {
    return;
  }
  if (audit === null) {
    els.audit.hidden = true;
    return;
  }
  const base = `/api/incidents/${encodeURIComponent(invoiceId)}/audit`;
  els.audit.replaceChildren(
    audit.problem === null
      ? `Hash chain intact over ${audit.lines} ${audit.lines === 1 ? "line" : "lines"}. `
      : h("strong", { class: "audit__broken" }, `Hash chain broken. ${audit.problem}. `),
    "Download the audit trail as ",
    h("a", { href: base, download: `${invoiceId}-audit.json` }, "JSON"),
    " or ",
    h("a", { href: `${base}?format=csv`, download: `${invoiceId}-audit.csv` }, "CSV"),
    ".",
  );
  els.audit.hidden = false;
}

function buildAttempt(attempt) {
  const failure = failureText(attempt.failureCode);
  // The bank's short reference is what the timeline messages call this payment.
  const reference =
    typeof attempt.reference === "string" && attempt.reference !== "" ? shownReference(attempt.reference) : null;
  // The timeline quotes Airwallex's status, such as CANCELLED for a failed
  // transfer, so the card names it too when it is not the state shown.
  const bank =
    typeof attempt.bankStatus === "string" &&
    /^[A-Z_]{1,30}$/.test(attempt.bankStatus) &&
    attempt.bankStatus.toLowerCase() !== String(attempt.state)
      ? attempt.bankStatus
      : null;
  return h(
    "li",
    { class: "attempt" },
    h(
      "p",
      { class: "attempt__kind" },
      h("span", null, ATTEMPT_KINDS[attempt.kind] ?? humanize(attempt.kind)),
      reference !== null && h("span", { class: "attempt__reference" }, reference),
    ),
    badge(ATTEMPT_STATES[attempt.state], attempt.state, false),
    failure !== null && h("p", { class: "attempt__failure" }, failure),
    bank !== null && h("p", { class: "attempt__ids" }, "Airwallex shows ", h("span", { class: "mono" }, bank)),
    h(
      "p",
      { class: "attempt__ids" },
      h(
        "span",
        { title: attempt.requestId },
        "Request ",
        h("span", { class: "mono" }, shortId(attempt.requestId)),
      ),
      attempt.transferId === null || attempt.transferId === undefined
        ? h("span", null, "No transfer yet")
        : h(
            "span",
            { title: attempt.transferId },
            "Transfer ",
            h("span", { class: "mono" }, shortId(attempt.transferId)),
          ),
    ),
  );
}

function renderPayments(detail) {
  const attempts = Array.isArray(detail.attempts) ? detail.attempts : [];
  syncPayAgain(detail.obligation.invoiceId);
  if (!changed("payments", [detail.obligation.invoiceId, attempts])) {
    return;
  }
  els.payments.replaceChildren(
    attempts.length === 0
      ? h("p", { class: "empty" }, "No payments yet")
      : h("ul", null, attempts.map(buildAttempt)),
  );
}

function syncPayAgain(invoiceId) {
  els.payAgain.disabled = state.payingAgain;
  setText(els.payAgain, state.payingAgain ? "Trying" : "Pay again");
  const result = state.payAgainResult?.invoiceId === invoiceId ? state.payAgainResult : null;
  setClass(
    els.payAgainResult,
    result?.failed === true ? "pay-again__result form-error" : "pay-again__result",
  );
  showMessage(els.payAgainResult, result?.message ?? null);
}

async function payAgain() {
  const invoiceId = state.selectedId;
  if (state.payingAgain || invoiceId === null) {
    return;
  }
  state.payingAgain = true;
  state.payAgainResult = null;
  syncPayAgain(invoiceId);
  try {
    const result = await api(`${incidentPath(invoiceId)}/pay-again`, { method: "POST", body: {} });
    state.payAgainResult = { invoiceId, message: String(result.message ?? ""), failed: false };
  } catch (error) {
    state.payAgainResult = { invoiceId, message: error.message, failed: true };
  }
  try {
    await refresh();
  } finally {
    state.payingAgain = false;
    syncPayAgain(invoiceId);
  }
}

function addressParts(from) {
  const match = /^(.*@)([^@\s>]+)(.*)$/s.exec(from);
  if (match === null) {
    return [from];
  }
  return [match[1], h("span", { class: "email__domain" }, match[2]), match[3]];
}

function isUnverified(from, unverified) {
  const lower = from.toLowerCase();
  return unverified.some((address) => lower.includes(address));
}

function unverifiedSenders(findings) {
  const list = findings?.unverifiedSenders;
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter((address) => typeof address === "string" && address.trim() !== "")
    .map((address) => address.trim());
}

function buildEmail(email, unverified) {
  const from = String(email.from ?? "");
  const flagged = isUnverified(
    from,
    unverified.map((address) => address.toLowerCase()),
  );
  return h(
    "li",
    { class: flagged ? "email email--unverified" : "email" },
    h(
      "dl",
      { class: "email__head" },
      h("dt", null, "From"),
      h(
        "dd",
        null,
        h("span", { class: "email__from" }, addressParts(from)),
        flagged &&
          h(
            "div",
            null,
            h("span", { class: "flag" }, icon("warning"), "Does not match the supplier on file"),
          ),
      ),
      whyText(email.fromName) !== "" && [
        h("dt", null, "Name in the email"),
        h("dd", { class: "email__muted" }, `${whyText(email.fromName)} (not checked)`),
      ],
      h("dt", null, "Subject"),
      h("dd", { class: "email__subject" }, email.subject),
      Number.isInteger(email.uploadId) && [
        h("dt", null, "Uploaded"),
        h(
          "dd",
          null,
          `by ${whyText(email.uploadedBy)}, `,
          h("a", { href: `#inbox/${email.uploadId}` }, `email ${email.uploadId}`),
        ),
      ],
      Array.isArray(email.replyTo) &&
        email.replyTo.length > 0 && [
          h("dt", null, "Reply-To"),
          h(
            "dd",
            null,
            email.replyTo.map((address) =>
              h(
                "div",
                null,
                h("span", { class: "email__from" }, addressParts(String(address))),
                isUnverified(String(address), unverified.map((entry) => entry.toLowerCase())) &&
                  h("span", { class: "flag" }, icon("warning"), "Does not match the supplier on file"),
              ),
            ),
          ),
        ],
    ),
    Number.isInteger(email.uploadId) && emailExtras(email),
    h("p", { class: "email__body" }, email.body),
  );
}

function buildFindings(findings, unverified, emailCount) {
  if (findings === null || findings === undefined) {
    if (emailCount === 0) {
      return null;
    }
    return h(
      "div",
      { class: "findings" },
      h("p", { class: "findings__title" }, "What the reader found"),
      h("p", { class: "empty" }, "The reader has not read these emails yet."),
    );
  }
  const asksForNewDetails = findings.asksForNewBankDetails === true;
  const readBy = typeof findings.readBy === "string" ? findings.readBy.trim() : "";
  return h(
    "div",
    { class: "findings" },
    h("p", { class: "findings__title" }, "What the reader found"),
    h("p", { class: "findings__summary" }, sentence(findings.summary)),
    unverified.length > 0 &&
      h(
        "div",
        { class: "caution" },
        icon("warning"),
        h(
          "p",
          { class: "caution__title" },
          unverified.length === 1
            ? "Sender does not match the supplier on file"
            : "Senders do not match the supplier on file",
        ),
        unverified.map((address) => h("p", { class: "caution__detail" }, address)),
      ),
    h(
      "dl",
      { class: "facts" },
      h("dt", null, "Reports non-receipt"),
      h("dd", null, findings.claimsNonReceipt === true ? "Yes" : "No"),
      h("dt", null, "Asks for new bank details"),
      h("dd", { class: asksForNewDetails ? "is-caution" : null }, asksForNewDetails ? "Yes" : "No"),
      h("dt", null, "Asks to hold, cancel or not pay"),
      h("dd", { class: findings.asksNotToPay === true ? "is-caution" : null }, findings.asksNotToPay === true ? "Yes" : "No"),
    ),
    readBy !== "" && h("p", { class: "hint" }, `Reader: ${readBy}`),
  );
}

function renderEmails(detail) {
  const invoiceId = detail.obligation.invoiceId;
  const emails = Array.isArray(detail.emails) ? detail.emails : [];
  const findings = detail.findings ?? null;
  const unverified = unverifiedSenders(findings);
  if (changed("emails", [invoiceId, emails, unverified])) {
    els.emails.replaceChildren(
      emails.length === 0
        ? h("p", { class: "empty" }, "No emails yet")
        : h(
            "ul",
            { class: "email-list" },
            emails.map((email) => buildEmail(email, unverified)),
          ),
    );
  }
  if (changed("findings", [invoiceId, findings, emails.length])) {
    const block = buildFindings(findings, unverified, emails.length);
    els.findings.replaceChildren(...(block === null ? [] : [block]));
  }
}

function neededOf(approval) {
  return Number.isInteger(approval.needed) && approval.needed > 1 ? approval.needed : 1;
}

function signoffsOf(approval) {
  return Array.isArray(approval.signoffs)
    ? approval.signoffs.filter((signoff) => typeof signoff?.approver === "string")
    : [];
}

// Why this approver cannot approve this request, in the order the server checks, or null.
function whyCannotApprove(approver, terms, barred, signoffs) {
  const bar = barred.find((entry) => sameName(entry.name, approver.name));
  if (bar !== undefined) {
    return String(bar.why ?? "").trim() || "cannot approve this payment";
  }
  if (signoffs.some((signoff) => sameName(signoff.approver, approver.name))) {
    return "approved already";
  }
  // Limits apply to the amount paid, in the currency it is paid from, as on the server.
  const fx = fxOf(terms);
  const amountMinor = fx === null ? terms.amountMinor : fx.sellAmountMinor;
  const currency = fx === null ? terms.currency : fx.sellCurrency;
  if (
    typeof approver.limitMinor === "number" &&
    typeof amountMinor === "number" &&
    approver.limitMinor < amountMinor
  ) {
    return `can approve up to ${formatMoney(approver.limitMinor, currency)}`;
  }
  return null;
}

// The exchange rate block of a payment from another currency's wallet, or null.
function fxOf(terms) {
  const fx = terms?.fx;
  return fx !== null &&
    typeof fx === "object" &&
    typeof fx.sellAmountMinor === "number" &&
    typeof fx.currencyPair === "string" &&
    typeof fx.clientRate === "number"
    ? fx
    : null;
}

// "1 EUR = 1.119541 USD" for EURUSD, the way Airwallex quotes the pair.
function rateText(fx) {
  return `1 ${fx.currencyPair.slice(0, 3)} = ${fx.clientRate} ${fx.currencyPair.slice(3)}`;
}

function markupText(fx) {
  if (typeof fx.midRate !== "number" || fx.midRate <= 0) {
    return null;
  }
  return `${((Math.abs(fx.clientRate - fx.midRate) / fx.midRate) * 100).toFixed(2)}% from mid-market ${fx.midRate}`;
}

// "Alex called +1 212 555 0147 (on file) on Oct 28 at 14:20 and spoke to Dana, who confirmed: ..."
function callbackText(bankChange) {
  const date = parseDate(bankChange.calledAt);
  const when =
    date === null
      ? []
      : [
          " on ",
          h(
            "time",
            { datetime: date.toISOString(), title: dateTimeFormat.format(date) },
            `${dayFormat.format(date)} at ${minuteFormat.format(date)}`,
          ),
        ];
  return [
    `${whyText(bankChange.calledBy)} called `,
    h("span", { class: "mono" }, bankChange.numberCalled),
    " (on file)",
    ...when,
    ` and spoke to ${whyText(bankChange.spokeTo)}, who confirmed: ${whyText(bankChange.confirmed)}`,
  ];
}

function caution(message) {
  return h("div", { class: "caution" }, icon("warning"), h("p", { class: "caution__title" }, message));
}

// ---------- arrival estimates ----------

// Today on this computer's calendar, as YYYY-MM-DD.
function localToday() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// An arrival estimate as the server words it, or null. The page keeps no copy of
// the rules or the words, so it cannot drift from pnpm approve and the timeline.
function adviceOf(value) {
  return value !== null &&
    typeof value === "object" &&
    typeof value.text === "string" &&
    typeof value.route === "string" &&
    typeof value.note === "string"
    ? value
    : null;
}

function cautionSub(atRisk, text) {
  return h("span", { class: atRisk === true ? "terms__sub terms__sub--caution" : "terms__sub" }, text);
}

// When the payment usually arrives if it is sent today, shown only when the
// estimate counts from an earlier day. It is not part of what is approved.
function sentTodayOf(advice) {
  const today = advice.sentToday;
  return today !== null && typeof today === "object" && typeof today.text === "string" ? today : null;
}

// The Arrival row of an approval card, or nothing when the terms carry no estimate.
function arrivalTerm(advice) {
  if (advice === null) {
    return [];
  }
  const today = sentTodayOf(advice);
  return [
    h("dt", null, "Arrival"),
    h(
      "dd",
      null,
      advice.route,
      typeof advice.due === "string" && cautionSub(advice.atRisk, sentence(advice.due)),
      today !== null && cautionSub(today.atRisk, sentence(today.text)),
      h("span", { class: "terms__sub" }, withPeriod(advice.note)),
    ),
  ];
}

// A held invoice's payment is its first, so the card does not call it a replacement.
function isHeldPayment(approval) {
  return approval.terms?.action === "pay";
}

function approvalLead(approval) {
  const approver = whyText(approval.approver) || null;
  const held = isHeldPayment(approval);
  const payment = held ? "payment" : "replacement";
  switch (approval.state) {
    case "requested": {
      const needed = neededOf(approval);
      const people =
        needed < 2 ? "A person" : needed === 2 ? "Two different people" : `${needed} different people`;
      const why = typeof approval.neededWhy === "string" ? approval.neededWhy.trim() : "";
      const lead =
        needed < 2 || why === ""
          ? `${people} must approve this ${payment} before PayOnce sends it.`
          : `${people} must approve this ${payment} before PayOnce sends it, because ${why}.`;
      // A held invoice can be closed without paying instead.
      const duplicates = approval.terms?.evidence?.duplicates;
      if (!held) {
        return lead;
      }
      return Array.isArray(duplicates) && duplicates.length > 0
        ? `${lead} If the invoice is a second bill, close it without paying instead.`
        : `${lead} If it should not be paid, close it without paying instead.`;
    }
    case "approved":
      return approver === null
        ? `Approved. PayOnce checks the terms again before it sends the ${payment}.`
        : `Approved by ${approver}. PayOnce checks the terms again before it sends the ${payment}.`;
    case "used":
      return approver === null
        ? `Used for one ${held ? "" : "replacement "}payment. It cannot be used again.`
        : `Approved by ${approver} and used for one ${held ? "" : "replacement "}payment. It cannot be used again.`;
    case "void":
      return approver === null
        ? "Void. This approval no longer covers a payment."
        : `Void. ${approver} approved it, but it no longer covers a payment.`;
    default:
      return "";
  }
}

// An invoice a held one looks like a second bill for, and how it stands.
function duplicateNode(duplicate) {
  const stateLabel = OBLIGATION_STATES[duplicate.state]?.label ?? humanize(duplicate.state);
  const paidBy =
    typeof duplicate.paidBy === "string" && duplicate.paidBy !== "" ? `, paid by ${duplicate.paidBy}` : "";
  return h(
    "span",
    { class: "terms__duplicate" },
    h("span", { class: "mono" }, duplicate.invoiceId),
    h("span", { class: "terms__sub" }, `${stateLabel}${paidBy}`),
    duplicate.sameAccount === false &&
      h(
        "span",
        { class: "terms__sub terms__sub--caution" },
        "Paid to a different account from the one this payment goes to",
      ),
  );
}

function buildApproval(invoiceId, approval, outage) {
  const terms = approval.terms ?? {};
  const evidence = terms.evidence ?? {};
  const requested = approval.state === "requested";
  const failure = failureText(evidence.failureCode);
  // Only the first letter is lowered, so PayOnce's own name keeps its capitals.
  const originalFacts = [humanize(evidence.originalState), failure === null ? null : `${failure.charAt(0).toLowerCase()}${failure.slice(1)}`]
    .filter((part) => part !== null && part !== "")
    .join(", ");
  const hasReference =
    typeof evidence.originalReference === "string" && evidence.originalReference !== "";

  const expired = requested && approval.expired === true;
  const held = isHeldPayment(approval);
  const duplicates = held && Array.isArray(evidence.duplicates) ? evidence.duplicates : [];
  // Set when the payment goes to bank details a callback verified.
  const bankChange =
    evidence.bankChange !== null && typeof evidence.bankChange === "object"
      ? evidence.bankChange
      : null;

  const previousSelect = approvalRefs?.select ?? null;
  const hadFocus = previousSelect !== null && document.activeElement === previousSelect;

  // A term the backend did not send is left out rather than shown as an empty row.
  const term = (label, value, ...rest) =>
    value === null || value === undefined || value === ""
      ? []
      : [h("dt", null, label), h("dd", null, value, ...rest)];
  const meta = (label, value) =>
    value === null || value === undefined || value === ""
      ? null
      : h("span", null, `${label} `, h("span", { class: "mono" }, value));

  // Set on a payment from another currency's wallet. The approval covers this quote.
  const fx = fxOf(terms);
  // Set on an invoice with a due date. Advice only: it never stops a payment.
  const arrival = adviceOf(approval.arrivalAdvice);
  const validTo = fx === null ? null : parseDate(fx.validTo);
  const rateSub =
    fx === null
      ? []
      : [
          markupText(fx),
          ["quote ", h("span", { class: "mono", title: String(fx.quoteId) }, shortId(fx.quoteId))],
          validTo === null
            ? null
            : [
                "holds until ",
                h(
                  "time",
                  { datetime: validTo.toISOString(), title: dateTimeFormat.format(validTo) },
                  minuteText(validTo),
                ),
              ],
        ]
          .filter((part) => part !== null)
          .flatMap((part, index) => (index === 0 ? [part] : [" · ", part]));

  const children = [
    h(
      "div",
      { class: "approval__head" },
      h("h2", { id: "approval-title" }, held ? "Payment approval" : "Replacement approval"),
      badge(expired ? EXPIRED_REQUEST : APPROVAL_STATES[approval.state], approval.state, false),
    ),
    h("p", { class: "approval__lead" }, approvalLead(approval)),
    ...[outageNote(approval, outage), sameAccountNote(terms, evidence, held)].filter((note) => note !== null),
    h(
      "dl",
      { class: "terms" },
      h("dt", null, "Amount"),
      h(
        "dd",
        { class: "terms__amount" },
        formatMoney(terms.amountMinor, terms.currency),
        fx !== null &&
          h("span", { class: "terms__sub" }, `Paid with ${formatMoney(fx.sellAmountMinor, fx.sellCurrency)}`),
      ),
      fx !== null && [
        h("dt", null, "Exchange rate"),
        h("dd", null, rateText(fx), h("span", { class: "terms__sub" }, rateSub)),
        h("dt", null, "Transfer fee"),
        h(
          "dd",
          null,
          typeof fx.feeEstimateMinor === "number"
            ? `About ${formatMoney(fx.feeEstimateMinor, fx.sellCurrency)}`
            : `Charged in ${fx.sellCurrency} when it is sent`,
        ),
      ],
      term(
        "Pay to",
        whyText(terms.payTo),
        bankChange !== null &&
          h(
            "span",
            { class: "terms__sub terms__sub--caution" },
            held ? "Not the account PayOnce last paid this supplier" : "Not the account the original payment went to",
          ),
      ),
      arrivalTerm(arrival),
      held
        ? [
            term("Callback", bankChange === null ? null : callbackText(bankChange)),
            term("Why it was held", sentence(evidence.reason)),
            term(
              "Looks like a second bill for",
              duplicates.length === 0 ? null : duplicates.map(duplicateNode),
            ),
            // Only on a held invoice with emails on file, and covered by the binding as on a replacement.
            term("Email evidence", sentence(evidence.emails)),
          ]
        : [
            term("Callback", bankChange === null ? null : callbackText(bankChange)),
            term("Why it was escalated", sentence(evidence.reason)),
            term(
              "Original payment",
              hasReference ? h("span", { class: "mono" }, shownReference(evidence.originalReference)) : originalFacts,
              hasReference && originalFacts !== "" && h("span", { class: "terms__sub" }, originalFacts),
            ),
            term("Email evidence", sentence(evidence.emails)),
          ],
    ),
    h(
      "p",
      { class: "terms__meta" },
      meta("Invoice", terms.invoiceId),
      meta("Beneficiary id", supplierLink(terms.beneficiaryId, terms.beneficiaryId)),
    ),
  ];

  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  let select = null;
  let button = null;
  let locked = false;
  if (requested) {
    const built = buildApproveForm(invoiceId, approval, terms, error);
    ({ select, button, locked } = built);
    children.push(built.form);
  } else {
    // With no form left, a refused approval is still explained under the lead.
    children.splice(2, 0, error);
  }
  // The id says which request an approval is for. The server refuses one that is out of date.
  approvalRefs = { select, button, error, locked, approvalId: approval.id, label: approveLabel(approval) };

  setClass(
    els.approval,
    requested && !expired ? "card approval approval--requested" : "card approval",
  );
  els.approval.replaceChildren(...children);
  els.approval.hidden = false;

  if (select !== null && hadFocus && !select.disabled) {
    select.focus();
  }
}

function approveLabel(approval) {
  return isHeldPayment(approval) ? "Approve payment" : "Approve replacement";
}

// The form under a request still waiting: who has approved, who may approve, and
// anything that stops approving for now.
function buildApproveForm(invoiceId, approval, terms, error) {
  const options = state.options;
  const problem = options?.approvalProblem ?? null;
  const expired = approval.expired === true;
  const signoffs = signoffsOf(approval);
  const barred = Array.isArray(approval.barred)
    ? approval.barred.filter((entry) => typeof entry?.name === "string")
    : [];
  const choices = (options?.approvers ?? []).map((approver) => ({
    name: approver.name,
    why: whyCannotApprove(approver, terms, barred, signoffs),
  }));
  const anyone = choices.some((choice) => choice.why === null);
  const locked = options === null || problem !== null || expired || !anyone;

  const notices = [];
  if (problem !== null) {
    notices.push(caution(`PayOnce refuses every approval because ${withPeriod(problem)}`));
  }
  if (expired) {
    notices.push(caution("This request has expired. PayOnce opens a new request on its next look."));
  } else if (options !== null && problem === null && !anyone) {
    notices.push(caution("Nobody on the approver list can approve this payment."));
  }

  const status = [];
  if (signoffs.length > 0) {
    status.push(
      h("dt", null, "Approved so far"),
      h(
        "dd",
        null,
        signoffs.map((signoff) => {
          const at = timeNode(signoff.at);
          return h("span", { class: "approval__signoff" }, whyText(signoff.approver), at !== null && [" at ", at]);
        }),
      ),
    );
    const remaining = neededOf(approval) - signoffs.length;
    if (remaining > 0) {
      status.push(
        h("dt", null, "Still needed"),
        h("dd", null, remaining === 1 ? "1 more approval" : `${remaining} more approvals`),
      );
    }
  }
  const expiresAt = expired ? null : timeNode(approval.expiresAt);
  if (expiresAt !== null) {
    status.push(h("dt", null, "Expires"), h("dd", null, expiresAt));
  }

  const select = h(
    "select",
    { id: "approver", name: "approver", disabled: locked },
    h("option", { value: "" }, options === null ? "Loading approvers" : "Choose your name"),
    choices.map((choice) =>
      h(
        "option",
        { value: choice.name, disabled: choice.why !== null },
        choice.why === null ? choice.name : `${choice.name} (${choice.why})`,
      ),
    ),
  );
  const draft = state.drafts.get(invoiceId) ?? "";
  select.value =
    choices.find((choice) => choice.why === null && sameName(choice.name, draft))?.name ?? "";
  select.addEventListener("change", () => {
    state.drafts.set(invoiceId, select.value);
    if (state.approveError !== null) {
      state.approveError = null;
      syncApprovalControls();
    }
  });

  const button = h(
    "button",
    { class: "button button--primary", type: "submit", disabled: locked },
    approveLabel(approval),
  );
  const form = h(
    "form",
    { class: "approve-form", novalidate: true },
    status.length > 0 && h("dl", { class: "facts approval__status" }, status),
    notices,
    h(
      "div",
      { class: "approve-form__row" },
      h("label", { class: "field" }, h("span", { class: "field__label" }, "Your name"), select),
      button,
    ),
    error,
    h(
      "p",
      { class: "hint" },
      fxOf(terms) === null
        ? "Your approval covers these exact terms and one payment. If the terms change, it is void."
        : "Your approval covers these exact terms, this exchange rate and one payment. If any of them change, it is void.",
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitApproval(invoiceId);
  });
  return { form, select, button, locked };
}

function syncApprovalControls() {
  if (approvalRefs === null) {
    return;
  }
  if (approvalRefs.button !== null) {
    const off = state.approving || approvalRefs.locked;
    approvalRefs.button.disabled = off;
    approvalRefs.select.disabled = off;
    setText(approvalRefs.button, state.approving ? "Approving" : approvalRefs.label);
  }
  if (liveMessage("approval", state.approveError) === null) {
    state.approveError = null;
  }
  const wasHidden = approvalRefs.error.hidden;
  showMessage(approvalRefs.error, state.approveError?.message);
  if (wasHidden && !approvalRefs.error.hidden) {
    // The card can run past the bottom of a short window. Bring a new message into view.
    approvalRefs.error.scrollIntoView({ block: "nearest" });
  }
}

function renderApproval(detail) {
  const invoiceId = detail.obligation.invoiceId;
  const approval = detail.approval ?? null;
  const outage = detail.outage ?? null;
  // Who may approve comes with the options, which can arrive after the incident.
  const policy =
    state.options === null ? null : [state.options.approvers, state.options.approvalProblem];
  if (changed("approval", [invoiceId, approval, policy, outage?.id ?? null])) {
    if (approval === null) {
      approvalRefs = null;
      els.approval.hidden = true;
      els.approval.replaceChildren();
    } else {
      buildApproval(invoiceId, approval, outage);
    }
  }
  syncApprovalControls();
}

// A replacement for an original the bank failed for a reason a resend cannot fix,
// such as a closed account, goes to the same account unless a callback verified
// new details, so it may fail the same way.
const RESENDABLE_CODES = ["91401", "91402"];

function sameAccountNote(terms, evidence, held) {
  const code = evidence.failureCode;
  const verified = evidence.bankChange !== null && evidence.bankChange !== undefined;
  if (held || terms.action !== "replace" || verified || typeof code !== "string") {
    return null;
  }
  return RESENDABLE_CODES.includes(code)
    ? null
    : caution("This replacement goes to the account the original failed on. Check the account with the supplier before approving it.");
}

// Said on a request or an approval while an outage is active on the rail the
// payment would go out on. An expired request is told only what holds for it:
// an approval of the next request waits for the outage too.
function outageNote(approval, outage) {
  if (outage === null || (approval.state !== "requested" && approval.state !== "approved")) {
    return null;
  }
  const until = parseDate(approval.expiresAt);
  if (approval.expired === true || (until !== null && until.getTime() <= Date.now())) {
    return caution(
      `Outage ${outage.id} on ${outage.rail} is active, so a payment approved on the next request also waits until a person ends it.`,
    );
  }
  const counts = until === null ? "" : ` and counts until ${minuteText(until)}`;
  return caution(
    approval.state === "approved"
      ? `Outage ${outage.id} on ${outage.rail} is active, so this approved payment waits until a person ends it. The approval is kept${counts}.`
      : `Outage ${outage.id} on ${outage.rail} is active. An approval given now waits until a person ends it. It is kept until then${counts}.`,
  );
}

async function submitApproval(invoiceId) {
  if (
    state.approving ||
    approvalRefs === null ||
    approvalRefs.select === null ||
    approvalRefs.locked
  ) {
    return;
  }
  const approver = approvalRefs.select.value;
  if (approver === "") {
    state.approveError = actionError("approval", "Choose your name to approve.");
    syncApprovalControls();
    approvalRefs.select.focus();
    return;
  }
  // The approval is for the request on screen, so the request is named.
  const approvalId = approvalRefs.approvalId;
  state.approving = true;
  state.approveError = null;
  syncApprovalControls();
  let failure = null;
  try {
    await api(`${incidentPath(invoiceId)}/approve`, {
      method: "POST",
      body: { approver, approvalId },
    });
    state.drafts.delete(invoiceId);
    state.fastUntil = Date.now() + EXPECT_WORK_MS;
  } catch (error) {
    failure = error.message;
  }
  try {
    // After a refusal this brings in the current terms, which may be a newer request.
    await refresh();
  } finally {
    state.approving = false;
    if (failure !== null && state.selectedId === invoiceId) {
      state.approveError = actionError("approval", failure);
    }
    syncApprovalControls();
  }
}

// ---------- ask why ----------

// A model's explanation of the incident, asked for by a person. It is shown as
// text only, kept in memory for this session and never written anywhere.
let whyTimer = 0;

// As pnpm ask prints them: control characters and line breaks become spaces, and
// format characters (bidi controls, zero-width characters and the rest of
// Unicode's Cf) and the rest of the tag block are dropped, so a name swapped back
// into an answer cannot reverse or hide part of it.
const WHY_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const WHY_HIDDEN = /[\p{Cf}\u{e0000}-\u{e007f}]/gu;

function whyText(text) {
  return typeof text === "string" ? text.replace(WHY_HIDDEN, "").replace(WHY_CONTROL, " ").trim() : "";
}

function whyEntry(invoiceId) {
  return state.why.get(invoiceId) ?? { asking: false, answer: null, error: null };
}

function lastEventId(detail) {
  const events = Array.isArray(detail.events) ? detail.events : [];
  return events.length === 0 ? 0 : Number(events[events.length - 1].id) || 0;
}

function buildWhy(invoiceId, explainer, entry, limited, stale) {
  const on = explainer?.on === true;
  const answer = entry.answer;
  const label = entry.asking
    ? "Asking"
    : answer !== null
      ? "Ask again"
      : entry.error !== null
        ? "Try again"
        : "Ask why";
  const button = h("button", { class: "button button--small", type: "button" }, label);
  button.disabled = !on || entry.asking || limited;
  button.addEventListener("click", () => askWhy(invoiceId));
  const at = answer === null ? null : parseDate(answer.at);
  const clock = at === null ? null : minuteText(at);
  const when = clock === null ? "" : ` at ${clock}`;
  // Google may use what its free tier is sent; any other service is named by host.
  const sentTo =
    explainer?.googleFreeTier === true
      ? `${explainer.models} on Google's free tier`
      : `${explainer?.models ?? "the model"} at ${explainer?.host || "the address in READER_BASE_URL"}`;
  const children = [
    h("div", { class: "approval__head" }, h("h2", { id: "why-title" }, "Why this happened"), button),
    state.options !== null &&
      !on &&
      h("p", { class: "hint" }, "The model reader is off. Set READER_API_KEY to ask a model why."),
    on &&
      answer === null &&
      !entry.asking &&
      h(
        "p",
        { class: "hint" },
        `Sends this invoice's PayOnce records to ${sentTo}. It leaves out emails, names and account details.`,
      ),
    entry.asking &&
      h(
        "p",
        { class: "why__asking" },
        h("span", { class: "pulse", "aria-hidden": "true" }),
        "Asking the model. This can take up to 17 seconds.",
      ),
    answer !== null && [
      h("p", { class: "why__text" }, whyText(answer.explanation)),
      whyText(answer.notInFacts) !== "" &&
        h("p", { class: "why__text" }, `Not in the records: ${whyText(answer.notInFacts)}`),
      answer.aliasesLeft &&
        Array.isArray(answer.legend) &&
        answer.legend.length > 0 && [
          h("p", { class: "hint" }, "What the labels in the answer stand for:"),
          h(
            "ul",
            { class: "why__legend" },
            answer.legend.map((item) => h("li", null, `${whyText(item.alias)} is ${whyText(item.value)}`)),
          ),
        ],
      // A cached answer that has gone stale shows only the stale notice.
      answer.cached &&
        !stale &&
        h("p", { class: "hint" }, `Nothing has changed since ${clock ?? "then"}, so this is the same answer.`),
      stale && caution("The incident has changed since this answer. Ask again for a current one."),
      h(
        "p",
        { class: "footnote" },
        `Written by ${whyText(answer.model)}${when} from PayOnce's records for this invoice${answer.cut ? ", and shortened to fit" : ""}. A model can be wrong. The timeline and the cards are the record.`,
      ),
    ],
    entry.error !== null && h("p", { class: "form-error", role: "alert" }, entry.error),
  ];
  els.why.replaceChildren(...children.flat(Infinity).filter((child) => child instanceof Node));
}

function renderWhy(detail) {
  const invoiceId = detail.obligation.invoiceId;
  const explainer = state.options?.explainer ?? null;
  const entry = whyEntry(invoiceId);
  const limited = state.whyRetryAt > Date.now();
  const stale = entry.answer !== null && lastEventId(detail) > Number(entry.answer.asOf?.lastEventId ?? 0);
  if (changed("why", [invoiceId, state.options === null, explainer, entry, limited, stale])) {
    buildWhy(invoiceId, explainer, entry, limited, stale);
  }
}

function redrawWhy(invoiceId) {
  const detail = currentDetail();
  if (detail !== null && detail.obligation.invoiceId === invoiceId) {
    renderWhy(detail);
  }
}

async function askWhy(invoiceId) {
  if (whyEntry(invoiceId).asking) {
    return;
  }
  state.why.set(invoiceId, { ...whyEntry(invoiceId), asking: true, error: null });
  redrawWhy(invoiceId);
  try {
    const answer = await api(`${incidentPath(invoiceId)}/why`, { method: "POST", body: {} });
    state.why.set(invoiceId, { asking: false, answer, error: null });
  } catch (error) {
    const wait = error.status === 429 ? Number(error.data?.retryAfterSeconds) : NaN;
    const limitedNow = Number.isFinite(wait) && wait > 0;
    if (limitedNow) {
      state.whyRetryAt = Date.now() + wait * 1000;
      clearTimeout(whyTimer);
      // The button comes back by itself once the limit allows the next ask, and
      // the error that said when goes with it.
      whyTimer = setTimeout(() => {
        for (const [id, entry] of state.why) {
          if (entry.limited === true) {
            state.why.set(id, { ...entry, error: null, limited: false });
          }
        }
        const detail = currentDetail();
        if (detail !== null) {
          renderWhy(detail);
        }
      }, wait * 1000 + 50);
    }
    state.why.set(invoiceId, { ...whyEntry(invoiceId), asking: false, error: error.message, limited: limitedNow });
  }
  redrawWhy(invoiceId);
}

// The card for an incident a person has to close: the bank reports the original
// as paid, so there is no payment to approve. For an invoice held as a likely
// second bill, closing it pays nothing.
function buildReview(invoiceId, review, emailSummary) {
  const hasReference = typeof review.reference === "string" && review.reference !== "";
  const duplicate = review.kind === "duplicate";
  // A held invoice, a likely second bill or any other with nothing live at the bank closes unpaid.
  const unpaid = duplicate || review.kind === "unpaid";
  // Paid payouts sent outside PayOnce that name this invoice but do not pay it.
  const namesOnly = Array.isArray(review.namesOnly) ? review.namesOnly : [];
  const label = unpaid ? "Close without paying" : "Close incident";
  const paidPayment =
    review.kind === "replacement"
      ? "replacement"
      : review.kind === "outside"
        ? "payout sent outside PayOnce"
        : review.kind === "mismatched"
          ? "transfer listed under this invoice's request id"
          : "original payment";
  const draft = state.closeDrafts.get(invoiceId) ?? { closedBy: "", finding: "" };
  const remember = () => {
    state.closeDrafts.set(invoiceId, { closedBy: closedBy.value, finding: finding.value });
    if (state.closeError !== null) {
      state.closeError = null;
      syncReviewControls();
    }
  };

  const closedBy = h("input", {
    type: "text",
    id: "closed-by",
    name: "closedBy",
    autocomplete: "name",
    maxlength: "80",
  });
  closedBy.value = draft.closedBy;
  closedBy.addEventListener("input", remember);
  const finding = h("input", {
    type: "text",
    id: "finding",
    name: "finding",
    autocomplete: "off",
    maxlength: "200",
  });
  finding.value = draft.finding;
  finding.addEventListener("input", remember);

  const button = h("button", { class: "button button--primary", type: "submit" }, label);
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const form = h(
    "form",
    { class: "close-form", novalidate: true },
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Your name"), closedBy),
    h(
      "label",
      { class: "field" },
      h("span", { class: "field__label" }, "What you confirmed"),
      finding,
    ),
    button,
    error,
    h(
      "p",
      { class: "hint" },
      unpaid
        ? "Closing records your name and this note on the timeline. PayOnce then pays nothing for this invoice."
        : "Closing records your name and this note on the timeline. It does not move money.",
      review.covered.length > 0 &&
        " It also records that you checked the transfers this close covers, and only those.",
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitClose(invoiceId);
  });
  // The close sends the transfer ids this card lists, so it is bound to what was shown.
  reviewRefs = {
    closedBy,
    finding,
    button,
    error,
    label,
    covered: review.covered.map((transfer) => transfer.transferId),
  };

  setClass(els.review, "card approval approval--requested");
  els.review.replaceChildren(
    h(
      "div",
      { class: "approval__head" },
      h("h2", { id: "review-title" }, unpaid ? "Close without paying" : "Close this incident"),
      badge(OBLIGATION_STATES.escalated, "escalated", false),
    ),
    h(
      "p",
      { class: "approval__lead" },
      duplicate
        ? `This invoice looks like a second bill for ${review.reference}. If it is, close it without paying. If it is not, PayOnce pays it once it is approved.`
        : unpaid && namesOnly.length > 0
          ? namesOnly.every((payout) => payout.checked === true)
            ? "A payout sent outside PayOnce names this invoice and is paid, but it does not match the invoice's amount, currency or account, so PayOnce does not count it as paying the invoice. Check it with the supplier. If the invoice should not be paid, close it without paying. Otherwise leave it waiting."
            : "A payout sent outside PayOnce names this invoice and is paid, but PayOnce could not check its amount, currency or account yet, so it does not count it as paying the invoice. Check it with the supplier. If the invoice should not be paid, close it without paying. Otherwise leave it waiting."
          : unpaid
            ? "Nothing for this invoice is with the bank or paid. If it should not be paid, close it without paying."
            : `The bank reports the ${paidPayment} as paid, so PayOnce will not send another. Check with the supplier, then close the incident.`,
    ),
    h(
      "dl",
      { class: "terms" },
      duplicate
        ? [
            h("dt", null, "Looks like a second bill for"),
            h("dd", null, h("span", { class: "mono" }, review.reference)),
          ]
        : unpaid
          ? []
          : [
            h("dt", null, sentence(paidPayment)),
            h(
              "dd",
              null,
              hasReference ? h("span", { class: "mono" }, shownReference(review.reference)) : "Paid",
              hasReference && h("span", { class: "terms__sub" }, "Paid"),
            ),
          ],
      review.reason !== "" && [
        h("dt", null, "Why it needs a person"),
        h("dd", null, sentence(review.reason)),
      ],
      emailSummary !== "" && [
        h("dt", null, "Email evidence"),
        h("dd", null, sentence(emailSummary)),
      ],
      review.covered.length > 0 && [
        h("dt", null, "This close covers"),
        h("dd", null, review.covered.map(coveredNode)),
      ],
      namesOnly.length > 0 && [
        h("dt", null, "Names this invoice but does not count as paying it"),
        h("dd", null, namesOnly.map(namingNode)),
      ],
    ),
    form,
  );
  els.review.hidden = false;
}

// A paid payout sent outside PayOnce that names the invoice but does not pay it,
// or that PayOnce could not check yet: its reference, what it delivered and the
// last four characters of the account.
function namingNode(payout) {
  const amount =
    Number.isFinite(payout.amountMinor) && typeof payout.currency === "string"
      ? formatMoney(payout.amountMinor, payout.currency)
      : "Amount not read";
  const ending = typeof payout.ending === "string" ? `account ending ${payout.ending}` : "account not read";
  return h(
    "span",
    { class: "terms__covered" },
    h("span", { class: "mono" }, shownReference(payout.reference)),
    h(
      "span",
      { class: "terms__sub" },
      `${amount}, ${ending}, paid. ${payout.checked === true ? "Does not match this invoice" : "Not checked yet"}`,
    ),
  );
}

// A transfer listed under one of the invoice's request ids that does not match
// it, which closing the incident records as checked.
function coveredNode(transfer) {
  const status =
    typeof transfer.status === "string" && transfer.status !== ""
      ? humanize(transfer.status)
      : "Status not read";
  return h(
    "span",
    { class: "terms__covered" },
    h("span", { class: "mono" }, shownReference(transfer.reference)),
    h(
      "span",
      { class: "terms__sub" },
      `${status}. Listed under the ${transfer.kind}'s request id and does not match this invoice`,
    ),
  );
}

function syncReviewControls() {
  if (reviewRefs === null) {
    return;
  }
  reviewRefs.button.disabled = state.closing;
  reviewRefs.closedBy.readOnly = state.closing;
  reviewRefs.finding.readOnly = state.closing;
  setText(reviewRefs.button, state.closing ? "Closing" : reviewRefs.label);
  if (liveMessage("review", state.closeError) === null) {
    state.closeError = null;
  }
  const wasHidden = reviewRefs.error.hidden;
  showMessage(reviewRefs.error, state.closeError?.message);
  if (wasHidden && !reviewRefs.error.hidden) {
    reviewRefs.error.scrollIntoView({ block: "nearest" });
  }
}

function renderReview(detail) {
  const invoiceId = detail.obligation.invoiceId;
  const review = detail.review ?? null;
  // The findings with the counts an approval shows: emails on file, text nobody read, flagged senders.
  const emailSummary = typeof review?.emails === "string" ? review.emails : "";
  if (changed("review", [invoiceId, review, emailSummary])) {
    if (review === null) {
      reviewRefs = null;
      els.review.hidden = true;
      els.review.replaceChildren();
    } else {
      buildReview(
        invoiceId,
        {
          kind: review.kind,
          reference: review.reference,
          reason: String(review.reason ?? ""),
          covered: Array.isArray(review.covered)
            ? review.covered.filter(
                (transfer) =>
                  typeof transfer?.transferId === "string" && typeof transfer.reference === "string",
              )
            : [],
        },
        emailSummary,
      );
    }
  }
  syncReviewControls();
}

async function submitClose(invoiceId) {
  if (state.closing || reviewRefs === null) {
    return;
  }
  const closedBy = reviewRefs.closedBy.value.trim();
  const finding = reviewRefs.finding.value.trim();
  const covered = reviewRefs.covered;
  const missing =
    closedBy === ""
      ? { field: reviewRefs.closedBy, message: "Enter your name to close." }
      : finding === ""
        ? { field: reviewRefs.finding, message: "Say what you confirmed." }
        : null;
  if (missing !== null) {
    state.closeError = actionError("review", missing.message);
    syncReviewControls();
    missing.field.focus();
    return;
  }
  state.closing = true;
  state.closeError = null;
  syncReviewControls();
  let failure = null;
  try {
    await api(`${incidentPath(invoiceId)}/close`, {
      method: "POST",
      body: { closedBy, finding, covered },
    });
    state.closeDrafts.delete(invoiceId);
    state.fastUntil = Date.now() + EXPECT_WORK_MS;
  } catch (error) {
    failure = error.message;
  }
  try {
    await refresh();
  } finally {
    state.closing = false;
    if (failure !== null && state.selectedId === invoiceId) {
      state.closeError = actionError("review", failure);
    }
    syncReviewControls();
  }
}

// ---------- callback for new bank details ----------

// Which control in a section has focus, so a rebuilt section can give it back.
function focusedControl(section) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !section.contains(active) || active.id === "") {
    return null;
  }
  const selection =
    typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
  return { id: active.id, selection };
}

function restoreFocus(focus) {
  const node = focus === null ? null : document.getElementById(focus.id);
  if (node === null || node.disabled) {
    return;
  }
  node.focus();
  if (focus.selection !== null) {
    try {
      node.setSelectionRange(focus.selection[0], focus.selection[1]);
    } catch {
      // The control does not take a text selection.
    }
  }
}

// The value a datetime-local input takes, in local time to the second. The server refuses a call
// before the payment it is compared with was sent, so a value cut to the minute could be refused.
function localInputValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// "Account name" reads as "account name" in a sentence, "SWIFT code" stays as it is.
function inSentence(label) {
  return String(label).replace(/\b[A-Z][a-z]+\b/g, (word) => word.toLowerCase());
}

// A person can record a callback only while the invoice waits on them and every payment, if any, has failed.
// The form says why when the server refuses one, such as for a supplier PayOnce has never paid.
function bankChangeShown(detail) {
  const obligation = detail.obligation;
  const attempts = Array.isArray(detail.attempts) ? detail.attempts : [];
  return (
    obligation.state === "escalated" &&
    typeof obligation.supplierPhone === "string" &&
    obligation.supplierPhone.trim() !== "" &&
    attempts.every((attempt) => attempt.state === "failed")
  );
}

function readBankForm(data) {
  const fields = Array.isArray(data.fields)
    ? data.fields
        .filter((field) => typeof field?.name === "string" && field.name !== "")
        .map((field) => ({
          name: field.name,
          label: typeof field.label === "string" && field.label !== "" ? field.label : humanize(field.name),
          current: typeof field.current === "string" ? field.current : "",
        }))
    : [];
  const blocked =
    typeof data.blocked === "string" && data.blocked.trim() !== "" ? data.blocked.trim() : null;
  return { fields, blocked };
}

function bankDraft(invoiceId) {
  let draft = state.bankDrafts.get(invoiceId);
  if (draft === undefined) {
    draft = {
      calledBy: "",
      numberCalled: "",
      calledAt: localInputValue(new Date()),
      spokeTo: "",
      confirmed: "",
      details: {},
    };
    state.bankDrafts.set(invoiceId, draft);
  }
  return draft;
}

function bankActions(...buttons) {
  return h("div", { class: "bank-change__actions" }, buttons);
}

// A button with no click handler submits its form.
function bankButton(id, label, className, onClick) {
  const button = h(
    "button",
    { class: className, type: onClick === null ? "submit" : "button", id },
    label,
  );
  if (onClick !== null) {
    button.addEventListener("click", onClick);
  }
  return button;
}

function buildBankChange(invoiceId, phone, open, load) {
  const focus = focusedControl(els.bankChange);
  const refs = { inputs: [], submit: null, cancel: null, error: null, fields: [] };
  const cancel = () => closeBankForm();

  const children = [
    h("div", { class: "approval__head" }, h("h2", { id: "bank-change-title" }, "Changed bank details")),
    h(
      "p",
      { class: "approval__lead" },
      "PayOnce pays new bank details only after someone calls the supplier on the number on file. It never uses a number or an account from an email.",
    ),
    h(
      "dl",
      { class: "terms" },
      h("dt", null, "Number on file"),
      h("dd", null, h("span", { class: "mono" }, phone)),
    ),
  ];

  const small = "button button--small";
  const cancelButton = () => bankButton("bank-change-cancel", "Cancel", small, cancel);
  if (!open) {
    children.push(
      bankActions(
        bankButton("bank-change-open", "Record a callback", small, () => openBankForm(invoiceId)),
      ),
    );
  } else if (load === null || load.status === "loading") {
    children.push(h("p", { class: "empty bank-change__status" }, "Loading the bank details on file."));
  } else if (load.status === "failed") {
    children.push(
      h("p", { class: "form-error" }, `Could not load the bank details. ${load.error}`),
      bankActions(
        bankButton("bank-change-retry", "Try again", small, () => openBankForm(invoiceId)),
        cancelButton(),
      ),
    );
  } else if (load.form.blocked !== null) {
    children.push(caution(withPeriod(load.form.blocked)), bankActions(cancelButton()));
  } else if (load.form.fields.length === 0) {
    children.push(
      caution("The supplier's record in Airwallex has no bank details PayOnce can change."),
      bankActions(cancelButton()),
    );
  } else {
    children.push(buildBankForm(invoiceId, load.form.fields, refs));
  }
  bankRefs = refs;

  els.bankChange.replaceChildren(...children);
  els.bankChange.hidden = false;

  if (state.bankFocusPending === invoiceId && load !== null && load.status !== "loading") {
    // The form just opened, so start at its first field, or its first button when it has none.
    state.bankFocusPending = null;
    (refs.inputs[0] ?? els.bankChange.querySelector("button"))?.focus();
  } else {
    restoreFocus(focus);
  }
}

function buildBankForm(invoiceId, fields, refs) {
  const draft = bankDraft(invoiceId);
  const clearError = () => {
    if (state.bankError !== null) {
      state.bankError = null;
      syncBankControls();
    }
  };
  const control = (id, label, attrs, read, write, hint) => {
    const hintId = hint === null ? null : `${id}-hint`;
    const input = h("input", {
      type: "text",
      id,
      autocomplete: "off",
      "aria-describedby": hintId,
      ...attrs,
    });
    input.value = read();
    input.addEventListener("input", () => {
      write(input.value);
      clearError();
    });
    refs.inputs.push(input);
    return h(
      "div",
      { class: "field" },
      h("label", { class: "field__label", for: id }, label),
      input,
      hint !== null && h("p", { class: "field__hint", id: hintId }, hint),
    );
  };
  const callField = (key, id, label, attrs) =>
    control(id, label, attrs, () => draft[key], (value) => (draft[key] = value), null);

  refs.fields = fields;
  const submit = bankButton("bank-change-submit", "Record callback", "button button--primary", null);
  const cancelButton = bankButton("bank-change-cancel", "Cancel", "button", () => closeBankForm());
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  refs.submit = submit;
  refs.cancel = cancelButton;
  refs.error = error;

  const form = h(
    "form",
    { class: "bank-form", novalidate: true },
    callField("calledBy", "callback-by", "Your name", { autocomplete: "name", maxlength: "80" }),
    callField("numberCalled", "callback-number", "Number you called", { type: "tel", maxlength: "40" }),
    callField("calledAt", "callback-at", "When you called", { type: "datetime-local", step: "1" }),
    callField("spokeTo", "callback-spoke-to", "Who you spoke to", { maxlength: "80" }),
    callField("confirmed", "callback-confirmed", "What they confirmed", { maxlength: "200" }),
    h("p", { class: "bank-form__title" }, "New bank details"),
    h(
      "p",
      { class: "hint bank-form__intro" },
      "Type every field as the supplier confirmed it on the call, including any that did not change.",
    ),
    fields.map((field) =>
      control(
        `bank-field-${field.name}`,
        field.label,
        { maxlength: "70", spellcheck: "false" },
        () => draft.details[field.name] ?? "",
        (value) => (draft.details[field.name] = value),
        field.current === "" ? null : `On file now: ${whyText(field.current)}`,
      ),
    ),
    bankActions(submit, cancelButton),
    error,
    h(
      "p",
      { class: "hint" },
      "Recording the callback updates the supplier's record in Airwallex. Two approvers other than you must then approve the payment to the new account.",
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitBankChange(invoiceId);
  });
  return form;
}

function syncBankControls() {
  if (bankRefs === null) {
    return;
  }
  for (const input of bankRefs.inputs) {
    input.readOnly = state.bankSaving;
  }
  if (bankRefs.submit !== null) {
    bankRefs.submit.disabled = state.bankSaving;
    setText(bankRefs.submit, state.bankSaving ? "Recording" : "Record callback");
  }
  if (bankRefs.cancel !== null) {
    bankRefs.cancel.disabled = state.bankSaving;
  }
  if (liveMessage("bankChange", state.bankError) === null) {
    state.bankError = null;
  }
  if (bankRefs.error === null) {
    return;
  }
  const wasHidden = bankRefs.error.hidden;
  showMessage(bankRefs.error, state.bankError?.message);
  if (wasHidden && !bankRefs.error.hidden) {
    bankRefs.error.scrollIntoView({ block: "nearest" });
  }
}

function renderBankChange(detail) {
  const obligation = detail.obligation;
  const invoiceId = obligation.invoiceId;
  const shown = bankChangeShown(detail);
  const open = shown && state.bankOpen === invoiceId;
  const load = open && state.bankLoad?.invoiceId === invoiceId ? state.bankLoad : null;
  if (
    changed("bankChange", [
      invoiceId,
      shown,
      obligation.supplierPhone,
      open,
      load === null ? null : [load.status, load.form ?? null, load.error ?? null],
    ])
  ) {
    if (shown) {
      buildBankChange(invoiceId, obligation.supplierPhone.trim(), open, load);
    } else {
      bankRefs = null;
      els.bankChange.hidden = true;
      els.bankChange.replaceChildren();
    }
  }
  syncBankControls();
}

// Opening the form reads the supplier's record again, so the form shows what it holds now.
async function openBankForm(invoiceId) {
  const loading = { invoiceId, status: "loading" };
  state.bankOpen = invoiceId;
  state.bankLoad = loading;
  state.bankError = null;
  state.bankFocusPending = invoiceId;
  renderMain();
  let loaded;
  try {
    const data = await api(`${incidentPath(invoiceId)}/bank-details`);
    loaded = { invoiceId, status: "ready", form: readBankForm(data) };
  } catch (error) {
    loaded = { invoiceId, status: "failed", error: error.message };
  }
  // A cancel or a second open while this one loaded wins.
  if (state.bankLoad === loading) {
    state.bankLoad = loaded;
    renderMain();
  }
}

function closeBankForm() {
  const hadFocus = els.bankChange.contains(document.activeElement);
  state.bankOpen = null;
  state.bankLoad = null;
  state.bankError = null;
  state.bankFocusPending = null;
  renderMain();
  if (hadFocus) {
    byId("bank-change-open")?.focus();
  }
}

function bankProblem(invoiceId, fields) {
  const draft = bankDraft(invoiceId);
  const calledAt = Date.parse(draft.calledAt);
  const now = Date.now();
  const checks = [
    ["callback-by", draft.calledBy.trim() !== "", "Enter your name."],
    ["callback-number", draft.numberCalled.trim() !== "", "Enter the number you called."],
    ["callback-at", Number.isFinite(calledAt), "Enter when you called."],
    [
      "callback-at",
      calledAt <= now + 5 * 60_000 && calledAt >= now - 7 * 24 * 60 * 60_000,
      "Enter when you called, within the last seven days.",
    ],
    ["callback-spoke-to", draft.spokeTo.trim() !== "", "Enter who you spoke to."],
    ["callback-confirmed", draft.confirmed.trim() !== "", "Say what they confirmed."],
    ...fields.map((field) => [
      `bank-field-${field.name}`,
      (draft.details[field.name] ?? "").trim() !== "",
      `Enter the ${inSentence(field.label)} the supplier confirmed.`,
    ]),
  ];
  const failed = checks.find(([, ok]) => !ok);
  return failed === undefined ? null : { id: failed[0], message: failed[2] };
}

async function submitBankChange(invoiceId) {
  if (state.bankSaving || bankRefs === null || bankRefs.submit === null) {
    return;
  }
  const fields = bankRefs.fields;
  const problem = bankProblem(invoiceId, fields);
  if (problem !== null) {
    state.bankError = actionError("bankChange", problem.message);
    syncBankControls();
    document.getElementById(problem.id)?.focus();
    return;
  }
  const draft = bankDraft(invoiceId);
  const body = {
    calledBy: draft.calledBy.trim(),
    numberCalled: draft.numberCalled.trim(),
    calledAt: new Date(Date.parse(draft.calledAt)).toISOString(),
    spokeTo: draft.spokeTo.trim(),
    confirmed: draft.confirmed.trim(),
    details: Object.fromEntries(
      fields.map((field) => [field.name, (draft.details[field.name] ?? "").trim()]),
    ),
  };
  state.bankSaving = true;
  state.bankError = null;
  syncBankControls();
  let failure = null;
  try {
    await api(`${incidentPath(invoiceId)}/bank-change`, { method: "POST", body });
    state.bankDrafts.delete(invoiceId);
    if (state.bankOpen === invoiceId) {
      state.bankOpen = null;
      state.bankLoad = null;
    }
    state.fastUntil = Date.now() + EXPECT_WORK_MS;
  } catch (error) {
    failure = error.message;
  }
  try {
    await refresh();
  } finally {
    state.bankSaving = false;
    if (failure !== null && state.selectedId === invoiceId) {
      state.bankError = actionError("bankChange", failure);
    }
    syncBankControls();
  }
}

// The metrics view draws itself. Leaving it, it stays on screen until another
// view, or its loading placeholder, is shown.
function renderMain() {
  if (state.selectedId === METRICS_ID) {
    renderMetricsMain();
    return;
  }
  els.metricsButton.removeAttribute("aria-current");
  renderViews();
  if (mainViews().some((node) => node !== els.metrics && !node.hidden)) {
    els.metrics.hidden = true;
  }
}

function renderViews() {
  const id = state.selectedId;
  if (id === null) {
    els.boardButton.setAttribute("aria-current", "true");
  } else {
    els.boardButton.removeAttribute("aria-current");
  }
  if (id === RECON_ID) {
    els.reconButton.setAttribute("aria-current", "true");
  } else {
    els.reconButton.removeAttribute("aria-current");
  }
  if (id === null) {
    // Coming back to the board, the view left stays a moment while a fresh board loads.
    if (state.board === null && state.boardError === null && Date.now() - state.selectedAt < LOADING_DELAY_MS) {
      return;
    }
    els.detail.hidden = true;
    els.runDetail.hidden = true;
    els.inboxDetail.hidden = true;
    els.supplierDetail.hidden = true;
    els.recon.hidden = true;
    els.placeholder.hidden = true;
    els.board.hidden = false;
    showMessage(els.connection, null);
    renderBoard();
    return;
  }
  renderSelected(id);
  // Leaving the board, it stays on screen until what was picked can be shown.
  if (
    !els.detail.hidden ||
    !els.runDetail.hidden ||
    !els.inboxDetail.hidden ||
    !els.supplierDetail.hidden ||
    !els.recon.hidden ||
    !els.placeholder.hidden
  ) {
    els.board.hidden = true;
  }
}

// A supplier record, and any view after one, leaves the view before it on screen
// until it or its placeholder can be shown.
function renderSelected(id) {
  if (supplierKeyOf(id) !== null) {
    renderSupplierMain();
    if (!els.supplierDetail.hidden || !els.placeholder.hidden) {
      els.detail.hidden = true;
      els.runDetail.hidden = true;
      els.inboxDetail.hidden = true;
      els.recon.hidden = true;
    }
    return;
  }
  renderOtherSelected(id);
  if (
    !els.detail.hidden ||
    !els.runDetail.hidden ||
    !els.inboxDetail.hidden ||
    !els.recon.hidden ||
    !els.placeholder.hidden
  ) {
    els.supplierDetail.hidden = true;
  }
}

// Reconciliation, an email, a pay run or an incident. The view left stays on screen
// until the one picked, or its loading placeholder, is shown.
function renderOtherSelected(id) {
  const views = [els.recon, els.inboxDetail, els.runDetail, els.detail];
  let picked = els.detail;
  if (id === RECON_ID) {
    picked = els.recon;
    renderReconMain();
  } else if (inboxIdOf(id) !== null) {
    picked = els.inboxDetail;
    renderInboxMain();
  } else if (runIdOf(id) !== null) {
    picked = els.runDetail;
    renderRunMain();
  } else {
    renderIncidentMain();
  }
  if (!picked.hidden || !els.placeholder.hidden) {
    for (const view of views) {
      if (view !== picked) {
        view.hidden = true;
      }
    }
  }
}

function renderIncidentMain() {
  const detail = currentDetail();
  if (detail === null && state.detailError === null && Date.now() - state.selectedAt < LOADING_DELAY_MS) {
    // Leave the previous incident, or the board, on screen for a moment so switching does not flash.
    return;
  }
  if (detail === null) {
    renderPlaceholder();
    els.detail.hidden = true;
    els.placeholder.hidden = false;
    showMessage(els.connection, null);
    return;
  }
  showMessage(
    els.connection,
    state.detailError === null ? null : `Could not refresh this incident. ${state.detailError}`,
  );
  renderHeader(detail);
  renderTimeline(detail);
  renderAudit(detail);
  renderWhy(detail);
  renderReview(detail);
  renderBankChange(detail);
  renderApproval(detail);
  placeApproval();
  renderOutbox(detail);
  renderPayments(detail);
  renderEmails(detail);
  els.placeholder.hidden = true;
  els.detail.hidden = false;
}

// While the approval card is shown it comes first, so the close card cannot push
// it below the first screen. Only the approval card moves, so a field someone is
// typing in on another card keeps its focus.
function placeApproval() {
  const after = els.approval.hidden ? els.bankChange : els.why;
  if (after.nextElementSibling !== els.approval) {
    after.after(els.approval);
  }
}

// ---------- messages to send ----------

let outboxRefs = null;

function draftText(draft) {
  return `Subject: ${draft.subject}\n\n${draft.body}`;
}

function draftWarnings(draft) {
  const warnings = [];
  if (draft.intact === false) {
    warnings.push(caution("This text no longer matches the hash recorded on the timeline when it was drafted."));
  }
  if (typeof draft.noLongerFits === "string") {
    warnings.push(
      caution(`Since this was drafted, it no longer fits: ${draft.noLongerFits}. Dismiss it, and draft another if one fits.`),
    );
  } else if (Array.isArray(draft.changed) && draft.changed.length > 0) {
    warnings.push(caution(`Since this was drafted, ${draft.changed.join(", ")}. Dismiss it and draft it again.`));
  }
  return warnings;
}

// Every step the draft went through, in order: a copy stays named once it is
// marked sent or dismissed.
function draftWho(draft) {
  const drafted = `Drafted by ${whyText(draft.createdBy)}${draft.copiedBy ? `, copied by ${whyText(draft.copiedBy)}` : ""}.`;
  if (draft.state === "sent") {
    return `${drafted} Marked sent by ${whyText(draft.sentBy)}.`;
  }
  if (draft.state === "dismissed") {
    return `${drafted} Dismissed by ${whyText(draft.dismissedBy)}${whyText(draft.dismissNote) ? `: ${whyText(draft.dismissNote)}` : ""}.`;
  }
  return drafted;
}

function buildDraft(invoiceId, draft) {
  const open = draft.state === "draft" || draft.state === "copied";
  const head = h(
    "div",
    { class: "outbox-draft__head" },
    h("span", { class: "outbox-draft__label" }, draft.label),
    h("span", { class: "tag" }, AUDIENCES[draft.audience] ?? humanize(draft.audience)),
    badge(DRAFT_STATES[draft.state], draft.state, false),
  );
  if (!open) {
    return h("li", { class: "outbox-draft outbox-draft--closed" }, head, h("p", { class: "hint" }, draftWho(draft)));
  }
  const text = h("textarea", {
    class: "outbox-draft__text",
    id: `draft-text-${draft.id}`,
    readonly: true,
    rows: "9",
    spellcheck: "false",
    "aria-label": `${draft.label}, the text to copy`,
  });
  text.value = draftText(draft);
  const note = h("input", {
    type: "text",
    id: `draft-note-${draft.id}`,
    maxlength: "200",
    autocomplete: "off",
    placeholder: "Why, if you dismiss it (optional)",
    "aria-label": "Why you dismiss it, optional",
  });
  note.value = state.outboxNotes.get(draft.id) ?? "";
  note.addEventListener("input", () => state.outboxNotes.set(draft.id, note.value));
  const copy = h("button", { class: "button button--small", type: "button" }, "Copy");
  copy.addEventListener("click", () => copyDraft(invoiceId, draft, text));
  const sent = h("button", { class: "button button--small button--primary", type: "button" }, "Mark sent");
  sent.addEventListener("click", () => moveDraft(invoiceId, draft.id, "sent"));
  const dismiss = h("button", { class: "button button--small", type: "button" }, "Dismiss");
  dismiss.addEventListener("click", () => moveDraft(invoiceId, draft.id, "dismiss"));
  return h(
    "li",
    { class: "outbox-draft" },
    head,
    draftWarnings(draft),
    draft.template === "callback-notice" &&
      h(
        "p",
        { class: "hint" },
        "Send it to the supplier's contact on file, not as a reply to the email that asked for the change.",
      ),
    text,
    h("div", { class: "outbox-draft__actions" }, copy, sent, dismiss),
    note,
    h("p", { class: "hint" }, draftWho(draft)),
  );
}

function buildOffer(invoiceId, offer, action = "Draft it") {
  const button = h("button", { class: "button button--small", type: "button" }, action);
  button.addEventListener("click", () => draftMessage(invoiceId, offer.template));
  return h(
    "li",
    { class: "outbox-offer" },
    h(
      "div",
      { class: "outbox-offer__text" },
      h("span", { class: "outbox-draft__label" }, offer.label),
      h("span", { class: "tag" }, AUDIENCES[offer.audience] ?? humanize(offer.audience)),
      typeof offer.why === "string" && h("p", { class: "hint" }, withPeriod(offer.why)),
    ),
    button,
  );
}

function buildOutbox(invoiceId, outbox) {
  const focus = focusedControl(els.outbox);
  const name = h("input", {
    type: "text",
    id: "outbox-name",
    autocomplete: "name",
    maxlength: "80",
  });
  name.value = state.outboxName ?? readStoredName();
  name.addEventListener("input", () => {
    state.outboxName = name.value;
  });
  const suggested = outbox.offers.filter((offer) => offer.suggested);
  const others = outbox.offers.filter((offer) => !offer.suggested);
  const withheld = Array.isArray(outbox.withheld) ? outbox.withheld : [];
  const drafts = [...outbox.drafts].reverse();
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  outboxRefs = { name, error, buttons: [] };
  const children = [
    h("div", { class: "approval__head" }, h("h2", { id: "outbox-title" }, "Messages to send")),
    h(
      "p",
      { class: "hint" },
      "PayOnce never sends these. Copy one into your own email, send it to the contact on file, then mark it sent.",
    ),
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Your name"), name),
    error,
    suggested.length > 0 && h("ul", { class: "outbox-offers" }, suggested.map((offer) => buildOffer(invoiceId, offer))),
    others.length > 0 && [
      h("p", { class: "bank-form__title" }, suggested.length > 0 ? "Other messages" : "Messages that fit"),
      h("ul", { class: "outbox-offers" }, others.map((offer) => buildOffer(invoiceId, offer))),
    ],
    withheld.length > 0 && [
      h(
        "p",
        { class: "hint" },
        "No message to the supplier is suggested, because they asked to hold, cancel or not pay this invoice.",
      ),
      h("ul", { class: "outbox-offers" }, withheld.map((offer) => buildOffer(invoiceId, offer, "Draft one anyway"))),
    ],
    outbox.notOffered.map((item) => h("p", { class: "hint" }, `${item.label} is not offered. ${item.why}`)),
    drafts.length > 0 && h("ul", { class: "outbox-drafts" }, drafts.map((draft) => buildDraft(invoiceId, draft))),
  ];
  els.outbox.replaceChildren(...children.flat(Infinity).filter((child) => child instanceof Node));
  outboxRefs.buttons = [...els.outbox.querySelectorAll("button")];
  restoreFocus(focus);
}

function syncOutboxControls() {
  if (outboxRefs === null) {
    return;
  }
  for (const button of outboxRefs.buttons) {
    button.disabled = state.outboxBusy !== null;
  }
  if (liveMessage("outbox", state.outboxError) === null) {
    state.outboxError = null;
  }
  showMessage(outboxRefs.error, state.outboxError?.message);
}

function renderOutbox(detail) {
  const invoiceId = detail.obligation.invoiceId;
  const outbox = detail.outbox ?? { drafts: [], offers: [], notOffered: [], withheld: [] };
  const empty =
    outbox.drafts.length === 0 &&
    outbox.offers.length === 0 &&
    outbox.notOffered.length === 0 &&
    (outbox.withheld ?? []).length === 0;
  if (changed("outbox", [invoiceId, outbox])) {
    if (empty) {
      outboxRefs = null;
      els.outbox.hidden = true;
      els.outbox.replaceChildren();
    } else {
      buildOutbox(invoiceId, outbox);
      els.outbox.hidden = false;
    }
  }
  syncOutboxControls();
}

function outboxName() {
  const name = (outboxRefs?.name.value ?? "").trim();
  if (name === "") {
    state.outboxError = actionError("outbox", "Enter your name first.");
    syncOutboxControls();
    outboxRefs?.name.focus();
    return null;
  }
  storeName(name);
  return name;
}

async function outboxAction(invoiceId, label, path, body) {
  if (state.outboxBusy !== null) {
    return;
  }
  state.outboxBusy = label;
  state.outboxError = null;
  syncOutboxControls();
  let failure = null;
  try {
    await api(`${incidentPath(invoiceId)}/outbox${path}`, { method: "POST", body });
  } catch (error) {
    failure = error.message;
  }
  try {
    await refresh();
  } finally {
    state.outboxBusy = null;
    if (failure !== null && state.selectedId === invoiceId) {
      state.outboxError = actionError("outbox", failure);
    }
    syncOutboxControls();
  }
}

function draftMessage(invoiceId, template) {
  const createdBy = outboxName();
  if (createdBy !== null) {
    outboxAction(invoiceId, "draft", "", { template, createdBy });
  }
}

function moveDraft(invoiceId, draftId, move) {
  const by = outboxName();
  if (by === null) {
    return;
  }
  const body =
    move === "sent"
      ? { sentBy: by }
      : { dismissedBy: by, note: (state.outboxNotes.get(draftId) ?? "").trim() };
  outboxAction(invoiceId, move, `/${draftId}/${move}`, body);
}

// Copies the text to the clipboard, or selects it when the browser will not, and
// records the copy on the timeline once.
async function copyDraft(invoiceId, draft, text) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(draftText(draft));
    copied = true;
  } catch {
    text.focus();
    text.select();
  }
  if (copied && draft.state === "draft") {
    const name = (outboxRefs?.name.value ?? "").trim();
    outboxAction(invoiceId, "copy", `/${draft.id}/copied`, name === "" ? {} : { copiedBy: name });
  }
}

// ---------- pay runs ----------

let runHeaderRefs = null;
let runApprovalRefs = null;
let runCancelRefs = null;

// What a run pays. Every pay row the server counts has an amount, so pay rows
// with no totals are rows whose amounts PayOnce could not read, not a run with
// nothing to pay.
function runTotalsText(totals, payRows = 0) {
  if (Array.isArray(totals) && totals.length > 0) {
    return totals.map((total) => formatMoney(total.amountMinor, total.currency)).join(" and ");
  }
  return Number.isInteger(payRows) && payRows > 0 ? "Amounts not read" : "Nothing to pay";
}

function runCountsText(counts) {
  if (counts === null || typeof counts !== "object") {
    return "";
  }
  const parts = [`${counts.pay} to pay`];
  if (counts.held > 0) {
    parts.push(`${counts.held} held when sent`);
  }
  if (counts.skip > 0) {
    parts.push(`${counts.skip} skipped`);
  }
  return parts.join(", ");
}

// The page keeps one name for whoever uses it, in both name fields.
function syncNames(source) {
  const value = source.value;
  storeName(value);
  for (const input of [els.startedBy, els.runUploadedBy, els.emailUploadedBy]) {
    if (input !== source && document.activeElement !== input) {
      input.value = value;
    }
  }
}

function renderUploadError() {
  const error = state.uploadError;
  if (!changed("uploadError", error)) {
    return;
  }
  if (error === null) {
    els.runError.hidden = true;
    els.runError.replaceChildren();
    return;
  }
  const items = [
    ...(error.problems ?? []).map((problem) =>
      h("li", null, problem.line === null ? withPeriod(problem.message) : `Line ${problem.line}: ${withPeriod(problem.message)}`),
    ),
    ...(error.rows ?? []).slice(0, 10).map((row) =>
      h(
        "li",
        null,
        `Line ${row.line}${row.invoiceId ? ` (${row.invoiceId})` : ""}: ${withPeriod((row.reasons ?? []).join(". "))}`,
      ),
    ),
  ];
  els.runError.replaceChildren(
    h(
      "div",
      null,
      h("p", null, withPeriod(error.message)),
      Number.isInteger(error.runId) && h("p", null, h("a", { href: `#run/${error.runId}` }, `Open run ${error.runId}`)),
      items.length > 0 && h("ul", { class: "form-error__list" }, items),
    ),
  );
  els.runError.hidden = false;
}

function renderRunForm() {
  els.runButton.disabled = state.uploading || state.options === null;
  els.runFile.disabled = state.uploading;
  els.runUploadedBy.readOnly = state.uploading;
  setText(els.runButton, state.uploading ? "Checking the file" : "Check file");
  renderUploadError();
}

async function submitRunFile(event) {
  event.preventDefault();
  if (state.uploading) {
    return;
  }
  const file = els.runFile.files?.[0] ?? null;
  const uploadedBy = els.runUploadedBy.value.trim();
  if (file === null) {
    state.uploadError = { message: "Choose a CSV file." };
    renderRunForm();
    els.runFile.focus();
    return;
  }
  if (uploadedBy === "") {
    state.uploadError = { message: "Enter your name to upload a pay run." };
    renderRunForm();
    els.runUploadedBy.focus();
    return;
  }
  const limit = state.options?.maxRunFileChars ?? 40000;
  state.uploading = true;
  state.uploadError = null;
  renderRunForm();
  try {
    const csv = await file.text();
    if (csv.length > limit) {
      throw new Error(
        `The file is ${csv.length.toLocaleString("en-US")} characters long. A pay run file can be at most ${limit.toLocaleString("en-US")}.`,
      );
    }
    const created = await api("/api/runs", {
      method: "POST",
      body: { fileName: file.name, csv, uploadedBy },
    });
    if (!Number.isInteger(created.runId)) {
      throw new Error("The server did not name the new pay run.");
    }
    els.runFile.value = "";
    state.fastUntil = Date.now() + EXPECT_WORK_MS;
    select(`run/${created.runId}`);
  } catch (error) {
    const data = error.data ?? null;
    state.uploadError = {
      message: error.message,
      problems: Array.isArray(data?.problems) ? data.problems : [],
      rows: Array.isArray(data?.rows) ? data.rows.filter((row) => row.action === "skip") : [],
      runId: Number.isInteger(data?.runId) ? data.runId : null,
    };
  } finally {
    state.uploading = false;
    renderRunForm();
  }
}

function createRunNode(key) {
  const button = h(
    "button",
    { class: "incident", type: "button" },
    h("span", { class: "incident__top" }, h("span", { class: "incident__id" }), h("span", { class: "badge" })),
    h(
      "span",
      { class: "incident__meta" },
      h("span", { class: "incident__amount" }),
      h("span", { class: "incident__supplier" }),
    ),
    h("span", { class: "incident__headline" }),
    h("span", { class: "incident__busy", hidden: true }, h("span", { class: "pulse" }), "Working"),
  );
  button.addEventListener("click", () => {
    select(key);
  });
  return h("li", { dataset: { id: key } }, button);
}

function updateRunNode(node, run, key) {
  const button = node.firstElementChild;
  const entry = RUN_STATES[run.status];
  const badgeNode = button.querySelector(".badge");
  setText(button.querySelector(".incident__id"), `Run ${run.id}`);
  setClass(badgeNode, badgeClass(entry));
  setText(badgeNode, entry?.label ?? humanize(run.status));
  setText(button.querySelector(".incident__amount"), runTotalsText(run.counts?.totals, run.counts?.pay));
  setText(button.querySelector(".incident__supplier"), run.fileName);
  setText(button.querySelector(".incident__headline"), runCountsText(run.counts));
  button.querySelector(".incident__busy").hidden = run.busy !== true;
  if (key === state.selectedId) {
    button.setAttribute("aria-current", "true");
  } else {
    button.removeAttribute("aria-current");
  }
}

function renderRunList() {
  const runs = state.runs ?? [];
  reconcile(
    els.runList,
    runs,
    (run) => `run/${run.id}`,
    (node, run, key) => {
      const target = node ?? createRunNode(key);
      updateRunNode(target, run, key);
      return target;
    },
  );
  els.runsEmpty.hidden = state.runs === null || runs.length > 0;
  showMessage(els.runsError, state.runsError);
}

function syncRunChecks() {
  for (const button of [runHeaderRefs?.button, runApprovalRefs?.checkButton]) {
    if (button !== null && button !== undefined) {
      button.disabled = state.runChecking;
      setText(button, state.runChecking ? "Checking" : "Check again");
    }
  }
  if (runHeaderRefs === null) {
    return;
  }
  if (liveMessage("runHeader", state.runCheckError) === null) {
    state.runCheckError = null;
  }
  showMessage(runHeaderRefs.error, state.runCheckError?.message);
}

function checkButton(runId) {
  const button = h("button", { class: "button button--small", type: "button" }, "Check again");
  button.addEventListener("click", () => {
    checkRunAgain(runId);
  });
  return button;
}

async function checkRunAgain(runId) {
  if (state.runChecking) {
    return;
  }
  state.runChecking = true;
  state.runCheckError = null;
  syncRunChecks();
  let failure = null;
  try {
    await api(`/api/runs/${runId}/check`, { method: "POST", body: {} });
    state.fastUntil = Date.now() + EXPECT_WORK_MS;
  } catch (error) {
    failure = error.message;
  }
  try {
    await refresh();
  } finally {
    state.runChecking = false;
    if (failure !== null && runIdOf(state.selectedId) === runId) {
      state.runCheckError = actionError("runHeader", failure);
    }
    syncRunChecks();
  }
}

function renderRunHeader(run) {
  const info = run.run;
  const busy = run.busy === true;
  if (
    changed("runHeader", [info.id, info.fileName, info.uploadedBy, info.uploadedAt, info.state, info.cancelNote, run.status, run.counts, busy])
  ) {
    const hadFocus =
      runHeaderRefs !== null && runHeaderRefs.button !== null && document.activeElement === runHeaderRefs.button;
    const button = info.state === "waiting" && !busy ? checkButton(info.id) : null;
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const uploadedAt = timeNode(info.uploadedAt);
    els.runHeader.replaceChildren(
      h(
        "div",
        { class: "detail__title" },
        h("p", { class: "eyebrow" }, "Pay run"),
        h("h1", null, `Run ${info.id}`),
        h("p", { class: "detail__supplier" }, info.fileName),
        h("p", { class: "detail__started" }, `Uploaded by ${whyText(info.uploadedBy)}`, uploadedAt !== null && [" at ", uploadedAt]),
        info.state === "cancelled" &&
          h("p", { class: "detail__started" }, `Cancelled by ${whyText(info.cancelledBy)}: ${whyText(info.cancelNote)}`),
      ),
      h(
        "div",
        { class: "detail__facts" },
        h("p", { class: "detail__amount" }, runTotalsText(run.counts?.totals, run.counts?.pay)),
        h("p", { class: "detail__started" }, runCountsText(run.counts)),
        h(
          "div",
          { class: "detail__state" },
          busy && h("span", { class: "working-pill" }, h("span", { class: "pulse" }), "Working"),
          button,
          badge(RUN_STATES[run.status], run.status, true),
        ),
      ),
      error,
    );
    runHeaderRefs = { button, error };
    if (hadFocus && button !== null) {
      button.focus();
    }
  }
  syncRunChecks();
}

// What became of a released row's invoice, in a word or two.
function invoiceStatus(invoice) {
  if (invoice.state === "settled") {
    return { label: "Paid", tone: "paid" };
  }
  if (invoice.state === "rejected") {
    return OBLIGATION_STATES.rejected;
  }
  if (invoice.state === "escalated") {
    return { label: "With a person", tone: "waiting" };
  }
  const last = Array.isArray(invoice.attempts) ? invoice.attempts.at(-1) : undefined;
  if (last === undefined || last.state === "pending") {
    return { label: "Sending", tone: "active" };
  }
  if (last.state === "failed") {
    return { label: "Failed", tone: "failed" };
  }
  return last.state === "paid" ? { label: "Paid", tone: "paid" } : { label: "With the bank", tone: "active" };
}

function cellOf(columns, row, name) {
  const index = Array.isArray(columns) ? columns.indexOf(name) : -1;
  return index < 0 || !Array.isArray(row.cells) ? "" : String(row.cells[index] ?? "");
}

function buildRunRow(row, columns) {
  const invoice = row.invoice !== null && typeof row.invoice === "object" ? row.invoice : null;
  const held = Array.isArray(row.heldFor) && row.heldFor.length > 0;
  const chip =
    invoice !== null
      ? badge(invoiceStatus(invoice), invoice.state)
      : row.state === "dropped"
        ? badge(ROW_ACTIONS.dropped, "dropped")
        : row.action === "skip"
          ? badge(ROW_ACTIONS.skip, "skip")
          : badge(held ? ROW_ACTIONS.held : ROW_ACTIONS.pay, row.action);
  const number = row.invoiceId ?? (cellOf(columns, row, "invoice") || "No invoice number");
  const amount =
    typeof row.amountMinor === "number" && typeof row.currency === "string"
      ? formatMoney(row.amountMinor, row.currency)
      : `${cellOf(columns, row, "amount")} ${cellOf(columns, row, "currency")}`.trim();
  const tags = [];
  // Only a row that pays has a payee to flag. Rows skipped before the flag was
  // cleared on a skip can still carry it.
  const pays = row.action === "pay" && row.state !== "dropped";
  if (pays && row.newPayee === true) {
    tags.push(h("span", { class: "tag tag--caution" }, "New payee"));
  }
  if (pays && row.bankChangeId !== null && row.bankChangeId !== undefined) {
    tags.push(h("span", { class: "tag tag--caution" }, "Account verified by a callback"));
  }
  if (typeof row.sandboxOutcome === "string" && row.sandboxOutcome !== "PAID") {
    tags.push(h("span", { class: "tag" }, "Sandbox: ", h("span", { class: "mono" }, row.sandboxOutcome)));
  }
  const notes = [...(Array.isArray(row.reasons) ? row.reasons : [])];
  if (held && invoice === null) {
    notes.push(`Looks like a second bill for ${row.heldFor.join(", ")}, so PayOnce holds it for a person when it comes to send it`);
  }
  if (typeof row.note === "string" && row.note !== "" && row.state === "dropped") {
    notes.push(`Not released: ${row.note}`);
  }
  // When a pay row usually arrives, and the fee PayOnce last saw on its route.
  const arrival = pays ? adviceOf(row.arrivalAdvice) : null;
  const today = arrival === null ? null : sentTodayOf(arrival);
  const fee = typeof row.feeSeen === "string" && row.feeSeen !== "" ? `; ${row.feeSeen}` : "";
  return h(
    "li",
    { class: row.action === "skip" || row.state === "dropped" ? "run-row is-skipped" : "run-row" },
    h(
      "div",
      { class: "run-row__top" },
      h("span", { class: "run-row__line" }, `Row ${row.line}`),
      h(
        "span",
        { class: "run-row__invoice mono" },
        invoice !== null ? h("a", { href: `#${encodeURIComponent(invoice.invoiceId)}` }, invoice.invoiceId) : number,
      ),
      h("span", { class: "run-row__amount" }, amount),
      chip,
    ),
    h(
      "p",
      { class: "run-row__payee" },
      supplierLink(pays ? row.beneficiaryId : null, whyText(row.payTo ?? row.supplier ?? cellOf(columns, row, "supplier"))),
    ),
    arrival !== null &&
      h(
        "p",
        { class: arrival.atRisk === true ? "run-row__arrival run-row__arrival--caution" : "run-row__arrival" },
        `${sentence(arrival.text)}${fee}`,
      ),
    today !== null &&
      h(
        "p",
        { class: today.atRisk === true ? "run-row__arrival run-row__arrival--caution" : "run-row__arrival" },
        sentence(today.text),
      ),
    tags.length > 0 && h("p", { class: "run-row__tags" }, tags),
    notes.length > 0 && h("ul", { class: "run-row__reasons" }, notes.map((note) => h("li", null, withPeriod(whyText(note))))),
  );
}

function renderRunRows(run) {
  if (!changed("runRows", [run.run.id, run.run.columns, run.rows])) {
    return;
  }
  els.runRows.replaceChildren(...run.rows.map((row) => buildRunRow(row, run.run.columns)));
}

function renderRunTimeline(run) {
  const events = Array.isArray(run.events) ? run.events : [];
  const fresh = els.runTimeline.dataset.run !== String(run.run.id);
  if (fresh) {
    els.runTimeline.replaceChildren();
    els.runTimeline.dataset.run = String(run.run.id);
  }
  reconcile(
    els.runTimeline,
    events,
    (event, index) => String(event.id ?? `row-${index}`),
    (node, event, key) => {
      const signature = eventSignature(event);
      if (node !== null && node.dataset.signature === signature) {
        return node;
      }
      const next = createEventNode(event, key, signature);
      if (node !== null) {
        node.replaceWith(next);
      } else if (!fresh) {
        next.classList.add("event--new");
      }
      return next;
    },
  );
  els.runTimeline.classList.toggle("is-busy", run.busy === true);
  els.runWorking.hidden = run.busy !== true;
}

// Under the run's timeline, as under an invoice's.
function renderRunAudit(run) {
  const runId = run.run.id;
  const audit = run.audit ?? null;
  if (!changed("runAudit", [runId, audit])) {
    return;
  }
  if (audit === null) {
    els.runAudit.hidden = true;
    return;
  }
  const base = `/api/runs/${encodeURIComponent(String(runId))}/audit`;
  els.runAudit.replaceChildren(
    audit.problem === null
      ? `Hash chain intact over ${audit.lines} ${audit.lines === 1 ? "line" : "lines"}. `
      : h("strong", { class: "audit__broken" }, `Hash chain broken. ${audit.problem}. `),
    "Download the run's audit trail as ",
    h("a", { href: base, download: `run-${runId}-audit.json` }, "JSON"),
    " or ",
    h("a", { href: `${base}?format=csv`, download: `run-${runId}-audit.csv` }, "CSV"),
    ".",
  );
  els.runAudit.hidden = false;
}

function runApprovalLead(approval, terms) {
  const count = Array.isArray(terms.rows) ? terms.rows.length : 0;
  const held = Array.isArray(terms.rows) ? terms.rows.filter((row) => row.heldFor?.length > 0).length : 0;
  const what = `paying ${count === 1 ? "1 invoice" : `${count} invoices`}, ${runTotalsText(terms.totals)}`;
  const heldText =
    held === 0
      ? ""
      : held === 1
        ? " One of them looks like a second bill, so PayOnce holds it for a person when it comes to send it."
        : ` ${held} of them look like second bills, so PayOnce holds them for a person when it comes to send them.`;
  const approver = whyText(approval.approver) || null;
  switch (approval.state) {
    case "requested": {
      const needed = neededOf(approval);
      const why = typeof approval.neededWhy === "string" ? approval.neededWhy.trim() : "";
      const people = needed < 2 ? "One person" : "Two different people";
      return `${people} must approve ${what} before PayOnce releases the run${needed > 1 && why !== "" ? `, because ${why}` : ""}.${heldText}`;
    }
    case "approved":
      return `Approved by ${approver ?? "the approvers"}. PayOnce checks every row again and then releases the run.`;
    case "used":
      return `Approved by ${approver ?? "the approvers"} and used to release the run.`;
    case "void":
      return approver === null
        ? "Void. This request no longer covers the run. Check the run again to open a new one."
        : `Void. ${approver} approved it, but it no longer covers the run. Check the run again to open a new request.`;
    default:
      return "";
  }
}

// The Arrival row of a run's approval card: when each row usually arrives, as the
// terms carry it. A request from before the estimates has none.
function runArrivalTerm(approval) {
  const rows = Array.isArray(approval.arrivalAdvice)
    ? approval.arrivalAdvice.filter((entry) => entry !== null && typeof entry === "object" && adviceOf(entry.advice) !== null)
    : [];
  if (rows.length === 0) {
    return [];
  }
  return [
    h("dt", null, "Arrival"),
    h(
      "dd",
      null,
      rows.map((entry) => {
        const today = sentTodayOf(entry.advice);
        return [
          cautionSub(entry.advice.atRisk, `Row ${entry.line}, ${entry.invoiceId}: ${entry.advice.text}`),
          today !== null && cautionSub(today.atRisk, `Row ${entry.line}, ${today.text}`),
        ];
      }),
      h("span", { class: "terms__sub" }, withPeriod(rows[0].advice.note)),
    ),
  ];
}

// The last thing the run's timeline says it is waiting on.
function runWaitingLine(run) {
  const events = Array.isArray(run.events) ? run.events : [];
  return [...events].reverse().find((event) => event.topic === "waiting")?.message ?? null;
}

function buildRunApproveForm(runId, approval, error) {
  const options = state.options;
  const problem = options?.approvalProblem ?? null;
  const signoffs = signoffsOf(approval);
  const barred = Array.isArray(approval.barred)
    ? approval.barred.filter((entry) => typeof entry?.name === "string")
    : [];
  // Limits are checked against the largest currency total.
  const limitTerms = approval.largest ?? { amountMinor: null, currency: "" };
  const choices = (options?.approvers ?? []).map((approver) => ({
    name: approver.name,
    why: whyCannotApprove(approver, limitTerms, barred, signoffs),
  }));
  const anyone = choices.some((choice) => choice.why === null);
  const locked = options === null || problem !== null || !anyone;

  const notices = [];
  if (problem !== null) {
    notices.push(caution(`PayOnce refuses every approval because ${withPeriod(problem)}`));
  } else if (options !== null && !anyone) {
    notices.push(caution("Nobody on the approver list can approve this run."));
  }
  const status = [];
  if (signoffs.length > 0) {
    status.push(
      h("dt", null, "Approved so far"),
      h(
        "dd",
        null,
        signoffs.map((signoff) => {
          const at = timeNode(signoff.at);
          return h("span", { class: "approval__signoff" }, whyText(signoff.approver), at !== null && [" at ", at]);
        }),
      ),
    );
    const remaining = neededOf(approval) - signoffs.length;
    if (remaining > 0) {
      status.push(h("dt", null, "Still needed"), h("dd", null, remaining === 1 ? "1 more approval" : `${remaining} more approvals`));
    }
  }
  const expiresAt = timeNode(approval.expiresAt);
  if (expiresAt !== null) {
    status.push(h("dt", null, "Expires"), h("dd", null, expiresAt));
  }

  const select = h(
    "select",
    { id: "run-approver", name: "approver", disabled: locked },
    h("option", { value: "" }, options === null ? "Loading approvers" : "Choose your name"),
    choices.map((choice) =>
      h("option", { value: choice.name, disabled: choice.why !== null }, choice.why === null ? choice.name : `${choice.name} (${choice.why})`),
    ),
  );
  const draft = state.runDrafts.get(runId)?.approver ?? "";
  select.value = choices.find((choice) => choice.why === null && sameName(choice.name, draft))?.name ?? "";
  select.addEventListener("change", () => {
    state.runDrafts.set(runId, { ...(state.runDrafts.get(runId) ?? {}), approver: select.value });
    if (state.runApproveError !== null) {
      state.runApproveError = null;
      syncRunApproval();
    }
  });
  const button = h("button", { class: "button button--primary", type: "submit", disabled: locked }, "Approve run");
  const form = h(
    "form",
    { class: "approve-form", novalidate: true },
    status.length > 0 && h("dl", { class: "facts approval__status" }, status),
    notices,
    h("div", { class: "approve-form__row" }, h("label", { class: "field" }, h("span", { class: "field__label" }, "Your name"), select), button),
    error,
    h(
      "p",
      { class: "hint" },
      "Your approval covers these rows and totals and nothing else. If a check finds anything different before the release, it is void.",
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitRunApproval(runId);
  });
  return { form, select, button, locked };
}

// A waiting run is released whole, so an outage on any of its pay rows' rails
// holds all of it, as the board says.
function runOutageNote(runId, approval, expired, outage) {
  const held = `Outage ${outage.id} on ${outage.rail} is active, so pay run ${runId} is released only once a person ends it.`;
  if (expired || (approval.state !== "requested" && approval.state !== "approved")) {
    return `${held} A run approved on a new request waits the same way.`;
  }
  return approval.state === "approved"
    ? `${held} The approval is kept until then and still expires when it would.`
    : `${held} An approval given now waits until then and still expires when it would.`;
}

function renderRunApproval(run) {
  const info = run.run;
  const approval = run.approval ?? null;
  const policy = state.options === null ? null : [state.options.approvers, state.options.approvalProblem];
  const waitingLine = runWaitingLine(run);
  const outage = run.outage ?? null;
  if (!changed("runApproval", [info.id, info.state, run.status, approval, policy, waitingLine, outage?.id ?? null])) {
    syncRunApproval();
    return;
  }
  const previousSelect = runApprovalRefs?.select ?? null;
  const hadFocus = previousSelect !== null && document.activeElement === previousSelect;
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const waiting = info.state === "waiting";
  const expired = approval?.state === "requested" && approval.expired === true;
  const open = approval?.state === "requested" && !expired && waiting;
  // Without an open or approved request, a person checks the run again to open one.
  const stuck = waiting && !open && approval?.state !== "approved";
  const checkAgain = stuck ? checkButton(info.id) : null;
  const children = [
    h(
      "div",
      { class: "approval__head" },
      h("h2", { id: "run-approval-title" }, "Run approval"),
      approval === null
        ? badge(RUN_STATES[run.status], run.status, false)
        : badge(expired ? EXPIRED_REQUEST : APPROVAL_STATES[approval.state], approval.state, false),
    ),
  ];
  if (approval === null) {
    children.push(h("p", { class: "approval__lead" }, "No approval request is open for this run."));
  } else {
    const terms = approval.terms ?? {};
    children.push(h("p", { class: "approval__lead" }, expired ? "This request expired before enough people approved it. Check the run again to open a new one." : runApprovalLead(approval, terms)));
    if (outage !== null && waiting) {
      children.push(caution(runOutageNote(info.id, approval, expired, outage)));
    }
    const totals = Array.isArray(terms.totals) ? terms.totals : [];
    children.push(
      h(
        "dl",
        { class: "terms" },
        totals.map((total) => [
          h("dt", null, `${total.currency}, ${total.payments === 1 ? "1 payment" : `${total.payments} payments`}`),
          h(
            "dd",
            null,
            h("span", { class: "terms__amount" }, formatMoney(total.amountMinor, total.currency)),
            total.reserveFloorMinor === null
              ? h("span", { class: "terms__sub terms__sub--caution" }, `No reserve floor is set for ${total.currency}`)
              : h("span", { class: "terms__sub" }, `Reserve floor ${formatMoney(total.reserveFloorMinor, total.currency)}`),
          ),
        ]),
        approval.largest !== null &&
          approval.largest !== undefined &&
          totals.length > 1 && [
            h("dt", null, "Limits checked against"),
            h("dd", null, `${formatMoney(approval.largest.amountMinor, approval.largest.currency)}, the largest total`),
          ],
        // The sender check trusts these domains, so each is approved with the run.
        Array.isArray(approval.domains) &&
          approval.domains.length > 0 && [
            h("dt", null, "Email domains"),
            h(
              "dd",
              null,
              approval.domains.map((check) =>
                h(
                  "span",
                  { class: check.changed === true ? "terms__sub terms__sub--caution" : "terms__sub" },
                  withPeriod(check.text),
                ),
              ),
            ),
          ],
        runArrivalTerm(approval),
      ),
      h(
        "p",
        { class: "terms__meta" },
        h("span", null, "Request ", h("span", { class: "mono" }, String(approval.id))),
        h("span", null, "File ", h("span", { class: "mono" }, String(info.fileHash ?? "").slice(0, 8))),
      ),
    );
  }
  if (stuck && waitingLine !== null) {
    children.push(caution(waitingLine));
  }
  let select = null;
  let button = null;
  let locked = false;
  if (open) {
    const built = buildRunApproveForm(info.id, approval, error);
    ({ select, button, locked } = built);
    children.push(built.form);
  } else {
    children.push(error);
  }
  if (checkAgain !== null) {
    children.push(h("div", { class: "pay-again" }, checkAgain));
  }
  runApprovalRefs = { select, button, error, locked, checkButton: checkAgain, approvalId: approval?.id ?? null };
  setClass(els.runApproval, open ? "card approval approval--requested" : "card approval");
  els.runApproval.replaceChildren(...children);
  els.runApproval.hidden = false;
  if (select !== null && hadFocus && !select.disabled) {
    select.focus();
  }
  syncRunApproval();
  syncRunChecks();
}

function syncRunApproval() {
  if (runApprovalRefs === null) {
    return;
  }
  if (runApprovalRefs.button !== null) {
    const off = state.runApproving || runApprovalRefs.locked;
    runApprovalRefs.button.disabled = off;
    runApprovalRefs.select.disabled = off;
    setText(runApprovalRefs.button, state.runApproving ? "Approving" : "Approve run");
  }
  if (liveMessage("runApproval", state.runApproveError) === null) {
    state.runApproveError = null;
  }
  showMessage(runApprovalRefs.error, state.runApproveError?.message);
}

async function submitRunApproval(runId) {
  if (state.runApproving || runApprovalRefs === null || runApprovalRefs.select === null || runApprovalRefs.locked) {
    return;
  }
  const approver = runApprovalRefs.select.value;
  if (approver === "") {
    state.runApproveError = actionError("runApproval", "Choose your name to approve.");
    syncRunApproval();
    runApprovalRefs.select.focus();
    return;
  }
  // The approval is for the request on screen, so the request is named.
  const approvalId = runApprovalRefs.approvalId;
  state.runApproving = true;
  state.runApproveError = null;
  syncRunApproval();
  let failure = null;
  try {
    await api(`/api/runs/${runId}/approve`, { method: "POST", body: { approver, approvalId } });
    state.fastUntil = Date.now() + EXPECT_WORK_MS;
  } catch (error) {
    failure = error.message;
  }
  try {
    await refresh();
  } finally {
    state.runApproving = false;
    if (failure !== null && runIdOf(state.selectedId) === runId) {
      state.runApproveError = actionError("runApproval", failure);
    }
    syncRunApproval();
  }
}

function renderRunCash(run) {
  const cash = Array.isArray(run.cash) ? run.cash : [];
  if (!changed("runCash", [run.run.id, run.run.checkedAt, cash])) {
    return;
  }
  if (cash.length === 0) {
    els.runCash.hidden = true;
    els.runCash.replaceChildren();
    return;
  }
  const checkedAt = timeNode(run.run.checkedAt);
  const amount = (minor) => cashAmount(minor);
  els.runCash.replaceChildren(
    h("h2", { id: "run-cash-title" }, "Cash at the last check"),
    h(
      "p",
      { class: "hint run-cash__when" },
      checkedAt === null ? [] : ["Checked at ", checkedAt, ". "],
      "PayOnce checks again, on a fresh balance, before it releases the run.",
    ),
    ...cash.map((entry) =>
      h(
        "div",
        { class: "run-cash__currency" },
        h("h3", null, entry.currency),
        h(
          "dl",
          { class: "cash__rows" },
          cashRow("To pay", `${entry.payments === 1 ? "1 payment" : `${entry.payments} payments`}`, amount(entry.payMinor)),
          cashRow(
            "Fees",
            entry.feeUnknown > 0
              ? entry.feeUnknown === entry.payments
                ? "not known at the last check"
                : `not known for ${entry.feeUnknown} at the last check`
              : "the latest recorded at the last check",
            amount(entry.feeMinor),
            entry.feeUnknown > 0 ? "is-unknown" : null,
          ),
          cashRow("Available", "Airwallex", amount(entry.availableMinor), entry.availableMinor === null ? "is-unknown" : null),
          cashRow("Committed elsewhere", "not sent yet", `- ${amount(entry.committedMinor)}`),
          entry.floorMinor === null
            ? cashRow("Reserve floor", `none is set for ${entry.currency}`, "None", "is-unknown")
            : cashRow("Reserve floor", null, amount(entry.floorMinor)),
          cashRow("After the run", null, amount(entry.afterMinor), `is-total ${typeof entry.shortMinor === "number" ? "is-negative" : ""}`.trim()),
        ),
        typeof entry.problem === "string" && entry.problem !== "" && caution(withPeriod(entry.problem)),
      ),
    ),
  );
  els.runCash.hidden = false;
}

function renderRunCancel(run) {
  const info = run.run;
  const show = info.state === "waiting";
  if (!changed("runCancel", [info.id, show])) {
    syncRunCancel();
    return;
  }
  if (!show) {
    runCancelRefs = null;
    els.runCancel.hidden = true;
    els.runCancel.replaceChildren();
    return;
  }
  const draft = state.runDrafts.get(info.id) ?? {};
  const remember = () => {
    state.runDrafts.set(info.id, { ...(state.runDrafts.get(info.id) ?? {}), cancelledBy: cancelledBy.value, note: note.value });
    if (state.runCancelError !== null) {
      state.runCancelError = null;
      syncRunCancel();
    }
  };
  const cancelledBy = h("input", { type: "text", id: "run-cancelled-by", autocomplete: "name", maxlength: "80" });
  cancelledBy.value = draft.cancelledBy ?? readStoredName();
  cancelledBy.addEventListener("input", remember);
  const note = h("input", { type: "text", id: "run-cancel-note", autocomplete: "off", maxlength: "200" });
  note.value = draft.note ?? "";
  note.addEventListener("input", remember);
  const button = h("button", { class: "button", type: "submit" }, "Cancel run");
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const form = h(
    "form",
    { class: "close-form", novalidate: true },
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Your name"), cancelledBy),
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Why"), note),
    button,
    error,
    h("p", { class: "hint" }, "Cancelling moves no money. The run's invoice numbers are free again, so a corrected file can use them."),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitRunCancel(info.id);
  });
  runCancelRefs = { cancelledBy, note, button, error };
  els.runCancel.replaceChildren(h("h2", { id: "run-cancel-title" }, "Cancel this run"), form);
  els.runCancel.hidden = false;
  syncRunCancel();
}

function syncRunCancel() {
  if (runCancelRefs === null) {
    return;
  }
  runCancelRefs.button.disabled = state.runCancelling;
  runCancelRefs.cancelledBy.readOnly = state.runCancelling;
  runCancelRefs.note.readOnly = state.runCancelling;
  setText(runCancelRefs.button, state.runCancelling ? "Cancelling" : "Cancel run");
  if (liveMessage("runCancel", state.runCancelError) === null) {
    state.runCancelError = null;
  }
  showMessage(runCancelRefs.error, state.runCancelError?.message);
}

async function submitRunCancel(runId) {
  if (state.runCancelling || runCancelRefs === null) {
    return;
  }
  const cancelledBy = runCancelRefs.cancelledBy.value.trim();
  const note = runCancelRefs.note.value.trim();
  const missing =
    cancelledBy === ""
      ? { field: runCancelRefs.cancelledBy, message: "Enter your name to cancel." }
      : note === ""
        ? { field: runCancelRefs.note, message: "Say why the run is cancelled." }
        : null;
  if (missing !== null) {
    state.runCancelError = actionError("runCancel", missing.message);
    syncRunCancel();
    missing.field.focus();
    return;
  }
  state.runCancelling = true;
  state.runCancelError = null;
  syncRunCancel();
  let failure = null;
  try {
    await api(`/api/runs/${runId}/cancel`, { method: "POST", body: { cancelledBy, note } });
    state.runDrafts.delete(runId);
  } catch (error) {
    failure = error.message;
  }
  try {
    await refresh();
  } finally {
    state.runCancelling = false;
    if (failure !== null && runIdOf(state.selectedId) === runId) {
      state.runCancelError = actionError("runCancel", failure);
    }
    syncRunCancel();
  }
}

function renderRunMain() {
  const runId = runIdOf(state.selectedId);
  const run = currentRun();
  if (run === null) {
    if (state.runError === null && Date.now() - state.selectedAt < LOADING_DELAY_MS) {
      return;
    }
    setText(els.placeholderTitle, state.runError === null ? `Loading pay run ${runId}` : `Could not load pay run ${runId}`);
    setText(els.placeholderText, state.runError ?? "");
    els.runDetail.hidden = true;
    els.placeholder.hidden = false;
    showMessage(els.connection, null);
    return;
  }
  showMessage(els.connection, state.runError === null ? null : `Could not refresh this pay run. ${state.runError}`);
  renderRunHeader(run);
  renderRunRows(run);
  renderRunTimeline(run);
  renderRunAudit(run);
  renderRunApproval(run);
  renderRunCash(run);
  renderRunCancel(run);
  els.placeholder.hidden = true;
  els.runDetail.hidden = false;
}

// ---------- inbox ----------

const UPLOAD_STATES = {
  waiting: { label: "Waiting", tone: "waiting" },
  delivered: { label: "Delivered", tone: "paid" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};

const WHERE_WORDS = { subject: "the subject", body: "the text", attachment: "an attachment's name" };

let matchRefs = null;
let dismissRefs = null;

function bytesText(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
    return "";
  }
  return bytes < 1024 ? `${bytes} bytes` : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("en-US")} KB`;
}

function toBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function renderEmailForm() {
  const options = state.options;
  els.emailButton.disabled = state.adding || options === null;
  els.emailFile.disabled = state.adding;
  els.emailPaste.readOnly = state.adding;
  els.emailUploadedBy.readOnly = state.adding;
  setText(els.emailButton, state.adding ? "Adding the email" : "Add email");
  setText(els.emailReader, options === null || options.reader === "" ? "" : `Emails are read by: ${options.reader}.`);
  setClass(els.emailFreeTier, options?.readerIsModel === true ? "hint is-caution" : "hint");
  const error = state.addError;
  if (!changed("addError", error)) {
    return;
  }
  if (error === null) {
    els.emailError.hidden = true;
    els.emailError.replaceChildren();
    return;
  }
  // replaceChildren writes false as text, so a link not shown is left out.
  els.emailError.replaceChildren(
    withPeriod(error.message),
    ...(error.id !== null ? [" ", h("a", { href: `#inbox/${error.id}` }, `Open email ${error.id}`)] : []),
  );
  els.emailError.hidden = false;
}

async function submitEmail(event) {
  event.preventDefault();
  if (state.adding) {
    return;
  }
  const file = els.emailFile.files?.[0] ?? null;
  const pasted = els.emailPaste.value;
  const uploadedBy = els.emailUploadedBy.value.trim();
  const missing =
    file === null && pasted.trim() === ""
      ? { field: els.emailFile, message: "Choose an .eml file or paste the raw email." }
      : file !== null && pasted.trim() !== ""
        ? { field: els.emailPaste, message: "Choose a file or paste the email, not both." }
        : uploadedBy === ""
          ? { field: els.emailUploadedBy, message: "Enter your name to add an email." }
          : null;
  if (missing !== null) {
    state.addError = { message: missing.message, id: null };
    renderEmailForm();
    missing.field.focus();
    return;
  }
  const limit = state.options?.maxEmailBytes ?? 2 * 1024 * 1024;
  state.adding = true;
  state.addError = null;
  renderEmailForm();
  try {
    // A file goes as its bytes, so mail in another character set is decoded once, on the server.
    const bytes = file !== null ? new Uint8Array(await file.arrayBuffer()) : new TextEncoder().encode(pasted);
    if (bytes.length > limit) {
      throw new Error("The email is larger than 2 MB. Paste its source without the attachment parts. Use the supplier's own email, not a forward.");
    }
    const created = await api("/api/inbox", {
      method: "POST",
      body: { uploadedBy, source: file !== null ? "file" : "paste", fileName: file?.name, eml: toBase64(bytes) },
    });
    if (!Number.isInteger(created.id)) {
      throw new Error("The server did not name the new upload.");
    }
    els.emailFile.value = "";
    els.emailPaste.value = "";
    select(`inbox/${created.id}`);
  } catch (error) {
    state.addError = { message: error.message, id: Number.isInteger(error.data?.id) ? error.data.id : null };
  } finally {
    state.adding = false;
    renderEmailForm();
  }
}

function createUploadNode(key) {
  const node = createRunNode(key);
  return node;
}

function updateUploadNode(node, upload, key) {
  const button = node.firstElementChild;
  const entry = UPLOAD_STATES[upload.state];
  const badgeNode = button.querySelector(".badge");
  setClass(button, upload.state === "waiting" ? "incident" : "incident is-done");
  setText(button.querySelector(".incident__id"), `Email ${upload.id}`);
  setClass(badgeNode, badgeClass(entry));
  setText(badgeNode, entry?.label ?? humanize(upload.state));
  setText(button.querySelector(".incident__amount"), upload.sender);
  setText(button.querySelector(".incident__supplier"), "");
  setText(
    button.querySelector(".incident__headline"),
    upload.state === "delivered" ? `${upload.subject} (on ${upload.invoiceId})` : upload.subject,
  );
  button.querySelector(".incident__busy").hidden = true;
  if (key === state.selectedId) {
    button.setAttribute("aria-current", "true");
  } else {
    button.removeAttribute("aria-current");
  }
}

function renderInboxList() {
  const uploads = state.inbox ?? [];
  reconcile(
    els.inboxList,
    uploads,
    (upload) => `inbox/${upload.id}`,
    (node, upload, key) => {
      const target = node ?? createUploadNode(key);
      updateUploadNode(target, upload, key);
      return target;
    },
  );
  const waiting = uploads.filter((upload) => upload.state === "waiting").length;
  setText(byId("inbox-title"), waiting > 0 ? `Inbox (${waiting} waiting)` : "Inbox");
  els.inboxEmpty.hidden = state.inbox === null || uploads.length > 0;
  showMessage(els.inboxError, state.inboxError);
}

function currentUpload() {
  const uploadId = inboxIdOf(state.selectedId);
  return uploadId !== null && state.uploadId === uploadId ? state.upload : null;
}

// PayOnce's notes, the attachments it did not open, and the text it found inside
// the email's styles, each in PayOnce's own frame around the sender's text.
function emailExtras(email) {
  const notes = Array.isArray(email.notes) ? email.notes : [];
  const attachments = Array.isArray(email.attachments) ? email.attachments : [];
  const styleText = typeof email.styleText === "string" ? email.styleText : "";
  return [
    notes.length > 0 &&
      h(
        "div",
        { class: "caution" },
        icon("warning"),
        h(
          "p",
          { class: "caution__title" },
          email.partial === true ? "Part of this email could not be read, so a person reads it" : "Notes from PayOnce",
        ),
        notes.map((text) => h("p", { class: "caution__detail" }, withPeriod(text))),
      ),
    attachments.length > 0 &&
      h(
        "div",
        { class: "email__extra" },
        h("p", { class: "findings__title" }, "Attachments, not opened by PayOnce"),
        h(
          "ul",
          { class: "email__attachments" },
          attachments.map((attachment) =>
            h("li", null, `${attachment.name} (${attachment.type}, ${bytesText(attachment.bytes)})`),
          ),
        ),
      ),
    styleText !== "" &&
      h(
        "div",
        { class: "email__extra" },
        h("p", { class: "findings__title" }, "Text found inside styles"),
        h("p", { class: "hint" }, "Strings and other text from the email's HTML styles and scripts, which a mail client may draw. The reader reads this too."),
        h("p", { class: "email__body" }, styleText),
      ),
  ];
}

function renderInboxHeader(detail) {
  const upload = detail.upload;
  if (!changed("inboxHeader", [upload.id, upload.state, upload.invoiceId, upload.deliveredBy, upload.dismissedBy, upload.dismissNote])) {
    return;
  }
  const entry = UPLOAD_STATES[upload.state];
  els.inboxHeader.replaceChildren(
    h(
      "div",
      { class: "detail__title" },
      h("p", { class: "eyebrow" }, "Inbox"),
      h("h1", null, `Email ${upload.id}`),
      h("p", { class: "detail__supplier" }, upload.subject),
      upload.state === "delivered" &&
        h(
          "p",
          { class: "detail__started" },
          `Delivered by ${whyText(upload.deliveredBy)} to `,
          h("a", { href: `#${encodeURIComponent(upload.invoiceId ?? "")}` }, upload.invoiceId ?? ""),
          " ",
          timeNode(upload.deliveredAt),
        ),
      upload.state === "dismissed" &&
        h("p", { class: "detail__started" }, `Dismissed by ${whyText(upload.dismissedBy)}: ${whyText(upload.dismissNote)}`),
    ),
    h("div", { class: "detail__facts" }, h("span", { class: badgeClass(entry) }, entry?.label ?? humanize(upload.state))),
  );
}

function renderInboxEmail(detail) {
  const upload = detail.upload;
  const same = Array.isArray(detail.sameMessageId) ? detail.sameMessageId : [];
  if (!changed("inboxEmail", [upload, same])) {
    return;
  }
  const replyTo = Array.isArray(upload.replyTo) ? upload.replyTo : [];
  const source = upload.fileName ?? (upload.source === "paste" ? "pasted source" : "file");
  els.inboxEmail.replaceChildren(
    h(
      "div",
      { class: "email" },
      h(
        "dl",
        { class: "email__head" },
        h("dt", null, "From"),
        h("dd", null, h("span", { class: "email__from" }, addressParts(upload.sender))),
        whyText(upload.senderName) !== "" && [h("dt", null, "Name in the email"), h("dd", { class: "email__muted" }, `${whyText(upload.senderName)} (not checked)`)],
        h("dt", null, "From as written"),
        h("dd", { class: "email__muted" }, whyText(upload.fromAsWritten)),
        replyTo.length > 0 && [
          h("dt", null, "Reply-To"),
          h("dd", null, replyTo.map((address) => h("div", { class: "email__from" }, addressParts(address)))),
        ],
        h("dt", null, "Subject"),
        h("dd", { class: "email__subject" }, upload.subject),
        upload.dateAsWritten !== "" && [h("dt", null, "Date in the email"), h("dd", null, upload.dateAsWritten)],
        upload.messageId !== null && [h("dt", null, "Message-ID"), h("dd", { class: "email__muted" }, upload.messageId)],
        h("dt", null, "Uploaded"),
        h("dd", null, `by ${whyText(upload.uploadedBy)} `, timeNode(upload.uploadedAt)),
        h("dt", null, "Upload"),
        h("dd", { class: "email__muted" }, `${source}, ${bytesText(upload.rawBytes)}, SHA-256 ${shortId(upload.rawSha256)}`),
      ),
      same.length > 0 &&
        h(
          "div",
          { class: "caution" },
          icon("warning"),
          h("p", { class: "caution__title" }, "Another upload has the same Message-ID and says something different"),
          same.map((id) => h("p", { class: "caution__detail" }, h("a", { href: `#inbox/${id}` }, `Email ${id}`))),
        ),
      emailExtras(upload),
      h("p", { class: "email__body" }, upload.body === "" ? "(no text)" : upload.body),
      h("p", { class: "hint" }, "When the email reaches an invoice, its sender and Reply-To are compared with the supplier's domain on file. Nothing in an email proves who sent it."),
    ),
  );
}

function candidateRow(candidate, checked) {
  const radio = h("input", { type: "radio", name: "inbox-invoice", value: candidate.invoiceId });
  radio.checked = checked;
  const how = candidate.exact
    ? `Named in ${WHERE_WORDS[candidate.where] ?? "the email"}`
    : `Nearly matches a number in ${WHERE_WORDS[candidate.where] ?? "the email"}`;
  const sender = candidate.senderOnFile
    ? "The sender matches the domain on file"
    : candidate.supplierDomain === ""
      ? "No supplier domain is on file, so the sender is flagged"
      : `The sender does not match the domain on file (${candidate.supplierDomain})`;
  return h(
    "label",
    { class: "candidate" },
    radio,
    h(
      "span",
      { class: "candidate__body" },
      h(
        "span",
        { class: "candidate__top" },
        h("a", { href: `#${encodeURIComponent(candidate.invoiceId)}` }, candidate.invoiceId),
        " ",
        badge(OBLIGATION_STATES[candidate.state], candidate.state),
      ),
      h("span", { class: "candidate__line" }, `${whyText(candidate.supplier)}, ${formatMoney(candidate.amountMinor, candidate.currency)}`),
      h("span", { class: "candidate__line" }, candidate.amongDigits ? `${how}, next to other digits, as in a phone number` : how),
      h("span", { class: candidate.senderOnFile ? "candidate__line" : "candidate__line is-caution" }, sender),
    ),
  );
}

function matchLead(candidates, suggested) {
  if (candidates.length === 0) {
    return "PayOnce found no invoice number from the ledger in this email. It looks only for numbers with a digit in them. Pick the invoice it is about, or dismiss it.";
  }
  if (suggested !== null) {
    return "It names one invoice. Check it, then deliver the email there.";
  }
  return candidates.length > 1
    ? "It names more than one invoice. Pick the one it is about."
    : "It names one invoice only nearly, among other digits, or one that is closed. Check before you pick it.";
}

function renderInboxMatch(detail) {
  const upload = detail.upload;
  const candidates = detail.candidates;
  if (!changed("inboxMatch", [upload.id, upload.state, candidates, detail.suggested])) {
    syncMatch();
    return;
  }
  if (upload.state !== "waiting") {
    matchRefs = null;
    els.inboxMatch.hidden = true;
    els.inboxMatch.replaceChildren();
    return;
  }
  // The person's pick outlives a rebuild. One that is no longer offered is dropped,
  // not swapped for the suggestion, so nobody delivers to an invoice they did not pick.
  const draft = state.matchDrafts.get(upload.id) ?? {
    picked: detail.suggested ?? "",
    otherInvoice: "",
    deliveredBy: readStoredName(),
  };
  const picked =
    draft.picked === "" || candidates.some((candidate) => candidate.invoiceId === draft.picked) ? draft.picked : null;
  const focused = document.activeElement?.id ?? "";
  const other = h("input", { type: "radio", name: "inbox-invoice", value: "" });
  other.checked = picked === "";
  const otherInvoice = h("input", { type: "text", id: "inbox-other-invoice", autocomplete: "off", spellcheck: "false", maxlength: "40" });
  otherInvoice.value = draft.otherInvoice;
  otherInvoice.addEventListener("input", () => {
    other.checked = true;
  });
  const deliveredBy = h("input", { type: "text", id: "inbox-delivered-by", autocomplete: "name", maxlength: "80" });
  deliveredBy.value = draft.deliveredBy;
  const button = h("button", { class: "button button--primary", type: "submit" }, "Deliver");
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const form = h(
    "form",
    { class: "approve-form", novalidate: true },
    h("p", { class: "approval__lead" }, matchLead(candidates, detail.suggested)),
    candidates.map((candidate) => candidateRow(candidate, candidate.invoiceId === picked)),
    h(
      "label",
      { class: "candidate" },
      other,
      h("span", { class: "candidate__body" }, h("span", { class: "candidate__top" }, "Another invoice"), otherInvoice),
    ),
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Your name"), deliveredBy),
    button,
    error,
    h("p", { class: "hint" }, "The agent then reads the email and decides again. An email only ever adds caution. A closed invoice keeps the email on file and is not reopened."),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitDeliver(upload.id);
  });
  const remember = () => {
    const radio = form.querySelector('input[name="inbox-invoice"]:checked');
    state.matchDrafts.set(upload.id, {
      picked: radio === null ? null : radio.value,
      otherInvoice: otherInvoice.value,
      deliveredBy: deliveredBy.value,
    });
    syncMatch();
  };
  form.addEventListener("change", remember);
  form.addEventListener("input", remember);
  matchRefs = { form, otherInvoice, deliveredBy, button, error };
  els.inboxMatch.replaceChildren(h("h2", { id: "inbox-match-title" }, "Which invoice is it about?"), form);
  els.inboxMatch.hidden = false;
  if (focused === "inbox-other-invoice" || focused === "inbox-delivered-by") {
    (focused === "inbox-other-invoice" ? otherInvoice : deliveredBy).focus();
  }
  syncMatch();
}

// The invoice the match card would deliver to: the picked one, or the number typed
// for another invoice. Empty when there is neither.
function matchChoice() {
  const picked = matchRefs.form.querySelector('input[name="inbox-invoice"]:checked');
  return picked === null ? "" : picked.value === "" ? matchRefs.otherInvoice.value.trim() : picked.value;
}

function syncMatch() {
  if (matchRefs === null) {
    return;
  }
  matchRefs.button.disabled = state.delivering;
  const choice = matchChoice();
  setText(matchRefs.button, state.delivering ? "Delivering" : choice === "" ? "Deliver" : `Deliver to ${choice}`);
  if (liveMessage("inboxMatch", state.deliverError) === null) {
    state.deliverError = null;
  }
  showMessage(matchRefs.error, state.deliverError?.message);
}

async function submitDeliver(uploadId) {
  if (state.delivering || matchRefs === null) {
    return;
  }
  const invoiceId = matchChoice();
  const deliveredBy = matchRefs.deliveredBy.value.trim();
  const missing =
    invoiceId === ""
      ? { field: matchRefs.otherInvoice, message: "Pick an invoice, or type its number." }
      : deliveredBy === ""
        ? { field: matchRefs.deliveredBy, message: "Enter your name to deliver the email." }
        : null;
  if (missing !== null) {
    state.deliverError = actionError("inboxMatch", missing.message);
    syncMatch();
    missing.field.focus();
    return;
  }
  state.delivering = true;
  state.deliverError = null;
  syncMatch();
  try {
    await api(`/api/inbox/${uploadId}/deliver`, { method: "POST", body: { invoiceId, deliveredBy } });
    state.matchDrafts.delete(uploadId);
    state.fastUntil = Date.now() + EXPECT_WORK_MS;
    select(invoiceId);
  } catch (error) {
    state.deliverError = actionError("inboxMatch", error.message);
  } finally {
    state.delivering = false;
    syncMatch();
  }
}

function renderInboxDismiss(detail) {
  const upload = detail.upload;
  if (!changed("inboxDismiss", [upload.id, upload.state])) {
    syncDismiss();
    return;
  }
  if (upload.state !== "waiting") {
    dismissRefs = null;
    els.inboxDismiss.hidden = true;
    els.inboxDismiss.replaceChildren();
    return;
  }
  const dismissedBy = h("input", { type: "text", id: "inbox-dismissed-by", autocomplete: "name", maxlength: "80" });
  dismissedBy.value = readStoredName();
  const note = h("input", { type: "text", id: "inbox-dismiss-note", autocomplete: "off", maxlength: "200" });
  const button = h("button", { class: "button", type: "submit" }, "Dismiss");
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const form = h(
    "form",
    { class: "close-form", novalidate: true },
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Your name"), dismissedBy),
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Why it belongs to no invoice"), note),
    button,
    error,
    h("p", { class: "hint" }, "Dismissing is final. The same email uploaded again is refused and names who dismissed it."),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitDismiss(upload.id);
  });
  dismissRefs = { dismissedBy, note, button, error };
  els.inboxDismiss.replaceChildren(h("h2", { id: "inbox-dismiss-title" }, "Dismiss this email"), form);
  els.inboxDismiss.hidden = false;
  syncDismiss();
}

function syncDismiss() {
  if (dismissRefs === null) {
    return;
  }
  dismissRefs.button.disabled = state.dismissing;
  setText(dismissRefs.button, state.dismissing ? "Dismissing" : "Dismiss");
  if (liveMessage("inboxDismiss", state.dismissError) === null) {
    state.dismissError = null;
  }
  showMessage(dismissRefs.error, state.dismissError?.message);
}

async function submitDismiss(uploadId) {
  if (state.dismissing || dismissRefs === null) {
    return;
  }
  const dismissedBy = dismissRefs.dismissedBy.value.trim();
  const note = dismissRefs.note.value.trim();
  const missing =
    dismissedBy === ""
      ? { field: dismissRefs.dismissedBy, message: "Enter your name to dismiss the email." }
      : note === ""
        ? { field: dismissRefs.note, message: "Say why it belongs to no invoice." }
        : null;
  if (missing !== null) {
    state.dismissError = actionError("inboxDismiss", missing.message);
    syncDismiss();
    missing.field.focus();
    return;
  }
  state.dismissing = true;
  state.dismissError = null;
  syncDismiss();
  let failure = null;
  try {
    await api(`/api/inbox/${uploadId}/dismiss`, { method: "POST", body: { dismissedBy, note } });
  } catch (error) {
    failure = error.message;
  }
  try {
    await refresh();
  } finally {
    state.dismissing = false;
    if (failure !== null && inboxIdOf(state.selectedId) === uploadId) {
      state.dismissError = actionError("inboxDismiss", failure);
    }
    syncDismiss();
  }
}

function renderInboxMain() {
  const uploadId = inboxIdOf(state.selectedId);
  const detail = currentUpload();
  if (detail === null) {
    if (state.uploadLoadError === null && Date.now() - state.selectedAt < LOADING_DELAY_MS) {
      return;
    }
    setText(els.placeholderTitle, state.uploadLoadError === null ? `Loading email ${uploadId}` : `Could not load email ${uploadId}`);
    setText(els.placeholderText, state.uploadLoadError ?? "");
    els.inboxDetail.hidden = true;
    els.placeholder.hidden = false;
    showMessage(els.connection, null);
    return;
  }
  showMessage(els.connection, state.uploadLoadError === null ? null : `Could not refresh this email. ${state.uploadLoadError}`);
  renderInboxHeader(detail);
  renderInboxEmail(detail);
  renderInboxMatch(detail);
  renderInboxDismiss(detail);
  els.placeholder.hidden = true;
  els.inboxDetail.hidden = false;
}

// ---------- suppliers ----------

const SUPPLIER_KEY = /^[A-Za-z0-9-]{1,64}$/;

// The board's groups as a sidebar tag counts them. open is never tagged.
const SUPPLIER_GROUP_WORDS = {
  person: "waiting on a person",
  deadline: "past the bank deadline",
  bank: "with the bank",
};

const PAYMENT_CHECKS = {
  checked: "checked",
  misdirected: "went to other details",
  "not-kept": "account not kept",
  "not-sent": "not sent",
  outside: "sent outside PayOnce",
};

const ACCOUNT_SOURCES = {
  decided: "decided for",
  sent: "sent to",
  approval: "asked to approve",
  "pay-run": "in a pay run",
  callback: "verified by a callback",
  "before-callback": "on the record before a callback",
  outside: "paid outside PayOnce",
};

const HOLD_WORDS = {
  counted: "counted its failure",
  original: "first payment",
  replacement: "replacement",
  approved: "approved payment",
  run: "pay run release",
};

function supplierLink(key, text) {
  return typeof key === "string" && SUPPLIER_KEY.test(key) ? h("a", { href: `#supplier/${key}` }, text) : text;
}

function invoiceLink(invoiceId) {
  return typeof invoiceId === "string" && invoiceId !== ""
    ? h("a", { class: "mono", href: `#${encodeURIComponent(invoiceId)}` }, invoiceId)
    : "an invoice";
}

function runLink(runId) {
  return Number.isInteger(runId) ? h("a", { href: `#run/${runId}` }, `pay run ${runId}`) : "a pay run";
}

// Nodes and text with a separator between each, for a line of links.
function joinedNodes(items, separator = ", ") {
  return items.flatMap((item, index) => (index === 0 ? [item] : [separator, item]));
}

function countText(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

// A time in a sentence, with the zone named as on the rest of the view: "at 17:31
// GMT+5:30" today, and "on Oct 28, 21:33 GMT+5:30" on another day.
function whenNode(value) {
  const time = zonedTime(value);
  return time === null ? "at a time not on file" : [isToday(parseDate(value)) ? "at " : "on ", time];
}

// The same with no word before it, after "Since".
function sinceNode(value) {
  return zonedTime(value) ?? "a time not on file";
}

function largestRisk(atRisk) {
  const list = Array.isArray(atRisk) ? atRisk : [];
  return list.reduce((most, money) => (most === null || money.minor > most.minor ? money : most), null);
}

function createSupplierNode(key) {
  const button = h("button", { class: "incident supplier-row", type: "button" });
  button.addEventListener("click", () => {
    select(key);
  });
  return h("li", { dataset: { id: key } }, button);
}

function supplierRowParts(summary) {
  const invoices = summary.invoices ?? {};
  const open = (invoices.open ?? 0) + (invoices.escalated ?? 0);
  const cautions = Array.isArray(summary.cautions) ? summary.cautions.length : 0;
  const risk = largestRisk(summary.atRisk);
  const tags = Object.entries(SUPPLIER_GROUP_WORDS)
    .filter(([group]) => (summary.groups?.[group] ?? 0) > 0)
    .map(([group, words]) => h("span", { class: "tag" }, `${summary.groups[group]} ${words}`));
  return [
    h(
      "span",
      { class: "incident__top" },
      h("span", { class: "supplier-row__name" }, whyText(summary.name) || "(no name)"),
      cautions > 0 && h("span", { class: "tag tag--caution" }, countText(cautions, "caution", "cautions")),
    ),
    h(
      "span",
      { class: "incident__meta" },
      risk !== null && h("span", { class: "incident__amount" }, `${formatMoney(risk.minor, risk.currency)} at risk`),
      h(
        "span",
        { class: risk === null ? "supplier-row__count" : "incident__supplier" },
        `${open} open of ${countText(invoices.total ?? 0, "invoice", "invoices")}`,
        summary.runRows > 0 ? `, ${countText(summary.runRows, "pay run row", "pay run rows")} waiting` : "",
      ),
    ),
    tags.length > 0 && h("span", { class: "supplier-row__tags" }, tags),
    summary.key === null && h("span", { class: "incident__headline" }, "Its record id cannot be linked"),
  ];
}

function updateSupplierNode(node, summary, key) {
  const button = node.firstElementChild;
  const signature = JSON.stringify(summary);
  if (node.dataset.signature !== signature) {
    node.dataset.signature = signature;
    button.replaceChildren(...supplierRowParts(summary).filter(Boolean));
    button.disabled = summary.key === null;
  }
  if (key === state.selectedId) {
    button.setAttribute("aria-current", "true");
  } else {
    button.removeAttribute("aria-current");
  }
}

function renderSupplierList() {
  const suppliers = state.suppliers ?? [];
  reconcile(
    els.supplierList,
    suppliers,
    (summary, index) => (summary.key === null ? `supplier-unlinked/${index}` : `supplier/${summary.key}`),
    (node, summary, key) => {
      const target = node ?? createSupplierNode(key);
      updateSupplierNode(target, summary, key);
      return target;
    },
  );
  els.suppliersEmpty.hidden = state.suppliers === null || suppliers.length > 0;
  showMessage(els.suppliersError, state.suppliersError);
}

// Fills a card, or hides it when there is nothing to show.
function fillCard(section, title, body) {
  const nodes = body.flat(Infinity).filter((node) => node !== null && node !== undefined && node !== false);
  section.hidden = nodes.length === 0;
  section.replaceChildren(...(nodes.length === 0 ? [] : [h("h2", { id: `${section.id}-title` }, title), ...nodes]));
}

function supplierHeader(detail) {
  const names = (Array.isArray(detail.names) ? detail.names : []).map(whyText).filter((name) => name !== "");
  const domains = (Array.isArray(detail.domains) ? detail.domains : []).map((entry) => whyText(entry.domain));
  const related = Array.isArray(detail.related) ? detail.related : [];
  const stored = detail.recordStored;
  const currencies = Array.isArray(detail.currencies) ? detail.currencies : [];
  const methods = Array.isArray(detail.methods) ? detail.methods : [];
  return [
    h(
      "div",
      { class: "detail__title" },
      h("p", { class: "eyebrow" }, "Supplier record"),
      h("h1", { class: "supplier__name" }, whyText(detail.name) || "(no name)"),
      h("p", { class: "detail__started" }, "Record ", h("span", { class: "mono" }, detail.key)),
      names.length > 0 && h("p", { class: "detail__started" }, `Also on file as ${names.join(", ")}`),
      h(
        "p",
        { class: "detail__started" },
        detail.phoneLast4 === null ? "No phone on file" : `Phone on file ending ${detail.phoneLast4}`,
        ". ",
        domains.length === 0 ? "No email domain on file" : `Email ${domains.length === 1 ? "domain" : "domains"} ${domains.join(", ")}`,
        currencies.length > 0 ? `. Pays in ${currencies.join(", ")}${methods.length > 0 ? ` by ${methods.join(", ")}` : ""}` : "",
      ),
      related.map((record) =>
        h(
          "p",
          { class: "detail__started" },
          record.why.includes("same-name") ? "Same name: " : "Same account: ",
          supplierLink(record.key, whyText(record.name) || record.key),
          record.why.includes("same-name") ? " (may be another company)" : "",
          record.why.includes("same-account")
            ? record.accounts.length > 0
              ? `, shares account ${record.accounts.join(", ")}`
              : ", shares an account"
            : "",
        ),
      ),
      h(
        "p",
        { class: "hint" },
        stored === null
          ? "PayOnce has not stored what this record holds. It reads the record again before every payment."
          : [
              "PayOnce last stored what this record held ",
              whenNode(stored.at),
              stored.invoiceId !== null
                ? [" (", invoiceLink(stored.invoiceId), ")"]
                : stored.runId !== null
                  ? [" (", Number.isInteger(stored.runLine) ? `row ${stored.runLine} of ` : "", runLink(stored.runId), ")"]
                  : "",
              `, account ${stored.account}. It reads the record again before every payment.`,
            ],
      ),
    ),
  ];
}

function cautionNode(caution) {
  const links = [
    ...(Array.isArray(caution.invoices) ? caution.invoices.map(invoiceLink) : []),
    ...(Array.isArray(caution.runs) ? caution.runs.map(runLink) : []),
    ...(Array.isArray(caution.keys) ? caution.keys.map((key) => supplierLink(key, `record ${key}`)) : []),
  ];
  const info = caution.level !== "caution";
  return h(
    "div",
    { class: info ? "caution caution--info" : "caution" },
    icon(info ? "other" : "warning"),
    h("p", { class: "caution__title" }, caution.text),
    links.length > 0 && h("p", { class: "supplier-caution__links" }, joinedNodes(links)),
    caution.since !== null && h("p", { class: "supplier-caution__links" }, "Since ", sinceNode(caution.since)),
  );
}

function countLine(label, count) {
  return count.total === 0
    ? null
    : `${label}: ${count.paid} paid, ${count.failed} failed, ${count.live} with the bank`;
}

function accountNode(account) {
  const tags = [
    account.lastPaid && h("span", { class: "tag" }, "Last paid and checked"),
    account.recordLastStored && h("span", { class: "tag" }, "Last stored"),
    account.verifiedBy !== null && h("span", { class: "tag tag--caution" }, "Verified by a callback"),
  ].filter(Boolean);
  const counts = [countLine("PayOnce", account.payonce), countLine("Outside PayOnce", account.outside)].filter(Boolean);
  const verified = account.verifiedBy;
  return h(
    "li",
    { class: "supplier-item" },
    h(
      "p",
      { class: "supplier-item__top" },
      h("strong", null, `Account ${account.label}`),
      h("span", { class: "mono" }, account.ending === null ? "ending not on file" : `ending ${account.ending}`),
      tags,
    ),
    account.lastPaid &&
      account.lastPaidReference !== null &&
      h("p", null, "Last paid by ", h("span", { class: "mono" }, account.lastPaidReference)),
    h("p", null, counts.length === 0 ? "No payment to it" : counts.join(". ")),
    h(
      "p",
      { class: "supplier-item__sub" },
      `Seen as ${account.seenAs.map((source) => ACCOUNT_SOURCES[source] ?? humanize(source)).join(", ")}`,
      account.firstSeen !== null ? [", first ", whenNode(account.firstSeen)] : "",
      account.lastSeen !== null && account.lastSeen !== account.firstSeen ? [", last ", whenNode(account.lastSeen)] : "",
    ),
    verified !== null &&
      h(
        "p",
        null,
        `Callback ${verified.callbackId} from ${whyText(verified.calledBy)} `,
        whenNode(verified.calledAt),
        " (",
        invoiceLink(verified.invoiceId),
        ")",
      ),
    account.superseded.length > 0 &&
      h("p", { class: "supplier-item__sub" }, `Older callbacks for it: ${account.superseded.join(", ")}`),
    account.barred.length > 0 &&
      h("p", { class: "hint hint--caution" }, `${account.barred.map(whyText).join(", ")} cannot approve payments to it`),
    account.alsoOn.length > 0 &&
      h("p", null, "Also on ", joinedNodes(account.alsoOn.map((key) => supplierLink(key, `record ${key}`)))),
  );
}

// A payment from before PayOnce kept an amount, an account or a send time says so
// once, instead of "not on file" for each.
const OLD_DETAILS = "(details from before PayOnce kept them)";

function paymentNode(payment) {
  const amountKnown = typeof payment.amountMinor === "number";
  const timeKnown = parseDate(payment.sentAt) !== null;
  // A payment with no transfer was never sent, so it has no account or send time.
  const old = payment.check !== "not-sent" && (!amountKnown || payment.account === null || !timeKnown);
  const parts = [
    payment.bankStatus !== null ? payment.bankStatus : null,
    payment.failureCode !== null ? `${payment.failureCode} (${payment.failureWords ?? "a code PayOnce has no words for"})` : null,
    amountKnown ? formatMoney(payment.amountMinor, payment.currency ?? "") : null,
    payment.account !== null ? `to account ${payment.account}` : null,
    old && payment.check === "not-kept" ? null : (PAYMENT_CHECKS[payment.check] ?? humanize(payment.check)),
    payment.foundLate ? "found late" : null,
    payment.rateMismatch ? "rate did not match its approval" : null,
  ].filter((part) => part !== null);
  const when = timeKnown ? [payment.kind === "outside" ? "Found " : "Sent ", whenNode(payment.sentAt)] : [];
  const state = payment.kind === "outside" ? null : ATTEMPT_STATES[payment.state];
  return h(
    "li",
    { class: "supplier-payment" },
    h(
      "span",
      { class: "supplier-payment__top" },
      h("span", null, payment.kind === "outside" ? "Sent outside PayOnce" : (ATTEMPT_KINDS[payment.kind] ?? humanize(payment.kind))),
      h("span", { class: "mono" }, payment.reference ?? "no reference"),
      badge(state ?? null, payment.state),
    ),
    h(
      "span",
      { class: "supplier-item__sub" },
      parts.join(", "),
      parts.length > 0 && when.length > 0 ? ". " : "",
      when,
      old ? `${parts.length > 0 || when.length > 0 ? " " : ""}${OLD_DETAILS}` : "",
    ),
    payment.mismatchedReference !== null &&
      h(
        "span",
        { class: "hint hint--caution" },
        "A transfer under its request id does not match the invoice: ",
        h("span", { class: "mono" }, payment.mismatchedReference),
        payment.mismatchedStatus !== null ? ` (${payment.mismatchedStatus})` : "",
      ),
  );
}

function paidByNode(paid) {
  return h(
    "p",
    null,
    "Paid by ",
    paid.reference === null ? "a payment" : h("span", { class: "mono" }, paid.reference),
    parseDate(paid.sentAt) === null ? [] : [paid.kind === "outside" ? ", found " : ", sent ", whenNode(paid.sentAt)],
    paid.account !== null ? ` to account ${paid.account}` : "",
    ` (${PAYMENT_CHECKS[paid.check] ?? humanize(paid.check)})`,
    paid.arrivesBy !== null ? `. It usually arrives by ${paid.arrivesBy}` : "",
  );
}

function supplierInvoiceNode(invoice, recordName) {
  const board = invoice.board;
  const amount =
    invoice.wallet === invoice.currency
      ? formatMoney(invoice.amountMinor, invoice.currency)
      : `${formatMoney(invoice.amountMinor, invoice.currency)}, paid from ${invoice.wallet}`;
  const facts = [
    invoice.origin === "outside" ? "Found in Airwallex" : null,
    invoice.runId !== null ? ["From ", runLink(invoice.runId), `, row ${invoice.runLine}`] : null,
    invoice.startedBy !== null ? `Started by ${whyText(invoice.startedBy)}` : null,
    invoice.rejectedBy !== null ? `Closed without paying by ${whyText(invoice.rejectedBy)}` : null,
    invoice.dueDate !== null ? `Due ${invoice.dueDate}` : null,
    invoice.duplicateOf.length > 0 ? ["Held as a likely second bill for ", joinedNodes(invoice.duplicateOf.map(invoiceLink))] : null,
  ].filter((part) => part !== null);
  const risk = Array.isArray(invoice.atRisk) ? invoice.atRisk : [];
  const emails = invoice.emails;
  return h(
    "li",
    { class: "supplier-item" },
    h(
      "p",
      { class: "supplier-item__top" },
      h("strong", null, invoiceLink(invoice.invoiceId)),
      badge(OBLIGATION_STATES[invoice.state], invoice.state),
      board !== null && board.group !== "open" && board.label !== OBLIGATION_STATES[invoice.state]?.label && h("span", { class: "tag" }, board.label),
      h("span", { class: "supplier-item__amount" }, amount),
    ),
    whyText(invoice.supplier) !== "" &&
      whyText(invoice.supplier).toLowerCase() !== whyText(recordName).toLowerCase() &&
      h("p", { class: "supplier-item__sub" }, `On file as ${whyText(invoice.supplier)}`),
    board !== null && h("p", null, withPeriod(board.why)),
    board !== null && board.also.map((line) => h("p", { class: "board-entry__also" }, `Also: ${withPeriod(line)}`)),
    risk.length > 0 && h("p", null, `${risk.map(boardMoneyText).join(", ")} at risk`),
    invoice.paidBy !== null && paidByNode(invoice.paidBy),
    facts.length > 0 && h("p", { class: "supplier-item__sub" }, joinedNodes(facts, ". ")),
    invoice.payments.length > 0 && h("ul", { class: "supplier-payments" }, invoice.payments.map(paymentNode)),
    emails !== null &&
      h(
        "p",
        { class: "supplier-item__sub" },
        countText(emails.count, "email", "emails"),
        emails.partlyUnread > 0 ? `, ${emails.partlyUnread} partly unread` : "",
        emails.sendersFlagged > 0 ? `, ${countText(emails.sendersFlagged, "sender", "senders")} flagged` : "",
        emails.findings === null ? ", not read yet" : `: ${emails.findings.summary}`,
      ),
  );
}

function supplierInvoices(detail) {
  const closed = detail.closed;
  const older = closed.settled + closed.rejected - closed.listed;
  return [
    h("ol", { class: "supplier-list" }, detail.invoices.map((invoice) => supplierInvoiceNode(invoice, detail.name))),
    older > 0 && h("p", { class: "footnote" }, `${countText(older, "older closed invoice is", "older closed invoices are")} not listed. The incident list has them.`),
  ];
}

function bankChangeNode(change) {
  return h(
    "li",
    { class: "supplier-item" },
    h(
      "p",
      { class: "supplier-item__top" },
      h("strong", null, `Callback ${change.id}`),
      badge({ label: humanize(change.state), tone: change.state === "applied" ? "paid" : change.state === "failed" ? "failed" : "neutral" }, change.state),
      change.latest && h("span", { class: "tag" }, "Latest applied"),
    ),
    h(
      "p",
      null,
      `By ${whyText(change.calledBy)} to the number ending ${change.numberCalledLast4 ?? "not on file"} `,
      whenNode(change.calledAt),
      " (",
      invoiceLink(change.invoiceId),
      ")",
    ),
    (change.from !== null || change.to !== null) &&
      h("p", null, change.from !== null ? `From account ${change.from}` : "From an account not on file", change.to !== null ? ` to account ${change.to}` : ""),
    h("p", { class: "supplier-item__sub" }, "Recorded ", whenNode(change.recordedAt)),
    change.barred.length > 0 && h("p", { class: "hint hint--caution" }, `${change.barred.map(whyText).join(", ")} cannot approve payments to it`),
  );
}

function supplierEmails(detail) {
  const withEmails = detail.invoices.filter((invoice) => invoice.emails !== null);
  const inbox = Array.isArray(detail.inbox) ? detail.inbox : [];
  return [
    withEmails.length > 0 &&
      h(
        "ul",
        { class: "supplier-list" },
        withEmails.map((invoice) =>
          h(
            "li",
            { class: "supplier-item" },
            h("p", { class: "supplier-item__top" }, h("strong", null, invoiceLink(invoice.invoiceId))),
            h(
              "p",
              null,
              countText(invoice.emails.count, "email", "emails"),
              invoice.emails.partlyUnread > 0 ? `, ${invoice.emails.partlyUnread} partly unread` : "",
              invoice.emails.sendersFlagged > 0 ? `, ${countText(invoice.emails.sendersFlagged, "sender", "senders")} flagged` : "",
            ),
            invoice.emails.findings !== null &&
              h(
                "p",
                { class: "supplier-item__sub" },
                `Found: ${invoice.emails.findings.summary}`,
                invoice.emails.findings.readBy !== null ? ` (read by ${whyText(invoice.emails.findings.readBy)})` : "",
              ),
          ),
        ),
      ),
    inbox.length > 0 && h("h3", { class: "supplier__sub" }, "Waiting in the inbox"),
    inbox.length > 0 &&
      h(
        "ul",
        { class: "supplier-list" },
        inbox.map((upload) =>
          h(
            "li",
            { class: "supplier-item supplier-item--line" },
            h("a", { href: `#inbox/${upload.uploadId}` }, `Email ${upload.uploadId}`),
            " names ",
            joinedNodes(upload.invoices.map(invoiceLink)),
            upload.suggested ? ". The inbox offers it to one of them first" : "",
          ),
        ),
      ),
  ];
}

function draftNode(draft) {
  const moves = [
    draft.copiedBy !== null ? [`copied by ${whyText(draft.copiedBy)} `, whenNode(draft.copiedAt)] : null,
    draft.sentBy !== null ? [`marked sent by ${whyText(draft.sentBy)} `, whenNode(draft.sentAt)] : null,
    draft.dismissedBy !== null ? [`dismissed by ${whyText(draft.dismissedBy)} `, whenNode(draft.dismissedAt)] : null,
  ].filter((move) => move !== null);
  return h(
    "li",
    { class: "supplier-item" },
    h(
      "p",
      { class: "supplier-item__top" },
      h("strong", null, draft.label ?? "A message PayOnce has no template for"),
      badge(DRAFT_STATES[draft.state], draft.state),
      draft.audience !== null && h("span", { class: "tag" }, `For the ${(AUDIENCES[draft.audience] ?? humanize(draft.audience)).toLowerCase()}`),
    ),
    h("p", null, `Draft ${draft.id} on `, invoiceLink(draft.invoiceId), `, created by ${whyText(draft.createdBy)} `, whenNode(draft.createdAt)),
    moves.length > 0 && h("p", { class: "supplier-item__sub" }, "Then ", joinedNodes(moves, ", ")),
  );
}

function duplicateNodeOf(group) {
  return h(
    "li",
    { class: "supplier-item" },
    h("p", { class: "supplier-item__top" }, h("strong", null, group.kind === "same-bill" ? "Same bill" : "Same number, other amount or currency")),
    h(
      "ul",
      { class: "supplier-payments" },
      group.invoices.map((member) =>
        h(
          "li",
          { class: "supplier-payment" },
          h(
            "span",
            { class: "supplier-payment__top" },
            invoiceLink(member.invoiceId),
            badge(OBLIGATION_STATES[member.state], member.state),
            h("span", null, formatMoney(member.amountMinor, member.currency)),
            member.held && h("span", { class: "tag" }, "Held as a second bill"),
            !member.thisRecord && supplierLink(member.key, "another record"),
          ),
        ),
      ),
    ),
  );
}

function supplierOutages(detail) {
  const outages = detail.outages ?? { active: [], holds: [], failures: [] };
  return [
    outages.active.map((outage) =>
      h(
        "div",
        { class: "caution" },
        icon("outage"),
        h("p", { class: "caution__title" }, `Outage ${outage.id}${outage.rail === null ? "" : ` on ${outage.rail}`} is active`),
        h(
          "p",
          { class: "supplier-caution__links" },
          "Since ",
          sinceNode(outage.declaredAt),
          ". It holds ",
          joinedNodes(outage.invoices.map(invoiceLink)),
          ". ",
          h("a", { href: "#" }, "End it on the board"),
        ),
      ),
    ),
    outages.holds.length > 0 &&
      h(
        "ul",
        { class: "supplier-list" },
        outages.holds.map((hold) =>
          h(
            "li",
            { class: "supplier-item supplier-item--line" },
            `Outage ${hold.outageId}${hold.rail === null ? "" : ` on ${hold.rail}`} held `,
            hold.invoiceId !== null ? invoiceLink(hold.invoiceId) : runLink(hold.runId),
            ` (${HOLD_WORDS[hold.what] ?? humanize(hold.what)}) `,
            whenNode(hold.heldAt),
            hold.state === "ended" ? [". Ended ", whenNode(hold.endedAt)] : ". Still active",
          ),
        ),
      ),
    outages.failures.length > 0 && h("h3", { class: "supplier__sub" }, "Rail failures"),
    outages.failures.length > 0 &&
      h(
        "ul",
        { class: "supplier-list" },
        outages.failures.map((failure) =>
          h(
            "li",
            { class: "supplier-item supplier-item--line" },
            failure.reference === null ? "A payout" : h("span", { class: "mono" }, failure.reference),
            ` failed with ${failure.code === null ? "a code PayOnce does not show" : `${failure.code} (${failure.codeWords ?? "rail failure"})`} `,
            whenNode(failure.failedAt),
            failure.invoiceId !== null ? [" on ", invoiceLink(failure.invoiceId)] : "",
            failure.outageId !== null ? `. Outage ${failure.outageId} counted it` : "",
          ),
        ),
      ),
  ];
}

function supplierRunRow(row) {
  const facts = [
    row.account !== null ? `account ${row.account}` : null,
    row.newPayee ? "new payee" : null,
    row.callbackVerified ? "account verified by a callback" : null,
    row.action === "skip" ? `skipped for ${countText(row.skipReasons, "reason", "reasons")}` : null,
  ].filter((part) => part !== null);
  return h(
    "li",
    { class: "supplier-item" },
    h(
      "p",
      { class: "supplier-item__top" },
      runLink(row.runId),
      `row ${row.line}`,
      badge(row.runState === "waiting" ? { label: "Waiting", tone: "waiting" } : RUN_STATES[row.runState], row.runState),
      h("span", { class: "supplier-item__amount" }, typeof row.amountMinor === "number" ? formatMoney(row.amountMinor, row.currency ?? "") : ""),
    ),
    h(
      "p",
      null,
      row.invoiceId === null ? "No invoice number" : invoiceLink(row.invoiceId),
      `, ${row.action === "pay" ? "pays" : "skipped"}, row ${row.state}`,
      facts.length > 0 ? `, ${facts.join(", ")}` : "",
    ),
  );
}

function renderSupplierDetail(detail) {
  els.supplierHeader.replaceChildren(...supplierHeader(detail));
  fillCard(els.supplierCautions, "Cautions", detail.cautions.map(cautionNode));
  fillCard(
    els.supplierMoney,
    "Money at risk now",
    detail.money.length === 0 ? [h("p", { class: "empty" }, "Nothing at risk.")] : detail.money.map(buildBoardTotal),
  );
  fillCard(
    els.supplierAccounts,
    "Accounts",
    detail.accounts.length === 0
      ? [h("p", { class: "empty" }, "PayOnce has not kept an account for this record.")]
      : [h("ul", { class: "supplier-list" }, detail.accounts.map(accountNode))],
  );
  fillCard(els.supplierInvoices, "Invoices", detail.invoices.length === 0 ? [] : supplierInvoices(detail));
  fillCard(
    els.supplierChanges,
    "Bank details callbacks",
    detail.bankChanges.length === 0 ? [] : [h("ul", { class: "supplier-list" }, detail.bankChanges.map(bankChangeNode))],
  );
  fillCard(els.supplierEmails, "Supplier emails", supplierEmails(detail));
  fillCard(
    els.supplierMessages,
    "Messages",
    detail.drafts.length === 0 ? [] : [h("ul", { class: "supplier-list" }, detail.drafts.map(draftNode))],
  );
  fillCard(
    els.supplierDuplicates,
    "Likely duplicates",
    detail.duplicates.length === 0 ? [] : [h("ul", { class: "supplier-list" }, detail.duplicates.map(duplicateNodeOf))],
  );
  fillCard(els.supplierOutages, "Outages", supplierOutages(detail));
  fillCard(
    els.supplierRuns,
    "Pay runs",
    detail.runs.length === 0 ? [] : [h("ul", { class: "supplier-list" }, detail.runs.map(supplierRunRow))],
  );
}

function renderSupplierMain() {
  const key = supplierKeyOf(state.selectedId);
  const detail = currentSupplier();
  if (detail === null) {
    if (state.supplierError === null && Date.now() - state.selectedAt < LOADING_DELAY_MS) {
      return;
    }
    setText(els.placeholderTitle, state.supplierError === null ? "Loading the supplier record" : "Could not load this supplier record");
    setText(els.placeholderText, state.supplierError ?? `Record ${key}`);
    els.supplierDetail.hidden = true;
    els.placeholder.hidden = false;
    showMessage(els.connection, null);
    return;
  }
  showMessage(
    els.connection,
    state.supplierError === null ? null : `Could not refresh this supplier record. ${state.supplierError}`,
  );
  const { generatedAt, ...shown } = detail;
  if (changed("supplier", shown)) {
    renderSupplierDetail(detail);
  }
  els.placeholder.hidden = true;
  els.supplierDetail.hidden = false;
}

// ---------- incident board ----------

const BOARD_ALL = { group: "All groups", currency: "All wallets", origin: "All origins" };

// One active outage at the top of the board: what it saw, what it holds now and
// the money those entries have at risk, as GET /api/board works them out from
// the cash panel's lines, and the end form the Outages card has.
function buildBoardOutage(outage, enders) {
  const list = (value) => (Array.isArray(value) ? value : []);
  const codes = list(outage.codes)
    .map((entry) => `${entry.code} (${entry.label})`)
    .join(", ");
  const atRisk = list(outage.atRisk);
  const since = zonedTime(outage.declaredAt);
  const held = [
    ["First payments waiting", list(outage.originals), (id) => outageLink(id, null)],
    ["Replacements escalated", list(outage.replacements), (id) => outageLink(id, null)],
    ["Approved payments waiting", list(outage.approved), (id) => outageLink(id, null)],
    ["Pay runs waiting", list(outage.runs), (id) => outageLink(null, id)],
  ];
  const titleId = `board-outage-${outage.id}-title`;
  return h(
    "section",
    { class: "card board-outage", "aria-labelledby": titleId },
    h(
      "div",
      { class: "approval__head" },
      h("h2", { id: titleId, class: "outage__title" }, `Outage ${outage.id} on ${outage.rail}`),
      badge(OUTAGE_STATES.active, "active", false),
    ),
    h("p", { class: "outage__text" }, withPeriod(outage.text)),
    h(
      "dl",
      { class: "facts approval__status" },
      h("dt", null, "Since"),
      h("dd", null, since ?? "Not on file"),
      h("dt", null, "Failure codes"),
      h("dd", null, codes === "" ? "None on file" : codes),
      h("dt", null, "Payees"),
      h("dd", null, `${outage.payees} failed within ${outage.windowMinutes} minutes`),
      held.map(([label, items, build]) => [
        h("dt", null, label),
        h("dd", null, items.length === 0 ? "None" : listNodes(items, build)),
      ]),
      h("dt", null, "At risk"),
      h("dd", null, atRisk.length === 0 ? "Nothing" : atRisk.map(boardMoneyText).join(", ")),
    ),
    buildEndForm(outage, enders, "board"),
  );
}

// The slot at the top of the board: every active outage, whatever the filters.
// It is built again when the board comes back on screen, so a name or note typed
// on the Outages card meanwhile is in its form.
function renderBoardOutages() {
  const outages = Array.isArray(state.board?.outages) ? state.board.outages : [];
  const enders = Array.isArray(state.outages?.enders) ? state.outages.enders : null;
  if (changed("boardOutages", [outages, enders, state.outages?.endRefused ?? null, state.selectedAt])) {
    const focus = focusedControl(els.boardOutages);
    outageRefs.board = new Map();
    els.boardOutages.replaceChildren(...outages.map((outage) => buildBoardOutage(outage, enders)));
    els.boardOutages.hidden = outages.length === 0;
    restoreFocus(focus);
  }
  syncOutages();
}

function renderBoardFilters(board) {
  const chosen = state.boardFilters;
  const currencies = new Set(Array.isArray(board?.currencies) ? board.currencies : []);
  if (chosen.currency !== "") {
    currencies.add(chosen.currency);
  }
  const lists = {
    group: (Array.isArray(board?.groups) ? board.groups : []).map((entry) => ({ value: entry.group, label: entry.label })),
    currency: [...currencies].sort().map((code) => ({ value: code, label: code })),
    origin: (Array.isArray(board?.origins) ? board.origins : []).map((entry) => ({ value: entry.origin, label: entry.label })),
  };
  const selects = { group: els.boardGroup, currency: els.boardCurrency, origin: els.boardOrigin };
  if (changed("boardFilters", lists)) {
    for (const [name, select] of Object.entries(selects)) {
      fillSelect(select, [{ value: "", label: BOARD_ALL[name] }, ...lists[name]]);
    }
  }
  for (const [name, select] of Object.entries(selects)) {
    if (select.value !== chosen[name]) {
      select.value = chosen[name];
    }
  }
}

function boardMoneyText(money) {
  const notes = [];
  if (money.estimated === true) {
    notes.push("estimated");
  }
  if (money.feeUnknown > 0) {
    notes.push("fee not known");
  }
  return `${formatMoney(money.minor, money.currency)}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}

function buildBoardTotal(total) {
  const parts = [
    [total.promisedMinor, "approved or being sent"],
    [total.waitingMinor, "waiting on a person"],
    [total.outageMinor, "waiting on an outage"],
    [total.runWaitingMinor, "pay run waiting for approval"],
    [total.withBankMinor, "with the bank"],
  ]
    .filter(([minor]) => typeof minor === "number" && minor !== 0)
    .map(([minor, what]) => `${what} ${cashAmount(minor)}`);
  const notes = [];
  if (total.estimated === true) {
    notes.push("part estimated");
  }
  if (total.feeUnknown > 0) {
    notes.push(total.feeUnknown === 1 ? "1 fee not known" : `${total.feeUnknown} fees not known`);
  }
  return h(
    "div",
    { class: "board-total" },
    h("span", { class: "board-total__code" }, total.currency),
    h("span", { class: "board-total__value" }, cashAmount(total.minor)),
    h("span", { class: "board-total__parts" }, `${parts.join(", ")}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`),
  );
}

function boardWhen(value) {
  const date = parseDate(value);
  if (date === null) {
    return null;
  }
  return minuteText(date);
}

// How long since PayOnce took the invoice on, against when the server answered.
function waitedText(since, now) {
  const at = parseDate(since);
  const reference = parseDate(now) ?? new Date();
  if (at === null) {
    return "Waiting since a time not on file";
  }
  const minutes = Math.max(0, Math.floor((reference.getTime() - at.getTime()) / 60000));
  if (minutes < 1) {
    return "Waiting under a minute";
  }
  if (minutes < 60) {
    return `Waiting ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `Waiting ${hours} h` : `Waiting ${Math.floor(hours / 24)} days`;
}

function buildBoardEntry(entry, now) {
  const run = entry.kind === "run-row";
  const href = run ? `#run/${entry.runId}` : `#${encodeURIComponent(entry.invoiceId)}`;
  const amount =
    entry.wallet === entry.currency
      ? formatMoney(entry.amountMinor, entry.currency)
      : `${formatMoney(entry.amountMinor, entry.currency)}, paid from ${entry.wallet}`;
  const origin = run
    ? `Pay run ${entry.runId}, not released`
    : entry.origin === "pay-run"
      ? `Pay run ${entry.runId}`
      : entry.origin === "outside"
        ? "Sent outside PayOnce"
        : null;
  const atRisk = Array.isArray(entry.atRisk) ? entry.atRisk : [];
  const deadline = boardWhen(entry.deadlineAt);
  const passed = deadline !== null && (parseDate(entry.deadlineAt)?.getTime() ?? 0) <= (parseDate(now)?.getTime() ?? Date.now());
  const key = `${entry.kind}-${entry.runId ?? ""}-${entry.invoiceId}`.replace(/[^A-Za-z0-9-]/g, "_");
  return h(
    "li",
    { class: "board-entry" },
    h(
      "a",
      { class: "board-entry__link", href, id: `board-${key}` },
      h(
        "span",
        { class: "board-entry__top" },
        h("span", { class: "board-entry__id" }, entry.invoiceId),
        origin !== null && h("span", { class: "tag" }, origin),
        typeof entry.outage === "object" &&
          entry.outage !== null &&
          h("span", { class: "tag tag--caution" }, `Outage ${entry.outage.id} on ${entry.outage.rail}`),
        h(
          "span",
          { class: atRisk.length === 0 ? "board-entry__risk is-empty" : "board-entry__risk" },
          atRisk.length === 0 ? "Nothing at risk" : `${atRisk.map(boardMoneyText).join(", ")} at risk`,
        ),
      ),
      h(
        "span",
        { class: "board-entry__meta" },
        h("span", { class: "board-entry__amount" }, amount),
        h("span", { class: "board-entry__age", "data-board-since": entry.waitingSince ?? "" }),
      ),
      h(
        "span",
        { class: "board-entry__why" },
        withPeriod(entry.why),
        deadline !== null && (passed ? ` The deadline was ${deadline}.` : ` Bank deadline ${deadline}.`),
      ),
      (Array.isArray(entry.also) ? entry.also : []).map((line) =>
        h("span", { class: "board-entry__also" }, `Also: ${withPeriod(line)}`),
      ),
    ),
    // Outside the entry's own link, since a link cannot hold another.
    h("p", { class: "board-entry__supplier" }, supplierLink(entry.beneficiaryId, whyText(entry.supplier))),
  );
}

function buildBoardGroup(group, entries, now) {
  return h(
    "section",
    { class: `card board-group board-group--${group.group}`, "aria-label": group.label },
    h("h2", { class: "board-group__head" }, group.label, h("span", { class: "board-group__count" }, String(group.count))),
    entries.length === 0
      ? h("p", { class: "empty" }, "None")
      : h("ol", { class: "board-list" }, entries.map((entry) => buildBoardEntry(entry, now))),
  );
}

function renderBoard() {
  const board = state.board;
  renderBoardOutages();
  renderBoardFilters(board);
  showMessage(els.boardError, state.boardError);
  // An empty ledger gets the hint the page showed before the board existed.
  els.boardEmpty.hidden = board === null || board.invoices !== 0;
  if (board === null) {
    if (changed("board", null)) {
      els.boardTotals.replaceChildren(h("p", { class: "empty" }, "Loading"));
      els.boardGroups.replaceChildren();
    }
    return;
  }
  if (changed("board", [board.filters, board.totals, board.groups, board.entries, board.all, board.invoices])) {
    const focus = focusedControl(els.boardGroups);
    els.boardTotals.replaceChildren(
      ...(board.totals.length > 0
        ? board.totals.map(buildBoardTotal)
        : [
            h(
              "p",
              { class: "empty" },
              board.invoices === 0
                ? "None."
                : board.all === 0
                  ? "None. Every invoice in the ledger is closed."
                  : "None in what is shown.",
            ),
          ]),
    );
    const only = board.filters?.group ?? null;
    els.boardGroups.replaceChildren(
      ...board.groups
        .filter((group) => only === null || group.group === only)
        .map((group) => buildBoardGroup(group, board.entries.filter((entry) => entry.group === group.group), board.generatedAt)),
    );
    restoreFocus(focus);
  }
  for (const node of els.boardGroups.querySelectorAll("[data-board-since]")) {
    setText(node, waitedText(node.dataset.boardSince, board.generatedAt));
  }
}

// ---------- cash panel ----------

const WAITING_KINDS = ["awaiting-approval", "awaiting-person"];

function cashAmount(minor) {
  return typeof minor === "number" && Number.isFinite(minor) ? formatMoney(minor, "") : "Unknown";
}

// How long ago an ISO time was, measured against when the server answered.
function since(value, now) {
  const at = parseDate(value);
  const reference = parseDate(now) ?? new Date();
  if (at === null) {
    return null;
  }
  const seconds = Math.max(0, Math.round((reference.getTime() - at.getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds} s ago`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min ago`;
  }
  return `at ${stampText(at)}`;
}

function cashFreshness(cash) {
  if (cash === null) {
    return state.cashError === null ? "Loading" : "";
  }
  const airwallex = cash.airwallex;
  const read =
    airwallex.readAt === null
      ? airwallex.refreshing
        ? "Reading balances from Airwallex."
        : "Airwallex balances not read yet."
      : airwallex.refreshing
        ? `Airwallex balances read ${since(airwallex.readAt, cash.generatedAt)}, reading them again now.`
        : `Airwallex balances read ${since(airwallex.readAt, cash.generatedAt)}, read again at most every ${airwallex.maxAgeSeconds} s while this page is open.`;
  const checked = since(cash.ledger.statesCheckedAt, cash.generatedAt);
  return `${read} ${checked === null ? "Payment states not checked yet." : `Payment states checked ${checked}.`}`;
}

function cashProblems(cash) {
  const problems = [];
  if (state.cashError !== null) {
    problems.push(state.cashError);
  }
  if (cash === null) {
    return problems;
  }
  const error = cash.airwallex.error;
  if (error !== null && typeof error === "object") {
    const failedAt = parseDate(error.at);
    const readAt = parseDate(cash.airwallex.readAt);
    const when = failedAt === null ? "" : ` at ${stampText(failedAt)}`;
    problems.push(
      readAt === null
        ? `Airwallex could not be read${when}: ${withPeriod(error.message)} PayOnce's own figures are current.`
        : `The last read${when} failed: ${withPeriod(error.message)} The panel shows the read from ${stampText(readAt)}.`,
    );
  }
  if (typeof cash.floors?.problem === "string" && cash.floors.problem !== "") {
    problems.push(
      `Every reserve floor is unreadable, so every automatic replacement goes to a person. ${withPeriod(sentence(cash.floors.problem))}`,
    );
  }
  return problems;
}

function cashLinesOf(currency, kinds) {
  return (Array.isArray(currency.lines) ? currency.lines : []).filter((line) => kinds.includes(line.kind));
}

function cashTotal(lines) {
  return lines.reduce((sum, line) => sum + line.amountMinor + line.feeMinor, 0);
}

// Links to the invoices behind a line, five at most. A pay run row not released
// yet has no invoice to open, so it links to its run.
function invoiceLinks(lines) {
  const hrefs = new Map();
  for (const line of lines) {
    const id = String(line.invoiceId);
    if (!hrefs.has(id)) {
      const fromRun = line.kind === "pay-run" && Number.isInteger(line.runId);
      const released = (state.incidents ?? []).some((incident) => incident.invoiceId === id);
      hrefs.set(id, fromRun && !released ? `#run/${line.runId}` : `#${encodeURIComponent(id)}`);
    }
  }
  const ids = [...hrefs.keys()];
  const parts = [];
  ids.slice(0, CASH_INVOICES_SHOWN).forEach((id, index) => {
    if (index > 0) {
      parts.push(", ");
    }
    parts.push(h("a", { href: hrefs.get(id) }, id));
  });
  if (ids.length > CASH_INVOICES_SHOWN) {
    parts.push(` and ${ids.length - CASH_INVOICES_SHOWN} more`);
  }
  return parts;
}

function cashRow(label, detail, amount, tone) {
  const hasDetail = Array.isArray(detail) ? detail.length > 0 : detail !== null && detail !== "";
  return h(
    "div",
    { class: tone ? `cash-row ${tone}` : "cash-row" },
    h("dt", null, label, hasDetail && h("span", { class: "cash-row__detail" }, detail)),
    h("dd", null, amount),
  );
}

// A line of money with the invoices it is for. Money headroom takes off reads "- ".
function moneyRow(currency, label, kinds, subtract) {
  const lines = cashLinesOf(currency, kinds);
  const unknown = lines.filter((line) => line.feeKnown !== true).length;
  const notes = [];
  if (unknown > 0) {
    notes.push(unknown === lines.length ? "fee not known" : `fee not known for ${unknown}`);
  }
  if (lines.some((line) => line.estimated === true && line.fromQuote !== true)) {
    notes.push("amount estimated");
  }
  if (lines.some((line) => line.fromQuote === true)) {
    notes.push(
      lines.some((line) => line.fromQuote === true && line.estimated === true)
        ? "estimated from an exchange rate quote"
        : "amount from an exchange rate quote",
    );
  }
  const detail = [...invoiceLinks(lines), notes.length > 0 ? ` (${notes.join(", ")})` : null];
  return cashRow(
    label,
    lines.length === 0 ? null : detail,
    `${subtract ? "- " : ""}${cashAmount(cashTotal(lines))}`,
    lines.length === 0 ? "is-empty" : null,
  );
}

function headroomTone(minor) {
  if (typeof minor !== "number") {
    return "is-unknown";
  }
  return minor < 0 ? "is-negative" : null;
}

function cashGroup(tag, tone, when, ...rows) {
  return h(
    "div",
    { class: "cash-group" },
    h(
      "p",
      { class: "cash-group__head" },
      h("span", { class: `source source--${tone}` }, tag),
      when,
    ),
    rows,
  );
}

function floorText(floor) {
  if (floor.source === "setting") {
    return cashAmount(floor.minor);
  }
  return floor.source === "not-set" ? "Not set" : "Unreadable";
}

// One count per kind of money that has any, for the closed summary.
function cashCounts(currency) {
  const count = (kinds) => cashLinesOf(currency, kinds).length;
  return [
    [count(["sending"]), "being sent"],
    [count(["approved"]), "approved"],
    [count(WAITING_KINDS), "waiting"],
    [count(["waiting-outage"]), "waiting on an outage"],
    [count(["with-bank"]), "with the bank"],
    [count(["outside"]), "sent outside PayOnce"],
  ]
    .filter(([number]) => number > 0)
    .map(([number, what]) => `${number} ${what}`)
    .join(", ");
}

// Until the person opens or closes it, a currency is open when money in it is
// promised or waiting on a person, or a headroom is below 0, so the panel stays
// short enough to leave the incident in view.
function cashOpen(currency) {
  const stored = readCashOpen()[currency.currency];
  if (typeof stored === "boolean") {
    return stored;
  }
  const below = (minor) => typeof minor === "number" && minor < 0;
  return (
    cashLinesOf(currency, ["sending", "approved", "pay-run", "waiting-outage", ...WAITING_KINDS]).length > 0 ||
    below(currency.headroomMinor) ||
    below(currency.headroomIfApprovedMinor)
  );
}

function buildCurrency(currency, cash) {
  const code = String(currency.currency);
  const balance = currency.airwallex;
  const floor = currency.floor ?? { minor: null, source: "unreadable", invoiceFloors: [] };
  const neverRead = cash.airwallex.readAt === null;
  const available = balance === null ? (neverRead ? "Not read" : `No ${code} balance`) : cashAmount(balance.availableMinor);

  const summary = h(
    "summary",
    { class: "cash-currency__summary", id: `cash-summary-${code}` },
    h("span", { class: "cash-currency__code" }, code),
    h(
      "span",
      { class: "cash-stat" },
      h("span", { class: "cash-stat__label" }, "Available"),
      h("span", { class: "cash-stat__value" }, available),
      h("span", { class: "source source--airwallex" }, "Airwallex"),
    ),
    h(
      "span",
      { class: floor.source === "setting" ? "cash-stat" : "cash-stat is-unknown" },
      h("span", { class: "cash-stat__label" }, "Floor"),
      h("span", { class: "cash-stat__value" }, floorText(floor)),
    ),
    h(
      "span",
      { class: `cash-stat ${headroomTone(currency.headroomMinor) ?? ""}`.trim() },
      h("span", { class: "cash-stat__label" }, "Headroom"),
      h("span", { class: "cash-stat__value" }, cashAmount(currency.headroomMinor)),
    ),
    h("span", { class: "cash-currency__counts" }, cashCounts(currency)),
  );

  const airwallexRows = [cashRow("Available", null, available, balance === null ? "is-unknown" : null)];
  if (balance !== null) {
    if (typeof balance.reservedMinor === "number") {
      airwallexRows.push(cashRow("Held for outgoing payments", "reserved", cashAmount(balance.reservedMinor), "is-aside"));
    }
    if (typeof balance.pendingMinor === "number") {
      airwallexRows.push(cashRow("Settling in", "pending conversions", cashAmount(balance.pendingMinor), "is-aside"));
    }
    if (typeof balance.prepaymentMinor === "number" && balance.prepaymentMinor !== 0) {
      airwallexRows.push(
        cashRow("Held for future-dated payments", "prepayment", cashAmount(balance.prepaymentMinor), "is-aside"),
      );
    }
    if (typeof balance.totalMinor === "number") {
      airwallexRows.push(cashRow("Total", null, cashAmount(balance.totalMinor), "is-aside"));
    }
  }

  const floorRow =
    floor.source === "setting"
      ? cashRow("Reserve floor", null, `- ${cashAmount(floor.minor)}`)
      : floor.source === "not-set"
        ? cashRow("Reserve floor", `not set, so every automatic replacement in ${code} goes to a person`, "- 0.00", "is-unknown")
        : cashRow("Reserve floor", "could not be read", "Unknown", "is-unknown");
  const invoiceFloors = (Array.isArray(floor.invoiceFloors) ? floor.invoiceFloors : []).map((own) =>
    h(
      "p",
      { class: "cash-note" },
      h("a", { href: `#${encodeURIComponent(own.invoiceId)}` }, own.invoiceId),
      ` has a stricter floor of its own: ${cashAmount(own.floorMinor)}`,
    ),
  );

  const fees = cashLinesOf(currency, ["fee-lost"]);
  const feesUnknown = fees.filter((line) => line.feeKnown !== true).length;
  const feesKnown = fees.length - feesUnknown;
  const ledgerRows = [
    moneyRow(currency, "Being sent, no transfer yet", ["sending"], true),
    moneyRow(currency, "Approved, not sent yet", ["approved"], true),
    cash.payRuns === null
      ? cashRow("Approved pay runs not sent yet", "Pay runs are not built yet", "", "is-empty")
      : moneyRow(currency, "Approved pay runs not sent yet", ["pay-run"], true),
    cashRow("= Headroom", null, cashAmount(currency.headroomMinor), `is-total ${headroomTone(currency.headroomMinor) ?? ""}`.trim()),
    moneyRow(currency, "Waiting on a person", WAITING_KINDS, true),
    moneyRow(currency, "Waiting on an outage, sent once it ends", ["waiting-outage"], true),
    cashRow(
      "= Headroom if every waiting payment is approved",
      null,
      cashAmount(currency.headroomIfApprovedMinor),
      `is-total ${headroomTone(currency.headroomIfApprovedMinor) ?? ""}`.trim(),
    ),
  ];
  const outRows = [
    moneyRow(currency, "With the bank", ["with-bank"], false),
    moneyRow(currency, "Payouts sent outside PayOnce", ["outside"], false),
    cashRow(
      "Fees on failed transfers",
      feesKnown === 0 ? null : `${feesKnown} ${feesKnown === 1 ? "transfer" : "transfers"}`,
      cashAmount(cashTotal(fees)),
      fees.length === 0 ? "is-empty" : null,
    ),
  ];

  const body = h(
    "div",
    { class: "cash-currency__body" },
    h(
      "div",
      { class: "cash-column" },
      cashGroup(
        "Airwallex",
        "airwallex",
        h("span", { class: "cash-group__when", "data-cash-age": "airwallex" }),
        h("dl", { class: "cash__rows" }, airwallexRows),
      ),
      cashGroup(
        "Setting",
        "setting",
        h("span", { class: "cash-group__when mono" }, "RESERVE_FLOORS"),
        h("dl", { class: "cash__rows" }, floorRow),
        invoiceFloors,
      ),
    ),
    h(
      "div",
      { class: "cash-column" },
      cashGroup(
        "PayOnce ledger",
        "ledger",
        h("span", { class: "cash-group__when", "data-cash-age": "ledger" }),
        h("dl", { class: "cash__rows" }, ledgerRows),
        h("p", { class: "cash-group__sub" }, "Already out of available, not subtracted again"),
        h("dl", { class: "cash__rows" }, outRows),
        feesUnknown > 0 &&
          h(
            "p",
            { class: "cash-note" },
            `${feesUnknown} failed ${feesUnknown === 1 ? "transfer has" : "transfers have"} no fee recorded yet.`,
          ),
        feesKnown > 0 && h("p", { class: "cash-note" }, "The sandbox keeps the fee when a transfer fails."),
      ),
    ),
  );

  const details = h("details", { class: "cash-currency", "data-currency": code }, summary, body);
  details.open = cashOpen(currency);
  // Stored on the person's click only, so a currency opened by default follows the
  // default until someone chooses.
  summary.addEventListener("click", () => {
    storeCashOpen(code, !details.open);
  });
  return details;
}

// The ages change on every poll, so they are set on their own nodes and do not
// redraw the panel.
function renderCashAges(cash) {
  const airwallex = cash.airwallex;
  const read =
    airwallex.readAt === null
      ? airwallex.refreshing
        ? "reading now"
        : "not read yet"
      : `read ${since(airwallex.readAt, cash.generatedAt)}${airwallex.refreshing ? ", reading again now" : ""}`;
  const checked = since(cash.ledger.statesCheckedAt, cash.generatedAt);
  const ledger = checked === null ? "as of now" : `as of now, payment states checked ${checked}`;
  for (const node of els.cashCurrencies.querySelectorAll("[data-cash-age]")) {
    setText(node, node.dataset.cashAge === "airwallex" ? read : ledger);
  }
}

function renderCash() {
  const cash = state.cash;
  setText(els.cashFresh, cashFreshness(cash));
  const problems = cashProblems(cash);
  if (changed("cashProblems", problems)) {
    els.cashProblem.replaceChildren(...problems.map((problem) => h("p", null, problem)));
    els.cashProblem.hidden = problems.length === 0;
  }
  if (cash === null) {
    return;
  }
  if (changed("cash", [cash.currencies, cash.payRuns, cash.floors, cash.airwallex.readAt === null])) {
    const focus = focusedControl(els.cashCurrencies);
    els.cashCurrencies.replaceChildren(
      ...(cash.currencies.length === 0
        ? [h("p", { class: "empty" }, "No currency has a floor, a balance or a payment in the ledger.")]
        : cash.currencies.map((currency) => buildCurrency(currency, cash))),
    );
    restoreFocus(focus);
  }
  renderCashAges(cash);
}

// ---------- outages ----------

// An active outage's end form is on the Outages card above the cash panel, or in
// the slot at the top of the board. Each place keeps its own forms, ids and
// messages. The names and notes typed are shared, by outage.
const OUTAGE_PLACES = {
  card: { section: "outages", prefix: "outage" },
  board: { section: "boardOutages", prefix: "board-outage" },
};

const outageRefs = { card: new Map(), board: new Map() };

function recentlyEnded(view, now) {
  const ended = parseDate(view.endedAt);
  return ended !== null && now - ended.getTime() < OUTAGE_ENDED_SHOWN_MS;
}

function outageLink(invoiceId, runId) {
  return invoiceId !== null && invoiceId !== undefined
    ? h("a", { href: `#${encodeURIComponent(invoiceId)}` }, invoiceId)
    : h("a", { href: `#run/${runId}` }, `pay run ${runId}`);
}

function listNodes(items, build) {
  return items.flatMap((item, index) => (index === 0 ? [build(item)] : [", ", build(item)]));
}

// What ending an outage sends, per currency, from the figures the board slot
// shows: "2 payments totalling 1,700.00 USD and 1 payment totalling 400.00 EUR".
function sendsText(sends) {
  const parts = (Array.isArray(sends) ? sends : []).map(
    (send) =>
      `${send.payments} ${send.payments === 1 ? "payment" : "payments"} totalling ${formatMoney(send.minor, send.currency)}${send.estimated === true ? " (estimated)" : ""}`,
  );
  return parts.length <= 1 ? (parts[0] ?? null) : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// What ending it does, in the end form.
function endEffect(view) {
  const sends = sendsText(view.sends);
  return sends === null
    ? `Ending it lets PayOnce open payments on ${view.rail} again. It holds no first payment or approved payment, so ending it sends nothing by itself.`
    : `Ending it sends ${sends} and lets PayOnce open payments on ${view.rail} again. A first payment goes out after the checks made before any payment, and an approved payment if its approval still counts.`;
}

// The form a person ends an outage with: a name from the approver list, or any
// name when no list is set, and a note. While the approval settings cannot be
// read nobody may end one, and PayOnce's reason is shown instead.
function buildEndForm(view, enders, place) {
  const refused = typeof state.outages?.endRefused === "string" ? state.outages.endRefused : null;
  if (refused !== null) {
    return h("p", { class: "hint" }, refused);
  }
  const prefix = `${OUTAGE_PLACES[place].prefix}-${view.id}`;
  const draft = state.outageDrafts.get(view.id) ?? {};
  const remember = () => {
    state.outageDrafts.set(view.id, { name: name.value, note: note.value });
    if (state.outageError !== null) {
      state.outageError = null;
      syncOutages();
    }
  };
  const name =
    enders === null
      ? h("input", { type: "text", id: `${prefix}-name`, autocomplete: "name", maxlength: "80" })
      : h(
          "select",
          { id: `${prefix}-name` },
          h("option", { value: "" }, "Choose your name"),
          enders.map((ender) => h("option", { value: ender }, ender)),
        );
  name.value =
    enders === null
      ? (draft.name ?? readStoredName())
      : (enders.find((ender) => sameName(ender, draft.name ?? readStoredName())) ?? "");
  name.addEventListener(enders === null ? "input" : "change", remember);
  const note = h("input", { type: "text", id: `${prefix}-note`, autocomplete: "off", maxlength: "200" });
  note.value = draft.note ?? "";
  note.addEventListener("input", remember);
  const label = `End outage on ${view.rail}`;
  const button = h("button", { class: "button button--primary", type: "submit" }, label);
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const form = h(
    "form",
    { class: "close-form", novalidate: true },
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Your name"), name),
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Why it is over"), note),
    button,
    error,
    h(
      "p",
      { class: "hint" },
      enders === null
        ? "No approver list is set, so any named person may end it. Nothing ends an outage by itself."
        : "Only a name on the approver list may end it. Nothing ends an outage by itself.",
    ),
    h("p", { class: "hint" }, endEffect(view)),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitEndOutage(view.id, place);
  });
  outageRefs[place].set(view.id, { name, note, button, error, label });
  return form;
}

function buildOutage(view, enders) {
  const codes = (Array.isArray(view.codes) ? view.codes : [])
    .map((entry) => `${entry.code} (${entry.label})`)
    .join(", ");
  const counted = Array.isArray(view.counted) ? view.counted : [];
  const held = (Array.isArray(view.held) ? view.held : []).filter((item) => item.what !== "counted");
  const active = view.state === "active";
  const declared = zonedTime(view.declaredAt);
  const ended = zonedTime(view.endedAt);
  return h(
    "div",
    { class: "outage" },
    h(
      "div",
      { class: "approval__head" },
      h("h3", { class: "outage__title" }, `Outage ${view.id} on ${view.rail}`),
      badge(OUTAGE_STATES[view.state], view.state, false),
    ),
    // The sentence of an ended outage names who ended it.
    h("p", { class: "outage__text" }, withPeriod(whyText(view.text))),
    h(
      "dl",
      { class: "facts approval__status" },
      h("dt", null, "Declared"),
      h("dd", null, declared ?? "Not on file"),
      h("dt", null, "Failure codes"),
      h("dd", null, codes === "" ? "None on file" : codes),
      h("dt", null, "Payouts counted"),
      h(
        "dd",
        null,
        listNodes(counted, (payout) =>
          payout.invoiceId === null
            ? shownReference(payout.reference)
            : h("span", null, `${shownReference(payout.reference)} (`, outageLink(payout.invoiceId, null), ")"),
        ),
      ),
      held.length > 0 && [
        h("dt", null, "Holds"),
        h("dd", null, listNodes(held, (item) => outageLink(item.invoiceId, item.runId))),
      ],
      !active && [
        h("dt", null, "Ended"),
        h(
          "dd",
          null,
          `By ${whyText(view.endedBy)}`,
          ended !== null && [" at ", ended],
          `: ${whyText(view.endNote)}`,
        ),
      ],
    ),
    active && buildEndForm(view, enders, "card"),
  );
}

// Active outages, and those ended in the last day, above the cash panel. While the
// board is on screen, the active outages its slot shows are left out here, so each
// is shown once with one end form. Runs after renderMain, which shows the board.
function renderOutages() {
  const report = state.outages;
  const now = Date.now();
  const inSlot = new Set(
    els.board.hidden || !Array.isArray(state.board?.outages) ? [] : state.board.outages.map((outage) => outage.id),
  );
  const shown =
    report === null
      ? []
      : [
          ...report.active.filter((view) => !inSlot.has(view.id)),
          ...report.recent.filter((view) => recentlyEnded(view, now)),
        ];
  const enders = report === null || !Array.isArray(report.enders) ? null : report.enders;
  if (changed("outages", [shown, enders, report?.endRefused ?? null])) {
    const focus = focusedControl(els.outages);
    outageRefs.card = new Map();
    els.outages.replaceChildren(
      h("h2", { id: "outages-title" }, "Outages"),
      ...shown.map((view) => buildOutage(view, enders)),
    );
    els.outages.hidden = shown.length === 0;
    restoreFocus(focus);
  }
  syncOutages();
}

function syncOutages() {
  const shown = state.outageError;
  if (shown !== null && liveMessage(OUTAGE_PLACES[shown.place].section, shown.error) === null) {
    state.outageError = null;
  }
  for (const [place, forms] of Object.entries(outageRefs)) {
    for (const [id, refs] of forms) {
      const busy = state.outageEnding === id;
      refs.button.disabled = state.outageEnding !== null;
      refs.name.disabled = busy;
      refs.note.readOnly = busy;
      setText(refs.button, busy ? "Ending" : refs.label);
      showMessage(
        refs.error,
        state.outageError?.id === id && state.outageError.place === place ? state.outageError.error.message : null,
      );
    }
  }
}

async function submitEndOutage(id, place) {
  const refs = outageRefs[place].get(id);
  const section = OUTAGE_PLACES[place].section;
  if (state.outageEnding !== null || refs === undefined) {
    return;
  }
  const endedBy = refs.name.value.trim();
  const note = refs.note.value.trim();
  const missing =
    endedBy === ""
      ? { field: refs.name, message: "Enter your name to end the outage." }
      : note === ""
        ? { field: refs.note, message: "Say why the outage is over." }
        : null;
  if (missing !== null) {
    state.outageError = { id, place, error: actionError(section, missing.message) };
    syncOutages();
    missing.field.focus();
    return;
  }
  state.outageEnding = id;
  state.outageError = null;
  syncOutages();
  let failure = null;
  try {
    await api(`/api/outages/${id}/end`, { method: "POST", body: { endedBy, note } });
    state.outageDrafts.delete(id);
    state.fastUntil = Date.now() + EXPECT_WORK_MS;
  } catch (error) {
    failure = error.message;
  }
  try {
    await refresh();
  } finally {
    state.outageEnding = null;
    if (failure !== null) {
      state.outageError = { id, place, error: actionError(section, failure) };
    }
    syncOutages();
  }
}

// ---------- reconciliation ----------

const WALLET_STATUS = {
  "adds-up": { text: "Adds up to Airwallex's available balance", tone: "good" },
  gap: { text: "The movements do not add up", tone: "bad" },
  differs: { text: "The movements do not end at Airwallex's available balance", tone: "bad" },
  moved: { text: "The balance moved while PayOnce read it, so the closing balance was not checked", tone: "neutral" },
  unchecked: { text: "The movements add up. The closing balance was not checked", tone: "neutral" },
  empty: { text: "No movements since the ledger started", tone: "neutral" },
  "not-two-decimal": { text: "Not reconciled: PayOnce handles two-decimal currencies only", tone: "neutral" },
  unreadable: { text: "A movement cannot be read, so the wallet is not checked", tone: "bad" },
};

const MOVEMENT_HOW = {
  payonce: "PayOnce's payment",
  mismatched: "Kept beside a payment because it does not match its invoice",
  outside: "Sent outside PayOnce, tied to an invoice",
  untied: "Sent outside PayOnce, tied to no invoice",
  before: "From before the ledger",
  hold: "Hold, left out",
  waiting: "Waiting for its transfer to be read",
  unexplained: "Not explained",
  unreadable: "Cannot be read",
  "not-two-decimal": "Not reconciled",
};

// The explain form of each kind on screen.
let reconRefs = new Map();

async function loadRecon() {
  try {
    const report = await api("/api/reconcile");
    if (report.built !== true || !Array.isArray(report.open) || !Array.isArray(report.wallets)) {
      throw new Error("The server sent a reconciliation this page could not read.");
    }
    state.recon = report;
    state.reconError = null;
  } catch (error) {
    state.reconError = error.message;
  }
}

async function loadMovements(currency) {
  const entry = state.reconMovements.get(currency) ?? { open: true, rows: null, error: null };
  try {
    const data = await api(`/api/reconcile/movements?currency=${encodeURIComponent(currency)}`);
    if (!Array.isArray(data.movements)) {
      throw new Error("The server sent movements this page could not read.");
    }
    state.reconMovements.set(currency, { ...entry, rows: data.movements, error: null });
  } catch (error) {
    state.reconMovements.set(currency, { ...entry, error: error.message });
  }
}

function runWords(run) {
  const from = run.ranFrom === "server" ? "the server" : "the terminal";
  const what = run.mode === "offline" ? "an offline match" : run.fullRead ? "a full read" : "the last seven days";
  return `from ${from}, ${what}, ${run.reads} ${run.reads === 1 ? "read" : "reads"}`;
}

function renderReconLast(report) {
  if (!changed("reconLast", [report.lastRun, report.lastProblem, report.running, report.everyMinutes, report.startedAt])) {
    return;
  }
  const last = report.lastRun;
  const problem = report.lastProblem;
  const every =
    report.everyMinutes === null
      ? "The server checks only when asked."
      : `The server checks a minute after it starts, then every ${report.everyMinutes} ${report.everyMinutes === 1 ? "minute" : "minutes"}.`;
  const shown = [
    h("h2", null, "Last check"),
    last === null
      ? h("p", null, "No check is recorded yet. ", every)
      : h("p", null, "Checked ", zonedTime(last.finishedAt ?? last.startedAt), ` ${runWords(last)}. `, every),
    problem !== null &&
      h(
        "p",
        { class: "form-error" },
        "The latest check, started ",
        zonedTime(problem.startedAt),
        problem.outcome === "stale"
          ? ", recorded nothing, because a check that started later was recorded first."
          : `, failed and changed no break: ${problem.error ?? "no reason was recorded"}.`,
      ),
    report.running && h("p", { class: "hint" }, "Checking now."),
    h("p", { class: "hint" }, "Movements are counted from when the ledger started, ", zonedTime(report.startedAt), "."),
  ];
  els.reconLast.replaceChildren(...shown.filter((node) => node !== false && node !== null));
}

function walletRow(label, value) {
  return [h("dt", null, label), h("dd", null, value)];
}

function buildMovements(currency) {
  const entry = state.reconMovements.get(currency);
  if (entry === undefined || !entry.open) {
    return null;
  }
  if (entry.error !== null) {
    return h("p", { class: "form-error" }, `Could not load the movements. ${entry.error}`);
  }
  if (entry.rows === null) {
    return h("p", { class: "hint" }, "Loading the movements.");
  }
  if (entry.rows.length === 0) {
    return h("p", { class: "hint" }, "No movements are stored for this wallet.");
  }
  return h(
    "ol",
    { class: "recon-moves" },
    entry.rows.map((row) =>
      h(
        "li",
        { class: "recon-move" },
        h(
          "div",
          { class: "recon-move__line" },
          h("span", { class: "recon-move__when" }, zonedTime(row.postedAt)),
          h("span", null, row.typeText),
          h("span", { class: "recon-move__amount" }, row.amountMinor === null ? "Cannot be read" : formatMoney(row.amountMinor, currency)),
          h("span", { class: "recon-move__balance" }, row.balanceMinor === null ? "" : `Balance ${formatMoney(row.balanceMinor, currency)}`),
        ),
        h(
          "p",
          { class: "recon-move__how" },
          MOVEMENT_HOW[row.how] ?? "Not explained",
          row.reference !== null && `, transfer ${row.reference}`,
          row.invoiceId !== null && [", ", h("a", { href: `#${encodeURIComponent(row.invoiceId)}` }, row.invoiceId)],
          row.breakId !== null && `, break ${row.breakId}`,
        ),
      ),
    ),
  );
}

async function toggleMovements(currency) {
  const entry = state.reconMovements.get(currency);
  if (entry?.open === true) {
    state.reconMovements.set(currency, { ...entry, open: false });
    renderReconWallets(state.recon);
    return;
  }
  state.reconMovements.set(currency, { open: true, rows: null, error: null });
  renderReconWallets(state.recon);
  await loadMovements(currency);
  if (state.recon !== null) {
    renderReconWallets(state.recon);
  }
}

function renderReconWallets(report) {
  const movements = [...state.reconMovements].map(([currency, entry]) => [currency, entry.open, entry.rows, entry.error]);
  if (!changed("reconWallets", [report.wallets, movements])) {
    return;
  }
  els.reconWallets.replaceChildren(
    ...report.wallets.map((wallet) => {
      const status = WALLET_STATUS[wallet.status] ?? { text: "Not checked", tone: "neutral" };
      const code = wallet.currency;
      const open = state.reconMovements.get(code)?.open === true;
      const button = h("button", { class: "button button--small", type: "button" }, open ? "Hide movements" : "Show movements");
      button.addEventListener("click", () => {
        toggleMovements(code);
      });
      return h(
        "section",
        { class: `card recon-wallet recon-wallet--${status.tone}` },
        h("div", { class: "recon-wallet__head" }, h("h2", null, `${code} wallet`), h("p", { class: "recon-wallet__status" }, status.text)),
        wallet.movements > 0 &&
          h(
            "dl",
            { class: "terms" },
            walletRow("Opening balance", wallet.openingMinor === null ? "Not known" : formatMoney(wallet.openingMinor, code)),
            walletRow("Money in", formatMoney(wallet.inMinor, code)),
            walletRow("Money out", formatMoney(Math.abs(wallet.outMinor), code)),
            wallet.holdsMinor !== 0 && walletRow("Holds, left out", formatMoney(wallet.holdsMinor, code)),
            walletRow("Closing balance", wallet.closingMinor === null ? "Not known" : formatMoney(wallet.closingMinor, code)),
            walletRow("Airwallex's available balance", wallet.availableMinor === null ? "Not read" : formatMoney(wallet.availableMinor, code)),
          ),
        wallet.movements === 0 &&
          h(
            "p",
            { class: "hint" },
            `Airwallex's available balance: ${wallet.availableMinor === null ? "not read" : formatMoney(wallet.availableMinor, code)}.`,
          ),
        wallet.movements > 0 &&
          h(
            "p",
            { class: "hint" },
            `${wallet.movements} movements: ${wallet.payonce} PayOnce's payments, ${wallet.mismatched ?? 0} kept beside a payment because they do not match its invoice, ${wallet.outside} sent outside PayOnce and tied to an invoice, ${wallet.untied} tied to no invoice, ${wallet.before} from before the ledger, ${wallet.holds} holds, ${wallet.waiting} waiting, ${wallet.unexplained} not explained.`,
          ),
        wallet.movements > 0 && button,
        buildMovements(code),
      );
    }),
  );
}

function reconDraft(kind) {
  const draft = state.reconDrafts.get(kind) ?? { name: readStoredName(), note: "", picked: new Set() };
  state.reconDrafts.set(kind, draft);
  return draft;
}

function buildBreak(item, draft, sync) {
  const box = h("input", { type: "checkbox", id: `recon-pick-${item.id}` });
  box.checked = draft.picked.has(item.id);
  box.addEventListener("change", () => {
    if (box.checked) {
      draft.picked.add(item.id);
    } else {
      draft.picked.delete(item.id);
    }
    sync();
  });
  return {
    box,
    node: h(
      "li",
      { class: "recon-break" },
      box,
      h(
        "label",
        { for: `recon-pick-${item.id}`, class: "recon-break__text" },
        h("span", { class: "recon-break__id" }, `Break ${item.id}`),
        h("span", null, item.text),
        h(
          "span",
          { class: "recon-break__meta" },
          item.invoiceId !== null && [h("a", { href: `#${encodeURIComponent(item.invoiceId)}` }, item.invoiceId), ". "],
          "Found ",
          zonedTime(item.openedAt ?? item.foundAt),
          ".",
          item.goneAt !== null && " No longer found. It still waits for a person.",
        ),
      ),
    ),
  };
}

function buildKindGroup(kind, items, count) {
  const draft = reconDraft(kind);
  const shown = new Set(items.map((item) => item.id));
  for (const id of [...draft.picked]) {
    if (!shown.has(id)) {
      draft.picked.delete(id);
    }
  }
  const refs = { kind, items, boxes: [], name: null, note: null, button: null, error: null, all: null };
  const sync = () => syncReconGroup(refs);
  const list = h("ul", { class: "recon-breaks" });
  for (const item of items) {
    const built = buildBreak(item, draft, sync);
    refs.boxes.push(built.box);
    list.append(built.node);
  }
  const name = h("input", { type: "text", id: `recon-name-${kind}`, autocomplete: "name", maxlength: "80" });
  name.value = draft.name;
  name.addEventListener("input", () => {
    draft.name = name.value;
  });
  const note = h("input", { type: "text", id: `recon-note-${kind}`, autocomplete: "off", maxlength: "200" });
  note.value = draft.note;
  note.addEventListener("input", () => {
    draft.note = note.value;
  });
  const button = h("button", { class: "button", type: "submit" }, "Explain");
  const all = h("button", { class: "button button--small", type: "button" }, "Select all");
  all.addEventListener("click", () => {
    const every = draft.picked.size === items.length;
    draft.picked = new Set(every ? [] : items.map((item) => item.id));
    refs.boxes.forEach((box, index) => {
      box.checked = draft.picked.has(items[index].id);
    });
    sync();
  });
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const form = h(
    "form",
    { class: "close-form", novalidate: true },
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Your name"), name),
    h("label", { class: "field" }, h("span", { class: "field__label" }, "What these are"), note),
    h("div", { class: "recon-explain__actions" }, button, all),
    error,
    h("p", { class: "hint" }, "Explaining moves no money and changes no invoice. It covers the breaks ticked here with the facts shown. If their facts change, they open again."),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitExplain(kind);
  });
  Object.assign(refs, { name, note, button, error, all });
  reconRefs.set(kind, refs);
  const first = items[0];
  return h(
    "section",
    { class: "recon-kind" },
    h("h3", null, `${first.label}: ${count}`),
    h("p", { class: "hint" }, first.action),
    count > items.length && h("p", { class: "hint" }, `The newest ${items.length} of them are listed here.`),
    list,
    form,
  );
}

function syncReconGroup(refs) {
  const draft = reconDraft(refs.kind);
  const busy = state.reconExplaining === refs.kind;
  refs.button.disabled = state.reconExplaining !== null || draft.picked.size === 0;
  refs.name.readOnly = busy;
  refs.note.readOnly = busy;
  setText(
    refs.button,
    busy ? "Explaining" : draft.picked.size === 0 ? "Tick the breaks to explain" : `Explain ${draft.picked.size === 1 ? "this break" : `these ${draft.picked.size} breaks`}`,
  );
  setText(refs.all, draft.picked.size === refs.items.length ? "Clear all" : "Select all");
  const error = state.reconExplainError;
  if (error !== null && error.kind === refs.kind && liveMessage("reconOpen", error.error) === null) {
    state.reconExplainError = null;
  }
  showMessage(refs.error, state.reconExplainError?.kind === refs.kind ? state.reconExplainError.error.message : null);
}

function renderReconOpen(report) {
  const open = report.open;
  const total = report.openCount ?? open.length;
  const counts = new Map((report.byKind ?? []).map((entry) => [entry.kind, entry.count]));
  if (changed("reconOpen", [total, report.byKind, open.map((item) => [item.id, item.fingerprint, item.goneAt, item.text])])) {
    const focus = focusedControl(els.reconOpen);
    reconRefs = new Map();
    const kinds = [...new Set(open.map((item) => item.kind))];
    const unlisted = (report.byKind ?? []).filter((entry) => !kinds.includes(entry.kind));
    els.reconOpen.replaceChildren(
      h("h2", { id: "recon-open-title" }, total === 0 ? "Nothing needs a person" : `Needs a person: ${total}`),
      // replaceChildren writes false as text, so a hint not shown is left out.
      ...(total > open.length
        ? [
            h(
              "p",
              { class: "hint" },
              `The newest ${open.length} are listed here, and ${total - open.length} more are open.`,
              unlisted.length > 0 &&
                ` Not listed yet: ${unlisted.map((entry) => `${entry.label} (${entry.count})`).join(", ")}. Older breaks move up as the listed ones are explained.`,
            ),
          ]
        : []),
      ...(open.length === 0
        ? [h("p", { class: "hint" }, "Every movement the last check read is explained, or still inside its window.")]
        : kinds.map((kind) => {
            const items = open.filter((item) => item.kind === kind);
            return buildKindGroup(kind, items, counts.get(kind) ?? items.length);
          })),
    );
    restoreFocus(focus);
  }
  for (const refs of reconRefs.values()) {
    syncReconGroup(refs);
  }
}

function renderReconWaiting(report) {
  if (!changed("reconWaiting", [report.waiting, report.pending])) {
    return;
  }
  const shown = report.waiting.length > 0 || report.pending > 0;
  els.reconWaiting.replaceChildren(
    h("h2", { id: "recon-waiting-title" }, "Waiting"),
    h(
      "ul",
      { class: "recon-waiting" },
      report.waiting.map((item) =>
        h("li", null, item.text, item.dueAt !== null && [" Due ", zonedTime(item.dueAt), "."]),
      ),
      report.pending > 0 &&
        h(
          "li",
          null,
          `${report.pending} ${report.pending === 1 ? "break was" : "breaks were"} found once. PayOnce opens one when the next check finds the same facts.`,
        ),
    ),
  );
  els.reconWaiting.hidden = !shown;
}

function renderReconExplained(report) {
  if (!changed("reconExplained", report.explained.map((item) => [item.id, item.goneAt]))) {
    return;
  }
  els.reconExplained.replaceChildren(
    h("h2", { id: "recon-explained-title" }, "Explained"),
    h(
      "ul",
      { class: "recon-waiting" },
      report.explained.map((item) =>
        h(
          "li",
          null,
          h("strong", null, `Break ${item.id}, ${item.label}. `),
          item.text,
          h(
            "span",
            { class: "recon-break__meta" },
            `Explained by ${whyText(item.explainedBy) || "a name PayOnce does not know"} `,
            zonedTime(item.explainedAt),
            ": ",
            whyText(item.note),
          ),
        ),
      ),
    ),
  );
  els.reconExplained.hidden = report.explained.length === 0;
}

function renderReconAudit(report) {
  const audit = report.audit;
  if (!changed("reconAudit", audit)) {
    return;
  }
  els.reconAudit.replaceChildren(
    audit.problem === null
      ? `Hash chain intact over ${audit.lines} ${audit.lines === 1 ? "line" : "lines"}. pnpm run audit checks it too.`
      : h("strong", { class: "audit__broken" }, `Hash chain broken. ${audit.problem}.`),
  );
  els.reconAudit.hidden = false;
}

function syncReconCheck() {
  const running = state.recon?.running === true;
  els.reconCheck.disabled = state.reconChecking || running;
  setText(els.reconCheck, state.reconChecking || running ? "Checking" : "Check now");
}

// ---------- metrics ----------

const METRICS_PERIOD_WORDS = {
  "7d": "the last 7 days",
  "30d": "the last 30 days",
  all: "since the ledger started",
};

const METRICS_PAYMENT_WORDS = {
  first: "first payment",
  "first-approved": "first payment, approved",
  "replacement-auto": "replacement by PayOnce",
  "replacement-approved": "replacement, approved",
};

const METRICS_STAGE_WORDS = {
  bank: "Failed at the bank",
  refused: "Refused by Airwallex",
  "never-created": "Never created",
};

const METRICS_HOW_WORDS = {
  "first-time": "paid the first time",
  replaced: "replaced by PayOnce",
  "person-paid": "paid after a person",
  "not-paid": "closed without paying",
};

const METRICS_GROUP_WORDS = {
  "paid-first-time": "Paid the first time",
  "recovered-by-itself": "Recovered by PayOnce alone",
  "with-a-person": "With a person",
};

// An amount as formatMoney writes it, which a table aligns with the numbers.
const MONEY_CELL = /^-?[0-9][0-9,]*\.[0-9]{2} [A-Z]{3}$/;

function mainViews() {
  return [
    els.board,
    els.detail,
    els.runDetail,
    els.inboxDetail,
    els.supplierDetail,
    els.recon,
    els.placeholder,
    els.metrics,
  ];
}

function showOnlyView(shown) {
  for (const node of mainViews()) {
    node.hidden = node !== shown;
  }
}

// Asked once when the view opens or the period changes, then every 30 seconds,
// whether the last answer came back or failed. An answer or an error for a period
// the person has left is dropped.
async function loadMetrics() {
  const period = state.metricsPeriod;
  const asked = state.metricsAsked;
  if (
    asked !== null &&
    asked.period === period &&
    asked.at >= state.selectedAt &&
    Date.now() - asked.at < METRICS_EVERY_MS
  ) {
    return;
  }
  state.metricsAsked = { period, at: Date.now() };
  try {
    const report = await api(`/api/metrics?period=${encodeURIComponent(period)}`);
    if (state.metricsPeriod !== period) {
      return;
    }
    if (report === null || typeof report !== "object" || report.period !== period || !Array.isArray(report.payments?.rows)) {
      throw new Error("The server sent metrics this page could not read.");
    }
    state.metrics = report;
    state.metricsError = null;
  } catch (error) {
    if (state.metricsPeriod === period) {
      state.metricsError = error.message;
    }
  }
}

function durationWords(seconds) {
  if (typeof seconds !== "number") {
    return "none";
  }
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

// Median with its n, p90 (shown from n 10), and the longest.
function spreadCells(spread) {
  if (spread.n === 0) {
    return ["none measured", "", ""];
  }
  return [
    `${durationWords(spread.medianSeconds)} (n ${spread.n})`,
    spread.p90Seconds === null ? "" : durationWords(spread.p90Seconds),
    durationWords(spread.maxSeconds),
  ];
}

function countWords(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function listWords(items) {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// What some payments took, wallet by wallet and never added across currencies,
// then how many have no amount on file. noun is [one, many], such as
// ["extra payment", "extra payments"].
function tookWords(subject, noun, rows, notKnown) {
  const unit = noun[0].split(" ").at(-1);
  const units = noun[1].split(" ").at(-1);
  const sentences = [];
  if (rows.length > 0) {
    sentences.push(
      `${subject} took ${listWords(rows.map((row) => `${formatMoney(row.amountMinor, row.currency)} in ${countWords(row.payments, unit, units)}`))}.`,
    );
  }
  if (notKnown > 0) {
    sentences.push(`${countWords(notKnown, noun[0], noun[1])} ${notKnown === 1 ? "has" : "have"} no amount on file.`);
  }
  if (sentences.length === 0) {
    sentences.push(`${subject} ${subject === "It" ? "is" : "are"} in a currency PayOnce cannot read.`);
  }
  return sentences.join(" ");
}

function percentWords(part, whole, percent) {
  return percent === null ? `${part} of ${whole}` : `${part} of ${whole} (${percent}%)`;
}

function metricsTable(caption, head, rows, empty) {
  if (rows.length === 0) {
    return h("p", { class: "empty" }, empty);
  }
  return h(
    "div",
    { class: "metrics-scroll" },
    h(
      "table",
      { class: "metrics-table" },
      h("caption", null, caption),
      h("thead", null, h("tr", null, head.map((cell) => h("th", { scope: "col" }, cell)))),
      h(
        "tbody",
        null,
        rows.map((row) =>
          h(
            "tr",
            null,
            row.map((cell, index) =>
              index === 0
                ? h("th", { scope: "row" }, cell)
                : h("td", { class: typeof cell === "number" || MONEY_CELL.test(String(cell)) ? "num" : null }, cell),
            ),
          ),
        ),
      ),
    ),
  );
}

// What a table left out: rows a time it needs is missing for, and rows whose
// currency PayOnce cannot read. For payments and incidents the server counts
// invoices, each once however many figures it was left out of.
function metricsNote(notOnFile, unreadable = 0, invoices = false) {
  const what = (count) => (invoices ? countWords(count, "invoice", "invoices") : String(count));
  const parts = [
    notOnFile > 0 &&
      (invoices
        ? `${what(notOnFile)} left out of some figures because a time they need is not on file.`
        : `${notOnFile} left out because a time they need is not on file.`),
    unreadable > 0 &&
      `${what(unreadable)} left out of the money because ${unreadable === 1 ? "its" : "their"} currency cannot be read.`,
  ].filter((part) => part !== false);
  return parts.length === 0 ? null : h("p", { class: "hint" }, parts.join(" "));
}

function metricsCard(key, title, ...children) {
  const id = `metrics-${key}-title`;
  return h("section", { class: "card metrics-card", "aria-labelledby": id }, h("h2", { id }, title), ...children);
}

function spreadNote(label, spread) {
  if (spread.n === 0 && spread.notOnFile === 0) {
    return null;
  }
  const [median, p90, longest] = spreadCells(spread);
  return [label, median, p90, longest];
}

function paymentsCard(table) {
  const firstTime =
    table.firstTime.length === 0
      ? "The bank paid or failed no first payment in this period."
      : `Paid the first time: ${table.firstTime
          .map((row) => `${row.currency} ${percentWords(row.paid, row.ended, row.percent)}`)
          .join("; ")}. This counts the first payments the bank has paid or failed.`;
  const paidTwice = table.paidMoreThanOnce;
  const twice =
    paidTwice.invoices === 0
      ? "Paid more than once, since the ledger started: none."
      : `Paid more than once, since the ledger started: ${countWords(paidTwice.invoices, "invoice", "invoices")}. ${tookWords("The extra payments", ["extra payment", "extra payments"], paidTwice.extra, paidTwice.notKnown)}`;
  const kept = table.mismatchedPaid;
  const mismatched =
    kept.transfers === 0
      ? null
      : `Paid transfers that did not match their invoice, since the ledger started: ${countWords(kept.transfers, "transfer", "transfers")} on ${countWords(kept.invoices, "invoice", "invoices")}. ${tookWords(kept.transfers === 1 ? "It" : "They", ["transfer", "transfers"], kept.paid, kept.notKnown)} PayOnce does not count these as a second payment.`;
  const bankTime = table.bankTimeToPay
    .map((row) => spreadNote(`${row.currency} ${row.method}`, row))
    .filter((row) => row !== null);
  return metricsCard(
    "payments",
    "Payments sent",
    metricsTable(
      "By when the transfer was created",
      ["Payment", "Sent", "Paid", "Failed", "With the bank", "Paid out", "From pay runs"],
      table.rows.map((row) => [
        `${row.currency} ${METRICS_PAYMENT_WORDS[row.what] ?? row.what}`,
        row.sent,
        row.paid,
        row.failed,
        row.withBank,
        formatMoney(row.paidMinor, row.currency),
        row.fromPayRuns,
      ]),
      "No payments sent in this period.",
    ),
    h("p", null, firstTime),
    h("p", { class: paidTwice.invoices === 0 ? null : "form-error" }, twice),
    mismatched !== null && h("p", null, mismatched),
    bankTime.length > 0 &&
      metricsTable(
        "Bank time to pay: from PayOnce's last call to create the transfer to when it recorded it paid",
        ["Rail", "Median", "p90", "Longest"],
        bankTime,
        "",
      ),
    metricsNote(table.leftOut, table.unreadable, true),
  );
}

function failuresCard(table) {
  return metricsCard(
    "failures",
    "Failures by rail and code",
    metricsTable(
      "By when the transfer was created, or when PayOnce tried to create it",
      ["Rail", "Where", "Code", "What it means", "PayOnce", "Outside PayOnce", "Counts toward an outage", "A resend can fix it"],
      table.rows.map((row) => [
        `${row.currency} ${row.method}`,
        METRICS_STAGE_WORDS[row.stage] ?? row.stage,
        row.code,
        row.label,
        row.payonce,
        row.outside,
        row.rail ? "Yes" : "No",
        row.resendable ? "Yes" : "No",
      ]),
      "No failures in this period.",
    ),
    table.outsidePayoutsFailed > 0 &&
      h(
        "p",
        null,
        `Payouts sent outside PayOnce that failed, by when PayOnce tied them to an invoice: ${table.outsidePayoutsFailed}.`,
      ),
    metricsNote(table.notOnFile, table.unreadable),
  );
}

function incidentsCard(table) {
  const started = table.started;
  const times = [
    ...table.timeToClose.map((spread) =>
      spreadNote(`${METRICS_GROUP_WORDS[spread.group] ?? spread.group}, from the first line`, spread),
    ),
    ...table.afterFailure.map((spread) =>
      spreadNote(`${METRICS_GROUP_WORDS[spread.group] ?? spread.group}, from the first failure`, spread),
    ),
    spreadNote("With a person, from when it first went to one", table.withPerson),
  ].filter((row) => row !== null);
  return metricsCard(
    "incidents",
    "Incidents",
    h(
      "p",
      null,
      `Started, by the first line on their timeline: ${started.single} single, ${started.payRun} from pay runs, ${started.found} found in Airwallex.`,
    ),
    metricsNote(started.notOnFile),
    metricsTable(
      "Closed, by when they closed",
      ["How it closed", "Count", "Amount", "From pay runs", "Found in Airwallex"],
      table.closed.map((row) => [
        `${row.currency} ${METRICS_HOW_WORDS[row.how] ?? row.how}`,
        row.count,
        formatMoney(row.amountMinor, row.currency),
        row.fromPayRuns,
        row.found,
      ]),
      "No incidents closed in this period.",
    ),
    times.length > 0 &&
      metricsTable("How long the closed ones took", ["Closed", "Median", "p90", "Longest"], times, ""),
    table.reasons.length > 0 &&
      metricsTable(
        "Why they needed a person: the reason on file when they closed",
        ["Reason", "Paid", "Not paid"],
        table.reasons.map((row) => [row.label, row.paid, row.notPaid]),
        "",
      ),
    h(
      "p",
      { class: "hint" },
      "An invoice counts as needing a person when PayOnce sent it to one, even if the bank then settled it before anyone acted.",
    ),
    metricsNote(table.leftOut, table.unreadable, true),
  );
}

function approvalsCard(table) {
  return metricsCard(
    "approvals",
    "Approvals",
    metricsTable(
      "By when a request got the signoff that completed it",
      ["Requests", "Given", "Two approvers", "Spent", "Voided", "Waiting to be used", "Time to approve", "p90", "Longest"],
      table.rows.map((row) => [
        row.of === "run" ? "Pay runs" : "Invoices",
        row.given,
        row.twoApprovers,
        row.spent,
        row.voided,
        row.waiting,
        ...spreadCells(row.wait),
      ]),
      "",
    ),
    h("p", null, `Waiting for a person now: ${table.openNow} ${table.openNow === 1 ? "request" : "requests"}.`),
    h(
      "p",
      { class: "hint" },
      "Time to approve runs from the first request to the signoff that completed one, across the requests that renewed in between.",
    ),
    metricsNote(table.rows.reduce((sum, row) => sum + row.notOnFile + row.wait.notOnFile, 0)),
  );
}

function feesCard(table) {
  return metricsCard(
    "fees",
    "Fees lost",
    metricsTable(
      "Fees kept on failed transfers, by when the transfer was created",
      ["Wallet", "Transfers", "Fees kept", "Not read yet", "PayOnce", "Outside PayOnce"],
      table.rows.map((row) => [
        row.currency,
        row.transfers,
        formatMoney(row.feeMinor, row.currency),
        row.notRead,
        row.payonce,
        row.outside,
      ]),
      "No fees lost in this period.",
    ),
    metricsNote(table.notOnFile, table.unreadable),
  );
}

function duplicatesCard(table) {
  return metricsCard(
    "duplicates",
    "Duplicates held",
    metricsTable(
      "Invoices held as a likely second bill, by the first line on their timeline",
      ["Currency", "Held", "Closed without paying", "Not paid twice", "Paid on approval", "Approved, paying now", "Still held"],
      table.rows.map((row) => [
        row.currency,
        row.held,
        row.stopped,
        formatMoney(row.stoppedMinor, row.currency),
        row.paid,
        row.released,
        row.stillHeld,
      ]),
      "No invoices held as a likely duplicate in this period.",
    ),
    metricsNote(table.notOnFile, table.unreadable),
  );
}

function outageHeldWords(held) {
  const parts = [
    held.original > 0 && `${held.original} first ${held.original === 1 ? "payment" : "payments"}`,
    held.replacement > 0 && `${held.replacement} ${held.replacement === 1 ? "replacement" : "replacements"}`,
    held.approved > 0 && `${held.approved} approved ${held.approved === 1 ? "payment" : "payments"}`,
    held.run > 0 && `${held.run} pay ${held.run === 1 ? "run" : "runs"}`,
  ].filter((part) => part !== false);
  return parts.length === 0 ? "Nothing" : parts.join(", ");
}

function outagesCard(table) {
  return metricsCard(
    "outages",
    "Rail outages",
    metricsTable(
      "Outages running at any time in the period",
      ["Outage", "Declared", "Ended", "Lasted", "Payees", "Codes", "Held"],
      table.rows.map((row) => [
        `${row.id} on ${row.currency} ${row.method}`,
        zonedTime(row.declaredAt) ?? "not on file",
        row.active ? "Still active" : (zonedTime(row.endedAt) ?? "not on file"),
        durationWords(row.seconds),
        row.payees,
        row.codes.length === 0 ? "none on file" : row.codes.map((code) => `${code.code} ${code.label}`).join(", "),
        outageHeldWords(row.held),
      ]),
      "No outages in this period.",
    ),
    table.byRail.length > 0 &&
      metricsTable(
        "By rail",
        ["Rail", "Outages", "In all", "Longest"],
        table.byRail.map((row) => [
          `${row.currency} ${row.method}`,
          row.outages,
          durationWords(row.totalSeconds),
          durationWords(row.longestSeconds),
        ]),
        "",
      ),
    metricsNote(table.notOnFile, table.unreadable),
  );
}

function reconCard(table) {
  const link = h("p", null, h("a", { href: "#recon" }, "Open reconciliation"));
  if (!table.ran) {
    return metricsCard("recon", "Reconciliation breaks", h("p", { class: "empty" }, "Reconciliation has not run on this ledger."), link);
  }
  const resolve = spreadNote("Time to resolve", table.resolve);
  return metricsCard(
    "recon",
    "Reconciliation breaks",
    metricsTable(
      "By when the break opened",
      ["Kind", "Clears by itself", "Found", "Explained", "Cleared", "Open"],
      table.rows.map((row) => [row.label, row.byItself ? "Yes" : "No", row.found, row.explained, row.cleared, row.open]),
      "No breaks opened in this period.",
    ),
    resolve !== null && metricsTable("From opening to explained or cleared", ["", "Median", "p90", "Longest"], [resolve], ""),
    link,
    metricsNote(table.notOnFile + table.resolve.notOnFile),
  );
}

function renderMetricsAsOf(report) {
  const loading = report.period !== state.metricsPeriod;
  els.metricsAsOf.replaceChildren(
    h(
      "span",
      null,
      `Showing ${METRICS_PERIOD_WORDS[report.period] ?? report.period}`,
      report.from !== null && [", from ", zonedTime(report.from)],
      ". As of ",
      zonedTime(report.builtAt),
      loading ? `. Loading ${METRICS_PERIOD_WORDS[state.metricsPeriod] ?? state.metricsPeriod}.` : ".",
    ),
  );
}

function renderMetricsMain() {
  els.metricsButton.setAttribute("aria-current", "true");
  els.boardButton.removeAttribute("aria-current");
  els.reconButton.removeAttribute("aria-current");
  for (const button of els.metricsPeriods) {
    button.setAttribute("aria-pressed", String(button.dataset.period === state.metricsPeriod));
  }
  const report = state.metrics;
  if (report === null) {
    if (state.metricsError === null && Date.now() - state.selectedAt < LOADING_DELAY_MS) {
      return;
    }
    setText(els.placeholderTitle, state.metricsError === null ? "Loading metrics" : "Could not load metrics");
    setText(els.placeholderText, state.metricsError ?? "");
    showMessage(els.connection, null);
    showOnlyView(els.placeholder);
    return;
  }
  showMessage(els.connection, null);
  showMessage(els.metricsError, state.metricsError === null ? null : `Could not refresh the metrics. ${state.metricsError}`);
  renderMetricsAsOf(report);
  if (changed("metrics", { ...report, to: null, builtAt: null, from: report.period === "all" ? report.from : null })) {
    els.metricsCards.replaceChildren(
      paymentsCard(report.payments),
      failuresCard(report.failures),
      incidentsCard(report.incidents),
      approvalsCard(report.approvals),
      feesCard(report.fees),
      duplicatesCard(report.duplicates),
      outagesCard(report.outages),
      reconCard(report.recon),
    );
  }
  showOnlyView(els.metrics);
}

function renderReconMain() {
  const report = state.recon;
  if (report === null) {
    if (state.reconError === null && Date.now() - state.selectedAt < LOADING_DELAY_MS) {
      return;
    }
    setText(els.placeholderTitle, state.reconError === null ? "Loading reconciliation" : "Could not load reconciliation");
    setText(els.placeholderText, state.reconError ?? "");
    els.recon.hidden = true;
    els.placeholder.hidden = false;
    showMessage(els.connection, null);
    return;
  }
  showMessage(els.connection, null);
  showMessage(
    els.reconError,
    state.reconCheckError ?? (state.reconError === null ? null : `Could not refresh reconciliation. ${state.reconError}`),
  );
  renderReconLast(report);
  renderReconWallets(report);
  renderReconOpen(report);
  renderReconWaiting(report);
  renderReconExplained(report);
  renderReconAudit(report);
  syncReconCheck();
  els.placeholder.hidden = true;
  els.recon.hidden = false;
}

async function checkRecon() {
  if (state.reconChecking) {
    return;
  }
  state.reconChecking = true;
  state.reconCheckError = null;
  syncReconCheck();
  try {
    await api("/api/reconcile/run", { method: "POST", body: {} });
    state.fastUntil = Date.now() + EXPECT_WORK_MS;
  } catch (error) {
    state.reconCheckError = error.message;
  }
  try {
    await refresh();
  } finally {
    state.reconChecking = false;
    syncReconCheck();
    if (state.selectedId === RECON_ID) {
      renderReconMain();
    }
  }
}

async function submitExplain(kind) {
  const refs = reconRefs.get(kind);
  if (state.reconExplaining !== null || refs === undefined) {
    return;
  }
  const draft = reconDraft(kind);
  const explainedBy = refs.name.value.trim();
  const note = refs.note.value.trim();
  const breaks = refs.items
    .filter((item) => draft.picked.has(item.id))
    .map((item) => ({ id: item.id, fingerprint: item.fingerprint }));
  const missing =
    breaks.length === 0
      ? { field: refs.boxes[0], message: "Tick the breaks to explain." }
      : explainedBy === ""
        ? { field: refs.name, message: "Enter your name to explain them." }
        : note === ""
          ? { field: refs.note, message: "Say what these are." }
          : null;
  if (missing !== null) {
    state.reconExplainError = { kind, error: actionError("reconOpen", missing.message) };
    syncReconGroup(refs);
    missing.field?.focus();
    return;
  }
  state.reconExplaining = kind;
  state.reconExplainError = null;
  for (const group of reconRefs.values()) {
    syncReconGroup(group);
  }
  let failure = null;
  try {
    await api("/api/reconcile/explain", { method: "POST", body: { breaks, explainedBy, note } });
    storeName(explainedBy);
    state.reconDrafts.delete(kind);
  } catch (error) {
    failure = error.message;
  }
  try {
    await refresh();
  } finally {
    state.reconExplaining = null;
    if (failure !== null) {
      state.reconExplainError = { kind, error: actionError("reconOpen", failure) };
    }
    for (const group of reconRefs.values()) {
      syncReconGroup(group);
    }
  }
}

function render() {
  renderForm();
  renderRunForm();
  renderList();
  renderRunList();
  renderSupplierList();
  renderEmailForm();
  renderInboxList();
  renderCash();
  renderMain();
  renderOutages();
  placePanels();
}

// Below this width the sidebar follows the main view (styles.css).
const NARROW = window.matchMedia("(max-width: 900px)");

// An incident, a pay run or an email comes before the outages card and the cash
// panel, as a supplier record does, so its header is on the first screen. On a
// narrow screen every view does, so a phone opens on what was picked. The nodes
// move only when the order has to change.
function placePanels() {
  const after =
    NARROW.matches || !els.detail.hidden || !els.runDetail.hidden || !els.inboxDetail.hidden;
  const main = els.cash.parentElement;
  if (after) {
    if (main.lastElementChild !== els.cash || els.cash.previousElementSibling !== els.outages) {
      main.append(els.outages, els.cash);
    }
  } else if (els.cash.nextElementSibling !== els.connection || els.outages.nextElementSibling !== els.cash) {
    main.insertBefore(els.outages, els.connection);
    main.insertBefore(els.cash, els.connection);
  }
}

// ---------- start ----------

els.form.addEventListener("submit", startIncident);
els.runForm.addEventListener("submit", submitRunFile);
els.emailForm.addEventListener("submit", submitEmail);
els.emailUploadedBy.value = readStoredName();
els.emailUploadedBy.addEventListener("input", () => {
  syncNames(els.emailUploadedBy);
});
for (const input of [els.emailFile, els.emailPaste]) {
  input.addEventListener("input", () => {
    if (state.addError !== null) {
      state.addError = null;
      renderEmailForm();
    }
  });
}
els.payAgain.addEventListener("click", payAgain);
els.startedBy.value = readStoredName();
els.runUploadedBy.value = readStoredName();
els.startedBy.addEventListener("input", () => {
  syncNames(els.startedBy);
  if (state.createError !== null) {
    state.createError = null;
    renderForm();
  }
});
els.runUploadedBy.addEventListener("input", () => {
  syncNames(els.runUploadedBy);
  if (state.uploadError !== null) {
    state.uploadError = null;
    renderRunForm();
  }
});
els.runFile.addEventListener("change", () => {
  if (state.uploadError !== null) {
    state.uploadError = null;
    renderRunForm();
  }
});

// A top-bar button scrolls to the top of its view even when it is already open.
els.boardButton.addEventListener("click", () => {
  window.scrollTo(0, 0);
  select(null);
});
els.reconButton.addEventListener("click", () => {
  window.scrollTo(0, 0);
  select(RECON_ID);
});
els.metricsButton.addEventListener("click", () => {
  window.scrollTo(0, 0);
  select(METRICS_ID);
});
for (const button of els.metricsPeriods) {
  button.addEventListener("click", () => {
    if (state.metricsPeriod !== button.dataset.period) {
      state.metricsPeriod = button.dataset.period;
      // An error belongs to the period it came from.
      state.metricsError = null;
      render();
      refresh();
    }
  });
}
els.reconCheck.addEventListener("click", checkRecon);
for (const [name, select] of [
  ["group", els.boardGroup],
  ["currency", els.boardCurrency],
  ["origin", els.boardOrigin],
]) {
  select.addEventListener("change", () => {
    state.boardFilters[name] = select.value;
    refresh();
  });
}

window.addEventListener("hashchange", () => {
  select(idFromHash());
});
NARROW.addEventListener("change", placePanels);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refresh();
  }
});

setSelected(idFromHash());
render();
watchSupplierList();
refresh();

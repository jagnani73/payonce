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
  review: byId("review"),
  bankChange: byId("bank-change"),
  approval: byId("approval"),
  payments: byId("payments"),
  payAgain: byId("pay-again"),
  payAgainResult: byId("pay-again-result"),
  emails: byId("emails"),
  findings: byId("findings"),
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
  dismissing: false,
  dismissError: null,
};

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

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function failureText(code) {
  if (code === null || code === undefined || code === "") {
    return null;
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

function timeNode(value) {
  const date = parseDate(value);
  return date === null
    ? null
    : h(
        "time",
        { datetime: date.toISOString(), title: dateTimeFormat.format(date) },
        timeFormat.format(date),
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
    const message =
      data !== null && typeof data.error === "string" && data.error !== ""
        ? data.error
        : `The server returned ${response.status}.`;
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

async function loadDetail() {
  const id = state.selectedId;
  if (id === null) {
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
      await Promise.all([loadOptions(), loadList(), loadRuns(), loadInbox(), loadDetail(), loadCash()]);
      if (state.selectedId === null && (state.incidents ?? []).length > 0) {
        setSelected(state.incidents[0].invoiceId);
        refreshAgain = true;
      }
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
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function setSelected(id) {
  state.selectedId = id;
  state.selectedAt = Date.now();
  state.revealSelected = id !== null;
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
  const hash =
    id === null ? "" : runIdOf(id) !== null || inboxIdOf(id) !== null ? `#${id}` : `#${encodeURIComponent(id)}`;
  if (window.location.hash !== hash) {
    window.history.replaceState(null, "", hash === "" ? window.location.pathname : hash);
  }
}

function select(id) {
  if (id === state.selectedId) {
    return;
  }
  setSelected(id);
  render();
  window.setTimeout(render, LOADING_DELAY_MS + 20);
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
    state.fastUntil = Date.now() + EXPECT_WORK_MS;
    window.scrollTo(0, 0);
    select(created.invoiceId);
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
      h("span", { class: "badge" }),
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
    if (invoiceId !== state.selectedId) {
      window.scrollTo(0, 0);
    }
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
  setText(
    button.querySelector(".incident__amount"),
    formatMoney(incident.amountMinor, incident.currency),
  );
  setText(button.querySelector(".incident__supplier"), incident.supplier);
  setText(button.querySelector(".incident__headline"), incident.headline);
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
  const startedBy =
    typeof obligation.startedBy === "string" && obligation.startedBy.trim() !== ""
      ? obligation.startedBy.trim()
      : null;
  // Set when the invoice is paid from another currency's wallet.
  const paidFrom =
    typeof obligation.sourceCurrency === "string" && obligation.sourceCurrency !== obligation.currency
      ? obligation.sourceCurrency
      : null;
  if (
    changed("header", [
      invoiceId,
      obligation.supplier,
      obligation.currency,
      obligation.amountMinor,
      paidFrom,
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
        h("p", { class: "detail__supplier" }, obligation.supplier),
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
      date === null ? "" : timeFormat.format(date),
    ),
    h("span", { class: "event__marker", "aria-hidden": "true" }, icon(kind)),
    h(
      "div",
      { class: "event__body" },
      h("p", { class: "event__kind" }, label),
      h("p", { class: "event__message" }, event.message),
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
      const signature = JSON.stringify([event.kind, event.at, event.message]);
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
    typeof attempt.reference === "string" && attempt.reference !== "" ? attempt.reference : null;
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
      typeof email.fromName === "string" &&
        email.fromName !== "" && [
          h("dt", null, "Name in the email"),
          h("dd", { class: "email__muted" }, `${email.fromName} (not checked)`),
        ],
      h("dt", null, "Subject"),
      h("dd", { class: "email__subject" }, email.subject),
      Number.isInteger(email.uploadId) && [
        h("dt", null, "Uploaded"),
        h(
          "dd",
          null,
          `by ${email.uploadedBy ?? ""}, `,
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
    `${bankChange.calledBy} called `,
    h("span", { class: "mono" }, bankChange.numberCalled),
    " (on file)",
    ...when,
    ` and spoke to ${bankChange.spokeTo}, who confirmed: ${bankChange.confirmed}`,
  ];
}

function caution(message) {
  return h("div", { class: "caution" }, icon("warning"), h("p", { class: "caution__title" }, message));
}

// A held invoice's payment is its first, so the card does not call it a replacement.
function isHeldPayment(approval) {
  return approval.terms?.action === "pay";
}

function approvalLead(approval) {
  const approver =
    typeof approval.approver === "string" && approval.approver !== "" ? approval.approver : null;
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

function buildApproval(invoiceId, approval) {
  const terms = approval.terms ?? {};
  const evidence = terms.evidence ?? {};
  const requested = approval.state === "requested";
  const failure = failureText(evidence.failureCode);
  const originalFacts = [humanize(evidence.originalState), failure?.toLowerCase() ?? null]
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
                  minuteFormat.format(validTo),
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
        terms.payTo,
        bankChange !== null &&
          h(
            "span",
            { class: "terms__sub terms__sub--caution" },
            "Not the account the original payment went to",
          ),
      ),
      held
        ? [
            term("Why it was held", sentence(evidence.reason)),
            term(
              "Looks like a second bill for",
              duplicates.length === 0 ? null : duplicates.map(duplicateNode),
            ),
          ]
        : [
            term("Callback", bankChange === null ? null : callbackText(bankChange)),
            term("Why it was escalated", sentence(evidence.reason)),
            term(
              "Original payment",
              hasReference ? h("span", { class: "mono" }, evidence.originalReference) : originalFacts,
              hasReference && originalFacts !== "" && h("span", { class: "terms__sub" }, originalFacts),
            ),
            term("Email evidence", sentence(evidence.emails)),
          ],
    ),
    h(
      "p",
      { class: "terms__meta" },
      meta("Invoice", terms.invoiceId),
      meta("Beneficiary id", terms.beneficiaryId),
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
          return h("span", { class: "approval__signoff" }, signoff.approver, at !== null && [" at ", at]);
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
  // Who may approve comes with the options, which can arrive after the incident.
  const policy =
    state.options === null ? null : [state.options.approvers, state.options.approvalProblem];
  if (changed("approval", [invoiceId, approval, policy])) {
    if (approval === null) {
      approvalRefs = null;
      els.approval.hidden = true;
      els.approval.replaceChildren();
    } else {
      buildApproval(invoiceId, approval);
    }
  }
  syncApprovalControls();
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

// The card for an incident a person has to close: the bank reports the original
// as paid, so there is no payment to approve. For an invoice held as a likely
// second bill, closing it pays nothing.
function buildReview(invoiceId, review, emailSummary) {
  const hasReference = typeof review.reference === "string" && review.reference !== "";
  const duplicate = review.kind === "duplicate";
  // A held invoice, a likely second bill or any other that has sent nothing, closes unpaid.
  const unpaid = duplicate || review.kind === "unpaid";
  const label = unpaid ? "Close without paying" : "Close incident";
  const paidPayment =
    review.kind === "replacement"
      ? "replacement"
      : review.kind === "outside"
        ? "payout sent outside PayOnce"
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
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitClose(invoiceId);
  });
  reviewRefs = { closedBy, finding, button, error, label };

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
        : unpaid
          ? "PayOnce has sent nothing for this invoice. If it should not be paid, close it without paying. Otherwise PayOnce pays it once it is approved."
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
              hasReference ? h("span", { class: "mono" }, review.reference) : "Paid",
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
    ),
    form,
  );
  els.review.hidden = false;
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
  const emailSummary = typeof detail.findings?.summary === "string" ? detail.findings.summary : "";
  if (changed("review", [invoiceId, review, emailSummary])) {
    if (review === null) {
      reviewRefs = null;
      els.review.hidden = true;
      els.review.replaceChildren();
    } else {
      buildReview(
        invoiceId,
        { kind: review.kind, reference: review.reference, reason: String(review.reason ?? "") },
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
      body: { closedBy, finding },
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

// The value a datetime-local input takes, in local time to the minute.
function localInputValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// "Account name" reads as "account name" in a sentence, "SWIFT code" stays as it is.
function inSentence(label) {
  return String(label).replace(/\b[A-Z][a-z]+\b/g, (word) => word.toLowerCase());
}

// A person can record a callback only while the invoice waits on them and every payment has failed.
function bankChangeShown(detail) {
  const obligation = detail.obligation;
  const attempts = Array.isArray(detail.attempts) ? detail.attempts : [];
  return (
    obligation.state === "escalated" &&
    typeof obligation.supplierPhone === "string" &&
    obligation.supplierPhone.trim() !== "" &&
    attempts.length > 0 &&
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
    callField("calledAt", "callback-at", "When you called", { type: "datetime-local" }),
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
        field.current === "" ? null : `On file now: ${field.current}`,
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

function renderMain() {
  const id = state.selectedId;
  if (inboxIdOf(id) !== null) {
    els.detail.hidden = true;
    els.runDetail.hidden = true;
    renderInboxMain();
    return;
  }
  els.inboxDetail.hidden = true;
  if (runIdOf(id) !== null) {
    els.detail.hidden = true;
    renderRunMain();
    return;
  }
  els.runDetail.hidden = true;
  const detail = currentDetail();
  if (
    id !== null &&
    detail === null &&
    state.detailError === null &&
    Date.now() - state.selectedAt < LOADING_DELAY_MS
  ) {
    // Leave the previous incident on screen for a moment so switching does not flash.
    return;
  }
  const showDetail = id !== null && detail !== null;
  if (!showDetail) {
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
  renderReview(detail);
  renderBankChange(detail);
  renderApproval(detail);
  renderPayments(detail);
  renderEmails(detail);
  els.placeholder.hidden = true;
  els.detail.hidden = false;
}

// ---------- pay runs ----------

let runHeaderRefs = null;
let runApprovalRefs = null;
let runCancelRefs = null;

function runTotalsText(totals) {
  return Array.isArray(totals) && totals.length > 0
    ? totals.map((total) => formatMoney(total.amountMinor, total.currency)).join(" and ")
    : "Nothing to pay";
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
    window.scrollTo(0, 0);
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
    if (key !== state.selectedId) {
      window.scrollTo(0, 0);
    }
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
  setText(button.querySelector(".incident__amount"), runTotalsText(run.counts?.totals));
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
        h("p", { class: "detail__started" }, `Uploaded by ${info.uploadedBy}`, uploadedAt !== null && [" at ", uploadedAt]),
        info.state === "cancelled" &&
          h("p", { class: "detail__started" }, `Cancelled by ${info.cancelledBy}: ${info.cancelNote}`),
      ),
      h(
        "div",
        { class: "detail__facts" },
        h("p", { class: "detail__amount" }, runTotalsText(run.counts?.totals)),
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
    h("p", { class: "run-row__payee" }, row.payTo ?? row.supplier ?? cellOf(columns, row, "supplier")),
    tags.length > 0 && h("p", { class: "run-row__tags" }, tags),
    notes.length > 0 && h("ul", { class: "run-row__reasons" }, notes.map((note) => h("li", null, withPeriod(note)))),
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
      const signature = JSON.stringify([event.kind, event.at, event.message]);
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
  const approver = typeof approval.approver === "string" && approval.approver !== "" ? approval.approver : null;
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
          return h("span", { class: "approval__signoff" }, signoff.approver, at !== null && [" at ", at]);
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

function renderRunApproval(run) {
  const info = run.run;
  const approval = run.approval ?? null;
  const policy = state.options === null ? null : [state.options.approvers, state.options.approvalProblem];
  const waitingLine = runWaitingLine(run);
  if (!changed("runApproval", [info.id, info.state, run.status, approval, policy, waitingLine])) {
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
            entry.feeUnknown > 0 ? (entry.feeUnknown === entry.payments ? "not known" : `not known for ${entry.feeUnknown}`) : "the latest recorded",
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
  els.emailError.replaceChildren(
    withPeriod(error.message),
    error.id !== null && " ",
    error.id !== null && h("a", { href: `#inbox/${error.id}` }, `Open email ${error.id}`),
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
    window.scrollTo(0, 0);
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
          `Delivered by ${upload.deliveredBy ?? ""} to `,
          h("a", { href: `#${encodeURIComponent(upload.invoiceId ?? "")}` }, upload.invoiceId ?? ""),
          " ",
          timeNode(upload.deliveredAt),
        ),
      upload.state === "dismissed" &&
        h("p", { class: "detail__started" }, `Dismissed by ${upload.dismissedBy ?? ""}: ${upload.dismissNote ?? ""}`),
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
        upload.senderName !== "" && [h("dt", null, "Name in the email"), h("dd", { class: "email__muted" }, `${upload.senderName} (not checked)`)],
        h("dt", null, "From as written"),
        h("dd", { class: "email__muted" }, upload.fromAsWritten),
        replyTo.length > 0 && [
          h("dt", null, "Reply-To"),
          h("dd", null, replyTo.map((address) => h("div", { class: "email__from" }, addressParts(address)))),
        ],
        h("dt", null, "Subject"),
        h("dd", { class: "email__subject" }, upload.subject),
        upload.dateAsWritten !== "" && [h("dt", null, "Date in the email"), h("dd", null, upload.dateAsWritten)],
        upload.messageId !== null && [h("dt", null, "Message-ID"), h("dd", { class: "email__muted" }, upload.messageId)],
        h("dt", null, "Uploaded"),
        h("dd", null, `by ${upload.uploadedBy} `, timeNode(upload.uploadedAt)),
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
      h("span", { class: "candidate__line" }, `${candidate.supplier}, ${formatMoney(candidate.amountMinor, candidate.currency)}`),
      h("span", { class: "candidate__line" }, candidate.amongDigits ? `${how}, next to other digits, as in a phone number` : how),
      h("span", { class: candidate.senderOnFile ? "candidate__line" : "candidate__line is-caution" }, sender),
    ),
  );
}

function matchLead(candidates, suggested) {
  if (candidates.length === 0) {
    return "No invoice number from the ledger is in this email. Pick the invoice it is about, or dismiss it.";
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
  const other = h("input", { type: "radio", name: "inbox-invoice", value: "" });
  other.checked = detail.suggested === null;
  const otherInvoice = h("input", { type: "text", id: "inbox-other-invoice", autocomplete: "off", spellcheck: "false", maxlength: "40" });
  otherInvoice.addEventListener("input", () => {
    other.checked = true;
  });
  const deliveredBy = h("input", { type: "text", id: "inbox-delivered-by", autocomplete: "name", maxlength: "80" });
  deliveredBy.value = readStoredName();
  const button = h("button", { class: "button button--primary", type: "submit" }, "Deliver");
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const form = h(
    "form",
    { class: "approve-form", novalidate: true },
    h("p", { class: "approval__lead" }, matchLead(candidates, detail.suggested)),
    candidates.map((candidate) => candidateRow(candidate, candidate.invoiceId === detail.suggested)),
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
  matchRefs = { form, otherInvoice, deliveredBy, button, error };
  els.inboxMatch.replaceChildren(h("h2", { id: "inbox-match-title" }, "Which invoice is it about?"), form);
  els.inboxMatch.hidden = false;
  syncMatch();
}

function syncMatch() {
  if (matchRefs === null) {
    return;
  }
  matchRefs.button.disabled = state.delivering;
  setText(matchRefs.button, state.delivering ? "Delivering" : "Deliver");
  if (liveMessage("inboxMatch", state.deliverError) === null) {
    state.deliverError = null;
  }
  showMessage(matchRefs.error, state.deliverError?.message);
}

async function submitDeliver(uploadId) {
  if (state.delivering || matchRefs === null) {
    return;
  }
  const picked = matchRefs.form.querySelector('input[name="inbox-invoice"]:checked');
  const invoiceId = picked === null ? "" : picked.value === "" ? matchRefs.otherInvoice.value.trim() : picked.value;
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
  return `at ${timeFormat.format(at)}`;
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
    const when = failedAt === null ? "" : ` at ${timeFormat.format(failedAt)}`;
    problems.push(
      readAt === null
        ? `Airwallex could not be read${when}: ${withPeriod(error.message)} PayOnce's own figures are current.`
        : `The last read${when} failed: ${withPeriod(error.message)} The panel shows the read from ${timeFormat.format(readAt)}.`,
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
    cashLinesOf(currency, ["sending", "approved", "pay-run", ...WAITING_KINDS]).length > 0 ||
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

function render() {
  renderForm();
  renderRunForm();
  renderList();
  renderRunList();
  renderEmailForm();
  renderInboxList();
  renderCash();
  renderMain();
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

window.addEventListener("hashchange", () => {
  select(idFromHash());
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refresh();
  }
});

setSelected(idFromHash());
render();
refresh();

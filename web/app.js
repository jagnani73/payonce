const POLL_BUSY_MS = 1500;
const POLL_IDLE_MS = 5000;
// After an action the backend is about to work, so keep polling fast and follow the timeline.
const EXPECT_WORK_MS = 15000;
// A new incident may not be readable until the backend has written it.
const STARTING_GRACE_MS = 30000;
// Keep the previous incident on screen this long before showing a loading state.
const LOADING_DELAY_MS = 250;
const STARTED_BY_KEY = "payonce.startedBy";

const OBLIGATION_STATES = {
  open: { label: "Open", tone: "active" },
  escalated: { label: "Waiting on a person", tone: "waiting" },
  settled: { label: "Closed", tone: "paid" },
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
  review: byId("review"),
  bankChange: byId("bank-change"),
  approval: byId("approval"),
  payments: byId("payments"),
  payAgain: byId("pay-again"),
  payAgainResult: byId("pay-again-result"),
  emails: byId("emails"),
  findings: byId("findings"),
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
  for (const child of children.flat()) {
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
    throw new Error(message);
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

async function loadDetail() {
  const id = state.selectedId;
  if (id === null) {
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
      await Promise.all([loadOptions(), loadList(), loadDetail()]);
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
  const hash =id === null ? "" : `#${encodeURIComponent(id)}`;
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
  const canResume = !busy && obligation.state !== "settled";
  const startedBy =
    typeof obligation.startedBy === "string" && obligation.startedBy.trim() !== ""
      ? obligation.startedBy.trim()
      : null;
  if (
    changed("header", [
      invoiceId,
      obligation.supplier,
      obligation.currency,
      obligation.amountMinor,
      obligation.state,
      obligation.origin,
      startedBy,
      busy,
    ])
  ) {
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
        startedBy !== null && h("p", { class: "detail__started" }, `Started by ${startedBy}`),
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
      h("dt", null, "Subject"),
      h("dd", { class: "email__subject" }, email.subject),
    ),
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
  // Limits are in the payment's own currency.
  if (
    typeof approver.limitMinor === "number" &&
    typeof terms.amountMinor === "number" &&
    approver.limitMinor < terms.amountMinor
  ) {
    return `can approve up to ${formatMoney(approver.limitMinor, terms.currency)}`;
  }
  return null;
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

function approvalLead(approval) {
  const approver =
    typeof approval.approver === "string" && approval.approver !== "" ? approval.approver : null;
  switch (approval.state) {
    case "requested": {
      const needed = neededOf(approval);
      if (needed < 2) {
        return "A person must approve this replacement before PayOnce sends it.";
      }
      const people = needed === 2 ? "Two different people" : `${needed} different people`;
      const why = typeof approval.neededWhy === "string" ? approval.neededWhy.trim() : "";
      return why === ""
        ? `${people} must approve this replacement before PayOnce sends it.`
        : `${people} must approve this replacement before PayOnce sends it, because ${why}.`;
    }
    case "approved":
      return approver === null
        ? "Approved. PayOnce checks the terms again before it sends the replacement."
        : `Approved by ${approver}. PayOnce checks the terms again before it sends the replacement.`;
    case "used":
      return approver === null
        ? "Used for one replacement payment. It cannot be used again."
        : `Approved by ${approver} and used for one replacement payment. It cannot be used again.`;
    case "void":
      return approver === null
        ? "Void. This approval no longer covers a payment."
        : `Void. ${approver} approved it, but it no longer covers a payment.`;
    default:
      return "";
  }
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

  const children = [
    h(
      "div",
      { class: "approval__head" },
      h("h2", { id: "approval-title" }, "Replacement approval"),
      badge(expired ? EXPIRED_REQUEST : APPROVAL_STATES[approval.state], approval.state, false),
    ),
    h("p", { class: "approval__lead" }, approvalLead(approval)),
    h(
      "dl",
      { class: "terms" },
      h("dt", null, "Amount"),
      h("dd", { class: "terms__amount" }, formatMoney(terms.amountMinor, terms.currency)),
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
      term("Callback", bankChange === null ? null : callbackText(bankChange)),
      term("Why it was escalated", sentence(evidence.reason)),
      term(
        "Original payment",
        hasReference ? h("span", { class: "mono" }, evidence.originalReference) : originalFacts,
        hasReference && originalFacts !== "" && h("span", { class: "terms__sub" }, originalFacts),
      ),
      term("Email evidence", sentence(evidence.emails)),
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
  approvalRefs = { select, button, error, locked, approvalId: approval.id };

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
    "Approve replacement",
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
      "Your approval covers these exact terms and one payment. If the terms change, it is void.",
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
    setText(approvalRefs.button, state.approving ? "Approving" : "Approve replacement");
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
// as paid, so there is no payment to approve.
function buildReview(invoiceId, review, emailSummary) {
  const hasReference = typeof review.reference === "string" && review.reference !== "";
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

  const button = h("button", { class: "button button--primary", type: "submit" }, "Close incident");
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
    h("p", { class: "hint" }, "Closing records your name and this note on the timeline. It does not move money."),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitClose(invoiceId);
  });
  reviewRefs = { closedBy, finding, button, error };

  setClass(els.review, "card approval approval--requested");
  els.review.replaceChildren(
    h(
      "div",
      { class: "approval__head" },
      h("h2", { id: "review-title" }, "Close this incident"),
      badge(OBLIGATION_STATES.escalated, "escalated", false),
    ),
    h(
      "p",
      { class: "approval__lead" },
      `The bank reports the ${paidPayment} as paid, so PayOnce will not send another. Check with the supplier, then close the incident.`,
    ),
    h(
      "dl",
      { class: "terms" },
      h("dt", null, sentence(paidPayment)),
      h(
        "dd",
        null,
        hasReference ? h("span", { class: "mono" }, review.reference) : "Paid",
        hasReference && h("span", { class: "terms__sub" }, "Paid"),
      ),
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
  setText(reviewRefs.button, state.closing ? "Closing" : "Close incident");
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
  renderReview(detail);
  renderBankChange(detail);
  renderApproval(detail);
  renderPayments(detail);
  renderEmails(detail);
  els.placeholder.hidden = true;
  els.detail.hidden = false;
}

function render() {
  renderForm();
  renderList();
  renderMain();
}

// ---------- start ----------

els.form.addEventListener("submit", startIncident);
els.payAgain.addEventListener("click", payAgain);
els.startedBy.value = readStoredName();
els.startedBy.addEventListener("input", () => {
  storeName(els.startedBy.value);
  if (state.createError !== null) {
    state.createError = null;
    renderForm();
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

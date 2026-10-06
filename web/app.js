const POLL_BUSY_MS = 1500;
const POLL_IDLE_MS = 5000;
// After an action the backend is about to work, so keep polling fast and follow the timeline.
const EXPECT_WORK_MS = 15000;
// A new incident may not be readable until the backend has written it.
const STARTING_GRACE_MS = 30000;
// Keep the previous incident on screen this long before showing a loading state.
const LOADING_DELAY_MS = 250;

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

const EVENT_KINDS = {
  payment: "Payment",
  email: "Supplier email",
  bank: "Bank",
  decision: "Decision",
  approval: "Approval",
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
  approval: byId("approval"),
  payments: byId("payments"),
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
  fastUntil: 0,
  drafts: new Map(),
  closeDrafts: new Map(),
};

// Signatures of what each section last drew, so an unchanged poll touches nothing.
const painted = new Map();
let approvalRefs = null;
let reviewRefs = null;
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
    state.options = {
      bankOutcomes: Array.isArray(options.bankOutcomes) ? options.bankOutcomes : [],
      emailThreads: Array.isArray(options.emailThreads) ? options.emailThreads : [],
      scenarios: Array.isArray(options.scenarios) ? options.scenarios : [],
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
  if (detail?.busy === true) {
    return true;
  }
  return (state.incidents ?? []).some((incident) => incident.busy === true);
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
  const hash = id === null ? "" : `#${encodeURIComponent(id)}`;
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
  els.startButton.disabled = locked;
  setText(els.startButton, state.creating ? "Starting" : "Start incident");
  showMessage(els.newError, state.createError ?? state.optionsError);
}

async function startIncident(event) {
  event.preventDefault();
  if (state.creating || state.options === null) {
    return;
  }
  const body = {
    bankOutcome: els.bankOutcome.value,
    emails: els.emailThread.value,
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
  if (
    changed("header", [
      invoiceId,
      obligation.supplier,
      obligation.currency,
      obligation.amountMinor,
      obligation.state,
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
  if (!changed("payments", [detail.obligation.invoiceId, attempts])) {
    return;
  }
  els.payments.replaceChildren(
    attempts.length === 0
      ? h("p", { class: "empty" }, "No payments yet")
      : h("ul", null, attempts.map(buildAttempt)),
  );
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

function approvalLead(approval) {
  const approver =
    typeof approval.approver === "string" && approval.approver !== "" ? approval.approver : null;
  switch (approval.state) {
    case "requested":
      return "A person must approve this replacement before PayOnce sends it.";
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

  const previousInput = approvalRefs?.input ?? null;
  const hadFocus = previousInput !== null && document.activeElement === previousInput;
  const selection = hadFocus ? [previousInput.selectionStart, previousInput.selectionEnd] : null;

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
      badge(APPROVAL_STATES[approval.state], approval.state, false),
    ),
    h("p", { class: "approval__lead" }, approvalLead(approval)),
    h(
      "dl",
      { class: "terms" },
      h("dt", null, "Amount"),
      h("dd", { class: "terms__amount" }, formatMoney(terms.amountMinor, terms.currency)),
      term("Pay to", terms.payTo),
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
  let input = null;
  let button = null;
  if (requested) {
    input = h("input", {
      type: "text",
      id: "approver",
      name: "approver",
      autocomplete: "name",
      maxlength: "80",
    });
    input.value = state.drafts.get(invoiceId) ?? "";
    input.addEventListener("input", () => {
      state.drafts.set(invoiceId, input.value);
      if (state.approveError !== null) {
        state.approveError = null;
        syncApprovalControls();
      }
    });
    button = h("button", { class: "button button--primary", type: "submit" }, "Approve replacement");
    const form = h(
      "form",
      { class: "approve-form", novalidate: true },
      h(
        "div",
        { class: "approve-form__row" },
        h("label", { class: "field" }, h("span", { class: "field__label" }, "Your name"), input),
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
    children.push(form);
  } else {
    // With no form left, a refused approval is still explained under the lead.
    children.splice(2, 0, error);
  }
  // The id says which request an approval is for. The server refuses one that is out of date.
  approvalRefs = { input, button, error, approvalId: approval.id };

  setClass(els.approval, requested ? "card approval approval--requested" : "card approval");
  els.approval.replaceChildren(...children);
  els.approval.hidden = false;

  if (input !== null && hadFocus) {
    input.focus();
    if (selection[0] !== null && selection[1] !== null) {
      input.setSelectionRange(selection[0], selection[1]);
    }
  }
}

function syncApprovalControls() {
  if (approvalRefs === null) {
    return;
  }
  if (approvalRefs.button !== null) {
    approvalRefs.button.disabled = state.approving;
    approvalRefs.input.readOnly = state.approving;
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
  if (changed("approval", [invoiceId, approval])) {
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
  if (state.approving || approvalRefs === null || approvalRefs.input === null) {
    return;
  }
  const approver = approvalRefs.input.value.trim();
  if (approver === "") {
    state.approveError = actionError("approval", "Enter your name to approve.");
    syncApprovalControls();
    approvalRefs.input.focus();
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
      "The bank reports the original payment as paid, so PayOnce will not send another. Check with the supplier, then close the incident.",
    ),
    h(
      "dl",
      { class: "terms" },
      h("dt", null, "Original payment"),
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
      buildReview(invoiceId, { reference: review.reference, reason: String(review.reason ?? "") }, emailSummary);
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

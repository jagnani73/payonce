import { request } from "node:http";

// Sets up the demo's morning on a fresh ledger, through the routes the page uses:
// a pay run uploaded, approved by two and released; a payment whose bank says the
// account is closed, followed by an email from a look-alike domain asking for a
// new account; and an EUR payment whose replacement would break the floor. It
// leaves three payments waiting on a person and makes five sandbox transfers.
// Run it against pnpm ui after pnpm reset:
//   node scripts/demo-morning.mjs [http://127.0.0.1:4310]
// docs/demo.md walks through what it leaves.

const BASE = new URL(process.argv[2] ?? "http://127.0.0.1:4310");
const UPLOADER = "Kim";
const APPROVERS = ["Alex", "Yash"];
const STARTER = "Sam";
const SETTLE_MS = 300_000;
const POLL_MS = 2_000;

function call(method, path, body) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const headers = { host: BASE.host };
  if (data !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(data);
    headers.origin = BASE.origin;
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: BASE.hostname, port: BASE.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = { error: text };
        }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on("error", reject);
    if (data !== undefined) {
      req.write(data);
    }
    req.end();
  });
}

async function must(method, path, body) {
  const answer = await call(method, path, body);
  if (answer.status >= 300) {
    throw new Error(`${method} ${path} answered ${answer.status}: ${answer.json.error ?? JSON.stringify(answer.json)}`);
  }
  return answer.json;
}

function say(line) {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const incidentPath = (invoiceId) => `/api/incidents/${encodeURIComponent(invoiceId)}`;

// An invoice is at rest when nothing runs for it and it is closed or waits on a person.
async function atRest(invoiceId) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const view = await must("GET", incidentPath(invoiceId));
    const group = view.situation.group;
    if (!view.activity.busy && (group === "needs-you" || group === "closed")) {
      return view;
    }
    if (Date.now() > deadline) {
      throw new Error(`${invoiceId} is still "${view.situation.label}" after ${SETTLE_MS / 1000} s. Open it on the page`);
    }
    await sleep(POLL_MS);
  }
}

// A payment held before anything was sent, such as a first payment that waits for
// an approval, is approved here so the morning starts after it went out.
async function sendIfHeld(invoiceId) {
  let view = await atRest(invoiceId);
  const asked = view.decision.open?.request ?? null;
  if (view.transfers.length > 0 || asked === null) {
    return view;
  }
  for (const approver of APPROVERS.slice(0, asked.needed)) {
    await must("POST", `${incidentPath(invoiceId)}/approve`, { approver, approvalId: asked.id });
    say(`${invoiceId}: first payment approved by ${approver}`);
  }
  await sleep(POLL_MS);
  view = await atRest(invoiceId);
  return view;
}

async function scenario(body) {
  const started = await must("POST", "/api/sandbox/scenarios", { ...body, startedBy: STARTER });
  say(`${started.invoiceId} started by ${STARTER}: ${body.scenario}, the bank plays ${body.bankOutcome}`);
  const view = await sendIfHeld(started.invoiceId);
  say(`${started.invoiceId}: ${view.situation.label}`);
  return started.invoiceId;
}

function lookalikeEmail(invoiceId) {
  return [
    "From: Example Supplier Accounts <accounts@example-supp1ier.test>",
    "To: payables@payonce.test",
    `Subject: RE: ${invoiceId} payment returned`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${invoiceId.toLowerCase()}-new-bank@example-supp1ier.test>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hi,",
    "",
    `Your payment for ${invoiceId} came back because our old account is closed. We have changed banks.`,
    "Please resend it today to our new account:",
    "",
    "Bank: First Example Bank",
    "Routing: 000000000",
    "Account: 9988776655",
    "",
    "This is urgent. Our next shipment is on hold until it arrives.",
    "",
    "Regards,",
    "Accounts, Example Supplier",
    "",
  ].join("\r\n");
}

async function checkStart() {
  const home = await must("GET", "/api/home");
  if (home.firstRun === null) {
    throw new Error("The ledger is not empty. Stop pnpm ui, run pnpm reset, start pnpm ui and run this again");
  }
  const settings = await must("GET", "/api/settings");
  const names = settings.approvals.approvers.map((approver) => approver.name.toLowerCase());
  for (const name of [UPLOADER, STARTER, ...APPROVERS]) {
    if (!names.includes(name.toLowerCase())) {
      throw new Error(`${name} is not in APPROVERS. Use APPROVERS=Yash:50000,Alex:10000,Kim:10000,Sam:4200`);
    }
  }
}

// The scripted incidents' USD supplier. The picker shows 20 records, and every
// bank change run adds one with a longer nickname, so when it is not among them
// the id comes from the example pay run file, which names this sandbox's records.
async function demoSupplier() {
  const picker = await must("GET", `/api/beneficiaries?q=${encodeURIComponent("PayOnce demo supplier")}`);
  if (picker.problem !== null) {
    throw new Error(`Airwallex could not be read: ${picker.problem.text ?? JSON.stringify(picker.problem)}`);
  }
  const found = picker.options.find(
    (option) => option.nickname === "PayOnce demo supplier" && option.currency === "USD" && option.methods.includes("LOCAL"),
  );
  if (found !== undefined) {
    return found.key;
  }
  const example = await call("GET", "/api/runs/example.csv");
  const key = example.text.split(/\r?\n/).find((row) => /,USD,LOCAL,/.test(row))?.split(",")[2];
  if (key === undefined) {
    throw new Error('The sandbox has no "PayOnce demo supplier" yet. Start one scripted incident (USD, local transfer, Paid) from the simulator, then pnpm reset and run this again');
  }
  say(`Using the USD supplier in fixtures/pay-run-example.csv, ${key}`);
  return key;
}

async function payRun(supplierKey) {
  const csv = [
    "invoice,supplier,beneficiary_id,amount,currency,method,sandbox_outcome",
    `INV-RUN-1001,Example Supplier LLC,${supplierKey},1250.00,USD,LOCAL,CHANNEL_TIMEOUT`,
    `INV-RUN-1002,Example Supplier LLC,${supplierKey},980.00,USD,LOCAL,ACCOUNT_CLOSED`,
    `INV-RUN-1002A,Example Supplier LLC,${supplierKey},980.00,USD,LOCAL,PAID`,
    "",
  ].join("\n");
  const uploaded = await call("POST", "/api/runs", { uploadedBy: UPLOADER, fileName: "overnight-run.csv", csv });
  const rows = uploaded.json.view?.rows ?? uploaded.json.rows ?? [];
  if (uploaded.status >= 300 || uploaded.json.view.counts.pay !== 2) {
    const reasons = rows.flatMap((row) => (row.skipReasons ?? []).map((reason) => `row ${row.line}: ${reason.text}`));
    throw new Error(
      `The pay run should pay 2 rows (${uploaded.json.error ?? "it does not"}). On a sandbox account that has never run a scripted incident, start one (USD, local transfer, Paid) from the simulator first. Then pnpm reset and run this again.\n${reasons.join("\n")}`,
    );
  }
  const run = uploaded.json.view;
  say(`Pay run ${run.run.id} uploaded by ${UPLOADER}: ${run.counts.pay} to pay, ${run.counts.skip} skipped`);
  const asked = run.decision?.request ?? null;
  if (asked === null) {
    throw new Error(`Pay run ${run.run.id} opened no request: ${run.situation.label}`);
  }
  for (const approver of APPROVERS.slice(0, asked.needed)) {
    await must("POST", `/api/runs/${run.run.id}/approve`, { approver, approvalId: asked.id });
    say(`Pay run ${run.run.id} approved by ${approver}`);
  }
  const deadline = Date.now() + SETTLE_MS;
  let released = run;
  while (released.run.releasedAt === null) {
    if (Date.now() > deadline) {
      throw new Error(`Pay run ${run.run.id} is still "${released.situation.label}". Open it on the page`);
    }
    await sleep(POLL_MS);
    released = await must("GET", `/api/runs/${run.run.id}`);
  }
  say(`Pay run ${run.run.id} released`);
  for (const row of released.rows.filter((row) => row.state === "released" && row.invoiceId !== null)) {
    const view = await atRest(row.invoiceId);
    say(`${row.invoiceId}: ${view.situation.label}`);
  }
}

async function bankChange() {
  const invoiceId = await scenario({ scenario: "usd-local-bank-change", bankOutcome: "ACCOUNT_CLOSED", emails: "nothing-arrived" });
  const eml = Buffer.from(lookalikeEmail(invoiceId), "utf8").toString("base64");
  const upload = await must("POST", "/api/inbox", { uploadedBy: UPLOADER, source: "paste", eml });
  await must("POST", `/api/inbox/${upload.id}/deliver`, { deliveredBy: UPLOADER, invoiceId });
  say(`Email ${upload.id} from accounts@example-supp1ier.test uploaded and delivered to ${invoiceId} by ${UPLOADER}`);
  await sleep(POLL_MS);
  say(`${invoiceId}: ${(await atRest(invoiceId)).situation.label}`);
}

async function main() {
  await checkStart();
  await payRun(await demoSupplier());
  await bankChange();
  await scenario({ scenario: "eur-swift-low-reserve", bankOutcome: "CHANNEL_TIMEOUT", emails: "nothing-arrived" });
  const after = await must("GET", "/api/home");
  say(`Needs you: ${after.needsYou.length}`);
  for (const item of after.needsYou) {
    say(`  ${item.row.invoiceId ?? `pay run ${item.row.runId}`}`);
  }
}

main().catch((error) => {
  console.error(error?.code === "ECONNREFUSED" ? `Nothing answers at ${BASE.origin}. Start pnpm ui first` : error.message);
  process.exitCode = 1;
});

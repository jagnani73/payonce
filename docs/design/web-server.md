# Web server

`pnpm ui` runs the page, the JSON API, the agent's dispatcher, the watcher, webhooks, alerts and the reconciliation timer in one process, bound to loopback. The server is `src/surfaces/http/` (`main.ts`, `router.ts`, `http.ts`, `app.ts`, `start.ts` and `routes/*.ts`) and the page is `web/src/`. Every GET answers a view from [views.md](views.md), webhooks are in [webhooks.md](webhooks.md), and [architecture.md](../architecture.md#text-payonce-did-not-write) has the table of how outside text is cleaned.

## Rules

### Start order

- `main` loads `.env` with `loadEnvIfPresent` before it reads any setting, then reads them all once with `loadSettings`.
- `createEngine` builds the engine. A missing credential, or an Airwallex address that is not the sandbox, stops the server in PayOnce's words (`EngineBuild.problem`) with exit 1, before anything opens.
- `main` then builds, in this order: the `SandboxBank`, the `Dispatcher`, the explainer (`explainerFor`, null without a model key) and its `ExplainLimiter`, `startRelease`, the `Watcher`, the `ReconRunner`, the `BalanceCache`, and `Alerts` when an alert target is set.
- The `SandboxBank` gives a pay run row's original the row's `sandbox_outcome`, which it reads from the ledger (`runRowOf`), and writes a failure it hears through the bank hook with `noteError`.
- The `Watcher` checks every 3 seconds (`CHECK_EVERY_MS`) and sweeps every 30 (`SWEEP_EVERY_MS`). The `ReconRunner` reads Airwallex on its own timer, in no invoice's turn and under no currency lease.
- `httpApp` bundles the parts with the helpers more than one route file uses. The route table is each `routes/*.ts` file's routes, concatenated in `main`'s order, and `startUp` prepares the restart pickup and the webhooks.
- The server listens on `HOST` (127.0.0.1) and `PORT`, then prints its start-up lines. The first is the page's address, and the second is `describeAirwallex`, which on `OFFLINE_HOST` says no call reaches Airwallex and nothing can be paid.
- The rest of the start-up lines are the email reader's name, `describePolicy`, `describeFloors`, `describeQuotes`, `describeOutageRule`, `describeAlerts` and `describeReconSetting`.
- Once listening, it starts one balance read, wakes interrupted payments (`pickUpInterrupted`), starts the watcher, the alerts and the reconciliation timer, and connects webhooks without waiting for them (`connectWebhooks`).
- The server prints an unhandled rejection and keeps running. On exit it stops the tunnel, and SIGINT and SIGTERM exit 0.

### Picking up after a restart

- `pickUpInterrupted` wakes every invoice that is not settled or rejected and has a payment with the bank (`withBank`) or an outside payout that is neither paid nor failed (`isWatching`). The look that follows syncs with Airwallex and never sends a new payment by itself.
- The sandbox bank goes back to paying any replacement still in flight, an original in flight that was paid on an approval after a hold, and a pay run row's original in flight (`resumedBySandbox`).
- `resumedBySandbox` reads the approval each attempt was opened on (`approvalOf`), not the invoice's latest request.
- A released pay run row that never sent is left to the watcher, which wakes such rows one at a time with the run's turn.

### The guard

- The server binds to loopback and has no login. `guard` refuses with 403 any Host but `127.0.0.1:<port>` and `localhost:<port>`.
- A request that is not a GET needs `Origin: http://<host>` and a JSON content type, or it gets 403.
- A GET under /api/ gets 403 when `sec-fetch-site` is present and is neither `same-origin` nor `none`, or when an `Origin` header names another origin (`crossSite`). Page files are not checked this way.
- `X-Content-Type-Options: nosniff` is set before routing, so every answer has it, CSV downloads and errors included.

### Routing and errors

- Every path outside /api/ is a page file and takes GET only (405 otherwise). Under /api/ the first route in the table whose method and pattern match answers, and none is 404.
- A pattern that starts with `/` matches that whole path. One without matches the path's segments, each `:name` standing for any one segment, which the handler gets in order.
- An error answers `{ error, ...extra }` with the `HttpError`'s status, `extra` and `headers`, such as `Retry-After`. Any other error answers 500, and the server prints it.
- A body not read to its end, as after a slow upload, is not waited for: the answer carries `Connection: close`.

### Bodies and typed fields

- A JSON body is at most 64 KB (`MAX_BODY_BYTES`) and must be a JSON object, else 400. An empty body reads as `{}`.
- `POST /api/runs` takes up to 256 KB (`MAX_RUN_BODY_BYTES`) and `POST /api/inbox` up to 3 MB (`MAX_INBOX_BODY_BYTES`). Both refuse with 408 a body that takes over 30 seconds to arrive (`UPLOAD_BODY_MS`).
- Files travel inside JSON: a pay run file as a string, an email as strict base64. The guard's Origin and content type checks cover an upload, and nothing parses multipart.
- `text` reads a typed field as one line (`oneLine`), `typed` reads it as sent, and `name` takes it through `personName`, answering 400 with what a name may hold. See [names.md](names.md).
- A name is read as sent, never through `text`, so a line break or other control character in it is refused instead of becoming a space.
- A note or finding is 1 to 200 characters (`MAX_FINDING_LENGTH`). Run, upload, draft, contact and outage ids must match `RUN_ID_PATTERN`, and invoice numbers `INVOICE_ID_PATTERN`. Anything else answers 404.

### Turns

- A person's step on an invoice runs in the invoice's turn (`inTurn`), behind whatever the agent is doing there. A refusal the step throws as an `HttpError` keeps its status. Any other error answers 409 with its message.
- Approve and close wait for any step already running on the invoice, then run. Check (and its alias `resume`) only queues a look.
- Every step on a pay run (approve, check, cancel, release) runs in `runKey(id)`'s turn. In `inRunTurn` an Airwallex failure answers 502 with `airwallexAdvice`, and any other error 409.
- An approval that completes a run's request starts the release in the run's turn and does not wait for it (`startRelease`).
- The outbox steps run in the invoice's turn (`inOutboxTurn`). Its known refusals answer 409 or 422, and any other error 500.
- Ask why, ending an outage, dismissing an upload and the contact changes take no invoice's turn.
- After an outage end or a contact change, the server wakes the invoices it made due, except released pay run rows that have not sent. The watcher sends those in their turn.

### Routes

The table lists every route in `src/surfaces/http/routes/`. Views and their builders are in [views.md](views.md). A 404 for an id the ledger does not have is left out of the refusals.

| Method | Path | Answers | Refusals |
|---|---|---|---|
| GET | `/api/home?me=` | `HomeView` | 400 for a name `personName` refuses |
| GET | `/api/status` | `StatusView`, and a balance read when the cache is 30 s old | |
| GET | `/api/settings` | `SettingsView` | |
| GET | `/api/search?q=` | `SearchView` | 400 for an empty query or one over 100 characters |
| GET | `/api/reports?period=` | `ReportsView` | 400 for a period other than `7d`, `30d` or `all` |
| GET | `/api/metrics?period=` | `MetricsReport` | 400 as for reports |
| GET | `/api/audit` | `AuditCheckView` | |
| GET | `/api/audit/export` | `ledgerAuditExport`, as the attachment payonce-audit.json | |
| GET | `/api/beneficiaries?q=` | `BeneficiaryPickerView` | |
| GET | `/api/incidents` | `IncidentsView`, filtered by `scope`, `currency`, `origin`, `me`, `clean` and `q` | 400 for a value it does not know |
| GET | `/api/board` | 307 to `/api/incidents`, with `{ location }` as the body | 400 for a group other than person, deadline, bank or open |
| GET | `/api/incidents/:id` | `IncidentView` | |
| GET | `/api/incidents/:id/audit?format=` | `auditExport` as JSON, or CSV with the header `X-Audit-Chain` | 400 for a format other than json or csv |
| GET | `/api/incidents/:id/bank-details` | `bankChangeForm` | |
| POST | `/api/incidents/:id/approve` | `Acted<IncidentView>`, given `approver` and `approvalId` | 400 without them, 409 for the engine's refusal |
| POST | `/api/incidents/:id/close` | `Acted<IncidentView>`, given `closedBy`, `finding`, `covered` and `as` | 400, 409 `close-kind-changed`, 409 for the engine's refusal |
| POST | `/api/incidents/:id/check` | `Acted<IncidentView>` after queuing a look (`resume` is the same) | |
| POST | `/api/incidents/:id/bank-change` | `Acted<IncidentView>`, given `calledBy`, `numberCalled`, `calledAt`, `spokeTo`, `confirmed` and `details` | 400, 409 |
| POST | `/api/incidents/:id/why` | `AskWhyAnswer` | 503 with no model key, 500 when the facts cannot be built, the limiter's status with `Retry-After`, 502 when no model answers |
| POST | `/api/incidents/:id/outbox` | 201 `Acted<IncidentView>` and `draftId`, given `template` and `createdBy` | 400, 409 with `draftId` while a draft of that template is open, 422 when it does not fit now |
| POST | `/api/incidents/:id/outbox/:draft/copied`, `/sent`, `/dismiss` | `Acted<IncidentView>`, given `copiedBy` (optional), `sentBy`, or `dismissedBy` and an optional `note` | 404 for another invoice's draft, 409 once sent or dismissed, 400 for a note over 200 characters |
| GET | `/api/runs` | `RunsView` | |
| POST | `/api/runs` | 201 `Acted<RunView>`, given `fileName`, `csv` and `uploadedBy` | 400 with `problems`, 409 `run-waiting` or `same-file` with `runId`, 422 `nothing-to-pay` with `rows`, 408, 413, 502 |
| GET | /api/runs/example.csv | `fixtures/pay-run-example.csv` as an attachment | |
| GET | `/api/runs/:id` | `RunView` | |
| GET | `/api/runs/:id/audit?format=` | `runAuditExport` as JSON or CSV | 400 for another format |
| POST | `/api/runs/:id/approve` | `Acted<RunView>`, given `approver` and `approvalId` | 400, 409 |
| POST | `/api/runs/:id/check` | `Acted<RunView>` | 409, 502 |
| POST | `/api/runs/:id/cancel` | `Acted<RunView>`, given `cancelledBy` and `note` | 400, 409 |
| GET | `/api/inbox?tab=` | `InboxListView` | 400 for a tab other than waiting, delivered or dismissed |
| POST | `/api/inbox` | 201 `UploadEmailResult`, given `uploadedBy`, `source`, `fileName` and `eml` | 400, 413 over 2 MB, 503 while four uploads wait to be parsed, 408, 409 with `id`, `state` and `invoiceId` |
| GET | `/api/inbox/:id` | `InboxItemView` | |
| POST | `/api/inbox/:id/deliver` | `Acted<InboxItemView>`, given `invoiceId` and `deliveredBy` | 400, 409 |
| POST | `/api/inbox/:id/dismiss` | `Acted<InboxItemView>`, given `dismissedBy` and `note` | 400, 409 once it is not waiting |
| GET | `/api/suppliers?q=` | `SuppliersView` | 400 for a query over 100 characters |
| GET | `/api/suppliers/:key` | `SupplierView` | |
| GET | `/api/suppliers/:key/contact` | `SupplierContactDetail`, the number on file in full | |
| POST | `/api/suppliers/:key/contact` | `Acted<SupplierView>` after a proposal | `ContactError`: 400, 403, 404 or 409 by its `why` |
| POST | `/api/suppliers/:key/contact/:id/confirm`, `/withdraw` | `Acted<SupplierView>` | as for a proposal |
| GET | `/api/cash` | `CashView` | |
| GET | `/api/cash/cached` | `CashReport` from the cache as it is, read soft, for the MCP server | |
| GET | `/api/outages` | `OutagesView` | |
| POST | `/api/outages/:id/end` | `EndOutageResult`, given `endedBy` and `note` | 400, 403 for a name that may not end it, 409 with `endedBy` and `endedAt` |
| GET | `/api/reconcile` | `ReconView` | |
| GET | `/api/reconcile/movements?currency=` | `ReconMovementsView` | 400 for a currency not in three capital letters |
| POST | `/api/reconcile/run` | 202 `{ started: true }` | 409 while a check runs, 429 with `Retry-After: 60` within a minute of the last |
| POST | `/api/reconcile/explain` | `Acted<ReconView>`, given `breaks`, `explainedBy` and `note` | 400, 404 with `unknown`, 409 with `changed` |
| GET | `/api/alerts` | the alert status and the last 50 alerts | |
| GET | `/api/sandbox` | `SandboxView` | |
| POST | `/api/sandbox/scenarios` | 202 `PaymentCreated` | 400, 409, 502 |
| POST | `/api/sandbox/duplicate-lock/:id` | `DuplicateLockResult` | |
| POST | `/api/payments/check` | `PaymentCheckView` | |
| POST | `/api/payments` | 201 `PaymentCreated` | 400 `fields`, 409 `duplicate-invoice`, 502 `airwallex-unreachable` |

- Every action answers `Acted<View>`: the view built after the step's turn ends, from reads only, and a `notice` with a `tone` and a `text`. A start answers `PaymentCreated` and an upload `UploadEmailResult`, each with a view and a notice. An outage end answers `EndOutageResult`.
- A refusal carries `code` only for `close-kind-changed`, `fields`, `duplicate-invoice`, `airwallex-unreachable` and the pay run upload's `run-waiting`, `same-file` and `nothing-to-pay`. Every other refusal is told by its status and its words.
- `GET /api/board` maps `group` to the incident list's scope (person to needs-you, deadline to bank-late, bank to with-bank, open to payonce) and passes `currency` and `origin` on.
- `GET /api/incidents/:id` builds the payment page with the server's `Live` and the headroom lines from the balance cache as it is, read soft (`HttpApp.incident`).
- `GET /api/audit` hashes every line, so it is kept by the ledger's `changeStamp` and built again at most once a minute.
- `GET /api/beneficiaries` reads Airwallex's beneficiary list with one GET at a time, and not again while the last good read is under a minute old. A failed read is answered once and not kept, so Try again reads again.
- `GET /api/alerts` gives each alert's key, kind, title, state, tries and last error, and never the address it posts to.
- `GET /api/sandbox` lists the email threads with `DEFAULT_EMAILS` first, so the form opens on the incident that is replaced without a person (`emailThreads`).

### Closing and approving

- A close names in `covered` the transfer ids the close option showed, at most 50 of up to 64 characters each. A close that names none is refused while any unrecognised transfer is on file.
- A close may send `as`, `paid` or `unpaid`. It must still be how PayOnce would close the payment (`pendingClose`'s kind), else 409 `close-kind-changed`. Without `as` the close is not checked this way.
- A recorded callback wakes the invoice even when the change failed part way.
- An approval's notice says whether the request is approved or how many approvers it still needs. The route wakes the invoice after an approval, and the release starts after a run's.

### Uploads

- A pay run upload waits for its checks, a few Airwallex GETs, and answers the run. A file PayOnce cannot read is 400 with `problems`, each `{ line, text }`. A run already waiting is 409 `run-waiting` and the same file again 409 `same-file`, each with `runId`. A file with nothing to pay is 422 `nothing-to-pay`, with every row as a `RunRowView`.
- An email upload takes its place in the parse queue (`takeParsePlace`) before its body is read, so bodies still arriving count as waiting. A body that takes too long gives its place back.
- An email over 2 MB, or a body over the route's 3 MB limit, is refused with the parser's words (`TOO_LARGE_TEXT`), not the generic ones.
- Delivering an upload runs in the invoice's turn, then wakes the invoice when it is open or escalated, so the look reads the email.

### New payment

- `POST /api/payments/check` reads the ledger, the cash panel from the cache as it is and the beneficiary record, and writes nothing. It never calls `refreshIfOld`.
- The check reads a beneficiary record with one GET per id at a time and keeps it a minute (`recordFor`). A failed read is not kept, so the next check reads again.
- An empty invoice number is checked as a fresh `newInvoiceId`, which the answer gives back.
- An amount is read by the pay run file's rule (`amountProblem`, `amountMinorOf`), and one over 20 characters is refused without being repeated.
- `POST /api/payments` refuses with every problem by field, then opens the payment with `openPayment` and `recordPayee`. Airwallex is read before the invoice is written, so a 502 stores nothing.
- A start with a sandbox outcome tells the sandbox bank (`expectOriginal`). It then wakes the invoice and answers after the first look (`whenIdle`), with a notice: sending, on hold with the reason, waiting on an outage, or not gone out yet.

### The sandbox routes

- `POST /api/sandbox/scenarios` takes `bankOutcome` (one of `SANDBOX_OUTCOMES`), `emails` (a fixture thread), `startedBy`, `scenario`, an optional `invoiceId` and an optional `dueDate`. A null or blank `dueDate` is no due date, and any other goes through `dueDateProblem`.
- A given invoice number already in the ledger, or on a row of the run waiting for approval, is 409. The route answers after `openScenario` and leaves `runScenario` running.
- `POST /api/sandbox/duplicate-lock/:id` runs `payAgain` in the invoice's turn. It never reaches Airwallex.

### Cash and balances

- `GET /api/cash` and `GET /api/status` answer at once from the `BalanceCache` and the ledger. Each starts one balance read when the last try, good or failed, is 30 seconds old (`BALANCE_MAX_AGE_MS`).
- With alerts on, the balances are also read every 5 minutes with no page open (`ALERT_BALANCE_EVERY_MS`). See [alerts.md](alerts.md).
- After each good read `recordMissingFees` runs, and no new read starts before it ends. `refreshing` is true only while the balances themselves are read.
- A failed read keeps the last good one, and the answer carries the error, the read's age and `statesCheckedAt`, when the watcher last read every payment with the bank (`lastCheckedAt`).
- `GET /api/cash/cached` gives the `CashReport` from the cache as it is and never starts an Airwallex read.

### Page files

- `pageFiles` walks `web/dist/` once when the server starts, and only the files it found are served, so no path can leave the folder.
- Each file is read on every request and sent with `Cache-Control: no-store`, so a file `pnpm build:web --watch` writes again is served as it is now.
- With `web/dist/` missing or empty, every page path answers 503 "The page is not built..." (`NOT_BUILT_TEXT`), and the API still answers.
- Page files carry the Content-Security-Policy `default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. A `.map` file is served as JSON.

### The page

- `web/src/` is the page, written in Preact and TSX. `pnpm build:web` (`scripts/build-web.mjs`, on esbuild) bundles `main.tsx` into app.js and app.css in `web/dist/`, and copies `index.html` and `favicon.svg`.
- `pnpm ui` builds the page first (its `preui` script), and `pnpm build:web --watch` builds again on every save. `web/dist/` is gitignored. `pnpm typecheck` checks the page too (`tsc --noEmit -p web`).
- The page imports only types from `src/views/contract.ts`, through `web/src/types.ts`. The build's `page-only` plugin stops on any file outside `web/src/` and `node_modules/`, so no code from `src/` is bundled.
- The page renders the server's views and keeps no copy of a rule, a failure-code table or a wording.
- It talks to the server only by JSON GETs and POSTs under /api/ (`getJson` and `postJson` in `web/src/api.ts`), sent `no-store` and same-origin.
- `index.html` loads one module script and one stylesheet, both from the server. The page has no inline script or style, no `style` attribute in HTML, no outside request and only system fonts. Preact's `style` prop sets CSSOM properties, which the CSP allows.
- Text PayOnce did not write goes through `<Theirs>` (in `web/src/components/`): cleaned by `cleanLine` or `cleanBlock`, isolated in `<bdi>`, and only ever a text node.
- Nothing in the page uses `dangerouslySetInnerHTML`.
- A refusal shows beside the button that caused it, in the server's words, cleaned. An action's notice shows as a toast.
- A time shows in the viewer's time zone on a 24-hour clock, "14:20" today and "6 Nov, 14:20" on another day (`web/src/time.ts`). `parseIso` gives null for anything that is not a non-empty string.
- A view's `Timed` sentence goes through `<Said>`, which writes each time with `<Time>`, and a deadline with how long is left. The page rewrites no time inside a view's text.

### Hash routes

- `web/src/router.ts` reads the hash. Its first segment, undecoded, names the screen when it is a reserved word (`SCREENS`), and an empty hash is Home.
- The bare-hash rule: any other hash is a payment, so `#INV-671104` opens `#incident/INV-671104`.
- The page always links a payment as `#incident/` and the encoded invoice number (`paymentHref`), so a payment whose number is a reserved word still opens.
- `REDIRECTS` sends `#board` to `#incidents`, `#recon` to `#treasury/reconciliation` and `#metrics` to `#reports`, and a bare `#treasury` goes to `#treasury/cash`. A redirect replaces the history entry, at most three in a row.
- `#sandbox` opens the simulator drawer over the screen on show.
- A screen keeps its state while only its tab or query changes, and starts again for another object (`screenKey`). A different screen opens scrolled to the top, with focus on the content.

### Polling

- `usePoll` (`web/src/poll.ts`) is the one scheduler. The first read starts at once, the next one `every(view)` milliseconds after the last answer, and a read still running is never started again.
- A failed read keeps the last good view on screen and tries again at the same pace. Only the screen on show polls.
- The payment and run pages poll every 1.5 seconds (`FAST_MS`) while the view says busy or watching, and every 5 (`SLOW_MS`) otherwise. Home and the run list speed up for busy only.
- The status chip polls `GET /api/status` every 10 seconds on every screen. The cash panel polls at 1.5 seconds while a balance read runs.
- An action's answer goes on screen at once (`replace`), and a read that started before it is dropped when it lands.
- A poll never wipes what someone is typing: a form keeps its draft in its own state.

### Browser storage

- `localStorage` keeps two conveniences: `payonce.me`, the "You are" name that fills every name field, and `payonce.sandboxOutcome`, the simulator's outcome for the next payment's first transfer, `PAID` by default.
- New payment sends `payonce.sandboxOutcome` as `sandbox.bankOutcome` on every check and start, and follows a change made in the simulator drawer.
- `sessionStorage` keeps `payonce.sandboxLog`, the last ten simulator actions in this tab. The server keeps no such list.
- The server checks every value these send: each name against the approver list and the bars, the outcome against `SANDBOX_OUTCOMES`.

## Why

- The Host check stops DNS rebinding, since the server has no login.
- A write needs an Origin and JSON so that another site open in the same browser cannot start or approve a payment.
- Cross-site GETs are refused because a page on another site that cannot read the answer could still make the server build one, or read Airwallex, on every load. The page's own requests are same-origin, and a typed address or a bookmark is `none`.
- With files inside JSON, the guard's checks cover uploads, and PayOnce needs no multipart parser.
- An email upload holds its parse place while its body is read, so with the 30-second upload limit a slow one gives the place back after 30 seconds, not after Node's five-minute request timeout.
- A 40,000-character pay run file takes at most 6 bytes a character once escaped, so the 256 KB body limit always fits one. 2 MB of email is about 2.7 MB as base64, so the 3 MB limit fits.
- A name is read as sent, so one with a control character is refused and cannot start a line of its own on a timeline, a card or a terminal.
- The check reads the cache only because a balance read writes missing fees, and the check must write nothing.
- The release is not awaited because it goes on to send its rows one at a time.
- The pickup uses `approvalOf` so that a request opened since does not decide what the sandbox bank plays on an attempt.
- The pickup reads soft, so a row a look cannot read does not stop the server: that look throws and sends nothing. The wakes come after the read, so no look runs inside it.
- Ask why takes no invoice's turn because it writes nothing: it reads the facts in one snapshot and asks the model after the snapshot closes. An outage end changes only the outage and the looks of what it held. A contact change is one ledger transaction. Neither moves money.
- A callback wakes the invoice in any case, because a change that failed part way may still have reached the supplier's record in Airwallex.
- `close-kind-changed` refuses a close when the payment moved after the page showed it, so nobody closes as paid what nothing paid.
- `GET /api/cash/cached` is for the MCP server, which needs the balances without ever starting an Airwallex read.
- Serving only the page files found at start keeps every path inside `web/dist/`, and reading each one per request lets a watch build show at once.
- Because the page has no inline script or style and carries the CSP, even text that slipped into markup could not run or load anything.
- The page imports only types from `src/`, so it cannot carry a copy of a rule or a wording, and the server's views stay the one source.
- The bare-hash rule is there because alerts already posted links of the form `#<invoice>`.
- Home polls for busy only because `/api/home` reads every snapshot, and a transfer can stay with the bank for days.
- The default thread comes first so that the simulator's scripted incident form opens on the incident PayOnce replaces without a person.

## Edge cases

- When the page is not built, page paths answer 503 and the API still answers. `pnpm ui` builds it first, so this is a server started some other way.
- A file added to `web/dist/` after start answers 404 until the server restarts, because `pageFiles` walked the folder once.
- A Host such as `[::1]:4310` gets 403, because the guard takes only `127.0.0.1` and `localhost` on the port.
- The CLI and curl send neither `sec-fetch-site` nor `Origin`, so their GETs pass. A POST must send `Origin` and a JSON content type.
- Every POST through a proxy or harness that drops `Origin` answers 403. Test actions on the server's own port.
- For an older page's routes, `GET /api/board` answers 307 to the incident list. Any route not in the table, such as `GET /api/options`, answers 404.
- On a refused pay run upload, the contract types `problems` as `{ line, text }`, while the server sends the parser's `FileProblem` (`line`, `message`). The page reads either.
- When every row is skipped, the 422's `rows` are the store's checked rows (`NothingToPayError.rows`), not `RunRowView`s. The page reads the fields they share.
- A run already waiting and the same file again are both 409 with `runId` and no code (`WaitingRunError`, `SameFileError`). The page tells them apart by comparing `runId` with the waiting run in `RunsView`.
- An approval refused for the name rule, a bar, a limit or a changed request answers 409 with the engine's words and no code.
- The beneficiary picker's `GET /api/beneficiaries` keeps a failed read for a minute like a good one, so "Try again" gives the same failure for up to a minute. The check's record read does not keep a failure.
- The first cash answer after a quiet spell carries a read older than 30 seconds with `refreshing` true, because it answers before the read it starts. The page polls at 1.5 seconds until the read lands.
- A due date in the past on a scenario is taken, and the arrival estimates say it has passed.
- With browser storage blocked, the name, the outcome and the session log last until the page reloads.
- When another tab changes "You are" or the outcome, the page follows through the `storage` event.
- A stored `payonce.sandboxOutcome` that is not one PayOnce writes (not matching `^[A-Z_]{1,40}$`) reads as `PAID`, and the server refuses any outcome not in `SANDBOX_OUTCOMES`.

Dated checks: [verification/web-server.md](../verification/web-server.md).

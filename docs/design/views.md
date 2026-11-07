# Views

A view is a typed, read-only answer built from the ledger for the page, the MCP server or the CLI. The code is `src/views/`: the contract in `contract.ts`, the builders, the parts they share and the read models they reuse. [architecture.md](../architecture.md#layers) has what the layer may import, the routes that serve views are in [web-server.md](web-server.md), and the MCP projection is in [mcp-server.md](mcp-server.md).

## Rules

### The contract

- `src/views/contract.ts` is the one view contract. The builders return its types, HTTP sends them as JSON, MCP projects them, the CLI prints them, and the page imports them as types only.
- It re-exports the situation and reason types from `domain/situation.ts` and `domain/reasons.ts` unchanged, so no view defines them again. [reasons.md](reasons.md) has how a situation is worked out.
- Every `...At` field is an ISO 8601 UTC string, and a day is `YYYY-MM-DD`. Every amount is a `Money`: minor units, a currency and PayOnce's own text.
- No view writes a time into its text. A sentence that names one is a `Timed` (`domain/timed.ts`): its words in parts, with each time between them as `{ at }` (its ISO value) and `deadline` set on a deadline or an expiry. The page writes each time in the viewer's zone (`<Said>`), the CLI writes it in UTC (`said`), and MCP passes the ISO values.
- A situation's detail, next step and blockers, a run's situation, the summary bullets and the cautions are `Timed`. A label holds no time: a transfer's `stateLabel` leaves its deadline to `deadlineAt`, and a supplier caution leaves its time to `since`.
- A view's words follow [glossary.md](../glossary.md): a rail reads "USD local" (`railWords`), negative money has a real minus sign (`moneyText`), no sentence outside Settings names a `.env` variable, and a starter is barred because they "started this payment". Stored lines, terms and bindings keep their own words, "USD LOCAL" and "started this incident" included.
- A field typed `Theirs` holds text PayOnce did not write. The page shows it through `<Theirs>`, MCP wraps it as outside text and alerts defang it. Every other string is PayOnce's own words or a value in a closed pattern.
- What a person can do, and why not, is a `Can`: allowed, and a reason when it is not.
- Every action answers `Acted<V>`: the fresh view of what it changed, and a `Notice`.
- The page only renders views. It keeps no copy of a rule, a failure-code table or a wording.

### Builders

- A builder is a function of `(ledger, settings, now, ...)` that returns a view. It only reads: no builder writes the ledger or calls Airwallex.
- `sandboxView` takes only the scripted scenarios and the email threads the route hands it, and `contactDetailView` and `ledgerAuditExport` take no settings.
- Every builder reads stored JSON soft (`readingSoft`), so a value that does not parse shows as none instead of stopping the view.
- Two Airwallex reads sit beside the builders for the routes to call, both GETs: `readBeneficiaries` for the New payment picker and `readRecord` for the payment check. The builders take what they read as an argument.

| File | Builds |
|---|---|
| `home.ts` | `HomeView`, and `waitingForMe`, what waits on one person's signoff |
| `incidents.ts` | `IncidentsView`, every payment as a ranked list with the board's totals and the active outages |
| `incident.ts` | `IncidentView`, one payment's page |
| `runs.ts` | `RunsView` and `RunView` |
| `inbox.ts` | `InboxListView` and `InboxItemView` |
| `supplier-pages.ts` | `SuppliersView` and `SupplierView` |
| `contacts.ts` | a supplier record's phone on file, the payment page's phone lines and `SupplierContactDetail` |
| `treasury.ts` | `CashView`, `OutagesView` and `ReconView` |
| `reports.ts` | `ReportsView`, the tiles over the metrics |
| `audit.ts` | `AuditCheckView`, and `ledgerAuditExport` for every timeline at once |
| `settings-view.ts` | `SettingsView` |
| `status.ts` | `StatusView`, the status chip and the banners |
| `search.ts` | `SearchView` |
| `beneficiaries.ts` | `BeneficiaryPickerView` |
| `payment-check.ts` | `PaymentCheckView`, New payment's "What happens next" |
| `sandbox.ts` | `SandboxView` |

- `parts.ts` holds the pieces every view is built from: money, failures, accounts, rates, arrival estimates, timelines and the audit line.
- `requests.ts` builds `RequestView`, `TermsView` and `RunRequestView`, `rows.ts` builds `IncidentRow` and `RunRowItem` with their ranking and each row's one action, and `decision.ts` builds the Decision panel.
- A row's action only opens the payment or run with that option chosen. Nothing irreversible happens from a row.
- `summary.ts` writes "What happened" in at most five bullets, from ledger fields and the situation by fixed templates, and `cautions.ts` words each caution from a code, a clause or a fixed line. No model writes either.
- The views reuse three read models as they are: `incident-board.ts` ([incident-board.md](incident-board.md)), `suppliers.ts` ([supplier-view.md](supplier-view.md)) and `metrics.ts` ([metrics.md](metrics.md)).
- `outside-fields.ts` lists, view by view, which strings are text PayOnce did not write, for the MCP projection ([mcp-server.md](mcp-server.md)).

### Context and snapshots

- `context.ts` holds what a builder reads besides the ledger, the settings and the time: `Live`, `liveFrom`, `snapshotOptions`, `askWhyOn`, `readerOf` and `supplierKeyOf`.
- `Live` is what only a running server knows: whether the agent or the sandbox bank is working on an invoice (`busy`), and whether a run's own step is running (`runBusy`). The server builds it with `liveFrom`. The CLI and MCP pass none, and then nothing is busy.
- `health.ts` holds the other facts only `pnpm ui` knows (`ServerFacts`, `airwallexHealth`): the Airwallex host, how its last reads went, its alerts and its timers. The status and settings views take them, and the CLI and MCP pass none.
- `snapshot.ts` loads what `situationOf` and `runSituationOf` read, from the ledger alone, in one read transaction (`readSnapshot`), reading soft. What every invoice shares is read once per call (`sharedOf`).
- A view is read in a few read transactions, one per read model: the snapshot, the board, the supplier read model and the metrics each open their own.

### How each surface serves a view

- HTTP sends a view as JSON. It passes the server's `Live`, so a view's `activity` (busy, watching) is filled, and gives the payment page its headroom lines from the balance cache (`HttpApp.incident`).
- An HTTP action builds its view after the step's turn ends, from reads only ([web-server.md](web-server.md)).
- MCP builds the same views with no `Live` and no cash panel. `marked` then projects them through `outside-fields.ts`: it drops `activity` and `askWhy` and wraps outside text ([mcp-server.md](mcp-server.md)).
- The CLI prints views through `src/surfaces/cli/view-text.ts`. Every line goes through `printable` with its leading spaces kept, times read like "2 Nov 2026, 09:00 UTC" (`utc`), and table amounts are right-aligned.
- A `Timed` sentence prints with each time in UTC, such as "open until 2 Nov 2026, 10:00 UTC".

| Command | Prints |
|---|---|
| `pnpm board [FILTER...]` | `incidentsView`, its scope from the group word, and the pay runs that need someone from `homeView` |
| `pnpm approve <INVOICE>` | `incidentView`: the payment's header, the open request's terms and signers, the cautions and the approve option |
| `pnpm close <INVOICE>` | `incidentView`: the header, emails, cautions and the close option, with the payouts that only name the invoice and the covered transfers |
| `pnpm payrun show`, `approve`, `upload`, `check` | `runView` |
| `pnpm supplier [RECORD\|INVOICE]` | `suppliersView`, or `supplierView` of the record `resolveSupplier` finds, with a "Phone on file" section when the record has a contact row |
| `pnpm outage` | `outagesView`, with the last five ended |
| `pnpm cash` | `cashView`, over the balances the command reads itself |
| `pnpm metrics` | `metricsReport`, which `ReportsView` carries with each row's money as `Money` and its codes and rail in words (`shownMetrics`) |

### Nothing on a payment path reads a view

- The engine, the policy, the store, alerts and the run, outage and reconciliation code import nothing from `src/views/`. The server hands alerts a reader of situations (`SnapshotsOf`), which loads them with `readInvoiceSnapshots`.
- Only the payment check imports the engine, the one exception [architecture.md](../architecture.md#layers) lists. It takes `firstPaymentFacts`, `firstPaymentHold` and `firstPaymentOutage` from `engine/first-payment.ts`, and the payee check and the invoice it would open from `engine/new-payment.ts`.

### Rules in particular views

- A transfer reference reaches a view only as `shownReference` gives it: in Airwallex's form, or `UNSHOWN_REFERENCE`.
- An arrival estimate is shown only when `vouchedArrival` accepts it: a transfer method, a route PayOnce knows or none, and days and day counts in PayOnce's forms. `arrivalView` gives null for any other.
- A country that is not two capital letters is dropped from a vouched estimate, because it comes from the beneficiary record in Airwallex.
- The advice for a payment sent today is given only while the payment can still be sent: for a request that is open (`requestOpen`), for a run's request only while the run waits, and for a run row only while the run waits. A sent transfer's estimate never gets it.
- A run row's fee line (`feeSeenText`) is built only for a vouched estimate and a currency in `CURRENCY_PATTERN`.
- The cash view lists a currency that has a floor set, a line in the ledger, an open invoice with an invoice floor, or a balance that is not zero (`cashReport`).
- The payment page's headroom lines, in the Money panel and under the Decision panel, are one `HeadroomLine` from `headroomOf`. While the invoice is open they are worked above the floor `floorFor` holds its payments to, which `heldFloor` (`domain/reserve.ts`) gives along with its source. Where the invoice's own floor is stricter than the wallet's, or the wallet has none, that floor is the invoice's and `floorSource` is `invoice`.
- A settled or rejected invoice's headroom lines use its wallet's floor.
- The cash panel and the payment page work headroom out with the same `headroomAbove` (`store/read/cash.ts`): the available balance less the floor and the `FIRM_KINDS` lines. The panel takes each wallet's own floor.
- `PaymentCheckView` asks `startPayment`'s outage gate and holds, in their order, on facts read without a lease (`firstPaymentFacts`, `firstPaymentHold`, `firstPaymentOutage`), so it says what a start would do. It writes nothing.
- The check gives back the invoice number it checked. For an empty field that is the number `newInvoiceId` made, and the page sends it on later checks and on start, so the payment starts under the number the person saw.
- The check shows the record's phone on file by its last four digits only (`phoneEnding`), read from the ledger, so it shows while Airwallex is unreachable.
- The check warns when the first transfer would leave the wallet below its floor, and says PayOnce does not check a single payment's first transfer against the floor.
- `InboxItemView` says whether a delivered email has been read. Only the inbox routes serve the inbox views: MCP and the CLI do not.
- An uploaded email's view carries its Date header as written, as `Theirs`, and the time it was uploaded. Both are null for an email the simulator played.
- `SettingsView` names the `.env` variables behind each row (`SettingRow.variables`), and none for a limit fixed in PayOnce, such as Ask why's caps. It never holds a secret: for the Airwallex keys it says only whether each is set.
- `IncidentsView.totals` follow every filter the rows do, scope, search and `me` included, and count the waiting pay run's rows while the run passes them. Each wallet names the runs in `runWaiting` (`runsWaiting`). `wallets` lists every wallet a payment in the ledger is paid from, closed payments included.
- A supplier hint, in the list and on the record, is its bank country (from the newest transfer PayOnce sent there), currencies and methods, such as "US · USD · Local", and the page shows the account and phone endings beside it. Search adds the account ending to it. It never shows the record's id.
- `ReconView.lastCheck.at` is the latest check that ran, failed or not, and `lastOkAt` the latest one that read Airwallex in full.
- The movements route answers `ReconMovementView`: amount and balance as `Money`, and how PayOnce explains the movement in words (`howText`).
- `StatusView` reads little, because every screen polls it every 10 seconds.
- `AuditCheckView` hashes every line, so the server keeps it by the ledger's `changeStamp` and builds it again at most once a minute.
- The server keeps the last three metrics reports, keyed by period, change stamp and minute, and Home, Reports and `GET /api/metrics` share them.

## Why

- With one contract, the page, MCP and the CLI show the same views built by the same code, so no copy can drift from the others.
- Builders read soft so that a view shows what it can of a row it cannot read. Payment paths read strictly instead, so that row stops its own invoice's looks and pays nothing ([invariants.md](../invariants.md), number 60).
- Views stay off payment paths because a view reads soft and words things for people. A decision made from one could act on a row read as none.
- `Live` is passed in because only the server has a dispatcher and a sandbox bank, so only it knows what is busy.
- A view takes a few read transactions, not one, because each read model opens its own snapshot, and `Db.readSnapshot` refuses to run inside another transaction (invariant 59), so a builder cannot wrap them in one.
- Estimates are vouched for in the shared builder, so text stored in an estimate never reaches a sentence that MCP passes as plain, and the page, MCP and the CLI give the same advice.
- The advice shows only while the payment can be sent, because "If sent today" means nothing for a payment already sent or a request that can no longer be used.
- The check asks the start's own holds, so the preview cannot drift from what starting the payment does.
- An open invoice's headroom is worked above the floor its payments are held to, so the line agrees with the request's floor reason. A settled or rejected invoice pays nothing more, so only its wallet's floor counts, as on the cash panel, which lists invoice floors for open invoices only.
- The panel and the page share `headroomAbove`, so they cannot work headroom out two ways.
- The status view stays small because it is read every 10 seconds by every open page.
- The audit view is cached because building it hashes every line in the ledger again.

## Edge cases

- Two parts of one view can be a moment apart. Each read model reads in its own transaction, so a payment's situation and its board money can come from slightly different moments.
- A view shows a stored value that does not parse as none, and the payment path for that invoice stops on it.
- The payment check skips `linkUnseenPayouts`, because it writes, so an outside payout with the new invoice number that the sweep has not tied yet is the one hold the check can miss.
- `PaymentCheckView` has no count of approvers. Paying a held first payment needs what the engine's held rule reads, the payee's history and the duplicates' transfers, and that rule also writes a timeline line, so no view can say it before a request opens.
- Nothing is busy in the CLI's and MCP's views, and MCP's payment page has no headroom lines.
- The headroom lines use the server's cached balance. They agree with the request's floor reason once the cache has read the balance after the bank kept the original's fee. Until then they are off by that fee, so a replacement can show as leaving cash above the invoice's floor while the reason says it goes below. While a page is open, its status poll starts a new read whenever the cache is 30 seconds old.
- With a group filter, `pnpm board`'s wallet totals cover that group, because the list's totals follow its scope. Closed payments are not listed.
- When `pnpm approve` meets terms PayOnce cannot read, `readableTerms` refuses them before the view is built. `pendingApproval` (`store/read/reviews.ts`) decides whether there is anything to approve, and so the exit code.
- `pnpm close` picks the close option by `pendingClose`'s kind and checks `--covers` against `pendingClose().covered`.
- For a pay run file with nothing to pay, nothing is stored, so there is no run view. The upload's 422 gives every checked row as a `RunRowView` (`checkedRowViews`), and `pnpm payrun upload` prints the rows and their skip reasons.
- With no active outage, `pnpm outage` does not say who may end one, because the view gives the enders on each active card.
- `pnpm cash` sets its exit code from the view: no balance read, a floors problem, or a headroom below 0.

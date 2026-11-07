# PayOnce

Payment incident agent for the Airwallex Agentic Banking Hackathon 2026, built on starter kit 3. TypeScript, pnpm, Node 24, a Preact page. Sandbox only.

## Commands

```bash
pnpm install
pnpm typecheck                                      # tsc --noEmit for src/, then for web/ (tsc --noEmit -p web)
pnpm check:layers                                   # fail when an import in src/ reaches the wrong way between layers (scripts/check-layers.mjs)
pnpm dev                                            # policy on seven sample incidents, no credentials
pnpm build:web                                      # bundle web/src/ into web/dist/ with esbuild; --watch rebuilds on save
pnpm ui                                             # build the page (preui), then the page and JSON API at http://127.0.0.1:4310, webhook receiver on 4311
pnpm recover [OUTCOME] [INVOICE] [EMAILS] [SCENARIO] [NAME] # one incident against the sandbox, or continue an existing invoice (status checks, no webhooks)
pnpm approve <INVOICE> [REQUEST NAME]               # show the waiting request (a replacement, or paying a held invoice), its terms and who can sign; with both, record that person's approval of that request
pnpm close <INVOICE> [NAME] [NOTE] [--covers=REF,...] # show a paid incident or a held invoice waiting on a person; with NAME and NOTE, close it (a held invoice without paying); --covers names every mismatched transfer the close covers
pnpm run audit [INVOICE] [json|csv]                 # check every invoice and pay run timeline, reconciliation's chain and their three running hashes, or one invoice's; with a format, print its audit trail
pnpm run audit run <RUN> [json|csv]                 # the same for one pay run's timeline
pnpm cash                                           # read balances once and print each wallet down to the headroom above its floor; exit 1 if Airwallex is unreadable, a floor is unreadable or a headroom is below 0
pnpm board [FILTER...]                              # the open payments from the ledger alone, active outages first; filters in any order: a group (person, deadline, bank, open = Needs you, Bank is late, With the bank, PayOnce is handling), a currency, an origin (payonce, outside, pay-run)
pnpm payrun upload <FILE> <NAME>                    # check a pay run CSV (Airwallex GETs only) and store it as a run waiting for approval; NAME is required
pnpm payrun show <RUN>                              # rows, cash, the waiting request, its number and who is barred
pnpm payrun approve <RUN> [REQUEST NAME]            # show the terms; with both, record that approval. pnpm ui releases the run
pnpm payrun check <RUN>                             # run every check again (GETs only) and open a new request if the old one expired or the terms changed
pnpm payrun cancel <RUN> <NAME> <NOTE>              # cancel a run that is waiting
pnpm outbox <INVOICE>                               # message drafts on file and the messages that fit now, suggested first
pnpm outbox <INVOICE> draft <TEMPLATE> <NAME>       # draft a message for a person to send and print it; PayOnce never sends it
pnpm outbox <INVOICE> show <DRAFT>                  # print a draft, whether its text still matches its hash, and what changed since
pnpm outbox <INVOICE> sent <DRAFT> <NAME>           # record that you sent it yourself
pnpm outbox <INVOICE> dismiss <DRAFT> <NAME> [NOTE]
pnpm outage                                         # the active rail outages and the last five ended, ledger only
pnpm outage end <ID> <NAME> <NOTE>                  # end an outage as a name in APPROVERS (any name when APPROVERS is unset; nobody while an approval setting cannot be read)
pnpm supplier [RECORD|INVOICE]                      # every supplier record, or one Airwallex beneficiary record (an invoice number gives the record it pays), ledger only
pnpm reconcile [offline]                            # one reconciliation check against Airwallex (GETs only), or the stored record matched again with no call, then the report; exit 1 when it failed, a wallet does not add up, does not end at Airwallex's balance or has a movement PayOnce cannot read, or a break waits on a person
pnpm reconcile show [CURRENCY]                      # the last report, ledger only, read-only; exit 1 by the same rule, on the latest run on file, and when the latest check against Airwallex failed, even with an offline match after it
pnpm reconcile explain <ID[,ID...]> [NAME NOTE --facts=FP,...] # the breaks and their facts; with NAME, NOTE and the printed facts, explain open breaks of one kind
pnpm mcp                                            # the read-only MCP server over stdio, by hand; Claude Code and Claude Desktop start it with node (see README)
pnpm ask <INVOICE> [facts]                          # ask the model reader's models why PayOnce did what it did on the invoice; with facts, print exactly what would be sent and ask nothing
pnpm metrics [7d|30d|all] [json]                    # the ops metrics for the last 7 or 30 days or since the ledger started, ledger only, read-only; json prints the route's answer
pnpm reset                                          # move payonce.db aside so the next run starts an empty ledger
```

Defaults: OUTCOME `CHANNEL_TIMEOUT`, EMAILS `nothing-arrived`, SCENARIO `usd-local`, NAME the OS login name (who started the incident). OUTCOME is a simulator failure type, `PAID`, or `STAYS_IN_FLIGHT`, which leaves the original in `SENT`. `pnpm audit` is pnpm's own dependency audit, so the audit command needs `run`. Asking an invoice why is `pnpm ask` because pnpm runs its own `why` command in place of a script named `why`. `pnpm reconcile` and `pnpm metrics` run the scripts: pnpm 12.5.1 has no built-in commands by those names. There is no lint script and there are no tests.

`web/dist/` is build output and is gitignored. `pnpm ui` serves only what `pnpm build:web` put there, and answers 503 on every page path while it is empty.

## Where the details are

This file holds the commands, the file map and the rules that hold everywhere. The rest is in `docs/`:

- `docs/architecture.md`: one look from wake to next look, the layers and what each may import, the payment gate, the leases, the Dispatcher, watcher and sweep, the hash chains and the ledger upgrade.
- `docs/invariants.md`: every money guarantee, one sentence each, with where it is enforced.
- `docs/glossary.md`: the words a person reads, and the names in the code for each idea.
- `docs/design/<topic>.md`: one note per topic, as Rules, Why and Edge cases. Read the topic note before changing the code it covers. Where this file and a topic note differ, the topic note is right.
- `docs/verification/<topic>.md`: the dated notes on how each topic's rules were checked, kept as written.
- `docs/demo.md`: the recording script for the demo.

| Topic note | Read it before changing |
|---|---|
| `engine-rules.md` | anything that sends, holds, approves or closes a payment: `src/engine/` (the look and its steps, first payments and holds, held invoices, retries, outside payouts, late and unrecognised transfers, requests, quotes, closes, callbacks, the currency lock, the Dispatcher, watcher and sweep), the cash lines in `store/read/cash.ts`, and in `src/domain/` the policy's files: `decide.ts`, `incident.ts`, `live.ts`, `approval.ts`, `approvers.ts`, `barred.ts`, `duplicates.ts`, `reserve.ts`, `deadlines.ts`, `fx.ts`, `callback.ts`. Its first table says which file holds each function |
| `ledger.md` | anything in `src/store/` (`ledger.ts`, `db.ts`, `schema.ts`, `chain.ts`, `timeline.ts`, `audit-trail.ts`, the stores, `read/`): a table, column, index, trigger, transaction, stored-JSON read, timeline line or hash chain |
| `accounts.md` | `accountKeyOf`, `routeKeyOf`, `NOT_ROUTING_FIELDS`, `ROUTE_SCHEME`, `knownRoute`, `holdsAccount`, `rebuildRoutes`, or any test of whether two sets of bank details are one account |
| `names.md` | `personName`, `knownName`, `sameName`, `sameSupplier`, or anything that records or compares a person's or a supplier's name |
| `supplier-contacts.md` | the phone on file: `domain/contacts.ts`, `store/contacts.ts`, `engine/contacts.ts`, `views/contacts.ts`, `routes/contacts.ts`, the callback checks in `engine/bank-change.ts`, and anything that reads `Obligation.supplierPhone` |
| `reasons.md` | `domain/reasons.ts`, `domain/situation.ts`, `domain/live.ts`, `views/snapshot.ts`, the reason columns and `SET_REASON` in `store/invoices.ts`, and any code that reads reason codes or situations, or adds a reason, clause or situation |
| `route-advisory.md` | `domain/arrival.ts`, the arrival parts of `engine/terms.ts` and `engine/send.ts`, and due dates |
| `pay-runs.md` | `src/runs/` (`run-file.ts`, `runs.ts`), `RunStore` in `store/runs.ts`, the run requests (`RUN_REQUESTS`) in `store/approvals.ts`, `surfaces/cli/payrun.ts`, and the run's turn (`LookOptions.runTurn`) in `engine/watcher.ts`, `engine/dispatcher.ts` and `startFirst` |
| `rail-outages.md` | `src/outages/outages.ts`, `store/outages.ts`, the outage gate in `AttemptStore.openAttempt`, `surfaces/cli/outage.ts`, `routes/outages.ts`, and the rail flag in `domain/failure-codes.ts` |
| `uploaded-emails.md` | `src/intake/` (the email parser, its HTML and CSS scanners, the parse worker and the upload queue), `domain/emails.ts`, `reader/emails.ts`, `routes/inbox.ts`, and how an email's findings reach a reason or terms |
| `email-reader.md` | `src/reader/` (the model services, the model and keyword readers, their failures), the model settings in `settings.ts`, and `readNewEmails` in `engine/emails.ts` |
| `ask-why.md` | `src/explain/`, `surfaces/cli/ask.ts`, `routes/why.ts`, the Ask why card on the payment page, and any new reason or timeline line, since Ask why passes only the ones it knows |
| `reconciliation.md` | `src/recon/`, `store/recon-store.ts`, `RECON_CHAIN`, `airwallex/history.ts`, `surfaces/cli/reconcile.ts`, `routes/reconcile.ts` |
| `metrics.md` | `views/metrics.ts`, `store/read/metrics.ts`, `views/reports.ts`, `surfaces/cli/metrics.ts`, `/api/metrics` and `/api/reports`, the Reports screen, the MCP `metrics` tool, and the time triggers in `store/schema.ts` |
| `incident-board.md` | `views/incident-board.ts` (`boardReport`, `boardEntriesFor`, `outageHolding`), how `views/incidents.ts` and `views/home.ts` take its money, totals and outages, `surfaces/cli/board.ts`, and the cash line kinds the board totals (`FIRM_KINDS`, `WAITING_KINDS`, `waitingRunLines` in `store/read/cash.ts`) |
| `supplier-view.md` | `views/suppliers.ts`, `views/supplier-pages.ts`, `store/read/suppliers.ts`, `routes/suppliers.ts`, `surfaces/cli/supplier.ts`, the Suppliers screens, and the MCP `suppliers` and `supplier` tools |
| `outbox.md` | `src/outbox/drafts.ts`, `DraftStore` in `store/drafts.ts`, `surfaces/cli/outbox.ts`, `routes/outbox.ts` and the payment's Messages tab |
| `alerts.md` | `src/alerts/`, `store/alerts.ts`, `alertSetting` in `settings.ts`, `alertCash` in `surfaces/http/main.ts`, and anything written to `escalation_reason` |
| `views.md` | `src/views/` (the contract, a builder, `snapshot.ts`, `context.ts`, the shared parts), `domain/timed.ts` and `surfaces/cli/view-text.ts`: how each surface serves a view |
| `web-server.md` | `src/surfaces/http/` (`main.ts`, `router.ts`, `http.ts`, `app.ts`, `start.ts`, `routes/*.ts`), the page in `web/src/`, and `scripts/build-web.mjs` |
| `mcp-server.md` | `src/surfaces/mcp/` (`main.ts`, `mcp-text.ts`, `server-cash.ts`) and `views/outside-fields.ts` |
| `webhooks.md` | `surfaces/http/webhooks.ts`, `surfaces/http/tunnel.ts`, `connectWebhooks` and `onWebhook` in `surfaces/http/start.ts`, and `airwallex/webhooks.ts` |
| `cli.md` | any file in `src/surfaces/cli/` (`view-text.ts` and `terms-shape.ts` included), `text/printable.ts`, `text/words.ts`, `text/line-error.ts` and `env-file.ts`: what each command loads, opens and prints |
| `airwallex-client.md` | `src/airwallex/` (frozen: the host allowlist, error shapes, secret redaction), `text/redact.ts`, `Settings.airwallex.client()`, `airwallexAdvice` and `withAdvice` |
| `sandbox-behaviour.md` | `engine/sandbox-bank.ts`, `engine/scenario.ts`, `airwallex/simulation.ts`, `routes/sandbox.ts`, `fixtures/`, and anything that relies on what Airwallex or its simulator does. Read it before any run against the sandbox |

## Files

`src/` is in layers: `domain/` is pure, `store/` is the ledger, `engine/` is the agent and what runs it, the subsystems sit beside the engine, `views/` builds what people and other programs read, and `surfaces/` are the ways in. `docs/architecture.md` says what each layer may import. `pnpm check:layers` enforces it. Its one exception is the New payment preview, which runs the engine's own holds.

- `src/settings.ts`: every environment setting PayOnce reads, with its default, parsing and error text, read once by `loadSettings` right after `.env` loads. A setting PayOnce cannot use carries its problem instead of throwing. Code below an entry point gets the settings it reads as arguments; nothing keeps a loaded copy.
- `src/env-file.ts`: `loadEnvIfPresent`.
- `src/domain/`, pure:
  - `decide.ts`: the policy (wait, replace, escalate, close) and `floorReason`. Every reason it gives is an exported constant, apart from the one that names the source currency.
  - `incident.ts`: the `Incident` and `Decision` types. Amounts are minor units.
  - `reasons.ts`: the `Reason` model (code, clauses, slots), `reasonText` and `parseReason`, families and labels, `reasonColumns`, and the fixed reasons the engine writes.
  - `situation.ts`: `situationOf`, one invoice's situation (group, state, need, close kind, what a person can do) and a run's.
  - `live.ts`: the notions of "live" the situations and views use (per transfer, outside payout, payment and request) and `closesItself`. The store keeps only their SQL forms (`LIVE_ATTEMPT` and the others in `store/attempts.ts`).
  - `emails.ts`: the email facts (`SupplierEmail`, `EmailFindings`, `summarise`) and the sender check (`unverifiedSenders`, `emailEvidence`).
  - `barred.ts` (`barredFrom`: who may not approve), `callback.ts` (`callbackBlocked`: why a callback cannot be recorded now), `contacts.ts` (the phone on file: typed numbers, sources, the blind re-key, lapses, refusals and timeline lines).
  - `money.ts` (`toMinor`, `formatMoney`, `formatAmount`, `invoiceMoney`, `twoDecimals`, two-decimal currencies only), `patterns.ts` (each form a reference, currency, failure code, status, method, rail or beneficiary id is accepted in, `railWords` and `runKey`), `sentences.ts` (`capitalise`), `timed.ts` (`Timed`: a sentence whose times are fields, not text), `failure-codes.ts` (the bank failure codes with their words and what each means for a resend, an outage or the account).
  - `assess.ts` (reads an Airwallex transfer: state, resendability, account and route keys, fee, debit), `deadlines.ts` (`deadlineMinutes(method, deadlines)`, with the bank deadlines passed in), `arrival.ts` (the route advisory), `duplicates.ts`, `reserve.ts` (floors and `debitCurrency`), `fx.ts` (`quoteValidity`).
  - `approval.ts`: the terms (`termsFor`, `heldTermsFor`, `runTermsFor`), `bindingOf`, `paymentAmount`, `runAmount` and the FX helpers.
  - `approvers.ts`: the approval policy, signer checks, `personName` and `sameName`.
- `src/store/`, the SQLite ledger (`node:sqlite`):
  - `ledger.ts`: the `Ledger` facade. It builds every store on one `Db` and delegates to them. A new method goes in the store that owns its tables, with a one-line delegation here.
  - `db.ts`: the connection, the one transaction helper (`transaction`, `readSnapshot`), `readingSoft`, and the stored-JSON readers (`checkedObject`, `storedShape`, `StoredShapeError`).
  - `schema.ts`: `SCHEMA`, `ADDED_COLUMNS`, the time triggers and the upgrades. `chain.ts`: `HashChain` and the three chains.
  - One store per group of tables: `invoices.ts` (with `SET_REASON`), `attempts.ts` (`openAttempt`, `insertAttempt`, the duplicate lock), `approvals.ts` (`RequestBook`, one request book for invoices and pay runs), `payouts.ts`, `closes.ts`, `runs.ts`, `outages.ts`, `inbox.ts`, `alerts.ts`, `bank-changes.ts`, `contacts.ts` (`supplier_contacts`, `seedContacts`), `drafts.ts`, `locks.ts`, `emails.ts`, `timeline.ts`, `webhook-events.ts`.
  - `stored.ts`: the shapes PayOnce checks stored JSON against, for terms, run terms, a kept quote, email findings and stored lists (`isApprovalTerms`, `requestTerms`, `runRequestTerms`, `storedFindings`, `emailsOnFile`).
  - `read/`: read-only helpers built on the ledger: `cash.ts` (`cashLines`, `committedMinor`, `cashReport`, `FIRM_KINDS`), `facts.ts` (an invoice's ledger predicates: `paidTwice`, `heldBeforePaying`, `coveredByClose`), `reviews.ts` (what a person reads before a close or an approval: `pendingClose`, `pendingApproval`, `barredOnFile`), `callback.ts` (`callbackFacts`, shared by the engine and the views), and the views' read models `suppliers.ts`, `metrics.ts` and `search.ts`.
  - `audit-trail.ts`: chain reports and exports. `recon-store.ts`: reconciliation's tables, on the shared `Db`.
- `src/engine/`, the agent:
  - `engine.ts`: the shared types (`Engine`, `NextLook`, `LookOptions`, `StepResult`, `Assessment`).
  - `look.ts`: `resumeIncident`, one look: the reads in `look()`, then the steps in `SENT_STEPS`, then `act`.
  - One module per phase: `first-payment.ts` (`startPayment`, `FIRST_PAYMENT_HOLDS`, `firstPaymentHold`, `startFirst`), `held.ts` (`continueHeld`), `escalated.ts`, `requests.ts` (`awaitApproval`, `voidIfStale`), `replacement.ts`, `retry.ts`, `outside.ts` (payouts sent outside PayOnce), `late-mismatched.ts`, `emails.ts`, `rates.ts`, `terms.ts`, `assessment.ts`, `send.ts`, `close.ts` (the agent's own close), `person.ts` (`approvePayment`, `closeIncident`, `payAgain`), `lines.ts` (`note`, `noteError`) and `reason-text.ts`.
  - `new-payment.ts`: `openPayment`, a payment a person or a scenario starts, and `recordPayee`. `contacts.ts`: a person proposing, confirming or withdrawing a phone number.
  - `create.ts` (`createEngine`, the one place an `Engine` is built), `dispatcher.ts`, `watcher.ts`, `sweep.ts`, `payments.ts` (idempotent send, status sync, `recordMissingFees`), `bank-change.ts` (recording a callback), `currency-lock.ts` (`withCurrencyLock`), `sandbox-bank.ts`, `scenario.ts`.
- Subsystems: `src/runs/` (`run-file.ts`, the CSV parser; `runs.ts`, upload to release), `src/outages/outages.ts`, `src/recon/` (`recon-match.ts`, `reconcile.ts`), `src/intake/` (`eml.ts`, `html-text.ts`, `css-text.ts`, the parser; `intake.ts`, `parse-worker.ts`, the upload queue), `src/reader/` (`emails.ts` with `EmailReader` and `loadEmails`, `model-service.ts`, `model-reader.ts`, `keyword-reader.ts`, `reader.ts`, `reader-error.ts`), `src/outbox/drafts.ts`, `src/alerts/` (`alerts.ts`, `alert-payloads.ts`), `src/explain/` (`why-facts.ts`, `explainer.ts`).
- `src/views/`, read-only:
  - `contract.ts`: the view contract every surface and the page use. `context.ts` (`Live`), `snapshot.ts` (what a situation is worked from), `parts.ts`, `requests.ts`, `rows.ts`, `decision.ts`, `cautions.ts`, `summary.ts`: shared pieces.
  - Builders: `home.ts`, `incidents.ts`, `incident.ts`, `runs.ts`, `inbox.ts`, `supplier-pages.ts`, `contacts.ts`, `treasury.ts`, `reports.ts`, `audit.ts`, `settings-view.ts`, `status.ts`, `search.ts`, `beneficiaries.ts`, `payment-check.ts` (the New payment preview), `sandbox.ts`, `health.ts`.
  - `incident-board.ts`, `suppliers.ts`, `metrics.ts`: the board, supplier and metrics read models the builders use.
  - `outside-fields.ts`: for each view, the fields that hold text PayOnce did not write and where it comes from.
- `src/surfaces/http/`: `pnpm ui`. `main.ts` starts the engine, watcher, alerts and reconciliation timer in order. `router.ts`: the route table's types, the Host and Origin guard, static files from `web/dist/` and the CSP. `routes/*.ts`: the handlers by area, each a function of the `HttpApp` in `app.ts`. `http.ts` reads bodies and writes answers. `start.ts` picks up interrupted payments and connects webhooks. `webhooks.ts`, `tunnel.ts`: the receiver and its cloudflared quick tunnel.
- `src/surfaces/mcp/`: `main.ts` (the read-only MCP server, the only importer of the SDK and zod), `mcp-text.ts` (`marked`, the projection of a view, and phone masking), `server-cash.ts` (the running server's balances for the `cash` tool).
- `src/surfaces/cli/`: one file per command (`recover.ts`, `approve.ts`, `close.ts`, `audit.ts`, `cash.ts`, `board.ts`, `payrun.ts`, `outbox.ts`, `outage.ts`, `ask.ts`, `supplier.ts`, `reconcile.ts`, `metrics.ts`, `reset.ts`, `dev.ts`), `view-text.ts` (how a command prints a view) and `terms-shape.ts` (checks stored terms before a command prints or approves them).
- `src/text/`: `printable.ts` (everything printed to a terminal: `say`, `printable`, `printableJson`, `shownReference`; `oneLine` for stored text, `trimmedLine`, `storable`, `utcText`, `listOf`), `redact.ts` (`redactKey`), `words.ts` (fixed words kept apart from the code that writes them, so the read-only code can share them without importing the sandbox bank), `line-error.ts` (`LineError`).
- `src/airwallex/`: `client.ts` (sandbox hosts only, errors, secret redaction, advice), `transfers.ts`, `fx.ts`, `beneficiaries.ts`, `balances.ts`, `webhooks.ts`, `simulation.ts` (sandbox-only calls), `history.ts`.
- `web/`: the page. `web/src/` is Preact and TSX, bundled by `scripts/build-web.mjs` into `web/dist/`:
  - `main.tsx` (entry), `app.tsx` (the shell and the screen table), `router.ts` (hash routes, the bare-hash rule, redirects), `api.ts` (`getJson`, `postJson`, `ApiError`), `poll.ts` (`usePoll`), `time.ts`, `text.ts` (`cleanLine`, `cleanBlock`), `me.ts` (who you are acting as), `notices.ts` (toasts), `settings.ts`, `hooks.ts`, `words.ts`, `styles.css`.
  - `types.ts`: the page's only door to `src/views/contract.ts`, types only.
  - `components/` (shared parts: actions, forms, rows, states, text with `<Theirs>`, the timeline), `shell/` (top bar, banners, search, status chip, the name picker), `screens/` (one file and folder per screen: home, incidents, payment, new-payment, inbox, runs, suppliers, treasury, reports, settings, simulator, search).
- `fixtures/emails/`, `fixtures/pay-run-example.csv`: sample supplier threads and a sample pay run file.

## Rules that hold everywhere

These are short forms of rules the topic notes give in full, with their exceptions and reasons.

### Money

- Rules stay in code. `decide.ts` decides, and no model decides an amount, an account or whether to pay. Findings from supplier emails only add caution: they are ORed with the stored ones and never removed.
- PayOnce learns what the bank did only by reading Airwallex. A webhook or the watcher wakes a look, and nothing in a webhook's body feeds a decision. The engine never simulates a bank outcome.
- An attempt opens only through `Ledger.openAttempt`, inside a transaction, before the Airwallex call. It checks that the lease is still held and is the source wallet's, applies the outage gate, copies the quote from the approval (and refuses a cross-currency attempt without one), and writes `request_id`, `account_key`, `route_key` and `approval_id`. Nothing calls `insertAttempt` any other way.
- A 4xx other than 429 marks the attempt failed, with two exceptions. `duplicate_request_id` is not a failure: the transfer it names is recorded. A retry of a cross-currency attempt is not failed by a 4xx while its quote can still pay. Any other error leaves the attempt pending, and a later look retries it under the same `request_id` and the same quote. A pending attempt is failed without a refusal only in the cases `engine-rules.md` lists, and only once a bank deadline has passed with nothing listed under its request id.
- One live payment per invoice: the partial unique index `one_live_attempt_per_invoice`, and `insertAttempt`'s `LIVE_ATTEMPT` check. A transfer the bank has live counts as live whatever state the ledger gives its attempt (`liveAtBank`), and `Ledger.record` never breaks the lock.
- Every payment PayOnce creates holds the lease of the wallet it leaves (`withCurrencyLock` on `debitCurrency`) from its last Airwallex read until the transfer is recorded. Just before any payment, the transfers are listed again and any new payout sent outside PayOnce is tied. If one turns up, nothing is sent and the look comes again at once. The exception is a new invoice's original, which still goes out when the payout it tied has already failed.
- Every first payment is asked the ordered holds in `FIRST_PAYMENT_HOLDS`, through `firstPaymentHold`, inside the transaction that opens its attempt: a missing beneficiary, a likely duplicate, an invoice number already on file for the supplier, a live outside payout, an account that changed since the last checked payment or was never confirmed, emails on file, a payment from another currency's wallet, and a pay run row's floor. A new hold is one entry in that list. The New payment preview asks the same list on facts read without a lease (`firstPaymentFacts`). A pay run row is sent only on a look that has the run's turn.
- An attempt PayOnce opens keeps the account it was decided or approved for (`attempts.account_key`). The beneficiary record is read again before sending, and if its details then differ from the kept ones in any field, nothing is sent. A retry of an attempt with no kept account that PayOnce cannot pin to one is held as `account-unknown`, never sent. A transfer that went to other details is marked `misdirected` and the invoice escalates.
- Two keys name bank details (`accounts.md`). The full `accountKeyOf` is the one in terms, and it is compared wherever a decision or an approval pinned an account. `routeKeyOf` only answers whether details go to the same account as before, and never goes in terms. Bump `ROUTE_SCHEME` whenever `routeKeyOf` or `NOT_ROUTING_FIELDS` changes.
- New bank details never come from an email or the reader. They come only from a callback to the phone on file, which a person records (`recordBankChange`).
- The phone on file is per supplier record (`supplier_contacts`, one Airwallex beneficiary id). Two people put it there or change it: one proposes it, someone else confirms it by typing it again from their own source. It never comes from an email, the reader, the Airwallex record or a pay run file. A callback counts only while the number it was made on is on file (`bank_changes.contact_id`), and whoever proposed or confirmed that number can neither record a callback on it nor approve a payment to an account a callback on it verified. A confirmed change withdraws, in its own transaction, every open or approved request that relied on a callback.
- Once an invoice is escalated, only a matching approval releases a payment. A replacement already out is never approved a second time, and after a failed replacement the policy escalates instead of sending a third payment.
- Decisions read a fresh balance, never `BalanceCache`, and the fee from the transfer just fetched, never from the ledger. An automatic replacement is checked against the wallet's reserve floor (`RESERVE_FLOORS`), less `committedMinor`. In a currency with no floor set it escalates. A single incident's original is not checked against the floor, and pay run rows are. A new kind of promised money must be counted in `committedMinor` and the cash panel's `FIRM_KINDS` (both in `store/read/cash.ts`), or the floor can be breached.
- A payment from another currency's wallet always goes out on a quote a person approved, carried in `terms.fx`.
- PayOnce closes a paid invoice by itself only when one payment is paid, nothing else for it is live, and `settle` finds none of the things it refuses for: a live payment at an unapproved rate or to other details, a late transfer beside a live payment, a live outside payout, or a mismatched transfer nobody has cleared. Anything else that looks paid waits for a person to close it (`closeIncident`), and that close must name every uncleared mismatched transfer. The only close without a payment that PayOnce makes by itself is `rejectAgain`, of an invoice a person closed before.

### Looks

- In `pnpm ui` and `pnpm recover`, every step on an invoice goes through the `Dispatcher`. The other CLI commands call the engine directly and rely on the ledger's transactions. A contact change runs outside any invoice's turn, as one transaction, and then wakes the invoices it touched.
- Every `await` of a look stays in `look()` (and of a held invoice in `continueHeld`), in its order. The steps await nothing, and a step that starts async work returns its promise as it is. An extra microtask turn reorders a look against other looks and the sweep.
- The order of a look's steps does not change: an unrecognised transfer is held before any retry, outside payouts are listed again before every payment, and a payment that may be paid twice holds the invoice before the policy runs or a close happens.

### Approvals

- Terms are built only by `termsFor`, `heldTermsFor` and `runTermsFor`, and the binding is SHA-256 of the terms JSON, so key order matters. A new field goes in by a conditional spread, so existing terms and bindings stay byte for byte the same. Check that on a copy of the ledger. The floor, second-bill and not-to-pay clauses are part of the reason text in the terms, so they are part of the binding.
- The policy is in `approvers.ts`: names from `APPROVERS` within their limits, compared with `paymentAmount` or `runAmount`, never a bare number. Whoever started the incident cannot approve it, and neither can a pay run's uploader, anyone who recorded a callback for the account, or anyone who proposed or confirmed the phone that callback was made on (`barredFrom`). `engine-rules.md` lists when two approvers are needed. Without `APPROVERS` every approval is refused.
- A request opens only on an escalated invoice, and never on one a person closed (`rejected_by`) or one the ledger shows paid once. It expires `APPROVAL_TTL_MINUTES` after it opens, or sooner for a cross-currency payment whose quote ends first, and a request that gets its last signoff has at least 10 minutes to be used.
- Just before an approval is spent, `approvalProblem` checks it against the policy as it is now, and nothing is spent if the invoice's email count or its paid duplicate changed since the look. An approved replacement is checked against the floor again. An approval is spent only by `useApproval` or `releaseFor`, which check the invoice and its outside payouts again and open the attempt in the same transaction, or, for a pay run, by `Ledger.releaseRun`.

### Reasons and situations

- Every reason PayOnce stores is an exported constant or built from them (`domain/decide.ts`, `domain/reasons.ts`), apart from the one that names the source currency. Each has a code: a `Reason` is a code with clauses and slots, and `reasonText` renders exactly the text stored.
- The store's escalation methods take a `Reason`, never a string, and write the text with its codes (`escalation_code`, `escalation_clauses`, `escalation_slots`) in one statement (`SET_REASON`). The text stays the record, and terms carry the text, so no binding moves. `Ledger.reasonOf` reads the codes when they render the stored text, and parses the text otherwise.
- Consumers switch on codes and on `situationOf`, not on reason text: alerts, Home and Incidents, the supplier view's cautions, the outbox, metrics, Ask why and the views. The board's read model (`views/incident-board.ts`) still tests text prefixes; a new consumer reads codes. A new reason needs its code, family and label in `domain/reasons.ts`, or it reads as `unrecognised` and Ask why shows a stand-in.
- `escalation_reason` never holds email text, model output, a phone number or account details, because alerts send it.

### Text, names and secrets

- Text PayOnce did not write (Airwallex names and errors, emails, typed names and notes, pay run cells) goes through a cleaning step before it is shown: `say` and `printable` on the console, `marked` in MCP answers, `defanged` in alerts, and `<Theirs>` (with `cleanLine` from `web/src/text.ts`) on the page, always into text nodes. Short references and failure codes are shown only in their fixed patterns (`domain/patterns.ts`).
- `marked` checks every string of an MCP answer by its path against `src/views/outside-fields.ts`. A field listed with a source is always wrapped as outside text. A field not listed passes plain only as a token (a time, a hash, an id, an amount), so a field added to a view later is wrapped until it is listed. Every phone number the ledger holds is masked.
- Alerts are built from ledger fields, never from timeline lines, and never name an approver, an account or a phone number. Text from the model service never reaches a timeline line, which uses `triesText`'s fixed words, and neither does `airwallexAdvice`. The Ask why answer is never stored.
- Every PayOnce name a person types goes through `personName`, and two names are compared with `sameName`. The supplier's contact on a callback is not a PayOnce name.
- Timeline lines are one line each, hash-chained and never edited. They are written through `note` or `runNote`, or by the store methods that append a line inside their own transaction (`Timelines.appendEvent`), never with plain SQL.
- `AWX_CLIENT_ID`, `AWX_API_KEY`, `CLAUDE_API_KEY` and `READER_API_KEY` are never printed. The model reader and Ask why cut both model keys out of every error and answer with `redactKeys`. Airwallex errors go through `withoutSecrets`, which cuts the client id, the key and the token in every form `redactKey` cuts, and through `cleanLine`. The Airwallex client accepts only the two sandbox hosts and `sandbox.invalid`.

### The page

- The page only renders views. It imports types from `src/views/contract.ts` through `web/src/types.ts` and no code from `src/`; the build stops on a file outside `web/src/` and `node_modules/`. It works out no policy of its own: what a person can do, and why not, comes in the view.
- One module script and one stylesheet, both from the server itself. No inline script or style, no `style` attribute in HTML, no outside request, system fonts. The CSP in `router.ts` enforces it.
- Text PayOnce did not write goes through `<Theirs>` into text nodes. Never `dangerouslySetInnerHTML`.
- Every action answers the fresh view, built after the step's turn ends, and a notice (`Acted<View>`, or a result that carries both). Typed drafts live in component state, never in the polled view, so a poll never wipes typing or moves focus.

### Settings

- Every environment variable is read in `settings.ts`, with its default, parsing and error text, and nowhere else. A new setting goes there, and reading it never throws: a value PayOnce cannot use carries its problem, and the code that needs it refuses at the moment it always did. A new variable goes in `.env.example` too.
- An entry point that reads settings calls `loadSettings()` after it loads `.env` and passes the code below it what it needs as arguments. Nothing keeps a loaded copy, so no module reads a setting it was not handed. The MCP server reads its settings only from the keys it allows (`ENV_ALLOWED`) and `PAYONCE_LEDGER`.
- The settings keep the Airwallex credentials and the model keys inside functions (`airwallex.client()`, `models.readerServices()`, `models.askServices()`), so printing or sending the settings object cannot show a key. Still, never send or print it whole.

### Ledger

- `Db.transaction` (reached as `Ledger.transaction`) cannot nest. Nothing that opens its own transaction runs inside one, and timeline lines are written after the commit, except those a store method appends inside its own.
- A new column goes in `ADDED_COLUMNS` (`store/schema.ts`) and is added under the write lock when the file opens. A new table goes in `SCHEMA`, except reconciliation's, which `ReconStore.ensure` creates. After an upgrade every PayOnce process restarts, because an older one sharing the file can void new requests.
- Stored JSON is read by its shape. `checkedObject` reads strict wherever it runs; `storedShape` reads strict on every payment path and as none inside `readingSoft`, where only views read. A value that does not parse or fails its shape throws `StoredShapeError`, whose message names the row in fixed words and never quotes the stored text.
- Reconciliation, metrics, the board, the views, Ask why and the MCP server move no money and change no invoice, attempt, approval or binding. The engine and the policy never read them, and `ledger.ts` only creates reconciliation's tables when the file opens.

### Checking

- Most changes can be checked on a copy of the ledger with Airwallex stubbed, or with `AWX_BASE_URL` at `sandbox.invalid`, as the notes in `docs/verification/` were. Use the real sandbox only when the check needs it, and read `sandbox-behaviour.md` first, because the simulator refuses some transitions.

## Keeping this file small

- This file stays under about 50k characters. Detail goes in the topic note in `docs/design/`. A change adds a line here only when the file map, the index or the rules above need one.
- A new topic gets its own note and a row in the index.
- A topic note holds Rules, Why and Edge cases. Dated notes on what was checked go in `docs/verification/<topic>.md`, never in the topic note.

## Conventions

- The code uses explicit type annotations and few comments.
- TypeScript 7 needs `"types": ["node"]` in `tsconfig.json` and `web/tsconfig.json`.
- pnpm 12 blocks install scripts; `esbuild` is allowed in `pnpm-workspace.yaml`.
- The only direct runtime dependencies are `@modelcontextprotocol/server` and `zod`, pinned exactly and imported only by `src/surfaces/mcp/main.ts`. The SDK brings `@modelcontextprotocol/core` 2.3.1. None of the three has install scripts.
- `preact` and `esbuild` are exact devDependencies: the page bundles Preact at build time, so nothing of either runs on the server.

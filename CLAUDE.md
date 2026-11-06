# PayOnce

Payment incident agent for the Airwallex Agentic Banking Hackathon 2026, built on starter kit 3. TypeScript, pnpm, Node 24. Sandbox only.

## Commands

```bash
pnpm install
pnpm typecheck                                      # tsc --noEmit
pnpm dev                                            # policy on seven sample incidents, no credentials
pnpm ui                                             # web page and JSON API at http://127.0.0.1:4310, webhook receiver on 4311
pnpm recover [OUTCOME] [INVOICE] [EMAILS] [SCENARIO] [NAME] # one incident against the sandbox, or continue an existing invoice (status checks, no webhooks)
pnpm approve <INVOICE> [REQUEST NAME]               # show the waiting approval (a replacement, or paying a held invoice), its request number and the policy; with both, record that person's approval of that request
pnpm close <INVOICE> [NAME] [NOTE] [--covers=REF,...] # show a paid incident or a held invoice waiting on a person; with NAME and NOTE, close it (a held invoice without paying); --covers names every mismatched transfer the close covers
pnpm run audit [INVOICE] [json|csv]                 # check every invoice and pay run timeline, reconciliation's chain and their three running hashes, or one invoice's; with a format, print its audit trail
pnpm run audit run <RUN> [json|csv]                 # the same for one pay run's timeline
pnpm cash                                           # read balances once and print each currency down to the headroom above its floor; exit 1 if Airwallex is unreadable, a floor is unreadable or a headroom is below 0
pnpm board [FILTER...]                              # the incident board from the ledger alone, active outages first; filters in any order: a group (person, deadline, bank, open), a currency, an origin (payonce, outside, pay-run)
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

Defaults: OUTCOME `CHANNEL_TIMEOUT`, EMAILS `nothing-arrived`, SCENARIO `usd-local`, NAME the OS login name (who started the incident). OUTCOME is a simulator failure type, `PAID`, or `STAYS_IN_FLIGHT`, which leaves the original in `SENT`. `pnpm audit` is pnpm's own dependency audit, so the audit command needs `run`. Asking an invoice why is `pnpm ask` because pnpm runs its own `why` command, a dependency check, in place of a script named `why`. `pnpm reconcile` runs the script: pnpm 12.5.1's `pnpm help` lists no `reconcile` or `recon` command. `pnpm metrics` runs the script too: `pnpm help` lists no `metrics` command and `pnpm help metrics` answers "unrecognized subcommand". There is no lint script and there are no tests.

## Where the details are

This file holds the commands, the file map and the rules that hold everywhere. The rest is in `docs/design/`, one file per topic, with the dated notes on what was checked and how. Read the topic file before changing the code it covers. Where this file and a topic file differ, the topic file is right.

| Topic file | Read it before changing |
|---|---|
| `engine-rules.md` | anything that sends, holds, approves or closes a payment: `engine.ts`, `decide.ts`, `payments.ts`, `approval.ts`, `approvers.ts`, `bank-change.ts`, `duplicates.ts`, `reserve.ts`, `cash-position.ts`, `currency-lock.ts`, `assess.ts`, `fx.ts`, `sweep.ts`, `watcher.ts`, `dispatcher.ts` |
| `ledger.md` | `ledger.ts` and `audit-trail.ts`: a table, column, index, trigger, transaction or the hash chain |
| `accounts.md` | `accountKeyOf`, `routeKeyOf`, `NOT_ROUTING_FIELDS`, or any test of whether two sets of bank details are one account |
| `names.md` | anything that records or compares a person's name |
| `route-advisory.md` | `arrival.ts`, due dates and arrival estimates |
| `pay-runs.md` | `run-file.ts`, `runs.ts`, `payrun.ts`, and the run's turn in `watcher.ts` and `dispatcher.ts` |
| `rail-outages.md` | `outages.ts`, `outage.ts` and the outage gate in `openAttempt` |
| `uploaded-emails.md` | `eml.ts`, `html-text.ts`, `css-text.ts`, `intake.ts`, `parse-worker.ts` |
| `email-reader.md` | `model-service.ts`, `model-reader.ts`, `keyword-reader.ts`, `reader.ts`, `reader-error.ts`, `emails.ts` |
| `ask-why.md` | `why-facts.ts`, `explainer.ts`, `ask.ts`, and any new reason or timeline line, since Ask why passes only the ones it knows |
| `reconciliation.md` | `recon-match.ts`, `recon-store.ts`, `reconcile.ts`, `recon-cli.ts`, `airwallex/history.ts`, and reconciliation's chain in `audit-trail.ts` |
| `metrics.md` | `metrics.ts`, `metrics-cli.ts` and the time triggers in `ledger.ts` |
| `incident-board.md` | `incident-board.ts`, `board.ts`, and the cash line kinds the board totals (`FIRM_KINDS`, `WAITING_KINDS`, `waitingRunLines` in `cash-position.ts`) |
| `supplier-view.md` | `suppliers.ts`, `supplier.ts`, and how the page shows text PayOnce did not write (`whyText`) |
| `outbox.md` | `drafts.ts`, `outbox.ts` |
| `alerts.md` | `alerts.ts`, `alert-payloads.ts`, and anything written to `escalation_reason` |
| `web-server.md` | `server.ts` and `web/` |
| `mcp-server.md` | `mcp.ts`, `mcp-views.ts`, `mcp-text.ts` |
| `webhooks.md` | `webhooks.ts`, `tunnel.ts`, `airwallex/webhooks.ts` |
| `sandbox-behaviour.md` | anything that relies on what Airwallex or its simulator does, and before any run against the sandbox |
| `structure.md` | any file, since it has the full note on each and the map below is its short form. It is the main note for `src/airwallex/` (the host allowlist, secret redaction, error shapes, `airwallexAdvice`), `sandbox-bank.ts`, `scenario.ts`, `printable.ts`, `redact.ts`, `terms-shape.ts`, `words.ts`, `line-error.ts`, `env-file.ts` and the CLI commands |

## Files

- `src/decide.ts`: the pure policy (wait, replace, escalate, close) and `floorReason`. Every reason it gives is an exported constant, apart from the one that names the source currency.
- `src/incident.ts`: the `Incident` and `Decision` types. Amounts are minor units.
- `src/money.ts`: `toMinor`, `readMinor`, `toMajor`, `formatMoney`, for two-decimal currencies only.
- `src/engine.ts`: the agent, shared by the CLI and the server. `resumeIncident` is one look at an invoice. Also `startPayment`, `startFirst`, `replaceUnderLock`, `approvePayment`, `closeIncident`, `payAgain`, `note` and `noteError`, tying payouts sent outside PayOnce, and FX rates.
- `src/dispatcher.ts`: runs steps one invoice at a time. `wake(id, true)` gives a look the pay run's turn.
- `src/watcher.ts`: the fallback for webhooks. Reads payments in flight, wakes due invoices and runs the sweep. In the server it also releases approved pay runs and sends their unsent rows by waking them with the run's turn.
- `src/sweep.ts`: lists transfers since the ledger started and handles the ones PayOnce did not send, late transfers and mismatched ones.
- `src/payments.ts`: idempotent send and status sync, and `recordMissingFees`.
- `src/assess.ts`: reads an Airwallex transfer: its state, whether a resend can fix it, its account and route keys, fee and debit.
- `src/deadlines.ts`: how long the bank has to pay or fail a transfer, by method.
- `src/arrival.ts`: the route advisory: usual arrival days by corridor, due-date risk and its wording.
- `src/duplicates.ts`: supplier and invoice-number matching, `likelyDuplicates` and the payout-to-invoice match.
- `src/approval.ts`: approval terms (`termsFor`, `heldTermsFor`, `runTermsFor`), `bindingOf`, `paymentAmount`, `runAmount` and the FX helpers.
- `src/approvers.ts`: the approval policy from the environment, signer checks, `personName` and `sameName`.
- `src/bank-change.ts`: recording a callback that confirms new bank details.
- `src/reserve.ts`: reserve floors from `RESERVE_FLOORS`, and `debitCurrency`.
- `src/cash-position.ts`: the cash panel: `cashLines`, `committedMinor`, `lineAmount`, `cashReport`.
- `src/currency-lock.ts`: a lease per wallet with a fair queue (`withCurrencyLock`).
- `src/fx.ts`: reads `FX_QUOTE_VALIDITY`.
- `src/outages.ts`: rail outages: the failure codes, the rule, recording failures, ending one, the views.
- `src/run-file.ts`, `src/runs.ts`: the pay run CSV parser, and pay runs from upload to release.
- `src/ledger.ts`: the SQLite ledger (`node:sqlite`): tables, transactions, the duplicate lock, the hash chain, `readSnapshot`, `readingSoft`.
- `src/audit-trail.ts`: hashing, chain checks and exports for invoice, pay run and reconciliation timelines.
- `src/sandbox-bank.ts`: plays the bank in the sandbox through the simulator.
- `src/scenario.ts`: the demo payments (`SCENARIOS`) and the scripted incident.
- `src/webhooks.ts`, `src/tunnel.ts`: the webhook receiver and its cloudflared quick tunnel.
- `src/emails.ts`: the `EmailReader` interface, findings, `summarise`, the sender check and the fixture loader.
- `src/eml.ts`, `src/html-text.ts`, `src/css-text.ts`: the raw email parser and its HTML and CSS scanners.
- `src/intake.ts`, `src/parse-worker.ts`: the upload queue, the parse worker, matching an upload to invoices and delivering it.
- `src/model-reader.ts`, `src/keyword-reader.ts`, `src/reader.ts`, `src/reader-error.ts`: the two email readers, their settings and their failures.
- `src/model-service.ts`: the model services the reader and Ask why ask in order, Claude's Messages API then Gemini's chat completions, and one request to a model over `fetch`.
- `src/why-facts.ts`, `src/explainer.ts`: Ask why: the facts with their aliases and reason grammar, and the model call.
- `src/redact.ts`: `redactKey`, which cuts a key out of error text in every form.
- `src/words.ts`: fixed words the read-only code shares without importing the reader or the sandbox bank.
- `src/line-error.ts`: `LineError`, an error whose message is a timeline line.
- `src/printable.ts`: everything printed to a terminal goes through it (`say`, `printable`, `printableJson`, `shownReference`).
- `src/terms-shape.ts`: checks stored terms before a CLI command prints or approves them.
- `src/env-file.ts`: `loadEnvIfPresent`.
- `src/server.ts`: the HTTP server for `web/` and the JSON API. It also starts the watcher, webhooks, alerts and the reconciliation timer.
- `src/alerts.ts`, `src/alert-payloads.ts`: alert conditions, and the Slack and Discord posts.
- `src/drafts.ts`: the outbox: its message templates, `outboxOf`, `createDraft` and `markDraft`.
- `src/recon-match.ts`, `src/recon-store.ts`, `src/reconcile.ts`: reconciliation's matcher, its tables and its checks.
- `src/incident-board.ts`: the incident board.
- `src/suppliers.ts`: the supplier view.
- `src/metrics.ts`: the ops metrics.
- `src/mcp.ts`, `src/mcp-views.ts`, `src/mcp-text.ts`: the read-only MCP server, its views, and the marking of text PayOnce did not write.
- CLI entry points: `recover.ts`, `approve.ts`, `close.ts`, `audit.ts`, `cash.ts`, `board.ts`, `payrun.ts`, `outbox.ts`, `outage.ts`, `ask.ts`, `supplier.ts`, `recon-cli.ts`, `metrics-cli.ts`, `reset.ts` and `index.ts` (`pnpm dev`).
- `src/airwallex/`: `client.ts` (sandbox hosts only, errors, secret redaction, advice), `transfers.ts`, `fx.ts`, `beneficiaries.ts`, `balances.ts`, `webhooks.ts`, `simulation.ts` (sandbox-only calls) and `history.ts`.
- `web/`: the static page (`index.html`, `styles.css`, `app.js`), with no build step and no external requests.
- `fixtures/emails/`, `fixtures/pay-run-example.csv`: sample supplier threads and a sample pay run file.
- `docs/demo.md`: the recording script for the demo. `docs/design/`: the topic notes.

## Rules that hold everywhere

These are short forms of rules the topic files give in full, with their exceptions and reasons.

### Money

- Rules stay in code. `decide.ts` decides, and no model decides an amount, an account or whether to pay. Findings from supplier emails only add caution: they are ORed with the stored ones and never removed.
- PayOnce learns what the bank did only by reading Airwallex. A webhook or the watcher wakes a look, and nothing in a webhook's body feeds a decision. The engine never simulates a bank outcome.
- In `pnpm ui` and `pnpm recover`, every step on an invoice goes through the `Dispatcher`. The other CLI commands call the engine directly and rely on the ledger's transactions.
- An attempt opens only through `Ledger.openAttempt`, inside a transaction, before the Airwallex call. It checks that the lease is still held and is the source wallet's, applies the outage gate, copies the quote from the approval (and refuses a cross-currency attempt without one), and writes `request_id`, `account_key`, `route_key` and `approval_id`. Nothing calls `insertAttempt` any other way.
- A 4xx other than 429 marks the attempt failed, with two exceptions. `duplicate_request_id` is not a failure: the transfer it names is recorded. A retry of a cross-currency attempt is not failed by a 4xx while its quote can still pay. Any other error leaves the attempt pending, and a later look retries it under the same `request_id` and the same quote. A pending attempt is failed without a refusal only in the cases `engine-rules.md` lists, and only once a bank deadline has passed with nothing listed under its request id.
- One live payment per invoice: the partial unique index `one_live_attempt_per_invoice`, and `insertAttempt`'s `LIVE_ATTEMPT` check. A transfer the bank has live counts as live whatever state the ledger gives its attempt (`liveAtBank`), and `Ledger.record` never breaks the lock.
- Every payment PayOnce creates holds the lease of the wallet it leaves (`withCurrencyLock` on `debitCurrency`) from its last Airwallex read until the transfer is recorded. Just before any payment, the transfers are listed again and any new payout sent outside PayOnce is tied. If one turns up, nothing is sent and the look comes again at once. The exception is a new invoice's original, which still goes out when the payout it tied has already failed.
- Every first payment goes through `startPayment`'s holds: a missing beneficiary, a likely duplicate, an invoice number already on file for the supplier, a live outside payout, an account that changed since the last checked payment or was never confirmed, emails on file, and a payment from another currency's wallet. A pay run row is sent only on a look that has the run's turn.
- An attempt PayOnce opens keeps the account it was decided or approved for (`attempts.account_key`). Attempts from before the column, and a found payout's original, may have none. The beneficiary record is read again before sending, and if its details then differ from the kept ones in any field, nothing is sent. A transfer that went to other details is marked `misdirected` and the invoice escalates.
- Two keys name bank details (`accounts.md`). The full `accountKeyOf` is the one in terms, and it is compared wherever a decision or an approval pinned an account. `routeKeyOf` only answers whether details go to the same account as before, and never goes in terms. Bump `ROUTE_SCHEME` whenever `routeKeyOf` or `NOT_ROUTING_FIELDS` changes.
- New bank details never come from an email or the reader. They come only from a callback to the phone on file, which a person records (`recordBankChange`).
- Once an invoice is escalated, only a matching approval releases a payment. A replacement already out is never approved a second time, and after a failed replacement the policy escalates instead of sending a third payment.
- Decisions read a fresh balance, never `BalanceCache`, and the fee from the transfer just fetched, never from the ledger. An automatic replacement is checked against the wallet's reserve floor (`RESERVE_FLOORS`), less `committedMinor`. In a currency with no floor set it escalates. A single incident's original is not checked against the floor, and pay run rows are. A new kind of promised money must be counted in `committedMinor` and the cash panel's `FIRM_KINDS`, or the floor can be breached.
- A payment from another currency's wallet always goes out on a quote a person approved, carried in `terms.fx`.
- PayOnce closes a paid invoice by itself only when one payment is paid, nothing else for it is live, and `settle` finds none of the things it refuses for: a live payment at an unapproved rate or to other details, a late transfer beside a live payment, a live outside payout, or a mismatched transfer nobody has cleared. Anything else that looks paid waits for a person to close it (`closeIncident`), and that close must name every uncleared mismatched transfer. The only close without a payment that PayOnce makes by itself is `rejectAgain`, of an invoice a person closed before.

### Approvals

- Terms are built only by `termsFor`, `heldTermsFor` and `runTermsFor`, and the binding is SHA-256 of the terms JSON, so key order matters. A new field goes in by a conditional spread, so existing terms and bindings stay byte for byte the same. Check that on a copy of the ledger. The floor, second-bill and not-to-pay clauses are part of the reason in the terms, so they are part of the binding.
- The policy is in `approvers.ts`: names from `APPROVERS` within their limits, compared with `paymentAmount` or `runAmount`, never a bare number. Whoever started the incident cannot approve it, and neither can a pay run's uploader or anyone who recorded a callback for the account. `engine-rules.md` lists when two approvers are needed. Without `APPROVERS` every approval is refused.
- A request opens only on an escalated invoice, and never on one a person closed (`rejected_by`) or one the ledger shows paid once. It expires `APPROVAL_TTL_MINUTES` after it opens, or sooner for a cross-currency payment whose quote ends first, and a request that gets its last signoff has at least 10 minutes to be used.
- Just before an approval is spent, `approvalProblem` checks it against the policy as it is now, and nothing is spent if the invoice's email count or its paid duplicate changed since the look. An approved replacement is checked against the floor again. An approval is spent only by `useApproval` or `releaseFor`, which check the invoice and its outside payouts again and open the attempt in the same transaction, or, for a pay run, by `Ledger.releaseRun`.

### Text, names and secrets

- Every reason PayOnce stores is an exported constant or built from them, apart from the one that names the source currency, and Ask why's reason grammar is built from those constants. A new reason needs a constant and a grammar part, or Ask why shows a stand-in. `escalation_reason` never holds email text, model output, a phone number or account details, because alerts send it.
- Text PayOnce did not write (Airwallex names and errors, emails, typed names and notes, pay run cells) goes through a cleaning step before it is shown: `say` and `printable` on the console, `marked` in MCP answers, `defanged` in alerts, and on the page `whyText`, always into text nodes. Email subjects and bodies are shown on the page as stored, in text nodes. Short references and failure codes are shown only in their fixed patterns.
- Alerts are built from ledger fields, never from timeline lines, and never name an approver or an account. Text from the model service never reaches a timeline line, which uses `triesText`'s fixed words, and neither does `airwallexAdvice`. The Ask why answer is never stored.
- Every PayOnce name a person types goes through `personName`, and two names are compared with `sameName`. The supplier's contact on a callback is not a PayOnce name.
- Timeline lines are one line each, hash-chained and never edited. They are written through `note` or `runNote`, or by the Ledger methods that append a line inside their own transaction, never with plain SQL.
- `AWX_CLIENT_ID`, `AWX_API_KEY`, `CLAUDE_API_KEY` and `READER_API_KEY` are never printed. The model reader and Ask why cut both model keys out of every error and answer with `redactKeys`. Airwallex errors go through `withoutSecrets`, which cuts the client id, the key and the token in every form `redactKey` cuts, and through `cleanLine`. The Airwallex client accepts only the two sandbox hosts and `sandbox.invalid`.

### Ledger

- `Ledger.transaction` cannot nest. Nothing that opens its own transaction runs inside one, and timeline lines are written after the commit, except those a Ledger method appends inside its own.
- A new column goes in `ADDED_COLUMNS` and is added under the write lock when the file opens. A new table goes in `SCHEMA`, except reconciliation's, which `ReconStore.ensure` creates. After an upgrade every PayOnce process restarts, because an older one sharing the file can void new requests.
- Stored JSON is read strict on every payment path. Only views read it soft, inside `readingSoft`.
- Reconciliation, metrics, the board, the supplier view, Ask why and the MCP server move no money and change no invoice, attempt, approval or binding. The engine and the policy never read them, and `ledger.ts` only creates reconciliation's tables when the file opens.

### Checking

- Most changes can be checked on a copy of the ledger with Airwallex stubbed, or with `AWX_BASE_URL` at `sandbox.invalid`, as the dated notes in `docs/design/` were. Use the real sandbox only when the check needs it, and read `sandbox-behaviour.md` first, because the simulator refuses some transitions.

## Keeping this file small

- This file stays under about 50k characters. Detail goes in the topic file in `docs/design/`. A change adds a line here only when the file map, the index or the rules above need one.
- A new topic gets its own file and a row in the index.
- Dated notes on what was checked go in the topic file, after the rules they back.

## Conventions

- The code uses explicit type annotations and few comments.
- TypeScript 7 needs `"types": ["node"]` in `tsconfig.json`.
- pnpm 12 blocks install scripts; `esbuild` is allowed in `pnpm-workspace.yaml`.
- The only direct runtime dependencies are `@modelcontextprotocol/server` and `zod`, pinned exactly and imported only by `src/mcp.ts`. The SDK brings `@modelcontextprotocol/core` 2.3.1. None of the three has install scripts.

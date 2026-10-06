# PayOnce

Payment incident agent for the Airwallex Agentic Banking Hackathon 2026, built on starter kit 3. TypeScript, pnpm, Node 24. Sandbox only.

## Commands

```bash
pnpm install
pnpm typecheck                                      # tsc --noEmit
pnpm dev                                            # policy on three sample incidents, no credentials
pnpm ui                                             # web page and JSON API at http://127.0.0.1:4310
pnpm recover [OUTCOME] [INVOICE] [EMAILS] [SCENARIO] # one incident against the sandbox, or continue an existing invoice
pnpm approve <INVOICE> [NAME]                       # show the waiting approval; with NAME, approve it
pnpm close <INVOICE> [NAME] [NOTE]                  # show a paid incident waiting on a person; with NAME and NOTE, close it
pnpm reset                                          # move payonce.db aside so the next run starts an empty ledger
```

Defaults: OUTCOME `CHANNEL_TIMEOUT`, EMAILS `nothing-arrived`, SCENARIO `usd-local`. OUTCOME is a simulator failure type or `PAID`. There is no lint script and there are no tests.

## Structure

- `src/decide.ts`: pure decision policy (wait / replace / escalate / close). Rules stay in code; the model never decides amounts or moves money.
- `src/incident.ts`: `Incident` and `Decision` types. Amounts are minor units.
- `src/engine.ts`: the incident flow shared by the CLI and the server. `runScenario` is the scripted sandbox incident, `resumeIncident` continues an invoice, `approveReplacement` records an approval, `closeIncident` records a person closing a paid incident, `note` writes the timeline. `SCENARIOS` defines the demo payments.
- `src/assess.ts`: maps an Airwallex transfer to `originalState` and `resendCanFix`, and compares bank details.
- `src/ledger.ts`: SQLite tables for obligations, attempts, approvals, emails, findings and events.
- `src/payments.ts`: idempotent send and status sync between Airwallex and the ledger.
- `src/approval.ts`: `ApprovalTerms`, `termsFor` and `bindingOf` (SHA-256 of the terms JSON).
- `src/emails.ts`: `EmailReader` interface (a `name` shown on the page, and `read`), `EmailFindings`, `unverifiedSenders` and the fixture loader.
- `src/model-reader.ts`: `ModelReader` reads the thread with one chat completion over plain `fetch`, with no SDK.
- `src/reader.ts`: `readerFromEnv` picks `ModelReader` when `READER_API_KEY` is set and the keyword placeholder otherwise.
- `src/keyword-reader.ts`: the fallback reader. It matches a handful of phrases.
- `src/server.ts`: `node:http` server for `web/` and the JSON API. It runs incidents in the background and tracks them in an in-memory `busy` set.
- `src/recover.ts`, `src/approve.ts`, `src/close.ts`, `src/reset.ts`, `src/index.ts`: the CLI commands.
- `docs/demo.md`: the recording script for the four demo incidents, with measured sandbox times.
- `src/airwallex/`: `client.ts` (login, token refresh, 30 s timeout, refuses non-sandbox hosts), `transfers.ts`, `beneficiaries.ts`, `balances.ts`, `simulation.ts` (every sandbox-only call).
- `web/`: static page (`index.html`, `styles.css`, `app.js`) with no build step and no external requests.
- `fixtures/emails/`: sample supplier threads. `{{invoice}}` is replaced with the invoice number. `new-account.json` uses a look-alike sender domain on purpose.

## Rules the engine keeps

- The engine writes an attempt row, with its `request_id`, before the Airwallex call. A 4xx marks the attempt failed. Any other error leaves it pending, because the transfer may exist, and a later run retries it under the same `request_id`.
- Once an invoice is escalated, only a matching approval releases a payment, even if the policy would now replace.
- A replacement that is already out is finished on resume. It is never approved a second time.
- Approval terms take the pay-to account from the beneficiary record as it is now, and the policy escalates if that differs from the account on the original transfer. The timeline carries a warning whenever they differ, whatever reason the policy escalates for.
- A reader failure marks the thread unread, which escalates.
- A non-finite amount throws in `toMinor`, and the policy escalates if the cash position is not a number.
- On resume, a paid replacement closes the incident. A paid original goes to the policy, which closes it only if no supplier email reports the payment missing.
- An escalated invoice whose original is paid is closed by a person through `closeIncident`, never by a resume. `pendingClose` says when that applies. Closing sends nothing and is not bound to terms.
- A settled invoice that is still paid once is left alone on resume.

## Ledger

- `src/ledger.ts` uses `node:sqlite`, which ships with Node 24, so there is no database dependency or server.
- The file is `payonce.db` in the working directory and is git-ignored. `pnpm reset` renames it with a timestamp, which is also ignored, so the next run starts empty. The rename fails with `EBUSY` while `pnpm ui` has the file open. Transfers already sent in the sandbox stay there.
- The duplicate lock is the partial unique index `one_live_attempt_per_invoice` on `attempts(invoice_id) WHERE state <> 'failed'`. A violation has `errcode` 2067 and is rethrown as `DuplicatePaymentError`.
- `paidOnce` is true when one attempt is paid and every other attempt has failed. `settle` closes an obligation only then. It also voids any approval still open.
- `obligations.escalation_reason` holds the policy's last reason for sending the invoice to a person.
- Approvals live in the `approvals` table with states `requested`, `approved`, `used` and `void`. The binding is the hash of the terms JSON, so build terms only through `termsFor` to keep the key order stable.
- A new request voids any earlier request or approval for the invoice that is still open. An approval is marked `used` before the payment is tried, so it covers one attempt.
- An approval request is created only when the original has failed. The duplicate lock still applies to an approved replacement.
- Supplier emails and the reader's findings are stored per invoice in `emails` and `email_findings`. The thread is read once when new emails arrive and the findings are reused, so a reader that words its summary differently on a second call cannot void an approval.
- Approval evidence includes the email summary, so new emails that change the findings void an approval.
- `events` holds the timeline. A line with a `topic` says how things stand: the decision, what the invoice is waiting on, an approval, the cost of a replacement, or a bank-details mismatch. `note` skips one when the timeline's last line on that topic says the same and nothing has happened since, so checking an invoice again when nothing has changed adds nothing. A line with no topic records an event and is skipped only when it repeats the line before it.
- On an escalated invoice the decision line says when the policy would now replace or close and why it does not.
- Columns added after the first version are listed in `ADDED_COLUMNS` and added when the database is opened.

## Email reader

- `READER_API_KEY` in `.env` turns the model reader on. `READER_BASE_URL` and `READER_MODEL` default to Gemini's OpenAI-compatible endpoint and `gemini-3.8-flash`, which is on Google's free tier.
- `pnpm dev` loads no env file, so it always uses the keyword placeholder.
- The request is one chat completion with `reasoning_effort: "low"` and a `json_schema` response format. `toFindings` checks the answer again, so a service that ignores the schema still cannot return anything but two booleans and a string.
- `tidy` replaces any token with four or more digits in the summary with `[number removed]`, because the approver reads the summary.
- A 429, a server error, a timeout or a bad answer is retried once after two seconds. Any other error status is not. A failure throws, the engine marks the thread unread, and the policy escalates.
- The API key is cut out of any error text before it reaches the timeline.
- Google may use free-tier content to improve its products. The fixtures are synthetic.
- It has not been run against Gemini yet. The request shape, the retries and the failure paths were run against a fake `fetch`.

## Web server

- It binds to loopback and has no login. `guard` checks the Host header and, for writes, the Origin header and a JSON content type.
- Routes: `GET /api/options`, `GET /api/incidents`, `GET /api/incidents/:id`, `POST /api/incidents` (takes `bankOutcome`, `emails` and `scenario`), `POST /api/incidents/:id/approve` (needs `approver` and `approvalId`), `POST /api/incidents/:id/close` (needs `closedBy` and `finding`), `POST /api/incidents/:id/resume`.
- An incident's detail carries `review` when a person can close it, and the page shows the close card from that.
- The page scrolls to keep the newest timeline line on screen when that line was already visible, and for 15 seconds after an action.
- On start it resumes every invoice that still has a pending or in-flight attempt.
- `GET /api/options` lists the default email thread first, so the form opens on the incident that is replaced without a person.

## Sandbox behaviour found by running it

- Credentials are a scoped API key in `.env` (`AWX_CLIENT_ID`, `AWX_API_KEY`). Admin keys are deprecated.
- A new transfer starts `SCHEDULED` and moves to `PROCESSING` on its own within seconds. The simulator returns `500 operation_failed` for a transition requested while it is still `SCHEDULED`, so wait first.
- The simulator sometimes returns `500 operation_failed` after it has applied the transition. `simulateTransfer` reads the transfer after a server error and retries only if the target status was not reached.
- A transfer left in `SENT` was `PAID` about ten minutes later with no simulation call. This happened once.
- `PROCESSING` to `SENT`, `SENT` to `PAID` and `SENT` to `FAILED` (with `failure_type`) all work. A failed transfer reads `FAILED`, then `CANCELLED` a few seconds later. The `failure` object survives the change.
- `failure.details.type` is `INCORRECT_ROUTING` for every simulated failure. Read `failure.code` instead: 91401 system error, 91402 channel timeout, 90701 account closed, 90101 invalid account name or number, 90802 beneficiary bank returned, 91001 recall requested, 91301 duplication return, 99901 unable to apply, 99902 other.
- Creating a transfer takes the amount out of `available_amount` immediately. A failed transfer is refunded a few seconds later.
- A EUR SWIFT transfer of 4,000 carried a fee of 13.91 or 13.92 EUR. When it failed, the 4,000 came back and the fee did not.
- The beneficiary record and a transfer's `beneficiary.bank_details` hold the same object. The transfer keeps the details it was sent with: `POST /api/v1/beneficiaries/{id}/update` changes the record and not the transfer, and setting the old values back makes the two equal again.
- Reusing a `request_id` returns `400 duplicate_request_id` and names the original transfer.
- LOCAL USD transfers carry no fee in the sandbox.
- The client sends no `x-api-version` header. The account default returns the newer status set (`FAILED` exists) with a nested `failure` object.
- Airwallex emails the account owner for every sent and cancelled transfer unless transfer notifications are turned off under Settings > User settings > Notifications.

## Conventions

- The code uses explicit type annotations and few comments.
- TypeScript 7 needs `"types": ["node"]` in `tsconfig.json`.
- pnpm 12 blocks install scripts; `esbuild` is allowed in `pnpm-workspace.yaml`.

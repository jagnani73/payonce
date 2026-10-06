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
- `src/emails.ts`: `EmailReader` interface, `EmailFindings`, `unverifiedSenders` and the fixture loader.
- `src/keyword-reader.ts`: placeholder reader. Replace it with a Claude-backed reader once `ANTHROPIC_API_KEY` is available.
- `src/server.ts`: `node:http` server for `web/` and the JSON API. It runs incidents in the background and tracks them in an in-memory `busy` set.
- `src/recover.ts`, `src/approve.ts`, `src/close.ts`, `src/index.ts`: the CLI commands.
- `src/airwallex/`: `client.ts` (login, token refresh, 30 s timeout, refuses non-sandbox hosts), `transfers.ts`, `beneficiaries.ts`, `balances.ts`, `simulation.ts` (every sandbox-only call).
- `web/`: static page (`index.html`, `styles.css`, `app.js`) with no build step and no external requests.
- `fixtures/emails/`: sample supplier threads. `{{invoice}}` is replaced with the invoice number. `new-account.json` uses a look-alike sender domain on purpose.

## Rules the engine keeps

- The engine writes an attempt row, with its `request_id`, before the Airwallex call. A 4xx marks the attempt failed. Any other error leaves it pending, because the transfer may exist, and a later run retries it under the same `request_id`.
- Once an invoice is escalated, only a matching approval releases a payment, even if the policy would now replace.
- A replacement that is already out is finished on resume. It is never approved a second time.
- Approval terms take the pay-to account from the beneficiary record as it is now, and the policy escalates if that differs from the account on the original transfer.
- A reader failure marks the thread unread, which escalates.
- A non-finite amount throws in `toMinor`, and the policy escalates if the cash position is not a number.
- On resume, a paid replacement closes the incident. A paid original goes to the policy, which closes it only if no supplier email reports the payment missing.
- An escalated invoice whose original is paid is closed by a person through `closeIncident`, never by a resume. `pendingClose` says when that applies. Closing sends nothing and is not bound to terms.
- A settled invoice that is still paid once is left alone on resume.

## Ledger

- `src/ledger.ts` uses `node:sqlite`, which ships with Node 24, so there is no database dependency or server.
- The file is `payonce.db` in the working directory and is git-ignored. Delete it to reset local state. Transfers already sent in the sandbox stay there.
- The duplicate lock is the partial unique index `one_live_attempt_per_invoice` on `attempts(invoice_id) WHERE state <> 'failed'`. A violation has `errcode` 2067 and is rethrown as `DuplicatePaymentError`.
- `paidOnce` is true when one attempt is paid and every other attempt has failed. `settle` closes an obligation only then. It also voids any approval still open.
- `obligations.escalation_reason` holds the policy's last reason for sending the invoice to a person.
- Approvals live in the `approvals` table with states `requested`, `approved`, `used` and `void`. The binding is the hash of the terms JSON, so build terms only through `termsFor` to keep the key order stable.
- A new request voids any earlier request or approval for the invoice that is still open. An approval is marked `used` before the payment is tried, so it covers one attempt.
- An approval request is created only when the original has failed. The duplicate lock still applies to an approved replacement.
- Supplier emails and the reader's findings are stored per invoice in `emails` and `email_findings`. The thread is read once when new emails arrive and the findings are reused, so a reader that words its summary differently on a second call cannot void an approval.
- Approval evidence includes the email summary, so new emails that change the findings void an approval.
- `events` holds the timeline. `note` skips a line already written since the last payment, email, bank, lock, closed or error line, so checking an invoice again when nothing has changed adds nothing.
- Columns added after the first version are listed in `ADDED_COLUMNS` and added when the database is opened.

## Web server

- It binds to loopback and has no login. `guard` checks the Host header and, for writes, the Origin header and a JSON content type.
- Routes: `GET /api/options`, `GET /api/incidents`, `GET /api/incidents/:id`, `POST /api/incidents` (takes `bankOutcome`, `emails` and `scenario`), `POST /api/incidents/:id/approve` (needs `approver` and `approvalId`), `POST /api/incidents/:id/close` (needs `closedBy` and `finding`), `POST /api/incidents/:id/resume`.
- An incident's detail carries `review` when a person can close it, and the page shows the close card from that.
- On start it resumes every invoice that still has a pending or in-flight attempt.

## Sandbox behaviour found by running it

- Credentials are a scoped API key in `.env` (`AWX_CLIENT_ID`, `AWX_API_KEY`). Admin keys are deprecated.
- A new transfer starts `SCHEDULED` and moves to `PROCESSING` on its own within seconds. The simulator returns `500 operation_failed` for a transition requested while it is still `SCHEDULED`, so wait first.
- The simulator sometimes returns `500 operation_failed` after it has applied the transition. `simulateTransfer` reads the transfer after a server error and retries only if the target status was not reached.
- A transfer left in `SENT` was `PAID` about ten minutes later with no simulation call. This happened once.
- `PROCESSING` to `SENT`, `SENT` to `PAID` and `SENT` to `FAILED` (with `failure_type`) all work. A failed transfer reads `FAILED`, then `CANCELLED` a few seconds later. The `failure` object survives the change.
- `failure.details.type` is `INCORRECT_ROUTING` for every simulated failure. Read `failure.code` instead: 91401 system error, 91402 channel timeout, 90701 account closed, 90101 invalid account name or number, 90802 beneficiary bank returned, 91001 recall requested, 91301 duplication return, 99901 unable to apply, 99902 other.
- Creating a transfer takes the amount out of `available_amount` immediately. A failed transfer is refunded a few seconds later.
- A EUR SWIFT transfer of 4,000 carried a fee of 13.91 or 13.92 EUR. When it failed, the 4,000 came back and the fee did not.
- The beneficiary record and a transfer's `beneficiary.bank_details` hold the same object.
- Reusing a `request_id` returns `400 duplicate_request_id` and names the original transfer.
- LOCAL USD transfers carry no fee in the sandbox.
- The client sends no `x-api-version` header. The account default returns the newer status set (`FAILED` exists) with a nested `failure` object.
- Airwallex emails the account owner for every sent and cancelled transfer unless transfer notifications are turned off under Settings > User settings > Notifications.

## Conventions

- The code uses explicit type annotations and few comments.
- TypeScript 7 needs `"types": ["node"]` in `tsconfig.json`.
- pnpm 12 blocks install scripts; `esbuild` is allowed in `pnpm-workspace.yaml`.

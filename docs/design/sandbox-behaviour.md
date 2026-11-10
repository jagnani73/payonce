# Sandbox behaviour

This note records what the Airwallex sandbox and its simulator do, found by running PayOnce against them, and covers the code that plays the bank there: the sandbox bank (`src/engine/sandbox-bank.ts`), the scripted incidents (`src/engine/scenario.ts`), `simulateTransfer` (`src/airwallex/simulation.ts`), the sandbox routes (`src/surfaces/http/routes/sandbox.ts`) and `fixtures/`. Read it before relying on anything Airwallex does, and before any run against the sandbox. The client itself is in [airwallex-client.md](airwallex-client.md), and invariant 56 in [invariants.md](../invariants.md) keeps the engine from simulating a bank outcome.

## Rules

### The account and the API

- Credentials are a scoped API key in `.env` (`AWX_CLIENT_ID`, `AWX_API_KEY`). Admin keys are deprecated.
- The client sends no `x-api-version` header. The account default returns the newer status set (`FAILED` exists) with a nested `failure` object.
- `created_at` reads like `2026-10-27T19:48:09+0000`, which `Date.parse` accepts.
- `GET /api/v1/transfers` takes `from_created_at` as an ISO time with milliseconds and `Z`, and takes `status`. It lists newest first and pages with `page_size` and a `page` cursor taken from `page_after`.
- A transfer's `beneficiary` has `bank_details`, `address`, `entity_type` and `type`. `bank_details.account_name` is the only name on it.
- `GET /api/v1/beneficiaries/{id}` answers 200 with an empty body for a well-formed id Airwallex does not have, and 400 `invalid_argument` for a malformed one. A record's `bank_details` carries `account_currency` and `account_name`.
- `findBeneficiary` gives undefined, as for an unknown beneficiary, for a record whose `id` is not the one asked for, and for a 400 or a 404.
- The beneficiary record and a transfer's `beneficiary.bank_details` hold the same object. The transfer keeps the details it was sent with.
- `POST /api/v1/beneficiaries/{id}/update` changes the record and not the transfer, and setting the old values back makes the two equal again.
- That update accepts the GET record's `beneficiary` (without `fingerprint`), `nickname`, `payer_entity_type` and `transfer_methods` (`updateBankDetails`). The next transfer to the beneficiary goes to the new account.
- After an update Airwallex rewrites `bank_name` from the routing number ("Bank of America" became "Bank of America, NA"), so the read-back compares only the fields that say where money goes.
- Reusing a `request_id` returns `400 duplicate_request_id` and names the original transfer.
- Airwallex emails the account owner for every sent and cancelled transfer unless transfer notifications are turned off under Settings > User settings > Notifications. On this account the emails for cancelled and sent transfers, overdue reminders and the daily summary of scheduled transfers are off.

### Transfers and the simulator

- A new transfer starts `SCHEDULED` and moves to `PROCESSING` on its own within seconds. The simulator returns `500 operation_failed` for a transition requested while it is still `SCHEDULED`, so `SandboxBank.send` waits first (`waitForTransfer`).
- The simulator sometimes returns `500 operation_failed` after it has applied the transition. `simulateTransfer` reads the transfer after a server error or a lost connection, and retries only if the target status was not reached, up to four tries 1.5 seconds apart.
- `PROCESSING` to `SENT`, `SENT` to `PAID` and `SENT` to `FAILED` (with `failure_type`) all work.
- A failed transfer usually reads `FAILED`, then `CANCELLED` a few seconds later. The `failure` object survives the change. One can stay `FAILED`, with no `PAYOUT_REVERSAL`, for half an hour or more (see Money).
- `failure.details.type` is `INCORRECT_ROUTING` for every simulated failure, so PayOnce reads `failure.code` instead (`FAILURE_CODES` in `src/domain/failure-codes.ts`).
- The codes: 91401 system error, 91402 channel timeout, 90701 account closed, 90101 invalid account name or number, 90802 beneficiary bank returned, 91001 recall requested, 91301 duplication return, 99901 unable to apply, 99902 other.
- The simulator returns `500 operation_failed` for every transition of a transfer that converts (`SENT`, `PAID`, `FAILED`, `CANCELLED`). Such a transfer stays in `PROCESSING`.
- The simulator can refuse every transition, same-currency ones too, for hours at a time.

### Money

- Creating a transfer takes the amount out of `available_amount` immediately. A failed transfer is usually refunded a few seconds later, as a `PAYOUT_REVERSAL` in the balance history.
- On 8 November one was not. P261108-WOU3MC3, 980.00 USD by LOCAL, failed with 90701 at 06:35:22 UTC and was still `FAILED`, never `CANCELLED`, with no reversal, at a reconciliation check 29 minutes later. The other failures that morning went `FAILED` to `CANCELLED` and were reversed 1 to 7 seconds after they failed. Reconciliation opens a `refund-missing` break for such a transfer once its window has passed.
- `reserved_amount` and `pending_amount` in `GET /api/v1/balances/current` read 0 in USD while a 4,000 USD transfer is in `SENT`. Money in flight cannot be read from the balance, so the cash panel takes it from the ledger.
- LOCAL USD transfers carry no fee in the sandbox.
- A EUR SWIFT transfer of 4,000 carried a fee of 13.91 or 13.92 EUR, and 14.03 EUR on 8 November. When it failed, the 4,000 came back and the fee did not.

### Exchange rates

- `POST /api/v1/fx/quotes/create` takes `sell_currency`, `buy_currency`, `buy_amount` and `validity`, and the sandbox requires `validity`.
- Quotes are `MULTI_USE`, and `GET /fx/quotes/{id}` returns the same body after expiry and after use.
- A transfer with `source_currency` USD, `transfer_currency` EUR and a `quote_id` is accepted with the usual body.
- It carries `conversion: { currency_pair: "EURUSD", rate }` with `rate` equal to the quote's `client_rate`, `source_amount` equal to the quote's `sell_amount`, and a fee in the source currency (15.60 USD for SWIFT, `SHARED`, and 15.59 on a later run).
- USD `available_amount` falls by `amount_payer_pays` at creation, and EUR does not move.
- The quote's `currency_pair` is the market convention (EURUSD, USD per EUR) whichever way the money goes. PayOnce compares rates as Airwallex gives them and never inverts one.
- `HR_1` cost about 0.12 percentage points more than `MIN_1` over mid-market.
- Reusing a request id after its quote expired returns `400 duplicate_request_id` naming the existing transfer: the duplicate check wins over the quote check.
- By Airwallex's docs, a converting transfer is refunded in the transfer currency by default, and the fee is not refunded.

### The sandbox bank

- `SandboxBank` plays the bank in the sandbox. It sends a new transfer to `SENT`, pays or fails it when the scenario says so, and pays every replacement.
- A scripted run waiting for an invoice's original (`scriptOriginal`) gets the first original the bank hears of for that invoice. Its script says whether it plays the transfer, and if it does, the bank leaves the transfer to it.
- Any other original gets the outcome `expectOriginal` recorded in this process, else what `outcomeOf` reads from the ledger (a pay run row's `sandbox_outcome`), else it is paid.
- `expectOriginal` takes only a simulator name (`[A-Z_]+`). Anything else, such as the CLI's `-` placeholder, is ignored, and the bank pays the original. A script settles its original the same way (`bankOutcomeOf`).
- Scripts and expected outcomes live in memory, so another process, or this one after a restart, pays the original instead.
- The bank reads each sent transfer first, trying up to four times in all on a server error or a lost connection, as the simulation calls do.
- A transfer that converts is left alone, and before its deadline (by the bank deadlines `SandboxBank` is given) the bank says so once.
- `SandboxBankError` is thrown when the simulator refuses or does not answer a move, when a read the bank needs fails with an `AirwallexError` or `AirwallexUnreachableError`, or when `waitForTransfer` gives up on a transfer still `SCHEDULED` (`TransferWaitError`).
- Any other error, such as a `TypeError`, is thrown unchanged, with its own message and stack trace.
- A `SandboxBankError` is a `LineError` of kind `sandbox`, so its line never reads as one from the bank. Lines it wrote before that kind existed are kind `bank` and stay that way. Its `what` is PayOnce's words: the simulator did not move transfer REF to a status this time, the bank could not read the transfer, the transfer stayed `SCHEDULED`, or the simulator does not move a transfer that converts.
- The `what` gives the answer's HTTP status, and an error code only in the form `FAILURE_CODE_PATTERN` allows (`^[A-Za-z0-9_]{1,40}$`). A reference is named only when it matches `REFERENCE_PATTERN`.
- The error's message adds `SANDBOX_BANK_AFTER` (PayOnce keeps reading the transfer, and a person hears about it if the bank has neither paid nor failed it by its deadline). Its `detail` is the error it came from.
- `pnpm recover`, which stops when its scripted run's bank fails, writes `what` with `SANDBOX_BANK_STOPPED` instead and prints its stopped guidance. Its `SandboxBank` writes a failure it hears through the bank hook with `SANDBOX_BANK_RECOVER`.
- `send` and `settle` take the transfer's short reference, and every read failure names it when the caller has it.
- `PAID_OUTCOME`, `STAYS_IN_FLIGHT` and `SANDBOX_OUTCOMES` (the bank outcomes the sandbox offers, and a run file's `sandbox_outcome` values) are in `src/text/words.ts`. `STAYS_IN_FLIGHT` leaves the original in `SENT`.
- `simulateTransfer` is called only by the sandbox bank, which the engine reaches only through the optional `Engine.bank` hook.

### Scripted incidents

- `SCENARIOS` holds the demo payments: `usd-local`, `eur-swift`, `eur-swift-low-reserve`, `usd-local-bank-change` and `eur-from-usd`, the one scenario with a `sourceCurrency`.
- `eur-swift-low-reserve` gives the invoice a floor of its own, placed so that one payment fits and a second fee is what breaches it. `usd-local-bank-change` carries the supplier's phone on file.
- `openScenario` is `openPayment` with the scenario's values and a payee step: `findOrCreateBeneficiary` by nickname, and the low-reserve floor.
- `openPayment` refuses before any Airwallex read: the invoice number's pattern, a number in the ledger or on a waiting pay run, the amount as positive minor units, a two-decimal currency and wallet, the method, the due date and the starter's name.
- So `pnpm recover` refuses a malformed invoice number, and one on a waiting pay run, with one line and nothing stored.
- The scenarios share one beneficiary per currency. Each `usd-local-bank-change` run creates a beneficiary of its own, nicknamed `PayOnce demo supplier (bank change)` plus the invoice number.
- A scripted incident's first payment waits for an approval, as every payment a person starts does, so `runScenario` sends nothing when it starts one. It registers its script with the bank (`scriptOriginal`) and wakes the invoice, so the request opens.
- Once a person approves it, the look that sends the original hands it to the script (`playOriginal`): the bank sends it, the supplier's emails arrive one at a time while it is in flight, then the bank pays or fails it. Once the incident has settled, a paid replacement is followed by Pay again, which the duplicate lock refuses.
- The script plays only the invoice's first original, the one sent on that approval, including after a retry under its request id. One sent after Airwallex refused the first is the bank's, with the scenario's outcome and no emails.
- An invoice held for something more specific, such as a second bill or an exchange rate, gets no script: the bank gives its original the scenario's outcome if a person releases it, and no supplier emails arrive. So does one whose first payment an outage held (`waitOnOutage`).
- Run again on a held invoice, as `pnpm recover` does to continue one, `runScenario` registers the script again when the invoice still waits only for its approval, and wakes it. If that look sends the original, it waits for the script and returns what it found. A script nobody waits on reports its failures through the bank's `onError`.
- `runScenario` returns true when the invoice waits for a person with nothing sent, and false when the invoice is still not at rest when the wait (`untilAtRest`, 180 seconds) runs out.

### Sandbox routes

- `pnpm ui` always serves the sandbox routes, since PayOnce only ever runs against the sandbox. `GET /api/sandbox` answers `SandboxView`: the scenarios, the bank outcomes, the email threads and the defaults. The route hands `sandboxView` the scenarios and defaults from `engine/scenario.ts` as a `SandboxScenarios` (`views/sandbox.ts`), because the views do not import the engine.
- `POST /api/sandbox/scenarios` starts a scripted incident and answers 202 with `PaymentCreated`. It refuses an unknown bank outcome, email thread or scenario (400), a due date `dueDateProblem` refuses (400), and a malformed invoice number (400).
- It also refuses an invoice number already in the ledger or on the waiting run (409). A `dueDate` of null is no due date.
- When Airwallex fails before the invoice is stored, it answers 502 with `airwallexAdvice`, and nothing is sent or stored. Otherwise the script runs in the background, and its failures go on the invoice's timeline.
- Its notice says the first payment waits for approval, and that once someone approves it the simulator plays the bank outcome and the email thread.
- `POST /api/sandbox/duplicate-lock/:id` runs Pay again in the invoice's turn and answers `DuplicateLockResult`. It never reaches Airwallex.

### Fixtures

- `fixtures/emails/` holds sample supplier threads, and `loadEmails` replaces `{{invoice}}` with the invoice number. `nothing-arrived.json` is the default thread.
- `new-account.json` uses a look-alike sender domain on purpose. `moved-banks.json` comes from the right domain, says the supplier changed banks and gives no account numbers.
- `fixtures/pay-run-example.csv` is a sample pay run file, with this sandbox account's demo beneficiary ids. `GET /api/runs/example.csv` serves it.

## Why

- `SandboxBank.send` waits for `PROCESSING` because the simulator refuses a transition while a transfer is `SCHEDULED`.
- `simulateTransfer` reads before it retries because the simulator sometimes answers 500 after applying the transition.
- PayOnce reads `failure.code` because `failure.details.type` is the same for every failure.
- The cash panel takes money in flight from the ledger because the balance's reserved and pending amounts do not show it.
- The read-back after a bank change compares only routing fields, because Airwallex rewrites `bank_name`.
- Each bank change run gets a beneficiary of its own because the scenarios share one per currency, so a bank change on one would reach the others.
- Rates are never inverted because `currency_pair` follows the market convention whichever way the money goes.
- The sandbox bank leaves a converting transfer alone because the simulator refuses to move it. The agent's deadline for it then runs out.
- Transfer notifications are off so Airwallex does not email the account owner for every transfer.
- `expectOriginal` lives in memory, while a pay run row's outcome is in the ledger, so a run row's outcome survives a restart and works in any process.
- A `SandboxBankError` is not PayOnce failing: in the sandbox the simulator stands in for the bank, so the payment is followed as any other.
- Its lines have a kind of their own because, as `bank` lines, a simulator refusal such as "did not move transfer REF to PAID this time: it answered 500 operation_failed" sat among the real bank lines of a payment that was then paid, and read like a bank error. The page could only tell them apart by their text.

## Edge cases

- A transfer left in `SENT` was `PAID` about ten minutes later with no simulation call. This happened once.
- A failed converting payment and its replacement cannot be shown in this sandbox, and what a failure refunds was not observed.
- The sandbox bank never asks the simulator to move a converting transfer, so nobody checked whether the simulator still refuses them.
- While the simulator refuses every transition, the sandbox bank's moves fail with a `SandboxBankError`, and payments sit in `PROCESSING` until their deadlines.
- A held invoice released after a restart, or in another process: `expectOriginal` is gone, so the bank pays its original.
- `pnpm recover` on an invoice from a pay run that has not sent its original is refused: the server sends it, in the run's order.
- `pnpm recover` on an invoice already in the ledger with a payment, or one a person closed, looks at it again instead of starting it.

Dated checks: [verification/sandbox-behaviour.md](../verification/sandbox-behaviour.md). The full runs against the sandbox, with every transfer they made: [verification/sandbox-runs.md](../verification/sandbox-runs.md).

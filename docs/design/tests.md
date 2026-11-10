# Tests

`pnpm test` replays a few journeys that check the money guarantees the README opens with. Each journey runs PayOnce's own engine on an empty ledger against a fake Airwallex inside the test process, and asserts on what the fake bank received and what the ledger holds. The suite runs without credentials or a network, never reads `.env`, and takes about a second.

The files are in `test/`: one `*.test.ts` file per guarantee, and the harness in `test/harness/`: `guard.ts` (what a test process may not do), `fake-airwallex.ts` (the fake bank) and `world.ts` (one journey's PayOnce). `test/tsconfig.json` extends the root one, and `pnpm typecheck` checks it.

## Rules

### How a journey runs

- `pnpm test` is `tsx --test --test-timeout=60000 test/*.test.ts`. It uses `node:test` and `node:assert` and no other package. Each file runs in a process of its own, and the files run in parallel. A test that takes more than 60 seconds fails.
- A journey builds a `World`: a new folder with an empty `payonce.db`, the settings from `SETTINGS` with the journey's own changes, the `Engine` from `createEngine`, and a `FakeAirwallex`. Each test makes its own `World` and calls `world.dispose()` in `t.after`.
- A journey drives PayOnce through the entry points the page and the CLI use: `openPayment` with `recordPayee` (the New payment form), `openScenario`, `resumeIncident` for one look, `approvePayment`, `closeIncident`, `payAgain`, and `parseUpload`, `storeUpload` and `deliverUpload` for an email. No server, `Dispatcher`, watcher or sweep runs, so nothing happens between two steps unless the journey does it.
- `World.startPayment` looks at the new invoice once, and again when that look held it, as `POST /api/payments` does. So a person's payment has its request open when it returns.
- `Date` is mocked with `node:test`'s mock timers, from 2026-11-02 09:00 UTC (`START`), and only `World.advance` moves it. Timers stay real, and no journey waits on one.
- The fake answers `https://sandbox.invalid` inside the process, with the bank in memory: login, current balances, beneficiary records (list, get, create, update) and transfers (create, get, list). Where PayOnce relies on the sandbox's behaviour, it follows [sandbox-behaviour.md](sandbox-behaviour.md): a reused request id answers `duplicate_request_id`, an unknown record answers 200 with an empty body, a new transfer takes its amount and fee from the wallet at once, and a failed one gets its amount back but not its fee.
- Nothing at the fake bank moves by itself. A new transfer is `PROCESSING`, and the journey plays the bank (`pay`, `fail`) and a person in the Airwallex web app (`sendOutside`, `editBeneficiary`, `addSupplier`).
- A journey asserts on facts: the transfers at the fake bank (how many, their status, request id, bank details and account key), the calls that changed something there, the invoice's state and reason code, the situation the payment page shows (`incidentView`), and the approvals' states and terms. It never compares a sentence PayOnce writes, so rewording a line breaks no journey.

### The journeys

| File | Guarantee | What the journey does |
|---|---|---|
| `pays-once.test.ts` | PayOnce never pays an invoice twice | A channel timeout gets one replacement under a new request id, Pay again is refused while either payment is live and after the close, and the invoice closes with one transfer paid and one failed. A payout sent from the web app while a payment waits for approval is tied to the invoice, the approval is voided, PayOnce creates no transfer, and a person closes it as paid. |
| `approvals.test.ts` | A payment a person starts is paid only on someone else's approval of its exact terms | The starter and a name outside `APPROVERS` are refused, and one signoff of the two needed sends nothing. A record's account number changed after the approval voids it, and only the new request's approval sends, to exactly the account its terms name. Terms edited in the ledger by hand stop every look with `StoredShapeError`, and the approval stays unspent. |
| `bank-details.test.ts` | Bank details never come from an email | A look-alike email asking for a new account is uploaded, parsed in the worker and delivered while the original is with the bank. The invoice escalates with `new-bank-details`, the channel timeout that follows is not resent by itself, and the approved replacement goes to the account on file. No transfer carries the email's details, and nothing writes to the beneficiary record. |
| `second-bill.test.ts` | A likely second bill is held, not paid | INV-0042 is paid, then INV-0042A for the same amount is held with `second-bill` and closed without paying. It runs twice: through the same record, and through a second record with the same account and routing numbers under an unrelated account name. |
| `reserve-floor.test.ts` | An automatic resend never takes a wallet below its reserve floor | The same channel timeout as in `pays-once.test.ts`, with a floor a replacement would breach, escalates with `below-floor` and sends nothing more. |
| `isolation.test.ts` | The journeys never reach Airwallex or read `.env` | Checks the guard below: the settings name only the offline host, PayOnce's client refuses a host that is not the sandbox, fetch and TCP to anything but the fake are refused, `.env` cannot be loaded, and the working folder is outside the repository. |

### Kept away from `.env` and Airwallex

- Every test file imports `test/harness/guard.ts` first, through `world.ts` or directly, so it runs before any PayOnce module. It:
  - removes from `process.env` every variable whose name starts with `AWX_`, `CLAUDE_`, `READER_`, `ALERT_` or `WEBHOOK`, and `PAYONCE_LEDGER`;
  - makes `process.loadEnvFile` throw;
  - replaces `fetch`, which answers only `https://sandbox.invalid` while a `World` is open, and refuses and records everything else;
  - refuses every TCP connection (`Socket.prototype.connect`), and lets a local pipe through, such as the one tsx uses to talk to its own CLI;
  - moves the process to a new folder under the system's temporary folder, and removes it at exit.
- No journey calls `loadEnvIfPresent`, or `loadSettings` without an argument. `SETTINGS` is an explicit list, with `AWX_BASE_URL=https://sandbox.invalid` and fake credentials whose values say they are not real keys.
- `World` refuses to start unless the engine's client talks to `sandbox.invalid`. `dispose` fails the journey when anything was refused, or when Airwallex was offered credentials other than the fake ones.
- Every ledger is a new `payonce.db` in its own folder under that temporary folder, never the repository's.
- PayOnce's output (`say`, `sayWarning`) is silenced so the report shows only the tests. `JOURNEY_LOG=1` lets it through. Only the harness reads that variable, so it is not in `settings.ts` or `.env.example`.

### Adding a journey

- Add `test/<guarantee>.test.ts`. Import `World` from `./harness/world.js` first, open a comment with the README section it checks, and name the `describe` after the guarantee in the README's words and each `test` after what it shows.
- Make one `World` per test and register `t.after(() => world.dispose())` straight away.
- Drive PayOnce through `World`. A step a person or the bank takes that `World` or `FakeAirwallex` lacks is added there, never to `src/`.
- Assert on facts, as above.
- Run `pnpm test` and `pnpm typecheck`. Then break the rule the journey guards on a scratch edit to `src/`, check that the journey fails, and undo the edit.

## Why

- The journeys call the engine inside the test process rather than through the HTTP server. Each step finishes before the next starts, nothing runs in between, and the whole suite takes about a second. The replay rig used during the build, which is kept outside the repository, also drove the server, the CLI and the MCP server, and compared whole outputs.
- The journeys assert facts because the guarantees are about what reaches the bank and what the ledger allows, while PayOnce's wording changes often.
- A fake bank needs no credentials and moves no money, and it answers the same way on any machine at any time.
- The guard backs up the explicit settings. The code under test cannot read a credential the process does not have, and a mistake in a journey makes it fail instead of reaching the real sandbox with a real key.
- The script runs `tsx --test` rather than `node --import tsx --test` because the email parser runs in a worker thread that inherits the loader. The tsx CLI passes the loader by absolute path, so the worker still finds it after the guard has moved the process to the temporary folder.
- Only `Date` is mocked, because the currency lease and the parse worker need real timers. No journey waits on either.

## Edge cases

- The journeys do not cover the server, the watcher and the sweep, webhooks, alerts, reconciliation, pay runs, rail outages, payments across currencies, callbacks and the phone on file, or the model reader (the keyword reader reads the emails). The replay rig covered most of these during the build, though not webhooks or the model reader.
- The fake's seeded records carry a `fingerprint` of all their bank details, the account name included. A record `addSupplier` adds carries none, as the sandbox's USD records do ([verification/accounts.md](../verification/accounts.md)). Two records whose fingerprints differ are two routes, whatever their names.
- The ledger's triggers stamp `escalated_at`, `failed_at` and `paid_at` from SQLite's clock, which is real time. No journey reads them.
- `resumeIncident` throws when a look fails, where the server's `Dispatcher` writes the error on the timeline. The tampered-terms journey asserts the error by its name.
- Request ids come from `randomUUID`, so they differ between runs, and no journey compares one with a fixed value.
- On Windows the temporary folder can be left behind if a file in it is still open at exit, which does no harm.

Dated checks: [verification/tests.md](../verification/tests.md).

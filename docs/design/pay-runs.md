# Pay runs

A pay run is a CSV of payments that people check and approve together, and that PayOnce then releases one row at a time. This note covers the file (`src/runs/run-file.ts`), the checks, requests, release and cancel (`src/runs/runs.ts`), `RunStore` in `src/store/runs.ts`, and the run's turn in `src/engine/watcher.ts` and `src/engine/dispatcher.ts`. It leans on [accounts.md](accounts.md), [engine-rules.md](engine-rules.md) and, in [architecture.md](../architecture.md), the sections on the Dispatcher, on how approvals bind terms and on the hash-chained timelines.

## Rules

### The file

- A row names its beneficiary by id, with the supplier, amount and currency. It may also give `method`, `due_date`, `sandbox_outcome` and `supplier_domain` (`RUN_COLUMNS`). Nothing else is read from a file: no bank details and no phone number.
- `parseRunFile` reads the CSV with RFC 4180 quotes, CRLF or LF and a BOM, and skips blank lines. `rowFromCells` reads each row. Every later check reads the stored cells through it again, so the same rules apply at upload and on every check.
- The file is refused, and nothing is stored, for an unknown or repeated column, a missing required column, an unclosed quote, no file name, no rows, more than 50 rows (`MAX_RUN_ROWS`) or more than 40,000 characters (`MAX_RUN_FILE_CHARS`).
- A header column that would name a wallet to pay from (`SOURCE_COLUMNS`: `source_currency`, `paid_from`, `pay_from`, `sell_currency`) refuses the file. Each row pays from its own currency's wallet.
- A problem in the header names the header's line, and an unclosed quote names the line it opened on. A problem with the whole file (no name, empty, no rows, too many rows or characters) has no line.
- The unknown-column problem prints the column's name through `printable`. `cleanFileName` drops folders, C0 and C1 controls, and format, default-ignorable and tag characters, and keeps at most 100 characters.
- An amount is major units with a dot and at most two decimals, read as a string so nothing is rounded (`amountProblem`, `amountMinorOf`). A sign, an exponent, a thousands separator, a currency sign or a third decimal is a row problem with its own words.
- The New payment form reads amounts by the same rule.
- The currency must have two decimals (`twoDecimals`). `supplier_domain` must be a plain ASCII domain, and only A to Z are lowercased. A currency or domain that fails, or a due date `dueDateProblem` refuses, is a row problem.
- A cell with a line break, more than 100 characters, or a control, format, default-ignorable or tag character is a row problem that names the column, such as "The X cell has a line break in it".
- Only the supplier cell may hold U+200C, U+200D and the variation selectors U+FE00 to U+FE0F (`NAME_JOINERS`). Bidi controls (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), the tag block and every other format or default-ignorable character stay refused there.
- Every other cell refuses the joiners and selectors as well.
- A cell that fails the line break, length or character check is never repeated in a reason. It reads as empty for the other checks, which add no second problem for it, so a reason repeats only a cell that passed all three.

### Checking the rows

- `checkRows` uses Airwallex GETs only: each beneficiary once, the transfer PayOnce last paid each one (`readPayees`), and one balance read. A row with any problem is skipped, with every reason found.
- A row is skipped for a cell problem, or for an invoice number in the ledger exactly (`alreadyInLedger`) or by `sameNumberExactly` for the same supplier, whatever the amount.
- A row is skipped for a number on an earlier row (exactly, or by `sameNumberExactly` for the same beneficiary), or for an earlier row that `sameBillAndNumber` matches.
- A row is skipped for a beneficiary Airwallex does not have or that has no bank details, or a supplier cell that is not the record's `account_name` once case, spacing and punctuation are dropped.
- A row is skipped for a currency other than the record's `account_currency`, or a method the record does not take (or no method when it takes both).
- A row is skipped when its bank details do not go where the last paid transfer went (`routeKeyOf` of both) and no `verifiedBankChange` exists for the record. The skip says to check with the supplier, pay outside PayOnce, or restore the old details.
- `lastPaidTransfer` is the latest paid attempt on an `origin = 'payonce'` invoice to the beneficiary that kept an `account_key` and is not `misdirected`, with that key.
- `readPayees` reads that transfer from Airwallex and compares the account it went to with the record. The same read gives the skip message. `payeeRule` and the first-payment hold compare the record with the kept account (`holdsAccount`) and read no transfer.
- A row to a beneficiary PayOnce has never paid on a person's approval (`paidOnApproval`) is a new payee, whatever PayOnce paid by itself. So is a row with no last paid transfer. The account check still compares with the last payment, automatic or not.
- A pay row keeps the callback `verifiedBankChange` finds for the record's account in `run_rows.verified_by`, whether or not PayOnce paid that account since. When the account is not the one PayOnce last paid, that callback is the row's `bankChange` too. A pay row keeps the record's `routeKey` in `run_rows.route_key`.
- A pay row to an account where a transfer failed with an account-level code (`ACCOUNT_FAILURE_CODES`: 90101, 90701, 90802), and no payment opened after it was paid there, keeps that transfer's reference and code (`Ledger.accountFailure`, `run_rows.account_failure`). The row still pays. It gets a caution and needs two approvers.
- `accountFailure` compares accounts by route key or full key, on any supplier record, since the account is where the money goes. A failure counts for the account it was meant for and the one it went to. A later payment lifts it only when the bank paid it to the account it was meant for (not `misdirected`).
- A row that `likelyDuplicates` matches against the ledger is a pay row with `heldFor` listing the matches. It counts in the totals, is released with the run, and `startPayment` holds it when it comes to send it.
- The cash check runs per currency over the pay rows: one `getBalances` read, less the money committed elsewhere, less the rows and their fees (`latestFee` by method; 0, marked not known, when none is recorded).
- Committed money is counted before and after the balance read and taken at the larger per invoice (`committedByInvoice`, `committedAcross`), leaving out the run's own rows.
- When the cash check leaves less than the floor, every row in the currency is skipped, with the shortfall in the reason. A skipped row goes through `skipRow`, which clears `heldFor`, `newPayee`, `bankChangeId`, `verifiedBy`, `accountFailure` and `arrival`.
- A currency with no floor set does not block, and the terms carry `reserveFloorMinor: null`. An unreadable `RESERVE_FLOORS`, or no balance in the currency, skips that currency's rows.

### One waiting run

- Only one run waits at a time (`one_waiting_run`). A file whose run is not cancelled cannot be uploaded again (`one_live_run_per_file`, on the file hash).
- `uploadRun` checks both before Airwallex is read, and `createRun` checks them again inside its transaction, which also skips a row whose number reached the ledger meanwhile.
- A new payment (`openPayment`, behind `POST /api/payments` and `pnpm recover`) and a scripted incident (`POST /api/sandbox/scenarios`) refuse an invoice number on the waiting run's pay rows.
- The file hash is SHA-256 of the header and every row's trimmed cells, so a copy with other line endings or a trailing newline hashes the same.

### Terms and approvals

- `runTermsFor` builds `RunTerms`: the run, the file hash, the uploader, every pay row in file order, and a total per currency with its floor.
- Each row in the terms has its line, invoice, amount, currency, beneficiary, method, `payTo`, `accountKey`, `heldFor` and `bankChange`, plus `supplierDomain` on a row that gives one and `arrival` on a row with a due date.
- A row whose account a callback verified, when `bankChange` is null because PayOnce paid that account since, also has `verifiedBy`. A row to a failed account has `accountFailure` (its reference and code). Both go in by conditional spread, so a row without them binds as before.
- Skipped rows, new-payee flags, sandbox outcomes, fees and how many approvers are needed are not in the terms.
- Every pay row gets `arrival`, stored in `run_rows.arrival` and shown with the row. A check counts it from the day of the run's latest request while that request is requested or approved and has not expired. Otherwise it counts from today.
- When `settleRunRequest` opens a new request on rows that count from another day, it counts them from today first and rewrites `run_rows.arrival` with `setRunArrivals`. It then compares the recounted binding again.
- `runRule` asks for two approvers when a row pays a new payee ("which PayOnce has never paid on a person's approval"), a row pays a callback-verified account PayOnce did not last pay (`bankChange`), a row pays a failed account, or a row's `supplier_domain` has a caution.
- For a failed account the reason is "row 2 goes to the account that transfer P261102-0000002 failed on (account closed)" (needed why code `run-account-failed`).
- The run's page, `pnpm payrun show` and `pnpm payrun approve` give the caution "Row 2 goes to the account that transfer P261102-0000002 failed on (account closed). Check the account with the supplier first." (`accountFailureCaution`, caution code `same-account-failed`). It is worded like the caution on a replacement to the account its original failed on.
- The check writes the caution on the run's timeline under the row's topic, so a later check that finds no failure writes "now pays".
- `runRule` also asks for two when any currency's total is above `TWO_APPROVERS_ABOVE`, or when the uploader's stored name does not follow the name rule (`knownName`).
- `domainChecks` gives a caution when the domain differs from the latest invoice to the beneficiary that has one, when the run gives the same beneficiary another domain, or when it is the first domain for a beneficiary PayOnce has paid once.
- A first domain for a beneficiary PayOnce has never paid gets a note only. The run's request and `pnpm payrun show` and `approve` show each row's domain with its caution or note (`domainText`).
- Limits are checked against the largest currency total (`runAmount`, which `largestTotal` shows).
- `runBarred` bars the uploader and, for each row, everyone `callbackBars` bars for the account the row pays. That is every recorder of a callback that verified the account, on any invoice of the record, whether or not PayOnce paid it since, and whoever proposed or confirmed the phone a callback was made on (see [supplier-contacts.md](supplier-contacts.md)).
- `barredFrom` asks `callbackBars` for an invoice, so a run row and an invoice to one account bar the same people. With no route key on file for a row's `accountKey`, every callback for the record bars.
- A row's `callbackVerified` is true when it has `verified_by`, or, on a row from before the column, `bank_change_id`. The request's callback rows are those with `bankChange` or `verifiedBy`.
- Approving (`approveRun`) follows `approvePayment`: the request the approver was shown, `checkSigner`, `signOffRun`, the binding.
- A run's requests are `run_approvals` rows kept by the same `RequestBook` as an invoice's, with the `RUN_REQUESTS` shape (`src/store/approvals.ts`). One opens only on a waiting run, and a new one voids the open one.
- A run request expires after `APPROVAL_TTL_MINUTES` and is not renewed by itself.
- `recheckRun` ("Re-check run", `pnpm payrun check`) runs every check. Then one transaction (`setRunRows` running `settleRunRequest`) rewrites the rows and keeps any requested or approved request with the same binding that has not expired.
- Otherwise `recheckRun` opens a new request and says when signoffs no longer count. With nothing left to pay, or too few eligible approvers, it opens none and says why.
- `recheckRun` is refused while the run's latest request is approved and has not expired.
- A confirmed change of the supplier's phone on file voids the waiting run's requested or approved request when a pay row of it to that record relies on a callback (`bank_change_id`), with a line on the run naming the rows. See [supplier-contacts.md](supplier-contacts.md).

### Release

- `releaseRun` runs in the run's turn: the Dispatcher key `run:N` (`runKey`). It checks every row again.
- If the approval expired, the binding differs or `signoffProblem` finds a problem, one transaction voids the approval and rewrites the rows. The run then waits for a person to check it again, and no request opens by itself.
- Otherwise `releaseRun` takes the lease of every currency the run pays, in code order (`withCurrencyLocks`), and runs the cash check again on a fresh balance. A shortfall voids the approval, and the run waits for a person.
- When the cash fits, `RunStore.releaseRun`, in one transaction that first checks every lease, spends the approval, marks the run released and writes each pay row as an `open` invoice.
- Each released invoice has the record's account name as supplier, the uploader as `started_by`, its `run_row_id`, `look_at` now, the approved `supplierDomain` or none, and no phone.
- Each released invoice gets a first chained line naming the run, row, file hash, approvers, request and binding. The release sets each released row's `account_key` and `pay_to` from the approved terms.
- A plain INSERT that fails on a taken number rolls back to a savepoint and drops that row.
- Timeline lines on the run come after the commit, except the release line, which is written in the transaction.
- After the commit the release wakes each released invoice in file order with the run's turn (`wake(invoiceId, { runTurn: true })`) and waits for it before the next.
- The approve route and the watcher start a release (`startRelease` in `src/surfaces/http/main.ts`) without awaiting it. `pnpm payrun approve` only signs, and the server's watcher releases the run on its next check.

### Sending a released row

- A released row's first look with the run's turn calls `startFirst`, which sends the original through `startPayment` with the row's `accountKey`.
- Under the lease, `startPayment` reads the balance, ties unseen payouts and reads the record last. Then, in one transaction, it checks the invoice is still open with no attempt, runs the first-payment holds (`firstPaymentHold`) and opens the attempt.
- A row is held when its beneficiary is missing (`BENEFICIARY_MISSING_REASON`) or the record holds other details (`RUN_ACCOUNT_CHANGED_REASON`).
- A row is also held for a likely second bill, the same number for the supplier, a live outside payout, emails before payment, or the floor (`CASH_HOLD_REASON`). The floor check counts the committed money without this invoice, so the run's other unsent rows count.
- Only the release, or the server's watcher once the run's key is not busy, sends a run row, because only they wake it with the run's turn (`LookOptions.runTurn`). The watcher wakes the first due unsent row of each run on each check.
- Any other look at an unsent row (the check and bank-change routes, a webhook, the sweep, `pnpm recover`'s watcher) notes that it waits for its turn and makes its next look due, so the server's watcher gives it one.
- `pnpm recover` refuses a run invoice that has not sent.
- A retry of a pending original on a run invoice checks the key the attempt keeps. On an attempt that kept none, it checks a used `pay` approval's account, else the row's `accountKey`.
- `continueHeld` on a run invoice: a missing beneficiary, or a record that no longer holds the row's account and has no verified callback, withdraws any request and waits for a person to close it.
- On any other held invoice, a record that no longer holds the account `lastPaidTransfer` kept writes a `last-paid` warning. With no verified callback it also withdraws any request and waits for a callback to the number on file, or with none, for a person to close it or restore the details.
- With a callback, the request's `HeldPaymentTerms.evidence.bankChange` carries it, added only then so other held invoices keep their binding, and its recorder is barred.
- On every held invoice `payeeRule` asks for two approvers when PayOnce has never paid the beneficiary, paid it only before it kept which account each payment went to, last paid it another account, or never paid it on a person's approval.
- A change of the supplier's phone on file is refused while a released row to that record that relies on a callback has not opened its payment (`RUN_ROW_WAITS`).

### Cancel, timeline and the sandbox outcome

- `cancelRun` works only on a waiting run. It voids the open request and drops the pay rows, so their numbers are free again. Anyone with a name and a note may cancel.
- A run's timeline is `run_events`, hash-chained per run by `RUN_CHAIN` (`src/store/chain.ts`) and written through `runNote`.
- The sandbox bank reads a run row's `sandbox_outcome` from the ledger through `runRowOf`. The engine never reads it, and it is not in the terms.

## Why

- A changed account's skip message points outside PayOnce because no callback can be recorded outside an incident.
- `lastPaidTransfer` takes only payments that kept their account and were not misdirected, so a payment that went out unchecked never becomes the account PayOnce last paid.
- A short currency skips all of its rows, so file order never decides who is paid.
- `skipRow` clears `heldFor`, `newPayee`, `bankChangeId`, `verifiedBy`, `accountFailure` and `arrival` because those only matter on a row that pays.
- A run row bars a callback's recorder for good, as an invoice does. Otherwise, once a payment to the new account made it the account PayOnce last paid, the recorder could approve a later run row to it, alone when the run needs one approver.
- A row to a failed account gets a caution, not a skip, because the supplier may have opened the account again or the bank may have made a mistake. Two people read the warning before it pays.
- A failure on another record with the same bank details counts, because a closed account is closed whichever record names it.
- A failed cell reads as empty and is never quoted, so nothing in it reaches a reason, the timeline or a terminal.
- The supplier cell takes the joiners and selectors because Persian names and emoji sequences need them.
- The sender check trusts a row's domain. A domain that disagrees with another for the same beneficiary, or a new one for a beneficiary already paid, is where a fraudster's domain would slip in, so it needs two approvers.
- Limits are bare numbers, so they are checked against the largest currency total.
- Counting `arrival` from the open request's day lets a check after midnight keep the request and its signoffs. Recounting before a new request means a new request always counts from the day it opens.
- A recheck is refused while the run is approved because the release pays those rows.
- The release writes rows from the approved terms, so a check that rewrote the rows meanwhile cannot change the account a row pays.
- Released rows send one at a time, so a run never sends a burst.
- A phone change voids a run's request when a row relies on a callback, because that callback was made on a number that is no longer on file.
- A released row has spent its run's approval, so a phone change has no request left to withdraw. The change waits until the row has gone to the bank.
- Cancelling moves no money, so anyone with a name and a note may cancel.
- The sandbox outcome is read from the ledger, so it survives a restart and works in any process.

## Edge cases

- A ledger written before attempts kept their account: with no checked payment to the beneficiary, `readPayees` takes the one `lastPaidUnchecked` finds, as before the column.
- A file with no due dates and no domains binds as it did before either column.
- Another process opened today's request on the same rows after a check read the old day: `settleRunRequest` compares the recounted binding and keeps that request, with its signoffs.
- A release after midnight: `releaseRun` checks again counting from the day in the approved terms, so it still matches. A refused release stores rows counted from today.
- A refused release after another process has released the run or opened a newer request: the void-and-rewrite transaction changes nothing.
- A check rewrote the rows while the release ran: a release row keeps its `route_key` only when its last check read the account the run approved.
- A row's number was taken between the check and the release: the INSERT fails, the savepoint rolls back, the row is `dropped` with a note, and the run's timeline says so.
- A run approved while no server runs waits, and is void once its use window has passed.
- An outage on any approved row's rail holds the whole run with its approval. See [rail-outages.md](rail-outages.md).
- A released row keeps its due date on the obligation.
- `pnpm approve` and `pnpm close` on a pay row of the waiting run name its row and run and point to `pnpm payrun show N` (`notAnInvoiceText`).
- `pnpm recover` with an invoice number on the waiting run: `openPayment` refuses it with one line and stores nothing.
- A row whose callback was made on a phone number that has changed since: `verifiedBankChange` no longer counts the callback, so the row has no `verifiedBy` and is not shown as verified, but the callback's recorder and the number's setters stay barred.
- A confirmed phone change voids a waiting run's request only for rows with `bank_change_id`. A row with only `verified_by` loses it at the next check, which changes the terms, so the release voids any approval given on them.
- A failure found on the account between approval and release, or a payment paid there meanwhile, changes the terms, so the release voids the approval and the run waits for a person to check it again.
- The sandbox's demo suppliers share bank details, so one closed-account scenario cautions later rows to every record with that account.

Dated checks: [verification/pay-runs.md](../verification/pay-runs.md).

# Engine rules

How the agent works an invoice, look by look: sending and retrying payments, holding a first payment, replacing a failed one against the reserve floor, approval requests, exchange rates, payouts sent outside PayOnce, late and unrecognised transfers, callbacks and closing. The code is `src/engine/`, the policy's half of `src/domain/`, and the ledger reads it acts on in `store/read/` and `store/stored.ts`. [architecture.md](../architecture.md) draws the look, the payment gate, the leases and the Dispatcher, watcher and sweep, and [invariants.md](../invariants.md) numbers the guarantees whose details are here.

## Where the code is

| File | Holds |
|---|---|
| `engine/engine.ts` | shared types: `Engine`, `Bank`, `NextLook`, `LookOptions`, `StepResult`, `RETRY_FAILED_LOOK_MS`, `Rate`, `Decided`, `Assessment` |
| `engine/look.ts` | `resumeIncident`, `look()`, `SENT_STEPS` and its steps, `act`, `waitOnOutage` |
| `engine/first-payment.ts` | `startPayment`, `FIRST_PAYMENT_HOLDS`, `firstPaymentHold`, `firstPaymentFacts`, `firstPaymentOutage`, `payeeRule`, `heldPaymentRule`, `heldIfRefused`, `holdRefused`, `startFirst` |
| `engine/new-payment.ts` | `openPayment`, `paymentProblems`, `checkedPayee`, `recordPayee`, `newObligation`, `asOpened`, `PaymentRefusedError` |
| `engine/held.ts` | `continueHeld` and its sub-steps, `heldRule`, `duplicateEvidence`, `duplicatesOnFile`, `releaseHeld`, `closeAgain` |
| `engine/escalated.ts` | `escalate` (`EscalateAs`), `continueEscalated`, `noteFloor`, `noteSecondBill` |
| `engine/requests.ts` | `ruleFor`, `approvalProblem`, `voidIfStale`, `awaitApproval` and its sub-steps |
| `engine/replacement.ts` | `replaceUnderLock`, `escalateForOutage` |
| `engine/retry.ts` | `holdPending`, `NeverSentCause`, `failNeverSent`, `neverSentAt`, `Retried`, `retryUnderLock`, `retry` |
| `engine/outside.ts` | `linkOutsidePayout`, `linkUnseenPayouts`, `syncOutsidePayouts`, `judgePayouts`, `payingRoute`, `holdForOutsidePayout` |
| `engine/late-mismatched.ts` | `recordLateTransfer`, `noteMismatchedTransfer`, `syncMismatched`, `unrecordedAttemptOf`, `holdMismatched`, `holdPaidTwice` |
| `engine/emails.ts` | `deliver`, `noteSenders`, `readNewEmails`, `emailsNotRead`, `noteEvidenceUpgrade` |
| `engine/rates.ts`, `engine/terms.ts` | `rateFor`, `requestExpiry`, `quoteLine`; `termsOf` and the arrival estimate in terms (`arrivalOf`, `arrivalClause`, `countedFromToday`) |
| `engine/assessment.ts` | `assess` |
| `engine/send.ts` | `requireAccount`, `AccountChangedError`, `transferChecks`, `send`, `waitForBank`, `deadlineLook`, `replacementOverdue` |
| `engine/payments.ts` | `sendAttempt`, `syncTransfer`, `wasRejected`, `recordMissingFees` |
| `engine/close.ts` | the agent's own close: `close`, `closeRefused`, `closeWaitingLine` |
| `engine/person.ts` | `payAgain`, `closeIncident`, `approvePayment` |
| `store/read/reviews.ts` | what a person reads before a close or an approval: `pendingClose` (`CloseReview`, `NamingPayout`), `pendingApproval`, `barredOnFile` |
| `store/read/facts.ts` | ledger predicates: `anyLive`, `paidDuplicate`, `paidTwice`, `heldBeforePaying`, `coveredByClose` (`CoveredTransfer`) |
| `engine/lines.ts` | `note`, `noteError`, `lineWanted`, `describe`, `payoutSummary` |
| `engine/reason-text.ts` | the clause builders: `decided`, `secondBill`, `namingNotToPay`, `withFloorReason`, `asRequested`, `PAID_ONLY_BY_ITSELF` |
| `store/stored.ts` | the shapes of stored terms, run terms, a kept quote, findings and an uploaded email's lists (`isApprovalTerms`, `isRunTerms`, `isLastQuote`, `isStoredFindings`, `isTextList`, `isAttachmentList`), `StoredFindings` and `storedFindings`, `requestTerms` and `runRequestTerms`, and what a failed read names (`termsOnFile`, `runTermsOnFile`, `quoteOnFile`, `findingsOnFile`, `emailsOnFile`) |
| `engine/bank-change.ts` | `bankChangeForm`, `recordBankChange`, `blockedReason` |
| `store/read/cash.ts` | the cash lines, `committedMinor`, `committedByInvoice`, `committedAcross`, `payRunLines`, `cashReport` |
| `engine/currency-lock.ts` | `withCurrencyLock`, `withCurrencyLocks`, `CurrencyBusyError` |
| `engine/dispatcher.ts`, `watcher.ts`, `sweep.ts`, `create.ts` | `Dispatcher`, `Watcher`, `sweep`, `createEngine` |
| `domain/decide.ts`, `domain/incident.ts` | `decide`, `floorReason` and the policy's reason constants; `Incident` and `Decision`, amounts in minor units |
| `domain/live.ts` | every test of live ([reasons.md](reasons.md#what-live-means)), `keptFailedLive` among them, and the engine's own close: `paidByReplacement`, `closeRefusedBy`, `closesItself` |
| `domain/approval.ts`, `approvers.ts`, `barred.ts` | terms and bindings; the approval policy; who is barred |
| `domain/duplicates.ts` | invoice numbers, second bills and the payout-to-invoice match |
| `domain/reserve.ts`, `deadlines.ts`, `fx.ts` | reserve floors and `debitCurrency`; bank deadlines; quote validity |
| `domain/callback.ts`, `store/read/callback.ts` | `callbackBlocked` and the facts it reads (`callbackFacts`) |
| `store/closes.ts`, `store/approvals.ts` | `CloseStore` (`settle`, `reject`, `rejectAgain`); `ApprovalStore` (`useApproval`, `releaseFor`) and `RequestBook` |

## Rules

### Looks and steps

- A look is `resumeIncident`: it runs `look()` once and saves the next look with `Ledger.lookAt`. [architecture.md](../architecture.md#one-look) draws the order of its reads and of `SENT_STEPS`.
- Every `await` of a look is in `look()`, and every await of a held invoice's look is in `continueHeld`, in a fixed order. Steps and sub-steps await nothing. One that starts async work returns its promise as it is (`StepResult`).
- PayOnce learns what the bank did only by reading Airwallex: a webhook or the watcher wakes a look, and the look reads the transfer ([invariant 55](../invariants.md#where-decisions-come-from)).
- `Engine.bank` is told about each payment sent, with its short reference (`Bank.sent`). In the sandbox it plays the bank. The engine never simulates a bank outcome.
- In `pnpm ui` and `pnpm recover` every step on an invoice runs through the `Dispatcher`, a person's approve and close on the page included. `pnpm approve`, `pnpm close`, `pnpm outbox` and `pnpm outage end` call the engine directly and rely on the ledger's transactions.
- `Dispatcher.wake` queues a look and drops a wake that comes while one is queued and not started. `wake(invoiceId, { runTurn: true })` gives the look the run's turn (`LookOptions.runTurn`), and hands the turn to a look already queued.
- `decide` (`domain/decide.ts`) is the policy: a pure function from an `Incident` to wait, replace, escalate or close. `assess` builds the `Incident` and writes the decision line.
- `Assessment.decision` is a `Decided`, `{ action, reason: Reason }`. `policyReason` and `floorClause` turn the policy's text into codes as it leaves `decide.ts`, and throw on a text with no code, so the look fails closed ([reasons.md](reasons.md)).
- Every reason `decide` gives is an exported constant, apart from the cross-currency one that names the wallet. `termsOf` passes `reasonText(reason)` to `termsFor`, so terms carry the text and no code reaches a binding.
- The engine reads its own reasons by code: `sayMismatchedFailed`, the reason `escalate` keeps (`Ledger.reasonOf`), and a held invoice's reason (`namingNotToPayHeld`).
- A look that throws leaves its next look as it was while that time is ahead, and otherwise moves it a minute on (`postponeDueLook`, `RETRY_FAILED_LOOK_MS`).
- `noteError` never throws. It writes an `AirwallexError` or `AirwallexUnreachableError` as an `error` line and one console line, a `LineError` as a line of its own kind with its `detail` on the console, and any other error as an `error` line with its stack trace on the console.
- Waiting on the bank has a deadline: the transfer's `created_at` plus `BANK_DEADLINE_LOCAL_MINUTES` (default 3) or `BANK_DEADLINE_SWIFT_MINUTES` (default 5), from `Settings.bankDeadlineMinutes`, which `createEngine` puts on the engine as `Engine.bankDeadlineMinutes` and every deadline check hands to `deadlineMinutes`. The look saves it in `obligations.look_at`.
- A transfer method PayOnce does not know gets its longest deadline, and `isOverdue` counts a deadline it cannot read as passed.
- `startPayment` saves the deadline look (`deadlineLook`) as soon as the original is with the bank. When the send's outcome is unknown, it moves the next look a minute on, as a failed look does.
- An original still in flight at its deadline escalates (`ORIGINAL_DEADLINE_REASON`). A replacement still in flight escalates with `REPLACEMENT_DEADLINE_REASON`, nothing more is sent (`replacementOverdue`), and the incident still closes by itself if the bank pays it.
- After a replacement is sent, the look waits for the bank (`followReplacement`) and closes the incident on the look that reads it paid (`closeIfPaid`). A replacement already out is never approved a second time.
- A look writes a `bank` line when a payment the ledger had in flight is now paid or failed (`notePayment`).
- A settled or rejected invoice is left alone: the look syncs its payments and outside payouts and reads new emails, then decides and sends nothing (`leaveClosed`), and `retry` refuses one under the lease. A rejected invoice that never sent a payment is left before any payout sync or email read.
- A reader failure marks the thread unread, which escalates. The `email` line says in PayOnce's words that the reader could not read a supplier email, what each model did (`triesText`), and when PayOnce reads it again. Nothing the service wrote reaches it.
- The next look reads from the email that failed, and keeps the count of those read before it (`emailsRead`).
- `toMinor` throws on an amount that is not finite, and the policy escalates when the cash position is not a number. `readMinor` gives null instead, for amounts only recorded or shown.

### Sending and retries

- An attempt opens only through `Ledger.openAttempt`, before the Airwallex call ([architecture.md](../architecture.md#the-payment-gate)). `sendAttempt` is the only caller of `createTransfer` and always sends the attempt's `request_id`.
- `sendAttempt` writes `tried_at` just before every create call, and refuses a cross-currency attempt with no `quoteId` before calling Airwallex.
- A 4xx other than 429 on a first send fails the attempt (`wasRejected`). Any other error, a 429 included, leaves it pending, and a later look retries it under the same `request_id`. `duplicate_request_id` records the transfer it names. This holds for every payment.
- `transferChecks` (`rateProblem` and `accountMismatch`) runs as the `Decide` of `sendAttempt` or `syncTransfer`, inside the transaction that records the transfer. `noteChecks` writes its warning lines after it.
- The checks run wherever an attempt first gains a transfer: in `send`, after a retry, when a look finds it by `request_id`, and in `recordLateTransfer`.
- A transfer that went to other details than the attempt's `account_key`, or shows no bank details, is marked `misdirected` and escalates (`accountMismatchOf`).
- A pending attempt with no transfer is first looked up by `request_id`. With none listed, the look ties unseen payouts (`linkUnseenPayouts`), reads every tied payout (`syncOutsidePayouts`), and asks `holdPending` whether to send it again.
- `holdPending` holds the attempt for, in order: a late transfer the bank has live (`paidTwice`), a tied payout that pays the invoice, a paid one that only names it, any live outside payout, a paid unrecognised transfer, a live one. Otherwise `retryUnderLock` sends it.
- Under the lease, `retry` checks the account, then reads the invoice, its payouts and the attempt again. It sends nothing, and the next look comes at once (`changed`), if the invoice is closed, a payout is live, another payment is live at the bank, or the attempt is no longer pending with no transfer.
- `retry` sends only to the account the attempt keeps: `requireAccount` on `attempts.account_key` throws `AccountChangedError` when the record differs in any field. The look hands that to `failNeverSent` as cause `account-changed` (`ACCOUNT_CHANGED_REASON`).
- A pending attempt is marked failed without a refusal only by `failNeverSent` ([invariant 7](../invariants.md#opening-and-sending-a-payment)).
- `failNeverSent` holds the attempt for its `NeverSentCause` (`paid-outside`, `names-only`, `late`, `mismatched`, `account-changed`, `account-unknown`) until `neverSentAt`, the method's bank deadline after `tried_at`, or after `opened_at` with no try. It plans the look for then, with a standing `retry` warning.
- On each such look it escalates the invoice with the cause's reason through `Ledger.escalateIfChanged`, which writes the row only when the invoice is not already escalated with that reason in every column.
- Past the deadline, `failNeverSent` takes the lease of the wallet the attempt pays from, reads the attempt again and lists its request id. If Airwallex lists nothing, `failAttempt` marks it failed with a `payment` line on the `retry` topic, which frees the duplicate lock and drops its `sending` cash line.
- `failAttempt` changes only an attempt still `pending` with no `transfer_id`. A transfer listed by then is not failed, and the next look, due at once, records it.
- After the fail, a paid outside payout or a paid unrecognised transfer leaves the invoice for the close option, a late transfer is recorded by the next look in its own state, and for `account-changed` or `account-unknown` paying takes a person's approval.
- Every payment PayOnce creates holds the lease of the wallet it leaves (`withCurrencyLock` on `debitCurrency`) from its last Airwallex read until its transfer is recorded ([architecture.md](../architecture.md#leases-and-the-fair-queue)). `continueEscalated` and `releaseHeld` take it before they spend the approval.
- `openAttempt` refuses a lease in any other currency than the invoice's source wallet.
- A payment that waits 45 seconds behind the payments ahead of it fails with `CurrencyBusyError`, having sent and spent nothing. The next look comes a minute later: `resumeIncident` plans it, or `startPayment` does when the scripted run called it.
- Pay again never reaches Airwallex. `payAgain` calls `Ledger.tryLock`, which inserts a replacement attempt in a transaction it always rolls back. When the lock does not refuse, the timeline says why nothing was sent.
- Fees are stored on attempts and outside payouts from the transfer's `fee_amount` and `fee_currency`, and are 0 when `fee_paid_by` is `BENEFICIARY` (`feeOf`). Decisions read the fee from the transfer just fetched, never from the ledger.
- `recordMissingFees` reads the fee of up to five failed transfers the ledger has none for, never tried or tried longest ago first. One whose fee it could not record is read again only after 10 minutes.
- `debitOf` is what a transfer took from the wallet before the fee. `record`, the sweep, `payoutMoney`, `rateMismatchOf` and `conversionText` all read the debit through it.

### First payments and holds

- Every first payment goes through `startPayment` under the lease of the wallet it leaves. It reads Airwallex first and the beneficiary record last, then runs every hold and opens the attempt in one transaction.
- The holds are the list `FIRST_PAYMENT_HOLDS`, asked through `firstPaymentHold` inside that transaction. The first that applies holds the invoice, and a new hold is one more entry in the list.
- Their order: the account (`heldForAccount`), other invoices (`heldForOthers`), where PayOnce last paid the supplier (`heldForLastPaid`), emails on file (`heldForEmails`), the exchange rate (`heldForExchangeRate`), a pay run row's floor (`heldForFloor`), and a payment a person started (`heldForApproval`).
- `heldForAccount` holds a payment whose record Airwallex no longer has or that has no bank details (`BENEFICIARY_MISSING_REASON`), and a pay run row whose record no longer holds the account the run approved (`RUN_ACCOUNT_CHANGED_REASON`).
- `heldForOthers` holds when `likelyDuplicates` finds another invoice, not `rejected`, to the same supplier (same beneficiary, same name, or another record that pays the same account) for the same amount and currency, with a number `sameInvoiceNumber` matches.
- It also holds when `sameNumberForSupplier` finds such an invoice for any amount or currency, because PayOnce pays an invoice number once, and when an outside payout for the invoice is live.
- Another record pays the same account when the ledger has seen it pay the route key the payment would go to (`FirstPaymentFacts.route`, `recordsSharing` in `domain/duplicates.ts`, `Ledger.recordsOnRoute`). A pay run's check asks `recordsSharing` too ([pay-runs.md](pay-runs.md)). That means an attempt's account or where its transfer went, an outside payout, a pay run row, an approval request, or the details a callback kept, as the supplier view links records that share an account. The hold uses the existing reasons (`held-as-second-bill`, `held-same-number`).
- A pay run row counts whatever its run's state (waiting, released or cancelled), and whether it pays or was skipped, just as an approval request counts in any state. Its `route_key` is the record's route as the run's check read it from Airwallex, so it shows the record pays that account whether or not the run went ahead. Counting more records only holds more payments for a person. It never sends one.
- Only the first payment's holds count such a record. A held invoice's later looks (`withNewDuplicates`, `duplicatesOnFile`), a replacement's paid second bill (`paidDuplicate`) and a pay run's checks still match by beneficiary and name.
- `heldForLastPaid` holds with `LAST_PAID_CHANGED_REASON` when `lastPaidTransfer` finds a payment to the beneficiary whose account the record no longer holds by where the money goes (`holdsAccount`), whether or not a callback verified the record.
- With no checked payment to the beneficiary but one `lastPaidUnchecked` finds, it holds with `UNCONFIRMED_ACCOUNT_REASON`: no callback is needed, and paying takes two approvers. A beneficiary PayOnce has never paid is not held for this.
- Once a checked payment to the account on file is paid, later invoices to it go out as usual.
- `heldForEmails` holds with `EMAILS_BEFORE_PAYMENT_REASON` while any supplier email is on file, a pay run row waiting its turn included.
- `heldForExchangeRate` holds every cross-currency first payment (`heldForRate`): "it is paid from USD, so a person approves the exchange rate before PayOnce pays it".
- `heldForApproval` holds every first payment a person started when no other hold applies, with `PERSON_STARTED_REASON` (code `person-started`): "a person started this payment, so someone else approves it before PayOnce pays it". A person started it when `obligations.started_by` is set and it is not a pay run row. That covers the New payment form, the simulator's scripted incidents and `pnpm recover`. A pay run row was approved with its run, and a payout found outside PayOnce has no starter.
- That hold goes through the held-invoice path like any other: `heldTermsFor`, `continueHeld`, the signer checks and `releaseFor`. The starter is barred, `payeeRule` asks two approvers for a payee PayOnce never paid on a person's approval, `signoffsNeeded` asks two above `TWO_APPROVERS_ABOVE`, and limits apply. The floor and the outage gate stay where they are.
- A held invoice is `escalated` with no attempt and `obligations.duplicate_of` listing the matches (`holdBeforePaying`). The invoices it matched get a line on their timelines. Nothing is sent.
- The outage gate comes before the lease (`firstPaymentOutage`), so a first payment on a rail with an active outage waits unsent with no attempt ([rail-outages.md](rail-outages.md)).
- `startPayment` ties unseen payouts for every first payment. For any but a pay run row's, it then reads the record and keeps its account on the attempt (`account_key`, `route_key`). A pay run row keeps the account the run approved, checked against the record (`accountProblem`).
- `startPayment` holds the invoice when an outside payout it ties is live, and sends anyway when that payout has already failed.
- A pay run row is sent only on a look with the run's turn (`startFirst`). Any other look leaves it with a standing waiting line, due at once. `startPayment` refuses a pay run row whose invoice would convert.
- Airwallex refusing every original (a 4xx on create) escalates the invoice through `holdRefused` (`refusedOriginal`). It happens at once on a send `startPayment` makes or one `releaseHeld` makes on an approval (`heldIfRefused`), and otherwise on the next look. It is then held like any other.
- `heldBeforePaying` is an escalated invoice that has sent nothing: every attempt, if any, failed without a transfer.
- The New payment preview asks `firstPaymentOutage` and `firstPaymentHold` on facts read with no lease (`firstPaymentFacts`), so it cannot drift from `startPayment`. It skips `linkUnseenPayouts`, which writes.
- `openPayment` refuses before any Airwallex read, with a `PaymentRefusedError` and nothing stored: a number outside `INVOICE_ID_PATTERN`, or one in the ledger or on a waiting pay run, an amount not in positive minor units, a currency or wallet that is not a two-decimal code, the method, the due date, or the starter's name.
- `openPayment` checks the number again after reading the payee, then writes the invoice with nothing awaited between. `pnpm recover` and the page's scenarios go through it (`openScenario`).
- A person's payment reads its record with `recordPayee`, a GET. It refuses a record that is missing or has no bank details, one whose account currency differs from the payment's, and one whose `transfer_methods` exclude the method.
- Its supplier is the record's account name, else the company name, else the nickname, else `UNNAMED_PAYEE`. Its invoice floor is 0 (`checkedPayee`). Its phone is the record's phone on file ([supplier-contacts.md](supplier-contacts.md)).
- Its `supplier_domain` is the record's email domain on file: the domain of the newest invoice to the record that has one (`domainOnFile`, which `recordPayee` adds), as a pay run's domain check reads it. With none on file it is `''`, and every sender is flagged ([uploaded-emails.md](uploaded-emails.md)).
- `sameInvoiceNumber` ignores case, spaces, dashes and other marks, and leading zeros. It matches a number to the same number with up to four letters added after the last digit, but not two numbers with different letters (`INV-42A` and `INV-42B`, `RENT-2026-OCT` and `RENT-2026-NOV`).
- `sameNumberExactly` adds no letters. `likelyDuplicates` and `sameNumberForSupplier` compare every number an invoice is known by (`numbersOf`: its number and a found payout's reference), list the oldest match first, and leave out `rejected` invoices. Given the records that share the account (`sharing`), they count those as the same supplier too. Without it they match by beneficiary and name only.
- `sameBillAndNumber` is `likelyDuplicates`'s test for two bills not in the ledger, such as two rows of a pay run file. Supplier names are compared by `sameSupplier` ([names.md](names.md)).

### Held invoices

- A held invoice pays only on an approval of `HeldPaymentTerms` (`heldTermsFor`), under the same policy as a replacement, through `continueHeld`.
- Each look adds to `duplicate_of` any invoice `likelyDuplicates` finds now (`withNewDuplicates`), with a warning, so one started later, or one that came first while this one was held for another reason, is listed too.
- The terms list each matched invoice with its state, the payment that paid it, and whether that payment, or else one still with the bank, went to the same account (`duplicateEvidence`, `sameAccount`). A change in any of them voids the approval.
- A match paid to another account than the one on file (`sameAccount` false) needs two approvers, and the timeline warns. A match paid to the same account does not by itself need a second approver.
- `payeeRule` asks two approvers when PayOnce has never paid the beneficiary, paid it only before it kept which account each payment went to, last paid it another account, or never paid it on a person's approval (`Ledger.paidOnApproval`, `PAID_ONLY_BY_ITSELF`), as a pay run row does. `heldRule` asks it through `heldPaymentRule`, which falls back to `signoffsNeeded`. Both are in `first-payment.ts`, so the New payment preview asks the same rule.
- Paid on a person's approval is a paid payment opened on an approval that was used (`approval_id`), or the original of a released pay run row. A single incident's original and an automatic replacement count as the account last paid, but not here.
- A held invoice's reason names the supplier's ask not to pay (`namingNotToPayHeld`, written with `rewordEscalation`). If another process changed the reason since the look read it, the look comes again at once.
- Until every email on file is read, nothing is offered and any open request is withdrawn. The look comes again a minute later after a reader failure, and at once when an email arrived while the others were read.
- A held invoice whose beneficiary is gone from Airwallex waits for a person to close it. One from a pay run whose record no longer holds the approved account waits too, unless a verified callback matches the record.
- When the record no longer holds the account PayOnce last paid (a `last-paid` warning), `continueHeld` waits for a callback before any request opens. With one, the request carries it, needs two approvers and bars whoever recorded it.
- A cross-currency held invoice is approved on a quote from `rateFor`, with no fee estimate, since nothing has been sent.
- On a matching approval, `continueHeld` ties unseen payouts and `releaseHeld` checks under the lease that the record still holds the approved account. `Ledger.releaseFor` then spends the approval, moves the invoice back to `open` and opens the original's attempt, in one transaction.
- `releaseFor` changes nothing when the approval is no longer approved, the invoice is closed, has sent something or has a live outside payout, the email count changed, `duplicatesOnFile` differs from when the terms were built, or `likelyDuplicates` finds an invoice the terms do not list.
- The next look adds such an invoice to `duplicate_of` and to the terms. Once released, the invoice carries on like any other.

### Replacements and the floor

- `decide` checks in a fixed order: a live outside payout, the supplier's emails and the record's bank details, the original's state, a failed replacement, whether a resend can fix it (`resendCanFix`), an original sent outside PayOnce, the floor, the two-approver amount, a cross-currency invoice, and last a currency with no floor.
- After a failed replacement the policy escalates (`REPLACEMENT_FAILED_REASON`). `replacementFailed` counts a replacement only when the bank does not have it live (`liveAtBank`), one Airwallex refused included.
- The original the policy goes by is the latest the bank has live, else the latest (`notePayment`), so an invoice with a live late transfer is never replaced.
- The policy escalates a replacement above `TWO_APPROVERS_ABOVE` (`TWO_APPROVERS_REASON`) instead of sending it unprompted, comparing `incident.sourceAmountMinor`.
- An automatic replacement (`replaceUnderLock`) takes the lease, ties unseen payouts, checks the record still holds the decided account (`requireAccount`), reads the balance again, and runs `decide` again in the transaction that opens the attempt, on the fresh balance and committed money.
- That transaction sends nothing, and the next look comes at once, when the invoice is no longer open, a tied outside payout is live, or an email arrived since `assess` read the thread. A decision other than replace there escalates with its reason.
- A replacement the policy would send on a rail with an active outage goes to a person with `OUTAGE_REASON` (`escalateForOutage`). Its terms come from the replace decision, so no binding names the outage.
- The reserve floor is per currency, from `RESERVE_FLOORS` (`reserveFromEnv`, read into `Settings.reserve`). `floorFor` gives an invoice's floor: its wallet's, or `obligations.invoice_floor_minor` when stricter, never looser.
- In a currency with no floor set every automatic replacement escalates (`NO_FLOOR_REASON`). That check comes last in `decide`, and with no floor the cash is not checked.
- `CUR:0` sets a floor of 0 on purpose. A `RESERVE_FLOORS` that cannot be parsed makes every floor unreadable (`floorFor` returns NaN), so every automatic replacement escalates as `UNREADABLE_CASH_REASON`. An invoice floor above 0 counts as set in a currency not listed.
- An original sent outside PayOnce is checked before the cash (`SENT_OUTSIDE_REASON`).
- `floorReason` takes the replacement, its fee and `committedMinor` off the available balance and compares the rest with the floor; any NaN reads as unreadable cash. The policy and the check before an approved replacement is spent both call it.
- `committedMinor` is money promised to other invoices in the same wallet that has not left `available` yet: attempts being sent with no transfer, `approved` approvals not used or expired on invoices that could still pay, and pay run rows of an approved waiting run or released and not sent.
- Money already with the bank is out of `available`, and requests waiting on a person are not counted.
- `assess` adds up committed money before it reads the balance. The checks under the lease (`replaceUnderLock`, a run row's `floorBreach`, a run's `cashCheck`) add it up before the read and again after, and `committedAcross` takes each invoice at the larger of the two.
- Every replacement request names the floor when it applies, the first one included: `act`, `continueEscalated` and `replaceUnderLock` run `withFloorReason`, which calls `floorReason` on the figures `decide` used.
- When the original failed, no outside payout is live and the policy escalated for another reason first, a floor reason that also applies goes into the terms' reason as "<reason>, and <floor reason>". With no floor set the clause is `NO_FLOOR_CLAUSE`. The decision line keeps the policy's order.
- `escalate` then writes a standing `floor` warning (`noteFloor`), which says the request names the floor only when a request bound to these terms is open. One `awaitApproval` opened in the same look on these terms, counted from today, counts as bound.
- A look that finds the floor no longer applies after such a warning writes a `floor` line saying so, adding that an approval of a request naming the floor still counts only when such a request or approval is open.
- Once the floor applies, an approval of terms without the floor reason is void because the binding changed, and the new request names both.
- While the floor does not apply, `asRequested` rebuilds the terms with only the floor changed (below it, unreadable, not set). A request or approval that has not expired and whose binding matches one of them still counts.
- `requestedDecision` reruns the policy with each of the three floors and matches the result by binding, because the request's terms keep the reason as text and the invoice's codes may name a later decision.
- A request opened because the approval was void for another reason, or because the payment now needs more approvers, gives the terms as they are now, without the floor.
- An approval of a request that named the floor is spent however far below the floor cash has fallen since, as in `eur-swift-low-reserve`. The terms carry no shortfall figure.
- The cost line (topic `cost`) appears when the replacement pays a fee or money is committed elsewhere, and names the committed amount.
- A single incident's original, and an original released after a hold, are not checked against the floor. A pay run's rows are: at the check, under the lease at release, and under the lease when each is sent (`floorBreach`, `CASH_HOLD_REASON`). A currency with no floor does not stop a row.
- Once the original has failed, `assess` asks `paidDuplicate` for a paid invoice among those `likelyDuplicates` finds. Where the policy would replace, it escalates instead with "it looks like a second bill for X, which is paid" (`secondBill`), on every look.
- Where the policy escalates for another reason, `namingPaidDuplicate` adds ", and it looks like a second bill for X, which is paid" to the terms' reason, after the floor clause, in `withFloorReason` and in the terms `requestedDecision` rebuilds. With no paid match nothing is added.
- `escalate` then writes a standing `second-bill` warning (`noteSecondBill`): "Also, it looks like a second bill for X, which is paid".
- `replaceUnderLock` asks `paidDuplicate` again in its transaction. `continueEscalated` passes `useApproval` a check that `paidDuplicate` and the email count are as `assess` found them. When either changed, nothing is spent, and the next look voids the approval and opens a new request.
- Approval terms take the pay-to account from the beneficiary record as it is now (`termsFor`). The policy escalates (`CHANGED_BANK_DETAILS_REASON`) when that differs from the original's account (`sameBankDetails`), and a `bank-details` warning goes on the timeline whenever they differ.

### Approvals and requests

- Approvals follow the policy in `domain/approvers.ts`, on the page and in `pnpm approve` alike ([invariants 44 to 46](../invariants.md#approvals)). A name must be in `APPROVERS` and within its limit, compared with `paymentAmount(terms)`. Without `APPROVERS` every approval is refused.
- `policyFromEnv` reads `APPROVERS` (name:limit pairs), `TWO_APPROVERS_ABOVE` and `APPROVAL_TTL_MINUTES` into `Settings.approvals`. `signoffsNeeded`, `eligibleApprovers`, `checkSigner` and `signoffProblem` take a `PaymentAmount`, never a bare number.
- `signoffsNeeded` asks two different approvers for an account the original did not go to, when `obligations.started_by` is null or a name `knownName` does not take, and above `TWO_APPROVERS_ABOVE`. A held invoice adds `payeeRule` and its matches' accounts.
- `barredFrom` bars whoever started the incident, and everyone `callbackBars` bars for the account: whoever recorded a callback for it, and whoever proposed or confirmed the phone number such a callback was made on. The engine asks it through `barredOnFile`.
- A pay run's `runBarred` asks `callbackBars` for each row, so an invoice and a run row to one account bar the same people, whether or not PayOnce has paid that account since ([pay-runs.md](pay-runs.md)).
- A request opens only on an escalated invoice, never on one with `rejected_by` set or one paid once ([invariant 41](../invariants.md#approvals)). While the original is paid or still with the bank, `escalate` opens nothing and writes what the invoice waits on.
- `awaitApproval` opens no request when `APPROVERS` cannot be read or fewer approvers could sign than the payment needs (`eligibleApprovers`, `waitForApproverList`). It withdraws any open one and says who could approve and why more are needed.
- A request still `requested` on the same binding, for at least as many approvers, is kept. A new one voids the old, and when the old had signoffs the timeline says those approvals no longer count (`noteReplacedRequest`).
- A request expires `APPROVAL_TTL_MINUTES` after it opened (`requestExpiry`). `escalate` returns the expiry as the next look, and that look opens a new request.
- `signOff` refuses an expired request inside its transaction, and a request it completes keeps at least `APPROVED_USE_WITHIN_MS` (10 minutes) to be used. A request that becomes approved makes the invoice's next look due at once.
- `approvePayment` refuses a signoff on any request but the one the approver was shown, and on an expired one.
- For an expired request `pnpm approve` says "This request has expired. PayOnce opens a new request at its next check, and pnpm approve shows it then" and offers no command. Given a name, it records nothing and exits 1.
- Before an approval is spent, `voidIfStale` voids it when it expired, when the binding of the terms built now differs (naming the changed fields, `changedFields`), or when `approvalProblem` finds the policy as it is now refuses it.
- `approvalProblem` asks `signoffProblem`: every signoff has the request's binding, there are enough of them, and each signer still passes `checkSigner`.
- In `continueEscalated`, an open request that needs at least as many approvers as the payment needs now keeps the terms it was opened with (`asRequested`). A new one gives the terms as they are now.
- An approval is spent only by `useApproval` (a replacement) or `releaseFor` (a held invoice), which move an `approved` row that has not expired to `used`, so one another process voided meanwhile, or one that expired during the look, is not spent.
- An approval is spent only on stored terms that still hash to its binding. `requestTerms` and `runRequestTerms` read terms only while `bindingOf(terms)` equals the stored binding, so every engine read of stored terms checks it, `voidIfStale`'s included. `useApproval`, `releaseFor` and `RunStore.releaseRun` read the row again under the write lock of the spend (`requireBound`, `requireBoundRun`), so terms cannot change between that check and `openAttempt` reading their account and quote.
- Terms that no longer hash to their binding throw `StoredShapeError`, "PayOnce cannot read the terms of approval request N for INV in the ledger, so it stops here and sends nothing". The spend rolls back, nothing is sent, and the look fails and comes again a minute later, so the payment waits for a person.
- Each opens the attempt in the same transaction, after the check that the record still holds the approved account, so a failed check leaves the approval unspent.
- `useApproval` also spends nothing unless the invoice is still escalated, has no `rejected_by`, no live outside payout and no other payment live at the bank, all checked inside its transaction, as `releaseFor` checks.
- Every attempt opened on an approval keeps its `approval_id`, a same-currency one included, and `openAttempt` copies the quote from that approval's own terms.
- The outside payouts are read again after the last listing of transfers. An approved payment on a rail with an active outage waits with its approval neither spent nor void (`RailOutageError`).
- `ApprovalTerms.accountKey` is a hash of the full bank details (`accountKeyOf`). Whether two sets of details are the same account is `routeKeyOf`'s question ([accounts.md](accounts.md)).
- No approval is requested for an invoice the ledger shows as paid once (`paidOnce`). It waits for a person to close it (`closeWaitingLine`).

### Exchange rates

- An invoice whose `sourceCurrency` is not its `currency` (`crossCurrency`) is paid by one transfer per attempt that converts on a quote: `source_currency`, `transfer_currency` and `quote_id`. The quote buys exactly the invoice amount, with no separate conversion.
- Every cross-currency payment goes out on a quote a person approved ([invariant 32](../invariants.md#cash-floors-and-exchange-rates)). `decide` escalates a replacement after the cash, outside-origin and two-approver checks and before the no-floor check.
- The quote is `terms.fx`, built by `fxTermsOf` in one key order and added only on a cross-currency payment, by a conditional spread right after `accountKey`. `changedFields` names a change in it as "exchange rate".
- A new approval request never opens on a quote an earlier request showed. While a request is `requested` or `approved` and not expired, `rateFor` builds the terms on its quote, so the binding holds still across looks.
- Otherwise `rateFor` offers the invoice's last quote (`obligations.last_quote`) when the latest request did not show it and it has more than 22 minutes left (`2 * APPROVED_USE_WITHIN_MS + QUOTE_MARGIN_MS`). Only when it cannot does it take a fresh quote, which becomes the last quote.
- A look that opens no request, for example because nobody on the list can approve the payment, takes no new quote while the last one holds.
- When a new request is needed and the terms carry an open request's quote, because other evidence changed, `awaitApproval` withdraws that request and returns now, and the next look takes a fresh quote.
- A rate line (kind `payment`, `quoteLine`) is written only when a request opens on a quote, with the last request's rate when it differs. `awaitApproval` reads the last request's terms for it only then, before anything is written.
- The waiting line for a payment nobody can approve names no rate, only roughly what the payment takes from the wallet.
- A cross-currency request expires at `min(opened + APPROVAL_TTL_MINUTES, quote end - APPROVED_USE_WITHIN_MS - QUOTE_MARGIN_MS)`, a 2 minute margin. The quote end is the earlier of `valid_to_at` and arrival plus the quote's validity.
- `FX_QUOTE_VALIDITY` (`Settings.fxQuotes`, on the engine as `Engine.fxQuotes`, read by `quoteValidity` when a quote is taken) takes `MIN_30` or longer, and `rateFor` refuses a quote that holds 12 minutes or less. `describeQuotes` is the start-up line.
- Approval limits, `TWO_APPROVERS_ABOVE`, `eligibleApprovers`, `signoffsNeeded` (in `continueHeld` too) and `signoffProblem` use `paymentAmount(terms)`: the quote's sell amount in the sell currency, else the invoice amount. The fee stays out of the limit.
- The attempt keeps `quote_id`, `quote_valid_to` and `approval_id`, written by `openAttempt` from the approval's own terms. A retry sends the same request id and quote, never a new one, under the source wallet's lease.
- Until `quote_valid_to` plus the method's bank deadline, a 4xx on a retry (`sendAttempt(..., "retry")`) never fails a cross-currency attempt: it stays pending and holds the lock, and the look runs again a minute later. A first send's 4xx still fails it.
- After that, the look makes one last try under the same request id (`"lapsed"`). A quote refusal (`quote_expired` or `quote_id_invalid`) fails the attempt only if `findTransferByRequestId` also comes back empty, and the timeline says it needs a new approval on a new quote.
- Any other error on the last try, a 429 or 401 included, or a listing that throws, leaves the attempt pending. The look takes the refused path only when the ledger shows the attempt failed, and otherwise throws and is retried a minute later.
- After a refused last try, a held original goes back to a person through the refused-original path, and a replacement through the policy, each for a new approval on a new quote.
- `rateProblem` checks a transfer against the `fx` of the used approval the attempt was opened on (`Ledger.approvalOf`) when that is the quote it was sent with, through `rateMismatchOf`. A transfer with no `conversion` is a mismatch. The panel's `lineAmount` reads the approval the same way.
- `rateMismatchOf` compares `currency_pair`, `rate`, and the source amount and currency `debitOf` reads, as Airwallex gives them, never inverted.
- A mismatch is recorded on the attempt (`rate_mismatch`, `markRateMismatch`) and escalates with a warning. The look reads the invoice again after syncing its attempts, so one escalated that way takes the escalated path in the same look.
- Only a person then closes the invoice, original or replacement: `settle` refuses PayOnce's own close, and `pendingClose` gives the mismatch as the close option's reason.
- The cash check reads the source wallet. `assess` takes a quote only once the original has failed, and uses the original's fee when `fee_currency` is the source currency or missing, else NaN. The cost line is in the source currency.
- `debitCurrency` is the source currency, so the floor, `committedMinor` and the cash panel use the source wallet. A pay run's USD cash check counts a EUR invoice paid from USD at its quote's USD amount.
- A failed cross-currency original is replaced from the same source wallet on a fresh quote.
- Pay runs never convert ([pay-runs.md](pay-runs.md)). A run's limits go through `runAmount(terms)`, so `checkSigner`, `eligibleApprovers` and `signoffProblem` get the same branded `PaymentAmount` for a run as for an invoice.

### Outside payouts

- A payout PayOnce did not send is tied to an invoice when its reference names the invoice, or when it `nearlyPays` one: same supplier, amount and currency, with a reference `sameInvoiceNumber` matches (`invoiceForPayout`).
- The sweep ties a near match to an invoice not yet closed first, then to the oldest. The check before a payment (`linkUnseenPayouts`) ties a near match to the invoice being paid, unless the reference names another invoice exactly.
- A failed payout that only nearly matches a closed invoice is not tied. It becomes an incident of its own, with a warning naming the closed invoice.
- Any other payout PayOnce did not send becomes an invoice with origin `outside` once it has failed or sat past its deadline (`adoptPayout`). The policy escalates where it would replace (`SENT_OUTSIDE_REASON`), so a person approves the replacement.
- Before any payment, original or replacement, automatic or approved, the agent lists the transfers again and ties any new payout for the invoice ([invariant 11](../invariants.md#opening-and-sending-a-payment)). If it ties one, it sends nothing, leaves the approval unspent and looks again at once.
- While a tied payout is in flight, paid or in an unknown status (`anyLive`), the policy escalates before any other check (`OUTSIDE_PAYOUT_REASON`), `holdForOutsidePayout` withdraws any open request, and nothing is sent.
- A settled or rejected invoice that gains such a payout is reopened as escalated in the transaction that ties it (`linkOutsidePayout`), which also makes an open or escalated invoice's next look due (`Ledger.lookNow`).
- A tied payout counts as paying the invoice only when `payoutPays`: it is paid and the last look found that it pays (`outside_payouts.pays` is 1). `paidOutside`, a person's close as paid outside, the close option's kind, the alert's `close` need and the board's group all ask it.
- On every look `syncOutsidePayouts` reads each tied payout still with the bank, and each paid one not yet checked (`checked_at`). `judgePayouts` then judges the paid ones with `payoutVerdict` and writes each verdict with `setPayoutVerdict`.
- `payoutVerdict` compares what the payout delivered (`transfer_amount` and `transfer_currency`, kept as `delivered_minor` and `delivered_currency`) with the invoice's amount and currency, so a payout from another wallet is judged by what arrived and not by its debit.
- Its known `sent_route` must also equal `payingRoute`, the account PayOnce would pay the beneficiary now without a person. The beneficiary id does not count, so a payout to the invoice's own record with other bank details does not pay it.
- `payingRoute` is the record's account when the record holds the account of the last checked payment (`lastPaidTransfer`), when a verified callback matches it, or when PayOnce has never paid the beneficiary. Otherwise it is the last checked payment's account.
- The look reads the beneficiary record once, and only when a paid payout is tied.
- A payout PayOnce cannot judge, because what it delivered or where it went was not read, or its route comes from another scheme, is written as not paying. One no look has judged yet (`pays` null) counts as not paying too.
- `setPayoutVerdict` always runs, as one conditional statement, so the stored verdict ends as the one the look just worked out. Every test that lets a payout count as paying reads the row when it decides, never a copy from earlier in the look.
- A paid payout that does not pay the invoice still holds PayOnce's payments. It does not stop a person's close without paying (`reject`, and `rejectAgain` with `byPerson`, which test `BLOCKING_OUTSIDE_PAYOUT`).
- The close option lists such a payout in `namesOnly` (`NamingPayout`): its reference, what it delivered, the last four characters of the account, never the payee, and `checked`, false while PayOnce could not judge it. The card and `pnpm close` then say it could not be checked yet.
- A pending attempt is not sent again while a payout is live (`holdRetryForOutsidePayout`): it stays pending under its request id, the invoice is escalated with `OUTSIDE_PAYOUT_REASON` through `Ledger.escalateIfChanged`, as in `failNeverSent`, and a standing `retry` warning says so. The watcher wakes the invoice when that payout fails.
- A payout tied in this look that has already failed holds nothing: the invoice is not escalated, and the next look, due at once, retries the attempt.

### Late and unrecognised transfers

- A transfer Airwallex lists under the request id of an attempt marked failed with no `transfer_id`, with the invoice's number as reference and its amount and currency (`unrecordedAttemptOf`), goes on that attempt through `recordLateTransfer`, in the state the bank gives it. `attempts.found_late_at` records when.
- `recordLateTransfer` runs `transferChecks` on it unless it failed on a closed invoice. The checks, the `LATE_TRANSFER_REASON` escalation or the reopen of a closed invoice (`foundAfterClose`), and a look due at once (`lookNow`) are written in the transaction that records it, and its line after.
- A transfer under such a request id without the invoice's number, amount and currency is an unrecognised transfer, never recorded as the attempt's payment. `noteMismatchedTransfer` keeps it beside the attempt, writes a `warning` once, and escalates with `MISMATCHED_TRANSFER_REASON` unless the invoice is settled (`escalateUnlessSettled`).
- `addMismatched` keeps `mismatched_transfer_id`, `mismatched_reference`, `mismatched_status`, and what it took from its wallet as `debitOf` reads it (`mismatched_amount_minor`, `mismatched_currency`). Later reads update only its status and debit (`syncMismatched`), with a `bank` line when it is paid or failed.
- Keeping an unrecognised transfer, a change of its status (`setMismatchedStatus`), and adopting a found payout each make the invoice's next look due in their own transaction.
- The sweep records a late transfer, and keeps an unrecognised one, in the invoice's turn. It wakes the invoice only if it is open or escalated afterwards, and for an unrecognised transfer only when it first kept it or its status changed.
- `linkUnseenPayouts` does both for the invoice being paid and then returns true, so the check before a payment sends nothing and looks again at once.
- A pending attempt's transfer is left to its look: the sweep only wakes the invoice, and the look lists the attempt by request id and records the transfer, so the checks and the bank hook run as for any payment it sends.
- A webhook for a failed attempt with no transfer asks for a sweep ([webhooks.md](webhooks.md)).
- `paidTwice` (`lateBesideLive`) finds a payment that may have paid the supplier a second time: a late transfer the bank has not failed, or one the ledger keeps failed while the bank shows it live, while another payment for the invoice, PayOnce's or one sent outside it, is live too.
- A look checks `paidTwice` after syncing its payments and outside payouts, before the policy, before a paid payment can close the incident, and before any retry (`holdIfPaidTwice`, `holdPending`). `retry` checks under the lease that no other payment is live at the bank.
- While it finds one, `holdPaidTwice` escalates with `LATE_TRANSFER_REASON`, withdraws any open request and sends nothing. The policy never runs, so it never replaces the reason with `OUTSIDE_PAYOUT_REASON`. The alert's need is `twice`.
- An attempt still pending with no transfer beside a late transfer goes to `failNeverSent` (cause `late`), so it is marked failed once a bank deadline has passed with nothing listed. With no other live payment, a late transfer is followed like any payment.
- A transfer the bank has live counts as live everywhere, whatever state its attempt has in the ledger ([invariant 3](../invariants.md#opening-and-sending-a-payment)). `insertAttempt` refuses an attempt beside one (`DuplicatePaymentError`), so neither `openAttempt` nor `tryLock` opens a payment beside a transfer the ledger keeps failed.
- `useApproval`, `releaseFor` and `reject` change nothing while one is live. `Ledger.releaseRun` opens no attempt, so its rows meet the test when `startPayment` opens theirs.
- The look records a kept-failed transfer again after reading the others (`keptFailedLive`), so it takes its own state, and the duplicate lock, in the look that finds the other payment failed, with a `bank` line. If one is still kept, the look decides nothing and looks again at once (`waitOnKeptFailed`).
- While an unrecognised transfer is live, the look reads its status first, and `holdMismatched` escalates with `MISMATCHED_TRANSFER_REASON`, withdraws any open request and sends nothing, before a retry and before anything else is decided.
- Just before that hold the look reads the invoice's outside payouts, so one the bank has paid or failed is recorded and the watcher stops waking the invoice for it.
- Once it is paid, `paidMismatched` lets a person close the invoice from the close option (kind `mismatched`), and `settle(invoiceId, true)` accepts it.
- A paid unrecognised transfer and a paid outside payout do not rule each other out. `paidOutside` asks only that no PayOnce payment is live or still with the bank, and only an outside payout in flight or in an unknown status stops `paidMismatched`.
- Once every unrecognised transfer has failed, the look rewords `MISMATCHED_TRANSFER_REASON` to `MISMATCHED_FAILED_REASON` (`sayMismatchedFailed`, `rewordEscalation`), and the invoice carries on with a person. Only a person clears the transfer.

### Bank details and callbacks

- Every attempt keeps the account it was decided or approved for in `attempts.account_key`, written by `openAttempt` before the Airwallex call ([invariant 19](../invariants.md#accounts-and-bank-details)).
- That key is the approval's `terms.accountKey` for an attempt opened on an approval, a pay run row's approved key, the record as `assess` read it for an automatic replacement, and the record as `startPayment` read it under the lease for any other first payment.
- Every replacement and held release reads the record again before it is sent, and refuses (`requireAccount`, `AccountChangedError`) when `accountKeyOf` the record differs from the approved terms' `accountKey`, or from the details the automatic decision was made on.
- `settle` never closes an invoice by itself while a misdirected attempt is live at the bank. `closeRefused` writes a fixed waiting line and the close option offers it, as for a rate mismatch.
- A retry whose record no longer holds the attempt's account goes to `failNeverSent` (`account-changed`): the invoice waits for a person, who can restore those details in Airwallex so the next look sends it.
- Once a bank deadline has passed with nothing listed, that attempt is marked failed, a waiting line says restoring the details no longer sends it and paying now takes an approval, and the invoice carries on like any whose payment failed.
- New bank details never come from an email or the reader ([invariant 23](../invariants.md#accounts-and-bank-details)). A person records a callback with `recordBankChange`, the only caller of `updateBankDetails`.
- `recordBankChange` refuses in the cases `callbackBlocked` gives (on `callbackFacts`): a new phone number waiting for a second person, no phone on file, an invoice not escalated, a payment for it live at the bank, nothing checked to compare with, a live outside payout, or another invoice to the supplier about to be paid.
- A callback can be recorded once the invoice is escalated and every payment for it has failed, or once it was held before paying a supplier PayOnce has paid with a checked payment, as after a `LAST_PAID_CHANGED_REASON` hold.
- Another invoice is about to be paid when it goes to the same beneficiary, is not closed, and has a pending attempt or an approved request, or when a pay run row to the beneficiary is approved or released and not sent (`payRunRows`).
- The call is on the record's phone on file (`Ledger.contactOnFile`), by someone who did not propose or confirm that number, and the dialled number must match it by its digits (`isNumberOnFile`). [supplier-contacts.md](supplier-contacts.md#callbacks-on-the-number) has the phone rules.
- The callback keeps that number's row (`bank_changes.contact_id`), and `addBankChange` inserts it only while the row is still on file.
- New details are compared with the invoice's latest original that became a transfer, or for an invoice held before paying with the payment `lastPaidTransfer` finds (`comparedPayment`). With neither, `callbackBlocked` says which: PayOnce has not paid the supplier, or paid it only before it kept accounts.
- The fields not on the form must equal those of the compared transfer, and the call must come after that transfer was created, by Airwallex's `created_at`. Typed details that hold what the compared payment went to, in every field but `NOT_ROUTING_FIELDS`, are refused as nothing to verify.
- The typed details are merged into the record, sent with `updateBankDetails`, and read back. The change is `applied` only if the record then holds every typed field but `NOT_ROUTING_FIELDS`, with `applied_key` set to the record's `bankDetailsKey`.
- Recording a callback withdraws the open request for the old account.
- `GET /api/incidents/:id/bank-details` gives `comparedSentAt`, Airwallex's `created_at` for the compared transfer, or null when that read fails. The form's "When you called" starts at the later of it and now.
- When the record's details differ from the original's, `escalate` asks for approval only if `verifiedBankChange` finds the latest applied callback for that beneficiary, made on the phone on file now, whose `applied_key` goes where the record now does (`routeKeyOf`). Otherwise it opens nothing, withdraws any open request and waits for a callback.
- The terms then carry the callback in `evidence.bankChange`, the request needs two approvers, and everyone who recorded a callback for the account, or proposed or confirmed the number one was made on, is barred ([supplier-contacts.md](supplier-contacts.md#who-is-barred)).
- With no phone on file, the waiting line says so: a person closes the invoice without paying, or restores the details the original went to in Airwallex and checks again.

### Closing

- PayOnce closes a paid invoice by itself only in the cases [invariant 48](../invariants.md#closing-an-invoice) gives. `CloseStore.settle` checks and closes in one transaction, and its SQL is the authority. `closeRefusedBy` restates what it refuses.
- The look closes by itself when the one paid payment is a replacement and no outside payout is live (`paidByReplacement`, the `closeIfPaid` step). `closesItself` is that test with nothing `closeRefusedBy` finds.
- The look's own close writes one `closed` line. After a replacement it reads "Incident closed: the original failed and one replacement was paid". For a payment that had no incident, it reads `PAID_FIRST_TIME_LINE`, "Payment closed: the bank paid its first transfer" (`paidFirstTime`). That means a PayOnce invoice whose original was its only attempt, with no outside payout and no reason on file but the routine approval. Any other paid original reads "Incident closed: the original payment arrived". Older timelines keep the words they were written with.
- A paid original goes to the policy, which first escalates for a live outside payout, new bank details, the ask not to pay, a changed record, an unverified sender or emails it could not read in full, and otherwise closes it unless a supplier email reports the payment missing (`NON_RECEIPT_REASON`).
- When the ledger refuses the look's own close, `closeRefused` waits on a person for a live misdirected or rate-mismatched payment, writes an `error` line when the ledger does not show the invoice paid once, and otherwise looks again at once.
- For an uncleared unrecognised transfer or a live outside payout, `closeRefused` sends the invoice to a person with `Ledger.escalateIfOpen`: an open one with `MISMATCHED_FAILED_REASON`, `MISMATCHED_TRANSFER_REASON` while one is live, or `OUTSIDE_PAYOUT_REASON`. An escalated one keeps its reason.
- A waiting line names what to check (`closeWaitingLine`), and no next look is planned, so the watcher leaves the invoice alone. The close option and the `close` alert follow. `escalate` writes the same waiting line for an invoice paid once.
- An escalated invoice is closed by a person through `closeIncident` once the bank reports it paid once: by PayOnce's original, by a replacement the look did not close, by an outside payout that pays it (`payoutPays`) after every payment PayOnce sent failed, or by a paid unrecognised transfer (`paidMismatched`).
- Without a payment, a person closes an escalated invoice without paying once nothing for it is live at the bank, PayOnce's or sent outside it. `closeIncident` calls `Ledger.reject` with their name, and the note goes on the timeline.
- `reject` sets state `rejected` and `rejected_by`, and voids any open request in the same transaction. Nothing is sent, and a rejected invoice opens no request again.
- Any escalated invoice qualifies once nothing is live: one held before paying, one whose payments all failed while a replacement request is open, and one whose new bank details nobody can verify because no phone is on file.
- `pendingClose` says when either close applies. It takes its kind from `closeKindFor` (`domain/situation.ts`): `original`, `replacement`, `outside`, `mismatched`, `duplicate` for a held invoice never closed before whose `duplicate_of` lists matches, and `unpaid` otherwise.
- Closing sends nothing and is not bound to terms. The invoices a held one matched get a line on their timelines when it is closed.
- The alert's need stays the one its reason gives for an invoice that sent a payment; only a held invoice, or one closed before, gets `held`.
- `pendingClose` lists the uncleared unrecognised transfers in `CloseReview.covered` (`CoveredTransfer`: transfer id, short reference, status, attempt kind). The close option shows them under "This close covers" and sends the transfer ids it shows.
- `pnpm close` prints them and closes only when `--covers=` names every one of them, by short reference or transfer id, and nothing else.
- `closeIncident` takes those ids (`shown`). It refuses when one on file is not among them, as when one was found since the card was shown, and when the caller names none while any is on file, saying the close must name them.
- Otherwise `settle`, `reject` or `rejectAgain` set `mismatched_cleared_at` on exactly those (`clearMismatched`), inside the transaction that closes the invoice. Until a person clears one, PayOnce never closes the invoice by itself.
- A rejected invoice that gains a live outside payout is reopened. When that payout fails, `continueHeld` closes it again without asking anyone to pay it (`closeAgain`). One reopened by a late transfer is closed again by `continueEscalated` once every payment has failed. Both use `Ledger.rejectAgain`.
- `rejectAgain` changes only an escalated invoice with `rejected_by` set and nothing live at the bank. By itself it also refuses while any tied payout is in flight, paid or unknown (`LIVE_OUTSIDE_PAYOUT`), or an uncleared unrecognised transfer is on file.
- The look then writes a waiting line, the close option offers the invoice as kind `unpaid`, and `closeIncident` closes it with `rejectAgain(invoiceId, true)`, which closes past a paid payout that does not pay the invoice and keeps who closed it first.
- `releaseFor` changes only an escalated invoice that has sent nothing, and `reject` only one with nothing live at the bank, both with no live outside payout. Each is a conditional update on `state = 'escalated'` under the write lock ([invariant 52](../invariants.md#closing-an-invoice)).
- A pending original held for a live outside payout leaves the invoice escalated with `OUTSIDE_PAYOUT_REASON`. When that payout fails and the original goes out and is paid, a person closes it: a look never closes an escalated invoice its original paid.
- An original `startPayment` held goes out only on an approval, and `releaseFor` reopens the invoice, so once that original is paid the policy closes it by itself. A held replacement closes by itself once paid, like any paid replacement.

### Cash lines

- `cashLines` lists every amount the ledger knows about by kind, each booked to the wallet it took money from: a payout from another currency at its `source_currency` and `source_amount`, and a fee in its own `fee_currency`. No figure adds two currencies together.
- `committedMinor(ledger, currency, { invoiceId?, runId? })` adds up the promised lines, leaving out the invoice or run being paid, and `committedByInvoice` gives the same money by invoice. Both build their lines from `Ledger.committedRead`, which reads only the columns they use.
- `payRunLines` gives one `pay-run` line per pay row of an approved waiting run and per released row not sent yet, from the rows' state, so a row drops out in the transaction that opens its attempt.
- `lineAmount` is what a line takes from its wallet: what `debitOf` read from the transfer (`attempts.amount_minor`); else, from another currency's wallet, the sell amount of the quote the attempt was sent with or the open request is on; else the last quote's, estimated; else 0, estimated. A line from a quote has `fromQuote`.
- `cashReport` works each currency down to its headroom, taking off the same promised lines. It lists a currency with a floor set, a line in the ledger, an invoice floor, or a balance that is not zero.
- `cashLines(ledger, now, { openOnly: true })` skips settled and rejected invoices, whose only lines are kept fees. Given `obligations`, it reads only those invoices' lines.
- `attemptLostFee` and `payoutLostFee` are the `fee-lost` test, which the metrics use too. The board's kinds (`FIRM_KINDS`, `WAITING_KINDS`) and `waitingRunLines` are in [incident-board.md](incident-board.md).
- The panel caches balances for 30 seconds (`BalanceCache`). The policy never reads that cache: `assess` reads the balance fresh on every look.

### The watcher and sweep

- The `Watcher` reads every transfer the ledger shows in flight, PayOnce's own and outside payouts tied to its invoices, and wakes the invoice when the bank has paid or failed one ([architecture.md](../architecture.md#dispatcher-watcher-and-sweep) gives its intervals).
- Among PayOnce's own it reads a transfer the ledger keeps failed while the bank has it in flight, and an unrecognised transfer the bank has neither paid nor failed. It reads an outside payout in any state that is not final, `unknown` included.
- It wakes an invoice whose next look is due (`dueLooks`), and one whose latest request is approved, or requested and expired, only when no later look is planned (`lookPlanned`). It reads which invoices to wake soft (`readingSoft`).
- Given `release` (only the server passes it), it releases an approved waiting run at most once a minute per run. It wakes a released row that has not sent, with the run's turn, one per run per check: the first due row of the run in file order (`unsentRunInvoices`), while neither the run's key nor the row's invoice has a step running.
- Without `release`, as in `pnpm recover`, the watcher never touches an unsent run row.
- `lastCheckedAt` is when the last check that read every payment with the bank without an error started. A check with a failed read leaves it as it was, so the panel's "payment states checked" age grows while Airwallex cannot be reached.
- A read failure prints the first time, then at most once a minute while the same message repeats, with how many reads failed meanwhile. A check that fails as a whole prints the same way, and the watcher notes whether the sweep is what failed.
- A sweep's failure is forgotten only by a check that succeeds with a sweep in it, or by any check that succeeds in `pnpm recover`, which has no sweep. Any other failure is forgotten by the next check that succeeds.
- When a failure is forgotten, the checks that failed since it was last printed are printed as one count ("N more checks failed before checks worked again"). When a check fails with another message, the old one's count is printed first.
- `sweep` lists the transfers created since the ledger started (`meta.started_at`) and handles the ones the ledger has not recorded: late transfers, unrecognised ones, payouts to tie and payouts to take on. Every listed transfer then goes to `railFailureSeen`.
- A payout the sweep cannot handle is reported once on the console and skipped. A found payout with no beneficiary, or with an unknown transfer method, is not taken on.
- A found payout's invoice number is its reference when that fits `INVOICE_ID_PATTERN`, else the bank's short reference, with the reference kept (`payout_reference`) so a later payout with it is tied to this invoice.
- A found payout's invoice has no floor of its own, no `started_by` and no email domain, and adds no phone: its phone is the record's phone on file, if any. Its supplier is the account name, else `UNNAMED_PAYEE`, and a replacement is paid from the wallet the payout came from.

## Why

### Looks and steps

- Every await stays in `look()` because an awaited async helper costs one more microtask turn, which reorders a look against other looks and the sweep. With async steps, which of the look or the sweep records a rail failure first would change, and so would the order of two invoices' timeline lines.
- A webhook can at most cause a look, so what the look decides rests on what Airwallex answers to its own read.
- `startPayment` saves the deadline look at once so that it comes even when no look runs before it, as when the sandbox bank's script fails.
- A failed look waits a minute so the watcher does not retry it on every check.
- `isOverdue` counts an unreadable deadline as passed so the transfer reaches a person instead of waiting for ever.

### Sending and retries

- A 429 only says to slow down, and after a 5xx or a lost answer the transfer may exist, so both leave the attempt pending. Only a 4xx says Airwallex created nothing.
- `neverSentAt` counts from the last try because `tried_at` is written before every create call. A 5xx retried each minute keeps pushing the deadline back, and no attempt is failed while a create try may still land.
- `failNeverSent` lists and fails under the lease because a retry holds it from its create try to recording the transfer. No try is under way meanwhile, and a try another process made since moves the deadline on.
- `retry` reads the ledger again under the lease because another process may have tied a payout, recorded a late transfer, closed the invoice or changed the attempt while this look waited up to 45 seconds for the lock.
- `transferChecks` runs inside the recording transaction because a transfer goes to the record as it is when created, which can change after the account check, and a line that cannot be written must never leave a transfer recorded and unchecked.
- A transfer that shows no bank details is marked misdirected because nobody could check it, and an unchecked payment must never become the account PayOnce last paid.
- Waiters take the lease in the order they asked, so a pay run sending its rows back to back cannot starve a payment that started waiting meanwhile.

### First payments and holds

- `startPayment` reads the record last and runs every hold in the opening transaction, so the record is checked as close to the attempt as a read can be and nothing awaited comes between the last check and the attempt.
- A first payment's attempt keeps its account so every retry is checked against the account it was decided on.
- `heldForLastPaid` holds even when a callback verified the record, because a callback recorded on one invoice must never let that person, or anyone alone, pay another invoice to the new account.
- `heldForEmails` holds because a supplier who wrote before anything was paid may be asking not to pay, or to pay elsewhere.
- The rate hold comes after the others: PayOnce never pays at a rate nobody has seen, but that is a less serious reason to hold than a second bill, a changed account or an email.
- The hold for a person's payment comes last because every other hold names something more specific that the approver should read. Each of them already waits for an approval, so a payment a person started never goes out without one. A pay run row never meets it, so its place after the floor hold changes nothing.
- `sameInvoiceNumber` allows letters after the number because a supplier billing again often adds a letter or a short word, such as A, B or REV. Two numbers with different letters could each be a bill of their own.
- A record that pays the same account counts as the same supplier for a first payment's holds, because a second bill sent through another record for the same account would otherwise pass for a new supplier. Holding it only adds caution. The later looks of a held invoice do not add such matches, so terms already built, and their bindings, stay as they were.
- A new payment takes the record's email domain on file so that the sender check can tell a look-alike domain from the supplier's own. Without it every sender reads the same.
- The New payment preview skips `linkUnseenPayouts` because it writes, and a preview writes nothing.
- `openPayment` checks the number again before writing because `openObligation` leaves an invoice already there as it is.

### Held invoices

- A second bill paid to a different account needs two approvers because that is the pattern of an invoice resent with new bank details.
- `payeeRule` asks for `paidOnApproval` so that paying a payee once by itself never stands in for the two approvers a payee nobody approved a payment to takes.
- `continueHeld` rereads the reason before building terms because terms built on a reason another process changed would open a request the next look voids.

### Replacements and the floor

- The policy sends no third payment because a second failure says the route itself is broken, and a third would only pay another fee.
- A replacement above `TWO_APPROVERS_ABOVE` escalates because the approval policy asks two people for a payment that size, so the agent does not send it alone either.
- The no-floor check comes last. It fails closed, as approvals do without `APPROVERS`, but it only stops a replacement the agent would otherwise send, and never takes the place of a more specific reason.
- An original sent outside PayOnce is checked before the cash so its reason does not move with the balance or the floor.
- `assess` counts committed money before the balance read so a payment that gets its transfer in between is counted twice, as committed and as debited, rather than missed. Counting again after the read under the lease catches one promised in between.
- Requests waiting on a person are not committed money, so one held invoice cannot block replacements elsewhere.
- The terms name the floor so a replacement below it is paid only on terms that said so. An approval of terms that did not is void.
- The terms carry no shortfall figure because one would void approvals on every balance move.
- `asRequested` keeps an approval that named the floor, so a refund that lifts cash above it neither voids the approval nor reopens a partly signed request.
- The cost line holds the figures and the floor reason stays fixed text, so no approval is voided by wording.
- Every replacement request names a paid second bill so the binding carries it, and an approval given without it is void. The standing warning says it when the decision line does not.
- An email delivered since `assess` read the thread stops an automatic replacement, so it is read before anything is sent.
- A pay run row in a currency with no floor goes out because a person approved the run.

### Approvals and requests

- `awaitApproval` opens no request nobody could approve, because it would only expire and be opened again.
- An approved request makes the next look due at once so a watcher in another process uses it on its next check.
- `APPROVED_USE_WITHIN_MS` gives a request completed just before it expired time to be used, so a slow look does not lose it.
- `useApproval` and `releaseFor` spend and open in one transaction so the money counts as approved or as being sent at every moment.
- Terms carry the full `accountKey` because `payTo` shows only the last four characters, and the binding has to pin the exact details a person saw.
- The binding check reads the stored terms because `voidIfStale` compares the binding with terms the look rebuilt, and `openAttempt` takes the account and quote from the stored row. Without it, a row edited outside PayOnce could send to an account or at a quote nobody signed while the rebuilt terms still matched.

### Exchange rates

- Every cross-currency payment needs an approved quote because without one Airwallex converts at its own rate, which nobody approved.
- A request keeps its quote so its binding holds still across looks. A last quote is offered only while a request opened on it would stay open at least as long as an approval has to be used.
- The quote end also counts from when the quote arrived, so a clock that differs from Airwallex's cannot stretch it.
- With the approved use window, the expiry margin ends any approval at least 2 minutes before its quote, so a slow look never sends on a quote that has run out.
- A retry's 4xx leaves a cross-currency attempt pending so a slow first try or a passing refusal cannot release the lock while the quote could still pay.
- A quote refusal fails the attempt only with an empty listing because Airwallex checks the request id before the quote. A refused quote does not prove that no transfer exists.
- A transfer with no conversion counts as a rate mismatch because, like one with no bank details, nobody could check it.

### Outside payouts

- A live outside payout holds everything because PayOnce's lock covers only its own payments.
- `payoutVerdict` judges by what the payout delivered because a payout from another wallet debits another currency.
- The beneficiary id does not count because a record can be changed and paid in the web app. Only a payout to the account PayOnce would pay without a person counts.
- `setPayoutVerdict` always writes because another process may have changed the stored verdict since the look read it.
- A payout PayOnce could not judge counts as not paying, so it never lets PayOnce close an invoice or stop holding a payment.
- A retry held for a payout keeps its request id, and with it the duplicate lock, so PayOnce opens no other payment for the invoice either.

### Late and unrecognised transfers

- An unrecognised transfer is never recorded as the attempt's payment because it does not carry the invoice's number, amount and currency, so it may not be this invoice's.
- `recordLateTransfer` writes the record and what it decides before its line, so a step that stops between them leaves either nothing, for the next sweep to find, or everything but the line.
- The ledger keeps a transfer failed beside a live payment because `Ledger.record` never breaks the duplicate lock. When the bank's state would make a second live attempt, it records everything but the state, `bank_status` included.
- `paidTwice` runs before any close so no paid payment closes the incident while another may pay it too.

### Bank details and callbacks

- A callback is refused while another invoice to the supplier is about to be paid because the change would move that payment's account outside its turn.
- Fields not on the form must match the compared transfer because a person confirms only the fields on the form, and any other changed field would pass as verified unseen.
- `NOT_ROUTING_FIELDS` leaves `bank_name` out because Airwallex rewrites a bank name it works out from the routing number, so a rewrite after the callback does not undo it.

### Closing

- A person's close names every transfer it covers so one found since the card was shown is looked at before the close clears it.
- `rejectAgain` by itself waits on any paid payout because one that names the invoice for another amount or account leaves the decision with a person.
- A paid original goes to the policy because, unlike a replacement sent on a decision already made, it may still need a person, as when an email says the supplier did not get it.

### The watcher and sweep

- The watcher wakes an invoice for an approval only with no look planned, because a look that failed on it has planned the next try.
- The watcher reads soft so a row a look cannot read stops only that invoice's looks, not the watcher for every other invoice.
- The sweep wakes an invoice for an unrecognised transfer only on a change, when it is first kept or its status changes.
- A failed payout that only nearly matches a closed invoice becomes its own incident because it may be a bill of its own.

## Edge cases

### Looks and steps

- A held invoice's reader failure line says PayOnce reads the email again "in about a minute", because its next look comes a minute later. Any other invoice's says "on its next look at this invoice". The console's `reader` lines keep what the service wrote, with the key cut out.
- When stored terms, a kept quote, findings or an uploaded email's lists a look acts on are not in a shape PayOnce wrote, the look throws `StoredShapeError` (`store/db.ts`), whose fixed words name the row (`store/stored.ts`), and pays nothing. The shapes accept every version on file ([ledger.md](ledger.md)).

### Sending and retries

- An attempt from before `account_key` is checked as it was then. A replacement goes to a used `replace` approval's `accountKey`, or with none to the account the original the look has read went to. An original goes to a used `pay` approval's key, else to its pay run row's.
- A replacement from before `account_key` whose account nothing names (its approval's terms have no `accountKey`, or its original shows no bank details or none was read) is not sent. `retry` returns `account-unknown` without reading the record, and `failNeverSent` holds it with `ACCOUNT_UNKNOWN_REASON`, then marks it failed.
- An original from before `account_key` with no used approval and no pay run row is retried without an account check.
- When `tried_at` is added to an older ledger, every pending attempt with no transfer gets that moment. An attempt with neither `tried_at` nor `opened_at` gets the current time on its first look (`neverSentAt`), so neither is failed before a full deadline has passed.
- `Ledger.approvalOf` gives an attempt without `approval_id`, one from before the column, its invoice's latest approval. `rateProblem` and the retry's account check use it only when it is `used`.
- A payout sent outside PayOnce takes no lease, so one created between a balance read and the attempt is the one payment the lock cannot see.

### First payments and holds

- Reading the record last under the lease costs one beneficiary read more for every original.
- An outside payout with the new invoice's number that the sweep has not tied yet is the one hold the New payment preview can miss.
- The route key counts the account name ([accounts.md](accounts.md)). Two records with the same IBAN under different account names are two routes, so a same-number bill to the other one is not held for sharing an account. Neither is one to a record the ledger has never seen paid, approved or released, since the ledger knows no route for it.
- With a domain on file, an email from the supplier's own domain is not flagged on a new payment. So a paid new payment with only such an email, and findings that ask for nothing, closes by itself instead of waiting for a person to check the sender. That is how scripted and pay run invoices with a domain already work.
- The domain on file is the newest one the record's invoices give. When they give more than one, the supplier view's `domain-changed` caution says so, and the new payment trusts the newest.
- `pnpm recover` refuses a malformed invoice number, and one on a waiting pay run, with one line and nothing stored.
- A first payment a person started that waits only for its approval has `person-started` as its reason until something else sends it to a person. Released and paid, it closes by itself, and its reason stays on file. The views and the metrics read that reason, with no clause, as part of the payment and not as an incident ([reasons.md](reasons.md), [metrics.md](metrics.md)).
- Every original a person started goes out on an approval, so once paid it counts as paid on a person's approval (`paidOnApproval`). A later held invoice to the same account then needs one approver below `TWO_APPROVERS_ABOVE`, not the two a payee nobody approved a payment to takes.
- The server's restart pickup (`pickUpInterrupted`) resumes an original paid on an approval after a hold, so after a restart the sandbox bank plays every such original that is still in flight.

### Replacements and the floor

- A rejected invoice whose late transfer has not failed is reopened as escalated.
- Of new invoices only the `eur-swift-low-reserve` scenario sets an invoice floor. Invoices from before `RESERVE_FLOORS` keep the floor they carried (`reserve_floor_minor`, copied to `invoice_floor_minor`).
- After `awaitApproval` withdrew a request on an old quote, no request is bound to the terms, so the `floor` warning does not say the request names the floor.
- For a cross-currency invoice the rebuilt terms keep the open request's quote, because `rateFor` offers that quote while the request is open, so the binding can still match. The floor figures are in the source wallet at the quote's amount.
- A cross-currency invoice whose original's fee is in a currency other than the wallet's reads its cash as unreadable, so its replacement escalates.

### Approvals and requests

- A request recorded before requests expired counts as expired (`expiryOf` gives 0), and the watcher wakes its invoice.
- A partly signed request that expired is reported as expired, even when its terms have changed since. So is a request on a quote or with an arrival estimate, whose terms differ once it is replaced.
- A `started_by` stored before names were checked that `knownName` does not take bars nobody, and the payment needs two approvers.
- Attempts from before `approval_id` was kept do not count as paid on a person's approval.
- A short TTL, such as 2 minutes for the demo, still opens a cross-currency request.
- A person can sign a request only on terms that still hash to its binding too: `pendingApproval` and `pendingRunApproval` read them with `requestTerms` and `runRequestTerms`, so the page refuses the signoff and `pnpm approve` says the terms cannot be read.
- Views read stored terms soft (`storedObject`), so a payment page still shows a request whose terms no longer match its binding.

### Exchange rates

- The sandbox has not shown its own codes for refusing a quote. `quote_expired` and `quote_id_invalid` are the codes Airwallex documents.
- A mismatched-rate attempt that then failed does not block PayOnce's own close once another payment is paid.
- Paying from the currency Airwallex refunds a failed converting transfer in is not built.

### Outside payouts

- A payout tied before PayOnce kept `checked_at` and `pays` is read and judged on its next look, a paid one included. A route rebuild clears `checked_at` and `pays`, so every payout is read again.

### Late and unrecognised transfers

- Two late transfers count as paid twice even when the ledger keeps one of them failed, because both are judged by `liveAtBank`.
- A late transfer that failed on a closed invoice moved nothing, so it is recorded without checks and does not reopen the invoice.
- A transfer the ledger keeps failed while the bank has it live is read by the watcher, wakes its invoice on a webhook, shows as `with-bank` on the cash panel with no lost fee, counts with the bank on the board, is not taken for failed by `paidOnce` or `paidOutside`, and refuses a callback.
- While the bank has an unrecognised transfer and has not paid it, the cash panel lists it as `with-bank` in the wallet it left, on an invoice that is not closed. One tied before its amount was kept gets an estimate (`lineAmount`): the invoice amount, the quote's sell amount from another wallet, or 0 with no quote.
- An unrecognised transfer tied between `closeIncident`'s check and its transaction stays uncleared.

### Bank details and callbacks

- Airwallex's `created_at` is to the second and the callback time is compared with it to the millisecond. With no `comparedSentAt` the form starts from now, and recording the callback reads the transfer again and checks the time.
- A supplier PayOnce never paid, or paid only before payments kept their account, has nothing to compare new details with, so the form says which and offers approving the account on file or closing the invoice.
- A callback recorded when the record already holds the typed details verifies them without an update, unless a verified callback for them is already on file.
- An update whose answer was lost is settled by the read back. When PayOnce cannot tell whether the record changed, the timeline says to record the callback again once Airwallex answers.

### Closing

- A close of an invoice paid on an approval after a hold does not call it a second bill: the matches are named only for a held invoice or one closed before.

### The watcher and sweep

- A transfer listed under a PayOnce request id that has no transfer yet, but not with that invoice's number, amount and currency, is reported once on the console and not recorded.
- A found payout with no request id gets `outside-<transfer id>` as its attempt's request id. Airwallex requires one, so this is not expected.

Dated checks: [verification/engine-rules.md](../verification/engine-rules.md).

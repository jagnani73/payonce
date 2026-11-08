# Ledger

The SQLite ledger: its tables, columns, indexes and triggers, its transactions, how stored JSON is read, the hash-chained timelines and the audit. The code is `src/store/`: `store/ledger.ts` (the `Ledger` facade), `store/db.ts`, `store/schema.ts`, `store/chain.ts`, `store/timeline.ts`, `store/audit-trail.ts`, one store per group of tables, and the read models in `store/read/`. [architecture.md](../architecture.md) gives the overview of [the payment gate](../architecture.md#the-payment-gate), [the three chains](../architecture.md#three-hash-chained-timelines) and [the upgrade on open](../architecture.md#how-the-ledger-is-upgraded), and [invariants.md](../invariants.md) numbers the guarantees.

## Rules

### The file and the connection

- The ledger is one file, `payonce.db` in the working directory (`LEDGER_PATH`), opened with `node:sqlite`. `.gitignore` ignores every file ending in .db.
- `Ledger` builds every store on one `Db`, the connection, and each `Ledger` method hands over to the store that owns its tables. The rest of PayOnce goes through `Ledger`.
- A write waits up to 5 seconds (`BUSY_TIMEOUT_MS`) for another process's lock before it fails.
- `pnpm reset` renames the file to `payonce.<time>.db`, which `.gitignore` also ignores, so the next run starts an empty ledger. Nothing is deleted, and transfers already sent stay in the sandbox.
- `new Ledger(path, true)` opens a file read-only and skips the schema, the upgrade, the chain start and `ReconStore.ensure`. `pnpm run audit`, `pnpm ask`, `pnpm metrics`, `pnpm reconcile show` and the MCP server open the ledger this way.
- `schemaGaps` lists the tables in `SCHEMA` and the columns in `ADDED_COLUMNS` that a file lacks, and only reads. Reconciliation's tables are not in `SCHEMA`, so neither `schemaGaps` nor the MCP server asks for them.

### Stores and read models

| Store | File | Tables |
|---|---|---|
| `InvoiceStore` | `store/invoices.ts` | `obligations` |
| `AttemptStore` | `store/attempts.ts` | `attempts` |
| `ApprovalStore`, `RequestBook` | `store/approvals.ts` | `approvals`, `signoffs`, `run_approvals`, `run_signoffs` |
| `PayoutStore` | `store/payouts.ts` | `outside_payouts` |
| `CloseStore` | `store/closes.ts` | closes `obligations` |
| `EmailStore`, `InboxStore` | `store/emails.ts`, `store/inbox.ts` | `emails`, `email_findings`, `inbox` |
| `BankChangeStore` | `store/bank-changes.ts` | `bank_changes` |
| `ContactReads`, `ContactStore` | `store/contacts.ts` | `supplier_contacts` |
| `RunStore` | `store/runs.ts` | `runs`, `run_rows` |
| `OutageStore` | `store/outages.ts` | `rail_failures`, `outages`, `outage_holds` |
| `LockStore` | `store/locks.ts` | `currency_locks`, `currency_lock_waiters` |
| `AlertStore` | `store/alerts.ts` | `alert_conditions`, `alerts` |
| `DraftStore` | `store/drafts.ts` | `outbox` |
| `WebhookEventStore` | `store/webhook-events.ts` | `webhook_events` |
| `Timelines` | `store/timeline.ts` | `events`, `run_events` |
| `Schema` | `store/schema.ts` | creates and upgrades every table, and `meta` |
| `ReconStore` | `store/recon-store.ts` | reconciliation's tables |

- `store/read/` holds models that only read: `SupplierReads` for the supplier view, `MetricsReads` for the metrics, `SearchReads` (`search`, `knownNames`), the cash lines and `committedMinor` (`cash.ts`), an invoice's facts such as `paidTwice` and `coveredByClose` (`facts.ts`), what a person reads before a close or an approval (`reviews.ts`: `pendingClose`, `pendingApproval`, `barredOnFile`), and `callbackFacts` in `store/read/callback.ts`, which the engine and `views/snapshot.ts` both use.
- `ReconStore` shares the `Db`, runs through `Db.transaction`, `Db.readSnapshot` and `RECON_CHAIN`, and creates its tables in `ReconStore.ensure` on every writable open. `Ledger.recon()` hands it out. Its rules are in [reconciliation.md](reconciliation.md).
- Smaller reads for the views: `nextCheckAt` gives `obligations.look_at` as stored, `approvalsFor` and `runApprovalsFor` give every request for an invoice or a run, oldest first, and `callbackRecorders` gives only the names of who recorded each callback on an invoice.
- The live tests are defined once, in `domain/live.ts`: `liveAtBank`, `ownLive`, `withBank`, `mismatchedLive`, `lateBesideLive` (the test `paidTwice` and `settle` make), `payoutPays`, and a request's `expiryOf` and `isExpired`. The store keeps only their SQL forms: `LIVE_ATTEMPT` and `UNCLEARED_MISMATCH` in `store/attempts.ts`, and `LIVE_OUTSIDE_PAYOUT` in `store/payouts.ts`.
- `metricsRead` and `changeStamp` serve the metrics. `changeStamp` changes whenever this connection writes or another commits, and writes nothing.

### Transactions

- `Db.transaction(fn, commit?)` is the one write transaction: `BEGIN IMMEDIATE`, then commit, or roll back if `fn` throws. `Ledger.transaction(fn)` is the same without `commit`.
- With `commit`, a result it refuses is rolled back and still returned: `releaseFor` and `useApproval` roll back when they open no attempt, and `tryLock` always rolls back.
- Transactions cannot nest. `Db.transaction` and `Db.readSnapshot` throw "A ledger transaction is already open" before anything is written ([invariant 59](../invariants.md#records-and-boundaries)).
- Nothing that opens its own transaction runs inside one, and neither does `note`. These include `addEvent`, `addRunEvent`, `requestApproval`, `signOff`, `releaseFor`, `useApproval`, `tryLock`, `adoptPayout`, `linkOutsidePayout`, `settle`, `reject`, `rejectAgain` and `takeCurrencyLock`.
- `openAttempt` and `addRunApproval` run only inside a transaction the caller holds, and throw outside one.
- `Db.readSnapshot(fn)` is the one read snapshot: a deferred `BEGIN`, so every read in `fn` sees the ledger at one moment. It works on a read-only open, and `fn` only reads.
- A view reads in several read transactions, one per read model (the invoice and run snapshots in `views/snapshot.ts`, the supplier reads, the metrics), so two parts of one view can come from different moments. `boardReport` opens no snapshot of its own.

### Stored JSON

- Stored JSON is read strict. Outside `readingSoft`, `storedStrings`, `storedList` and `storedObject` in `store/db.ts` are plain `JSON.parse` ([invariant 60](../invariants.md#records-and-boundaries)).
- The row mappers read through them: `duplicate_of`, attempt and run row `arrival`, run `columns`, run row `cells`, `reasons` and `held_for`, outage `codes` and `counted`, and an upload's `reply_to`, `attachments` and `notes`.
- `checkedObject(json, shape, what)` reads strict everywhere, inside `readingSoft` too. `storedShape(json, shape, what)` reads strict outside `readingSoft` and as none inside it. The shapes are `isApprovalTerms`, `isRunTerms`, `isLastQuote`, `isStoredFindings`, `isTextList` and `isAttachmentList` in `store/stored.ts`.
- A value that does not parse, or that the shape refuses, throws `StoredShapeError`, a `SyntaxError`. Its message is fixed words naming the row ("PayOnce cannot read the terms of approval request 3 for INV-102502 in the ledger, so it stops here and sends nothing"), never the stored text.
- Approval terms are read with `requestTerms` (`checkedObject`) in `approvalProblem`, `voidIfStale`, `awaitApproval`, `noteEvidenceUpgrade`, `retry`, `pendingApproval`, `rateFor`, `rateProblem` and `arrivalFrom`. Run terms are read with `runRequestTerms` (`checkedObject`, `isRunTerms`) in the run check, `pendingRunApproval` and `releaseRun`.
- Both read terms only while they still hash to the request's binding (`boundTo`: the shape, then `bindingOf(terms) === binding`). Terms that do not throw `StoredShapeError` with the same fixed words as terms that do not parse.
- The three spends read the row again inside their write transaction, before anything changes: `ApprovalStore.useApproval` and `releaseFor` through `requireBound`, and `RunStore.releaseRun` through `requireBoundRun`. A mismatch rolls the spend back, so no approval is used and no attempt or run row opens.
- `rateFor` reads the kept quote and `readNewEmails` the findings with `checkedObject`. `storedFindings` and the cash line amount's terms and kept quote use `storedShape`, so the board's `pendingClose` and the panel read them soft.
- `Ledger.emails` reads an email's `reply_to` and `notes` with `storedShape` and `isTextList`, and its `attachments` with `isAttachmentList`. A look throws on a list that is not in the shape PayOnce writes, and a view reads it as an empty list.
- Reads that span every invoice parse only the columns they use: `committedMinor` reads `committedRead` (open and escalated invoices and their attempts, without `duplicate_of` or `arrival`), and the duplicate scans, the run checks and the callback's check read `scannedObligations`.
- Only views read soft, inside `readingSoft(fn)`: the builders in `src/views/`, `outageView`, `outagesReport` and `GET /api/cash`. The watcher and the server's start-up pick-up (`pickUpInterrupted`) also read soft when they list which invoices to wake.
- `readingSoft` takes synchronous reads only and throws on a promise, so no look runs inside it. The watcher and `pickUpInterrupted` read inside it and wake the invoices afterwards.
- In a view, a value that does not parse, is not a list or an object as PayOnce writes it, or fails its shape check reads as none.
- The alert loop reads strict, apart from the invoice snapshots its needs come from (`readInvoiceSnapshots`, soft). Its cash check reads strict.

### Invoices

- `obligations.invoice_id` is the primary key. A plain `INSERT` of a number on file (`adoptPayout`, `releaseRun`) fails with `errcode` 1555 (`isPrimaryKeyViolation`), not 2067.
- `openObligation` writes the invoice and its first line in one transaction with `INSERT OR IGNORE`. For a number already on file it writes nothing and returns the row on file. `openPayment` refuses such a number first (`numberTaken`).
- `state` is `open`, `escalated`, `settled` or `rejected` (closed without paying). `dueLooks`, the watcher and the server's start-up pick-up skip `settled` and `rejected` invoices.
- `origin` is `payonce` or `outside`. `payout_reference` keeps a found payout's reference when it could not be the invoice number, and `obligationForReference` matches either.
- `duplicate_of` is a JSON list of the invoices a held invoice looked like (`holdBeforePaying`, `setDuplicateOf`). `rejected_by` is who closed it without paying.
- `source_currency` is the wallet the invoice is paid from, null for its own `currency`. `toObligation` turns null into `currency`, so code never sees it. `NewObligation.sourceCurrency` is optional, and the sweep sets it from a found payout's `source_currency`.
- `invoice_floor_minor` is the invoice's own floor, 0 for none, in minor units of the wallet it is paid from (`debitCurrency`), because `floorFor` and the panel compare it with that wallet.
- `last_quote` is the latest quote `rateFor` took for the invoice (`saveQuote`), as `LastQuote` JSON with when it ends by PayOnce's clock.
- `due_date` is YYYY-MM-DD, null for none and for every invoice found in Airwallex. `run_row_id` is the run row the invoice was released from (`Obligation.runRowId`).
- `look_at` is when the agent next looks by itself, null to wait for news. `lookAt` sets it, `lookNow` makes an open or escalated invoice's look due now, and `postponeDueLook` moves a due look later.
- `obligations.supplier_phone` is written by `openObligation` and not read after the contacts seed. An invoice's `Obligation.supplierPhone` is its record's phone on file (see Supplier contacts below).

### Reasons

- `escalation_reason` is the text of the policy's last reason for sending the invoice to a person. `escalation_code`, `escalation_clauses` (JSON `Clause[]`) and `escalation_slots` (JSON `Slots`) hold the same reason as codes. [reasons.md](reasons.md#how-a-reason-is-stored) has the reason model.
- `escalation_code` is the lead's code, `''` with no reason, and `unrecognised` for a text PayOnce does not write.
- Every escalation writes the text and the codes in one statement (`SET_REASON`, `reasonColumns`) and takes a `Reason` or `StoredReason`, never a string ([invariant 62](../invariants.md#records-and-boundaries)).
- Those writers are `escalate`, `escalateIfChanged`, `rewordEscalation`, `holdBeforePaying`, `escalateIfOpen`, `escalateUnlessSettled`, `linkOutsidePayout`'s reopen and `addMismatched`.
- `escalateIfOpen` keeps all four columns when the invoice is escalated already. `escalateIfChanged` writes nothing when it is escalated already with the same text, code, clauses and slots. `rewordEscalation` changes only an invoice still escalated with the reason it was read with.
- `Ledger.reasonOf(obligation)` gives the stored codes while they render the text the obligation was read with, and otherwise parses that text (`storedReason`, `parseReason`). The text stays the record.

### Attempts

- The duplicate lock is the partial unique index `one_live_attempt_per_invoice` on `attempts(invoice_id) WHERE state <> 'failed'`. `insertAttempt` also refuses while `LIVE_ATTEMPT` finds a live payment ([invariant 2](../invariants.md#opening-and-sending-a-payment)).
- A violation, `errcode` 2067 (`isUniqueViolation`), is rethrown as `DuplicatePaymentError`.
- `AttemptStore.record` never raises it. An attempt whose bank state would break the lock keeps its failed state and stores the bank's status beside it. Once the lock is free, the next record takes the bank's state ([invariant 4](../invariants.md#opening-and-sending-a-payment)).
- `record` writes a failed attempt that the bank shows in a status PayOnce does not know as `in_flight`, because such a status counts as live.
- `openAttempt` writes `request_id`, `approval_id`, the quote, `account_key`, `route_key` and `opened_at` before Airwallex is called, `route_key` only with an `account_key` (see [the payment gate](../architecture.md#the-payment-gate)).
- `attemptOf` finds an attempt by `request_id` or transfer id. `failAttempt` changes only an attempt still pending with no transfer.
- `fee_minor` and `fee_currency` are the fee as last read. `record` keeps the stored fee when a read has none. `recordFee` writes only these columns, only where `fee_minor` is null, so it can run outside an invoice's turn.
- `failedWithoutFee` lists failed transfers with no fee, PayOnce's and outside payouts, leaving out those tried too recently and putting the least recently tried first. `feeTried` stamps `fee_tried_at` on both tables before a read.
- `latestFee` is the latest fee recorded in a currency for a transfer method, which the panel uses to estimate the fee of a payment not sent yet.
- `amount_minor` and `currency`, on attempts and `outside_payouts`, are what the transfer took from the wallet before the fee (`debitOf`): the source amount and currency for a cross-currency payment, else the transfer amount. On attempts, `record` and `adoptPayout` write them.
- `quote_id` and `quote_valid_to` are the quote a cross-currency attempt is sent with. `approval_id` is the approval it was opened on, null when none released it. `rate_mismatch` says why its transfer did not match that quote (`markRateMismatch`).
- `bank_created_at` and `bank_status` are the transfer's `created_at` and `status` as `record` last read them, kept with `COALESCE`.
- `arrival` is the route advisory's `ArrivalTerms`, written by `send` with `setArrival` once it works the estimate out. `tried_at` is when `sendAttempt` last called Airwallex to create the transfer, written just before the call (`tried`).
- `found_late_at` is when `recordLateTransfer` found a transfer for an attempt marked failed with none, written by `foundLate` before the transfer is recorded.
- The `mismatched_*` columns keep an unrecognised transfer under the attempt's request id: its id, reference, status, amount and currency (`addMismatched`, `setMismatchedStatus`). `mismatched_cleared_at` is when a person's close covered it (`clearMismatched`).
- `misdirected` is 1 for a transfer that went to other details than its attempt keeps, or showed none (`accountMismatch` in `transferChecks`, `markMisdirected`), so it never counts as the account PayOnce last paid.
- `refused_at` is when Airwallex refused to create the transfer, with or without a code. `sendAttempt` calls `failAttempt` with `refused` true, and `failNeverSent` passes false when Airwallex lists no transfer. Only the metrics read it.

### Where a transfer went

- `sent_key`, `sent_route` and `sent_ending`, on attempts and `outside_payouts`, are where a transfer went as last read: `accountKeyOf` and `routeKeyOf` of its bank details, and the last four of `account_number`, else `iban`, as 1 to 4 letters and digits (`sentToOf`).
- All three are null when the transfer shows no bank details, or details that are not an object, such as `null`.
- They are display only, for the supplier view, the payment page and the New payment picker's last paid (`paidTransfer`), except that `outside_payouts.sent_route` decides whether a paid payout pays its invoice (`payoutVerdict`). No decision, term, binding, alert, draft or explainer reads them.
- `record` in `engine/payments.ts` writes them with `recordSentTo`, a `COALESCE` update after its transaction, inside a try, so a failure prints a warning and the payment step goes on.
- `payoutMoney` writes them when a payout is tied and on every look that reads it, and the sweep's `adopt` on a found payout's original.
- `sentToOf` never throws: it checks the value is an object first and catches anything else.

### Time triggers

- `obligations.escalated_at`, `attempts.failed_at` and `attempts.paid_at` are when PayOnce first recorded that state. For a found payout's original taken on failed or paid, that is when PayOnce took it on. Only the metrics read them, and the New payment picker, which shows when the last paid transfer was paid (`paidTransfer`).
- Only the five triggers in `TIME_TRIGGERS` write them. `obligation_escalated_at`, `attempt_failed_at` and `attempt_paid_at` run after an `UPDATE OF state` into that state from another one while the column is null.
- `attempt_failed_at_insert` and `attempt_paid_at_insert` run after an insert in that state, as `adoptPayout` makes.
- Each trigger sets only its own column, with `COALESCE` and `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`, on the same row by rowid. A trigger has no constraint, no RAISE and no SELECT.
- `addColumns` creates them with `IF NOT EXISTS` under the write lock that adds the columns, on every writable open. `recursive_triggers` stays off and no trigger changes a state, so none sets off another.
- Nothing in `decide`, the policy, approvals, terms, bindings, alerts, the board or the cash panel reads them.

### Approval requests

- `approvals` holds an invoice's requests, with states `requested`, `approved`, `used` and `void`. Each approver's signoff is a `signoffs` row with the binding they approved, one per approver (`one_signoff_per_approver`).
- The binding is SHA-256 of the terms JSON, so terms are built only through `termsFor`, `heldTermsFor` and `runTermsFor` ([invariant 35](../invariants.md#approvals)).
- `RequestBook.signOff` checks the request is waiting, the binding matches and it has not expired, adds the signoff, and marks it approved once it has `needed`, in one transaction ([invariant 36](../invariants.md#approvals)).
- A request that gets its last signoff has at least `useWithinMs` to be used, `approvals.approver` joins the signers' names (`signersOf`), and an invoice's next look is due at once.
- `RequestBook.add` voids any earlier open request for the same invoice or run, and inserts only while the shape's `open` test passes: an escalated invoice, or a waiting run.
- `requestApproval` runs `add` in a transaction of its own. A run's request opens only through `addRunApproval`, which runs it in the caller's transaction, so a run check's rows and its request are written together.
- Invoice and run requests share `RequestBook`, with a shape each (`INVOICE_REQUESTS`, `RUN_REQUESTS`): the tables, the owner column, the open test, the columns kept beside the terms (`route_key`, invoices only), the expiry message, and the look due once approved.
- An approval is marked `used` in the transaction that opens its attempt, before the payment is tried (`useApproval`, `releaseFor`, or `RunStore.releaseRun` for a run), so it covers one attempt.
- PayOnce opens a request only when the original has failed, or for a held invoice. `pendingApproval` shows none on an invoice that is not escalated. The duplicate lock still applies to an approved payment.
- Approval evidence includes the email summary, so new emails that change the findings void an approval.
- Approvals have no FX column: the quote is in `approvals.terms`, and `expires_at` carries the earlier expiry.

### Closing an invoice

- `paidOnce` is true when one attempt is paid and nothing else for the invoice is still with the bank: every other has failed at the bank, or the bank has paid it as well, which the look holds for a person.
- `settle` closes only then, or on a person's close when `paidOutside` or `paidMismatched` holds. By itself it refuses while a payment live at the bank has a `rate_mismatch` or is `misdirected`, or `lateBesideLive` finds a late transfer.
- By itself `settle` also refuses while an outside payout is live (`LIVE_OUTSIDE_PAYOUT`) or an unrecognised transfer no person has cleared is on file (`UNCLEARED_MISMATCH`). `closeRefused` then hands the invoice to a person instead of looking again.
- `settle(invoiceId, byPerson, from, covered)` checks and closes in one `BEGIN IMMEDIATE` transaction, and changes only an open or escalated invoice still in the state `from` names. The look passes the state it read, and `closeIncident` passes `escalated`.
- A closing `settle` voids any open request and clears the `covered` transfers in the same transaction.
- `settle(invoiceId, true, "escalated", covered)`, a person's close, also accepts an invoice whose attempts all failed and whose outside payout is paid and pays it (`paidOutside`, `payoutPays`), or one paid by an unrecognised transfer (`paidMismatched`). Only `closeIncident` makes it.
- `reject` and `rejectAgain` close without paying only while nothing for the invoice is live, and void open requests and clear the covered transfers in the same transaction ([invariants 50 to 52](../invariants.md#closing-an-invoice)).

### Outside payouts

- `outside_payouts` ties a payout sent outside PayOnce to an invoice: the bank's short reference, the last state a look read (`in_flight`, `paid`, `failed`, `unknown`), the debit and fee, where it went, `beneficiary_id`, what it delivered (`delivered_minor`, `delivered_currency`), `checked_at` and `pays`.
- `pays` is 1 when the last look found the payout pays its invoice, 0 when it does not or PayOnce could not tell, and null until a look judges it, which counts as not paying (`payoutVerdict`, `setPayoutVerdict`, `payoutPays`).
- `linkOutsidePayout` ties a payout, reopens a closed invoice when given a reason, and makes the look due, in one transaction. `recordOutsidePayout` keeps a stored value wherever a read has none, and stamps `checked_at`.
- `adoptPayout` writes a found payout's invoice, its original attempt and its first line in one transaction. Its `INSERT` is plain, so an invoice another process wrote in between makes it fail.

### Emails, uploads and drafts

- `emails` and `email_findings` hold each invoice's supplier emails and the reader's findings. The findings record how many emails they cover (`emailsRead`). New emails are read one at a time, and the findings are ORed and reused.
- An uploaded email's `emails` row also has `inbox_id`, `reply_to`, `style_text`, `attachments`, `notes` (codes) and `partial`. A fixture email's are empty.
- `inbox` holds uploads: who and when, `source` (`file` or `paste`), the file name, `raw_sha256`, `raw_bytes`, `content_hash`, Message-ID, sender, display name, From and date as written, Reply-To, subject, body, style text, attachments, notes and `partial`. The raw bytes are not kept.
- `content_hash` is SHA-256 of the raw bytes read as Latin-1, with CRLF as LF, hashed as UTF-8. The unique index `one_upload_per_email` refuses a second upload of the same email (`DuplicateUploadError`). `sameMessageId` lists other uploads with the same Message-ID.
- An upload's `state` is `waiting`, `delivered` (`invoice_id`, `delivered_by`, `delivered_at`) or `dismissed` (`dismissed_by`, `dismiss_note`), which is final. Each change is a conditional update on `state = 'waiting'`.
- `deliverUpload` moves the upload, adds the email to the invoice's thread and makes an open or escalated invoice's look due, in one transaction. A closed invoice keeps the email and is not reopened.
- `outbox` holds message drafts: the invoice, template, audience (`supplier` or `bank`), the facts as JSON in the template's key order, subject, body, `text_hash`, `state`, and who created, copied, sent or dismissed it and when, with a dismiss note.
- `text_hash` is SHA-256 of `JSON.stringify({template, subject, body})` (`textHash`). `state` is `draft`, `copied`, `sent` or `dismissed`, and `sent` and `dismissed` are final.
- The partial unique index `one_open_draft_per_template` on `(invoice_id, template) WHERE state IN ('draft', 'copied')` allows one open draft per template per invoice. A second is `DraftOpenError`, with the open draft's id.
- `createDraft` inserts the draft and appends its line in one transaction. `markDraft` moves a draft only from the states given (`MOVES_FROM`: `copied` from `draft`, `sent` and `dismissed` from `draft` or `copied`) and writes its line in the same transaction.

### Pay runs

- `runs` holds each run: `state` `waiting`, `released` or `cancelled`, the file's name, hash and header, the uploader, and the last check's cash as JSON. The partial unique indexes `one_waiting_run` and `one_live_run_per_file` allow one waiting run and one live run per file.
- `run_rows` holds each row: the cells as read, what the last check made of them, `action` `pay` or `skip`, `reasons`, `held_for`, `new_payee`, `bank_change_id`, `verified_by` (the callback that verified the account, whether or not PayOnce paid it since), `account_failure` (a failed transfer on the account, as JSON), `payee`, `pay_to`, `account_key`, `route_key`, `due_date`, `arrival`, and `state` `waiting`, `released` or `dropped` with a `note`.
- `run_rows.arrival` is the last check's estimate for a pay row as `ArrivalTerms` JSON, null on a skip row.
- `run_approvals` and `run_signoffs` mirror `approvals` and `signoffs`. `run_events` is the run's timeline, chained like `events`. [pay-runs.md](pay-runs.md) has the rules.
- `payRunRows` reads, in SQL, the pay rows of a waiting run whose latest request is `approved` and not expired, and the released invoices still `open` with no attempt. A row drops out in the transaction that opens its attempt.

### Rail outages

- `rail_failures` holds each rail-level failure once, keyed by transfer id: currency, method, code, payee, the bank's short reference, the invoice or null, origin (`payonce` or `outside`), `created_at` as Airwallex wrote it, `seen_at`, `seen_by` (`look` or `sweep`) and `failed_at`.
- `outages` holds each outage: rail, `codes` (JSON), `state` `active` or `ended`, `declared_at`, the payees counted, the rule (`threshold`, `window_minutes`), `counted` (JSON transfer ids), and `ended_at`, `ended_by` and `end_note`. `one_active_outage_per_rail` allows one active outage per rail.
- `outage_holds` lists what each outage held, an invoice or a run, with `what` (`counted`, `original`, `replacement`, `approved` or `run`), one per outage per invoice or run (`one_hold_per_invoice`, `one_hold_per_run`).
- `insertHold` turns an invoice's `counted` hold into the hold of what the outage later holds of it, and that hold's line is written then. Event kind `outage` is chained like any other. [rail-outages.md](rail-outages.md) has the rules.

### Currency locks

- `currency_locks` holds the lease per currency, `holder` and `expires_at`. `takeCurrencyLock`, in one `BEGIN IMMEDIATE`, drops waiters that have not asked for 10 seconds (`WAITER_GONE_MS`), then takes the lock only when no other waiter is first in line.
- Taking the lock inserts it, or takes it over once expired. Otherwise `takeCurrencyLock` adds the holder to `currency_lock_waiters` or refreshes its `seen_at`, so it keeps its place.
- `leaveCurrencyQueue` removes a holder that gave up. `withCurrencyLock` calls it whenever it stops waiting with an error: after 45 seconds, or when `takeCurrencyLock` throws on a busy ledger.
- `renewCurrencyLock` and `releaseCurrencyLock` act only for the holder. `requireLease` checks a lease inside the transaction that writes what it guards.

### Alerts and webhooks

- `alert_conditions` holds one row per condition that needed a person, keyed `invoice:<id>`, `payout:<transfer id>`, `run:<id>`, `audit:invoices`, `audit:runs`, `audit:recon`, `cash:<currency>`, `inbox`, `outage:<id>`, `contact:<beneficiary id>` or `recon`.
- Each condition row has its fingerprint, its episode, `seen_at` (when it was last recorded as new, changed or back) and `cleared_at`.
- `alerts` holds one row per message: the facts it is built from, fixed when queued, and `state` `queued`, `sending`, `sent`, `failed` or `skipped`, with tries, the next try, the claim and the last error.
- The unique index `one_alert_per_change` on `(alert_key, episode, fingerprint)` stops a key alerting twice for one fingerprint in one episode. `meta.alerts_started_at` is the first evaluation. The webhook address is never stored. [alerts.md](alerts.md) has the rules.
- `webhook_events` holds the id of every webhook event taken (`firstDelivery`), so a redelivered event is ignored.

### Supplier contacts

- `supplier_contacts` is in `SCHEMA`: one row per version of a record's phone, with `state` `proposed`, `on_file`, `replaced`, `withdrawn` or `lapsed`. [supplier-contacts.md](supplier-contacts.md) has the phone rules.
- `one_contact_on_file` and `one_open_proposal` allow one row on file and one proposal per record and field. `contacts_by_beneficiary` indexes the rows by record.
- `bank_changes.contact_id`, in `ADDED_COLUMNS`, is the contact row of the number a callback was made on. `addBankChange` inserts a callback only while that row is still on file.
- `seedContacts` runs once, at the end of `Schema.addColumns`' transaction, and sets `meta.contacts_seeded_at`. For each record, the phone on its newest invoice that has one becomes the row on file, and each callback made on that number gets its `contact_id`.
- `Obligation.supplierPhone` is read through `ContactReads.phoneColumn()`, the record's row on file, on every invoice read and the supplier list. `''` on file, a removed number, reads as null.
- `openObligation` puts a scenario's phone on file in the transaction that writes the invoice (`seedScenario`), only when the record has none on file and none waiting. Only `openScenario` passes a phone.
- `Ledger.storedPhones()` gives every phone the ledger keeps, in any state, every `number_called` and every `obligations.supplier_phone`, for the MCP server to mask.
- `bank_changes` holds each callback: who called, the number, when, who they spoke to, what was confirmed, the old record and the typed fields, `applied_key`, and `state` `pending`, `applied` or `failed`. The row is written before the Airwallex update.
- `Ledger.callbacksFor(beneficiaryId)` gives each applied callback's details key with its recorders and the people who put its number on file, which `callbackBars` reads.

### Meta and indexes

- `meta.started_at` is when the ledger was first opened (`Db.startedAt`). The sweep lists transfers from then. `meta.outages_since` is when code that counts outages first opened it.
- `meta` also holds `route_scheme` ([accounts.md](accounts.md)), `contacts_seeded_at`, `alerts_started_at`, the chain keys below and reconciliation's keys.
- `events_by_invoice`, `attempts_by_invoice`, `approvals_by_invoice`, `emails_by_invoice` and `outside_payouts_by_invoice` index those tables by invoice. `obligations_by_beneficiary`, `run_events_by_run`, `inbox_by_message_id` and `rail_failures_by_rail` index the others.

### Upgrades

- A column added after the first version goes in `ADDED_COLUMNS`, and a new table goes in `SCHEMA`, apart from reconciliation's. `Schema.addColumns` adds what a file lacks in one `Db.transaction`, under the write lock (see [the upgrade on open](../architecture.md#how-the-ledger-is-upgraded)).
- One-off fills run in that transaction when their column is first added: the old floors into `invoice_floor_minor`, `tried_at`, `TIME_NOT_KNOWN`, `backfillAccountKeys` and `backfillReasonCodes`. `rebuildRoutes` and `seedContacts` run there too, once each by their meta key.
- After an upgrade, every PayOnce process restarts. The edge cases list what an older process sharing the file gets wrong.

### Timelines

- `events` holds invoice timelines and `run_events` run timelines. A line with a `topic` says how things stand. A line with none records an event.
- A line's `kind` is an `EventKind` (`store/timeline.ts`, and the same list in `views/contract.ts`). The column has no CHECK, so a new kind needs no upgrade. A line keeps the kind it was written with, because the kind is part of its hash.
- Invoice topics are the decision, what the invoice waits on, an approval, the cost of a replacement, a bank-details mismatch, a `last-paid`, `floor` or `second-bill` warning, a held `retry`, and a draft (`outbox:<id>`). Run topics include `row:<line>` and `release`.
- `note` and `runNote` skip a line that repeats the line before it, and a standing line when the timeline's last line on its topic says the same and nothing has happened since (`lineWanted`, `stillSays`).
- On an escalated invoice the decision line says when the policy would now replace or close and why it does not.
- A timeline line is one line. `note` and `runNote` run the message through `oneLine` before the dedupe, the write and the console line, and `appendEvent` and `addRunEventRow` do it again for lines written without them.
- `addEvent` and `addRunEvent` read the last hash, insert the line and update the running hash in one `BEGIN IMMEDIATE` transaction. `note` runs its dedupe before, outside the lock.
- `Timelines.appendEvent` and `addRunEventRow` run inside a transaction the caller holds.
- The store methods that write a line with their change call them: `openObligation`, `adoptPayout`, `releaseRun`, `createDraft`, `markDraft`, `recordRailFailure`, `holdForOutage`, `endOutage`, `proposeContact`, `confirmContact` and `withdrawContact`.
- Every other line is written after the commit. Apart from hashing the lines already there when a chain starts, no code updates or deletes a line.
- Every invoice gets its first line in the transaction that writes it: "Payment started by NAME" from `openObligation` ("Incident opened by NAME" on lines written before it), the found payout's line from `adoptPayout`, each released row's line from `releaseRun`. A run's upload line follows `createRun` with nothing awaited between them.

### Hash chains

- `HashChain` in `store/chain.ts` is the chain code, with one shape per chain: `INVOICE_CHAIN` over `events`, one chain per invoice, `RUN_CHAIN` over `run_events`, one per run, and reconciliation's `RECON_CHAIN`. A shape names the table, the owner column, the topic and the meta keys.
- A line's `prev_hash` is the hash of the owner's line before it, 64 zeros (`GENESIS`) for the first. Its `hash` is SHA-256 of `prev_hash` followed by `HashChain.canonical`: the JSON `{at, invoice_id, kind, message, topic}`, with `run_id` as a number on a run line, keys in that order.
- The running hash folds each line's hash in id order, `sha256(head + hash)` (`HashChain.next`), into `meta.events_head` or `meta.run_events_head`.
- `appendEvent` hashes a line as it will read back: `storable` turns half of a surrogate pair, such as an emoji cut by `.slice`, into U+FFFD, as SQLite's UTF-8 does.
- `HashChain.start` hashes the lines already there in id order the first time a ledger opens with the chain, and sets `meta.chain_started_at` and `meta.chain_backfilled_through`, the last line it hashed (`run_chain_started_at` and `run_chain_backfilled_through` for runs).
- A chain has started (`HashChain.started`, `chainStarted`) once any of its meta keys, its restart record or a line with a hash is on file. A started chain is never hashed again.
- Every chain sets its running hash when it starts, so a running hash missing when a line is written was removed. `HashChain.advance` still writes the line and starts the running hash again from the genesis.
- The first restart goes in `meta.events_head_restarted` or `meta.run_events_head_restarted` as `{at, id, of}`: the time, the line's id, and the invoice or `run N`. `restartOf` reads it, and from then on the ledger never reads as intact.
- A restart shows in `pnpm run audit`, the export's `ledger`, the incident and run audit lines, the MCP `audit` tool and the `audit:*` alerts (`runningHash` "started again").

### The audit

- `pnpm run audit` opens the file read-only. It refuses a missing file and a ledger whose chain has not started, which includes a file from before the `meta` table.
- It checks the invoice chains, then the run chains, then reconciliation's. `pnpm run audit run <RUN>` checks or exports one run. A ledger whose run chain has not started is reported, not hashed.
- `auditSnapshot` and `runAuditSnapshot` read what a check needs in one read transaction, so a line another process adds meanwhile cannot make the running hash look wrong.
- `HashChain.breaks` compares each line with the stored hash of the line before it and with its own content, so an edit shows up once. When the running hash does not match but every timeline verifies, it cannot say which invoice lost lines.
- `unlinedInvoices` and `unlinedRuns` list invoices and runs with no line at all. The snapshots and `runningHashCheck` read them, the audit reports them as lost lines, and an alert counts them in `withoutLine`.
- `runningHashCheck`, behind the incident view's audit line, hashes only the lines added since its last check in this process, and reads the last line it hashed again each time. Ids are never reused, so removing the ledger's last lines is caught at once.
- Once a minute (`FULL_HEAD_CHECK_MS`), `runningHashCheck` hashes every line again, as the alert loop's audit check does. Only then does it catch the other removals and rewrites, which the edge cases list.
- The invoice's own chain, read in full each time, shows a line edited, removed or inserted in its timeline at once. The audit export routes and `pnpm run audit` hash every line every time.
- An export in `json` is always written through `printableJson`. A `csv` export goes to a file or a pipe as it is, and through `printableLines` only when stdout is a terminal.
- `auditCsv` starts the file with a byte order mark and puts an apostrophe before any cell that would start a spreadsheet formula. Each exported line says whether it is `backfilled`, hashed when the chain started.
- The chain has no key. The audit catches:
  - a line edited, inserted or removed without new hashes;
  - lines cut from the end of a timeline or of the ledger;
  - every line removed together with the running hash, through the restart record and the invoices, runs and breaks left with no line;
  - the chain's meta keys deleted as well, so that the next open starts the chain again, through the invoices, runs and breaks with no line.
- It misses someone who can write `payonce.db` and recomputes the hashes: lines rewritten with every hash after them and the running hash, or invoices, runs or breaks deleted with their lines and the running hash recomputed.
- It also misses someone who deletes every invoice, run, break and line along with the chain's meta keys and any restart record. `pnpm run audit` then reports the result intact.

## Why

- `node:sqlite` ships with Node 24, so the ledger needs no database dependency or server.
- The CLI and the server can have the file open at once, so a write waits out the busy timeout instead of failing on the first lock.
- A read-only open skips every upgrade so a check cannot change what it checks.
- `BEGIN IMMEDIATE` takes the write lock at the start, so two processes cannot both pass a check that a write then relies on.
- Transactions cannot nest because `node:sqlite` cannot, so a nested call throws before it writes rather than failing part way.
- Strict reads make the engine, the policy, approvals, terms, bindings, `committedMinor` and the run checks fail closed on a value they cannot read. The look throws, sends nothing and is tried again a minute later.
- The scans that span every invoice parse only what they use, so one spoiled row stops only its own invoice's looks.
- Views read soft so that one spoiled row cannot answer 500 for the whole view. The watcher and the start-up pick-up read soft so that one spoiled row stops neither.
- `StoredShapeError` is a `SyntaxError` so `pnpm approve`'s `instanceof SyntaxError` catch still answers "holds terms PayOnce cannot read". Its message names the row because it goes on the timeline, where a native `JSON.parse` error would put a snippet of the stored text.
- `record` keeps a failed state rather than break the lock, because the lock must always hold one live payment.
- `settle` checks and closes in one transaction, against the state the caller read. A payout another process ties after a look's `syncOutsidePayouts`, or a late transfer it records after the look's `paidTwice` check, then stops the close, and the next look holds the invoice for a person.
- `RequestBook.add` checks the invoice is escalated in the same transaction as the insert, so a request cannot land on an invoice another process has just closed.
- `signOff` counts in one transaction, so the server and the CLI cannot both count the last signoff.
- Run requests have tables of their own because `approvals` and `signoffs` reference `obligations`, which a run has none of until it is released.
- Findings are reused and ORed, so a reader that words its summary differently on a second call cannot void an approval.
- `addEvent` reads the last hash under the write lock because the CLI and the server write the same file, and a step on one invoice can write on another's timeline.
- Store methods write their line inside their own transaction so the change never exists without its line: a draft without the line that records its hash, or an invoice without its first line.
- The first line goes with the invoice so that an audit finding an invoice with none knows its lines were removed.
- The running hash catches lines removed from the end of a timeline and whole timelines, which a per-invoice chain cannot.
- A started chain is never hashed again, because hashing again would vouch for whatever the lines say now. For the same reason there is no way to take a line with no hash into the chain: the step would launder a forged one.
- `HashChain.advance` writes the line even with the running hash missing, because a payment step must never fail for want of a hash.
- `runningHashCheck` hashes only new lines so a look does not hash every line, and once a minute it hashes them all to catch what that misses.
- A `csv` export goes to a file or pipe as it is because whoever checks the hashes needs every message exactly. The apostrophe guard means the JSON export is the form to check hashes against.
- The time triggers have no constraint, RAISE or SELECT so they cannot fail the statement they run in, and they fire for an older PayOnce sharing the file too.
- No trigger writes `refused_at`, because only the caller knows why an attempt with no transfer failed.
- `sentToOf` never throws and `recordSentTo` runs in a try, so a payout with odd bank details is still tied by `linkOutsidePayout`, the check before every payment and `syncOutsidePayouts`, and still taken on by the sweep.
- `adoptPayout`'s plain `INSERT` makes a race with another process fail instead of giving the invoice a second original.
- `markDraft` moves only from the given states, so a page and the CLI cannot both move one draft. Uploads change the same way, on `state = 'waiting'`.
- `webhook_events` exists because Airwallex may deliver an event more than once.
- The sweep lists from `meta.started_at` so payouts from an earlier ledger are not taken for ones sent outside PayOnce.
- Columns are added under the write lock so two processes opening an older file at once do not both add one.

## Edge cases

- `pnpm reset` fails with EBUSY while `pnpm ui` has the file open, and says to stop `pnpm ui` and try again.
- A number already on file reaching `openObligation`, as when another process opened it after `openPayment`'s check, writes nothing, not even a line, and the caller gets the row on file.
- A held invoice whose `duplicate_of` does not parse stays held, and `pendingApproval` throws on it too, so nobody can approve paying it.
- In a view, unreadable terms or a kept quote give the panel's line amount no quote, the board tells a held request from a replacement by the invoice, and findings that do not parse or fit their shape (such as `{}`) stand as not read.
- An outage with no readable codes says "a rail-level code", as its alert does, and its card on Treasury's Outages tab (`web/src/screens/treasury/`) shows "none on file".
- The stored shapes accept every version on file. A replacement's terms may lack `accountKey` (rows before 2026-10-28) and `evidence.emails` (the first terms), and `evidence.bankChange` may be missing or null. Held terms always have `accountKey`. A pay run's rows may lack `supplierDomain`, `arrival`, `verifiedBy` and `accountFailure`.
- Stored findings may lack `asksNotToPay`, `emailsRead`, `unread`, `unverifiedSenders` and `readBy`.
- A line with no hash, written by older code, is reported as written outside the chain, and the next line chains from the last line with a hash.
- A ledger whose run chain or invoice chain has not started is reported by `pnpm run audit`, never hashed by it. On a file from before pay runs, which has no `runs` table (`hasRunTable`), `pnpm run audit run <RUN>` says the ledger has no pay runs.
- The minute-long full pass of `runningHashCheck` is what catches a line removed or rewritten with a new hash in the middle, a whole invoice's lines removed, or a timeline's last line removed when it is not the ledger's last. These show on every incident's audit line within about a minute.
- Lines that older code stored keep their line breaks. `pnpm payrun show` prints each run line through `say`, as one line.
- A request recorded before requests expired has no `expires_at` and counts as expired (`expiryOf`).
- A row from before a column has none of its values until a look reads its transfer again. For the `sent_*` columns that happens only to live attempts. A payout tied before `checked_at` is read once on its next look, a paid one included.
- A row from before the amount columns has no debit. For PayOnce's own attempt from the invoice's own currency the panel takes the invoice amount, which is exact, and for a cross-currency one the quote amount `lineAmount` gives.
- A found invoice's original, or an outside payout, from before the amount columns gets the same amount marked estimated until a look reads the transfer and stores what it took.
- Payments from before `bank_created_at`, `bank_status` and `arrival` have none. A found payout's original has `bank_created_at` from take-on and an empty `bank_status` until a look reads it.
- `opened_at` is null on attempts from before the column and on a found payout's. `neverSentAt` writes the current time as `tried_at` for an attempt with neither, and opening a file from before `tried_at` gives every pending attempt with no transfer the time the column was added.
- A refusal from before `refused_at` has none.
- A row already in its state when its time column was added gets `''`, a time not known, which no trigger overwrites and the metrics count as not on file (`TIME_NOT_KNOWN`). For `escalated_at` that is every invoice escalated or with a reason, and for `failed_at` every attempt failed or found late.
- `reserve_floor_minor` is the floor each invoice carried before `RESERVE_FLOORS`. The open that adds `invoice_floor_minor` copies every `reserve_floor_minor` that is not 0 into it, and only that open. After that `reserve_floor_minor` is not read or written.
- A ledger from before `account_key` keeps a key only where `backfillAccountKeys` found an approval or a pay run row that named the account.
- On such a ledger, a supplier PayOnce paid only through other payments (automatic replacements, single incidents' originals, approvals from before terms carried `accountKey`) counts as paid before with the account not confirmed (`lastPaidUnchecked`).
- That supplier's next first payment is held with `UNCONFIRMED_ACCOUNT_REASON` and takes two approvers, until a checked payment to it is paid. `pnpm reset` starts an empty ledger, which has none of these.
- `backfillReasonCodes` codes every reason on file once, when the code columns are added. A row whose codes no longer render its text, because an older PayOnce rewrote it, is read by parsing the text, and the first such row in a process prints one warning.
- A read-only open of a file without `supplier_contacts`, or not yet seeded, reads `obligations.supplier_phone` (`ContactReads.kept()`, cached once true).
- The sweep writes a found payout's invoice with no phone of its own. Like any invoice, it reads its record's phone on file.
- After an upgrade, an older process sharing the file builds terms without `fx` or `arrival` and voids the new requests, and retries a pending cross-currency attempt without its quote.
- An older process also still counts a payout as paying by its debit and beneficiary, never reads a paid payout again, and still closes a misdirected payment by itself.
- After the upgrade, a held invoice whose payee PayOnce has only paid by itself needs two approvers (`paidOnApproval`). The next look opens its request again on the same terms and binding, signoffs given on the old request no longer count, and the timeline says so.
- A payment one person approved, such as an approved replacement, makes its payee count as paid on a person's approval.
- While `APPROVERS`, `TWO_APPROVERS_ABOVE` or `APPROVAL_TTL_MINUTES` cannot be read, nobody can end an outage until the setting is fixed and PayOnce restarted.

Dated checks: [verification/ledger.md](../verification/ledger.md).

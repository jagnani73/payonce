# Reconciliation

Reconciliation matches every wallet movement in Airwallex's balance history to the transfers on file. A movement PayOnce's records do not explain, or one that should be there and is not, becomes a break. This note covers the matcher (`src/recon/recon-match.ts`), one check and its views (`src/recon/reconcile.ts`), its tables and chain (`ReconStore` in `src/store/recon-store.ts`), `listBalanceHistory` (`src/airwallex/history.ts`), `pnpm reconcile` (`src/surfaces/cli/reconcile.ts`) and the reconcile routes. It moves no money (invariant 63 in [invariants.md](../invariants.md)), and its timeline is the third chain in [architecture.md](../architecture.md#three-hash-chained-timelines).

## Rules

### What it touches

- Reconciliation reads and records. It moves no money, takes no currency lease, runs in no invoice's turn, and writes no invoice, attempt, approval, binding, timeline line, cash panel figure or board entry.
- It writes only its own tables, its chain (`recon_events`) and its own keys in `meta`, through `ReconStore`, which works on the ledger's shared `Db` with `Db.transaction` and `Db.readSnapshot`. `ReconStore.ensure` creates the tables on every writable open.
- Nothing in the engine, the policy, the board or the cash panel's figures reads its tables. The outbox reads refund missing breaks, read-only, to offer `refund-trace` (`refundBreaks`), the cash view lists them beside its figures (`missingRefunds`), and the metrics read break times (`breakTimes`).

### Reading Airwallex

- A check reads, with GETs through `AirwallexClient`, in this order: `balances/current`, `balances/history?account_type=cash` for each window, `balances/current` again, then `listTransfersSince(meta.started_at)`.
- The history is read with no currency, so every wallet comes back at once, 500 a page with cursor paging (`listBalanceHistory`).
- Last, a check reads by id at most 5 transfers that stored payout, fee or reversal movements name and no check has read.
- A 404, or an answer for another id, stores that id as not a transfer, and it is never asked again.
- Any other 4xx except 401, 403 and 429 records the id in `recon_lookups` as refused, with the status. The check carries on, and the movement waits as "a transfer Airwallex refused to show".
- A refused id is asked again only 10 minutes later (`REFUSED_RETRY_MS`, as `recordMissingFees` does), behind ids never asked.
- A 401, 403, 429, 5xx or lost connection stops the check, as any other failed read does. `failRun` records the cleaned error on the run, and nothing else changes. `reconcileOnce` returns `airwallexAdvice` with the error, and `pnpm reconcile` prints it.
- Windows are at most 7 days (`HISTORY_WINDOW_MS`), and both ends are whole seconds. The last window ends 10 minutes after now.
- A full read (the first check, and once `meta.recon_full_read_at` is 24 hours old) covers every window from `started_at` floored to the second. Each window starts a minute before the last one ends (`WINDOW_OVERLAP_MS`).
- Any other check reads one window, from the later of that start and 7 days before its end (`windowsFor`).
- `wallet_movements` is upserted by Airwallex's row id, so a movement read twice is stored once.
- A read replaces what is stored in the range its windows cover together (`replacedRange`). A stored movement whose `posted_ms` falls in it and that no window listed is deleted, so a movement one window lists on its edge and the next leaves out stays.
- A seven-day read leaves the first minute of its window alone, because earlier reads covered that edge from inside a window.
- Times are UTC milliseconds from `airwallexTime`, which reads the sandbox's `+0800` offset.
- A row whose id, currency or time cannot be read is kept as unreadable, with no amount or balance. It is stored under `x` plus a hash of the row when its id cannot be used, and dated to its window's start when its time cannot be read (`movementOf`).
- `description` and `reference` are never read or stored. `source`, `source_type`, `transaction_type`, the short reference, the status and the method are kept only when they match fixed patterns (`movementOf`, `reconTransferOf`).

### Matching

- Matching is by transfer id only: `attempts.transfer_id`, `attempts.mismatched_transfer_id` and `outside_payouts.transfer_id`, never a request id or a reference.
- A found payout's original (origin `outside`) counts as sent outside PayOnce. A transfer kept beside an attempt because it does not match the invoice is labelled and counted apart (`mismatched`), never as PayOnce's payment.
- Hold rows (the six types Airwallex's bank feed guide names, and source type `PAYMENT_RESERVE`) are matched to no transfer and make no break.
- Hold rows count only in the running balance, and the wallet's totals show them apart from money in and out.
- A debit is compared with `debitOf`, and a `FEE` row with `feeOf`, never with the fee in the ledger.
- A refund must be the whole debit back in the wallet it left, or, for a transfer that converts, the transfer amount in the transfer currency.
- A transfer's debit is due at `created_at` plus the method's bank deadline (`deadlineMinutes`). The deadlines come from the settings: `ReconRunner`, `reconcileOnce`, `reconcileOffline`, `commitRun` and `movementsView` take them and pass them to `match` (`MatchInput.deadlines`).
- A failed transfer's refund is due at the earlier of its `updated_at` and the first check that read it failed, plus the deadline. `SCHEDULED` and `OVERDUE` transfers wait with no due time.
- Inside its window an item is waiting, kept in the run's summary, never a break. A transfer created before `started_at` is matched only for paid-then-returned.
- A movement PayOnce cannot read holds its transfer for that check. When its source cannot be read it holds every transfer in its wallet, and when its currency cannot be read either, every transfer in every wallet.
- None of the held transfers' breaks opens, changes or clears, and a `balance-gap` already on file for an unreadable wallet keeps its state. The `unreadable-movement` break says which transfers wait.
- Only two-decimal currencies are reconciled. Movements in others are stored and labelled not reconciled, with no break.
- A transfer from a wallet whose currency is known and has no two decimals is not reconciled either: every kind of break for it is unchecked, so none opens, changes or clears.
- The wallet's currency decides, not the currency the transfer pays in, so a USD wallet's debit for a JPY transfer is reconciled like any other.

### Breaks

- Kinds that clear by themselves (`clearsByItself`): `debit-missing`, `refund-missing`, `unreadable-movement`, `balance-gap` and `balance-differs`.
- `balance-gap` is keyed by the first movement where the running balance stops following.
- `balance-differs` compares the last balance with the available balance read just after the history, only when the reads before and after agree. Its facts are the difference and the newest movement when that difference was first found, carried while it stands.
- Kinds that wait for a person: `debited-twice`, `debit-differs`, `fee-differs`, `refund-differs`, `refund-unexpected`, `paid-then-returned`, `untied-payout` (waiting until its debit window ends, so the sweep can tie it), `unexplained-credit` and `unexplained-debit`.
- Facts never hold a status, a time or a due time. Each kind's facts are in one key order, and `fingerprintOf` hashes them.
- `paid-then-returned` has two subjects. The first is a transfer the ledger ties to an invoice (its own attempt, one kept beside an attempt, or a payout sent outside PayOnce) that Airwallex now shows failed or cancelled, or gave money back for.
- That transfer counts when the ledger records it paid now, or it was paid when a check read it. `recon_transfers.paid_seen_ms` is set when a check reads it `PAID` or finds the ledger recording it paid, and is kept.
- The second subject is an invoice the ledger settled that has no payment recorded as paid now (no paid attempt, kept transfer or outside payout), keyed `paid-then-returned:invoice:<id>`.
- The invoice subject is left out when a `paid-then-returned` break on file or found now names one of its transfers. A rejected invoice is closed without paying, so only its transfers can have one.
- The wording names a kept transfer as kept, and no break reopens the invoice.
- `recordBreaks` keeps one row per key in `pending` or `open` (`one_open_break_per_key`).
- `debit-missing` and `refund-missing` open with a `found` line on the first live check that finds them (`opensAtOnce`).
- Every other kind is `pending` when a live check first finds it, with no line, and opens with a `found` line when the next live check finds the same fingerprint. A pending row the next check does not find is deleted.
- New facts on an open row update its facts and fingerprint with a `changed` line, so an explanation given on the old fingerprint no longer covers it.
- A row no longer found is `cleared` when its kind clears by itself, and an `untied-payout` is cleared when the ledger now ties its transfer to an invoice (`clearReason`).
- A kind that waits for a person never clears by itself. It gets `gone_at` and a `gone` line and stays open until a person explains it, with a `back` line if it is found again. A key the check could not look at (`unchecked`) keeps its state.
- `reconcileOffline` matches as of the last committed live check (`lastLiveAt`), not now. It opens nothing and never creates or changes a pending row.
- In an offline match, what is new waits until a live check finds it, a pending row keeps the facts the last live check found, and an explained break with new facts waits for the next live check. It still deletes a pending row it no longer finds.
- `explain` runs in one transaction. The route and the CLI first refuse a fingerprint that is not 12 to 64 hex characters with `ExplainInputError` (400).
- Every id must be open: pending or unknown is `ReconUnknownError` (404), and explained or cleared is `ReconChangedError` (409). The stored fingerprint must start with the one shown (`ReconChangedError`, 409), and all must be one kind (`ReconKindsError`, 400).
- The name goes through `personName` and the note through `cleanLine`, 1 to 200 characters. The line is "Break N explained by NAME: NOTE. Facts SHA-256" and the fingerprint's first 12 characters.
- An explanation holds while the same facts are found with no gap. New facts open a new row with a `reopened` line naming the explained one, which ends its episode.
- An explained break not found ends its episode with an `ended` line, and the same facts found after that are a new break.
- `breakText` and `waitingText` check every slot again as they read stored facts back. `typeWords` and `typeName` put a `transaction_type` in PayOnce's words, and `KIND_LABELS` and `KIND_ACTIONS` name each kind and what a person does about it.

### Runs and the chain

- A run takes its id under the write lock when it starts (`beginRun`). `reconcileOnce` awaits the read from Airwallex (`readAirwallex`) first, outside any transaction.
- `commit` then stores the read, matches and runs `recordBreaks` in one synchronous write transaction, with no await inside.
- `commit` records the run `stale`, and writes nothing else, when `meta.recon_committed_run` is higher than its id.
- `recon_events` is one chain in id order (`RECON_CHAIN`). `hash` is SHA-256 of `prev_hash` followed by the JSON `{at, break_id, kind, message}`.
- `meta.recon_events_head` is the chain's running hash, set to the genesis only while the chain has never had a line.
- `meta.recon_first_line_at` is the first line's time, written with it and never again.
- A running hash missing when a line is added starts again from the genesis, unless the line is the chain's first (no line, no first-line key, no restart record and no other break opened before it). The first restart goes in `meta.recon_events_head_restarted`, which the audit reports from then on.
- The audit also reports a chain with no line, or whose line 1 is not the line it started with, as lines removed. It lists every break that has opened with no line, since a break gets its first line when it opens.
- Line kinds are `found`, `changed`, `back`, `gone`, `cleared`, `reopened`, `explained` and `ended`.
- `pnpm run audit` checks the chain after the pay run chains, and says "This ledger has no reconciliation" for a file without the tables. The page's audit line checks it in full at most once a minute, and again whenever its line count or last id changes.

### Server, page and alerts

- `ReconRunner` runs one check a minute after `pnpm ui` starts, then every `RECON_EVERY_MINUTES`, never two at once in one process.
- `RECON_EVERY_MINUTES` defaults to 10, and `0` means never by itself. `loadSettings` reads it into `Settings.recon`, and any other value falls back to 10 with a problem the start-up line (`describeReconSetting`) gives.
- `POST /api/reconcile/run` (Check now) answers 202, 409 while a check runs in this process, and 429 within a minute of the last start, the timer's included.
- `reconReport` gives the last committed run, the latest failed or stale run after it, the wallets from that run's summary, and the newest 500 open breaks (`MAX_OPEN_SHOWN`).
- `reconReport` also gives `openCount`, counts by kind, the open breaks in each wallet split into those that wait on a person and those that clear by themselves (`byWallet`), and how many are pending (all with `COUNT(*)`), the waiting items, the last 50 explained and the audit line. The page and the CLI give the full counts and say how many are not listed.
- `GET /api/reconcile` answers `reconReport` as a `ReconView` (`reconView` in `src/views/treasury.ts`).
- `GET /api/reconcile/movements?currency=USD` answers `reconMovementsView` (`src/views/treasury.ts`): the 500 newest stored movements (`MOVEMENTS_SHOWN`), each with its amount and balance as `Money` and what explains it now in words (`howText`), from the matcher run again with no balances (`movementsView`).
- `POST /api/reconcile/explain` takes `{ breaks: [{ id, fingerprint }], explainedBy, note }`. It answers 200 with the `ReconView` and a notice, 400, 404 with `unknown`, or 409 with `changed`. The route table is in [web-server.md](web-server.md).
- On the page, reconciliation is the Reconciliation tab of Treasury (`web/src/screens/treasury/`). `#recon` redirects to it (`web/src/router.ts`), and the tab reads `/api/reconcile` only while it is on screen.
- The tab shows the last check with Check now and, after a failed check, when the last good one ran (`lastCheck.lastOkAt`). It shows a card per wallet with its movements on request, the breaks that need a person by kind with a checkbox each and a name and note form, the breaks that clear by themselves, what is waiting, the last explanations and the audit line.
- The next check the tab shows (`nextCheckAt`) is when the server's timer runs next (`ReconRunner.nextRunAt`), a minute after start and then every `RECON_EVERY_MINUTES`. Check now does not move the timer. With no timer (`RECON_EVERY_MINUTES=0`) there is none.
- A wallet card counts every open break in that wallet (`byWallet`) and says how many need a person and how many clear by themselves, so it agrees with the two lists and with the "break N" its movements show.
- Clearing by themselves lists each break under its kind, with its text (which gives the amount), wallet, the payment it belongs to as a link, the transfer's short reference and when it was found. It has no explain form.
- The cash view lists each open `refund-missing` break under its wallet as money not back from a failed transfer (`refundsMissing`, from `missingRefunds`), with the payment, the reference and the amount. It is information only. The available balance already leaves that money out, and money that has left the wallet is not promised money, so `committedMinor`, headroom and the floor do not count it. `pnpm cash` prints the same lines.
- The alert condition is `recon`, standing while a break of a kind that waits on a person is open (`PERSON_KINDS` in `alerts.ts`: every kind but those `clearsByItself` names). A break that clears by itself never alerts, however long it stays open.
- Its fingerprint is the highest `recon_events` id of kind `found`, `changed` or `reopened` on a break of those kinds, in any state.
- The break the alert names is the open one of those kinds with the newest such line, so a break found once and opened on a later check is named on the alert its own line raised.
- The alert's title is "N wallet movements need a person".
- The alert's facts are the count, kind codes with counts (the message adds `KIND_LABELS`), currencies, and that break's kind, currency, invoice and short reference, each checked against its pattern.
- Counts and currencies come from `COUNT(*)` and `DISTINCT` over every open break of those kinds (`alertState`), never from a capped list. The link is `#recon`.
- The alert is urgent while a `paid-then-returned` is open. The first-enable summary counts open breaks that wait on a person.
- `audit:recon` sits beside `audit:invoices` and `audit:runs` in the once-a-minute audit check, in the same shape: `scope` `recon`, `broken` 0 or 1 (one chain), `first` null, `line` the first broken line or null when lines from its start were removed, `runningHash` and `withoutLine`.
- `audit:recon` posts "PayOnce's reconciliation record no longer verifies", linked to `#recon`.

## Why

- Airwallex refuses a history range longer than 7 days with `time_range_exceed`, so windows are at most 7 days.
- Windows overlap by a minute so a movement exactly on an edge is read whether Airwallex counts a range's start or its end.
- `airwallexTime` turns every time to UTC milliseconds, so nothing compares Airwallex's text with a UTC bound.
- `description` and `reference` carry payee names and typed text, so they are never read.
- A refused id waits behind ids never asked, so one refused id cannot hold up the rest.
- Keeping `paid_seen_ms` means a look on a settled invoice that later records the payment as failed cannot hide a paid-then-returned.
- `debit-missing` and `refund-missing` open at once because each has already waited out its window. Every other kind needs two live checks with the same facts.
- The offline match runs as of the last live check, so a refund or debit window that ran out since cannot open a break from that read. Deleting a pending row it no longer finds can only delay an opening.
- A stale run writes nothing, so a run that started earlier never undoes a later one.
- The alert's fingerprint uses only lines that say a break is new or changed, so a new or changed break alerts and one clearing or being explained does not.
- The alert counts only the kinds that wait on a person so that it says what the page's "Breaks that need a person" says. A refund still missing after a long time stays a break that clears by itself: nothing here hands it to a person after a window. Its action asks a person to chase Airwallex, the outbox offers `refund-trace` for it, and the Cash tab shows the money.
- The next check comes from the timer, not from the last check plus the interval, because Check now runs a check without moving the timer.

## Edge cases

- A ledger written before `meta.recon_first_line_at`: `ensure` takes the key from the chain's first line when the file opens.
- A ledger written before `paid_seen_ms`: `ensure` adds the column.
- A file without reconciliation's tables, opened read-only: `pnpm run audit` says "This ledger has no reconciliation", and the metrics leave break times out (`hasTables`).
- Anyone who can write the file can still rewrite the chain and its running hash, as with every chain in PayOnce.
- An alert summary queued by a PayOnce without reconciliation has no `recon` count.
- A ledger whose open breaks all clear by themselves has no `recon` condition. A `recon` alert queued for such a break before the condition left those kinds out is skipped as stale before it posts.

Dated checks: [verification/reconciliation.md](../verification/reconciliation.md).

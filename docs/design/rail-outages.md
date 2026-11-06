# Rail outages

An outage is PayOnce stopping new transfers on one rail after payouts to several payees failed there with rail-level codes in a short window. This note covers `src/outages/outages.ts` (the rule, recording failures, ending one, the views), `OutageStore` in `src/store/outages.ts`, the outage gate in `AttemptStore.openAttempt`, `pnpm outage` (`src/surfaces/cli/outage.ts`) and `POST /api/outages/:id/end` (`src/surfaces/http/routes/outages.ts`). The gate is step 2 of [the payment gate](../architecture.md#the-payment-gate), and invariant 10 in [invariants.md](../invariants.md) is the guarantee.

## Rules

### Counting failures

- A rail is `(transfer_currency, transfer_method)` upper-cased, as Airwallex reports them. For PayOnce's own payments that is `(obligations.currency, obligations.transfer_method)`, which every gate reads. An `eur-from-usd` payment runs on EUR SWIFT while its lease is on USD.
- A failure counts when a transfer reads FAILED or CANCELLED with `failure.code` in `RAIL_FAILURE_CODES`: 91401, 91402, 99901 and 99902, the codes `FAILURE_CODES` in `src/domain/failure-codes.ts` marks `rail`.
- Mixed codes add up, and the outage records the codes it counted (`outages.codes`). Account codes, unknown codes and a transfer with no code never count. Webhook bodies never count.
- An outage is declared when payouts to `OUTAGE_FAILURES` different payees (2 to 100, default 3) fail on the rail within `OUTAGE_WINDOW_MINUTES` (1 to 1440, default 30).
- `loadSettings` reads the rule into `Settings.outageRule`. A value outside its range falls back to the default with a `problem`, which the start-up line (`describeOutageRule`) names.
- The look calls `railFailureSeen` after the `bank` line of each attempt its first pass reads as failed (`notePayment`), and `syncOutsidePayouts` calls it for an outside payout that reads failed. The later pass that records a kept transfer again does not.
- The sweep calls `railFailureSeen` for every listed transfer, after it is tied or taken on, so the failure names its invoice. The watcher, the listing before a payment and webhooks never call it.
- `railFailureSeen` never throws. A failure it could not record is recorded by the next look or sweep, because the transfer id makes the record idempotent.
- A failure is dated by `failed_at`: the transfer's `updated_at` when Airwallex gives one PayOnce can read, and otherwise when PayOnce first reads it (`seen_at`).
- A failure is recorded only if its transfer was created at or after `meta.outages_since`, which the first open with outage counting sets. A `created_at` PayOnce cannot read counts.
- A failure dated by `updated_at` is left out once that time is a window old. One without `updated_at` is left out once `created_at` plus the method's bank deadline plus the window has passed.
- A payee is `payeeOf`: `keyHash` of the normalised fields that say where money goes (`bank_country_code`, `account_currency`, `account_number`, `account_routing_value1`, `iban`, `swift_code`, spaces dropped, upper-cased).
- A payout with none of the account fields is the payee `beneficiary:<id>`. Two beneficiary records for one account are one payee, and a `bank_name` Airwallex rewrote makes no new one.
- `OutageStore.recordRailFailure`, in one write transaction, does `INSERT OR IGNORE` on the failure, keyed by transfer id, so FAILED then CANCELLED, or two processes, record it once.
- If the rail has no active outage, the same transaction counts the distinct payees of the rail's failures dated after `max(now - window, the rail's last ended_at)`, by `failed_at`, else `seen_at`.
- At the threshold it inserts the outage, a `counted` hold for each counted invoice, and the declared line on each one's timeline through `appendEvent`. The partial unique index `one_active_outage_per_rail` backs this up.

### The gate and the holds

- The gate is in `openAttempt`: inside its transaction, after `requireLease`, it throws `RailOutageError` on a rail with an active outage. That covers `startPayment`, `replaceUnderLock`, `useApproval` and `releaseFor`, and each rolls back, so an approval it would have spent stays `approved`.
- `RunStore.releaseRun` throws `RailOutageError` too when any release row's rail has an active outage.
- An attempt opened before the declaration is a payment already decided: `sendAttempt` and the retry (`retry` in `src/engine/retry.ts`) are not gated.
- Ledger reads before the lease give the hold its kind. `startPayment` checks first (`original`): a new original waits open, with no attempt and no hold for a person.
- `continueEscalated` and `continueHeld` check after `voidIfStale` (`approved`), and `releaseRun` checks before `checkRows` (`run`).
- `replaceUnderLock` reads the outage inside its transaction after `decide` says replace. `escalateForOutage` then writes `Escalate: OUTAGE_REASON` and the `replacement` hold, and calls `escalate` with `"outage"`, which stores `OUTAGE_REASON` with its reason code.
- `resumeIncident` catches `RailOutageError`. It postpones the due look a minute (`postponeDueLook`) and calls `waitOnOutage`, which writes the hold line once per outage per invoice and the standing `waiting` line, naming a kept approval and when it stops counting.
- No `error` line is written for an outage. If the outage has ended by the time `waitOnOutage` runs, the next look is due at once.
- `holdForOutage` writes the hold line and the standing line in one transaction, only while the outage is active. The standing line is a `StandingLine` whose `wanted` is `lineWanted`, the check `note` makes.
- `runScenario` handles an outage on its first send the same way, and records the scenario's outcome with `expectOriginal`, so the original sent after the end gets it.
- A pay run with any approved row on a rail with an outage waits whole, its approval neither spent nor void. `holdRun` writes one chained `run` hold line on the run's timeline and a standing `release` line, through `holdForOutage`.
- The watcher tries a held run's release once a minute (`RETRY_RELEASE_MS`), and each try is a ledger read.
- The cash panel lists a single incident's original waiting on an outage (open, no attempt, not a run row, an active outage on its rail) as `waiting-outage`.
- `waiting-outage` is in the second headroom figure only, not in `FIRM_KINDS`, so `committedMinor`, the floor reasons and every binding are unchanged. A released run row waiting on an outage is already a `pay-run` line.
- The incident board shows both as first payments the outage holds (see [incident-board.md](incident-board.md)).
- No binding depends on an outage. `OUTAGE_REASON` is only `obligations.escalation_reason`, written by `escalate`, and only for an open invoice whose original failed. It is never set on a held invoice (`heldBeforePaying`), so `heldTermsFor` never reads it.
- The request's terms come from the replace decision through `termsOf`, so `evidence.reason` reads "original failed, a resend can fix it and the beneficiary details are unchanged", and later looks rebuild the same terms.

### Ending an outage

- `endOutage(ledger, policy, id, name, note, holdingOf)` checks the name with `personName` and trims the note (1 to 200 characters, `cleanLine`).
- The name must be in `APPROVERS` (`sameName`, recorded as listed) while the list is usable. With `APPROVERS` unset any named person may, and the end line says no approver list was set.
- While any approval setting cannot be read (`ApprovalPolicy.unreadable`: `APPROVERS`, `TWO_APPROVERS_ABOVE` or `APPROVAL_TTL_MINUTES`), `outageEnders` gives no names and `endOutage` refuses everyone with the reason (`endRefusal`; `why` `approver`, 403).
- `OutageStore.endOutage`, in one transaction, first records a hold for each invoice and run `holdingOf` lists: what the board shows as held, read while the outage is still active.
- The same transaction conditionally updates the outage to `ended`, writes the end line on every invoice and run with a hold (`counted` holds included, chained), and sets each held open or escalated invoice's `look_at` to now.
- The end line says PayOnce looks at the invoice now only for an open or escalated one. A settled or rejected one is told it is already closed and that PayOnce sends nothing for it.
- Two ends at once end it once. The other gets `ended` (409 with `endedBy` and `endedAt`). `EndRefusedError.why` is `input` (400), `approver` (403), `unknown` (404) or `ended` (409).
- The server then wakes the held invoices, leaving an unsent run row to the watcher's turn, and starts the held runs' release.
- The page and `pnpm outage` show the `endRefusal` reason in place of the end form.
- After the end every check runs again on the next look. A waiting original goes through `startPayment` (duplicates, outside payouts, emails, FX hold, a run row's account and floor).
- After the end, an approval is spent if it still matches, or voided for its real reason. An invoice the outage escalated stays escalated and needs its approval.

### Views

- `OutageHolding` is what an active outage holds now, as the board lists it: invoices with what of each it holds, runs, and `sends`, the `OutageSend`s per currency.
- `HoldingOf` works an `OutageHolding` out. `outageHolding` in `src/views/incident-board.ts` gives it, so `outages.ts` has no board code. `outagesReport` and `endOutage` take a `HoldingOf`, and `outageView` takes an `OutageHolding`.
- `sendsText` writes the sends for the CLIs. The page's Outages tab and `pnpm outage` read `outagesView` (`src/views/treasury.ts`), built on `outagesReport`, and the board builds its outages from `outageView`.
- The timeline lines are `holdLine`, `waitingLine`, `runHoldLine`, `runWaitingLine`, and the declared and end lines.

## Why

- A payee is the account, not the route key, so outage counts do not move when that key does.
- `meta.outages_since` keeps an upgraded ledger from ever counting its old failures.
- `updated_at` is when Airwallex last changed the transfer: when it failed, or when it was cancelled a few seconds later. One already a window old could never count, so it is left out.
- The fallback cut-off for a failure with no `updated_at` keeps failures read at catch-up after downtime from counting.
- Counting only from the rail's last end means the failures one outage counted never declare the next.
- The ledger reads before the lease save Airwallex calls, and give each hold its kind.
- The hold line and the standing line share a transaction with the active check, so neither lands after the end line.
- Invoices on other rails, and invoices on the rail escalated for another reason, get identical decisions, terms and bindings, because no binding reads the outage.
- Only a name in `APPROVERS` may end an outage, because ending it lets PayOnce pay on the rail again. A broken approval setting never opens that to anyone.
- `holdingOf` is read inside the end's transaction, so every invoice and run the board showed gets its hold and its end line.
- The end sets `look_at` to now, so a watcher in any process picks the held invoices up.

## Edge cases

- Long bank deadlines: the catch-up cut-off works only while deadlines are short, minutes as in the sandbox. With deadlines of days, failures with no `updated_at` read late after downtime are dated when read and can declare an outage together.
- A host clock more than the window ahead of Airwallex (30 minutes by default) leaves every dated failure out. One more than the bank deadline plus the window ahead (33 minutes by default for LOCAL, 35 for SWIFT) leaves every undated one out, so no outage is ever declared.
- A clock behind Airwallex keeps failures counting for longer than the window.
- Failures recorded while an outage is active do not count toward the next one, unless Airwallex dated one after the end by this machine's clock, as when Airwallex's clock is ahead.
- A ledger written before `failed_at`: the window counts `seen_at` on those rows.
- The outage ended in the moment between `replaceUnderLock`'s read and `escalateForOutage`: the next look is due at once and replaces as usual.
- `APPROVERS` unset or unreadable: an outage turns every replacement PayOnce would have sent by itself into an escalation nobody can approve. `escalate` opens no request, every approval is refused, and ending the outage does not release it.
- Those invoices wait until the approver list is set, because an escalated invoice pays only on an approval. First payments and pay runs held by the outage are not affected this way: they go out after the end.
- Approvals keep expiring during an outage. `voidIfStale` voids one that expires, and the next look opens a new request on the same terms, as at any other time.
- Only one run waits at a time, so while an outage holds a run no other run can be uploaded until it is released or cancelled.
- After upgrading, restart every PayOnce process: an older one ignores outages.
- The outage alerts' lines give codes without labels and times without dates, so a line stays under the 200 characters a line part is cut at. The alert's fields keep both.

Dated checks: [verification/rail-outages.md](../verification/rail-outages.md).

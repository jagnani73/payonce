# Incident board

The incident board ranks everything still open, from the ledger alone, and works out the money each item has at risk from the cash panel's own lines. The code is `src/views/incident-board.ts`, with the cash line kinds it totals in `src/store/read/cash.ts`. The Incidents and Home views (`src/views/incidents.ts`, `src/views/home.ts`), `pnpm board`, the supplier view and the outage holdings read it. The groups people see on those lists come from the situation layer ([reasons.md](reasons.md)), and outages are in [rail-outages.md](rail-outages.md).

## Rules

### What the board holds
- `boardReport` lists every invoice that is not `settled` or `rejected`, and every pay row (`action` `pay`, `state` `waiting`) of the run waiting for approval, which has no invoices until it is released.
- The board reads the ledger only and never calls Airwallex. It reads stored JSON soft (`readingSoft`), as a view does, and adds no action of its own.
- Each `BoardEntry` is an invoice or a run row, and names its `beneficiaryId`: the invoice's, or the run row's. `BoardOutage`, `BoardOutageMark` and `OutageTouch` are how the board shows rail outages.
- Money at risk is the cash panel's lines and nothing else: `cashLines` with `openOnly`, without `fee-lost`, plus `payRunLines` and `waitingRunLines`. Each line counts its amount plus its fee, per invoice and per currency of the wallet the money leaves (`moneyOf`).
- The waiting run has released nothing, so a line with its `runId` goes to its row. Any other run's line goes to the released invoice.
- `FIRM_KINDS` (`sending`, `approved`, `pay-run`: what headroom takes off) and `WAITING_KINDS` (`awaiting-approval`, `awaiting-person`, `waiting-outage`) are exported from `store/read/cash.ts` for the board's totals and the cash panel.
- `waitingRunLines` gives the waiting run's pay rows that `payRunLines` leaves out because the request is not approved or has expired. They are `awaiting-approval` while the request is open and `awaiting-person` otherwise, worked out as `payRunLines` does.
- `cashReport` never takes `waitingRunLines`, so no headroom counts a run before its approval. Only the board does, as `runWaitingMinor`.
- `cashLines(ledger, now, { openOnly: true })` skips settled and rejected invoices, whose only lines are fees kept. Given `obligations`, it reads only those invoices' lines.

### Groups
- Groups in order (`BOARD_GROUPS`, labelled by the board's `GROUP_LABELS`): `person`, `deadline`, `bank`, `open`.
- `person`: an invoice with a line of kind `awaiting-approval` or `awaiting-person`, or a pay row of the waiting run while its request is not approved.
- `person` also takes an escalated invoice the bank reports paid that waits for a person to close it (`pendingClose` of a paid kind). It is tested ahead of the deadline and bank groups.
- `person` also takes an invoice with any line at risk that a waiting upload offers first (`candidatesFor`'s `suggested`): the one invoice the upload names, not only among other digits, open or escalated.
- `deadline`: a payment with a transfer, pending or in flight, at or past `bank_created_at` plus `deadlineMinutes(obligation.transferMethod, deadlines)`, with the bank deadlines the caller passes from its settings.
- With no creation time on file, a payment counts as past its deadline only when the escalation reason starts with a deadline reason (`DEADLINE_REASONS`).
- `bank`: any other payment with the bank, or a tied outside payout in flight or in an unknown status.
- `open`: the rest. That includes an invoice with an `approved` line (the next look spends it), a pay row of an approved run (the server's watcher releases it), a released row waiting for its turn, and a payment with no transfer yet.
- `open` also takes an escalated invoice with nothing at risk and no paid close, and an open invoice with nothing at risk.
- An active outage moves what it holds to `person` (see Outages on the board).
- Within a group, entries rank by the largest per-currency amount at risk (`rankMinor`), then the oldest `waitingSince`, then the invoice number.

### Words
- `why` and `also` are fixed strings in `incident-board.ts`, filled only with PayOnce's own figures: the open request's signoffs, the run id, how many uploads name the invoice, and an outage's id and rail. `reason` is the code behind `why` (`BoardReason`).
- `why` and `also` never hold the escalation reason, an email, a model's answer or an Airwallex message. The escalation reason is only read with `startsWith`, to pick a group, a `reason` or a touch.
- `railName` names a rail only when it matches `RAIL_PATTERN` (a currency code and a method), and writes "a rail PayOnce cannot name" otherwise.
- A `person` entry whose payment is past its deadline says so in `also`. So does an entry that an upload offers first but that is in its group for another reason.
- An upload that names an invoice beside others, only nearly or among other digits, never moves it. It adds "may be about this invoice" to `also`.
- `waitingSince` is the invoice's first timeline line (`Ledger.firstEvent`, which reads one row), or the run's `uploaded_at` for a run row.
- `deadlineAt` is the deadline of the live payment the entry is about, null when no creation time is on file.

### Totals and filters
- `totals` per currency, over the entries shown that the caller's `keep` passes (by default, every one): `promisedMinor` (`FIRM_KINDS`), `waitingMinor` (`awaiting-approval` and `awaiting-person` with no run), `outageMinor` (`waiting-outage`), `runWaitingMinor` (`waitingRunLines`) and `withBankMinor` (`with-bank` and `outside`).
- With no filter, `promisedMinor`, `waitingMinor`, `outageMinor` and `withBankMinor` equal the cash panel's lines of the same kinds read at the same moment.
- With a currency filter only that currency is totalled. An entry passes the filter when its wallet or any currency it has at risk is that one.
- The origin filter is `payonce`, `outside` or `pay-run`. `pay-run` is any invoice with `run_row_id` and every waiting run row.
- `groups[].count` counts the entries that pass the currency and origin filters, whatever the group filter. `currencies` lists every wallet on the board, `all` the entries before any filter, and `invoices` the invoices in the ledger, closed ones included.
- One report reads the whole invoice table three times (`obligations`, `cashLines` with `openOnly`, and one `invoiceIndex` shared by every waiting upload) and does the rest per open invoice.

### Who reads it
- `incidentsView` calls `boardReport` with the list's currency and origin and no group filter. Its `keep` passes the invoices the list's scope, search and `me` filters keep, and the waiting run's rows while the run passes them, so the totals (as `WalletTotals`, with `runsWaiting`) follow the list. It also takes `currencies`, outages (as `OutageStrip`) and the invoice count, and each row's money in play and wallet amount from the board's entry.
- The rows of `incidentsView`, their groups and their ranking are the situation's (`situationOf`, ranked in `src/views/rows.ts`), not the board's. A row takes the entry's `waitingSince` only when its situation gives no time.
- `homeView` reads the board's entries for its rows' money, ranked the same way.
- `boardEntriesFor` builds the entries and totals for some invoices, and for the waiting run's pay rows to one beneficiary (every pay row when it is null), each as the whole board with no filter has it. The supplier view and the payment page's money read it.
- In `boardEntriesFor`, the run's outage and status are worked out over all its rows before the rows are picked. `indexOf` gives the invoice index for the waiting uploads, read only when one waits.
- `inboxNames` and `runOutage` are exported for `src/views/snapshot.ts`, so the situation layer counts uploads and run outages exactly as the board does.
- The board's own groups, `why`, `also` and `reason` are read only by the supplier view: its list puts a record with a `person` entry first, and its read model keeps each invoice's group and words.

### Group words outside the board
- `pnpm board`, `GET /api/board` and the MCP `board` tool take the board's group words and map them to the Incidents scopes: `person` to `needs-you`, `deadline` to `bank-late`, `bank` to `with-bank`, `open` to `payonce`. Each keeps its own copy of the map.
- `GET /api/board` answers 307 to `/api/incidents`, with the group as `scope` and the currency and origin passed on, and `{ location }` as its body. Another group answers 400 "The group is person, deadline, bank or open".
- `isBoardGroup`, `isBoardOrigin`, `BOARD_GROUPS`, `BOARD_ORIGINS` and `ORIGIN_LABELS` are what the routes and the CLI check the words with, and a currency is checked with `CURRENCY_PATTERN` (`src/domain/patterns.ts`).

### `pnpm board`
- `pnpm board [FILTER...]` takes a group, a currency and an origin as words in any order. It prints from `incidentsView` and `homeView`, with no Airwallex call ([cli.md](cli.md)).
- A currency can be in any case, and must be a code `Intl.supportedValuesOf("currency")` lists or a wallet on the board (Node does not list CNH). Any other word, such as `pay`, prints the usage and exits 1.
- It prints the active rail outages (whatever the filters), the money by wallet, then the four open groups as Needs you, Bank is late, With the bank and PayOnce is handling. Closed payments are not listed.
- Needs you also lists the pay runs that need someone, from Home, under the same filters.
- With a group filter, the money by wallet covers that group, because the list's totals follow its scope, and its heading says "in this group".
- With no invoices in the ledger it says how to start one. When every payment is closed and no run waits, it says that.

### Outages on the board
- `boardReport` reads `ledger.activeOutage` on each invoice's rail and gives the entry `outage: { id, rail, touch }` when the outage touches it, from the entry's cash lines.
- `original`: a `waiting-outage` line, or a `pay-run` line of a released row, so a first payment not opened. `approved`: an `approved` line.
- `replacement`: an `awaiting-approval` or `awaiting-person` line on an invoice this outage holds, whose `escalation_reason` starts with `OUTAGE_REASON`. `approval`: any other `awaiting-approval` or `awaiting-person` line.
- Money with the bank is never touched.
- A run row is touched by the first active outage on any pay row's rail (`runOutage`): `run` while the run is `approved`, `approval` otherwise, because the run is released whole.
- `original`, `approved` and `run` move the entry to `person` with reason `outage-original`, `outage-approved` or `outage-run`, since only a person ends an outage. A `replacement` waiting for approval gets `outage-replacement`.
- Any other `replacement`, and every `approval`, keeps its group and reason, and gets a fixed `also` line saying a payment approved now waits for the outage to end.
- `outages` in the report: each active outage, oldest first, with `outageView`'s `codes`, `payees`, `windowMinutes`, `declaredAt` and `text`, and what it holds now from the entries before any filter.
- What an outage holds: `originals`, `replacements` and `approved` (invoice ids), `runs` (run ids), `atRisk` (the sum of those entries' cash lines) and `sends` (`sendsOf`).
- `sends` is what ending the outage sends per currency: one payment per `original`, `approved` and `run` entry, and the sum of their cash lines.
- `outageHolding(ledger, deadlines, now)` gives the same lists, as `OutageHolding`, to Treasury's Outages tab, `pnpm outage`, the status view's outage strips, the end-outage option on the payment and pay run pages, and the end of an outage. It reads the board once, on its first call.
- Ending an outage, in one transaction, records a hold (the touch as `what`) for every invoice and run the holding listed and marks the outage ended. It then writes the end line on every invoice and run with a hold, `counted` ones included ([rail-outages.md](rail-outages.md)).
- `incidentsView` turns each board outage into an `OutageStrip`: its id, rail, how many payments it is pausing (originals, approved and runs) and what ending it sends. The Incidents screen shows each as a link to Treasury's Outages tab, where the end form is.

### The page
- The Incidents screen (`web/src/screens/incidents.tsx`) reads `GET /api/incidents`. Its filters live in the address (`#incidents?scope=...&currency=...&origin=...`).
- The Incidents screen is polled every 10 seconds, and every 3 seconds while PayOnce is working on a payment it shows. `#board` redirects to `#incidents`.
- With no payment in the ledger, the Incidents screen says "No payments yet."
- A row whose rail has an active outage carries an "Outage N" tag, and one an upload names carries an inbox tag (the row's tags, in `src/views/rows.ts`).

## Why

- The board totals the cash panel's lines instead of figures of its own, so the board and the panel cannot disagree about what is at risk, and the totals can be checked against the panel.
- The board's `why` and `also` are fixed words that hold only PayOnce's own figures, so a view can show them anywhere without carrying a supplier email, a model's answer or Airwallex text.
- Entries are ranked by plain numbers across currencies because PayOnce has no exchange rates. Amounts in different currencies are compared as numbers, and a currency filter gives a strict order within one wallet.
- An outage touches a run whole because the run is released in one step, so one outage on any of its rails holds every row.
- Outage holds go to `person` because only a person ends an outage, so whatever it holds waits on a person.
- Hold rows alone cannot tell a replacement, so the touch also reads the cash line and the reason. A hold stays `replacement` after a person approves, and an invoice whose replacement waits on another reason keeps a `counted` hold.
- The holding is read in the end's own transaction, so every invoice and run the board showed as held gets its hold and its end line, and nothing an outage held is missed when it ends.

## Edge cases

- A run row with no invoice yet is an entry of kind `run-row`, keyed by its row's invoice number, with its run's `uploaded_at` as `waitingSince`. It counts in the totals and the outages, and `pnpm board` lists its run from Home.
- When terms do not parse, a `person` entry tells a held invoice's request from a replacement's by `heldBeforePaying` instead.
- An outside payout with no creation time never counts as past the deadline, because the ledger keeps none for tied payouts.
- For an expired request, the entry says PayOnce opens a new one on its next look.
- An escalated invoice paid once waits in `person` for a person to close it, as the payment page's close option offers it.
- An approved invoice that a waiting upload names first stays in `person`, as a payment being sent does.
- On an empty ledger, `invoices` is 0, and the Incidents screen and `pnpm board` say how to start a payment.

Dated checks: [verification/incident-board.md](../verification/incident-board.md).

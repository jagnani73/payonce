# Metrics

The ops metrics: eight tables of how a period went, built from the ledger alone and shown on the page's Reports screen, by `pnpm metrics` and by the MCP `metrics` tool. The code is `src/views/metrics.ts` (the tables), `MetricsReads` in `src/store/read/metrics.ts` (the read), `src/views/reports.ts` (the tiles), `src/surfaces/cli/metrics.ts` and the route in `src/surfaces/http/routes/views.ts`. The time columns it counts by are written by SQLite triggers ([ledger.md](ledger.md)), and the reason families come from [reasons.md](reasons.md).

## Rules

### Display only
- Metrics move no money and change nothing. Nothing PayOnce decides, alerts on, binds or checks reads a metric, and neither do the incident board nor the cash panel.
- Home's "Paid in the last 7 days" tile and the Reports tiles (`reportTiles`) are built from the report and are display only too.
- No Airwallex call, balance or setting goes into a metric. `metricsReport(ledger, period, now)` reads `Ledger.metricsRead` and `ReconStore.breakTimes` in one `readSnapshot`, and `metricsOf` builds the tables from those rows.
- Nothing on a payment path imports `src/views/metrics.ts`.

### Periods
- `7d` and `30d` are 7 or 30 times 24 hours up to now, compared as UTC milliseconds after `Date.parse`. `all` is every row (`PERIODS`, `isPeriod`, `PERIOD_PROBLEM`).
- Each table names the time that puts a row in the period:
  - payments, failures at the bank and fees lost: the transfer's `bank_created_at`;
  - a refused or never-created payment: `tried_at`, else `opened_at`;
  - a payout sent outside PayOnce and tied to an invoice: `found_at`;
  - incidents started and duplicates held: the invoice's first timeline line;
  - incidents closed: its latest `closed` line;
  - approvals: the signoff that completed the request;
  - outages: overlapping the period;
  - reconciliation breaks: `opened_at`.
- A found payout taken on as an invoice of its own is that invoice's original, so it goes by `bank_created_at` too, which `adoptPayout` writes.
- A row whose time is missing or unreadable is left out of `7d` and `30d` and counted in the `notOnFile` beside it (`started.notOnFile` for incidents started, each row's own for approvals). `all` includes it.
- A duration with either end missing or unreadable, or one that comes out negative, counts in its spread's `notOnFile`.
- A row whose currency is not three capital letters (`CURRENCY_PATTERN`) stays out of the money and counts in `unreadable`. The payments table's `unreadable` counts invoices.
- Payments and incidents also give `leftOut`: the invoices a time is missing for, each counted once, whether that left it out of the rows or out of one or more durations. The page's and the CLI's note under those two tables show it.

### The tables
- The payments table counts the payments PayOnce sent, each an attempt with a transfer and not a found payout's original, by currency and kind (`first`, `first-approved`, `replacement-auto`, `replacement-approved`).
- Each payment row gives what the bank did to the attempt's own payment (`ownLive`), so a mismatched transfer under it counts only in `mismatchedPaid`, once paid. The table also gives the first payments paid the first time and the bank's time to pay.
- `paidMoreThanOnce` counts the invoices paid more than once since the ledger started, by paid attempts and paid outside payouts. `extra` is what each paid payment after the first took, wallet by wallet.
- `extra` takes the invoice's attempts in rowid order (a found payout's original included), then its payouts in the order they were tied, each at the amount and currency `debitOf` stored.
- With no stored amount, PayOnce's own payment counts at the invoice amount from the invoice's own wallet, or the sell amount of the quote it was sent with. The quote counts only when the approval it was opened on (else the invoice's latest approval) names that quote and wallet.
- Anything else is counted in `notKnown`, as is a found payout's original with no stored amount.
- Paid mismatched transfers are counted apart in `mismatchedPaid`, at their stored amount or not known, never as a second payment.
- The failures table counts failures by rail, stage (`bank`, `refused`, `never-created`) and code. A failure with no transfer is `refused` when the attempt has a `failure_code` or a `refused_at`, so a 4xx with no code counts as refused.
- A failure code is shown only as five digits or one of `KNOWN_CODES`, else `other`, and `none` for null. Each row says, from `domain/failure-codes.ts`, its words (`FAILURE_WORDS`), whether it counts toward an outage and whether a resend can fix it (`RESENDABLE_FAILURE_CODES`).
- The incidents table counts incidents started by origin, and closed by currency and how (`first-time`, `replaced`, `person-paid`, `not-paid`). It gives how long they took from the first line, from the first failed original and with a person, and the reason on file when a person's invoice closed.
- The approvals table counts approvals given, needing two approvers, spent, voided and waiting, for invoices and runs. The time to approve is per episode: from the first request after the last one given to the signoff that completed one. `openNow` counts requests open now.
- A fee counts as lost by the cash panel's own tests (`attemptLostFee`, `payoutLostFee`).
- Duplicates held are counted by their state now: stopped (rejected), paid (settled), released (open again, approved and paying) or still held (escalated).
- The outages table lists outages with how long they ran, payees, rail codes and their holds other than `counted`.
- The breaks table counts reconciliation breaks by kind and state, with the time to resolve.
- A median and p90 are by nearest rank. Every median has its n, and p90 is null below 10.

### Reasons
- An invoice needed a person when `escalation_reason` is set.
- The reasons table counts each closed invoice under `familyOf` its reason's lead code, read from `MetricsObligation.reason` as `Ledger.reasonOf` reads it: the stored codes when they render the text exactly, else the text parsed.
- A reason PayOnce does not write is `unrecognised`, which counts as `other`. Only the family leaves the read: `REASON_LABELS` is keyed by `ReasonFamily`.

### Only fixed strings
- Every string in a report is a code from a fixed set, a five-digit failure code, a currency code, an ISO time with a four-digit year, or a fixed label.
- The labels are `FAILURE_WORDS` or one of three fixed phrases by failure code, `RAIL_FAILURE_CODES` by rail code, `REASON_LABELS` by reason family, and `KIND_LABELS` by break kind.
- `RAIL_FAILURE_CODES` and `FAILURE_WORDS` are looked up with `Object.hasOwn`, so a stored code such as `toString` gets no label.
- `metricsRead` selects no supplier name, phone, reference, facts, note, approver or timeline message. Of the timeline it reads only each invoice's first line's time and its latest `closed` line's.
- In SQL, `metricsRead` reads stored JSON only inside `CASE WHEN json_valid(...)`: `duplicate_of`'s length, and of an approval's terms only its quote's sell amount, compared with the attempt's quote and wallet in SQL.
- Outage codes come back as text, and `outageCodes` parses them inside a try.

### Where it is shown
- `GET /api/metrics?period=7d|30d|all` (7d when left out) answers the `MetricsReport`. Anything else answers 400 "The period is 7d, 30d or all". `GET /api/reports` answers `ReportsView`: the tiles and the same report.
- The server keeps the last three reports (`METRICS_KEPT`), keyed by the period, `Ledger.changeStamp()` and the minute. Home, Reports and the metrics route share them.
- `changeStamp` is `PRAGMA data_version` and `total_changes()`, so another connection's commit, or the server's own write, builds the report again.
- The Reports screen (`web/src/screens/reports.tsx`) is `#reports`, with `?period=30d` or `?period=all` in the address. Three period buttons carry `aria-pressed`. `#metrics` redirects to `#reports`.
- Reports polls `GET /api/reports` 30 seconds after the last answer or failure. It keeps the shown period on screen until another period's answer lands, and says that one is loading.
- Reports shows the tiles, the ledger-wide audit card and the eight tables (`ReportTables`). A period with nothing at all in it says so and offers the period since the ledger started.
- `pnpm metrics [7d|30d|all] [json]` opens `payonce.db` read-only, loads no `.env`, and prints each table in the page's order in its own words, with the period's bounds as ISO times in UTC. With `json` it prints the route's answer through `printableJson`.
- `pnpm metrics` refuses a missing file and a file `schemaGaps` finds gaps in, and says to restart `pnpm ui` or run `pnpm board` once, which upgrades it.
- The MCP `metrics` tool takes an optional `period` and answers `reportsView`: the tiles and the report. `REPORTS_FIELDS` (in `src/views/outside-fields.ts`) lists its plain paths, the tiles' three fields and the four label paths. Every other string is a token, so nothing in its answer is wrapped.

## Why

- Each table names its own time because a payment, a failure and a close happen at different moments. Each counts by the time it names, so the tables do not add up to each other.
- Ledgers written before the time columns have rows with no time, and `notOnFile` and `leftOut` count them beside the table. Counting them there says how much a figure leaves out, instead of putting a row in a period it may not belong to.
- The report never adds money across currencies. PayOnce has no exchange rates, so a total across wallets would be a number with no meaning.
- The report holds only fixed strings because it goes to the page, the terminal and an MCP client. With only codes, numbers and fixed labels, no name, reference, reason text, email or Airwallex message can reach any of them, and the MCP answer needs no wrapping.
- The reasons table counts by family instead of by reason, because a family is a fixed set the labels cover. A reason from an older PayOnce, or a reworded constant, shows up as `other` instead of being guessed.
- Every JSON read is wrapped in `json_valid` because SQLite evaluates both sides of an AND, and a JSON function throws on text that is not JSON. Without it, one bad row would fail the whole report.
- The report is cached by the change stamp and the minute. Durations still running and requests open now move with the clock, so a cached report is kept for at most a minute even when nothing was written.
- A refusal with no code is still a refusal, since `refused_at` is written on every refusal and tells a 4xx without a code apart from an attempt Airwallex never created.

## Edge cases

- In a ledger from before `refused_at`, a refusal with no code counts as never created, because only its code shows it was refused.
- An original PayOnce marked failed and then found late counts toward the first failure only once the bank has failed its transfer too, and then with no time on file, because its `failed_at` is PayOnce's mark.
- In a ledger from before the time columns, rows already in a state when its column was added hold `''`, a time not known, and count in `notOnFile` ([ledger.md](ledger.md)).
- When a `duplicate_of` or the terms are not JSON, `json_valid` keeps the row and reads nothing from the bad value, and every period still answers.
- A stored code such as `toString` or `constructor` gets no label, and in the failures table it counts as `other` unless it is five digits.
- When reason codes do not render the text, as when an older PayOnce rewrote the reason, the text is parsed instead, and the first such row in a process logs one warning.
- A held duplicate released and paying counts as released, not still held.
- An invoice called `metrics` has its page at `#incident/metrics`, and `#metrics` goes to Reports.
- With no reconciliation tables yet, the breaks table has `ran: false` and no rows.

Dated checks: [verification/metrics.md](../verification/metrics.md).

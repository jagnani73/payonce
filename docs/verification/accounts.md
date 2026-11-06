# Accounts: dated checks

How the rules in [design/accounts.md](../design/accounts.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-11-03: the route key rebuild (`rebuildRoutes`) on a copy of the main ledger

On a copy of the main ledger the rebuild keyed both checked attempts, and one look per open invoice under main and under this code wrote the same approvals, terms, bindings and lines, byte for byte. Live requests and approvals made by main's code kept their bindings, and the approved ones were spent.

## 2026-11-03: a change to one bank details field, with stubbed Airwallex

Checked on 2026-11-03 with stubbed Airwallex: after a change to `bank_name` alone, new invoices, a replacement and a pay run row to the supplier were paid as before; after a change to `account_routing_type1` or `local_clearing_system` alone, the first payment was held, the replacement escalated, the run row was skipped and a transfer sent there was marked misdirected, as on main. On a ledger written by the six-field allowlist the route key first used, this code held the first payment and barred the callback's recorder.

## 2026-11-03: outside payouts and closes after rebasing onto main

Checked on 2026-11-03 after rebasing onto main, with Airwallex stubbed. An invoice a person had closed without paying stayed with a person when a payout naming it for 0.01 USD, or to another account, was paid, and PayOnce closed it again by itself only once such a payout failed. A 4,000.00 EUR invoice paid outside PayOnce from the USD wallet counted as paid, by an exact or a near reference. A payout to the invoice's own record with other bank details did not. Paid payouts tied by main's code were read once on the next look and judged, and outage payee counts matched main's for every change to the bank details.

# Accounts: dated checks

How the rules in [design/accounts.md](../design/accounts.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-11-03: the route key rebuild (`rebuildRoutes`) on a copy of the main ledger

On a copy of the main ledger the rebuild keyed both checked attempts, and one look per open invoice under main and under this code wrote the same approvals, terms, bindings and lines, byte for byte. Live requests and approvals made by main's code kept their bindings, and the approved ones were spent.

## 2026-11-03: a change to one bank details field, with stubbed Airwallex

Checked on 2026-11-03 with stubbed Airwallex: after a change to `bank_name` alone, new invoices, a replacement and a pay run row to the supplier were paid as before; after a change to `account_routing_type1` or `local_clearing_system` alone, the first payment was held, the replacement escalated, the run row was skipped and a transfer sent there was marked misdirected, as on main. On a ledger written by the six-field allowlist the route key first used, this code held the first payment and barred the callback's recorder.

## 2026-11-03: outside payouts and closes after rebasing onto main

Checked on 2026-11-03 after rebasing onto main, with Airwallex stubbed. An invoice a person had closed without paying stayed with a person when a payout naming it for 0.01 USD, or to another account, was paid, and PayOnce closed it again by itself only once such a payout failed. A 4,000.00 EUR invoice paid outside PayOnce from the USD wallet counted as paid, by an exact or a near reference. A payout to the invoice's own record with other bank details did not. Paid payouts tied by main's code were read once on the next look and judged, and outage payee counts matched main's for every change to the bank details.

## 2026-11-10: the account name leaves the route key (`r3`)

Checked on branch `fix/name-free-route`, with Airwallex faked by the replay rig, and on a copy of the final rehearsal ledger.

- rig-v7, main 620860c against the branch: 354 files compared, 40 differ, 377 differences, all in `db.json`. 325 are stored route keys going from `r2:` to `r3:`. They form 61 key pairs, one to one within each journey, so every route that matched still matches and no new match appears. 40 are `meta.route_scheme`. 12 are in the smoke ledger copy, where the rebuild left the EUR supplier's keys null because no callback kept its details. Every view, CLI output, MCP answer, alert and bank call was the same. The fake bank gives every record a fingerprint of all its fields, the name included, so no route match changed in those journeys.
- rig-v8 adds six journeys, run on main and on the branch. The records carry no fingerprint, as on the sandbox's USD records, except in the last one.
  - A New payment for `INV-107001A` through a second record for Payee A's account, under "Acme Holdings Ltd", is held as a second bill of `INV-107001`, and `INV-0107001` for another amount is held for the same number. On main `INV-107001A` went out on its routine approval and was paid.
  - Through a pay run, a number on file is skipped, a likely second bill is a pay row held when it is sent, and a second bill of an earlier row is skipped. On main all three went out.
  - The control, a second record under the same name, behaves as on main.
  - An account name changed after an approval was given and before it was used voids it. Nothing is sent, and the new request's approval sends. Main does the same.
  - A timeout after a name-only change is replaced without a person, to the same account number. On main it waited for a callback.
  - With the fake bank's fingerprint over the name, the second record stays a second route, as on main.
- The ledger copy opened with the branch: `meta.route_scheme` became `r3`, and all 24 route columns matched routes recomputed from the callback's details. 18 got `r3:` keys and the EUR supplier's 6 stayed null. `pnpm run audit` found every chain intact. `pnpm board` and `pnpm supplier`, for all records and each one, printed the same as main on the same copy.

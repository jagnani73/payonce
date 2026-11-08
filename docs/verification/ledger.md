# Ledger: dated checks

How the rules in [design/ledger.md](../design/ledger.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-11-08: stored terms against their bindings (`requestTerms`, `runRequestTerms`)

Every approval request on file hashes to its binding: all 83 rows in the rig baseline of main 5db2ff4 (both real ledgers' rows included) and the 11 and 9 rows of the two real ledger copies, `approvals` and `run_approvals` alike, so the check voids none. With Airwallex faked, a held payment whose `approvals.terms` were edited after its approval failed its look with "PayOnce cannot read the terms of approval request 1 for INV-102701 in the ledger, so it stops here and sends nothing" and sent nothing, and a pay run whose `run_approvals.terms` were edited was not released. On a copy of that ledger, `releaseFor`, `useApproval` and `RunStore.releaseRun` each threw `StoredShapeError` inside their transaction and changed nothing, and `releaseFor` spent the approval once the terms were put back.

## 2026-11-07: the stored shapes against every row on file (`store/stored.ts`)

Shapes accept every version on file: a replacement's terms may lack `accountKey` (rows before 2026-10-28) and `evidence.emails` (the first terms), and `evidence.bankChange` may be missing or null; held terms always have `accountKey`; findings may lack `asksNotToPay`, `emailsRead`, `unread`, `unverifiedSenders` and `readBy`. Checked against all 73 approval rows and every findings and last_quote row in the rig baseline and both real ledger copies.

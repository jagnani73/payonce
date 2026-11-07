# Ledger: dated checks

How the rules in [design/ledger.md](../design/ledger.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-11-07: the stored shapes against every row on file (`store/stored.ts`)

Shapes accept every version on file: a replacement's terms may lack `accountKey` (rows before 2026-10-28) and `evidence.emails` (the first terms), and `evidence.bankChange` may be missing or null; held terms always have `accountKey`; findings may lack `asksNotToPay`, `emailsRead`, `unread`, `unverifiedSenders` and `readBy`. Checked against all 73 approval rows and every findings and last_quote row in the rig baseline and both real ledger copies.

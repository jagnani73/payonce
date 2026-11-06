# Rail outages: dated checks

How the rules in [design/rail-outages.md](../design/rail-outages.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-10-28: an outage declared, held and ended against the sandbox

Found by running it on 2026-10-28 (UTC; 2026-10-29 local), on a fresh worktree ledger with `WEBHOOKS=off`, `RESERVE_FLOORS=USD:1000000,EUR:1000000`, `APPROVERS=Alex:10000,Sam:5000,Yash:50000`, the default rule and a loopback mock receiver:

- Two payouts sent outside PayOnce to two USD LOCAL beneficiaries with different accounts, P261028-F9233YT (CHANNEL_TIMEOUT, failed 20:39:28) and P261028-KC0JY2L (SYSTEM_ERROR, failed 20:40:03), were recorded by the sweep 16 and 11 seconds later as one payee each. A `usd-local` incident's original P261028-V7DL95U then failed with CHANNEL_TIMEOUT at about 20:42:25, and the look that read it declared outage 1 on USD LOCAL with codes 91401 and 91402. The same look escalated the replacement with `OUTAGE_REASON` and opened a one-approver request whose terms carried the replace reason. The mock got one "Outage declared on USD LOCAL" post 12 seconds later.
- A new `usd-local` incident started during the outage opened no attempt, got the hold and waiting lines and was listed as `waiting-outage` on the cash panel. Alex's approval of the replacement stayed `approved` and unspent across the one-minute rechecks, and the waiting line named it. An end by a name outside `APPROVERS` was refused with 403.
- `pnpm outage end 1 Alex ...` from the terminal ended it at 20:48:11 while the server ran. Two seconds later the server sent the waiting original (P261028-BDR879Z) and the replacement on the same approval (P261028-XZH7DK4, `approval_id` 2). The sandbox bank paid both and both incidents closed. Pay again was refused by the duplicate lock on each. The mock got one "Outage on USD LOCAL ended" post, which named neither Alex nor the note. Five transfers in all, and `pnpm run audit` verified the chain.
- The ended alert's line ran past the 200 characters a line part is cut at, so the lines now give codes without labels and times without dates; the fields keep both.

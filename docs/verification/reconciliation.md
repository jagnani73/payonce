# Reconciliation: dated checks

How the rules in [design/reconciliation.md](../design/reconciliation.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-11-03: checks against a stub of the probe answers

Checked on 2026-11-03 against a stub of the probe answers (`P4b` history, `P10` transfers, `P7` balances) through a test-only fetch hook on `https://sandbox.invalid`, on ledger copies:

- A copy of the main ledger: the first check opened refund missing for P261028-GO7IJME and P261028-KC0JY2L and found 17 payouts tied to no invoice once, and the second opened those 17. USD added up from 9,928,000.00 to 9,882,869.17, Airwallex's available balance. INV-528160's paid replacement gave no break. Dumps of every invoice table, approval, binding, timeline, the board and the cash panel were byte-identical before and after two checks, an offline match and two explanations, and the one open approval's binding matched the main ledger's.
- On the seeded copy with 5,000 settled invoices and a stub of 5,032 transfers and 5,045 movements, a check's commit (store, match, record) took 110 to 118 ms, and its 64 GETs to the local stub about 400 ms. The report took 2 ms and the movements view 85 ms. After the fixes below, on a slower moment of the same machine, the commit took 141 to 150 ms, against 126 to 204 ms for the code before them on the same copy at the same time.

## 2026-11-03: fixes before the merge

Fixed before the merge and checked on 2026-11-03 the same way, each case before and after on its own copy:

- A payment that was paid and came back stays open for a person after a look records it failed: on a copy of the main ledger after two real sandbox runs, P261028-2IURNV2 on inv-0528160 failed in the stub, opened on the second check and stayed open once its attempt read failed, where it used to clear with "PayOnce's records now explain it". The same held for P261028-ZG94RYT on OUT-771204, cancelled with a reversal. A debit counted twice and a debit that differs stay open, marked no longer found, when the extra or changed debit drops out of the history.
- A lookup refused with 400 no longer fails every check: the check records the movement as waiting and asks once in ten minutes, and a 429 still stops it. `pnpm reconcile offline` right after the first check opens none of the 17 payouts found once, and offline 20 minutes after a failed transfer's read leaves its refund waiting. A balance that differs opens on the second check. A transfer kept beside an attempt counts apart, with its own wording. With 600 unexplained deposits the report and the alert count 619 open breaks, not 500. An unreadable debit no longer opens a debit-missing break or clears its payout's untied break. With Airwallex's range start exclusive, a movement on a full read's edge more than seven days back is kept.
- Deleting every reconciliation line and the running hash, then opening the ledger, fails `pnpm run audit`, and `audit:recon` posted "lines removed from its start" to a loopback receiver. A rewritten line posted "broken from line 3". Deleting the last line and recomputing the running hash still passes, as it does for every chain.
- The main ledger copy still gave refund missing for P261028-GO7IJME and P261028-KC0JY2L, 17 payouts tied to no invoice and no break on a paid payment, and its dumps were byte-identical before and after two checks, an offline match and 17 explanations.
- The alert names the break whose line raised it. On a copy of the main ledger the second check opened the 17 payouts found once, and the alert it queued named P261028-O6T855P, break 18, whose found line was the newest. Before, it named refund missing for P261028-GO7IJME, break 19, opened on the first check.
- An offline match no longer counts as one of the two checks. On a copy of the main ledger, after two checks, the tie of OUT-771204's payout was deleted from the ledger. The offline match after that recorded nothing, the next check found the untied payout once, and the check after that opened it. Before, the offline match found it once and the next check opened it. A found-once row with new facts in the stored record now keeps its old facts through an offline match and opens two checks later. Before, the offline match took the new facts and the next check opened it.

## 2026-11-08: the rehearsal's missing refund, the wallet card and the next check

Checked on 2026-11-08 with no Airwallex call, on a copy of the 8 November dress rehearsal's ledger and on a server against the replay rig's fake bank:

- The rehearsal's copy holds one open break: refund missing for P261108-WOU3MC3 on INV-RUN-1002. `alertState` over every kind counts it, and over the kinds that wait on a person counts nothing, so no `recon` condition stands. The rehearsal had posted "1 wallet movement needs a person" for it.
- Served from that copy, the Reconciliation tab reads "No breaks need a person". Clearing by themselves lists "Transfer P261108-WOU3MC3 failed, and 980.00 USD has not come back to the USD wallet." with USD, INV-RUN-1002 as a link, the reference and when it was found. The USD card reads "7 movements · 1 break clearing by itself", and the −980.00 USD payout in its movements is tagged "break 1".
- The Cash tab's USD worksheet lists the same transfer under "Not back from failed transfers", marked for information, and no figure on the tab moved.
- With `RECON_EVERY_MINUTES=10`, the next check read 07:37:54 UTC before a Check now and still read 07:37:54 after the Check now at 07:29:13, which is when the timer ran next. The last check plus ten minutes would have read about 07:39.
- Replay rig, `base-cf7b5c1` against `rehearsal-3`: 309 files compared, 93 differ, 713 differences, all in routes, transcripts and MCP answers. They are the wallet cards' `breaks`, the cash view's `refundsMissing` (empty in every journey), `nextCheckAt` in `reconciliation`, `ledger-main-copy` and `ledger-smoke-copy`, and the payment page's supplier cautions. No ledger, bank, alert or CLI output changed.

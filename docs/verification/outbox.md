# Outbox: dated checks

How the rules in [design/outbox.md](../design/outbox.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-10-28: each template, its refusals and the hash warning

Checked on 2026-10-28 on copies of the main ledger: each template was offered in its situation and refused with 422 outside it; a second draft of one template was refused with the open draft's id; setting the payment paid in SQL showed "the payment status changed from in flight to paid", and failing the trace's payment showed it no longer fits; editing a body in SQL showed the hash warning while `pnpm run audit` still verified the chain, with the original hash on the created line; marking sent twice, and dismissing after sent, were refused. No stored draft held a supplier name, an email address, a reason or more than the last four digits of the phone number.

## 2026-11-03: the refund trace request

Checked on 2026-11-03 on copies of a ledger after two real reconciliation runs, with no Airwallex call: `pnpm outbox INV-528160` suggested `refund-trace` for P261028-GO7IJME, the draft gave the reference, 4,000.00 USD, LOCAL, 28 October 2026 and FAILED, and its hash line landed on the timeline with `pnpm run audit` still verifying. After break 19 was explained, the draft said a person had explained it and a new one was refused. With the break cleared in SQL, the draft said reconciliation no longer found the refund missing. A draft marked sent with the same facts was not offered again. Through the route, an invoice with no such break got 422 and a name with U+202E got 400. With markup, a phone number, bidi characters and an instruction seeded into the supplier name, the escalation reason, the payout reference, `started_by`, the phone on file, the emails, the attempt's failure code, status and mismatched reference, and the break's facts and note, the draft was byte for byte the clean one. With the attempt's reference, the stored transfer's status and method and the break's currency seeded too, it took the stored transfer's short reference and left the amount and status out, and with no reference left it was refused. No draft held a seeded string.

## 2026-11-03: in review, the break lookup and the method line

Checked again in review on 2026-11-03, on copies of the same ledger: with 200,000 breaks seeded into `recon_breaks`, `refundBreaks` took 31 ms by `transfer_id` and 0.12 ms by key, and found the same breaks in every case. A transfer kept beside another invoice's attempt, a payout sent outside PayOnce, another invoice's transfer and a pending break got no offer. A rejected invoice got one. With the invoice's method edited to markup in SQL, both bank drafts carried it before and left the method line out after.

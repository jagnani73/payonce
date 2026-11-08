# Alerts: dated checks

How the rules in [design/alerts.md](../design/alerts.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-10-28: posting against a mock receiver

Found by running it on 2026-10-28, against a mock receiver on 127.0.0.1:

- A copy of the main ledger recorded 20 standing conditions on the first check and posted one summary. A held FX incident started on the page was posted 10 seconds after it was held, once. A pay run uploaded with `pnpm payrun upload` while the server and a second sender ran the alert loop on the same file was posted once, by the process that won the claim.
- Two senders racing on one ledger copy while a third process escalated five invoices posted each alert once, and the first-run summary once.
- Supplier names carrying links, Slack and Discord markup, mentions, 300 emoji, and the longest a run file allows (40,000 characters of `<&>`, backticks and markdown characters) all posted in both formats to a mock that refuses anything over the documented limits. The longest field was 606 characters on Slack and 600 on Discord, and no post held a live link but the local page's.
- On a ledger copy, a sender read A's condition as gone, another process then recorded it back to A, and the sender marked A skipped, so A stood with no alert. With the check inside the skip `UPDATE`, A posted once whether the other process wrote just before the check or just after it, both in the ledger calls and through `Alerts.flush` to a mock receiver.
- On a ledger copy, with another connection holding the write lock, an alert check that found nothing new took about 2 ms. Before `recordConditions` and `claimAlert` read first, each waited out the 5 second busy timeout and threw `database is locked`.

## 2026-10-29: the inbox alert

Checked on 2026-10-29, after the merge with the inbox: an uploaded email was posted once as "1 supplier email waits in the inbox", a second upload as "2 supplier emails wait", and dismissing one posted nothing. No post held the sender, the display name, the subject or the text. With the alert tables emptied, the first check's summary counted the email still waiting.

## 2026-10-29: a held invoice and the ask not to pay

Checked on 2026-10-29 on ledger copies, with Airwallex stubbed and the keyword reader: a held invoice's alert gave its reason as "supplier emails arrived before the first payment, so a person reads them before PayOnce pays it". After a "please hold" email, a new request opened and the mock got a second alert ending ", and the supplier asks to hold, cancel or not pay this invoice". Alerts turned on with nothing waiting queued no summary, and a hold after that queued its own alert.

## 2026-11-08: breaks that clear by themselves, and the callback's second alert

Checked on 2026-11-08 on a copy of the 8 November dress rehearsal's ledger, with no Airwallex call:

- The rehearsal posted "1 wallet movement needs a person" for refund missing on P261108-WOU3MC3, 9 minutes after the morning's setup, while the Reconciliation page listed it under Clearing by themselves. On the copy the `recon` condition no longer stands: the only open break clears by itself.
- The rehearsal also posted "INV-931567 needs an approval" twice. The first was for the replacement to the account on file, needing one approver. The second came after the callback, for the new account, needing two, with the Account field. Their fingerprints differ in `accountKey` and signoffs, as the rules say, so the second alert stays.
- In the replay rig's `reconciliation` journey every break that opens waits on a person, and its `alerts.json` and stored conditions are unchanged.

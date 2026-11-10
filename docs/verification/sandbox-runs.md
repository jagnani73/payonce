# Sandbox runs: dated checks

These are the runs of PayOnce against the real Airwallex sandbox. They made real API calls and real sandbox transfers, and the sandbox's own simulator played the bank. Most other notes in this folder checked one topic's rules on a copy of the ledger with Airwallex stubbed or faked, and these runs faked nothing. Each `P261108-...` reference is Airwallex's short reference for a transfer.

## 8 November 2026: three runs, 17 transfers

All times are UTC. Each run started `pnpm ui` from a clean checkout of main, on an empty ledger, with the approvers and floors [demo.md](../demo.md) gives (`APPROVERS=Yash:50000,Alex:10000,Kim:10000,Sam:4200`, `RESERVE_FLOORS=USD:1000000,EUR:1000000`) and the other approval settings at their defaults. The start-up log of each server read "Webhooks are off. Payments in flight are checked every 3 seconds". Alerts went to a test receiver on 127.0.0.1 (`ALERT_TEST_RECEIVER_URL`), not to Slack. Runs 1 and 2 shared one server and one ledger. Run 3 started again from an empty ledger at a later commit.

Every transfer in these three runs was read back from Airwallex by reconciliation, with GETs only, in the status the ledger had for it. Every movement in the USD and EUR wallet history was tied to one of these payments, and each wallet added up to Airwallex's available balance.

### Run 1: dress rehearsal, 06:35 to 06:55 UTC, main at cf7b5c1

What ran: `node scripts/demo-morning.mjs`, then every beat of [demo.md](../demo.md) on the page. The setup took 43 seconds and left three payments waiting for a person, as the script says it should. The pay run's third row, INV-RUN-1002A, was skipped as a likely second bill and sent nothing.

| Invoice | Transfer | What happened |
| --- | --- | --- |
| INV-RUN-1001, 1,250.00 USD, pay run | P261108-M3YV4NV | Failed, 91402 channel timeout |
| INV-RUN-1001 | P261108-KHIXVOO | PayOnce's own replacement, paid |
| INV-RUN-1002, 980.00 USD, pay run | P261108-WOU3MC3 | Failed, 90701 account closed. Waits for a person |
| INV-931567, 4,000.00 USD | P261108-H1C0YA1 | Failed, 90701 account closed |
| INV-931567 | P261108-NT8URI2 | Replacement to the account a callback verified, approved by two people, paid |
| INV-843590, 4,000.00 EUR, SWIFT | P261108-IEOTB3D | Failed, 91402 channel timeout. Airwallex kept the 14.03 EUR fee |
| INV-843590 | P261108-FTR2Q55 | Sent to a person by the floor check, approved, paid |

One failed transfer was never reversed. P261108-WOU3MC3 failed at 06:35 and stayed `FAILED`, never `CANCELLED`, and its 980.00 USD had still not come back at the last reconciliation check on that ledger, at 07:24. Reconciliation opened a refund-missing break for it. The other failures went from `FAILED` to `CANCELLED` and were reversed within seconds. [design/sandbox-behaviour.md](../design/sandbox-behaviour.md) records this.

What broke: seven page and alert problems. A reconciliation alert reported that refund as needing a person while the page listed it as clearing by itself. The USD card read "no breaks" beside a movement tagged as a break. A supplier caution named "Account A" and showed one of two accounts. The callback's note field cut off the typed note, a skipped run row showed a tick, and the next check time ignored the timer. After a signoff, Approving as moved to another person's name. All seven were fixed on `fix/rehearsal`, merged at a9fd3a9, with the script matched to what the run showed.

### Run 2: the rest of the product, 07:00 to 07:25 UTC, same server

What ran: the screens and tools the demo does not show. On the page, New payment (with supplier emails uploaded through the Inbox from the supplier's own domain and from a look-alike one), Ask why, Incidents, Settings, Reports, and the page at phone width. Then a second pay run, a change to a supplier's phone on file, Treasury, every MCP tool, and the CLI commands on a copy of the ledger.

| Invoice | Transfer | What happened |
| --- | --- | --- |
| INV-OPS-2101, 12.00 USD, pay run 2 | P261108-GCD4T3A | Paid |
| INV-OPS-2202, 23.00 USD, pay run 2 | P261108-3JWOSDH | Paid |
| INV-995544, 50.00 EUR, SWIFT, New payment | P261108-G0W8VN0 | Approved by someone other than the starter, paid. 14.03 EUR fee |

A second new payment, INV-486112 for 75.00 EUR, was closed without paying and sent nothing.

What matched: the check at 07:24 found all 10 transfers from runs 1 and 2 in Airwallex with the ledger's statuses, and tied all 16 wallet movements to PayOnce's payments. `pnpm run audit` found 8 invoices, 2 pay runs and reconciliation's chain intact. The receiver got 14 alerts across runs 1 and 2, and none named an approver, an account or a phone number.

The sandbox moved the two pay run 2 rows from `SCHEDULED` to `PAID` about a minute after they were sent, and the ledger never saw them in `SENT`.

What broke, and the fixes:

- One money gap. Someone who recorded a callback could approve a pay run row that paid the account their own callback verified, because the bar covered only rows that carried the bank change. Invoices and pay run rows now share one rule (`callbackBars`). The same change gives a run row to an account that just failed with an account-level code a caution and a second approver. Merged at 6a9d663.
- New payments had no email domain on file, so the sender check never ran on them, and a look-alike sender got the same line as the real one. A new payment now takes its supplier record's domain. A second bill sent to another supplier record with the same bank details was not held; the second-bill checks now count those records too. Merged at 9449647.
- A held new payment to an account that had just failed with an account-level code got no caution. It now gets one and needs two approvers. Merged at 9a1d117.
- Wording and layout problems on the page, the CLI and MCP, such as an email on a closed payment that said PayOnce would read it at its next check, approval lines that folded away, and tables that scrolled sideways at phone width. Merged at 536488d.
- The simulator's retries read like bank errors on a payment's timeline, and a phone number typed wrong by the second person left no trace. Simulator lines now have a kind of their own, and a mismatched re-key writes a timeline line and sends an alert. Merged at 5c58281.

### Run 3: final rehearsal, 10:52 to 11:05 UTC, main at 5c58281

What ran: a clean checkout with every fix above, an empty ledger, then the setup script and every beat of [demo.md](../demo.md) as written. The setup took 41 seconds.

| Invoice | Transfer | What happened |
| --- | --- | --- |
| INV-RUN-1001, 1,250.00 USD, pay run | P261108-8DFNAWL | Failed, 91402 channel timeout |
| INV-RUN-1001 | P261108-Y2XMLME | PayOnce's own replacement, paid |
| INV-RUN-1002, 980.00 USD, pay run | P261108-EVXF1KR | Failed, 90701 account closed. Waits for a person |
| INV-602174, 4,000.00 USD | P261108-THG24WV | Failed, 90701 account closed |
| INV-602174 | P261108-B6DZFHZ | Replacement to the account a callback verified, approved by two people, paid |
| INV-239819, 4,000.00 EUR, SWIFT | P261108-OP4J9Z6 | Failed, 91402 channel timeout. Airwallex kept the 14.03 EUR fee |
| INV-239819 | P261108-X9A9E4E | Sent to a person by the floor check, approved, paid |

What matched: the last reconciliation check, at 11:02, found all 7 transfers in Airwallex with the ledger's statuses, tied all 13 wallet movements to them, and opened no break, because this time the sandbox reversed all four failed transfers. `pnpm run audit` reported 79 lines across 4 invoices and 9 lines on the pay run, all intact, with both running hashes matching. The receiver got 4 alerts, and none named an approver, an account or a phone number.

The verdict was to record the script as written, with a few edits, merged at 15f32d8. Beat 6 no longer says each invoice was paid once, since INV-RUN-1002 was not paid. The preparation now says to turn off Grammarly and other writing extensions, which drew icons in the callback's note field. The other edits reword the opening and beats 0, 1 and 2. One view changed too: the floor's cost warning on the EUR payment had been folded away as a system line, and now shows at full weight (54386fd).

## Earlier runs

PayOnce also ran against the sandbox while its features were built, before the rebuild of 6 to 8 November:

- 28 October: bank detail updates, exchange rate quotes, bank deadlines, payouts sent from the Airwallex web app, pay runs, a rail outage declared and ended, and webhook delivery. The dated notes are in [sandbox-behaviour.md](sandbox-behaviour.md), [rail-outages.md](rail-outages.md) and [webhooks.md](webhooks.md).
- 3 November: a run through the page of the whole product as it was then, with 12 transfers. It found no money bug. One EUR SWIFT create got a `400 fee_unknown` that was gone by the afternoon.

## Not tested in these runs

- Webhook delivery. All three runs on 8 November had `WEBHOOKS=off`, and the status check found every change. In the runs on 28 October Airwallex created an event for every status change and left each one queued. None was ever attempted, and the web app's Send test event delivered nothing either ([webhooks.md](webhooks.md)). Delivery was not tried again on 8 November.
- A payment from another currency's wallet. The simulator refuses to move a transfer that converts, so the runs on 8 November made none. On 28 October a USD-to-EUR transfer went out on its approved quote and stayed in `PROCESSING` ([sandbox-behaviour.md](sandbox-behaviour.md)).
- Rail outages and payouts sent from the Airwallex web app. Neither came up on 8 November. Both were run on 28 October.
- Slack. Alerts went to the local receiver.
- Real banks and real money. In the sandbox the simulator plays the bank, and PayOnce's sandbox bank tells it what to do ([design/sandbox-behaviour.md](../design/sandbox-behaviour.md)).

# Sandbox behaviour: dated checks

How the rules in [design/sandbox-behaviour.md](../design/sandbox-behaviour.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-10-28: updating a beneficiary's bank details

- Run on 2026-10-28: `POST /api/v1/beneficiaries/{id}/update` with the GET record's `beneficiary` (without `fingerprint`), `nickname`, `payer_entity_type` and `transfer_methods` was accepted. Airwallex rewrote `bank_name` from the routing number ("Bank of America" became "Bank of America, NA"), so the read-back compares only the fields that say where money goes. The next transfer to the beneficiary went to the new account.

## 2026-10-28: the balance while a transfer is in flight

- Run on 2026-10-28: `reserved_amount` and `pending_amount` in `GET /api/v1/balances/current` read 0 in USD while a 4,000 USD transfer was in `SENT`. Money in flight cannot be read from the balance, so the panel takes it from the ledger.

## 2026-10-28: transfer notification emails

- Airwallex emails the account owner for every sent and cancelled transfer unless transfer notifications are turned off under Settings > User settings > Notifications. On 2026-10-28 the email for cancelled transfers was turned off there. Sent, overdue reminders and the daily summary of scheduled transfers were already off.

## 2026-10-28: FX probe

- FX probe on 2026-10-28. `POST /api/v1/fx/quotes/create` takes `sell_currency`, `buy_currency`, `buy_amount` and `validity`, and the sandbox requires `validity`. Quotes are `MULTI_USE`, and `GET /fx/quotes/{id}` returns the same body after expiry and after use. A transfer with `source_currency` USD, `transfer_currency` EUR and a `quote_id` was accepted with the usual body. It carries `conversion: { currency_pair: "EURUSD", rate }` with `rate` equal to the quote's `client_rate`, `source_amount` equal to the quote's `sell_amount`, and a fee in the source currency (15.60 USD for SWIFT, `SHARED`, and 15.59 on a later run). USD `available_amount` fell by `amount_payer_pays` at creation, and EUR did not move.

## 2026-10-28: the simulator refuses converting transfers, then every transition

- The simulator returns `500 operation_failed` for every transition of a transfer that converts (`SENT`, `PAID`, `FAILED`, `CANCELLED`), across 13 minutes. The probe's two transfers, `P261028-O6T855P` (`FX-PROBE-A`) and `P261028-937JTEB` (`FX-PROBE-B`), stayed in `PROCESSING`. From about 12:27 UTC the same day the simulator refused same-currency transitions too, until about 15:00 UTC, when they worked again. Nobody tried a converting transfer again after that. A failed converting payment and its replacement cannot be shown in this sandbox, and what a failure refunds was not observed. By Airwallex's docs, a converting transfer is refunded in the transfer currency by default, and the fee is not refunded.

## 2026-10-28: FX run with two-minute requests

- FX run on 2026-10-28 with `APPROVAL_TTL_MINUTES=2`: the `eur-from-usd` invoice was held, a request opened on an `HR_1` quote, and each 2 minute expiry opened a new request on a fresh quote. Sam, with a limit of 4,200, was refused on the 4,476.66 USD source amount. Alex's approval sent `P261028-71RA8Q0`: 4,476.40 USD at 1 EUR = 1.1191 USD plus a 15.60 USD fee, matching the approved quote. It stayed in `PROCESSING` and the invoice escalated at the 5 minute SWIFT deadline. The cash panel listed it under USD only.

## 2026-10-28: deadlines, outside payouts and the check before payment

- Runs on 2026-10-28. With the local deadline set to 1 minute, an original left in `SENT` escalated 63 seconds after it was sent. A failed payout made outside PayOnce was taken on within 30 seconds, and its approved replacement was paid and the incident closed 6 seconds after the approval. An outside payout made just before an approval was tied by the check before payment one second after the approval: the approval was voided and nothing was sent. When the bank paid that payout, the close card offered it.

## 2026-10-28: pay runs

Pay runs, checked on 2026-10-28 on a worktree ledger with hand-made invoices:

- `GET /api/v1/beneficiaries/{id}` answers 200 with an empty body for a well-formed id Airwallex does not have, and 400 `invalid_argument` for a malformed one. `findBeneficiary` treats a record whose `id` is not the one asked for as unknown. A record's `bank_details` carries `account_currency` and `account_name`.
- From about 12:27 to about 15:00 UTC the simulator answered `500 operation_failed` on every transition, so no paid or failed outcome could be seen for a run row in that time. A two-row run released at 13:33 waited 6 seconds for a USD lease another process held, then created P261028-NLOYLPE and P261028-OAM9OUA one after the other and held a third row as a likely duplicate. Both transfers stayed in `PROCESSING`, and both invoices escalated at their 3-minute deadline.
- By about 15:00 UTC same-currency transitions worked again: P261028-3JMKQFD moved to `PAID`. On the integration branch a pay run then paid one row (P261028-QO9B589) and failed another with `CHANNEL_TIMEOUT` (P261028-JY3VK1Q), and an automatic replacement (P261028-L968UVS) was paid. A converting transfer, P261028-C9NWDL7, went out on its approved quote and stayed in `PROCESSING`. The sandbox bank never asks the simulator to move a converting transfer, so nobody checked whether the simulator still refuses them.
- An automatic replacement that decided Replace, then waited for the lease while 1,000,000.00 USD was committed on another invoice, read the balance again under the lease and escalated with the floor reason, sending nothing.
- Merged build, checked on 2026-10-28 on a copy of the main ledger while the simulator was down. An `eur-from-usd` incident was held and a request opened on an `HR_1` quote at 4,476.44 USD, needing one approver. The cash panel listed it under USD, with the amount from the quote. A two-row pay run in USD and EUR reached its request, needing two approvers, and a file with a `source_currency` column was refused. Nothing was approved or sent.

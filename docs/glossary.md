# Glossary

The first part defines the words PayOnce shows people. The second defines the words a reader of the code meets, which people never see. Where a product word has a different name in the code, the entry says so.

## Product words

**Payment.** One supplier invoice that PayOnce pays once: a supplier, an amount, a currency, a transfer method, the wallet it is paid from and an optional due date. A person creates one, a pay run row becomes one when the run is released, or PayOnce makes one from a payout someone sent outside it that matches no payment on file. In the code a payment is an obligation.

**Invoice, invoice number.** The supplier's bill and the number on it. The invoice number identifies the payment.

**Incident.** Anything off the normal path for a payment: a failed or refused transfer, a replacement, a hold before paying, a time it went to a person, a payout sent outside PayOnce, an outage pause, an unrecognised or late transfer, or a close without paying. The approval every payment a person starts waits for before its first transfer is part of the payment, not an incident, so a payment that waits only for it has none. A payment paid by its first transfer never had one, whether or not it waited for that approval. An incident ends when the payment is closed. No table holds incidents; they are worked out from the ledger.

**Transfer.** One Airwallex transfer for a payment, shown by its bank reference, such as `P261103-77F2G5X`.

- **Original.** The first transfer for a payment.
- **Replacement.** A second transfer sent after the original failed. PayOnce sends at most one, by itself or on an approval.
- **Payout sent outside PayOnce**, or **outside payout.** A transfer someone made elsewhere, such as in the Airwallex web app, whose reference names a payment PayOnce knows or nearly matches one.
- **Unrecognised transfer.** A transfer Airwallex lists under one of PayOnce's request ids that does not carry the payment's number, amount and currency. The code calls it a mismatched transfer.
- **Late transfer.** A transfer Airwallex listed only after PayOnce had marked that attempt as never sent.

**Supplier, supplier record.** The supplier is the business being paid. A supplier record is PayOnce's view of one Airwallex beneficiary: its accounts, payments, callbacks, cautions and contact on file. "Beneficiary" is used only where a person picks an Airwallex record.

**Account.** The bank account money goes to, shown as the bank's name and the last four characters, such as `COMMERZBANK AG ···3000`. Two sets of bank details are the same account when their route keys match.

**Wallet.** An Airwallex balance in one currency. A payment is paid from one wallet. In the code it is the source currency (`sourceCurrency`, `debitCurrency`).

**Rail.** A currency and a transfer method together, written "USD local" or "EUR SWIFT". Outages are per rail.

**Approval request**, or **request.** PayOnce asking approvers to approve exact terms: who is paid, how much, to which account, at which exchange rate, and why. Requests are numbered, open for a fixed time, then expire. A request covers one payment, or one pay run. Its states are waiting for signoffs, approved, used, expired, replaced (a newer request with other terms took its place) and withdrawn (PayOnce withdrew it and none replaced it).

**Signoff.** One approver's yes to one request. A request needs one or two.

**Approval.** A request with all the signoffs it needs. An approval is spent once: on one payment, or on one pay run's release.

**Approver.** A name in `APPROVERS`, with a limit. An approver *can approve* a request when the name is on the list, the amount is within the limit, they are not barred, and they have not signed it already. *Barred* means they may not approve this payment, with a reason: they started it, recorded the callback for its bank details, or uploaded its pay run.

**Callback.** A phone call a person makes to the supplier's number on file to confirm new bank details, recorded with who called, the number, when, who they spoke to and what was confirmed. A callback is the only way new bank details enter PayOnce.

**Pay run.** A CSV file of payments checked and approved together, then released one row at a time. A row pays, is skipped with its reasons, or is not released. Pay runs are numbered.

**Outage.** PayOnce stopped opening new transfers on one rail because payouts to several payees failed there with rail-level codes in a short window. Outages are numbered, and only a person ends one.

**Pause.** An outage holding back a transfer PayOnce would otherwise send: a first transfer, an approved transfer or a pay run release.

**On hold.** PayOnce stopped before sending a payment's first transfer and is waiting for a person. The reason says why, for example that it looks like a second bill, that emails arrived before the first transfer, or that it is paid from another currency's wallet so a person approves the rate.

**Possible second bill.** A payment that matches one already on file: the same supplier and amount, and the same invoice number apart from case, spacing, leading zeros or letters added at the end. PayOnce also holds a payment whose number matches another invoice for the same supplier at any amount, because it pays an invoice number once.

**Close.** Ending a payment. There are two kinds. **Close as paid**: a person confirms a payment that PayOnce would not close by itself, such as one paid at a rate nobody approved or by an outside payout, and closes it. **Close without paying**: a person ends a payment and nothing is sent, and any open request is withdrawn. PayOnce **closes by itself** when one transfer is paid and nothing else for the payment is live. A closed payment shows as Paid or as Closed without paying.

**Reserve floor, headroom.** The reserve floor is the least a wallet must keep after any automatic replacement or pay run row (`RESERVE_FLOORS`). With no floor set for a currency, every automatic replacement goes to a person. Headroom is the available balance less the floor less money already promised. Headroom if approved also takes off money waiting on people.

**Promised, waiting on people, with the bank.** The three groups of money for a wallet. *Promised*: approved or being sent, and still in the balance. *Waiting on people*: would leave if someone approves or decides. *With the bank*: has left the available balance, and the bank has neither paid nor failed it. Fees kept on failed transfers are shown apart.

**Reserved by Airwallex.** Money Airwallex has set aside in a wallet, its hold movements in balance history. Only reconciliation shows it.

**Reconciliation, break.** Reconciliation is PayOnce matching every wallet movement in Airwallex's balance history to the transfers on file, without changing anything. A break is a movement PayOnce's records do not explain, or one that should be there and is not. Some clear by themselves, and a person explains the rest.

**Check.** PayOnce reading Airwallex and working out what to do for one payment. **Check now** asks for one at once. On a pay run, **re-check** runs every row's checks again and opens a new request if the old one expired or the terms changed. In the code a check is a look.

**Inbox, upload, deliver.** The inbox holds supplier emails a person uploaded that are not yet on a payment. Delivering an email puts it on a payment, which PayOnce then reads. Dismissing says it belongs to no payment.

**Messages, draft.** PayOnce drafts messages for a person to send to the supplier or to Airwallex. It never sends them. The code calls them the outbox.

**Sent to a person.** PayOnce stopped and handed the payment to people. In the code this is escalated.

**Needs you.** The group of payments a person can act on now: approve, record a callback, close, end an outage, trace a late transfer, decide.

**PayOnce is handling.** The group of payments PayOnce is moving by itself: sending, approved and about to send, renewing a request, queued in a pay run, starting.

**Audit trail.** The hash-chained record of every timeline line, per payment, per pay run and for reconciliation. It is intact when every chain and running hash checks out, and it exports as JSON or CSV.

**Sandbox bank.** The part of PayOnce that plays the bank in the Airwallex sandbox: it moves each payment it is told about through Airwallex's simulator (`src/engine/sandbox-bank.ts`). Scripted incidents (`src/engine/scenario.ts`) also play supplier emails. Neither exists in production, and the engine never reads the outcomes they play.

**Name.** PayOnce has no login. It runs on one machine, bound to loopback, and a name is a typed claim checked against the approver list and the barred list. Names take ASCII letters, digits, spaces and a few marks, and two names are one person when their letters, digits and spaces between words match, ignoring case.

## Words in the code

**Obligation.** A row of `obligations`: one payment, keyed by its invoice number (`invoice_id`). Its `state` is `open`, `escalated`, `settled` or `rejected`, and its `origin` is `payonce` or `outside`.

**Escalated.** An obligation's state while it waits for a person. Once an invoice is escalated, only a matching approval releases a payment for it.

**Settled.** Closed as paid.

**Rejected.** Closed without paying. `rejected_by` holds who closed it. A rejected invoice that gains a live payment is reopened as escalated, and PayOnce closes it again by itself once that payment fails.

**Held**, `heldBeforePaying`. An escalated obligation that has sent nothing: every attempt, if any, failed without a transfer. `duplicate_of` lists the invoices it looked like.

**Look.** One pass over an invoice: `resumeIncident` in `src/engine/look.ts`. It reads Airwallex, runs its steps in order, asks `decide` and acts, then saves the next look's time in `obligations.look_at`. `NextLook` is that time, or null when the invoice waits for news or a person.

**Step.** One of the look's ordered functions in `SENT_STEPS`, such as `holdIfPaidTwice` or `closeIfPaid`. A step ends the look with a next look time, or lets the next step run.

**Decide**, **the policy.** `decide` in `src/domain/decide.ts`: a pure function from an `Incident` to wait, replace, escalate or close, with a reason.

**Assessment.** What a look read before `decide`: the original transfer, the `Incident`, the email findings, the record's bank details, any verified callback, the quote and the floor clause (`Assessment` in `src/engine/engine.ts`).

**Attempt.** A row of `attempts`: one payment PayOnce opened for an invoice, an `original` or a `replacement`. It has a `request_id` from the moment it opens, and a `transfer_id` once Airwallex creates the transfer. Its `state` is `pending`, `in_flight`, `paid` or `failed`.

**Request id.** The UUID an attempt is opened with and sent to Airwallex as its idempotency key, so a retry cannot create a second transfer.

**Live**, `liveAtBank`. A payment the bank may still pay, or has paid: an attempt that is not failed, a transfer the ledger keeps failed while the bank does not show it failed, or an unrecognised transfer under the attempt's request id that the bank has not failed. `LIVE_ATTEMPT` is the same test in SQL.

**Duplicate lock.** The rule that an invoice has at most one live attempt: `insertAttempt`'s `LIVE_ATTEMPT` check and the unique index `one_live_attempt_per_invoice`.

**Kept failed.** An attempt the ledger keeps `failed` although the bank shows its transfer live, because another payment held the duplicate lock when it was recorded (`keptFailedLive` in `src/domain/live.ts`). It takes its own state once the lock is free.

**Mismatched transfer.** The code's name for an unrecognised transfer, kept in the `mismatched_*` columns of the attempt whose request id it came under. `mismatched_cleared_at` is set when a person's close covers it.

**Found late.** A transfer recorded on an attempt after PayOnce had marked it failed with none (`attempts.found_late_at`, `recordLateTransfer`).

**Outside payout.** A row of `outside_payouts`: a payout sent outside PayOnce, tied to an invoice. `pays` records whether the last look found that it pays the invoice.

**Gate.** `Ledger.openAttempt`, the one place an attempt opens. See [architecture.md](architecture.md).

**Lease.** The hold one payment has on a wallet's currency while it reads the balance, opens its attempt and records its transfer: a `currency_locks` row taken by `withCurrencyLock`. It runs out by itself after 60 seconds and is renewed while held. Waiters queue in `currency_lock_waiters`.

**Dispatcher.** The in-process queue that runs one step at a time per invoice (`src/engine/dispatcher.ts`). `wake` queues a look.

**The run's turn.** Permission for a look to send a pay run row's first payment (`LookOptions.runTurn`). Only the run's release and the server's watcher give it.

**Watcher.** The timer that wakes invoices whose look is due or whose transfer the bank moved, and in the server releases approved runs and runs the sweep (`src/engine/watcher.ts`).

**Sweep.** Listing every Airwallex transfer since the ledger started to find payouts PayOnce did not send, late transfers and unrecognised ones (`src/engine/sweep.ts`).

**Terms.** The JSON a request asks approvers to approve: `ReplacementTerms`, `HeldPaymentTerms` or `RunTerms`, built only by `termsFor`, `heldTermsFor` and `runTermsFor`.

**Binding.** SHA-256 of the terms' JSON (`bindingOf`). A signoff records the binding it approved, and an approval is spent only while the terms built at that moment have the same binding.

**Request**, `approvals` row. One approval request for an invoice, with its terms, binding, `needed`, `expires_at` and a `state` of `requested`, `approved`, `used` or `void`. Replaced and withdrawn are both `void`. A pay run's requests are `run_approvals` rows. Each approver's yes is a `signoffs` (or `run_signoffs`) row.

**Spend.** Moving an approval from `approved` to `used` in the transaction that opens its payment: `useApproval`, `releaseFor` or `RunStore.releaseRun`.

**Account key, route key.** Two hashes of bank details. The account key (`accountKeyOf`) covers every field and is what terms pin. The route key (`routeKeyOf`) leaves out fields that cannot route money, `bank_name` and `account_name`, and answers whether two sets of details go to the same account. It never goes in terms.

**Committed money**, `committedMinor`. Money promised to payments from a wallet that has not left its available balance yet. Every floor check takes it off.

**Reason, reason code.** Why an invoice went to a person. `escalation_reason` holds the text, and `escalation_code`, `escalation_clauses` and `escalation_slots` hold the same reason as codes (`Reason` in `src/domain/reasons.ts`). The text stays the record.

**Situation.** What a payment's state is and what a person can do about it, worked out once from a snapshot of the ledger (`situationOf` in `src/domain/situation.ts`). Views and alerts read it. The engine and the policy do not; the engine takes only `closeKindFor` from the same file, to say what kind of close a person is offered.

**Timeline line**, **event.** One line on an invoice's or a run's timeline, hash-chained. A line with a `topic` is a standing line: it says how things stand, and `note` skips it when the timeline already says the same.

**Running hash.** A hash folded over every line's hash in id order (`meta.events_head` and the two others), so lines removed from the end or a whole timeline removed still show.

**View.** A typed, read-only answer built from the ledger for the page, the MCP server or the CLI (`src/views/`, contract in `src/views/contract.ts`).

**Read soft.** Reading stored JSON so that a value that does not parse reads as none (`readingSoft`). Only views do this; payment paths read strictly.

**Pay again.** A demo action that tries to open a second payment to show the duplicate lock refusing it (`payAgain`, `Ledger.tryLock`). It always rolls back and never reaches Airwallex.

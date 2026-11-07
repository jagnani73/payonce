# Invariants

These are PayOnce's money guarantees. Each is one sentence, followed by where the code enforces it and the topic note with the details and the edge cases. Function names are the ones in the code, so each line can be checked with a search. [architecture.md](architecture.md) explains how the parts fit, and [glossary.md](glossary.md) defines the words.

A guarantee enforced "in SQL" is a condition inside the statement that writes, run in a write transaction (`BEGIN IMMEDIATE`). Two processes sharing the ledger, such as the server and a CLI command, cannot both pass it.

## Opening and sending a payment

1. Every payment attempt opens through `Ledger.openAttempt`, inside a write transaction, before Airwallex is called.\
   Where: `src/store/attempts.ts` `AttemptStore.openAttempt`, which throws outside a transaction; `insertAttempt` is private. Callers: `startPayment`, `replaceUnderLock`, `ApprovalStore.useApproval`, `ApprovalStore.releaseFor`. Details: [ledger.md](design/ledger.md).

2. An invoice has at most one live payment at a time.\
   Where: `AttemptStore.insertAttempt` refuses while `LIVE_ATTEMPT` finds one (`DuplicatePaymentError`), and the partial unique index `one_live_attempt_per_invoice` in `src/store/schema.ts` backs it. Details: [ledger.md](design/ledger.md).

3. A transfer the bank has live counts as live whatever state the ledger gives its attempt.\
   Where: `liveAtBank` and its SQL twin `LIVE_ATTEMPT` in `src/store/attempts.ts`, both built from `FAILED_STATUS_LIST` in `src/domain/assess.ts`. Details: [engine-rules.md](design/engine-rules.md).

4. Recording what the bank says never breaks the duplicate lock: a transfer that would become a second live attempt keeps its failed state and stores the bank's status beside it.\
   Where: `AttemptStore.record` retries the update without the state on a unique violation. Details: [ledger.md](design/ledger.md).

5. A transfer is created only under its attempt's `request_id`, so retrying an attempt can create at most one transfer.\
   Where: `sendAttempt` in `src/engine/payments.ts`, the only caller of `createTransfer`. Details: [engine-rules.md](design/engine-rules.md).

6. A refusal (a 4xx other than 429) fails the attempt, except that `duplicate_request_id` records the transfer it names and a retry of a cross-currency attempt stays pending while its quote can still pay; any other error leaves the attempt pending for a retry under the same request id and quote.\
   Where: `wasRejected` and `sendAttempt` in `src/engine/payments.ts`. Details: [engine-rules.md](design/engine-rules.md).

7. A pending attempt is marked failed without a refusal only when something else may pay the invoice or the record lost the attempt's account, and only once a bank deadline has passed since its last try with nothing listed under its request id.\
   Where: `failNeverSent` and `neverSentAt` in `src/engine/retry.ts`; `AttemptStore.failAttempt` changes only an attempt still pending with no transfer. Details: [engine-rules.md](design/engine-rules.md).

8. Every payment PayOnce creates holds the lease of the wallet it leaves from its last Airwallex read until its transfer is recorded.\
   Where: `withCurrencyLock` in `src/engine/currency-lock.ts`, taken by `startPayment`, `act` (automatic replacement), `continueEscalated`, `releaseHeld`, `retryUnderLock` and `failNeverSent`. Details: [engine-rules.md](design/engine-rules.md).

9. An attempt opens only while its caller still holds the lease, and only under the lease of the wallet the invoice pays from.\
   Where: `AttemptStore.openAttempt` calls `LockStore.requireLease` (`LeaseLostError`) and compares the lease's currency with the invoice's source wallet. The store does not check the lease again for a retry or a send, which rely on their callers. Details: [ledger.md](design/ledger.md).

10. No attempt opens and no pay run is released on a rail with an active outage, and an approval the outage stops stays unspent.\
    Where: `AttemptStore.openAttempt` and `RunStore.releaseRun` throw `RailOutageError`, which rolls back the caller's transaction. Details: [rail-outages.md](design/rail-outages.md).

11. Just before any payment, PayOnce lists the transfers again and ties any new payout for the invoice sent outside PayOnce; if one turns up, it sends nothing and looks again at once, except that a new invoice's original still goes out when the payout it tied has already failed.\
    Where: `linkUnseenPayouts` in `src/engine/outside.ts`, called by `startPayment`, `replaceUnderLock`, `continueEscalated`, `continueHeld` and the retry branch of `look`. Details: [engine-rules.md](design/engine-rules.md).

12. While a payout for the invoice sent outside PayOnce is live, PayOnce sends nothing for it and withdraws any open request.\
    Where: `decide` checks `outsidePayoutLive` first; `holdForOutsidePayout` and `holdPending` in the engine; `LIVE_OUTSIDE_PAYOUT` in the SQL of `useApproval` and `releaseFor`; the check in `replaceUnderLock`'s transaction. Details: [engine-rules.md](design/engine-rules.md).

13. A payout sent outside PayOnce counts as paying an invoice only when it is paid and a look found that it delivered the invoice's amount and currency to the account PayOnce would pay without a person; one PayOnce could not judge counts as not paying.\
    Where: `payoutVerdict` and `payoutPays` in `src/store/payouts.ts`; `judgePayouts` and `payingRoute` in `src/engine/outside.ts`; `CloseStore.paidOutside`. Details: [engine-rules.md](design/engine-rules.md).

14. Every first payment passes `startPayment`'s holds in the transaction that opens its attempt: a missing beneficiary, a likely second bill, an invoice number already on file for the supplier, a live outside payout, an account that changed since the last checked payment or was never confirmed, emails on file, and a payment from another currency's wallet.\
    Where: `startPayment`, `heldForOthers` and `lastPaidHold` in `src/engine/first-payment.ts`; `likelyDuplicates`, `sameNumberForSupplier` and `sameInvoiceNumber` in `src/domain/duplicates.ts`. Details: [engine-rules.md](design/engine-rules.md).

15. A pay run row is sent only on a look that has the run's turn.\
    Where: `startFirst` in `src/engine/first-payment.ts` reads `LookOptions.runTurn`, which only `releaseRun` in `src/runs/runs.ts` and the server's `Watcher` set. Details: [pay-runs.md](design/pay-runs.md).

16. Once an invoice is escalated, only a matching approval releases a payment for it.\
    Where: the look's `continueIfEscalated` step hands it to `continueEscalated` (`useApproval`), a held one goes to `continueHeld` (`releaseFor`), and `replaceUnderLock` sends nothing for an invoice that is no longer open. Details: [engine-rules.md](design/engine-rules.md).

17. A replacement already with the bank is never followed by another payment, and after a failed replacement the policy escalates instead of sending a third.\
    Where: the `followReplacement` step and `replacementOverdue`; `decide` returns `REPLACEMENT_FAILED_REASON`; `assess` counts a replacement as failed only when the bank does not have it live. Details: [engine-rules.md](design/engine-rules.md).

18. A settled or rejected invoice sends nothing.\
    Where: the `leaveClosed` step; `retry`'s state check under the lease; the `state = 'escalated'` conditions in `useApproval` and `releaseFor`. Details: [engine-rules.md](design/engine-rules.md).

## Accounts and bank details

19. Every attempt keeps the account it was decided or approved for, written before the Airwallex call.\
    Where: `AttemptStore.openAttempt` writes `account_key` from the approval's terms (`approvedAccountKey`) or from the account the caller decided on. Details: [engine-rules.md](design/engine-rules.md), [accounts.md](design/accounts.md).

20. The beneficiary record is read again before every replacement, held payment and retry, and nothing is sent if its bank details differ from the kept account in any field.\
    Where: `requireAccount` in `src/engine/send.ts` (`AccountChangedError`), called by `replaceUnderLock`, `continueEscalated`, `releaseHeld` and `retry`; `startPayment` checks a pay run row's account the same way. Details: [accounts.md](design/accounts.md).

21. A transfer that went to other bank details than its attempt keeps, or shows none, is marked misdirected and escalates the invoice, in the transaction that records it.\
    Where: `transferChecks` (`accountMismatch`) in `src/engine/send.ts`, run as the `Decide` inside `record` in `src/engine/payments.ts`; `markMisdirected`. Details: [engine-rules.md](design/engine-rules.md).

22. Wherever a decision or an approval pinned an account, PayOnce compares the full account key, and the route key only answers whether new details still go to the same account and never goes in terms.\
    Where: `accountKeyOf` in `src/domain/approval.ts`; `routeKeyOf`, `NOT_ROUTING_FIELDS` and `ROUTE_SCHEME` in `src/domain/assess.ts`; `holdsAccount` in `src/store/attempts.ts`. Details: [accounts.md](design/accounts.md).

23. New bank details never come from an email or the email reader; they enter only through a callback to the phone number on file, which a person records.\
    Where: `recordBankChange` in `src/engine/bank-change.ts`, the only caller of `updateBankDetails`, which checks the number with `isNumberOnFile` and refuses in the cases `callbackBlocked` (`src/domain/callback.ts`) gives; the reader returns only true or false findings (`EmailFindings` in `src/reader/emails.ts`). Details: [engine-rules.md](design/engine-rules.md).

24. A payment to an account the original did not go to gets an approval request only after a verified callback, needs two approvers, and cannot be approved by whoever recorded that callback.\
    Where: `escalate` in `src/engine/escalated.ts` waits while `assessment.bankChange` is null; `verifiedBankChange` in `src/store/bank-changes.ts`; `signoffsNeeded` in `src/domain/approvers.ts`; `barredFrom` in `src/domain/barred.ts`. Details: [engine-rules.md](design/engine-rules.md).

25. A first payment to a supplier whose record no longer holds the account of PayOnce's last checked payment, or whose earlier payments kept no account, is held for a person.\
    Where: `lastPaidHold` in `src/engine/first-payment.ts` (`lastPaidTransfer`, `lastPaidUnchecked`, `holdsAccount`). Details: [engine-rules.md](design/engine-rules.md).

## Cash, floors and exchange rates

26. Decisions read a fresh balance and the fee on the transfer just fetched, never the cached balance or a stored fee.\
    Where: `assess` in `src/engine/assessment.ts` (`getAvailableMinor`, `original.fee_amount`); `BalanceCache` is used only in `src/surfaces/http`. Details: [engine-rules.md](design/engine-rules.md).

27. PayOnce sends an automatic replacement only when the wallet stays at or above its reserve floor after the replacement, its fee and the money promised to other payments, and a currency with no floor set escalates.\
    Where: `decide` and `floorReason` in `src/domain/decide.ts`; `floorFor` in `src/domain/reserve.ts`. Details: [engine-rules.md](design/engine-rules.md).

28. An automatic replacement is decided again under the wallet lease, on a balance read under that lease, in the transaction that opens its attempt.\
    Where: `replaceUnderLock` in `src/engine/replacement.ts` (`committedAcross`, `decide`, `openAttempt`). Details: [engine-rules.md](design/engine-rules.md).

29. Money promised but still in the available balance (attempts being sent, approvals not yet spent, approved or released run rows not sent) is taken off in every floor check.\
    Where: `committedMinor` and `committedByInvoice` in `src/store/read/cash.ts`, which count the `FIRM_KINDS` lines. Details: [engine-rules.md](design/engine-rules.md), [incident-board.md](design/incident-board.md).

30. Pay run rows are checked against the floor when the run is checked, again under the lease at release, and again when each row is sent, while a single incident's original is not.\
    Where: `cashCheck` and `releaseRun` in `src/runs/runs.ts`; `floorBreach` in `src/engine/first-payment.ts`, which runs for run rows only. Details: [pay-runs.md](design/pay-runs.md).

31. An approved replacement is checked against the floor again before it is spent, and once the floor applies, an approval of terms that did not name it is void.\
    Where: `withFloorReason` and `asRequested` in `src/engine/reason-text.ts`; `voidIfStale` compares bindings. Details: [engine-rules.md](design/engine-rules.md).

32. A payment from another currency's wallet goes out only on a quote a person approved.\
    Where: `startPayment` holds the original (`heldForRate`); `decide` escalates the replacement; `AttemptStore.openAttempt` refuses a cross-currency attempt whose approval carries no quote; `sendAttempt` refuses an attempt with no `quoteId`. Details: [engine-rules.md](design/engine-rules.md).

33. A cross-currency transfer at another rate than the approved quote is marked and escalates, and only a person can close its invoice.\
    Where: `transferChecks` and `rateProblem` in `src/engine/send.ts`, which build the reason with `rateMismatchOf` from `src/domain/reasons.ts` and call `markRateMismatch`; `CloseStore.settle` refuses its own close while such a payment is live. Details: [engine-rules.md](design/engine-rules.md).

34. A pay run never converts currency: each row pays from its own currency's wallet.\
    Where: `SOURCE_COLUMNS` in `src/runs/run-file.ts` refuses the columns; `startPayment` refuses a cross-currency run row; `RunStore.releaseRun` writes `source_currency` as null. Details: [pay-runs.md](design/pay-runs.md).

## Approvals

35. Approval terms are built only by `termsFor`, `heldTermsFor` and `runTermsFor`, and the binding is SHA-256 of the terms' JSON with its keys in a fixed order.\
    Where: `src/domain/approval.ts` (`bindingOf`). Details: [ledger.md](design/ledger.md).

36. A signoff counts only for the binding of the request it was given on, and only while that request is waiting and has not expired.\
    Where: `RequestBook.signOff` in `src/store/approvals.ts`. Details: [ledger.md](design/ledger.md).

37. Before an approval is spent, PayOnce builds the terms again and voids the approval if it has expired or the binding has changed.\
    Where: `voidIfStale` in `src/engine/requests.ts`, called by `continueEscalated` and `continueHeld`; `releaseRun` makes the same checks for a run. Details: [engine-rules.md](design/engine-rules.md).

38. Before an approval is spent, it is checked against the approval policy as it is then.\
    Where: `voidIfStale` and `approvalProblem` in `src/engine/requests.ts`, which call `signoffProblem` from `src/domain/approvers.ts`. Details: [engine-rules.md](design/engine-rules.md).

39. An approval is spent once, on one payment, in the same transaction that opens that payment.\
    Where: `useApproval` and `releaseFor` in `src/store/approvals.ts` move it from `approved` to `used` only before its expiry, then call `openAttempt`, and roll back if no attempt opens; `RunStore.releaseRun` does the same for a run. Details: [ledger.md](design/ledger.md).

40. Nothing is spent if the invoice's emails, the paid invoice it looks like a second bill for, or a held invoice's matches changed since the look built the terms.\
    Where: the `unchanged` check that `continueEscalated` (`src/engine/escalated.ts`) passes to `useApproval`, and the one `releaseHeld` (`src/engine/held.ts`) passes to `releaseFor`; both run inside the spending transaction. Details: [engine-rules.md](design/engine-rules.md).

41. A request opens only on an escalated invoice, and never on one a person closed without paying or one already paid once.\
    Where: `RequestBook.add` inserts only while the invoice is escalated (the `open` test in `INVOICE_REQUESTS`); `escalate` in `src/engine/escalated.ts` stops on `rejectedBy` and `paidOnce`. Details: [ledger.md](design/ledger.md).

42. A new request voids any earlier open request for the same invoice or run.\
    Where: `RequestBook.add` calls `RequestBook.void`. Details: [ledger.md](design/ledger.md).

43. A request expires `APPROVAL_TTL_MINUTES` after it opens, or sooner when its exchange rate quote ends first, and a request that gets its last signoff keeps at least 10 minutes to be used.\
    Where: `requestExpiry` in `src/engine/rates.ts`; `RequestBook.signOff` with `APPROVED_USE_WITHIN_MS`. Details: [engine-rules.md](design/engine-rules.md).

44. Only a name in `APPROVERS` may approve, within its limit as compared with what the payment takes from its wallet, and without `APPROVERS` every approval is refused.\
    Where: `checkSigner` and `policyFromEnv` in `src/domain/approvers.ts`; `paymentAmount` and `runAmount` in `src/domain/approval.ts`. Details: [engine-rules.md](design/engine-rules.md).

45. Two different approvers are needed above `TWO_APPROVERS_ABOVE`, for an account the original did not go to, and when PayOnce does not know who started the payment, with further cases for a held invoice's first payment and for a pay run.\
    Where: `signoffsNeeded` in `src/domain/approvers.ts`; `payeeRule` in `src/engine/held.ts`; `runRule` in `src/runs/runs.ts`. Details: [engine-rules.md](design/engine-rules.md), [pay-runs.md](design/pay-runs.md).

46. Whoever started the incident, a pay run's uploader, anyone who recorded a callback for the account, and anyone who proposed or confirmed the phone number that callback was made on cannot approve the payment.\
    Where: `barredFrom` in `src/domain/barred.ts` (through `barredOnFile` in `src/store/read/reviews.ts`); `runBarred` in `src/runs/runs.ts`; `checkSigner` refuses a barred name. Details: [engine-rules.md](design/engine-rules.md).

47. No request opens while fewer people could approve it than it needs, and an open one is withdrawn.\
    Where: `awaitApproval` in `src/engine/requests.ts` (`eligibleApprovers`, `waitForApproverList`). Details: [engine-rules.md](design/engine-rules.md).

## Closing an invoice

48. PayOnce closes a paid invoice by itself only when one payment is paid, nothing else for it is still with the bank, and none of these is on file: a live payment at an unapproved rate or to other details, a late transfer beside a live payment, a live outside payout, or an unrecognised transfer nobody has cleared.\
    Where: `CloseStore.settle` in `src/store/closes.ts`, which checks and closes in one transaction; `close` in `src/engine/close.ts`; the `closeIfPaid` step (`paidByReplacement` in `src/domain/live.ts`). Details: [ledger.md](design/ledger.md).

49. A person's close must name every unrecognised transfer not yet cleared, and it clears exactly those.\
    Where: `closeIncident` in `src/engine/person.ts` (the `shown` check); `clearMismatched` inside `settle`, `reject` and `rejectAgain`. Details: [engine-rules.md](design/engine-rules.md).

50. An invoice can be closed without paying only while nothing for it is live at the bank, and the close voids any open request.\
    Where: `CloseStore.reject` (`LIVE_ATTEMPT`, `BLOCKING_OUTSIDE_PAYOUT` in its SQL). Details: [engine-rules.md](design/engine-rules.md).

51. The only close without a payment that PayOnce makes by itself is `rejectAgain`, of an invoice a person had already closed without paying.\
    Where: `rejectAgain` is called by `continueEscalated` and `closeAgain` in `src/engine/held.ts`; `reject` is called only from `closeIncident`. Details: [engine-rules.md](design/engine-rules.md).

52. When a held invoice's release, an approved replacement and a close without paying race from different processes, at most one of them succeeds.\
    Where: the conditions on `state = 'escalated'` and `LIVE_ATTEMPT` in the SQL of `releaseFor`, `useApproval` and `reject`, each under the write lock. Details: [engine-rules.md](design/engine-rules.md).

53. A payment that may have paid the supplier twice holds the invoice for a person before the policy runs and before any close.\
    Where: `paidTwice` in `src/store/read/facts.ts`, the `holdIfPaidTwice` step and `holdPaidTwice`; `settle` refuses while `lateBesideLive` finds one. Details: [engine-rules.md](design/engine-rules.md).

54. While an unrecognised transfer (one under PayOnce's request id that does not match the invoice) is live, the invoice waits for a person and nothing is sent.\
    Where: `holdMismatched` in `src/engine/late-mismatched.ts`, run by `look` before any retry or decision; `holdPending` for a pending attempt. Details: [engine-rules.md](design/engine-rules.md).

## Where decisions come from

55. PayOnce learns what the bank did only by reading Airwallex, and nothing in a webhook's body feeds a decision.\
    Where: `onWebhook` in `src/surfaces/http/start.ts` only wakes an invoice or asks for a sweep, after `WebhookReceiver` checks the signature and `Ledger.firstDelivery` drops repeats; the look reads transfers with `getTransfer` and `findTransferByRequestId`. Details: [webhooks.md](design/webhooks.md).

56. The engine never simulates a bank outcome.\
    Where: `simulateTransfer` is called only by `src/engine/sandbox-bank.ts`, which the engine reaches only through the optional `Engine.bank` hook. Details: [sandbox-behaviour.md](design/sandbox-behaviour.md).

57. No model decides an amount, an account or whether to pay, and supplier email findings can only add caution.\
    Where: `decide` is pure code; `readNewEmails` in `src/engine/emails.ts` ORs each read into the stored findings and never clears one. Details: [email-reader.md](design/email-reader.md).

58. In `pnpm ui` and `pnpm recover`, no two steps run on one invoice at once.\
    Where: `Dispatcher.run` and `Dispatcher.wake` in `src/engine/dispatcher.ts`; the server runs a person's actions through `inTurn`. Details: [engine-rules.md](design/engine-rules.md).

## Records and boundaries

59. Ledger transactions cannot nest: a step that opens its own transaction throws if it is called inside another, before it writes anything.\
    Where: `Db.transaction` and `Db.readSnapshot` in `src/store/db.ts` throw when a transaction is open. Details: [ledger.md](design/ledger.md).

60. Stored JSON is read strictly on every payment path, so a row PayOnce cannot read stops its own invoice's looks and pays nothing; only views read it leniently.\
    Where: `storedStrings`, `storedList` and `storedObject` in `src/store/db.ts`, lenient only inside `readingSoft`. Details: [ledger.md](design/ledger.md).

61. Timeline lines are one line each, hash-chained, and never edited.\
    Where: `note` in `src/engine/lines.ts` and `Timelines.appendEvent` in `src/store/timeline.ts` (`oneLine`, `HashChain.hash`); `HashChain.breaks` in `src/store/chain.ts` reports an edit. Details: [ledger.md](design/ledger.md).

62. An escalation reason holds only PayOnce's own words, never email text, model output, a phone number or account details.\
    Where: the escalation methods in `src/store/invoices.ts` take a `Reason` built from the codes in `src/domain/reasons.ts` (or keep the reason already on file), never a bare string, and write text and codes together (`SET_REASON`). Details: [alerts.md](design/alerts.md).

63. Reconciliation, metrics, the incident board, the supplier view, Ask why and the MCP server move no money and change no invoice, attempt, approval or binding.\
    Where: the engine imports none of them; the MCP server, `pnpm ask` and `pnpm metrics` open the ledger read-only (`new Ledger(path, true)`). Details: [reconciliation.md](design/reconciliation.md), [mcp-server.md](design/mcp-server.md).

64. PayOnce's Airwallex client talks only to the sandbox.\
    Where: the host check in `src/airwallex/client.ts` accepts only `SANDBOX_HOSTS` and `sandbox.invalid` (`ALLOWED_HOSTS`). Details: [airwallex-client.md](design/airwallex-client.md).

65. The Airwallex client id and API key, and the model services' keys, are cut out of Airwallex errors, model service errors and Ask why answers before any of them is printed or stored.\
    Where: `withoutSecrets` in `src/airwallex/client.ts`; `redactKeys` in `src/reader/model-service.ts` and `src/explain/explainer.ts`; both use `src/text/redact.ts`. Details: [airwallex-client.md](design/airwallex-client.md), [email-reader.md](design/email-reader.md).

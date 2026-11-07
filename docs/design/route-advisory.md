# Route advisory

The route advisory tells people when a payment usually arrives and whether it may miss its due date. It is in `src/domain/arrival.ts`. The engine uses it in `src/engine/terms.ts` and `src/engine/send.ts`, the pay run check in `src/runs/runs.ts`, and the views in `src/views/parts.ts`. An estimate goes into approval terms by a conditional spread, as [architecture.md](../architecture.md#how-approvals-bind-terms) describes, so an invoice with no due date keeps its binding.

## Rules

- The advisory is for people and never decides. `decide` does not read it, and a payment that may arrive late is sent, replaced, held or approved exactly as it would be without a due date.
- PayOnce does not switch routes. A beneficiary record holds one transfer method, and paying another way needs another record.
- `obligations.due_date` is optional, as YYYY-MM-DD. It comes from the New payment form (`POST /api/payments`), a scripted incident (`POST /api/sandbox/scenarios`) or a pay run row's `due_date`.
- `dueDateProblem` refuses anything that is not a calendar day from 2000 to 2099. A day in the past is taken, and every estimate says it has passed.
- `CORRIDORS` holds the usual arrival in business days by destination country, currency, method and, for a US local payment, clearing system. The figures come from Airwallex's payout network pages for the US and Germany, read on 2026-10-28.
- A US local record with no clearing system pays by ACH. `ROUTES` lists the route names an estimate can carry.
- A route not in `CORRIDORS` (any country but the US and Germany, or a US clearing system the table does not list) gets an estimate with no days, which says the arrival is not known.
- Every ACH payment gets 0 to 2 days.
- Business days skip Saturdays and Sundays only (`addBusinessDays`). A public holiday counts as a working day, and every place that shows an estimate says so (`HOLIDAYS_NOTE`). "Today" is this machine's calendar date (`today`).
- `arrivalFor` builds `ArrivalTerms` in one key order: method, country, route, days, the day it counts from, the earliest and latest usual day, and the due date. `arrivalBlock` copies one in that order, and `ifSentOn` counts one from another day.
- `arrivalRisk` compares an estimate with the due date: on time, may arrive late, late even at its fastest, the due date has passed, or not known.
- `arrivalText`, `sentArrivalText` and `replacementArrivalText` write an estimate for people. `arrivalAdvice` is what the page and the CLI show for one, never part of the terms.
- `routeText` names a route with its method when the two differ, such as "LOCAL (ACH), usually 0 to 2 business days", so the advice reads the same as the fee beside it. The terms keep `route` as it was.
- The fee estimate is `latestFee` for the currency and method, labelled as last seen, or as none seen (`feeSeenText`). It is shown on the pay run rows and in `pnpm payrun show`, and it is never in terms.
- `send` writes a line after every payment it creates, original or replacement: when it usually arrives, counted from the transfer's `created_at` on this machine's calendar, and against the due date when there is one.
- That line is a warning when the payment may arrive late, arrives late even at its fastest, or the due date has passed (`atRisk`). `send` also stores the estimate on the attempt (`setArrival`).
- For an invoice with a due date, `assess` builds `arrival` for a replacement to the record as it is now (`arrivalOf`). The decision line adds it when the original failed and no outside payout is live (`arrivalClause`).
- `termsFor` and `heldTermsFor` add `arrival` to the terms by a conditional spread after `fx`. The terms and bindings of an invoice with no due date are unchanged. `changedFields` names a change as "arrival estimate".
- The decision line counts from today, even while an open request keeps an earlier day.
- `arrivalFrom` counts an invoice's estimate from the day of its latest request while that request is requested or approved and has not expired. Otherwise it counts from today.
- When `awaitApproval` opens a new request on terms that kept another day, it first counts them from today with `countedFromToday` (`withArrival` and `ifSentOn`).
- `awaitApproval` then compares the recounted binding with the latest request again, so a request another process opened today on the same terms is kept, with its signoffs.
- `escalate` compares the open request with both the terms and their `countedFromToday` version, so on the look that opens a request the `floor` and `second-bill` warnings already say it names them.
- An approval can be spent on an estimate from an earlier day. The day holds while the request is open, which is up to `APPROVAL_TTL_MINUTES` (no cap) plus `APPROVED_USE_WITHIN_MS`.
- When the estimate's day is before today, the approve options, `pnpm approve` and `pnpm payrun approve` add when the payment usually arrives if it is sent today. That line is not in the terms.
- For a route with no figures, that "if sent today" line appears only when the due date has passed since the estimate's day.
- A pay run counts its rows' estimates by the same day rule. See [pay-runs.md](pay-runs.md).

## Why

- The account checks key on the record (`lastPaidTransfer`, `verifiedBankChange`, `payeeRule`, the run check), so another record is another supplier.
- Airwallex's non-trading-days list needs an admin key, which PayOnce does not have, so holidays are not known.
- Every ACH payment gets 0 to 2 days although Airwallex sends ACH as Next Day ACH (1 to 2 days) above 1,000,000 USD or when the payer is outside the US, and this sandbox account's payer is in Singapore. The latest day is right either way.
- The fee estimate stays out of terms, so a fee recorded on another invoice cannot void an approval.
- Counting from the open request's day keeps the binding when a look comes after midnight. Recounting before a new request means a new request always counts from the day it opens.
- The terms say "if sent on" that day, so they stay true as written when the approval is spent later.

## Edge cases

- A payment to another record for the same supplier: no callback recorded for the first record counts for it, and a callback on an invoice held before paying it is refused while PayOnce has not paid that record.
- A single incident's first payment to another record goes out like any first payment. A held invoice or a pay run row to it needs two approvers, because PayOnce has never paid it.
- An ACH payment above 1,000,000 USD, or from a payer outside the US: the earliest day shown is a day early, so one shown as "may arrive late" may arrive late even at its fastest.
- A due date in the past: it is taken, and every estimate says it has passed.
- A route with no figures: the estimate says the arrival is not known, and no "if sent today" line appears unless the due date has passed since.

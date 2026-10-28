# PayOnce

A payment incident agent that recovers failed supplier transfers without paying twice.

PayOnce is my entry for the Airwallex Agentic Banking Hackathon 2026. It starts from starter kit 3, Payment Ops Incident Commander.

> Status: working demo against the Airwallex sandbox. A model reads supplier emails when a key is set, and a keyword placeholder reads them when it is not. Sandbox only, no real money.

## The problem

A supplier says a payment never arrived and their deadline has passed. The transfer shows as sent but not settled. Finance can wait, send a replacement, or escalate, and each choice can go wrong: wait too long and the supplier stops shipping, replace too early and you have paid twice. This is also when fraudsters send the "please resend to our new account" email.

## What it does

PayOnce follows each supplier payment through an incident. It sends the transfer and then reacts to what happens: the bank pays or fails it, the supplier writes in, or a person approves something. An Airwallex webhook or a status check tells it the bank has moved, and it reads the transfer from Airwallex itself before it decides. Each time, it waits, replaces the payment, closes the incident, or hands the decision to a person. A web page shows each incident as a timeline, with the emails, the payments and whatever a person is asked to approve or close. A person can upload a supplier's real email there, and PayOnce reads it as untrusted text that can only add caution.

If the bank sits on a payment past its deadline, a person hears about it. PayOnce also looks through Airwallex for payouts it did not send, such as a resend made in the Airwallex web app, and holds its own payments for an invoice someone else has paid.

## What the agent decides

| Situation | Action |
| --- | --- |
| A payout for this invoice was sent outside PayOnce and has not failed | Escalate to a person |
| The supplier asks for payment to different bank details | Escalate to a person |
| The supplier asks to hold, cancel or not pay the invoice | Escalate to a person |
| The supplier's bank details on file changed after the original payment | Escalate to a person |
| An email came from an address that does not match the supplier on file | Escalate to a person |
| Supplier emails are on file that could not be read | Escalate to a person |
| Part of a supplier email could not be read | Escalate to a person |
| The original is in a status the policy does not recognise | Escalate to a person |
| The original settled but the supplier reports non-receipt | Escalate to a person |
| The original settled and no supplier email reports it missing | Close |
| The original transfer is still in flight past its deadline | Escalate to a person |
| The original transfer is still in flight | Wait |
| A replacement has already failed | Escalate to a person |
| The original failed for a reason a resend cannot fix | Escalate to a person |
| The original was sent outside PayOnce and would otherwise be replaced | Escalate to a person |
| The cash position could not be read | Escalate to a person |
| The original failed and a replacement with its transfer fee, on top of money already committed to other payments, would push cash below the reserve floor | Escalate to a person |
| The replacement is above `TWO_APPROVERS_ABOVE` | Escalate to a person |
| The invoice is paid from another currency's wallet, so the replacement needs a new exchange rate | Escalate to a person |
| No reserve floor is set for the payment's currency | Escalate to a person |
| The original failed, a resend can fix it and the beneficiary details are unchanged | Replace |

`src/decide.ts` checks the rules in that order. A resend can fix a failure only when it happened on the sending side: a system error or a channel timeout. Any other failure, including a return from the beneficiary's bank, goes to a person.

When the supplier asks to hold, cancel or not pay the invoice, and the policy escalated for an earlier rule or the invoice was already held before paying, PayOnce adds "and the supplier asks to hold, cancel or not pay this invoice" to the reason. The approval request, the alert and the approval card all show it, and a person can still approve paying.

Two of these checks do not depend on how the email text is read. The sender's domain, and the Reply-To's, is compared with the one on file, as ASCII only, so a look-alike character such as the Kelvin sign cannot pass for a K. An invoice with no domain on file flags every sender. The supplier's bank details are read from Airwallex again and compared with the account the original payment went to. When they differ the timeline says so, whatever reason the policy escalates for.

A model reads the supplier emails, one at a time. It holds no credentials and moves no money. It answers three yes-or-no questions: does the supplier say the payment has not arrived, ask for a different account, or ask to hold, cancel or not pay the invoice. PayOnce writes the summary a person sees from those answers, so no wording from an email or from the model reaches the approval card. A keyword check reads the same email, and a finding is yes if either says yes. A finding, once made, stays: a later email cannot clear it. Every finding leads to more caution, so an email that tricks the model cannot remove a finding the keyword check makes. An email that the keyword check misses and that also tricks the model can still hide a finding, which is why the sender check and the bank-details check are in code. The emails go to the model marked as untrusted text. If the model fails, or its answer is not three yes-or-no values, the thread counts as unread and the incident goes to a person.

The reader is Gemini 3.5 Flash by default, with Gemini 3.1 Flash-Lite as a second model if the first does not answer. Both are on Google's free tier and are called through its OpenAI-compatible endpoint, so any service that speaks the same format can replace them. Without a key, a keyword placeholder in `src/keyword-reader.ts` reads the emails. The page names the reader under its findings.

## Supplier emails you upload

Real supplier mail reaches PayOnce through the "Supplier email" card on the page. Choose the `.eml` file, or paste the raw source (Show original or View source in your mail client), and add your name. One email per upload, up to 2 MB. PayOnce refuses an Outlook `.msg` file, and refuses text that is not raw source, so pasting what the mail client shows does not lose the first paragraph to the headers. If a paste starts with a header line such as `Subject:` and the text follows with no blank line, PayOnce reads that text as part of the email and marks the email partly unread.

PayOnce parses the email itself, with no library. It keeps the sender's address and display name, Reply-To, the subject, every text part (plain and HTML) and a list of attachments by name, type and size. The reader reads the display name, because a mail client shows it, but the sender check never compares it. PayOnce ignores the Sender header and checks only From and Reply-To. It never opens an attachment, loads an image or follows a link. It treats every byte as hostile, and parses each upload in a worker thread of its own. If a parse takes more than 2 seconds or 256 MB of memory, PayOnce stops it and refuses the email, so one slow email cannot hold up the agent or the page. It reads one upload at a time, with up to four waiting, and past that asks the next person to try again in a moment. An ambiguous sender becomes "no sender address PayOnce could read", which the sender check flags. PayOnce strips invisible characters and terminal control codes, and keeps its own notes about the email apart from the text, so an email cannot forge one.

PayOnce turns HTML into text in one pass, and when in doubt it reads more than a mail client shows. Script and style content stays out of the text, but every string in it, and any text in it that is not CSS, is shown and read as "text found inside styles". What a form field shows (an input's value, or the placeholder of an input or text area) and CDATA inside SVG or MathML are read as text too. Anything CSS could make a client draw that is not one of those strings, such as a web font, a counter or a reversed run of digits, or a style sheet from outside the email, marks the email partly unread. So does text past 32,000 characters, a text attachment, a forwarded or encrypted email, or a part in a character set PayOnce cannot decode. A partly unread email sends the invoice to a person, who reads it in their own mail client.

PayOnce does not lay out the HTML the way a mail client does. Reordering, list numbering and positioning can show a person the same characters in another order than the reader gets them. That is accepted because no protection depends on it: bank details change only through a callback to the number on file, the sender check works on addresses, approvals bind the account read from Airwallex, and the findings only add caution.

The upload waits in the inbox. PayOnce lists the invoices it names, from invoice numbers in the subject, the text and attachment names, and offers one first only when exactly one invoice matches, in any state, and that invoice is open or with a person. A number found only inside other digits, as in a phone number, is never offered first. A person picks the invoice, or types another, and confirms. Nothing is delivered by itself. The agent then reads the email and decides again. A dismissed email stays dismissed, and the same email uploaded twice is refused with where the first one went.

An email on file before an invoice's first payment holds the invoice for a person, pay run rows waiting their turn included. A held invoice reads its emails, and its approval terms carry the findings. Approval terms count the emails on file, and how many could not be read in full or come from flagged senders, so any new email voids an open approval and the approvers look again. Terms never quote a sender's address or text.

## The duplicate lock

PayOnce writes every payment attempt to a SQLite ledger (`payonce.db`) before it creates the transfer. A unique index allows one attempt per invoice that has not failed, so the database refuses a second live payment. PayOnce can open a replacement only after the ledger records the original as failed.

Each attempt keeps its `request_id`. A retry reuses it, and Airwallex then returns the transfer it already has. A 4xx from Airwallex marks the attempt failed, except a 429, which only asks PayOnce to slow down: like a 5xx, it leaves the attempt pending for the next look to retry. An incident closes only when one attempt is paid and every other attempt has failed.

The Payments card has a "Pay again" button for the person who wants to send it once more to be sure. It opens a replacement attempt the way the agent would, inside a database transaction that is always rolled back. While a payment is live or paid, the lock refuses it and the timeline names the payment holding the lock. When every payment has failed there is nothing to refuse, but the button still sends nothing: a replacement goes through the policy, and through an approval once the invoice is with a person. Either way nothing reaches Airwallex.

## Deadlines

A transfer has a deadline: 3 minutes for a local transfer and 5 for SWIFT, counted from when Airwallex created it. Real rails take days and the sandbox moves in seconds, so the defaults suit the sandbox. `BANK_DEADLINE_LOCAL_MINUTES` and `BANK_DEADLINE_SWIFT_MINUTES` change them. While PayOnce waits on the bank, the timeline says how long the bank has before a person hears about it.

If the original is still in flight at its deadline, the incident goes to a person and PayOnce still sends nothing, because the bank may yet pay it. A replacement past its deadline goes to a person the same way, and the incident still closes if the bank pays it. The `STAYS_IN_FLIGHT` bank outcome leaves the original in `SENT` to show this.

## Payouts sent outside PayOnce

The lock only covers payments PayOnce sends. Someone can still pay the same invoice from the Airwallex web app. Every 30 seconds PayOnce lists the transfers created since its ledger started and looks for ones it did not send.

- A payout whose reference is an invoice PayOnce has, or nearly matches one as described under [Duplicate invoices](#duplicate-invoices), goes on that invoice's timeline. While it is in flight or paid, PayOnce sends nothing for the invoice, withdraws any open approval and hands the invoice to a person. If the invoice was already closed, it is reopened.
- Any other payout becomes an incident of its own once it fails or passes its deadline. PayOnce runs it like its own, except that a replacement always needs a person's approval, because whoever sent the original may be resending it too.

Before it sends any payment, PayOnce lists the transfers again, so a resend made a moment earlier is caught even between sweeps. If every payment PayOnce sent failed and a payout sent outside it paid the invoice, a person can close the incident from the close card.

## Duplicate invoices

The lock stops PayOnce paying one invoice twice. It cannot see a supplier billing the same work twice under a slightly different number, such as INV-0042 and INV-42A. So before PayOnce sends a new invoice's first payment, it compares the invoice with every other invoice in the ledger. If one has the same supplier, currency and amount, and a number that is the same apart from case, spacing, leading zeros or up to four letters added at the end, PayOnce holds the new invoice and sends nothing. Both timelines say so. PayOnce pays an invoice number once, so it also holds a new invoice whose number matches another invoice to the same supplier this way, whatever the amount or currency. A pay run row and an invoice started on the page under the same number cannot both be paid, even for different amounts.

The letters count only when one number is the other with letters added. INV-42A and INV-42B each match INV-42 but not each other, so RENT-2026-OCT and RENT-2026-NOV are paid as separate bills. INV-42-1 and INV-421 do not match INV-42.

A person then either pays the held invoice or closes it without paying. Paying it takes an approval under the rules below. The person who started the incident cannot give it. The terms list the invoices it looks like and how each stands, so a change in any of them voids the approval. If one of them was paid, or is being paid, to a different account from the one on file now, two approvers are needed, because a resent invoice with new bank details is a common fraud. Closing it without paying takes a name and a note, on the close card or with `pnpm close`. A held invoice keeps being compared, so an invoice that matches it later is added to its terms.

Payouts sent outside PayOnce get the same check. A payout whose reference nearly matches an invoice number, to the same supplier for the same amount, is tied to that invoice as if its reference were the number itself. The check before every payment does this too, so a payout made in the Airwallex web app under a near-identical number holds the invoice. A failed payout that only nearly matches an invoice already closed may be a bill of its own, so it becomes an incident, with a warning that names the closed invoice.

If Airwallex refuses an invoice's payment outright, the invoice is held the same way. A person approves paying it again or closes it without paying. PayOnce never replaces a payment by itself when it looks like a second bill for an invoice that is already paid. When a replacement goes to a person for any reason, its approval request names that paid invoice too, so nobody approves it without seeing the match.

The invoice number on the start form is optional. An invoice number already in the ledger is refused.

## Approvals

When the original has failed and the policy escalates, PayOnce records an approval request with the exact terms: the amount, the currency, the account the supplier's record points to now, and the evidence behind the escalation. A held invoice gets one as well. A person approves it on the web page or with `pnpm approve`, and the approval names the request they were shown.

Before paying, PayOnce rebuilds the terms from current data and compares them with what was approved. If they match, it sends the replacement. If anything changed, the approval is void and PayOnce opens a new request. An approval is spent on one attempt, and it cannot override the duplicate lock. Once an invoice has gone to a person, only an approval releases a payment, even if the policy would now replace it unprompted.

### Who can approve

Approvers are listed in `.env` as names with limits, for example `APPROVERS=Yash:50000,Alex:10000,Sam:5000`. Without the list nobody can approve. A limit is compared with what the payment takes from the company's wallet, in that wallet's currency. For an invoice paid from its own currency, that is the invoice amount. For one paid from another wallet, it is the amount on the exchange rate quote (see [Payments across currencies](#payments-across-currencies)).

- Two different approvers are needed above `TWO_APPROVERS_ABOVE` (5,000 by default). Two are also needed whatever the amount when the payment would go to an account the original did not go to, and when PayOnce does not know who started the incident, as with a payout found in Airwallex.
- The person who started an incident cannot approve a payment for it. The page asks for a name when an incident starts. `pnpm recover` takes one as its fifth argument and uses the computer's login name without it.
- An approval request expires after `APPROVAL_TTL_MINUTES` (60 by default). The agent looks at the invoice again when it expires, voids it and opens a new one. Approvals given on the old request no longer count.
- Each approval records the hash of the terms its approver was shown, and the second approver has to approve the same request. The terms include a hash of every bank detail of the account, because the pay-to line shows only its last four digits. Before paying, PayOnce checks the approvals against the policy as it is then, so an approver taken off the list or a lowered limit voids them.
- A request completed just before it expired has ten minutes to be used, so a slow look does not lose it.
- If nobody on the list can approve a payment, for example because it needs two approvers and only one has a high enough limit, PayOnce opens no request and the timeline says so.
- The agent does not replace a payment above `TWO_APPROVERS_ABOVE` by itself either. It escalates, and the replacement needs two approvers.

The page has no login, so a name is whatever the person types or picks. The rules stop someone approving their own incident under their own name, and the timeline records who said what. They do not prove who was at the keyboard. That needs a login tied to each name.

## Payments across currencies

An invoice can be owed in one currency and paid from another wallet. The `eur-from-usd` scenario pays a 4,000 EUR invoice from USD. Each payment is one Airwallex transfer that converts on a quote. PayOnce asks Airwallex for a quote that buys exactly the invoice amount and sends the transfer with that quote's id, so the supplier gets the invoice amount and the rate decides what leaves the USD wallet.

PayOnce never pays at a rate nobody has seen, so every payment from another wallet waits for a person, the first one included:

- A new invoice is held before paying. The approval card shows the amount, what it takes from the USD wallet, the rate as Airwallex quotes it (1 EUR = 1.1191 USD), how far that is from the mid-market rate, the quote id and when the quote runs out. `pnpm approve` prints the same.
- If the original fails, its replacement goes to a person too, at a new quote, paid from the same wallet.
- The quote is part of the terms the approval is bound to. A new request never opens on a quote an earlier request showed, and the timeline shows the new rate next to the last one. While nobody on the approver list can approve the payment, PayOnce keeps the last quote it took and takes no new one until that one runs low, and the timeline names no rate. A payment from the invoice's own currency has no quote in its terms.
- A request ends at `APPROVAL_TTL_MINUTES`, or 12 minutes before its quote runs out if that comes first. An approval given at the last moment still has its 10 minutes to be used, with 2 to spare. `FX_QUOTE_VALIDITY` sets how long a quote holds: `MIN_30`, `HR_1` (the default), `HR_4`, `HR_8` or `HR_24`. A longer quote gives people longer to approve, at a slightly worse rate.
- Approval limits and `TWO_APPROVERS_ABOVE` are compared with what leaves the wallet, in its currency. With a limit of 4,200, Sam can approve 4,000 EUR paid from the EUR wallet but not 4,000 EUR paid with 4,476 USD.
- A payment that may not have reached Airwallex is retried with its own request id and quote, never a new quote. While the quote could still pay, a refused retry leaves the payment open and the duplicate lock held. When a bank deadline has passed since the quote ran out, PayOnce tries once more under the same request id. If Airwallex reports a transfer, PayOnce follows it. If Airwallex refuses the quote and lists no transfer with that request id, nothing was ever sent: PayOnce marks the payment failed, which releases the lock, and the invoice goes back to a person for a new approval on a new quote. Any other error, such as Airwallex throttling the call, leaves the payment open, and PayOnce tries again a minute later.
- Whenever a payment becomes a transfer, PayOnce checks the transfer's rate, currency pair and amount against the approved quote. A transfer at any other rate goes to a person with a warning. If it is the payment that pays the invoice, only a person can close the incident, whether it was the first payment or a replacement. If it fails and a later payment is paid at its approved rate, the incident closes as usual.
- The reserve floor and the cash panel count the payment in the wallet it leaves, at the quote's amount, with the fee in that currency. Nothing is counted in EUR. The same goes for the money a pay run's cash check counts as committed elsewhere, and the payment holds that wallet's currency lock while it is sent.

In the sandbox, Airwallex creates the converting transfer on the approved quote and takes the USD and a SWIFT fee of about 15.60 USD out of available at once. Its simulator does not move such a transfer past `PROCESSING`, so this demo ends at the bank deadline, where the incident goes to a person. A failed converting payment and its replacement cannot be shown in this sandbox.

## Route advisory

An invoice can have a due date, written like 2026-11-02: the "Due date" field on the start form, `dueDate` in `POST /api/incidents`, or a `due_date` column in a pay run file. PayOnce then says when a payment usually arrives and whether it may miss that date. A date in the past is accepted, and the advice says it has passed.

The advice is for people. It never holds, sends, replaces or blocks a payment, and the policy decides without it. A payment that may arrive late goes out like any other.

- Every pay run row shows its route and arrival on the rows card and in `pnpm payrun show`, such as "SWIFT, usually 0 to 3 business days, by 2026-11-02 if sent on 2026-10-28; due 2026-10-30; may arrive late", followed by the fee PayOnce last saw for that currency and method. A row with a due date carries the same estimate in the run's terms, so the approval card and `pnpm payrun approve` show it to the approvers.
- When PayOnce sends a payment, the timeline gives the days it usually arrives between and, with a due date, whether it should arrive in time. The line is a warning when the payment may be late.
- When the original fails, the decision line says when a replacement sent that day usually arrives, against the due date. The replacement's approval terms carry the same estimate. So do the terms for paying a held invoice, such as one paid from another currency's wallet, and `pnpm approve` prints it.

The estimates come from Airwallex's published payout network tables for the United States and Germany: ACH 0 to 2 business days, Next Day ACH 1 to 2, FedNow and Fedwire 0 to 1, SEPA 0 to 2 and SWIFT 0 to 3. PayOnce shows every ACH payment as 0 to 2 days. Airwallex says it sends ACH as Next Day ACH, 1 to 2 days, above 1,000,000 USD or when the payer is outside the US, and this sandbox account's payer is in Singapore. For those payments the earliest day shown is a day early, so a payment shown as "may arrive late" may arrive late even at its fastest. The latest day is right either way. For any other country the advice says the arrival is not known. Airwallex has no API that quotes one transfer's arrival or fee. Business days skip Saturdays and Sundays only. Airwallex's list of non-trading days needs an admin key, so a public holiday counts as a working day and a payment may arrive a day or more later than shown. The advice says so wherever it gives a date. The fee is the last one PayOnce recorded for that currency and method, labelled as last seen, or "no fee seen yet".

PayOnce does not switch a payment to a faster route. Each Airwallex beneficiary record holds one transfer method, so paying another way takes another record, and PayOnce treats another record as another account, with a callback and two approvers like any change of bank details. When a route may be too slow, the advice says so and a person decides what to do.

An estimate in approval terms counts from the day its request opened, so an approval given just before midnight still matches after it. The same goes for a pay run checked again after midnight: the approvals it already has still count. A new request counts from the day it opens. While the day in the terms is before today, the approval card and `pnpm approve` also say when the payment usually arrives if it is sent today. That line is advice and is not part of what is approved. An invoice without a due date has the same approval terms as before, and so does a pay run file without due dates.

## Changed bank details

PayOnce never takes new bank details from an email or from the model that reads emails. When a supplier says it has moved banks, or the supplier's record no longer matches the account the original went to, PayOnce pays the new account only after a person has called the supplier back.

Once every payment for the invoice has failed, the incident page has a "Changed bank details" card. The person calls the supplier on the phone number in the supplier record, then records who called, the number they dialled, when, who they spoke to and what was confirmed. PayOnce refuses the callback if the number is not the one on file. The person then types the new details the supplier read out. PayOnce updates the supplier's beneficiary record in Airwallex, reads it back and keeps the record's details with the callback.

The agent then opens a new approval request for the new account. Its terms carry the callback and a hash of the full bank details, and two approvers must approve it whatever the amount. The person who recorded the callback cannot be one of them, and neither can the person who started the incident. If the record changes again, in PayOnce or in the Airwallex web app, the callback no longer matches it, any open request is withdrawn and nothing is paid until someone calls again.

A callback verifies the record for every invoice paid to that supplier, not just the one it was recorded on, because they all pay the same beneficiary.

Before any replacement goes out, PayOnce reads the supplier's record again and sends nothing if it no longer holds the account the approvers saw. While another invoice to the same supplier is about to be paid, a callback cannot be recorded, because the change would move that payment too.

In the sandbox, the scenarios share one beneficiary per currency, so a change would reach every later incident. Each run of the `usd-local-bank-change` scenario creates a record of its own, with a phone number on file. Try it with the `moved-banks` email thread and the `ACCOUNT_CLOSED` bank outcome.

## Closing a paid incident

A paid original holds the duplicate lock, so PayOnce cannot send anything more for that invoice. If no supplier email reports the payment missing, the incident closes. If one does, or anything else on file sends it to a person, the incident stays open until a person closes it. The same goes for an invoice paid by a replacement or by a payout sent outside PayOnce that has gone to a person.

The page shows the paid transfer and the reason, and takes a name and a note of what the person confirmed. `pnpm close` does the same in the terminal. Both the name and the note go on the timeline. Closing moves no money, so it is not bound to terms the way an approval is. "Check again" never closes an incident that is waiting on a person.

## Audit trail

Each incident's timeline is a hash chain, and so is each pay run's. Every line stores the hash of the line before it on the same invoice, and a SHA-256 hash of its own content plus that previous hash. Editing, removing or inserting a line breaks the chain at that point. The ledger also keeps a running hash over every line in the order they were written. It catches two things one invoice's chain misses: lines removed from the end of a timeline, and every line of an invoice removed. Pay run timelines have a running hash of their own.

PayOnce writes each line, its hashes and the running hash in one database transaction. The terminal commands and the web server can write to the ledger at the same time, and the transaction stops two of them chaining from the same line.

`pnpm run audit` checks every timeline and the running hash, and says where a chain breaks. `pnpm run audit INV-5001` checks one invoice and lists each break. Add `json` or `csv` to print the invoice's audit trail instead. `pnpm run audit run 7` checks pay run 7's timeline, with `json` or `csv` after it for the run's audit trail, and the check of the whole ledger covers every run. (`pnpm audit` on its own runs pnpm's dependency audit.) The page shows the result under an incident's or a run's timeline, with links to download the same audit trail as JSON or CSV. The JSON describes how each hash is made, so the trail can be checked without PayOnce. The CSV is for reading in a spreadsheet. A cell that starts with `=`, `+`, `-` or `@` gets a leading apostrophe there, so a supplier's email subject cannot run as a formula. Check hashes against the JSON.

Lines written before the chain existed were hashed the first time the ledger was opened with it, and the export marks them. The chain catches a quiet edit to the file. It cannot stop someone who can write the file from rewriting a timeline and recomputing every hash after it. To show later that a timeline changed after a given day, keep that day's export, or just its last hash, somewhere else.

## The cost of a second transfer

A failed SWIFT transfer gets its amount back but not its fee, so a replacement pays the fee again. PayOnce adds that fee to the cost of a replacement before it checks the reserve floor. It also takes off money already committed to other payments from the same wallet and not yet sent, and the timeline shows the numbers. In the `eur-swift-low-reserve` scenario the invoice gets a floor of its own, stricter than the one for EUR, set so that the second fee is what breaches it, and the incident goes to a person.

## Reserve floors

`RESERVE_FLOORS` in `.env` sets how much each wallet keeps back, as currency and amount pairs: `RESERVE_FLOORS=USD:1000000,EUR:1000000`. PayOnce replaces a failed payment by itself only if the wallet stays above its floor afterwards.

A currency that is not listed has no floor, and PayOnce never replaces a payment in it by itself. The incident goes to a person, the same way approvals are refused when `APPROVERS` is missing. To say on purpose that a currency needs no floor, list it with 0, as in `EUR:0`. If the setting cannot be read, every automatic replacement goes to a person. Floors are read when PayOnce starts, so a change needs a restart.

PayOnce checks the floor again each time it looks at an incident waiting on a person. If a replacement would take cash below the floor, the currency has no floor or the setting cannot be read, the approval request says so, the first request included, along with the reason the incident went to a person. An approval counts only if its request named the floor. Otherwise PayOnce voids it and opens a new request that gives both reasons. If cash rises back above the floor, an approval given while it was short still counts. The request does not say how far short cash was, so PayOnce spends such an approval however far cash has fallen since. A figure in the request would void approvals every time the balance moved.

A single incident's first payment is not checked against the floor. A pay run's rows are, when the run is checked, again when it is released, and once more when each row is sent.

## Cash panel

The page opens with a cash panel, one row per currency. A row shows the available balance from Airwallex, the reserve floor and the headroom: how much can still leave the wallet before cash drops below the floor. Open a row to see how the headroom is worked out, with each figure tagged by where it comes from.

The balance comes from Airwallex, with the age of the read. Money held for outgoing payments and money still arriving from currency conversions are shown next to it, but neither is part of available. A payment from another currency's wallet is listed under the wallet it leaves, at the amount on its transfer, or on its quote before the transfer exists. When no request is open on a quote, for example because nobody on the list can approve it, the panel shows the latest quote's amount and marks it as estimated from a quote. Before any quote is taken it shows 0, estimated. The floor comes from `RESERVE_FLOORS`, and any invoice held to a stricter floor of its own is listed under it. The rest comes from PayOnce's ledger. Payments being sent that have no transfer yet, approvals given but not used yet and the rows of approved pay runs are taken off to give the headroom. A second figure also takes off every invoice waiting on a person that could still be paid, with or without an open approval request, as if each one were approved. A pay run waiting for its approval is in neither figure. Its rows count only once the run is approved.

Below that the panel lists payments already with the bank, payouts sent outside PayOnce and the fees kept on failed transfers. Airwallex takes a transfer out of available as soon as it is created, so the panel does not take these off again. Each is listed under the wallet the money left. A payout paid from another currency counts in the currency it was paid from, and a fee counts in the currency it was charged in.

The panel reads the balance from Airwallex when the page asks for it and the last read is 30 seconds old or more, so it reads nothing while no page is open, unless alerts are on. Then the server also reads it every 5 minutes (see Alerts). After a quiet spell the first answer can show a read several minutes old, with its age, while a new read runs. The page says so and picks up the new read a moment later.

That read is for display. Before an automatic replacement, PayOnce reads the balance fresh and takes off the same committed money the panel does. The panel's headroom can still differ from what that check sees. The panel's balance may be older, and the panel takes off the currency's floor, while an invoice with a stricter floor of its own is held to that floor (the panel lists such invoices under the floor). The check for one invoice also leaves that invoice's own committed money out.

If a read fails, the panel keeps the last good one, shows its age and says why the newer one failed. If no read has worked yet, it shows no headroom, because a headroom worked out from a missing balance would be wrong.

PayOnce reads each transfer's fee and keeps it in the ledger, and fills in older failed transfers, up to five after each balance read. A transfer it cannot read waits 10 minutes before the next try, and the others go first. The fee line is called "Fees on failed transfers". Once a fee on a failed transfer is on file, a note under it says the sandbox keeps the fee when a transfer fails. That rests on what the sandbox did with failed EUR SWIFT transfers, so the panel does not claim every rail works this way. The pay runs line takes off the rows of an approved run, and the released rows that have not sent their payment yet.

`pnpm cash` prints the same figures in the terminal after one fresh read. It exits with 1 when Airwallex could not be read, the floor setting is unreadable or a headroom is below 0, so a script can check it.

## Incident board

The page opens on the incident board, under the cash panel. It lists every invoice that is not closed, and the rows of a pay run waiting for approval, in four groups, most urgent first:

1. Waiting on a person, with money that could still leave a wallet: an approval request that is open, or approved and not used yet, an invoice held before paying, a failed payment with no request open, a pay run waiting for approval, or an invoice that an email waiting in the inbox names on its own, so the inbox offers it first. An email that names the invoice beside others, only nearly, or inside other digits adds a note to it and leaves it in its group.
2. Bank deadline passed: a payment still with the bank after its deadline.
3. With the bank: a payment, or a payout sent outside PayOnce, that the bank still has.
4. Everything else that is open, such as a paid invoice waiting for someone to close it, an approved pay run that PayOnce releases on its next check, or a pay run row waiting for its turn.

Within a group, the invoice with the most money at risk comes first, then the oldest. Money at risk is what could still leave a wallet for the invoice, fee included, in the currency of the wallet it leaves: a payment being sent, approved or waiting on a person, a held invoice's amount, a pay run row, or a payment still with the bank. For an invoice paid from another wallet it is the quote's amount. The board takes these figures from the cash panel and never works them out another way.

The totals at the top add them up per currency, in the cash panel's terms. "Approved or being sent" is the panel's payments being sent, approvals not used yet and approved pay runs not sent yet. "Waiting on a person" is the panel's line of that name. "With the bank" is the panel's "With the bank" and "Payouts sent outside PayOnce" together. A pay run waiting for approval gets a part of its own, because the cash panel counts a run only once it is approved. PayOnce has no exchange rates, so the board ranks amounts in different currencies as plain numbers. Filter by wallet to rank one currency on its own.

Each row gives the invoice, the supplier, the amount and the wallet it is paid from, why it is in its group, how long since PayOnce took it on, and a link to the incident, or to the pay run for a row not released yet. The reasons are PayOnce's own fixed words, never an email's. The board has no buttons of its own: the cards on the incident do the work. You can filter by group, by wallet and by origin (PayOnce, sent outside PayOnce, pay run). The board reads only the ledger and refreshes with the incident list. The incident list stays in the sidebar. Next to each invoice's state it names the board's group when that tells you more, such as "Bank deadline passed". The "Incident board" button in the top bar brings the board back. With nothing in the ledger yet, the board says how to start the first incident.

`pnpm board` prints the same ranking in the terminal. It takes the same filters as words in any order, such as `pnpm board deadline USD outside`. A word that is not a group, an origin or a currency prints the usage.

## Pay runs

A pay run pays a batch of invoices from one CSV file on one approval. Upload the file on the page under "Pay run", or with `pnpm payrun upload <FILE> <NAME>`.

```csv
invoice,supplier,beneficiary_id,amount,currency,method,due_date,sandbox_outcome
INV-RUN-1001,Example Supplier LLC,6170b987-3840-4825-8da6-c27671bd26ad,40.00,USD,LOCAL,2026-11-02,PAID
INV-RUN-1002,Example Supplier LLC,6170b987-3840-4825-8da6-c27671bd26ad,41.00,USD,LOCAL,,ACCOUNT_CLOSED
```

`fixtures/pay-run-example.csv` is a sample. Its beneficiary ids belong to the sandbox account PayOnce was built on, so use your own.

Each row names the beneficiary by its Airwallex id and gives the supplier's name, the amount and the currency. The amount is in major units with a dot, at most two decimals and no thousands separator. `method` is optional, and so is `due_date`, written like 2026-11-02 (see [Route advisory](#route-advisory)). `sandbox_outcome` tells the sandbox bank what to do with the row's payment: `PAID` by default, or a failure type as in `pnpm recover`. `supplier_domain` is optional too: the domain the supplier's emails come from, which the sender check trusts for that invoice. It is part of what the approvers approve. A domain that differs from the one on file for the beneficiary, or from another row of the same run, or that is the first domain for a beneficiary PayOnce has already paid, shows a caution and needs two approvers. A row without one flags every sender. PayOnce never reads bank details or phone numbers from a file. It pays the account on the beneficiary record. Every row pays in its own currency from that currency's wallet. PayOnce refuses a file with a column naming another wallet to pay from, such as `source_currency`. Pay such an invoice on its own. A file holds 50 rows at most. A file PayOnce cannot read is refused with every problem found. A problem in the header, such as a missing or unknown column, gives the header's line, and a quote that never closes gives the line it opened on. A problem with the whole file has no line: no name, an empty file, no rows after the header, more than 50 rows, or more than 40,000 characters.

PayOnce checks every row with GETs only. It skips a row that:

- has a cell it cannot read, such as `4,000.00`, `40.005`, a currency without two decimals or a due date that is not a day on the calendar;
- has an invoice number the ledger already has, or the same number for the same supplier apart from case, spacing or leading zeros;
- repeats an earlier row's number, or looks like a second bill for an earlier row of the file;
- names a beneficiary Airwallex does not have, or one whose account name, currency or transfer method does not match the row (names are compared without case, spacing or punctuation);
- pays a beneficiary whose bank details are not the ones PayOnce last paid it, unless a callback verified the new ones.

A skipped row says why on the page and on the run's timeline, and its number stays free for a corrected file. A row that looks like a second bill for an invoice already in the ledger is released with the run, and PayOnce holds it for a person when it comes to send it, as it holds any likely duplicate.

The cash check comes last. In each currency, the rows and their expected fees must leave the wallet above its reserve floor, after money already committed elsewhere. If they do not, every row in that currency is skipped, and the timeline says how far below the floor they would take cash. So the order of the rows never decides who is paid. A currency with no floor set does not stop a run, because a person approves every run, and the approval card says no floor is set, on the page and in `pnpm payrun approve`.

### Approving a run

The run's approval covers every row it pays and the total in each currency, bound by a hash like any other approval. Limits apply to the total in each currency, so splitting one payment into small rows gains nothing. Two approvers are needed when any currency's total is above `TWO_APPROVERS_ABOVE`, when a row pays a beneficiary PayOnce has never paid, and when a row pays an account a callback verified. The person who uploaded the run cannot approve it, and nor can anyone who recorded the callback for an account it pays. The upload in the terminal needs a name, so nobody uploads under their login name and approves under another without noticing.

A run's request expires like any other, but it does not renew by itself. "Check again" on the page, or `pnpm payrun check`, runs every check again and opens a new request. Only one run waits for approval at a time. To upload a corrected file, cancel the waiting run first. Cancelling moves no money and frees its invoice numbers. While a run is approved and waiting for its release, checking it again is refused, so the rows the approvers saw are the rows released.

### Release

Once the run is approved, the server checks every row again. If anything changed, or the approval policy no longer accepts the approval, the approval is void and the run waits for someone to check it again. Next, PayOnce takes the lock of each currency the run pays, reads the balance again and checks the floor. If the run no longer fits, it is not released. Otherwise one database transaction spends the approval and writes each row as an invoice that pays the account the approvers approved. Each invoice's first timeline line names the run, the row and the approval. `pnpm payrun approve` only records an approval, and `pnpm ui` releases the run on its next check.

The server then sends each invoice's first payment one at a time, in file order, each under its currency's lock and checked against the floor once more. Only the release, and the server's status check once the release has stopped, send a row's first payment. Checking the invoice again, a webhook or a sweep leaves an unsent row for its turn. A row is held for a person instead when its beneficiary's bank details changed since the approval, when it would now take cash below the floor, or when another invoice to the same supplier already has its number. From there each invoice is an incident like any other. A row whose payment fails is escalated or replaced by the usual rules.

### One payment at a time per currency

Every payment PayOnce sends holds a lease on the currency it leaves from (USD for a EUR invoice paid from USD), from its last read of Airwallex until the transfer is created and recorded. That covers a single incident's first payment, a run's row, an automatic or approved replacement, a held invoice paid on an approval, and a retry of a payment that may not have reached Airwallex. A run's row and an automatic replacement read the balance under the lease. An approved replacement and a held invoice paid on an approval read it before they take the lease, and under it only check that the supplier's record still holds the approved account. The lease is a row in the ledger, so the terminal and the server take turns, and it runs out after a minute if the process holding it dies. An automatic replacement reads the balance again under the lease and decides again on it, so two replacements in one currency can no longer pass on the same cash. Payments get the lease in the order they asked for it, so a run sending its rows one after another cannot keep a replacement waiting. A payment waits up to 45 seconds for the payments ahead of it. Then it sends nothing, spends no approval and tries again a minute later. PayOnce writes a payment to the ledger before sending it, and releases a pay run, only in a transaction that finds the lease still held, so a payment whose lease ran out before that write is never written or sent. Once it is written it is sent, even if the lease runs out before the transfer is created. Payouts sent from the Airwallex web app take no lease.

## Webhooks

`pnpm ui` listens for Airwallex payout webhooks on a second port, 4311, that answers one path. To give Airwallex an address it can reach, PayOnce opens a Cloudflare quick tunnel, which needs no Cloudflare account. It then points its Airwallex webhook subscription at the tunnel. The first run creates the subscription, and later runs move it, because a quick tunnel gets a new address each time it starts. The page and its API stay on this machine and are not behind the tunnel.

An event counts only if its signature checks out with the subscription's secret, and an event already seen is ignored. A paid or failed event only tells PayOnce to look again. PayOnce reads the transfer from Airwallex and decides on what it reads. An event for a transfer PayOnce does not know starts a sweep.

A status check runs every 15 seconds in case an event is late or lost, and every 3 seconds when webhooks are off. In the sandbox, Airwallex records an event for every status change but leaves each one queued and never sends it, even a test event sent from its own web app, so the status check finds every change. A request from outside through the tunnel does reach the receiver.

Install cloudflared with `winget install --id Cloudflare.cloudflared`, or set `CLOUDFLARED` to the path of `cloudflared.exe`. Set `WEBHOOK_URL` to use a public address you already have, or `WEBHOOKS=off` to skip webhooks.

## Alerts

PayOnce can post to a Slack or Discord channel when something needs a person. It alerts on an invoice that is escalated, held or waiting on an approval, a bank deadline that has passed, a payout sent outside PayOnce, a pay run waiting for approval, supplier emails waiting in the inbox for a person, an audit trail that no longer verifies, and a currency whose headroom has gone below 0.

Set `ALERT_WEBHOOK_URL` to a Slack incoming webhook (`https://hooks.slack.com/services/...`) or a Discord webhook (`https://discord.com/api/webhooks/...` or the same on `discordapp.com`, with `ALERT_FORMAT=discord`). PayOnce takes no other address. If the setting is wrong, the start-up line says why and nothing is posted. With no address set, PayOnce makes no alert calls at all. Treat the address as a password and keep it in `.env`. PayOnce prints its host and never the rest.

Only `pnpm ui` posts. Every 5 seconds it works out from the ledger what needs a person, which is the same state the page shows, so an incident escalated in the terminal is alerted by the server on its next check. A condition alerts once when it appears, and again only when it changes: an approval request opening on an escalated invoice, say, or a new reason. A request renewed on the same terms does not alert again, and neither does a floor clause that comes and goes as the balance moves. Each alert waits 10 seconds before it goes out, so when a request opens a moment after an escalation, only the request is posted. If the condition then goes back to what it was, as when that request is withdrawn, the alert held back is posted after all. A condition that clears and comes back within 10 minutes alerts again only if it changed.

The first time alerts are on for a ledger, PayOnce records what is already waiting and posts one summary, such as "2 invoices are waiting on a person, 1 pay run waits for approval, 1 supplier email waits in the inbox", instead of an alert for each. It waits for the server's first balance read before it looks, so a currency already below 0 is counted in the summary too. If nothing is waiting, it posts nothing.

An alert gives the invoice number, the supplier, the amount, the reason PayOnce recorded, how many approvers a request needs and when it runs out, and a link to the incident on the local page. The link only works on the machine running PayOnce, and the message says so. An inbox alert says only how many emails wait, and it comes again when a new one is uploaded, not when one is delivered or dismissed. An alert never carries email text, a sender or a subject, anything the model read, an account number or any digits of one, an approver's name or a secret. Text PayOnce did not write itself, such as a supplier name, goes out as code, with `://` and `www.` broken up, so it cannot turn into a link, a mention or formatting. PayOnce also strips characters that can reverse or hide part of it, such as right-to-left overrides and zero-width spaces. The only link in an alert is the one to the local page. Discord mentions are off, and long values are cut to fit each service's limits.

When a post fails, PayOnce tries again after 30 seconds, 2 minutes, 8 minutes and 32 minutes, then gives up. After a 429 it waits as long as the answer asks. If the webhook answers 401, 403, 404 or 410, the address is wrong or the webhook is gone, so PayOnce stops posting until it is restarted. It does not follow redirects. The agent, the watcher and the page never wait on a post. If the server dies between posting an alert and recording it, the alert can be posted again a minute later, because incoming webhooks take no idempotency key.

While alerts are on, the server also reads the balances every 5 minutes when nothing else has, so a headroom below 0 is noticed with no page open. Like any balance read, each one also reads up to five transfers to fill in the fees of failed transfers.

To try alerts without Slack or Discord, run a receiver on this machine and set `ALERT_TEST_RECEIVER_URL` to it, such as `http://127.0.0.1:4399/slack`. It takes only a 127.0.0.1, localhost or [::1] address, and while it is set PayOnce posts there instead of to `ALERT_WEBHOOK_URL`, in the format `ALERT_FORMAT` names. `GET /api/alerts` lists the last 50 alerts and how each one went.

## Messages to send

Each incident has a "Messages to send" card, and `pnpm outbox` does the same in the terminal. PayOnce suggests the messages that fit the incident now, a person drafts one, copies it into their own email and sends it to the contact on file, then marks it sent. PayOnce never sends anything itself.

There are four messages for the supplier: the payment has been sent (with its reference, amount and when it usually arrives), it has been sent again after a failure, we are looking into it (which promises nothing), and we will call you on the number we have on file to confirm a change of bank details. That last one asks the supplier not to send bank details by email. The fifth is a trace request to Airwallex for a transfer past its deadline, with its reference, amount, creation time and status.

If the supplier has asked to hold, cancel or not pay the invoice, PayOnce suggests nothing to send them. The card says why and lists the messages that would fit, each with a "Draft one anyway" button. The trace request to Airwallex is still offered. A message already marked sent is not offered again until its facts change, for example when the bank pays.

A draft is built only from what PayOnce formats itself: the invoice number, amounts, bank references, dates and statuses, and the last four digits of the phone number on file. It never includes the supplier's name, anything from an email, an escalation reason or account details. For when a payment usually arrives it uses the route advisory's latest usual day, never PayOnce's own bank deadline, and without an estimate it says "within the usual time for this route".

The text is fixed when it is drafted. Its SHA-256 goes on the incident's timeline in the same write, and copying, sending and dismissing are recorded there too. If the payment changes afterwards, for example the bank pays it, the card says what changed and suggests drafting it again. If the stored text no longer matches its hash, the card says that too.

## Run it

```bash
pnpm install
pnpm dev
```

`pnpm dev` needs no credentials. It reads the sample supplier emails in `fixtures/emails/` and prints the findings and the decision for seven incidents.

Everything else talks to the Airwallex sandbox. Copy `.env.example` to `.env` and fill in a sandbox Client ID and API key. Set `RESERVE_FLOORS=USD:1000000,EUR:1000000` as well. Without it no currency has a floor, and every failed payment goes to a person instead of being replaced.

For a model to read the emails, create a Gemini API key in Google AI Studio and set it as `READER_API_KEY`. The free tier needs no billing account. Google may use free-tier content to improve its products. The "Supplier email" card says so next to the upload: keep confidential mail out, or leave the key unset and let the keyword placeholder read it. `READER_MODEL` takes a comma-separated list of models to try in order.

### The web page

```bash
pnpm ui
```

Open `http://127.0.0.1:4310`. The page opens on the [incident board](#incident-board). `docs/demo.md` walks through four incidents in under five minutes. Choose a payment, a bank outcome and a supplier email thread, then start an incident. The page follows it step by step. The agent waits for a webhook or a status check after each bank outcome, so an incident takes up to a minute in the sandbox. When an incident is waiting on a person, the approval card shows the terms and takes a name. If the bank has paid the invoice, a close card takes a name and a note instead. "Check again" continues an incident that stopped part-way.

The server has no login. It listens on this machine only and accepts changes only from its own page.

### The terminal

```bash
pnpm recover [OUTCOME] [INVOICE] [EMAILS] [SCENARIO] [NAME]
pnpm approve <INVOICE> [REQUEST NAME]
pnpm close <INVOICE> [NAME] [NOTE]
pnpm run audit [INVOICE] [json|csv]
pnpm run audit run <RUN> [json|csv]
pnpm cash
pnpm board [FILTER...]
pnpm payrun upload <FILE> <NAME>
pnpm payrun show <RUN>
pnpm payrun approve <RUN> [REQUEST NAME]
pnpm payrun check <RUN>
pnpm payrun cancel <RUN> <NAME> <NOTE>
pnpm outbox <INVOICE>
pnpm outbox <INVOICE> draft <TEMPLATE> <NAME>
pnpm outbox <INVOICE> show <DRAFT>
pnpm outbox <INVOICE> sent <DRAFT> <NAME>
pnpm outbox <INVOICE> dismiss <DRAFT> <NAME> [NOTE]
pnpm reset
```

`pnpm outbox` lists an invoice's drafts and the messages that fit now. The templates are `payment-sent`, `replacement-sent`, `checking`, `callback-notice` and `bank-trace`. It reads and writes only the ledger, and runs without a `.env`. When there is one, it takes the bank deadlines from it.

`pnpm payrun upload` and `check` read Airwallex, GETs only. `show`, `approve` and `cancel` read only the ledger. `approve` without a name shows the terms and the request number, like `pnpm approve`.

| Argument | Values | Default |
| --- | --- | --- |
| `OUTCOME` | A simulated bank outcome: `PAID`, `STAYS_IN_FLIGHT`, or a failure type such as `CHANNEL_TIMEOUT`, `SYSTEM_ERROR`, `BENEFICIARY_BANK_RETURNED` or `ACCOUNT_CLOSED` | `CHANNEL_TIMEOUT` |
| `INVOICE` | Any invoice number. A new one starts an incident and an existing one continues it | A random number |
| `EMAILS` | `nothing-arrived`, `new-account` or `moved-banks` | `nothing-arrived` |
| `SCENARIO` | `usd-local`, `eur-swift`, `eur-swift-low-reserve`, `usd-local-bank-change` or `eur-from-usd` | `usd-local` |
| `NAME` | Who is starting the incident. That person cannot approve a payment for it | Your login name |

Five runs to try:

```bash
pnpm recover
pnpm recover ACCOUNT_CLOSED
pnpm recover CHANNEL_TIMEOUT INV-5001 new-account
pnpm approve INV-5001
pnpm approve INV-5001 1 Alex
pnpm recover - INV-5001
pnpm recover PAID INV-5002
pnpm close INV-5002
pnpm close INV-5002 Yash supplier found the payment
pnpm recover PAID inv-05002
pnpm close inv-05002 Yash supplier sent it twice
```

The terminal has no webhook receiver, so `pnpm recover` checks the bank every 2 seconds and returns once the incident is closed or waiting on a person.

The first replaces the payment and shows the lock refusing a second one. The second ends in an escalation. In the third, the supplier asks for payment to a new account from a look-alike address, so it escalates although a channel timeout on its own would be replaced. `pnpm approve` with no name shows the terms, the request number and who may approve them. With the request number and a name it records that person's approval, so `1` stands for the number it printed. A request opened since is refused, so nobody approves terms they have not seen. `pnpm recover` started the incident under your login name, so approve it under a name from `APPROVERS`. `pnpm recover - INV-5001` then sends the replacement to the account on file. The outcome is ignored for an invoice that already exists, so `-` works as a placeholder.

In the fourth, the bank pays the original while the supplier says it never arrived, so the incident goes to a person. `pnpm close` with no name shows what is waiting, and with a name and a note it closes the incident.

In the fifth, `inv-05002` has the same supplier, amount and number as INV-5002, so PayOnce holds it and sends nothing. `pnpm close` closes it without paying. To pay it instead, approve it with `pnpm approve` and run `pnpm recover - inv-05002`. The bank then pays the original, or does what the outcome says if one is given in place of `-`.

## Layout

| File | Contents |
| --- | --- |
| `src/decide.ts` | The decision policy, a pure function |
| `src/incident.ts` | Types for an incident and a decision |
| `src/engine.ts` | The agent: look at an invoice, read new emails, decide, replace or escalate, and the timeline |
| `src/dispatcher.ts` | Runs the agent's steps one invoice at a time |
| `src/watcher.ts` | Status checks on payments in flight, the fallback for webhooks. It also wakes an incident at its deadline and runs the sweep |
| `src/deadlines.ts` | How long the bank has to pay or fail a transfer |
| `src/arrival.ts` | The route advisory: how many business days each route usually takes, the arrival against a due date, and the fee last seen |
| `src/sweep.ts` | Finds payouts PayOnce did not send |
| `src/duplicates.ts` | Finds invoices that look like a second bill, and the invoice a payout sent outside PayOnce is for |
| `src/webhooks.ts`, `src/tunnel.ts` | The webhook receiver and its signature check, and the cloudflared tunnel |
| `src/sandbox-bank.ts` | Plays the bank in the sandbox: sends, pays and fails transfers |
| `src/scenario.ts` | The sample payments and the scripted incident |
| `src/assess.ts` | Maps an Airwallex transfer to the facts the policy reads |
| `src/ledger.ts` | Obligations, payment attempts, approvals, emails and the timeline in SQLite |
| `src/audit-trail.ts` | How timeline lines are hashed and checked, and the JSON and CSV export |
| `src/payments.ts` | Sends an attempt under its `request_id`, syncs transfer state and fees into the ledger, and fills in fees missing from older failed transfers |
| `src/reserve.ts` | The reserve floors from `RESERVE_FLOORS`, the floor one invoice's replacement is held to, and the wallet a payment leaves |
| `src/cash-position.ts` | The cash panel's figures, and the committed money the policy also takes off, pay runs included |
| `src/incident-board.ts` | The incident board: every open invoice in its group, with the money it has at risk and why |
| `src/run-file.ts` | Reads a pay run CSV file and the cells of each row |
| `src/runs.ts` | Pay runs: the checks, the terms and the request, approving, releasing and cancelling a run |
| `src/currency-lock.ts` | The lease that lets one payment at a time be sent in each currency |
| `src/fx.ts` | How long an exchange rate quote holds, from `FX_QUOTE_VALIDITY` |
| `src/approval.ts` | Approval terms, the exchange rate quote in them, the hash that binds an approval to them, and the amount limits are compared with |
| `src/approvers.ts` | The approval policy: who may approve, how many are needed, and when a request expires |
| `src/bank-change.ts` | Records a callback about new bank details and updates the supplier's record in Airwallex |
| `src/emails.ts` | The email reader interface, the findings a reader returns, the sender check and the email evidence in approval terms |
| `src/eml.ts`, `src/html-text.ts`, `src/css-text.ts` | Read an uploaded email: headers, MIME parts, charsets, HTML to text, and the strings in its styles |
| `src/intake.ts`, `src/parse-worker.ts` | Parses an upload in a worker thread, stores it, finds the invoices it names, and delivers it to the one a person picks |
| `src/model-reader.ts` | The model reader: one chat completion that returns the findings |
| `src/reader.ts` | Picks the model reader, or the keyword placeholder when no key is set |
| `src/keyword-reader.ts` | Keyword placeholder that reads the emails when no key is set |
| `src/drafts.ts` | Messages to send: the templates, which ones fit an incident, and drafts that keep their hash |
| `src/alerts.ts` | Alerts: the webhook setting, what needs a person, and posting with retries |
| `src/alert-payloads.ts` | What an alert says, and its Slack and Discord message shapes |
| `src/server.ts` | Local web server and JSON API |
| `src/recover.ts`, `src/approve.ts`, `src/close.ts`, `src/audit.ts`, `src/cash.ts`, `src/board.ts`, `src/payrun.ts`, `src/outbox.ts`, `src/reset.ts`, `src/index.ts` | The commands |
| `src/airwallex/` | Sandbox client: login, beneficiaries, transfers, exchange rate quotes, balances and their cache for the cash panel, the webhook subscription and the simulation calls |
| `web/` | The page: plain HTML, CSS and JavaScript with no build step |
| `fixtures/emails/` | Sample supplier emails |
| `fixtures/pay-run-example.csv` | A sample pay run file |

The code holds amounts in minor units and converts at the Airwallex boundary. The ledger is `payonce.db` in the working directory. `pnpm reset` moves it aside, and the next run starts an empty one. Stop `pnpm ui` first.

## Not built yet

- A model's explanation of each decision. The reasons on the timeline come from the policy.
- Closing an incident without a payment, except a held duplicate. A person can close any other only when the bank reports a payment for the invoice as paid.
- Chasing the bank by itself. When a payment passes its deadline, PayOnce tells a person and offers a trace request for them to send to Airwallex.
- Sending email. Messages are drafted for a person, who sends them from their own mail, and PayOnce keeps no recipient addresses.
- A floor check on a single incident's first payment. Pay run rows have one.
- Totals across currencies. They need exchange rates. A run's approver limits are compared with each currency's total on its own, and the incident board ranks amounts in different currencies as plain numbers.
- Rail outages on the incident board. The board keeps an empty place for them at the top.
- Editing a run, approving part of one, or scheduling one for a later date. Cancel it and upload a corrected file.
- Recording a callback for a supplier outside an incident, so a run can pay a supplier who changed banks.
- Pay run rows paid from another currency's wallet. Each row pays in its own currency from that currency's wallet.
- Paying a replacement from the currency a failed converting payment is refunded in. By Airwallex's docs that refund lands in the transfer currency by default, so a replacement from that wallet would need no new rate. The sandbox simulator cannot fail a converting payment, so the refund cannot be seen and the replacement pays from the original's wallet again, on a new quote.
- A fee estimate for the first payment of an invoice paid from another wallet. The card says the fee is charged when it is sent.
- Choosing or switching a payment's route. The route advisory says when a payment usually arrives and whether it may be late, and a person decides what to do.
- Public holidays in arrival estimates, and arrival figures for countries other than the United States and Germany.
- A due date for `pnpm recover`. Give one on the page or in `POST /api/incidents`.
- A webhook delivered by the sandbox. The receiver, the tunnel and the subscription work, and Airwallex records the events, but the sandbox has not sent one.
- Real bank outcomes. The run uses the sandbox simulator to send, fail and pay transfers.
- Fetching mail. Emails arrive only as uploads, with no IMAP, Gmail or forwarding address, and there is no terminal command for them.
- Opening attachments, loading images or following links. A PDF, an image of text or a forwarded email is listed by name, and a forwarded one makes the email partly unread.
- Checking DKIM, SPF or DMARC. Nothing in an email proves its sender, which is why bank details change only through a callback.
- A mail client's layout. PayOnce reads every character it can, but not the order a client draws them in.

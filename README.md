# PayOnce

A payment incident agent that recovers failed supplier transfers without paying twice.

PayOnce is my entry for the Airwallex Agentic Banking Hackathon 2026. It starts from starter kit 3, Payment Ops Incident Commander.

> Status: working demo against the Airwallex sandbox. A model reads supplier emails when a key is set, and a keyword placeholder reads them when it is not. Sandbox only, no real money.

## The problem

A supplier says a payment never arrived and their deadline has passed. The transfer shows as sent but not settled. Finance can wait, send a replacement, or escalate, and each choice can go wrong: wait too long and the supplier stops shipping, replace too early and you have paid twice. This is also when fraudsters send the "please resend to our new account" email.

## What it does

PayOnce follows each supplier payment through an incident. It sends the transfer and then reacts to what happens: the bank pays or fails it, the supplier writes in, or a person approves something. A status check, or an Airwallex webhook on an account that delivers them, tells it the bank has moved, and it reads the transfer from Airwallex itself before it decides. PayOnce calls one such read and decision a look. Each time, it waits, replaces the payment, closes the incident, or hands the decision to a person. A web page shows each incident as a timeline, with the emails, the payments and whatever a person is asked to approve or close. A person can upload a supplier's real email there, and PayOnce reads it as untrusted text that can only add caution.

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
| The invoice looks like a second bill for another invoice that is already paid | Escalate to a person |
| The policy would replace, but an outage is active on the payment's currency and transfer method | Escalate to a person |
| The original failed, a resend can fix it and the beneficiary details are unchanged | Replace |

`src/decide.ts` checks the rules in that order, apart from the second bill and the outage. The engine checks those two where `decide.ts` would replace, the outage last, in the transaction that would open the replacement (see [Rail outages](#rail-outages)). A transfer found late that may pay the supplier twice, or one under a payment's request id that does not match the invoice, holds the invoice for a person before the policy runs at all (see [Payouts sent outside PayOnce](#payouts-sent-outside-payonce)). A resend can fix a failure only when it happened on the sending side: a system error or a channel timeout. Any other failure, including a return from the beneficiary's bank, goes to a person.

When the supplier asks to hold, cancel or not pay the invoice, and the policy escalated for an earlier rule or the invoice was already held before paying, PayOnce adds "and the supplier asks to hold, cancel or not pay this invoice" to the reason. The approval request, the alert and the approval card all show it, and a person can still approve paying.

Two of these checks do not depend on how the email text is read. The sender's domain, and the Reply-To's, is compared with the one on file, as ASCII only, so a look-alike character such as the Kelvin sign cannot pass for a K. An invoice with no domain on file flags every sender. The supplier's bank details are read from Airwallex again and compared with the account the original payment went to. When they differ the timeline says so, whatever reason the policy escalates for.

A model reads the supplier emails, one at a time. It holds no credentials and moves no money. It answers three yes-or-no questions: does the supplier say the payment has not arrived, ask for a different account, or ask to hold, cancel or not pay the invoice. PayOnce writes the summary a person sees from those answers, so no wording from an email or from the model reaches the approval card. A keyword check reads the same email, and a finding is yes if either says yes. A finding, once made, stays: a later email cannot clear it. Every finding leads to more caution, so an email that tricks the model cannot remove a finding the keyword check makes. An email that the keyword check misses and that also tricks the model can still hide a finding, which is why the sender check and the bank-details check are in code. The emails go to the model marked as untrusted text. If the model fails, or its answer is not three yes-or-no values, the thread counts as unread and the incident goes to a person. The timeline then says, in PayOnce's own words, what happened to each model, such as "gemini-3.5-flash was busy (503), then gemini-3.1-flash-lite timed out after 8 s", and that PayOnce reads the email again on its next look. Nothing the model service wrote goes on the timeline.

The reader is Gemini 3.5 Flash by default, with Gemini 3.1 Flash-Lite as a second model if the first does not answer. Both are on Google's free tier and are called through its OpenAI-compatible endpoint, so any service that speaks the same format can replace them. Without a key, a keyword placeholder in `src/keyword-reader.ts` reads the emails. The page names the reader under its findings.

## Supplier emails you upload

Real supplier mail reaches PayOnce through the "Supplier email" card on the page. Choose the `.eml` file, or paste the raw source (Show original or View source in your mail client), and add your name. One email per upload, up to 2 MB. PayOnce refuses an Outlook `.msg` file, and refuses text that is not raw source, so pasting what the mail client shows does not lose the first paragraph to the headers. If a paste starts with a header line such as `Subject:` and the text follows with no blank line, PayOnce reads that text as part of the email and marks the email partly unread.

PayOnce parses the email itself, with no library. It keeps the sender's address and display name, Reply-To, the subject, every text part (plain and HTML) and a list of attachments by name, type and size. The reader reads the display name, because a mail client shows it, but the sender check never compares it. PayOnce ignores the Sender header and checks only From and Reply-To. It never opens an attachment, loads an image or follows a link. It treats every byte as hostile, and parses each upload in a worker thread of its own. If a parse takes more than 2 seconds or 256 MB of memory, PayOnce stops it and refuses the email, so one slow email cannot hold up the agent or the page. It reads one upload at a time, with up to four waiting, and past that asks the next person to try again in a moment. If an email or a pay run file takes more than 30 seconds to arrive, PayOnce refuses it and keeps nothing, so a slow connection cannot hold up the uploads behind it. An ambiguous sender becomes "no sender address PayOnce could read", which the sender check flags. PayOnce strips invisible characters and terminal control codes, and keeps its own notes about the email apart from the text, so an email cannot forge one.

PayOnce turns HTML into text in one pass, and when in doubt it reads more than a mail client shows. Script and style content stays out of the text, but every string in it, and any text in it that is not CSS, is shown and read as "text found inside styles". What a form field shows (an input's value, or the placeholder of an input or text area) and CDATA inside SVG or MathML are read as text too. Anything CSS could make a client draw that is not one of those strings, such as a web font, a counter or a reversed run of digits, or a style sheet from outside the email, marks the email partly unread. So does text past 32,000 characters, a text attachment, a forwarded or encrypted email, or a part in a character set PayOnce cannot decode. A partly unread email sends the invoice to a person, who reads it in their own mail client.

PayOnce does not lay out the HTML the way a mail client does. Reordering, list numbering and positioning can show a person the same characters in another order than the reader gets them. That is accepted because no protection depends on it: bank details change only through a callback to the number on file, the sender check works on addresses, approvals bind the account read from Airwallex, and the findings only add caution.

The upload waits in the inbox. PayOnce lists the invoices it names, from invoice numbers in the subject, the text and attachment names, and offers one first only when exactly one invoice matches, in any state, and that invoice is open or with a person. A number found only inside other digits, as in a phone number, is never offered first. A person picks the invoice, or types another, and confirms. Nothing is delivered by itself. The agent then reads the email and decides again. A dismissed email stays dismissed, and the same email uploaded twice is refused with where the first one went.

An email on file before an invoice's first payment holds the invoice for a person, pay run rows waiting their turn included. A held invoice reads its emails, and its approval terms carry the findings. Approval terms count the emails on file, and how many could not be read in full or come from flagged senders, so any new email voids an open approval and the approvers look again. Terms never quote a sender's address or text.

## The duplicate lock

PayOnce writes every payment attempt to a SQLite ledger (`payonce.db`) before it creates the transfer. A unique index allows one attempt per invoice that has not failed, so the database refuses a second live payment. PayOnce can open a replacement only after the ledger records the original as failed.

Each attempt keeps its `request_id`. A retry reuses it, and Airwallex then returns the transfer it already has. A 4xx from Airwallex marks the attempt failed, except a 429, which only asks PayOnce to slow down: like a 5xx, it leaves the attempt pending for the next look to retry. PayOnce closes an incident by itself only when one attempt is paid and every other attempt has failed.

The Payments card has a "Pay again" button for the person who wants to send it once more to be sure. It opens a replacement attempt the way the agent would, inside a database transaction that is always rolled back. While a payment is live or paid, the lock refuses it and the timeline names the payment holding the lock. When every payment has failed there is nothing to refuse, but the button still sends nothing: a replacement goes through the policy, and through an approval once the invoice is with a person. Either way nothing reaches Airwallex.

## Deadlines

A transfer has a deadline: 3 minutes for a local transfer and 5 for SWIFT, counted from when Airwallex created it. Real rails take days and the sandbox moves in seconds, so the defaults suit the sandbox. `BANK_DEADLINE_LOCAL_MINUTES` and `BANK_DEADLINE_SWIFT_MINUTES` change them. While PayOnce waits on the bank, the timeline says how long the bank has before a person hears about it.

If the original is still in flight at its deadline, the incident goes to a person and PayOnce still sends nothing, because the bank may yet pay it. A replacement past its deadline goes to a person the same way, and the incident still closes if the bank pays it. The `STAYS_IN_FLIGHT` bank outcome leaves the original in `SENT` to show this.

## Payouts sent outside PayOnce

The lock only covers payments PayOnce sends. Someone can still pay the same invoice from the Airwallex web app. While `pnpm ui` runs, every 30 seconds PayOnce lists the transfers created since its ledger started and looks for ones it did not send.

- A payout whose reference is an invoice PayOnce has, or nearly matches one as described under [Duplicate invoices](#duplicate-invoices), goes on that invoice's timeline. While it is in flight or paid, PayOnce sends nothing for the invoice, withdraws any open approval and hands the invoice to a person. If the invoice was already closed, it is reopened. The payout counts as paying the invoice only when it delivered the invoice's amount in its currency, even from another wallet, and went to the account PayOnce would pay without a person. That is the account PayOnce last paid the supplier with a checked payment, the one on file once a callback verified it, or the one on file for a supplier PayOnce has never paid. A payout to the supplier's own record with other bank details does not count. A payout that only names the invoice, such as 0.01 USD to someone else with the invoice's number as its reference, is listed on the close card with what it delivered and the last four digits of the account it went to. The card then offers to close the invoice without paying, and a person may also leave it waiting. A payout PayOnce has not checked yet, such as one tied before an upgrade, counts as not paying until the next look reads it, and the card says so. If a person had closed the invoice without paying, a payout that names it keeps the invoice with a person while the payout is in flight or paid. PayOnce closes it again by itself only once that payout fails.
- Any other payout becomes an incident of its own once it fails or passes its deadline. PayOnce runs it like its own, except that a replacement always needs a person's approval, because whoever sent the original may be resending it too.

Before it sends any payment, PayOnce lists the transfers again, so a resend made a moment earlier is caught even between sweeps. That includes sending again a payment whose first try may not have reached Airwallex: while a payout sent outside PayOnce is in flight or paid, the payment stays open and is not sent. PayOnce checks the ledger once more right before the send, after waiting its turn on the wallet, so a payout another PayOnce process found in the meantime stops it too. A payout that has already failed holds nothing, so PayOnce tries the payment again straight away. If an outside payout fails after holding the payment, PayOnce sends the payment. A paid original then waits for a person to close the invoice, and a paid replacement closes it by itself. If the outside payout is paid, PayOnce waits until a bank deadline has passed since it last tried to send the payment, then asks Airwallex once more for a transfer under the payment's request id, at a moment when no PayOnce process can be sending it. If there is none, the payment never reached the bank, so PayOnce marks it failed. If there is one, PayOnce records it and follows it like any other. If Airwallex lists that transfer only after PayOnce marked the payment failed, PayOnce records it on the payment, provided it carries the invoice's number, amount and currency. If another payment for the invoice, PayOnce's or one sent outside it, has not failed either, the supplier may have been paid twice. PayOnce then sends nothing more for the invoice and hands it to a person with a reason of its own, which the alert and the close card show. A transfer the bank has live counts as live in every check PayOnce makes, even while the ledger still lists that payment as failed, so PayOnce opens no other payment beside it and never replaces it. When the other payment fails, PayOnce follows the late transfer as the invoice's payment. A payment of PayOnce's still open beside a late transfer is marked failed the same way, once a bank deadline has passed with nothing listed. A transfer under the payment's request id without the invoice's number, amount and currency is not recorded as that payment. PayOnce keeps it beside the payment, warns on the timeline, sends nothing for the invoice while the bank has it, and hands the invoice to a person. While the bank has it, the cash panel lists it with the bank. If it is paid, a payment of PayOnce's still open beside it is marked failed the same way, and a person can close the invoice, even when a payout sent outside PayOnce paid it as well. If the bank fails it, the reason the invoice waits for a person says so. After that only a person can close the invoice, and a person's close clears only the transfers of this kind that were on file when they closed it. A closed invoice stays closed unless the late transfer may still pay it. PayOnce closes an invoice by itself in one write that checks again that it is paid once, so a late transfer another PayOnce process records at that moment stops the close and the invoice goes to a person. If every payment PayOnce sent failed and a payout sent outside it paid the invoice, a person can close the incident from the close card.

## Rail outages

A rail is a currency and a transfer method, such as USD LOCAL. When payouts to three different payees fail on one rail within 30 minutes with a code that means the rail failed and not the account, PayOnce declares an outage on that rail. Those codes are 91401 (system error), 91402 (channel timeout), 99901 (unable to apply) and 99902 (other), and they can be mixed. A payee is the account paid, so two beneficiary records for one account count once, and so do several failures to one supplier. Payouts sent outside PayOnce count too. Failures that point at the account never count: account closed, invalid account, a return from the beneficiary's bank, a recall and a duplication return. `OUTAGE_FAILURES` and `OUTAGE_WINDOW_MINUTES` change the three and the 30.

PayOnce reads failures on a look at the invoice or in the sweep. It dates each one by the time Airwallex last updated the transfer, which is when it failed, and leaves it out once that is more than the window ago, so failures read late after PayOnce was down are not counted as if they happened together. When Airwallex gives no update time, PayOnce dates the failure by when it first reads it, and leaves it out once the bank deadline plus the window has passed since the transfer was created. That only works while bank deadlines are minutes, as in the sandbox: with deadlines of days, failures read late without an update time can still add up to an outage. A transfer created before the ledger started counting outages never counts. PayOnce compares Airwallex's times with its own clock. A computer clock running more than the window ahead of Airwallex's (30 minutes by default) stops failures with an update time from counting, and one more than the bank deadline plus the window ahead (33 minutes for a local transfer and 35 for SWIFT, by default) stops outages being declared at all.

While an outage lasts, PayOnce opens no new payment on the rail:

- A new invoice's first payment waits unsent. The timeline says why, and PayOnce checks again every minute. The cash panel lists it as waiting on an outage. Only the second headroom figure takes it off, not the first, because a single incident's first payment is not checked against the floor (see [Cash panel](#cash-panel)).
- A replacement PayOnce would send by itself goes to a person, with the reason "an outage was declared on this payment's currency and transfer method". The approval request carries the terms it would carry without the outage, so an outage changes no approval. Without `APPROVERS` nobody can approve it, and ending the outage does not send it either, so it waits until an approver list is set.
- An approved payment waits, and its approval is kept. It still expires when it would, and the next look opens a new request as usual.
- A pay run with any row on the rail waits whole, with its approval kept. It still expires, and if it does, a person checks the run again after the outage to open a new request. Only one run waits at a time, so no other run can be uploaded until this one is released or cancelled.

A payment opened before the outage was declared was decided already and goes out as usual. The check runs in the database transaction that opens a payment, under its currency's lock, so neither the terminal nor the server can open one while the other declares an outage.

Nothing ends an outage by itself. A person ends it with their name and a note: on the incident board, on the Outages card beside the cash panel on any other view, or with `pnpm outage end <ID> <NAME> <NOTE>`. Only a name in `APPROVERS` may end one, because ending it lets payments go out again. When `APPROVERS` is unset, any named person may, and the timeline says no approver list was set. While `APPROVERS`, `TWO_APPROVERS_ABOVE` or `APPROVAL_TTL_MINUTES` cannot be read, nobody can end one: the end form and `pnpm outage` show why, and PayOnce refuses until the setting is fixed. The end goes on the timeline of every invoice and run the outage held, including any the board lists as held that no look had reached yet, and they carry on at once: a first payment goes out after the checks made before any payment, and an approved payment goes out if its approval still counts. `GET /api/outages` lists the active outages and those ended recently, from the ledger only. The incident board shows each active outage at the top, with what it holds (see [Incident board](#incident-board)).

## Duplicate invoices

The lock stops PayOnce paying one invoice twice. It cannot see a supplier billing the same work twice under a slightly different number, such as INV-0042 and INV-42A. So before PayOnce sends a new invoice's first payment, it compares the invoice with every other invoice in the ledger. If one has the same supplier, currency and amount, and a number that is the same apart from case, the spaces, dashes and other marks between its letters and digits, leading zeros, or up to four letters added after the last digit, PayOnce holds the new invoice and sends nothing. Both timelines say so. PayOnce pays an invoice number once, so it also holds a new invoice whose number matches another invoice to the same supplier this way, whatever the amount or currency. A pay run row and an invoice started on the page under the same number cannot both be paid, even for different amounts.

The letters count only when one number is the other with letters added. INV-42A and INV-42B each match INV-42 but not each other, so RENT-2026-OCT and RENT-2026-NOV are paid as separate bills. INV-42-1 and INV-421 do not match INV-42.

A person then either pays the held invoice or closes it without paying. Paying it takes an approval under the rules below. The person who started the incident cannot give it. The terms list the invoices it looks like and how each stands, so a change in any of them voids the approval. If one of them was paid, or is being paid, to a different account from the one on file now, two approvers are needed, because a resent invoice with new bank details is a common fraud. Closing it without paying takes a name and a note, on the close card or with `pnpm close`. A held invoice keeps being compared, so an invoice that matches it later is added to its terms. If a payment PayOnce had marked failed turns up later and reopens an invoice a person closed without paying, PayOnce closes it again once that payment fails too, and asks nobody to approve paying it.

Payouts sent outside PayOnce get the same check. A payout whose reference nearly matches an invoice number, to the same supplier for the same amount, is tied to that invoice as if its reference were the number itself. The check before every payment does this too, so a payout made in the Airwallex web app under a near-identical number holds the invoice. A failed payout that only nearly matches an invoice already closed may be a bill of its own, so it becomes an incident, with a warning that names the closed invoice.

If Airwallex refuses an invoice's payment outright, the invoice is held the same way. A person approves paying it again or closes it without paying. PayOnce never replaces a payment by itself when it looks like a second bill for an invoice that is already paid. When a replacement goes to a person for any reason, its approval request names that paid invoice too, so nobody approves it without seeing the match.

The invoice number on the start form is optional. An invoice number already in the ledger is refused.

## Approvals

When the original has failed and the policy escalates, PayOnce records an approval request with the exact terms: the amount, the currency, the account the supplier's record points to now, and the evidence behind the escalation. A held invoice gets one as well. A person approves it on the web page or with `pnpm approve`, and the approval names the request they were shown.

Before paying, PayOnce rebuilds the terms from current data and compares them with what was approved. If they match, it sends the replacement. If anything changed, the approval is void and PayOnce opens a new request. An approval is spent on one attempt, and it cannot override the duplicate lock. Once an invoice has gone to a person, only an approval releases a payment, even if the policy would now replace it unprompted.

### Who can approve

Approvers are listed in `.env` as names with limits, for example `APPROVERS=Yash:50000,Alex:10000,Kim:10000,Sam:4200`. Without the list nobody can approve. With those four, every scenario and the sample pay run still has enough approvers once the person who started it is barred, and Sam, with a limit of 4,200, is still refused on `eur-from-usd`, which takes about 4,476 USD from the USD wallet. A limit is compared with what the payment takes from the company's wallet, in that wallet's currency. For an invoice paid from its own currency, that is the invoice amount. For one paid from another wallet, it is the amount on the exchange rate quote (see [Payments across currencies](#payments-across-currencies)).

- Two different approvers are needed above `TWO_APPROVERS_ABOVE` (5,000 by default). Two are also needed whatever the amount when the payment would go to an account the original did not go to, and when PayOnce does not know who started the incident, as with a payout found in Airwallex. Paying a held invoice takes two as well when PayOnce has never paid the supplier, paid it only before it kept which account each payment went to, last paid it another account, or has paid it only by itself. A payment counts as one a person approved when it went out on an approval, or as a row of an approved pay run. Paying a supplier once as a single incident, which needs no approval, never stands in for the second approver.
- The person who started an incident cannot approve a payment for it. The page asks for a name when an incident starts. `pnpm recover` takes one as its fifth argument and uses the computer's login name without it.
- An approval request expires after `APPROVAL_TTL_MINUTES` (60 by default). The agent looks at the invoice again when it expires, voids it and opens a new one. Approvals given on the old request no longer count.
- Each approval records the hash of the terms its approver was shown, and the second approver has to approve the same request. The terms include a hash of every bank detail of the account, because the pay-to line shows only its last four digits. Before paying, PayOnce checks the approvals against the policy as it is then, so an approver taken off the list or a lowered limit voids them.
- A request completed just before it expired has ten minutes to be used, so a slow look does not lose it.
- If nobody on the list can approve a payment, for example because it needs two approvers and only one has a high enough limit, PayOnce opens no request and the timeline says so.
- The agent does not replace a payment above `TWO_APPROVERS_ABOVE` by itself either. It escalates, and the replacement needs two approvers.

The page has no login, so a name is whatever the person types or picks. A name takes only the letters A to Z, digits, spaces, dots, hyphens, apostrophes and underscores, up to 80 characters, and needs at least one letter or digit, so `-` or `.` on its own is not a name. That holds on the page and in the terminal alike, and for the names in `APPROVERS`. That stops a name with an invisible character, or a look-alike letter from another alphabet, from passing for someone else's. Two names are one person when their letters, digits and the spaces between words match, case and punctuation aside, so `Alex.` and `alex` are the same approver, and a list that names both is refused. `Sam Lee` and `SamLee` are two people. When `APPROVERS` cannot be read, the start-up line and every refusal quote the entry and the rule. A name stored before this rule that breaks it counts as nobody PayOnce knows, so the payment it started needs two approvers. The page drops the invisible characters from such a name wherever it shows one, and from the notes people type and the sender names in emails. The rules stop someone approving their own incident under their own name, and the timeline records who said what. They do not prove who was at the keyboard. That needs a login tied to each name.

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

The estimates come from Airwallex's published payout network tables for the United States and Germany: ACH 0 to 2 business days, Next Day ACH 1 to 2, FedNow and Fedwire 0 to 1, SEPA 0 to 2 and SWIFT 0 to 3. PayOnce shows every ACH payment as 0 to 2 days. Airwallex says it sends ACH as Next Day ACH, 1 to 2 days, above 1,000,000 USD or when the payer is outside the US, and this sandbox account's payer is in Singapore. For those payments the earliest day shown is a day early, so a payment shown as "may arrive late" may arrive late even at its fastest. The latest day is right either way. For any other route, such as another country or a US clearing system not in the table, the advice says the arrival is not known. Airwallex has no API that quotes one transfer's arrival or fee. Business days skip Saturdays and Sundays only. Airwallex's list of non-trading days needs an admin key, so a public holiday counts as a working day and a payment may arrive a day or more later than shown. The advice says so wherever it gives a date. The fee is the last one PayOnce recorded for that currency and method, labelled as last seen, or "no fee seen yet".

PayOnce does not switch a payment to a faster route. Each Airwallex beneficiary record holds one transfer method, so paying another way takes another record. The checks on bank details and on who must approve key on the record, so to them another record is another supplier (see [Supplier view](#supplier-view)). The duplicate checks also match invoices to it by the supplier's name. PayOnce has no earlier payment to that record to compare its bank details with, so moving to it takes no callback. A single incident's first payment to it goes out like any first payment, and paying a held invoice or a pay run row to it takes two approvers, because PayOnce has never paid that record. When a route may be too slow, the advice says so and a person decides what to do.

An estimate in approval terms counts from the day its request opened, so an approval given just before midnight still matches after it. The same goes for a pay run checked again after midnight: the approvals it already has still count. A new request counts from the day it opens. While the day in the terms is before today and the request is still open, the approval card and `pnpm approve` also say when the payment usually arrives if it is sent today. That line is advice and is not part of what is approved. An invoice without a due date has the same approval terms as before, and so does a pay run file without due dates.

## Changed bank details

PayOnce never takes new bank details from an email or from the model that reads emails. When a supplier says it has moved banks, or the supplier's record no longer matches the account the original went to, PayOnce pays the new account only after a person has called the supplier back.

Once every payment for the invoice has failed, or the invoice is held before paying a supplier PayOnce has paid before, the incident page has a "Changed bank details" card. The person calls the supplier on the phone number in the supplier record, then records who called, the number they dialled, when, who they spoke to and what was confirmed. PayOnce refuses the callback if the number is not the one on file, or if the call came before the original payment was sent (for an invoice held before paying, before the last payment to the supplier). The form fills in the time it opened, to the second, or the time Airwallex created that payment if your clock is behind, so its default always passes. The person then types the new details the supplier read out. PayOnce updates the supplier's beneficiary record in Airwallex, reads it back and keeps the record's details with the callback.

The agent then opens a new approval request for the new account. Its terms carry the callback and a hash of the full bank details, and two approvers must approve it whatever the amount. The person who recorded the callback cannot be one of them, and neither can the person who started the incident. If the record changes again, in PayOnce or in the Airwallex web app, the callback no longer matches it, any open request is withdrawn and nothing is paid until someone calls again.

A callback verifies the record for every invoice paid to that supplier, not just the one it was recorded on, because they all pay the same beneficiary.

The same rule covers a first payment. If PayOnce has paid a supplier before and the supplier's record now holds another account, PayOnce holds the new invoice before paying it. Only a change to where the money goes counts. A new bank name, which Airwallex writes itself whenever a record is updated, is not another account, but a change to any other field of the bank details is. Until a callback verifies the new account, a person records one on the same card first, and only then does an approval request open. Once one has, every first payment to that account still waits for two approvers, and whoever recorded the callback cannot be one of them, so a callback taken on one invoice does not let anyone pay the next one alone. With no phone number on file there is nobody to call, so a person either closes the invoice without paying or puts the old details back in Airwallex. After a payment to the new account is paid, later invoices go out as usual. A supplier PayOnce has never paid is not held for this, and neither is a new Airwallex record for a supplier PayOnce paid under another one, but paying a held invoice to either still takes two approvers, as a pay run row does.

PayOnce reads the supplier's record before every first payment, which is one more Airwallex read per invoice. A supplier missing from Airwallex, or with no bank details there, holds the invoice for a person.

Every payment keeps the account it was decided or approved for. Before any payment goes out, PayOnce reads the supplier's record again and sends nothing if any of its details has changed since, the bank name included. For an approved payment the next look then asks for a new approval. That includes sending again a payment whose first try may not have reached Airwallex: the invoice then goes to a person, and once a bank deadline has passed with no transfer under the payment's request id, the payment counts as failed. Only a payment that went to the account it was meant for counts as the account PayOnce last paid a supplier. A transfer that went elsewhere, including one found late under a payment marked failed, and one that shows no bank details, goes to a person with a warning and never counts. While another invoice to the same supplier is about to be paid, a callback cannot be recorded, because the change would move that payment too.

In the sandbox, the scenarios share one beneficiary per currency, so a change would reach every later incident. Each run of the `usd-local-bank-change` scenario creates a record of its own, with a phone number on file. Try it with the `moved-banks` email thread and the `ACCOUNT_CLOSED` bank outcome.

## Closing an incident

A paid original holds the duplicate lock, so PayOnce cannot send anything more for that invoice. If no supplier email reports the payment missing, the incident closes. If one does, or anything else on file sends it to a person, the incident stays open until a person closes it. A person also closes an invoice that a payout sent outside PayOnce has paid. A paid replacement was sent on a decision already made, so it closes the incident by itself, even when the invoice is with a person, unless it went out at a rate nobody approved or one of the cases below applies.

The page shows the paid transfer and the reason, and takes a name and a note of what the person confirmed. `pnpm close` does the same in the terminal. Both the name and the note go on the timeline. Closing moves no money, so it is not bound to terms the way an approval is. Sometimes a transfer that does not match the invoice turns up under one of its request ids. The close card lists each such transfer under "This close covers", and the close covers exactly the ones the card showed. `pnpm close` prints them too, and closes only when `--covers=` names every one, by short reference or transfer id. If another one turns up after the card was shown, the close is refused and the person looks again first. "Check again" never closes an incident that only a person may close, such as one paid by its original after it went to a person.

When PayOnce would close an incident by itself but one of these transfers is on file, or a payout sent outside PayOnce for the invoice is still live, it hands the incident to a person instead and stops looking at it. The timeline says what to check, the close card offers the close, and an alert goes out when alerts are on.

A person can also close an invoice without paying it while it waits on a person and nothing for it is with the bank or paid. That covers an invoice held before paying, one whose payments all failed while a replacement waits for approval, and one whose new bank details cannot be checked because no phone number is on file to call. The close card then reads "Close without paying" and takes a name and a note, as `pnpm close` does. PayOnce sends nothing, withdraws any open approval request and does not ask anyone to approve paying the invoice again. While a payment for it is still with the bank, the close waits until the bank pays or fails that payment.

## Audit trail

Each incident's timeline is a hash chain, and so is each pay run's. Every line stores the hash of the line before it on the same invoice, and a SHA-256 hash of its own content plus that previous hash. Editing, removing or inserting a line breaks the chain at that point. The ledger also keeps a running hash over every line in the order they were written. It catches two things one invoice's chain misses: lines removed from the end of a timeline, and every line of an invoice removed. If the running hash itself is deleted, PayOnce keeps writing: it starts the running hash again with the next line and records when, and every audit says so from then on. PayOnce writes an invoice's first line together with the invoice, and a pay run's when it is uploaded, so an invoice or run left with no line at all is reported too. Together these catch a whole chain emptied along with its running hash. Pay run timelines have a running hash of their own. `pnpm run audit` and the downloads check every line each time. The audit line under a timeline on the page checks that timeline's chain in full each time, so a line edited, removed or inserted in it shows at once. For the running hash it hashes only the lines added since its last check: the ledger's last line removed shows at once, while a whole invoice removed, or a timeline's last line removed when it is not the ledger's last, shows within about a minute, when it hashes every line again.

PayOnce writes each line, its hashes and the running hash in one database transaction. The terminal commands and the web server can write to the ledger at the same time, and the transaction stops two of them chaining from the same line.

`pnpm run audit` checks every timeline and the running hash, and says where a chain breaks. `pnpm run audit INV-5001` checks one invoice and lists each break. Add `json` or `csv` to print the invoice's audit trail instead. `pnpm run audit run 7` checks pay run 7's timeline, with `json` or `csv` after it for the run's audit trail, and the check of the whole ledger covers every run. (`pnpm audit` on its own runs pnpm's dependency audit.) The page shows the result under an incident's or a run's timeline, with links to download the same audit trail as JSON or CSV. The JSON describes how each hash is made, so the trail can be checked without PayOnce. The CSV is for reading in a spreadsheet. A cell that starts with `=`, `+`, `-` or `@` gets a leading apostrophe there, so a supplier's email subject cannot run as a formula. Check hashes against the JSON. In the terminal, `json` writes any character that could act on the screen as an escape, and the text still parses back the same. `csv` is cleaned only when it prints straight to the screen, so a file you save keeps every message exactly.

Lines written before the chain existed were hashed the first time the ledger was opened with it, and the export marks them. The chain has no key, so it catches a quiet edit to the file and no more. Someone who can write the file and knows how the chain works can rewrite a timeline and recompute every hash after it and the running hash, delete invoices with their lines and recompute the running hash, or delete every invoice, run, break and line along with the chain's own records. The audit then reports the ledger intact. To show later that a timeline changed after a given day, keep that day's export, or just its last hash, somewhere else.

## The cost of a second transfer

A failed SWIFT transfer gets its amount back but not its fee, so a replacement pays the fee again. PayOnce adds that fee to the cost of a replacement before it checks the reserve floor. It also takes off money already committed to other payments from the same wallet and not yet sent, and the timeline shows the numbers. In the `eur-swift-low-reserve` scenario the invoice gets a floor of its own, stricter than the one for EUR, set so that the second fee is what breaches it, and the incident goes to a person.

## Reserve floors

`RESERVE_FLOORS` in `.env` sets how much each wallet keeps back, as currency and amount pairs: `RESERVE_FLOORS=USD:1000000,EUR:1000000`. PayOnce replaces a failed payment by itself only if the wallet stays above its floor afterwards.

A currency that is not listed has no floor, and PayOnce never replaces a payment in it by itself. The incident goes to a person, the same way approvals are refused when `APPROVERS` is missing. To say on purpose that a currency needs no floor, list it with 0, as in `EUR:0`. If the setting cannot be read, every automatic replacement goes to a person. Floors are read when PayOnce starts, so a change needs a restart.

PayOnce checks the floor again each time it looks at an incident waiting on a person. If a replacement would take cash below the floor, the currency has no floor or the setting cannot be read, the approval request says so, the first request included, along with the reason the incident went to a person. An approval counts only if its request named the floor. Otherwise PayOnce voids it and opens a new request that gives both reasons. If cash rises back above the floor, an approval given while it was short still counts. The request does not say how far short cash was, so PayOnce spends such an approval however far cash has fallen since. A figure in the request would void approvals every time the balance moved.

A single incident's first payment is not checked against the floor. A pay run's rows are, when the run is checked, again when it is released, and once more when each row is sent.

## Cash panel

The page opens with a cash panel, one row per currency. A row shows the available balance from Airwallex, the reserve floor and the headroom: how much can still leave the wallet before cash drops below the floor. Open a row to see how the headroom is worked out, with each figure tagged by where it comes from.

The balance comes from Airwallex, with the age of the read. Money held for outgoing payments and money still arriving from currency conversions are shown next to it, but neither is part of available. A payment from another currency's wallet is listed under the wallet it leaves, at the amount on its transfer, or on its quote before the transfer exists. When no request is open on a quote, for example because nobody on the list can approve it, the panel shows the latest quote's amount and marks it as estimated from a quote. Before any quote is taken it shows 0, estimated. The floor comes from `RESERVE_FLOORS`, and any invoice held to a stricter floor of its own is listed under it. The rest comes from PayOnce's ledger. Payments being sent that have no transfer yet, approvals given but not used yet and the rows of approved pay runs are taken off to give the headroom. A second figure also takes off every invoice waiting on a person that could still be paid, with or without an open approval request, as if each one were approved, and every first payment waiting on an outage. A pay run waiting for its approval is in neither figure. Its rows count only once the run is approved.

Below that the panel lists payments already with the bank, payouts sent outside PayOnce and the fees kept on failed transfers. Airwallex takes a transfer out of available as soon as it is created, so the panel does not take these off again. Each is listed under the wallet the money left. A payout paid from another currency counts in the currency it was paid from, and a fee counts in the currency it was charged in.

The panel reads the balance from Airwallex when the page asks for it and the last read is 30 seconds old or more, so it reads nothing while no page is open, unless alerts are on. Then the server also reads it every 5 minutes (see Alerts). After a quiet spell the first answer can show a read several minutes old, with its age, while a new read runs. The page says so and picks up the new read a moment later.

That read is for display. Before an automatic replacement, PayOnce reads the balance fresh and takes off the same committed money the panel does. The panel's headroom can still differ from what that check sees. The panel's balance may be older, and the panel takes off the currency's floor, while an invoice with a stricter floor of its own is held to that floor (the panel lists such invoices under the floor). The check for one invoice also leaves that invoice's own committed money out.

If a read fails, the panel keeps the last good one, shows its age and says why the newer one failed. If no read has worked yet, it shows no headroom, because a headroom worked out from a missing balance would be wrong.

PayOnce reads each transfer's fee and keeps it in the ledger, and fills in older failed transfers, up to five after each balance read. A transfer it cannot read waits 10 minutes before the next try, and the others go first. The fee line is called "Fees on failed transfers". Once a fee on a failed transfer is on file, a note under it says the sandbox keeps the fee when a transfer fails. That rests on what the sandbox did with failed EUR SWIFT transfers, so the panel does not claim every rail works this way. The pay runs line takes off the rows of an approved run, and the released rows that have not sent their payment yet.

`pnpm cash` prints the same figures in the terminal after one fresh read. It exits with 1 when Airwallex could not be read, the floor setting is unreadable or a headroom is below 0, so a script can check it.

## Incident board

The page opens on the incident board, under the cash panel. Any active rail outage comes first (see below). Then the board lists every invoice that is not closed, and the rows of a pay run waiting for approval, in four groups, most urgent first:

1. Waiting on a person: a payment an outage holds, an approval request that is open, an invoice held before paying, a failed payment with no request open, a pay run waiting for approval, a paid invoice waiting for someone to close it, or an invoice with money at risk that an email waiting in the inbox names on its own, so the inbox offers it first. An email that names the invoice beside others, only nearly, or inside other digits adds a note to it and leaves it in its group.
2. Bank deadline passed: a payment still with the bank after its deadline.
3. With the bank: a payment, or a payout sent outside PayOnce, that the bank still has.
4. Everything else that is open, such as an approved payment that PayOnce sends on its next look, an approved pay run that it releases on its next check (unless an outage holds either one), or a pay run row waiting for its turn.

Within a group, the invoice with the most money at risk comes first, then the oldest. Money at risk is what could still leave a wallet for the invoice, fee included, in the currency of the wallet it leaves: a payment being sent, approved or waiting on a person, a held invoice's amount, a pay run row, or a payment still with the bank. For an invoice paid from another wallet it is the quote's amount. The board takes these figures from the cash panel and never works them out another way.

The totals at the top add them up per currency, in the cash panel's terms. "Approved or being sent" is the panel's payments being sent, approvals not used yet and approved pay runs not sent yet. "Waiting on a person" and "Waiting on an outage" are the panel's lines of those names. "With the bank" is the panel's "With the bank" and "Payouts sent outside PayOnce" together. A pay run waiting for approval gets a part of its own, because the cash panel counts a run only once it is approved. PayOnce has no exchange rates, so the board ranks amounts in different currencies as plain numbers. Filter by wallet to rank one currency on its own.

Each row gives the invoice, the supplier, the amount and the wallet it is paid from, why it is in its group, how long since PayOnce took it on, and a link to the incident, or to the pay run for a row not released yet. The reasons are PayOnce's own fixed words, never an email's. Apart from the form that ends an outage, the board has no buttons of its own: the cards on the incident do the work. You can filter by group, by wallet and by origin (PayOnce, sent outside PayOnce, pay run). The board reads only the ledger and refreshes with the incident list. The incident list stays in the sidebar. Next to each invoice's state it names the board's group when that tells you more, such as "Bank deadline passed". The "Incident board" button in the top bar brings the board back. With nothing in the ledger yet, the board says how to start the first incident.

Each active rail outage gets a card at the top of the board, whatever the filters. The card shows the rail, the failure codes, how many payees failed, when the outage started and what it holds: first payments waiting, replacements escalated, approved payments waiting and pay runs waiting, each linked. It also shows the money those have at risk, taken from the cash panel's figures like the rest of the board, and the form to end the outage. The form says what ending it sends, such as "Ending it sends 3 payments totalling 2,000.00 USD", counting each first payment, approved payment and pay run row it holds. A replacement the outage escalated is not in that count, because it still needs an approval. The Outages card lists the same invoices and runs as the board. While the board is open, the Outages card above the cash panel leaves these outages out, so each one appears once; outages ended in the last day still show there. A row affected by an outage carries a tag naming it. A first payment, approved payment or approved pay run that the outage holds moves to "Waiting on a person", because only a person can end an outage. A replacement the outage escalated says so while it waits for approval, and any other approval on the rail notes that the payment will wait until the outage ends.

`pnpm board` prints the same ranking in the terminal, after any active outages. It takes the same filters as words in any order, such as `pnpm board deadline USD outside`. A word that is not a group, an origin or a currency prints the usage.

## Supplier view

When a supplier calls to say "you never paid us" or "we changed banks", the supplier view answers for that supplier on one page: what was owed, what PayOnce sent and to which account, whether it checked that account, what changed, who called whom, what the emails said in PayOnce's words, what is still at risk and what to be careful of. The sidebar lists every supplier, those with something waiting on a person first, and loads the list while that part of the sidebar is on screen. The supplier name on an incident, the beneficiary id on an approval card, a paying row's payee on a pay run and each row of the incident board link to it. `pnpm supplier` prints the same in the terminal.

A supplier here is one Airwallex beneficiary record, because that is what PayOnce checks every payment against: which account it last paid, whether a callback verified the account on file, who may approve. PayOnce never merges two records. Records that share a name, or an account, link to each other, and the page says what that means: a callback or a payment on one does not count for the other.

The record comes first on its page, above the outages and the cash panel, and shows, in order:

- Cautions in PayOnce's fixed words, such as a record holding other bank details than the account PayOnce last paid, an invoice waiting on a person because the bank details changed, an account a callback verified, a supplier PayOnce has never paid, a transfer that went somewhere it was not meant to, an account on another record, an account-level failure in the last 30 days, a new email domain, a supplier asking not to pay or to pay another account, a payment that may have gone out twice, and an invoice waiting on a person with no phone number for a callback. Each links to the invoices it is about. The bank details caution follows the same checks the payments do, so a callback recorded earlier does not hide a record that changed again.
- Money at risk now, per wallet, taken from the incident board's entries, so the two always agree.
- The accounts PayOnce has seen for the record, labelled A, B and so on, with the last four characters only, which one it last paid and checked, which one a callback verified and who may not approve payments to it.
- Every open invoice and the 25 newest closed ones, each with its board group, what paid it and when the payment usually arrives, and each payment with its account and whether PayOnce checked it. The incident list has the older ones.
- Callbacks, with the number's last four digits, a summary of each invoice's emails, message drafts by name and state, likely duplicates across records with the same name, outages and pay run rows.

The view only reads the ledger. It has no buttons: each row links to the incident, pay run, email or outage where a person acts. It never shows an email's text, subject or sender, a draft's text, what someone typed about a callback, an escalation reason or a timeline line, and shows a phone number or account only by its last four characters. To show the last four, PayOnce keeps where each transfer went (`attempts.sent_key` and `sent_ending`, and the same on payouts sent outside PayOnce) as it reads the transfer. Payments from before that show "ending not on file". Nothing PayOnce decides reads those two columns.

## Pay runs

A pay run pays a batch of invoices from one CSV file on one approval. Upload the file on the page under "Pay run", or with `pnpm payrun upload <FILE> <NAME>`.

```csv
invoice,supplier,beneficiary_id,amount,currency,method,due_date,sandbox_outcome
INV-RUN-1001,Example Supplier LLC,6170b987-3840-4825-8da6-c27671bd26ad,40.00,USD,LOCAL,2026-11-02,PAID
INV-RUN-1002,Example Supplier LLC,6170b987-3840-4825-8da6-c27671bd26ad,41.00,USD,LOCAL,,ACCOUNT_CLOSED
```

`fixtures/pay-run-example.csv` is a sample. It leaves out `due_date` and `supplier_domain`, so its rows have no due date to compare the arrival with, and every invoice it releases flags every sender. Its beneficiary ids belong to the sandbox account PayOnce was built on, so use your own.

Each row names the beneficiary by its Airwallex id and gives the supplier's name, the amount and the currency. The amount is in major units with a dot, at most two decimals and no thousands separator. `method` is optional, and so is `due_date`, written like 2026-11-02 (see [Route advisory](#route-advisory)). `sandbox_outcome` tells the sandbox bank what to do with the row's payment: `PAID` by default, or a failure type as in `pnpm recover`. `supplier_domain` is optional too: the domain the supplier's emails come from, which the sender check trusts for that invoice. It is part of what the approvers approve. A domain that differs from the one on file for the beneficiary, or from another row of the same run, or that is the first domain for a beneficiary PayOnce has already paid, shows a caution and needs two approvers. A row without one flags every sender. PayOnce never reads bank details or phone numbers from a file. It pays the account on the beneficiary record. Every row pays in its own currency from that currency's wallet. PayOnce refuses a file with a column naming another wallet to pay from, such as `source_currency`. Pay such an invoice on its own. A file holds 50 rows at most. A file PayOnce cannot read is refused with every problem found. A problem in the header, such as a missing or unknown column, gives the header's line, and a quote that never closes gives the line it opened on. A problem with the whole file has no line: no name, an empty file, no rows after the header, more than 50 rows, or more than 40,000 characters.

PayOnce checks every row with GETs only. It skips a row that:

- has a cell it cannot read, such as `4,000.00`, `40.005`, a currency without two decimals or a due date that is not a day on the calendar;
- has an invoice number the ledger already has, or the same number for the same supplier apart from case, the spaces, dashes and other marks between its letters and digits, or leading zeros;
- repeats an earlier row's number, or looks like a second bill for an earlier row of the file;
- names a beneficiary Airwallex does not have, or one whose account name, currency or transfer method does not match the row (names are compared without case, spacing or punctuation);
- pays a beneficiary whose bank details are not the ones PayOnce last paid it, unless a callback verified the new ones.

A skipped row says why on the page and on the run's timeline, and its number stays free for a corrected file. A row that looks like a second bill for an invoice already in the ledger is released with the run, and PayOnce holds it for a person when it comes to send it, as it holds any likely duplicate.

The cash check comes last. In each currency, the rows and their expected fees must leave the wallet above its reserve floor, after money already committed elsewhere. If they do not, every row in that currency is skipped, and the timeline says how far below the floor they would take cash. So the order of the rows never decides who is paid. A currency with no floor set does not stop a run, because a person approves every run, and the approval card says no floor is set, on the page and in `pnpm payrun approve`.

### Approving a run

The run's approval covers every row it pays and the total in each currency, bound by a hash like any other approval. Limits apply to the total in each currency, so splitting one payment into small rows gains nothing. Two approvers are needed when any currency's total is above `TWO_APPROVERS_ABOVE`, when a row pays a beneficiary PayOnce has never paid on a person's approval, when a row pays an account a callback verified, and when a row's supplier domain shows a caution (see above). The person who uploaded the run cannot approve it, and nor can anyone who recorded the callback for an account it pays. The upload in the terminal needs a name, so nobody uploads under their login name and approves under another without noticing.

A run's request expires like any other, but it does not renew by itself. "Check again" on the page, or `pnpm payrun check`, runs every check again and opens a new request. Only one run waits for approval at a time. To upload a corrected file, cancel the waiting run first. Cancelling moves no money and frees its invoice numbers. While a run is approved and waiting for its release, checking it again is refused, so the rows the approvers saw are the rows released.

### Release

Once the run is approved, the server checks every row again. If anything changed, or the approval policy no longer accepts the approval, the approval is void and the run waits for someone to check it again. Next, PayOnce takes the lock of each currency the run pays, reads the balance again and checks the floor. If the run no longer fits, it is not released. Otherwise one database transaction spends the approval and writes each row as an invoice that pays the account the approvers approved. Each invoice's first timeline line names the run, the row and the approval. `pnpm payrun approve` only records an approval, and `pnpm ui` releases the run on its next check.

The server then sends each invoice's first payment one at a time, in file order, each under its currency's lock and checked against the floor once more. Only the release, and the server's status check once the release has stopped, send a row's first payment. Checking the invoice again, a webhook or a sweep leaves an unsent row for its turn. A row is held for a person instead when its beneficiary's bank details changed since the approval, when it would now take cash below the floor, or when another invoice to the same supplier already has its number. From there each invoice is an incident like any other. A row whose payment fails is escalated or replaced by the usual rules.

### One payment at a time per currency

Every payment PayOnce sends holds a lease on the currency it leaves from (USD for a EUR invoice paid from USD), from its last read of Airwallex until the transfer is created and recorded. That covers a single incident's first payment, a run's row, an automatic or approved replacement, a held invoice paid on an approval, and a retry of a payment that may not have reached Airwallex. A run's row and an automatic replacement read the balance under the lease. An approved replacement reads it before it takes the lease. A held invoice paid on an approval reads no balance, because PayOnce does not check such a first payment against the floor. Before taking the lease, both tie any payout sent outside PayOnce. Under it, both check that the supplier's record still holds the approved account and that the number of supplier emails has not changed. The approved replacement also checks a paid second bill again, and the held invoice checks the invoices it may be a second bill for. The lease is a row in the ledger, so the terminal and the server take turns, and it runs out after a minute if the process holding it dies. An automatic replacement reads the balance again under the lease and decides again on it, so two replacements in one currency can no longer pass on the same cash. Payments get the lease in the order they asked for it, so a run sending its rows one after another cannot keep a replacement waiting. A payment waits up to 45 seconds for the payments ahead of it. Then it sends nothing, spends no approval and tries again a minute later. PayOnce writes a payment to the ledger before sending it, and releases a pay run, only in a transaction that finds the lease still held, so a payment whose lease ran out before that write is never written or sent. Once it is written it is sent, even if the lease runs out before the transfer is created. Payouts sent from the Airwallex web app take no lease.

## Webhooks

`pnpm ui` listens for Airwallex payout webhooks on a second port, 4311, that answers one path. To give Airwallex an address it can reach, PayOnce opens a Cloudflare quick tunnel, which needs no Cloudflare account. It then points its Airwallex webhook subscription at the tunnel. The first run creates the subscription, and later runs move it, because a quick tunnel gets a new address each time it starts. The page and its API stay on this machine and are not behind the tunnel.

An event counts only if its signature checks out with the subscription's secret, and an event already seen is ignored. A paid or failed event only tells PayOnce to look again. PayOnce reads the transfer from Airwallex and decides on what it reads. A paid, failed, cancelled or overdue event for a transfer PayOnce does not know starts a sweep.

A status check runs every 15 seconds in case an event is late or lost, and every 3 seconds when webhooks are off. In the sandbox, Airwallex records an event for every status change but leaves each one queued and never sends it, even a test event sent from its own web app, so the status check finds every change. A request from outside through the tunnel does reach the receiver.

Install cloudflared with `winget install --id Cloudflare.cloudflared`, which waits on a Windows administrator (UAC) prompt. Or download the standalone `cloudflared-windows-amd64.exe` from cloudflared's GitHub releases, which runs without admin rights, and set `CLOUDFLARED` to its path. Set `WEBHOOK_URL` to use a public address you already have, or `WEBHOOKS=off` to skip webhooks. Anyone who learns the tunnel's address can send it requests, so the receiver prints the requests it refuses at most once a minute, with a count, so they cannot scroll the timeline off the terminal.

## Reconciliation

PayOnce follows the status of each transfer it knows about. Reconciliation reads the wallets themselves, so it can see a refund that never came, a debit with no transfer behind it, or a balance that does not add up. It reads Airwallex's own record of each wallet with GETs, matches it with the transfers and with PayOnce's ledger, and lists what it cannot explain as a break for a person. It never moves money and never changes an invoice, an approval, a binding, the cash panel or the board.

A check reads, in this order: the balances, every movement in the cash account in windows of at most seven days (Airwallex refuses a longer range), the balances again, the transfers created since the ledger started, and by id up to five transfers that movements name and the listing did not have. The first check, and one a day after that, reads every window since the ledger started. Each window starts a minute before the last one ends, so a movement right on the edge is read either way. The others read the last seven days, which also picks up a movement posted late. Airwallex dates movements at +0800 in the sandbox, and PayOnce keeps each time as UTC. If Airwallex refuses to show a transfer by id, the movement that names it is listed as waiting, PayOnce asks again ten minutes later, and the other transfers are read in the meantime.

Each wallet has to add up. Every movement's balance must follow from the one before it, and the last one must equal Airwallex's available balance. When the balance moved between the two balance reads, the closing check waits for the next check. A movement is matched to its transfer by the transfer's id, and the transfer to the ledger by id only: an attempt's own transfer, a transfer kept beside an attempt because it does not match the invoice (counted on its own, not as PayOnce's payment), or a payout sent outside PayOnce that is tied to an invoice. Holds (the hold and release rows Airwallex's bank feed guide leaves out) are not matched to any transfer and never make a break. They still count in the running balance, because Airwallex's balance after each row includes them, and the wallet shows their total apart from money in and out.

| Break | What it means | How it ends |
| --- | --- | --- |
| Refund missing | A failed transfer's money has not come back a bank deadline after it failed. For one of an invoice's own payments, its "Messages to send" card offers a request asking Airwallex where the refund is | By itself when the refund lands |
| Debit missing | A transfer Airwallex lists has not taken money a bank deadline after it was created | By itself when the debit posts |
| Paid, then returned | A payment was recorded as paid, and Airwallex now shows it failed or gave the money back. This also covers an invoice PayOnce closed as paid when none of its payments is recorded as paid any more. The invoice is not reopened | A person |
| Payout tied to no invoice | A payout sent outside PayOnce took money and no invoice explains it | By itself when the sweep ties it to an invoice, otherwise a person |
| Debited more than once, debit differs, fee differs, refund differs | The wallet does not show what the transfer says | A person |
| Money came back unexpectedly | A refund for a transfer Airwallex does not show as failed | A person |
| Money in or out that no transfer explains | A deposit, an adjustment or anything else with no transfer behind it | A person |
| Movements do not add up, balance differs | The running balance breaks, or ends away from the available balance | By itself |
| Movement PayOnce cannot read | An amount, balance, time or currency PayOnce cannot read | By itself |

A movement whose transfer is still inside its window, or has not been read yet, is listed as waiting and is not a break. So is a transfer with a movement PayOnce cannot read: until it can, none of that transfer's breaks opens, changes or clears. A refund or a debit that is missing opens as soon as its window passes. Every other break opens only when two checks in a row find the same facts, so a transfer that fails between two reads does not open one by mistake. `pnpm reconcile offline` reads nothing new, so it opens nothing and does not count as one of those two checks. It judges each window as of the last check that read Airwallex.

A break that waits for a person stays open until someone explains it, even after Airwallex's records stop showing it. PayOnce then marks it as no longer found. The one exception is a payout tied to no invoice, which clears when the sweep ties it.

To explain breaks, open Reconciliation in the top bar, tick breaks of one kind, give your name and a note, and press Explain. The explanation covers those breaks with the facts the page showed. If a break's facts change later, such as a refund landing on a payout you explained, it opens again. `pnpm reconcile explain` does the same in the terminal, with the short fingerprints it printed. Put a name with a space in it in quotes, because the name is one argument. Every word after the name is the note. Anyone with a name may explain a break, as anyone may close an incident, because explaining moves no money.

Every break found, changed, cleared or explained goes on a hash chain of its own, with its own running hash, and `pnpm run audit` checks it after the invoice and pay run chains. Once the chain has its first line, an empty chain, a missing running hash, a running hash that went missing and started again, or a break that opened with no line counts as lines removed.

`pnpm ui` runs a check a minute after it starts and then every `RECON_EVERY_MINUTES` (10 by default, 0 for never). Check now on the page starts one, at most once a minute. A check that fails a read records the error and changes no break. With alerts on, the open breaks share one alert, which posts again only when a break opens or its facts change. A reconciliation record that no longer verifies gets an alert of its own, as an invoice or pay run audit trail does.

## Metrics

The board says what needs a person now. Metrics says how the last week or month went: how many payments went out and how many the bank paid or failed, on which rail and why, how many incidents PayOnce closed by itself and how many needed someone, how long they took, what failures cost in fees, and which controls fired. Open Metrics in the top bar, or run `pnpm metrics`. Pick the last 7 days, the last 30 days or since the ledger started. The periods are rolling hours up to now, not calendar days, so two people reading the same file at the same minute get the same numbers.

| Table | Counts | By |
| --- | --- | --- |
| Payments sent | First payments (pay run rows among them, since a run's approval is not an approval of the invoice itself), first payments a person approved, replacements PayOnce sent by itself and approved ones, with how many came from pay runs and how many the bank paid, failed or still has. Also how many first payments were paid the first time, any invoice paid more than once since the ledger started and what each extra payment took from its wallet, any paid transfer that did not match its invoice, on a line of its own, and how long the bank took to pay | When the transfer was created |
| Failures | Failures per rail and failure code, at the bank, refused by Airwallex (with or without a code) or never created, with whether the code counts toward an outage and whether a resend can fix it | When the transfer was created, or when PayOnce tried to create it. A payout sent outside PayOnce and tied to an invoice: when PayOnce found it |
| Incidents | Started, by origin. Closed, by how: paid the first time, replaced by PayOnce, paid after a person, or closed without paying. How long they took from the first timeline line, from the first failure and with a person. Why the ones that needed a person needed one, as the reason on file when they closed | Their first line, and their close |
| Approvals | Requests given, those needing two approvers, and whether each was spent, voided or is still waiting, with the time to approve, plus requests waiting now | The signoff that completed the request |
| Fees lost | Fees kept on failed transfers, the cash panel's figure | When the transfer was created. A payout sent outside PayOnce and tied to an invoice: when PayOnce found it |
| Duplicates held | Invoices held as a likely second bill, and whether a person stopped them, paid them or approved a payment still under way, or they still wait | Their first line |
| Rail outages | Each outage running in the period, how long it lasted and what it held | Overlapping the period |
| Reconciliation breaks | Breaks by kind and whether they were explained, cleared or are still open, with the time to resolve | When the break opened |

Each table counts by the time it names, so the tables do not add up to each other. Amounts stay in their own currency and are never added across currencies. A row whose time is not in the ledger is left out of the 7 and 30 day periods and counted as not on file. Under Payments sent and Incidents that count is of invoices, and an invoice left out of several figures counts once. An invoice counts as needing a person when PayOnce sent it to one, even if the bank then settled it before anyone acted. Its reason is coded by matching PayOnce's own reason wording, so the page shows a fixed label such as "Bank deadline passed" and never the reason's text.

Metrics only read the ledger. They call nothing in Airwallex, change nothing, and nothing PayOnce decides reads them. They show no names, notes, invoice numbers, references, email text or Airwallex messages. Three times feed the durations: when an invoice first went to a person, and when PayOnce first recorded a payment failed or paid. SQLite triggers write them as the state changes. A fourth, when Airwallex refused to create a transfer, tells a refusal with no code from a payment that was never created. A ledger from before them shows those durations as not on file.

## Alerts

PayOnce can post to a Slack or Discord channel when something needs a person. It alerts on an invoice that is escalated, held or waiting on an approval, a bank deadline that has passed, a payout sent outside PayOnce, a payment PayOnce had marked as never sent that turned up and may have paid the supplier twice, a pay run waiting for approval, supplier emails waiting in the inbox for a person, an audit trail that no longer verifies, a currency whose headroom has gone below 0, reconciliation breaks that need a person, and a rail outage, once when it is declared and once when a person ends it. An outage alert names the rail, the failure codes, the payees counted and the bank's references, and never who ended it or their note.

Set `ALERT_WEBHOOK_URL` to a Slack incoming webhook (`https://hooks.slack.com/services/...`) or a Discord webhook (`https://discord.com/api/webhooks/...` or the same on `discordapp.com`, with `ALERT_FORMAT=discord`). PayOnce takes no other address. If the setting is wrong, the start-up line says why and nothing is posted. With no address set, PayOnce makes no alert calls at all. Treat the address as a password and keep it in `.env`. PayOnce prints its host and never the rest.

Only `pnpm ui` posts. Every 5 seconds it works out from the ledger what needs a person, which is the same state the page shows, so an incident escalated in the terminal is alerted by the server on its next check. A condition alerts once when it appears, and again only when it changes: an approval request opening on an escalated invoice, say, or a new reason. A request renewed on the same terms does not alert again, and neither does a floor clause that comes and goes as the balance moves. Each alert waits 10 seconds before it goes out, so when a request opens a moment after an escalation, only the request is posted. If the condition then goes back to what it was, as when that request is withdrawn, the alert held back is posted after all. A condition that clears and comes back within 10 minutes alerts again only if it changed.

The first time alerts are on for a ledger, PayOnce records what is already waiting and posts one summary, such as "2 invoices are waiting on a person, 1 pay run waits for approval, 1 supplier email waits in the inbox", instead of an alert for each. It waits for the server's first balance read before it looks, so a currency already below 0 is counted in the summary too. If nothing is waiting, it posts nothing.

An alert gives the invoice number, the supplier, the amount, the reason PayOnce recorded, how many approvers a request needs and when it runs out, and a link to the incident on the local page. The link only works on the machine running PayOnce, and the message says so. An inbox alert says only how many emails wait, and it comes again when a new one is uploaded, not when one is delivered or dismissed. An alert never carries email text, a sender or a subject, anything the model read, an account number or any digits of one, an approver's name or a secret. Text PayOnce did not write itself, such as a supplier name, goes out as code, with `://` and `www.` broken up, so it cannot turn into a link, a mention or formatting. PayOnce also strips characters that can reverse or hide part of it, such as right-to-left overrides and zero-width spaces. The only link in an alert is the one to the local page. Discord mentions are off, and long values are cut to fit each service's limits.

When a post gets a server error, times out or gets no answer, PayOnce tries again after 30 seconds, 2 minutes, 8 minutes and 32 minutes, then gives up. After a 429 it waits as long as the answer asks. A redirect or any other 4xx fails the alert at once, because PayOnce does not follow redirects. If the webhook answers 401, 403, 404 or 410, the address is wrong or the webhook is gone, so PayOnce stops posting until it is restarted. The agent, the watcher and the page never wait on a post. If the server dies between posting an alert and recording it, the alert can be posted again a minute later, because incoming webhooks take no idempotency key.

While alerts are on, the server also reads the balances every 5 minutes when nothing else has, so a headroom below 0 is noticed with no page open. Like any balance read, each one also reads up to five transfers to fill in the fees of failed transfers.

To try alerts without Slack or Discord, run a receiver on this machine and set `ALERT_TEST_RECEIVER_URL` to it, such as `http://127.0.0.1:4399/slack`. It takes only a 127.0.0.1, localhost or [::1] address, and while it is set PayOnce posts there instead of to `ALERT_WEBHOOK_URL`, in the format `ALERT_FORMAT` names. `GET /api/alerts` lists the last 50 alerts and how each one went.

## Messages to send

Each incident has a "Messages to send" card, and `pnpm outbox` does the same in the terminal. PayOnce suggests the messages that fit the incident now, a person drafts one, copies it into their own email and sends it to the contact on file, then marks it sent. PayOnce never sends anything itself.

There are four messages for the supplier: the payment has been sent (with its reference, amount and when it usually arrives), it has been sent again after a failure, we are looking into it (which promises nothing), and we will call you on the number we have on file to confirm a change of bank details. That last one asks the supplier not to send bank details by email. The fifth is a trace request to Airwallex for a transfer past its deadline, with its reference, amount, creation time and status. The sixth asks Airwallex where the refund of a failed transfer is. It fits while reconciliation finds that refund missing for one of the invoice's own payments, and gives the transfer's reference, the amount taken from the wallet, the method, the day it failed and its status. Once a person explains the missing refund, or reconciliation stops finding it missing, the draft says it no longer fits.

If the supplier has asked to hold, cancel or not pay the invoice, PayOnce suggests nothing to send them. The card says why and lists the messages that would fit, each with a "Draft one anyway" button. The two requests to Airwallex are still offered. A message already marked sent is not offered again until its facts change, for example when the bank pays.

A draft is built only from what PayOnce formats itself: the invoice number, amounts, bank references, dates and statuses, and the last four digits of the phone number on file. It never includes the supplier's name, anything from an email, an escalation reason or account details. For when a payment usually arrives it uses the route advisory's latest usual day, never PayOnce's own bank deadline, and without an estimate it says "within the usual time for this route".

The text is fixed when it is drafted. Its SHA-256 goes on the incident's timeline in the same write, and copying, sending and dismissing are recorded there too. If the payment changes afterwards, for example the bank pays it, the card says what changed and suggests drafting it again. If the stored text no longer matches its hash, the card says that too.

## Ask this incident why

Each incident has a "Why this happened" card at the top of its side column, and `pnpm ask <INVOICE>` does the same in the terminal. The command is `pnpm ask` because pnpm runs its own `why` command, a dependency check, in place of a script named `why`. It asks the model reader's models for a short account in plain English of what PayOnce did on the invoice, why it did it, and what it is waiting on now. Nobody types a question, so nothing from the page reaches the prompt. The answer is only for reading: PayOnce never stores it in the ledger, the timeline, approval terms, alerts or drafts, and nothing it decides reads it.

The model gets PayOnce's own records and nothing else. That means states, amounts, bank references and statuses, failure codes in PayOnce's words, the reasons its rules gave, the approval request and where it stands, the settings PayOnce reads now, active outages and any ended outage that held the invoice, and the newest 60 timeline lines, with a count of those left out. It never gets an email, a subject, a sender, a display name, an attachment name, anything from an upload, account details, a phone number, a payout reference, a note someone typed or an error message. People and other invoices go in as labels such as [person 1] and [invoice 2], and PayOnce puts the real names back only in the answer it shows. A timeline line goes in only when it matches one of PayOnce's own templates and has the kind PayOnce gives that template, so an error message or a typed name that reads like a decision or a bank update goes in as a stand-in. Any other line goes in as a stand-in such as "(an error line PayOnce does not pass on)", and a reason PayOnce does not recognise goes in as "(a reason PayOnce does not pass on)". `pnpm ask <INVOICE> facts` prints exactly what would be sent and asks nothing.

The request uses the reader's key, base URL, model list and 8 second timeout, and PayOnce cuts the key out of any error: as written, URL-encoded or in base64, and any run of 20 or more characters from one of those forms, whatever the case of its letters. The card says the records go to Google's free tier when the reader uses Google's endpoint, and names the host for any other service. The page allows 2 asks a minute and 30 a day per server, one at a time, which leaves most of the free-tier quota to the email reader. If nothing on the invoice has changed, asking again within 10 minutes gives the same answer from memory and sends no request. The server keeps those answers in memory only, so a restart forgets them. If every model fails, the card and `pnpm ask` say what happened to each, such as "gemini-3.5-flash was busy (503), then gemini-3.1-flash-lite cut its answer short". If every model answers 429, the page waits a minute before it asks again. The terminal has no limit. Without `READER_API_KEY` the card says the model reader is off.

## Run it

You need Node 24 (PayOnce uses its built-in `node:sqlite`) and pnpm 12. If you do not have pnpm 12, run `npm install -g pnpm@12`.

```bash
pnpm install
pnpm typecheck
pnpm dev
```

`pnpm typecheck` runs the TypeScript compiler as a check and writes no files. `pnpm dev` needs no credentials. It reads the sample supplier emails in `fixtures/emails/` and prints the findings and the decision for seven incidents.

`pnpm ui` and the commands that send or read payments talk to the Airwallex sandbox. They need a `.env` file in the project folder, and so does `pnpm approve` to record an approval. Without it, a command that needs a credential stops and names the missing setting. Create one with your sandbox Client ID and API key and a list of approvers:

```bash
AWX_CLIENT_ID=your-client-id
AWX_API_KEY=your-api-key
APPROVERS=Yash:50000,Alex:10000,Kim:10000,Sam:4200
RESERVE_FLOORS=USD:1000000,EUR:1000000
WEBHOOKS=off
```

Without `APPROVERS` nobody can approve, so every approval is refused. Without `RESERVE_FLOORS` no currency has a floor, and every failed payment goes to a person instead of being replaced. Set `WEBHOOKS=off` for the sandbox. `on` and `off` work in any case, and any other value, such as `on|off` copied from `.env.example`, also turns webhooks off, with a start-up line saying so. Airwallex records webhook events there but never delivers them (see [Webhooks](#webhooks)), and while webhooks are on, the status check that finds every change runs every 15 seconds instead of every 3. Leave the line out to open the tunnel, for an Airwallex account that delivers webhooks.

`.env.example` lists every setting with its default. Read it as a reference rather than copying it as it is. `NAME!` is a required secret: write it as `NAME=value`. `NAME=value` shows the default. A line such as `ALERT_FORMAT=slack|discord  # default: slack` lists the values a setting takes and which one is the default, so write just one of them. A name with no value is unset by default, and its comment says what unset means: most such settings are off until you set them, but leaving `WEBHOOK_URL` unset, with `WEBHOOKS` at its default, opens a cloudflared tunnel. Put only the lines you change in `.env`. PayOnce talks only to the sandbox: `AWX_BASE_URL` must be `https://api.sandbox.airwallex.com`, the default, or `https://api-demo.airwallex.com`, and any other address stops it at start-up with a line that lists the addresses it takes. A value with `|` in it is the list of choices from `.env.example`, and the line says to keep one of them. The one exception is `https://sandbox.invalid`, a name that never resolves, for running the page with no Airwallex at all: every Airwallex call then fails as if Airwallex were down. When `pnpm ui` starts, it names the host its calls go to, and for this host it says no call reaches Airwallex.

For a model to read the emails, create a Gemini API key in Google AI Studio and set it as `READER_API_KEY`. The free tier needs no billing account. Google may use free-tier content to improve its products. The "Supplier email" card says so next to the upload: keep confidential mail out, or leave the key unset and let the keyword placeholder read it. `READER_MODEL` takes a comma-separated list of models to try in order.

### The web page

```bash
pnpm ui
```

Open `http://127.0.0.1:4310`. The page opens on the [incident board](#incident-board). `docs/demo.md` walks through four incidents in under five minutes. Choose a payment, a bank outcome and a supplier email thread, then start an incident. The page follows it step by step. The agent waits for a webhook or a status check after each bank outcome, so an incident takes up to a minute in the sandbox. When an incident is waiting on a person, the approval card shows the terms and takes a name. If the bank has paid the invoice, a close card takes a name and a note instead. When nothing for the invoice is with the bank, the same card closes it without paying. "Check again" continues an incident that stopped part-way.

The server has no login. It listens on this machine only and accepts changes only from its own page. It also refuses reads that another website's page sends from your browser, while the page itself, a typed address, `curl` and the terminal commands work as before.

### The terminal

```bash
pnpm recover [OUTCOME] [INVOICE] [EMAILS] [SCENARIO] [NAME]
pnpm approve <INVOICE> [REQUEST NAME]
pnpm close <INVOICE> [NAME] [NOTE] [--covers=REF,...]
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
pnpm outage
pnpm outage end <ID> <NAME> <NOTE>
pnpm supplier [RECORD|INVOICE]
pnpm reconcile [offline]
pnpm reconcile show [CURRENCY]
pnpm reconcile explain <ID[,ID...]> [NAME NOTE --facts=FP[,FP...]]
pnpm mcp
pnpm ask <INVOICE> [facts]
pnpm metrics [7d|30d|all] [json]
pnpm reset
```

`pnpm metrics` prints the [metrics](#metrics) for the last 7 days, or the period given, with times in UTC. `json` prints what `GET /api/metrics` answers. It opens the ledger read-only and needs no `.env`, so it refuses a ledger an older PayOnce wrote: open that ledger once with `pnpm ui` or `pnpm board` first.

`pnpm ask` asks the model why PayOnce did what it did on one invoice (see [Ask this incident why](#ask-this-incident-why)). With `facts` it prints the facts and the system message exactly as they would be sent, then the legend of labels, which stays on this machine, and asks nothing. It opens the ledger read-only and never calls Airwallex, so it refuses a ledger an older PayOnce wrote: open that ledger once with `pnpm ui` or `pnpm board` first. It strips control and format characters from names and invoice numbers after it swaps the labels back, as `pnpm board` does.

`pnpm reconcile` runs one check against Airwallex and prints the report: each wallet, the breaks that need a person, what is waiting and the last explanations. `offline` matches what the ledger holds again with no Airwallex call, `show` prints the last report from the ledger alone without creating or upgrading a file, and `explain` lists breaks with their facts or explains them. The check, `offline` and `show` exit 1 when the check failed (for `show`, the latest check against Airwallex on file, even when an offline match came after it), a wallet does not add up or any break is open, so a script can check the result.

`pnpm outage` lists the active outages and the last few ended, with the payouts each counted and what it held. `pnpm outage end` ends one, as the button on the page does. It writes only the ledger, and the server's watcher picks up what the outage held on its next check.

`pnpm supplier` lists every supplier record, and `pnpm supplier <RECORD>` prints one as the supplier view shows it (see [Supplier view](#supplier-view)). Give an invoice number instead to see the record that invoice pays. It reads only the ledger and never calls Airwallex.

`pnpm outbox` lists an invoice's drafts and the messages that fit now. The templates are `payment-sent`, `replacement-sent`, `checking`, `callback-notice`, `bank-trace` and `refund-trace`. It reads and writes only the ledger, and runs without a `.env`. When there is one, it takes the bank deadlines from it.

`pnpm payrun upload` and `check` read Airwallex, GETs only. `show`, `approve` and `cancel` read only the ledger, and run without a `.env`. `approve` without a name shows the terms and the request number, like `pnpm approve`.

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

The first replaces the payment and shows the lock refusing a second one. The second ends in an escalation. In the third, the supplier asks for payment to a new account from a look-alike address, so it escalates although a channel timeout on its own would be replaced. `pnpm approve` with no name shows the terms, the request number and who may approve them. With the request number and a name it records that person's approval, so `1` stands for the number it printed. A request opened since is refused, so nobody approves terms they have not seen. `pnpm recover` started the incident under your login name, so approve it under a name from `APPROVERS`. `pnpm recover - INV-5001` then sends the replacement to the account on file. The outcome is ignored for an invoice that has already tried a payment, so `-` works as a placeholder here.

In the fourth, the bank pays the original while the supplier says it never arrived, so the incident goes to a person. `pnpm close` with no name shows what is waiting, and with a name and a note it closes the incident.

In the fifth, `inv-05002` has the same supplier, amount and number as INV-5002, so PayOnce holds it and sends nothing. `pnpm close` closes it without paying. To pay it instead, approve it with `pnpm approve` and run `pnpm recover - inv-05002`. The bank then pays the original, or does what the outcome says if one is given in place of `-`.

## Read PayOnce from Claude

`src/mcp.ts` is a read-only Model Context Protocol server over stdio. Add it to Claude Code or Claude Desktop and Claude can answer questions such as "what is waiting on a person?" or "why did INV-5001 go to a person?" from the ledger. It has eleven tools:

| Tool | What it returns |
| --- | --- |
| `board` | The incident board, with the page's filters: group, wallet and origin |
| `incidents` | Every invoice, newest first, with its state, board group and headline as the page lists them: the board's reason for an open invoice, else its latest decision, close or standing line |
| `incident` | One invoice: its payments and what the bank did, payouts sent outside PayOnce, the active outage on its rail, the latest approval request with its terms, whether a person can close it, what the supplier emails were found to say, the newest timeline lines and its audit check |
| `cash` | The cash panel, per wallet |
| `runs`, `run` | The pay runs, and one run's rows, cash check, approval request and timeline |
| `audit` | The invoice and pay run hash chain checks `pnpm run audit` makes, for the whole ledger, one invoice or one run. Reconciliation's chain is left out, and only `pnpm run audit` checks it |
| `outages` | The active rail outages and those ended lately |
| `suppliers`, `supplier` | Every supplier record, and one record as the supplier view shows it, without its waiting emails and drafts. `supplier` takes a record id or an invoice number |
| `metrics` | The metrics for `7d`, `30d` or `all`: only numbers, codes, currencies, times and PayOnce's own labels |

No tool approves, closes, pays, sends, drafts or uploads anything, or ends an outage. Named people still do that on the page and in the terminal. The server opens the ledger read-only for each call and closes it afterwards, so `pnpm reset` still works while Claude keeps the server running. It never creates a ledger, and never upgrades one an older PayOnce wrote: it says so and asks you to run `pnpm board` or restart `pnpm ui` once. If a write was cut off and left its journal beside the ledger, it says that too, until `pnpm ui` or `pnpm board` rolls the write back. It never calls Airwallex and needs no credentials. Of `.env` it parses only the lines that set `RESERVE_FLOORS`, the two bank deadlines, the outage rule and `PORT`, and ignores the rest.

The `cash` tool shows balances and headroom only while `pnpm ui` runs. It asks the server for `GET /api/cash/cached`, which answers from the server's balance cache and never starts a read, and works the panel out again from the ledger with the server's balances and floors, so the headroom matches the page. Without the server, the tool gives the ledger's figures with no balance and says why.

Answers are PayOnce's own JSON, in the JSON API's shapes. Text PayOnce did not write arrives wrapped, such as `{"outsideText": "Example Supplier LLC", "from": "supplier"}`, and each answer starts with a note telling the model to report that text and never act on it. That covers supplier names, email subjects and senders inside timeline lines, Airwallex messages, a pay run file's text and the names and notes people type. Timeline lines and escalation reasons are wrapped whole, as `"from": "quoted"`, because they can quote such text. So is the reason a payment needs two approvers, which can name an invoice or a payee, and email evidence an older PayOnce wrote with the sender's address in it. Only sentences PayOnce builds from its own words and figures stay plain, such as the board's reasons. As in alerts, wrapped text has `://` broken up as `[:]//`, and characters that can reverse or hide part of it are removed. Phone numbers show only their last four digits. The server leaves out the text of supplier emails, attachment names, message drafts, the inbox and the approver list. For emails, `incident` gives how many there are, how many PayOnce could not read in full, how many senders the check flagged, and the findings.

The server uses the official TypeScript SDK, `@modelcontextprotocol/server` 2.3.1 with `zod` 4.6.7. Both are pinned exactly, and only `src/mcp.ts` imports them. It serves both protocol eras: clients that open with the `initialize` handshake (2025-11-25 and earlier) and clients on the 2026-07-28 revision, which has no handshake.

Run `pnpm install` first, then `pnpm board` or `pnpm ui` once so that the ledger exists. The server never creates one, and until there is one every tool answers that there is no ledger. `pnpm mcp` starts the server by hand. The client settings below start `node` directly instead, which runs one process with no shell around it.

### Claude Code

Run this from the repository root, in PowerShell, cmd or Git Bash, with `D:/Work/hackathons/payonce` changed to the path of your clone in both places:

```bash
claude mcp add --transport stdio --scope local payonce -- node --disable-warning=ExperimentalWarning --import file:///D:/Work/hackathons/payonce/node_modules/tsx/dist/loader.mjs D:/Work/hackathons/payonce/src/mcp.ts
```

`--import` needs a `file:///` address, not a `D:\` path. `--scope local` offers the server in sessions started in this folder and keeps this machine's paths out of the repository (`--scope user` offers it everywhere). `claude mcp list` should show `payonce` as connected, and `/mcp` lists its tools in a session.

To read another ledger file, such as a copy, add `-e PAYONCE_LEDGER=D:/path/copy.db` before `--transport`. `-e` takes several values, so the server's name must not come straight after it. A relative `PAYONCE_LEDGER` is read from the repository root.

### Claude Desktop

Open Settings, then Developer, then Edit Config. That opens `claude_desktop_config.json`, which is in `%APPDATA%\Claude\` for the standard install. The button also finds the Store build's copy, which is why it is safer than typing the path. Add the block below, with the node path changed to the one `where.exe node` prints and the two `D:` paths changed to your clone's. Double each backslash inside the JSON strings:

```json
{
  "mcpServers": {
    "payonce": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "--disable-warning=ExperimentalWarning",
        "--import",
        "file:///D:/Work/hackathons/payonce/node_modules/tsx/dist/loader.mjs",
        "D:\\Work\\hackathons\\payonce\\src\\mcp.ts"
      ]
    }
  }
}
```

Quit Claude Desktop fully and start it again. It writes the server's stderr to `%APPDATA%\Claude\logs\mcp-server-payonce.log`. To read another ledger file, add `"env": { "PAYONCE_LEDGER": "D:/path/copy.db" }` beside `args`.

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
| `src/outages.ts` | Rail outages: the rule, counting failures, the timeline lines, ending one, and what the page and the board show |
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
| `src/incident-board.ts` | The incident board: active outages and what they hold, then every open invoice in its group, with the money it has at risk and why |
| `src/suppliers.ts` | The supplier view: one Airwallex beneficiary record, its accounts, invoices, payments and cautions, read from the ledger, for the page, `pnpm supplier` and the MCP server |
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
| `src/why-facts.ts` | The facts a model gets to explain an incident: PayOnce's own fields, the reasons and timeline lines it recognises, and labels for people and other invoices |
| `src/explainer.ts` | Asks the model reader's models to explain an incident, checks and cleans the answer, and keeps the page's limits |
| `src/drafts.ts` | Messages to send: the templates, which ones fit an incident, and drafts that keep their hash |
| `src/recon-match.ts` | Reconciliation's matcher, the break kinds and their wording |
| `src/recon-store.ts` | Reconciliation's tables, its runs, its breaks and their hash chain |
| `src/reconcile.ts` | One reconciliation check, the server's timer, the report and a person's explanation |
| `src/metrics.ts` | The metrics: the eight tables for a period, read from the ledger, and the reason codes |
| `src/alerts.ts` | Alerts: the webhook setting, what needs a person, and posting with retries |
| `src/alert-payloads.ts` | What an alert says, and its Slack and Discord message shapes |
| `src/server.ts` | Local web server and JSON API |
| `src/mcp.ts` | The read-only MCP server over stdio, and the only file that imports the MCP SDK |
| `src/mcp-views.ts` | What the MCP tools answer, from the ledger alone |
| `src/mcp-text.ts` | Marks the text PayOnce did not write in an MCP answer, and masks phone numbers |
| `src/money.ts` | Major and minor units, and amounts as people read them, for two-decimal currencies |
| `src/printable.ts` | Cleans every line PayOnce prints to a terminal, so a name or an error cannot move the cursor or write the clipboard |
| `src/terms-shape.ts` | Checks stored approval terms, an invoice's or a pay run's, before `pnpm approve` or `pnpm payrun` prints them |
| `src/recover.ts`, `src/approve.ts`, `src/close.ts`, `src/audit.ts`, `src/cash.ts`, `src/board.ts`, `src/payrun.ts`, `src/outbox.ts`, `src/outage.ts`, `src/ask.ts`, `src/recon-cli.ts`, `src/metrics-cli.ts`, `src/supplier.ts`, `src/reset.ts`, `src/index.ts` | The commands |
| `src/airwallex/` | Sandbox client: login, beneficiaries, transfers, exchange rate quotes, balances and their cache for the cash panel, balance history, the webhook subscription and the simulation calls |
| `web/` | The page: plain HTML, CSS and JavaScript with no build step |
| `fixtures/emails/` | Sample supplier emails |
| `fixtures/pay-run-example.csv` | A sample pay run file |

The code holds amounts in minor units and converts at the Airwallex boundary. The ledger is `payonce.db` in the working directory. `pnpm reset` moves it aside, and the next run starts an empty one. Stop `pnpm ui` first.

A ledger from before PayOnce kept which account each payment went to keeps that account only for payments an approval or a pay run row named. A supplier PayOnce paid only in other ways counts as paid before with the account not confirmed: its next first payment waits for two approvers, until a payment checked against its account is paid. `pnpm reset` avoids this.

## Not built yet

- Asking a model a question of your own about an incident. The "Why this happened" card asks one fixed question.
- Pay run timelines in an explanation. A pay run row's facts give only its run and line.
- Closing an invoice while a payment for it is still with the bank. A person can close it once the bank pays or fails that payment.
- Chasing the bank by itself. When a payment passes its deadline, PayOnce tells a person and offers a trace request for them to send to Airwallex.
- Sending email. Messages are drafted for a person, who sends them from their own mail, and PayOnce keeps no recipient addresses.
- A floor check on a single incident's first payment. Pay run rows have one.
- Totals across currencies. They need exchange rates. A run's approver limits are compared with each currency's total on its own, and the incident board ranks amounts in different currencies as plain numbers.
- Editing a run, approving part of one, or scheduling one for a later date. Cancel it and upload a corrected file.
- Recording a callback for a supplier outside an incident, so a run can pay a supplier who changed banks.
- What a supplier's Airwallex record holds right now. The supplier view shows what PayOnce last stored, and PayOnce reads the record again before every payment.
- Spotting look-alike supplier names, such as a Cyrillic letter in place of a Latin one. The supplier view links records whose names read the same once case, spacing and invisible characters are set aside, but never by an empty name or the "Unnamed payee" a found payout with no account name gets.
- The last four characters of an account for payments made before PayOnce kept where each transfer went. The supplier view shows "ending not on file" for them.
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
- Ending an outage by itself, probing a rail to see whether it works again, or declaring an outage by hand. A person ends every outage.
- Releasing only the rows of a pay run that do not pay on a rail with an outage. The whole run waits.
- Reading financial transactions for reconciliation. Balance history has the running balance that shows a wallet adds up, and needs no other API scope.
- Reconciliation's wallets and breaks on the incident page, the board or the cash panel, in the MCP server, or as an export. It has a page of its own and `pnpm reconcile`. The MCP `metrics` tool gives only the break counts, and an incident shows a missing refund only as the refund trace in "Messages to send".
- Charts, exports or stored snapshots of the metrics, money at risk over a past period, figures per person, and lists of the invoices behind a figure. Metrics are tables of what the ledger holds now, and the board and the incident list link every invoice.
- Checking the refund of a failed converting transfer. The simulator cannot fail one, so reconciliation accepts that refund in either wallet, and that path is not verified in the sandbox.
- Counting an outage's failures from a webhook or from the status check. A look at the invoice and the sweep count them, so a failure can take up to one sweep, 30 seconds, to count.
- Grouping failures by bank. Several payees at one bank that fail together still declare an outage on the whole rail.
- Currencies with no decimals or three, such as JPY or KWD. Amounts are handled for two-decimal currencies only. Reconciliation leaves a wallet in such a currency, and every transfer from one, not reconciled, with no break, while a two-decimal wallet's debit for a transfer paid in such a currency is reconciled as usual.
- A login. Names are typed, so the approval rules stop mistakes, not someone typing another person's name.
- A keyed hash chain, or one anchored outside the ledger. Anyone who can write `payonce.db` can rewrite a timeline and recompute every hash and the running hash, and `pnpm run audit` then reports it intact.

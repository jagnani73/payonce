# PayOnce

A payment incident agent that recovers failed supplier transfers without paying twice.

PayOnce is my entry for the Airwallex Agentic Banking Hackathon 2026. It starts from starter kit 3, Payment Ops Incident Commander.

> Status: working demo against the Airwallex sandbox. A model reads supplier emails when a key is set, and a keyword placeholder reads them when it is not. Sandbox only, no real money.

## The problem

A supplier says a payment never arrived and their deadline has passed. The transfer shows as sent but not settled. Finance can wait, send a replacement, or escalate, and each choice can go wrong: wait too long and the supplier stops shipping, replace too early and you have paid twice. This is also when fraudsters send the "please resend to our new account" email.

## What it does

PayOnce follows each supplier payment through an incident. It sends the transfer and then reacts to what happens: the bank pays or fails it, the supplier writes in, or a person approves something. An Airwallex webhook or a status check tells it the bank has moved, and it reads the transfer from Airwallex itself before it decides. Each time, it waits, replaces the payment, closes the incident, or hands the decision to a person. A web page shows each incident as a timeline, with the emails, the payments and whatever a person is asked to approve or close.

If the bank sits on a payment past its deadline, a person hears about it. PayOnce also looks through Airwallex for payouts it did not send, such as a resend made in the Airwallex web app, and holds its own payments for an invoice someone else has paid.

## What the agent decides

| Situation | Action |
| --- | --- |
| A payout for this invoice was sent outside PayOnce and has not failed | Escalate to a person |
| The supplier asks for payment to different bank details | Escalate to a person |
| The supplier's bank details on file changed after the original payment | Escalate to a person |
| An email came from an address that does not match the supplier on file | Escalate to a person |
| Supplier emails are on file that could not be read | Escalate to a person |
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
| No reserve floor is set for the payment's currency | Escalate to a person |
| The original failed, a resend can fix it and the beneficiary details are unchanged | Replace |

`src/decide.ts` checks the rules in that order. A resend can fix a failure only when it happened on the sending side: a system error or a channel timeout. Any other failure, including a return from the beneficiary's bank, goes to a person.

Two of these checks do not depend on how the email text is read. The sender's domain is compared with the one on file. The supplier's bank details are read from Airwallex again and compared with the account the original payment went to. When they differ the timeline says so, whatever reason the policy escalates for.

A model reads the supplier emails. It holds no credentials and moves no money. It answers two yes-or-no questions, and PayOnce writes the summary a person sees from those answers, so no wording from an email or from the model reaches the approval card. A keyword check reads the same thread, and a finding is yes if either says yes. Both findings lead to more caution, so an email that tricks the model cannot remove a finding the keyword check makes. An email that the keyword check misses and that also tricks the model can still hide a finding, which is why the sender check and the bank-details check are in code. The emails go to the model marked as untrusted text. If the model fails, or its answer is not two yes-or-no values, the thread counts as unread and the incident goes to a person.

The reader is Gemini 3.5 Flash by default, with Gemini 3.1 Flash-Lite as a second model if the first does not answer. Both are on Google's free tier and are called through its OpenAI-compatible endpoint, so any service that speaks the same format can replace them. Without a key, a keyword placeholder in `src/keyword-reader.ts` reads the emails. The page names the reader under its findings.

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

If Airwallex refuses an invoice's payment outright, the invoice is held the same way. A person approves paying it again or closes it without paying. PayOnce never replaces a payment by itself when it looks like a second bill for an invoice that is already paid.

The invoice number on the start form is optional. An invoice number already in the ledger is refused.

## Approvals

When the original has failed and the policy escalates, PayOnce records an approval request with the exact terms: the amount, the currency, the account the supplier's record points to now, and the evidence behind the escalation. A held invoice gets one as well. A person approves it on the web page or with `pnpm approve`, and the approval names the request they were shown.

Before paying, PayOnce rebuilds the terms from current data and compares them with what was approved. If they match, it sends the replacement. If anything changed, the approval is void and PayOnce opens a new request. An approval is spent on one attempt, and it cannot override the duplicate lock. Once an invoice has gone to a person, only an approval releases a payment, even if the policy would now replace it unprompted.

### Who can approve

Approvers are listed in `.env` as names with limits, for example `APPROVERS=Yash:50000,Alex:10000,Sam:5000`. Without the list nobody can approve. A limit is compared with the amount in the payment's own currency, because PayOnce has no exchange rates yet.

- Two different approvers are needed above `TWO_APPROVERS_ABOVE` (5,000 by default). Two are also needed whatever the amount when the payment would go to an account the original did not go to, and when PayOnce does not know who started the incident, as with a payout found in Airwallex.
- The person who started an incident cannot approve a payment for it. The page asks for a name when an incident starts. `pnpm recover` takes one as its fifth argument and uses the computer's login name without it.
- An approval request expires after `APPROVAL_TTL_MINUTES` (60 by default). The agent looks at the invoice again when it expires, voids it and opens a new one. Approvals given on the old request no longer count.
- Each approval records the hash of the terms its approver was shown, and the second approver has to approve the same request. The terms include a hash of every bank detail of the account, because the pay-to line shows only its last four digits. Before paying, PayOnce checks the approvals against the policy as it is then, so an approver taken off the list or a lowered limit voids them.
- A request completed just before it expired has ten minutes to be used, so a slow look does not lose it.
- If nobody on the list can approve a payment, for example because it needs two approvers and only one has a high enough limit, PayOnce opens no request and the timeline says so.
- The agent does not replace a payment above `TWO_APPROVERS_ABOVE` by itself either. It escalates, and the replacement needs two approvers.

The page has no login, so a name is whatever the person types or picks. The rules stop someone approving their own incident under their own name, and the timeline records who said what. They do not prove who was at the keyboard. That needs a login tied to each name.

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

A failed SWIFT transfer gets its amount back but not its fee, so a replacement pays the fee again. PayOnce adds that fee to the cost of a replacement before it checks the reserve floor. It also takes off money already committed to other payments in the same currency and not yet sent, and the timeline shows the numbers. In the `eur-swift-low-reserve` scenario the invoice gets a floor of its own, stricter than the one for EUR, set so that the second fee is what breaches it, and the incident goes to a person.

## Reserve floors

`RESERVE_FLOORS` in `.env` sets how much each wallet keeps back, as currency and amount pairs: `RESERVE_FLOORS=USD:1000000,EUR:1000000`. PayOnce replaces a failed payment by itself only if the wallet stays above its floor afterwards.

A currency that is not listed has no floor, and PayOnce never replaces a payment in it by itself. The incident goes to a person, the same way approvals are refused when `APPROVERS` is missing. To say on purpose that a currency needs no floor, list it with 0, as in `EUR:0`. If the setting cannot be read, every automatic replacement goes to a person. Floors are read when PayOnce starts, so a change needs a restart.

PayOnce checks the floor again before it sends a replacement a person approved. If the replacement would take cash below the floor, the currency has no floor or the setting cannot be read, the approval counts only if its request said so. Otherwise PayOnce voids it and opens a new request that gives both reasons: the one the incident went to a person for, and the floor.

A single incident's first payment is not checked against the floor. A pay run's rows are, when the run is checked, again when it is released, and once more when each row is sent.

## Cash panel

The page opens with a cash panel, one row per currency. A row shows the available balance from Airwallex, the reserve floor and the headroom: how much can still leave the wallet before cash drops below the floor. Open a row to see how the headroom is worked out, with each figure tagged by where it comes from.

The balance comes from Airwallex, with the age of the read. Money held for outgoing payments and money still arriving from currency conversions are shown next to it, but neither is part of available. The floor comes from `RESERVE_FLOORS`, and any invoice held to a stricter floor of its own is listed under it. The rest comes from PayOnce's ledger. Payments being sent that have no transfer yet, and approvals given but not used yet, are taken off to give the headroom. A second figure also takes off every payment waiting on a person, as if each one were approved.

Below that the panel lists payments already with the bank, payouts sent outside PayOnce and the fees kept on failed transfers. Airwallex takes a transfer out of available as soon as it is created, so the panel does not take these off again. Each is listed under the wallet the money left. A payout paid from another currency counts in the currency it was paid from, and a fee counts in the currency it was charged in.

The panel reads the balance from Airwallex when the page asks for it and the last read is 30 seconds old or more, so it reads nothing while no page is open. After a quiet spell the first answer can show a read several minutes old, with its age, while a new read runs. The page says so and picks up the new read a moment later.

That read is for display. Before an automatic replacement, PayOnce reads the balance fresh and takes off the same committed money the panel does. The panel's headroom can still differ from what that check sees. The panel's balance may be older, and the panel takes off the currency's floor, while an invoice with a stricter floor of its own is held to that floor (the panel lists such invoices under the floor). The check for one invoice also leaves that invoice's own committed money out.

If a read fails, the panel keeps the last good one, shows its age and says why the newer one failed. If no read has worked yet, it shows no headroom, because a headroom worked out from a missing balance would be wrong.

PayOnce reads each transfer's fee and keeps it in the ledger, and fills in older failed transfers, up to five after each balance read. A transfer it cannot read waits 10 minutes before the next try, and the others go first. The fee line is called "Fees on failed transfers". Once a fee on a failed transfer is on file, a note under it says the sandbox keeps the fee when a transfer fails. That rests on what the sandbox did with failed EUR SWIFT transfers, so the panel does not claim every rail works this way. The pay runs line takes off the rows of an approved run, and the released rows that have not sent their payment yet.

`pnpm cash` prints the same figures in the terminal after one fresh read. It exits with 1 when Airwallex could not be read, the floor setting is unreadable or a headroom is below 0, so a script can check it.

## Pay runs

A pay run pays a batch of invoices from one CSV file on one approval. Upload the file on the page under "Pay run", or with `pnpm payrun upload <FILE> <NAME>`.

```csv
invoice,supplier,beneficiary_id,amount,currency,method,sandbox_outcome
INV-RUN-1001,Example Supplier LLC,6170b987-3840-4825-8da6-c27671bd26ad,40.00,USD,LOCAL,PAID
INV-RUN-1002,Example Supplier LLC,6170b987-3840-4825-8da6-c27671bd26ad,41.00,USD,LOCAL,ACCOUNT_CLOSED
```

`fixtures/pay-run-example.csv` is a sample. Its beneficiary ids belong to the sandbox account PayOnce was built on, so use your own.

Each row names the beneficiary by its Airwallex id and gives the supplier's name, the amount and the currency. The amount is in major units with a dot, at most two decimals and no thousands separator. `method` is optional. `sandbox_outcome` tells the sandbox bank what to do with the row's payment: `PAID` by default, or a failure type as in `pnpm recover`. PayOnce never reads bank details, phone numbers or email domains from a file. It pays the account on the beneficiary record. A file holds 50 rows at most. A file PayOnce cannot read is refused with every problem found. A problem in the header, such as a missing or unknown column, gives the header's line, and a quote that never closes gives the line it opened on. A problem with the whole file has no line: no name, an empty file, no rows after the header, more than 50 rows, or more than 40,000 characters.

PayOnce checks every row with GETs only. It skips a row that:

- has a cell it cannot read, such as `4,000.00`, `40.005` or a currency without two decimals;
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

Every payment PayOnce sends holds a lease on its currency, from the balance read to the recorded transfer: a run's row, an automatic or approved replacement, or a held invoice paid on an approval. The lease is a row in the ledger, so the terminal and the server take turns, and it runs out after a minute if the process holding it dies. An automatic replacement reads the balance again under the lease and decides again on it, so two replacements in one currency can no longer pass on the same cash. Payments get the lease in the order they asked for it, so a run sending its rows one after another cannot keep a replacement waiting. A payment waits up to 45 seconds for the payments ahead of it. Then it sends nothing, spends no approval and tries again a minute later. PayOnce writes a payment to the ledger, before sending it, only while its lease is still held, so a payment whose lease ran out is never written or sent. Payouts sent from the Airwallex web app take no lease.

## Webhooks

`pnpm ui` listens for Airwallex payout webhooks on a second port, 4311, that answers one path. To give Airwallex an address it can reach, PayOnce opens a Cloudflare quick tunnel, which needs no Cloudflare account. It then points its Airwallex webhook subscription at the tunnel. The first run creates the subscription, and later runs move it, because a quick tunnel gets a new address each time it starts. The page and its API stay on this machine and are not behind the tunnel.

An event counts only if its signature checks out with the subscription's secret, and an event already seen is ignored. A paid or failed event only tells PayOnce to look again. PayOnce reads the transfer from Airwallex and decides on what it reads. An event for a transfer PayOnce does not know starts a sweep.

A status check runs every 15 seconds in case an event is late or lost, and every 3 seconds when webhooks are off. In the sandbox, Airwallex records an event for every status change but leaves each one queued and never sends it, even a test event sent from its own web app, so the status check finds every change. A request from outside through the tunnel does reach the receiver.

Install cloudflared with `winget install --id Cloudflare.cloudflared`, or set `CLOUDFLARED` to the path of `cloudflared.exe`. Set `WEBHOOK_URL` to use a public address you already have, or `WEBHOOKS=off` to skip webhooks.

## Run it

```bash
pnpm install
pnpm dev
```

`pnpm dev` needs no credentials. It reads the sample supplier emails in `fixtures/emails/` and prints the findings and the decision for six incidents.

Everything else talks to the Airwallex sandbox. Copy `.env.example` to `.env` and fill in a sandbox Client ID and API key. Set `RESERVE_FLOORS=USD:1000000,EUR:1000000` as well. Without it no currency has a floor, and every failed payment goes to a person instead of being replaced.

For a model to read the emails, create a Gemini API key in Google AI Studio and set it as `READER_API_KEY`. The free tier needs no billing account. Google may use free-tier content to improve its products, so keep real supplier emails out of it. `READER_MODEL` takes a comma-separated list of models to try in order.

### The web page

```bash
pnpm ui
```

Open `http://127.0.0.1:4310`. `docs/demo.md` walks through four incidents in under five minutes. Choose a payment, a bank outcome and a supplier email thread, then start an incident. The page follows it step by step. The agent waits for a webhook or a status check after each bank outcome, so an incident takes up to a minute in the sandbox. When an incident is waiting on a person, the approval card shows the terms and takes a name. If the bank has paid the invoice, a close card takes a name and a note instead. "Check again" continues an incident that stopped part-way.

The server has no login. It listens on this machine only and accepts changes only from its own page.

### The terminal

```bash
pnpm recover [OUTCOME] [INVOICE] [EMAILS] [SCENARIO] [NAME]
pnpm approve <INVOICE> [REQUEST NAME]
pnpm close <INVOICE> [NAME] [NOTE]
pnpm run audit [INVOICE] [json|csv]
pnpm run audit run <RUN> [json|csv]
pnpm cash
pnpm payrun upload <FILE> <NAME>
pnpm payrun show <RUN>
pnpm payrun approve <RUN> [REQUEST NAME]
pnpm payrun check <RUN>
pnpm payrun cancel <RUN> <NAME> <NOTE>
pnpm reset
```

`pnpm payrun upload` and `check` read Airwallex, GETs only. `show`, `approve` and `cancel` read only the ledger. `approve` without a name shows the terms and the request number, like `pnpm approve`.

| Argument | Values | Default |
| --- | --- | --- |
| `OUTCOME` | A simulated bank outcome: `PAID`, `STAYS_IN_FLIGHT`, or a failure type such as `CHANNEL_TIMEOUT`, `SYSTEM_ERROR`, `BENEFICIARY_BANK_RETURNED` or `ACCOUNT_CLOSED` | `CHANNEL_TIMEOUT` |
| `INVOICE` | Any invoice number. A new one starts an incident and an existing one continues it | A random number |
| `EMAILS` | `nothing-arrived`, `new-account` or `moved-banks` | `nothing-arrived` |
| `SCENARIO` | `usd-local`, `eur-swift`, `eur-swift-low-reserve` or `usd-local-bank-change` | `usd-local` |
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
| `src/sweep.ts` | Finds payouts PayOnce did not send |
| `src/duplicates.ts` | Finds invoices that look like a second bill, and the invoice a payout sent outside PayOnce is for |
| `src/webhooks.ts`, `src/tunnel.ts` | The webhook receiver and its signature check, and the cloudflared tunnel |
| `src/sandbox-bank.ts` | Plays the bank in the sandbox: sends, pays and fails transfers |
| `src/scenario.ts` | The sample payments and the scripted incident |
| `src/assess.ts` | Maps an Airwallex transfer to the facts the policy reads |
| `src/ledger.ts` | Obligations, payment attempts, approvals, emails and the timeline in SQLite |
| `src/audit-trail.ts` | How timeline lines are hashed and checked, and the JSON and CSV export |
| `src/payments.ts` | Sends an attempt under its `request_id`, syncs transfer state and fees into the ledger, and fills in fees missing from older failed transfers |
| `src/reserve.ts` | The reserve floors from `RESERVE_FLOORS`, and the floor one invoice's replacement is held to |
| `src/cash-position.ts` | The cash panel's figures, and the committed money the policy also takes off, pay runs included |
| `src/run-file.ts` | Reads a pay run CSV file and the cells of each row |
| `src/runs.ts` | Pay runs: the checks, the terms and the request, approving, releasing and cancelling a run |
| `src/currency-lock.ts` | The lease that lets one payment at a time be sent in each currency |
| `src/approval.ts` | Approval terms and the hash that binds an approval to them |
| `src/approvers.ts` | The approval policy: who may approve, how many are needed, and when a request expires |
| `src/bank-change.ts` | Records a callback about new bank details and updates the supplier's record in Airwallex |
| `src/emails.ts` | The email reader interface, the findings a reader returns, and the sender check |
| `src/model-reader.ts` | The model reader: one chat completion that returns the findings |
| `src/reader.ts` | Picks the model reader, or the keyword placeholder when no key is set |
| `src/keyword-reader.ts` | Keyword placeholder that reads the emails when no key is set |
| `src/server.ts` | Local web server and JSON API |
| `src/recover.ts`, `src/approve.ts`, `src/close.ts`, `src/audit.ts`, `src/cash.ts`, `src/payrun.ts`, `src/reset.ts`, `src/index.ts` | The commands |
| `src/airwallex/` | Sandbox client: login, beneficiaries, transfers, balances and their cache for the cash panel, the webhook subscription and the simulation calls |
| `web/` | The page: plain HTML, CSS and JavaScript with no build step |
| `fixtures/emails/` | Sample supplier emails |
| `fixtures/pay-run-example.csv` | A sample pay run file |

The code holds amounts in minor units and converts at the Airwallex boundary. The ledger is `payonce.db` in the working directory. `pnpm reset` moves it aside, and the next run starts an empty one. Stop `pnpm ui` first.

## Not built yet

- A model's explanation of each decision. The reasons on the timeline come from the policy.
- Closing an incident without a payment, except a held duplicate. A person can close any other only when the bank reports a payment for the invoice as paid.
- Chasing the bank. When a payment passes its deadline, PayOnce tells a person and does nothing else.
- A floor check on a single incident's first payment. Pay run rows have one.
- Totals across currencies. They need exchange rates. A run's approver limits are compared with each currency's total on its own.
- Editing a run, approving part of one, or scheduling one for a later date. Cancel it and upload a corrected file.
- Recording a callback for a supplier outside an incident, so a run can pay a supplier who changed banks.
- A webhook delivered by the sandbox. The receiver, the tunnel and the subscription work, and Airwallex records the events, but the sandbox has not sent one.
- Real bank outcomes. The run uses the sandbox simulator to send, fail and pay transfers.

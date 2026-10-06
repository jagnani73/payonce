# Demo run-through

Four incidents on the web page, in about four and a half minutes. Each one shows a different decision. The times in the table come from a dry run against the sandbox on 6 October 2026, where the four incidents took about 42 seconds of sandbox time in total. That run used the keyword reader. With a model reading the emails, each read took 2 to 5 seconds in checks the same day, and one took 12. The run makes five reads.

## Before recording

```bash
pnpm reset
pnpm ui
```

`pnpm reset` moves the current ledger aside, so the page opens with no incidents. Stop `pnpm ui` first if it is running, because the reset cannot move a ledger that is open.

Open `http://127.0.0.1:4310`. Use a window at least 1500 pixels wide at 125% zoom. Below that the timeline and the cards stack into one column and the approval card moves above the timeline.

Set `READER_API_KEY` in `.env` so a model reads the emails. After `pnpm ui` starts, the console names the models it will ask. The free tier allows about five requests a minute on the first model, and the second takes over if the first is rate limited. AI Studio shows the daily limits.

The run sends six sandbox transfers. Airwallex emails the account owner for each one unless transfer notifications are off under Settings > User settings > Notifications.

## The run

| Time | Do | Sandbox time | Point at |
| --- | --- | --- | --- |
| 0:00 | Show the empty page | | The problem: a supplier says a payment never arrived. Waiting too long stops shipments, and replacing too early pays twice |
| 0:25 | Start an incident with the form as it loads: USD local transfer, channel timeout, nothing arrived | 13 s | "Wait" while the transfer is in flight. The bank fails it. "Replace". The replacement is paid and the incident closes. The last line is the ledger refusing a second payment |
| 1:10 | Change supplier emails to "New account" and start | 8 s | The same bank failure as before. The second email comes from `example-supp1ier.test`, with a digit one in place of the letter l. The warning, then "Escalate". The approval card pays the account on file, ending 6789, and not the account in the email |
| 1:50 | Type a name and approve | 8 s | "Approval matches the current terms". One replacement goes to the account on file and the incident closes |
| 2:30 | Payment "EUR, SWIFT, low cash reserve", emails "Nothing arrived", start | 7 s | The cost line: a replacement pays the SWIFT fee a second time, and that fee is what takes cash below the reserve floor. "Escalate". Leave this one waiting |
| 3:20 | Payment "USD, local transfer", bank outcome "Paid", start | 7 s | The bank says paid and the supplier says nothing arrived. "Escalate". There is no approval card, because there is nothing to pay |
| 3:50 | On the close card, type a name and what the supplier confirmed, then close | | The incident closes on one payment. The name and the note are on the timeline |
| 4:10 | Scroll the incident list | | Three closed and one waiting on a person. Then the wrap-up below |

## What to say in the wrap-up

- The rules are a pure function in `src/decide.ts`. The reader returns two yes-or-no findings and a summary. It returns no amounts and no bank details, so it cannot change what is paid or to whom.
- The duplicate lock is a unique index in SQLite. The database refuses a second live payment for an invoice, whatever the code above it does.
- An approval covers the exact terms on the card and one payment. If the account on file, the amount or the evidence changes, the approval is void.
- Gemini 3.5 Flash on the free tier reads the emails. It answers two yes-or-no questions and PayOnce writes the summary, so no wording from an email reaches the approval card. Before recording, check the findings say "Reader: gemini-3.5-flash" or "Reader: gemini-3.1-flash-lite" and not the keyword placeholder.
- Everything runs against the Airwallex sandbox. The simulator stands in for the bank.

## If something goes wrong

- The sandbox simulator sometimes answers with a server error. PayOnce reads the transfer again and retries, so a step can take a few seconds longer. Keep talking.
- If an incident stops part-way, "Check again" picks it up. It cannot send a second live payment.
- If the timeline says the emails could not be read, every model failed and the incident went to a person, which is the safe outcome. Wait a minute and run that incident again.
- For another take, stop `pnpm ui`, run `pnpm reset` and start again.

## Cut for time

Drop the EUR incident first. The other three cover replace, the look-alike email with an approval, and the paid transfer that a person closes.

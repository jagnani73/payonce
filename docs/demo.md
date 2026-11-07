# Demo run-through

Four incidents on the web page, in about four and a half minutes. Each one shows a different decision. The times in the table come from a dry run against the sandbox on 6 October 2026, where the four incidents took about 42 seconds of sandbox time in total. That run used the keyword reader. With a model reading the emails, each read took 2 to 5 seconds in checks the same day, and one took 12. The run makes five reads.

## Before recording

```bash
pnpm reset
pnpm ui
```

`pnpm reset` moves the current ledger aside, so the page opens with no incidents. Stop `pnpm ui` first if it is running, because the reset cannot move a ledger that is open. Skipping it on a ledger from before PayOnce kept which account each payment went to can hold the first payment to a supplier paid back then for two approvers.

Open `http://127.0.0.1:4310`. Use a window at least 1500 pixels wide at 125% zoom. Below that the payment page's side rail moves under its main column.

Set `WEBHOOKS=off` in `.env`. The sandbox records webhook events but never delivers them. With webhooks on, `pnpm ui` opens a cloudflared tunnel it does not need, and the status check that finds every bank change runs every 15 seconds instead of every 3, so each bank step takes longer.

Set `READER_API_KEY` in `.env` so a model reads the emails. After `pnpm ui` starts, the console names the models it will ask. The free tier allows about five requests a minute on the first model, and the second takes over if the first is rate limited. AI Studio shows the daily limits.

Set `APPROVERS` in `.env`, for example `APPROVERS=Yash:50000,Alex:10000,Kim:10000,Sam:4200`, and restart `pnpm ui` after changing it. The name in the simulator's Started by field cannot approve that payment, so approve under another name. Each approval in the run below needs one approver. These need two:

- `eur-from-usd`, until a payment a person approved has paid the EUR supplier: a held invoice to a supplier PayOnce has never paid on a person's approval takes two approvers. A payment PayOnce sent by itself, such as an automatic replacement, does not count.
- The sample pay run, while any row pays a supplier PayOnce has never paid on a person's approval. On a fresh ledger every row does.
- `usd-local-bank-change`, because it pays an account the original did not go to. Whoever records the callback cannot approve it either.

With the list above, each of these still has two approvers left after the starter is barred. Sam's 4,200 limit is below the 4,476 USD that `eur-from-usd` takes from the USD wallet, so Sam is refused there.

The run sends six sandbox transfers. Airwallex emails the account owner for each one unless transfer notifications are off under Settings > User settings > Notifications.

## The run

| Time | Do | Sandbox time | Point at |
| --- | --- | --- | --- |
| 0:00 | Show the page. It opens on Home, with the checklist an empty ledger shows | | The problem: a supplier says a payment never arrived. Waiting too long stops shipments, and replacing too early pays twice |
| 0:25 | Open the Sandbox simulator from the top bar. Under Run a scripted incident, keep USD, local transfer, Channel timeout and Nothing arrived, type your name in Started by, and press Start scripted incident. That name cannot approve this payment | 13 s | "Wait" while the transfer is in flight. The bank fails it. "Replace". The replacement is paid and the incident closes. The last line is the ledger refusing a second payment |
| 1:10 | In the simulator, change Supplier emails to play to "New account" and start | 8 s | The same bank failure as before. The second email comes from `example-supp1ier.test`, with a digit one in place of the letter l. The warning, then "Escalate". The Decision panel pays the account on file, ending 6789, and not the account in the email |
| 1:50 | In the Decision panel, approve as another name | 8 s | "Approval by NAME matches the current terms". One replacement goes to the account on file and the incident closes |
| 2:30 | Scenario "EUR, SWIFT, low cash reserve", emails "Nothing arrived", start | 7 s | The cost line: a replacement pays the SWIFT fee a second time, and that fee is what takes cash below the reserve floor. "Escalate". Leave this one waiting |
| 3:20 | Scenario "USD, local transfer", bank outcome "Paid", start | 7 s | The bank says paid and the supplier says nothing arrived. "Escalate". There is no request to approve, because there is nothing to pay |
| 3:50 | In the Decision panel, close it as paid with a name and what the supplier confirmed | | The incident closes on one payment. The name and the note are on the timeline |
| 4:10 | Click Incidents in the top bar | | Needs you shows the one payment still waiting, and Closed the other three. Then the wrap-up below |

## What to say in the wrap-up

- The rules are a pure function in `src/domain/decide.ts`. The reader answers three yes-or-no questions, and PayOnce writes the summary from the answers. It returns no amounts and no bank details, so it cannot change what is paid or to whom.
- The duplicate lock is a unique index in SQLite. The database refuses a second live payment for an invoice, whatever the code above it does.
- An approval covers the exact terms on the card and one payment. If the account on file, the amount or the evidence changes, the approval is void.
- Gemini 3.5 Flash on the free tier reads the emails. It answers three yes-or-no questions and PayOnce writes the summary, so no wording from an email reaches the approve option. Before recording, check the findings say "Reader: gemini-3.5-flash" or "Reader: gemini-3.1-flash-lite" and not the keyword placeholder.
- Everything runs against the Airwallex sandbox. The simulator stands in for the bank.

## If something goes wrong

- The sandbox simulator sometimes answers with a server error. PayOnce reads the transfer again and retries, so a step can take a few seconds longer. Keep talking.
- If an incident stops part-way, Check now on its page picks it up. It cannot send a second live payment.
- If the timeline says the emails could not be read, every model failed and the incident went to a person, which is the safe outcome. Wait a minute and run that incident again.
- For another take, stop `pnpm ui`, run `pnpm reset` and start again.

## Cut for time

Drop the EUR incident first. The other three cover replace, the look-alike email with an approval, and the paid transfer that a person closes.

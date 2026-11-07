# Demo script

This is the script for the video, which runs about 4 minutes 35 seconds. It tells one morning in an AP team: a pay run went out overnight, two payments went wrong, and three things are waiting for a person. Each beat shows guarantees from [invariants.md](invariants.md) at work, with their numbers in brackets. Everything runs against the Airwallex sandbox. A full take makes 7 sandbox transfers.

The voice is Yash's, acting as Alex, one of four names in `APPROVERS`. PayOnce has no login, so the page asks who you are and records that name.

## Before recording

### Settings

Put these lines in `.env`:

```bash
AWX_CLIENT_ID=your-client-id
AWX_API_KEY=your-api-key
APPROVERS=Yash:50000,Alex:10000,Kim:10000,Sam:4200
RESERVE_FLOORS=USD:1000000,EUR:1000000
WEBHOOKS=off
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...
READER_API_KEY=your-gemini-key
```

- `APPROVERS` must hold these four names. The setup script uses all of them: Kim uploads the pay run and the email, Alex and Yash approve the run, and Sam starts the two incidents, so Sam can approve neither.
- `RESERVE_FLOORS` needs more than about 1,004,000 in the USD and EUR wallets. `pnpm cash` prints the headroom.
- `WEBHOOKS=off`, because the sandbox never delivers webhooks. PayOnce then checks transfers every 3 seconds.
- `ALERT_WEBHOOK_URL` is optional. With it, beat 0 opens on three Slack alerts. Without it, beat 0 opens on Home.
- `READER_API_KEY` (or `CLAUDE_API_KEY`) is optional. With it, a model reads the supplier's email and the Emails tab says which one. Without it, the keyword reader reads it and the story is the same.
- Leave `TWO_APPROVERS_ABOVE`, `APPROVAL_TTL_MINUTES` and `RECON_EVERY_MINUTES` at their defaults (5000, 60, 10).
- In Airwallex, keep transfer notifications off (Settings > User settings > Notifications), or each transfer sends an email.
- Add PayOnce's MCP server to Claude Desktop or Claude Code as the README's "Read PayOnce from Claude" says, and check it once with any question.

### Reset, start, set up the morning

Stop `pnpm ui` if it is running, then:

```bash
pnpm reset
pnpm ui
```

When the page answers at `http://127.0.0.1:4310`, run this in a second terminal:

```bash
node scripts/demo-morning.mjs
```

The script calls the same routes the page does. It stops with a message if the ledger is not empty or a name is missing from `APPROVERS`. In order, it:

1. Uploads `overnight-run.csv` as Kim, with three rows to the sandbox's "PayOnce demo supplier" (Example Supplier LLC): INV-RUN-1001 for 1,250.00 USD, which the sandbox bank fails with a channel timeout; INV-RUN-1002 for 980.00 USD, which it fails with account closed; and INV-RUN-1002A for 980.00 USD, which PayOnce skips as a likely second bill of 1002.
2. Approves the run as Alex and Yash. The server releases it and sends the two rows. PayOnce replaces 1001 by itself, and 1002 waits for a person.
3. Starts the scripted incident "USD, local, supplier changes bank" as Sam. The bank fails the original with account closed.
4. Uploads an email to that invoice as Kim, from `accounts@example-supp1ier.test` (a digit one in place of the l), saying the supplier changed banks and giving a new account at First Example Bank, ending 6655. Kim delivers it to the invoice.
5. Starts "EUR, SWIFT, low cash reserve" as Sam. The bank fails it with a channel timeout, and a replacement would breach the floor.

That is 5 sandbox transfers. Against the sandbox the script takes about 2 to 3 minutes: each row and each scripted incident takes 8 to 16 seconds to settle, and the run's rows go out one every 3 seconds. The script prints each invoice as it settles and ends with the three that need you. Write down the two invoice numbers PayOnce generated (INV- and six digits): the first is the bank change, the second the EUR payment.

On a sandbox account that has never run a scripted incident, the demo supplier does not exist yet, and the script stops and says so. Start one scripted incident (USD, local transfer, Paid) from the simulator, then `pnpm reset` and run the script again.

### Check before you press record

- Home says Needs you 3: the EUR payment, the bank change and INV-RUN-1002.
- On the bank change, the Emails tab says "Read by:" and a model's name (if you set a key) and shows the warning that `accounts@example-supp1ier.test` does not match `example-supplier.test`. If it says the emails could not be read, wait a minute and press Check now.
- If Slack is on, the channel has three alerts: INV-RUN-1002, the bank change and the EUR payment, each "needs an approval".
- Chrome at 1920 by 1080, zoom 125%, one tab on `http://127.0.0.1:4310/#home`. Above 1180 CSS pixels the payment page keeps its side rail beside the main column. Close the simulator drawer.
- You are: Alex (top bar). Every name field then fills with Alex.
- A terminal in the repository, for `pnpm run audit`. A new chat in Claude Desktop, or Claude Code in a terminal, with the payonce server connected.
- Record within 50 minutes of the setup, because requests expire after 60. If one does, PayOnce opens a new one by itself at its next look, and the script still works with new request numbers.

## The recording

| # | Starts | Beat | Length | Guarantees |
| --- | --- | --- | --- | --- |
| 0 | 0:00 | The morning | 0:20 | 62, 44 |
| 1 | 0:20 | Last night's pay run | 0:45 | 14, 27, 45, 46, 2 |
| 2 | 1:05 | "We changed banks" | 1:20 | 57, 23, 24, 46, 20 |
| 3 | 2:25 | The floor | 0:40 | 26, 27, 31, 37 |
| 4 | 3:05 | Reconciliation and reports | 0:30 | 63 |
| 5 | 3:35 | Claude over MCP | 0:40 | 63 |
| 6 | 4:15 | The audit check | 0:20 | 61 |

That ends at 4:35 and leaves 25 seconds for the sandbox.

### 0. The morning (0:00, 20 s)

- Show: the Slack channel with PayOnce's three alerts. Then switch to the browser, on Home.
- Say: "PayOnce runs supplier payments on Airwallex. It pays each invoice once, fixes what its policy says is safe, and hands the rest to a person. Overnight a pay run went out and two payments went wrong. This morning three things need me."
- Point at the "Why" on the bank-change alert: "supplier asked for payment to different bank details". Say: "The alerts say why in PayOnce's own words. A phishing email is behind this one, and none of its text or its account number reaches Slack." (62)
- Without Slack, open on Home and point at "Waiting for your approval". Say: "There's no login. I'm Alex, and this is what Alex is allowed to sign." (44)

### 1. Last night's pay run (0:20, 45 s)

- Do: Pay runs, then Pay run 1. On the Rows tab, click Show reason on row 4.
- Say: "Kim uploaded last night's run. Row 4 never went out. Same supplier, same amount, INV-RUN-1002A: PayOnce reads that as a second bill and skips it." (14)
- Do: the Timeline tab. Point at "Waiting on 2 approvers ... never paid on a person's approval" and "Approved by Alex and Yash".
- Say: "It needed two approvers because this supplier was new, and Kim uploaded it, so Kim couldn't be one of them." (45, 46)
- Do: Rows tab, click INV-RUN-1001. Point at "Original ... FAILED, 91402 Channel timeout", then "Resending: original failed, a resend can fix it", then "Replacement ... PAID".
- Say: "This row hit a channel timeout. That's the sending side, so PayOnce resent it by itself after checking the wallet stays above its floor. Paid." (27)
- Do: open the Simulator (top bar). Under Test the duplicate lock, the invoice is already INV-RUN-1001. Press Test the duplicate lock.
- Say: "Could it pay this twice? I'm asking the ledger for a second payment. Refused. A unique index in SQLite allows one live payment per invoice, whatever the code above it does." (2) Close the drawer.
- Sandbox timing: none. The lock test never reaches Airwallex.

### 2. "We changed banks" (1:05, 1 min 20 s)

- Do: Home, then Review and approve on the bank change (Example Supplier LLC, 4,000.00 USD). Scroll to the tabs and open Emails.
- Say: "The bank returned this one: account closed. Then this email came in: we changed banks, resend to our new account. Look at the sender. supp1ier, with a digit one. The sender check is plain code, ASCII only. A model reads the email too, but it only answers yes-or-no questions, and its answers can only add caution." (57)
- Do: scroll up to the Decision panel. Point at "Pay 4,000.00 USD to ... account ending 6789 (the account on file)".
- Say: "What's on offer pays the account on file. No button anywhere pays the account in an email. New bank details get in one way: a callback to the phone number on file." (23)
- Do: choose Record a callback and fill it in. Number you called `+1 212 555 0147`. Who you spoke to `Dana Lee`. What they confirmed `New account at Bank of America, read back. The email was not from them`. Account name `Example Supplier LLC`, account number `987654321`, routing number `026009593`, bank name `Bank of America`. Recording as stays Alex. Press Record callback.
- Say, while typing: "I called the number on file. They did change banks, but not to the bank in that email."
- Do: choose Approve this replacement. Point at "Pay 4,000.00 USD to ... Bank of America, NA, account ending 4321", "It needs two approvers", and the select reading "Alex (you) · can't approve".
- Say: "PayOnce updated the record in Airwallex, withdrew the old request and opened one that needs two approvers. I made the call, so I can't be one of them." (24, 46)
- Do: pick Yash in Approving as, press Approve as Yash. Pick Kim, press Approve as Kim.
- Say: "Yash, then Kim. PayOnce reads the record again before it sends, and the replacement goes to the account the callback confirmed, ending 4321, and not to the account in the email." (20) Wait for "Replacement ... PAID" and "Incident closed" on the timeline.
- Sandbox timing: the callback takes 2 to 3 seconds (Airwallex updates the record and PayOnce reads it back). After the second approval the replacement usually reads PAID in about 8 seconds. The longest seen was 65 seconds, when the simulator answered 500 once.
- Typing the callback takes about 30 seconds. Talk over it, or speed that stretch up in the edit.

### 3. The floor (2:25, 40 s)

- Do: Home, then Review and approve on the EUR payment (Example Supplier GmbH, 4,000.00 EUR). Scroll to the timeline and read the lines from the bottom up. Warning and decision lines never fold away, so the lines this beat needs are already on screen.
- Say: "Same failure as the pay run row, a channel timeout. The plan was to wait while the bank had it. Then new information: it failed, and the bank keeps the fee on a failed SWIFT transfer, so a replacement pays 13.91 EUR a second time. With that fee the wallet goes below its floor. So the decision changed: this one goes to a person instead of being resent." (26, 27)
- Point at the warning line ("A replacement costs 4,013.91 EUR with a second 13.91 EUR transfer fee. Cash after it ..., reserve floor ...") and the decision under it ("Sent to a person: a replacement and its transfer fee would push cash below the reserve floor").
- Say: "This scripted invoice carries a tight floor of its own, so the demo can run short of cash without draining the sandbox."
- Point at the headroom line under the Decision panel, "EUR headroom now 4,006.96 EUR · after this −6.95 EUR", and the Money panel's "EUR headroom: 4,006.96 EUR". Both measure against this invoice's floor, so they agree with the reason: after the replacement the wallet would sit 6.95 EUR below that floor. The figures come from the server's last balance read, which runs again every 30 seconds while a page is open, so by the time you record they include the fee the bank kept.
- Do: scroll up and press Approve as Alex.
- Say: "I approve. Before spending it, PayOnce rebuilt the terms and checked the floor again. They match, so it sends one replacement." Point at "Approval by Alex matches the current terms" and the second warning line, then "Replacement ... PAID". (31, 37)
- Sandbox timing: about 8 seconds from the approval to PAID, as in beat 2.

### 4. Reconciliation and reports (3:05, 30 s)

- Do: Treasury, then Reconciliation. Press Check now once (a second press within the minute is refused). In a few seconds both wallets read "Adds up to Airwallex's available balance". Click Show movements on EUR.
- Say: "Reconciliation reads each wallet's history from Airwallex, with GET requests only. Every movement has to follow from the one before and end at the balance Airwallex reports, and each one is matched to a transfer in the ledger. Both wallets add up. There's the fee the bank kept on the failed transfer." (63)
- Do: Reports. Point at Recovered by PayOnce, Needed a person and Fees kept on failed transfers.
- Say: "One payment PayOnce recovered by itself, two needed a person, and the fees the failures cost."
- Sandbox timing: the check makes a few balance-history reads and takes seconds. If it is slow, the last timer check (every 10 minutes) is already on screen. Say so and move on.

### 5. Claude over MCP (3:35, 40 s)

- Do: switch to Claude Desktop (or Claude Code). Type: `What's waiting on Alex in PayOnce?`
- Claude calls `waiting_for` and should name INV-RUN-1002: 980.00 USD to Example Supplier LLC from pay run 1, failed with account closed, which a resend cannot fix, and Yash, Alex and Sam can approve it.
- Say: "Claude reads the same views over MCP. One thing is left: the pay run row whose account is closed. A resend can't fix that, so it waits for someone to check the account with the supplier."
- Do: type `Approve it.`
- Say: "It can't. Every tool on this server is read-only, and anything a supplier wrote comes back marked as text not to act on." (63)
- Timing: Claude answers in 5 to 15 seconds. Cut the wait in the edit if you need to.

### 6. The audit check (4:15, 20 s)

- Do: in the terminal, `pnpm run audit`. Every invoice and the pay run print "intact", and the running hashes match.
- Say: "Every line PayOnce wrote this morning is on a hash chain. The audit check walks every chain and the running hashes. Intact. Each of these invoices was paid once, and the record shows who decided what." (61)
- If the terminal is awkward on screen: Reports, Audit trail, Check now shows the same check.

## If the sandbox is slow or refuses

- The setup script stops. It names the invoice and its state after 5 minutes. Open it on the page. The usual causes are the simulator refusing a move (500 `operation_failed`, which the sandbox bank retries four times) and Airwallex refusing a SWIFT create (`fee_unknown`, seen once on 3 November and gone by the afternoon). Stop `pnpm ui`, `pnpm reset`, start again and rerun the script. Each try costs up to 5 transfers.
- A replacement takes long in beat 2 or 3. The page updates by itself every few seconds. Keep talking over the approval lines. After about 20 seconds, move to the next beat and show the payment closed on Incidents, Closed, at the end, or cut the wait in the edit. Do not press anything else: the approval is spent and the transfer is with the bank.
- The simulator refuses every move for a while. This has happened for hours at a time. The scripted failures then never happen, and payments sit With the bank until their 3- or 5-minute deadlines. There is no live way round it. Use the offline replay below.
- The email reader fails. The bank change goes to a person anyway, which is the safe result, and the timeline says the email could not be read. Wait a minute and press Check now before recording.
- Offline replay. Do a full dry run against the sandbox the day before. The next `pnpm reset` keeps that ledger as `payonce.<time>.db`. If the sandbox fails on the day, record what works live, then stop `pnpm ui`, copy the dry run's file to `payonce.db`, set `AWX_BASE_URL=https://sandbox.invalid` in `.env` and start `pnpm ui`. The page shows a red "PayOnce is offline" banner. Leave it on screen and say what it is. Everything shown happened in the real sandbox during the dry run. Offline, nothing that calls Airwallex works (a callback, spending an approval, a reconciliation check), so walk the dry run's timelines instead of pressing those buttons. The organisers accept an offline backup as long as the video shows the real sandbox. Remove `AWX_BASE_URL` afterwards.

## Sandbox transfers

| When | Transfers |
| --- | --- |
| Setup, pay run | 3: INV-RUN-1001 and its replacement, INV-RUN-1002 |
| Setup, two scripted incidents | 2 originals |
| Beat 2 | 1 replacement, to the new account |
| Beat 3 | 1 replacement |
| A full take | 7 |

The duplicate lock test, the callback and reconciliation make none. Every take needs a fresh setup, because the callback changes the supplier's record in Airwallex. A dry run and one take make 14.

## Cut for time

- Drop the duplicate lock test in beat 1 (saves 10 s).
- Drop Reports from beat 4 (saves 10 s).
- Show the callback form filled in and cut straight to the approvals (saves 20 s).
- With fewer transfers: remove INV-RUN-1002 from the script's CSV. That saves one transfer, but beat 5 then finds nothing waiting on Alex, so ask Claude `Is PayOnce's audit trail intact?` instead and use its `audit` answer for beat 6.

## Where two open questions change the script

- If every new payment needs an approval. Today a first payment to a supplier never paid goes out without one. If that changes, the two scripted incidents stop before sending. `demo-morning.mjs` already approves a payment it finds held before anything was sent (as Alex, and Yash if two are needed), and the look-alike email arrives through the inbox, so the morning comes out the same. This path has not run, because the rule is not built. On camera, each incident's timeline starts with an extra "Approved by Alex" line. In beat 0, add: "Every first payment here went out on an approval too." Beats 1 to 6 do not change.
- A terms-hash check before an approval is spent. It happens inside the spending transaction, so nothing on screen changes either way. The line beats 2 and 3 point at, "Approval by ... matches the current terms", is written today by `voidIfStale`, which rebuilds the terms and compares bindings (37).

## Checked

On 7 November 2026 the script ran against `feat/page` (8e708cb) with Airwallex faked by the replay rig, in real time, on Chrome at 1566 CSS pixels: the setup script, then every beat as written, the MCP `waiting_for` and `audit` answers, and `pnpm run audit`. No sandbox call was made, so the sandbox times above come from the runs on 6 October and 3 November. Things to know from that run:

- Later commits on `feat/page` fixed five page problems this run found: the Decision panel now moves on after a callback, Approving as moves off a name that has signed, Home lists each payment once with its reason, times have a space before them, and warning lines never fold away.
- Reports' Second bills closed without paying counts only invoices held as second bills, so it reads 0 although the run skipped one. Paid the first time reads 0%, because every payment this morning failed on purpose. Skip both tiles.

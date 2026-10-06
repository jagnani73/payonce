# PayOnce

A payment incident agent that recovers failed supplier transfers without paying twice.

PayOnce is my entry for the Airwallex Agentic Banking Hackathon 2026. It starts from starter kit 3, Payment Ops Incident Commander.

> Status: working demo against the Airwallex sandbox. A keyword placeholder reads supplier emails until a model is connected. Sandbox only, no real money.

## The problem

A supplier says a payment never arrived and their deadline has passed. The transfer shows as sent but not settled. Finance can wait, send a replacement, or escalate, and each choice can go wrong: wait too long and the supplier stops shipping, replace too early and you have paid twice. This is also when fraudsters send the "please resend to our new account" email.

## What it does

PayOnce follows one supplier payment through an incident. It sends the transfer, reads the supplier's emails, watches the bank outcome, and then waits, replaces the payment, closes the incident, or hands the decision to a person. A web page shows each incident as a timeline, with the emails, the payments and whatever a person is asked to approve or close.

## What the agent decides

| Situation | Action |
| --- | --- |
| The supplier asks for payment to different bank details | Escalate to a person |
| The supplier's bank details on file changed after the original payment | Escalate to a person |
| An email came from an address that does not match the supplier on file | Escalate to a person |
| Supplier emails are on file that could not be read | Escalate to a person |
| The original is in a status the policy does not recognise | Escalate to a person |
| The original settled but the supplier reports non-receipt | Escalate to a person |
| The original settled and no supplier email reports it missing | Close |
| The original transfer is still in flight | Wait |
| The original failed for a reason a resend cannot fix | Escalate to a person |
| The cash position could not be read | Escalate to a person |
| The original failed and a replacement with its transfer fee would push cash below the reserve floor | Escalate to a person |
| The original failed, a resend can fix it and the beneficiary details are unchanged | Replace |

`src/decide.ts` checks the rules in that order. A resend can fix a failure only when it happened on the sending side: a system error or a channel timeout. Any other failure, including a return from the beneficiary's bank, goes to a person.

Two of these checks do not depend on how the email text is read. The sender's domain is compared with the one on file. The supplier's bank details are read from Airwallex again and compared with the account the original payment went to.

The model will read supplier emails and explain each decision. It will not hold credentials or move money directly. Until a model is connected, a keyword placeholder in `src/keyword-reader.ts` reads the emails. A reader returns two findings and a summary, with no amounts or bank details, so it cannot change what is paid or to whom.

## The duplicate lock

PayOnce writes every payment attempt to a SQLite ledger (`payonce.db`) before it creates the transfer. A unique index allows one attempt per invoice that has not failed, so the database refuses a second live payment. PayOnce can open a replacement only after the ledger records the original as failed.

Each attempt keeps its `request_id`. A retry reuses it, and Airwallex then returns the transfer it already has. An incident closes only when one attempt is paid and every other attempt has failed.

## Approvals

When the original has failed and the policy escalates, PayOnce records an approval request with the exact terms: the amount, the currency, the account the supplier's record points to now, and the evidence behind the escalation. A person approves it on the web page or with `pnpm approve`, and the approval names the request they were shown.

Before paying, PayOnce rebuilds the terms from current data and compares them with what was approved. If they match, it sends the replacement. If anything changed, the approval is void and PayOnce opens a new request. An approval is spent on one attempt, and it cannot override the duplicate lock. Once an invoice has gone to a person, only an approval releases a payment, even if the policy would now replace it unprompted.

## Closing a paid incident

A paid original holds the duplicate lock, so PayOnce cannot send anything more for that invoice. If no supplier email reports the payment missing, the incident closes. If one does, or anything else on file sends it to a person, the incident stays open until a person closes it.

The page shows the paid transfer and the reason, and takes a name and a note of what the person confirmed. `pnpm close` does the same in the terminal. Both the name and the note go on the timeline. Closing moves no money, so it is not bound to terms the way an approval is. "Check again" never closes an incident that is waiting on a person.

## The cost of a second transfer

A failed SWIFT transfer gets its amount back but not its fee, so a replacement pays the fee again. PayOnce adds that fee to the cost of a replacement before it checks the cash reserve. In the `eur-swift-low-reserve` scenario the reserve floor is set so that the second fee is what breaches it, and the incident goes to a person.

## Run it

```bash
pnpm install
pnpm dev
```

`pnpm dev` needs no credentials. It reads the sample supplier emails in `fixtures/emails/` and prints the findings and the decision for four incidents.

Everything else talks to the Airwallex sandbox. Copy `.env.example` to `.env` and fill in a sandbox Client ID and API key.

### The web page

```bash
pnpm ui
```

Open `http://127.0.0.1:4310`. Choose a payment, a bank outcome and a supplier email thread, then start an incident. The page follows it step by step, which takes 10 to 20 seconds in the sandbox. When an incident is waiting on a person, the approval card shows the terms and takes a name. If the bank has paid the original, a close card takes a name and a note instead. "Check again" continues an incident that stopped part-way.

The server has no login. It listens on this machine only and accepts changes only from its own page.

### The terminal

```bash
pnpm recover [OUTCOME] [INVOICE] [EMAILS] [SCENARIO]
pnpm approve <INVOICE> [NAME]
pnpm close <INVOICE> [NAME] [NOTE]
```

| Argument | Values | Default |
| --- | --- | --- |
| `OUTCOME` | A simulated bank outcome. Either `PAID` or a failure type, such as `CHANNEL_TIMEOUT`, `SYSTEM_ERROR`, `BENEFICIARY_BANK_RETURNED` or `ACCOUNT_CLOSED` | `CHANNEL_TIMEOUT` |
| `INVOICE` | Any invoice number. A new one starts an incident and an existing one continues it | A random number |
| `EMAILS` | `nothing-arrived` or `new-account` | `nothing-arrived` |
| `SCENARIO` | `usd-local`, `eur-swift` or `eur-swift-low-reserve` | `usd-local` |

Four runs to try:

```bash
pnpm recover
pnpm recover ACCOUNT_CLOSED
pnpm recover CHANNEL_TIMEOUT INV-5001 new-account
pnpm approve INV-5001
pnpm approve INV-5001 Yash
pnpm recover - INV-5001
pnpm recover PAID INV-5002
pnpm close INV-5002
pnpm close INV-5002 Yash supplier found the payment
```

The first replaces the payment and shows the lock refusing a second one. The second ends in an escalation. In the third, the supplier asks for payment to a new account from a look-alike address, so it escalates although a channel timeout on its own would be replaced. `pnpm approve` with no name shows the terms and with a name approves them. `pnpm recover - INV-5001` then sends the replacement to the account on file. The outcome is ignored for an invoice that already exists, so `-` works as a placeholder.

In the fourth, the bank pays the original while the supplier says it never arrived, so the incident goes to a person. `pnpm close` with no name shows what is waiting, and with a name and a note it closes the incident.

## Layout

| File | Contents |
| --- | --- |
| `src/decide.ts` | The decision policy, a pure function |
| `src/incident.ts` | Types for an incident and a decision |
| `src/engine.ts` | The incident flow: pay, read emails, assess, replace or escalate, and the timeline |
| `src/assess.ts` | Maps an Airwallex transfer to the facts the policy reads |
| `src/ledger.ts` | Obligations, payment attempts, approvals, emails and the timeline in SQLite |
| `src/payments.ts` | Sends an attempt under its `request_id` and syncs transfer state into the ledger |
| `src/approval.ts` | Approval terms and the hash that binds an approval to them |
| `src/emails.ts` | The email reader interface, the findings a reader returns, and the sender check |
| `src/keyword-reader.ts` | Keyword placeholder that stands in for the model |
| `src/server.ts` | Local web server and JSON API |
| `src/recover.ts`, `src/approve.ts`, `src/close.ts`, `src/index.ts` | The commands |
| `src/airwallex/` | Sandbox client: login, beneficiaries, transfers, balances and the simulation calls |
| `web/` | The page: plain HTML, CSS and JavaScript with no build step |
| `fixtures/emails/` | Sample supplier emails |

The code holds amounts in minor units and converts at the Airwallex boundary. The ledger is `payonce.db` in the working directory. Delete it to start with an empty ledger.

## Not built yet

- A model as the email reader.
- Approving payment to new bank details. An approval covers a replacement to the account on file.
- Closing an incident without a payment. A person can close one only when the bank reports the original as paid.
- Payout webhooks. Airwallex needs a public URL to deliver them, so a local run polls for status.
- Real bank outcomes. The run uses the sandbox simulator to send, fail and pay transfers.

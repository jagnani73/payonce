# PayOnce

A payment incident agent that recovers failed supplier transfers without paying twice.

PayOnce is my entry for the Airwallex Agentic Banking Hackathon 2026. It starts from starter kit 3, Payment Ops Incident Commander.

> Status: early build. PayOnce runs a full incident against the Airwallex sandbox: it sends a transfer, fails it, decides, and sends one replacement under a duplicate lock. A person can approve a replacement the policy will not send on its own. Email reading is not built yet.

## The problem

A supplier says a payment never arrived and their deadline has passed. The transfer shows as sent but not settled. Finance can wait, send a replacement, or escalate, and each choice can go wrong: wait too long and the supplier stops shipping, replace too early and you have paid twice. This is also when fraudsters send the "please resend to our new account" email.

## What the agent decides

| Situation | Action |
| --- | --- |
| The supplier asks for payment to different bank details | Escalate to a person |
| The evidence conflicts | Escalate to a person |
| The original is in a status the policy does not recognise | Escalate to a person |
| The original settled but the supplier reports non-receipt | Escalate to a person |
| The original transfer is still in flight | Wait |
| The original failed for a reason a resend cannot fix | Escalate to a person |
| The original failed and a replacement would push cash below the reserve floor | Escalate to a person |
| The original failed, a resend can fix it and the beneficiary details are unchanged | Replace |

`src/decide.ts` checks the rules in that order. A resend can fix a failure only when it happened on the sending side: a system error or a channel timeout. Any other failure, including a return from the beneficiary's bank, goes to a person.

The model will read supplier emails and explain each decision. It will not hold credentials or move money directly. Until a model is connected, a keyword placeholder in `src/keyword-reader.ts` reads the sample emails. A reader returns two findings and a summary, with no amounts or bank details, so it cannot change what is paid or to whom.

## The duplicate lock

PayOnce writes every payment attempt to a SQLite ledger (`payonce.db`) before it creates the transfer. A unique index allows one attempt per invoice that has not failed, so the database refuses a second live payment. PayOnce can open a replacement only after the ledger records the original as failed.

Each attempt keeps its `request_id`. A retry reuses it, and Airwallex then returns the transfer it already has. An incident closes only when one attempt is paid and every other attempt has failed.

## Approvals

When the original has failed and the policy escalates, PayOnce records an approval request with the exact terms: the amount, the currency, the beneficiary and the evidence behind the escalation. `pnpm approve <INVOICE> <NAME>` shows those terms and records the approval.

The next `pnpm recover` run for that invoice rebuilds the terms from current data and compares them with what was approved. If they match, it sends the replacement. If anything changed, the approval is void and PayOnce opens a new request. An approval is spent on one attempt, and it cannot override the duplicate lock.

## Run it

```bash
pnpm install
pnpm dev
```

`pnpm dev` needs no credentials. It reads the sample supplier emails in `fixtures/emails/` and prints the findings and the decision for three incidents.

To run a full incident against the sandbox, copy `.env.example` to `.env`, fill in a sandbox Client ID and API key, then:

```bash
pnpm recover
pnpm recover ACCOUNT_CLOSED
pnpm recover CHANNEL_TIMEOUT INV-2001
```

`pnpm recover` sends a transfer, marks it sent, fails it with a channel timeout and sends one replacement. It then tries to pay the same invoice again and prints the ledger's refusal. Passing another failure type, such as `ACCOUNT_CLOSED`, ends in an escalation and no second payment.

The second argument names the invoice. Running the same invoice again reports its state and sends nothing. The client refuses any host that is not the Airwallex sandbox.

To approve an escalated replacement:

```bash
pnpm recover BENEFICIARY_BANK_RETURNED INV-3001
pnpm approve INV-3001 Yash
pnpm recover - INV-3001
```

The first command ends in an escalation. The second shows the terms and records the approval. The third sends the replacement. The failure type is ignored for an invoice that already exists, so `-` works as a placeholder.

## Layout

| File | Contents |
| --- | --- |
| `src/incident.ts` | Types for an incident and a decision |
| `src/decide.ts` | The decision policy, a pure function |
| `src/assess.ts` | Maps an Airwallex transfer to the facts the policy reads |
| `src/ledger.ts` | Obligations and payment attempts in SQLite, with the duplicate lock |
| `src/payments.ts` | Sends an attempt under its `request_id` and syncs transfer state into the ledger |
| `src/approval.ts` | Approval terms and the hash that binds an approval to them |
| `src/approve.ts` | Records a person's approval for an escalated invoice |
| `src/recover.ts` | One incident run against the sandbox |
| `src/index.ts` | Three sample incidents run through the policy |
| `src/emails.ts` | The email reader interface and the findings a reader returns |
| `src/keyword-reader.ts` | Keyword placeholder that stands in for the model |
| `fixtures/emails/` | Sample supplier emails |
| `src/airwallex/` | Sandbox client: login, beneficiaries, transfers, balances and the simulation calls |

The code holds amounts in minor units and converts at the Airwallex boundary.

## Not built yet

- A model as the email reader. The sandbox run does not read emails yet.
- Approving payment to new bank details. An approval covers a replacement to the same beneficiary.
- Payout webhooks. The run polls for status.

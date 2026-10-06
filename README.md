# PayOnce

A payment incident agent that recovers failed supplier transfers without paying twice.

PayOnce is my entry for the Airwallex Agentic Banking Hackathon 2026. It starts from starter kit 3, Payment Ops Incident Commander.

> Status: early build. The decision policy runs a full incident against the Airwallex sandbox: send a transfer, fail it, decide, and send one replacement. The ledger, approvals and email reading are not built yet.

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

The model will read supplier emails and explain each decision. It will not hold credentials or move money directly.

## Run it

```bash
pnpm install
pnpm dev
```

`pnpm dev` needs no credentials. It prints the decision for three sample incidents.

To run a full incident against the sandbox, copy `.env.example` to `.env`, fill in a sandbox Client ID and API key, then:

```bash
pnpm recover
pnpm recover ACCOUNT_CLOSED
```

`pnpm recover` sends a transfer, marks it sent, fails it with a channel timeout and sends one replacement. Passing another failure type, such as `ACCOUNT_CLOSED`, ends in an escalation and no second payment. The client refuses any host that is not the Airwallex sandbox.

## Layout

| File | Contents |
| --- | --- |
| `src/incident.ts` | Types for an incident and a decision |
| `src/decide.ts` | The decision policy, a pure function |
| `src/assess.ts` | Maps an Airwallex transfer to the facts the policy reads |
| `src/recover.ts` | One incident run against the sandbox |
| `src/index.ts` | Three sample incidents run through the policy |
| `src/airwallex/` | Sandbox client: login, beneficiaries, transfers, balances and the simulation calls |

The code holds amounts in minor units and converts at the Airwallex boundary.

## Not built yet

- An obligation ledger with a lock, so one invoice can have only one live payment.
- Reusing a `request_id` on a retry. A replacement already gets a new one.
- Approvals bound to the amount, currency, beneficiary and evidence shown.
- Closing an incident only after both the original and the replacement are reconciled.
- The model reading supplier emails.
- Payout webhooks. The run polls for status.

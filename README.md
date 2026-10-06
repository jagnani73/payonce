# PayOnce

A payment incident agent that recovers failed supplier transfers without paying twice.

PayOnce is my entry for the Airwallex Agentic Banking Hackathon 2026. It starts from starter kit 3, Payment Ops Incident Commander.

> Status: idea phase. This repository holds the decision policy and three sample incidents. Nothing here calls Airwallex yet.

## The problem

A supplier says a payment never arrived and their deadline has passed. The transfer shows as sent but not settled. Finance can wait, send a replacement, or escalate, and each choice can go wrong: wait too long and the supplier stops shipping, replace too early and you have paid twice. This is also when fraudsters send the "please resend to our new account" email.

## What the agent decides

| Situation | Action |
| --- | --- |
| The supplier asks for payment to different bank details | Escalate to a person |
| The evidence conflicts, or the original settled but the supplier reports non-receipt | Escalate to a person |
| The original transfer is still in flight | Wait |
| The original failed for a reason a resend cannot fix | Escalate to a person |
| The original failed and a replacement would push cash below the reserve floor | Escalate to a person |
| The original failed, a resend can fix it and the beneficiary details are unchanged | Replace |

`src/decide.ts` checks the rules in that order. The model will read supplier emails and explain each decision. It will not hold credentials or move money directly.

## Run it

```bash
pnpm install
pnpm dev
```

`pnpm dev` prints the decision for three sample incidents: an original still in flight, an original returned by the bank, and a supplier asking for a new account.

## Layout

| File | Contents |
| --- | --- |
| `src/incident.ts` | Types for an incident and a decision |
| `src/decide.ts` | The decision policy, a pure function |
| `src/index.ts` | Three sample incidents run through the policy |

The code holds amounts in minor units.

## Not built yet

- A client for the Airwallex sandbox: beneficiaries, transfers, the transfer simulation endpoints, balances and payout webhooks.
- An obligation ledger with a lock, so one invoice can have only one live payment.
- Idempotency: a new `request_id` for a replacement and the same one for a retry.
- Approvals bound to the amount, currency, beneficiary and evidence shown.
- Closing an incident only after both the original and the replacement are reconciled.
- The model reading supplier emails.

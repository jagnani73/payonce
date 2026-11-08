# Engine rules: dated checks

How the rules in [design/engine-rules.md](../design/engine-rules.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-11-08: every payment a person starts waits for an approval (`heldForApproval`)

Checked with the replay rig on Airwallex faked, against a run of main 5db2ff4. Every journey that starts a payment now approves its first payment before its next step, with names the policy allows. Of the 34 journeys main has, 31 do the same after that approval: the same decisions, attempts, transfer outcomes, final reason codes, closes, alerts and bank writes, with every chain intact. Three differ because of the rule: a second bill of an invoice paid on a person's approval needs one approver (`held-invoice-approved`), the server's restart pickup now resumes a person's original in flight (`restart-pickup`), and a scripted incident whose first create answered 429 now plays its emails once the retry sends it (`airwallex-errors`). A new journey checks that the starter is refused, that a payee never paid on a person's approval needs two approvers and then one, and what the New payment preview says. Two full runs were identical.

The first rig run found two gaps the rule opened, both fixed: a refused send after the approval waited a minute before going back to a person (`heldIfRefused` now holds it at once, as `startPayment` does), and an email asking not to pay that arrived while the approved original was with the bank raised no alert (`underway` in `alerts.ts`).

`demo-morning.mjs` ran on the faked bank in real time: it approved both scripted incidents' first payments, and the morning came out as `docs/demo.md` describes.

## 2026-11-02: account keys filled on an older ledger (`backfillAccountKeys`)

On a copy of the main ledger it keyed two of the 13 attempts, the two paid on approvals that named an account, so the demo supplier's last checked payment is `P261028-2IURNV2`.

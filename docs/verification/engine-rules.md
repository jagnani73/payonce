# Engine rules: dated checks

How the rules in [design/engine-rules.md](../design/engine-rules.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-11-08: new payments' sender domain, second bills on a shared account, and their timeline lines

These are the four gaps that the real-sandbox test of new payments found. They were checked with the replay rig on Airwallex faked, against a run of main a9fd3a9 with the same rig.

Across the 36 journeys, nothing that reaches the bank changed. No `bank.json`, `bank-reads.json` or `alerts.json` differs, and neither does any approval, run approval or signoff row. The two real ledger copies open the same. Every difference is one of two kinds:

- The new line wording: "Payment started by NAME" where a person starts a payment, and "Payment closed: the bank paid its first transfer" in six journeys, with the hashes that move with them.
- Ask why's `waitingOn` is null on 43 settled or rejected invoices that used to show their last waiting line.

With the two close lines read as one, the decisions, closes, final codes, attempts, transfer outcomes, bank writes and alerts are the same in every journey, and every chain is intact.

Two new journeys ran on both sides:

- A look-alike sender on a new payment to the record the scripted demo payment uses. The ledger has `example-supplier.test` on file for that record, so the line now says the sender does not match that domain. Before, it said no domain was on file to check against. A new payment with an email from the supplier's own domain now has nothing flagged, so once paid it closed by itself; before, it went to a person as an unverified sender. A record with no domain on file still flags every sender.
- A same-number bill to another record for the same account: two records with identical bank details and no account name, so their names differ. The New payment preview and the start now hold it as `held-same-number`; before, only the routine approval held it. A third record had the EUR demo supplier's IBAN under another account name. It was not held on either side, because the route key counts the account name.

On copies of the main ledger, the app ledger and the live test's ledger, each had one route on two records: the USD demo supplier's account, on its own record and on a bank change scenario's record, both named "Example Supplier LLC". Counting records that share an account matched no invoice that the beneficiary and name tests did not already match. Every stored approval's terms still hash to their binding.

## 2026-11-08: every payment a person starts waits for an approval (`heldForApproval`)

Checked with the replay rig on Airwallex faked, against a run of main 5db2ff4. Every journey that starts a payment now approves its first payment before its next step, with names the policy allows. Of the 34 journeys main has, 31 do the same after that approval: the same decisions, attempts, transfer outcomes, final reason codes, closes, alerts and bank writes, with every chain intact. Three differ because of the rule: a second bill of an invoice paid on a person's approval needs one approver (`held-invoice-approved`), the server's restart pickup now resumes a person's original in flight (`restart-pickup`), and a scripted incident whose first create answered 429 now plays its emails once the retry sends it (`airwallex-errors`). A new journey checks that the starter is refused, that a payee never paid on a person's approval needs two approvers and then one, and what the New payment preview says. Two full runs were identical.

The first rig run found two gaps the rule opened, both fixed: a refused send after the approval waited a minute before going back to a person (`heldIfRefused` now holds it at once, as `startPayment` does), and an email asking not to pay that arrived while the approved original was with the bank raised no alert (`underway` in `alerts.ts`).

`demo-morning.mjs` ran on the faked bank in real time: it approved both scripted incidents' first payments, and the morning came out as `docs/demo.md` describes.

## 2026-11-02: account keys filled on an older ledger (`backfillAccountKeys`)

On a copy of the main ledger it keyed two of the 13 attempts, the two paid on approvals that named an account, so the demo supplier's last checked payment is `P261028-2IURNV2`.

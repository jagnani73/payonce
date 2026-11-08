# Pay runs: dated checks

How the rules in [design/pay-runs.md](../design/pay-runs.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-11-08: callback bars and failed accounts on run rows, with Airwallex faked by the replay rig

Both gaps were found in the live sandbox test that morning. Checked on `fix/run-callback-bar` on main a9fd3a9, with the replay rig plus two new journeys, against a run of main.

- Callback bar (`run-callback-bar`). Alex's callback moves a record to account 4321, Yash and Sam approve the replacement, and the bank pays it. A run row then pays that account. Before: the row had no `bankChange`, the run barred only its uploader, and Alex approved and released it alone. After: the row shows as verified by callback, its terms carry `verifiedBy`, and Alex is barred ("recorded the callback for the bank details row 2 pays"), so his signoff is refused and Yash releases the run.
- The same journey starts a held invoice of the same record to the same account, on another invoice than the callback's. It barred Alex before and after, so the single-invoice path had no gap.
- Failed account (`run-account-closed`). A payment to Payee A fails with 90701, and 30 seconds later a run row pays the same account. Before: one approver, no caution, and Alex released it. After: the row has the caution, its terms carry `accountFailure` (P261102-0000002, 90701), and the request needs two approvers, so Alex and Yash release it. A later run, after that row was paid to the account, has no caution and needs one approver.
- Every other journey: of 309 files in 36 journeys, 274 are byte for byte the same. The other 35 are `db.json` files that differ only by the two new `run_rows` columns, null on every row. A semantic compare of decisions, attempts, transfers, bank writes and alerts finds all 38 journeys the same, the two new ones included, since the same transfers reach the bank.
- Bindings: every stored request in the rig and on both real ledger copies hashes to its binding, apart from the two that `tampered-terms` changes on purpose. `runTermsFor` rebuilds the smoke ledger's run request byte for byte. On both copies every run's barred list is the same under the new rule.
- On the smoke ledger copy, rows 2 and 3 of released run 1 would get the caution if checked now. The cause is a 90701 that came after the run, on another record with the same bank details.

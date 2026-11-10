# Accounts

How PayOnce tells whether two sets of bank details are one account. Two keys name bank details: the account key pins exactly the details a person saw, and the route key says where the money goes. The code is `accountKeyOf` in `src/domain/approval.ts`, `routeKeyOf`, `NOT_ROUTING_FIELDS`, `ROUTE_SCHEME` and `knownRoute` in `src/domain/assess.ts`, `holdsAccount` in `src/store/attempts.ts` and `rebuildRoutes` in `src/store/schema.ts`. [Invariants 19 to 25](../invariants.md#accounts-and-bank-details) list the guarantees.

## Rules

### The two keys

- `accountKeyOf` hashes every field of the bank details (`bankDetailsKey`, then `keyHash`). Approval terms (`accountKey`), run terms and every stored `account_key` carry it, so a binding pins exactly the details a person saw.
- `routeKeyOf` hashes every field except `NOT_ROUTING_FIELDS`, in name order, each string read with its whitespace dropped and upper-cased (`routeValue`). Every route key starts with `ROUTE_SCHEME` (`r3:`).
- A field nobody listed counts toward the route key. `NOT_ROUTING_FIELDS` holds `bank_name` and `account_name`. `fingerprint` counts.
- A field joins `NOT_ROUTING_FIELDS` only with evidence that it cannot route money, written beside it in `domain/assess.ts`.
- `knownRoute` takes a stored route key only when it starts with this scheme's prefix. A key from another scheme, or none, is not known and never matches as a route.
- Bump `ROUTE_SCHEME` whenever `routeKeyOf` or `NOT_ROUTING_FIELDS` changes.

### Where each key is compared

- Wherever a decision or an approval pinned an account, PayOnce compares the full key ([invariant 22](../invariants.md#accounts-and-bank-details)).
- Those places are `requireAccount` (every replacement, a held invoice's release and every retry, so before `useApproval` and `releaseFor` spend anything), a run row's approved key in `startPayment` and `continueHeld`, `accountMismatch` in `transferChecks` on every transfer, and `sameAccount` in held terms.
- So a bank name or an account name changed after an approval voids it, and the next look opens a new request.
- The route key is for the tests that would otherwise stop a supplier being paid after such a change: `sameBankDetails` (a replacement's new bank details) and its warning, and the first-payment hold (`lastPaidHold`) and `payeeRule` against `lastPaidTransfer`.
- The callback compares by route too: its nothing-to-verify and read-back checks, `verifiedBankChange`, `bankChangeRecorders`, `callbackPhoneSetters` and `callbackBars`, which `barredFrom` and `runBarred` read.
- So do the pay run account checks, `payingRoute` and `payoutVerdict` for outside payouts, and the supplier view, which groups accounts by route through `accountRoutes`.
- Outage payees (`payeeOf`) keep a field list of their own. [rail-outages.md](rail-outages.md) has it.

### Where route keys are kept

- Route keys sit beside the full keys and never go in terms: `attempts.route_key`, `attempts.sent_route`, `outside_payouts.sent_route`, `run_rows.route_key` and `approvals.route_key`.
- `openAttempt` writes `attempts.route_key` from the record its caller just checked, and only when the attempt has an `account_key`. `releaseRun` keeps a row's `route_key` only when the run approved the same `account_key` the row holds.
- `holdsAccount` compares a stored account by its route key when `knownRoute` takes the key, and by its full key otherwise.
- `callbackBars` bars every recorder of a callback for the beneficiary, and everyone who put its number on file, when it cannot read the account's route or the callback's. `bankChangeRecorders` lists a recorder whose callback details it cannot read.
- `meta.route_scheme` names the scheme the stored keys were built with.
- When `meta.route_scheme` is not `ROUTE_SCHEME`, the writable open runs `rebuildRoutes` under the write lock that adds columns. It clears every route column, then gives each key equal to the full hash of details a callback kept (`applied_key` or `old_details`, `callbackRoutes`) the route of those details. The rest stay null.
- `rebuildRoutes` also clears every outside payout's `checked_at` and `pays`, so the next look reads it again and judges it by the new keys.

## Why

- There are two keys because the binding must pin what a person saw, while a changed bank name or account name must not stop a supplier being paid.
- Airwallex rewrites `bank_name` from the routing number when a record is updated (seen on 2026-10-28: "Bank of America" became "Bank of America, NA"), and the routing number, not the name, says where the money goes.
- Banks credit the account number, not the account name. UCC § 4A-207(b)(1) lets the beneficiary's bank rely on the number when the name and the number identify different people. PSD2 (Directive (EU) 2015/2366) Article 88(1) deems a payment made to the unique identifier, such as the IBAN, correctly executed for the payee that identifier names. So one account under two Airwallex records with different names is one route, and a second bill sent through the other record is held.
- `fingerprint` stays in the route because a record may show a masked account number, and then the fingerprint is the only field that tells two accounts apart.
- The route key counts every field nobody listed, so a field Airwallex adds later counts as routing money until there is evidence that it does not.
- Strings are read without spaces and upper-cased because Airwallex may change case or spacing when it stores a value.
- Route keys stay out of terms, so terms and their bindings are the same bytes with or without them.
- A key from another scheme never passes for the same account. That is what the scheme prefix, `knownRoute` and the full-key fallback in `holdsAccount` are for.
- The rebuild gives a route only to keys whose details a callback kept, because those are the only details on file to rebuild from. A key it cannot rebuild is compared by its full key, which is never looser.
- A recorder is barred when a route cannot be read, so the bar never depends on a key PayOnce cannot check.

## Edge cases

- A change to `bank_name` or `account_name` alone: new invoices, a replacement and a pay run row to the supplier are paid as before, to the same account number. Terms pin the full key, so an approval given before the change is voided.
- A change to `account_routing_type1` or `local_clearing_system` alone: the first payment is held, the replacement escalates, the run row is skipped, and a transfer sent there is marked misdirected.
- A rename is not new bank details, so these go through as they would with no change, always to the same account number:
  - a resendable failure after a rename is replaced without a person;
  - a rename needs no callback, and no second approver for a new account;
  - a callback stays valid after the record is renamed;
  - typed details that differ from the compared payment only in the account name are refused as nothing to verify, and a typed name Airwallex did not store does not fail a callback;
  - a payout sent outside PayOnce to the same number under another name pays the invoice.
- Two records with the same bank details under different account names share a route. A second bill through either is held as a likely second bill or for the same number. A pay run row through the other record is skipped, or held when it is sent, as for two records under one name.
- A held second bill through the other record still says it pays a different account from the first, and needs two approvers, because the duplicate evidence in its terms compares full keys. That stays, so no binding moves.
- If Airwallex's `fingerprint` covers the account name, two records for one account differ by it and stay two routes, so the second bill is not held. It stays in the route on purpose (see Why). The sandbox's USD records carry no fingerprint (seen in the 2026-11-08 ledger).
- A ledger whose route keys an earlier scheme built, such as the six-field allowlist the route key first used or `r2`, which counted the account name: the next writable open rebuilds them. A key no callback's details match stays null, so its account is compared by its full key, the first payment is held, and the callback's recorder is barred. A failure or a payment from before the rebuild then counts only for exactly the details it went to, and the second-bill hold links records paid before the rebuild only by beneficiary and name.
- An attempt from before `account_key` that nothing on file named an account for, and a found payout's original, have no account key and no route key. [ledger.md](ledger.md) says how `backfillAccountKeys` fills what it can.
- A request from before `approvals.route_key` has none.
- A released run row has no `route_key` when its last check read another account than the run approved.

Dated checks: [verification/accounts.md](../verification/accounts.md).

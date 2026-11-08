# Supplier contacts

A callback is how PayOnce checks new bank details, so the phone number it is made on matters as much as the account. This note covers the supplier record's phone on file: where it lives, how two people put it there or change it, what a change withdraws, and who it bars. The code is `src/domain/contacts.ts` (the rules, refusals and timeline lines), `src/store/contacts.ts` (the table and its changes), `src/engine/contacts.ts` (a person's propose, confirm and withdraw), `src/views/contacts.ts` and `src/surfaces/http/routes/contacts.ts`. The callback itself is in [engine-rules.md](engine-rules.md) and the table in [ledger.md](ledger.md).

## Rules

### Where the phone lives
- The phone on file belongs to a supplier record, one Airwallex beneficiary id, in `supplier_contacts`. At most one row is `on_file` per record (`one_contact_on_file`), and at most one proposal waits (`one_open_proposal`).
- An invoice's `Obligation.supplierPhone` is read from its record's row on file (`ContactReads.phoneColumn()`), never from `obligations.supplier_phone`, which is written when an invoice opens and not read after that.
- A row on file with the value `''` means a number was removed and none is on file. It reads as no phone.
- Every version is kept: a row moves from `proposed` to `on_file`, `withdrawn` or `lapsed`, and from `on_file` to `replaced`. Nothing is deleted.
- The only field today is `phone` (`ContactField`). The email domain stays on each invoice.

### Where a number may come from
- A number reaches the ledger only as a person typed it, through `proposeContact` and `confirmContact`. Never from an email, the reader, the Airwallex record or a pay run file, and the form is never prefilled.
- The person picks a source from `CONTACT_SOURCES`: the contract or onboarding form, the supplier's website, a call to a number already known for the supplier, in person, or another source with a note. There is no "email" and no "Airwallex record" source.
- A typed number must be international: `+`, the country code, 8 to 15 digits, split by spaces, dashes, dots or brackets (`typedPhone`). It is stored with each run of separators as one space, beside its digits.
- On a proposal PayOnce counts the supplier emails on file whose subject, body or style text holds those digits, in full or as their last ten, and how many of those the sender check flags (`seenInEmails`). The counts go on the row, the proposal line and the confirm card as a warning, never a refusal.

### Two people
- One person proposes a number; a different person confirms it by typing it again from their own source (the blind re-key, `sameNumber`). It goes on file only when the digits match.
- The proposer cannot confirm (`selfConfirm`, compared with `sameName`). Anyone with a PayOnce name may propose or confirm: confirmers are not limited to `APPROVERS`.
- A first number, a change and a removal take the same two steps.
- A proposal lapses 72 hours after it was made (`PROPOSAL_LAPSES_MS`). The next proposal for the record marks it `lapsed`, with its line, in its own transaction. A lapsed proposal blocks nothing, and confirming one is refused.
- Anyone may withdraw a waiting proposal with a name and a note of 1 to 200 characters.
- Each change is one ledger transaction (`ContactStore`), outside any invoice's turn. It writes its lines and sets `look_at` to now on the record's open and escalated invoices; the route then wakes them, except a released pay run row that has not sent, which the watcher wakes in the run's turn.

### Callbacks on the number
- A callback must be made on the record's phone on file. `recordBankChange` reads it before any Airwallex call and refuses a dialled number that is not that one (`isNumberOnFile`).
- The callback stores the id of the row it was made on (`bank_changes.contact_id`). `addBankChange` inserts it only while that row is still on file, or refuses with `PHONE_CHANGED_WHILE_RECORDING`.
- A callback verifies bank details only while the number it was made on is on file (`verifiedBankChange`). A confirmed change of the number retires every callback made on the old one.
- While a proposal waits, no callback can be recorded on the record's invoices (`PROPOSAL_BLOCKS_CALLBACK`, the first check in `callbackBlocked`).

### Who is barred
- Whoever proposed or confirmed the number on file cannot record a callback on it (`setterCalls`). A number other people put on file lifts that bar.
- Whoever proposed or confirmed the number a callback was made on cannot approve a payment, a held invoice's payment or a pay run row to the account that callback verified (`Ledger.callbackPhoneSetters`, read by `callbackBars` for `barredFrom` and `runBarred`). The bar lasts for that account of that record, as a callback recorder's does.
- A migrated or scenario number has no person, so it bars nobody.

### What a confirmed change withdraws
- A change of a number on file (not a first value, and not one replacing `''`) voids, in the same transaction, every `requested` or `approved` request on the record's invoices whose terms carry `evidence.bankChange`, each with the line `CALLBACK_REQUEST_VOIDED`.
- It also voids the waiting pay run's open or approved request when a pay row of it to the record has a `bank_change_id`, with a run line naming the rows (`runRequestVoided`).
- How many requests it withdrew is stored on the row (`withdrawn_requests`), for the confirm notice and the alert.
- A change is refused while a released pay run row to the record waits to send on a callback (`RUN_ROW_WAITS`), because that send does not check the callback again.
- A payment already opened on an approval goes on: its attempt keeps the account it was approved for.

### Lines, alerts and display
- Lines go on every open or escalated invoice of the record. With none, they go on its newest invoice, and with no invoice, on the waiting run that names the record. Their kind is `contact`.
- A proposal line names the number by its last four digits only, so the confirmer has to find it themselves. The confirm line, the record of what went on file, gives the full number.
- `escalation_reason` never holds a phone number. No new escalation reason comes from a contact change.
- An alert `contact:<beneficiary id>` goes out while a person's proposal waits and for 24 hours after one went on file; a changed number is urgent. Its facts never carry the number, a domain or a person's name ([alerts.md](alerts.md)).
- The full number is served by `GET /api/suppliers/:key/contact` and by the callback form (`GET /api/incidents/:id/bank-details`, `phoneOnFile`), and the timeline's confirm, callback and waiting lines quote it. Every other view field gives the last four digits. MCP has no tool for either route, and it masks every number the ledger holds (`Ledger.storedPhones()`).

## Why

- The phone belongs to the record, not to an invoice or an account. Every control already keys on the beneficiary id, and a callback already verifies per record. The phone has to outlive an account change, because it is what checks one. A supplier entity spanning records would let a callback on one record vouch for another's details, and records are linked only by name or shared account, which an attacker can choose.
- A first value takes two people as well, because the first number is the one an insider setting up a supplier gets to pick. Maker-checker on vendor master data is the usual control, and it costs one more person once per supplier.
- The confirmer types the number again because one who only clicks "yes" checks nothing. Showing only the last four digits makes them find the number in their own source.
- There is no email, reader or Airwallex source because fraud arrives by email, and the Airwallex record's phone fields sit beside the bank details, editable by the same people and keys.
- Confirmers need not be in `APPROVERS`. They are barred from approving what their number verifies, so with three or four approvers, a starter plus a confirmer from the list could leave fewer than two who may sign.
- A change voids requests in its own transaction instead of through the terms. Binding the number into terms would change the frozen terms builders and catch a change only at the next look. The void is atomic: `useApproval`, `releaseFor` and `releaseRun` move only `approved` rows, so once it commits nothing it covered can be spent.
- Invoices read the number through the record because a subquery column on the invoice reads lets every existing reader follow the record unchanged: the callback form, waiting lines, alerts, the board, drafts, Ask why, the supplier view and MCP. Copying the number onto invoices would touch the INSERTs in `releaseRun` and `adoptPayout`, which are money transactions, and rewrite closed invoices.
- The seen-in-email count warns and never refuses, because a real supplier's signature carries the real number.

## Edge cases

- On a ledger from before the table, the first writable open adds `supplier_contacts` and runs `seedContacts` once, under the write lock that adds columns (`meta.contacts_seeded_at`). For each record, the newest invoice with a phone gives an `on_file` row of origin `migrated`, trimmed and not normalised. Each callback gets that row's id when `isNumberOnFile` matches the number it called, else none, and a callback with none verifies nothing.
- On a read-only open of an older file, without the table or before the seed, `ContactReads.kept()` is false and invoices read their own `supplier_phone`. MCP, `pnpm ask` and `pnpm metrics` refuse such a file until a writable open upgrades it (`schemaGaps`).
- The demo scenario's number: `openScenario` passes a phone, and `openObligation` puts it on file in its own transaction, origin `scenario`, only when the record has none on file and none waiting, with the line "The demo scenario put +1 212 555 0147 on file as the supplier's phone number".
- PayOnce refuses a proposal that matches what is on file, a removal with nothing on file, and a second proposal while one waits (naming who proposed it).
- When the number on file changed after a proposal was made, confirming the proposal is refused because `replaces_id` no longer matches. Withdraw it and propose again.
- Confirming a lapsed proposal is refused with the lapse line and "Propose it again".
- A look that read the record before a change and opens a request after it is caught before the spend, because `verifiedBankChange` no longer verifies the callback.
- A payout sent outside PayOnce to an account whose callback was retired stops counting as paying the invoice, because the payout's verdict reads `verifiedBankChange`. A person can still close the invoice without paying.
- A removal confirmed by two people leaves `''` on file. The record reads as having no phone and gets no `phone-changed` caution. The `no-phone` caution, on an invoice that needs a callback, says to put one on file.

## Not built

- The email domain on the same table, a hash chain of the record's own, and `pnpm run audit` checking contact rows.
- Writing a contact from the terminal, a cooling-off time after a new number, a note on the email card when an email gives a number not on file, comparing with the Airwallex record's phone, and a caution for a phone shared by two records.
- Ask why shows the `contact` lines as stand-ins.
- Escalating a released pay run row when the number changes. The change is refused until the row sends.

Dated checks: [verification/supplier-contacts.md](../verification/supplier-contacts.md).

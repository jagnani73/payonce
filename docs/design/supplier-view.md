# Supplier view

The supplier view shows one Airwallex beneficiary record at a time: what PayOnce owed it, sent it and to which account, what changed, who called whom, what is still at risk and what to be careful of. The read model is `src/views/suppliers.ts` over `SupplierReads` in `src/store/read/suppliers.ts`, the page views are `src/views/supplier-pages.ts` with the contact block from `src/views/contacts.ts`, and it is shown by the Suppliers screens (`web/src/screens/suppliers.tsx` and `web/src/screens/suppliers/`), `pnpm supplier` and the MCP `suppliers` and `supplier` tools. The phone rules are in [supplier-contacts.md](supplier-contacts.md), accounts in [accounts.md](accounts.md), and the money and groups come from the [incident board](incident-board.md).

## Rules

### Records
- A supplier record is one Airwallex beneficiary record: `obligations.beneficiary_id`, and `run_rows.beneficiary_id` for a pay row of the waiting run that no invoice holds yet.
- A skip row never makes a record, since its id may be one Airwallex does not have.
- The key in every route, link and command is the id, checked against `SUPPLIER_KEY_PATTERN` (`BENEFICIARY_ID_PATTERN` from `src/domain/patterns.ts`). A stored id outside the pattern is listed with `key: null` and no link.
- Every control keys on the record (`lastPaidTransfer`, `verifiedBankChange`, `payeeRule`, the run check), so the view shows what the next payment is checked against.
- Records are never merged. Records that share a name (`sameSupplier`, through `supplierNameKey`) or an account are linked, for display only.
- Two records share an account when an account key is on file under both, or when both failed to one `rail_failures.payee`.
- An empty name, and `UNNAMED_PAYEE`, the name the sweep gives a found payout with no account name, never link records.
- `resolveSupplier` takes a word as a record id first, then as an invoice number, then as a waiting pay row's invoice number, giving the record it pays (`viaInvoice`). `Ledger.supplierNamed` says whether an invoice or a waiting pay row names a record.

### Reads
- `supplierList` and `supplierDetail` each read the ledger once, inside `Ledger.readSnapshot`, and work on a read-only ledger. Nothing on a payment path imports them.
- The list reads every record with `Ledger.supplierListRead`: only the columns its cautions, counts and names use from invoices (`SupplierObligation`), attempts (`SupplierAttempt`) and outside payouts, and no drafts or outage holds.
- The list reads approvals with only the account their terms name, so each terms JSON is parsed once, and builds the links between records from that same read (`linksOf`).
- The detail reads its record with `Ledger.supplierRead(key)`: the invoices in full, what the page shows of each payment as `SupplierPayment`, its drafts by template and state, and its holds. The route advisory's JSON is parsed only for what paid a listed invoice.
- The detail reads the other records' names and accounts with `Ledger.supplierLinks(key)`, which leaves out that record's own approvals, read already.
- An approval's account is read only inside `CASE WHEN json_valid(terms)`, as `metricsRead` reads `duplicate_of`.
- Every account key the reads give is the routeKey of the same details where the ledger keeps one (`Ledger.accountRoutes`, applied in the reads), else the key as it is.
- An invoice's phone is read through the record's phone on file (`ContactReads.phoneColumn()`), and the record's contact rows come with the read ([supplier-contacts.md](supplier-contacts.md)).
- Neither answer holds an email's or an upload's subject, body or display name, a draft's subject, body, facts or dismiss note, or a callback's `spoke_to`, `confirmed` or `new_details`.
- Neither answer holds a timeline line, an escalation reason or a skip reason. The cautions read a reason only by its code (`Ledger.reasonOf`).
- Both still read some of that text. The list's read takes `escalation_reason`, and the detail's takes whole invoice rows. The detail's inbox and `boardEntriesFor` read waiting uploads in full, but only for `candidatesFor`.
- The board also reads each open invoice's first timeline line, only for its time, and the waiting run's rows in full.

### Money and groups
- Money and groups are the board's own, built by `boardEntriesFor` for the invoices that need them, each entry as the whole board has it.
- The list builds entries for every invoice that is not closed (`Ledger.openObligations`) and every pay row of the waiting run, summed per record. The detail builds them for its own invoices and pay rows, with their totals.
- Neither builds entries when its records have no open invoice and no waiting run row. The detail's waiting uploads and the board's use one invoice index.

### Accounts
- Accounts are named by where the money goes and labelled A, B, C in the order first seen, so a bank name Airwallex rewrote makes no new account.
- Where an account was seen (`AccountSource`): decided for (`account_key`, `opened_at`), sent to (`sent_key`), asked to approve (the terms' `accountKey`), pay run (a pay row's `account_key`, `checked_at`), verified by a callback (the routeKey of `applied_key`), on the record before a callback (`routeKeyOf` the callback's `old_details`), and paid outside PayOnce (a payout's `sent_key`).
- The page and the CLI never print an account key. The read model carries it as `accountKey`.
- An ending comes only from `sent_ending` and the callback JSON, and only as 1 to 4 letters and digits.
- A payment's account is its `sent_key`, else its `account_key` when it has a transfer and is not misdirected.
- A payment's check is `checked`, `misdirected`, `not-kept` (no `account_key`), `not-sent` (no transfer) or `outside`.
- The account PayOnce last paid is `ledger.lastPaidTransfer`'s, never a copy of the rule.
- What PayOnce last stored for the record is the newest key among decided for, asked to approve, pay run and verified by a callback. The record names the invoice it was stored on, or a pay run row as "row N of pay run M" (`runLine`), since the row's number may not be an invoice yet.
- The latest applied callback is the newest applied one, whatever it kept, and only while it was made on the phone number on file now (`onFilePhone`), as `verifiedBankChange` reads it. `verifiedBy` is that callback when its key is this account's.
- Each account reads only its own payments, payouts, callbacks and failures, grouped once per record.
- `barred` lists everyone who recorded an applied callback for the account (`bankChangeRecorders`) and whoever proposed or confirmed the number one was made on (`callbackPhoneSetters`), through `knownName`, as `barredFrom` reads them.

### Cautions
- A caution is `{ code, level, text, invoices, accounts, keys, runs, since }`. Cautions come before infos, each in `CAUTIONS` order, and each code has a must or could tier.
- `text` is fixed words. It may hold account labels, counts, a rail in its own form, and failure codes' words (`wordsFor`: only a code in `FAILURE_CODE_PATTERN`'s form that is `FAILURE_WORDS`'s own entry, so `constructor` gets none).
- `callback-verified`'s text also holds the account's ending (1 to 4 letters and digits). When the callback was recorded is its `since`, never in its text.
- Invoice numbers (25 at most), account labels and other record ids (`keys`) go in the arrays. No caution carries a name, a domain or a reference, and none fills `runs`.
- `phone-proposed` (first, a caution): a new phone number waits for a second person, and nobody can record a callback until it is confirmed or withdrawn. A lapsed proposal raises none.
- `phone-changed`: people changed the number on file in the last 7 days. A first number, one that replaced none, or a removal does not count.
- `account-changed` follows the engine's tests. It shows when `lastPaidTransfer` gives an account, the account PayOnce last stored is another, and the latest applied callback did not verify it. That part names the stored account's label.
- `account-changed` also shows, with those invoices and whatever the callbacks, whenever an open invoice's reason code says the record's bank details changed (`accountChangedReason`).
- `accountChangedReason` covers four codes: `bank-details-changed`, `last-paid-account-changed`, `account-changed-before-send` and `run-account-changed` (a pay run row whose record changed after the run was approved). The text has a part for each case.
- The first part of `account-changed` speaks only of first payments and pay run rows: PayOnce sends no first payment to those details, and skips a pay run row to them, before a callback.
- `callback-verified`: the latest applied callback verified the account PayOnce last stored, and it is not the account `lastPaidTransfer` gives. It says which account (label and ending).
- `callback-verified` also says that paying a held invoice or a pay run row to the account needs two approvers (`payeeRule`, `runRule`), and that nobody who recorded a callback for it may approve. It says nothing about automatic payments, and reads with `new-payee`.
- Then, in order:
  - `new-payee`: never paid, or paid only by itself and never on a person's approval;
  - `unconfirmed-account`;
  - `misdirected`;
  - `shared-account`;
  - `account-failure`: a code in `ACCOUNT_FAILURE_CODES` (90701, 90101, 90802) on the last paid or last stored account in the last 30 days;
  - `domain-changed`;
  - `asks-not-to-pay` and `asks-new-details` (open invoices only);
  - `paid-twice`;
  - `no-phone`;
  - `recent-failures`, by `bank_created_at`, else `opened_at` (a failed attempt the bank still has live is not one);
  - `non-receipt`, `flagged-senders`, `no-domain`, `outside-payout`, `held-duplicate`;
  - `outage`: an active outage on an open invoice's rail.
- `paid-twice` and `no-phone` take the open invoices in situation state `paid-twice` and `needs-phone` (`situationOf`). `situationsOf` builds those situations with an empty approver list (`policyFromEnv({})`), since neither state depends on it.
- `no-phone` ends "Put one on file below. It takes two people."
- "Recent" is a 30-day constant (`RECENT_MS`). The list carries the codes of level `caution`.

### The list
- The list puts a record first when it has an entry in the board's `person` group or a phone proposal waiting. Then come records with a must-tier caution, then the most money at risk, then the name and the key.
- Each list row gives the account ending the record held the last time PayOnce stored it, and the phone on file's last four digits.
- `suppliersView` shapes the list for the page (`supplierRows`). Each row gives the name, a hint (its bank country, currencies and methods), how many records share its name, its payments open and in all, and each caution code with a short label (`CAUTION_LABELS`).
- A row's country is the bank country of the newest transfer PayOnce sent to the record, from its route advisory. The ledger keeps no bank name per account, so an account's label names it by its ending.
- The list's search matches the name, the record's id, and three or more of the last characters of the account ending.
- `suppliersView` takes `q` and keeps the records whose name or id holds it, ignoring case.

### The record
- The read model's detail lists every open invoice, then the 25 newest closed, with counts per state. Each `InvoiceView` keeps the board's group, label, `why` and `also`, and its money at risk.
- Each `InvoiceView` also gives what paid it, with the route advisory's latest usual day. A payout sent outside PayOnce counts as paying only if `payoutPays` says it pays the invoice.
- Each attempt and outside payout gives its reference only as `REFERENCE_PATTERN`, its status only as `STATUS_PATTERN`, a failure code and its words, and a rate mismatch only as true or false.
- An invoice's emails are counts, with `summarise` of the three findings and `readBy`, never the stored summary.
- The detail also gives callbacks (who called, the number's last four digits, from and to account) and likely duplicates across this record and same-name records.
- Duplicates are bucketed on `numberOf(...).base`, and called "same bill" when amount and currency match too.
- The detail gives outage holds, rail failures and active outages. A run's hold is on the record of each row the run released, by the invoice it became, and on the records of its pay rows while it waits. Never on a skip row or a dropped row.
- The detail gives pay run rows (skip reasons only as a count), waiting uploads that name its invoices (one `invoiceIndex`), and drafts by template label, audience, state and who moved them.
- `supplierView` shapes the record for the page. Its payments are the incident list's rows (`IncidentRow`), grouped by situation: the open ones, and the closed ones listed with counts paid and closed without paying.
- `supplierView` also gives the cautions, the contact block (`contactView`), the accounts, callbacks, possible second bills, pay run rows, the inbox, drafts, active outages and rail failures, related records and the money per wallet (`walletTotals`).
- An account's `onFile` says it is the one PayOnce last stored for the record.
- The contact block gives the phone on file by its ending, who proposed and confirmed it, a proposal waiting, the earlier versions, who may not record a callback on it, and what a person can do now (`propose`, `confirm`, `withdraw`). The full number is served only by the contact route ([supplier-contacts.md](supplier-contacts.md)).
- A payment with no transfer says it was not sent, with no account or send time.
- Starting a new payment from the record is allowed, and `can.newPayment.href` opens New payment with the record picked.
- The phone on file gives no `since` for a migrated number, because PayOnce knows only when it moved it. A removal two people confirmed gives `removed` and no `changed`, and the confirm notice says the number is no longer on file. Each earlier version gives the note it was withdrawn with (`closeNote`).

### Routes
- `GET /api/suppliers` (with an optional `q`) and `GET /api/suppliers/:key` answer `SuppliersView` and `SupplierView`. They write nothing, so they skip the Dispatcher.
- An unknown key, or one outside the pattern, answers 404 "No invoice or pay run row in the ledger names supplier record X", X cut to 20 characters. A `q` longer than `MAX_QUERY_LENGTH` answers 400.

### The page
- `#suppliers` (and `#suppliers?q=`) is the list, and `#supplier/<key>` one record.
- The list's search follows the address 300 ms after typing stops. The list is polled every 5 seconds.
- The record is polled every 5 seconds, and every 1.5 seconds while PayOnce is working on one of its payments.
- The record shows its header, the cautions, the contact on file beside the accounts, then each section that has something to show: payments, callbacks, possible second bills, pay run rows, inbox emails, messages, outages and related records.
- When the record has related records, the page also reads `GET /api/suppliers` every 30 seconds, to tell the others apart by currency, method, account ending and phone ending.
- Names and other text PayOnce did not write go through `<Theirs>` (in `web/src/components/`), which cleans them with `cleanLine` and puts them in text nodes ([web-server.md](web-server.md)).

### `pnpm supplier`
- `pnpm supplier` prints the list, or one record's sections ([cli.md](cli.md)). A word is a record id first, then an invoice number, which prints "INV pays supplier record X" first. Any other word prints the usage and exits 1.
- The list gives each record's name and hint, its id or "A record id PayOnce cannot link", its payments not closed of the total, its caution labels, and how many records share its name.
- A record prints its name, id and hint, other names on file, the phone ending and email domains, then its cautions, each with its since, its "Phone on file" section and its money by wallet.
- After those come the accounts, payments not closed, closed payments, callbacks, possible second bills, pay run rows, the inbox, messages, outages and related records. A section with nothing to show is left out.
- An account's lines give its letter, its label, the reference that last paid it, where it was seen, when first and last, the callback that verified it, who cannot approve payments to it, and the other records it is on.
- "Phone on file" gives the phone's ending, since when, and who proposed and confirmed it with their sources. It also gives a proposal waiting or lapsed, by its ending, and each earlier version.
- Times are UTC, references go through `shownReference`, and every line goes through `printable`.

### MCP
- `suppliers` answers `suppliersView`. `supplier` takes `key`, a record id or an invoice number through `resolveSupplier`, and answers `supplierView` with `viaInvoice`. An unknown word is refused with the 404's words.
- `SUPPLIERS_FIELDS` and `SUPPLIER_FIELDS` (in `src/views/outside-fields.ts`) list what is wrapped. Names and domains wrap as `supplier`, typed names as `person`, and account labels as `airwallex`. Caution text, hints and PayOnce's labels are plain.

## Why

- The beneficiary record is the key because every control already checks the next payment against the record, so the view shows exactly what those checks read.
- Records are never merged, because they are linked only by name or a shared account, which an attacker can choose. A callback or a payment on one record never counts for another.
- Accounts are named by route key because Airwallex can rewrite a bank's name on the same details, which would otherwise look like a new account.
- The view uses the engine's own tests instead of a copy of them. The last paid account is `lastPaidTransfer`'s and the bank-details invoices come by reason code, so the view and the engine cannot drift.
- `account-changed` speaks only of first payments and pay run rows because a replacement whose original went to the changed details is not held by that rule, such as the replacement of a payout sent outside PayOnce. The sentence promises nothing it does not hold.
- `no-phone` reads the situation because a callback is recorded on the escalated invoice from the record's phone, and only an invoice about the supplier's bank details needs one.
- A waiting phone proposal ranks with what waits on a person, because nobody can record a callback for the record until someone confirms or withdraws it.
- No answer holds outside text, because the view reaches the page, the terminal and MCP clients. It gives emails as counts and PayOnce's summaries, never what the supplier or Airwallex wrote beyond names.
- The reads use `CASE WHEN json_valid` because SQLite promises no order for the two sides of an AND, and `json_type` throws on text that is not JSON.

## Edge cases

- A payment from before accounts were kept has the check `not-kept`. A record paid only that way gets `unconfirmed-account`, since its next first payment waits for two approvers.
- A record only a waiting pay run names is a record with no invoice. Its phone ending comes only from the record's phone on file, and the account PayOnce last stored is named by the run's row.
- Two found payouts named "Unnamed payee" are not linked.
- A failure code such as `constructor`, `toString` or `__proto__` gets no words.
- A run's outage hold on a skipped or dropped row stays off that row's record.
- In a ledger not yet seeded with phones on file, the phone comes from the newest invoice that has one ([supplier-contacts.md](supplier-contacts.md)).
- Once the number a callback was made on is replaced, that callback no longer counts, in the view as in `verifiedBankChange`. `callback-verified` and `verifiedBy` do not name it, and only a callback on the number on file now verifies the account again.
- The view reads stored JSON soft (`readingSoft`), so when it does not parse, an unreadable account, ending or findings is left out and the rest of the record still shows.

Dated checks: [verification/supplier-view.md](../verification/supplier-view.md).

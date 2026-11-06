# Names

How PayOnce takes, records and compares the name a person types, and how it compares supplier names. PayOnce has no login, so a name is a typed claim (see Name in [glossary.md](../glossary.md#product-words)). The code is `personName`, `knownName`, `sameName`, `NAME_RULE` and `NameError` in `src/domain/approvers.ts`, and `sameSupplier` in `src/domain/duplicates.ts`.

## Rules

### Taking a name

- Every name a person types goes through `personName`: who started an incident, an approver, who uploaded or cancelled a pay run, who recorded a callback, who ended an outage, and who uploaded, delivered or dismissed an email.
- The same goes for who created, copied, sent or dismissed a draft, who closed an invoice, who explained a reconciliation break, and who proposed, confirmed or withdrew a supplier's phone number.
- `personName` trims the name and collapses runs of spaces. It accepts only ASCII letters, digits, spaces, dots, hyphens, apostrophes and underscores, 1 to 80 characters, with at least one letter or digit.
- Anything else is refused with `NAME_RULE` (`NameError`). An empty name is refused with the caller's own words, such as "Enter your name".
- The normal form `personName` returns is what PayOnce records.
- The check runs in the functions that record the name: `checkSigner`, `closeIncident`, `uploadRun`, `cancelRun`, `endOutage`, `recordBankChange`, `createDraft`, `markDraft`, `storeUpload`, `deliverUpload`, `explainBreaks`, `proposeContact`, `confirmContact` and `withdrawContact`.
- A new payment's starter is checked by `newObligation`, which `openPayment` and so `openScenario` reach, and `paymentProblems` reports a bad name before anything is opened.
- The server's `name` helper (`surfaces/http/http.ts`) runs `personName` first on the field exactly as sent, not through `text`, and answers 400 with the rule.
- `pnpm recover`, `pnpm close` and `pnpm payrun upload` check the name before they record or send anything.
- Without a NAME, `pnpm recover` uses the login name. When that is not a name PayOnce takes, it says so, with the login name quoted as escaped JSON, and asks for NAME.
- The MCP `waiting_for` tool takes a name through `personName` and refuses one it does not take with the rule.
- Who a person spoke to on a callback is the supplier's contact, not a PayOnce name, and is not checked this way.

### Approver names

- `APPROVERS` names follow the same rule once each run of whitespace in an entry, a tab or U+FEFF included, is one space. Otherwise `policyFromEnv` cannot read the list and every approval is refused.
- A list with two names `sameName` takes for one person, such as `Alex` and `alex.`, is refused the same way, and the message names both.
- The start-up line and every refusal quote the bad entry, with any character outside printable ASCII written as its code point (`Al\u{200B}ex`), and give the rule.

### Comparing names

- `sameName` says two names are one person when both follow the rule and their letters, digits and the spaces between words match, lowercased, with other characters dropped and runs of spaces collapsed. So `Alex.` and `alex` are one person, and so are "Mary-Jane" and "MaryJane".
- Every comparison of two people's names goes through `sameName`: finding the approver a typed name belongs to, the barred lists, the proposer confirming their own phone number, and who may end an outage.
- `knownName` gives a stored name only when it follows the rule, in `personName`'s normal form, and null otherwise.
- A stored name that `knownName` refuses is nobody PayOnce knows. It bars nobody (`barredFrom`, `runBarred`), and the payment needs two approvers, as when `started_by` is null (`signoffsNeeded`, and `runRule` for an uploader).
- The why facts give such a starter as "not known".
- Names already in the ledger are kept as they were stored. The page shows each one after `cleanLine` in `web/src/text.ts`, in text nodes. `Ledger.knownNames` lists them as stored.

### Supplier names

- Supplier names are not people's names. `sameSupplier` compares two in NFKC with format characters and default-ignorable code points dropped, trimmed, runs of whitespace collapsed and lowercased (`supplierNameKey`).
- `likelyDuplicates` and the pay run checks use `sameSupplier`, and the supplier view groups names by `supplierNameKey`.

## Why

- Names are ASCII only, so a zero-width space, a bidi control or a Cyrillic letter cannot make a name that reads on screen as someone else's.
- A name needs a letter or a digit, because a name of marks alone, such as "-" or ".", has nothing to tell it from another.
- Underscores are allowed for login names, which `pnpm recover` uses by default.
- The check runs in the functions that record a name, so the page and the CLI refuse the same names.
- The server reads a name as sent, so a line break or another control character in it is refused instead of becoming a space.
- `APPROVERS` names follow the rule because an approver types their name to approve, and nobody could type a listed name the rule refuses.
- Two listed names that are one person are refused, because a typed name must find exactly one approver and one limit.
- A stored name that does not follow the rule could pass for someone else's, so PayOnce cannot tell whose it is. It counts as not known, and two approvers stand in for the requester rule it cannot check.
- Supplier names come from Airwallex records and pay run files in any script, so `sameSupplier` normalises them instead of refusing them, and drops characters that draw nothing so a name cannot pass for another supplier's by a character nobody sees.

## Edge cases

- A name with a tab or a line break in it is refused when typed, since `personName` collapses only spaces. In an `APPROVERS` entry the same whitespace becomes one space.
- A `started_by`, a callback recorder, an uploader or a phone setter written before names were checked may not follow the rule. It stays as it was, bars nobody, and makes the payment need two approvers.
- Marking a draft copied may record no name. Every other draft move needs one.
- Dismissing an upload is checked only by the server's `name` helper, since `Ledger.dismissUpload` takes the name as given and no CLI command dismisses one.
- A reconciliation break explained under a name that does not follow the rule shows no explainer (`knownName`).

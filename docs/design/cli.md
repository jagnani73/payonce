# Terminal commands and printing

The terminal commands, one file per command in `src/surfaces/cli/`: how each loads its settings and opens the ledger, what it prints, and how everything PayOnce prints to a terminal is cleaned. The shared code is `src/surfaces/cli/view-text.ts`, `src/surfaces/cli/terms-shape.ts`, `src/text/printable.ts`, `src/text/words.ts`, `src/text/line-error.ts` and `src/env-file.ts`. Outside text in general is in [architecture.md](../architecture.md#text-payonce-did-not-write), and the read-only open and the schema upgrade are in [ledger.md](ledger.md).

## Rules

### The commands
- Each `pnpm` script runs one file in `src/surfaces/cli/` with `tsx`: `dev.ts`, `recover.ts`, `approve.ts`, `close.ts`, `audit.ts` (`pnpm run audit`), `cash.ts`, `board.ts`, `payrun.ts`, `outbox.ts`, `outage.ts`, `supplier.ts`, `reconcile.ts`, `ask.ts`, `metrics.ts` and `reset.ts`.
- `view-text.ts` and `terms-shape.ts` are shared by the commands and are not commands. `pnpm ui` and `pnpm mcp` live in `src/surfaces/http/` and `src/surfaces/mcp/`.
- Only `pnpm recover` runs a `Dispatcher` and a `Watcher`: it checks every 2 seconds and runs no sweep. Every other command calls the engine directly and relies on the ledger's transactions ([architecture.md](../architecture.md#dispatcher-watcher-and-sweep)).
- `pnpm dev` runs `decide` on its sample incidents with the keyword reader. It opens no ledger and reads no setting.
- Only `pnpm recover`, `pnpm cash`, `pnpm payrun upload` and `check`, and the live `pnpm reconcile` call Airwallex. No other command does, and `pnpm ask` calls only the model services ([ask-why.md](ask-why.md)). `pnpm cash` writes only the fees it reads.

### Settings and `.env`
- A command that loads `.env` calls `loadEnvIfPresent` itself, before `loadSettings`. A variable already set in the shell keeps its value. No script uses node's `--env-file` flags.
- These load `.env` when there is one, and say nothing when there is none: `pnpm approve`, `ask`, `board`, `cash`, `outage`, `outbox`, `payrun`, `recover`, `supplier`, and `reconcile` (the live check, `offline` and `show`).
- These load no `.env` and read only the shell's environment: `pnpm close`, `pnpm run audit`, `pnpm metrics` and `pnpm reconcile explain`. `pnpm reset` and `pnpm dev` read no setting at all.
- Only `pnpm recover`, `pnpm cash`, `pnpm payrun upload` and `check`, and the live `pnpm reconcile` need credentials. Without one they stop with the client's sentence from `settings.ts`.
- That sentence is "Missing environment variable AWX_CLIENT_ID. Make a .env file in this folder from the setup lines under Run it in the README", or "... Add AWX_CLIENT_ID to .env" when there is a `.env`.
- Every other command runs with no credentials. Without a `.env` the defaults apply, and nothing is printed about it.
- What they take from `.env`: the bank deadlines for `pnpm board`, `supplier`, `outbox` and `outage`; `APPROVERS` for `pnpm approve`, `board` and `payrun show`, `approve` and `cancel`; `APPROVERS` and the outage rule for `pnpm outage`; the approval policy, floors, bank deadlines, quote validity and reader names for `pnpm ask`.

### Opening the ledger
- `pnpm ask`, `pnpm metrics`, `pnpm run audit` and `pnpm reconcile show` open `payonce.db` read-only (`new Ledger(LEDGER_PATH, true)`), so they never create, upgrade or hash a file.
- `pnpm ask` and `pnpm metrics` refuse a file `schemaGaps` finds gaps in and exit 1. The refusal names the first three gaps, says the command never upgrades a ledger, and says to restart `pnpm ui` or run `pnpm board` once, which upgrades it.
- `pnpm run audit` refuses a ledger whose timelines are not a hash chain yet, and `pnpm reconcile show` one with no reconciliation tables. Each says which command starts them.
- Every other command that opens the ledger opens it for writing, so an older file gets the upgrade any writable open makes ([ledger.md](ledger.md)).

### With no `payonce.db`
- `pnpm approve`, `close`, `ask` and `metrics` stop with "There is no payonce.db here. Start an incident first." and exit 1.
- Every `pnpm payrun` command stops with "There is no payonce.db here. Start an incident first, or start pnpm ui once." after it checks the command, so a bare or unknown one prints the usage.
- `pnpm run audit` says there is nothing to check and exits 1. `pnpm reconcile` says there is nothing to reconcile, or with `show` nothing to show, and exits 1. `pnpm reset` says there is nothing to reset and exits 0.
- `pnpm board`, `supplier`, `outage`, `outbox` and `cash` open the file without looking for it first, so with none they start an empty ledger. `pnpm recover` starts one on purpose.

### Refusals they share
- `pnpm approve` and `pnpm close` say "INV is not in the ledger" for an invoice the ledger does not have (`notAnInvoiceText` in `src/runs/runs.ts`).
- For a pay row of the run waiting for approval, `notAnInvoiceText` instead gives its row and run, says it is not an invoice until the run is released, and points to `pnpm payrun show N`.
- `pnpm outbox`, `pnpm ask` and `pnpm run audit` say "INV is not in the ledger" alone.
- `pnpm recover` refuses an invoice from a pay run that has not sent its original: the server sends it, in the run's turn.
- When `pnpm recover`'s scripted run's sandbox bank fails with a `SandboxBankError`, it prints the bank's words, says PayOnce stopped and how to look at the invoice again, and writes a `bank` line ending with `SANDBOX_BANK_STOPPED`.
- When `untilAtRest` gives up in `pnpm recover`, as when the bank could not move a replacement, it prints the same guidance and exits 1.
- When Airwallex cannot be reached or answers with an error, `pnpm recover` says nothing was sent or stored, with `airwallexAdvice`, before the invoice is stored. After that, it says PayOnce stopped and writes an `error` line.

### What each command prints
- `pnpm board [FILTER...]` prints `incidentsView` (outages, wallet totals, payment rows, the scope from the group word), plus `homeView`'s pay runs that need someone under the same filters ([incident-board.md](incident-board.md)).
- `pnpm board`'s group words `person`, `deadline`, `bank` and `open` print as Needs you, Bank is late, With the bank and PayOnce is handling. Closed payments are not listed.
- With a group filter, `pnpm board`'s totals cover that group, because the view's totals follow its scope, and the heading says "Money by wallet in this group".
- `pnpm approve <INVOICE>` prints `incidentView`: the payment's header (its situation and the incident's cause), the open request's terms and signing, the cautions, and the approve option's consequence.
- `pnpm approve`'s signing lists each approver's limit and whether they can sign now, and who is barred and why (`signingFields`). The gate is `pendingApproval` (`store/read/reviews.ts`).
- `pnpm close <INVOICE>` prints `incidentView`: the payment's header, its emails, the cautions and the close option with its consequence. The option is `close-paid` or `close-unpaid`, picked by `pendingClose`'s kind.
- `pnpm close` also lists the payouts that only name the invoice and the unrecognised transfers the close covers. `--covers` is checked against `pendingClose().covered`, so a list that changed since the person looked is refused.
- `pnpm payrun show` prints `runView`: the situation, rows, skip summary, cash at the run's check, the request, cautions, options and the newest 8 timeline lines that are not system lines.
- `pnpm payrun approve` prints the request and the approve option. `upload` and `check` print the same as `show`. A file with nothing to pay is not stored, so it prints its rows and skip reasons through `putRows`.
- `pnpm payrun` prints no sandbox outcome on a row.
- `pnpm supplier [RECORD|INVOICE]` prints `suppliersView` or `supplierView`. `resolveSupplier` turns an invoice number into its record ([supplier-view.md](supplier-view.md)).
- `pnpm outage` prints `outagesView`: the rule, the active outages and the last 5 ended. Who can end an outage is printed on each active card (from `card.end`), and with no active outage it is not printed.
- `pnpm cash` prints `cashView` over the balances it reads itself, with each wallet's floor. It does not print Airwallex's reserved, pending, prepayment or total amounts, which the view does not carry; reserved money is reconciliation's.
- `pnpm cash` exits 1 by the view: no balance read (`balances.readAt`), a floors problem (`floorsProblem`), or any headroom below 0.
- `pnpm metrics`, `pnpm outbox`, `pnpm reconcile`, `pnpm run audit`, `pnpm ask` and `pnpm recover` print their own text from their modules' reports, not from a view.

### How the views print
- `view-text.ts` holds the pieces the view commands print with. Every line goes through `printable`, keeping the spaces it starts with (`put`, `putAll`, `heading`).
- `utc` writes a time as "2 Nov 2026, 09:00 UTC" (through `utcText`), and "a time not on file" for none. `said` prints a view's `Timed` sentence with each of its times through `utc`.
- `money` marks an estimated figure "(estimated)". `table` lines up columns, with the columns it names right-aligned, such as amounts. `putFields` prints labelled values with the labels in one column.
- `putTimeline` prints a timeline's newest lines that are not system lines, oldest first. `signingFields` prints a request's signoffs, approvers and barred names. `putConsequence` and `putOption` print what a decision option does and why it cannot be chosen now.
- `paymentRow`, `runRow` and `putRows` print list rows. Each row ends with the command that does its primary action, where one does ("Next step: pnpm approve INV").
- `walletLine` prints a wallet's money in play, `putPayment` a payment's header, and `putCautions` the cautions the header did not print already.

### Terms before approving
- `readableTerms` and `readableRunTerms` (`terms-shape.ts`) check stored terms, an invoice's or a pay run's, field by field in the type and form each is printed in. `pnpm approve` and `pnpm payrun show` and `approve` check them before they build the view or record an approval.
- The checks cover the FX quote (`buyCurrency` and `buyAmountMinor` among its fields), the arrival estimate and `evidence.bankChange`, which the request view prints.
- Terms that are not JSON, or not in their shape, get "Request N for ... holds terms PayOnce cannot read, so there is nothing to show or approve", and the command exits 1.
- Only these commands use `terms-shape.ts`. The engine and `src/runs/runs.ts` read terms without it.

### Printing
- Every console line PayOnce prints goes through `say`, `sayWarning` or `sayError` (`printable.ts`), so Airwallex names and errors, typed names and notes, and pay run cells cannot move the cursor or write the clipboard.
- `pnpm mcp` points `console.log` at stderr, so `say` writes there and stdout carries only the protocol.
- `printable` makes one line: a control character becomes a space, a format character or a tag character goes, and the line is trimmed.
- `printableLines` does the same line by line and keeps the line breaks and each line's indent. `printableError` gives an error with its stack trace through it.
- `printableJson` writes DEL, C1 controls, U+2028, U+2029, format characters and tag characters as `\uXXXX` escapes, so the JSON parses back to the same value. `JSON.stringify` already escapes C0 controls.
- `oneLine` turns every control character, a line break included, into a space and keeps format characters. It is for text PayOnce stores: every timeline line (`note` and `appendEvent`), the server's typed notes and other free text, and the Airwallex account name in a pay run skip reason.
- A typed name goes to `personName` as it was sent instead of through `oneLine`, and `personName` refuses any control character.
- `trimmedLine` is `oneLine` trimmed, for an alert's fields. `capitalise` (`domain/sentences.ts`) puts a clause's first letter in capitals.
- `shownReference` and `shownFailureCode` print Airwallex's short reference and failure code only in the form Airwallex gives them (`REFERENCE_PATTERN`, `FAILURE_CODE_PATTERN`), and otherwise `UNSHOWN_REFERENCE` or `UNSHOWN_FAILURE_CODE`. Commands and views that print a reference or a code use them.
- `utcText` writes a time for an alert's fields. The commands write times with `view-text.ts`'s `utc`, and a view's `Timed` sentence with its `said`.

### Fixed words
- `words.ts` holds fixed words kept apart from the code that writes them, and it imports nothing: `UNNAMED_PAYEE`, `PAID_OUTCOME`, `STAYS_IN_FLIGHT`, `SANDBOX_OUTCOMES`, the sandbox bank lines' endings, `ModelFailure`, `MODEL_FAILURE_WORDS`, `FAILURES_WITH_STATUS` and `TRY_WORDS_SOURCE`.
- The sandbox bank lines' endings are `SANDBOX_BANK_AFTER`, `SANDBOX_BANK_STOPPED` and `SANDBOX_BANK_RECOVER`. `TRY_WORDS_SOURCE` is the model failure words as a pattern.
- `why-facts.ts`, the views and the run file parser take the sandbox outcomes and line endings from it without importing `engine/sandbox-bank.ts` or `airwallex/simulation.ts`. `reader/reader-error.ts` takes the model failure words from it without importing a reader.
- Nothing the MCP server, `why-facts.ts` or `views/metrics.ts` imports at runtime reaches `engine/sandbox-bank.ts` or `airwallex/simulation.ts`.
- They do reach `reader/model-reader.ts` and `reader/model-service.ts`, through `settings.ts`, which imports `reader/reader.ts` to set up the model services.

### Errors as timeline lines
- `LineError` (`line-error.ts`) is an error whose message is a timeline line in PayOnce's words, with a kind of its own, and whose `detail` is the error it came from.
- `noteError` (`src/engine/lines.ts`) writes a `LineError` as a line of its kind and prints only its `detail` to the console. The sandbox bank's `SandboxBankError` is a `LineError` of kind `bank`.

## Why

- Every line goes through `printable.ts` because supplier and payee names and error text come from Airwallex, names and notes are typed, and a pay run file comes from anywhere. Any of them could hold a control character that moves the cursor, clears the screen, retitles the window or writes the clipboard.
- `oneLine` keeps format characters so the stored line keeps what was written. The page and `printable` drop them when they show a stored line, so a typed name or an Airwallex name cannot start a line of its own.
- References and codes print through `shownReference` and `shownFailureCode` because they are stored as Airwallex sent them, so a stored value in another form could otherwise print a line of its own.
- No script uses the `--env-file` flag, because `--env-file` stops on a missing file in node's words, and `--env-file-if-exists` prints its note once for tsx and again for the script.
- Commands that need an invoice check for the file first, because opening a ledger that is not there would make an empty one.
- Read-only opens never upgrade because a check never changes what it checks, so `pnpm ask` and `pnpm metrics` refuse an older file instead of reading columns it may lack.
- `terms-shape.ts` checks the terms before approving, because terms that do not parse into their shape were changed outside PayOnce, and a person must not approve what the command cannot show them in full.
- `words.ts` imports nothing because the code that reads lines back and the read-only views need the words the sandbox bank and the reader write, without importing the code that calls the simulator.
- `LineError`'s detail goes only to the console, so the timeline line stays in PayOnce's words, and the error it came from, which can quote Airwallex or a model, never reaches a hash-chained line.

## Edge cases

- When the terms are not JSON, `pendingApproval` throws a `SyntaxError`, and `pnpm approve` says the request holds terms PayOnce cannot read and exits 1.
- `pnpm approve` shows an expired request, says PayOnce opens a new request at its next check, and exits 1 only when a name was given.
- `pnpm recover` quotes a login name PayOnce does not take through `printableJson`, so it shows as it is without moving the cursor, and asks for NAME.
- `utc` prints "not known" for a time a view cannot read.
- An older ledger opened by `pnpm board` or `pnpm supplier` gets the schema upgrade any writable open makes and nothing else, which is why the read-only commands point to `pnpm board`.
- When `pnpm reset` runs while `pnpm ui` holds the file, the move fails, and it says to stop `pnpm ui` and try again.

# MCP server

`pnpm mcp` serves PayOnce's views read-only over stdio, so an agent such as Claude can read the ledger. The code is `src/surfaces/mcp/` (`main.ts`, the projection in `mcp-text.ts`, the cached balances in `server-cash.ts`) and the field lists in `src/views/outside-fields.ts`. It answers the views in [views.md](views.md), moves no money ([invariants.md](../invariants.md), number 63), and [architecture.md](../architecture.md#text-payonce-did-not-write) has the table of how outside text is cleaned.

## Rules

### The process

- `pnpm mcp` runs `src/surfaces/mcp/main.ts` with tsx. Claude Code and Claude Desktop start the same file with node and tsx's loader (`--import`), as the README's client settings show.
- `src/surfaces/mcp/main.ts` is the only file that imports `@modelcontextprotocol/server` and `zod`. `serveStdio` picks each connection's protocol era.
- stdout carries only MCP messages: the `console` methods `log`, `info` and `debug` go to stderr, so `say` writes there.
- The process never imports `src/surfaces/http/`, builds no Airwallex client and loads no credentials. Its one network call is to PayOnce's own server, for the balances.

### Settings

- From `<root>/.env` it parses only the lines that set an `ENV_ALLOWED` key, with or without `export`: `APPROVERS`, `TWO_APPROVERS_ABOVE`, `APPROVAL_TTL_MINUTES`, `RESERVE_FLOORS`, `BANK_DEADLINE_LOCAL_MINUTES`, `BANK_DEADLINE_SWIFT_MINUTES`, `OUTAGE_FAILURES`, `OUTAGE_WINDOW_MINUTES` and `PORT`.
- A key already set in the environment keeps its value. `loadSettings` then reads only those keys and `PAYONCE_LEDGER`, so a credential set in the shell is not read either.
- Credentials, alert addresses and the model settings never enter the process.
- The approver list does. Approver names and limits appear in answers, and each name is wrapped as `person`.
- The ledger is `PAYONCE_LEDGER`, absolute or from the repository root, or else `<root>/payonce.db`. `PAYONCE_LEDGER` comes from the client's settings, not from `.env`.
- `PORT` must be an integer port, or the process uses 4310 (`mcpPort`).
- A `.env` it cannot read leaves the defaults, with one line on stderr.

### Opening the ledger

- Each call opens the ledger with `new Ledger(path, true)` and closes it in `finally`, so the process holds no connection between calls.
- A missing file is refused in PayOnce's words and never created. The refusal names the file's path from the PayOnce folder, or only its name when `PAYONCE_LEDGER` names another folder (`ledgerPlace`).
- A file that `schemaGaps` finds lacking a table or column is refused and never upgraded. The refusal names up to three of the gaps and says to restart `pnpm ui` or run `pnpm board` once.
- SQLite would refuse a write on the read-only connection anyway.
- A call is not one transaction: each view reads in its own few read transactions, as it does on the server ([views.md](views.md)).

### The tools

Twelve tools, in this order. Each builds its view on the read-only ledger with no `Live`, so nothing reads as busy.

| Tool | Arguments | Answer |
|---|---|---|
| `board` | `group` (person, deadline, bank or open; person when left out), `currency`, `origin` | `IncidentsView` with the group's scope: person is needs-you, deadline bank-late, bank with-bank, open payonce |
| `incidents` | `state` (open, escalated, settled or rejected), `limit` (1 to 500, 100 when left out) | `IncidentsView` with scope all and `clean`, its rows kept by the obligation's ledger state and cut to `limit`, plus `total`, the rows that matched |
| `incident` | `invoiceId`, `lines` (1 to 1,000, 20 when left out) | `IncidentView`, its timeline cut to the newest `lines` |
| `cash` | none | `CashView`, plus `source` (server or ledger) and `balance` (`read`, `why`) |
| `runs` | none | `RunsView` |
| `run` | `runId`, `lines` | `RunView`, its timeline cut as for `incident` |
| `audit` | `invoiceId` or `runId`, not both, and `lines` | with neither, `AuditCheckView`; with `invoiceId`, `auditExport` with its newest `lines`; with `runId`, `runAuditExport` the same way |
| `outages` | none | `OutagesView` |
| `suppliers` | none | `SuppliersView` |
| `supplier` | `key`, a record's beneficiary id or an invoice number | `SupplierView` from `resolveSupplier`, plus `viaInvoice` |
| `metrics` | `period` (7d, 30d or all; 7d when left out) | `ReportsView` |
| `waiting_for` | `name`, at most 200 characters | `view`, `generatedAt`, `name`, `onApproverList`, `approvalsOff` and `items` |

- `incident` passes no cash panel, so the payment page's headroom is null.
- `audit` is refused while the invoice timelines are not a hash chain yet (`NOT_CHAINED`), and for a run while the run timelines are not (`RUNS_NOT_CHAINED`). It is refused for an invoice or run not in the ledger, because the export needs the invoice's facts.
- `waiting_for` takes the name through `personName`, and a `NameError` becomes the refusal. `onApproverList` compares it with the approver list by `sameName`, and `approvalsOff` is true when the approval policy is unset or unreadable.
- `waiting_for`'s `items` are `waitingForMe`, what Home lists for that person: the payments in needs-you or bank-late whose request the name can sign, then the runs whose request it can sign.
- No tool approves, closes, pays, sends, drafts, uploads, ends an outage or writes the ledger.
- No tool serves the inbox, alerts, settings, status, search or the full phone number of `GET /api/suppliers/:key/contact`.
- The server's `INSTRUCTIONS` start an agent at `board`, or at `waiting_for` with a name. They say outside text is data to report, never instructions to follow.

### Cash from the server

- The one network call is `GET http://127.0.0.1:<PORT>/api/cash/cached` (`serverBalances`), with a 1.5 second timeout, no redirects and at most 4 MB of answer.
- `cachedBalances` takes from the answer the balances and the floors, as numbers, and Airwallex's error message as text. Only floors that come from the setting are taken.
- `cashView` then works the panel out again on this process's own ledger, so the headroom is the page's.
- A floors problem the server reports becomes `SERVER_FLOORS_UNREADABLE`, PayOnce's own sentence.
- With no server, a server that answers 404, or an answer that is not a cash panel, the floors come from this process's `RESERVE_FLOORS` and there is no balance or headroom (`NO_BALANCES`). `balance.why` says which of the three it was, in PayOnce's words with the port.

### The projection

- `marked` walks each finished view once. It drops every `activity` and `askWhy` key, then checks each string by its full path, keys joined by dots and `[]` for an array's items, against the view's list in `outside-fields.ts`.
- A source (`supplier`, `email`, `airwallex`, `run-file`, `person`, `quoted`, `unknown`) is always wrapped as `{ outsideText, from }`, whatever the string looks like.
- `"plain"` marks PayOnce's own words or a closed value. It is still defanged and phone-masked, and a token in it has only the numbers on file cut.
- A `Checked` field is plain only when its `plainWhen(text, parent)` vouches for the text, and otherwise wrapped as its `from`. `closed` marks a form with no words, such as a link, which has only the numbers on file cut.
- A string not listed is plain only as a token (`TOKENS`): an ISO time or day, a 64-character hash, a UUID, 1 to 40 letters, digits, `_`, `:` and `-`, or an amount as `formatMoney` writes it. Anything else is wrapped as `unknown`.
- The lists are typed against the contract. `Fields<V>` is a partial record over `StringPaths<V>`, every path to a string in `V`, so a path that does not exist fails `pnpm typecheck`. `under` composes the shared lists: situation, request, terms, row.
- Links are not tokens. A row's link, the audit export links, the callback form's path and the ledger audit's export path are plain only in the form PayOnce builds from an invoice or run number (`ROW_LINK`, `AUDIT_EXPORT_LINK`, `BANK_DETAILS_LINK`, `LEDGER_EXPORT_LINK`).
- Wrapped text goes through `defanged`, `maskPhones` and `capped`. The caps are 4,000 characters for any `.body`, 2,000 for a timeline or audit line, 600 for other quoted text, 200 for `person`, `supplier` and `run-file`, and 300 otherwise.

### What is wrapped and what stays plain

- Always wrapped: supplier names and domains, every part of an email (sender, display name, Reply-To, subject, body, style text, attachment names and types, the Date header as written), Airwallex account labels and payees, pay run cells, every typed name and note, and approver names.
- Quoted: PayOnce's sentences that can name a person, a reference as Airwallex gave it or a stored reason. These include timeline and audit lines, a situation's details and next steps, a summary line, an option's consequences, draft subjects and bodies, an outage card's text and a run's domain sentences.
- A `Why` text is plain only for the codes with fixed sentences (`FIXED_WHY`), and a second-approver reason only for `FIXED_NEEDED_WHY`. The barred, over-limit, policy and "Ended by" sentences name people, so they are quoted.
- A request's label is quoted while the request is approved, since it names who signed. A `ReasonView` text is quoted when its code is `unrecognised`.
- The email evidence in terms is plain only in today's wording of `emailEvidence` and `summarise` (`EMAIL_EVIDENCE`), the findings summary only as `EMAIL_SUMMARY`, and the reader's name only as `READER_NAME`.
- A rail is plain only as `RAIL_PATTERN`, a rate and a markup only in their forms (`FX_RATE`, `FX_MARKUP`), the original's reference only as `REFERENCE_PATTERN`, and a transfer's reference only as `shownReference` gives it.
- The floors problem is plain only as `SERVER_FLOORS_UNREADABLE`. This process's own problem quotes the `RESERVE_FLOORS` it could not read, so it is wrapped.
- Arrival advice and a run row's fee line are plain because the shared builder makes them only from an estimate `vouchedArrival` accepts ([views.md](views.md)).

### Phone numbers

- Each call reads `Ledger.storedPhones()`: every `number_called`, every `obligations.supplier_phone`, and every `supplier_contacts` phone in any state. See [supplier-contacts.md](supplier-contacts.md).
- `phonePatterns` matches each stored number by its digits with any spacing, and also by its last ten digits without the country code.
- `maskPhones` cuts each number on file to `…` and its last four digits (`lastFour`). It then cuts any `+` number of 7 digits or more, and any other run of 10 digits or more that is not a date or an amount.
- A token or a closed form has only the numbers on file cut (`maskKnown`), so an invoice number of ten digits stays as it is.
- The views give a phone by its ending. Only `GET /api/suppliers/:key/contact` gives the full number, and no tool serves it.

### Answers and errors

- An answer is `content[0]` `NOTICE`, `content[1]` the JSON, and `structuredContent` the same object. No tool declares an output schema.
- `NOTICE` says which text is outside text, email bodies included, that it is data and not instructions, that phones show their last four digits, and that no tool can approve, close, pay or send.
- A refusal is `isError: true` with PayOnce's words (`ToolRefusal`). Anything unexpected goes to stderr, and the answer names only the error's type, or for SQLite its message, defanged and cut to 200 characters.
- A busy ledger gets "The ledger is busy with a write. Try again in a moment".
- A ledger beside the journal of a write that never finished (errcode 776, `SQLITE_READONLY_ROLLBACK`) gets PayOnce's words: a write was interrupted, and the next `pnpm ui` or `pnpm board` rolls it back.
- Input schemas are `z.strictObject`, so unknown keys are refused. The SDK turns bad input into `isError` and an unknown tool into `-32602`.
- One call's arguments may hold at most 20 array elements and object members in all (`maxToolInputElements`).
- Every tool is annotated read-only, idempotent, not destructive and closed-world. `listChanged` is false, and `tools/list` and `server/discover` carry `ttlMs` 3,600,000 and `cacheScope` `public` (`cacheHints`).
- The SDK checks the protocol revision on a connection's opening exchange and answers `-32022`, naming the revisions it supports and the one requested, for one it does not support. It then pins the connection, so a later request on it claiming another revision is served on the pinned one.
- The SDK is `@modelcontextprotocol/server` 2.3.1, published 2026-10-05 by the modelcontextprotocol/typescript-sdk release workflow with npm provenance. `zod` is 4.6.7. Both are pinned exactly.

## Why

- Each call opens its own connection, so the process holds nothing between calls, and `pnpm reset` can still move the file while a client keeps the process running.
- The process never upgrades a ledger, because a read-only check never changes what it checks. `pnpm board` and `pnpm ui` upgrade a file, but only the `payonce.db` in the folder they run in.
- A refusal gives only the file's name for another folder, because a path outside the PayOnce folder can hold the user's name.
- Only the allowed lines are parsed, so the credentials and every other setting in `.env` never become values here.
- The approver list enters the process because a payment's situation depends on who can approve it. Without the list, every payment waiting for approval reads as "Nobody can approve", the approver choices are empty, and `waiting_for` finds nothing.
- `askWhy` is dropped because Ask why's switch reads the model settings, which this process never loads, so it would always say Ask why is not set up. `activity` is dropped because only the server knows what is busy.
- The MCP server uses the cached cash route because it never reads Airwallex. Working the panel out on its own ledger from the server's balances and floors gives the page's headroom.
- The server's floors problem is replaced because its text cannot be vouched for.
- With field lists, not path rules, a field added to a view later is wrapped until a list names it, so the projection fails closed.
- Links are plain only in their own form because a security review found that, with a link pattern among the tokens, link-shaped outside text in an unlisted field passed plain.
- The email evidence patterns are needed because an older PayOnce put the sender's address in the evidence, as approvals 1 and 3 in the main ledger still show, and an older reader wrote the stored summary itself.
- Phone numbers are also matched by their last ten digits because a callback to the number on file may be dialled without the country code.
- Only known numbers are cut from a token, because a token holds no spaces or markup, and masking every long run of digits there would cut an invoice number of ten digits.
- The interrupted-write refusal is needed because a read-only connection cannot roll back a hot journal.
- The compiler does no completeness check, since `Theirs` is a plain `string` and `tsc` cannot tell that every `Theirs` field is listed. A branded copy of `src/` checks it (see the dated checks).
- The SDK is 2.3.1, not 2.4.0, because 2.4.0 was 10 days old when the server was built, under the two-week rule, and its changes do not touch a stdio server with zod input schemas.

## Edge cases

- A ledger written by an older PayOnce is refused with its gaps. `pnpm board` or a restart of `pnpm ui` upgrades only the `payonce.db` in the folder they run in, so neither touches a `PAYONCE_LEDGER` file elsewhere, though the refusal still names them.
- After an interrupted write, the same holds for the journal: `pnpm ui` and `pnpm board` roll back only the `payonce.db` in their folder.
- With no server, or an older one, `cash` answers with `source` `ledger`, no balance and no headroom, and `balance.why` says whether nothing answered, the server answered 404, or the answer was not a cash panel.
- When the server has not read the balances yet, `cash` comes from the server with `balance.read` false, and `balance.why` says there is no headroom yet.
- Older email evidence that names a sender, as an older PayOnce wrote it, arrives wrapped as `quoted`, and today's wording stays plain.
- In an estimate edited in the ledger, a route, method or day not in PayOnce's forms gives no advice and no fee line. The terms still show the estimate, and whatever in it does not fit is wrapped. A country that is not two capital letters is left out of the advice.
- `audit` refuses an invoice with timeline lines but no obligation, because the export needs the invoice's facts.
- Email bodies arrive wrapped as `email`, folded to one line by defanging and cut at 4,000 characters.
- When the timeline is cut, `incident` and `run` keep the newest lines, and the view's count of lines stays the full count.

Dated checks: [verification/mcp-server.md](../verification/mcp-server.md).

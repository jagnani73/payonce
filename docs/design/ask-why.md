# Ask why

A person asks a model why PayOnce did what it did on one invoice. The facts are built in `src/explain/why-facts.ts`, the model call, what is shown and the page's limits are in `src/explain/explainer.ts`, the route is `src/surfaces/http/routes/why.ts`, the CLI is `src/surfaces/cli/ask.ts` and the card is in the payment page's summary (`web/src/screens/payment/`). The model services are the email reader's ([email-reader.md](email-reader.md)), and every reason is read through the grammar in [reasons.md](reasons.md).

## Rules

### The question and the answer

- A person asks from the payment's "What happened" card or with `pnpm ask <INVOICE>`. The question is fixed (`WHY_QUESTION`), so nothing typed reaches the prompt.
- The answer is display-only. It is never stored in the ledger, the timeline, approval terms, alerts, drafts or browser storage, and nothing PayOnce decides reads it. The console gets one line about it, with no text.
- Nothing in `src/engine/`, `src/domain/`, `src/alerts/` or `src/outbox/` imports `src/explain/`.

### The facts

- `whyFacts(ledger, invoiceId, settings)` reads the ledger and `WhySettings` only (the approval policy, the reserve floors, the reader names, the bank deadlines and the quote validity), in one `Ledger.readSnapshot`. It writes nothing and calls nothing outside the ledger, so the page and the CLI give the same facts.
- It returns the facts, the `legend` (alias to real value, never sent), `asOf` (the timeline's length and last line id) and how many reasons it did not pass on.
- Every value is PayOnce's own words, a closed pattern, a failure code in PayOnce's words (`FAILURE_WORDS`), or an alias.
- The closed patterns: a bank reference `^[A-Z0-9-]{1,30}$`, a transfer id as a UUID, a status `^[A-Z_]{1,30}$`, a currency, an amount `formatMoney` wrote, a date, an ISO time, a rate such as `1 EUR = 1.1191 USD`, and a count.
- An Airwallex error code is passed only from `KNOWN_CODES`, and any other reads "an error code PayOnce does not pass on". `KNOWN_CODES` is exported for the metrics, and `FAILURE_WORDS` lives in `src/domain/failure-codes.ts`.
- A wallet or transfer method that is not a currency code, `LOCAL` or `SWIFT`, as Airwallex can give for a payout found there, goes in PayOnce's words.
- The invoice explained is "this invoice". Other invoices in the ledger are `[invoice N]`. People are `[person N]` when the name is in `APPROVERS`, signed one of this invoice's approvals, started it, closed it without paying or recorded a callback on it. Any other name is "a person".
- `Aliases` numbers people and invoices in order of first appearance, the invoices it looks like a second bill for first. The legend swaps aliases back only in the answer shown.
- The invoice: state, origin, run and row, amount, wallet, method, due date, who started it, whether a supplier domain and a phone are on file, and whether it was held before paying.
- Also on the invoice: the escalation reason, who closed it without paying, the latest decision line, what it waits on now, and the invoices it looks like a second bill for.
- What it waits on now (`waitingOn`) is the newest waiting line of an open or escalated invoice. A settled or rejected invoice waits on nothing, so a paid payment does not say it waits for the bank.
- Each payment: kind, reference, state, status, created time, deadline and whether it passed, failure, whether a resend could fix it, what it took from the wallet, and fee.
- Also on each payment: the approval it was opened on, the approved rate, whether the rate mismatched, found late, a transfer that does not match the invoice, and when it usually arrives.
- The emails: `emailEvidence` when its text is in the closed form, counts, the three findings, whether the reader failed, and `readBy` only when it is one of the reader names (`readerNamesFromEnv`), "the email reader" otherwise.
- The rest: outside payouts, the latest approval picked field by field, `pendingClose` with its reason, the cash (wallet, floor, where the floor comes from, committed money, and no balance), the policy as read now, and outages.
- Outages are every active one and every ended one that held this invoice: number, rail, state, times, codes, payees counted, window and what it held.
- The facts never hold `payTo`, `accountKey`, the beneficiary id, the quote id, the binding, or the callback's number, contact or words.
- Nor do they hold the findings' `unverifiedSenders`, an email or upload field, a payout's reference text, the supplier's phone number, a run's file name, who ended an outage or their note, or `policy.problem`.
- An approver barred for a why in `BARRED_WHY` keeps it (started it, uploaded its run, recorded the callback, proposed or confirmed the phone number the callback was made on). Any other why reads "barred by the approval policy".

### Reasons in the facts

- The escalation reason comes from its stored codes (`Ledger.reasonOf`). `FactsBuilder.reasonOf` renders it with `reasonText` after each invoice slot becomes its alias and a failure code its PayOnce words.
- A reason in a decision line, approval terms or the close review is text, read with `parseReason`, and a lone clause, as an "Also" line holds one, with `parseClause`. Both are then rendered the same way (`FactsBuilder.reason`).
- A reason that does not parse, or names an invoice the ledger does not have, becomes "(a reason PayOnce does not pass on)". The console gets `  why      N unrecognised reasons on <invoice>`, with no text.
- Why a request needs more than one approver, and `signoffProblem`'s "it now needs N approvers, because ...", go through why-facts' own parts (`WHY_PARTS`): parts joined by ", and ", each matched whole at its position, with backtracking.
- The arrival clause and the held suffix of a decision line are handled apart from its reason (`ARRIVAL_MARKERS`, `HELD_SUFFIXES`).

### Timeline lines

- The last 60 lines go in. Each passes only through `FIXED_LINES` and `LINE_RULES`, checked in order.
- A rule keeps a line whose slots are all closed patterns, or rewrites it in fixed words with only the safe slots: sender checks, payouts with their payee or reference, the email delivery line, bank lines with Airwallex's message, and waiting lines with `payTo` or the phone.
- Rules also rewrite signoffs, callbacks, close notes, outage ends, drafts, a run's first line, the refusals of `send`, and the email reader's failure, which names a model only when it is one of the reader names, "a model" otherwise.
- A payment's first line passes with the person as an alias: "Payment started by [person N]", and on older timelines "Incident opened by [person N]". The close of a payment its first transfer paid, `PAID_FIRST_TIME_LINE`, is a fixed line, beside the two older "Incident closed:" lines.
- The sandbox bank's lines are `bank` lines, rebuilt from their reference, the status asked for, the HTTP status and a code from `KNOWN_CODES`. The same lines written as `error` lines, and the raw simulator errors older code wrote, are rebuilt the same way.
- Each rule and fixed line names the sources it may come from, a kind and a topic such as `decision/decision`, `approval/waiting` or `error`, and passes no line from any other source.
- An error line passes only as the fixed words of a rule for one of PayOnce's own errors (a lock wait, a refused or unfinished send, the reader failing, a refused bank change), or as the stand-in. No rule keeps an error line as written.
- Every line then passes `SAFE_LINE`. A line no rule knows, such as an Airwallex or network error, becomes "(a/an KIND line PayOnce does not pass on)", and `timelineLeftOut` counts it by kind with the earlier lines left out.

### The request

- Each service gets the reader's request shape ([email-reader.md](email-reader.md)) with a `json_schema` of two strings, `explanation` and `notInFacts`, the 8-second timeout and `MAX_TOKENS` 4,000.
- The user message is `<facts>`, the facts as JSON, `</facts>`, with `<` and `>` written as `<` and `>` (`promptOf`).
- Each model gets one request: Claude's in `CLAUDE_ASK_MODEL`'s order (default `claude-sonnet-5-5,claude-haiku-5-5`), then Gemini's in `READER_MODEL`'s (`explainerFor(settings.models.askServices())`). `CLAUDE_MODEL` is the reader's list only.
- `explainerFor` gives null when neither key is set. An `Explainer` also carries `views` (where the facts go, service by service) and `googleFreeTier`, which no view reads, and `maxSeconds` (how long an ask can take when every model times out), which the settings view gives as "Waits for an answer".
- A failure moves on to the next model: an error status, a timeout, a body that is not JSON, a `stop_reason` other than `end_turn` or a `finish_reason` other than `stop`, fields other than the two, or an empty explanation.
- Each failure prints `  why      MODEL gave no answer after N ms: ...`. A 401 or 403 skips the rest of that service's models.
- `redactKeys` cuts both keys out of every error and out of both strings of an answer. [airwallex-client.md](airwallex-client.md) has the full rule for `redactKey`.
- `EXPLAIN_SYSTEM` tells the model to write "UTC" after every time it gives.
- When every model fails, `ExplainError` holds the tries and its message says what each did in `triesText`'s words. `limited` is true when every model answered 429 or refused the key, and at least one answered 429.

### What is shown

- `shownAnswer` runs `cleanText`, drops Unicode `Cf` and the tag block, and collapses whitespace.
- It caps the explanation at 1,000 characters and `notInFacts` at 300, at the last sentence end, else the last space with an ellipsis, and sets `cut`. It then swaps `[invoice N]` and `[person N]` back from the legend.
- `aliasesLeft` says the text still looks like it holds an alias. Only then do the card and the CLI show the legend.

### The route

- `POST /api/incidents/:id/why` takes `{}` and goes through the router's `guard`. It does not take the invoice's turn: the facts are read in one snapshot, and the model is asked after it closes.
- 200 gives `{ explanation, notInFacts, cut, model, at, cached, asOf, legend, aliasesLeft }`.
- 503 without `CLAUDE_API_KEY` or `READER_API_KEY`, before any facts are built. 404 for an invoice not in the ledger. 500 when the facts cannot be built, and nothing is sent.
- 409 while another ask runs. 429 with `retryAfterSeconds` and a `Retry-After` header. 502 when every model failed, saying what each one did in PayOnce's words.
- The server logs `  why      INV answered by MODEL in N s (N characters)`.
- The payment view (`IncidentView`) says whether Ask why is allowed, from the situation's `can`. The settings view (`SettingsView.reader.askWhy`) says whether it is on, which models it asks and the hosts the facts go to (`hosts`), and gives the page's limits as rows (`limits`): asks a minute, asks a day and how long it waits for an answer.

### The page's limits

- `ExplainLimiter` holds them, per server process and in memory only. One ask runs at a time.
- An answer is remembered for 10 minutes by `factsKey` (SHA-256 of the invoice, the facts as sent and the model list), at most 50, oldest dropped. A remembered answer costs no request and counts toward no limit.
- At most 2 asks start per rolling minute (`ASKS_PER_MINUTE`) and 30 per UTC day (`ASKS_PER_DAY`).
- After every model answered 429 or refused the key, with at least one 429 among them, nothing is asked for a minute.
- `pnpm ask` is not limited.

### The card

- The "What happened" card has the Ask why button. It is enabled when the payment view allows it and Settings say Ask why is on. Otherwise the note says to turn on the email reader's model in Settings.
- The answer shows as text nodes through `Theirs`, which drops format characters and the tag block and turns control characters into spaces, as `pnpm ask` cleans text for a terminal.
- Under the answer the card shows "Not in the records" when the model put something there, the legend when aliases are left, the model and time, the timeline line the facts went up to, and "cut to fit" when the text was cut.
- When the payment's newest timeline line is past `asOf.lastEventId`, the card says more has happened since and to ask again.
- A refusal (409, 429, 502 or 503) shows under the button as the route's message.
- The answer lives in the card's own state and goes when the card does.

### pnpm ask

- `pnpm ask <INVOICE> facts` prints the system message, the user message exactly as sent and the legend, and calls nothing, with or without a key.
- `pnpm ask <INVOICE>` prints the answer wrapped at 80 and the model that wrote it. It strips control and format characters from names and invoice numbers after it swaps the labels back, as `pnpm board` does.
- It opens the ledger read-only and calls nothing in Airwallex.
- It exits 1 for a missing argument, no ledger, a ledger an older PayOnce wrote, an invoice not in the ledger, no key (pointing to `facts`), and every model failing, which it says model by model in PayOnce's words.
- After a request it sets `process.exitCode` instead of calling `process.exit`.

## Why

- The question is fixed so that nothing a person types reaches the model.
- `waitingOn` goes by the invoice's state, not by whether its waiting line still stands. Another invoice's look can write a warning on this one's timeline, such as a second bill it held, and nothing rewrites this invoice's waiting line after it. So a test for a standing line would drop a wait that has not ended.
- The facts hold only PayOnce's words, closed patterns and aliases because they leave the machine, possibly to Google's free tier. A supplier name, an email, a typed note or an error text could carry an instruction to the model or a person's details.
- Each line rule names its sources because an error line holds whatever message the error had and a callback line starts with a typed name. Without the source, either could pass as a decision, a bank line or a closing line.
- `SAFE_LINE` runs last so that a rule written too loosely fails there, and a template added later with outside text in it fails closed until it gets a rule.
- `MAX_TOKENS` is 4,000 because Claude counts thinking against the cap and Gemini counts its reasoning: gemini-3.1-flash-lite ran out at 1,000 before it answered. Anything past the character caps is cut anyway.
- Ask why asks Sonnet first because its explanations fit the cap and were more accurate. Haiku ran past the 1,000-character cap and once called a deadline still pending after the replacement was paid. Four to five seconds is fine for a button press, and the reader keeps Haiku first.
- Keys are cut out of answers as well as errors because a service that echoes a key in an error could echo it in an answer.
- The model writes "UTC" after every time because the facts' times are UTC while the page's timeline shows local time, and an unlabelled time would read as a second clock.
- The route goes through `guard` so that another site cannot spend the quota.
- The ask takes no invoice turn because it writes nothing, so the invoice's looks never wait on a model.
- The page has limits because the explainer shares the reader's keys, one maybe on Google's free tier, and a reader that fails sends an incident to a person. The limits leave the reader room.
- A refused key does not cancel the minute's pause that another service's 429 calls for, because a refused key will be refused again.
- `pnpm ask` sets `process.exitCode` because exiting while fetch's socket closes trips a libuv assertion in Node on Windows.
- `pnpm ask` opens the ledger read-only and refuses an older file because a check never changes what it checks, and a column the facts read may be missing from an older file.

## Edge cases

- With no key, the route gives 503 naming both keys, and `pnpm ask` exits 1 pointing to `facts`. `facts` still prints.
- A ledger an older PayOnce wrote: `pnpm ask` refuses it with the tables or columns it lacks, never upgrades it, and says to restart `pnpm ui` or run `pnpm board` once, which upgrades it.
- A ledger no newer code has opened has no `run_row_id` column at all, and the facts read it as no run.
- Approval terms PayOnce did not write, such as a row made by hand, may have no evidence. They give no evidence fields instead of failing the facts.
- The `account-unknown` lines pass: the waiting line, the line for a payment marked failed without being sent, and the cause in the retry lines (`FIXED_LINES`, `CAUSE`).
- A `StoredShapeError` line is an error line, so it shows as the stand-in.
- The supplier phone lines (kind `contact`) and the line withdrawing a request because the phone number changed have no rule, so they show as stand-ins.
- A line added to the timeline after an answer brings up the card's stale note. It also changes the facts, so the next ask is a new request, not the remembered answer.

Dated checks: [verification/ask-why.md](../verification/ask-why.md).

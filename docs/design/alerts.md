# Alerts

Alerts post to a Slack or Discord incoming webhook when something waits on a person. The conditions and the loop are in `src/alerts/alerts.ts`, the messages and payloads in `src/alerts/alert-payloads.ts`, the two tables in `src/store/alerts.ts` and the target in `src/settings.ts`. An invoice's need comes from its situation ([reasons.md](reasons.md)), and the text rules are the alert row of "Text PayOnce did not write" in [architecture.md](../architecture.md).

## Rules

### Turning alerts on

- Alerts are off unless `ALERT_WEBHOOK_URL` or `ALERT_TEST_RECEIVER_URL` is set, and only `pnpm ui` evaluates and posts (`Alerts`, started in `src/surfaces/http/main.ts`). With alerts off there are no alert rows and no alert calls.
- No CLI command runs the alert loop. The CLI writes the ledger, and the server's next check sees what it did.
- `ALERT_WEBHOOK_URL` must be https on the default port with no user info, and either `hooks.slack.com` under `/services/` (format `slack`) or `discord.com` or `discordapp.com` under `/api/webhooks/` (format `discord`) (`alertSetting`).
- `ALERT_FORMAT` is `slack` (the default) or `discord`, and must match the host. Any other value turns alerts off with a start-up line that never repeats the value (`describeAlerts`).
- `ALERT_TEST_RECEIVER_URL` takes only a receiver on this machine: http or https on 127.0.0.1, localhost or [::1], posted in the shape `ALERT_FORMAT` names. While it is set it wins over `ALERT_WEBHOOK_URL`, and the start-up line says alerts go to a test receiver.

### What an alert may hold

- Alerts are built from ledger fields, never from timeline lines, and never from an upload's sender, display name, subject or text.
- The facts are invoice numbers, the supplier name, formatted amounts, the escalation reason, counts, dates and the bank's short references. An alert never names an approver, an account, a bank, an `accountKey`, a binding, a request id or a phone number.
- `obligations.escalation_reason` holds only PayOnce's own words, because alerts post it: every escalation writes a `Reason` built from codes ([reasons.md](reasons.md)).
- The reasons supplier emails add are fixed strings (`NOT_TO_PAY_REASON`, `PARTLY_UNREAD_REASON`, `EMAILS_BEFORE_PAYMENT_REASON` and the clause `NOT_TO_PAY_CLAUSE`), and so are `LATE_TRANSFER_REASON`, `MISMATCHED_TRANSFER_REASON` and `MISMATCHED_FAILED_REASON`.

### Invoice conditions

- `invoice:<id>` stands for an escalated invoice whose situation needs a person: `situationOf` on a snapshot of every escalated invoice (`invoiceCondition`). The server hands `Alerts` a `SnapshotsOf` reader, which loads them with `readInvoiceSnapshots`.
- The need (`situationNeed`): `needs-approval` is `approve-held` for a first payment and `approve` for a replacement; `paid-twice` and `unrecognised-transfer` are `twice`; `bank-late` is `bank`; `ready-to-close` is `close`.
- `needs-decision` is `held` for a held invoice or one a person closed before, and `check` otherwise. `no-approvers` is `check`, `needs-callback` is `callback` and `needs-phone` is `phone`.
- `with-bank` is `outside` for a payout sent outside PayOnce, `callback` when the bank details are in question and a phone is on file, and `check` otherwise. Every other state needs nobody.
- While a person's approval is underway (`approvedUnderway`: approved and not expired, or used with its payment pending or in flight), only `approve`, `approve-held`, `bank` and `twice` stand (`needOf`). The approval every payment a person starts waits for (terms whose reason is `person-started`) does not count as underway (`underway`), so an invoice that goes to a person while that payment is with the bank alerts as it would without it.
- `twice` and `bank` are urgent. Their titles are "INV may have been paid twice" and "Bank deadline passed on INV". Every other title is the invoice and the need's words (`NEED_TITLES`).
- The fingerprint is the need, the reason without its floor clauses (`reasonText(withoutClauses(reason, FLOOR_CLAUSES))`), and for a request waiting for signoffs its action, amount, currency, `accountKey` and signoffs needed.
- The `NOT_TO_PAY_CLAUSE` stays in the fingerprint's reason.

### Other conditions

- `payout:<transfer id>` stands once for every outside payout tied to an invoice and every original of an `outside` invoice (fingerprint `found`).
- `run:<id>` stands while `runStatus` is `waiting-approval`, by binding and signoffs needed.
- `audit:invoices`, `audit:runs` and `audit:recon` stand when a chain breaks, a running hash is missing, does not match or started again, or an invoice, run or opened break has no line. They are checked once a minute (`auditConditions`).
- An audit alert's facts give `runningHash` (`matches`, `missing`, `does not match` or `started again`) and `withoutLine`. The message adds "With no line at all" only when that is above 0.
- `cash:<currency>` stands while the cash panel's `headroomMinor` is below 0.
- `inbox` stands while any upload waits for a person, with the count as its only fact. Its fingerprint is the newest upload's id in any state (`Ledger.inboxWaiting`).
- `outage:<id>` stands while an outage is active and for 24 hours after it ended, with its state as the fingerprint. It posts "Outage declared on USD LOCAL" once and "Outage on USD LOCAL ended" once, then clears with nothing posted.
- An outage alert's facts are the rail, the codes (labelled from `RAIL_FAILURE_CODES` in the message), payees, window, up to five short references, the times and how many invoices and runs it held. That count is its hold rows other than `counted`, as the Outages card lists them.
- An outage alert never names who ended it or their note. A reference outside `REFERENCE_PATTERN` is left out, and the Payouts field with it when none is left. The alert still posts.
- `contact:<beneficiary id>` stands while a person's proposed phone number waits for a second person (`waiting`), and for 24 hours after a person's number went on file. Its fingerprint is `waiting:<id>`, `set:<id>` or `changed:<id>`, so each posts once. A waiting proposal that someone failed to confirm has `waiting:<id>:mismatched:<n>`, `n` being its `mismatched_confirms`, so each confirmation that did not match posts it again.
- A contact alert's facts are the record's key (in its own form only, for the `#supplier/<key>` link), the supplier name as outside text, the field, whether it is a first number, a change or a removal, when, open payments and requests withdrawn, and `mismatched` only when a confirmation did not match. With `mismatched` the title is "A confirmation of a supplier phone number did not match", the message gives the count, and it is urgent.
- A contact alert never holds the number, an email domain or anyone's name. `changed` is urgent. Only rows a person made alert ([supplier-contacts.md](supplier-contacts.md#lines-alerts-and-display)).
- `recon` stands while any reconciliation break waits on a person (`reconCondition`, [reconciliation.md](reconciliation.md)). A break of a kind that clears by itself, such as a missing refund, never raises it, however long it stays open, since the Reconciliation page lists it apart from the breaks that need a person.

### Recording conditions

- Every 5 seconds `Alerts.evaluate` works out the conditions from ledger fields and records them, and `flush` claims the alerts that are due and posts them.
- `Ledger.recordConditions` (`AlertStore`) keeps the first condition found for each key. It reads the stored conditions, and when nothing is new, changed, back or gone it returns without writing.
- Otherwise it compares again in one `BEGIN IMMEDIATE` transaction and writes only the rows that changed.
- A new condition, a changed fingerprint, or a condition back more than 10 minutes after it cleared (a new episode) queues an alert with `INSERT OR IGNORE`.
- When that insert meets a `skipped` row for the same key, episode and fingerprint, the row is queued again with the facts as they are now, its tries and last error reset. A queued, sending, sent or failed row is left alone.
- A condition back within 10 minutes as it was queues nothing new, but an alert skipped while it was gone is queued again.
- On the first evaluation (both alert tables empty and no `meta.alerts_started_at`), every standing condition is recorded with no alert and `alerts_started_at` is set.
- That first evaluation queues one summary, only when a condition stands. With nothing standing, each later condition alerts on its own.
- The summary counts invoices waiting on a person, pay runs waiting for approval, active outages, emails in the inbox, broken audit trails, currencies below 0 and open reconciliation breaks that wait on a person.
- Before the first balance read, cash conditions are neither found nor cleared. The server's first check waits while that read runs (the cash callback answers `"reading"`).
- If the first balance read fails, the check goes ahead without cash, and the currency gets an alert of its own once a read works.

### Sending

- An alert is due 10 seconds after it is queued. `flush` posts up to four per 5-second check, 1.1 seconds apart.
- `claimAlert` reads first, then takes the oldest due alert, or one whose claim ran out, in one `UPDATE ... RETURNING`. The claim lasts 60 seconds, and only its holder can finish the alert (`finishAlert`).
- Before posting any alert but the summary, `skipStaleAlert` marks it `skipped` when its condition has cleared or no longer has the same episode and fingerprint. The check is inside that one `UPDATE`, and an alert it leaves alone is posted.
- A post is one `fetch` with `Content-Type: application/json` and no other header PayOnce sets, `redirect: "manual"` and an 8-second timeout, never through the Airwallex client. Discord gets `wait=true`.
- 2xx is sent. 429 waits `Retry-After` or Discord's `retry_after`, between 1 second and 15 minutes. A 5xx, network error or timeout waits 30 seconds times 4 to the power of (tries made less one). Five tries in all, then `failed`.
- A 3xx, a 400 or any other 4xx fails at once. 401, 403, 404 and 410 also stop this process posting until a restart, and queued alerts wait.
- `last_error` keeps the status with Slack's lower-case code or Discord's numeric `code`, and nothing else from the answer, not even Discord's `message`. For a network error or timeout it keeps Node's error text.
- The webhook address, its path and its query are cut out of every error and log line in every form `redactKey` cuts a key: URL-encoded, in either case, cut short, or with spaces or line breaks between its characters (`redact`, `redactKeys`).
- `GET /api/alerts` lists the 50 latest alerts with their titles and how they went, and never the address.

### Message text

- `alertMessage` builds one message (title, line, fields, link) from an alert's stored facts, and `payloadFor` shapes it with `slackPayload` or `discordPayload`. Times read as "28 Oct 2026, 15:05 UTC" (`utcText`).
- A title holds only PayOnce's words and identifiers that match `^[A-Za-z0-9-]{1,40}$`. Any other invoice id reads "an invoice" ("An invoice" at the start), and its alert links to the page root.
- Text PayOnce did not write (an `AlertText` with `outside` true: the supplier name, and the escalation reason, which can name other invoices or hold an Airwallex code) is an inline code span in both formats, after `defanged`.
- `defanged` drops every format character (Unicode `Cf`) and the rest of the tag block U+E0000 to U+E007F, makes the text one trimmed line (`trimmedLine` in `src/text/printable.ts`), and turns `://` into `[:]//`, a word-start `www.` into `www[.]` and a backtick into an apostrophe.
- Outside text with nothing left after that shows a placeholder in PayOnce's words, not a span: "(no name)" for a supplier, "(no reason recorded)" for a reason.
- The parts of a message's line are joined with a space, so a span never follows a letter directly. On Slack a span also has `&`, `<` and `>` escaped, as `slackText` escapes them. On Discord nothing inside a code span is read as markdown, a link or a mention. The only link is the one to the local page.
- Slack: `text` is the title only, then a `header` block (plain text, at most 150 characters), a section with the line, a section of up to 10 fields and a context block with the local link. `unfurl_links` and `unfurl_media` are false.
- On Slack every `mrkdwn` text object has `verbatim: true`. The `<url|text>` link to the local page still works.
- Discord: `username`, `content` (the title, markdown escaped), one embed (title, description with the bare local link, colour, fields, footer, timestamp) and `allowed_mentions: { parse: [] }`, with no embed `url`.
- `capped` escapes first and then cuts between whole characters, so no escape or surrogate pair is split and the result never passes its cap.
- The caps are the supplier 200 characters, the reason 600, any other value 300, and the title 150 on Slack and 256 on Discord. All sit inside Slack's 2,000 per field and Discord's 1,024 per field value and 6,000 per embed.
- The link is `http://127.0.0.1:<PORT>/#<invoice>`, `#run/<id>` for a run, `#supplier/<key>` for a contact alert, `#recon` for reconciliation's alerts, and the page root otherwise, the inbox alert included. It is never the tunnel's address.

### Balance reads

- While alerts are on, the server asks `BalanceCache` for a read when no read is 5 minutes old and it has not asked in 5 minutes (`alertCash` in `surfaces/http/main.ts`).
- Like every good balance read, each one runs `recordMissingFees` after it, which can read up to five more transfers.

## Why

- Alerts are built from ledger fields because an alert leaves the machine, and timeline lines hold email subjects, senders, Airwallex error text and the supplier's phone number.
- The need comes from `situationOf`, which the page and the supplier cautions read too, so they cannot disagree about what an invoice waits on.
- Most needs go quiet while an approval is underway because a person has already acted. A payment that may pay twice and a late bank are still news.
- The fingerprint leaves out the floor clause because the agent adds or drops it as the balance moves, and the floor alone should not alert an invoice again.
- The ask not to pay stays in the fingerprint, so a held invoice alerts again when the supplier's ask arrives even though its need is unchanged.
- The request's terms are in the fingerprint so that a request renewed on the same terms counts as the same need and does not alert again.
- `recordConditions` and `claimAlert` read before they write, so a check that finds nothing never waits behind a CLI holding the write lock.
- Keeping the first condition per key means a key found twice cannot fail the insert and roll the whole check back.
- Queuing a skipped row again lets a condition that goes from A to B before A posts, and then back to A, post B and then A.
- The first evaluation queues one summary so that a ledger with twenty standing conditions posts one message. From then on each new condition gets its own.
- The first check waits for the balance read, so a currency already below 0 when alerts are turned on joins the summary instead of getting an alert of its own.
- An alert waits 10 seconds before it is due, so a request opened a moment after an escalation replaces it before anything posts.
- The stale check sits inside the skip `UPDATE`. If another process records the condition back to the alert's fingerprint, either its write lands first and the alert posts, or it finds the alert skipped and queues it again.
- `last_error` keeps nothing from the answer but the status and a code because a receiver could repeat part of the token in its message.
- 401, 403, 404 and 410 stop posting because they mean the address is wrong or the webhook is gone, and posting again cannot help.
- A post is one plain `fetch` that follows no redirect, so no Airwallex token can ride along and no redirect can carry the post to another host.
- Outside text goes in code spans after `defanged`, so a supplier name from a pay run file or an outside payout cannot become a link, a mention or markup. The space before a span matters because Slack does not read a span that follows a letter as code.
- `verbatim: true` stops Slack from turning a bare URL, domain or channel name into a link or parsing a mention.
- The Discord embed has no `url` because Discord may refuse a loopback address there. `allowed_mentions` stops pings in any case.
- The link goes to 127.0.0.1 and never to the tunnel because the page has no login and works only on the machine running PayOnce, as every message says.
- The server reads balances with no page open so that the cash condition sees a falling balance while nobody is looking.
- Only phone numbers a person put on file alert, because a number the demo scenario or the one-off migration put there is no news. A changed number is urgent because a callback made on the old one no longer verifies bank details.
- A confirmation that did not match is urgent because it may be someone trying a number they do not have, or a proposal the confirmer's source contradicts ([supplier-contacts.md](supplier-contacts.md#why)).

## Edge cases

- An escalated payment whose own transfer is with the bank keeps a need: `callback` when the supplier's bank details are in question and a phone is on file, as a fraud signal while money is in flight, and `check` otherwise.
- An escalated invoice that is `reading-emails`, `renewing-request`, `paused-by-outage`, `approved`, `sending` or `closing` has no invoice condition. An outage that pauses it has an alert of its own.
- While a new phone number waits for a second person, `callbackBlocked` keeps the invoice out of `needs-callback`, so it alerts as `check` or `held`, and the `contact:` alert carries the proposal.
- `EMAILS_BEFORE_PAYMENT_REASON` is `held`, or `approve-held` once a request is open. `NOT_TO_PAY_REASON` and `PARTLY_UNREAD_REASON` are `check` until a request opens.
- A live transfer under `MISMATCHED_TRANSFER_REASON` is `unrecognised-transfer`, so `twice`, and `close` once it is paid. `MISMATCHED_FAILED_REASON` is `check`, or `held` when the invoice never sent a payment of its own or a person closed it before.
- A held invoice that gets the supplier's ask to hold is reworded with the clause, so its fingerprint changes and it alerts again with the same need.
- A recorded callback withdraws the open request and opens one for the new account, which usually needs two approvers. Its terms name another `accountKey` and another number of signoffs, so the invoice alerts a second time with the same need, "INV needs an approval", and the second alert's Account field says the request pays an account the original did not go to. That is on purpose: the approvers are asked to sign a different payment. A request renewed on the same terms does not alert again, and no request id is in the fingerprint.
- A summary queued before inbox, outage or reconciliation alerts existed has no count for them, and reads each as 0.
- Emptying both alert tables starts over with a summary only if `meta.alerts_started_at` is deleted too.
- After a 401, 403, 404 or 410 the process stops posting. Alerts still queued are sent after a restart if they still apply.
- Airwallex short references such as `P261028-F9233YT` always pass the outage alert's reference pattern.
- An outage alert's line gives the failure codes without their labels and the times without dates ("20:42 UTC"), so it stays well under the 200 characters a line part is cut at. Its fields keep the labelled codes and the full dates (`outageMessage`, [rail-outages.md](rail-outages.md)).
- A phone number a person takes off file alerts as `changed`, and its message says the number on file is being taken off.
- The MCP server uses `defanged` and `capped` from `alert-payloads.ts` for its own outside text.
- The page opens an alert's `#<invoice>` as that payment and `#recon` as reconciliation (`web/src/router.ts`), so links in alerts already posted still work.

Dated checks: [verification/alerts.md](../verification/alerts.md).

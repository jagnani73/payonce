# Uploaded emails

A person uploads a raw supplier email on the page. PayOnce parses it, matches it to invoices, and a person delivers it to one, where the reader reads it ([email-reader.md](email-reader.md)). The parser and the inbox are `src/intake/` (`eml.ts`, `html-text.ts`, `css-text.ts`, `intake.ts`, `parse-worker.ts`), the email's shape, the sender check and the evidence are `src/reader/emails.ts`, and the routes are `src/surfaces/http/routes/inbox.ts`.

## Rules

### The modules

- `parseEmail` (`eml.ts`) reads an uploaded raw email, as bytes, into the sender, Reply-To, subject, body, `styleText`, attachments (name, type, size), `notes` (fixed codes worded by `NOTE_TEXT`) and `partial`, or refuses it in PayOnce's own words.
- `eml.ts` also gives `cleanText`, `cleanLine`, `validAddress`, `validDomain` and `noteTexts`.
- `htmlToText` (`html-text.ts`) is the one-pass HTML scanner. It returns the text, `styleText`, and whether styles or markup could draw characters PayOnce cannot read.
- `scanCss` (`css-text.ts`) is the CSS tokenizer. It takes out every string and any text that is not CSS, and applies the fail-closed rule below.
- `intake.ts` gives `takeParsePlace`, `parseUpload`, `storeUpload`, `candidatesFor`, `invoiceIndex`, `deliverUpload` and the timeline lines for a delivery.
- `parse-worker.ts` is the worker thread `parseUpload` starts. It says it is ready, parses the one email it is sent, posts what `parseEmail` made of it, and is terminated.
- `src/reader/emails.ts` gives `SupplierEmail`, the `EmailReader` interface (a `name` shown beside the findings, and `read`), `EmailFindings` (the three findings), `summarise`, `unverifiedSenders`, `emailEvidence` and the fixture loader `loadEmails`.

### Uploading

- A person uploads an `.eml` file or pastes raw source on the page. There is no CLI for it.
- `parseEmail` works on bytes with no dependency and never throws on input.
- It refuses an email over 2 MiB (`MAX_EMAIL_BYTES`), an Outlook `.msg`, and text that is not raw source: the first line must be a header field, and the top headers must have a From, Subject or Content-Type.
- It refuses headers with no blank line within 64 KiB, over 256 KiB in all, more than 300 fields in one header block, or a From, Reply-To, Content-Type or Content-Transfer-Encoding field over 16 KiB.
- It refuses more than 32 parameters in one header, more than 100 MIME parts, multipart nesting deeper than 8, and a bad or colliding boundary.
- Every scan moves forward, and no regex can backtrack on a long run, so the work is linear. A style or script nested in one already read inside `<svg>` or `<math>` is not read again; it makes the email partial instead.

### The parse queue

- The server parses each upload with `parseUpload` in a worker thread, one at a time.
- At most four uploads wait behind the one being parsed. An upload takes its place (`takeParsePlace`) before its body is read, so a body still being read, up to 3 MB, counts as waiting too.
- The next upload is refused with 503, "PayOnce is reading other emails, try again in a moment" (`ParserBusyError`), before its body is read or anything is kept.
- The body of an email upload or a pay run file has 30 seconds to arrive (`UPLOAD_BODY_MS`). Past that `readJson` refuses it with 408, "The upload took more than 30 seconds to arrive, so PayOnce stopped reading it and kept nothing. Try again".
- A refused slow upload gives its place back, and the connection closes once the answer is sent. Any error answer sent before a request's body was read to its end closes the connection.
- The parse has a 2-second budget, counted from when the worker is ready, and a 256 MB heap limit (`resourceLimits`).
- Past either limit the worker is terminated, nothing is kept, and the upload is refused with "PayOnce gave up reading this email", the reason (time or memory) and what to do.

### Headers

- Headers are unfolded and raw UTF-8 is decoded. RFC 2047 words are decoded only in the subject, display names, file names and the From line as written (`fromAsWritten`, which is only shown).
- From and Reply-To use a strict ASCII grammar. Anything outside it gives `SENDER_UNREADABLE` or `REPLY_TO_UNREADABLE`, which the sender check flags.
- Outside the grammar: two From fields or two Reply-To fields, more than one From mailbox or more than five Reply-To mailboxes, groups, a quoted local part, an address literal, and anything outside ASCII.
- The display name is never compared. A client shows it, so both readers get it as `fromName`: the keyword check reads it with the subject, the model in a `<from_name>` tag. The page shows it beside the address in the From line, as text PayOnce did not write.
- The Sender header is ignored: only From and Reply-To are read and checked.

### Text and HTML

- Every text part is read, plain and HTML. A part is dropped only when it is identical to one already read once whitespace and case are collapsed, and a `multipart/alternative` that kept two gets `versions-differ`.
- Charsets go through `TextDecoder` under WHATWG labels, with four aliases. `utf-7`, `x-user-defined` and labels it refuses mark the part undecodable. Base64 decodes across early padding.
- Pasted source is UTF-8 for unencoded parts. `multipart/signed` reads its second part as the signature only for pgp and pkcs7 signature types.
- In HTML, script and style content is left out of the text, except inside `<svg>` and `<math>`, where it is read as text too.
- Comments end at `-->` or `--!>` or the end of input, nothing in them opens or closes an element, and their text is kept.
- Every string in a style block or `style=""` attribute (CSS escapes decoded), style text that is not CSS PayOnce can parse, and every script's text go to `styleText`. The model reads it in a `<text_found_inside_styles>` tag, and the inbox shows it under "Text inside the email's styles and scripts".
- A form field's text is read as `[form field: ...]`, beside an image's alt text: an `<input>`'s `value`, and the `placeholder` of an `<input>` or `<textarea>`.
- Inside `<svg>` and `<math>`, `<![CDATA[` is text up to its `]]>` or the end of input. Elsewhere it is a bogus comment.

### CSS fails closed

- One rule: anything CSS could make a client show that is not a string PayOnce took out makes the email partial. No special case is added beyond it.
- Under it: a `content` value with anything but strings, comments, `none`, `normal` or `!important`; `counter()`, `counters()` or `attr()` anywhere; an `@font-face` with `src`; `@counter-style`; `unicode-bidi` other than `normal`, and `<bdo>`.
- Also under it: a style or script nested in one already read inside `<svg>` or `<math>`; `@import`, a linked style sheet, or a URL in `url()`, `src()`, `image()` or `image-set()` outside the email (not `cid:`, `data:` or a fragment).
- Also under it: CSS left open, that is a comment, a string or an unquoted `url(` with no end.
- PayOnce does not reproduce a mail client's layout. Reordering (flex `order`, bidi in SVG, positioning) and list numbering can make what a person sees differ in order from what the reader gets.

### Partial emails

- `partial` is set by any note in `PARTIAL_NOTES`. Notes are codes kept outside the body.
- Size notes: text past 32,000 characters (`MAX_BODY_CHARS`), style text past 8,000 (`MAX_STYLE_CHARS`) and more than 16 text parts.
- Parts PayOnce does not read: a text part sent as an attachment, `text/calendar` and the like, a `message/*` part such as a delivery report, Outlook's TNEF `winmail.dat`, a forwarded `message/rfc822`, and encrypted or opaque-signed mail.
- Decoding notes: an undecodable part, an encoded header in a refused charset, and a Content-Type that cannot be parsed (`odd-type`: the part is read as plain text).
- Header notes: a skipped header line, and a line among the email's own headers that is not a field (`header-text`: that line and the lines after it, up to the blank line, are read as text, and those that are fields are read as fields too).
- Repeats: a repeated Content-Type or Content-Transfer-Encoding, and any parameter given twice in a Content-Type or Content-Disposition, a boundary, a charset or a file name among them.
- Also: a signed section with more than two parts, and the CSS rule above (`style-unreadable`).
- Attachments are listed by name, type and size from the encoded length, and never decoded, stored or opened. Links are never followed and images never loaded.

### Matching an upload to invoices

- `candidatesFor` reads the subject, the body and attachment names, never the sender, amount or supplier.
- Tokens with a digit (up to 5,000, each at most 128 characters), the same without a file extension, and a word followed by a number ("inv #5001") are looked up by `numberOf` keys, so exact is `sameNumberExactly` and near is `sameInvoiceNumber`.
- `candidatesFor` takes an `InvoiceIndex` from `invoiceIndex`, so several uploads matched against one ledger share one index.
- Exact matches rank first, then the subject before the body before attachment names. Each candidate says whether the email's sender passes the check against that invoice's supplier domain.
- An invoice is suggested only when exactly one invoice matches, in any state, that invoice is open or escalated, and its number was not found as all digits next to other digits.
- Nothing is delivered by itself. A person presses Deliver beside the suggestion ("Deliver to INV-..."), beside another candidate, or after typing another invoice number (`web/src/screens/inbox/Item.tsx`).

### Delivering

- `deliverUpload` runs in the invoice's turn. `Ledger.deliverUpload` moves the upload from waiting to delivered, adds the email and makes an open or escalated invoice's next look due, in one transaction.
- The timeline then says who uploaded and delivered it, the sender and Reply-To check, text nobody read, another invoice it names, and an upload with the same Message-ID. For a closed invoice it says the email is on file and does not reopen it.
- In those lines PayOnce's words come first and the email's subject last.

### What a delivered email adds

- Each new email is read on its own and ORed with the stored findings, so findings only ever add caution.
- The timeline line says what the emails read in that look found ("Read 1 new email: ..."), and, when that differs, the invoice's findings so far.
- The `asksNotToPay` finding (hold, cancel or not pay, sent in error, paid another way) escalates. An email with `partial` escalates with `PARTLY_UNREAD_REASON`, "part of a supplier email could not be read".
- While `asksNotToPay` is on file, the escalation reason names it: `namingNotToPay` (`src/engine/reason-text.ts`) joins `NOT_TO_PAY_CLAUSE` last, "<reason>, and the supplier asks to hold, cancel or not pay this invoice", unless the reason already leads with or names the ask.
- For a replacement the clause is added in `withFloorReason`, after the floor and second-bill clauses, and in the terms `requestedDecision` rebuilds. It adds something only when a payout sent outside PayOnce or new bank details came first in the policy.
- `assess` adds the clause to the decision line as well. The floor and second-bill clauses stay off that line.
- For a held invoice, `continueHeld` rewords the stored reason with `Ledger.rewordEscalation`, which changes only an invoice still escalated with the reason the look read, and writes a decision line.
- When `rewordEscalation` changes nothing, another process changed the invoice since the look read it, so the look opens no request on the old reason and comes again at once.
- The approval request, the alert and the approval card then name the ask, and a person can still approve paying. Without the finding nothing is added.
- An invoice with no supplier domain on file (a pay run row without `supplier_domain`, a found payout) flags every sender (`unverifiedSenders`).
- An invoice with any email on file before its first payment is held for a person (`EMAILS_BEFORE_PAYMENT_REASON`), pay run rows waiting their turn included.
- A held invoice reads its emails in `continueHeld` and opens no request until they are read. It looks again a minute later after a reader failure, or at once when another process delivered an email while the others were being read.
- A held invoice's `HeldPaymentTerms.evidence.emails` carries the evidence, added only when it has emails.
- `emailEvidence` in approval terms is the findings' summary, the number of emails on file, how many have text PayOnce could not read and how many senders the check flags. It names no address. Every new email changes it, so it voids an open approval.
- The approval card and `pnpm approve` show the evidence for a held invoice as for a replacement. `pendingClose` gives it as `CloseReview.emails`, which the close card and `pnpm close` show.
- `useApproval`, `releaseFor` and the automatic replacement's transaction spend nothing when the invoice's email count differs from the one the look assessed.

## Why

- Parsing is bounded and linear because an upload is bytes from anyone, so no input may cost more than linear work or pass the limits above.
- The parse runs in a worker with a time budget and a heap limit so that a slow path nobody has found yet refuses one upload instead of stalling the dispatcher, the watcher and the page.
- Two seconds leaves plenty of room. The slowest 2 MiB case, an unclosed style full of strings, parses in about 200 ms (215 ms at most measured). Starting a worker takes about 0.1 s, and through the worker the worst cases answer in 430 to 470 ms.
- An upload takes its place before its body is read because each waiting upload holds its bytes, and a body still being read holds up to 3 MB.
- The body gets 30 seconds, so a slow sender holds a place for at most 30 seconds instead of Node's five-minute request timeout.
- Only From and Reply-To are read, in ASCII, because the sender check works on addresses. Lower-casing outside ASCII can fold a letter into ASCII (the Kelvin sign becomes k), so an address outside the grammar is flagged instead of compared.
- The display name is read but never compared. A client shows it to a person, so the readers read it like the body.
- CSS fails closed because any character a client could draw that PayOnce did not take out as text is text the reader never saw.
- Not reproducing a client's layout is safe because no protection depends on rendering: bank details change only through a callback to the number on file, the sender check works on addresses, approvals bind the account read from Airwallex, and findings only add caution.
- Notes are codes kept outside the body so that a sender cannot forge one.
- The ask-not-to-pay clause is added only with the finding, so every other invoice keeps its terms and its binding.
- The floor and second-bill clauses stay off the decision line because their standing warnings already say them.
- The look comes again after a failed reword because terms built on the reason it read would open a request the next look voids.
- Held terms carry email evidence only when the invoice has emails, so other held invoices keep their binding.
- The evidence counts the emails so that every new email voids an open approval and the approvers look again.
- With no supplier domain on file every sender is flagged, because there is nothing to check a sender against.

## Edge cases

- A `<style>` with no closing tag is not partial by itself. Its content runs to the end of the input and is read as text, and the rest of the input is scanned as CSS once, at the first such style, under the fail-closed rule.
- Outlook's `@font-face` blocks with only `font-family` and `panose-1` do not make an email partial. Font names in `styleText` cost nothing.
- An `odd-type` part is read as plain text, so HTML in it skips the CSS rule.
- An email already in the inbox is refused (`DuplicateUploadError`), naming the upload it matches and where it went.
- An email delivered to a closed invoice stays on file and does not reopen it.
- A replacement request opened before the email count existed is replaced once. Its timeline line says only why the request no longer matches, and the step that withdraws it, opens a new one or ends approvals given on it says so, once.
- A held invoice whose reason PayOnce does not recognise still gets the clause, as text ([reasons.md](reasons.md)).
- The page can put first the invoice the inbox was opened from, and says so.

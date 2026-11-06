# Outbox

The outbox drafts messages for a person to send to the supplier or to Airwallex. PayOnce never sends them. The code is `src/outbox/drafts.ts` (the templates, `outboxOf`, `createDraft`, `markDraft`, `textHash`, `MOVES_FROM`), the `outbox` table in `src/store/drafts.ts`, `pnpm outbox` (`src/surfaces/cli/outbox.ts`), the routes in `src/surfaces/http/routes/outbox.ts` and the payment page's Messages tab (`web/src/screens/payment/messages.tsx`). It leans on the reason codes ([reasons.md](reasons.md)), the phone on file ([supplier-contacts.md](supplier-contacts.md)), the route advisory ([route-advisory.md](route-advisory.md)) and reconciliation's breaks ([reconciliation.md](reconciliation.md)).

## Rules

### What a draft is
- A draft is a message for a person to send to the supplier or to Airwallex (audience `supplier` or `bank`). PayOnce never sends one.
- Marking a draft sent changes nothing else: no invoice state, no approval, no money (`markDraft`).
- A draft has no recipient address. The page and `pnpm outbox` say to send it to the contact on file.
- There are six templates in `TEMPLATES`, each a facts function, a suggestion rule and a renderer: `payment-sent`, `replacement-sent`, `checking`, `callback-notice`, `bank-trace` and `refund-trace`. `isTemplate` and `templateLabel` check a stored name.

### Facts
- A draft is rendered only from facts PayOnce formats itself: the invoice number, the amount (`invoiceMoney`), dates written out ("28 October 2026"), `in flight` or `paid`, and the last four digits of the phone on file.
- The bank's short references go in only as `REFERENCE_PATTERN`, Airwallex's status only as `STATUS_PATTERN`, and the method only as `LOCAL` or `SWIFT` (`METHOD_PATTERN`). Otherwise the line is left out.
- A draft never holds the supplier name, email text, the reader's findings text, model output, an escalation reason, approver names or account details.
- The phone ending comes from `Obligation.supplierPhone`, which reads the supplier record's phone on file ([supplier-contacts.md](supplier-contacts.md)).
- Supplier drafts never show PayOnce's bank deadline. A payment still with the bank gives the route advisory's latest usual day from `attempts.arrival`, and says a public holiday can make it later.
- With no advisory, a supplier draft says "within the usual time for this route". "Sent on" is the advisory's `from` day, else the day of `bank_created_at`.

### Templates
- `payment-sent` fits when the original is with the bank or paid. It is suggested when the supplier reports non-receipt.
- `replacement-sent` fits when a replacement is with the bank or paid after a failed original, and is always suggested. It names the day of the callback in the approval the replacement was sent on, if any.
- `checking` fits an open or escalated invoice with emails on file and promises nothing. It is suggested on an escalated invoice unless `payment-sent` or `callback-notice` is suggested.
- `callback-notice` fits an open or escalated invoice with a phone on file when the findings say the supplier asks for new bank details or the reason's code is about bank details (`aboutBankDetailsReason`). It is always suggested.
- `callback-notice` says PayOnce calls the number on file before paying any other account, and asks the supplier not to send bank details by email or in a reply. Without a phone it is listed in `notOffered`, with why.
- `bank-trace` fits when an attempt is in flight (`inFlight`) past its bank deadline (`pastDeadline`, `deadlineMinutes` of the invoice's method). It is always suggested.
- `bank-trace` gives the reference, invoice, amount, the transfer's creation time and status, the method, and on a cross-currency invoice what the transfer took from the wallet. It gives no deadline.
- `refund-trace` (audience `bank`) fits when reconciliation has an open `refund-missing` break on one of the invoice's own transfers, matched by `attempts.transfer_id` only (`ReconStore.refundBreaks`). The latest such attempt wins. It is always suggested.
- `refund-trace` fits a settled or rejected invoice too.
- `refund-trace`'s facts are `reference` (the attempt's, else the stored transfer's short reference), `debited` (the break's `expectedMinor` and `currency` through `formatMoney`), `status` (the stored transfer's), `failedDay` (`failedBy`, on this machine's calendar) and `method`.
- `debited` goes in only as a positive whole number and three capital letters. With no reference in its form, `refund-trace` does not fit.
- `refund-trace` never takes the invoice number, a name, a reason, the break's other facts or note, or anything else Airwallex wrote.
- Once the newest such break is `explained`, `refund-trace` no longer fits because "a person explained the missing refund in reconciliation". Once it is `cleared`, because "reconciliation no longer finds the refund missing".

### Offers
- `outboxOf` gives the drafts on file as `DraftView`s, the `DraftOffer`s that fit now, `notOffered` and `withheld`. It is a pure read: nothing is drafted until a person asks. Suggested offers come first.
- A template with an open draft (`draft` or `copied`) is not offered again.
- A template whose last draft marked sent had the same facts JSON is not offered again (`sentAlready`).
- While the findings say the supplier asks to hold, cancel or not pay, each supplier message that fits goes to `withheld` instead of `offers`, not suggested. Only the bank messages stay in `offers`.
- A person can still draft a withheld message: `createDraft` takes it as it takes any offer.

### Drafting and moving
- `createDraft` renders the template once and stores the text, its facts and `textHash` with the timeline line in one transaction. `textHash` is SHA-256 of the JSON `{template, subject, body}`.
- A draft of a template that does not fit now is refused (`DraftNotFitError`, 422), and so is a second draft of a template with one open (409 with `draftId`).
- `MOVES_FROM` says which states each move takes: `copied` from `draft`, and `sent` and `dismissed` from `draft` or `copied`. Any other move is refused (`DraftMoveError`, 409).
- Copying a copied draft again records nothing. Only a copy may go unnamed. Every other name goes through `personName`.
- Each read hashes the stored text again (`intact`) and works the facts out again. `changed` lists each fact that differs, and `noLongerFits` says why the template no longer fits.
- A person can mark a stale draft sent. The sent line then says what changed since it was drafted.

### Timeline lines
- Lines are kind `outbox` with topic `outbox:<id>`, appended by `DraftStore` inside the transaction that writes the draft. They are standing lines.
- The lines: `Draft N for the supplier created by NAME: "LABEL". Text SHA-256 HASH. PayOnce does not send it`, `Draft N copied by NAME` (or `Draft N copied`), `Draft N marked sent by NAME. PayOnce did not send it`, and `Draft N dismissed by NAME: NOTE`.
- The draft's text is never on the timeline.

### Where people see it
- `pnpm outbox <INVOICE>` lists the drafts, the messages that fit (suggested ones marked), what is not offered and why, and the withheld messages as "held back". Its `draft` takes a withheld template too.
- `pnpm outbox <INVOICE> show <DRAFT>` prints the draft, its hash, a warning when the text no longer matches, and what changed since or why it no longer fits.
- The Messages tab lists the suggested offers with "Draft it", then "Other messages that fit", then the withheld messages under a line saying the supplier asked to hold, cancel or not pay.
- Each draft on the tab shows who drafted, copied, marked sent or dismissed it, its subject and body as outside text (`Theirs`), whether the text matches its hash, and what changed or why it no longer fits.
- Copy text puts the subject and body on the clipboard. When the browser refuses, it says to select the text instead. The first copy is recorded while the draft's `can.copy` allows it.
- Mark as sent and Dismiss (an optional note up to 200 characters) need a name. The name field starts from the name the page keeps.
- The tab uses no inline script or style, so it works under the page's Content-Security-Policy (`default-src 'self'`).

## Why

- A draft has no recipient address, so nobody replies to a look-alike thread by mistake.
- A supplier draft gives no bank deadline, because PayOnce's deadline is minutes in the sandbox, and it is PayOnce's own clock, not a promise of arrival.
- A draft holds only formatted facts because it goes to someone outside PayOnce. It carries nothing an email, a model or Airwallex wrote that could hold an instruction or a lie, and nothing that names an approver or an account.
- Outbox lines are standing lines. A line with a topic says how things stand, so the next look does not repeat its decision because a draft was made.
- The draft's hash goes on the chained line because the draft text lives in a table PayOnce can rewrite. With its hash on the hash-chained timeline, an edit to the text shows.
- A message already sent is not offered again with the same facts. It is offered again only once something it says has changed.
- A cleared refund break does not say the money landed, because a break also clears when only part of the money comes back (a `refund-differs` break then opens), or when the debit drops out of the balance history a check reads.

## Edge cases

- When a draft's text is edited in the file, every read shows the hash warning. The created line keeps the hash the draft was made with, and `pnpm run audit` still verifies the chain.
- For a template PayOnce no longer has, as in an edited ledger, `templateLabel` gives null, the draft shows its stored template name, and it no longer fits because "PayOnce no longer has this template".
- With no phone on file, a bank-details invoice lists `callback-notice` in `notOffered`, because there is no number to call back on, and the supplier should not be asked to send bank details by email.
- With no creation time on file, a payment in flight counts as past its deadline when the reason's code is a deadline code (`deadlineReason`).
- A transfer that is not the invoice's own gets no `refund-trace`, whether it is a transfer kept beside another invoice's attempt, a payout sent outside PayOnce or another invoice's transfer.
- When the method is not LOCAL or SWIFT, such as one edited in SQL, both bank drafts leave the method line out.
- When the payment is paid while a draft is open, the draft shows "the payment status changed from in flight to paid". A failed trace payment shows that the draft no longer fits.

Dated checks: [verification/outbox.md](../verification/outbox.md).

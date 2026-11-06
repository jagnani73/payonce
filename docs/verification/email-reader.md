# Email reader: dated checks

How the rules in [design/email-reader.md](../design/email-reader.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-10-06: Gemini's endpoint and models

Found by running it on 2026-10-06:

- The key goes in `Authorization: Bearer`. A strict `json_schema` response format and `reasoning_effort: "low"` are accepted, and a good answer has `finish_reason` `stop`.
- `gemini-3.8-flash`, the model in Google's examples, answered 503 "high demand" on 5 of 8 calls. In about 35 reader calls, `gemini-3.5-flash` and `gemini-3.1-flash-lite` between them always returned an answer, usually in 1.6 to 5.8 seconds. `gemini-3.5-flash-lite` took 8 to 18 seconds. The 2.5 models return 404 for new users.
- `gemini-3.5-flash` returns 429 after about six calls in a minute and answers again a minute later. The second model answered each time. Daily limits are shown only in AI Studio.
- Both default models gave the expected findings on the two fixtures, a reworded email the keywords miss, a thank-you email and an email with an injected instruction to answer false. The one difference: `gemini-3.5-flash` once read the injection email as a non-receipt claim.
- One "new account" incident on the page took 21 seconds, against 8 with the keyword reader. Its first read took 12 seconds, before the timeout was cut from 15 seconds to 8.

## 2026-11-06: Claude on the Messages API

Measured on 2026-11-06, with about 30 calls to Anthropic's API in all, on a copy of the main ledger with `AWX_BASE_URL` at `sandbox.invalid`, and with stubbed services:

- The Messages API took `anthropic-version: 2026-10-21`, `output_config` with low effort and a `json_schema` format, and a user-linked key in `x-api-key`. Every answer was one text block with `stop_reason` `end_turn` and 41 output tokens, none of them thinking tokens, on both models.
- The reader ran through `ModelReader`, one email at a time, on the same kinds of email as on 2026-10-06: `nothing-arrived`, both emails of `new-account`, `moved-banks`, a reworded email the keywords miss ("still no trace of the funds", "route this and future remittances to the account we hold at our other bank"), a thank-you email, and an email asking to be paid at another bank with a note telling the assistant the system expects false for all three. Both models gave the same answers on all seven, before the keyword OR: non-receipt for `nothing-arrived` and the first `new-account` email; non-receipt and new bank details for the second `new-account` email (its subject says the payment was not received), `moved-banks` and the reworded email; nothing for the thank-you; and new bank details alone for the injection email, whose note neither model obeyed.
- Latency per read: `claude-haiku-5-5` took 1.1 to 2.1 seconds over 14 reads, with a median of 1.4, and `claude-sonnet-5-5` 1.7 to 2.9 seconds over 7. Both are well inside the 8 second timeout. Haiku goes first because it was as accurate as Sonnet and faster, at a twentieth of Sonnet's price per token. Sonnet is second, so a busy Haiku does not send the email to Gemini.
- Fallback through the engine on the ledger copy, with an invoice held before paying, one email on file and no payment: with a bad `CLAUDE_API_KEY`, `claude-haiku-5-5` answered 401, `claude-sonnet-5-5` was not asked, and `gemini-3.5-flash` read the email (`readBy` `gemini-3.5-flash`). With both keys bad, Gemini answered 400 for its key, the thread was marked unread, the invoice waited on a person, and the timeline said "claude-haiku-5-5 refused the key (401), then gemini-3.5-flash refused the request (400), then gemini-3.1-flash-lite refused the request (400)". Ask why passed that line with the model names kept. With both keys good, `claude-haiku-5-5` read it.
- With only `READER_API_KEY` set, the reader and explainer from main and the ones here got the same fake `fetch`. They sent the same URL, headers and body, gave the same outcome and wrote the same console lines. That held for an answer, 503 then an answer, a 401 that echoed the key, 429 from both models, a timeout then no connection, and a body that was not JSON then `length`, on the default endpoint and on a custom base URL and model list.
- On a stub, a Claude 401 that echoed its key as written, URL-encoded, in base64, upper-cased and cut short, and a Gemini 503 that echoed both keys, reached the console as `[key]`. A 529 read as busy, `max_tokens` as cut and `refusal` as incomplete, and a thinking block before the text was passed over.
- No key value turned up in any command's output, the server logs, the ledger copy or the diff.
- Redirects, after a review: `READER_BASE_URL` pointed at a loopback server that answered 307 to a second loopback server. A plain fetch to the first followed the redirect and handed the second `x-api-key` and the body. The reader failed with "gemini-3.5-flash could not be reached, then gemini-3.1-flash-lite could not be reached", and the second server received nothing. A Claude-shaped service pointed at the first server failed the same way, and again nothing reached the second.

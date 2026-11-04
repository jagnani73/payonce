# Email reader

This is one of PayOnce's design notes. [CLAUDE.md](../../CLAUDE.md) has the commands, the file map, the rules that hold everywhere and the index of these notes. Where the two differ, this file is right.

- `READER_API_KEY` in `.env` turns the model reader on. `READER_BASE_URL` defaults to Gemini's OpenAI-compatible endpoint. `READER_MODEL` is a comma-separated list tried in order and defaults to `gemini-3.5-flash,gemini-3.1-flash-lite`, both on Google's free tier.
- `pnpm dev` loads no env file, so it always uses the keyword placeholder.
- "Ask why" uses the same key, base URL, model list and timeout (see Ask why). One ask is at most one request per model, and the page's limits leave most of the free tier's calls a minute to the reader.
- The request is one chat completion per email with `reasoning_effort: "low"` and a `json_schema` response format. The model answers three booleans (`claimsNonReceipt`, `asksForNewBankDetails`, `asksNotToPay`) and no text. `toAnswers` checks the answer again, so a service that ignores the schema still cannot return anything else. The display name, Reply-To, the text found inside styles, attachment names and PayOnce's notes go in tags of their own, and the prompt says nothing in the sender's tags comes from PayOnce.
- `summarise` in `src/emails.ts` writes the summary from the findings for both readers, so no wording from an email or a model reaches the approval card or the approval binding.
- `ModelReader` also runs the keyword check and ORs the findings. Every finding only makes the policy more cautious, so a tricked model cannot remove a finding the keywords make. It can still hide one the keywords miss. The keyword check reads the display name, subject, body, style text and attachment names after `keywordText`: blank-looking letters become spaces, default-ignorable characters go, NFKC, straight apostrophes and one space for every whitespace run, so wrapped lines and curly apostrophes match.
- Each model gets one request with an 8 second timeout. If it fails, the next model is asked, and the console gets a `reader` line saying why. A refused key (401 or 403) stops at once. If every model fails, `read` throws `ModelReadError`, the engine marks the thread unread with a timeline line that says what each model did in PayOnce's words, and the policy escalates.
- Findings carry `readBy`, the model that answered, and the page shows it.
- The API key is cut out of any error text before it reaches the timeline, in every form `redactKey` cuts.
- Google may use free-tier content to improve its products. The fixtures are synthetic. The page's "Supplier email" card says so next to the upload, and names the reader.

Found by running it on 2026-10-06:

- The key goes in `Authorization: Bearer`. A strict `json_schema` response format and `reasoning_effort: "low"` are accepted, and a good answer has `finish_reason` `stop`.
- `gemini-3.8-flash`, the model in Google's examples, answered 503 "high demand" on 5 of 8 calls. In about 35 reader calls, `gemini-3.5-flash` and `gemini-3.1-flash-lite` between them always returned an answer, usually in 1.6 to 5.8 seconds. `gemini-3.5-flash-lite` took 8 to 18 seconds. The 2.5 models return 404 for new users.
- `gemini-3.5-flash` returns 429 after about six calls in a minute and answers again a minute later. The second model answered each time. Daily limits are shown only in AI Studio.
- Both default models gave the expected findings on the two fixtures, a reworded email the keywords miss, a thank-you email and an email with an injected instruction to answer false. The one difference: `gemini-3.5-flash` once read the injection email as a non-receipt claim.
- One "new account" incident on the page took 21 seconds, against 8 with the keyword reader. Its first read took 12 seconds, before the timeout was cut from 15 seconds to 8.

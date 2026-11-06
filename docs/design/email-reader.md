# Email reader

How PayOnce reads a supplier email into three findings, with a model or with the keyword placeholder. The reader is `src/reader/` (`reader.ts`, `model-service.ts`, `model-reader.ts`, `keyword-reader.ts` and `reader-error.ts`), and the engine's side is `readNewEmails` in `src/engine/emails.ts`. Uploads are parsed before they are read ([uploaded-emails.md](uploaded-emails.md)), Ask why shares the model services ([ask-why.md](ask-why.md)), and invariant 57 in [invariants.md](../invariants.md) is the money rule.

## Rules

### Which reader reads

- `CLAUDE_API_KEY` turns Claude on, with the models in `CLAUDE_MODEL`, a comma-separated list that defaults to `claude-haiku-5-5,claude-sonnet-5-5` (`DEFAULT_CLAUDE_MODELS`).
- `READER_API_KEY` turns the chat completions service on after Claude, with the models in `READER_MODEL` (default `gemini-3.5-flash,gemini-3.1-flash-lite`, `DEFAULT_GEMINI_MODELS`, both on Google's free tier).
- The chat completions service is at `READER_BASE_URL`, which defaults to Gemini's OpenAI-compatible endpoint (`DEFAULT_GEMINI_BASE_URL`).
- With only one key, only that service is asked. With neither, the keyword placeholder reads the emails (`readerFor`).
- `modelServicesFromEnv(env, use)` builds the services in the order they are asked, each left out without its key. `src/settings.ts` builds them once for the reader and once for Ask why (`Settings.models.readerServices`, `askServices`).
- Ask why uses the same services, timeout and `READER_MODEL`, but takes its Claude models from `CLAUDE_ASK_MODEL`, which defaults to `claude-sonnet-5-5,claude-haiku-5-5` (`DEFAULT_CLAUDE_ASK_MODELS`, [ask-why.md](ask-why.md)).
- One ask is at most one request per model, and the page's limits leave most of the free tier's calls a minute to the reader.
- `pnpm dev` always reads with the keyword placeholder: `surfaces/cli/dev.ts` builds a `KeywordReader` and loads no env file.
- `readerNamesFromEnv` gives every name stored findings may give for whoever read an invoice's emails: the models in `CLAUDE_MODEL` and `READER_MODEL`, both services' default models and the keyword placeholder.

### One request

- A request to a model is one plain `fetch`, with no SDK (`complete`). A `ModelService` is Anthropic's Messages API at the fixed `CLAUDE_URL` (`claudeService`), or an OpenAI-compatible chat completions endpoint (`chatService`).
- Claude gets one Messages API request per email: `POST https://api.anthropic.com/v1/messages` with `x-api-key`, `anthropic-version: 2026-10-21` (`ANTHROPIC_VERSION`) and `max_tokens` 4,000.
- The Claude body puts the system prompt in `system` and sends `output_config` with `effort: "low"` and a `json_schema` format. It sends no `thinking` setting.
- A good Claude answer has `stop_reason` `end_turn`, and its text blocks are read by type. `max_tokens` is a cut answer, and any other stop reason, `refusal` included, an incomplete one.
- Gemini gets one chat completion per email, with the key in `Authorization: Bearer`, `reasoning_effort: "low"` and a strict `json_schema` response format. A good answer has `finish_reason` `stop`, and `length` is a cut answer.
- No request follows a redirect. `complete` passes `redirect: "error"`, a redirect fails the request, and `tryOf` reads it as could not be reached.
- Each model gets one request with an 8-second timeout (`REQUEST_TIMEOUT_MS`).
- `firstAnswer` asks each service's models in order and returns the first answer its `parse` accepts, with the model that gave it, or every try.
- A refused key (401 or 403) skips the rest of that service's models, and the next service is asked. An overloaded service, 503 from Google or 529 from Anthropic, counts as busy.
- `ModelError` is an error status. `ModelAnswerError` is an answer PayOnce cannot use: `cut` on its token budget, `incomplete` when stopped for another reason, or `unusable` when it is not what was asked for.
- `serviceView` is what a view is told about a service: its models, its host, whether it is Claude and whether it is Google's free tier, never its key.

### What a model may answer

- The model answers three booleans (`claimsNonReceipt`, `asksForNewBankDetails`, `asksNotToPay`) and no text. `toAnswers` checks the answer again, so a service that ignores the schema still cannot return anything else.
- The display name, Reply-To, the text found inside styles, attachment names and PayOnce's notes go in tags of their own. The prompt says nothing in the sender's tags comes from PayOnce, and `<` and `>` are escaped so an email cannot close its tag.
- `summarise` in `src/reader/emails.ts` writes the summary from the findings for both readers, so no wording from an email or a model reaches the approval card or the approval binding.
- `ModelReader` also runs the keyword check and ORs the findings.
- `KeywordReader` is the fallback reader. It matches a handful of phrases for each finding and understands nothing else, and its findings name it "keyword placeholder" (`KEYWORD_READER_NAME`).
- The keyword check reads the display name, subject, body, style text and attachment names after `keywordText`: blank-looking letters become spaces, default-ignorable characters go, then NFKC, straight apostrophes and one space for every whitespace run.
- The engine gives the reader one email at a time and ORs each read into the stored findings (`readNewEmails`).
- When every model fails, `read` throws `ModelReadError`. The engine marks the thread unread with a timeline line saying what each model did in PayOnce's words, the policy escalates, and the next look reads from the email that failed.
- Findings carry `readBy`, the model that answered. The payment's emails and the inbox show it.

### Failures in PayOnce's words

- `reader-error.ts` gives `ModelTry`, `tryText` and `triesText`, which say what each model did in fixed words that hold no text from the service, from `MODEL_FAILURE_WORDS` in `src/text/words.ts`.
- The words: was busy (503 or 529), was over its request limit (429), refused the key (401 or 403), refused the request, had an error on its side, timed out after 8 s, cut its answer short, stopped before its answer was complete, gave an answer PayOnce could not use, could not be reached, gave no answer.
- `reader-error.ts` imports only `words.ts`, so the engine reads a reader failure without importing the reader.
- A model that fails prints a `reader` line saying why, with every key cut out of the service's text in every form `redactKey` cuts (`redactKeys`, [airwallex-client.md](airwallex-client.md)). The timeline gets only `triesText`'s words.

### What the page says

- Settings' "Email reader and Ask why" section names the model reader's models in order, or says the keyword reader reads because no model key is set (`views/settings-view.ts`).
- Settings show a caution that Google may use what it reads when a model on Google's endpoint is in the reader's chain, from `ModelReader.views`, which lists where the emails go, service by service.
- The inbox's upload card shows the same caution whenever a model reader is on (`views/inbox.ts`).

## Why

- The key is `CLAUDE_API_KEY`, not `ANTHROPIC_API_KEY`, because Claude Code reads `ANTHROPIC_API_KEY`, and a key under that name in Yash's shell would switch Claude Code to it.
- Claude gets low effort and no `thinking` setting because at low effort the models skipped thinking, and one body then works on both Haiku 5.5 and Sonnet 5.5. Sonnet 5.5 refuses `disabled` and Haiku 5.5 refuses `between_tools`.
- Neither Claude list should name a model that rejects `effort`, such as Haiku 4.5 or Sonnet 4.5. It answers 400, which counts as a refused request, and the next model is asked.
- Claude's text blocks are read by type because a thinking block can come first.
- No request follows a redirect because fetch would otherwise carry `x-api-key` and the email or the facts to the host the redirect names, dropping only `Authorization`.
- The model answers three booleans and no text, so a tricked model can change those answers and nothing else, and each finding only makes the policy more cautious.
- The keyword check is ORed in so that a tricked model cannot remove a finding the keywords make. It can still hide one the keywords miss.
- `keywordText` normalises the text so that wrapped lines and curly apostrophes match, and blank-looking or invisible characters cannot break up a phrase.
- The engine reads one email at a time so that an instruction in one email cannot change how another is read.
- A refused key skips the rest of its service because that service's models share the key.
- Each service has a second model because free-tier capacity comes and goes, and one busy model should not send an incident to a person. Sonnet is Claude's second so that a busy Haiku does not send the email to Gemini.
- The reader asks Haiku first because it was as accurate as Sonnet and faster, at a twentieth of Sonnet's price per token. Measured reads took 1.1 to 2.1 seconds on Haiku (median 1.4) and 1.7 to 2.9 on Sonnet.
- Gemini's defaults are `gemini-3.5-flash` and `gemini-3.1-flash-lite` because between them they always answered, usually in 1.6 to 5.8 seconds.
- The other Gemini models did worse. `gemini-3.8-flash`, the model in Google's examples, answered 503 "high demand" on 5 of 8 calls, `gemini-3.5-flash-lite` took 8 to 18 seconds, and the 2.5 models return 404 for new users.
- The timeout is 8 seconds because reads on the default models usually took 1 to 6 seconds, and a model that hangs then holds the look for at most 8 seconds before the next one is asked.
- Ask why's page limits leave room for the reader because `gemini-3.5-flash` returns 429 after about six calls in a minute and answers again a minute later. Daily limits are shown only in AI Studio.
- The page warns about Google's free tier because Google may use free-tier content to improve its products. The fixtures are synthetic.

## Edge cases

- A service that ignores the schema can add fields, and only the three booleans are kept. An answer that is not JSON or lacks one of them is `unusable`, and the next model is asked.
- A service that echoes a key in an error, as written, URL-encoded, in base64, upper-cased or cut short, reaches the console as `[key]`.
- With every key refused, the thread is marked unread and the invoice waits on a person. The timeline line names each model and what it did, such as "claude-haiku-5-5 refused the key (401), then gemini-3.5-flash refused the request (400)".
- Findings saved before `asksNotToPay` existed have none, which reads as false.
- Findings saved before the read count was kept cover the whole thread.
- A `READER_BASE_URL` that does not parse names its host as "the address in READER_BASE_URL".

Dated checks: [verification/email-reader.md](../verification/email-reader.md).

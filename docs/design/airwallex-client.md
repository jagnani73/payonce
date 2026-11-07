# Airwallex client

PayOnce reaches Airwallex through one HTTP client and one module per API area, all in `src/airwallex/`, with secret redaction in `src/text/redact.ts`. `src/airwallex/` is frozen code, and this note describes it as it is. `Settings.airwallex.client()` in `src/settings.ts` builds the client. Invariants 64 and 65 in [invariants.md](../invariants.md) are the guarantees, [architecture.md](../architecture.md#text-payonce-did-not-write) shows where Airwallex's words are cleaned, and [sandbox-behaviour.md](sandbox-behaviour.md) has what Airwallex does.

## Rules

### Hosts

- `SANDBOX_HOSTS` is exactly `api.sandbox.airwallex.com` and `api-demo.airwallex.com`, the two sandbox hosts Airwallex documents.
- `OFFLINE_HOST` is exactly `sandbox.invalid`, for running with no Airwallex at all, as the offline checks do. Every call to it fails as Airwallex being unreachable.
- The `AirwallexClient` constructor throws unless the base URL is https on one of those three hosts, on the default port, with no user info, path, query or fragment. Nothing else is accepted, not even another `.invalid` name.
- Calls go to the parsed `origin`, never the text of `AWX_BASE_URL`.
- An unset or empty `AWX_BASE_URL` is the default, `https://api.sandbox.airwallex.com`.
- The refusal is in PayOnce's words. It names `AWX_BASE_URL`, the three addresses, and of the bad value only its host.
- For a value with `|` in it, the refusal says it looks like the list of choices from `.env.example`, and to keep one of them.
- `Settings.airwallex.client()` builds the client from `AWX_BASE_URL`, `AWX_CLIENT_ID` and `AWX_API_KEY` only when a command asks for it, so no copy of the settings holds the credentials. `Settings.airwallex.keys` says only whether each credential is set, for the settings view.
- A missing credential throws "Missing environment variable X. Add X to .env", or with no `.env`, "Make a .env file in this folder from the setup lines under Run it in the README". `createEngine` returns that as its `problem`.
- `AirwallexClient.host` is the host every call goes to. `describeAirwallex` is `pnpm ui`'s start-up line naming it, and on `OFFLINE_HOST` it says no call reaches Airwallex and nothing can be paid.
- Every call uses `redirect: "manual"`. A 3xx, or an opaque redirect, is an `AirwallexError` in PayOnce's words, so a payment stays pending, as on a 5xx.

### Login, timeouts and retries

- The client logs in with `POST /api/v1/authentication/login` (`LOGIN_REQUEST`), sending `x-client-id` and `x-api-key`. It reuses the bearer token until 60 seconds before its `expires_at`, then logs in again.
- Every call has a 30 second timeout (`AbortSignal.timeout`). The client never retries a call itself.
- The retries are the callers': `simulateTransfer` and the sandbox bank's reads try up to four times, 1.5 seconds apart, on a 5xx or a lost connection (`isAmbiguous`). `waitForTransfer` polls every second for up to 30 seconds.
- A payment the client could not send is retried by a later look under the same request id. See [engine-rules.md](engine-rules.md).
- An error's `request` is the method and path only, such as `LOGIN_REQUEST`, with no query string.

### Errors

- `AirwallexError` means Airwallex answered with an error status. It carries `request`, `status`, `code` and `source`.
- An `AirwallexError` message reads "REQUEST failed with STATUS CODE: TEXT". It keeps at most 300 characters of Airwallex's words, through `cleanLine`.
- The error keeps a `code` only when it matches `^[A-Za-z0-9_.-]{1,64}$` and holds no secret. Its `source` goes through the same cleaning.
- An error answer that is not JSON, such as the HTML page the sandbox's login answers a wrong key with (a 403), is not quoted. The message says Airwallex answered with a page that is not JSON. An empty answer gives the status text.
- `AirwallexUnreachableError` means no answer came back, so whether Airwallex acted is unknown. It carries `request` and the `host`.
- An `AirwallexUnreachableError` keeps no `cause`. Its message keeps the inner cause's message, with the secrets cut out and cleaned.

### Secrets

- `withoutSecrets` cuts the client id, the API key and the bearer token the request carried out of the message, the `source` and an `AirwallexUnreachableError`'s detail, as `[client id]`, `[key]` and `[token]`.
- It cuts them in every form `redactKey` cuts, before and after `cleanLine`, and it drops a code that held one. The token goes first, then the key, then the client id.
- None of the three then reaches a console line, a timeline line, the page, an audit export, an MCP answer, `GET /api/cash` or `recon_runs.error`.
- `redactKey` cuts the key out of error text as written, URL-encoded (either case of hex), and as base64 or base64url at each of the three byte alignments.
- It also cuts any run of 20 or more characters from one of those forms, such as a key cut short, whatever the case of its letters.
- It also cuts any run of 20 or more of a form's letters and digits, in order, with separators between them, such as a key split by spaces, line breaks or tabs. The 20 is `KEY_RUN`, the same length the partial match uses.
- A separator is anything but a letter or a digit (whitespace, controls, punctuation), plus anything a screen draws as nothing or a blank (`Default_Ignorable_Code_Point`: zero-width characters, the soft hyphen, the Hangul fillers).
- An escape that writes a separator counts as one: `\n`, `\r`, `\t`, `\b`, `\f`, `\v`, `\uXXXX` or `\xHH`, and a URL's `%HH` for an ASCII character.
- The cut runs from the first matched character to the last, so the separators inside it go too, and two pieces of one key with only separators between them become one label.
- Each cut becomes its `label`, `[key]` unless the caller gives another. `redactKeys` runs `redactKey` for each key the email reader and Ask why hold.
- `src/text/redact.ts` imports nothing. The email reader, Ask why and the Airwallex client share it.

### Advice

- `airwallexAdvice` turns an `AirwallexError` or `AirwallexUnreachableError` into PayOnce's advice from its status, request and host alone, never from Airwallex's text.
- A 401 or 403 on `LOGIN_REQUEST` says Airwallex refused the API key, and to check `AWX_CLIENT_ID` and `AWX_API_KEY` in `.env`.
- A 401 on any other call says Airwallex refused the key or its token for that call, and to start PayOnce again. A 403 on any other call says to check the key's permissions, as for a scoped key without one.
- An unreachable `OFFLINE_HOST` says `AWX_BASE_URL` is the offline host. Any other unreachable call, a 5xx or a 429 says to try again in a minute. Any other error gets no advice.
- `withAdvice` puts the advice after a message, with one period between them.
- The 502s on starting a payment (`POST /api/payments`), starting a scripted incident (`POST /api/sandbox/scenarios`) and checking a pay run file use the advice.
- So do `pnpm recover`, `pnpm payrun upload` and `check`, `pnpm cash` and `pnpm reconcile`. No timeline line holds it.

### API modules

- `transfers.ts`: `createTransfer` always sends `source_currency`, and `quote_id` only when one is given. `getTransfer`, `findTransferByRequestId`, and `listTransfersSince` (100 a page, newest first).
- `transfers.ts` also has `waitForTransfer`, which throws `TransferWaitError` when a transfer does not reach a state in time.
- `fx.ts`: `createQuote` buys exactly the invoice amount. `QuoteValidity` and `QUOTE_VALIDITIES` are `MIN_30`, `HR_1`, `HR_4`, `HR_8` and `HR_24`.
- `beneficiaries.ts`: `getBeneficiary`, `findBeneficiary` (undefined for an id Airwallex does not have), `getBankDetails`, `updateBankDetails`, and `findOrCreateBeneficiary`, which every scenario uses to find its beneficiary by nickname or create it.
- `balances.ts`: `getBalances` and `getAvailableMinor`, on the cash account only, and `BalanceCache` for the cash panel.
- `webhooks.ts`: `subscribe` points PayOnce's one transfer subscription at a URL, creating it the first time with every transfer event (`TRANSFER_EVENTS`), and returns its signing secret. `listWebhooks` pages through the subscriptions.
- `simulation.ts`: every sandbox-only call (`simulateTransfer`).
- `history.ts`: `listBalanceHistory` reads one window to its last page, 500 a page, with no currency, so every wallet comes back at once.
- Its callers keep each window to `HISTORY_WINDOW_MS`, and it throws `HistoryPagingError` past 200 pages.

## Why

- This code moves money, so it talks to nothing but the sandbox.
- The reserved `.invalid` name never resolves and no public certificate can exist for it, so with `OFFLINE_HOST` the key cannot leave over TLS.
- Calls go to the parsed origin so that an empty `?` or `#`, a backslash or a tab cannot move them to another path.
- A redirect would carry `x-client-id` and `x-api-key`, or the token, to whatever host it names, so none is followed.
- The query string can carry ids, so only the path goes into error messages.
- Airwallex can echo what a request sent, so every part of an error kept is cut of the secrets.
- An `AirwallexUnreachableError` keeps no `cause` because when fetch refuses a header value, its message quotes the value.
- Secrets are cut before and after `cleanLine` because cleaning can join two parts of one.
- The token is cut first, so a shorter secret found inside a longer one cannot leave part of the longer one behind.
- `redactKey` ignores case because a service can echo the key upper-cased.
- Spaced runs need `KEY_RUN` letters and digits, so a key with fewer than 20 (the rig's dummies, for one) is never matched across separators and cannot cut words out of ordinary text.
- Advice comes from the status and request only, so nothing Airwallex wrote becomes PayOnce's advice.
- `getAvailableMinor` throws when Airwallex returns no balance in the currency, because the policy must not act on an amount it cannot read.
- `findBeneficiary` throws on any error but a 400 or 404, so an outage never reads as every beneficiary being unknown.
- `listBalanceHistory` never reads `description` or `reference`, because they carry payee names and typed text.
- A subscription's events cannot be changed after it is created, so it takes every transfer event and the receiver picks what it needs. A tunnel gets a new address each time it starts, so the one subscription is moved to it instead of a new one being added.
- A request ends 12 minutes before its quote does (the 10 minutes an approval has to be used and a 2 minute margin), so `MIN_1` would leave no time to approve and `MIN_15` about 3 minutes. Both are left out of `QuoteValidity`.

## Edge cases

- `AirwallexClient.fromEnv` and its private `requireEnv` are still in the frozen client, and nothing calls them. `settings.ts` carries the same messages.
- A 401 past the login is most likely the token run out, so starting PayOnce again logs in afresh.
- An answer from `balances/current` that is not a list throws, as any other unreadable read does.
- An account with yield or credit balances lists those too, in the same currencies. `getBalances` keeps rows whose `account_type` is `cash` or not given.
- `subscribe` finds PayOnce's own subscription by its `request_id` prefix. A subscription made in the web app may have no `request_id`, and is left alone.

Dated checks: [verification/airwallex-client.md](../verification/airwallex-client.md).

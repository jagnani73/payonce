# Webhooks

`pnpm ui` takes Airwallex's transfer webhooks on a port of their own, behind a cloudflared quick tunnel, and a signed event only wakes a look. The code is `src/surfaces/http/webhooks.ts` (`WebhookReceiver`, `verifySignature`), `src/surfaces/http/tunnel.ts` (`openTunnel`), `connectWebhooks` and `onWebhook` in `src/surfaces/http/start.ts`, and `subscribe` in `src/airwallex/webhooks.ts`. Invariant 55 in [invariants.md](../invariants.md) is the rule that nothing in a webhook's body feeds a decision, and the watcher that backs webhooks up is in [architecture.md](../architecture.md#dispatcher-watcher-and-sweep).

## Rules

### The receiver

- `WebhookReceiver` listens on `WEBHOOK_PORT` (4311) on 127.0.0.1 and answers `POST /airwallex/webhooks` (`WEBHOOK_PATH`) and nothing else, which gets 404.
- It answers 503 until it has the subscription's secret.
- A body over 256 KB is 413, a bad or old signature 401, and a body that is not an event (a string `id` and `name` and an object `data`) 400.
- `verifySignature` computes the HMAC-SHA256 of the `x-timestamp` header followed by the raw body, keyed with the secret, and compares it in constant time with the hex `x-signature`. A timestamp that is not all digits, or is more than 5 minutes off, is refused.
- The receiver takes the transfer from `data`, or from `data.object` when Airwallex nests it there (`toEvent`).
- It prints refused requests (any answer but 200) at most once a minute: the first at once, and the rest counted and printed with the latest status when the minute is up (`RefusalLog`).

### What an event does

- `onWebhook` takes each event id once (`Ledger.firstDelivery`), prints the event's name and reference, and acts only on `payout.transfer.paid`, `failed`, `cancelled` and `overdue` (`DECISIVE_EVENTS`). Every other event is only logged.
- For a PayOnce transfer the ledger still has with the bank (`withBank`), it writes a `bank` line ("Webhook from Airwallex: ... Checking it") and wakes the invoice. The look reads the transfer from Airwallex and decides on that.
- An event for a payment the ledger already shows paid or failed changes nothing.
- An event for an attempt marked failed with no transfer asks for a sweep (`sweepSoon`), which records the transfer on it.
- An event for a transfer the ledger does not know asks for a sweep, unless it is an outside payout already tied to an invoice (`outsideInvoiceOf`), which wakes that invoice.
- The look a webhook wakes never has the run's turn, so it never sends a pay run row's first payment ([pay-runs.md](pay-runs.md)).

### Connecting

- `connectWebhooks` runs once the server listens, and the server does not wait for it.
- `WEBHOOKS` takes `on` or `off` in any case, and unset or empty is on. Any other value is off, with a start-up line saying WEBHOOKS must be on or off and is neither. Off skips the receiver, the tunnel and the subscription.
- Without `WEBHOOK_URL`, `openTunnel` runs `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4311` (`CLOUDFLARED` sets the command) and takes the first `https://*.trycloudflare.com` address in its output within 30 seconds. The address changes on every start.
- With `WEBHOOK_URL`, that address is used, with trailing slashes cut and `WEBHOOK_PATH` added.
- `subscribe` lists the subscriptions and finds PayOnce's by the `request_id` prefix `payonce-transfers-`. It moves that one to the new address, or creates it with all nine `payout.transfer.*` events (`TRANSFER_EVENTS`).
- A subscription already at the address is left as it is. A new one is created with `WEBHOOK_API_VERSION`, `2025-06-30` by default.
- The secret comes back from Airwallex, from the create, the update or the list, and is held in memory only.
- `subscribeWithRetry` tries three times, 5 seconds apart. Once subscribed, the watcher checks every 15 seconds (`CHECK_WITH_WEBHOOKS_MS`).
- Without webhooks the server's watcher checks every 3 seconds (`CHECK_EVERY_MS`), and `pnpm recover`'s every 2.
- If cloudflared stops after the tunnel is up, the watcher goes back to every 3 seconds, with a warning. When the server exits it stops the tunnel.

## Why

- The receiver has a port and a path of its own, so the tunnel, which makes it public, exposes no other part of PayOnce.
- The receiver answers 503 without the secret because nothing can be checked yet, and Airwallex retries a failed delivery, so the event is not lost.
- The 5-minute window means a captured event cannot be played back later.
- The refusal log prints at most once a minute because anyone who learns the tunnel's address can send requests, and a stream of refusals must not scroll the timeline lines off the terminal.
- The receiver takes the transfer from `data` or `data.object` because Airwallex's transfer examples put the transfer in `data`, and its general event format nests the resource under `data.object`. The sandbox's events carry the transfer directly under `data`, with `version` `2025-06-30`.
- Each event id is taken once because Airwallex may deliver an event more than once.
- An event only wakes a look because PayOnce learns what the bank did only by reading Airwallex (invariant 55).
- An event for a payment already final is no news. A failed transfer is cancelled a few seconds later, and a status check may have got there first. Either way the ledger already has the news. A transfer the ledger keeps failed while the bank has it in flight is news, and `withBank` counts it.
- PayOnce moves one subscription because a quick tunnel gets a new address each time it starts. Airwallex's update keeps the subscription's id, and its list call returns each subscription's secret, so one subscription follows the tunnel instead of a new one being added.
- A subscription's events cannot be changed after it is created, so it takes all nine and the receiver picks what it needs.
- The `request_id` holds eight characters of a UUID because Airwallex takes a webhook `request_id` of at most 50 characters.
- The subscription is retried because a new tunnel address can take a few seconds to resolve.
- Any other `WEBHOOKS` value is off, so no tunnel opens that nobody asked for, as with `on|off` copied from `.env.example`.
- `WEBHOOK_API_VERSION` is set because no response header says which version the account uses.
- The check intervals differ because with webhooks the check is a safety net for a late or lost event. Without them it is the main signal, so it runs often enough that nothing waits long.

## Edge cases

- The sandbox delivers nothing. Airwallex records an event for every status change (`scheduled`, `processing`, `sent`, `paid`, `failed`), addressed to the subscription's URL, and leaves each one Queued, never attempted. "Send test event" and "Re-trigger" in the web app deliver nothing either.
- In the sandbox, the watcher catches every change, so `WEBHOOKS=off` loses nothing there and checks every 3 seconds instead of 15.
- Delivery status per event shows under Settings > Developer > Events in the Airwallex web app, which needs the account owner's login.
- A request from outside through the tunnel reaches the receiver, and an unsigned one gets 401.
- An event before the secret gets 503, and Airwallex retries it.
- For a redelivered event, `firstDelivery` finds its id already taken, and nothing happens.
- A subscription made in the web app may have no `request_id`, so PayOnce does not take it for its own and creates one.
- When cloudflared is missing, or gives no address within 30 seconds, cloudflared is stopped, webhooks are not connected, and a warning says payments in flight are checked every 3 seconds.
- When the subscription cannot be made, the same warning prints after three tries with the error's message, and the watcher stays at 3 seconds.
- On Windows, installing cloudflared with `winget install Cloudflare.cloudflared` waits on a UAC prompt. The standalone cloudflared-windows-amd64.exe from the GitHub release runs without admin rights, with `CLOUDFLARED` set to its path.
- The CLI in the terminal has no receiver. `pnpm recover` checks the bank every 2 seconds.

Dated checks: [verification/webhooks.md](../verification/webhooks.md).

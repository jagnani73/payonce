# Webhooks

This is one of PayOnce's design notes. [CLAUDE.md](../../CLAUDE.md) has the commands, the file map, the rules that hold everywhere and the index of these notes. Where the two differ, this file is right.

- `pnpm ui` starts `WebhookReceiver` on `WEBHOOK_PORT` (4311, loopback). It answers `POST /airwallex/webhooks` and nothing else, so the tunnel exposes no other route. It answers 503 until it has the secret, so Airwallex retries.
- Without `WEBHOOK_URL`, `openTunnel` runs `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4311` (`CLOUDFLARED` sets the path) and takes the `trycloudflare.com` address from its output. The address changes on every start.
- `subscribe` finds PayOnce's subscription by the `request_id` prefix `payonce-transfers-` and moves it to the new address, or creates it with all nine `payout.transfer.*` events. The secret comes back from Airwallex and is held in memory only.
- `verifySignature`: HMAC-SHA256 hex of the `x-timestamp` header followed by the raw body, keyed with the secret, compared in constant time. A timestamp more than 5 minutes off is refused.
- The receiver takes the transfer from `data`, or from `data.object` when Airwallex nests it there.
- A paid, failed, cancelled or overdue event for a PayOnce transfer the ledger still has with the bank (`withBank`) puts a `bank` line on the timeline and wakes the agent. One for a payment the ledger already shows paid or failed changes nothing, and one for an attempt marked failed with no transfer asks for a sweep. Other events are only logged.
- The receiver prints refused requests (any answer but 200) at most once a minute: the first at once, and the rest counted and printed with the latest status when the minute is up (`RefusalLog`).
- With webhooks connected the watcher checks every 15 seconds. Without them it checks every 3, and the CLI every 2. `WEBHOOKS` takes on or off in any case, and unset or empty is on. Any other value, such as `on|off` copied from `.env.example`, is off, with a start-up line saying WEBHOOKS must be on or off and is neither. Off skips the receiver, the tunnel and the subscription.
- `WEBHOOK_API_VERSION` defaults to `2025-06-30`. No response header says which version the account uses.

Found by running it on 2026-10-28:

- A webhook `request_id` is limited to 50 characters.
- The list call returns each subscription's secret. The update call moved PayOnce's subscription to a new tunnel address and kept its id.
- In three incidents, with about ten transfer status changes, Airwallex delivered no event within 12 minutes. The tunnel answered a request from outside, and the subscription listed the right address and events. The watcher caught every change. Delivery status per event is under Settings > Developer > Events in the web app, which needs the account owner's login.
- Checked in the web app later the same day: Airwallex creates an event for every status change (`scheduled`, `processing`, `sent`, `paid`, `failed`), with the transfer directly under `data` and `version` `2025-06-30`, addressed to the subscription's URL. Every event stayed `Queued` with no HTTP status, so none was ever attempted. With a fresh tunnel and the subscription moved to it, "Send test event" and "Re-trigger" in the web app delivered nothing either, while a POST from outside through the tunnel reached the receiver and got its 401. The sandbox records events but does not deliver them to this account.
- The scripted incidents with the watcher on: a replaced payment from start to close in 11 seconds through `pnpm recover`, and about 50 seconds for each escalation on the page while the watcher checked every 60 seconds.
- `winget install Cloudflare.cloudflared` waits on a UAC prompt. The standalone `cloudflared-windows-amd64.exe` from the GitHub release runs without admin rights.

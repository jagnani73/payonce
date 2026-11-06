# Webhooks: dated checks

How the rules in [design/webhooks.md](../design/webhooks.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-10-28: the subscription, delivery in the sandbox and the tunnel

Found by running it on 2026-10-28:

- A webhook `request_id` is limited to 50 characters.
- The list call returns each subscription's secret. The update call moved PayOnce's subscription to a new tunnel address and kept its id.
- In three incidents, with about ten transfer status changes, Airwallex delivered no event within 12 minutes. The tunnel answered a request from outside, and the subscription listed the right address and events. The watcher caught every change. Delivery status per event is under Settings > Developer > Events in the web app, which needs the account owner's login.
- Checked in the web app later the same day: Airwallex creates an event for every status change (`scheduled`, `processing`, `sent`, `paid`, `failed`), with the transfer directly under `data` and `version` `2025-06-30`, addressed to the subscription's URL. Every event stayed `Queued` with no HTTP status, so none was ever attempted. With a fresh tunnel and the subscription moved to it, "Send test event" and "Re-trigger" in the web app delivered nothing either, while a POST from outside through the tunnel reached the receiver and got its 401. The sandbox records events but does not deliver them to this account.
- The scripted incidents with the watcher on: a replaced payment from start to close in 11 seconds through `pnpm recover`, and about 50 seconds for each escalation on the page while the watcher checked every 60 seconds.
- `winget install Cloudflare.cloudflared` waits on a UAC prompt. The standalone `cloudflared-windows-amd64.exe` from the GitHub release runs without admin rights.

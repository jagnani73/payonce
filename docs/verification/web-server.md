# Web server: dated checks

How the rules in [design/web-server.md](../design/web-server.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-11-02: the incident list and detail on a large ledger

Checked on 2026-11-02 on a copy of a reviewer ledger seeded with 5,000 settled invoices and 60,000 chained lines, server on port 4344 with webhooks off: `GET /api/incidents` went from a median of 1,153 ms to 83 ms, and an incident detail from 100 ms to 16 ms (median of 10 each).

## 2026-11-03: format characters on the cards, and moving between views

Checked on 2026-11-03 in headless Chrome, server on port 4388 with Airwallex at `sandbox.invalid`, on a ledger copy with legacy names holding U+202E and U+200B (who started two incidents, an approval and its signoffs, a callback, two uploads, two drafts, a cancelled run, an ended outage and an explained break): no header or card held a format character, where before the incident, outbox, inbox, run and outage cards did. With 400 ms added to every request, going from reconciliation, an email or a run to an incident, or from reconciliation to an email or a run, left the main area empty for about 270 ms before and never after. Before, an upload refused with no email id read "falsefalse" after its message, and now nothing follows it.

## 2026-11-03: moving between views again, in review

Checked again in review on 2026-11-03 in headless Chrome, server on port 4392 with Airwallex at `sandbox.invalid`: with 400 ms added to every request, each of the 30 moves between the board, an incident, a pay run, an email, a supplier record and reconciliation showed exactly one view in every 10 ms sample, never a blank main area, and ended on the view picked. Picking a third view 100 ms after a second never showed the second, whichever of their answers was slower. Typed notes and an email's display name held U+202E or U+200B on the outbox, run, inbox, outage and reconciliation cards before the fix and none after.

## 2026-11-07: the Inbox and Pay runs screens' actions

The note gave no date; it is the day the two screens were built.

- Offline server on rig ledgers (`payrun-release`, `eml-upload`) and a server against the rig's fake bank in manual mode at the real time (scratch `ir-tools/live.mjs`), so requests are live: run upload (400 problems, 422 every row skipped, 409 waiting), approve by two, release and rows paid after advancing the clock, request expiry and re-check, cancel (note required), outage pause and End outage from the run page; email upload (file dialog, paste, duplicate 409 with link, unreadable source), suggested delivery, unread then read after a check, another payment refused (404 words beside the button), dismiss (note required), 404 email and run.
- The width harness drops the Origin header, so every POST through it answers 403 Forbidden. Actions were checked in a tab on the app's own port.

## 2026-11-07: the uploaded email's date and upload time in the routes' answers

The note gave no date; it is the day the fields were added.

- `rig-runs/payment-1` against `rig-runs/page-12a3bbb`: 348 differences in 58 files (routes.json, mcp.json, transcript.json), every one the two new EmailView fields. `pay/classify.mjs` checks that by stripping them from B: 291 files compared, 0 differ beyond them.

## 2026-11-08: approver pickers, the callback note and a skipped row

Checked on 2026-11-08 in Chrome, on a server against the replay rig's fake bank after `scripts/demo-morning.mjs`:

- You are Alex, on the bank change after the callback: Approving as reads "Choose who is approving", the reason Alex can't approve shows under it, and the button reads Approve and is off. Yash picked by hand gave "Approve as Yash". After Yash signed, the picker read "Choose who is approving" again, with Kim left for a person to pick. With You are Kim, the picker started on Kim.
- The callback form's "What they confirmed" is a two-row textarea as wide as the form, and the demo's note shows in full.
- On pay run 1, row 4's "Skipped (1 reason)" badge shows a skip mark, not a tick.

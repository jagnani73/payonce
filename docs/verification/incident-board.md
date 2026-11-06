# Incident board: dated checks

How the rules in [design/incident-board.md](../design/incident-board.md) were checked, as written at the time. Only paths have been updated to the current layout, so a note may describe behaviour that has changed since.

## 2026-10-29: one report's time on seeded copies

Written beside the read rule (one report reads the whole invoice table three times) on 2026-10-29: On seeded copies of the ledger it took 50 ms with 5,000 closed invoices and 51 waiting uploads, and 125 ms with 10,000 and 101.

## 2026-10-29: the board against the cash panel on a copy of the main ledger

Checked on 2026-10-29 on a copy of the main ledger with the server on port 4337 (webhooks off, keyword reader): the sweep took on payouts made from other worktrees, and with a held `eur-from-usd` invoice, the sample pay run waiting for approval and an uploaded email naming an invoice in flight past its deadline, the board listed 15 entries across all four groups. Its `promisedMinor`, `waitingMinor` and `withBankMinor` equalled `GET /api/cash`'s lines in every currency (USD 0, 8,499.92 and 13,321.15), and the run's 81.00 USD and 50.00 EUR showed only in `runWaitingMinor`. The outside filter gave 9,321.15 USD, the panel's "Payouts sent outside PayOnce". Nothing was approved or sent.

## 2026-10-29: the sidebar's tags and moving between views

Checked again on 2026-10-29 on a seeded copy, same settings: the sidebar's tags matched the board's group for all 14 open invoices, seven of them payouts sent outside PayOnce past their deadline. Moving between the board, an incident, a run and an email never left the main area blank, and with `/api/board` held back 800 ms the way back showed the incident for 280 ms, then "Loading", then the fresh board. An empty ledger showed the hint. Nothing was approved or sent.

## 2026-10-29: outages on the board

Checked on 2026-10-29 on a copy of the main ledger seeded with outage 1 on USD LOCAL (three payees, 91401 and 91402), a waiting original, an escalated replacement and an approved payment, server on port 4339 with Airwallex pointed at `sandbox.invalid`, so every call failed at DNS: `GET /api/board` listed the three under the outage with 2,500.00 USD at risk, `outageMinor` 1,250.00 matched the panel's waiting-outage line, and an older invoice on the rail with an expired request got the `approval` line. `pnpm board` printed the same. Ending it from the slot as Yash moved it to the card as ended and cleared the marks. No transfer was created.

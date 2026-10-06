# PayOnce

Payment incident agent for the Airwallex Agentic Banking Hackathon 2026, built on starter kit 3. TypeScript, pnpm, Node 24. Sandbox only.

## Commands

```bash
pnpm install
pnpm typecheck        # tsc --noEmit
pnpm dev              # policy on three sample incidents, no credentials
pnpm recover [TYPE] [INVOICE]   # full incident against the sandbox; TYPE is a simulated failure type (default CHANNEL_TIMEOUT), INVOICE names the incident
```

There is no lint script and there are no tests.

## Structure

- `src/decide.ts`: pure decision policy (wait / replace / escalate). Rules stay in code; the model never decides amounts or moves money.
- `src/incident.ts`: `Incident` and `Decision` types. Amounts are minor units.
- `src/assess.ts`: maps an Airwallex transfer to `originalState` and `resendCanFix`.
- `src/airwallex/`: `client.ts` (login, bearer token refresh, refuses non-sandbox hosts), `transfers.ts`, `beneficiaries.ts`, `balances.ts`, `simulation.ts` (every sandbox-only call).
- `src/ledger.ts`: obligations and attempts in SQLite, with the duplicate lock.
- `src/payments.ts`: idempotent send and status sync between Airwallex and the ledger.
- `src/recover.ts`: one incident end to end. A second run for the same invoice only reports.

## Ledger

- `src/ledger.ts` uses `node:sqlite`, which ships with Node 24, so there is no database dependency or server.
- The file is `payonce.db` in the working directory and is git-ignored. Delete it to reset local state. Transfers already sent in the sandbox stay there.
- The duplicate lock is the partial unique index `one_live_attempt_per_invoice` on `attempts(invoice_id) WHERE state <> 'failed'`. A violation has `errcode` 2067 and is rethrown as `DuplicatePaymentError`.
- `openAttempt` writes the attempt before any API call. `sendAttempt` in `src/payments.ts` reuses the stored `request_id`, and on `duplicate_request_id` it looks the transfer up by that id.
- `settle` closes an obligation only when one attempt is paid and every other attempt has failed.

## Sandbox behaviour found by running it

- Credentials are a scoped API key in `.env` (`AWX_CLIENT_ID`, `AWX_API_KEY`). Admin keys are deprecated.
- A new transfer starts `SCHEDULED` and moves to `PROCESSING` on its own within seconds. The simulator returns `500 operation_failed` for a transition requested while it is still `SCHEDULED`, so wait first.
- `PROCESSING` to `SENT` and `SENT` to `FAILED` (with `failure_type`) both work. A failed transfer reads `FAILED`, then `CANCELLED` a few seconds later. The `failure` object survives the change.
- `failure.details.type` is `INCORRECT_ROUTING` for every simulated failure. Read `failure.code` instead: 91401 system error, 91402 channel timeout, 90701 account closed, 90101 invalid account name or number, 90802 beneficiary bank returned, 91001 recall requested, 91301 duplication return, 99901 unable to apply, 99902 other.
- Creating a transfer takes the amount out of `available_amount` immediately. A failed transfer is refunded a few seconds later.
- Reusing a `request_id` returns `400 duplicate_request_id` and names the original transfer.
- LOCAL USD transfers carry no fee in the sandbox.
- The client sends no `x-api-version` header. The account default returns the newer status set (`FAILED` exists) with a nested `failure` object.

## Conventions

- The code uses explicit type annotations and few comments.
- TypeScript 7 needs `"types": ["node"]` in `tsconfig.json`.
- pnpm 12 blocks install scripts; `esbuild` is allowed in `pnpm-workspace.yaml`.

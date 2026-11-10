# Tests: dated checks

How the rules in [design/tests.md](../design/tests.md) were checked, as written at the time.

## 2026-11-10: the first suite, on main e3b290e

Checked on branch `test/journeys`, rebased onto main e3b290e, on Windows 11 with Node 24.18.0. No file in `src/` changed.

- `pnpm test` three times in a row: 12 of 12 passed each time, in about a second each.
- With a `.env` in the checkout that set `AWX_BASE_URL=https://api-demo.airwallex.com`, a fake client id and key, `APPROVERS=Nobody:1` and a marker variable, `pnpm test` ran with a probe loaded into every Node process through `NODE_OPTIONS`. In all seven processes (the tsx CLI and the six test files) the marker and every `AWX_` variable were absent at start and at exit, `process.loadEnvFile` was never called, and no fetch or HTTP request was made. The only connection each test process opened was tsx's local pipe to its CLI. All 12 passed, so no journey had a refused call or a login with other credentials. The `.env` was then deleted.
- Two rules broken on purpose, each undone after:
  - `barredFrom` barring the starter only for a pay run: the approvals journey failed, because Kim was listed among the people who could approve. The other 11 passed.
  - `account_name` taken back out of `NOT_ROUTING_FIELDS`: the second bill through the record with another account name was held only for its approval (`person-started`), not as a second bill. The other 11 passed.

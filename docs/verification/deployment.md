# Deployment: dated checks

How the rules in [design/deployment.md](../design/deployment.md) were checked, as written at the time.

## 2026-11-11: the branch, before the first deploy

Nothing was created in AWS. The only AWS calls were `cdk synth`'s read-only lookups, in the owner's `aws login` session. No Airwallex call was made: every server below ran with `AWX_BASE_URL=https://sandbox.invalid` and dummy keys, on a scratch ledger outside the repository.

- `pnpm typecheck`, `pnpm check:layers` and `pnpm test` (12 journeys) passed after each change under `src/`.
- The guard, with `PUBLIC_ORIGIN=https://dtest123.cloudfront.net`: a POST with that Host and Origin passed (200), and one with Origin `https://evil.example`, `http://dtest123.cloudfront.net`, a loopback Origin or none got 403. A loopback Host with the public Origin got 403. GETs on the public Host passed, and got 403 with `sec-fetch-site: cross-site` or another Origin. The page answered on the public Host. With `PUBLIC_ORIGIN` unset, every request on the public Host got 403, loopback worked as before, and the start-up lines were the old ones.
- The cap, on a ledger seeded through the store with two invoices started that day and a pay run of two rows: at `DAILY_PAYMENT_CAP=2`, New payment, a scripted incident, a pay run upload and a run approval each got 429 `daily-cap` with `Retry-After` until midnight UTC. At 3, the two starts went on to Airwallex (502, offline, nothing stored), and the approval got 429 saying the run pays 2 rows and 1 more can start. Unset, nothing was refused.
- The held places, with a stub ledger and a start that waits 200 ms: two starts at once for the last place gave one start and one 429, and the place was free once both ended. A run approval's places stayed held until its release showed in the ledger.
- With no model key, the payment page's Ask why card read "Ask why is not set up." and the route answered 503.
- A release built as CI builds it was 1.0 MB, installed with `pnpm install --frozen-lockfile`, and ran with its own `tsx` from another working folder with `deploy/payonce.env`. The ledger was made in that folder, and the page, its files and the fixtures came from the release. The reset moved the ledger to `payonce.<time>.db`, and `demo-morning.mjs` passed its start checks on the empty ledger and stopped at the first Airwallex read.
- `cdk synth` looked up three AZs, prefix list `pl-31a34658` and Canonical's arm64 AMI. The template had no Lambda, custom resource, log group, CloudWatch, CDK metadata, parameter or bootstrap rule. As the CLI sends it, as YAML, it was 39.6 KB of 50 KiB, and the raw user data 12.5 KB of 16 KB. Every resource type CloudFormation can tag carried `project=payonce`.
- nginx 1.24.0 from Ubuntu 24.04's package, unpacked in WSL and run on another port: `nginx -t` passed. No origin header or a wrong one got 403, the right one reached a stub app with the public Host and without the header, and `Server` had no version. 40 POSTs from one viewer gave 21 answers and then 429, while another viewer still got through. 150 GETs at once from a new viewer gave 102 answers and 48 429s. A 3.2 MB body got 413.
- `systemd-analyze verify` (systemd 259) found nothing in the units but the paths that exist only on the instance. The timer's next run was 03:00 +08, 19:00 UTC. `systemd-run` took every property the morning's transient units use.
- nft 1.0.9 from Ubuntu 24.04's package, in a throwaway user and network namespace, checked and loaded `imds-block.nft` twice.
- `bash -n` passed on every script and on the assembled user data.
- Not checked: shellcheck, which could not run here; the stack itself, the first boot, a deploy through SSM, CloudFront, the budgets and their actions. Those wait for the first deploy.

## 2026-11-11: installing releases as payonce

- In WSL, with Node 24 from nodejs.org checked against its SHASUMS256: pnpm 12.5.1 fetched its native binary on its first run, so a corepack home nobody had run it from failed read-only. Run once by its owner first, as the first boot now does, and then made read-only, it worked.
- `pnpm install --frozen-lockfile --package-import-method copy` of a release ran in a transient unit with the deploy's sandbox properties (all but `User=`, `Group=` and the IMDS unit, which need the system manager) and finished in 8 s. Nothing in the corepack home changed, every installed file was world-readable, and the only hard links were esbuild's binary inside the release, none shared with the store. The installed server answered 200 for its status and its page.
- `bash -n` passed on the scripts and the assembled user data, which was 13.5 KB of 16 KB, and the template 40.9 KB of 50 KiB.
- Not checked: the `chown` to root and back, which needs root.

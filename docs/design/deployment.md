# Deployment

PayOnce runs live on one EC2 instance in ap-southeast-1, behind CloudFront, with no login. The stack is `infra/` (CDK in TypeScript), what the instance runs is `deploy/`, and CI/CD is `.github/workflows/ci.yml`. The server is `pnpm ui` as [web-server.md](web-server.md) describes it, with `PUBLIC_ORIGIN` and `DAILY_PAYMENT_CAP` set.

## Rules

### One stack, nothing else

- Everything is in the stack `PayOnce` (`infra/lib/payonce-stack.ts`), and `cdk destroy` removes all of it once the release bucket is empty.
- The stack uses `LegacyStackSynthesizer`, has no file or Docker asset, and its template stays under the 50 KiB the CLI sends inline (about 40 KiB now). It never needs a CDK bootstrap stack.
- The template has no `AWS::Lambda::*`, `Custom::*`, `AWS::Logs::*` or `AWS::CloudWatch::*` resource. So the stack uses no construct that makes a custom resource: the OIDC provider is `OidcProviderNative`, the VPC sets `restrictDefaultSecurityGroup: false`, the bucket has no `autoDeleteObjects`, and nothing uses `AwsCustomResource`, `BucketDeployment` or `logRetention`.
- Nothing uses CloudWatch: there is no log group, alarm, dashboard, agent, metric stream, detailed monitoring or CloudFront logging. Logs stay in the instance's journal, capped at 200 MB.
- The stack has no NAT gateway, load balancer, WAF, Secrets Manager secret, KMS customer key, autoscaling, key pair or open port 22. SSM Session Manager is the only shell, and the first boot removes `openssh-server`, so nothing listens on 22 inside the instance either.
- `Tags.of(app)` tags everything taggable `project=payonce`. The launch template tags itself and the instance's root volume and network interface, and both budgets and their actions carry it in `ResourceTags`. Route, route table association, gateway attachment, security group ingress, bucket policy, instance profile and EIP association have no tags in CloudFormation.
- The account comes from the CLI's session at synth. `cdk.context.json` is committed and pins the Availability Zone, the Ubuntu AMI and the CloudFront prefix list id.

### Network and instance

- The VPC has one public subnet in one AZ and no NAT. The subnet gives no public address at launch: the instance's only address is the Elastic IP, and the first boot waits for it.
- The security group lets in TCP 80 only from `com.amazonaws.global.cloudfront.origin-facing` and lets everything out.
- The instance is a t4g.small with standard CPU credits, on Canonical's Ubuntu 24.04 arm64 AMI, IMDSv2 only with a hop limit of 1, and a 10 GB gp3 root volume encrypted with the AWS-managed key and deleted with the instance.
- The instance role has `AmazonSSMManagedInstanceCore`, `s3:GetObject` on `releases/*` in the release bucket, and a deny on reading any parameter outside `/payonce/*`.
- User data installs the base only (`deploy/box/bootstrap.sh`): Node 24 from nodejs.org checked against its SHASUMS256, pnpm 12.5.1 through corepack, nginx, nftables, the AWS CLI, the `payonce` user, the units, journald's cap and unattended upgrades, but no app code. It writes every file in `deploy/box` without its full-line comments, to stay under EC2's 16 KB.

### The front door

- CloudFront serves `https://<id>.cloudfront.net` with its default certificate, redirects HTTP to HTTPS and talks to the origin over HTTP on port 80. Its origin is the Elastic IP's public name, `ec2-a-b-c-d.ap-southeast-1.compute.amazonaws.com`.
- Nothing is cached (`CachingDisabled`). It forwards every viewer header, Host included, and CloudFront's own headers (`AllViewerAndCloudFrontHeaders-2022-06`), and adds the security headers policy.
- CloudFront sends `X-Origin-Verify` with a value made of the stack id and the Elastic IP's allocation id. nginx answers 403 to any request without it, and removes it before the app sees the request.
- nginx limits each viewer, by the address in `CloudFront-Viewer-Address`: 20 requests a second with a burst of 100, and 30 writes a minute with a burst of 20. Past either it answers 429. It takes bodies up to 3 MB, the app's own upload limit, and sends no version.
- The stack publishes the distribution's domain and the header value as `/payonce/cloudfront-domain` and `/payonce/origin-header`, plain SSM parameters. `payonce-env` reads them, so the instance never waits on the distribution.

### The service

- `payonce.service` runs what `pnpm ui` runs after building the page: the release's `tsx` on `src/surfaces/http/main.ts`, as `payonce`, in `/var/lib/payonce`. The ledger is `/var/lib/payonce/payonce.db`, outside every release, and the page comes from the release's `web/dist`, which CI built.
- It reads `deploy/payonce.env` from the release, then `/run/payonce/runtime.env`. The second holds `AWX_CLIENT_ID`, `AWX_API_KEY` and `PUBLIC_ORIGIN`, written by `payonce-env` (root, mode 0600) from Parameter Store before each start. Nothing prints a value.
- The Airwallex keys are SecureString parameters under the AWS-managed `aws/ssm` key. The owner puts them there by hand. The stack never makes them.
- The unit runs with `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/payonce`, `ProtectHome`, `PrivateTmp`, no capabilities, `MemoryMax=1200M`, `Restart=on-failure` and `IPAddressDeny` on the metadata service.
- The `payonce` user cannot reach the instance metadata service at all: `payonce-imds.service` loads an nftables table at boot that drops its packets to 169.254.169.254 and fd00:ec2::254, and `payonce.service` and the morning require it. Root keeps IMDS for the SSM agent, `payonce-env` and `payonce-deploy`.
- `deploy/payonce.env` sets the four demo approvers, two approvers above 5,000, floors of 1,000,000 USD and EUR, webhooks off, reconciliation every 10 minutes, a request TTL of 1,500 minutes, a cap of 20 payments a day, no model key and no alerts.

### Releases and deploys

- CI builds a release on main: `git archive` of `src`, `scripts`, `fixtures`, `deploy` and the package files, plus the built `web/dist`. It uploads it as `releases/<sha>.tar.gz` and sends the `PayOnce-Deploy` command with the commit.
- `PayOnce-Deploy` takes one parameter, `sha`, which must match `^[0-9a-f]{40}$`, and runs `/usr/local/sbin/payonce-deploy` with it as root.
- `payonce-deploy` downloads and unpacks the release into `/opt/payonce/releases/<sha>` as root. `pnpm install --frozen-lockfile` runs as `payonce` in a transient unit with the service's sandbox, which may write only the release, the pnpm store and pnpm's own folder, and copies packages instead of linking them to the store. Then the release belongs to root, so PayOnce runs code it cannot change. The script points `/opt/payonce/current` at it and restarts the service. It waits up to 60 seconds for `GET /api/status` on 127.0.0.1:4310. If that fails it points back at the release before, restarts it and exits 1, and CI fails.
- It keeps the newest 3 releases and never removes the current one. The deploy and the morning take the same lock, so they never run at once.
- `infra/` is a separate pnpm workspace with its own lockfile. CI never installs it, and the release does not include it.
- The bucket blocks public access, encrypts with SSE-S3, refuses plain HTTP and expires releases after 7 days.

### CI/CD

- `ci.yml` has `permissions: contents: read` at the top, and every action is pinned by commit.
- The checks run on every push and pull request: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm check:layers`, `pnpm test` and `pnpm build:web`.
- The deploy job runs only on main (a push or a manual run), after the checks, one at a time, and only when the repository variable `PAYONCE_DEPLOY_ROLE_ARN` is set. Otherwise GitHub skips it and the workflow passes.
- It assumes the deploy role over GitHub's OIDC provider. The role trusts only `aud=sts.amazonaws.com` and `sub=repo:jagnani73/payonce:ref:refs/heads/main`, lasts at most an hour, and may only put objects under `releases/`, send `PayOnce-Deploy` to the one instance, and read command results.
- The job uses no GitHub environment, because one would change the token's `sub`. Its settings are repository variables: `PAYONCE_DEPLOY_ROLE_ARN`, `PAYONCE_INSTANCE_ID`, `PAYONCE_RELEASE_BUCKET` and `PAYONCE_AWS_REGION`.

### The nightly morning

- `payonce-morning.timer` runs at 03:00 Singapore time (19:00 UTC). It ships disabled.
- `payonce-morning` stops PayOnce, moves the ledger aside with `src/surfaces/cli/reset.ts`, deletes ledgers moved aside more than 3 days ago, starts PayOnce, waits for it to answer and runs `scripts/demo-morning.mjs`. That makes 5 sandbox transfers and leaves three payments waiting on a person.
- The reset and the morning script run as `payonce` in transient units with `payonce.service`'s sandbox, never through `runuser`. The deploy's install uses the same helper, `as_payonce` in `deploy/box/payonce-sandbox.sh`.

### Money guards

- There are two budgets, each with an action that stops the instance through SSM's `AWS-StopEC2Instance`: `payonce-gross-usage`, usage before credits, $30 a month, email when the forecast passes $25 and when actual passes $30, stopping at $30; and `payonce-real-money`, after credits, $1 a month, email and stop when actual passes $1.
- Their email address comes from `-c alertEmail=` at synth and deploy, and is never committed. The budget role may only stop this instance through SSM and start that one automation.
- The account's "My Zero-Spend Budget" is not part of the stack, and nothing here changes it.
- `DAILY_PAYMENT_CAP` limits the payments the page starts in a UTC day ([web-server.md](web-server.md)), and the nginx limits slow down anyone hammering the API.

## Why

- PayOnce runs on one small instance because it is one long-lived process on a SQLite file. A serverless or database rewrite would touch the money path.
- The stack avoids CloudWatch and custom resources because each custom resource brings a Lambda and a log group, and the owner wants nothing on the account but this stack.
- It needs no bootstrap stack, which would outlive `cdk destroy` and add a bucket, roles and a repository.
- CloudFront in front gives HTTPS with no certificate or domain, and a fixed set of addresses for the security group. The origin header stops someone pointing their own distribution at the instance.
- The instance holds no GitHub credential. CI pushes the release to S3, and SSM tells the instance to fetch it. The instance can read releases but not write them, and CI can send one command to one instance.
- The document's regex and the script's own check mean the only thing CI controls on the box is which release runs.
- The `payonce` user is kept from IMDS twice, by the unit and by nftables, so code PayOnce runs, its dependencies included, cannot take the instance role. Installs run as `payonce` for the same reason: a package's install script runs during them.
- The request TTL is longer than a day so that the requests the morning opens at 03:00 stay open until the next morning resets the ledger.
- The instance uses standard CPU credits because unlimited ones can bill for a busy CPU.

## Edge cases

- The local PayOnce and the server share one Airwallex sandbox account. A local run while the server runs shows up on each as payouts sent outside PayOnce and as reconciliation breaks. Record the demo video before the server starts sending transfers, or stop the server while recording.
- Credits expire on 31 December 2026, and after that the instance, its Elastic IP and its disk cost real money. Destroy the stack once the results are out: empty the bucket, then `cdk destroy`.
- `cdk destroy` fails while the bucket has objects, since the bucket has no auto-delete. Empty it first.
- A change to anything under `deploy/box` changes the launch template and replaces the instance. The new instance has a new id, no release and an empty ledger. Update `PAYONCE_INSTANCE_ID` and run the workflow by hand. A change to `deploy/payonce.env` ships with the next release and replaces nothing.
- The first boot cannot start PayOnce: the unit waits for a release (`ConditionPathExists`). `payonce-env` fails until the two Airwallex parameters exist, and then the deploy fails and says so.
- The watcher and an outage's end send rows of a released pay run without asking the daily cap. That is by design: the approval that released the run already counted them, and the public reaches only the HTTP routes.
- A pay run upload is checked against the cap by its rows, before Airwallex says which will pay. The approval is checked by the rows to pay, and holds their places until the release writes their invoices, at most 15 minutes.
- Visitors can record callbacks, and each makes a beneficiary record in the sandbox. Nothing caps that but nginx's write limit.
- Ask why is off with no model key. The page says so on the card, and the route answers 503.
- The origin header cannot be rotated without replacing the Elastic IP or the stack. Anyone with read access to the account can read it, which is fine: the security group already admits only CloudFront.
- A full month of this stack is about $20 before credits, so the forecast email, at $25, means something runs above normal. The forecast needs some weeks of data, so it may come late or not at all in the first month.
- A stopped instance still pays for its Elastic IP and disk.
- `pnpm install` runs esbuild's install script, the only one `pnpm-workspace.yaml` allows, as `payonce` in the sandbox.
- pnpm 12 fetches its native binary into the corepack home the first time it runs. The first boot runs it as root, so `payonce` only ever reads that folder. If the folder is ever cleared, installs fail until root runs `pnpm --version` with `COREPACK_HOME=/var/cache/payonce/corepack`.
- The AMI stays the one in `cdk.context.json`. To take a newer one, clear it with `cdk context --reset` and deploy, which replaces the instance.
- The GitHub OIDC provider can exist once per account. If one exists already, the deploy fails on it.
- If the morning script fails, as when Airwallex is down, the ledger is empty until the next morning or a manual run of `payonce-morning`.

Dated checks: [verification/deployment.md](../verification/deployment.md).

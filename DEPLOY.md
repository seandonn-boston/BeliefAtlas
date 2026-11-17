# Deploying to Vercel and Neon

About half an hour, most of it creating accounts. Do it in this order.

## Just a preview first

To try a branch on a real URL before launch, without Twilio or Stripe:

1. Import the repo in Vercel and create the Neon database (steps 1.1 and 1.2 below).
2. Add `PHONE_PEPPER` (any long random string) and `PREVIEW_TEST_MODE` = `1`, both for the **Preview** environment only.
3. Every pushed branch then gets its own preview URL. Its build loads the questions and demo votes; signup takes the code `000000` (shown on the page) and membership switches without payment.

Preview test mode only works where Vercel sets `VERCEL_ENV=preview`, so it can't switch on in production.

## 1. Vercel and the database

1. In Vercel, **Add New → Project** and import `seandonn-boston/yes-or-no`. Leave the build settings alone; `vercel.json` sets the build command, which runs database migrations before every build.
2. In the project, open **Storage → Create Database → Neon**. Accept the defaults and connect it to all environments. This adds `DATABASE_URL` for you, using Neon's pooled connection.
3. In Neon, turn on **branching for preview deployments** if offered. Each pull request then gets its own copy of the database, so preview builds never migrate production.

## 2. Required settings

In **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `PHONE_PEPPER` | Output of `openssl rand -hex 32`. Set once and never change it: a new value locks every existing account out. Keep a copy somewhere safe. |
| `SITE_URL` | Your domain, for example `https://example.com` |
| `MIN_GROUP_SIZE` | `5` |
| `CONTACT_EMAIL`, `OPERATOR_NAME` | Shown on the terms and privacy pages |

Deploy once now. `/api/health` should answer `{"ok":true,...}`.

## 3. Load the questions

From your laptop, with the production `DATABASE_URL` in `.env.local`:

```bash
npm run db:seed:questions
```

Never run `npm run db:seed:demo` against production; it creates fake accounts and refuses to run when `NODE_ENV=production`.

## 4. Phone verification (Twilio)

Signups stay closed in production until this is set up.

1. Create a Twilio account and upgrade it from trial (trial accounts only text verified numbers).
2. **Verify → Services → Create**. Name it BeliefAtlas, code length 6, SMS channel on.
3. Under **Verify → Settings → Geo permissions**, allow only the countries you want to accept signups from. This is the main defence against SMS fraud.
4. Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_VERIFY_SERVICE_SID` to Vercel, set `TWILIO_ENABLED=true`, and redeploy. Paid services are on hold for now, so leave this until a payment plan is in place.
5. Optional, recommended before launch: set `PHONE_LINE_CHECK=twilio` to look up each number's line type before texting it and turn away VoIP and virtual numbers. Twilio bills each lookup. Leave `PHONE_ALLOW_UNKNOWN` unset (true) unless bots get through with numbers the lookup can't classify.

## 4b. Bot check on signup (Cloudflare Turnstile)

Signups stay closed in production until this is set up. It is free.

1. In Cloudflare, **Turnstile → Add widget**. Add your domain, widget mode **Managed**.
2. Add `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to Vercel and redeploy.

See `docs/human-verification.md` for how this fits with the age and phone checks.

## 5. Membership (Stripe)

Membership shows "opens soon" in production until this is set up.

1. In Stripe, **Product catalog → Add product**: "BeliefAtlas membership", recurring, $5.00 monthly. Copy the price ID (`price_...`).
2. **Developers → Webhooks → Add endpoint**: `https://<your domain>/api/stripe/webhook`, with these events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`. Copy the signing secret (`whsec_...`).
3. **Settings → Billing → Customer portal**: turn on cancellation and payment method updates.
4. Add `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET` to Vercel, set `STRIPE_ENABLED=true`, and redeploy. On hold for now: no keys or bank details are set up until a payment plan is ready.

Use test-mode keys first and buy a membership with card `4242 4242 4242 4242`. Switch to live keys when that works.

## 6. Moderators

Sign up on the live site, then from your laptop:

```bash
npm run admin:role -- <your username> admin
```

A **Review** link appears in the header for moderators and admins.

## 7. Optional

- `ANTHROPIC_API_KEY`: screens new questions for repeats and harm, and sorts them into subjects. Without it, simple rules hold any question with an unfamiliar name for a moderator.
- `API_KEYS`: comma-separated keys for the stats API.
- `LOG_LEVEL`: `debug`, `info` (the default), `warn` or `error`. See [Logs and errors](#logs-and-errors).
- The uptime check, backups and restore drill in [Operations](#operations) below. All free; none is on until you set it up.

## Before you open to the public

- Have a lawyer review `/terms` and `/privacy`, then set `LEGAL_DRAFT = false` in `lib/legal.ts`.
- Neon's free plan keeps 24 hours of history to restore from; a paid plan keeps more. Set up the nightly backup below so there is a copy that doesn't depend on Neon.
- Run the restore drill once by hand and check it passes.

# Operations

Everything here is free and self-contained: no paid service, no account to create, no key in the code. Anything that would need one is described as a later option behind a flag that is off by default.

## Logs and errors

Server code logs through `lib/log.ts`: one JSON object per line, which Vercel's **Logs** tab can search and filter.

```json
{"level":"error","msg":"request failed","time":"2026-11-17T18:10:00.000Z","requestId":"iad1::abc-123","route":"/q/[id]","digest":"2841127310","kind":"render","method":"GET","path":"/q/42","error":{"name":"Error","message":"...","stack":"..."}}
```

- Every line has `level`, `msg` and `time`, plus `requestId` when the platform supplied one (`x-request-id`, or Vercel's `x-vercel-id`), plus the caller's fields.
- `LOG_LEVEL` sets the lowest level written (default `info`).
- **Redaction** runs on every line before it is written. Fields whose names look sensitive (anything with phone, token, password, secret, cookie, authorization, api key, session, OTP, pepper, or ending in code or pin) are replaced with `[redacted]`. Every string, including the message and error stacks, is also scrubbed of phone numbers, bearer tokens, JWTs, Stripe/Anthropic/GitHub/Twilio-style keys and `key=value` secrets such as `?code=123456`. Tests in `tests/w5-log.test.ts` cover the cases.
- In code: `import { logger } from "@/lib/log"`, then `logger.info("vote recorded", { questionId })`, or `logger.child({ requestId })` to tag every line from one request or job.

**Errors.** `instrumentation.ts` logs every server error Next.js catches (server components, route handlers, server actions, proxy) as one `request failed` line with the route, the error digest, the method and the path without its query string. Request bodies and headers are never logged; only the request id is read from the headers. When a user reports an error page, the digest shown to them matches the `digest` in the log.

Error tracking stays in the logs for now. To add a tracker later without changing that default:

1. Pick one that is free or self-hosted: [GlitchTip](https://glitchtip.com) (open source, self-hosted, speaks Sentry's protocol) or Sentry's own self-hosted edition. Both accept the standard Sentry SDK.
2. Add a flag that is off by default, for example `ERROR_TRACKER_ENABLED=false` and `ERROR_TRACKER_DSN=` in `.env.example`. The DSN is set in Vercel only, never in the repository.
3. In `onRequestError` in `instrumentation.ts`, after the `logger.error` call, forward the error only when the flag is `true` and the DSN is set. Send the same redacted fields the log line has (route, digest, kind, path without query), never the raw request.
4. Keep the log line regardless, so turning the tracker off loses nothing.

## Uptime check

`scripts/ops/uptime-check.ts` fetches the home page and `/api/feed`, retries each twice, and exits non-zero if either is down or answers with the wrong kind of content. A rate-limited feed (429) counts as up.

```bash
npx tsx scripts/ops/uptime-check.ts https://example.com
```

**On a schedule, for free:** `.github/workflows/uptime.yml` runs it every hour on GitHub's runners. It is off until you add a repository variable (not a secret):

1. In GitHub, **Settings → Secrets and variables → Actions → Variables → New repository variable**.
2. Name `UPTIME_URL`, value `https://example.com` (your domain). Save.
3. **Actions → Uptime → Run workflow** once to check it passes.

Without the variable the job is skipped and costs nothing. When the site is down the run fails, and GitHub notifies about failed scheduled runs under your own **Settings → Notifications → Actions** (by default it notifies whoever last edited the schedule). On a private repository each run uses about a minute of the free Actions allowance; edit the `cron` line to check less often.

A free external monitor (UptimeRobot, Better Stack) pointed at `/api/health` also works, and checks from outside GitHub; it needs an account with them.

## Backups and the restore drill

Neon keeps 24 hours of history on the free plan. For copies you hold yourself:

```bash
# Dump to ./backups/beliefatlas-YYYYMMDDTHHMMSSZ.dump and keep the newest 7.
DATABASE_URL=postgres://... scripts/ops/backup.sh

# Restore the newest dump into a scratch database, check it, drop the scratch database.
DATABASE_URL=postgres://... scripts/ops/restore-drill.sh
```

**backup.sh** writes a compressed `pg_dump` custom-format file, checks it is readable before renaming it into place (so a half-written dump never counts as the newest), and deletes all but the newest `BACKUP_KEEP` (default 7). Settings: `BACKUP_DATABASE_URL` (wins over `DATABASE_URL`; use Neon's direct host, without `-pooler`, for dumps), `BACKUP_DIR` (default `./backups`), `BACKUP_KEEP`.

**restore-drill.sh** restores the newest dump (or a file you name) into a new database called `beliefatlas_restore_drill_<time>` on the same server, fails on any restore error, then checks:

- the `migrations`, `accounts`, `questions`, `votes` and `vote_events` tables came back, with their row counts printed beside the live ones;
- there are migrations and questions (set `DRILL_ALLOW_EMPTY=1` for a brand new install);
- the dump's newest migration is applied live, so it is a dump of this database;
- no vote points at a missing question or account.

It drops the scratch database whether the drill passes or fails, and refuses any scratch name without `restore_drill` in it. The role needs permission to create databases (Neon's default role has it). Settings: `RESTORE_DATABASE_URL`, `BACKUP_DIR`, `DRILL_DB`, `DRILL_ALLOW_EMPTY`.

Both need the PostgreSQL client tools (`pg_dump`, `pg_restore`, `psql`) at the server's major version or newer, and the drill needs Node.

**Where to run them.** Any machine you control with cron, for example nightly backups and a weekly drill:

```cron
15 3 * * *  cd /path/to/beliefatlas && BACKUP_DIR=/srv/beliefatlas-backups scripts/ops/backup.sh >> /var/log/beliefatlas-backup.log 2>&1
45 3 * * 0  cd /path/to/beliefatlas && BACKUP_DIR=/srv/beliefatlas-backups scripts/ops/restore-drill.sh >> /var/log/beliefatlas-backup.log 2>&1
```

Put `DATABASE_URL` in the cron user's environment, not in the crontab line. Dumps hold account data (hashed phone numbers, votes): keep them on encrypted disk with owner-only permissions (the script sets them), never in git (the script puts a `.gitignore` in the backup folder) and never in a public bucket or share link. Production backups deliberately do not run in GitHub Actions, which would mean storing the production database URL as a repository secret and the dumps as downloadable artifacts.

CI runs both scripts on its own throwaway database on every push, so they keep working as the schema changes.

## Nightly load test

`.github/workflows/nightly.yml` runs every night at 07:23 UTC and on demand (**Actions → Nightly → Run workflow**). On a throwaway Postgres it migrates, loads the questions and the demo votes, then:

- runs `npm run load:test` against the built app at `BASE_URL=http://localhost:3000` (and `DATABASE_URL`), if `package.json` has that script; if not, the run notes that it skipped it;
- runs the backup and restore drill on the result.

The load test's output and the app log are kept as a run artifact for 14 days. It never touches production.

## Migrations

`db/migrate.ts` applies `db/migrations/*.sql` in name order. The original files keep their names (`001_init.sql` to `007_front_door.sql`); every new one must be named `YYYYMMDD_HHMM_description.sql` (UTC time, lowercase letters, digits and underscores), for example `20261117_1810_stage2_contracts.sql`. Timestamps sort after the old numbers and keep branches written at the same time from claiming the same number. CI checks this with `npx tsx scripts/ops/check-migrations.ts`.

## Settings and flags

| Name | Where | Default | What it does |
|---|---|---|---|
| `LOG_LEVEL` | Vercel | `info` | Lowest log level written: `debug`, `info`, `warn`, `error` |
| `UPTIME_URL` | GitHub repository variable | unset (off) | Site the hourly uptime workflow checks |
| `UPTIME_TIMEOUT_MS`, `UPTIME_RETRIES` | uptime command | `10000`, `2` | Per-request timeout and retries |
| `BACKUP_DATABASE_URL` | backup machine | `DATABASE_URL` | Database to dump (use a direct, non-pooled host) |
| `BACKUP_DIR`, `BACKUP_KEEP` | backup machine | `./backups`, `7` | Where dumps go and how many to keep |
| `RESTORE_DATABASE_URL` | backup machine | `DATABASE_URL` | Server the drill restores onto and compares with |
| `DRILL_DB`, `DRILL_ALLOW_EMPTY` | backup machine | generated, off | Scratch database name; accept an empty catalog |
| `TWILIO_ENABLED`, `STRIPE_ENABLED`, `AI_ENABLED` | Vercel | `false` | Paid services, off until set to `true` (see above) |
| `ERROR_TRACKER_ENABLED` | not built yet | — | Suggested flag for a self-hosted tracker; see [Logs and errors](#logs-and-errors) |

# Social Agent

`social-agent` turns selected Reddit posts into platform-native social drafts, banks reusable angles, fills four daily queue slots, and publishes to whichever platforms are enabled.

Current platform surface:
- LinkedIn
- Threads
- X/Twitter
- Instagram
- Facebook Group

Dashboard: [http://localhost:4001](http://localhost:4001)

Maintainer context for humans and coding agents lives in `AGENTS.md`.
Production runtime notes live in `docs/PRODUCTION_RUNTIME.md`; Instagram image
persistence details live in `docs/INSTAGRAM_IMAGE_PIPELINE.md`.

## What changed recently

- The runtime is now TS-first with a split model: `tsx` for source-driven dev tooling and compiled `dist/` output for the production service.
- X is now a first-class platform in the content model, queue, history, API, dashboard, and publish flow.
- X is text-only in this runtime and posts through `POST /2/tweets`.
- X live-post smoke testing is confirmed working with OAuth 2.0 user-context credentials as of April 29, 2026.
- The content engine banks source summaries plus reusable angles so one Reddit source can support multiple future posts.

Tracked default profile:
- `ENABLE_THREADS=true`
- `ENABLE_INSTAGRAM=true`
- `ENABLE_LINKEDIN=false`
- `ENABLE_X=false`
- `ENABLE_FACEBOOK=false`

## Quick start

```bash
git clone https://github.com/OneClickPostFactory/social-agents.git
cd social-agent
npm install
cp .env.example .env
# fill in your credentials
npm run build
npm run fetch
npm run queue
npm run start:pm2
pm2 save && pm2 startup
```

## Runtime model

- Author in TypeScript.
- Use `npm run dev` for source-driven local development through `tsx`.
- Use `npm run build` to compile the runtime into `dist/`.
- Use `npm start` or `npm run start:pm2` to run the compiled `dist/` service in production.
- Do not edit generated build output by hand.
- Runtime state now lives primarily in `data/automation.sqlite` and `data/control-plane.sqlite`.
- The build copies `public/` and `content-os/` into `dist/` so the compiled runtime stays self-contained.

Production intentionally runs compiled JavaScript from `dist/`, not TypeScript through `tsx`. TypeScript is the authoring format; JavaScript is the Node runtime artifact. This keeps production startup smaller, removes the TypeScript transpiler from the live service path, and proves the exact deployable artifact with `npm run smoke:dist` and `npm run ci`.

## OneClickPostFactory SaaS worker mode

For the hosted OneClickPostFactory app, this repo also runs as a headless worker against an owner-managed Supabase project.

Flow:

```text
Lovable app -> Supabase agent_jobs -> social-agent worker -> Supabase tenant tables
```

The browser app must not call this backend directly. The worker polls `agent_jobs`, processes each job by `job.user_id`, checks entitlement from Supabase `profiles`, decrypts tenant credentials from `user_credentials`, and writes tenant-scoped results back to `queue_items`, `publish_history`, `source_records`, `angle_records`, and `worker_logs`.

Required worker env:

```env
SUPABASE_URL=https://<your-owned-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<sb_secret_... or legacy service_role JWT>
CREDENTIAL_ENCRYPTION_KEY=<same-key-used-by-lovable-server-runtime>
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_TIMEOUT_MS=120000
CLOUDINARY_CLOUD_NAME=<cloudinary-cloud-name>
CLOUDINARY_API_KEY=<cloudinary-api-key>
CLOUDINARY_API_SECRET=<cloudinary-api-secret>
CLOUDINARY_FOLDER=social-agent/instagram
```

Cloudflare production no longer uses Worker-side Reddit public JSON/RSS or
Browser Run web-login collection as the active source path. Reddit OAuth is not
available as a reliable product path for this project. Active Reddit collection
is the user-installed OneClick Reddit Connector: it pairs with the tenant's
OneClick account, reads only configured Reddit sources from the user's own
browser context, and writes tenant-scoped `source_records` before any later
OpenAI, angle, queue, or publishing work. Manual import remains an advanced
fallback only. The tenant's Reddit source intent still comes from
`user_sources`; runtime env must not be used as a global tenant author/subreddit
fallback. See `docs/ADR_REDDIT_INGESTION_DECISION.md` before changing this
direction.

Run only the worker loop with:

```bash
npm run worker:supabase
```

Production should run the compiled worker entrypoint:

```bash
npm run build
npm run start:supabase
```

For Cloudflare production, deploy the scheduled Worker:

```bash
npm run deploy:cloudflare
```

Cloudflare runs `src/cloudflare-worker.ts` from a cron trigger every minute. Each scheduled tick claims a small batch of Supabase jobs, processes them, and exits. The local `setInterval` loop remains available for development through `npm run worker:supabase`.

Set Cloudinary credentials as Cloudflare Worker secrets. `OPENAI_IMAGE_MODEL`,
`OPENAI_IMAGE_TIMEOUT_MS`, and `CLOUDINARY_FOLDER` are non-secret Worker vars
in `wrangler.toml`. `OPENAI_IMAGE_TIMEOUT_MS` controls only OpenAI image
generation; do not remove image timeouts entirely.

Local SQLite remains for local admin/dev control-plane state. It is not the SaaS tenant source of truth.

## Platform setup

### LinkedIn

Set:

```env
ENABLE_LINKEDIN=true
LINKEDIN_TOKEN=...
LINKEDIN_PERSON_URN=urn:li:person:...
```

The LinkedIn publisher uses the UGC Posts API and is text-only.

### X / Twitter

Set OAuth 2.0 user-context credentials:

```env
ENABLE_X=true
X_OAUTH2_ACCESS_TOKEN=...
X_OAUTH2_REFRESH_TOKEN=...
X_CLIENT_ID=...
X_CLIENT_SECRET=...
X_REDIRECT_URI=http://127.0.0.1:4001/auth/x/callback
```

`X_OAUTH2_CLIENT_ID` and `X_OAUTH2_CLIENT_SECRET` are also accepted aliases for the labels shown in the X developer portal.

OAuth 1.0a user-context credentials are still supported:

```env
ENABLE_X=true
X_API_KEY=...
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_TOKEN_SECRET=...
```

Notes:
- Preferred path is OAuth 2.0 user-context credentials with an access token, refresh token, client ID, and client secret from the same X app.
- OAuth 2.0 user-context posting is supported through the dashboard connect flow at `/auth/x/start` or by importing portal-generated tokens with `npm run import-x-oauth2`.
- OAuth 1.0a user-context auth also posts through `POST /2/tweets`.
- App-only bearer tokens are not valid for posting.
- Validate the token with `npm run test-x`.
- Publish a deliberate live smoke test with `npm run test-x -- --live-post`.
- The latest confirmed live smoke test posted as `@JohnWOE15`: `https://x.com/i/web/status/2049570569494958455`.
- If auth passes but publish is rejected by X for credits or access tier, the app automatically keeps X in draft-only mode for a cooldown window so other platforms can continue publishing.

### Threads / Instagram / Facebook

Get a Meta token from [Meta Graph API Explorer](https://developers.facebook.com/tools/explorer) with:
- `threads_basic`
- `threads_content_publish`
- `instagram_basic`
- `instagram_content_publish`
- `pages_read_engagement`
- `pages_show_list`
- `publish_to_groups`
- `groups_access_member_info`

Resolve the Threads user ID:

```bash
curl "https://graph.threads.net/me?fields=id,username&access_token=YOUR_THREADS_TOKEN"
```

Resolve the Instagram account from the linked Page:

```bash
curl "https://graph.facebook.com/v25.0/me/accounts?access_token=YOUR_TOKEN"
curl "https://graph.facebook.com/v25.0/PAGE_ID?fields=instagram_business_account&access_token=YOUR_TOKEN"
```

If `FACEBOOK_PAGE_ID` is set, the app can auto-discover the linked Instagram business account and derive a Page access token for Instagram publishing.

Find the Facebook Group ID from `facebook.com/groups/GROUP_ID`.

## Platform behavior

| Platform | Format | Writing shape | Media |
|---|---|---|---|
| LinkedIn | Text post | Concrete, professional, operational | None |
| Threads | Text post | Punchy, direct, conversational | None |
| X | Text post | Sharp, reply-worthy, under 280 chars | None |
| Instagram | Caption + image | Visual, clear, save-worthy | GPT Image asset persisted to Cloudinary before queue/publish |
| Facebook | Text post | Conversational with practical framing | None |

## Commands

`package.json` is strict JSON, so the scripts themselves cannot have real comments. This table is the script commentary and should be updated whenever a script is added or renamed.

| Command | Why it exists | What it runs |
|---|---|---|
| `npm run typecheck` | Catch TypeScript contract errors before a build or deploy. | `tsc --noEmit --project tsconfig.json` |
| `npm run build` | Produce the deployable runtime artifact under `dist/`. | `tsx scripts/build.ts` |
| `npm run test` | Run the focused local security regression suite against compiled output. | `npm run build && node dist/test/security-hardening.test.js` |
| `npm run smoke:dist` | Prove the compiled CLI can boot and read runtime state. | `node dist/src/cli.js status` |
| `npm run ci` | Run the full local release gate in one command. | typecheck, build, dist smoke, security tests |
| `npm run dev` | Start the scheduler and dashboard directly from TypeScript during local development. | `tsx src/agent.ts` |
| `npm run worker:supabase` | Run only the hosted SaaS worker loop against Supabase jobs. | `tsx src/supabase-worker.ts` |
| `npm start` | Start the production service from compiled JavaScript. | `node dist/src/agent.js` |
| `npm run start:supabase` | Start the production SaaS worker from compiled JavaScript. | `node dist/src/supabase-worker.js` |
| `npm run start:pm2` | Start the compiled production service under PM2 supervision. | `pm2 start dist/src/agent.js --name social-agent --restart-delay=5000` |
| `npm run deploy:cloudflare` | Deploy the SaaS worker as a Cloudflare scheduled Worker. | `wrangler deploy` |
| `npm run deploy -- --ref origin/main` | Backup data, rebuild, restart PM2, and health-check a deployment. | `tsx scripts/deploy.ts` |
| `npm run backup` | Snapshot runtime state before deploys or risky operations. | `tsx scripts/backup.ts` |
| `npm run restore -- --from <backup-dir>` | Restore runtime state from a previous backup. | `tsx scripts/restore.ts` |
| `npm run fetch` | Fill empty queue slots from banked angles or fresh Reddit sources. | `tsx src/cli.ts fetch` |
| `npm run queue` | Inspect queued drafts, publish IDs, and retry errors. | `tsx src/cli.ts queue` |
| `npm run status` | Check slot occupancy and memory counts quickly. | `tsx src/cli.ts status` |
| `npm run memory` | Inspect source and angle inventory. | `tsx src/cli.ts memory` |
| `npm run history` | Review recent publish history. | `tsx src/cli.ts history` |
| `npm run post-now` | Publish queued slots immediately through the same automation gate as cron/API. | `tsx src/cli.ts post-now` |
| `npm run import-x-oauth2` | Import X OAuth 2.0 user-context tokens generated in the X developer portal. | `tsx src/cli.ts import-x-oauth2` |
| `npm run test-meta` | Diagnose Meta credentials, Pages, Instagram linkage, Threads, and Group access. | `tsx src/test-meta.ts` |
| `npm run test-x` | Validate the configured X auth mode and optionally live-post a smoke test. | `tsx src/test-x.ts` |

## Operational notes

- Draft generation skips disabled platforms to protect token spend.
- Existing queued items can auto-hydrate missing X drafts from stored source and angle memory when X is enabled later.
- X is confirmed working with the current OAuth 2.0 user-context app; if X later rejects publishing for credits or access tier, the runtime falls back to draft-only mode for X.
- Instagram image generation only runs when Instagram is enabled, and generated images are uploaded to Cloudinary immediately so queued posts do not rely on temporary OpenAI provider URLs.
- Failed platforms no longer force the whole queue item to disappear.
- Partial success is supported, so one platform can succeed while another is retained for retry.
- The API, CLI, and cron now share the same automation gate and SQLite-backed lock layer.

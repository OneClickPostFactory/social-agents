# Production Runtime

This repo is the headless worker for OneClickPostFactory. The production
runtime is a Cloudflare scheduled Worker that polls the owner-managed Supabase
project through `agent_jobs`.

## Architecture

```text
Cloudflare Pages/Worker frontend
  -> owner-managed Supabase tables
  -> agent_jobs
  -> social-agent Cloudflare scheduled Worker
  -> tenant-scoped Supabase rows
```

The browser never calls the social-agent Worker directly. The app inserts
tenant-scoped jobs into Supabase and reads tenant-scoped tables under RLS. The
Worker uses the service-role key only in the trusted Worker runtime.

## Local vs Production

- Local mode uses SQLite files under `APP_DATA_DIR` for queue, history, source,
  angle, platform state, and local control-plane state.
- Any host-local runtime must set `APP_DATA_DIR` to a protected path outside
  the Git checkout. The repository-local `data/` fallback is for disposable
  development only and must not become a service-owned production path.
- Production mode uses Supabase for `profiles`, `user_credentials`,
  `user_sources`, `user_settings`, `source_records`, `angle_records`,
  `queue_items`, `publish_history`, `worker_logs`, and `agent_jobs`.
- Local SQLite state is not a SaaS tenant source of truth.
- PM2/local workers should stay stopped for production. Cloudflare is the
  production worker environment.

## Tenant Scoping Rules

Every production read/write is scoped by `job.user_id`. Do not hardcode tenant
IDs, emails, Reddit usernames, subreddits, platform credentials, subscription
states, Cloudinary URLs, OpenAI image URLs, or deployment URLs.

The Worker must fail closed when tenant settings are missing. Missing Reddit
author settings, missing allowed subreddits, missing credentials, missing
Cloudinary configuration, or expired entitlement must not create queue rows.

## Required Cloudflare Worker Secrets

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or alias `SUPABASE_SECRET_KEY`
- `CREDENTIAL_ENCRYPTION_KEY`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `WORKER_TICK_TOKEN` if manual HTTP ticks are enabled

## Worker Vars

Configured in `wrangler.toml`:

- `NODE_ENV=production`
- `SUPABASE_WORKER_BATCH_SIZE=5`
- `DAILY_INVENTORY_PLANNER_ENABLED=true`
- `DAILY_INVENTORY_PLANNER_START_LOCAL_DATE=YYYY-MM-DD`
- `HTTP_TIMEOUT_MS=45000`
- `OPENAI_IMAGE_MODEL=gpt-image-2`
- `OPENAI_IMAGE_TIMEOUT_MS=90000`
- `CLOUDINARY_FOLDER=social-agent/instagram`

`OPENAI_IMAGE_TIMEOUT_MS` is separate from the generic HTTP timeout and applies
only to OpenAI image generation. The 90-second bound is based on measured
production image latency; image failures must surface as
`instagram_image_generation` errors, release the angle, and yield the current job
rather than continuing into another operation or becoming stale runtime failures.

The Worker derives a tenant-specific Cloudinary subfolder from `job.user_id`
using a hash. This keeps assets grouped per tenant without exposing raw user
IDs in Cloudinary paths.

## Daily Inventory Planner

When enabled, the scheduled Worker prepares the next tenant-local day at 05:00,
07:00, 12:00, and 15:00 for every enabled production platform. Active recovery
rows reserve their matching platform slot and replace, rather than add to, the
normal four-slot inventory.

The planner creates only future-dated work. It never backfills a missed slot,
retries a historical row, or fabricates content to reach the target. When no
approved unused angle or processable source record exists, it records the
`daily_inventory_insufficient` operator result and leaves the queue unchanged.

## OpenAI Generation Safety

Every OpenAI call records a durable `started` event and a terminal `completed`
or `failed` event in `worker_logs`. The Worker will not automatically repeat the
same source or angle operation while an earlier start lacks terminal telemetry;
an operator must first resolve the uncertain attempt. Tenant limits override
the fail-closed defaults of 40 text calls and 4 image calls per UTC day.

## Deployment

Push to `origin/main` on `https://github.com/OneClickPostFactory/social-agents.git`.
The `deploy-cloudflare-worker` workflow runs `npm ci`, `npm run typecheck`,
and `npx wrangler deploy`.

For a manual deploy from this repo:

```sh
npm ci
npm run typecheck
npm run deploy:cloudflare
```

Do not redeploy the frontend from this repo. The frontend lives in the
`oneclickpostfactory` repo.

## Verification

1. Confirm the Cloudflare Worker is listed as the active scheduled Worker.
2. Insert or trigger a tenant-owned `agent_jobs` row from the frontend.
3. Confirm the Worker updates only that job and writes rows with the same
   `user_id`.
4. Confirm `worker_logs` contains useful non-secret messages for the same
   tenant.
5. For Instagram rows, confirm `instagram_image_url` is a Cloudinary URL before
   publish.

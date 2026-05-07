# Social Agent Knowledge Base

This file is the fast-start context for LLMs and human maintainers working in this repo.

## What This Project Does

`social-agent` turns selected Reddit posts into platform-specific social posts, queues them into four daily slots, and publishes them to enabled social platforms.

Current content flow:
1. Fetch posts from allowed subreddits.
2. Filter to posts by `REDDIT_USER`.
3. Bank each Reddit source into multiple reusable angles.
4. Draft only one saved angle at a time into enabled platforms.
5. Generate an Instagram image only when Instagram is enabled.
6. Copy generated Instagram images into Cloudinary so queued posts use stable delivery URLs.
7. Save each transformed item into the automation queue store.
8. Publish only to enabled platforms.
9. Save publish IDs and history in the automation history store.

## Runtime Layout

- `config.ts`: loads `.env`, exposes runtime config, and supports per-platform toggles.
- `src/agent.ts`: cron scheduler and startup checks.
- `src/cli.ts`: local operations like `fetch`, `queue`, `status`, and `post-now`.
- `src/server.ts`: dashboard/API server on `GUI_PORT`.
- `src/automation-service.ts`: shared API/CLI/cron automation service with readiness gates and SQLite locks.
- `src/supabase-worker.ts`: OneClickPostFactory SaaS worker that polls Supabase `agent_jobs`, processes jobs by `job.user_id`, and writes tenant-scoped results back to Supabase.
- `src/supabase-client.ts`: small server-side Supabase REST client that requires `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` or aliases `SUPABASE_SECRET_KEY`/`SERVICE_ROLE_KEY`, and `CREDENTIAL_ENCRYPTION_KEY` for the worker path.
- `src/tenant-credentials.ts`: decrypts SaaS `user_credentials.*_enc` values using `CREDENTIAL_ENCRYPTION_KEY`.
- `src/content-engine.ts`: shared source-bank / angle-bank / queue orchestration.
- `src/publish.ts`: shared publish orchestrator. This is the main place to change multi-platform posting behavior.
- `src/runtime-policy.ts`: runtime readiness checks, platform readiness, and automation gating.
- `src/control-plane.ts`: single-install users, sessions, MFA/RBAC, billing state, runtime settings/secrets, and audit logs.
- `src/validators.ts`: API request validation for auth, settings, and queue mutations.
- `src/cloudinary.ts`: copies temporary remote image URLs to stable Cloudinary delivery URLs.
- `src/http-client.ts`: shared HTTP helper with timeout/error handling.
- `src/linkedin.ts`: LinkedIn publisher using the UGC Posts API.
- `src/x.ts`: X/Twitter publisher using OAuth 1.0a or OAuth 2.0 user-context auth depending on configured credentials.
- `src/threads.ts`: Threads publisher using `graph.threads.net` `/me/...` endpoints.
- `src/instagram.ts`: Instagram publisher using Graph API media container + publish flow.
- `src/facebook.ts`: Facebook Group publisher using Graph API feed posts.
- `src/test-meta.ts`: Meta diagnostics for identity, Page, Instagram linkage, Group access, and Threads account checks.
- `src/test-x.ts`: X diagnostics for the configured auth mode and optional live-post smoke tests.
- `src/store.ts`: SQLite-backed queue/history/source/angle/platform-state persistence with one-time legacy JSON import from the `data/` directory.
- `src/ai.ts`: source extraction, angle drafting, lightweight learning memory, and DALL-E image generation.
- `src/reddit.ts`: Reddit fetcher for allowed subreddits.
- `content-os/`: repo-ready prompt pack that defines source extraction, platform rules, quality checks, and banned phrasing.

## Current Architecture Boundary

This codebase now has two runtime boundaries:

1. Local single-install runtime:

- `APP_DATA_DIR` points to one global runtime data directory.
- Queue, history, source memory, angle memory, platform state, runtime settings, runtime secrets, and billing state are global for that installation.
- Control-plane users are owner/operator/viewer accounts for the same installation, not separate SaaS customer tenants.
- Billing is represented as one access state for the installation, not per tenant or per workspace.

2. OneClickPostFactory SaaS worker runtime:

- `src/supabase-worker.ts` polls Supabase `agent_jobs` when `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` or aliases `SUPABASE_SECRET_KEY`/`SERVICE_ROLE_KEY`, and `CREDENTIAL_ENCRYPTION_KEY` are configured.
- `SUPABASE_URL` must point to the owner-managed OneClickPostFactory Supabase project that Lovable also uses; do not point the worker at a hidden managed project whose secret/service-role key and credential encryption key are unavailable.
- Every SaaS job is processed by `job.user_id`.
- SaaS reads/writes for `profiles`, `user_credentials`, `user_sources`, `user_settings`, `queue_items`, `publish_history`, `source_records`, `angle_records`, and `worker_logs` are scoped by `job.user_id`.
- SaaS credential values are decrypted with `CREDENTIAL_ENCRYPTION_KEY`.
- SaaS billing entitlement is checked from Supabase `profiles`; the local SQLite billing state and local billing bypass do not grant SaaS worker entitlement.
- Local SQLite remains acceptable for local admin/dev state, but it is not the SaaS tenant source of truth.

Known SaaS worker limitations:

- Facebook Group publishing remains paused until the app/token/group permission path is verified.

## Important Build Rule

This repo is authored in TypeScript with a split execution model: `tsx` for source-driven dev/operator commands and compiled `dist/` output for the production service runtime.

- Edit `.ts` files, not generated build output.
- `npm run dev`, `npm run fetch`, `npm run status`, and similar operator commands run from source through `tsx`.
- `npm run build` emits compiled output into `dist/`.
- `npm start` and `npm run start:pm2` run the compiled service from `dist/src/agent.js`.
- The build copies `public/` and `content-os/` into `dist/` for the compiled runtime.

## Current Platform State

As of April 29, 2026:

- Threads posting is confirmed working.
- Instagram posting is confirmed working against the currently accessible Page-linked account.
- LinkedIn code has been merged from `linkedin-agent-v4`, but this repo has not yet live-posted to LinkedIn.
- X is implemented as a first-class text-only platform and live posting is confirmed working with OAuth 2.0 user-context credentials.
- X OAuth 2.0 connect, callback, token persistence, refresh-token support, and portal-token import are implemented in `src/x.ts`, `src/server.ts`, and `src/cli.ts`.
- X live-post smoke test succeeded as `@JohnWOE15` on April 29, 2026: `https://x.com/i/web/status/2049570569494958455`.
- Threads now uses its own token path through `THREADS_ACCESS_TOKEN`.
- Threads uses `/me`, `/me/threads`, and `/me/threads_publish` on `graph.threads.net`.
- Facebook/Instagram Graph defaults were bumped to `v25.0`.
- Instagram can now auto-discover the page-linked `instagram_business_account` and derive a Page access token from `FACEBOOK_PAGE_ID` + `META_ACCESS_TOKEN`.
- Instagram generated images are persisted to Cloudinary when Cloudinary config is present; this avoids expired temporary DALL-E URLs in queued slots.
- Automation readiness currently requires Cloudinary configuration when Instagram is enabled, even though lower-level image generation can still return the original DALL-E URL if Cloudinary is absent.
- Queue retry behavior is safe: failed platforms no longer delete queued items.
- Partial success is supported: one platform can succeed without forcing the whole slot to fail.
- Source reuse is supported: a Reddit post is only exhausted when no banked angles remain.
- Draft generation skips disabled platforms to save tokens.
- Existing queued items can auto-hydrate missing drafts from stored source and angle memory when a platform is enabled later, including X.
- CLI commands, local API routes, and local cron publishing all go through `src/automation-service.ts`, which applies the local automation gate and uses SQLite locks.
- The SaaS worker path goes through `src/supabase-worker.ts`, uses Supabase `agent_jobs`, and does not use local SQLite for tenant queue/history/log/source state.

Current tracked operational mode in `.env.example`:

- `ENABLE_THREADS=true`
- `ENABLE_INSTAGRAM=true`
- `ENABLE_LINKEDIN=false`
- `ENABLE_X=false`
- `ENABLE_FACEBOOK=false`

Important: `config.ts` has fallback defaults that enable Threads, Instagram, and Facebook if no env/runtime setting is present. The tracked `.env.example` pins Facebook off. Keep platform toggles explicit in real deployments.

This was done because:

- Threads and Instagram are both confirmed working.
- LinkedIn has been merged but not yet verified from this repo.
- X remains off in the tracked example config, but live posting is confirmed when valid OAuth 2.0 user-context credentials are configured.
- The Facebook Group still returns `(#3) Missing Permission`.

## Meta Config Notes

Do not mix these IDs up:

- `FACEBOOK_USER_ID`: the Facebook user account ID returned by `/me`
- `FACEBOOK_PAGE_ID`: the Facebook Page ID returned by `/me/accounts`
- `INSTAGRAM_ACCOUNT_ID`: must be the Page-linked `instagram_business_account` ID, not a Facebook user ID
- `FACEBOOK_PAGE_ACCESS_TOKEN`: optional override for Instagram publishing; otherwise the app derives it from the configured Page
- `THREADS_USER_ID`: the Threads account ID returned by `graph.threads.net/me`
- `FACEBOOK_GROUP_ID`: the Group object ID used for `/feed`

Current known live values discovered during diagnostics:

- `FACEBOOK_USER_ID=1483119573444544`
- `FACEBOOK_PAGE_ID=123393450677299`
- `INSTAGRAM_ACCOUNT_ID=17841453638630920`
- `THREADS_USER_ID=25914281681582868`

Do not commit real secrets from `.env`.

## X Config Notes

- Prefer OAuth 2.0 user-context credentials for X publishing: `X_OAUTH2_ACCESS_TOKEN`, `X_OAUTH2_REFRESH_TOKEN`, and either `X_CLIENT_ID`/`X_CLIENT_SECRET` or the X-portal label aliases `X_OAUTH2_CLIENT_ID`/`X_OAUTH2_CLIENT_SECRET`.
- `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, and `X_ACCESS_TOKEN_SECRET` remain supported for OAuth 1.0a user-context auth.
- `X_CLIENT_ID`, `X_CLIENT_SECRET`, and `X_REDIRECT_URI` support the OAuth 2.0 user-context connect flow. `X_OAUTH2_CLIENT_ID` and `X_OAUTH2_CLIENT_SECRET` are accepted aliases for the labels used in the X developer portal.
- `X_OAUTH2_ACCESS_TOKEN` and `X_OAUTH2_REFRESH_TOKEN` are supported for v2 posting after OAuth connect.
- Do not use app-only bearer tokens for posting.
- X publishing is text-only.
- Auth mode priority in `src/x.ts` is OAuth 2.0 refresh-token config, then a static OAuth 2.0 access token, then OAuth 1.0a credentials.
- The OAuth 1.0a path authenticates with `account/verify_credentials` and posts through `/2/tweets`.
- The OAuth 2.0 path authenticates with `/2/users/me` and posts through `/2/tweets`.
- The dashboard owner route `/auth/x/start` begins the OAuth 2.0 flow, and `/auth/x/callback` persists the returned access and refresh tokens into runtime secrets.
- `npm run import-x-oauth2` imports user-context OAuth 2.0 access/refresh tokens generated directly in the X developer portal, saves them into encrypted runtime secrets, validates `/2/users/me`, and only then clears X draft-only mode.
- Queued publishing in `src/publish.ts` only attempts X when OAuth 1.0a credentials or `X_OAUTH2_ACCESS_TOKEN` are present. After OAuth 2.0 connect succeeds, the persisted access token satisfies this requirement.
- If X returns a credits/access-tier publish entitlement error, the runtime switches X into temporary draft-only mode.

## Platform Toggles

These env vars control which platforms are active:

- `ENABLE_THREADS`
- `ENABLE_INSTAGRAM`
- `ENABLE_LINKEDIN`
- `ENABLE_X`
- `ENABLE_FACEBOOK`

Behavior:

- Disabled platforms are skipped by `src/publish.ts`.
- A slot is considered complete if every enabled platform succeeds.
- Disabled platforms do not keep a queue item stuck in retry status.
- The automation gate in `src/runtime-policy.ts` also requires an owner account, active billing access, core credentials, and readiness for each enabled platform.

## Commands That Matter

In this workspace, run Node/npm commands inside the Linux shell and load NVM first:

`source ~/.nvm/nvm.sh && npm run build`

`package.json` is strict JSON, so script commentary belongs here and in the README command table rather than as inline comments inside the scripts object.

- `npm run build`: compile TypeScript to `dist/`
- `npm run typecheck`: TypeScript validation without emitting JS
- `npm run ci`: typecheck, build, compiled smoke test, and local security regression suite
- `npm run dev`: start agent (cron + dashboard) from TypeScript through `tsx`
- `npm run worker:supabase`: start only the Supabase SaaS worker loop
- `npm run test-meta`: diagnose Meta setup
- `npm run test-x`: validate the configured X auth mode and optionally live-post a test update
- `npm run test`: run the local security hardening regression suite
- `npm run fetch`: fill empty queue slots from Reddit
- `npm run queue`: inspect queued content and publish IDs/errors
- `npm run status`: show which slots are filled
- `npm run memory`: inspect source/angle memory counts
- `npm run history`: inspect recent publish history
- `npm run post-now`: immediately post every queued slot to enabled platforms
- `npm run import-x-oauth2`: import X OAuth 2.0 user-context tokens generated in the X developer portal
- `npm run backup`: snapshot `APP_DATA_DIR` into `backups/`
- `npm run restore -- --from <backup-dir>`: restore a backup into `APP_DATA_DIR`
- `npm run smoke:dist`: verify the compiled CLI/runtime wiring
- `npm start`: start compiled agent (cron + dashboard) from `dist/`

## Content OS

The repo includes a prompt pack in `content-os/`:

- `SYSTEM.md`
- `PLATFORM_RULES.md`
- `QUALITY_CHECKS.md`
- `BANNED_PHRASES.json`

`src/ai.ts` uses this OS in practice by:

- extracting a source summary plus multiple reusable angles first
- drafting natively per platform from one selected angle instead of rewriting line by line
- using lightweight learning notes from recent history to avoid repetition
- checking banned phrases
- scoring specificity, human tone, and platform fit before finalizing

## Data Files

- `data/automation.sqlite`: queue, history, sources, angles, platform-state, and automation locks
- `data/control-plane.sqlite`: users, sessions, billing, runtime config/secrets, and audit logs
- `data/control-plane.key`: generated local encryption key when `APP_ENCRYPTION_KEY` is not provided; production should use `APP_ENCRYPTION_KEY`
- `data/queue.json`, `data/used_ids.json`, `data/history.json`, `data/sources.json`, `data/angles.json`, `data/platform-state.json`: legacy import sources retained as runtime artifacts/backups if present
- `data/agent.log`: dashboard log feed
- `backups/`: default backup output directory for `npm run backup`

These files are local runtime state, not source code, and not the source of truth for SaaS tenant data.

## Known Risks

- Instagram posting depends on the currently accessible Page continuing to expose the linked `instagram_business_account`.
- LinkedIn posting still needs a live validation run from this repo even though the publish slice was ported from a working standalone project.
- X posting is confirmed for the current OAuth 2.0 user-context app, but future failures can still happen if credentials expire, the X app permissions change, or credits/access tier are removed.
- Facebook Group posting still depends on app/token/group permissions that are not fixed in code.
- DALL-E image URLs are temporary. If an Instagram slot sits too long before posting, the image URL may expire.
- Cloudinary should be configured for Instagram queues so DALL-E URLs are copied to a stable delivery URL immediately after generation.
- Compiled output can go stale if `npm run build` is skipped before `npm start` or `npm run start:pm2`.

## Good First Checks When Something Breaks

1. Run `npm run build`.
2. Run `npm run test-meta`.
3. Run `npm run test-x` if X is enabled.
4. Run `npm run status` to see whether X is in draft-only mode.
5. Run `npm run queue`.
6. Inspect `data/automation.sqlite`, `data/control-plane.sqlite`, and `data/agent.log`.
7. Confirm `.env` platform toggles match intended behavior.
8. For SaaS worker issues, inspect Supabase `agent_jobs` and `worker_logs` for the affected `user_id`.

## If You Need To Change Publishing Behavior

Start here:

- `src/publish.ts` for platform orchestration
- `src/agent.ts` for cron and startup rules
- `src/cli.ts` and `src/server.ts` for manual and API posting behavior

For Meta diagnostics:

- `src/test-meta.ts`

For Threads-specific work:

- `src/threads.ts`

For X-specific work:

- `src/x.ts`

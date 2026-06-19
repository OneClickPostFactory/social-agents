# Reddit Browser Collector Service Contract

Status: contract plus disabled-by-default backend ingestion endpoint,
local/staging-only source-record write mode, and a staging Cloudflare Browser
Run collector implementation.
Last updated: 2026-06-19.

## Purpose

The Reddit Browser Collector is the target Reddit source-ingestion service for
OneClickPostFactory. It replaces Worker-side Reddit public JSON, Reddit RSS,
Reddit OAuth source ingestion, Devvit, and manual paste as the active product
direction.

The main OneClickPostFactory app remains Cloudflare plus Supabase. It owns the
dashboard, settings, source records, OpenAI pipeline, queue, publishing, logs,
and billing surfaces. The collector is a separate service that handles Reddit
browser session collection and sends normalized source records into the main
backend.

## Service Responsibilities

The collector is responsible for:

- hosted Reddit login/session flow
- encrypted per-user browser state storage
- session status checks
- scheduled and manual Reddit collection
- explicit user-configured Reddit sources only
- normalizing visible Reddit posts into source payloads
- signing payload delivery to the OneClick backend
- maintaining collector-side source cursors, caps, and dedupe hints

The collector is not responsible for:

- OpenAI calls
- angle extraction
- queue creation
- publishing
- billing or entitlement decisions
- OneClick dashboard or product settings outside Reddit collection
- platform credentials for X, LinkedIn, Threads, or Instagram

## Session Lifecycle

Collector session statuses:

- `disconnected`: no usable browser session exists
- `connecting`: user is in the hosted connection flow
- `awaiting_user_login`: a temporary Live View URL has been issued and the
  user must complete Reddit login manually
- `connected`: encrypted browser state is present and recently verified
- `expired`: browser state exists but Reddit requires login or challenge again
- `revoked`: user intentionally disconnected and state was deleted
- `collecting`: one manual collection run is active for the user
- `error`: collector could not determine state safely

Supported user actions:

- `Connect Reddit Browser`
- `Reconnect Reddit Browser`
- `Disconnect`
- `Check session`
- `Delete session`

Disconnect and delete-session actions must remove encrypted browser state. The
collector must never print, return, or log cookies, local storage, session
tokens, passwords, or raw browser storage.

## Source Configuration

Milestone 1 supports subreddit `new` pages, for example:

- `https://www.reddit.com/r/openclawbot/new/`
- `https://www.reddit.com/r/lovablebuildershub/new/`

Later source types:

- Reddit user profile submitted pages
- keyword/search pages

The main app's `user_sources` table is the source-of-truth for configured
sources. The collector must verify a requested `source_id` belongs to the
authenticated `user_id`, is enabled, is a healthy Reddit subreddit source, and
matches the requested subreddit before it opens Browser Run.

Source configuration fields:

```json
{
  "user_id": "uuid",
  "source_id": "uuid",
  "source_type": "subreddit_new",
  "source_value": "r/openclawbot",
  "enabled": true,
  "schedule": "manual",
  "max_posts_per_run": 5,
  "max_posts_per_day": 25,
  "last_collected_at": "2026-06-18T00:00:00Z",
  "last_error_code": null,
  "last_error_message": null,
  "health_status": "healthy"
}
```

Recommended source health statuses:

- `healthy`
- `not_configured`
- `disabled`
- `expired_session`
- `needs_attention`
- `rate_limited`
- `blocked`
- `error`

The collector may store its own source state, but the main app remains the
source-of-truth for which sources a user has explicitly configured.

## Normalized Payload Contract

Each delivered record must include:

```json
{
  "tenant_user_id": "uuid",
  "source_config_id": "uuid",
  "source_url": "https://www.reddit.com/r/openclawbot/comments/post_id/title/",
  "reddit_post_id": "t3_example",
  "title": "Visible Reddit post title",
  "subreddit": "openclawbot",
  "author": "reddit_author_if_visible",
  "post_body": "Visible body text or useful snippet",
  "captured_at": "2026-06-18T00:00:00Z",
  "collector_type": "authenticated_browser",
  "content_hash": "sha256:title/body/url hash",
  "raw_metadata": {
    "source_type": "subreddit_new",
    "permalink": "https://www.reddit.com/r/openclawbot/comments/post_id/title/"
  }
}
```

Payload rules:

- `tenant_user_id` and `source_config_id` must map to a permitted user/source.
- `collector_type` must be `authenticated_browser`.
- `source_url` must be a valid Reddit HTTPS URL.
- `post_body` may be an excerpt, but it must contain enough visible source text
  for later angle extraction.
- `raw_metadata` must be minimal and safe. It must not contain cookies, session
  state, request headers, browser storage, credentials, or private account data.

## Backend Ingestion Contract

Proposed first backend endpoint:

```text
POST /api/collector/reddit/source-records
```

Current implementation status:

- endpoint exists in the backend route surface
- disabled by default unless `COLLECTOR_INGEST_ENABLED=true`
- validates HMAC signatures using `COLLECTOR_INGEST_HMAC_SECRET`
- validates normalized browser collector payloads
- dry-run by default
- write mode requires `COLLECTOR_INGEST_WRITE_ENABLED=true`
- write mode also requires `COLLECTOR_INGEST_ENV=local` or
  `COLLECTOR_INGEST_ENV=staging`
- production write mode is blocked by policy
- write mode creates `source_records` only
- no OpenAI, `angle_records`, `queue_items`, publishing, or production Supabase
  side effects occur from the ingestion endpoint

Current source-record mapping:

- `user_id` maps to the tenant user id
- `source_id` is verified against an enabled tenant-owned `user_sources` row
- `source_url` maps to `source_records.url`
- `title` maps to `source_records.title`
- `collector_type = authenticated_browser` maps to
  `source_records.origin = authenticated_browser`
- `captured_at` maps to `source_records.fetched_at`
- `reddit_post_id`, `subreddit`, `author`, `content_hash`, and `post_body`
  map to their matching source-record fields where present
- `source_text` is required before write; metadata-only collector records are
  rejected

The downstream source-record processing path accepts `origin = manual` and
`origin = authenticated_browser` records when they are tenant-scoped, banked,
unused, and include `source_text`. The collector ingestion endpoint still stops
at source-record creation; it never silently calls OpenAI, queues, or publishes.

The endpoint should:

- authenticate the collector payload
- verify timestamp freshness and reject replayed requests
- validate the request schema
- verify the tenant/source allowlist
- dedupe by `reddit_post_id`, `source_url`, and `content_hash`
- create `source_records` only
- write a safe ingestion audit/log summary
- return a structured result with created, duplicate, rejected, and invalid
  counts

The endpoint must not:

- call OpenAI during the first ingestion proof
- create `angle_records` directly during the first ingestion proof
- create `queue_items`
- publish anything
- trust client-provided ownership without server-side source mapping
- expose internal secrets or raw diagnostic payloads

Recommended signing model for Milestone 1:

- `X-OneClick-Collector-Id`: identifies the collector integration
- `X-OneClick-Timestamp`: Unix timestamp or ISO timestamp
- `X-OneClick-Signature`: HMAC-SHA256 over timestamp plus canonical JSON body
- replay window: 5 minutes
- idempotency key: `source_config_id:reddit_post_id:content_hash`

The signing secret must be stored outside source control and rotated through the
deployment platform's secret manager.

## Security Boundaries

Collector security requirements:

- encrypt browser state per user at rest
- isolate browser contexts per user
- never log cookies, sessions, tokens, browser storage, or passwords
- delete browser state on disconnect/revoke
- collect only explicitly configured Reddit source pages
- do not scrape DMs, inbox, modmail, saved posts, votes, account settings, or
  private account pages
- do not bypass CAPTCHA or access controls
- do not use stealth scraping or residential proxy behavior
- enforce per-source and per-user daily caps
- rate-limit manual collection
- record safe audit events for connect, disconnect, session check, collection
  start, collection success, and collection failure
- return safe user-facing errors only

Main backend security requirements:

- verify collector authentication before parsing ownership-sensitive data
- enforce tenant/source allowlists server-side
- treat all collector payload fields as untrusted input
- reject invalid or duplicate payloads without OpenAI, queue, or publish side
  effects
- store source text only when it is necessary for downstream angle extraction
- keep raw collector diagnostics out of user-facing responses

## Milestone 1 Scope

Milestone 1 proves the full boundary without turning on automation:

- standalone Cloudflare Worker collector service
- Cloudflare Browser Run human-in-the-loop Live View login
- Supabase JWT validation with `user_id` derived from the access token
- server-side collector rollout guard:
  `disabled`, `allowlist`, or future `all_entitled_users`
- allowlist staging for the first test user; later production rollout must use
  entitlement from `profiles`, not client-side user-id gating
- connect/reconnect flow
- encrypted session storage
- one configured subreddit source, with `openclawbot` first and
  `lovablebuildershub` as fallback
- manual collection only
- max 5 visible posts per run
- signed delivery to staging or local backend
- backend staging dry-run validates signed payloads with write mode disabled
- backend source-record write mode remains local/staging-only and production
  writes remain blocked
- no OpenAI calls
- no `angle_records`
- no `queue_items`
- no publishing
- Browser Run REST credential failures must return safe actionable errors such
  as `cloudflare_browser_api_auth_failed`, not raw 500s or leaked diagnostics

Success criteria:

- user can connect a Reddit browser session
- collector can verify session status without logging session contents
- collector can collect one configured subreddit page
- collector sends a signed payload accepted by a non-production backend
- backend validates, dedupes, and writes source records only
- invalid, duplicate, stale, or unsigned payloads create no downstream side
  effects

## Future Milestones

Milestone 2:

- production ingestion endpoint behind collector authentication
- authenticated app status surface for collector session and source health
- manual collect button wired to collector, not the Cloudflare Worker
- source record creation visible in Memory

Milestone 3:

- scheduled collector runs
- per-source caps and backoff
- source health and audit visibility
- controlled handoff from accepted source records to existing OpenAI angle
  extraction

Milestone 4:

- user profile submitted pages if allowed and stable
- keyword/search pages if justified
- managed browser runtime hardening

## Explicit Non-Goals

This contract does not re-enable:

- Reddit public JSON from Cloudflare Worker
- Reddit RSS from Cloudflare Worker
- Reddit OAuth as source ingestion
- Devvit as the next ingestion path
- manual paste/import as the main product direction

Manual import remains an advanced fallback only. The collector direction is a
separate user-authorized browser service that feeds source records into the
existing OneClickPostFactory pipeline.

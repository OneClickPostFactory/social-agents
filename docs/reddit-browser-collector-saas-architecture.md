# Archived Reddit Browser Collector SaaS Architecture

## Current System Truth

OneClickPostFactory is a multi-tenant SaaS. The main app remains Cloudflare plus
Supabase and owns dashboard routes, user settings, tenant-owned source records,
OpenAI angle extraction, queue generation, publishing, logs, and billing
state.

This Browser Run / Playwright web-login direction is archived. The current SaaS
source-connection path is normal Reddit authorization: the app stores encrypted
per-user Reddit tokens, fetches configured subreddit sources through Reddit's
authenticated API, writes normalized `source_records`, and does not own OpenAI,
queue creation, publishing, billing, or product settings outside Reddit source
collection.

Cloudflare Worker-side Reddit public JSON, RSS, Browser Run/Playwright
web-login collection, and Devvit are inactive/archive paths. Manual import
remains an advanced fallback, not the normal Reddit ingestion direction.

## Canonical Tenant Key

The canonical tenant key is the authenticated Supabase Auth user id. The app
does not currently model workspaces, organisations, or memberships. Tables such
as `profiles`, `user_sources`, `source_records`, `angle_records`,
`queue_items`, `publish_history`, `worker_logs`, and `agent_jobs` are scoped by
`user_id`.

`profiles.user_id` is a unique reference to `auth.users(id)`. Deleted auth
users cascade through profile and tenant-owned rows where foreign keys are
declared.

## Permanent Internal Owner Account Intent

The permanent internal owner account is an operational/product-owner account,
not the tenant model. It must remain its own isolated tenant while bypassing the
payment wall and receiving full product and collector entitlement without
expiry.

The owner account does not bypass:

- global emergency feature-disabled state
- tenant isolation
- source ownership checks
- session and collection limits
- Reddit API/source collection capacity protection
- abuse-prevention limits

The owner email is only a provisioning input. Ongoing authorization must use the
immutable Supabase Auth user id.

## How Permanent Owner Access Is Represented

Permanent owner access is represented by
`public.internal_access_overrides`, keyed by immutable `user_id`.

An active non-expiring owner override is:

- `access_level = internal_owner`
- `billing_exempt = true`
- `collector_entitled = true`
- `status = active`
- `expires_at = null`

The table is service-role owned. Browser roles receive no table grants and no
self-service write policy. Stripe webhooks update subscription fields on
`profiles`; they do not create, update, or revoke internal owner overrides.

## Normal User Subscription And Entitlement Path

Normal users remain plan-gated through `profiles.subscription_status`,
`profiles.trial_ends_at`, `profiles.current_period_end`, and optional
time-limited `profiles.dev_access_until`.

Subscription state is written by trusted server/webhook paths. Browser clients
may read their own profile row but cannot update entitlement or billing fields.

## Access-Decision Precedence

1. Global emergency feature-disabled state denies everyone.
2. Active permanent internal owner override grants billing-exempt, non-expiring
   product and collector entitlement.
3. Normal subscription, trial, canceled-current-period, or time-limited dev
   entitlement grants or denies access for normal users.
4. Collector rollout policy controls exposure: `disabled`, `allowlist`, or
   `all_entitled_users`.
5. Operational safety limits still apply.

## Tables Reused

- `profiles`: normal subscription state and time-limited dev/test access.
- `user_sources`: source-of-truth for configured Reddit subreddit sources.
- `source_records`: stored source payloads from manual import or authenticated
  browser collection.
- `angle_records`: OpenAI-extracted angle bank.
- `queue_items`: platform drafts and scheduled publish queue.
- `publish_history`: external publish proof.
- `agent_jobs`: validated worker job queue.
- `worker_logs`: safe tenant-scoped operational logs.

## Tables Not Needed

No workspace, organisation, membership, or separate source-ownership table is
needed for Milestone 1. `user_id` remains the tenant key and `user_sources`
remains the source authority.

## Missing Controls

Production rollout still needs:

- remote migration and idempotent owner provisioning
- Browser Run REST credential validation in the deployed collector environment
- real connect/reconnect proof through Live View
- manual Reddit login by the owner account
- collection from an owned enabled subreddit source
- reconnect/disconnect proof
- passive production/staging monitoring after deployment

## Durable Object Responsibilities

The collector Durable Object owns one session coordinator per authenticated
user. It stores minimal session metadata, encrypted browser state, Live View
expiry metadata, and collection lock state. It must not log or persist plaintext
cookies, browser storage, Live View URLs, or browser session identifiers in safe
responses.

## Supabase Responsibilities

Supabase owns authentication, tenant rows, source records, downstream product
state, billing status, internal access overrides, RLS, and security-definer
RPCs. Browser clients must not write entitlement, billing, source-record, queue,
or publish-history rows directly.

## Collector Responsibilities

The collector verifies Supabase JWTs, derives `user_id` from the verified token,
checks central entitlement/rollout, validates source ownership, manages Browser
Run sessions, collects only configured subreddit `/new` pages, normalizes at
most two posts for the first live owner proof, and delivers signed payloads to
staging/backend ingestion.

## Backend Responsibilities

The backend validates collector signatures and payloads, verifies tenant/source
relationships, dedupes source records, and creates `source_records` only when
local/staging write mode is explicitly enabled. Staging writes for the first
live proof must also pass the owner/source canary scope. Ingestion does not call
OpenAI, create `angle_records`, create `queue_items`, enqueue jobs, or publish.

Explicit downstream processing may later consume `origin = manual` and
`origin = authenticated_browser` records when they include `source_text`.

## Frontend Responsibilities

The frontend consumes server-controlled entitlement and collector state. It
must not hardcode permanent owner email checks. Browser Collector controls send
the current Supabase access token, use real stored `user_sources.id` values, do
not persist Live View URLs, and display safe error categories.

## Entitlement Model

Normal product entitlement comes from `profiles`. Permanent owner entitlement
comes from `internal_access_overrides`. Collector access uses the same central
authority before normal subscription checks, while retaining disabled-mode and
operational safety limits.

## Quota Model

Existing worker/job limits remain in force:

- validated `enqueue_agent_job` rate limits
- per-tenant OpenAI usage controls on `user_settings`
- queue slot limits
- collector maximum of five posts per manual run
- one active collector session and collection per user

No new usage table is required for Milestone 1.

## Rollout Model

Collector rollout remains configuration-driven:

- `disabled`: deny session and collection routes
- `allowlist`: staging proof mode
- `all_entitled_users`: future production mode using central entitlement

The permanent internal owner override is not a client-side allowlist entry and
does not require code changes for future normal-user rollout.

## End-To-End Data Flow

1. User signs into OneClickPostFactory through Supabase Auth.
2. Frontend calls collector staging with the Supabase access token.
3. Collector verifies JWT and derives canonical `user_id`.
4. Collector checks disabled mode, permanent owner override, normal
   entitlement, rollout, and source ownership.
5. Collector starts or reuses a Browser Run session.
6. User completes Reddit login manually through Live View.
7. Collector encrypts browser state and stores it in the user Durable Object.
8. User manually collects from an owned enabled subreddit source.
9. Collector normalizes at most five visible Reddit posts.
10. Collector signs and sends the payload to backend staging.
11. Backend staging validates and dry-runs, or local/staging write mode creates
    `source_records` only.
12. Later explicit downstream processing can extract angles, fill queue slots,
    and publish through the existing pipeline.

## Security Boundaries

- No owner email or immutable user id is committed.
- No browser role can self-assign owner access.
- No collector request trusts body-supplied `user_id`.
- Source IDs must be stored, enabled, healthy, Reddit subreddit sources owned by
  the authenticated user.
- Ingestion rejects cookies, tokens, browser storage, queue/publish/OpenAI
  side-effect hints, and overlong bodies.
- Production collector delivery and production source-record writes remain
  disabled until a separate approval.
- The collector does not collect DMs, inbox, modmail, saved posts, votes,
  account settings, or private pages.

## Production Rollout Requirements

Before production rollout:

- apply the additive internal access migration
- provision the permanent internal owner override once through the private
  service-role provisioning script
- validate Browser Run credential permissions
- deploy collector/backend/frontend fixes
- prove Connect, manual Reddit login, collection, staging dry-run delivery,
  reconnect, and disconnect
- monitor for unexpected jobs, OpenAI calls, queue rows, publishing, and Worker
  errors
- keep rollout as `allowlist` until the staged proof is complete
- move to `all_entitled_users` only by configuration after monitoring and
  capacity review

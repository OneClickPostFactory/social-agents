# Social Agent API Contract

Audit / refresh date: 2026-04-22

Scope:
- This document is grounded in the current backend implementation.
- Code truth wins over README or UI language when they differ.
- Machine-readable REST contract: [openapi.yaml](./openapi.yaml)
- Backend build plan: [BACKEND_BUILD_PLAN.md](./BACKEND_BUILD_PLAN.md)

## 1. System Overview

`social-agent` is now a secure single-tenant content automation backend with a local control plane.

What it does now:
- serves a local HTTP API and dashboard
- supports owner bootstrap, login, logout, and password change
- stores sessions, billing state, encrypted secrets, and audit logs in SQLite
- keeps the existing Reddit -> AI -> queue -> publish engine
- supports first-class platform drafting and publishing for LinkedIn, Threads, X, Instagram, and Facebook
- gates automation behind owner auth, billing status, and runtime readiness
- stores legacy automation state in local JSON files
- can also run a OneClickPostFactory SaaS worker loop that polls an owner-managed Supabase `agent_jobs` table and writes tenant-scoped results back by `job.user_id`

What it still does not implement in the local HTTP control plane:
- multi-tenant org/workspace model for local SQLite API routes
- multiple users or server-side role hierarchy beyond `owner`
- email verification or password reset flow
- OAuth callback flows for platform connection
- inbound product webhooks other than Stripe billing
- distributed worker scaling beyond the Supabase `agent_jobs` polling loop
- database-backed replacement for local queue/history/source/angle storage outside the SaaS worker path

Primary code files:
- `config.ts`
- `src/control-plane.ts`
- `src/runtime-policy.ts`
- `src/server.ts`
- `src/agent.ts`
- `src/content-engine.ts`
- `src/store.ts`
- `src/publish.ts`
- `src/ai.ts`

## 2. Architecture Map

### Runtime shape

- HTTP server: plain `node:http`
- scheduler: `node-cron`
- control-plane persistence: SQLite via `node:sqlite`
- automation persistence: local JSON files under `data/`
- UI: static `public/index.html`

### State boundaries

Control-plane state:
- `data/control-plane.sqlite`
- optional `data/control-plane.key`

Automation state:
- `data/automation.sqlite`
- `data/queue.json`
- `data/history.json`
- `data/sources.json`
- `data/angles.json`
- `data/used_ids.json`
- `data/agent.log`
- `data/platform-state.json` if present as legacy runtime artifact/import source

SaaS worker state:
- owned Supabase `agent_jobs`
- owned Supabase `profiles`, `user_credentials`, `user_sources`, `user_settings`
- owned Supabase `queue_items`, `publish_history`, `source_records`, `angle_records`, `worker_logs`
- all SaaS reads/writes are scoped by `job.user_id`

### End-to-end flow

1. First start can run in setup mode with no owner and no stored secrets.
2. `POST /api/auth/bootstrap` creates the owner account and starts a trial billing state.
3. Authenticated settings routes store runtime config and encrypted secrets.
4. Runtime config is reloaded into the live process after settings/secrets updates.
5. Automation routes are available only when:
   - an owner session is present
   - CSRF passes for writes
   - billing status is `trialing` or `active`
   - runtime readiness checks pass
6. The content engine fills slots from saved angles first, then fresh Reddit extraction.
7. Scheduled or manual publish uses the existing platform adapters.

### Trust boundaries

- Browser -> backend:
  - session cookie auth
  - optional cross-origin credentialed requests through `APP_ALLOWED_ORIGINS`
- backend -> control-plane DB:
  - local SQLite
- backend -> automation files:
  - local filesystem
- backend -> third-party APIs:
  - Reddit
  - OpenAI
  - X API
  - Threads
  - Meta Graph
  - LinkedIn
  - Stripe

## 3. API Surface Inventory

Global behavior:
- matched API errors return JSON `{ "error": string }`
- mutating authenticated routes require `X-CSRF-Token`
- session auth uses an HTTP-only cookie:
  - `social_agent_session` when `COOKIE_SECURE=false`
  - `__Host-social_agent_session` when `COOKIE_SECURE=true`
- CORS is allowlist-based through `APP_ALLOWED_ORIGINS`
- request body size is capped by `MAX_BODY_BYTES`

### Public routes

#### `GET /healthz`
- purpose: liveness plus DB/setup/readiness snapshot
- auth: none
- response:
  - `ok`
  - `time`
  - `db`
  - `setup`
  - `readiness`
  - `automation`

#### `GET /api/bootstrap/status`
- purpose: onboarding readiness before login
- auth: none
- response:
  - `setup`
  - `readiness`
  - `automation`
  - `stripe`

#### `GET /api/auth/me`
- purpose: session introspection
- auth: optional
- unauthenticated response:
  - `authenticated: false`
  - `setup`
  - `stripe`
- authenticated response:
  - `authenticated: true`
  - `user`
  - `csrfToken`
  - `billing`
  - `readiness`
  - `stripe`

#### `POST /api/auth/bootstrap`
- purpose: create the only owner account for the installation
- auth: none
- body:
  - `email: string`
  - `password: string` minimum 12 chars
- behavior:
  - returns `409` if owner already exists
  - starts billing state in `trialing`
  - sets session cookie

#### `POST /api/auth/login`
- purpose: owner login
- auth: none
- body:
  - `email`
  - `password`
- behavior:
  - sets session cookie on success

#### `POST /api/billing/webhook`
- purpose: Stripe subscription state sync
- auth: Stripe signature only
- headers:
  - `Stripe-Signature`
- behavior:
  - validates webhook signature
  - updates stored billing state for supported Stripe events

### Authenticated control-plane routes

#### `POST /api/auth/logout`
- auth: session + CSRF
- response:
  - `success`

#### `POST /api/auth/password`
- auth: session + CSRF
- body:
  - `currentPassword`
  - `nextPassword`
- response:
  - `success`

#### `GET /api/settings`
- auth: session
- response:
  - `runtime`
  - `storedRuntimeSettings`
  - `secretPresence`
  - `readiness`
  - `billing`
- notes:
  - runtime platform toggles now include `ENABLE_X`
  - secret presence may include `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_OAUTH2_ACCESS_TOKEN`, `X_OAUTH2_REFRESH_TOKEN`, `X_CLIENT_ID`, and `X_CLIENT_SECRET`

#### `PUT /api/settings/runtime`
- auth: session + CSRF
- body:
  - `settings: object`
- behavior:
  - sanitized and persisted to control-plane storage
  - live config reload triggered

#### `PUT /api/settings/secrets`
- auth: session + CSRF
- body:
  - `secrets: object`
- behavior:
  - string values are trimmed and encrypted at rest
  - `null` or empty string removes a stored secret
  - live config reload triggered

#### `GET /api/billing`
- auth: session
- response:
  - `billing`
  - `stripe`

#### `POST /api/billing/checkout-session`
- auth: session + CSRF
- body:
  - `interval: "monthly" | "yearly"` default monthly
- behavior:
  - creates Stripe customer if missing
  - creates Stripe subscription checkout session

#### `POST /api/billing/portal-session`
- auth: session + CSRF
- behavior:
  - returns Stripe billing portal URL if customer exists

#### `GET /api/audit-logs`
- auth: session
- response:
  - latest 100 audit log entries

### Authenticated automation routes

All write routes below require:
- session
- CSRF
- automation gate open

Automation gate means:
- owner exists
- billing access is active
- runtime readiness is satisfied

#### `GET /api/status`
- auth: session
- response:
  - `slots`
  - `stats`
  - `memory`
  - `readiness`
  - `billing`
  - `config`
- notes:
  - `config.platforms` includes `x`
  - queue items may include `post.x`, `post.ids.x`, and `post.publishErrors.x`
  - X publish capability is tracked in the SQLite platform-state store when provider entitlement blocks live posting

#### `GET /api/queue`
- auth: session
- response:
  - array of `{ slot, post }`

#### `GET /api/history`
- auth: session
- response:
  - latest 50 history entries

#### `GET /api/memory`
- auth: session
- response:
  - `stats`
  - `sources`
  - `recentAngles`

#### `GET /api/logs`
- auth: session
- response:
  - latest 150 log lines

#### `POST /api/fetch`
- auth: session + CSRF + automation gate
- purpose: fill queue from banked angles or fresh extraction

#### `POST /api/post-slot`
- auth: session + CSRF + automation gate
- body:
  - `slotId`

#### `POST /api/post-all`
- auth: session + CSRF + automation gate

#### `PUT /api/slot`
- auth: session + CSRF + automation gate
- body:
  - `slotId`
  - `updates`
- note:
  - still weakly validated

#### `DELETE /api/slot`
- auth: session + CSRF + automation gate
- body:
  - `slotId`

## 4. Auth and Permissions Contract

### Session auth

Implemented in:
- `src/control-plane.ts`
- `src/server.ts`

Properties:
- single owner account only
- password hashing uses `scrypt`
- session token is hashed before DB storage
- CSRF token stored per session
- cookie is `HttpOnly`
- `Secure` and `SameSite` are configurable

### Permission model

Server-side roles:
- `owner`

Server-side authorization:
- public routes require none
- control-plane routes require owner session
- automation writes require owner session, CSRF, and automation gate

Not implemented:
- multi-user RBAC
- org/workspace tenancy
- impersonation

## 5. Data Model Contract

### New control-plane entities

#### `app_users`
- purpose: owner account storage
- fields:
  - `id`
  - `email`
  - `role`
  - `password_hash`
  - `created_at`
  - `updated_at`
  - `last_login_at`

#### `app_sessions`
- purpose: persistent session storage
- fields:
  - `id`
  - `user_id`
  - `token_hash`
  - `csrf_token`
  - `expires_at`
  - `created_at`
  - `last_seen_at`
  - `user_agent`
  - `ip`

#### `app_singletons`
- purpose: singleton JSON or encrypted config blobs
- keys used now:
  - `runtime_settings`
  - `runtime_secrets`
  - `billing_state`

#### `app_audit_logs`
- purpose: security and control-plane audit trail
- fields:
  - `id`
  - `actor_user_id`
  - `action`
  - `target`
  - `metadata_json`
  - `ip`
  - `created_at`

### Legacy automation entities still in use

- `QueueItem`
- `HistoryEntry`
- `SourceRecord`
- `AngleRecord`

These live in the SQLite-backed automation store, with legacy JSON files retained only as import/runtime artifacts if present. Shape definitions are described in `src/types.ts`.

## 6. Gaps and Risks

### Remaining high-priority gaps

- no password reset flow
- no email verification
- no request rate limiting
- `PUT /api/slot` is still weakly validated
- queue/history/source/angle/platform-state data is SQLite-backed, but broader cross-process operational guarantees are still single-node oriented
- `node:sqlite` is still an experimental Node module
- no distributed background job locking beyond the current SQLite automation lock layer

### Operational notes

- first bootstrap creates a live owner account and starts a live trial state
- Stripe checkout and portal routes require valid Stripe env config
- readiness can be satisfied by env-backed config even when no secrets are stored in SQLite yet
- X readiness requires `ENABLE_X=true` plus either:
  - `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, and `X_ACCESS_TOKEN_SECRET`
  - or `X_OAUTH2_ACCESS_TOKEN`
- The preferred X path is OAuth 2.0 user-context credentials. Portal-generated tokens can be imported with `npm run import-x-oauth2`; dashboard OAuth still starts at `/auth/x/start`.
- Even when X auth is valid, live publish can still fail at the provider due to credits or access tier changes. The runtime can temporarily mark X as draft-only in the SQLite platform-state store.

## 7. Build-Ready Summary

What frontend and product teams can rely on now:
- secure owner bootstrap/login flow
- cookie session auth with CSRF on writes
- encrypted secret persistence
- billing-aware automation gating
- settings API for runtime config and platform secrets
- protected legacy automation API

What should still be treated as next-phase work:
- public internet hardening beyond current baseline
- password recovery
- platform OAuth connect flows
- transactional persistence for automation state

## 8. Evidence Map

Core control plane:
- `src/control-plane.ts`
- `src/runtime-policy.ts`
- `src/server.ts`

Runtime integration:
- `config.ts`
- `src/agent.ts`

Legacy automation engine:
- `src/content-engine.ts`
- `src/store.ts`
- `src/publish.ts`
- `src/ai.ts`
- `src/types.ts`

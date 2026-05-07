# Secure Single-Tenant Backend Build Plan

Audit / implementation date: 2026-04-22

## Goal

Turn `social-agent` into a secure single-tenant subscription product without throwing away the working content engine.

The strategy is:
- keep the existing Reddit -> AI -> queue -> publish pipeline
- add a secure control plane around it
- store settings and secrets outside raw `.env` usage
- gate automation behind owner auth, billing state, and runtime readiness

## Implemented Now

The following backend work is now in the repo:

### 1. Secure single-tenant control plane

Files:
- `src/control-plane.ts`
- `src/runtime-policy.ts`

What it adds:
- owner bootstrap flow
- login/logout
- password change
- session storage in SQLite
- CSRF protection for mutating authenticated routes
- encrypted runtime secret storage
- billing state storage
- audit log storage

### 2. Setup-mode runtime instead of crash-on-missing-env

Files:
- `config.ts`
- `src/agent.ts`

What changed:
- runtime config can now come from stored settings/secrets, not only `.env`
- the agent no longer hard-fails when onboarding is incomplete
- automation only runs when:
  - an owner exists
  - billing allows access
  - required source/platform settings are present

### 3. Authenticated backend API surface

File:
- `src/server.ts`

What changed:
- public bootstrap/auth/billing readiness endpoints added
- settings and secret management endpoints added
- billing checkout and portal session endpoints added
- Stripe webhook endpoint added
- audit log endpoint added
- previous automation endpoints are now auth-protected
- automation write routes are additionally gated by billing/readiness

### 4. Security hardening added in this pass

What is implemented:
- password hashing with `scrypt`
- session token hashing before persistence
- AES-256-GCM encrypted secret blob at rest
- HTTP-only session cookie
- configurable `SameSite` / `Secure` cookie policy
- CSRF token requirement on authenticated writes
- request body size limit
- JSON parse failures now return an error instead of silently degrading
- baseline response hardening headers
- CORS allowlist support through `APP_ALLOWED_ORIGINS`

## Current Backend Shape

### Persistence

- Legacy automation state remains in local JSON files under `data/`
  - queue
  - history
  - source memory
  - angle memory
  - logs
  - platform capability state such as X draft-only cooldown windows
- New control-plane state is stored in:
  - `data/control-plane.sqlite`
  - `data/control-plane.key` if `APP_ENCRYPTION_KEY` is not provided

### Auth model

- exactly one owner account per installation
- session cookie auth
- no multi-user model
- no org/workspace tenancy

### Billing model

- single installation billing state
- trial starts at owner bootstrap
- Stripe checkout session creation supported
- Stripe billing portal session creation supported
- Stripe webhook updates subscription status
- automation access is allowed only for `trialing` or `active`

## API Groups

### Public

- `GET /healthz`
- `GET /api/bootstrap/status`
- `GET /api/auth/me`
- `POST /api/auth/bootstrap`
- `POST /api/auth/login`
- `POST /api/billing/webhook`

### Authenticated control-plane routes

- `POST /api/auth/logout`
- `POST /api/auth/password`
- `GET /api/settings`
- `PUT /api/settings/runtime`
- `PUT /api/settings/secrets`
- `GET /api/billing`
- `POST /api/billing/checkout-session`
- `POST /api/billing/portal-session`
- `GET /api/audit-logs`

### Authenticated automation routes

- `GET /api/status`
- `GET /api/queue`
- `GET /api/history`
- `GET /api/memory`
- `GET /api/logs`
- `POST /api/fetch`
- `POST /api/post-slot`
- `POST /api/post-all`
- `PUT /api/slot`
- `DELETE /api/slot`

## Recommended Deployment Shape

For the OneClickPostFactory SaaS direction, the recommended deployment is now:

- one Lovable app deployment for the UI/control plane
- one owner-managed Supabase project as the SaaS source of truth
- Lovable browser code uses only Supabase URL + anon/publishable key
- trusted server runtimes use service-role credentials only server-side
- one local or hosted `social-agent` worker polls Supabase `agent_jobs`
- every worker read/write is scoped by `job.user_id`
- Stripe subscription state is stored in Supabase `profiles` and re-checked by the worker before automation/publishing

The older one-backend-per-customer shape remains valid for isolated single-install deployments, but it is not the preferred SaaS path for the Lovable-hosted OneClickPostFactory app.

## Remaining Work Before Public Launch

These items are still recommended before exposing the backend on the public internet:

### Priority 1

- add reverse-proxy TLS termination and strict HTTPS-only cookies in production
- add password reset flow and email verification
- add request rate limiting
- add structured server-side input validation instead of ad hoc object checks
- add backup and restore procedure for SQLite and `data/`

### Priority 2

- move from `node:sqlite` experimental runtime usage to a stable production persistence choice
  - either PostgreSQL
  - or a stable SQLite driver such as `better-sqlite3`
- add server-side secret rotation workflow
- add account lockout / brute-force throttling
- add health subchecks and metrics endpoint
- expand structured provider error taxonomy and provider capability state beyond the current X draft-only fallback

### Priority 3

- add email delivery for billing notices and password reset
- replace direct token pasting with OAuth connect flows for supported platforms
- add background job locking across concurrent publish/fetch actions
- add integration tests for auth, billing gating, and queue writes

## Implementation Principles Going Forward

- do not rewrite the content engine unless it blocks product correctness
- keep auth, secrets, billing, and audit concerns separate from publish logic
- prefer strict validation and explicit gating over permissive silent fallbacks
- preserve the single-tenant model unless product strategy changes

# Reliability repair progress

This file records only implementation status that is evidenced by repository changes and CI. It does not claim production deployment or provider readiness.

## Sequence 1: release identity and complete CI gate

Status: merged to upstream `main` through PR #2. The final pre-merge branch head was proven by the complete upstream pull-request CI gate before merge.

Evidence:

- `npm run ci` gates typecheck, the complete repository test suite, and the compiled runtime smoke check.
- the deploy workflow runs that same gate before Wrangler deployment.
- Cloudflare version metadata and the deployment Git SHA are exposed separately from provider readiness.
- hosted Threads and Instagram publication remain explicitly unavailable; Facebook remains paused; LinkedIn compatibility remains unverified; X remains tenant-scoped.
- no production deployment is claimed by this change.

## D03 containment: overlapping tenant runtime state

Status: merged to upstream `main` through PR #3 after fresh upstream CI passed on the branch synchronised to the PR #2 merge commit.

The Cloudflare scheduled and authenticated `/tick` job-drain entry points share one per-isolate exclusive run gate. This prevents two overlapping SaaS drains in the same Worker isolate from entering the mutable tenant runtime concurrently. Separate Worker isolates do not share process globals.

The containment regression deliberately interleaves two executions, proves maximum concurrent execution is one, and proves a rejected execution releases the gate.

## D03 runtime isolation: process-global config and token callbacks

Status: merged to upstream `main` through PR #4. Fresh upstream CI run #88 passed `npm ci` and the complete `npm run ci` gate on synchronised head `f68e4434efc18053d11c85ff1b3d2dd334c5dc3d` before merge. The upstream PR #4 merge commit is `033b9b578c120bec0b725311eba1db3d3bfe5530`.

The Worker installs async-scoped accessors on the existing config object only after Cloudflare bindings have been copied into `process.env`. Each scheduled/authenticated SaaS drain then runs inside its own `AsyncLocalStorage` context.

Within that context:

- tenant config writes made by the existing `withTenantRuntime` path are copy-on-write and remain inside the current async execution instead of mutating process-global values;
- OpenAI, Cloudinary, Instagram, Facebook and provider modules that already read the shared config object transparently resolve the scoped values without a flag-day call-signature rewrite;
- Threads, LinkedIn and X token-persistence setters use scope-local callback slots when a SaaS runtime scope exists;
- token rotation updates only the current scoped config snapshot while the Supabase persistence callback remains attached to that same async execution;
- outside a SaaS runtime scope, the existing local single-tenant behaviour is preserved.

The current `processPendingSupabaseJobs()` implementation remains serial, so tenant runtime mutation is restored between jobs inside a drain. The earlier exclusive run gate remains defence-in-depth but is no longer the only boundary preventing overlapping Worker invocations from sharing config or token callbacks.

The proven regression covers overlapping tenant credentials, scope-local Threads/LinkedIn/X persistence callbacks, rotated-token isolation, base-config isolation and failure cleanup. Explicit provider-client arguments remain desirable architectural cleanup, but the process-global cross-tenant safety defect is no longer the active blocker.

No provider is re-enabled and no deployment was performed by these D03 repairs.

## D22: fail-closed tenant platform activation

Status: implemented on `codex/fail-closed-platform-settings`; upstream pull-request CI evidence is required before merge.

Tenant platform activation now has one explicit policy: a platform is active only when its persisted `*_enabled` setting is exactly boolean `true`. Missing settings rows, missing fields, `null` and `false` all remain disabled.

The regression covers:

- a missing settings object enabling no platforms;
- all-null flags enabling no platforms;
- all-false flags enabling no platforms;
- mixed settings enabling only explicit `true` entries;
- canonical platform ordering when all five platforms are explicitly enabled.

No provider is re-enabled, no credential semantics change, no queue or billing behaviour changes, and no deployment is performed by this repair.

## Next bounded repair

After D22 is green and merged, proceed to atomic database claims/fencing for jobs, sources and angles, then publication-attempt identity and unknown-outcome handling. Meta publication remains disabled until the publication ledger and provider-specific restoration work are ready.

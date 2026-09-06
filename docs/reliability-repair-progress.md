# Reliability repair progress

This file records only implementation status that is evidenced by repository changes and CI. It does not claim production deployment or provider readiness.

## Sequence 1: release identity and complete CI gate

Status: implemented on `codex/reliability-foundation-1` and proven by upstream pull-request CI on head `a73d1d9202f5013a944b9a2320ebb22be7caf4b1`.

Evidence:

- `npm run ci` gates typecheck, the complete repository test suite, and the compiled runtime smoke check.
- the deploy workflow runs that same gate before Wrangler deployment.
- Cloudflare version metadata and the deployment Git SHA are exposed separately from provider readiness.
- hosted Threads and Instagram publication remain explicitly unavailable; Facebook remains paused; LinkedIn compatibility remains unverified; X remains tenant-scoped.
- no production deployment is claimed by this change.

## D03 containment: overlapping tenant runtime state

Status: implemented and proven by upstream pull-request CI on head `ee377775030d27117b2568bc10426da8304c7a24`.

The Cloudflare scheduled and authenticated `/tick` job-drain entry points share one per-isolate exclusive run gate. This prevents two overlapping SaaS drains in the same Worker isolate from entering the mutable tenant runtime concurrently. Separate Worker isolates do not share process globals.

The containment regression deliberately interleaves two executions, proves maximum concurrent execution is one, and proves a rejected execution releases the gate.

## D03 runtime isolation: process-global config and token callbacks

Status: implemented on `codex/immutable-tenant-runtime`; upstream CI evidence is still required before this layer can be marked proven.

The Worker now installs async-scoped accessors on the existing config object only after Cloudflare bindings have been copied into `process.env`. Each scheduled/authenticated SaaS drain then runs inside its own `AsyncLocalStorage` context.

Within that context:

- tenant config writes made by the existing `withTenantRuntime` path are copy-on-write and remain inside the current async execution instead of mutating process-global values;
- OpenAI, Cloudinary, Instagram, Facebook and provider modules that already read the shared config object transparently resolve the scoped values without a flag-day call-signature rewrite;
- Threads, LinkedIn and X token-persistence setters use scope-local callback slots when a SaaS runtime scope exists;
- token rotation updates only the current scoped config snapshot while the Supabase persistence callback remains attached to that same async execution;
- outside a SaaS runtime scope, the existing local single-tenant behaviour is preserved.

The current `processPendingSupabaseJobs()` implementation remains serial, so tenant runtime mutation is restored between jobs inside a drain. The earlier exclusive run gate remains defence-in-depth but is no longer the only boundary preventing overlapping Worker invocations from sharing config or token callbacks.

Acceptance evidence required before this layer is considered proven:

- two deliberately overlapping runtime scopes resolve different OpenAI/provider credentials;
- Threads, LinkedIn and X token rotations invoke only the persistence callback belonging to their own scope;
- rotated credentials remain visible inside the originating scope but do not change the base config or the other scope;
- a failed scoped execution cannot leak its config into the next execution;
- the complete `npm run ci` gate passes on the exact branch SHA.

No provider is re-enabled and no deployment is performed by this refactor.

## Next bounded repair

After runtime isolation is green, make missing tenant platform settings fail closed (D22), then proceed to atomic database claims/fencing and publication-attempt identity. Meta publication remains disabled until the publication ledger and provider-specific restoration work are ready.

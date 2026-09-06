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

Status: containment implemented on `codex/tenant-runtime-containment`; immutable provider/client context refactor still required before D03 can be marked complete.

The Cloudflare scheduled and authenticated `/tick` job-drain entry points now share one per-isolate exclusive run gate. This prevents two overlapping SaaS drains in the same Worker isolate from entering `withTenantRuntime` concurrently. Separate Worker isolates do not share process globals.

This is deliberately a containment layer, not the target architecture. The remaining D03 work is to remove tenant-specific mutation of shared `config` and shared token-persistence callbacks and pass immutable tenant/connection context to provider and generation clients.

Acceptance evidence required before this containment is considered proven:

- deliberately interleaved async runs never overlap inside the gate;
- a failed run does not poison the next queued run;
- the complete CI gate passes on the exact branch SHA.

## Next bounded repair

After containment is green, replace shared tenant runtime mutation with immutable request-scoped/provider-scoped context. Do not re-enable Meta publication as part of that refactor.

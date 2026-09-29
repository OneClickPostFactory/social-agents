# Cloud acceptance readiness — milestone 1

The owner approved the seven delivery milestones on 29 September 2026. This
change implements the first runtime prerequisite, not all seven milestones.

`GET /readyz` is an operator-only, effect-free endpoint, authenticated with the
existing WORKER_TICK_TOKEN. A configuration request proves exact deployed
version, source tag and required binding presence without querying the database.
A database request checks only the three existing metadata RPCs and their
required capabilities. No scheduler, tenant record, model, provider, job claim
or completion path is invoked. A readiness response never authorises execution.

The caller supplies X-OCPF-Expected-Version (UUID), X-OCPF-Expected-Sha (40 hex),
X-OCPF-Readiness-Nonce (32–64 hex), and X-OCPF-Readiness-Mode (configuration or
database). Responses are non-cacheable, echo the challenge and identify the
actual version. Failed authentication stays opaque. Errors contain fixed codes,
not credentials, origins, database responses or tenant data. Only hosted
Supabase origins, or a temporary tunnel in explicit staging, are admitted.

This addresses the previous acceptance design defect: `/healthz` liveness was
followed immediately by a business tick before authentication, version and
backend readiness were distinguished. It is not yet proof of the cause of every
previous HTTP 404/500, or evidence that hosted acceptance has passed.

The app-owned harness must verify the active deployment and exact version,
perform bounded configuration/database probes, then execute each acceptance
job once. Only effect-free probes may be retried. An ambiguous job/tick failure
must stop the experiment. Preserve every trial, including failures and cleanup.

Production controls, cron configuration, provider capability gates and existing
ledgers are unchanged. No new database branch, subscription, image service or
always-running compute is required. Cloud execution still needs capacity/budget
verification and independent teardown. The app repository retains private
schema source; do not copy it into this public repository for CI savings.

Local validation on the operator's isolated coding environment: TypeScript
check and 63 synthetic readiness tests passed. Hosted/full current-head CI is a
separate result and must be read before promotion. No production deployment was
performed by this source change.

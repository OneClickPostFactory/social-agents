# Pilot-Readiness Evidence Pack

As of April 27, 2026, this backend is positioned as pilot-ready for a dedicated single-customer deployment. It is not positioned as a broad enterprise rollout or a multi-tenant SaaS control plane.

## 1. Executive Summary

This backend is in a materially stronger state than the earlier single-owner tool baseline. The current codebase has explicit bootstrap protection, hardened admin authentication, role-based access inside a single installation, validation on mutating routes, transactional SQLite-backed automation state, shared automation governance across API/CLI/cron paths, backup and restore tooling, and a compiled `dist/` production runtime with CI validation.

The honest positioning is:

- pilot-ready for one customer per install
- not multi-tenant
- not a broad self-serve SaaS rollout
- not a substitute for enterprise SSO, centralized key management, or HA infrastructure

For an enterprise pilot, the backend can reasonably be described as a dedicated deployment with hardened local controls and verified operational safeguards. It should not be described as a mature multi-tenant enterprise platform.

## 2. Control Summary

### Identity and admin access

- Bootstrap is no longer openly claimable. Bootstrap is restricted by configured mode and can require a token or local-only access.
- Password-only admin access is no longer the sole control. The backend now includes MFA support, failed-auth throttling, and failed-auth audit events.
- Session lifecycle is hardened. Password changes revoke existing sessions and the control plane supports logout of active sessions.

### Authorization and access boundaries

- The backend is no longer a pure single-owner surface. It now supports `owner`, `operator`, and `viewer` roles.
- Sensitive routes such as billing, secrets, and user management remain owner-only.
- Read-only operational views are separated from mutation routes.

### API and state integrity

- Mutating routes are validated instead of relying on schema-less body merges.
- Unsafe slot mutation is blocked. Publish IDs, internal queue metadata, and similar non-editable fields are not accepted from clients.
- CSRF enforcement remains in place for authenticated writes.
- Public health is minimal, while detailed readiness is protected.

### Automation and runtime safety

- Queue, history, source, angle, and platform state are backed by SQLite rather than file-authoritative JSON.
- Automation mutations are lock-protected to reduce duplicate execution and cross-surface race conditions.
- API, CLI, and cron now run through the same automation gate and policy checks.

### Deployment and recovery controls

- Production runtime is explicit: compiled `dist/` output is the service artifact.
- Backup and restore scripts exist and were exercised against a clean restore drill.
- CI validates typecheck, build, compiled-runtime smoke, and the security regression suite.

### Observability and auditability

- Request logging is structured enough for pilot operations.
- Audit logs cover security-relevant and administrative actions.
- Forced failure review showed logs and audit entries are usable for operator investigation, with the caveat that provider-level correlation can still improve.

## 3. Verification Summary

The following items have been locally verified against the current backend state:

- TypeScript validation passed.
- Compiled `dist/` build passed.
- Built CLI smoke test passed against `dist/src/cli.js`.
- Security regression suite passed from compiled output.
- Clean-environment backup and restore drill passed and the restored instance booted successfully.
- Hostile auth tests passed for:
  - bootstrap denial without required bootstrap control
  - brute-force throttling window
  - revoked-session reuse denial
  - MFA-required access denial before verification
- Concurrency stress passed for overlapping automation attempts across API, cron-equivalent service paths, and CLI.
- Forced failure review confirmed that logs, queue error state, and audit output are usable for pilot incident review.

Platform-specific verification remains intentionally differentiated:

- Threads posting is confirmed working.
- Instagram posting is confirmed working against the currently accessible linked account path.
- X is integrated and live posting is confirmed with OAuth 2.0 user-context credentials. The April 29, 2026 smoke test posted as `@JohnWOE15`: `https://x.com/i/web/status/2049570569494958455`.
- LinkedIn code is present but still needs a live post validation from this repository.
- Facebook Group posting remains permission-dependent and is not positioned as a proven path.

## 4. Deployment / Operating Model

This backend is designed to operate as a dedicated single-customer installation.

- One customer per install
- One queue and one content memory set per install
- One local control plane per install
- One runtime data directory per install

Current execution model:

- Source-driven dev and operator commands use `tsx`
- Production service runtime uses compiled `dist/`
- PM2 is the documented process manager path for the service
- Runtime state is stored under `APP_DATA_DIR`, primarily in SQLite files

Operationally, this is a single-node deployment model. It assumes standard surrounding infrastructure such as host security, TLS termination, and normal system administration outside the application code itself.

## 5. Current Limitations

These are real limitations, but they are not the same as pilot blockers in the current dedicated-install model:

- The product is not multi-tenant.
- The product does not yet present SSO, SCIM, or enterprise federation as a first-class auth model.
- Secret custody is not yet positioned as centralized KMS-backed secret management.
- The deployment model is single-node rather than HA/distributed.
- Observability is serviceable for pilot operations, but not yet a full metrics-and-tracing stack.
- Provider maturity is uneven across channels:
  - Threads, Instagram, and X are the proven live paths
  - X publish capability can still regress if provider entitlement, app permissions, credits, or token state change
  - LinkedIn still needs a live validation run from this repo
  - Facebook remains the weakest operational slice

These should be framed as future maturity work rather than represented as already solved.

## 6. Suggested Wording for Customer or Stakeholder Conversations

### Short version

This backend is ready for a controlled enterprise pilot as a dedicated single-customer deployment. It is not a multi-tenant SaaS platform and it is not yet positioned for broad enterprise rollout.

### Slightly fuller version

The current backend has been hardened beyond its earlier single-owner prototype state. Admin bootstrap is protected, authentication is throttled and MFA-capable, privileged access is role-scoped inside the installation, mutating APIs are validated, automation state is transactional and lock-protected, and backup/restore plus compiled-runtime verification are in place. We are positioning it for a dedicated pilot deployment, not for multi-tenant scale-out or broad self-serve enterprise distribution.

### Important caveat wording

- This is a one-customer-per-install model.
- It is not multi-tenant.
- It is pilot-ready, not broad enterprise-rollout-ready.
- Some maturity items such as SSO, centralized key management, richer observability, and HA remain roadmap work rather than current claims.

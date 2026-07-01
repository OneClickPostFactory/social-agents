# Codex Workflow Guardrails

## Reuse Before Rebuild

Before creating a new repo, runtime, connector, service, or POC, audit the
existing codebase and document what already exists. Prefer adapting existing
repos and modules when they are still aligned with the product direction.

For Reddit source ingestion, do not create another connector while
`/home/oneclickwebsitedesignfactory/reddit-user-connector` exists. That repo is
the active user-installed connector direction.

Ask before introducing a new repo, runtime, deployment target, browser
automation surface, or credential model.

## Rejected Reddit Paths

Do not revive these as active source-ingestion paths:

- Browser Run Reddit login
- backend Playwright or CLI Reddit login
- Reddit OAuth without confirmed obtainable and usable credentials
- Reddit public JSON from the Worker
- Reddit RSS from the Worker
- Devvit outbound bridge
- copied cookies
- copied browser storage state
- manual paste as the main product direction

Manual import may remain an advanced fallback only.

## Acceptance Evidence

Do not use mocks, fake payloads, `example.com`, unit tests, or local-only
fixtures as acceptance evidence for source ingestion. Acceptance is:

```text
installed connector -> real Reddit posts -> owner-scoped source_records
```

Connector ingestion must create `source_records` only. It must not call OpenAI,
create angle records, create queue rows, or publish during ingestion.

## Dead Code

Do not preserve dead code "just in case." Delete obsolete active code paths. If
historical evidence is worth keeping, document it clearly as archived reference
and make sure it cannot be mistaken for product direction.

# Reddit RSS Recovery Checkpoint

Date: 2026-06-03

## Problem Solved

The deployed Cloudflare Worker had started receiving `reddit_rss_http_403` from
Reddit RSS while later investigation showed the proven end-to-end Reddit runtime
path was actually public JSON. The old recovery pressure was to force Reddit
OAuth or rewrite history as RSS-first. That is not the current product strategy,
and it is also not correct to erase the historical public JSON evidence.

The RSS recovery patch made RSS safer and diagnosable, added source-level
backoff for Worker-side 403s, and added manual Reddit import as the approved
fallback when server-side fetching is blocked. A later focused patch removed
Reddit OAuth from the product source path and renamed misleading Reddit
`acquisition_mode = oauth` rows to `public_json`.

## Verified May 21 Runtime Truth

Follow-up Cloudflare runtime investigation confirmed the last known good
source-fetching flow on 2026-05-21 ran on backend Worker version
`3e2a598a-b8bc-461f-9a40-d65b3ad2e156`, likely backend commit `fc53fcb Add
OpenAI usage visibility and runaway protection`.

That successful flow used runtime adapter `reddit_public_json`, not RSS. Reddit
public JSON returned HTTP 200, fetched 20 subreddit posts, accepted 17 posts,
and rejected 3 posts with `rejected_author_mismatch`. OpenAI angle extraction was
reached, `angle_records` were created, platform drafts and `queue_items` were
created, and scheduled publishing later completed with `publish_history` rows.

The relevant source rows had `acquisition_mode = oauth`, but the runtime adapter
was `reddit_public_json`, not `reddit_oauth`. That acquisition label was
misleading and has been replaced by `public_json` for Reddit public JSON rows.
RSS was not the May 21 success path. RSS has returned HTTP 200 separately, but
persisted Worker evidence shows zero RSS accepted posts, angle records, queue
rows, or publishes.

Guardrails for future LLM/code sessions:

- Do not claim RSS was the May 21 success path.
- Do not remove public JSON; it is the only proven end-to-end Reddit fetch path.
- Do not present RSS as the proven May 21 path; keep it best-effort.
- Do not force Reddit OAuth as the fix; it is removed/quarantined from the
  product source path.
- Do not call OpenAI when source fetching fails.
- Do not retry Reddit fetches blindly after 403; use source health/backoff.
- Do not fill queue directly from metadata-only `source_records`.
- Manual import remains the dependable fallback direction when Reddit blocks
  server-side fetching.

## Files Changed

Backend:

- `src/supabase-worker.ts`
- `test/source-ssrf.test.ts`
- `AGENTS.md`
- `docs/REDDIT_ANGLE_BANK.md`
- `docs/REDDIT_RSS_RECOVERY_CHECKPOINT.md`

Frontend:

- `src/routes/_authenticated/app.memory.tsx`
- `src/integrations/supabase/types.ts`
- `tests/user-source-rpcs.test.ts`
- `docs/kb.md`
- `docs/agent-worker.md`

Database migration:

- `supabase/migrations/20260603152000_recover_reddit_rss_and_manual_import.sql`

## Reddit RSS Fetch Path Now

- Reddit RSS URLs are canonicalized before fetch to `www.reddit.com`.
- `https://reddit.com/user/Advanced_pudding9228/.rss` becomes
  `https://www.reddit.com/user/Advanced_pudding9228/.rss`.
- Lowercase usernames remain supported.
- RSS fetch uses the honest app user agent:
  `OneClickPostFactory/early-access (+https://www.oneclickpostfactory.com)`.
- RSS/XML Accept remains:
  `application/rss+xml, application/atom+xml, text/xml, application/xml, text/plain`.
- Existing protections remain in place: HTTPS-only validation, SSRF blocking,
  manual redirects, redirect revalidation, max 5 redirects, timeout caps, body
  size caps, and content-type validation.
- RSS failures log safe metadata only: source id, job id, adapter, HTTP status,
  original/attempted/final hosts, content type, canonicalized flag, and stable
  error code. Response bodies are not logged.
- `reddit_rss_http_403` marks the source `needs_attention` and sets
  `blocked_until` to avoid aggressive retry loops.
- RSS failure does not trigger OpenAI, source record creation, angle creation,
  queue creation, public JSON fallback, or publishing.

## Manual Import Now

- The Memory page has a manual Reddit import form for URL, title, and body text.
- Browser code calls the validated `import_manual_source` RPC.
- The RPC stores a tenant-scoped `source_records` row with `origin = manual` and
  enough `source_text` for angle extraction.
- Manual imports enter the same existing pipeline as accepted source posts:
  source record -> OpenAI angle extraction -> `angle_records` -> platform drafts
  -> `queue_items`.
- Existing banked `source_records` that only contain title, URL, author, and
  subreddit metadata are not draftable shortcuts. A source record needs enough
  stored body text or matching usable `angle_records`.

## Intentionally Not Changed

- Publishing behavior was not changed.
- Queue slot logic was not changed.
- Platform publisher payloads were not changed.
- OpenAI prompts were not changed.
- Tenant security/RLS policies were not loosened.
- Reddit public JSON was not made the normal fallback path.

## Focused Public JSON / OAuth Removal Update

Later on 2026-06-03, Reddit OAuth was removed/quarantined from the product source
path without destructively dropping credential columns. Existing misleading
Reddit `acquisition_mode = oauth` rows are migrated to `public_json`, preserving
source ids, ownership, values, filters, timestamps, and enabled/disabled state.

This update:

- preserves the `reddit_public_json` adapter and May 21 working path
- stops normal source fetching from attempting a Reddit OAuth token exchange
- stops the backend worker from decrypting tenant Reddit client id/secret for
  source fetching
- removes Reddit client id/secret from the browser credential UI
- removes Reddit OAuth recommendation/warning copy
- keeps RSS available as best-effort
- does not build new manual import behavior in this patch

## Local Tests Passed Before Deploy

Backend:

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `git diff --check`

Frontend:

- `npm run test`
- `npm run build`
- `git diff --check`

Frontend typecheck:

- Unavailable; the frontend repo has no `typecheck` script.

## Not Yet Happened At This Checkpoint

- Supabase migration has not yet been applied.
- Backend Worker has not yet been deployed.
- Frontend has not yet been deployed.
- No jobs have been triggered by this patch preparation.
- No source fetch has been triggered by this patch preparation.
- No OpenAI live call has been made by this patch preparation.
- No publishing has happened.

## Post-Deploy Verification To Record

Recorded after deploy on 2026-06-03:

- Supabase migration applied: yes.
- Backend Worker deployed: yes, `oneclickpostfactory-agent` version
  `c502ab4e-fcd1-4fdd-8d76-8e56c3cf2849`.
- Frontend Worker deployed: yes, `oneclickpostfactory` version
  `a6e78e12-74e0-448d-bb7a-91ee3ca3cf8c`.
- Controlled Fetch Sources job id:
  `86f0a2d4-bde0-474f-a566-7fffac64a382`.
- RSS status: Reddit returned HTTP 403 from the Worker runtime.
- Canonical URL evidence: worker log recorded `original_host = reddit.com`,
  `attempted_host = www.reddit.com`, `final_host = www.reddit.com`, and
  `canonicalized_url = true`.
- Honest user agent: deployed code uses
  `OneClickPostFactory/early-access (+https://www.oneclickpostfactory.com)`.
- RSS/XML Accept header: deployed code preserves
  `application/rss+xml, application/atom+xml, text/xml, application/xml, text/plain`.
- Public JSON fallback attempted: no.
- OpenAI ran: no; `openaiUsage.textCalls = 0` and
  `openaiUsage.imageCalls = 0`.
- Source marked `needs_attention`: yes. The source
  `d564b5e3-1f85-4d01-9240-301a98d24503` was marked with
  `last_error_code = reddit_rss_http_403` and
  `blocked_until = 2026-06-03T22:18:41.197+00:00`.
- Source records created: none.
- Angle records created: none.
- Queue items created: none.
- Publish history created: none.
- Manual import tested live: no. UI presence and RPC wiring were verified in
  build/tests; no live manual import was submitted during this verification.
- Publishing remained untouched: yes. No publish job was triggered and no
  publish history row was created.

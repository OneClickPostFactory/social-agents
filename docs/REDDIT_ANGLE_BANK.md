# Reddit Ingestion And Angle Bank

## Production Tenant Rules

The Supabase SaaS worker is tenant-scoped by `agent_jobs.user_id`.
Every read of tenant configuration and every write to sources, angles, queue
items, publish history, and logs must include that `user_id`.

Reddit ingestion separates tenant isolation from source intent.

Tenant isolation is always `agent_jobs.user_id`: every read and write remains
scoped to that user. Source intent is checked separately before an item can
become a `source_records`, `angle_records`, or `queue_items` row.

`user_sources` now declares intent with:

- `provider`: `reddit`, `generic_rss`, or `manual`
- `acquisition_mode`: `oauth`, `rss`, `devvit`, or `manual`
- `source_scope`: `reddit_user`, `subreddit`, `reddit_search`, or `generic_rss`
- `target_author`: optional normalized Reddit author
- `allowed_subreddits`: optional normalized subreddit list
- `allow_unfiltered_rss`: explicit opt-in for broad RSS discovery

Rules:

- `source_scope = reddit_user` requires the fetched item's Reddit author to
  match `target_author`. RSS author feeds are still checked after fetch; an RSS
  item whose author does not match is rejected as `rejected_author_mismatch`.
- `source_scope = subreddit` requires the item to belong to an allowed
  subreddit. If a tenant-level or source-level `target_author` exists, both
  subreddit and author must match.
- `source_scope = generic_rss` is legacy metadata only. RSS is quarantined from
  normal product flow and should not be offered as a normal source path.
- Manual Reddit import is a first-class fallback for Reddit fetch blocks. It stores a
  tenant-scoped `source_records` row with `origin = manual` and enough
  `source_text` for angle extraction. Metadata-only source records are not
  draftable shortcuts.

Legacy `rss` rows are preserved for history but quarantined from normal
ingestion. They should never silently bypass a tenant's Reddit author or
allowed-subreddit intent.

Usernames and subreddits are normalized before comparison, so values such as
`u/example`, `@example`, `r/builders`, and full reddit.com URLs compare by their
canonical names.

## Reddit Public JSON Source Path

Normal UI-created Reddit author and subreddit sources use Reddit public JSON
(`acquisition_mode = public_json`). This is the only supported Reddit source
path in the normal product flow because it is the only path with persisted
end-to-end Cloudflare Worker evidence.

Reddit OAuth is removed/quarantined from the product source path. Reddit RSS is
also quarantined from normal user flow. Existing Reddit RSS rows may remain for
history, but they should be disabled or marked `needs_attention` with
`last_error_code = reddit_rss_source_unsupported`; the worker skips them before
fetching and must not call OpenAI or create source/angle/queue rows from them.

The old RSS fetch helper remains SSRF-tested safety code, not a supported
product path. It keeps URL validation, manual redirect handling, redirect target
revalidation, max redirects, timeout caps, body size caps, and content-type
validation for any future focused recovery work.

### Verified May 21, 2026 Runtime Truth

The last known good source-fetching flow on 2026-05-21 did not use RSS. It ran
on Cloudflare backend Worker version
`3e2a598a-b8bc-461f-9a40-d65b3ad2e156` (likely backend commit `fc53fcb Add
OpenAI usage visibility and runaway protection`) and persisted Worker logs with
adapter `reddit_public_json`.

That runtime path:

- returned HTTP 200 from Reddit public JSON
- fetched 20 subreddit posts
- accepted 17 posts
- rejected 3 posts with `rejected_author_mismatch`
- reached OpenAI angle extraction
- created `angle_records`
- created platform drafts and `queue_items`
- later completed scheduled publish jobs and `publish_history` writes

The source rows carried `acquisition_mode = oauth`, but the runtime adapter was
`reddit_public_json`, not `reddit_oauth`. That label was misleading and has been
renamed to `public_json` for Reddit public JSON rows. Future work must not claim
RSS was the May 21 success path, must not force Reddit OAuth as the proven fix,
and must not delete public JSON.

RSS has returned HTTP 200 separately from the Cloudflare Worker runtime, but the
persisted Worker evidence shows zero RSS accepted posts, zero source records,
zero angle records, zero queue rows, zero publish rows, and zero OpenAI calls.
Current strategy is: preserve public JSON as the supported path, quarantine RSS
from normal flow, keep manual import as the fallback when Reddit blocks
server-side fetching, and keep source-fetch failures from calling OpenAI.

Public JSON settings still exist for explicit advanced/runtime control:

- `REDDIT_PUBLIC_JSON_TRANSPORT=auto|fetch|node_https`

Reddit client ID/secret values are not part of the product source path and must
not be presented as required setup. Existing encrypted columns may remain
temporarily for non-destructive compatibility, but the worker does not use them
to choose source-fetch behavior. The tenant's source intent rows remain the only
inputs that decide which Reddit posts may enter that tenant's workflow.

Automated Reddit fetching remains the product direction. Manual paste/import is
a fallback for blocked server-side fetches, not the main operating model.

### Reddit Request Shape

Reddit public JSON requests must use an honest, descriptive Reddit-format
User-Agent:

`cloudflare-worker:oneclickpostfactory:v0.1 (by /u/Advanced_Pudding9228)`

Public JSON uses:

- `Accept: application/json, text/plain;q=0.9, */*;q=0.8`
- `Accept-Language: en-GB,en;q=0.9`
- `Cache-Control: no-cache`

The retained RSS safety helper uses the same User-Agent and preserves an
RSS/XML-oriented Accept header:

`application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain;q=0.9, */*;q=0.8`

Do not add fake browser headers, spoof Chrome/Safari/Firefox, send cookies, or
add `sec-fetch`/`sec-ch` browser fingerprint headers. If Reddit blocks the
Cloudflare Worker egress despite the honest request shape, record the failure,
back off where supported, and keep OpenAI out of the failed source-fetch path.

`REDDIT_PUBLIC_JSON_TRANSPORT=auto` uses `node:https` in local Node and `fetch`
in Cloudflare. Forcing `node_https` in a runtime that cannot use it fails clearly
with `reddit_node_https_unavailable_in_runtime`. If Reddit returns `429`, the
worker records `reddit_public_json_rate_limited_429` with transport, runtime,
endpoint kind, status, and a safe body snippet.

If Cloudflare Worker egress receives `reddit_rss_http_403`, the worker records
safe diagnostic metadata only: source id, job id, adapter, status, attempted
host, final host, content type, canonicalized flag, and stable error code. It
does not log response bodies or provider payloads. The source is marked
`needs_attention` with temporary `blocked_until` backoff so scheduled fetches do
not retry aggressively. No public JSON fallback is attempted. OpenAI is not
called unless accepted posts or manual imports with stored `source_text` exist.

## Source To Angle Flow

The production flow is:

1. Load enabled tenant sources.
2. Resolve each source's declared intent.
3. Process manual imports that contain stored source body, or fetch via the
   declared acquisition mode when needed.
4. Reject fetched items that do not match author, subreddit, or RSS discovery
   rules before source/angle/queue writes.
5. Insert one tenant-scoped `source_records` row per accepted unique Reddit URL.
6. Run OpenAI angle extraction only after accepted posts or manual imports exist.
7. Insert one tenant-scoped `angle_records` row per angle and enabled platform.
8. Draft one unused angle at a time into platform-specific `queue_items`.
9. Publish ready queue rows on schedule.
10. Record external proof in `publish_history`.

Short form: source fetch -> accepted posts -> OpenAI angle extraction -> angle
records -> platform drafts -> queue items -> scheduled publish -> publish
history.

The worker drains existing `unused` or `in_progress` angles before fetching new
Reddit posts. This prevents wasting OpenAI calls on new sources while usable
banked angles remain.

Cloudflare scheduled automation keeps slot filling and publishing separate.
Scheduled publish only publishes existing `queue_items` whose `scheduled_for`
time is due. It does not turn angles into posts. A separate scheduled
`refresh_queue` job with `fill_existing_angles_only=true` fills open slots from
existing metadata-complete angles without fetching Reddit. Slots are
platform-specific: the occupancy key is `user_id + platform + tenant-local date
+ slot_index`, so four enabled platforms can have sixteen rows per local day.
The worker chooses the earliest future tenant-local slot for that angle's
platform, preferring same-day future slots before tomorrow, then stores
`scheduled_for` as UTC. If no usable angles exist, the job should say automation
has no unused angles to schedule. If OpenAI drafting fails while filling slots,
the job must finalize with an OpenAI blocker instead of retrying every cron tick.

Accepted source records are saved before OpenAI angle extraction starts. A
`source_records` row without matching tenant-scoped `angle_records` is preserved
evidence, not a completed source. It must not block future angle extraction after
OpenAI billing, quota, rate-limit, or model-access issues are fixed. Existing
banked RSS records that only contain metadata such as title, URL, author, and
subreddit are not enough for high-quality drafting. Manual imports are draftable
only because they store source body in `source_records.source_text`.

If the only active angles are legacy/incomplete rows that cannot be proven to
have source URL, subreddit, author, and intended platform metadata, the worker
quarantines those rows as `rejected` and then continues to the fresh source
fetch stage. Valid unused or in-progress angles still block fresh fetching until
they are drafted, published, rejected, or exhausted.

## Job Result Summaries

`fetch_sources` and `refresh_queue` jobs must write a tenant-scoped summary into
`agent_jobs.result.summary`. The summary is what the frontend uses to explain why
a queue did or did not fill. A completed job with no queue rows is acceptable
only when the result says what happened.

The summary includes:

- source counts: configured, enabled, checked, fetched, accepted,
  author-rejected, subreddit-rejected, unfiltered-RSS-rejected, duplicate,
  no-angle, and fetch failure counts
- angle counts: active at start, draftable at start, created, existing,
  extraction failures, grouped failure reasons, quarantined legacy rows, unused,
  in-progress, and status totals
- draft counts: attempted, created, skipped, failures, and grouped reasons
- queue counts: active slots at start, open slots at start, ready rows, and rows
  created by the job
- access, enabled platform, missing credential, warning, error, message, outcome,
  and next-action fields

Common empty outcomes:

- Reddit RSS row was skipped as `reddit_rss_source_unsupported`; public JSON is
  the supported source path and OpenAI is not called for the unsupported row
- no Reddit posts matched the configured author filter
- `content_exhausted`: automation is working, but current Reddit sources have
  no new usable posts and there are no unused angles to schedule. This is a
  healthy terminal state, not a Reddit/platform failure. The next action is to
  add another subreddit or Reddit user, paste manual Reddit imports with source
  text, or wait for new source posts.
- Reddit/API access failed closed
- Reddit fetch succeeded, but OpenAI text angle extraction failed
- no usable angles were extracted
- draft generation failed
- Instagram image persistence failed
- no source, platform, credential, or billing access was available
- legacy Angle Bank rows were quarantined before fresh fetching

Systemic OpenAI text failures during angle extraction use stable codes such as
`openai_text_quota_exceeded`, `openai_text_billing_blocked`,
`openai_text_rate_limited`, `openai_text_model_unavailable`, or
`openai_text_generation_failed` with stage `angle_extraction`. For quota,
billing, rate-limit, and model-access failures, the worker must stop trying
remaining accepted posts, write a clear `worker_logs` entry, and finalize
`agent_jobs` as `failed` or `completed_with_errors` instead of leaving the job
`running`.

Partial success is valid. If Reddit fetch, source-record preservation, OpenAI
text angle extraction, and some platform drafts succeed, but Instagram image
generation fails later, the final summary must not relabel the job as
`angle_extraction` or `openai_text_generation_failed`. It must preserve counts
for fetched/accepted posts, source records, angle records, queue rows, and rows
by platform, then report `outcome: "completed_with_errors"`,
`failedStage: "instagram_image_generation"`, and the matching
`openai_image_*` code.

## Angle Statuses

Supabase angle statuses are:

- `unused`
- `in_progress`
- `drafted`
- `published`
- `rejected`
- `exhausted`

Local SQLite mode keeps its existing single-tenant content engine and maps the
same lifecycle concept onto its local `ready`, `queued`, `published`, and
`discarded` states.

## Idempotency

`source_records` are unique per `(user_id, url)`.
`angle_records` have a unique index per `(user_id, source_reddit_post_id,
intended_platform, angle_title)`.

If a source URL has already been stored for a tenant, the worker skips
re-extraction and resumes from unused tenant-scoped angles already in the bank.

# Reddit Ingestion And Angle Bank

## Current Product Direction

Reddit collection is moving out of Worker-side public JSON/RSS and the blocked
Browser Run web-login experiment. Reddit OAuth is not currently available for
this project, and there is no active reliable SaaS Reddit ingestion path. The
OneClickPostFactory main app remains responsible for tenant source records,
OpenAI angle extraction after valid sources exist, platform drafts, queueing,
scheduled publishing, publish history, billing, and logs.

Active `fetch_sources` / `refresh_queue` behavior must not call Reddit public
JSON or Reddit RSS from the Cloudflare Worker as the normal product path. If no
usable source records or banked angles exist, the worker should return
`reddit_source_ingestion_unavailable` and stop before Reddit, OpenAI, queue
creation, or publishing side effects.

Reddit public JSON, Reddit RSS, Browser Run/Playwright web-login collection, and
Devvit are legacy/quarantined/reference paths. Keep old migration history and
compatibility fields where needed, but do not present those paths as current
product setup. Manual import remains an advanced fallback only, not the core
product direction.

## Production Tenant Rules

The Supabase SaaS worker is tenant-scoped by `agent_jobs.user_id`.
Every read of tenant configuration and every write to sources, angles, queue
items, publish history, and logs must include that `user_id`.

Reddit ingestion separates tenant isolation from source intent.

Tenant isolation is always `agent_jobs.user_id`: every read and write remains
scoped to that user. Source intent is checked separately before an item can
become a `source_records`, `angle_records`, or `queue_items` row.

`user_sources` declares intent with:

- `provider`: `reddit`, `generic_rss`, or `manual`
- `acquisition_mode`: `public_json`, `oauth`, `rss`, `devvit`, or `manual`
- `source_scope`: `reddit_user`, `subreddit`, `reddit_search`, or `generic_rss`
- `target_author`: optional normalized Reddit author
- `allowed_subreddits`: optional normalized subreddit list
- `allow_unfiltered_rss`: explicit opt-in for broad RSS discovery

Rules:

- `source_scope = reddit_user` requires the delivered Reddit item's author to
  match `target_author`. Historical RSS diagnostics may mention
  `rejected_author_mismatch`, but active collection comes from stored
  source records rather than Worker-side RSS fetches.
- `source_scope = subreddit` requires the item to belong to an allowed
  subreddit. If a tenant-level or source-level `target_author` exists, both
  subreddit and author must match.
- `source_scope = generic_rss` is legacy metadata only. RSS is quarantined from
  normal product flow and should not be offered as a normal source path.
- Manual Reddit import remains an advanced fallback for source-connection
  blocks. It is not the primary product direction. The user-installed Reddit
  Connector must store tenant-scoped `source_records` rows with enough
  `source_text` for later explicit source-record processing. Metadata-only
  source records are not draftable shortcuts.

Legacy `rss` rows are preserved for history but quarantined from normal
ingestion. They should never silently bypass a tenant's Reddit author or
allowed-subreddit intent.

Usernames and subreddits are normalized before comparison, so values such as
`u/example`, `@example`, `r/builders`, and full reddit.com URLs compare by their
canonical names.

## Legacy Reddit Public JSON And RSS Paths

Reddit public JSON (`acquisition_mode = public_json`) was the only path with
persisted end-to-end Cloudflare Worker evidence, but it is no longer the active
product direction. It is a legacy compatibility path, not a foundation to build
on again without new evidence.

Reddit RSS is quarantined from normal user flow. Existing Reddit RSS rows may
remain for history, but they should be disabled or marked `needs_attention` with
`last_error_code = reddit_rss_source_unsupported`; the worker skips them before
fetching and must not call OpenAI or create source/angle/queue rows from them.

The old RSS fetch helper has been removed from active code. RSS remains
compatibility metadata only; future focused recovery work must start from a new
review rather than reusing hidden Worker-side RSS fetching.

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
Current strategy is: preserve old migration history and compatibility rows,
quarantine public JSON/RSS/OAuth/Browser Run/Devvit from normal setup, and keep
source-fetch failures from calling OpenAI.

Public JSON runtime settings have been removed from active configuration.

Reddit OAuth credentials and encrypted per-user Reddit tokens are historical
compatibility fields unless a future approved OAuth path is confirmed. The
tenant's source intent rows remain the only inputs that decide which Reddit
posts may enter that tenant's workflow after a valid connector delivers source
records.

Automated Reddit collection remains a product goal, but there is currently no
active reliable SaaS Reddit ingestion path. Manual paste/import is a fallback,
not the main operating model.

### Reddit Request Shape

Reddit public JSON requests must use an honest, descriptive Reddit-format
User-Agent:

`cloudflare-worker:oneclickpostfactory:v0.1 (by /u/Advanced_Pudding9228)`

Public JSON uses:

- `Accept: application/json, text/plain;q=0.9, */*;q=0.8`
- `Accept-Language: en-GB,en;q=0.9`
- `Cache-Control: no-cache`

The former RSS helper and its RSS/XML Accept header are historical notes only;
they are not present as an active fetch implementation.

Do not add fake browser headers, spoof Chrome/Safari/Firefox, send cookies, or
add `sec-fetch`/`sec-ch` browser fingerprint headers. If Reddit blocks the
Cloudflare Worker egress despite the honest request shape, record the failure,
back off where supported, and keep OpenAI out of the failed source-fetch path.

If old logs contain `reddit_public_json_rate_limited_429` or
`reddit_rss_http_403`, treat them as historical diagnostics. Active source
collection must use the installed connector and write source records first; it
must not call the old Worker-side fetchers. If a source row still carries
`reddit_rss_source_unsupported`, the worker should report it as unsupported and
avoid aggressive retry loops. No public JSON fallback is attempted. OpenAI is not
called unless accepted posts, advanced manual imports, or authenticated-browser
collector records with stored `source_text` exist and an explicit downstream
processing job runs. Collector ingestion itself does not call OpenAI.

## Source To Angle Flow

The production flow is:

1. Load enabled tenant source configs and tenant-owned source records.
2. Treat source configs as connector allowlists, not as Worker-side fetch jobs.
3. Process collected source records or advanced manual imports that contain
   stored source body.
4. Reject source records that lack text, ownership, enabled source mapping, or
   dedupe/progress eligibility before angle/queue writes.
5. Keep source-record ingestion side effects limited to tenant-scoped
   `source_records`.
6. Run OpenAI angle extraction only after valid source records or manual imports
   exist and an explicit downstream job runs.
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
subreddit are not enough for high-quality drafting. Manual imports and
authenticated-browser collector records are draftable only because they store
source body in `source_records.source_text`.

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

- Reddit RSS row was skipped as `reddit_rss_source_unsupported`; RSS is not an
  active source path and OpenAI is not called for the unsupported row
- no Reddit posts matched the configured author filter
- `content_exhausted`: automation is working, but current Reddit sources have
  no new usable collected records and there are no unused angles to schedule.
  This is a healthy terminal state, not a Reddit/platform failure. The next
  action is to add valid source records through an approved ingestion path or
  use the advanced manual fallback with stored source text.
- Reddit/API access failed closed
- source-record processing succeeded, but OpenAI text angle extraction failed
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

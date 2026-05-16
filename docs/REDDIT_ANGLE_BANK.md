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
- `source_scope = generic_rss` is broad discovery only. It is ingested only when
  `allow_unfiltered_rss = true`; otherwise the source is rejected as
  `rejected_unfiltered_rss_not_allowed`.
- Manual Reddit URL import must also pass any configured `target_author` and
  `allowed_subreddits` checks before downstream queue work.

Legacy `rss` rows are treated as blocked generic RSS until a user explicitly
confirms Discovery Feed mode. RSS should never silently bypass a tenant's
Reddit author or allowed-subreddit intent.

Usernames and subreddits are normalized before comparison, so values such as
`u/example`, `@example`, `r/builders`, and full reddit.com URLs compare by their
canonical names.

## Reddit API Access

The worker supports Reddit OAuth when credentials are available, then falls back
to public Reddit JSON for `reddit_user` and `subreddit` sources. Public JSON uses
the old local request shape as closely as each runtime allows. Node/local can use
`node:https`; Cloudflare Workers use runtime `fetch`.

- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- `REDDIT_USER_AGENT`
- `REDDIT_PUBLIC_JSON_TRANSPORT=auto|fetch|node_https`

Those values authenticate the Reddit API client only. They are not tenant
settings and they do not provide a global Reddit author or subreddit fallback.
The tenant's source intent rows remain the only inputs that decide which Reddit
posts may enter that tenant's workflow.

`REDDIT_PUBLIC_JSON_TRANSPORT=auto` uses `node:https` in local Node and `fetch`
in Cloudflare. Forcing `node_https` in a runtime that cannot use it fails clearly
with `reddit_node_https_unavailable_in_runtime`. If Reddit returns `429`, the
worker records `reddit_public_json_rate_limited_429` with transport, runtime,
endpoint kind, status, and a safe body snippet.

## Source To Angle Flow

The production flow is:

1. Load enabled tenant sources.
2. Resolve each source's declared intent.
3. Fetch via the declared acquisition mode.
4. Reject fetched items that do not match author, subreddit, or RSS discovery
   rules before source/angle/queue writes.
5. Insert one tenant-scoped `source_records` row per accepted unique Reddit URL.
6. Extract multiple angles from that source.
7. Insert one tenant-scoped `angle_records` row per angle and enabled platform.
8. Draft one unused angle at a time into `queue_items`.
9. Publish ready queue rows and mark their angle `published`.

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
OpenAI billing, quota, rate-limit, or model-access issues are fixed.

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

- RSS source fetched posts, but none matched the selected Reddit user
- RSS source fetched posts, but none matched the allowed subreddit list
- an unfiltered RSS feed needs explicit Discovery Feed confirmation
- no Reddit posts matched the configured author filter
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

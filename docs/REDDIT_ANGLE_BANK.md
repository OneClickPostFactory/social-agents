# Reddit Ingestion And Angle Bank

## Production Tenant Rules

The Supabase SaaS worker is tenant-scoped by `agent_jobs.user_id`.
Every read of tenant configuration and every write to sources, angles, queue
items, publish history, and logs must include that `user_id`.

Reddit ingestion uses enabled rows in `user_sources`:

- `reddit_user` is the tenant's author filter.
- `subreddit` rows are the tenant's allowed subreddit list.
- `rss` rows are independent feeds and are not Reddit-author filtered.

For Reddit subreddit ingestion, both a `reddit_user` source and at least one
enabled `subreddit` source are required. If a tenant has subreddit sources but
no Reddit author filter, the worker fails the job with
`reddit_author_filter_missing` instead of broadly processing subreddit posts.

Usernames and subreddits are normalized before comparison, so values such as
`u/example`, `@example`, `r/builders`, and full reddit.com URLs compare by their
canonical names.

## Reddit API Access

Local SQLite mode can still use the older public Reddit JSON listing fetch for
developer runs. Cloudflare production fails closed unless Reddit OAuth client
credentials are available from either tenant credentials or Worker secrets:

- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- `REDDIT_USER_AGENT`

Those values authenticate the Reddit API client only. They are not tenant
settings and they do not provide a global Reddit author or subreddit fallback.
The tenant's `reddit_user` and enabled `subreddit` sources remain the only
inputs that decide which Reddit posts may enter that tenant's workflow.

## Source To Angle Flow

The production flow is:

1. Fetch allowed subreddit listings.
2. Keep only posts whose Reddit author matches the tenant's `reddit_user`.
3. Insert one tenant-scoped `source_records` row per unique Reddit URL.
4. Extract multiple angles from that source.
5. Insert one tenant-scoped `angle_records` row per angle and enabled platform.
6. Draft one unused angle at a time into `queue_items`.
7. Publish ready queue rows and mark their angle `published`.

The worker drains existing `unused` or `in_progress` angles before fetching new
Reddit posts. This prevents wasting OpenAI calls on new sources while usable
banked angles remain.

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

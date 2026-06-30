# ADR: Reddit Source Ingestion Decision

## Status

Accepted.

## Decision

There is currently no active reliable SaaS Reddit ingestion path for
OneClickPostFactory.

The main OneClickPostFactory app remains Cloudflare + Supabase and continues to
own the dashboard, settings, tenant-scoped `source_records`, OpenAI processing
after valid sources exist, queueing, publishing, billing, owner access, and logs.
Reddit source collection must not be presented as connected until a reliable
approved mechanism exists.

## Rejected Active Paths

- Browser Run Reddit login.
- Backend Playwright Reddit login as a SaaS feature.
- Reddit OAuth without confirmed obtainable and usable credentials.
- Reddit public JSON or RSS as the product foundation.
- Devvit outbound bridge.
- Copied cookies or browser storage-state import.
- Manual paste/import as the primary product direction.

## Preserved

- OneClickPostFactory main app.
- `source_records` pipeline.
- OpenAI pipeline after valid source records exist.
- Queue and publishing after valid sources and angles exist.
- Internal owner access override.
- Source ownership checks.
- HMAC/source ingestion contract.
- `authenticated_browser` source-record origin support for a future valid
  connector.
- Local Playwright POC as owner/internal reference only.
- Historical migration files and compatibility fields.

## Future Valid Choices

1. Approved official Reddit API access.
2. Explicit user-owned connector/runtime, clearly presented as such.
3. Re-evaluation only if Reddit access rules or platform constraints change.

Do not build the rejected paths again without new evidence.

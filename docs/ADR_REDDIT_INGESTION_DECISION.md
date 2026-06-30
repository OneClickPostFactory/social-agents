# ADR: Reddit Source Ingestion Decision

## Status

Accepted.

## Decision

The active Reddit ingestion direction is a user-installed OneClick Reddit
Connector, not a pure-SaaS Reddit login/fetch path.

The main OneClickPostFactory app remains Cloudflare + Supabase and continues to
own the dashboard, settings, tenant-scoped `source_records`, OpenAI processing
after valid sources exist, queueing, publishing, billing, owner access, and logs.
Reddit source collection must be presented as requiring the user-installed
connector. The connector pairs to the user's OneClick account, opens Reddit
locally for manual user login, collects only configured sources, and sends
normalized records to OneClick.

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
- Source ingestion writes `source_records` only.
- `authenticated_browser` source-record origin support.
- Hashed connector pairing codes and hashed connector device tokens.
- Local Playwright POC as owner/internal reference only.
- Historical migration files and compatibility fields.

## Current Valid Choice

1. Explicit user-owned connector/runtime, clearly presented as such.
2. Re-evaluation only if Reddit access rules or platform constraints change.

Do not build the rejected paths again without new evidence.

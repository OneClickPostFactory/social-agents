# Instagram Image Pipeline

Instagram posts require durable image URLs. OneClickPostFactory must not queue
or publish Instagram posts using temporary OpenAI provider URLs.

## Current Flow

1. The tenant enables Instagram in `user_settings.active_platforms`.
2. The Worker drafts from one tenant-scoped Angle Bank row.
3. `src/ai.ts` builds an image prompt for the selected angle.
4. OpenAI generates the image with `OPENAI_IMAGE_MODEL` (`gpt-image-2` by
   default) and the image-specific `OPENAI_IMAGE_TIMEOUT_MS` timeout.
5. The Worker immediately uploads the generated image asset to Cloudinary.
6. The Cloudinary secure URL is saved to `queue_items.instagram_image_url`.
7. Publishing verifies that the image URL is a Cloudinary URL before calling the
   Instagram Graph API.

## Why Cloudinary Is Mandatory

The older single-install implementation generated a DALL-E image URL and copied
it to Cloudinary when Cloudinary was configured. If Cloudinary was missing, it
could return the original provider URL. That was acceptable only for early
manual tests, not for scheduled multi-tenant production.

The production runtime now fails closed:

- If Cloudinary is not configured, Instagram image persistence fails.
- If a generated image cannot be uploaded to Cloudinary, the Instagram row is
  not queued as publishable.
- If OpenAI image generation is blocked by quota or a billing hard limit, the
  worker records `openai_image_billing_blocked`, keeps Instagram failed/blocked,
  and tells the user to add image-generation credits or raise the OpenAI billing
  hard limit before retrying.
- If OpenAI image generation times out or is aborted, the worker records an
  `instagram_image_generation` failure such as
  `openai_image_generation_aborted`; do not relabel it as text generation or
  `worker_runtime`.
- If no Instagram slot is open, the Worker skips Instagram image generation
  before calling OpenAI and records `instagram_no_open_slot`; that is a deferred
  scheduling state, not a media failure.
- If an existing queue row has a non-Cloudinary image URL, publishing tries to
  persist or regenerate the image first. If that fails, the row is marked failed
  with a tenant-scoped error.

## Environment

Required in the Worker runtime:

- `OPENAI_IMAGE_MODEL=gpt-image-2`
- `OPENAI_IMAGE_TIMEOUT_MS=120000`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER`

`CLOUDINARY_UPLOAD_PRESET` is supported for unsigned upload mode, but signed
uploads using API key and secret are preferred for production.

## OpenClaw generated-media delivery proxy

The narrowly scoped Supabase Edge Function is canonically owned by the
`relay-live-business-engagement-connector` repository at
`supabase/functions/cloudinary-upload-proxy/index.ts`. It belongs to the
OpenClaw campaign-delivery lane rather than this tenant queue worker.

Its contract is intentionally smaller than the normal Cloudinary module:

- one authenticated `POST` containing PNG or JPEG bytes;
- public IDs must remain beneath `tailwagging-generated/`;
- the caller-provided SHA-256 must match the received bytes;
- Cloudinary overwrite and unique-name mutation are disabled;
- the function downloads the resulting HTTPS asset and verifies its SHA-256;
- the OpenClaw caller performs a second independent delivery checksum;
- no list, search, transform, rename, update, archive, delete, or social action
  is exposed.

Host-specific deployment remains owned by the private `openclaw-ops`
repository through `scripts/deploy-cloudinary-upload-proxy.mjs`. This
repository neither owns nor deploys that function, and it must not acquire a
second copy of either component.

`OPENAI_IMAGE_TIMEOUT_MS` is deliberately separate from `HTTP_TIMEOUT_MS` so
image generation can take longer than normal API calls without waiting forever.
Do not remove the timeout completely.

## Tenant Safety

Cloudinary credentials are operator infrastructure credentials. Tenant-specific
platform credentials remain encrypted in Supabase `user_credentials`. The Worker
derives a tenant-specific Cloudinary folder from `job.user_id`, and every queue,
history, source, and angle write keeps `user_id = job.user_id`.

Do not add global image queues, global platform credentials, global subscription
flags, or unscoped image records.

## Verification Queries

Check queued Instagram images:

```sql
select user_id, id, status, instagram_image_url
from queue_items
where platform = 'instagram'
order by created_at desc
limit 20;
```

All active/pending Instagram rows should have `instagram_image_url` containing a
Cloudinary delivery host. Failed rows should have a clear `error_message`.

Check publish history:

```sql
select user_id, queue_item_id, platform, external_id, error_message, created_at
from publish_history
where platform = 'instagram'
order by created_at desc
limit 20;
```

No tenant should see or publish another tenant's image, queue item, or history
row.

type JsonRecord = Record<string, unknown>;

export interface CollectorIngestEnv {
  COLLECTOR_INGEST_ENABLED?: string;
  COLLECTOR_INGEST_HMAC_SECRET?: string;
  COLLECTOR_INGEST_WRITE_ENABLED?: string;
}

export interface CollectorIngestProcessResult {
  status: number;
  body: JsonRecord;
}

interface NormalizedCollectorRecord {
  user_id: string;
  source_id: string;
  source_url: string;
  reddit_post_id: string | null;
  title: string;
  subreddit: string;
  author: string | null;
  post_body: string | null;
  captured_at: string;
  collector_type: 'authenticated_browser';
  content_hash: string;
  raw_metadata?: JsonRecord;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_POST_BODY_CHARS = 12_000;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;
const FORBIDDEN_KEYS = new Set([
  'authorization',
  'angle_records',
  'browser_state',
  'browser_storage',
  'create_queue',
  'cookie',
  'cookies',
  'headers',
  'local_storage',
  'openai',
  'password',
  'publish_now',
  'publishing',
  'queue_items',
  'session',
  'session_state',
  'source_records',
  'storage_state',
  'token',
  'tokens',
  'trigger_openai',
]);
const SIDE_EFFECTS = {
  openai_called: false,
  source_records_written: false,
  angle_records_created: false,
  queue_rows_created: false,
  publishing_triggered: false,
};

export async function handleBrowserCollectorIngestRequest(
  request: Request,
  env: CollectorIngestEnv = process.env
): Promise<Response> {
  let rawBody = '';
  try {
    rawBody = await readLimitedBody(request);
  } catch {
    return new Response(JSON.stringify({
      status: 'rejected',
      error: 'request_body_too_large',
      message: 'Collector ingest body exceeds the safe cap.',
      accepted_count: 0,
      rejected_count: 1,
      duplicate_count: 0,
      dry_run: true,
      write_enabled: false,
      side_effects: SIDE_EFFECTS,
    }), {
      status: 413,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }
  const result = await processBrowserCollectorIngest(rawBody, request.headers, env);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function processBrowserCollectorIngest(
  rawBody: string,
  headers: Headers,
  env: CollectorIngestEnv = process.env,
  nowMs = Date.now()
): Promise<CollectorIngestProcessResult> {
  const ingestEnabled = parseBooleanEnv(env.COLLECTOR_INGEST_ENABLED);
  const writeEnabled = parseBooleanEnv(env.COLLECTOR_INGEST_WRITE_ENABLED);

  if (!ingestEnabled) {
    return respond(403, {
      status: 'disabled',
      reason: 'collector_ingest_disabled',
      accepted_count: 0,
      rejected_count: 0,
      duplicate_count: 0,
      dry_run: true,
      write_enabled: false,
      write_path: 'disabled',
      side_effects: SIDE_EFFECTS,
    });
  }

  if (!env.COLLECTOR_INGEST_HMAC_SECRET) {
    return respond(503, {
      status: 'misconfigured',
      reason: 'collector_ingest_secret_missing',
      accepted_count: 0,
      rejected_count: 0,
      duplicate_count: 0,
      dry_run: true,
      write_enabled: false,
      side_effects: SIDE_EFFECTS,
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    return rejection(400, 'invalid_json', 'Request body must be valid JSON.');
  }

  if (containsForbiddenKey(payload)) {
    return rejection(400, 'unsafe_payload_fields', 'Payload contains forbidden session, cookie, token, or browser storage fields.');
  }

  const signatureResult = await verifySignedRequest({
    secret: env.COLLECTOR_INGEST_HMAC_SECRET,
    timestamp: headers.get('x-oneclick-timestamp') || '',
    signature: headers.get('x-oneclick-signature') || '',
    payload,
    nowMs,
  });
  if (!signatureResult.ok) {
    return rejection(401, signatureResult.code, 'Collector signature validation failed.');
  }

  const recordsInput = extractRecords(payload);
  if (!recordsInput.length) {
    return rejection(400, 'missing_records', 'At least one collector record is required.');
  }

  const seen = new Set<string>();
  const accepted: NormalizedCollectorRecord[] = [];
  const rejected: Array<{ index: number; code: string; message: string }> = [];
  let duplicateCount = 0;

  recordsInput.forEach((recordInput, index) => {
    const validated = validateCollectorRecord(recordInput);
    if (!validated.ok) {
      rejected.push({ index, code: validated.code, message: validated.message });
      return;
    }

    const dedupeIdentity = dedupeKey(validated.record);
    if (seen.has(dedupeIdentity)) {
      duplicateCount++;
      return;
    }

    seen.add(dedupeIdentity);
    accepted.push(validated.record);
  });

  if (rejected.length && !accepted.length) {
    return respond(400, {
      status: 'rejected',
      accepted_count: 0,
      rejected_count: rejected.length,
      duplicate_count: duplicateCount,
      dry_run: true,
      write_enabled: false,
      rejections: rejected,
      side_effects: SIDE_EFFECTS,
    });
  }

  if (writeEnabled) {
    return respond(501, {
      status: 'write_deferred',
      reason: 'schema_review_required',
      accepted_count: accepted.length,
      rejected_count: rejected.length,
      duplicate_count: duplicateCount,
      dry_run: true,
      write_enabled: false,
      write_path: 'schema_review_required',
      summary: accepted.map(safeRecordSummary),
      rejections: rejected,
      side_effects: SIDE_EFFECTS,
    });
  }

  return respond(202, {
    status: 'accepted_dry_run',
    accepted_count: accepted.length,
    rejected_count: rejected.length,
    duplicate_count: duplicateCount,
    dry_run: true,
    write_enabled: false,
    write_path: 'deferred',
    summary: accepted.map(safeRecordSummary),
    rejections: rejected,
    side_effects: SIDE_EFFECTS,
  });
}

export async function signCollectorPayload(secret: string, timestamp: string, payload: unknown): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const message = `${timestamp}.${canonicalJson(payload)}`;
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toHex(signature);
}

function respond(status: number, body: JsonRecord): CollectorIngestProcessResult {
  return { status, body };
}

function rejection(status: number, code: string, message: string): CollectorIngestProcessResult {
  return respond(status, {
    status: 'rejected',
    error: code,
    message,
    accepted_count: 0,
    rejected_count: 1,
    duplicate_count: 0,
    dry_run: true,
    write_enabled: false,
    side_effects: SIDE_EFFECTS,
  });
}

async function readLimitedBody(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new Error('Collector ingest body too large');
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    throw new Error('Collector ingest body too large');
  }

  return rawBody;
}

function parseBooleanEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value || '').trim());
}

function extractRecords(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (isRecord(payload) && Array.isArray(payload.records)) {
    return payload.records;
  }

  return [payload];
}

function validateCollectorRecord(input: unknown): { ok: true; record: NormalizedCollectorRecord } | { ok: false; code: string; message: string } {
  if (!isRecord(input)) {
    return { ok: false, code: 'invalid_record', message: 'Collector record must be an object.' };
  }

  const userId = readString(input, 'user_id') || readString(input, 'tenant_user_id');
  const sourceId = readString(input, 'source_id') || readString(input, 'source_config_id');
  const sourceUrl = readString(input, 'source_url');
  const redditPostId = readString(input, 'reddit_post_id') || null;
  const title = readString(input, 'title');
  const subreddit = readString(input, 'subreddit');
  const author = readString(input, 'author') || null;
  const postBody = readString(input, 'post_body') || readString(input, 'snippet') || null;
  const capturedAt = readString(input, 'captured_at');
  const collectorType = readString(input, 'collector_type');
  const contentHash = readString(input, 'content_hash');

  for (const [key, value] of Object.entries({
    user_id: userId,
    source_id: sourceId,
    source_url: sourceUrl,
    title,
    subreddit,
    captured_at: capturedAt,
    collector_type: collectorType,
    content_hash: contentHash,
  })) {
    if (!value) {
      return { ok: false, code: `missing_${key}`, message: `${key} is required.` };
    }
  }

  if (collectorType !== 'authenticated_browser') {
    return { ok: false, code: 'invalid_collector_type', message: 'collector_type must be authenticated_browser.' };
  }

  if (!redditPostId && !sourceUrl) {
    return { ok: false, code: 'missing_dedupe_identity', message: 'reddit_post_id or source_url is required.' };
  }

  if (!isValidRedditUrl(sourceUrl)) {
    return { ok: false, code: 'invalid_source_url', message: 'source_url must be an HTTPS Reddit URL.' };
  }

  if (!/^[A-Za-z0-9_]{3,21}$/.test(subreddit)) {
    return { ok: false, code: 'invalid_subreddit', message: 'subreddit must be valid.' };
  }

  const capturedTime = Date.parse(capturedAt);
  if (!Number.isFinite(capturedTime)) {
    return { ok: false, code: 'invalid_captured_at', message: 'captured_at must be an ISO timestamp.' };
  }

  if (postBody && postBody.length > MAX_POST_BODY_CHARS) {
    return { ok: false, code: 'post_body_too_large', message: 'post_body exceeds the safe ingestion cap.' };
  }

  const rawMetadata = isRecord(input.raw_metadata) ? input.raw_metadata : undefined;
  return {
    ok: true,
    record: {
      user_id: userId,
      source_id: sourceId,
      source_url: normalizeRedditUrl(sourceUrl),
      reddit_post_id: redditPostId,
      title,
      subreddit: subreddit.toLowerCase(),
      author,
      post_body: postBody,
      captured_at: new Date(capturedTime).toISOString(),
      collector_type: 'authenticated_browser',
      content_hash: contentHash,
      raw_metadata: rawMetadata,
    },
  };
}

function safeRecordSummary(record: NormalizedCollectorRecord): JsonRecord {
  return {
    user_id: record.user_id,
    source_id: record.source_id,
    dedupe_key: dedupeKey(record),
    source_host: safeHost(record.source_url),
    title_present: record.title.length > 0,
    subreddit: record.subreddit,
    author_present: Boolean(record.author),
    post_body_length: record.post_body?.length || 0,
    captured_at: record.captured_at,
    collector_type: record.collector_type,
  };
}

function dedupeKey(record: NormalizedCollectorRecord): string {
  return record.reddit_post_id
    ? `reddit_post_id:${record.reddit_post_id}`
    : `source_url:${record.source_url}`;
}

function readString(record: JsonRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidRedditUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'reddit.com' || host === 'www.reddit.com' || host.endsWith('.reddit.com'));
  } catch {
    return false;
  }
}

function normalizeRedditUrl(value: string): string {
  const url = new URL(value);
  url.protocol = 'https:';
  url.hostname = 'www.reddit.com';
  url.username = '';
  url.password = '';
  url.hash = '';
  return url.toString();
}

function safeHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenKey);
  }

  if (!isRecord(value)) {
    return false;
  }

  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[-\s]/g, '_');
    if (FORBIDDEN_KEYS.has(normalizedKey)) {
      return true;
    }
    if (containsForbiddenKey(nested)) {
      return true;
    }
  }

  return false;
}

async function verifySignedRequest(input: {
  secret: string;
  timestamp: string;
  signature: string;
  payload: unknown;
  nowMs: number;
}): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!input.timestamp || !input.signature) {
    return { ok: false, code: 'missing_signature_headers' };
  }

  const timestampMs = parseTimestamp(input.timestamp);
  if (!Number.isFinite(timestampMs)) {
    return { ok: false, code: 'invalid_timestamp' };
  }

  if (input.nowMs - timestampMs > REPLAY_WINDOW_MS) {
    return { ok: false, code: 'stale_timestamp' };
  }

  if (timestampMs - input.nowMs > FUTURE_SKEW_MS) {
    return { ok: false, code: 'future_timestamp' };
  }

  const expected = await signCollectorPayload(input.secret, input.timestamp, input.payload);
  if (!timingSafeEqualHex(expected, input.signature)) {
    return { ok: false, code: 'invalid_signature' };
  }

  return { ok: true };
}

function parseTimestamp(value: string): number {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return value.length <= 10 ? parsed * 1000 : parsed;
  }
  return Date.parse(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (isRecord(value)) {
    const sorted: JsonRecord = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }

  return value;
}

function timingSafeEqualHex(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  let mismatch = normalizedLeft.length ^ normalizedRight.length;
  const maxLength = Math.max(normalizedLeft.length, normalizedRight.length);
  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (normalizedLeft.charCodeAt(index) || 0) ^ (normalizedRight.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

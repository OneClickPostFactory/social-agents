import assert from 'node:assert/strict';

import {
  processBrowserCollectorIngest,
  signCollectorPayload,
  type CollectorIngestEnv,
} from '../src/browser-collector-ingest';

const secret = 'local-collector-secret';
const nowMs = Date.parse('2026-06-18T12:00:00.000Z');
const timestamp = new Date(nowMs).toISOString();

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: 'test-user',
    source_id: 'test-source',
    source_url: 'https://www.reddit.com/r/openclawbot/comments/abc/example/',
    reddit_post_id: 't3_abc',
    title: 'Example Reddit post',
    subreddit: 'openclawbot',
    author: 'example_author',
    post_body: 'Useful visible source body for later angle extraction.',
    captured_at: '2026-06-18T11:59:00.000Z',
    collector_type: 'authenticated_browser',
    content_hash: 'hash',
    raw_metadata: {
      source_type: 'subreddit_new',
    },
    ...overrides,
  };
}

function env(overrides: Partial<CollectorIngestEnv> = {}): CollectorIngestEnv {
  return {
    COLLECTOR_INGEST_ENABLED: 'true',
    COLLECTOR_INGEST_HMAC_SECRET: secret,
    ...overrides,
  };
}

async function signedHeaders(payload: unknown, signedAt = timestamp, signedSecret = secret): Promise<Headers> {
  return new Headers({
    'x-oneclick-collector-id': 'reddit-browser-collector-worker',
    'x-oneclick-timestamp': signedAt,
    'x-oneclick-signature': await signCollectorPayload(signedSecret, signedAt, payload),
  });
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`- ${name}... `);
  await fn();
  process.stdout.write('ok\n');
}

async function main(): Promise<void> {
  await run('disabled endpoint does not accept writes', async () => {
    const payload = validRecord();
    const result = await processBrowserCollectorIngest(
      JSON.stringify(payload),
      await signedHeaders(payload),
      env({ COLLECTOR_INGEST_ENABLED: 'false' }),
      nowMs
    );

    assert.equal(result.status, 403);
    assert.equal(result.body.status, 'disabled');
    assert.equal(result.body.accepted_count, 0);
    assert.deepEqual((result.body.side_effects as Record<string, unknown>).source_records_written, false);
  });

  await run('valid signed dry-run payload is accepted', async () => {
    const payload = validRecord();
    const result = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload), env(), nowMs);

    assert.equal(result.status, 202);
    assert.equal(result.body.status, 'accepted_dry_run');
    assert.equal(result.body.accepted_count, 1);
    assert.equal(result.body.dry_run, true);
    assert.equal(result.body.write_enabled, false);
  });

  await run('invalid signature is rejected', async () => {
    const payload = validRecord();
    const headers = await signedHeaders(payload);
    headers.set('x-oneclick-signature', 'deadbeef');
    const result = await processBrowserCollectorIngest(JSON.stringify(payload), headers, env(), nowMs);

    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'invalid_signature');
  });

  await run('missing signature headers are rejected', async () => {
    const payload = validRecord();
    const result = await processBrowserCollectorIngest(JSON.stringify(payload), new Headers(), env(), nowMs);

    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'missing_signature_headers');
  });

  await run('stale timestamp is rejected', async () => {
    const payload = validRecord();
    const stale = new Date(nowMs - 10 * 60 * 1000).toISOString();
    const result = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload, stale), env(), nowMs);

    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'stale_timestamp');
  });

  await run('future timestamp outside skew is rejected', async () => {
    const payload = validRecord();
    const future = new Date(nowMs + 2 * 60 * 1000).toISOString();
    const result = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload, future), env(), nowMs);

    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'future_timestamp');
  });

  await run('malformed payload is rejected', async () => {
    const payload = validRecord({ title: '' });
    const result = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload), env(), nowMs);

    assert.equal(result.status, 400);
    assert.equal(result.body.status, 'rejected');
  });

  await run('wrong collector_type is rejected', async () => {
    const payload = validRecord({ collector_type: 'public_json' });
    const result = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload), env(), nowMs);

    assert.equal(result.status, 400);
    assert.equal(result.body.rejected_count, 1);
  });

  await run('payload containing cookie/session/browser state fields is rejected', async () => {
    const payload = validRecord({ raw_metadata: { storage_state: 'must-not-appear' } });
    const result = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload), env(), nowMs);

    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'unsafe_payload_fields');
  });

  await run('payload trying to trigger OpenAI, queue, or publishing is rejected', async () => {
    const payload = validRecord({ trigger_openai: true, queue_items: [], publish_now: true });
    const result = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload), env(), nowMs);

    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'unsafe_payload_fields');
  });

  await run('overlong post body is rejected', async () => {
    const payload = validRecord({ post_body: 'x'.repeat(12_001) });
    const result = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload), env(), nowMs);

    assert.equal(result.status, 400);
    assert.equal(result.body.status, 'rejected');
  });

  await run('long post body is excluded from safe summary', async () => {
    const longBody = 'visible fixture body '.repeat(200);
    const payload = validRecord({ post_body: longBody });
    const result = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload), env(), nowMs);

    assert.equal(result.status, 202);
    const responseText = JSON.stringify(result.body);
    assert.equal(responseText.includes(longBody), false);
    assert.equal(responseText.includes('post_body_length'), true);
  });

  await run('no OpenAI, queue, source record, or publishing side effects are reported', async () => {
    const payload = validRecord();
    const result = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload), env(), nowMs);
    const sideEffects = result.body.side_effects as Record<string, unknown>;

    assert.equal(sideEffects.openai_called, false);
    assert.equal(sideEffects.source_records_written, false);
    assert.equal(sideEffects.queue_rows_created, false);
    assert.equal(sideEffects.publishing_triggered, false);
  });

  await run('write mode is off by default and explicit write mode is deferred', async () => {
    const payload = validRecord();
    const defaultResult = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload), env(), nowMs);
    assert.equal(defaultResult.body.write_enabled, false);

    const writeResult = await processBrowserCollectorIngest(
      JSON.stringify(payload),
      await signedHeaders(payload),
      env({ COLLECTOR_INGEST_WRITE_ENABLED: 'true' }),
      nowMs
    );
    assert.equal(writeResult.status, 501);
    assert.equal(writeResult.body.status, 'write_deferred');
    assert.equal(writeResult.body.write_path, 'schema_review_required');
  });
}

void main();

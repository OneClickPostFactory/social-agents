import assert from 'node:assert/strict';

import {
  processBrowserCollectorIngest,
  signCollectorPayload,
  type CollectorIngestEnv,
  type CollectorIngestStorage,
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

function stagingWriteEnv(overrides: Partial<CollectorIngestEnv> = {}): CollectorIngestEnv {
  return env({
    COLLECTOR_INGEST_WRITE_ENABLED: 'true',
    COLLECTOR_INGEST_ENV: 'staging',
    COLLECTOR_INGEST_CANARY_USER_ID: 'test-user',
    COLLECTOR_INGEST_CANARY_SOURCE_ID: 'test-source',
    COLLECTOR_INGEST_MAX_RECORDS: '2',
    ...overrides,
  });
}

function mockStorage(existingRows: Array<{ id: string; url?: string | null; reddit_post_id?: string | null; content_hash?: string | null }> = []): {
  storage: CollectorIngestStorage;
  insertedRows: Array<Record<string, unknown>>;
} {
  const insertedRows: Array<Record<string, unknown>> = [];
  const storage: CollectorIngestStorage = {
    async loadUserSource(userId, sourceId) {
      return {
        id: sourceId,
        user_id: userId,
        kind: 'subreddit',
        value: 'r/openclawbot',
        enabled: true,
        provider: 'reddit',
        source_scope: 'subreddit',
      };
    },
    async loadExistingSourceRecords() {
      return [
        ...existingRows,
        ...insertedRows.map((row, index) => ({
          id: `inserted-${index}`,
          url: row.url as string,
          reddit_post_id: row.reddit_post_id as string | null,
          content_hash: row.content_hash as string,
        })),
      ];
    },
    async insertSourceRecords(rows) {
      insertedRows.push(...rows);
      return rows.map((_row, index) => ({ id: `source-record-${insertedRows.length - rows.length + index}` }));
    },
  };
  return { storage, insertedRows };
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

  await run('write mode is off by default and requires local or staging env', async () => {
    const payload = validRecord();
    const defaultResult = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload), env(), nowMs);
    assert.equal(defaultResult.body.write_enabled, false);

    const writeResult = await processBrowserCollectorIngest(
      JSON.stringify(payload),
      await signedHeaders(payload),
      env({ COLLECTOR_INGEST_WRITE_ENABLED: 'true' }),
      nowMs
    );
    assert.equal(writeResult.status, 403);
    assert.equal(writeResult.body.status, 'write_blocked');
    assert.equal(writeResult.body.reason, 'collector_ingest_env_must_be_local_or_staging');
  });

  await run('production write mode is blocked', async () => {
    const payload = validRecord();
    const writeResult = await processBrowserCollectorIngest(
      JSON.stringify(payload),
      await signedHeaders(payload),
      env({
        COLLECTOR_INGEST_WRITE_ENABLED: 'true',
        COLLECTOR_INGEST_ENV: 'production',
      }),
      nowMs
    );

    assert.equal(writeResult.status, 403);
    assert.equal(writeResult.body.status, 'write_blocked');
  });

  await run('staging write mode requires explicit owner source canary scope', async () => {
    const payload = validRecord();
    const writeResult = await processBrowserCollectorIngest(
      JSON.stringify(payload),
      await signedHeaders(payload),
      env({
        COLLECTOR_INGEST_WRITE_ENABLED: 'true',
        COLLECTOR_INGEST_ENV: 'staging',
      }),
      nowMs
    );

    assert.equal(writeResult.status, 403);
    assert.equal(writeResult.body.status, 'write_blocked');
    assert.equal(writeResult.body.reason, 'collector_canary_scope_required');
  });

  await run('valid signed staging payload creates source_records only through mock storage', async () => {
    const payload = validRecord();
    const { storage, insertedRows } = mockStorage();
    const writeResult = await processBrowserCollectorIngest(
      JSON.stringify(payload),
      await signedHeaders(payload),
      stagingWriteEnv(),
      nowMs,
      storage
    );

    assert.equal(writeResult.status, 201);
    assert.equal(writeResult.body.status, 'source_records_written');
    assert.equal(writeResult.body.source_records_written, 1);
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].user_id, 'test-user');
    assert.equal(insertedRows[0].url, 'https://www.reddit.com/r/openclawbot/comments/abc/example/');
    assert.equal(insertedRows[0].origin, 'authenticated_browser');
    assert.equal(insertedRows[0].source_text, 'Useful visible source body for later angle extraction.');
    assert.equal(insertedRows[0].status, 'banked');
    assert.equal((writeResult.body.side_effects as Record<string, unknown>).source_records_written, true);
    assert.equal((writeResult.body.side_effects as Record<string, unknown>).queue_rows_created, false);
    assert.equal((writeResult.body.side_effects as Record<string, unknown>).publishing_triggered, false);
  });

  await run('duplicate staging payload does not create duplicate source_records', async () => {
    const payload = validRecord();
    const { storage, insertedRows } = mockStorage();
    const stagingEnv = stagingWriteEnv();

    const first = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload), stagingEnv, nowMs, storage);
    const second = await processBrowserCollectorIngest(JSON.stringify(payload), await signedHeaders(payload), stagingEnv, nowMs, storage);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.source_records_written, 0);
    assert.equal(second.body.duplicate_count, 1);
    assert.equal(insertedRows.length, 1);
  });

  await run('write mode rejects mixed-user batches', async () => {
    const payload = [
      validRecord(),
      validRecord({
        user_id: 'second-user',
        source_id: 'second-source',
        source_url: 'https://www.reddit.com/r/openclawbot/comments/def/second/',
        reddit_post_id: 't3_def',
        content_hash: 'hash-2',
      }),
    ];
    const { storage, insertedRows } = mockStorage();
    const writeResult = await processBrowserCollectorIngest(
      JSON.stringify(payload),
      await signedHeaders(payload),
      env({
        COLLECTOR_INGEST_WRITE_ENABLED: 'true',
        COLLECTOR_INGEST_ENV: 'local',
      }),
      nowMs,
      storage
    );

    assert.equal(writeResult.status, 207);
    assert.equal(writeResult.body.source_records_written, 0);
    assert.equal(insertedRows.length, 0);
    assert.match(JSON.stringify(writeResult.body), /mixed_user_batch_unsupported/);
  });

  await run('staging canary rejects wrong user or source before insert', async () => {
    const payload = validRecord({ source_id: 'wrong-source' });
    const { storage, insertedRows } = mockStorage();
    const writeResult = await processBrowserCollectorIngest(
      JSON.stringify(payload),
      await signedHeaders(payload),
      stagingWriteEnv(),
      nowMs,
      storage
    );

    assert.equal(writeResult.status, 403);
    assert.equal(writeResult.body.status, 'write_blocked');
    assert.equal(writeResult.body.reason, 'collector_canary_scope_mismatch');
    assert.equal(insertedRows.length, 0);
  });

  await run('staging canary rejects more than two records before insert', async () => {
    const payload = [
      validRecord(),
      validRecord({
        source_url: 'https://www.reddit.com/r/openclawbot/comments/def/second/',
        reddit_post_id: 't3_def',
        content_hash: 'hash-2',
      }),
      validRecord({
        source_url: 'https://www.reddit.com/r/openclawbot/comments/ghi/third/',
        reddit_post_id: 't3_ghi',
        content_hash: 'hash-3',
      }),
    ];
    const { storage, insertedRows } = mockStorage();
    const writeResult = await processBrowserCollectorIngest(
      JSON.stringify(payload),
      await signedHeaders(payload),
      stagingWriteEnv(),
      nowMs,
      storage
    );

    assert.equal(writeResult.status, 400);
    assert.equal(writeResult.body.status, 'write_blocked');
    assert.equal(writeResult.body.reason, 'collector_batch_exceeds_canary_limit');
    assert.equal(insertedRows.length, 0);
  });

  await run('write mode validates source ownership and source text', async () => {
    const payload = validRecord({ post_body: '' });
    const { storage } = mockStorage();
    const writeResult = await processBrowserCollectorIngest(
      JSON.stringify(payload),
      await signedHeaders(payload),
      env({
        COLLECTOR_INGEST_WRITE_ENABLED: 'true',
        COLLECTOR_INGEST_ENV: 'local',
      }),
      nowMs,
      storage
    );

    assert.equal(writeResult.status, 207);
    assert.equal(writeResult.body.source_records_written, 0);
    assert.equal(writeResult.body.rejected_count, 1);
  });
}

void main();

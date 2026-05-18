import assert from 'node:assert/strict';

import { __test__ } from '../src/supabase-worker';

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test('scheduled publish success includes normalized summary evidence', () => {
  const result = __test__.publishSuccessResult(
    {
      id: 'job-1',
      user_id: 'tenant-1',
      kind: 'publish_now',
      status: 'running',
      created_at: '2026-05-17T15:00:46.000Z',
      started_at: '2026-05-17T15:00:47.000Z',
      payload: {
        source: 'scheduled',
        scheduler: 'cloudflare_cron',
        due_at: '2026-05-17T15:00:00.000Z',
        queue_item_id: 'queue-1',
      },
    },
    {
      id: 'queue-1',
      user_id: 'tenant-1',
      platform: 'threads',
      status: 'publishing',
      slot_index: 3,
      scheduled_for: '2026-05-17T15:00:00.000Z',
    },
    {
      id: 'history-1',
      user_id: 'tenant-1',
      platform: 'threads',
      external_post_id: 'external-1',
      published_at: '2026-05-17T15:00:58.000Z',
    },
    'external-1',
    '2026-05-17T15:00:59.000Z'
  ) as any;

  assert.equal(result.platform, 'threads');
  assert.equal(result.queueItemId, 'queue-1');
  assert.equal(result.publishHistoryId, 'history-1');
  assert.equal(result.externalPostId, 'external-1');
  assert.equal(result.summary.outcome, 'published');
  assert.equal(result.summary.origin, 'scheduled');
  assert.equal(result.summary.scheduler, 'cloudflare_cron');
  assert.equal(result.summary.final_queue_status, 'published');
  assert.equal(result.summary.publish_history_id, 'history-1');
  assert.equal(result.summary.external_post_id, 'external-1');
  assert.match(result.summary.message, /Scheduled post published to threads/);
});

test('reconciled scheduled publish with publish proof becomes published', () => {
  const result = __test__.stalePublishResult(
    {
      id: 'job-reconciled-scheduled',
      user_id: 'tenant-1',
      kind: 'publish_now',
      status: 'running',
      created_at: '2026-05-18T04:00:51.000Z',
      started_at: '2026-05-18T04:01:48.000Z',
      payload: {
        source: 'scheduled',
        scheduler: 'cloudflare_cron',
        due_at: '2026-05-18T04:00:00.000Z',
        queue_item_id: 'queue-threads',
      },
    },
    {
      id: 'queue-threads',
      user_id: 'tenant-1',
      platform: 'threads',
      status: 'published',
      slot_index: 0,
      scheduled_for: '2026-05-18T04:00:00.000Z',
      source_url: 'https://reddit.example/post',
    },
    {
      id: 'history-threads',
      user_id: 'tenant-1',
      platform: 'threads',
      external_post_id: '18360373546225198',
      published_at: '2026-05-18T04:02:02.333Z',
      source_url: 'https://reddit.example/post',
    },
    []
  ) as any;

  assert.equal(result.summary.outcome, 'published');
  assert.equal(result.summary.platform, 'threads');
  assert.equal(result.summary.queue_item_id, 'queue-threads');
  assert.equal(result.summary.job_id, 'job-reconciled-scheduled');
  assert.equal(result.summary.origin, 'scheduled');
  assert.equal(result.summary.scheduler, 'cloudflare_cron');
  assert.equal(result.summary.final_queue_status, 'published');
  assert.equal(result.summary.publish_history_id, 'history-threads');
  assert.equal(result.summary.external_post_id, '18360373546225198');
  assert.equal(result.summary.completed_at, '2026-05-18T04:02:02.333Z');
  assert.match(result.summary.message, /Scheduled post published to threads/);
  assert.equal(result.error, undefined);
  assert.equal(result.jobStatus, undefined);
});

test('reconciled manual publish with publish proof becomes published', () => {
  const result = __test__.stalePublishResult(
    {
      id: 'job-reconciled-manual',
      user_id: 'tenant-1',
      kind: 'publish_now',
      status: 'running',
      created_at: '2026-05-18T12:00:00.000Z',
      started_at: '2026-05-18T12:00:01.000Z',
      payload: {
        queue_item_id: 'queue-linkedin',
      },
    },
    {
      id: 'queue-linkedin',
      user_id: 'tenant-1',
      platform: 'linkedin',
      status: 'published',
      slot_index: 2,
      scheduled_for: '2026-05-18T11:00:00.000Z',
      source_url: 'https://reddit.example/linkedin',
    },
    {
      id: 'history-linkedin',
      user_id: 'tenant-1',
      platform: 'linkedin',
      external_post_id: 'urn:li:share:1',
      published_at: '2026-05-18T12:00:30.000Z',
      source_url: 'https://reddit.example/linkedin',
    },
    []
  ) as any;

  assert.equal(result.summary.outcome, 'published');
  assert.equal(result.summary.origin, 'manual');
  assert.equal(result.summary.publish_history_id, 'history-linkedin');
  assert.equal(result.summary.external_post_id, 'urn:li:share:1');
  assert.match(result.summary.message, /Published to linkedin/);
});

test('unknown publish state remains warning without publish history proof', () => {
  const result = __test__.stalePublishResult(
    {
      id: 'job-unknown',
      user_id: 'tenant-1',
      kind: 'publish_now',
      status: 'running',
      created_at: '2026-05-18T12:00:00.000Z',
      started_at: '2026-05-18T12:00:01.000Z',
      payload: {
        source: 'scheduled',
        scheduler: 'cloudflare_cron',
        queue_item_id: 'queue-x',
      },
    },
    {
      id: 'queue-x',
      user_id: 'tenant-1',
      platform: 'x',
      status: 'publishing',
      slot_index: 2,
      scheduled_for: '2026-05-18T11:00:00.000Z',
      source_url: 'https://reddit.example/x',
    },
    undefined,
    [{
      created_at: '2026-05-18T12:00:02.000Z',
      level: 'info',
      message: 'published_queue_item',
      context: {
        jobId: 'job-unknown',
        queueItemId: 'queue-x',
      },
    }]
  ) as any;

  assert.equal(result.summary.outcome, 'blocked');
  assert.equal(result.summary.failureCode, 'unknown_publish_state');
  assert.equal(result.jobStatus, 'failed');
});

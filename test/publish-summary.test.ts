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

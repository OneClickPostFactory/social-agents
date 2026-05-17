import assert from 'node:assert/strict';

import { OPENAI_IMAGE_GENERATION_ABORTED_CODE, OPENAI_IMAGE_GENERATION_STAGE } from '../src/ai';
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

const imageFailure = {
  code: OPENAI_IMAGE_GENERATION_ABORTED_CODE,
  nextAction: 'Retry Instagram image generation later, or attach/use a durable Cloudinary image.',
  platform: 'instagram',
  stage: OPENAI_IMAGE_GENERATION_STAGE,
  userMessage: 'Instagram image generation was interrupted before durable media was ready.',
};

test('partial refresh_queue progress survives Instagram image interruption', () => {
  const summary = __test__.reconstructStaleSummary([
    {
      level: 'info',
      message: 'queued_banked_angle',
      created_at: '2026-05-17T11:08:21.893Z',
      context: {
        jobId: 'job-1',
        platforms: ['x'],
      },
    },
    {
      level: 'info',
      message: 'queued_banked_angle',
      created_at: '2026-05-17T11:08:26.432Z',
      context: {
        jobId: 'job-1',
        platforms: ['linkedin'],
      },
    },
    {
      level: 'warn',
      message: 'banked_angle_draft_failed',
      created_at: '2026-05-17T11:09:00.000Z',
      context: {
        jobId: 'job-1',
        platform: 'instagram',
        stage: OPENAI_IMAGE_GENERATION_STAGE,
        normalized_error_code: OPENAI_IMAGE_GENERATION_ABORTED_CODE,
      },
    },
  ], imageFailure) as any;

  assert.equal(summary.outcome, 'completed_with_errors');
  assert.equal(summary.failedStage, OPENAI_IMAGE_GENERATION_STAGE);
  assert.equal(summary.failureCode, OPENAI_IMAGE_GENERATION_ABORTED_CODE);
  assert.equal(summary.queue.created, 2);
  assert.deepEqual(summary.queue.createdByPlatform, { linkedin: 1, x: 1 });
  assert.equal(summary.drafts.failuresByPlatform.instagram, 1);
  assert.match(String(summary.message), /Instagram image generation was interrupted/);
  assert.doesNotMatch(String(summary.message), /worker job exceeded/i);
});

test('Instagram-only image interruption is specific instead of worker runtime', () => {
  const summary = __test__.reconstructStaleSummary([
    {
      level: 'warn',
      message: 'banked_angle_draft_failed',
      created_at: '2026-05-17T12:59:15.712Z',
      context: {
        jobId: 'job-2',
        platform: 'instagram',
        stage: OPENAI_IMAGE_GENERATION_STAGE,
        normalized_error_code: OPENAI_IMAGE_GENERATION_ABORTED_CODE,
      },
    },
  ], imageFailure) as any;

  assert.equal(summary.outcome, 'blocked');
  assert.equal(summary.failedStage, OPENAI_IMAGE_GENERATION_STAGE);
  assert.equal(summary.failureCode, OPENAI_IMAGE_GENERATION_ABORTED_CODE);
  assert.equal(summary.queue.created, 0);
  assert.match(String(summary.message), /Instagram image generation was interrupted/);
  assert.doesNotMatch(String(summary.message), /worker job exceeded/i);
  assert.doesNotMatch(String(summary.failedStage), /worker_runtime/i);
});

test('stale cleanup can identify recent refresh_queue activity', () => {
  assert.equal(
    __test__.hasRecentJobActivity([
      {
        level: 'warn',
        message: 'banked_angle_draft_failed',
        created_at: '2026-05-17T13:01:27.428Z',
        context: { jobId: 'job-3' },
      },
    ], '2026-05-17T13:00:00.000Z'),
    true
  );
  assert.equal(
    __test__.hasRecentJobActivity([
      {
        level: 'info',
        message: 'job_started',
        created_at: '2026-05-17T12:59:15.712Z',
        context: { jobId: 'job-3' },
      },
    ], '2026-05-17T13:00:00.000Z'),
    false
  );
});

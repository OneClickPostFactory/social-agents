import assert from 'node:assert/strict';

import config from '../config';
import {
  OPENAI_IMAGE_GENERATION_ABORTED_CODE,
  OPENAI_IMAGE_GENERATION_STAGE,
  OPENAI_TEXT_ANGLE_EXTRACTION_STAGE,
  extractSourceBank,
  generateInstagramImageFromText,
  openAIImageErrorDetails,
  setOpenAIUsageRecorder,
  type OpenAIUsageEvent,
} from '../src/ai';
import { __test__ } from '../src/supabase-worker';
import { DAILY_SLOT_HOURS, platformSlotOccupancyKey } from '../src/slot-scheduler';

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function fullPlatformSlots(platform: string, date = '2026-05-18'): string[] {
  return DAILY_SLOT_HOURS.map((_hour, index) => platformSlotOccupancyKey(platform, date, index));
}

async function main(): Promise<void> {
  await test('scheduler capacity preflight reports no open refresh slots when all enabled platforms are full', () => {
    const occupied = new Set([
      ...fullPlatformSlots('x'),
      ...fullPlatformSlots('threads'),
      ...fullPlatformSlots('linkedin'),
      ...fullPlatformSlots('instagram'),
    ]);

    const snapshot = __test__.platformSlotCapacitySnapshot(['x', 'threads', 'linkedin', 'instagram'] as any, occupied);
    assert.equal(snapshot.hasOpenSlots, false);
    assert.deepEqual(snapshot.openSlotsByPlatform, {
      instagram: 0,
      linkedin: 0,
      threads: 0,
      x: 0,
    });
  });

  await test('scheduler capacity preflight enqueues work when at least one platform has an open slot', () => {
    const occupied = new Set([
      ...fullPlatformSlots('instagram'),
      ...fullPlatformSlots('linkedin'),
      ...fullPlatformSlots('threads'),
      platformSlotOccupancyKey('x', '2026-05-18', 0),
    ]);

    const snapshot = __test__.platformSlotCapacitySnapshot(['x', 'threads', 'linkedin', 'instagram'] as any, occupied);
    assert.equal(snapshot.hasOpenSlots, true);
    assert.equal(snapshot.openSlotsByPlatform.x, 3);
    assert.equal(snapshot.openSlotsByPlatform.threads, 0);
  });

  await test('scheduler capacity preflight is platform-specific', () => {
    const occupied = new Set(fullPlatformSlots('x'));
    const snapshot = __test__.platformSlotCapacitySnapshot(['x', 'threads'] as any, occupied);
    assert.equal(snapshot.hasOpenSlots, true);
    assert.equal(snapshot.openSlotsByPlatform.x, 0);
    assert.equal(snapshot.openSlotsByPlatform.threads, 4);
  });

  await test('queue-full preflight avoids OpenAI work by reporting no open slots', () => {
    const occupied = new Set([
      ...fullPlatformSlots('x'),
      ...fullPlatformSlots('threads'),
    ]);
    const snapshot = __test__.platformSlotCapacitySnapshot(['x', 'threads'] as any, occupied);
    assert.equal(snapshot.hasOpenSlots, false);
  });

  await test('OpenAI usage telemetry records text call stages without prompt text', async () => {
    const previousKey = config.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const events: OpenAIUsageEvent[] = [];
    const sentinel = 'DO_NOT_LOG_PROMPT_TEXT';

    config.OPENAI_API_KEY = 'test-openai-key';
    setOpenAIUsageRecorder(event => {
      events.push(event);
    });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: {
              source_type: 'reddit_post',
              topic: 'Automation',
              core_claim: 'Queues need controls',
            },
            angles: [{
              label: 'Control layer',
              thesis: 'Scheduled publishing needs a control layer.',
              hook: 'A queue is a control surface.',
              practicalConsequence: 'Operators can see what will publish.',
              strength: 5,
            }],
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    try {
      await extractSourceBank({
        id: 'post-1',
        title: `A title ${sentinel}`,
        selftext: `Body ${sentinel}`,
        url: 'https://reddit.example/post-1',
        score: 1,
        comments: 0,
        subreddit: 'OpenclawBot',
        author: 'advanced_pudding9228',
        created: 1,
      }, {
        usageContext: {
          jobId: 'job-1',
          jobKind: 'fetch_sources',
          sourceRecordId: 'source-record-1',
          stage: OPENAI_TEXT_ANGLE_EXTRACTION_STAGE,
          userId: 'tenant-1',
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.OPENAI_API_KEY = previousKey;
      setOpenAIUsageRecorder(undefined);
    }

    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => event.call_status), ['started', 'completed']);
    assert.ok(events.every(event => event.stage === OPENAI_TEXT_ANGLE_EXTRACTION_STAGE));
    assert.ok(events.every(event => event.type === 'text'));
    assert.ok(events.every(event => event.input_size_estimate > 0));
    assert.doesNotMatch(JSON.stringify(events), new RegExp(sentinel));
    assert.doesNotMatch(JSON.stringify(events), /test-openai-key/);
  });

  await test('OpenAI usage telemetry records image failures without prompt text', async () => {
    const previousTimeout = config.OPENAI_IMAGE_TIMEOUT_MS;
    const previousKey = config.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const events: OpenAIUsageEvent[] = [];
    const sentinel = 'DO_NOT_LOG_IMAGE_PROMPT';

    config.OPENAI_IMAGE_TIMEOUT_MS = 10;
    config.OPENAI_API_KEY = 'test-openai-key';
    setOpenAIUsageRecorder(event => {
      events.push(event);
    });
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('This operation was aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')), { once: true });
      });
    }) as typeof fetch;

    try {
      await assert.rejects(
        () => generateInstagramImageFromText(`Title ${sentinel}`, `Body ${sentinel}`, {
          jobId: 'job-2',
          jobKind: 'refresh_queue',
          platform: 'instagram',
          stage: OPENAI_IMAGE_GENERATION_STAGE,
          userId: 'tenant-1',
        }),
        error => {
          const details = openAIImageErrorDetails(error);
          assert.equal(details?.code, OPENAI_IMAGE_GENERATION_ABORTED_CODE);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
      config.OPENAI_IMAGE_TIMEOUT_MS = previousTimeout;
      config.OPENAI_API_KEY = previousKey;
      setOpenAIUsageRecorder(undefined);
    }

    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => event.call_status), ['started', 'failed']);
    assert.ok(events.every(event => event.stage === OPENAI_IMAGE_GENERATION_STAGE));
    assert.ok(events.every(event => event.type === 'image'));
    assert.equal(events[1].normalized_error_code, OPENAI_IMAGE_GENERATION_ABORTED_CODE);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(sentinel));
    assert.doesNotMatch(JSON.stringify(events), /test-openai-key/);
  });

  await test('OpenAI usage telemetry aggregates into pipeline summaries', () => {
    const summary = {
      openaiUsage: {
        byStage: {},
        failuresByStage: {},
        imageCalls: 0,
        textCalls: 0,
      },
    };

    __test__.recordOpenAIUsageOnSummary(summary as any, {
      call_status: 'started',
      input_size_estimate: 100,
      model: 'gpt-4o',
      retry_attempt: 1,
      stage: 'platform_draft',
      timestamp: '2026-05-18T00:00:00.000Z',
      type: 'text',
    });
    __test__.recordOpenAIUsageOnSummary(summary as any, {
      call_status: 'started',
      input_size_estimate: 100,
      model: 'gpt-image-2',
      retry_attempt: 1,
      stage: OPENAI_IMAGE_GENERATION_STAGE,
      timestamp: '2026-05-18T00:00:01.000Z',
      type: 'image',
    });
    __test__.recordOpenAIUsageOnSummary(summary as any, {
      call_status: 'failed',
      input_size_estimate: 100,
      model: 'gpt-image-2',
      normalized_error_code: OPENAI_IMAGE_GENERATION_ABORTED_CODE,
      retry_attempt: 1,
      stage: OPENAI_IMAGE_GENERATION_STAGE,
      timestamp: '2026-05-18T00:00:02.000Z',
      type: 'image',
    });

    assert.equal(summary.openaiUsage.textCalls, 1);
    assert.equal(summary.openaiUsage.imageCalls, 1);
    assert.deepEqual(summary.openaiUsage.byStage, {
      instagram_image_generation: 1,
      platform_draft: 1,
    });
    assert.deepEqual(summary.openaiUsage.failuresByStage, {
      instagram_image_generation: 1,
    });
  });
}

void main();

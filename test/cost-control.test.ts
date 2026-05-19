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

function openAIUsageLog(input: {
  angleId?: string;
  callStatus: 'started' | 'completed' | 'failed';
  createdAt: string;
  model?: string;
  normalizedErrorCode?: string;
  platform?: string;
  queueItemId?: string;
  sourceRecordId?: string;
  stage: string;
  type: 'text' | 'image';
}): any {
  return {
    level: 'info',
    message: 'openai_call_recorded',
    created_at: input.createdAt,
    context: {
      angle_id: input.angleId,
      call_status: input.callStatus,
      elapsed_ms: input.callStatus === 'started' ? undefined : 1234,
      input_size_estimate: 120,
      model: input.model || (input.type === 'image' ? 'gpt-image-2' : 'gpt-4o-mini'),
      normalized_error_code: input.normalizedErrorCode,
      output_size_estimate: input.callStatus === 'completed' ? 400 : undefined,
      platform: input.platform,
      queue_item_id: input.queueItemId,
      source_record_id: input.sourceRecordId,
      stage: input.stage,
      timestamp: input.createdAt,
      type: input.type,
    },
  };
}

function queuedAngleLog(platforms: string[], createdAt = '2026-05-18T12:00:00.000Z'): any {
  return {
    level: 'info',
    message: 'queued_banked_angle',
    created_at: createdAt,
    context: {
      platforms,
    },
  };
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

  await test('OpenAI usage summary counts text and image calls by stage', () => {
    const logs = [
      openAIUsageLog({
        callStatus: 'started',
        createdAt: '2026-05-18T10:00:00.000Z',
        model: 'gpt-4o-mini',
        stage: 'platform_draft',
        type: 'text',
      }),
      openAIUsageLog({
        callStatus: 'completed',
        createdAt: '2026-05-18T10:00:02.000Z',
        model: 'gpt-4o-mini',
        stage: 'platform_draft',
        type: 'text',
      }),
      openAIUsageLog({
        callStatus: 'started',
        createdAt: '2026-05-18T10:01:00.000Z',
        model: 'gpt-image-2',
        platform: 'instagram',
        stage: OPENAI_IMAGE_GENERATION_STAGE,
        type: 'image',
      }),
      openAIUsageLog({
        callStatus: 'failed',
        createdAt: '2026-05-18T10:01:10.000Z',
        model: 'gpt-image-2',
        normalizedErrorCode: OPENAI_IMAGE_GENERATION_ABORTED_CODE,
        platform: 'instagram',
        stage: OPENAI_IMAGE_GENERATION_STAGE,
        type: 'image',
      }),
      queuedAngleLog(['threads', 'instagram']),
    ];

    const summary = __test__.buildOpenAIUsageDailySummary(logs, {});

    assert.equal(summary.title, 'OpenAI usage today');
    assert.equal(summary.labels.textGenerations, 'Text generations');
    assert.equal(summary.labels.imageGenerations, 'Image generations');
    assert.equal(summary.textCallCountToday, 1);
    assert.equal(summary.imageCallCountToday, 1);
    assert.equal(summary.imageGenerationAttemptsToday, 1);
    assert.equal(summary.platformDraftsCreatedToday, 2);
    assert.deepEqual(summary.callsByStage, {
      instagram_image_generation: 1,
      platform_draft: 1,
    });
    assert.deepEqual(summary.failuresByStage, {
      instagram_image_generation: 1,
    });
    assert.equal(summary.latestFailure?.normalizedErrorCode, OPENAI_IMAGE_GENERATION_ABORTED_CODE);
    assert.equal(summary.latestSuccessfulGeneration?.stage, 'platform_draft');
  });

  await test('repeated image aborts pause generation for that item', () => {
    const logs = [
      openAIUsageLog({
        angleId: 'angle-1',
        callStatus: 'failed',
        createdAt: '2026-05-18T11:50:00.000Z',
        normalizedErrorCode: OPENAI_IMAGE_GENERATION_ABORTED_CODE,
        platform: 'instagram',
        stage: OPENAI_IMAGE_GENERATION_STAGE,
        type: 'image',
      }),
      openAIUsageLog({
        angleId: 'angle-1',
        callStatus: 'failed',
        createdAt: '2026-05-18T11:58:00.000Z',
        normalizedErrorCode: OPENAI_IMAGE_GENERATION_ABORTED_CODE,
        platform: 'instagram',
        stage: OPENAI_IMAGE_GENERATION_STAGE,
        type: 'image',
      }),
    ];
    const usage = __test__.buildOpenAIUsageDailySummary(logs, {});
    const decision = __test__.preflightOpenAIGeneration({}, usage, logs, {
      angleId: 'angle-1',
      platform: 'instagram',
      stage: OPENAI_IMAGE_GENERATION_STAGE,
      type: 'image',
    }, new Date('2026-05-18T12:00:00.000Z'));

    assert.equal(decision.allowed, false);
    assert.equal(decision.code, __test__.OPENAI_IMAGE_PAUSED_REPEATED_ABORTS_CODE);
    assert.equal(decision.message, 'Generation is paused for this item because the same OpenAI step failed repeatedly. Existing queue items can still publish.');
    assert.equal(decision.nextAction, 'Review the failed item, wait for backoff, or manually retry after checking your OpenAI account.');
  });

  await test('source extraction backoff pauses repeated source failures', () => {
    const logs = [
      openAIUsageLog({
        callStatus: 'failed',
        createdAt: '2026-05-18T08:00:00.000Z',
        normalizedErrorCode: 'openai_text_rate_limited',
        sourceRecordId: 'source-1',
        stage: OPENAI_TEXT_ANGLE_EXTRACTION_STAGE,
        type: 'text',
      }),
      openAIUsageLog({
        callStatus: 'failed',
        createdAt: '2026-05-18T11:45:00.000Z',
        normalizedErrorCode: 'openai_text_rate_limited',
        sourceRecordId: 'source-1',
        stage: OPENAI_TEXT_ANGLE_EXTRACTION_STAGE,
        type: 'text',
      }),
    ];
    const usage = __test__.buildOpenAIUsageDailySummary(logs, {});
    const decision = __test__.preflightOpenAIGeneration({}, usage, logs, {
      sourceRecordId: 'source-1',
      stage: OPENAI_TEXT_ANGLE_EXTRACTION_STAGE,
      type: 'text',
    }, new Date('2026-05-18T12:00:00.000Z'));

    assert.equal(decision.allowed, false);
    assert.equal(decision.code, __test__.OPENAI_SOURCE_EXTRACTION_BACKOFF_ACTIVE_CODE);
  });

  await test('no open slot skips generation before OpenAI', () => {
    const decision = __test__.draftCreationPreflightForAngle({
      angleId: 'angle-full',
      occupiedSlots: new Set(fullPlatformSlots('instagram')),
      platform: 'instagram',
      queuedAnglePlatformKeys: new Set(),
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'instagram_no_open_slot');
  });

  await test('user-configured image limit blocks image generation when enabled', () => {
    const logs = [
      openAIUsageLog({
        callStatus: 'started',
        createdAt: '2026-05-18T10:00:00.000Z',
        platform: 'instagram',
        stage: OPENAI_IMAGE_GENERATION_STAGE,
        type: 'image',
      }),
    ];
    const settings = {
      openai_image_daily_call_limit: 1,
      openai_image_generation_enabled: true,
    };
    const usage = __test__.buildOpenAIUsageDailySummary(logs, settings);
    const decision = __test__.preflightOpenAIGeneration(settings, usage, logs, {
      platform: 'instagram',
      stage: OPENAI_IMAGE_GENERATION_STAGE,
      type: 'image',
    }, new Date('2026-05-18T12:00:00.000Z'));

    assert.equal(decision.allowed, false);
    assert.equal(decision.code, __test__.OPENAI_IMAGE_DAILY_LIMIT_REACHED_CODE);
  });

  await test('no configured limit means no daily hard cap', () => {
    const logs = Array.from({ length: 250 }, (_entry, index) => openAIUsageLog({
      callStatus: 'started',
      createdAt: `2026-05-18T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      platform: 'instagram',
      stage: OPENAI_IMAGE_GENERATION_STAGE,
      type: 'image',
    }));
    const usage = __test__.buildOpenAIUsageDailySummary(logs, {});
    const decision = __test__.preflightOpenAIGeneration({}, usage, logs, {
      platform: 'instagram',
      stage: OPENAI_IMAGE_GENERATION_STAGE,
      type: 'image',
    }, new Date('2026-05-18T12:00:00.000Z'));

    assert.equal(usage.imageCallCountToday, 250);
    assert.equal(decision.allowed, true);
  });

  await test('existing queue publish path remains OpenAI-free for durable media', () => {
    assert.equal(__test__.publishRequiresOpenAIMediaRepair({
      instagram_image_url: 'https://res.cloudinary.com/demo/image/upload/v1/post.jpg',
      platform: 'instagram',
    } as any), false);
    assert.equal(__test__.publishRequiresOpenAIMediaRepair({
      instagram_image_url: null,
      platform: 'threads',
    } as any), false);
    assert.equal(__test__.publishRequiresOpenAIMediaRepair({
      instagram_image_url: 'https://example.com/transient.jpg',
      platform: 'instagram',
    } as any), true);
  });
}

void main();

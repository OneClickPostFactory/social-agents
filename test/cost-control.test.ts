import assert from 'node:assert/strict';

import config from '../config';
import {
  OPENAI_IMAGE_GENERATION_ABORTED_CODE,
  OPENAI_IMAGE_GENERATION_STAGE,
  OPENAI_TEXT_ANGLE_EXTRACTION_STAGE,
  draftPlatforms,
  extractSourceBank,
  formatContentStrategyProfile,
  generateInstagramImageFromText,
  openAIImageErrorDetails,
  setOpenAIUsageRecorder,
  truncatePostSafely,
  type OpenAIUsageEvent,
} from '../src/ai';
import type { AngleCandidate, SourceSummary } from '../src/types';
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

function sampleSourceSummary(): SourceSummary {
  return {
    source_type: 'reddit_post',
    topic: 'Queue visibility',
    core_claim: 'Automation queues need visible state.',
    surface_problem: 'People think publishing failed randomly.',
    deeper_problem: 'The queue lacks operator-readable status.',
    practical_consequence: 'Operators cannot recover quickly.',
    specific_example: 'A due post stays invisible after a token issue.',
    best_line: 'Invisible queues create invisible failures.',
    audience_fit: 'operators',
    tone_source: 'practical',
    cta_goal: 'conversation',
  };
}

function sampleAngle(): AngleCandidate {
  return {
    label: 'Visible queue',
    thesis: 'A queue is part of the product surface.',
    hook: 'Queues fail quietly when no one can inspect them.',
    supportingPoints: ['status', 'proof'],
    practicalConsequence: 'Teams recover faster when queue state is legible.',
    specificExample: 'A failed publish row with a clear retry action.',
    audienceFit: 'operators',
    strength: 5,
  };
}

function openAIUsageLog(input: {
  angleId?: string;
  callStatus: 'started' | 'completed' | 'failed';
  createdAt: string;
  jobId?: string;
  model?: string;
  normalizedErrorCode?: string;
  platform?: string;
  queueItemId?: string;
  retryAttempt?: number;
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
      job_id: input.jobId,
      model: input.model || (input.type === 'image' ? 'gpt-image-2' : 'gpt-4o-mini'),
      normalized_error_code: input.normalizedErrorCode,
      output_size_estimate: input.callStatus === 'completed' ? 400 : undefined,
      platform: input.platform,
      queue_item_id: input.queueItemId,
      retry_attempt: input.retryAttempt || 1,
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

  await test('next-day capacity ignores occupied slots on other local dates', () => {
    const occupied = new Set(fullPlatformSlots('threads', '2026-05-18'));
    const snapshot = __test__.platformSlotCapacitySnapshot(
      ['threads'] as any,
      occupied,
      '2026-05-19',
    );

    assert.equal(snapshot.hasOpenSlots, true);
    assert.equal(snapshot.openSlotsByPlatform.threads, 4);
  });

  await test('next-day draft preflight blocks a full target date before OpenAI', () => {
    const decision = __test__.draftCreationPreflightForAngle({
      angleId: 'angle-next-day-full',
      occupiedSlots: new Set([
        ...fullPlatformSlots('threads', '2026-05-18'),
        ...fullPlatformSlots('threads', '2026-05-19'),
      ]),
      platform: 'threads',
      queuedAnglePlatformKeys: new Set(),
      targetLocalDate: '2026-05-19',
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'threads_no_open_slot');
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

  await test('missing content strategy profile preserves existing prompt shape', async () => {
    const previousKey = config.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const prompts: string[] = [];

    config.OPENAI_API_KEY = 'test-openai-key';
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || '{}'));
      prompts.push(String(body.messages?.[1]?.content || ''));
      return new Response(JSON.stringify({
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
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      await extractSourceBank({
        id: 'post-no-profile',
        title: 'Queue control',
        selftext: 'Operators need visible queue controls.',
        url: 'https://reddit.example/no-profile',
        score: 1,
        comments: 0,
        subreddit: 'OpenclawBot',
        author: 'advanced_pudding9228',
        created: 1,
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.OPENAI_API_KEY = previousKey;
    }

    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0], /Content strategy context/);
    assert.match(prompts[0], /Source content:/);
  });

  await test('content strategy profile fields appear in extraction prompt context', async () => {
    const previousKey = config.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const prompts: string[] = [];

    config.OPENAI_API_KEY = 'test-openai-key';
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || '{}'));
      prompts.push(String(body.messages?.[1]?.content || ''));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: {
                source_type: 'reddit_post',
                topic: 'Reliability',
                core_claim: 'Failures need visible controls',
              },
              angles: [{
                label: 'Visible failure',
                thesis: 'Automation needs visible failure states.',
                hook: 'Invisible failures do not stay small.',
                practicalConsequence: 'Operators can recover faster.',
                strength: 5,
              }],
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      await extractSourceBank({
        id: 'post-profile',
        title: 'Queue control',
        selftext: 'Operators need visible queue controls.',
        url: 'https://reddit.example/profile',
        score: 1,
        comments: 0,
        subreddit: 'OpenclawBot',
        author: 'advanced_pudding9228',
        created: 1,
      }, {
        contentStrategyProfile: {
          primary_audience: 'solo operators',
          business_offer: 'automation reliability audits',
          content_pillars: ['operational clarity', 'visible failures'],
          proof_assets: ['published queue audit checklist'],
          taboo_claims: ['guaranteed growth'],
        },
        contentStrategyProfileVersion: 'tenant-content-strategy-test',
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.OPENAI_API_KEY = previousKey;
    }

    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Content strategy context/);
    assert.match(prompts[0], /primary_audience: solo operators/);
    assert.match(prompts[0], /business_offer: automation reliability audits/);
    assert.match(prompts[0], /content_pillars: operational clarity \| visible failures/);
    assert.match(prompts[0], /proof_assets_supplied_by_user: published queue audit checklist/);
    assert.match(prompts[0], /taboo_claims: guaranteed growth/);
    assert.match(prompts[0], /Source truth always wins/);
  });

  await test('content strategy profile fields appear in platform draft prompt context', async () => {
    const previousKey = config.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const prompts: string[] = [];

    const summary: SourceSummary = {
      source_type: 'reddit_post',
      topic: 'Queue visibility',
      core_claim: 'Automation queues need visible state.',
      surface_problem: 'People think publishing failed randomly.',
      deeper_problem: 'The queue lacks operator-readable status.',
      practical_consequence: 'Operators cannot recover quickly.',
      specific_example: 'A due post stays invisible after a token issue.',
      best_line: 'Invisible queues create invisible failures.',
      audience_fit: 'operators',
      tone_source: 'practical',
      cta_goal: 'conversation',
    };
    const angle: AngleCandidate = {
      label: 'Visible queue',
      thesis: 'A queue is part of the product surface.',
      hook: 'Queues fail quietly when no one can inspect them.',
      supportingPoints: ['status', 'proof'],
      practicalConsequence: 'Teams recover faster when queue state is legible.',
      specificExample: 'A failed publish row with a clear retry action.',
      audienceFit: 'operators',
      strength: 5,
    };

    config.OPENAI_API_KEY = 'test-openai-key';
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || '{}'));
      prompts.push(String(body.messages?.[1]?.content || ''));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              angle: 'Visible queue',
              post: 'A queue is not backstage infrastructure. It is part of the product surface.',
              scores: {
                specificity: 5,
                human_tone: 5,
                platform_fit: 5,
                clarity: 5,
                practical_consequence: 5,
                non_genericity: 5,
              },
              banned_phrases_found: [],
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      await draftPlatforms(
        { title: 'Queue visibility', selftext: 'A failed slot needs visible proof.' },
        summary,
        angle,
        ['x'],
        {
          contentStrategyProfile: {
            primary_audience: 'technical founders',
            voice_traits: ['calm', 'specific'],
            words_to_use: ['operator', 'proof'],
            words_to_avoid: ['viral'],
            cta_style: 'quiet question',
            taboo_claims: ['guaranteed revenue'],
          },
          contentStrategyProfileVersion: 'tenant-content-strategy-test',
          disableLearningMemory: true,
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
      config.OPENAI_API_KEY = previousKey;
    }

    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Content strategy context/);
    assert.match(prompts[0], /primary_audience: technical founders/);
    assert.match(prompts[0], /voice_traits: calm \| specific/);
    assert.match(prompts[0], /words_to_use: operator \| proof/);
    assert.match(prompts[0], /words_to_avoid: viral/);
    assert.match(prompts[0], /taboo_claims: guaranteed revenue/);
    assert.match(prompts[0], /Write from this exact angle only/);
    assert.match(prompts[0], /Do not blend in other unused angles/);
  });

  await test('revision prompt includes content strategy context and fake-proof guardrails', async () => {
    const previousKey = config.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const prompts: string[] = [];

    config.OPENAI_API_KEY = 'test-openai-key';
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || '{}'));
      prompts.push(String(body.messages?.[1]?.content || ''));
      const firstDraft = prompts.length === 1;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              angle: 'Visible queue',
              post: firstDraft
                ? 'Generic launch copy with low specificity.'
                : 'A queue is a product surface when operators can inspect blockers and proof.',
              scores: {
                specificity: firstDraft ? 2 : 5,
                human_tone: firstDraft ? 2 : 5,
                platform_fit: firstDraft ? 2 : 5,
                clarity: 5,
                practical_consequence: 5,
                non_genericity: 5,
              },
              banned_phrases_found: [],
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      await draftPlatforms(
        { title: 'Queue visibility', selftext: 'A failed slot needs visible proof.' },
        sampleSourceSummary(),
        sampleAngle(),
        ['x'],
        {
          contentStrategyProfile: {
            primary_audience: 'technical founders',
            business_offer: 'source-to-queue publishing system',
            positioning_statement: 'Shows its work instead of acting like a blank AI writer.',
            voice_traits: ['calm', 'operator-minded'],
            words_to_use: ['publish proof', 'scheduled queue'],
            words_to_avoid: ['viral'],
            proof_assets: ['records external post IDs'],
            cta_style: 'soft early-access CTA',
            taboo_claims: ['guaranteed growth'],
          },
          contentStrategyProfileVersion: 'tenant-content-strategy-test',
          disableLearningMemory: true,
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
      config.OPENAI_API_KEY = previousKey;
    }

    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Content strategy context/);
    assert.match(prompts[1], /primary_audience: technical founders/);
    assert.match(prompts[1], /business_offer: source-to-queue publishing system/);
    assert.match(prompts[1], /positioning_statement: Shows its work/);
    assert.match(prompts[1], /voice_traits: calm \| operator-minded/);
    assert.match(prompts[1], /words_to_use: publish proof \| scheduled queue/);
    assert.match(prompts[1], /words_to_avoid: viral/);
    assert.match(prompts[1], /proof_assets_supplied_by_user: records external post IDs/);
    assert.match(prompts[1], /cta_style: soft early-access CTA/);
    assert.match(prompts[1], /taboo_claims: guaranteed growth/);
    assert.match(prompts[1], /Do not invent proof/);
    assert.match(prompts[1], /testimonials, clients, numbers, metrics, revenue, growth, or guarantees/);
    assert.match(prompts[1], /Preserve source truth/);
    assert.match(prompts[1], /Platform: X/);
    assert.match(prompts[1], /Write from this exact angle only/);
  });

  await test('revision prompt omits content strategy context when profile is empty', async () => {
    const previousKey = config.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const prompts: string[] = [];

    config.OPENAI_API_KEY = 'test-openai-key';
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || '{}'));
      prompts.push(String(body.messages?.[1]?.content || ''));
      const firstDraft = prompts.length === 1;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              angle: 'Visible queue',
              post: firstDraft
                ? 'Generic launch copy with low specificity.'
                : 'A queue is a product surface when operators can inspect blockers and proof.',
              scores: {
                specificity: firstDraft ? 2 : 5,
                human_tone: firstDraft ? 2 : 5,
                platform_fit: firstDraft ? 2 : 5,
                clarity: 5,
                practical_consequence: 5,
                non_genericity: 5,
              },
              banned_phrases_found: [],
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      await draftPlatforms(
        { title: 'Queue visibility', selftext: 'A failed slot needs visible proof.' },
        sampleSourceSummary(),
        sampleAngle(),
        ['x'],
        {
          contentStrategyProfile: {},
          disableLearningMemory: true,
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
      config.OPENAI_API_KEY = previousKey;
    }

    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[1], /Content strategy context/);
    assert.match(prompts[1], /Platform: X/);
    assert.match(prompts[1], /Preserve source truth/);
  });

  await test('content strategy formatter truncates long fields and caps arrays', () => {
    const formatted = formatContentStrategyProfile({
      primary_audience: 'A'.repeat(1000),
      positioning_statement: 'B'.repeat(1000),
      content_pillars: Array.from({ length: 10 }, (_entry, index) => `pillar-${index}`),
      voice_traits: Array.from({ length: 10 }, (_entry, index) => `trait-${index}`),
    }, 'tenant-content-strategy-test');

    assert.ok(formatted.length <= 1700);
    assert.match(formatted, /profile_version: tenant-content-strategy-test/);
    assert.match(formatted, /pillar-7/);
    assert.doesNotMatch(formatted, /pillar-8/);
    assert.match(formatted, /trait-7/);
    assert.doesNotMatch(formatted, /trait-8/);
    assert.match(formatted, /source truth wins/i);
  });

  await test('proof assets are represented only when supplied', () => {
    const withoutProof = formatContentStrategyProfile({
      primary_audience: 'operators',
    });
    const withProof = formatContentStrategyProfile({
      primary_audience: 'operators',
      proof_assets: ['public reliability checklist'],
    });

    assert.doesNotMatch(withoutProof, /proof_assets_supplied_by_user/);
    assert.match(withProof, /proof_assets_supplied_by_user: public reliability checklist/);
  });

  await test('content strategy profile text does not leak into OpenAI telemetry', async () => {
    const previousKey = config.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const events: OpenAIUsageEvent[] = [];
    const sentinel = 'DO_NOT_LOG_PROFILE_TEXT';

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
              topic: 'Telemetry',
              core_claim: 'Telemetry should stay safe.',
            },
            angles: [{
              label: 'Safe telemetry',
              thesis: 'Prompt context should not leak into telemetry.',
              hook: 'Safe telemetry records shape, not text.',
              practicalConsequence: 'Operators can debug without exposing strategy.',
              strength: 5,
            }],
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    try {
      await extractSourceBank({
        id: 'post-profile-telemetry',
        title: 'Safe telemetry',
        selftext: 'Telemetry should stay safe.',
        url: 'https://reddit.example/profile-telemetry',
        score: 1,
        comments: 0,
        subreddit: 'OpenclawBot',
        author: 'advanced_pudding9228',
        created: 1,
      }, {
        contentStrategyProfile: {
          primary_audience: sentinel,
          proof_assets: [sentinel],
        },
        usageContext: {
          jobId: 'job-profile',
          jobKind: 'fetch_sources',
          sourceRecordId: 'source-record-profile',
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
    assert.doesNotMatch(JSON.stringify(events), new RegExp(sentinel));
    assert.doesNotMatch(JSON.stringify(events), /test-openai-key/);
  });

  await test('platform length rules still apply with content strategy profile', async () => {
    const previousKey = config.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const summary: SourceSummary = {
      source_type: 'reddit_post',
      topic: 'Queue visibility',
      core_claim: 'Automation queues need visible state.',
      surface_problem: 'People think publishing failed randomly.',
      deeper_problem: 'The queue lacks operator-readable status.',
      practical_consequence: 'Operators cannot recover quickly.',
      specific_example: 'A due post stays invisible after a token issue.',
      best_line: 'Invisible queues create invisible failures.',
      audience_fit: 'operators',
      tone_source: 'practical',
      cta_goal: 'conversation',
    };
    const angle: AngleCandidate = {
      label: 'Visible queue',
      thesis: 'A queue is part of the product surface.',
      hook: 'Queues fail quietly when no one can inspect them.',
      supportingPoints: ['status', 'proof'],
      practicalConsequence: 'Teams recover faster when queue state is legible.',
      specificExample: 'A failed publish row with a clear retry action.',
      audienceFit: 'operators',
      strength: 5,
    };

    config.OPENAI_API_KEY = 'test-openai-key';
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            angle: 'Visible queue',
            post: 'A'.repeat(400),
            scores: {
              specificity: 5,
              human_tone: 5,
              platform_fit: 5,
              clarity: 5,
              practical_consequence: 5,
              non_genericity: 5,
            },
            banned_phrases_found: [],
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    try {
      const draft = await draftPlatforms(
        { title: 'Queue visibility', selftext: 'A failed slot needs visible proof.' },
        summary,
        angle,
        ['x'],
        {
          contentStrategyProfile: {
            primary_audience: 'operators',
            words_to_avoid: ['viral'],
          },
          disableLearningMemory: true,
        }
      );
      assert.ok(draft.x.length <= 280);
    } finally {
      globalThis.fetch = originalFetch;
      config.OPENAI_API_KEY = previousKey;
    }
  });

  await test('X truncation stays within limit and avoids mid-word clipping', () => {
    const truncated = truncatePostSafely(
      'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda',
      30
    );

    assert.ok(truncated.length <= 30);
    assert.equal(truncated, 'Alpha beta gamma delta...');
    assert.doesNotMatch(truncated, /epsi\.\.\.$/);
  });

  await test('X truncation prefers sentence boundary when useful', () => {
    const firstSentence = 'The queue should show blockers, proof, and the next posting window clearly.';
    const truncated = truncatePostSafely(
      `${firstSentence} This second sentence should not survive the X limit because the first one is already useful.`,
      110
    );

    assert.equal(truncated, firstSentence);
    assert.ok(truncated.length <= 110);
    assert.doesNotMatch(truncated, /second sentence/);
  });

  await test('non-X platforms are not truncated by X safety cap', async () => {
    const previousKey = config.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const longLinkedInPost = 'LinkedIn can keep a fuller explanation about queue state, blockers, and publish proof without using the X safety cap. '.repeat(4).trim();

    config.OPENAI_API_KEY = 'test-openai-key';
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            angle: 'Visible queue',
            post: longLinkedInPost,
            scores: {
              specificity: 5,
              human_tone: 5,
              platform_fit: 5,
              clarity: 5,
              practical_consequence: 5,
              non_genericity: 5,
            },
            banned_phrases_found: [],
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    try {
      const draft = await draftPlatforms(
        { title: 'Queue visibility', selftext: 'A failed slot needs visible proof.' },
        sampleSourceSummary(),
        sampleAngle(),
        ['linkedin'],
        { disableLearningMemory: true }
      );
      assert.equal(draft.linkedin, longLinkedInPost);
      assert.ok(draft.linkedin.length > 280);
    } finally {
      globalThis.fetch = originalFetch;
      config.OPENAI_API_KEY = previousKey;
    }
  });

  await test('worker exposes content strategy prompt options from settings', () => {
    assert.deepEqual(__test__.contentStrategyPromptOptions({}), {});
    const options = __test__.contentStrategyPromptOptions({
      content_strategy_profile: {
        primary_audience: 'operators',
        words_to_avoid: ['viral'],
      },
      content_strategy_profile_version: 'tenant-content-strategy-test',
    } as any);

    assert.deepEqual(options, {
      contentStrategyProfile: {
        primary_audience: 'operators',
        words_to_avoid: ['viral'],
      },
      contentStrategyProfileVersion: 'tenant-content-strategy-test',
    });
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

  await test('unterminated OpenAI attempt blocks another paid call for the same angle', () => {
    const logs = [openAIUsageLog({
      angleId: 'angle-uncertain',
      callStatus: 'started',
      createdAt: '2026-05-18T11:55:00.000Z',
      jobId: 'job-uncertain',
      platform: 'threads',
      retryAttempt: 1,
      stage: 'platform_draft',
      type: 'text',
    })];
    const usage = __test__.buildOpenAIUsageDailySummary(logs, {});
    const decision = __test__.preflightOpenAIGeneration({}, usage, logs, {
      angleId: 'angle-uncertain',
      platform: 'threads',
      stage: 'platform_draft',
      type: 'text',
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.code, __test__.OPENAI_GENERATION_ATTEMPT_UNCERTAIN_CODE);
  });

  await test('matching terminal telemetry clears the uncertain-attempt guard', () => {
    const base = {
      angleId: 'angle-complete',
      jobId: 'job-complete',
      platform: 'threads',
      retryAttempt: 1,
      stage: 'platform_draft',
      type: 'text' as const,
    };
    const logs = [
      openAIUsageLog({ ...base, callStatus: 'started', createdAt: '2026-05-18T11:55:00.000Z' }),
      openAIUsageLog({ ...base, callStatus: 'completed', createdAt: '2026-05-18T11:55:03.000Z' }),
    ];
    const usage = __test__.buildOpenAIUsageDailySummary(logs, {});
    const decision = __test__.preflightOpenAIGeneration({}, usage, logs, {
      angleId: 'angle-complete',
      platform: 'threads',
      stage: 'platform_draft',
      type: 'text',
    });

    assert.equal(decision.allowed, true);
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

  await test('any existing queue history blocks automatic angle reuse before OpenAI', () => {
    const decision = __test__.draftCreationPreflightForAngle({
      angleId: 'angle-with-history',
      occupiedSlots: new Set(),
      platform: 'threads',
      queuedAnglePlatformKeys: new Set(['angle-with-history:threads']),
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'angle_platform_draft_already_queued');
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
      openAIUsageLog({
        callStatus: 'completed',
        createdAt: '2026-05-18T10:00:01.000Z',
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

  await test('unset tenant limits use fail-closed daily defaults', () => {
    const logs = Array.from({ length: 4 }, (_entry, index) => {
      const base = {
        jobId: 'image-job-' + index,
        platform: 'instagram',
        stage: OPENAI_IMAGE_GENERATION_STAGE,
        type: 'image' as const,
      };
      return [
        openAIUsageLog({
          ...base,
          callStatus: 'started',
          createdAt: '2026-05-18T10:0' + index + ':00.000Z',
        }),
        openAIUsageLog({
          ...base,
          callStatus: 'completed',
          createdAt: '2026-05-18T10:0' + index + ':01.000Z',
        }),
      ];
    }).flat();
    const usage = __test__.buildOpenAIUsageDailySummary(logs, {});
    const decision = __test__.preflightOpenAIGeneration({}, usage, logs, {
      platform: 'instagram',
      stage: OPENAI_IMAGE_GENERATION_STAGE,
      type: 'image',
    }, new Date('2026-05-18T12:00:00.000Z'));

    assert.equal(usage.imageCallCountToday, 4);
    assert.equal(usage.configuredLimits.imageDailyCallLimit, 4);
    assert.equal(usage.configuredLimits.textDailyCallLimit, 40);
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, __test__.OPENAI_IMAGE_DAILY_LIMIT_REACHED_CODE);
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

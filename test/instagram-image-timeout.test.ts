import assert from 'node:assert/strict';

import config from '../config';
import {
  OPENAI_IMAGE_GENERATION_ABORTED_CODE,
  OPENAI_IMAGE_GENERATION_STAGE,
  generateInstagramImageFromText,
  openAIImageErrorDetails,
  openAIImageQualityForModel,
  openAIImageTimeoutMs,
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

async function main(): Promise<void> {
  await test('GPT image requests use the low-latency quality profile', () => {
    assert.equal(openAIImageQualityForModel('gpt-image-2'), 'low');
    assert.equal(openAIImageQualityForModel('chatgpt-image-latest'), 'low');
    assert.equal(openAIImageQualityForModel('dall-e-3'), 'standard');
  });

  await test('OpenAI image generation uses the image-specific timeout and does not retry aborts', async () => {
    const previousTimeout = config.OPENAI_IMAGE_TIMEOUT_MS;
    const previousKey = config.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    let calls = 0;

    config.OPENAI_IMAGE_TIMEOUT_MS = 10;
    config.OPENAI_API_KEY = 'test-openai-key';
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls++;
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
      assert.equal(openAIImageTimeoutMs(), 10);
      await assert.rejects(
        () => generateInstagramImageFromText('Test image', 'A short test post.'),
        error => {
          const details = openAIImageErrorDetails(error);
          assert.ok(details);
          assert.equal(details.code, OPENAI_IMAGE_GENERATION_ABORTED_CODE);
          assert.equal(details.stage, OPENAI_IMAGE_GENERATION_STAGE);
          assert.equal(details.timeoutMs, 10);
          assert.equal(details.attempt, 1);
          assert.ok(Number(details.promptLength) > 0);
          assert.ok(Number(details.promptLength) < 1000);
          assert.ok(Number(details.elapsedMs) >= 0);
          return true;
        }
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
      config.OPENAI_IMAGE_TIMEOUT_MS = previousTimeout;
      config.OPENAI_API_KEY = previousKey;
    }
  });

  await test('full Instagram active slots block Instagram image generation without blocking other platforms', () => {
    const occupied = new Set(
      DAILY_SLOT_HOURS.map((_hour, index) => platformSlotOccupancyKey('instagram', '2026-05-17', index))
    );

    assert.equal(__test__.hasOpenActiveSlotForPlatform('instagram', occupied), false);
    assert.equal(__test__.hasOpenActiveSlotForPlatform('x', occupied), true);
    assert.equal(__test__.hasOpenActiveSlotForPlatform('threads', occupied), true);
    assert.equal(__test__.hasOpenActiveSlotForPlatform('linkedin', occupied), true);
  });
}

void main();

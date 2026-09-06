import assert from 'node:assert/strict';

import config from '../config';
import * as linkedin from '../src/linkedin';
import { installScopedConfig, runWithRuntimeScope } from '../src/runtime-scope';
import * as threads from '../src/threads';
import * as x from '../src/x';

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function main(): Promise<void> {
  installScopedConfig(config);

  await test('overlapping tenant scopes do not share config or token persistence callbacks', async () => {
    const base = {
      openai: config.OPENAI_API_KEY,
      threads: config.THREADS_ACCESS_TOKEN,
      linkedin: config.LINKEDIN_TOKEN,
      linkedinRefresh: config.LINKEDIN_REFRESH_TOKEN,
      x: config.X_OAUTH2_ACCESS_TOKEN,
      xRefresh: config.X_OAUTH2_REFRESH_TOKEN,
    };
    const bothReady = deferred();
    const release = deferred();
    let readyCount = 0;
    const persisted: string[] = [];

    async function tenantRun(tenant: 'a' | 'b'): Promise<void> {
      await runWithRuntimeScope(async () => {
        config.OPENAI_API_KEY = `openai-${tenant}`;
        config.THREADS_ACCESS_TOKEN = `threads-${tenant}`;
        config.LINKEDIN_TOKEN = `linkedin-${tenant}`;
        config.LINKEDIN_REFRESH_TOKEN = `linkedin-refresh-${tenant}`;
        config.X_OAUTH2_ACCESS_TOKEN = `x-${tenant}`;
        config.X_OAUTH2_REFRESH_TOKEN = `x-refresh-${tenant}`;

        const restoreThreads = threads.setTokenPersistence(async tokens => {
          persisted.push(`${tenant}:threads:${tokens.accessToken}`);
        });
        const restoreLinkedIn = linkedin.setOAuth2TokenPersistence(async tokens => {
          persisted.push(`${tenant}:linkedin:${tokens.accessToken}`);
        });
        const restoreX = x.setOAuth2TokenPersistence(async tokens => {
          persisted.push(`${tenant}:x:${tokens.accessToken}`);
        });

        readyCount++;
        if (readyCount === 2) bothReady.resolve();
        await release.promise;

        assert.equal(config.OPENAI_API_KEY, `openai-${tenant}`);
        assert.equal(config.THREADS_ACCESS_TOKEN, `threads-${tenant}`);
        assert.equal(config.LINKEDIN_TOKEN, `linkedin-${tenant}`);
        assert.equal(config.X_OAUTH2_ACCESS_TOKEN, `x-${tenant}`);

        await threads.persistLongLivedAccessToken({
          accessToken: `threads-rotated-${tenant}`,
          source: 'refresh',
        });
        await linkedin.persistOAuth2Tokens({
          accessToken: `linkedin-rotated-${tenant}`,
          refreshToken: `linkedin-refresh-rotated-${tenant}`,
        });
        await x.persistOAuth2Tokens({
          accessToken: `x-rotated-${tenant}`,
          refreshToken: `x-refresh-rotated-${tenant}`,
        });

        await Promise.resolve();
        assert.equal(config.THREADS_ACCESS_TOKEN, `threads-rotated-${tenant}`);
        assert.equal(config.LINKEDIN_TOKEN, `linkedin-rotated-${tenant}`);
        assert.equal(config.LINKEDIN_REFRESH_TOKEN, `linkedin-refresh-rotated-${tenant}`);
        assert.equal(config.X_OAUTH2_ACCESS_TOKEN, `x-rotated-${tenant}`);
        assert.equal(config.X_OAUTH2_REFRESH_TOKEN, `x-refresh-rotated-${tenant}`);

        restoreThreads();
        restoreLinkedIn();
        restoreX();
      }, { tenant });
    }

    const tenantA = tenantRun('a');
    const tenantB = tenantRun('b');
    await bothReady.promise;
    release.resolve();
    await Promise.all([tenantA, tenantB]);

    assert.deepEqual(new Set(persisted), new Set([
      'a:threads:threads-rotated-a',
      'a:linkedin:linkedin-rotated-a',
      'a:x:x-rotated-a',
      'b:threads:threads-rotated-b',
      'b:linkedin:linkedin-rotated-b',
      'b:x:x-rotated-b',
    ]));

    assert.equal(config.OPENAI_API_KEY, base.openai);
    assert.equal(config.THREADS_ACCESS_TOKEN, base.threads);
    assert.equal(config.LINKEDIN_TOKEN, base.linkedin);
    assert.equal(config.LINKEDIN_REFRESH_TOKEN, base.linkedinRefresh);
    assert.equal(config.X_OAUTH2_ACCESS_TOKEN, base.x);
    assert.equal(config.X_OAUTH2_REFRESH_TOKEN, base.xRefresh);
  });

  await test('a failed scoped execution cannot leak mutated config into the next execution', async () => {
    const baseOpenAIKey = config.OPENAI_API_KEY;

    await assert.rejects(
      runWithRuntimeScope(async () => {
        config.OPENAI_API_KEY = 'should-not-leak';
        await Promise.resolve();
        throw new Error('expected failure');
      }, { tenant: 'failing' }),
      /expected failure/
    );

    assert.equal(config.OPENAI_API_KEY, baseOpenAIKey);
    await runWithRuntimeScope(async () => {
      assert.equal(config.OPENAI_API_KEY, baseOpenAIKey);
      config.OPENAI_API_KEY = 'next-tenant';
      assert.equal(config.OPENAI_API_KEY, 'next-tenant');
    }, { tenant: 'next' });
    assert.equal(config.OPENAI_API_KEY, baseOpenAIKey);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

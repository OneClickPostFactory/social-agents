import assert from 'node:assert/strict';

import config from '../config';
import * as threads from '../src/threads';

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const originalFetch = globalThis.fetch;
const originalToken = config.THREADS_ACCESS_TOKEN;

async function main(): Promise<void> {
await test('refreshes and persists a long-lived Threads token without exposing it', async () => {
  config.THREADS_ACCESS_TOKEN = 'old-test-token';
  let persisted: threads.ThreadsTokenSet | undefined;
  const restorePersistence = threads.setTokenPersistence(tokens => {
    persisted = tokens;
  });
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.threads.net');
    assert.equal(url.pathname, '/refresh_access_token');
    assert.equal(url.searchParams.get('grant_type'), 'th_refresh_token');
    assert.equal(url.searchParams.get('access_token'), 'old-test-token');
    return new Response(JSON.stringify({
      access_token: 'new-test-token',
      token_type: 'bearer',
      expires_in: 5_183_944,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const tokens = await threads.refreshLongLivedAccessToken();
    await threads.persistLongLivedAccessToken(tokens);
    assert.equal(config.THREADS_ACCESS_TOKEN, 'new-test-token');
    assert.equal(persisted?.accessToken, 'new-test-token');
    assert.equal(persisted?.expiresIn, 5_183_944);
  } finally {
    restorePersistence();
  }
});

globalThis.fetch = originalFetch;
config.THREADS_ACCESS_TOKEN = originalToken;
}

main().catch(error => {
  globalThis.fetch = originalFetch;
  config.THREADS_ACCESS_TOKEN = originalToken;
  console.error(error);
  process.exitCode = 1;
});

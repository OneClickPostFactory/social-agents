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
const originalAppSecret = config.THREADS_APP_SECRET;

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
    assert.equal(persisted?.source, 'refresh');
  } finally {
    restorePersistence();
  }
});

await test('exchanges a short-lived Threads token and verifies the resulting account', async () => {
  config.THREADS_ACCESS_TOKEN = 'short-test-token';
  config.THREADS_APP_SECRET = 'test-app-secret';
  let persisted: threads.ThreadsTokenSet | undefined;
  const restorePersistence = threads.setTokenPersistence(tokens => {
    persisted = tokens;
  });
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests += 1;
    const url = new URL(String(input));
    if (url.pathname === '/access_token') {
      assert.equal(url.searchParams.get('grant_type'), 'th_exchange_token');
      assert.equal(url.searchParams.get('client_secret'), 'test-app-secret');
      assert.equal(url.searchParams.get('access_token'), 'short-test-token');
      return new Response(JSON.stringify({
        access_token: 'long-test-token',
        token_type: 'bearer',
        expires_in: 5_183_944,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    assert.equal(url.pathname, '/me');
    assert.equal(init?.headers && new Headers(init.headers).get('Authorization'), 'Bearer long-test-token');
    return new Response(JSON.stringify({ id: 'threads-account', username: 'owner' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const result = await threads.prepareAccessTokenForPublish();
    assert.equal(result.action, 'exchanged');
    assert.equal(result.accountId, 'threads-account');
    assert.equal(config.THREADS_ACCESS_TOKEN, 'long-test-token');
    assert.equal(persisted?.source, 'exchange');
    assert.equal(requests, 2);
  } finally {
    restorePersistence();
  }
});

globalThis.fetch = originalFetch;
config.THREADS_ACCESS_TOKEN = originalToken;
config.THREADS_APP_SECRET = originalAppSecret;
}

main().catch(error => {
  globalThis.fetch = originalFetch;
  config.THREADS_ACCESS_TOKEN = originalToken;
  config.THREADS_APP_SECRET = originalAppSecret;
  console.error(error);
  process.exitCode = 1;
});

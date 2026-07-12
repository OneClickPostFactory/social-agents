import assert from 'node:assert/strict';

import config from '../config';
import * as linkedin from '../src/linkedin';

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
const original = {
  token: config.LINKEDIN_TOKEN,
  refreshToken: config.LINKEDIN_REFRESH_TOKEN,
  clientId: config.LINKEDIN_CLIENT_ID,
  clientSecret: config.LINKEDIN_CLIENT_SECRET,
  expiresAt: config.LINKEDIN_EXPIRES_AT,
};

async function main(): Promise<void> {
  await test('refreshes and persists LinkedIn OAuth tokens without logging credentials', async () => {
    config.LINKEDIN_TOKEN = 'old-access-token';
    config.LINKEDIN_REFRESH_TOKEN = 'old-refresh-token';
    config.LINKEDIN_CLIENT_ID = 'client-id';
    config.LINKEDIN_CLIENT_SECRET = 'client-secret';
    config.LINKEDIN_EXPIRES_AT = '';
    let persisted: linkedin.LinkedInOAuthTokenSet | undefined;
    const restorePersistence = linkedin.setOAuth2TokenPersistence(tokens => {
      persisted = tokens;
    });
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://www.linkedin.com/oauth/v2/accessToken');
      assert.equal(init?.method, 'POST');
      const body = new URLSearchParams(String(init?.body || ''));
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'old-refresh-token');
      assert.equal(body.get('client_id'), 'client-id');
      assert.equal(body.get('client_secret'), 'client-secret');
      return new Response(JSON.stringify({
        access_token: 'new-access-token',
        expires_in: 5_184_000,
        refresh_token: 'new-refresh-token',
        refresh_token_expires_in: 31_536_000,
        scope: 'w_member_social',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const tokens = await linkedin.refreshAndPersistOAuth2AccessToken();
      assert.equal(tokens.accessToken, 'new-access-token');
      assert.equal(config.LINKEDIN_TOKEN, 'new-access-token');
      assert.equal(config.LINKEDIN_REFRESH_TOKEN, 'new-refresh-token');
      assert.equal(persisted?.accessToken, 'new-access-token');
      assert.equal(persisted?.refreshTokenExpiresIn, 31_536_000);
    } finally {
      restorePersistence();
    }
  });

  await test('refreshes only when a complete credential set is due', async () => {
    config.LINKEDIN_REFRESH_TOKEN = 'refresh-token';
    config.LINKEDIN_CLIENT_ID = 'client-id';
    config.LINKEDIN_CLIENT_SECRET = 'client-secret';
    const now = Date.parse('2026-07-12T12:00:00.000Z');
    assert.equal(linkedin.shouldRefreshAccessToken('', now), true);
    assert.equal(
      linkedin.shouldRefreshAccessToken('2026-07-14T12:00:00.000Z', now),
      true
    );
    assert.equal(
      linkedin.shouldRefreshAccessToken('2026-08-12T12:00:00.000Z', now),
      false
    );
    config.LINKEDIN_CLIENT_SECRET = '';
    assert.equal(linkedin.shouldRefreshAccessToken('', now), false);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  globalThis.fetch = originalFetch;
  config.LINKEDIN_TOKEN = original.token;
  config.LINKEDIN_REFRESH_TOKEN = original.refreshToken;
  config.LINKEDIN_CLIENT_ID = original.clientId;
  config.LINKEDIN_CLIENT_SECRET = original.clientSecret;
  config.LINKEDIN_EXPIRES_AT = original.expiresAt;
});

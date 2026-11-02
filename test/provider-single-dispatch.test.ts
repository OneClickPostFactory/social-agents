import assert from 'node:assert/strict';
import config from '../config';
import * as x from '../src/x';
import * as linkedin from '../src/linkedin';
import { PlatformPublishError } from '../src/platform-errors';
import { classifyPostDispatchError } from '../src/publication-outcome';

async function main() {
  const originalFetch = globalThis.fetch;
  const original = {
    X_OAUTH2_ACCESS_TOKEN: config.X_OAUTH2_ACCESS_TOKEN,
    X_OAUTH2_REFRESH_TOKEN: config.X_OAUTH2_REFRESH_TOKEN,
    X_CLIENT_ID: config.X_CLIENT_ID, X_CLIENT_SECRET: config.X_CLIENT_SECRET,
    LINKEDIN_TOKEN: config.LINKEDIN_TOKEN, LINKEDIN_PERSON_URN: config.LINKEDIN_PERSON_URN,
  };
  Object.assign(config, {
    X_OAUTH2_ACCESS_TOKEN: 'fixture-access', X_OAUTH2_REFRESH_TOKEN: 'fixture-refresh',
    X_CLIENT_ID: 'fixture-client', X_CLIENT_SECRET: 'fixture-secret',
    LINKEDIN_TOKEN: 'fixture-linkedin', LINKEDIN_PERSON_URN: 'urn:li:person:fixture',
  });
  const restore = x.setOAuth2TokenPersistence(async () => {});
  try {
    for (const status of [401, 503, 201]) {
      let posts = 0, refreshes = 0;
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url.includes('oauth2/token')) { refreshes++; return Response.json({ access_token: 'new-fixture', refresh_token: 'new-refresh' }); }
        assert.ok(url.endsWith('/2/tweets'));
        assert.equal(init?.method, 'POST'); posts++;
        return Response.json({ title: 'Unauthorized', ...(status === 201 ? { data: { id: '123456' } } : {}) }, { status });
      }) as typeof fetch;
      await assert.rejects(() => x.publish('fixture content'));
      assert.equal(posts, 1); assert.equal(refreshes, 0);
      console.log(`ok - X status ${status} cannot trigger an invisible second publishing request`);
    }
    let lookups = 0, refreshes = 0;
    globalThis.fetch = (async input => {
      const url = String(input);
      if (url.includes('oauth2/token')) { refreshes++; return Response.json({ access_token: 'new-fixture', refresh_token: 'new-refresh' }); }
      lookups++;
      return lookups === 1 ? Response.json({ title: 'Unauthorized' }, { status: 401 }) : Response.json({ data: { id: 'fixture-account' } });
    }) as typeof fetch;
    assert.equal((await x.verifyCredentials()).accountId, 'fixture-account');
    assert.equal(lookups, 2); assert.equal(refreshes, 1);
    console.log('ok - read-only X identity verification can still refresh after explicit 401');

    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), 'https://api.linkedin.com/rest/posts');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('LinkedIn-Version'), '202608');
      const post = JSON.parse(String(init?.body));
      assert.equal(post.author, config.LINKEDIN_PERSON_URN);
      assert.equal(post.commentary, 'fixture content');
      assert.equal(post.visibility, 'PUBLIC');
      return new Response('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:123456' } });
    }) as typeof fetch;
    assert.equal(await linkedin.publish('fixture content'), 'urn:li:share:123456');
    globalThis.fetch = (async () => new Response('', { status: 201 })) as typeof fetch;
    await assert.rejects(() => linkedin.publish('fixture content'));
    console.log('ok - LinkedIn uses its exact response identity and never fabricates posted');

    for (const status of [408, 409, 500]) {
      const outcome = classifyPostDispatchError(new PlatformPublishError({
        platform: 'x', stage: 'post', status, code: 'platform_api_error',
        userMessage: 'refresh_token=TOP_SECRET', bodySnippet: 'Authorization: TOP_SECRET', nextAction: 'TOP_SECRET',
      }));
      assert.equal(outcome.outcome, 'unknown');
      assert.ok(!JSON.stringify(outcome).includes('TOP_SECRET'));
    }
    console.log('ok - ambiguous status and secret-bearing error payloads cannot become retry evidence or receipts');
  } finally {
    restore(); globalThis.fetch = originalFetch; Object.assign(config, original);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

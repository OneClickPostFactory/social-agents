import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { __test__ } from '../src/supabase-worker';

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

async function assertBlocked(
  url: string,
  code: string,
  options: Parameters<typeof __test__.fetchSafeRssText>[2] = {}
): Promise<void> {
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls++;
    return new Response('<rss />', {
      status: 200,
      headers: { 'content-type': 'application/rss+xml' },
    });
  }) as typeof fetch;

  await assert.rejects(
    __test__.fetchSafeRssText(url, 'generic_rss', { fetchImpl, ...options }),
    (error: any) => {
      assert.equal(error.code, code);
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
}

function rssResponse(body: string, contentType = 'application/rss+xml'): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

type TestSource = Parameters<typeof __test__.sourceIntentFor>[0];
type TestPost = Parameters<typeof __test__.sourceIntentRejectReasons>[0];

function source(overrides: Partial<TestSource>): TestSource {
  return {
    id: 'source-1',
    user_id: 'user-1',
    kind: 'rss',
    value: 'https://reddit.com/user/Advanced_Pudding9228/.rss',
    enabled: true,
    provider: 'reddit',
    acquisition_mode: 'rss',
    source_scope: 'reddit_user',
    target_author: 'advanced_pudding9228',
    allowed_subreddits: null,
    allow_unfiltered_rss: false,
    ...overrides,
  };
}

function post(overrides: Partial<TestPost>): TestPost {
  return {
    id: 'post-1',
    title: 'Useful post',
    selftext: 'Source body',
    url: 'https://www.reddit.com/r/indiehackers/comments/post1/useful_post',
    score: 0,
    comments: 0,
    subreddit: 'indiehackers',
    author: 'advanced_pudding9228',
    created: Date.now() / 1000,
    ...overrides,
  };
}

async function main(): Promise<void> {
  await test('non-HTTPS and localhost source URLs are blocked before fetch', async () => {
    await assertBlocked('http://localhost/feed.xml', 'source_url_invalid_scheme');
    await assertBlocked('file:///etc/passwd', 'source_url_invalid_scheme');
    await assertBlocked('data:text/plain,test', 'source_url_invalid_scheme');
  });

  await test('loopback, metadata, and private IPv4 source URLs are blocked before fetch', async () => {
    for (const url of [
      'https://127.0.0.1/feed.xml',
      'https://0.0.0.0/feed.xml',
      'https://10.0.0.1/feed.xml',
      'https://172.16.0.1/feed.xml',
      'https://172.31.255.255/feed.xml',
      'https://192.168.0.1/feed.xml',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      await assertBlocked(url, 'source_url_private_network_blocked');
    }
  });

  await test('credentialed and invalid host source URLs are blocked before fetch', async () => {
    await assertBlocked('https://user:pass@feeds.real-domain.com/feed.xml', 'source_url_credentials_not_allowed');
    await assertBlocked('https://not_a_valid_host.com/feed.xml', 'source_url_invalid_host');
    await assertBlocked('https://printer.local/feed.xml', 'source_url_private_network_blocked');
    await assertBlocked('https://intranet/feed.xml', 'source_url_invalid_host');
  });

  await test('too many redirects are blocked with a stable code', async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      return new Response('', {
        status: 302,
        headers: { location: 'https://feeds.real-domain.com/next.xml' },
      });
    }) as typeof fetch;

    await assert.rejects(
      __test__.fetchSafeRssText('https://feeds.real-domain.com/feed.xml', 'generic_rss', {
        fetchImpl,
        maxRedirects: 2,
      }),
      (error: any) => {
        assert.equal(error.code, 'source_url_too_many_redirects');
        return true;
      }
    );
    assert.equal(fetchCalls, 3);
  });

  await test('redirects to private networks or downgraded protocols are blocked', async () => {
    const privateRedirect = (async () => new Response('', {
      status: 302,
      headers: { location: 'https://127.0.0.1/feed.xml' },
    })) as typeof fetch;
    await assert.rejects(
      __test__.fetchSafeRssText('https://feeds.real-domain.com/feed.xml', 'generic_rss', {
        fetchImpl: privateRedirect,
      }),
      (error: any) => {
        assert.equal(error.code, 'source_url_redirect_blocked');
        assert.equal(error.context.blocked_code, 'source_url_private_network_blocked');
        return true;
      }
    );

    const downgradedRedirect = (async () => new Response('', {
      status: 302,
      headers: { location: 'http://feeds.real-domain.com/feed.xml' },
    })) as typeof fetch;
    await assert.rejects(
      __test__.fetchSafeRssText('https://feeds.real-domain.com/feed.xml', 'generic_rss', {
        fetchImpl: downgradedRedirect,
      }),
      (error: any) => {
        assert.equal(error.code, 'source_url_redirect_blocked');
        assert.equal(error.context.blocked_code, 'source_url_invalid_scheme');
        return true;
      }
    );
  });

  await test('unsupported content types are rejected before reading the body', async () => {
    const fetchImpl = (async () => rssResponse('<html></html>', 'text/html')) as typeof fetch;
    await assert.rejects(
      __test__.fetchSafeRssText('https://feeds.real-domain.com/feed.xml', 'generic_rss', { fetchImpl }),
      (error: any) => {
        assert.equal(error.code, 'source_content_type_unsupported');
        return true;
      }
    );
  });

  await test('oversized RSS responses are capped', async () => {
    const fetchImpl = (async () => rssResponse('<rss>' + 'x'.repeat(64) + '</rss>')) as typeof fetch;
    await assert.rejects(
      __test__.fetchSafeRssText('https://feeds.real-domain.com/feed.xml', 'generic_rss', {
        fetchImpl,
        maxBytes: 16,
      }),
      (error: any) => {
        assert.equal(error.code, 'source_response_too_large');
        return true;
      }
    );
  });

  await test('fetch aborts are reported as source_fetch_timeout', async () => {
    const fetchImpl = (async () => {
      const error = new Error('operation aborted');
      error.name = 'AbortError';
      throw error;
    }) as typeof fetch;
    await assert.rejects(
      __test__.fetchSafeRssText('https://feeds.real-domain.com/feed.xml', 'generic_rss', { fetchImpl }),
      (error: any) => {
        assert.equal(error.code, 'source_fetch_timeout');
        return true;
      }
    );
  });

  await test('valid HTTPS RSS is allowed', async () => {
    const feed = `
      <rss><channel><item>
        <title>Useful source</title>
        <link>https://www.reddit.com/r/builders/comments/abc/example</link>
        <description>Source text</description>
      </item></channel></rss>
    `;
    const fetchImpl = (async () => rssResponse(feed, 'application/rss+xml; charset=utf-8')) as typeof fetch;
    const result = await __test__.fetchSafeRssText('https://feeds.real-domain.com/feed.xml', 'generic_rss', {
      fetchImpl,
    });
    assert.match(result.text, /Useful source/);
    assert.equal(result.status, 200);
    assert.equal(result.redirects, 0);
  });

  await test('Reddit author RSS accepts casing differences and source URL author fallback', () => {
    const parsed = __test__.parseRss(`
      <rss><channel><item>
        <title>Author feed item</title>
        <link>https://www.reddit.com/r/indiehackers/comments/abc/example</link>
        <description>Source text</description>
      </item></channel></rss>
    `, 'https://reddit.com/user/Advanced_Pudding9228/.rss');
    assert.equal(parsed[0].author, 'advanced_pudding9228');

    const intent = __test__.sourceIntentFor(source({ target_author: 'Advanced_PUDDING9228' }), '', []);
    assert.deepEqual(
      __test__.sourceIntentRejectReasons(post({ author: parsed[0].author }), intent),
      []
    );
  });

  await test('Reddit author RSS tolerates display-style RSS author metadata', () => {
    const intent = __test__.sourceIntentFor(source({}), '', []);
    assert.deepEqual(
      __test__.sourceIntentRejectReasons(post({ author: 'Advanced Pudding' }), intent),
      []
    );
  });

  await test('Reddit author RSS does not inherit tenant-level subreddit filters', () => {
    const intent = __test__.sourceIntentFor(source({ allowed_subreddits: null }), '', ['openclawbot']);
    assert.deepEqual(intent.allowedSubreddits, []);
    assert.deepEqual(
      __test__.sourceIntentRejectReasons(post({ subreddit: 'indiehackers' }), intent),
      []
    );
  });

  await test('Reddit author RSS applies explicit source-level subreddit filters', () => {
    const intent = __test__.sourceIntentFor(source({ allowed_subreddits: ['openclawbot'] }), '', ['indiehackers']);
    assert.deepEqual(intent.allowedSubreddits, ['openclawbot']);
    assert.deepEqual(
      __test__.sourceIntentRejectReasons(post({ subreddit: 'indiehackers' }), intent),
      ['rejected_subreddit_mismatch']
    );
  });

  await test('subreddit RSS still rejects wrong subreddit', () => {
    const intent = __test__.sourceIntentFor(source({
      value: 'https://reddit.com/r/openclawbot/.rss',
      source_scope: 'subreddit',
      target_author: null,
      allowed_subreddits: ['openclawbot'],
    }), '', []);
    assert.deepEqual(
      __test__.sourceIntentRejectReasons(post({ subreddit: 'indiehackers' }), intent),
      ['rejected_subreddit_mismatch']
    );
  });

  await test('discovery RSS accepts without author or subreddit constraints when enabled', () => {
    const intent = __test__.sourceIntentFor(source({
      provider: 'generic_rss',
      source_scope: 'generic_rss',
      target_author: null,
      allow_unfiltered_rss: true,
    }), 'advanced_pudding9228', ['openclawbot']);
    assert.deepEqual(
      __test__.sourceIntentRejectReasons(post({ author: 'someone_else', subreddit: 'anywhere' }), intent),
      []
    );
  });

  await test('true author mismatch and true subreddit mismatch still reject', () => {
    const authorIntent = __test__.sourceIntentFor(source({}), '', []);
    assert.deepEqual(
      __test__.sourceIntentRejectReasons(post({ author: 'someone_else' }), authorIntent),
      ['rejected_author_mismatch']
    );

    const subredditIntent = __test__.sourceIntentFor(source({
      source_scope: 'subreddit',
      target_author: null,
      allowed_subreddits: ['openclawbot'],
    }), '', []);
    assert.deepEqual(
      __test__.sourceIntentRejectReasons(post({ subreddit: 'elsewhere' }), subredditIntent),
      ['rejected_subreddit_mismatch']
    );
  });

  await test('Reddit source scope selection is unchanged', () => {
    assert.equal(__test__.sourceScopeFor({
      id: 'source-1',
      user_id: 'user-1',
      kind: 'subreddit',
      value: 'builders',
      enabled: true,
    }), 'subreddit');
    assert.equal(__test__.sourceScopeFor({
      id: 'source-2',
      user_id: 'user-1',
      kind: 'reddit_user',
      value: 'founder',
      enabled: true,
    }), 'reddit_user');
  });

  await test('blocked source URL handling has no OpenAI or source-record side effects', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'supabase-worker.ts'), 'utf8');
    const helperBody = source.match(/async function fetchSafeRssText[\s\S]*?\n}\n\nfunction hasDateInFuture/)?.[0] || '';
    assert.doesNotMatch(helperBody, /extractSourceBank|draftPlatforms|openAI/i);
    assert.doesNotMatch(helperBody, /supabaseInsert\('source_records'/);
  });

  await test('public JSON 403 guidance presents RSS as recommended and OAuth as optional', () => {
    const worker = fs.readFileSync(path.join(process.cwd(), 'src', 'supabase-worker.ts'), 'utf8');
    assert.match(worker, /RSS sources are still supported and are the recommended path/);
    assert.match(worker, /Reddit OAuth is optional only if you want API-backed Reddit access later/);
    assert.doesNotMatch(worker, /Configure Reddit OAuth, use an author RSS feed/);
  });

  await test('filtered RSS messaging is distinct from OpenAI quota errors', () => {
    const worker = fs.readFileSync(path.join(process.cwd(), 'src', 'supabase-worker.ts'), 'utf8');
    assert.match(worker, /RSS fetched successfully, but no items matched the source filters/);
    assert.doesNotMatch(worker, /RSS fetched successfully[\s\S]{0,160}OpenAI/i);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

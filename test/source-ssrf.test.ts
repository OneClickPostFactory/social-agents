import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { redditConnectorTest } from '../src/reddit-connector';
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
  await test('direct Reddit public JSON and RSS fetch implementations are removed', () => {
    const worker = fs.readFileSync(path.join(process.cwd(), 'src', 'supabase-worker.ts'), 'utf8');
    const legacyAdapterPath = path.join(process.cwd(), 'src', 'legacy', 'reddit-public-json.ts');
    const testApi = __test__ as Record<string, unknown>;

    assert.equal(fs.existsSync(legacyAdapterPath), false);
    assert.equal(typeof testApi.fetchSafeRssText, 'undefined');
    assert.equal(typeof testApi.parseRss, 'undefined');
    assert.equal(typeof testApi.canonicalizeRedditRssUrl, 'undefined');
    assert.equal(typeof testApi.validateRssSourceUrl, 'undefined');
    assert.doesNotMatch(worker, /fetchSafeRssText|parseRss|SourceFetchAdapter|REDDIT_RSS_USER_AGENT|RSS_ACCEPT_HEADER/);
    assert.doesNotMatch(worker, /fetchRedditPublicJson|readRedditPublicJsonListing|fetchTenantSourcePosts/);
    assert.doesNotMatch(worker, /oauth\.reddit\.com|api\/v1\/access_token|getRedditAccessToken/);
    assert.match(worker, /reddit_source_ingestion_unavailable/);
    assert.match(worker, /No server-side Reddit fetch was attempted/);
    assert.match(worker, /directRedditFetchAttempted:\s*false/);
  });

  await test('manual and authenticated browser source records require stored source text for processing', () => {
    const worker = fs.readFileSync(path.join(process.cwd(), 'src', 'supabase-worker.ts'), 'utf8');
    const sourceRecordBody = worker.match(/async function processBankedSourceRecords[\s\S]*?\n}\n\nasync function hasActiveBankedAngles/)?.[0] || '';
    assert.match(worker, /const PROCESSABLE_SOURCE_RECORD_ORIGINS = \[\s*'manual',\s*'authenticated_browser',\s*\] as const/);
    assert.match(sourceRecordBody, /operator: 'in', value: \[\.\.\.PROCESSABLE_SOURCE_RECORD_ORIGINS\]/);
    assert.match(sourceRecordBody, /source_text/);
    assert.match(sourceRecordBody, /isProcessableSourceRecordForAngleExtraction\(record, sourceUrlsWithAngles\)/);
    assert.match(sourceRecordBody, /extractSourceBankWithJobTimeout/);
    assert.match(sourceRecordBody, /queueFromBankedAngles/);
    assert.match(sourceRecordBody, /source_record_selected_for_angle_extraction/);
    assert.doesNotMatch(sourceRecordBody, /readRedditPublicJsonListing|fetchRedditPublicJson|reddit_rss|reddit_oauth|devvit/i);
  });

  await test('source record eligibility admits manual and authenticated browser origins only', () => {
    const baseRecord = {
      origin: 'manual',
      status: 'banked',
      used: false,
      source_text: 'Visible body text.',
      url: 'https://www.reddit.com/r/openclawbot/comments/abc/example/',
    };
    const sourceUrlsWithAngles = new Set<string>();

    assert.equal(__test__.isProcessableSourceRecordForAngleExtraction(baseRecord, sourceUrlsWithAngles), true);
    assert.equal(__test__.isProcessableSourceRecordForAngleExtraction({
      ...baseRecord,
      origin: 'authenticated_browser',
    }, sourceUrlsWithAngles), true);
    for (const origin of ['public_json', 'rss', 'oauth', 'devvit']) {
      assert.equal(__test__.isProcessableSourceRecordForAngleExtraction({
        ...baseRecord,
        origin,
      }, sourceUrlsWithAngles), false);
    }
    assert.equal(__test__.isProcessableSourceRecordForAngleExtraction({
      ...baseRecord,
      source_text: '',
    }, sourceUrlsWithAngles), false);
    assert.equal(__test__.isProcessableSourceRecordForAngleExtraction({
      ...baseRecord,
      used: true,
    }, sourceUrlsWithAngles), false);
    assert.equal(__test__.isProcessableSourceRecordForAngleExtraction({
      ...baseRecord,
      status: 'exhausted',
    }, sourceUrlsWithAngles), false);
    assert.equal(__test__.isProcessableSourceRecordForAngleExtraction(
      baseRecord,
      new Set([baseRecord.url])
    ), false);
  });

  await test('source intent compatibility keeps old rows fail-closed without fetching', () => {
    assert.equal(__test__.isUnsupportedRedditRssSource(source({})), true);
    assert.equal(__test__.isUnsupportedRedditRssSource(source({
      kind: 'reddit_user',
      value: 'advanced_pudding9228',
      acquisition_mode: 'public_json',
      source_scope: 'reddit_user',
    })), false);
    assert.equal(__test__.isUnsupportedRedditRssSource(source({
      provider: 'generic_rss',
      source_scope: 'generic_rss',
    })), false);

    const subredditIntent = __test__.sourceIntentFor(source({
      source_scope: 'subreddit',
      target_author: null,
      allowed_subreddits: ['openclawbot'],
    }), '', []);
    assert.deepEqual(
      __test__.sourceIntentRejectReasons(post({ subreddit: 'elsewhere' }), subredditIntent),
      ['rejected_subreddit_mismatch']
    );

    const authorIntent = __test__.sourceIntentFor(source({}), '', []);
    assert.deepEqual(
      __test__.sourceIntentRejectReasons(post({ author: 'someone_else' }), authorIntent),
      ['rejected_author_mismatch']
    );
  });

  await test('source collection summary keeps obsolete paths inactive', () => {
    const worker = fs.readFileSync(path.join(process.cwd(), 'src', 'supabase-worker.ts'), 'utf8');
    assert.match(worker, /reddit_source_ingestion_unavailable/);
    assert.match(worker, /public JSON, RSS, OAuth, Browser Run, and Devvit stayed inactive/);
    assert.match(worker, /Add valid source_records through an approved ingestion path/);
    assert.match(worker, /reddit_rss_source_unsupported/);
    assert.match(worker, /approved ingestion path/);
    assert.doesNotMatch(worker, /use RSS only as a best-effort source/);
    assert.doesNotMatch(worker, /Configure Reddit OAuth/);
    assert.doesNotMatch(worker, /Reddit OAuth is optional/);
    assert.doesNotMatch(worker, /Check Reddit API credentials/);
  });

  await test('connector ingestion remains source-record-only before downstream processing', () => {
    const ingest = fs.readFileSync(path.join(process.cwd(), 'src', 'browser-collector-ingest.ts'), 'utf8');
    assert.match(ingest, /source_records/);
    assert.match(ingest, /authenticated_browser/);
    assert.match(ingest, /COLLECTOR_INGEST_WRITE_ENABLED/);
    assert.match(ingest, /production_collector_write_blocked/);
    assert.match(ingest, /'openai'/);
    assert.match(ingest, /'queue_items'/);
    assert.doesNotMatch(ingest, /from '\.\/ai'|extractSourceBank|draftPlatforms/);
    assert.doesNotMatch(ingest, /supabaseInsert<[^>]*>\('angle_records'|supabaseInsert<[^>]*>\('queue_items'|supabaseInsert<[^>]*>\('publish_history'/);
    assert.doesNotMatch(ingest, /oauth\.reddit\.com|fetchRedditPublicJson|fetchSafeRssText|Devvit/i);
  });

  await test('connector source contract returns all enabled subreddits with required author filter', () => {
    const connector = fs.readFileSync(path.join(process.cwd(), 'src', 'reddit-connector.ts'), 'utf8');
    assert.match(connector, /author_filter/);
    assert.match(connector, /subreddit_sources/);
    assert.match(connector, /reddit_author_filter_required/);
    assert.match(connector, /source_scope', operator: 'eq', value: 'subreddit'/);
    assert.match(connector, /kind !== 'reddit_user' && row\.source_scope !== 'reddit_user'/);
    assert.match(connector, /target_author/);
    assert.match(connector, /limit: 50/);
    assert.doesNotMatch(connector, /openclawbot|lovablebuildershub|five_cards_dev/);
  });

  await test('connector source contract exposes only normalized known ids for enabled subreddits', () => {
    assert.equal(redditConnectorTest.normalizeRedditPostId('ABC123'), 't3_abc123');
    assert.equal(redditConnectorTest.normalizeRedditPostId('t3_ABC123'), 't3_abc123');
    assert.equal(redditConnectorTest.normalizeRedditPostId('unsafe/id'), '');
    assert.deepEqual(redditConnectorTest.knownRedditPostIds([
      { reddit_post_id: 'ABC123', subreddit: 'OpenClawBot' },
      { reddit_post_id: 't3_abc123', subreddit: 'openclawbot' },
      { reddit_post_id: 'other1', subreddit: 'not-enabled' },
      { reddit_post_id: null, subreddit: 'openclawbot' },
    ], new Set(['openclawbot'])), ['t3_abc123']);

    const connector = fs.readFileSync(path.join(process.cwd(), 'src', 'reddit-connector.ts'), 'utf8');
    assert.match(connector, /existing_reddit_post_ids/);
    assert.match(connector, /column: 'user_id', operator: 'eq', value: userId/);
    assert.match(connector, /column: 'origin', operator: 'eq', value: 'authenticated_browser'/);
  });

  await test('internal owner override grants non-expiring billing exemption only when active', () => {
    assert.equal(__test__.isActiveInternalOwnerOverride({
      access_level: 'internal_owner',
      billing_exempt: true,
      collector_entitled: true,
      status: 'active',
      expires_at: null,
    }), true);

    assert.equal(__test__.isActiveInternalOwnerOverride({
      access_level: 'internal_owner',
      billing_exempt: false,
      collector_entitled: true,
      status: 'active',
      expires_at: null,
    }), false);

    assert.equal(__test__.isActiveInternalOwnerOverride({
      access_level: 'internal_owner',
      billing_exempt: true,
      collector_entitled: true,
      status: 'revoked',
      expires_at: null,
    }), false);
  });

  await test('internal owner provisioning script does not commit owner PII', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'provision-internal-owner-access.mjs'), 'utf8');
    assert.match(script, /PERMANENT_OWNER_ACCOUNT_EMAIL/);
    assert.match(script, /internal_access_overrides/);
    assert.match(script, /access_level: "internal_owner"/);
    assert.doesNotMatch(script, /gracehaastrup@icloud\.com/i);
    assert.doesNotMatch(script, /console\.(log|error)\([^)]*ownerEmail/);
  });

  await test('filtered source messaging is distinct from OpenAI quota errors', () => {
    const worker = fs.readFileSync(path.join(process.cwd(), 'src', 'supabase-worker.ts'), 'utf8');
    assert.match(worker, /Source fetched successfully, but no items matched the source filters/);
    assert.doesNotMatch(worker, /Source fetched successfully[\s\S]{0,160}OpenAI/i);
    assert.doesNotMatch(worker, /switch the source to discovery mode/);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

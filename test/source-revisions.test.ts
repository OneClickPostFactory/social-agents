import assert from 'node:assert/strict';
import config from '../config';
import { __test__ as worker } from '../src/supabase-worker';
import {
  REQUIRED_WORKER_CLAIM_CAPABILITIES, assertWorkerClaimsContract,
  claimSourceRecordById, claimSourceRecordForExtraction, commitSourceAngleExtraction,
} from '../src/worker-claims';

const user = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const revisionA = '33333333-3333-4333-8333-333333333333';
const revisionB = '44444444-4444-4444-8444-444444444444';
const token = '55555555-5555-4555-8555-555555555555';
const source = {
  id: sourceId, user_id: user, url: 'https://source.invalid/one-article',
  title: 'A synthetic source', origin: 'manual', used: false, status: 'banked',
  source_text: 'The edited version has a new independently documented lesson.',
  current_revision_id: revisionB, score: 0, reddit_post_id: 'synthetic',
  subreddit: 'manual', reddit_author: 'fixture',
  fetched_at: '2026-11-01T00:00:00Z', created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-03T00:00:00Z',
};
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  console.log('ok - ' + name);
}
const originalFetch = globalThis.fetch;
const original = {
  url: config.SUPABASE_URL, role: config.SUPABASE_SERVICE_ROLE_KEY,
  encryption: config.CREDENTIAL_ENCRYPTION_KEY, openai: config.OPENAI_API_KEY,
};
config.SUPABASE_URL = 'https://database.invalid';
config.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-key';
config.CREDENTIAL_ENCRYPTION_KEY = 'fixture-encryption-key';
config.OPENAI_API_KEY = 'fixture-no-live-key';

async function main() {
  await test('the revision capability is required before worker claims are enabled', async () => {
    globalThis.fetch = async () => Response.json({
      contract: 'worker-claims-v1', migration: 'fixture',
      capabilities: REQUIRED_WORKER_CLAIM_CAPABILITIES.filter(value => value !== 'source-revisions-v1'),
    });
    await assert.rejects(assertWorkerClaimsContract(), /source-revisions-v1/);
  });

  await test('source claims reject missing revision, foreign owner and mismatched fencing identity', async () => {
    const valid = { ...source, claim_token: token, claim_version: 2, claim_expires_at: '2026-11-03T12:00:00Z' };
    for (const patch of [
      { current_revision_id: null }, { current_revision_id: '' },
      { user_id: 'other-tenant' }, { claim_token: 'other-claim' },
      { id: 'other-source' },
    ]) {
      globalThis.fetch = async () => Response.json([{ ...valid, ...patch }]);
      await assert.rejects(claimSourceRecordById(user, sourceId, token), /immutable revision or scope/);
    }
    globalThis.fetch = async () => Response.json([{ ...valid, current_revision_id: undefined }]);
    await assert.rejects(claimSourceRecordForExtraction(user, token), /immutable revision or scope/);
    let called = false;
    globalThis.fetch = async () => { called = true; throw Error('must not send'); };
    await assert.rejects(commitSourceAngleExtraction(user, {
      id: sourceId, claim_token: token, claim_version: 2, current_revision_id: '',
    }, []), /claimed immutable revision/);
    assert.equal(called, false);
  });

  await test('candidate and scheduler reads use tenant-scoped current-revision views before limits', async () => {
    const requests: URL[] = [];
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      requests.push(url);
      assert.equal(url.origin, config.SUPABASE_URL);
      assert.equal(url.searchParams.get('user_id'), 'eq.' + user);
      if (url.pathname.endsWith('/processable_source_records')) return Response.json([source]);
      if (url.pathname.endsWith('/current_source_angle_records')) return Response.json([{
        id: 'angle-current', source_record_id: sourceId, source_revision_id: revisionB,
        intended_platform: 'x', status: 'unused', source_reddit_post_id: 'synthetic',
        source_url: source.url, subreddit: 'manual', reddit_author: 'fixture',
      }]);
      throw Error('Unexpected historical table read: ' + url.pathname);
    };
    assert.equal((await worker.loadProcessableSourceRecords(user)).length, 1);
    assert.equal(await worker.hasProcessableSourceRecord(user), true);
    assert.equal(await worker.hasActiveBankedAngles(user), true);
    assert.equal(await worker.hasDraftableActiveAngle(user, ['x']), true);
    assert.equal(requests[0].searchParams.get('limit'), '10');
    assert.equal(requests[1].searchParams.get('limit'), '1');
    assert.ok(requests[0].searchParams.get('select')?.includes('current_revision_id'));
  });

  for (const loseCommitReply of [false, true]) await test(loseCommitReply
    ? 'a lost commit reply recovers exact counts without duplicate model work or created metrics'
    : 'an edited URL reaches extraction once; exact replay and reversion use completed snapshots', async () => {
    // The database owns revision eligibility. Exercise the real worker against
    // that contract while all model/HTTP traffic is intercepted locally.
    const oldAngle = { id: 'historical-angle', source_record_id: sourceId,
      source_revision_id: revisionA, angle: 'Original immutable angle', status: 'published' };
    const oldQueue = { id: 'historical-queue', angle_record_id: oldAngle.id,
      draft_text: 'Original approved text', status: 'published', external_post_id: '123' };
    const preserved = JSON.stringify({ oldAngle, oldQueue });
    const completed = new Set([revisionA]);
    let current = revisionB;
    let modelCalls = 0;
    let commitCalls = 0;
    let firstCommitRequest: string | undefined;
    let claimed: any;
    const pendingSource = () => ({ ...source, current_revision_id: current,
      source_text: current === revisionA ? 'Original source content.' : source.source_text });
    const observed: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body || '{}'));
      observed.push(url.pathname);
      if (url.origin === 'https://api.openai.com') {
        assert.equal(url.pathname, '/v1/chat/completions');
        modelCalls++;
        assert.ok(String(body.messages[1].content).includes(source.source_text));
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          summary: { topic: 'Changed source', core_claim: 'Distinct current lesson' },
          angles: [{ label: 'Current revision', thesis: 'Use the edited source snapshot', strength: 4 }],
        }) } }] });
      }
      assert.equal(url.origin, config.SUPABASE_URL);
      if (url.pathname.endsWith('/profiles')) return Response.json([{ subscription_status: 'active' }]);
      if (url.pathname.endsWith('/internal_access_overrides')) return Response.json([]);
      if (url.pathname.endsWith('/processable_source_records')) {
        assert.equal(url.searchParams.get('user_id'), 'eq.' + user);
        return Response.json(completed.has(current) ? [] : [pendingSource()]);
      }
      if (url.pathname.endsWith('/current_source_angle_records')) {
        assert.equal(url.searchParams.get('user_id'), 'eq.' + user);
        return Response.json([]);
      }
      if (url.pathname.endsWith('/worker_logs')) {
        assert.equal(init?.method, 'POST');
        assert.equal(body.user_id, user);
        return new Response(null, { status: 201 });
      }
      if (url.pathname.endsWith('/rpc/claim_source_record_by_id')) {
        assert.equal(body.p_user_id, user);
        assert.equal(body.p_source_record_id, sourceId);
        if (completed.has(current)) return Response.json([]);
        claimed = { ...pendingSource(), claim_token: body.p_claim_token,
          claim_version: 9, claim_expires_at: new Date(Date.now() + 60_000).toISOString() };
        return Response.json([claimed]);
      }
      if (url.pathname.endsWith('/rpc/commit_source_angle_extraction')) {
        commitCalls++;
        if (firstCommitRequest) assert.equal(JSON.stringify(body), firstCommitRequest);
        else firstCommitRequest = JSON.stringify(body);
        assert.equal(body.p_user_id, user);
        assert.equal(body.p_source_record_id, sourceId);
        assert.equal(body.p_claim_token, claimed.claim_token);
        assert.equal(body.p_claim_version, claimed.claim_version);
        assert.equal(claimed.current_revision_id, revisionB);
        assert.equal(body.p_angles.length, 1);
        assert.equal(body.p_angles[0].intended_platform, 'x');
        completed.add(current);
        if (loseCommitReply && commitCalls === 1) throw new TypeError('Simulated lost committed response');
        return Response.json([{ inserted_count: loseCommitReply ? 0 : 1, total_count: 1 }]);
      }
      throw Error('Unexpected request, including any historical row mutation: ' + url.pathname);
    };
    const job: any = { id: 'job-fixture', user_id: user, kind: 'refresh_queue', payload: {} };
    const tenant: any = { userId: user, settings: {}, credentials: {}, activePlatforms: ['x'] };
    const occupied = new Set<string>();
    let lastSummary: Awaited<ReturnType<typeof worker.createPipelineSummary>> | undefined;
    async function run() {
      const summary = await worker.createPipelineSummary(job, tenant, [], occupied, []);
      lastSummary = summary;
      return worker.processBankedSourceRecords(job, tenant, occupied, 'Europe/London', summary, []);
    }
    assert.equal(await worker.hasProcessableSourceRecord(user), true);
    assert.deepEqual(await run(), { banked: 1, queued: 0 });
    assert.equal(lastSummary?.angles.created, loseCommitReply ? 0 : 1);
    assert.equal(lastSummary?.angles.alreadyExisting, loseCommitReply ? 1 : 0);
    assert.equal(modelCalls, 1);
    assert.equal(commitCalls, loseCommitReply ? 2 : 1);
    assert.equal(await worker.hasProcessableSourceRecord(user), false);
    assert.deepEqual(await run(), { banked: 0, queued: 0 });
    current = revisionA;
    assert.equal(await worker.hasProcessableSourceRecord(user), false);
    assert.deepEqual(await run(), { banked: 0, queued: 0 });
    assert.equal(modelCalls, 1);
    assert.equal(commitCalls, loseCommitReply ? 2 : 1);
    assert.equal(JSON.stringify({ oldAngle, oldQueue }), preserved);
    assert.ok(!observed.some(path => path === '/rest/v1/angle_records' || path === '/rest/v1/queue_items'));
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  globalThis.fetch = originalFetch;
  config.SUPABASE_URL = original.url;
  config.SUPABASE_SERVICE_ROLE_KEY = original.role;
  config.CREDENTIAL_ENCRYPTION_KEY = original.encryption;
  config.OPENAI_API_KEY = original.openai;
});

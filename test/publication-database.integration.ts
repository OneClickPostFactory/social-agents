import assert from 'node:assert/strict';
import { exercisePublicationLockOrder } from './publication-lock-order.integration';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import config from '../config';
import { encryptCredential } from '../src/tenant-credentials';
import { installScopedConfig, runWithRuntimeScope } from '../src/runtime-scope';
import { __test__ as worker } from '../src/supabase-worker';
import { reconcilePublication, recoverStalePublications } from '../src/publication-executor';
import { loadPublicationStateForQueueItem, claimPublicationIntent, beginPublicationDispatch } from '../src/publication-ledger';

// Real local database and Worker; social transport is intercepted. No live-provider
// authorisation or visibility claim is made by this suite.
if (process.env.PUBLICATION_DATABASE_TEST !== 'local-only') throw new Error('Local database test opt-in required');
const local = JSON.parse(execFileSync('supabase', ['status', '--output', 'json'], {
  cwd: '.schema-contract', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}));
const api = new URL(local.API_URL);
if (!['127.0.0.1', 'localhost'].includes(api.hostname) || api.protocol !== 'http:') throw new Error('Refusing non-local Supabase');
const names = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n').filter(name => /^supabase_db_[a-zA-Z0-9_-]+$/.test(name));
assert.equal(names.length, 1, 'exactly one ephemeral local database');
function sql(statement: string): string {
  return execFileSync('docker', ['exec', '-i', names[0], 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], {
    input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
Object.assign(config, {
  SUPABASE_URL: api.origin, SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
  CREDENTIAL_ENCRYPTION_KEY: 'ephemeral-publication-test-only', HTTP_TIMEOUT_MS: 5000,
});
installScopedConfig(config);

interface Fixture {
  user: string;
  row: { id: string; user_id: string; platform: 'x' | 'linkedin' | 'threads' | 'instagram'; slot_index: number; scheduled_for: string; status: string; draft_text: string };
  token: string;
}
const tokens = new Map<string, string>();
const posts = new Map<string, number>();
const texts = new Map<string, string[]>();
const modes = new Map<string, 'timeout' | 'reject' | 'pause' | 'late'>();
let lostRpc: { path: string; remaining: number } | undefined;
let totalWrites = 0;
const databaseErrors: Array<{ rpc: string; code: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input));
  if (url.origin === api.origin) {
    const response = await realFetch(input, init);
    if (!response.ok && url.pathname.includes('/rpc/')) {
      const failure = await response.clone().json().catch(() => ({})) as { code?: unknown };
      databaseErrors.push({ rpc: url.pathname.split('/').pop() || 'unknown', code: String(failure.code || 'unknown') });
    }
    if (lostRpc && url.pathname.endsWith(lostRpc.path) && lostRpc.remaining > 0 && response.ok) {
      lostRpc.remaining--; await response.text(); throw new TypeError('injected response loss after database commit');
    }
    return response;
  }
  const token = (new Headers(init?.headers).get('authorization') || '').replace(/^Bearer /, '');
  const owner = tokens.get(token);
  assert.ok(owner, 'provider receives only the intended fixture tenant credential');
  if (url.hostname === 'api.x.com' && url.pathname === '/2/users/me') {
    if (modes.get(owner) === 'pause') sql(`UPDATE public.user_settings SET automation_publish_enabled = false WHERE user_id = ${literal(owner)}::uuid;`);
    await new Promise<void>(resolve => setImmediate(resolve));
    return Response.json({ data: { id: `account-${owner}` } });
  }
  if ((url.hostname === 'api.x.com' && url.pathname === '/2/tweets') || (url.hostname === 'api.linkedin.com' && url.pathname === '/rest/posts')) {
    assert.equal(init?.method, 'POST'); totalWrites++;
    const providerId = String(900000 + totalWrites);
    posts.set(owner, (posts.get(owner) || 0) + 1);
    const body = JSON.parse(String(init?.body));
    const text = body.text || body.commentary;
    texts.set(owner, [...(texts.get(owner) || []), text]);
    assert.ok(Number(sql(`SELECT count(*) FROM public.publication_attempts WHERE user_id = ${literal(owner)}::uuid AND state = 'dispatching';`)) > 0);
    if (modes.get(owner) === 'timeout') throw new TypeError('injected lost provider response');
    if (modes.get(owner) === 'reject' || url.hostname === 'api.linkedin.com') return Response.json({ message: 'fixture payload rejection' }, { status: 422 });
    if (modes.get(owner) === 'late') {
      const queueId = sql(`SELECT queue_item_id FROM public.publication_attempts WHERE user_id = ${literal(owner)}::uuid AND state = 'dispatching';`);
      assert.equal((await reconcilePublication({ userId: owner, queueItemId: queueId, platform: 'x' }, Date.now() + 300_000)).outcome, 'unknown');
    }
    return Response.json({ data: { id: providerId } }, { status: 201 });
  }
  throw new Error(`External network forbidden in integration tests: ${url.origin}`);
}) as typeof fetch;

function seed(platform: Fixture['row']['platform'] = 'x', existingUser?: string): Fixture {
  const user = existingUser || randomUUID(), id = randomUUID(), token = `fixture-${user}`;
  tokens.set(token, user);
  const scheduled = new Date(Date.now() - 60_000).toISOString();
  if (!existingUser) {
    sql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (${literal(user)}::uuid, ${literal(`${user}@example.invalid`)}, '{}'::jsonb);
      UPDATE public.profiles SET subscription_status = 'active' WHERE user_id = ${literal(user)}::uuid;
      INSERT INTO public.user_settings (user_id, x_enabled, linkedin_enabled, threads_enabled, instagram_enabled, automation_enabled, automation_publish_enabled)
      VALUES (${literal(user)}::uuid, true, true, true, true, true, true)
      ON CONFLICT (user_id) DO UPDATE SET x_enabled = true, linkedin_enabled = true, threads_enabled = true, instagram_enabled = true, automation_enabled = true, automation_publish_enabled = true;
      INSERT INTO public.user_credentials (user_id, x_oauth2_access_token_enc, linkedin_token_enc, linkedin_person_urn_enc)
      VALUES (${literal(user)}::uuid, ${literal(encryptCredential(token))}, ${literal(encryptCredential(token))}, ${literal(encryptCredential(`urn:li:person:${user}`))})
      ON CONFLICT (user_id) DO UPDATE SET x_oauth2_access_token_enc = EXCLUDED.x_oauth2_access_token_enc, linkedin_token_enc = EXCLUDED.linkedin_token_enc, linkedin_person_urn_enc = EXCLUDED.linkedin_person_urn_enc;`);
  }
  sql(`INSERT INTO public.queue_items (id, user_id, platform, slot_index, scheduled_for, scheduled_local_date, scheduled_timezone, draft_text, source_url, status)
    VALUES (${literal(id)}::uuid, ${literal(user)}::uuid, ${literal(platform)}::public.platform, 0, ${literal(scheduled)}::timestamptz, ${literal(scheduled.slice(0, 10))}::date, 'UTC', ${literal(`authorised-${user}`)}, 'https://example.com/reusable-source', 'ready');`);
  return { user, token, row: { id, user_id: user, platform, slot_index: 0, scheduled_for: scheduled, draft_text: `authorised-${user}`, status: 'ready' } };
}
function job(f: Fixture) {
  return { id: randomUUID(), user_id: f.user, kind: 'publish_now', payload: { source: 'scheduled', queue_item_id: f.row.id }, status: 'running', created_at: new Date().toISOString() };
}
const run = (f: Fixture) => runWithRuntimeScope(() => worker.publishQueueRow(job(f), f.row, {}), { userId: f.user });
const state = (f: Fixture) => loadPublicationStateForQueueItem(f.user, f.row.id);
const target = (f: Fixture) => ({ userId: f.user, queueItemId: f.row.id, platform: f.row.platform });
let scenarios = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn(); scenarios++; console.log(`PASS ${scenarios}: ${name}`);
}

async function main() {
  for (const operation of ['begin', 'release'] as const) {
    await test(`controlled ${operation}/claim contention has no database deadlock`, async () => {
      const f = seed();
      const intent = await claimPublicationIntent(f.user, f.row.id, randomUUID(), 120);
      await exercisePublicationLockOrder({
        databaseName: names[0], sql, userId: f.user, queueId: f.row.id,
        intentId: intent.id, claimToken: intent.claim_token!, claimVersion: intent.claim_version, operation,
      });
      assert.equal(posts.get(f.user) || 0, 0);
    });
  }
  await test('real scheduled Worker records exact immutable acceptance and handles duplicate delivery', async () => {
    const f = seed();
    sql(`UPDATE public.queue_items SET draft_text = 'approved revision before claim' WHERE id = ${literal(f.row.id)}::uuid;`);
    const r = await run(f);
    assert.equal(r.outcome, 'accepted'); assert.ok(r.publishHistoryId);
    assert.deepEqual(texts.get(f.user), ['approved revision before claim']);
    const receipt = await state(f);
    assert.equal(receipt.history?.queue_item_id, f.row.id);
    assert.equal(receipt.history?.publication_attempt_id, receipt.attempt?.id);
    assert.equal(receipt.history?.post_text, 'approved revision before claim');
    assert.equal(receipt.attempt?.provider_account_ref, `account-${f.user}`);
    assert.equal((await run(f)).outcome, 'accepted'); assert.equal(posts.get(f.user), 1);
    assert.throws(() => sql(`UPDATE public.queue_items SET draft_text = 'late edit' WHERE id = ${literal(f.row.id)}::uuid;`));
  });
  await test('concurrent real Postgres claimers have exactly one provider writer', async () => {
    for (let round = 0; round < 20; round++) {
      const f = seed(), errorStart = databaseErrors.length;
      const results = await Promise.all(Array.from({ length: 8 }, () => run(f)));
      const current = await state(f);
      const observed = {
        round,
        writes: posts.get(f.user) || 0,
        outcomes: results.map(r => ({ outcome: r.outcome, failureCode: r.failureCode })),
        intentState: current.intent?.state,
        attemptState: current.attempt?.state,
        databaseErrors: databaseErrors.slice(errorStart),
      };
      assert.equal(posts.get(f.user) || 0, 1, JSON.stringify(observed));
      assert.equal(Number(sql(`SELECT count(*) FROM public.publication_attempts WHERE user_id = ${literal(f.user)}::uuid;`)), 1);
      assert.equal(current.attempt?.state, 'accepted', JSON.stringify(observed));
      assert.equal(databaseErrors.slice(errorStart).some(error => error.code === '40P01'), false, JSON.stringify(observed));
    }
  });
  await test('two tenants interleave with their own encrypted credentials and source snapshots', async () => {
    const a = seed(), b = seed();
    await Promise.all([run(a), run(b)]);
    assert.deepEqual(texts.get(a.user), [`authorised-${a.user}`]);
    assert.deepEqual(texts.get(b.user), [`authorised-${b.user}`]);
    assert.equal((await state(a)).attempt?.provider_account_ref, `account-${a.user}`);
    assert.equal((await state(b)).attempt?.provider_account_ref, `account-${b.user}`);
  });
  await test('Postgres history failure rolls back acceptance and blocks repeat publication', async () => {
    const f = seed();
    sql(`CREATE OR REPLACE FUNCTION public.fixture_fail_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.queue_item_id = ${literal(f.row.id)}::uuid THEN RAISE EXCEPTION 'injected history failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fixture_fail_history BEFORE INSERT ON public.publish_history FOR EACH ROW EXECUTE FUNCTION public.fixture_fail_history();`);
    const r = await run(f);
    assert.equal(r.outcome, 'unknown'); assert.equal(r.providerAccepted, true);
    assert.equal((await state(f)).history, undefined);
    assert.equal((await state(f)).attempt?.state, 'unknown');
    assert.equal(sql(`SELECT status FROM public.queue_items WHERE id = ${literal(f.row.id)}::uuid;`), 'publishing');
    await run(f); assert.equal(posts.get(f.user), 1);
    sql('DROP TRIGGER fixture_fail_history ON public.publish_history; DROP FUNCTION public.fixture_fail_history();');
  });
  await test('lost accepted RPC responses reconcile from the committed receipt', async () => {
    const f = seed(); lostRpc = { path: '/record_publication_accepted', remaining: 3 };
    assert.equal((await run(f)).outcome, 'accepted');
    assert.equal(lostRpc.remaining, 0); lostRpc = undefined;
    assert.equal((await state(f)).attempt?.state, 'accepted'); assert.equal(posts.get(f.user), 1);
  });
  await test('lost begin-dispatch responses create no provider call and preserve unknown', async () => {
    const f = seed(); lostRpc = { path: '/begin_publication_dispatch', remaining: 3 };
    assert.equal((await run(f)).outcome, 'unknown');
    assert.equal(lostRpc.remaining, 0); lostRpc = undefined;
    assert.equal(posts.get(f.user) || 0, 0); assert.equal((await state(f)).attempt?.state, 'unknown');
    await run(f); assert.equal(posts.get(f.user) || 0, 0);
  });
  await test('lost claim response reuses its token and fence', async () => {
    const f = seed(); lostRpc = { path: '/claim_publication_intent', remaining: 1 };
    assert.equal((await run(f)).outcome, 'accepted'); lostRpc = undefined;
    assert.equal((await state(f)).intent?.claim_version, 1); assert.equal(posts.get(f.user), 1);
  });
  await test('provider timeout remains unknown through stale recovery and repeated jobs', async () => {
    const f = seed(); modes.set(f.user, 'timeout');
    assert.equal((await run(f)).outcome, 'unknown');
    assert.equal((await worker.stalePublishJobResult(job(f), [])).outcome, 'unknown');
    await run(f); assert.equal(posts.get(f.user), 1);
    assert.equal(sql(`SELECT status FROM public.queue_items WHERE id = ${literal(f.row.id)}::uuid;`), 'publishing');
  });
  await test('known rejection records failed projection without inventing history', async () => {
    const f = seed(); modes.set(f.user, 'reject');
    assert.equal((await run(f)).outcome, 'rejected');
    assert.equal((await state(f)).attempt?.state, 'rejected'); assert.equal((await state(f)).history, undefined);
    assert.equal(sql(`SELECT status FROM public.queue_items WHERE id = ${literal(f.row.id)}::uuid;`), 'failed');
    await run(f); assert.equal(posts.get(f.user), 1);
  });
  await test('pause after identity verification is rechecked before dispatch', async () => {
    const f = seed(); modes.set(f.user, 'pause');
    assert.equal((await run(f)).failureCode, 'publish_automation_disabled');
    assert.equal((await state(f)).attempt, undefined); assert.equal(posts.get(f.user) || 0, 0);
  });
  await test('disabled Meta causes zero provider, media, claim or revision mutations', async () => {
    for (const platform of ['threads', 'instagram'] as const) {
      const f = seed(platform);
      assert.equal((await run(f)).failureCode, 'legacy_meta_publication_disabled');
      assert.equal((await state(f)).intent, undefined); assert.equal(posts.get(f.user) || 0, 0);
      assert.equal(sql(`SELECT status FROM public.queue_items WHERE id = ${literal(f.row.id)}::uuid;`), 'ready');
    }
  });
  await test('publish_all retains independent platform outcomes', async () => {
    const f = seed(), other = seed('linkedin', f.user);
    const r = await runWithRuntimeScope(() => worker.handlePublishAll({ ...job(f), kind: 'publish_all' }, { userId: f.user, settings: {}, credentials: {}, activePlatforms: ['x', 'linkedin'] }));
    assert.equal(r.jobStatus, 'completed_with_errors');
    assert.equal((r.published as unknown[]).length, 1); assert.equal((r.failures as unknown[]).length, 1);
    assert.equal((await state(f)).attempt?.state, 'accepted'); assert.equal((await state(other)).attempt?.state, 'rejected');
  });
  await test('legacy ambiguous rows stay quarantined without source-URL guesses', async () => {
    const f = seed();
    sql(`UPDATE public.queue_items SET status = 'publishing' WHERE id = ${literal(f.row.id)}::uuid;`);
    assert.equal((await reconcilePublication(target(f))).failureCode, 'legacy_publication_requires_reconciliation');
    assert.equal(sql(`SELECT status FROM public.queue_items WHERE id = ${literal(f.row.id)}::uuid;`), 'publishing');
    assert.equal(posts.get(f.user) || 0, 0);
  });
  await test('late provider acceptance resolves a stale unknown attempt with exact positive evidence', async () => {
    const f = seed(); modes.set(f.user, 'late');
    assert.equal((await run(f)).outcome, 'accepted');
    const s = await state(f);
    assert.equal(s.attempt?.state, 'accepted'); assert.ok(s.attempt?.reconciled_at);
    assert.equal(s.attempt?.reconciliation_evidence?.kind, 'exact_attempt_provider_acceptance_response');
    assert.equal(s.history?.publication_attempt_id, s.attempt?.id);
    assert.equal(s.attempt?.verified_at, null);
    await run(f); assert.equal(posts.get(f.user), 1);
  });
  await test('expired pre-dispatch ownership releases through the real fenced RPC', async () => {
    const f = seed(); await claimPublicationIntent(f.user, f.row.id, randomUUID(), 120);
    assert.equal((await reconcilePublication(target(f), Date.now() + 300_000)).outcome, 'retry_wait');
    assert.equal((await state(f)).intent?.state, 'scheduled');
    assert.equal(sql(`SELECT status FROM public.queue_items WHERE id = ${literal(f.row.id)}::uuid;`), 'ready');
    assert.equal(posts.get(f.user) || 0, 0);
  });
  await test('orphan dispatch is recovered without a parent job or any provider write', async () => {
    const f = seed(); const intent = await claimPublicationIntent(f.user, f.row.id, randomUUID(), 120);
    await beginPublicationDispatch({ userId: f.user, intent, dispatchOperationId: randomUUID(), providerAccountRef: `account-${f.user}`, providerIdempotencySupported: false });
    assert.ok(await recoverStalePublications(Date.now() + 300_000) >= 1);
    assert.equal((await state(f)).attempt?.state, 'unknown');
    assert.equal(posts.get(f.user) || 0, 0);
  });
  console.log(`PUBLICATION_DATABASE_INTEGRATION_PASS scenarios=${scenarios}; real Supabase/Postgres; provider transport intercepted; live_posts=0`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { globalThis.fetch = realFetch; });

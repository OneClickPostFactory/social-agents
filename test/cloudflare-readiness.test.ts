import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { handleReadinessRequest, READINESS_CONTRACTS, type ReadinessEnv } from '../src/cloudflare-readiness';
const SHA = 'a'.repeat(40);
const VERSION = '11111111-1111-4111-8111-111111111111';
const NONCE = 'b'.repeat(32);
const env: ReadinessEnv = {
  NODE_ENV: 'staging', WORKER_TICK_TOKEN: 'test-operator-secret',
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-database-secret', CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-secret',
  CF_VERSION_METADATA: { id: VERSION, tag: SHA, timestamp: '2026-09-29T00:00:00Z' },
};
function request(mode = 'database', headers: Record<string, string> = {}, method = 'GET', signal?: AbortSignal) {
  return new Request('https://worker.example/readyz', { method, signal, headers: {
    Authorization: `Bearer ${env.WORKER_TICK_TOKEN}`, 'X-OCPF-Readiness-Nonce': NONCE,
    'X-OCPF-Expected-Version': VERSION, 'X-OCPF-Expected-Sha': SHA, 'X-OCPF-Readiness-Mode': mode, ...headers,
  } });
}
function fixture(change?: (body: Record<string, unknown>, index: number) => void) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const i = calls.length;
    const req = READINESS_CONTRACTS[i];
    calls.push({ url: String(input), init });
    assert.ok(req, 'a probe must never loop or retry internally');
    const body: Record<string, unknown> = {
      contract: req.contract, capabilities: [...req.capabilities],
      ...(req.contract === 'publication-ledger-v1' ? { migration: '20260907054000', lock_order_migration: '20260913061000' } : {}),
    };
    change?.(body, i);
    return Response.json(body);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
async function check(e: ReadinessEnv = env, r = request(), change?: (body: Record<string, unknown>, index: number) => void) {
  const f = fixture(change);
  const response = await handleReadinessRequest(r, e, f.fetchImpl);
  return { response, body: await response.json() as Record<string, unknown>, calls: f.calls };
}

test('configuration readiness proves exact identity and auth without database work', async () => {
  const { response, body, calls } = await check(env, request('configuration'));
  assert.equal(response.status, 200); assert.equal(body.code, 'configuration_ready');
  assert.equal(body.workerVersionId, VERSION); assert.equal(body.gitSha, SHA); assert.equal(body.nonce, NONCE);
  assert.equal(body.databaseEvaluated, false); assert.equal(body.authorisesExecution, false); assert.equal(calls.length, 0);
  assert.match(response.headers.get('Cache-Control') || '', /no-store/);
});

test('database readiness performs only three fixed metadata RPCs', async () => {
  const { response, body, calls } = await check();
  assert.equal(response.status, 200); assert.equal(body.code, 'database_ready');
  assert.equal(body.databaseEvaluated, true); assert.equal(body.effectFree, true);
  assert.equal(body.authorisesExecution, false); assert.equal(calls.length, 3);
  for (const [i, call] of calls.entries()) {
    assert.equal(call.url, `${env.SUPABASE_URL}/rest/v1/rpc/${READINESS_CONTRACTS[i].rpc}`);
    assert.equal(call.init.method, 'POST'); assert.equal(call.init.body, '{}');
    assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  const text = JSON.stringify(body);
  for (const secret of [env.WORKER_TICK_TOKEN, env.SUPABASE_SERVICE_ROLE_KEY, env.CREDENTIAL_ENCRYPTION_KEY, env.SUPABASE_URL]) assert.ok(!text.includes(secret!));
});

for (const auth of ['', 'Bearer wrong-secret', 'Basic test']) test(`unauthorised request stays opaque: ${auth}`, async () => {
  const f = fixture(); const response = await handleReadinessRequest(request('database', { Authorization: auth }), env, f.fetchImpl);
  assert.equal(response.status, 404); assert.equal(await response.text(), 'Not found'); assert.equal(f.calls.length, 0);
});
for (const method of ['POST', 'PUT', 'DELETE']) test(`readiness rejects ${method}`, async () => {
  const f = fixture(); const response = await handleReadinessRequest(request('database', {}, method), env, f.fetchImpl);
  assert.equal(response.status, 404); assert.equal(f.calls.length, 0);
});
test('absent operator credential denies all probes', async () => {
  const f = fixture(); const response = await handleReadinessRequest(request(), { ...env, WORKER_TICK_TOKEN: '' }, f.fetchImpl);
  assert.equal(response.status, 404); assert.equal(f.calls.length, 0);
});
for (const [header, value] of [
  ['X-OCPF-Readiness-Nonce', ''], ['X-OCPF-Readiness-Nonce', 'z'.repeat(33)],
  ['X-OCPF-Expected-Sha', 'main'], ['X-OCPF-Expected-Version', '../wrong'],
  ['X-OCPF-Readiness-Mode', 'publish'],
]) test(`invalid ${header} is rejected before requests`, async () => {
  const { response, calls } = await check(env, request('database', { [header]: value }));
  assert.equal(response.status, 400); assert.equal(calls.length, 0);
});
for (const metadata of [undefined, { id: VERSION, tag: 'c'.repeat(40), timestamp: '' }, { id: '22222222-2222-4222-8222-222222222222', tag: SHA, timestamp: '' }]) {
  test(`stale or absent version cannot become readiness: ${metadata?.id}`, async () => {
    const { response, body, calls } = await check({ ...env, CF_VERSION_METADATA: metadata });
    assert.equal(response.status, 409); assert.equal(body.code, 'release_identity_mismatch'); assert.equal(calls.length, 0);
  });
}
for (const key of ['SUPABASE_SERVICE_ROLE_KEY', 'CREDENTIAL_ENCRYPTION_KEY']) test(`missing ${key} fails closed`, async () => {
  const { body, calls } = await check({ ...env, [key]: '' });
  assert.equal(body.code, 'runtime_bindings_incomplete'); assert.equal(calls.length, 0);
});
for (const url of ['http://127.0.0.1', 'https://user:pass@abcdefghijklmnopqrst.supabase.co', 'https://abcdefghijklmnopqrst.supabase.co/path', 'https://evil.example', 'https://abcdefghijklmnopqrst.supabase.co?x=1']) {
  test(`unapproved database origin rejected: ${url}`, async () => {
    const { body, calls } = await check({ ...env, SUPABASE_URL: url });
    assert.equal(body.code, 'database_origin_invalid'); assert.equal(calls.length, 0);
  });
}
test('temporary tunnel is permitted only in explicit staging', async () => {
  const url = 'https://temporary-fixture.trycloudflare.com';
  const ok = await check({ ...env, SUPABASE_URL: url }, request('configuration'));
  assert.equal(ok.response.status, 200);
  const no = await check({ ...env, NODE_ENV: 'production', SUPABASE_URL: url });
  assert.equal(no.body.code, 'database_origin_invalid'); assert.equal(no.calls.length, 0);
});
for (const [index, contract] of READINESS_CONTRACTS.entries()) {
  test(`${contract.contract} mismatch fails without leaking its body`, async () => {
    const { response, body } = await check(env, request(), (b, i) => { if (i === index) { b.contract = 'incorrect'; b.secret = 'private-row'; } });
    assert.equal(response.status, 503); assert.equal(body.code, 'database_contract_mismatch'); assert.ok(!JSON.stringify(body).includes('private-row'));
  });
  for (const cap of contract.capabilities) test(`missing capability ${cap} blocks readiness`, async () => {
    const { body } = await check(env, request(), (b, i) => { if (i === index) b.capabilities = contract.capabilities.filter(c => c !== cap); });
    assert.equal(body.code, 'database_contract_mismatch');
  });
}
test('feature-introducing migration is not replaced with the latest migration head', async () => {
  const { body } = await check(env, request(), b => { if (b.contract === 'publication-ledger-v1') b.lock_order_migration = '20260928220000'; });
  assert.equal(body.code, 'database_contract_mismatch');
});
for (const status of [301, 401, 403, 404, 429, 500, 503]) test(`HTTP ${status} is classified without forwarding secrets`, async () => {
  let calls = 0;
  const response = await handleReadinessRequest(request(), env, (async () => { calls++; return new Response('test-database-secret', { status }); }) as typeof fetch);
  const text = await response.text(); assert.equal(response.status, 503); assert.equal(calls, 1); assert.ok(!text.includes('test-database-secret'));
});
for (const text of ['<html>provider error</html>', 'a'.repeat(17000), '{"contract":null}', '[]']) test(`invalid response fails closed (${text.length} bytes)`, async () => {
  const response = await handleReadinessRequest(request(), env, (async () => new Response(text)) as typeof fetch);
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('<html>'));
});
test('network exceptions are redacted and not retried', async () => {
  let calls = 0;
  const response = await handleReadinessRequest(request(), env, (async () => { calls++; throw new Error('credential=secret'); }) as typeof fetch);
  assert.equal(response.status, 503); assert.equal(calls, 1); assert.ok(!(await response.text()).includes('credential='));
});
test('cancelled request cannot touch the database', async () => {
  const controller = new AbortController(); controller.abort();
  const { response, calls } = await check(env, request('database', {}, 'GET', controller.signal));
  assert.equal(response.status, 503); assert.equal(calls.length, 0);
});
test('entrypoint routes readiness before any config/scheduler side effects', () => {
  const src = readFileSync('src/cloudflare-worker.ts', 'utf8');
  assert.match(src, /if \(url\.pathname === '\/readyz'\) \{\s+return handleReadinessRequest\(request, env\);\s+\}/);
  const readiness = readFileSync('src/cloudflare-readiness.ts', 'utf8');
  assert.doesNotMatch(readiness, /from ['"].*(?:supabase-worker|config|tenant-credentials|publish|ai)['"]/);
  assert.doesNotMatch(readiness, /process\.env|runScheduledTick|enqueue_agent_job|claim_agent_job/);
});

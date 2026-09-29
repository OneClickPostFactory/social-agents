import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import worker from '../src/cloudflare-worker';
import { handleWorkerReadiness, READINESS_CONTRACTS, type ReadinessEnv } from '../src/worker-readiness';

const version = '11111111-1111-4111-8111-111111111111';
const nonce = '22222222-2222-4222-8222-222222222222';
const sha = 'a'.repeat(40);
const env: ReadinessEnv = {
  WORKER_TICK_TOKEN: 'tick-secret-not-for-output', SUPABASE_URL: 'https://database.example',
  SUPABASE_SERVICE_ROLE_KEY: 'database-secret-not-for-output', CREDENTIAL_ENCRYPTION_KEY: 'encryption-secret-not-for-output',
  CF_VERSION_METADATA: { id: version, tag: sha, timestamp: '2026-09-29T00:00:00Z' },
  SUPABASE_WORKER_GENERATION_ENABLED: 'false', SUPABASE_PROVIDER_DISPATCH_ENABLED: 'false',
};
function request(headers: Record<string, string> = {}, method = 'GET', signal?: AbortSignal) {
  return new Request('https://staging.example/readyz', { method, signal, headers: {
    Authorization: `Bearer ${env.WORKER_TICK_TOKEN}`, 'X-OCPF-Readiness-Nonce': nonce,
    'X-OCPF-Expected-Version': version, 'X-OCPF-Expected-Sha': sha, ...headers,
  } });
}
function fixture(change: (body: Record<string, any>, rpc: string) => Response | void = () => {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input); calls.push({ url, init });
    const rpc = url.split('/').pop()!;
    const spec = READINESS_CONTRACTS.find(s => s.rpc === rpc);
    assert.ok(spec, 'A probe must never call an unapproved endpoint');
    const body: Record<string, any> = { contract: spec.contract, capabilities: [...spec.capabilities] };
    if (spec.name === 'publication') Object.assign(body, { migration: '20260907054000', lock_order_migration: '20260913061000' });
    return change(body, rpc) || Response.json(body);
  };
  return { calls, fetch: fn as typeof fetch };
}
async function probe(change?: Parameters<typeof fixture>[0], e: ReadinessEnv = env, req = request()) {
  const f = fixture();
  const selected = change ? fixture(change) : f;
  const response = await handleWorkerReadiness(req, e, selected.fetch);
  return { response, body: await response.json() as any, calls: selected.calls };
}

test('readiness proves exact identity and all schema capabilities without executing a job', async () => {
  const { response, body, calls } = await probe();
  assert.equal(response.status, 200); assert.equal(body.ok, true);
  assert.equal(body.readOnly, true); assert.equal(body.executionAuthorised, false);
  assert.equal(body.nonce, nonce); assert.equal(body.release.workerVersionId, version); assert.equal(body.release.gitSha, sha);
  assert.equal(body.readiness, 'dependencies_verified'); assert.equal(calls.length, 3);
  for (const { url, init } of calls) {
    assert.ok(READINESS_CONTRACTS.some(c => url === `https://database.example/rest/v1/rpc/${c.rpc}`));
    assert.equal(init?.method, 'POST'); assert.equal(init?.body, '{}'); assert.equal(init?.redirect, 'manual');
    assert.equal(init?.cache, 'no-store'); assert.ok(init?.signal instanceof AbortSignal);
    assert.equal((init?.headers as Record<string, string>).apikey, env.SUPABASE_SERVICE_ROLE_KEY);
  }
});

for (const auth of ['', 'Bearer wrong', 'bearer tick-secret-not-for-output']) {
  test(`invalid authorisation makes zero calls (${auth.length})`, async () => {
    const f = fixture(); const r = await handleWorkerReadiness(request({ Authorization: auth }), env, f.fetch);
    assert.equal(r.status, 404); assert.equal(await r.text(), 'Not found'); assert.equal(f.calls.length, 0);
  });
}
for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) test(`${method} cannot turn readiness into execution`, async () => {
  const f = fixture(); const r = await handleWorkerReadiness(request({}, method), env, f.fetch);
  assert.equal(r.status, 404); assert.equal(f.calls.length, 0);
});

test('missing server token is rejected even when other configuration is absent', async () => {
  const f = fixture(); const r = await handleWorkerReadiness(request(), {}, f.fetch);
  assert.equal(r.status, 404); assert.equal(f.calls.length, 0);
});
for (const invalid of ['', 'x', 'not-a-uuid', 'a'.repeat(1000)]) test(`invalid nonce (${invalid.length}) is rejected before database access`, async () => {
  const { response, calls } = await probe(undefined, env, request({ 'X-OCPF-Readiness-Nonce': invalid }));
  assert.equal(response.status, 400); assert.equal(calls.length, 0);
});
for (const header of ['X-OCPF-Expected-Version', 'X-OCPF-Expected-Sha']) test(`${header} mismatch is not readiness`, async () => {
  const { response, body, calls } = await probe(undefined, env, request({ [header]: 'wrong' }));
  assert.equal(response.status, 503); assert.equal(body.code, 'release_identity_mismatch'); assert.equal(calls.length, 0);
});
for (const metadata of [undefined, { id: 'wrong', tag: sha, timestamp: '' }, { id: version, tag: 'main', timestamp: '' }]) test(`missing/unattested runtime identity cannot pass ${JSON.stringify(metadata)}`, async () => {
  const { response, calls } = await probe(undefined, { ...env, CF_VERSION_METADATA: metadata });
  assert.equal(response.status, 503); assert.equal(calls.length, 0);
});
for (const key of ['SUPABASE_SERVICE_ROLE_KEY', 'CREDENTIAL_ENCRYPTION_KEY'] as const) test(`missing ${key} fails without a dependency call`, async () => {
  const { response, calls } = await probe(undefined, { ...env, [key]: '' });
  assert.equal(response.status, 503); assert.equal(calls.length, 0);
});
for (const url of ['', 'not-a-url', 'http://127.0.0.1:54321', 'https://name:secret@example.com', 'https://example.com/rest/v1', 'https://example.com/?key=secret', 'https://example.com/#key']) {
  test(`unusable configured origin fails closed (${url})`, async () => {
    const { response, calls } = await probe(undefined, { ...env, SUPABASE_URL: url });
    assert.equal(response.status, 503); assert.equal(calls.length, 0);
  });
}
for (const spec of READINESS_CONTRACTS) {
  for (const capability of spec.capabilities) test(`missing ${capability} cannot pass`, async () => {
    const { response, body } = await probe((b, rpc) => { if (rpc === spec.rpc) b.capabilities = b.capabilities.filter((c: string) => c !== capability); });
    assert.equal(response.status, 503); assert.ok(body.dependencies.some((d: any) => d.name === spec.name && d.state === 'contract_mismatch'));
  });
  test(`wrong ${spec.name} contract fails closed`, async () => {
    const { response } = await probe((b, rpc) => { if (rpc === spec.rpc) b.contract = 'invented'; });
    assert.equal(response.status, 503);
  });
}
for (const field of ['migration', 'lock_order_migration']) test(`wrong publication ${field} cannot pass`, async () => {
  const { response } = await probe((b, rpc) => { if (rpc === 'get_publication_schema_contract') b[field] = '20200101000000'; });
  assert.equal(response.status, 503);
});
for (const status of [301, 401, 403, 404, 429, 500]) test(`dependency HTTP ${status} is not retried or disclosed`, async () => {
  const { response, body, calls } = await probe(() => new Response('secret: '+env.SUPABASE_SERVICE_ROLE_KEY, { status }));
  assert.equal(response.status, 503); assert.equal(calls.length, 3);
  assert.ok(body.dependencies.every((d: any) => d.state === 'http_error' && d.status === status));
  assert.ok(!JSON.stringify(body).includes(env.SUPABASE_SERVICE_ROLE_KEY!));
});
for (const invalid of ['<html>bad gateway</html>', '[]', 'null', '1', 'x'.repeat(65537)]) test(`invalid response (${invalid.length}) is bounded and blocked`, async () => {
  const { response } = await probe(() => new Response(invalid)); assert.equal(response.status, 503);
});

test('streaming response exceeding the cap is cancelled', async () => {
  let cancelled = 0;
  const { response } = await probe(() => new Response(new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(40000)); }, cancel() { cancelled++; },
  })));
  assert.equal(response.status, 503); assert.equal(cancelled, 3);
});

test('database transport exceptions never disclose credentials or raw errors', async () => {
  const f = async () => { throw new Error('private ' + env.SUPABASE_SERVICE_ROLE_KEY); };
  const r = await handleWorkerReadiness(request(), env, f as typeof fetch);
  const text = await r.text(); assert.equal(r.status, 503);
  assert.ok(!text.includes(env.SUPABASE_SERVICE_ROLE_KEY!)); assert.ok(text.includes('transport_error'));
});

test('pre-cancelled request cannot read dependencies', async () => {
  const { response, calls } = await probe(undefined, env, request({}, 'GET', AbortSignal.abort()));
  assert.equal(response.status, 503); assert.equal(calls.length, 0);
});

test('cancellation aborts dependency reads and cannot return a late success', async () => {
  const c = new AbortController(); let aborted = 0;
  const f = (_: Parameters<typeof fetch>[0], init?: RequestInit) => new Promise<Response>((_, reject) => {
    init!.signal!.addEventListener('abort', () => { aborted++; reject(new Error('cancelled')); }, { once: true });
  });
  const pending = handleWorkerReadiness(request({}, 'GET', c.signal), env, f as typeof fetch);
  c.abort(); const r = await pending; assert.equal(r.status, 503); assert.equal(aborted, 3);
});

test('readiness has a finite shared dependency deadline', async () => {
  const start = Date.now();
  const f = (_: Parameters<typeof fetch>[0], init?: RequestInit) => new Promise<Response>((_, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  });
  const r = await handleWorkerReadiness(request(), env, f as typeof fetch);
  assert.equal(r.status, 503); assert.ok(Date.now() - start < 13000);
});

test('concurrent probes use their own environment and do not change process.env', async () => {
  const before = { ...process.env }; const a = fixture(); const b = fixture();
  await Promise.all([
    handleWorkerReadiness(request(), env, a.fetch),
    handleWorkerReadiness(request(), { ...env, SUPABASE_SERVICE_ROLE_KEY: 'second-private-key', SUPABASE_URL: 'https://second.example' }, b.fetch),
  ]);
  assert.deepEqual(Object.keys({ ...before, ...process.env }).filter(k => before[k] !== process.env[k]), []);
  assert.ok(a.calls.every(c => c.url.startsWith('https://database.example/') && (c.init!.headers as any).apikey === env.SUPABASE_SERVICE_ROLE_KEY));
  assert.ok(b.calls.every(c => c.url.startsWith('https://second.example/') && (c.init!.headers as any).apikey === 'second-private-key'));
});

test('responses are never cacheable and ignore unrelated database fields', async () => {
  const { response, body } = await probe(b => { b.secret = env.SUPABASE_SERVICE_ROLE_KEY; b.tenants = ['private-id']; });
  assert.match(response.headers.get('cache-control')!, /no-store/);
  assert.match(response.headers.get('vary')!, /Authorization/);
  assert.ok(!JSON.stringify(body).includes('private-id')); assert.ok(!JSON.stringify(body).includes(env.SUPABASE_SERVICE_ROLE_KEY!));
});

test('enabled execution controls are reported truthfully, never presented as inert', async () => {
  const { body } = await probe(undefined, { ...env, SUPABASE_PROVIDER_DISPATCH_ENABLED: 'true', SUPABASE_WORKER_GENERATION_ENABLED: 'false ' });
  assert.equal(body.controls.generationDisabled, false); assert.equal(body.controls.publishingDisabled, false);
  assert.equal(body.executionAuthorised, false);
});

test('worker routes /readyz through the effect-free handler without initialising execution', async () => {
  const before = { ...process.env }; const original = globalThis.fetch; const f = fixture();
  globalThis.fetch = f.fetch;
  try {
    const r = await worker.fetch(request(), env as Parameters<typeof worker.fetch>[1]);
    assert.equal(r.status, 200); assert.equal(f.calls.length, 3);
    assert.deepEqual(Object.keys({ ...before, ...process.env }).filter(k => before[k] !== process.env[k]), []);
  } finally { globalThis.fetch = original; }
});

test('readiness capability lists track existing source/angle/publication requirements', () => {
  for (const [name, file] of [['worker_claims', 'src/worker-claims.ts'], ['publication', 'src/publication-ledger.ts']]) {
    const source = readFileSync(file, 'utf8');
    const block = source.match(/export const REQUIRED_[A-Z_]+ = \[([\s\S]*?)\] as const;/)![1];
    const expected = [...block.matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
    assert.deepEqual([...READINESS_CONTRACTS.find(c => c.name === name)!.capabilities].sort(), expected);
  }
});

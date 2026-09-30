import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/cloudflare-worker';
import { READINESS_CONTRACTS } from '../src/worker-readiness';
import { releaseProbeAuthorised, withOperatorControls, workerPaused, type OperatorEnv } from '../src/worker-operator-controls';

const project = 'rdgqpokhdffznhgazyoe';
const lease = 'a'.repeat(64);
const start = 1790760000000;
const env: OperatorEnv = {
  WORKER_TICK_TOKEN: 'existing-operator-token', WORKER_READINESS_TOKEN: lease,
  WORKER_READINESS_TOKEN_ISSUED_AT: String(start), WORKER_READINESS_TOKEN_EXPIRES_AT: String(start + 600000),
  SUPABASE_URL: `https://${project}.supabase.co`,
};
function req(path = '/readyz', method = 'GET', headers: Record<string, string> = {}) {
  return new Request('https://worker.example' + path, { method, headers: {
    Authorization: `Bearer ${lease}`, 'X-OCPF-Expected-Project': project, ...headers,
  } });
}
function currentEnv(): OperatorEnv {
  return { ...env, WORKER_READINESS_TOKEN_ISSUED_AT: String(Date.now() - 1000),
    WORKER_READINESS_TOKEN_EXPIRES_AT: String(Date.now() + 600000) };
}
function fake() {
  const calls: { request?: Request; env: OperatorEnv }[] = [];
  const core = withOperatorControls({
    async fetch(request: Request, e: OperatorEnv) {
      calls.push({ request, env: e });
      return Response.json({ ok: true, executionAuthorised: false, release: { gitSha: 'b'.repeat(40) } });
    },
    async scheduled(_c: unknown, e: OperatorEnv, _x: unknown) { calls.push({ env: e }); },
  });
  return { core, calls };
}

test('maintenance defaults are backwards compatible and configured typos pause', () => {
  assert.equal(workerPaused({}), false); assert.equal(workerPaused({ WORKER_MAINTENANCE_MODE: 'false' }), false);
  for (const value of ['true', '', 'FALSE', 'false ', '0', 'off']) assert.equal(workerPaused({ WORKER_MAINTENANCE_MODE: value }), true);
});

test('valid lease has a strict finite not-before and expiry', () => {
  assert.equal(releaseProbeAuthorised(req(), env, start), true);
  assert.equal(releaseProbeAuthorised(req(), env, start - 1), false);
  assert.equal(releaseProbeAuthorised(req(), env, start + 600000), false);
  assert.equal(releaseProbeAuthorised(req(), { ...env, WORKER_READINESS_TOKEN_EXPIRES_AT: String(start + 900001) }, start), false);
  assert.equal(releaseProbeAuthorised(req(), { ...env, WORKER_READINESS_TOKEN_EXPIRES_AT: String(start) }, start), false);
});

for (const key of ['WORKER_READINESS_TOKEN', 'WORKER_READINESS_TOKEN_ISSUED_AT', 'WORKER_READINESS_TOKEN_EXPIRES_AT'] as const) {
  test(`missing or malformed ${key} never authorises a probe`, () => {
    for (const value of [undefined, '', 'bad', '1e12', 'Infinity']) {
      assert.equal(releaseProbeAuthorised(req(), { ...env, [key]: value }, start), false);
    }
  });
}

test('lease never authorises other routes or methods', () => {
  for (const path of ['/tick', '/healthz', '/api/connectors/reddit/x', '/api/collector/reddit/source-records']) {
    assert.equal(releaseProbeAuthorised(req(path), env, start), false);
  }
  for (const method of ['POST', 'PUT', 'HEAD', 'DELETE']) assert.equal(releaseProbeAuthorised(req('/readyz', method), env, start), false);
  assert.equal(releaseProbeAuthorised(req('/readyz', 'GET', { Authorization: 'Bearer wrong' }), env, start), false);
});

test('maintenance intercepts all business routes before the core and scheduled work', async () => {
  const f = fake(); const paused = { ...currentEnv(), WORKER_MAINTENANCE_MODE: 'true' };
  for (const path of ['/tick', '/api/connectors/reddit/x', '/api/collector/reddit/source-records', '/unrecognised']) {
    assert.equal((await f.core.fetch(req(path, 'POST'), paused)).status, 503);
  }
  await f.core.scheduled({}, paused, {}); assert.equal(f.calls.length, 0);
});

test('a leased probe reuses native checks and does not expose either token', async () => {
  const f = fake(); const e = currentEnv(); const original = { ...e };
  const response = await f.core.fetch(req(), e); const body = await response.json() as any;
  assert.equal(body.databaseProjectMatched, true); assert.equal(body.executionAuthorised, false);
  assert.equal(body.release.gitSha, 'b'.repeat(40)); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request!.headers.get('Authorization'), `Bearer ${e.WORKER_TICK_TOKEN}`);
  assert.equal(f.calls[0].env.WORKER_READINESS_TOKEN, undefined);
  assert.equal(f.calls[0].env.WORKER_READINESS_TOKEN_ISSUED_AT, undefined);
  assert.equal(f.calls[0].env.WORKER_READINESS_TOKEN_EXPIRES_AT, undefined);
  assert.deepEqual(e, original);
  const text = JSON.stringify(body); assert.ok(!text.includes(lease)); assert.ok(!text.includes(e.WORKER_TICK_TOKEN!));
  assert.match(response.headers.get('cache-control')!, /no-store/);
});

test('wrong project, missing project and unsafe configured origins make no core calls', async () => {
  const f = fake();
  for (const url of ['https://different.supabase.co', `https://${project}.supabase.co/other`, `http://${project}.supabase.co`, `https://x:y@${project}.supabase.co`, `https://${project}.supabase.co/?secret=x`]) {
    assert.equal((await f.core.fetch(req(), { ...currentEnv(), SUPABASE_URL: url })).status, 503);
  }
  assert.equal((await f.core.fetch(req('/readyz', 'GET', { 'X-OCPF-Expected-Project': '' }), currentEnv())).status, 503);
  assert.equal(f.calls.length, 0);
});

test('health and scheduled delegation never copy lease secrets into core environment', async () => {
  const f = fake(); const e = currentEnv();
  await f.core.fetch(req('/healthz'), e); await f.core.scheduled({}, e, {});
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) assert.equal(c.env.WORKER_READINESS_TOKEN, undefined);
});

test('canonical Worker maintenance has no dependency or execution effects', async () => {
  const before = { ...process.env }; let waits = 0;
  const e = { WORKER_MAINTENANCE_MODE: 'true' };
  await worker.scheduled({ scheduledTime: 0, cron: '* * * * *' }, e, { waitUntil() { waits++; } });
  assert.equal((await worker.fetch(req('/tick', 'POST'), e)).status, 503);
  assert.equal(waits, 0); assert.deepEqual({ ...process.env }, before);
});

test('canonical Worker never accepts the read-only lease as a tick credential', async () => {
  assert.equal((await worker.fetch(req('/tick', 'POST'), currentEnv())).status, 404);
});

test('canonical leased readiness still checks all three contracts and exact identity', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls++; const c = READINESS_CONTRACTS.find(c => String(input).endsWith('/' + c.rpc))!;
    assert.ok(c);
    return Response.json({ contract: c.contract, capabilities: [...c.capabilities],
      migration: '20260907054000', lock_order_migration: '20260913061000' });
  }) as typeof fetch;
  const e = { ...currentEnv(), WORKER_MAINTENANCE_MODE: 'true', SUPABASE_SERVICE_ROLE_KEY: 'private',
    CREDENTIAL_ENCRYPTION_KEY: 'private-encryption', SUPABASE_WORKER_GENERATION_ENABLED: 'false',
    SUPABASE_PROVIDER_DISPATCH_ENABLED: 'false',
    CF_VERSION_METADATA: { id: '11111111-1111-4111-8111-111111111111', tag: 'b'.repeat(40), timestamp: '' } };
  const headers = { 'X-OCPF-Readiness-Nonce': '22222222-2222-4222-8222-222222222222',
    'X-OCPF-Expected-Version': e.CF_VERSION_METADATA.id, 'X-OCPF-Expected-Sha': 'b'.repeat(40) };
  try {
    const r = await worker.fetch(req('/readyz', 'GET', headers), e);
    const b = await r.json() as any;
    assert.equal(r.status, 200); assert.equal(calls, 3); assert.equal(b.maintenance.paused, true);
    assert.equal(b.databaseProjectMatched, true); assert.equal(b.executionAuthorised, false);
    const wrong = await worker.fetch(req('/readyz', 'GET', { ...headers, 'X-OCPF-Expected-Sha': 'c'.repeat(40) }), e);
    assert.equal(wrong.status, 503); assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

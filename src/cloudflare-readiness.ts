// Operator-only, effect-free readiness. Never import the scheduler, tenant
// credentials, global config, paid models or provider adapters in this module.
export interface ReadinessEnv {
  NODE_ENV?: string;
  WORKER_TICK_TOKEN?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  SERVICE_ROLE_KEY?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp: string };
}

const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NONCE = /^[a-f0-9]{32,64}$/;
const MAX_BYTES = 16384;
const HEADERS = { 'Cache-Control': 'no-store, max-age=0', Vary: 'Authorization' };

export const READINESS_CONTRACTS = [
  { rpc: 'get_worker_schema_contract', contract: 'worker-claims-v1', capabilities: [
    'source-targeted-claim-v1', 'angle-targeted-claim-v1', 'angle-exhaust-fenced-v1',
    'source-angle-atomic-commit-v1', 'angle-queue-atomic-commit-v1',
    'queue-angle-identity-v1', 'legacy-queue-revision-hold-v1',
  ] },
  { rpc: 'get_publication_schema_contract', contract: 'publication-ledger-v1', capabilities: [
    'publication-intent-claim-v1', 'publication-dispatch-boundary-v1',
    'publication-attempt-outcome-v1', 'publication-unknown-reconciliation-v1',
    'publication-exact-history-receipt-v1', 'publication-queue-compatibility-fence-v1',
    'publication-provenance-snapshot-v1', 'publication-legacy-queue-hold-v1',
    'publication-queue-lock-order-v1',
  ] },
  { rpc: 'get_agent_jobs_contract', contract: 'agent-jobs-v1', capabilities: [
    'durable-enqueue-v1', 'fenced-terminal-v1', 'reconciliation-only-recovery-v1',
    'rpc-only-job-writes-v1',
  ] },
] as const;

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
    await response.body?.cancel();
    throw new Error('invalid_response');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_response');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error('invalid_response');
      chunks.push(value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Only fixed, existing metadata RPCs are consulted. POST is their transport
// convention, not permission to run a job. Response data is never passed through.
export async function handleReadinessRequest(
  request: Request,
  env: ReadinessEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const token = env.WORKER_TICK_TOKEN;
  if (request.method !== 'GET' || !token || request.headers.get('Authorization') !== `Bearer ${token}`) {
    return new Response('Not found', { status: 404, headers: HEADERS });
  }
  const nonce = request.headers.get('X-OCPF-Readiness-Nonce') || '';
  const expectedVersion = request.headers.get('X-OCPF-Expected-Version') || '';
  const expectedSha = request.headers.get('X-OCPF-Expected-Sha') || '';
  const mode = request.headers.get('X-OCPF-Readiness-Mode') || '';
  if (!NONCE.test(nonce) || !UUID.test(expectedVersion) || !SHA.test(expectedSha)
    || !['configuration', 'database'].includes(mode)) {
    return Response.json({ ok: false, code: 'readiness_request_invalid' }, { status: 400, headers: HEADERS });
  }
  const metadata = env.CF_VERSION_METADATA;
  const version = metadata && UUID.test(metadata.id) ? metadata.id : null;
  const sha = metadata?.tag && SHA.test(metadata.tag) ? metadata.tag : null;
  const base = {
    schema: 'ocpf.readiness.v1', nonce, mode, workerVersionId: version, gitSha: sha,
    effectFree: true, authorisesExecution: false,
  };
  const fail = (code: string, status = 503) => Response.json(
    { ...base, ok: false, code }, { status, headers: HEADERS },
  );
  if (version !== expectedVersion || sha !== expectedSha) return fail('release_identity_mismatch', 409);
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || env.SERVICE_ROLE_KEY;
  if (!serviceKey?.trim() || !env.CREDENTIAL_ENCRYPTION_KEY?.trim()) return fail('runtime_bindings_incomplete');
  let origin: URL;
  try {
    origin = new URL(env.SUPABASE_URL || '');
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port
      || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid_origin');
    const hosted = /^[a-z0-9]{20}\.supabase\.co$/.test(origin.hostname);
    const temporary = env.NODE_ENV === 'staging' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(origin.hostname);
    if (!hosted && !temporary) throw new Error('invalid_origin');
  } catch { return fail('database_origin_invalid'); }
  if (mode === 'configuration') {
    return Response.json({ ...base, ok: true, code: 'configuration_ready', databaseEvaluated: false },
      { status: 200, headers: HEADERS });
  }

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12000)]);
  for (const required of READINESS_CONTRACTS) {
    let response: Response;
    let body: unknown;
    try {
      signal.throwIfAborted();
      response = await fetchImpl(`${origin.origin}/rest/v1/rpc/${required.rpc}`, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal,
        headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if ([401, 403].includes(response.status)) return fail('database_auth_rejected');
        if (response.status === 404) return fail('database_contract_unavailable');
        return fail('database_transport_unavailable');
      }
      body = await boundedJson(response);
      signal.throwIfAborted();
    } catch { return fail('database_transport_unavailable'); }
    if (!object(body) || body.contract !== required.contract || !Array.isArray(body.capabilities)
      || required.capabilities.some(c => !(body.capabilities as unknown[]).includes(c))) {
      return fail('database_contract_mismatch');
    }
    if (required.contract === 'publication-ledger-v1'
      && (body.migration !== '20260907054000' || body.lock_order_migration !== '20260913061000')) {
      return fail('database_contract_mismatch');
    }
  }
  return Response.json({
    ...base, ok: true, code: 'database_ready', databaseEvaluated: true,
    contracts: READINESS_CONTRACTS.map(c => c.contract),
  }, { status: 200, headers: HEADERS });
}

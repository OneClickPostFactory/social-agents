import { timingSafeEqual } from 'node:crypto';

// Operator-only, effect-free probe. Do not import config, scheduler, job claims,
// provider clients or loggers here: liveness must never initialise execution.
export interface ReadinessEnv {
  WORKER_TICK_TOKEN?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  SERVICE_ROLE_KEY?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp: string };
  SUPABASE_WORKER_GENERATION_ENABLED?: string;
  SUPABASE_PROVIDER_DISPATCH_ENABLED?: string;
}

export const READINESS_CONTRACTS = [
  {
    name: 'worker_claims', rpc: 'get_worker_schema_contract', contract: 'worker-claims-v1',
    capabilities: ['source-targeted-claim-v1', 'angle-targeted-claim-v1', 'angle-exhaust-fenced-v1',
      'source-angle-atomic-commit-v1', 'angle-queue-atomic-commit-v1', 'queue-angle-identity-v1',
      'legacy-queue-revision-hold-v1'],
  },
  {
    name: 'publication', rpc: 'get_publication_schema_contract', contract: 'publication-ledger-v1',
    capabilities: ['publication-intent-claim-v1', 'publication-dispatch-boundary-v1',
      'publication-attempt-outcome-v1', 'publication-unknown-reconciliation-v1',
      'publication-exact-history-receipt-v1', 'publication-queue-compatibility-fence-v1',
      'publication-provenance-snapshot-v1', 'publication-legacy-queue-hold-v1', 'publication-queue-lock-order-v1'],
  },
  {
    name: 'agent_jobs', rpc: 'get_agent_jobs_contract', contract: 'agent-jobs-v1',
    capabilities: ['durable-enqueue-v1', 'fenced-terminal-v1', 'reconciliation-only-recovery-v1', 'rpc-only-job-writes-v1'],
  },
] as const;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const HEADERS = { 'Cache-Control': 'no-store, private, max-age=0', Vary: 'Authorization, X-OCPF-Readiness-Nonce' };
const MAX_BODY = 65536;
const TIMEOUT_MS = 10000;

function authorised(request: Request, token: string | undefined): boolean {
  if (!token || token.length > 4096) return false;
  const received = request.headers.get('Authorization') || '';
  const expected = `Bearer ${token}`;
  const a = Buffer.from(received), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) {
    await response.body?.cancel();
    throw new Error('invalid_body');
  }
  if (!response.body) throw new Error('invalid_body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error('invalid_body');
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_body');
    return parsed as Record<string, unknown>;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function handleWorkerReadiness(
  request: Request,
  env: ReadinessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  // Invalid auth is indistinguishable from a missing route. No dependency reads.
  if (request.method !== 'GET' || !authorised(request, env.WORKER_TICK_TOKEN)) {
    return new Response('Not found', { status: 404, headers: HEADERS });
  }
  const nonce = request.headers.get('X-OCPF-Readiness-Nonce');
  if (!nonce || !UUID.test(nonce)) {
    return Response.json({ ok: false, code: 'readiness_nonce_required' }, { status: 400, headers: HEADERS });
  }
  const metadata = env.CF_VERSION_METADATA;
  const identity = {
    workerVersionId: metadata && UUID.test(metadata.id) ? metadata.id : null,
    gitSha: metadata?.tag && SHA.test(metadata.tag) ? metadata.tag : null,
  };
  const envelope = {
    schema: 'ocpf.worker-readiness.v1', readOnly: true, executionAuthorised: false,
    nonce, release: identity,
    controls: {
      generationDisabled: env.SUPABASE_WORKER_GENERATION_ENABLED === 'false',
      publishingDisabled: env.SUPABASE_PROVIDER_DISPATCH_ENABLED === 'false',
    },
  };
  const blocked = (code: string) => Response.json(
    { ...envelope, ok: false, readiness: 'blocked', code }, { status: 503, headers: HEADERS },
  );
  if (!identity.workerVersionId || !identity.gitSha) return blocked('release_identity_unavailable');
  // Bind readiness to the caller's exact reviewed version, not any healthy code.
  if (request.headers.get('X-OCPF-Expected-Version') !== identity.workerVersionId
    || request.headers.get('X-OCPF-Expected-Sha') !== identity.gitSha) return blocked('release_identity_mismatch');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || env.SERVICE_ROLE_KEY;
  if (!key?.trim() || !env.CREDENTIAL_ENCRYPTION_KEY?.trim()) return blocked('runtime_configuration_incomplete');
  let origin: string;
  try {
    const u = new URL(env.SUPABASE_URL || '');
    // The URL comes solely from trusted bindings, never from the request.
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') {
      return blocked('database_origin_invalid');
    }
    origin = u.origin;
  } catch { return blocked('database_origin_invalid'); }
  if (request.signal.aborted) return blocked('readiness_cancelled');
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, TIMEOUT_MS);
  try {
    const dependencies = await Promise.all(READINESS_CONTRACTS.map(async expected => {
      let response: Response | undefined;
      try {
        response = await fetchImpl(`${origin}/rest/v1/rpc/${expected.rpc}`, {
          method: 'POST', body: '{}', redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json', Accept: 'application/json' },
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          return { name: expected.name, state: 'http_error', status: response.status };
        }
        const body = await jsonBody(response);
        const capabilities = body.capabilities;
        let compatible = body.contract === expected.contract && Array.isArray(capabilities)
          && expected.capabilities.every(c => capabilities.includes(c));
        if (expected.name === 'publication') compatible = compatible
          && body.migration === '20260907054000' && body.lock_order_migration === '20260913061000';
        return { name: expected.name, state: compatible ? 'verified' : 'contract_mismatch' };
      } catch {
        // Never return DB bodies, URLs, SQL messages, exception text or secrets.
        return { name: expected.name, state: controller.signal.aborted ? 'cancelled_or_timeout' : response ? 'invalid_response' : 'transport_error' };
      }
    }));
    const ready = !controller.signal.aborted && dependencies.every(d => d.state === 'verified');
    return Response.json({ ...envelope, ok: ready, readiness: ready ? 'dependencies_verified' : 'blocked', dependencies }, {
      status: ready ? 200 : 503, headers: HEADERS,
    });
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abort);
  }
}

import { timingSafeEqual } from 'node:crypto';

export type OperatorEnv = {
  WORKER_MAINTENANCE_MODE?: string;
  WORKER_READINESS_TOKEN?: string;
  WORKER_READINESS_TOKEN_ISSUED_AT?: string;
  WORKER_READINESS_TOKEN_EXPIRES_AT?: string;
  WORKER_TICK_TOKEN?: string;
  SUPABASE_URL?: string;
};

const PRIVATE_HEADERS = { 'Cache-Control': 'no-store, private, max-age=0' };
const LEASE_FIELDS = [
  'WORKER_READINESS_TOKEN', 'WORKER_READINESS_TOKEN_ISSUED_AT', 'WORKER_READINESS_TOKEN_EXPIRES_AT',
] as const;

// Absence preserves the existing runtime. A misspelled configured flag pauses.
export function workerPaused(env: OperatorEnv): boolean {
  return env.WORKER_MAINTENANCE_MODE !== undefined && env.WORKER_MAINTENANCE_MODE !== 'false';
}

export function releaseProbeAuthorised(request: Request, env: OperatorEnv, now = Date.now()): boolean {
  if (request.method !== 'GET' || new URL(request.url).pathname !== '/readyz') return false;
  const token = env.WORKER_READINESS_TOKEN;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const issued = env.WORKER_READINESS_TOKEN_ISSUED_AT || '';
  const expires = env.WORKER_READINESS_TOKEN_EXPIRES_AT || '';
  if (!/^\d{13}$/.test(issued) || !/^\d{13}$/.test(expires)) return false;
  const start = Number(issued), end = Number(expires);
  if (!Number.isSafeInteger(now) || start > now || end <= now || end <= start || end - start > 900000) return false;
  const actual = Buffer.from(request.headers.get('Authorization') || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function withoutLease<E extends OperatorEnv>(env: E): E {
  const copy = { ...env };
  for (const key of LEASE_FIELDS) delete copy[key];
  return copy;
}

function projectMatches(request: Request, env: OperatorEnv): boolean {
  const project = request.headers.get('X-OCPF-Expected-Project') || '';
  if (!/^[a-z]{20}$/.test(project)) return false;
  try {
    const url = new URL(env.SUPABASE_URL || '');
    return url.protocol === 'https:' && url.hostname === `${project}.supabase.co`
      && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
}

interface Core<E, Controller, Context> {
  fetch(request: Request, env: E): Promise<Response>;
  scheduled(controller: Controller, env: E, context: Context): Promise<void>;
}

// Wrap the canonical entry, not a separate staging implementation. The lease
// grants GET readiness only; it is never accepted as a business tick token.
export function withOperatorControls<E extends OperatorEnv, Controller, Context>(
  core: Core<E, Controller, Context>,
): Core<E, Controller, Context> {
  return {
    async scheduled(controller, env, context) {
      if (workerPaused(env)) return;
      return core.scheduled(controller, withoutLease(env), context);
    },
    async fetch(request, env) {
      const path = new URL(request.url).pathname;
      const clean = withoutLease(env);
      if (path === '/readyz' && releaseProbeAuthorised(request, env)) {
        // Authenticate first, then bind the read-only probe to the owned project.
        if (!projectMatches(request, env)) {
          return Response.json({ ok: false, code: 'readiness_project_mismatch', readOnly: true,
            executionAuthorised: false }, { status: 503, headers: PRIVATE_HEADERS });
        }
        if (!env.WORKER_TICK_TOKEN) return new Response('Not found', { status: 404, headers: PRIVATE_HEADERS });
        const headers = new Headers(request.headers);
        headers.set('Authorization', `Bearer ${env.WORKER_TICK_TOKEN}`);
        // Reuse all native version/SHA/nonce/schema checks; no new DB path.
        const response = await core.fetch(new Request(request, { headers }), clean);
        if (!response.headers.get('content-type')?.includes('application/json')) return response;
        const body = await response.json() as Record<string, unknown>;
        return Response.json({ ...body, databaseProjectMatched: true,
          maintenance: { paused: workerPaused(env) } }, { status: response.status, headers: {
          ...Object.fromEntries(response.headers), ...PRIVATE_HEADERS,
        } });
      }
      if (path === '/healthz') {
        const response = await core.fetch(request, clean);
        const body = await response.json() as Record<string, unknown>;
        return Response.json({ ...body, maintenance: { paused: workerPaused(env) } }, {
          status: response.status, headers: { ...Object.fromEntries(response.headers), ...PRIVATE_HEADERS },
        });
      }
      if (path === '/readyz') return core.fetch(request, clean);
      if (workerPaused(env)) {
        return Response.json({ ok: false, code: 'worker_maintenance', executionAuthorised: false }, {
          status: 503, headers: { ...PRIVATE_HEADERS, 'Retry-After': '60' },
        });
      }
      return core.fetch(request, clean);
    },
  };
}

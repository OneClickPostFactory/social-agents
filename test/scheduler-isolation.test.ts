import assert from 'node:assert/strict';
import { test } from 'node:test';
import config from '../config';
import { runSupabaseAutomationScheduler } from '../src/supabase-worker';

test('the real scheduler isolates tenant, stage and logging failures', async t => {
  const originalFetch = globalThis.fetch;
  const originalConfig = {
    SUPABASE_URL: config.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: config.SUPABASE_SERVICE_ROLE_KEY,
    CREDENTIAL_ENCRYPTION_KEY: config.CREDENTIAL_ENCRYPTION_KEY,
    SUPABASE_WORKER_CANARY_REQUIRED: config.SUPABASE_WORKER_CANARY_REQUIRED,
    SUPABASE_WORKER_CANARY_USER_IDS: config.SUPABASE_WORKER_CANARY_USER_IDS,
    SUPABASE_WORKER_GENERATION_ENABLED: config.SUPABASE_WORKER_GENERATION_ENABLED,
    SUPABASE_PROVIDER_DISPATCH_ENABLED: config.SUPABASE_PROVIDER_DISPATCH_ENABLED,
  };
  Object.assign(config, {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    CREDENTIAL_ENCRYPTION_KEY: 'test-encryption', SUPABASE_WORKER_CANARY_REQUIRED: false,
    SUPABASE_WORKER_CANARY_USER_IDS: '', SUPABASE_WORKER_GENERATION_ENABLED: true,
    SUPABASE_PROVIDER_DISPATCH_ENABLED: true,
  });
  try {
    for (const failure of ['tenant', 'fetch_query', 'recovery_query', 'logging'] as const) {
      await t.test(failure, async () => {
        const enqueued: Array<Record<string, any>> = [];
        const unexpected: string[] = [];
        let slotFillVisited = false;
        const settings = ['broken', 'healthy'].map(user_id => ({
          user_id, automation_enabled: true, automation_publish_enabled: true,
          automation_fetch_enabled: true, next_fetch_at: null,
        }));
        const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
        globalThis.fetch = async (input, init) => {
          const url = new URL(String(input));
          const table = url.pathname.split('/').pop();
          const method = init?.method || 'GET';
          const user = url.searchParams.get('user_id');
          if (table === 'get_agent_jobs_contract') return json({ contract: 'agent-jobs-v1', capabilities: ['durable-enqueue-v1', 'fenced-terminal-v1', 'reconciliation-only-recovery-v1', 'rpc-only-job-writes-v1'] });
          if (table === 'enqueue_worker_agent_job') {
            const args = JSON.parse(String(init?.body));
            const job = { user_id: args.p_user_id, kind: args.p_kind, payload: args.p_payload, id: `job-${enqueued.length + 1}` };
            enqueued.push(job);
            return json({ created: true, job });
          }
          if (url.pathname.includes('/rpc/')) return json({ message: 'schema unavailable' }, 503);
          if (table === 'worker_logs' && method === 'POST') return failure === 'logging'
            ? json({ message: 'log unavailable' }, 503) : json([]);
          if (table === 'user_settings' && method === 'PATCH') return json([]);
          if (table === 'user_settings' && method === 'GET') {
            if (url.searchParams.has('automation_fetch_enabled')) return failure === 'fetch_query'
              ? json({ message: 'settings unavailable' }, 503) : json(settings);
            if (url.searchParams.has('automation_publish_enabled')) {
              slotFillVisited = true;
              return json([]);
            }
            return json(settings);
          }
          if (table === 'profiles') return user === 'eq.broken'
            ? json({ message: 'tenant data unavailable' }, 503) : json([{ subscription_status: 'active' }]);
          if (table === 'internal_access_overrides') return json([]);
          if (table === 'user_sources') return json([{ id: 'source' }]);
          if (table === 'agent_jobs' && method === 'GET') return failure === 'recovery_query' && url.searchParams.has('claim_expires_at')
            ? json({ message: 'recovery unavailable' }, 503) : json([]);
          if (table === 'queue_items' && method === 'GET') return json(['broken', 'healthy', 'healthy'].map((user_id, i) => ({
            id: `queue-${i}`, user_id, platform: 'x', status: 'ready',
            scheduled_for: '2026-01-01T00:00:00Z',
          })));
          unexpected.push(`${method} ${url.pathname}`);
          return json({ message: 'unexpected request' }, 500);
        };
        const stats = await runSupabaseAutomationScheduler();
        assert.equal(slotFillVisited, true);
        assert.equal(stats.publishJobsEnqueued, 2);
        assert.equal(stats.fetchJobsEnqueued, failure === 'fetch_query' ? 0 : 1);
        assert.equal(stats.errors.fetch, 1);
        assert.equal(stats.errors.publish, 1);
        assert.equal(stats.errors.job_recovery || 0, failure === 'recovery_query' ? 1 : 0);
        assert.equal(enqueued.every(job => job.user_id === 'healthy'), true);
        assert.deepEqual(enqueued.filter(job => job.kind === 'publish_now').map(job => job.payload.queue_item_id), ['queue-1', 'queue-2']);
        assert.deepEqual(unexpected, []);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config, originalConfig);
  }
});

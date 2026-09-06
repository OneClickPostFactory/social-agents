import { createExclusiveRunGate } from './exclusive-run-gate';
import { installScopedConfig, runWithRuntimeScope } from './runtime-scope';

interface WorkerVersionMetadata {
  id: string;
  tag?: string;
  timestamp: string;
}

interface Env {
  NODE_ENV?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  SERVICE_ROLE_KEY?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  SUPABASE_WORKER_BATCH_SIZE?: string;
  DAILY_INVENTORY_PLANNER_ENABLED?: string;
  DAILY_INVENTORY_PLANNER_START_LOCAL_DATE?: string;
  HTTP_TIMEOUT_MS?: string;
  OPENAI_MODEL?: string;
  OPENAI_IMAGE_MODEL?: string;
  OPENAI_IMAGE_TIMEOUT_MS?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  CLOUDINARY_UPLOAD_PRESET?: string;
  META_GRAPH_VERSION?: string;
  THREADS_GRAPH_VERSION?: string;
  CLOUDINARY_FOLDER?: string;
  WORKER_TICK_TOKEN?: string;
  COLLECTOR_INGEST_ENABLED?: string;
  COLLECTOR_INGEST_HMAC_SECRET?: string;
  COLLECTOR_INGEST_WRITE_ENABLED?: string;
  COLLECTOR_INGEST_ENV?: string;
  COLLECTOR_INGEST_CANARY_SOURCE_ID?: string;
  COLLECTOR_INGEST_CANARY_USER_ID?: string;
  COLLECTOR_INGEST_MAX_RECORDS?: string;
  REDDIT_CONNECTOR_ENABLED?: string;
  REDDIT_CONNECTOR_MAX_POSTS_PER_RUN?: string;
  REDDIT_CONNECTOR_PAIRING_TTL_SECONDS?: string;
  REDDIT_CONNECTOR_PAIRING_SECRET?: string;
  APP_ALLOWED_ORIGINS?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  [key: string]: string | WorkerVersionMetadata | undefined;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const SCHEMA_CONTRACT = 'pre-publication-ledger-v1';
const scheduledTickGate = createExclusiveRunGate();

function canonicalGitSha(versionTag: string | undefined): string | null {
  const tag = String(versionTag || '').trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(tag) ? tag : null;
}

function publicationCapabilities(): Record<string, { state: string; code: string }> {
  return {
    threads: {
      state: 'unavailable',
      code: 'legacy_meta_publication_disabled',
    },
    instagram: {
      state: 'unavailable',
      code: 'legacy_meta_publication_disabled',
    },
    linkedin: {
      state: 'compatibility_unverified',
      code: 'provider_contract_unverified',
    },
    x: {
      state: 'tenant_scoped',
      code: 'tenant_connection_required',
    },
    facebook: {
      state: 'paused',
      code: 'facebook_publication_paused',
    },
  };
}

function healthPayload(env: Env): Record<string, unknown> {
  const metadata = env.CF_VERSION_METADATA;
  return {
    ok: true,
    liveness: 'ok',
    readiness: 'not_evaluated',
    service: 'oneclickpostfactory-agent',
    mode: 'cloudflare-scheduled-worker',
    release: {
      workerVersionId: metadata?.id || null,
      versionTag: metadata?.tag || null,
      gitSha: canonicalGitSha(metadata?.tag),
      versionTimestamp: metadata?.timestamp || null,
      schemaContract: SCHEMA_CONTRACT,
      appliedSchema: 'unverified',
    },
    publicationCapabilities: publicationCapabilities(),
    executionGate: scheduledTickGate.snapshot(),
  };
}

function applyCloudflareEnv(env: Env): void {
  process.env.CF_WORKER_RUNTIME = 'true';

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value) {
      process.env[key] = value;
    }
  }
}

async function executeScheduledTick(env: Env): Promise<Response> {
  applyCloudflareEnv(env);

  // Config must be constructed after Worker bindings are copied into process.env.
  // Instrument the shared object once, then keep every tenant mutation inside this
  // async execution scope rather than process-global state.
  const { default: config } = await import('../config');
  installScopedConfig(config);

  return runWithRuntimeScope(async () => {
    const [{ processPendingSupabaseJobs, runSupabaseAutomationScheduler }, logger] = await Promise.all([
      import('./supabase-worker'),
      import('./logger'),
    ]);

    const schedulerStats = await runSupabaseAutomationScheduler();
    const stats = await processPendingSupabaseJobs();
    logger.info(
      `Cloudflare scheduled worker tick | scheduled_fetch:${schedulerStats.fetchJobsEnqueued} scheduled_fill:${schedulerStats.slotFillJobsEnqueued} scheduled_publish:${schedulerStats.publishJobsEnqueued} inventory_plans:${schedulerStats.inventoryPlansChecked} inventory_alerts:${schedulerStats.inventoryAlerts} stale_failed:${schedulerStats.staleJobsFailed} claimed:${stats.claimed} completed:${stats.completed} failed:${stats.failed}`
    );

    return Response.json({ ok: true, schedulerStats, stats });
  }, {
    execution: 'cloudflare_saas_tick',
  });
}

function runScheduledTick(env: Env): Promise<Response> {
  return scheduledTickGate.run(() => executeScheduledTick(env));
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledTick(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      applyCloudflareEnv(env);
      return Response.json(healthPayload(env));
    }

    if (url.pathname === '/api/collector/reddit/source-records' && request.method === 'POST') {
      applyCloudflareEnv(env);
      const { handleBrowserCollectorIngestRequest } = await import('./browser-collector-ingest');
      return handleBrowserCollectorIngestRequest(request, env);
    }

    if (url.pathname.startsWith('/api/connectors/reddit/')) {
      applyCloudflareEnv(env);
      const { handleRedditConnectorRequest } = await import('./reddit-connector');
      return handleRedditConnectorRequest(request, env);
    }

    if (url.pathname === '/tick' && request.method === 'POST') {
      const token = env.WORKER_TICK_TOKEN;
      if (!token || request.headers.get('Authorization') !== `Bearer ${token}`) {
        return new Response('Not found', { status: 404 });
      }
      return runScheduledTick(env);
    }

    return new Response('Not found', { status: 404 });
  },
};

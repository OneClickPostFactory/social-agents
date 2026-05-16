interface Env {
  NODE_ENV?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  SERVICE_ROLE_KEY?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  SUPABASE_WORKER_BATCH_SIZE?: string;
  HTTP_TIMEOUT_MS?: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  REDDIT_PUBLIC_JSON_TRANSPORT?: string;
  REDDIT_USER_AGENT?: string;
  OPENAI_MODEL?: string;
  OPENAI_IMAGE_MODEL?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  CLOUDINARY_UPLOAD_PRESET?: string;
  META_GRAPH_VERSION?: string;
  THREADS_GRAPH_VERSION?: string;
  CLOUDINARY_FOLDER?: string;
  WORKER_TICK_TOKEN?: string;
  [key: string]: string | undefined;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function applyCloudflareEnv(env: Env): void {
  process.env.CF_WORKER_RUNTIME = 'true';

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value) {
      process.env[key] = value;
    }
  }
}

async function runScheduledTick(env: Env): Promise<Response> {
  applyCloudflareEnv(env);

  const [{ processPendingSupabaseJobs, runSupabaseAutomationScheduler }, logger] = await Promise.all([
    import('./supabase-worker'),
    import('./logger'),
  ]);

  const schedulerStats = await runSupabaseAutomationScheduler();
  const stats = await processPendingSupabaseJobs();
  logger.info(
    `Cloudflare scheduled worker tick | scheduled_fetch:${schedulerStats.fetchJobsEnqueued} scheduled_publish:${schedulerStats.publishJobsEnqueued} stale_failed:${schedulerStats.staleJobsFailed} claimed:${stats.claimed} completed:${stats.completed} failed:${stats.failed}`
  );

  return Response.json({ ok: true, schedulerStats, stats });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledTick(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      applyCloudflareEnv(env);
      return Response.json({
        ok: true,
        service: 'oneclickpostfactory-agent',
        mode: 'cloudflare-scheduled-worker',
      });
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

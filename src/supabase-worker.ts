import * as crypto from 'node:crypto';

import config from '../config';

import * as ai from './ai';
import * as instagram from './instagram';
import * as linkedin from './linkedin';
import * as logger from './logger';
import * as threads from './threads';
import * as x from './x';
import {
  isSupabaseWorkerConfigured,
  supabaseDelete,
  supabaseInsert,
  supabaseSelect,
  supabaseUpdate,
} from './supabase-client';
import {
  decryptTenantCredentials,
  encryptCredential,
  type TenantCredentialRow,
  type TenantCredentials,
} from './tenant-credentials';

import type { AppConfig } from '../config';
import type { AngleCandidate, PlatformKey, RedditPost, SourceSummary } from './types';

type JobKind =
  | 'fetch_sources'
  | 'refresh_queue'
  | 'publish_now'
  | 'publish_all'
  | 'skip_slot'
  | 'release_slot';

type JsonMap = Record<string, unknown>;
type WorkerLevel = 'debug' | 'info' | 'warn' | 'error';

interface AgentJobRow {
  id: string;
  user_id: string;
  kind: string;
  payload: JsonMap | null;
  status: string;
  created_at: string;
}

interface ProfileRow {
  subscription_status?: string | null;
  current_period_end?: string | null;
  trial_ends_at?: string | null;
}

interface UserSettingsRow {
  ai_model?: string | null;
  posting_timezone?: string | null;
  threads_enabled?: boolean | null;
  instagram_enabled?: boolean | null;
  linkedin_enabled?: boolean | null;
  x_enabled?: boolean | null;
  facebook_enabled?: boolean | null;
}

interface UserSourceRow {
  id: string;
  user_id: string;
  kind: 'subreddit' | 'rss' | 'reddit_user';
  value: string;
  enabled: boolean;
}

interface QueueItemRow {
  id: string;
  user_id: string;
  slot_index: number;
  scheduled_for: string;
  platform: PlatformKey;
  status: string;
  draft_text?: string | null;
  instagram_image_url?: string | null;
  instagram_image_prompt?: string | null;
  source_url?: string | null;
  source_title?: string | null;
  angle?: string | null;
  angle_record_id?: string | null;
}

type AngleRecordStatus = 'unused' | 'in_progress' | 'drafted' | 'published' | 'rejected' | 'exhausted';

interface AngleRecordRow {
  id: string;
  user_id: string;
  angle: string;
  topic?: string | null;
  used_count?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  source_record_id?: string | null;
  source_reddit_post_id?: string | null;
  subreddit?: string | null;
  reddit_author?: string | null;
  source_url?: string | null;
  angle_title?: string | null;
  angle_summary?: string | null;
  intended_platform?: PlatformKey | null;
  status?: AngleRecordStatus | null;
  priority?: number | null;
}

interface TenantContext {
  userId: string;
  settings: UserSettingsRow;
  credentials: TenantCredentials;
  activePlatforms: PlatformKey[];
}

interface WorkerStats {
  claimed: number;
  completed: number;
  failed: number;
}

interface RedditAccessToken {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface RedditListingPayload {
  data?: {
    children?: Array<{ data?: Record<string, unknown> }>;
  };
}

class WorkerJobError extends Error {
  constructor(
    public readonly code: string,
    message = code,
    public readonly context?: JsonMap
  ) {
    super(message);
  }
}

const SUPPORTED_JOB_KINDS = new Set<JobKind>([
  'fetch_sources',
  'refresh_queue',
  'publish_now',
  'publish_all',
  'skip_slot',
  'release_slot',
]);

const SLOT_HOURS = [5, 7, 12, 15];
const ACTIVE_QUEUE_STATUSES = ['pending', 'ready', 'publishing'];
const ACTIVE_ANGLE_STATUSES: AngleRecordStatus[] = ['unused', 'in_progress'];
const REDDIT_TOKEN_SKEW_MS = 60_000;
const redditTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRedditUsername(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?reddit\.com\/user\//i, '')
    .replace(/^u\//i, '')
    .replace(/^@/, '')
    .split(/[/?#|]/)[0]
    .trim()
    .toLowerCase();
}

function normalizeSubreddit(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?reddit\.com\/r\//i, '')
    .replace(/^r\//i, '')
    .split(/[/?#|]/)[0]
    .trim()
    .toLowerCase();
}

function contentHashForPost(post: RedditPost): string {
  return crypto
    .createHash('sha256')
    .update([post.id, post.subreddit, post.author, post.title, post.selftext, post.url].join('\n'))
    .digest('hex');
}

function publicError(error: unknown): string {
  if (error instanceof WorkerJobError) return error.code;
  if (error instanceof Error) return error.message;
  return String(error);
}

function hasDateInFuture(value: string | null | undefined): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

async function writeWorkerLog(
  userId: string,
  level: WorkerLevel,
  message: string,
  context?: JsonMap
): Promise<void> {
  const payload = {
    user_id: userId,
    level,
    message,
    context: context || null,
  };

  try {
    await supabaseInsert('worker_logs', payload);
  } catch (error) {
    logger.warn(`Supabase worker log write failed: ${publicError(error)}`);
  }

  const logMessage = `[supabase-worker] ${message}`;
  if (level === 'error') logger.error(logMessage, context);
  else if (level === 'warn') logger.warn(logMessage, context);
  else logger.info(logMessage, context);
}

async function loadEntitlement(userId: string): Promise<{ canWrite: boolean; status: string; reason: string }> {
  const profile = (await supabaseSelect<ProfileRow>('profiles', {
    select: 'subscription_status,current_period_end,trial_ends_at',
    filters: [{ column: 'user_id', operator: 'eq', value: userId }],
    limit: 1,
  }))[0];

  const status = profile?.subscription_status || 'none';
  if (status === 'active') return { canWrite: true, status, reason: 'ok' };
  if (status === 'trialing' && (!profile?.trial_ends_at || hasDateInFuture(profile.trial_ends_at))) {
    return { canWrite: true, status, reason: 'ok' };
  }
  if (status === 'canceled' && hasDateInFuture(profile?.current_period_end)) {
    return { canWrite: true, status, reason: 'ok' };
  }
  if (status === 'past_due') return { canWrite: false, status, reason: 'past_due' };
  if (status === 'canceled') return { canWrite: false, status, reason: 'expired' };
  return { canWrite: false, status, reason: 'no_subscription' };
}

async function assertTenantEntitlement(job: AgentJobRow): Promise<void> {
  const entitlement = await loadEntitlement(job.user_id);
  if (entitlement.canWrite) return;

  await writeWorkerLog(job.user_id, 'warn', 'billing_inactive', {
    jobId: job.id,
    kind: job.kind,
    status: entitlement.status,
    reason: entitlement.reason,
  });
  throw new WorkerJobError('billing_inactive', 'billing_inactive', {
    status: entitlement.status,
    reason: entitlement.reason,
  });
}

async function loadTenantContext(userId: string): Promise<TenantContext> {
  const settings = (await supabaseSelect<UserSettingsRow>('user_settings', {
    select: '*',
    filters: [{ column: 'user_id', operator: 'eq', value: userId }],
    limit: 1,
  }))[0] || {};

  const credentialRow = (await supabaseSelect<TenantCredentialRow>('user_credentials', {
    select: '*',
    filters: [{ column: 'user_id', operator: 'eq', value: userId }],
    limit: 1,
  }))[0];

  const credentials = decryptTenantCredentials(credentialRow);
  const activePlatforms: PlatformKey[] = [];
  if (settings.threads_enabled ?? true) activePlatforms.push('threads');
  if (settings.instagram_enabled ?? true) activePlatforms.push('instagram');
  if (settings.linkedin_enabled ?? true) activePlatforms.push('linkedin');
  if (settings.x_enabled ?? false) activePlatforms.push('x');
  if (settings.facebook_enabled ?? false) activePlatforms.push('facebook');

  return {
    userId,
    settings,
    credentials,
    activePlatforms,
  };
}

function snapshotConfig(): Partial<AppConfig> {
  return {
    OPENAI_API_KEY: config.OPENAI_API_KEY,
    OPENAI_MODEL: config.OPENAI_MODEL,
    REDDIT_CLIENT_ID: config.REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET: config.REDDIT_CLIENT_SECRET,
    REDDIT_USER_AGENT: config.REDDIT_USER_AGENT,
    ENABLE_THREADS: config.ENABLE_THREADS,
    ENABLE_INSTAGRAM: config.ENABLE_INSTAGRAM,
    ENABLE_LINKEDIN: config.ENABLE_LINKEDIN,
    ENABLE_X: config.ENABLE_X,
    ENABLE_FACEBOOK: config.ENABLE_FACEBOOK,
    THREADS_ACCESS_TOKEN: config.THREADS_ACCESS_TOKEN,
    LINKEDIN_TOKEN: config.LINKEDIN_TOKEN,
    LINKEDIN_PERSON_URN: config.LINKEDIN_PERSON_URN,
    X_CLIENT_ID: config.X_CLIENT_ID,
    X_CLIENT_SECRET: config.X_CLIENT_SECRET,
    X_OAUTH2_ACCESS_TOKEN: config.X_OAUTH2_ACCESS_TOKEN,
    X_OAUTH2_REFRESH_TOKEN: config.X_OAUTH2_REFRESH_TOKEN,
    META_ACCESS_TOKEN: config.META_ACCESS_TOKEN,
    FACEBOOK_PAGE_ACCESS_TOKEN: config.FACEBOOK_PAGE_ACCESS_TOKEN,
    INSTAGRAM_ACCOUNT_ID: config.INSTAGRAM_ACCOUNT_ID,
    FACEBOOK_PAGE_ID: config.FACEBOOK_PAGE_ID,
    TIMEZONE: config.TIMEZONE,
  };
}

async function withTenantRuntime<T>(tenant: TenantContext, fn: () => Promise<T>): Promise<T> {
  const previous = snapshotConfig();
  const restoreXTokenPersistence = x.setOAuth2TokenPersistence(async tokens => {
    const patch: Record<string, unknown> = {
      x_oauth2_access_token_enc: encryptCredential(tokens.accessToken),
    };
    if (tokens.refreshToken) {
      patch.x_oauth2_refresh_token_enc = encryptCredential(tokens.refreshToken);
    }

    await supabaseUpdate('user_credentials', patch, {
      filters: [{ column: 'user_id', operator: 'eq', value: tenant.userId }],
    });
    await writeWorkerLog(tenant.userId, 'info', 'x_oauth2_tokens_refreshed', {
      accessTokenUpdated: true,
      refreshTokenUpdated: Boolean(tokens.refreshToken),
    });
  });
  config.OPENAI_API_KEY = tenant.credentials.openaiApiKey || previous.OPENAI_API_KEY || '';
  config.OPENAI_MODEL = tenant.settings.ai_model || 'gpt-4o-mini';
  config.REDDIT_CLIENT_ID = tenant.credentials.redditClientId || previous.REDDIT_CLIENT_ID || '';
  config.REDDIT_CLIENT_SECRET = tenant.credentials.redditClientSecret || previous.REDDIT_CLIENT_SECRET || '';
  config.REDDIT_USER_AGENT = previous.REDDIT_USER_AGENT || config.REDDIT_USER_AGENT;
  config.ENABLE_THREADS = tenant.activePlatforms.includes('threads');
  config.ENABLE_INSTAGRAM = tenant.activePlatforms.includes('instagram');
  config.ENABLE_LINKEDIN = tenant.activePlatforms.includes('linkedin');
  config.ENABLE_X = tenant.activePlatforms.includes('x');
  config.ENABLE_FACEBOOK = tenant.activePlatforms.includes('facebook');
  config.THREADS_ACCESS_TOKEN = tenant.credentials.threadsToken || '';
  config.LINKEDIN_TOKEN = tenant.credentials.linkedinToken || '';
  config.LINKEDIN_PERSON_URN = tenant.credentials.linkedinPersonUrn || '';
  config.X_CLIENT_ID = tenant.credentials.xClientId || '';
  config.X_CLIENT_SECRET = tenant.credentials.xClientSecret || '';
  config.X_OAUTH2_ACCESS_TOKEN = tenant.credentials.xOAuth2AccessToken || '';
  config.X_OAUTH2_REFRESH_TOKEN = tenant.credentials.xOAuth2RefreshToken || '';
  config.META_ACCESS_TOKEN = tenant.credentials.metaAccessToken || tenant.credentials.instagramToken || '';
  config.FACEBOOK_PAGE_ACCESS_TOKEN = tenant.credentials.facebookPageAccessToken || tenant.credentials.instagramToken || '';
  config.INSTAGRAM_ACCOUNT_ID = tenant.credentials.instagramAccountId || '';
  config.FACEBOOK_PAGE_ID = tenant.credentials.facebookPageId || '';
  config.TIMEZONE = tenant.settings.posting_timezone || previous.TIMEZONE || 'Europe/London';

  try {
    return await fn();
  } finally {
    restoreXTokenPersistence();
    Object.assign(config, previous);
  }
}

function assertSupportedJobKind(kind: string): asserts kind is JobKind {
  if (!SUPPORTED_JOB_KINDS.has(kind as JobKind)) {
    throw new WorkerJobError('unsupported_job_kind', `Unsupported job kind: ${kind}`, { kind });
  }
}

async function listPendingJobs(): Promise<AgentJobRow[]> {
  return supabaseSelect<AgentJobRow>('agent_jobs', {
    select: '*',
    filters: [{ column: 'status', operator: 'eq', value: 'pending' }],
    order: 'created_at.asc',
    limit: Math.max(1, Math.min(config.SUPABASE_WORKER_BATCH_SIZE || 10, 50)),
  });
}

async function claimJob(job: AgentJobRow): Promise<AgentJobRow | null> {
  const claimed = await supabaseUpdate<AgentJobRow>('agent_jobs', {
    status: 'running',
    started_at: nowIso(),
    completed_at: null,
    error: null,
    result: null,
  }, {
    filters: [
      { column: 'id', operator: 'eq', value: job.id },
      { column: 'status', operator: 'eq', value: 'pending' },
    ],
    returning: true,
  });
  return claimed[0] || null;
}

async function completeJob(job: AgentJobRow, result: JsonMap): Promise<void> {
  await supabaseUpdate('agent_jobs', {
    status: 'completed',
    completed_at: nowIso(),
    result,
    error: null,
  }, {
    filters: [
      { column: 'id', operator: 'eq', value: job.id },
      { column: 'user_id', operator: 'eq', value: job.user_id },
    ],
  });
}

async function failJob(job: AgentJobRow, error: unknown): Promise<void> {
  const message = publicError(error);
  await writeWorkerLog(job.user_id, 'error', message, {
    jobId: job.id,
    kind: job.kind,
  });
  await supabaseUpdate('agent_jobs', {
    status: 'failed',
    completed_at: nowIso(),
    error: message,
  }, {
    filters: [
      { column: 'id', operator: 'eq', value: job.id },
      { column: 'user_id', operator: 'eq', value: job.user_id },
    ],
  });
}

function hashId(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function firstXmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return decodeXml(match?.[1] || '');
}

function parseRss(xml: string, sourceUrl: string): RedditPost[] {
  const itemBlocks = [...xml.matchAll(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi)]
    .map(match => match[0])
    .slice(0, 20);

  return itemBlocks.map(block => {
    const title = firstXmlTag(block, 'title') || 'Untitled RSS item';
    const link = firstXmlTag(block, 'link') || sourceUrl;
    const description = firstXmlTag(block, 'description') || firstXmlTag(block, 'summary') || '';
    const published = firstXmlTag(block, 'pubDate') || firstXmlTag(block, 'published') || firstXmlTag(block, 'updated');
    return {
      id: hashId(`${sourceUrl}:${link}:${title}`),
      title,
      selftext: description,
      url: link,
      score: 0,
      comments: 0,
      subreddit: 'rss',
      author: sourceUrl,
      created: published ? Date.parse(published) / 1000 || Date.now() / 1000 : Date.now() / 1000,
    };
  });
}

function redditUserAgent(): string {
  return config.REDDIT_USER_AGENT.trim() || 'oneclickpostfactory-agent/1.0';
}

function redditOauthListingUrl(publicUrl: string): string {
  const parsed = new URL(publicUrl);
  const path = parsed.pathname.replace(/\.json$/i, '');
  return `https://oauth.reddit.com${path}${parsed.search}`;
}

function parseRedditListing(payload: RedditListingPayload): RedditPost[] {
  return (payload.data?.children || [])
    .map(child => child.data || {})
    .filter(post => !post.stickied && !post.is_video)
    .map(post => ({
      id: String(post.id || hashId(String(post.url || post.title || Math.random()))),
      title: String(post.title || ''),
      selftext: String(post.selftext || ''),
      url: String(post.url || ''),
      score: Number(post.score || 0),
      comments: Number(post.num_comments || 0),
      subreddit: String(post.subreddit || ''),
      author: String(post.author || ''),
      created: Number(post.created_utc || Date.now() / 1000),
    }));
}

async function redditResponseError(response: Response, prefix: string): Promise<Error> {
  let body = '';
  try {
    body = (await response.text()).replace(/\s+/g, ' ').slice(0, 220);
  } catch {
    body = '';
  }
  return new Error(body ? `${prefix} ${response.status}: ${body}` : `${prefix} ${response.status}`);
}

async function getRedditAccessToken(): Promise<string> {
  const clientId = config.REDDIT_CLIENT_ID.trim();
  const clientSecret = config.REDDIT_CLIENT_SECRET.trim();
  if (!clientId || !clientSecret) {
    throw new Error('reddit_oauth_credentials_missing');
  }

  const cached = redditTokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now() + REDDIT_TOKEN_SKEW_MS) {
    return cached.accessToken;
  }

  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': redditUserAgent(),
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    signal: AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await redditResponseError(response, 'Reddit OAuth HTTP');
  }

  const token = await response.json() as RedditAccessToken;
  if (!token.access_token) {
    throw new Error('reddit_oauth_token_missing');
  }

  const expiresInMs = Math.max(60, Number(token.expires_in || 3600)) * 1000;
  redditTokenCache.set(clientId, {
    accessToken: token.access_token,
    expiresAt: Date.now() + expiresInMs,
  });
  return token.access_token;
}

async function fetchRedditListing(url: string): Promise<RedditPost[]> {
  const headers: Record<string, string> = {
    'User-Agent': redditUserAgent(),
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  };

  let requestUrl = url;
  if (config.REDDIT_CLIENT_ID.trim() && config.REDDIT_CLIENT_SECRET.trim()) {
    headers.Authorization = `Bearer ${await getRedditAccessToken()}`;
    requestUrl = redditOauthListingUrl(url);
  } else if (process.env.CF_WORKER_RUNTIME === 'true') {
    throw new Error('reddit_oauth_credentials_missing');
  }

  const response = await fetch(requestUrl, {
    headers,
    signal: AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await redditResponseError(response, 'Reddit HTTP');
  }
  return parseRedditListing(await response.json() as RedditListingPayload);
}

async function fetchTenantSourcePosts(source: UserSourceRow, userId?: string, jobId?: string): Promise<RedditPost[]> {
  const value = source.value.trim();
  if (!value) return [];

  if (source.kind === 'subreddit') {
    const sub = normalizeSubreddit(value);
    if (!sub) return [];
    return fetchRedditListing(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=20&raw_json=1`);
  }

  if (source.kind === 'reddit_user') {
    const [rawUser, rawSubs] = value.split('|').map(part => part.trim());
    const user = normalizeRedditUsername(rawUser);
    const subs = (rawSubs || '')
      .split(',')
      .map(sub => normalizeSubreddit(sub))
      .filter(Boolean);

    if (subs.length) {
      const listings: RedditPost[][] = [];
      for (const sub of subs) {
        try {
          const posts = await fetchRedditListing(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=50&raw_json=1`);
          listings.push(posts);
          if (userId && jobId) {
            await writeWorkerLog(userId, 'info', 'reddit_subreddit_fetched', {
              jobId,
              sourceId: source.id,
              subreddit: sub,
              posts: posts.length,
            });
          }
        } catch (error) {
          listings.push([]);
          if (userId && jobId) {
            await writeWorkerLog(userId, 'warn', 'reddit_subreddit_fetch_failed', {
              jobId,
              sourceId: source.id,
              subreddit: sub,
              error: publicError(error),
            });
          }
        }
      }
      const seen = new Set<string>();
      const filtered = listings
        .flat()
        .filter(post => post.author.toLowerCase() === user)
        .sort((a, b) => b.created - a.created)
        .filter(post => {
          if (seen.has(post.id)) return false;
          seen.add(post.id);
          return true;
        });
      if (userId && jobId) {
        await writeWorkerLog(userId, 'info', 'reddit_author_filter_applied', {
          jobId,
          sourceId: source.id,
          author: user,
          subreddits: subs,
          matches: filtered.length,
        });
      }
      return filtered;
    }

    await writeWorkerLog(userId || source.user_id, 'warn', 'reddit_author_source_missing_subreddits', {
      jobId,
      sourceId: source.id,
    });
    return [];
  }

  const response = await fetch(value, {
    headers: {
      'User-Agent': 'oneclickpostfactory-supabase-worker/1.0',
      Accept: 'application/rss+xml, application/atom+xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`RSS HTTP ${response.status}`);
  }
  return parseRss(await response.text(), value);
}

function canonicalSourceUrl(post: RedditPost): string {
  if (post.subreddit && post.id && post.subreddit !== 'rss') {
    return `https://www.reddit.com/r/${post.subreddit}/comments/${post.id}`;
  }
  return post.url || `urn:source:${post.id}`;
}

function getPlatformDraftText(
  draft: Awaited<ReturnType<typeof ai.draftPlatforms>>,
  platform: PlatformKey
): string {
  switch (platform) {
    case 'threads':
      return draft.threads;
    case 'x':
      return draft.x;
    case 'instagram':
      return draft.instagram;
    case 'linkedin':
      return draft.linkedin;
    case 'facebook':
      return draft.facebook;
  }
}

function nextScheduledFor(slotIndex: number): string {
  const now = new Date();
  const scheduled = new Date(now);
  scheduled.setHours(SLOT_HOURS[slotIndex] || 9, 0, 0, 0);
  if (scheduled.getTime() <= now.getTime()) {
    scheduled.setDate(scheduled.getDate() + 1);
  }
  return scheduled.toISOString();
}

async function loadActiveSlotIndexes(userId: string): Promise<Set<number>> {
  const rows = await supabaseSelect<QueueItemRow>('queue_items', {
    select: 'slot_index,status',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'status', operator: 'in', value: ACTIVE_QUEUE_STATUSES },
    ],
    limit: 100,
  });
  return new Set(rows.map(row => Number(row.slot_index)));
}

function firstOpenSlot(occupied: Set<number>): number | undefined {
  return [0, 1, 2, 3].find(slot => !occupied.has(slot));
}

async function loadExistingSourceUrls(userId: string): Promise<Set<string>> {
  const rows = await supabaseSelect<{ url: string }>('source_records', {
    select: 'url',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'status', operator: 'neq', value: 'rejected' },
    ],
    limit: 1000,
  });
  return new Set(rows.map(row => row.url));
}

async function loadExistingSourceRecord(
  userId: string,
  url: string
): Promise<{ id: string; status?: string | null } | undefined> {
  return (await supabaseSelect<{ id: string; status?: string | null }>('source_records', {
    select: 'id,status',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'url', operator: 'eq', value: url },
    ],
    limit: 1,
  }))[0];
}

async function hasActiveBankedAngles(userId: string): Promise<boolean> {
  const rows = await supabaseSelect<{ id: string }>('angle_records', {
    select: 'id',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'status', operator: 'in', value: ACTIVE_ANGLE_STATUSES },
    ],
    limit: 1,
  });
  return rows.length > 0;
}

function tenantRedditConfig(sources: UserSourceRow[]): {
  author: string;
  subredditSources: UserSourceRow[];
  nonRedditSources: UserSourceRow[];
} {
  const author = normalizeRedditUsername(
    sources.find(source => source.kind === 'reddit_user')?.value.split('|')[0]
  );
  const subredditSources = sources
    .filter(source => source.kind === 'subreddit')
    .map(source => ({ ...source, value: normalizeSubreddit(source.value) }))
    .filter(source => source.value);
  const nonRedditSources = sources.filter(source => source.kind === 'rss');

  return { author, subredditSources, nonRedditSources };
}

function toQueueRows(
  userId: string,
  slotIndex: number,
  post: RedditPost,
  sourceUrl: string,
  angle: AngleCandidate,
  draft: Awaited<ReturnType<typeof ai.draftPlatforms>>,
  platforms: PlatformKey[],
  angleRecordId?: string
): Array<Record<string, unknown>> {
  const scheduledFor = nextScheduledFor(slotIndex);
  return platforms
    .map(platform => ({
      user_id: userId,
      slot_index: slotIndex,
      scheduled_for: scheduledFor,
      platform,
      status: 'ready',
      draft_text: getPlatformDraftText(draft, platform),
      instagram_image_url: platform === 'instagram' ? draft.imageUrl || null : null,
      instagram_image_prompt: platform === 'instagram' ? draft.imagePrompt || null : null,
      source_url: sourceUrl,
      source_title: post.title,
      angle: angle.thesis,
      angle_record_id: angleRecordId || null,
      error_message: null,
    }))
    .filter(row => String(row.draft_text || '').trim());
}

function toAngleCandidateFromRecord(row: AngleRecordRow): AngleCandidate {
  const title = row.angle_title || row.topic || '';
  const thesis = row.angle_summary || row.angle;
  const [fallbackLabel, ...fallbackThesisParts] = row.angle.split(':');
  const fallbackThesis = fallbackThesisParts.join(':').trim() || row.angle;
  return {
    label: title.trim() || fallbackLabel.trim() || 'Banked angle',
    thesis: thesis.trim() || fallbackThesis,
    hook: thesis.trim() || fallbackThesis,
    supportingPoints: [],
    practicalConsequence: thesis.trim() || fallbackThesis,
    specificExample: '',
    audienceFit: 'builders',
    strength: Math.max(1, Math.min(5, Math.round(Number(row.priority || 4)))),
  };
}

function anglePlatform(row: AngleRecordRow, tenant: TenantContext): PlatformKey | undefined {
  return row.intended_platform && tenant.activePlatforms.includes(row.intended_platform)
    ? row.intended_platform
    : undefined;
}

function isDraftableAngle(row: AngleRecordRow): boolean {
  return Boolean(
    row.source_reddit_post_id
    && row.source_url
    && row.subreddit
    && row.reddit_author
    && row.intended_platform
  );
}

async function queueFromBankedAngles(
  job: AgentJobRow,
  tenant: TenantContext,
  occupiedSlots: Set<number>
): Promise<number> {
  const slotIndex = firstOpenSlot(occupiedSlots);
  if (slotIndex === undefined) return 0;

  const angles = await supabaseSelect<AngleRecordRow>('angle_records', {
    select: '*',
    filters: [
      { column: 'user_id', operator: 'eq', value: job.user_id },
      { column: 'status', operator: 'in', value: ACTIVE_ANGLE_STATUSES },
    ],
    order: 'created_at.asc',
    limit: 20,
  });

  for (const angleRow of angles) {
    const platform = anglePlatform(angleRow, tenant);
    if (!platform || !isDraftableAngle(angleRow)) {
      await supabaseUpdate('angle_records', {
        status: 'rejected',
      }, {
        filters: [
          { column: 'id', operator: 'eq', value: angleRow.id },
          { column: 'user_id', operator: 'eq', value: job.user_id },
        ],
      });
      await writeWorkerLog(job.user_id, 'warn', 'legacy_angle_quarantined', {
        jobId: job.id,
        angleId: angleRow.id,
        reason: !platform ? 'disabled_or_missing_platform' : 'missing_source_metadata',
      });
      continue;
    }

    const locked = await supabaseUpdate<AngleRecordRow>('angle_records', {
      status: 'in_progress',
    }, {
      filters: [
        { column: 'id', operator: 'eq', value: angleRow.id },
        { column: 'user_id', operator: 'eq', value: job.user_id },
        { column: 'status', operator: 'in', value: ACTIVE_ANGLE_STATUSES },
      ],
      returning: true,
    });
    const currentAngle = locked[0];
    if (!currentAngle) continue;

    const selectedAngle = toAngleCandidateFromRecord(currentAngle);
    const post: RedditPost = {
      id: currentAngle.source_reddit_post_id || currentAngle.id,
      title: currentAngle.topic || selectedAngle.label,
      selftext: selectedAngle.thesis,
      url: currentAngle.source_url || '',
      score: 0,
      comments: 0,
      subreddit: currentAngle.subreddit || 'banked',
      author: currentAngle.reddit_author || '',
      created: Date.parse(currentAngle.created_at || '') / 1000 || Date.now() / 1000,
    };
    const summary: SourceSummary = {
      source_type: 'reddit_post',
      topic: currentAngle.topic || selectedAngle.label,
      core_claim: selectedAngle.thesis,
      surface_problem: selectedAngle.thesis,
      deeper_problem: selectedAngle.practicalConsequence || selectedAngle.thesis,
      practical_consequence: selectedAngle.practicalConsequence || selectedAngle.thesis,
      specific_example: selectedAngle.specificExample || '',
      best_line: selectedAngle.hook || selectedAngle.thesis,
      audience_fit: selectedAngle.audienceFit || 'builders',
      tone_source: '',
      cta_goal: '',
    };

    try {
      const draft = await ai.draftPlatforms(
        post,
        summary,
        selectedAngle,
        [platform],
        { disableLearningMemory: true, disableImageGeneration: true }
      );
      const rows = toQueueRows(
        job.user_id,
        slotIndex,
        post,
        currentAngle.source_url || `banked-angle:${currentAngle.id}`,
        selectedAngle,
        draft,
        [platform],
        currentAngle.id
      );
      if (!rows.length) {
        await supabaseUpdate('angle_records', { status: 'exhausted' }, {
          filters: [
            { column: 'id', operator: 'eq', value: currentAngle.id },
            { column: 'user_id', operator: 'eq', value: job.user_id },
          ],
        });
        continue;
      }

      await supabaseInsert('queue_items', rows);
      await supabaseUpdate('angle_records', {
        status: 'drafted',
        used_count: (currentAngle.used_count || 0) + 1,
        last_used_at: nowIso(),
      }, {
        filters: [
          { column: 'id', operator: 'eq', value: currentAngle.id },
          { column: 'user_id', operator: 'eq', value: job.user_id },
        ],
      });
      occupiedSlots.add(slotIndex);
      await writeWorkerLog(job.user_id, 'info', 'queued_banked_angle', {
        jobId: job.id,
        slotIndex,
        angleId: currentAngle.id,
        platforms: rows.map(row => row.platform),
      });
      return rows.length;
    } catch (error) {
      await supabaseUpdate('angle_records', {
        status: 'unused',
      }, {
        filters: [
          { column: 'id', operator: 'eq', value: currentAngle.id },
          { column: 'user_id', operator: 'eq', value: job.user_id },
        ],
      });
      await writeWorkerLog(job.user_id, 'warn', 'banked_angle_draft_failed', {
        jobId: job.id,
        angleId: currentAngle.id,
        error: publicError(error),
      });
    }
  }

  return 0;
}

async function handleRefreshQueue(job: AgentJobRow, tenant: TenantContext): Promise<JsonMap> {
  if (!config.OPENAI_API_KEY) {
    throw new WorkerJobError('openai_api_key_missing', 'openai_api_key_missing');
  }
  if (!tenant.activePlatforms.length) {
    throw new WorkerJobError('no_enabled_platforms', 'no_enabled_platforms');
  }

  const sources = await supabaseSelect<UserSourceRow>('user_sources', {
    select: '*',
    filters: [
      { column: 'user_id', operator: 'eq', value: job.user_id },
      { column: 'enabled', operator: 'eq', value: true },
    ],
    order: 'created_at.asc',
    limit: 100,
  });
  if (!sources.length) {
    throw new WorkerJobError('no_enabled_sources', 'no_enabled_sources');
  }

  const occupiedSlots = await loadActiveSlotIndexes(job.user_id);
  let queued = 0;

  if (firstOpenSlot(occupiedSlots) !== undefined && await hasActiveBankedAngles(job.user_id)) {
    queued += await queueFromBankedAngles(job, tenant, occupiedSlots);
    return { fetched: 0, banked: 0, queued, deferredFetch: true };
  }

  const existingSourceUrls = await loadExistingSourceUrls(job.user_id);
  const { author: redditAuthorFilter, subredditSources, nonRedditSources } = tenantRedditConfig(sources);
  if (subredditSources.length && !redditAuthorFilter) {
    await writeWorkerLog(job.user_id, 'warn', 'reddit_author_filter_missing', {
      jobId: job.id,
      subredditSources: subredditSources.length,
    });
    throw new WorkerJobError('reddit_author_filter_missing', 'reddit_author_filter_missing');
  }

  const processingSources = [
    ...subredditSources,
    ...nonRedditSources,
  ];
  if (!processingSources.length) {
    throw new WorkerJobError('no_processable_sources', 'no_processable_sources');
  }

  let fetched = 0;
  let banked = 0;

  for (const source of processingSources) {
    if (firstOpenSlot(occupiedSlots) === undefined) break;

    try {
      const posts = await fetchTenantSourcePosts(source, job.user_id, job.id);
      const sourcePosts = source.kind === 'subreddit' && redditAuthorFilter
        ? posts.filter(post => normalizeRedditUsername(post.author) === redditAuthorFilter)
        : posts;
      fetched += sourcePosts.length;

      for (const post of sourcePosts) {
        if (firstOpenSlot(occupiedSlots) === undefined) break;

        const sourceUrl = canonicalSourceUrl(post);
        if (existingSourceUrls.has(sourceUrl)) continue;

        const extraction = await ai.extractSourceBank(post);
        const sourcePayload = {
          user_id: job.user_id,
          url: sourceUrl,
          title: post.title || null,
          origin: source.kind,
          score: post.score || null,
          reddit_post_id: post.id || null,
          subreddit: post.subreddit || null,
          reddit_author: normalizeRedditUsername(post.author) || null,
          content_hash: contentHashForPost(post),
          status: 'banked',
          used: false,
          fetched_at: nowIso(),
        };
        const existingSource = await loadExistingSourceRecord(job.user_id, sourceUrl);
        const sourceRows = existingSource?.status === 'rejected'
          ? await supabaseUpdate<{ id: string }>('source_records', sourcePayload, {
              filters: [
                { column: 'id', operator: 'eq', value: existingSource.id },
                { column: 'user_id', operator: 'eq', value: job.user_id },
              ],
              returning: true,
            })
          : await supabaseInsert<{ id: string }>('source_records', sourcePayload, true);
        const sourceRecordId = sourceRows[0]?.id || null;
        existingSourceUrls.add(sourceUrl);

        const angles = extraction.angles.slice(0, 5);
        if (!angles.length) continue;

        const angleRows = angles.flatMap(angle => tenant.activePlatforms.map(platform => ({
          user_id: job.user_id,
          source_record_id: sourceRecordId,
          source_reddit_post_id: post.id,
          subreddit: post.subreddit || null,
          reddit_author: normalizeRedditUsername(post.author) || null,
          source_url: sourceUrl,
          angle: `${angle.label}: ${angle.thesis}`,
          angle_title: angle.label,
          angle_summary: angle.thesis,
          intended_platform: platform,
          status: 'unused',
          priority: angle.strength || null,
          topic: extraction.summary.topic || post.title || null,
          used_count: 0,
          last_used_at: null,
        })));

        await supabaseInsert('angle_records', angleRows);
        banked += angleRows.length;

        queued += await queueFromBankedAngles(job, tenant, occupiedSlots);
        await writeWorkerLog(job.user_id, 'info', 'source_banked_angles', {
          jobId: job.id,
          sourceId: source.id,
          sourceUrl,
          angleCount: angleRows.length,
        });

        if (queued > 0 || await hasActiveBankedAngles(job.user_id)) break;
      }
    } catch (error) {
      await writeWorkerLog(job.user_id, 'warn', 'source_fetch_or_draft_failed', {
        jobId: job.id,
        sourceId: source.id,
        kind: source.kind,
        error: publicError(error),
      });
    }

    if (queued > 0 || await hasActiveBankedAngles(job.user_id)) break;
  }

  if (queued === 0 && firstOpenSlot(occupiedSlots) !== undefined) {
    queued += await queueFromBankedAngles(job, tenant, occupiedSlots);
  }

  return { fetched, banked, queued };
}

function requirePayloadId(payload: JsonMap | null, key: string): string {
  const value = payload?.[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkerJobError('missing_payload_id', `${key} is required`, { key });
  }
  return value;
}

function payloadSlotIndex(payload: JsonMap | null): number | undefined {
  const value = payload?.slot_index;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) {
    return undefined;
  }
  return value;
}

async function publishPlatform(row: QueueItemRow): Promise<string> {
  const text = row.draft_text?.trim();
  if (!text) {
    throw new WorkerJobError('draft_text_missing', 'draft_text_missing');
  }

  switch (row.platform) {
    case 'threads':
      return threads.publish(text);
    case 'x':
      return x.publish(text);
    case 'linkedin':
      return linkedin.publish(text);
    case 'instagram':
      if (!row.instagram_image_url?.trim()) {
        throw new WorkerJobError('instagram_image_url_missing', 'instagram_image_url_missing');
      }
      return instagram.publish(text, row.instagram_image_url);
    case 'facebook':
      throw new WorkerJobError('facebook_paused', 'facebook_paused');
  }
}

async function publishQueueRow(job: AgentJobRow, row: QueueItemRow): Promise<JsonMap> {
  const locked = await supabaseUpdate<QueueItemRow>('queue_items', {
    status: 'publishing',
    error_message: null,
  }, {
    filters: [
      { column: 'id', operator: 'eq', value: row.id },
      { column: 'user_id', operator: 'eq', value: job.user_id },
      { column: 'status', operator: 'in', value: ['pending', 'ready', 'failed'] },
    ],
    returning: true,
  });

  let current = locked[0];
  if (!current) {
    throw new WorkerJobError('queue_item_not_available', 'queue_item_not_available', { queueItemId: row.id });
  }

  try {
    if (current.platform === 'instagram' && !current.instagram_image_url?.trim()) {
      const image = await ai.generateInstagramImageFromText(
        current.source_title || current.angle || 'Instagram post',
        current.draft_text || ''
      );
      const patched = await supabaseUpdate<QueueItemRow>('queue_items', {
        instagram_image_url: image.imageUrl,
        instagram_image_prompt: current.instagram_image_prompt || image.imagePrompt,
      }, {
        filters: [
          { column: 'id', operator: 'eq', value: current.id },
          { column: 'user_id', operator: 'eq', value: job.user_id },
        ],
        returning: true,
      });
      current = patched[0] || {
        ...current,
        instagram_image_url: image.imageUrl,
        instagram_image_prompt: current.instagram_image_prompt || image.imagePrompt,
      };
    }

    const externalPostId = await publishPlatform(current);
    await supabaseUpdate('queue_items', {
      status: 'published',
      error_message: null,
    }, {
      filters: [
        { column: 'id', operator: 'eq', value: current.id },
        { column: 'user_id', operator: 'eq', value: job.user_id },
      ],
    });
    await supabaseInsert('publish_history', {
      user_id: job.user_id,
      platform: current.platform,
      post_text: current.draft_text || null,
      external_post_id: externalPostId,
      source_url: current.source_url || null,
      published_at: nowIso(),
    });
    if (current.angle_record_id) {
      await supabaseUpdate('angle_records', {
        status: 'published',
        last_used_at: nowIso(),
      }, {
        filters: [
          { column: 'id', operator: 'eq', value: current.angle_record_id },
          { column: 'user_id', operator: 'eq', value: job.user_id },
        ],
      });
    }
    await writeWorkerLog(job.user_id, 'info', 'published_queue_item', {
      jobId: job.id,
      queueItemId: current.id,
      platform: current.platform,
      externalPostId,
    });
    return { queueItemId: current.id, platform: current.platform, externalPostId };
  } catch (error) {
    const message = publicError(error);
    await supabaseUpdate('queue_items', {
      status: 'failed',
      error_message: message,
    }, {
      filters: [
        { column: 'id', operator: 'eq', value: current.id },
        { column: 'user_id', operator: 'eq', value: job.user_id },
      ],
    });
    throw error;
  }
}

async function handlePublishNow(job: AgentJobRow): Promise<JsonMap> {
  const queueItemId = requirePayloadId(job.payload, 'queue_item_id');
  const row = (await supabaseSelect<QueueItemRow>('queue_items', {
    select: '*',
    filters: [
      { column: 'id', operator: 'eq', value: queueItemId },
      { column: 'user_id', operator: 'eq', value: job.user_id },
    ],
    limit: 1,
  }))[0];
  if (!row) {
    throw new WorkerJobError('queue_item_not_found', 'queue_item_not_found', { queueItemId });
  }
  return publishQueueRow(job, row);
}

async function handlePublishAll(job: AgentJobRow): Promise<JsonMap> {
  const rows = await supabaseSelect<QueueItemRow>('queue_items', {
    select: '*',
    filters: [
      { column: 'user_id', operator: 'eq', value: job.user_id },
      { column: 'status', operator: 'in', value: ['pending', 'ready'] },
    ],
    order: 'scheduled_for.asc',
    limit: 100,
  });

  const published: JsonMap[] = [];
  const failures: JsonMap[] = [];
  for (const row of rows) {
    try {
      published.push(await publishQueueRow(job, row));
    } catch (error) {
      failures.push({
        queueItemId: row.id,
        platform: row.platform,
        error: publicError(error),
      });
    }
  }

  if (failures.length) {
    throw new WorkerJobError('publish_all_failed', 'publish_all_failed', {
      published,
      failures,
    });
  }

  return { published, failures };
}

async function handleSkipSlot(job: AgentJobRow): Promise<JsonMap> {
  const queueItemId = typeof job.payload?.queue_item_id === 'string'
    ? job.payload.queue_item_id
    : undefined;
  const slotIndex = payloadSlotIndex(job.payload);

  const filters = [
    { column: 'user_id', operator: 'eq' as const, value: job.user_id },
    ...(queueItemId
      ? [{ column: 'id', operator: 'eq' as const, value: queueItemId }]
      : []),
    ...(slotIndex !== undefined
      ? [{ column: 'slot_index', operator: 'eq' as const, value: slotIndex }]
      : []),
  ];
  if (!queueItemId && slotIndex === undefined) {
    throw new WorkerJobError('missing_queue_target', 'queue_item_id or slot_index is required');
  }

  const rows = await supabaseUpdate<QueueItemRow>('queue_items', {
    status: 'skipped',
    error_message: null,
  }, {
    filters,
    returning: true,
  });
  for (const row of rows) {
    if (!row.angle_record_id) continue;
    await supabaseUpdate('angle_records', {
      status: 'rejected',
    }, {
      filters: [
        { column: 'id', operator: 'eq', value: row.angle_record_id },
        { column: 'user_id', operator: 'eq', value: job.user_id },
      ],
    });
  }
  return { skipped: rows.length };
}

async function handleReleaseSlot(job: AgentJobRow): Promise<JsonMap> {
  const queueItemId = typeof job.payload?.queue_item_id === 'string'
    ? job.payload.queue_item_id
    : undefined;
  const slotIndex = payloadSlotIndex(job.payload);

  const filters = [
    { column: 'user_id', operator: 'eq' as const, value: job.user_id },
    ...(queueItemId
      ? [{ column: 'id', operator: 'eq' as const, value: queueItemId }]
      : []),
    ...(slotIndex !== undefined
      ? [{ column: 'slot_index', operator: 'eq' as const, value: slotIndex }]
      : []),
  ];
  if (!queueItemId && slotIndex === undefined) {
    throw new WorkerJobError('missing_queue_target', 'queue_item_id or slot_index is required');
  }

  const rows = await supabaseDelete<QueueItemRow>('queue_items', {
    filters,
    returning: true,
  });
  for (const row of rows) {
    if (!row.angle_record_id) continue;
    await supabaseUpdate('angle_records', {
      status: 'unused',
    }, {
      filters: [
        { column: 'id', operator: 'eq', value: row.angle_record_id },
        { column: 'user_id', operator: 'eq', value: job.user_id },
      ],
    });
  }
  return { released: rows.length };
}

async function handleClaimedJob(job: AgentJobRow): Promise<JsonMap> {
  assertSupportedJobKind(job.kind);
  await assertTenantEntitlement(job);
  const tenant = await loadTenantContext(job.user_id);
  const kind = job.kind as JobKind;

  return withTenantRuntime(tenant, async () => {
    await writeWorkerLog(job.user_id, 'info', 'job_started', {
      jobId: job.id,
      kind: job.kind,
    });

    switch (kind) {
      case 'fetch_sources':
      case 'refresh_queue':
        return handleRefreshQueue(job, tenant);
      case 'publish_now':
        return handlePublishNow(job);
      case 'publish_all':
        return handlePublishAll(job);
      case 'skip_slot':
        return handleSkipSlot(job);
      case 'release_slot':
        return handleReleaseSlot(job);
    }

    throw new WorkerJobError('unsupported_job_kind', `Unsupported job kind: ${job.kind}`, { kind: job.kind });
  });
}

export async function processPendingSupabaseJobs(): Promise<WorkerStats> {
  const stats: WorkerStats = { claimed: 0, completed: 0, failed: 0 };
  const jobs = await listPendingJobs();

  for (const pendingJob of jobs) {
    const job = await claimJob(pendingJob);
    if (!job) continue;

    stats.claimed++;
    try {
      const result = await handleClaimedJob(job);
      await completeJob(job, result);
      stats.completed++;
      await writeWorkerLog(job.user_id, 'info', 'job_completed', {
        jobId: job.id,
        kind: job.kind,
        result,
      });
    } catch (error) {
      await failJob(job, error);
      stats.failed++;
    }
  }

  return stats;
}

export function startSupabaseWorkerLoop(log = logger): { stop: () => void } | undefined {
  if (!isSupabaseWorkerConfigured()) {
    log.info(
      'Supabase SaaS worker disabled | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY/SERVICE_ROLE_KEY, or CREDENTIAL_ENCRYPTION_KEY is not configured'
    );
    return undefined;
  }

  let running = false;
  const intervalMs = Math.max(1000, config.SUPABASE_WORKER_POLL_INTERVAL_MS || 10000);

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const stats = await processPendingSupabaseJobs();
      if (stats.claimed) {
        log.info(
          `Supabase SaaS worker tick | claimed:${stats.claimed} completed:${stats.completed} failed:${stats.failed}`
        );
      }
    } catch (error) {
      log.error(`Supabase SaaS worker tick failed: ${publicError(error)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();
  log.info(`Supabase SaaS worker polling agent_jobs every ${intervalMs}ms`);

  return {
    stop: () => clearInterval(timer),
  };
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  startSupabaseWorkerLoop();
}

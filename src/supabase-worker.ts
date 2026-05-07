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

function nowIso(): string {
  return new Date().toISOString();
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
  config.OPENAI_MODEL = tenant.settings.ai_model || previous.OPENAI_MODEL || 'gpt-4o-mini';
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

async function fetchRedditListing(url: string): Promise<RedditPost[]> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'oneclickpostfactory-supabase-worker/1.0',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Reddit HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    data?: {
      children?: Array<{ data?: Record<string, unknown> }>;
    };
  };
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

async function fetchTenantSourcePosts(source: UserSourceRow): Promise<RedditPost[]> {
  const value = source.value.trim();
  if (!value) return [];

  if (source.kind === 'subreddit') {
    const sub = value.replace(/^r\//i, '');
    return fetchRedditListing(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=20&raw_json=1`);
  }

  if (source.kind === 'reddit_user') {
    const [rawUser, rawSubs] = value.split('|').map(part => part.trim());
    const user = rawUser.replace(/^u\//i, '').toLowerCase();
    const subs = (rawSubs || '')
      .split(',')
      .map(sub => sub.trim().replace(/^r\//i, ''))
      .filter(Boolean);

    if (subs.length) {
      const listings: RedditPost[][] = [];
      for (const sub of subs) {
        try {
          listings.push(
            await fetchRedditListing(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=50&raw_json=1`)
          );
        } catch {
          listings.push([]);
        }
      }
      const seen = new Set<string>();
      return listings
        .flat()
        .filter(post => post.author.toLowerCase() === user)
        .sort((a, b) => b.created - a.created)
        .filter(post => {
          if (seen.has(post.id)) return false;
          seen.add(post.id);
          return true;
        });
    }

    return fetchRedditListing(`https://www.reddit.com/user/${encodeURIComponent(user)}/submitted.json?limit=20&raw_json=1`);
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
    filters: [{ column: 'user_id', operator: 'eq', value: userId }],
    limit: 1000,
  });
  return new Set(rows.map(row => row.url));
}

function toQueueRows(
  userId: string,
  slotIndex: number,
  post: RedditPost,
  sourceUrl: string,
  angle: AngleCandidate,
  draft: Awaited<ReturnType<typeof ai.draftPlatforms>>,
  platforms: PlatformKey[]
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
      error_message: null,
    }))
    .filter(row => String(row.draft_text || '').trim());
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
  const existingSourceUrls = await loadExistingSourceUrls(job.user_id);
  let fetched = 0;
  let banked = 0;
  let queued = 0;

  for (const source of sources) {
    if (firstOpenSlot(occupiedSlots) === undefined) break;

    try {
      const posts = await fetchTenantSourcePosts(source);
      fetched += posts.length;

      for (const post of posts) {
        const slotIndex = firstOpenSlot(occupiedSlots);
        if (slotIndex === undefined) break;

        const sourceUrl = canonicalSourceUrl(post);
        if (existingSourceUrls.has(sourceUrl)) continue;

        const extraction = await ai.extractSourceBank(post);
        const sourcePayload = {
          user_id: job.user_id,
          url: sourceUrl,
          title: post.title || null,
          origin: source.kind,
          score: post.score || null,
          used: false,
          fetched_at: nowIso(),
        };
        await supabaseInsert('source_records', sourcePayload);
        existingSourceUrls.add(sourceUrl);

        const angles = extraction.angles.slice(0, 5);
        if (!angles.length) continue;

        await supabaseInsert('angle_records', angles.map(angle => ({
          user_id: job.user_id,
          angle: `${angle.label}: ${angle.thesis}`,
          topic: extraction.summary.topic || post.title || null,
          used_count: 0,
          last_used_at: null,
        })));
        banked += angles.length;

        const selectedAngle = angles[0];
        const draft = await ai.draftPlatforms(
          post,
          extraction.summary,
          selectedAngle,
          tenant.activePlatforms,
          { disableLearningMemory: true }
        );
        const rows = toQueueRows(job.user_id, slotIndex, post, sourceUrl, selectedAngle, draft, tenant.activePlatforms);
        if (!rows.length) continue;

        await supabaseInsert('queue_items', rows);
        await supabaseUpdate('source_records', { used: true }, {
          filters: [
            { column: 'user_id', operator: 'eq', value: job.user_id },
            { column: 'url', operator: 'eq', value: sourceUrl },
          ],
        });
        occupiedSlots.add(slotIndex);
        queued += rows.length;
        await writeWorkerLog(job.user_id, 'info', 'queued_drafts', {
          jobId: job.id,
          slotIndex,
          platforms: rows.map(row => row.platform),
          sourceUrl,
        });
      }
    } catch (error) {
      await writeWorkerLog(job.user_id, 'warn', 'source_fetch_or_draft_failed', {
        jobId: job.id,
        sourceId: source.id,
        kind: source.kind,
        error: publicError(error),
      });
    }
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

  const current = locked[0];
  if (!current) {
    throw new WorkerJobError('queue_item_not_available', 'queue_item_not_available', { queueItemId: row.id });
  }

  try {
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

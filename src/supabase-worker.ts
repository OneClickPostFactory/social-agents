import * as crypto from 'node:crypto';

import config from '../config';

import * as ai from './ai';
import * as cloudinary from './cloudinary';
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
  supabaseUpsert,
} from './supabase-client';
import {
  decryptTenantCredentials,
  encryptCredential,
  type TenantCredentialRow,
  type TenantCredentials,
} from './tenant-credentials';
import {
  isPlatformPublishError,
  platformErrorContext,
} from './platform-errors';
import {
  fetchRedditPublicJson,
  RedditPublicJsonError,
  type RedditPublicJsonEndpointKind,
  type RedditPublicJsonRuntime,
  type RedditPublicJsonUsedTransport,
} from './reddit-public-json';
import {
  DAILY_SLOT_HOURS,
  buildPlatformSlotOccupancy,
  nextOpenPlatformSlot,
  platformSlotOccupancyKey,
  scheduledSlotWriteFields,
  tenantTimeZone,
  type PlatformSlotOccupancy,
  type ScheduledPlatformSlot,
} from './slot-scheduler';

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
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
  result?: JsonMap | null;
}

interface ProfileRow {
  subscription_status?: string | null;
  current_period_end?: string | null;
  trial_ends_at?: string | null;
  dev_access_until?: string | null;
}

interface UserSettingsRow {
  user_id?: string | null;
  ai_model?: string | null;
  posting_timezone?: string | null;
  threads_enabled?: boolean | null;
  instagram_enabled?: boolean | null;
  linkedin_enabled?: boolean | null;
  x_enabled?: boolean | null;
  facebook_enabled?: boolean | null;
  automation_enabled?: boolean | null;
  automation_fetch_enabled?: boolean | null;
  automation_publish_enabled?: boolean | null;
  automation_timezone?: string | null;
  automation_cadence_minutes?: number | null;
  next_fetch_at?: string | null;
  last_scheduled_fetch_at?: string | null;
  last_scheduled_job_id?: string | null;
  last_automation_result?: JsonMap | null;
}

interface AutomationSettingsRow extends UserSettingsRow {
  user_id: string;
}

interface UserSourceRow {
  id: string;
  user_id: string;
  kind: 'subreddit' | 'rss' | 'reddit_user';
  value: string;
  enabled: boolean;
  provider?: SourceProvider | null;
  acquisition_mode?: AcquisitionMode | null;
  source_scope?: SourceScope | null;
  target_author?: string | null;
  allowed_subreddits?: string[] | null;
  allow_unfiltered_rss?: boolean | null;
}

type SourceProvider = 'reddit' | 'generic_rss' | 'manual';
type AcquisitionMode = 'oauth' | 'rss' | 'devvit' | 'manual';
type SourceScope = 'reddit_user' | 'subreddit' | 'reddit_search' | 'generic_rss';
type SourceFetchAdapter = 'reddit_oauth' | 'reddit_public_json' | 'reddit_rss' | 'generic_rss';

interface SourceIntent {
  provider: SourceProvider;
  acquisitionMode: AcquisitionMode;
  sourceScope: SourceScope;
  targetAuthor: string;
  allowedSubreddits: string[];
  allowUnfilteredRss: boolean;
}

interface QueueItemRow {
  id: string;
  user_id: string;
  slot_index: number;
  scheduled_for: string;
  scheduled_local_date?: string | null;
  scheduled_timezone?: string | null;
  platform: PlatformKey;
  status: string;
  draft_text?: string | null;
  instagram_image_url?: string | null;
  instagram_image_prompt?: string | null;
  source_url?: string | null;
  source_title?: string | null;
  angle?: string | null;
  angle_record_id?: string | null;
  error_message?: string | null;
}

interface PublishHistoryRow {
  id: string;
  user_id: string;
  platform: PlatformKey;
  external_post_id?: string | null;
  external_url?: string | null;
  source_url?: string | null;
  published_at: string;
}

interface WorkerLogRow {
  level: WorkerLevel;
  message: string;
  context?: JsonMap | null;
  created_at: string;
}

export interface SchedulerStats {
  tenantsChecked: number;
  staleJobsFailed: number;
  fetchJobsEnqueued: number;
  slotFillJobsEnqueued: number;
  publishJobsEnqueued: number;
  skipped: Record<string, number>;
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

interface PipelineSummary {
  outcome: 'queued' | 'blocked' | 'empty' | 'deferred' | 'content_exhausted' | 'completed_with_errors';
  message: string;
  nextAction: string;
  access: {
    status: string;
    canWrite: boolean;
    reason: string;
  };
  platforms: {
    enabled: PlatformKey[];
    missingCredentials: string[];
    warnings: string[];
  };
  sources: {
    configured: number;
    enabled: number;
    checked: number;
    subredditSources: number;
    redditAuthorFilters: number;
    rssSources: number;
    postsFetched: number;
    postsAccepted: number;
    rejectedByAuthor: number;
    rejectedBySubreddit: number;
    rejectedUnfilteredRss: number;
    rejected: number;
    accepted: number;
    duplicatesSkipped: number;
    recordsCreated: number;
    recordsUpdated: number;
    withoutAngles: number;
    fetchFailures: number;
    fetchFailureReasons: Record<string, number>;
    rejectionReasons: Record<string, number>;
  };
  angles: {
    activeAtStart: number;
    draftableAtStart: number;
    created: number;
    alreadyExisting: number;
    extractionFailures: number;
    failureReasons: Record<string, number>;
    legacyRejected: number;
    disabledPlatformRejected: number;
    missingMetadataRejected: number;
    unusedAvailable: number;
    inProgressAvailable: number;
    statusCounts: Record<string, number>;
    rejectionReasons: Record<string, number>;
  };
  drafts: {
    attempted: number;
    created: number;
    skipped: number;
    failures: number;
    skipReasons: Record<string, number>;
    failureReasons: Record<string, number>;
    failuresByPlatform: Record<string, number>;
  };
  queue: {
    openSlotsAtStart: number;
    activeSlotsAtStart: number;
    created: number;
    ready: number;
    createdByPlatform: Record<string, number>;
  };
  errors: string[];
  failedStage?: string;
  failureCode?: string;
  mode?: 'fill_existing_angles';
}

const CONTENT_EXHAUSTED_MESSAGE =
  'Automation is working, but there are no new usable posts from your current Reddit sources. Add more sources, enable discovery feeds, paste manual URLs, or wait for new posts.';
const CONTENT_EXHAUSTED_NEXT_ACTION =
  'Add another subreddit or Reddit user, enable an intentional discovery feed, paste manual Reddit URLs, or wait for new source posts.';
const PARTIAL_INSTAGRAM_IMAGE_MESSAGE =
  'Automation created drafts for some platforms, but Instagram image generation was interrupted. Other platform drafts remain available.';
const PARTIAL_INSTAGRAM_IMAGE_NEXT_ACTION =
  'Retry Instagram image generation later, or attach/use a durable Cloudinary image.';
const PUBLISH_UNKNOWN_STATE_CODE = 'unknown_publish_state';
const PUBLISH_UNKNOWN_STATE_MESSAGE =
  'Scheduled publish timed out before the system could confirm whether the platform accepted the post. Review the platform account before retrying.';
const PUBLISH_UNKNOWN_STATE_NEXT_ACTION =
  'Check the platform account for a matching post. If it is not live, retry this queue item manually.';
const PUBLISH_INTERRUPTED_CODE = 'publish_claim_interrupted';
const PUBLISH_INTERRUPTED_MESSAGE =
  'Scheduled publish was interrupted before the platform publish step started. The queue item remains available for retry.';
const PUBLISH_INTERRUPTED_NEXT_ACTION =
  'Wait for the next scheduled run or retry the item manually.';
const PUBLISH_RECONCILED_CODE = 'publish_state_reconciled';
const PUBLISH_RECONCILED_MESSAGE =
  'Scheduled publish timed out, but the queue item is already published. No retry is needed.';
const PUBLISH_RECONCILED_NEXT_ACTION =
  'No action is needed unless the external platform post is missing.';

interface QueueFromAnglesResult {
  queued: number;
  draftableSeen: number;
  failures: number;
  rejected: number;
}

interface SourceFetchResult {
  posts: RedditPost[];
  adapter: SourceFetchAdapter;
  endpointKind?: RedditPublicJsonEndpointKind;
  runtime?: RedditPublicJsonRuntime;
  status?: number;
  transport?: RedditPublicJsonUsedTransport;
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

class SourceFetchError extends Error {
  constructor(
    public readonly adapter: SourceFetchAdapter,
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

const ACTIVE_QUEUE_STATUSES = ['pending', 'ready', 'publishing'];
const ACTIVE_ANGLE_STATUSES: AngleRecordStatus[] = ['unused', 'in_progress'];
const REDDIT_TOKEN_SKEW_MS = 60_000;
const ANGLE_EXTRACTION_TIMEOUT_MS = 12_000;
const SCHEDULER_NAME = 'cloudflare_cron';
const SCHEDULED_SOURCE = 'scheduled';
const STALE_RUNNING_JOB_MINUTES = 3;
const REFRESH_QUEUE_STALE_RUNNING_JOB_MINUTES = 8;
const redditTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function nowIso(): string {
  return new Date().toISOString();
}

function addMinutesIso(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

function incrementSchedulerSkip(stats: SchedulerStats, reason: string): void {
  stats.skipped[reason] = (stats.skipped[reason] || 0) + 1;
}

function secondsFromNowIso(seconds: number | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
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

function redditUrlMetadata(url: string | null | undefined): {
  subreddit: string;
  postId: string;
  author: string;
} {
  try {
    const parsed = new URL(String(url || ''));
    if (!parsed.hostname.toLowerCase().endsWith('reddit.com')) {
      return { subreddit: '', postId: '', author: '' };
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    const subredditIndex = parts.findIndex(part => part.toLowerCase() === 'r');
    const userIndex = parts.findIndex(part => ['user', 'u'].includes(part.toLowerCase()));
    return {
      subreddit: subredditIndex >= 0 ? normalizeSubreddit(parts[subredditIndex + 1]) : '',
      postId: subredditIndex >= 0 && parts[subredditIndex + 2]?.toLowerCase() === 'comments'
        ? String(parts[subredditIndex + 3] || '').trim().toLowerCase()
        : '',
      author: userIndex >= 0 ? normalizeRedditUsername(parts[userIndex + 1]) : '',
    };
  } catch {
    return { subreddit: '', postId: '', author: '' };
  }
}

function validSourceProvider(value: string | null | undefined): SourceProvider | '' {
  return value === 'reddit' || value === 'generic_rss' || value === 'manual' ? value : '';
}

function validAcquisitionMode(value: string | null | undefined): AcquisitionMode | '' {
  return value === 'oauth' || value === 'rss' || value === 'devvit' || value === 'manual' ? value : '';
}

function validSourceScope(value: string | null | undefined): SourceScope | '' {
  return value === 'reddit_user' || value === 'subreddit' || value === 'reddit_search' || value === 'generic_rss'
    ? value
    : '';
}

function sourceScopeFor(source: UserSourceRow): SourceScope {
  const explicit = validSourceScope(source.source_scope);
  if (explicit) return explicit;
  if (source.kind === 'reddit_user') return 'reddit_user';
  if (source.kind === 'subreddit') return 'subreddit';
  return 'generic_rss';
}

function acquisitionModeFor(source: UserSourceRow): AcquisitionMode {
  const explicit = validAcquisitionMode(source.acquisition_mode);
  if (explicit) return explicit;
  return source.kind === 'rss' ? 'rss' : 'oauth';
}

function providerFor(source: UserSourceRow, sourceScope = sourceScopeFor(source)): SourceProvider {
  const explicit = validSourceProvider(source.provider);
  if (explicit) return explicit;
  if (sourceScope === 'generic_rss') return 'generic_rss';
  return source.kind === 'rss' ? 'reddit' : 'reddit';
}

function redditUserValueParts(source: UserSourceRow): { author: string; subreddits: string[] } {
  const [rawUser, rawSubs] = source.value.split('|').map(part => part.trim());
  return {
    author: normalizeRedditUsername(rawUser),
    subreddits: (rawSubs || '')
      .split(',')
      .map(sub => normalizeSubreddit(sub))
      .filter(Boolean),
  };
}

function arrayFromSourceSubreddits(value: string[] | null | undefined): string[] {
  return (Array.isArray(value) ? value : [])
    .map(sub => normalizeSubreddit(sub))
    .filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function explicitSourceAuthor(source: UserSourceRow): string {
  return normalizeRedditUsername(source.target_author)
    || (source.kind === 'reddit_user' ? redditUserValueParts(source).author : '');
}

function explicitSourceSubreddits(source: UserSourceRow): string[] {
  const configured = arrayFromSourceSubreddits(source.allowed_subreddits);
  const fromKind = source.kind === 'subreddit'
    ? [normalizeSubreddit(source.value)].filter(Boolean)
    : source.kind === 'reddit_user'
      ? redditUserValueParts(source).subreddits
      : [];
  return uniqueStrings([...configured, ...fromKind]);
}

function sourceIntentFor(
  source: UserSourceRow,
  tenantAuthor: string,
  tenantAllowedSubreddits: string[]
): SourceIntent {
  const sourceScope = sourceScopeFor(source);
  const acquisitionMode = acquisitionModeFor(source);
  const explicitAllowed = explicitSourceSubreddits(source);
  const allowedSubreddits = sourceScope === 'generic_rss'
    ? explicitAllowed
    : uniqueStrings(explicitAllowed.length ? explicitAllowed : tenantAllowedSubreddits);
  const targetAuthor = sourceScope === 'generic_rss'
    ? explicitSourceAuthor(source)
    : explicitSourceAuthor(source) || tenantAuthor;

  return {
    provider: providerFor(source, sourceScope),
    acquisitionMode,
    sourceScope,
    targetAuthor,
    allowedSubreddits,
    allowUnfilteredRss: source.allow_unfiltered_rss === true,
  };
}

function preflightSourceIntentRejectReason(intent: SourceIntent): string {
  if (intent.sourceScope === 'generic_rss' && intent.acquisitionMode === 'rss' && !intent.allowUnfilteredRss) {
    return 'rejected_unfiltered_rss_not_allowed';
  }
  if (intent.sourceScope === 'reddit_user' && !intent.targetAuthor) {
    return 'rejected_author_mismatch';
  }
  if (intent.sourceScope === 'subreddit' && intent.allowedSubreddits.length === 0) {
    return 'rejected_subreddit_mismatch';
  }
  return '';
}

function sourceIntentRejectReasons(post: RedditPost, intent: SourceIntent): string[] {
  if (intent.sourceScope === 'generic_rss') {
    return intent.allowUnfilteredRss ? [] : ['rejected_unfiltered_rss_not_allowed'];
  }

  const reasons: string[] = [];
  const author = normalizeRedditUsername(post.author);
  const subreddit = normalizeSubreddit(post.subreddit) || redditUrlMetadata(post.url).subreddit;
  if (intent.allowedSubreddits.length > 0 && !intent.allowedSubreddits.includes(subreddit)) {
    reasons.push('rejected_subreddit_mismatch');
  }
  if (intent.targetAuthor && author !== intent.targetAuthor) {
    reasons.push('rejected_author_mismatch');
  }
  if (intent.sourceScope === 'reddit_user' && !intent.targetAuthor) {
    reasons.push('rejected_author_mismatch');
  }
  return reasons;
}

function summarizeRejectedSource(summary: PipelineSummary, reason: string, count = 1): void {
  if (!reason || count <= 0) return;
  summary.sources.rejected += count;
  incrementCounter(summary.sources.rejectionReasons, reason);
  if (reason === 'rejected_author_mismatch') summary.sources.rejectedByAuthor += count;
  if (reason === 'rejected_subreddit_mismatch') summary.sources.rejectedBySubreddit += count;
  if (reason === 'rejected_unfiltered_rss_not_allowed') summary.sources.rejectedUnfilteredRss += count;
}

function contentHashForPost(post: RedditPost): string {
  return crypto
    .createHash('sha256')
    .update([post.id, post.subreddit, post.author, post.title, post.selftext, post.url].join('\n'))
    .digest('hex');
}

function publicError(error: unknown): string {
  const imageError = ai.openAIImageErrorDetails(error);
  if (imageError) return imageError.userMessage;
  if (isPlatformPublishError(error)) return error.userMessage;
  if (error instanceof WorkerJobError) return error.code;
  if (error instanceof SourceFetchError) return error.code;
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorFailureReason(error: unknown): string {
  const imageError = ai.openAIImageErrorDetails(error);
  if (imageError) return imageError.code;
  return publicError(error);
}

function errorNextAction(error: unknown): string {
  const imageError = ai.openAIImageErrorDetails(error);
  if (imageError) return imageError.nextAction;
  if (isPlatformPublishError(error)) return error.nextAction;
  return 'Open Logs, fix the reported blocker, then retry the job.';
}

function safeErrorContext(error: unknown): JsonMap | null {
  const imageError = ai.openAIImageErrorDetails(error);
  if (imageError) {
    return {
      ...(typeof imageError.model === 'string' ? { model: imageError.model } : {}),
      ...(typeof imageError.promptLength === 'number' ? { prompt_length: imageError.promptLength } : {}),
      ...(typeof imageError.timeoutMs === 'number' ? { timeout_ms: imageError.timeoutMs } : {}),
      ...(typeof imageError.attempt === 'number' ? { attempt: imageError.attempt } : {}),
      ...(typeof imageError.elapsedMs === 'number' ? { elapsed_ms: imageError.elapsedMs } : {}),
      stage: imageError.stage,
      normalized_error_code: imageError.code,
      user_message: imageError.userMessage,
      next_action: imageError.nextAction,
    };
  }
  if (error instanceof WorkerJobError) return error.context || null;
  if (isPlatformPublishError(error)) return platformErrorContext(error);
  return null;
}

function sourceFetchAdapterFromError(error: unknown): SourceFetchAdapter | undefined {
  return error instanceof SourceFetchError ? error.adapter : undefined;
}

function sourceFetchContextFromError(error: unknown): JsonMap | undefined {
  return error instanceof SourceFetchError ? error.context : undefined;
}

function hasDateInFuture(value: string | null | undefined): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function incrementCounter(counter: Record<string, number>, key: string | undefined): void {
  const normalized = String(key || 'unknown').trim() || 'unknown';
  counter[normalized] = (counter[normalized] || 0) + 1;
}

function activeSlotCountForPlatform(platform: PlatformKey | string, occupiedSlots: PlatformSlotOccupancy): number {
  const prefix = `${String(platform || '').trim()}:`;
  if (!prefix.trim()) return 0;
  return [...occupiedSlots].filter(key => key.startsWith(prefix)).length;
}

function hasOpenActiveSlotForPlatform(platform: PlatformKey | string, occupiedSlots: PlatformSlotOccupancy): boolean {
  return activeSlotCountForPlatform(platform, occupiedSlots) < DAILY_SLOT_HOURS.length;
}

function addSummaryError(summary: PipelineSummary, error: unknown): void {
  const message = publicError(error);
  if (!summary.errors.includes(message)) {
    summary.errors.push(message);
  }
  const imageError = ai.openAIImageErrorDetails(error);
  if (imageError) {
    summary.failedStage ||= imageError.stage;
    summary.failureCode ||= imageError.code;
  }
  const textError = ai.openAITextErrorDetails(error, ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE);
  if (textError) {
    summary.failedStage ||= textError.stage;
    summary.failureCode ||= textError.code;
  }
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
    select: 'subscription_status,current_period_end,trial_ends_at,dev_access_until',
    filters: [{ column: 'user_id', operator: 'eq', value: userId }],
    limit: 1,
  }))[0];

  const status = profile?.subscription_status || 'none';
  if (hasDateInFuture(profile?.dev_access_until)) {
    return { canWrite: true, status, reason: 'dev_access' };
  }
  if (status === 'active') return { canWrite: true, status, reason: 'ok' };
  if (status === 'trialing' && hasDateInFuture(profile?.trial_ends_at)) {
    return { canWrite: true, status, reason: 'ok' };
  }
  if (status === 'canceled' && hasDateInFuture(profile?.current_period_end)) {
    return { canWrite: true, status, reason: 'ok' };
  }
  if (status === 'past_due') return { canWrite: false, status, reason: 'past_due' };
  if (status === 'trialing') return { canWrite: false, status, reason: 'expired' };
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

function missingPlatformCredentials(tenant: TenantContext): string[] {
  const missing = new Set<string>();

  if (!config.OPENAI_API_KEY) {
    missing.add('OpenAI API key');
  }

  for (const platform of tenant.activePlatforms) {
    if (platform === 'threads' && !tenant.credentials.threadsToken) {
      missing.add('Threads access token');
    }
    if (platform === 'instagram') {
      const hasMetaToken = Boolean(
        tenant.credentials.metaAccessToken
        || tenant.credentials.facebookPageAccessToken
        || tenant.credentials.instagramToken
      );
      const hasInstagramIdentity = Boolean(
        tenant.credentials.instagramAccountId
        || tenant.credentials.facebookPageId
      );
      if (!hasMetaToken) missing.add('Instagram / Meta access token');
      if (!hasInstagramIdentity) missing.add('Instagram account ID or Facebook Page ID');
    }
    if (platform === 'linkedin') {
      if (!tenant.credentials.linkedinToken) missing.add('LinkedIn access token');
      if (!tenant.credentials.linkedinPersonUrn) missing.add('LinkedIn person URN');
    }
    if (platform === 'x') {
      if (!tenant.credentials.xOAuth2AccessToken) missing.add('X OAuth access token');
    }
  }

  return [...missing];
}

function platformWarnings(tenant: TenantContext): string[] {
  const warnings: string[] = [];
  if (tenant.activePlatforms.includes('instagram')) {
    const hasCloudinary = Boolean(
      config.CLOUDINARY_CLOUD_NAME
      && config.CLOUDINARY_API_KEY
      && config.CLOUDINARY_API_SECRET
    );
    if (!hasCloudinary) {
      warnings.push('Instagram drafts need Cloudinary configured so generated images are durable.');
    }
  }
  if (
    tenant.activePlatforms.includes('x')
    && tenant.credentials.xOAuth2AccessToken
    && (!tenant.credentials.xOAuth2RefreshToken || !tenant.credentials.xClientId || !tenant.credentials.xClientSecret)
  ) {
    warnings.push('X OAuth2 credentials are stored but not refreshable. Reconnect X with client credentials and a refresh token.');
  }
  return warnings;
}

async function markXCredentialVerified(
  userId: string,
  verification: Awaited<ReturnType<typeof x.verifyCredentials>>
): Promise<void> {
  await supabaseUpdate('user_credentials', {
    x_verified_at: nowIso(),
    x_last_verification_failed_at: null,
    x_verification_status: 'verified',
    x_auth_mode: verification.authMode,
    x_account_id: verification.accountId,
    x_verification_error: null,
  }, {
    filters: [{ column: 'user_id', operator: 'eq', value: userId }],
  });
  await writeWorkerLog(userId, 'info', 'x_credentials_verified', {
    platform: 'x',
    auth_mode: verification.authMode,
    accountIdHash: hashId(verification.accountId),
  });
}

async function markXCredentialFailure(userId: string, error: unknown): Promise<void> {
  const context = isPlatformPublishError(error)
    ? platformErrorContext(error)
    : { normalized_error_code: 'verification_failed', user_message: publicError(error) };
  const code = typeof context.normalized_error_code === 'string'
    ? context.normalized_error_code
    : 'verification_failed';
  const status = code === 'not_connected' ? 'not_connected' : 'needs_reconnect';
  await supabaseUpdate('user_credentials', {
    x_last_verification_failed_at: nowIso(),
    x_verification_status: status,
    x_verification_error: publicError(error),
  }, {
    filters: [{ column: 'user_id', operator: 'eq', value: userId }],
  });
  await writeWorkerLog(userId, 'warn', 'x_credentials_verification_failed', {
    platform: 'x',
    ...context,
  });
}

async function verifyXCredentialForPublish(userId: string): Promise<x.XSafeAuthMode> {
  try {
    const verification = await x.verifyCredentials();
    await markXCredentialVerified(userId, verification);
    return verification.authMode;
  } catch (error) {
    await markXCredentialFailure(userId, error);
    throw error;
  }
}

async function createPipelineSummary(
  job: AgentJobRow,
  tenant: TenantContext,
  sources: UserSourceRow[],
  occupiedSlots: PlatformSlotOccupancy
): Promise<PipelineSummary> {
  const entitlement = await loadEntitlement(job.user_id);
  const enabledSources = sources.filter(source => source.enabled);
  const activeAngles = await supabaseSelect<AngleRecordRow>('angle_records', {
    select: 'id,status,intended_platform,source_reddit_post_id,source_url,subreddit,reddit_author',
    filters: [
      { column: 'user_id', operator: 'eq', value: job.user_id },
      { column: 'status', operator: 'in', value: ACTIVE_ANGLE_STATUSES },
    ],
    order: 'created_at.asc',
    limit: 1000,
  });
  const statusCounts: Record<string, number> = {};
  for (const row of activeAngles) {
    incrementCounter(statusCounts, row.status || 'unknown');
  }

  return {
    outcome: 'empty',
    message: 'No queue items were created yet.',
    nextAction: 'Review the setup details and run Fetch sources again.',
    access: {
      status: entitlement.status,
      canWrite: entitlement.canWrite,
      reason: entitlement.reason,
    },
    platforms: {
      enabled: tenant.activePlatforms,
      missingCredentials: missingPlatformCredentials(tenant),
      warnings: platformWarnings(tenant),
    },
    sources: {
      configured: sources.length,
      enabled: enabledSources.length,
      checked: 0,
      subredditSources: enabledSources.filter(source => sourceScopeFor(source) === 'subreddit').length,
      redditAuthorFilters: enabledSources.filter(source => sourceScopeFor(source) === 'reddit_user').length,
      rssSources: enabledSources.filter(source => source.kind === 'rss').length,
      postsFetched: 0,
      postsAccepted: 0,
      rejectedByAuthor: 0,
      rejectedBySubreddit: 0,
      rejectedUnfilteredRss: 0,
      rejected: 0,
      accepted: 0,
      duplicatesSkipped: 0,
      recordsCreated: 0,
      recordsUpdated: 0,
      withoutAngles: 0,
      fetchFailures: 0,
      fetchFailureReasons: {},
      rejectionReasons: {},
    },
    angles: {
      activeAtStart: activeAngles.length,
      draftableAtStart: activeAngles.filter(row => anglePlatform(row, tenant) && isDraftableAngle(row)).length,
      created: 0,
      alreadyExisting: 0,
      extractionFailures: 0,
      failureReasons: {},
      legacyRejected: 0,
      disabledPlatformRejected: 0,
      missingMetadataRejected: 0,
      unusedAvailable: activeAngles.filter(row => row.status === 'unused').length,
      inProgressAvailable: activeAngles.filter(row => row.status === 'in_progress').length,
      statusCounts,
      rejectionReasons: {},
    },
    drafts: {
      attempted: 0,
      created: 0,
      skipped: 0,
      failures: 0,
      skipReasons: {},
      failureReasons: {},
      failuresByPlatform: {},
    },
    queue: {
      openSlotsAtStart: Math.max(0, tenant.activePlatforms.length * 4 - occupiedSlots.size),
      activeSlotsAtStart: occupiedSlots.size,
      created: 0,
      ready: 0,
      createdByPlatform: {},
    },
    errors: [],
  };
}

function snapshotConfig(): Partial<AppConfig> {
  return {
    OPENAI_API_KEY: config.OPENAI_API_KEY,
    OPENAI_MODEL: config.OPENAI_MODEL,
    OPENAI_IMAGE_MODEL: config.OPENAI_IMAGE_MODEL,
    OPENAI_IMAGE_TIMEOUT_MS: config.OPENAI_IMAGE_TIMEOUT_MS,
    REDDIT_CLIENT_ID: config.REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET: config.REDDIT_CLIENT_SECRET,
    REDDIT_PUBLIC_JSON_TRANSPORT: config.REDDIT_PUBLIC_JSON_TRANSPORT,
    REDDIT_USER_AGENT: config.REDDIT_USER_AGENT,
    CLOUDINARY_FOLDER: config.CLOUDINARY_FOLDER,
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

function tenantCloudinaryFolder(baseFolder: string, userId: string): string {
  const base = (baseFolder || 'social-agent/instagram').replace(/\/+$/g, '') || 'social-agent/instagram';
  const tenantHash = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
  return `${base}/tenant-${tenantHash}`;
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
    if (tokens.scope) {
      patch.x_scopes = tokens.scope;
    }
    const expiresAt = secondsFromNowIso(tokens.expiresIn);
    if (expiresAt) {
      patch.x_expires_at = expiresAt;
    }

    await supabaseUpdate('user_credentials', patch, {
      filters: [{ column: 'user_id', operator: 'eq', value: tenant.userId }],
    });
    await writeWorkerLog(tenant.userId, 'info', 'x_oauth2_tokens_refreshed', {
      accessTokenUpdated: true,
      refreshTokenUpdated: Boolean(tokens.refreshToken),
      scopeUpdated: Boolean(tokens.scope),
      expiresAtUpdated: Boolean(expiresAt),
    });
  });
  config.OPENAI_API_KEY = tenant.credentials.openaiApiKey || previous.OPENAI_API_KEY || '';
  config.OPENAI_MODEL = tenant.settings.ai_model || 'gpt-4o-mini';
  config.OPENAI_IMAGE_MODEL = previous.OPENAI_IMAGE_MODEL || config.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  config.REDDIT_CLIENT_ID = tenant.credentials.redditClientId || previous.REDDIT_CLIENT_ID || '';
  config.REDDIT_CLIENT_SECRET = tenant.credentials.redditClientSecret || previous.REDDIT_CLIENT_SECRET || '';
  config.REDDIT_USER_AGENT = previous.REDDIT_USER_AGENT || config.REDDIT_USER_AGENT;
  config.CLOUDINARY_FOLDER = tenantCloudinaryFolder(previous.CLOUDINARY_FOLDER || config.CLOUDINARY_FOLDER, tenant.userId);
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

function resultSummary(result: JsonMap): JsonMap {
  const summary = result.summary;
  return typeof summary === 'object' && summary !== null && !Array.isArray(summary)
    ? summary as JsonMap
    : {};
}

function terminalStatusForResult(result: JsonMap): string {
  const requested = typeof result.jobStatus === 'string' ? result.jobStatus : '';
  if (requested === 'failed' || requested === 'completed_with_errors') return requested;

  const summary = resultSummary(result);
  if (summary.outcome === 'completed_with_errors') return 'completed_with_errors';
  if (summary.failedStage === ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE) {
    const queue = typeof summary.queue === 'object' && summary.queue !== null && !Array.isArray(summary.queue)
      ? summary.queue as JsonMap
      : {};
    const angles = typeof summary.angles === 'object' && summary.angles !== null && !Array.isArray(summary.angles)
      ? summary.angles as JsonMap
      : {};
    const queueCreated = Number(queue.created || 0);
    const anglesCreated = Number(angles.created || 0);
    return queueCreated > 0 || anglesCreated > 0 ? 'completed_with_errors' : 'failed';
  }
  if (summary.failedStage === ai.OPENAI_IMAGE_GENERATION_STAGE) {
    const queue = typeof summary.queue === 'object' && summary.queue !== null && !Array.isArray(summary.queue)
      ? summary.queue as JsonMap
      : {};
    const queueCreated = Number(queue.created || 0);
    return queueCreated > 0 ? 'completed_with_errors' : 'failed';
  }

  return 'completed';
}

function resultErrorMessage(result: JsonMap, status: string): string | null {
  if (status !== 'failed') return null;
  const summary = resultSummary(result);
  return String(summary.failureCode || summary.message || result.error || 'job_failed');
}

function payloadSource(payload: JsonMap | null | undefined): string {
  return typeof payload?.source === 'string' ? payload.source : 'manual';
}

function jobOrigin(job: AgentJobRow): string {
  const source = payloadSource(job.payload);
  if (source === SCHEDULED_SOURCE) return 'scheduled';
  if (source.includes('smoke') || Boolean(job.payload?.smoke_test) || Boolean(job.payload?.smoke)) return 'smoke-test';
  if (source === 'system') return 'system';
  return 'manual';
}

function queueItemIdFromPayload(payload: JsonMap | null | undefined): string {
  return typeof payload?.queue_item_id === 'string' ? payload.queue_item_id : '';
}

function isScheduledJob(job: AgentJobRow): boolean {
  return payloadSource(job.payload) === SCHEDULED_SOURCE
    && job.payload?.scheduler === SCHEDULER_NAME;
}

function publishSuccessMessage(platform: PlatformKey, origin: string): string {
  return origin === 'scheduled'
    ? `Scheduled post published to ${platform}. External post ID recorded.`
    : `Published to ${platform}. External post ID recorded.`;
}

function publishSuccessResult(
  job: AgentJobRow,
  row: QueueItemRow,
  history: PublishHistoryRow | undefined,
  externalPostId: string,
  completedAt: string,
  authMode?: string
): JsonMap {
  const origin = jobOrigin(job);
  const scheduler = typeof job.payload?.scheduler === 'string' ? job.payload.scheduler : undefined;
  const scheduledFor = row.scheduled_for || (typeof job.payload?.due_at === 'string' ? job.payload.due_at : undefined);
  const message = publishSuccessMessage(row.platform, origin);
  const nextAction = 'Review the published post in Publish History or on the platform.';
  const summary: JsonMap = {
    outcome: 'published',
    platform: row.platform,
    queue_item_id: row.id,
    job_id: job.id,
    origin,
    ...(scheduler ? { scheduler } : {}),
    ...(scheduledFor ? { scheduled_for: scheduledFor } : {}),
    started_at: job.started_at || null,
    completed_at: completedAt,
    final_queue_status: 'published',
    publish_history_id: history?.id || null,
    external_post_id: externalPostId,
    ...(history?.external_url ? { external_url: history.external_url } : {}),
    message,
    nextAction,
  };

  return {
    authMode,
    completedAt,
    externalPostId,
    external_post_id: externalPostId,
    finalQueueStatus: 'published',
    final_queue_status: 'published',
    jobId: job.id,
    job_id: job.id,
    message,
    nextAction,
    origin,
    platform: row.platform,
    publishHistoryId: history?.id || null,
    publish_history_id: history?.id || null,
    queueItemId: row.id,
    queue_item_id: row.id,
    scheduledFor,
    scheduled_for: scheduledFor,
    ...(scheduler ? { scheduler } : {}),
    startedAt: job.started_at || null,
    started_at: job.started_at || null,
    summary,
  };
}

function automationResultPayload(job: AgentJobRow, status: string, result: JsonMap): JsonMap {
  const summary = resultSummary(result);
  const outcome = typeof summary.outcome === 'string' ? summary.outcome : '';
  return {
    jobId: job.id,
    kind: job.kind,
    status: outcome === 'content_exhausted' ? 'content_exhausted' : status,
    jobStatus: status,
    outcome: outcome || null,
    origin: jobOrigin(job),
    completedAt: nowIso(),
    message: String(summary.message || result.message || result.error || status),
    nextAction: String(summary.nextAction || result.nextAction || ''),
    failedStage: typeof summary.failedStage === 'string' ? summary.failedStage : null,
    failureCode: typeof summary.failureCode === 'string' ? summary.failureCode : null,
  };
}

async function recordScheduledAutomationResult(job: AgentJobRow, status: string, result: JsonMap): Promise<void> {
  if (!isScheduledJob(job)) return;
  try {
    await supabaseUpdate('user_settings', {
      last_scheduled_job_id: job.id,
      last_automation_result: automationResultPayload(job, status, result),
    }, {
      filters: [{ column: 'user_id', operator: 'eq', value: job.user_id }],
    });
  } catch (error) {
    logger.warn(`Scheduled automation result update failed: ${publicError(error)}`);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function extractSourceBankWithJobTimeout(post: RedditPost): Promise<Awaited<ReturnType<typeof ai.extractSourceBank>>> {
  return withTimeout(
    ai.extractSourceBank(post),
    Math.max(5_000, Math.min(ANGLE_EXTRACTION_TIMEOUT_MS, config.HTTP_TIMEOUT_MS - 1_000)),
    'OpenAI angle extraction timed out before the worker could finalize the job'
  );
}

async function completeJob(job: AgentJobRow, result: JsonMap): Promise<string> {
  const status = terminalStatusForResult(result);
  await supabaseUpdate('agent_jobs', {
    status,
    completed_at: nowIso(),
    result,
    error: resultErrorMessage(result, status),
  }, {
    filters: [
      { column: 'id', operator: 'eq', value: job.id },
      { column: 'user_id', operator: 'eq', value: job.user_id },
    ],
  });
  await recordScheduledAutomationResult(job, status, result);
  return status;
}

async function failJob(job: AgentJobRow, error: unknown): Promise<void> {
  const message = publicError(error);
  const context = safeErrorContext(error);
  const result = {
    outcome: 'blocked',
    message,
    nextAction: errorNextAction(error),
    error: message,
    context,
  };
  await writeWorkerLog(job.user_id, 'error', message, {
    jobId: job.id,
    kind: job.kind,
    ...(context ? { context } : {}),
  });
  await supabaseUpdate('agent_jobs', {
    status: 'failed',
    completed_at: nowIso(),
    error: message,
    result,
  }, {
    filters: [
      { column: 'id', operator: 'eq', value: job.id },
      { column: 'user_id', operator: 'eq', value: job.user_id },
    ],
  });
  await recordScheduledAutomationResult(job, 'failed', result);
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

function firstXmlLink(block: string): string {
  const textLink = firstXmlTag(block, 'link');
  if (textLink) return textLink;
  const href = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i)?.[1];
  return decodeXml(href || '');
}

function parseRss(xml: string, sourceUrl: string): RedditPost[] {
  const itemBlocks = [...xml.matchAll(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi)]
    .map(match => match[0])
    .slice(0, 20);

  return itemBlocks.map(block => {
    const title = firstXmlTag(block, 'title') || 'Untitled RSS item';
    const link = firstXmlLink(block) || sourceUrl;
    const description = firstXmlTag(block, 'description') || firstXmlTag(block, 'summary') || '';
    const published = firstXmlTag(block, 'pubDate') || firstXmlTag(block, 'published') || firstXmlTag(block, 'updated');
    const metadata = redditUrlMetadata(link);
    const fallbackAuthor = metadata.author || redditUrlMetadata(sourceUrl).author;
    const author = normalizeRedditUsername(
      firstXmlTag(block, 'author')
      || firstXmlTag(block, 'dc:creator')
      || firstXmlTag(block, 'creator')
      || fallbackAuthor
    );
    return {
      id: metadata.postId || hashId(`${sourceUrl}:${link}:${title}`),
      title,
      selftext: description,
      url: link,
      score: 0,
      comments: 0,
      subreddit: metadata.subreddit || '',
      author,
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

async function redditResponseError(response: Response, adapter: SourceFetchAdapter): Promise<SourceFetchError> {
  let body = '';
  try {
    body = (await response.text()).replace(/\s+/g, ' ').slice(0, 220);
  } catch {
    body = '';
  }
  let code = `${adapter}_http_${response.status}`;
  if (response.status === 403) code = adapter === 'reddit_public_json'
    ? 'reddit_public_json_blocked_403'
    : `${adapter}_forbidden_403`;
  if (response.status === 404) code = `${adapter}_not_found_404`;
  if (response.status === 429) code = `${adapter}_rate_limited_429`;
  return new SourceFetchError(adapter, code, body ? `${code}: ${body}` : code, {
    status: response.status,
    body_snippet: body || undefined,
    transport: 'fetch',
  });
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
    throw await redditResponseError(response, 'reddit_oauth');
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

async function readRedditListingJson(
  url: string,
  adapter: SourceFetchAdapter,
  headers: Record<string, string>
): Promise<SourceFetchResult> {
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await redditResponseError(response, adapter);
  }

  try {
    return {
      posts: parseRedditListing(await response.json() as RedditListingPayload),
      adapter,
      status: response.status,
      transport: 'fetch',
    };
  } catch (error) {
    throw new SourceFetchError(adapter, `${adapter}_json_parse_failed`, `Failed to parse Reddit response: ${publicError(error)}`);
  }
}

async function readRedditPublicJsonListing(
  url: string,
  endpointKind: RedditPublicJsonEndpointKind
): Promise<SourceFetchResult> {
  try {
    const result = await fetchRedditPublicJson(url, {
      endpointKind,
      timeoutMs: config.HTTP_TIMEOUT_MS,
      transport: config.REDDIT_PUBLIC_JSON_TRANSPORT,
    });
    return {
      adapter: 'reddit_public_json',
      endpointKind,
      posts: parseRedditListing(result.payload as RedditListingPayload),
      runtime: result.runtime,
      status: result.status,
      transport: result.transport,
    };
  } catch (error) {
    if (error instanceof RedditPublicJsonError) {
      throw new SourceFetchError('reddit_public_json', error.code, error.message, {
        body_snippet: error.context.bodySnippet,
        endpoint_kind: endpointKind,
        runtime: error.context.runtime,
        status: error.context.status,
        transport: error.context.transport,
      });
    }
    throw new SourceFetchError('reddit_public_json', 'reddit_public_json_failed', publicError(error), {
      endpoint_kind: endpointKind,
      transport: config.REDDIT_PUBLIC_JSON_TRANSPORT,
    });
  }
}

async function fetchRedditListing(
  url: string,
  endpointKind: RedditPublicJsonEndpointKind
): Promise<SourceFetchResult> {
  const oauthHeaders: Record<string, string> = {
    'User-Agent': redditUserAgent(),
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  };

  let requestUrl = url;
  if (config.REDDIT_CLIENT_ID.trim() && config.REDDIT_CLIENT_SECRET.trim()) {
    try {
      oauthHeaders.Authorization = `Bearer ${await getRedditAccessToken()}`;
      requestUrl = redditOauthListingUrl(url);
      return readRedditListingJson(requestUrl, 'reddit_oauth', oauthHeaders);
    } catch (error) {
      if (error instanceof SourceFetchError && error.adapter !== 'reddit_oauth') {
        throw error;
      }
    }
  }

  return readRedditPublicJsonListing(url, endpointKind);
}

async function fetchTenantSourcePosts(source: UserSourceRow, userId?: string, jobId?: string): Promise<SourceFetchResult> {
  const value = source.value.trim();
  if (!value) return { posts: [], adapter: source.kind === 'rss' ? 'generic_rss' : 'reddit_public_json' };

  if (source.kind === 'subreddit') {
    const sub = normalizeSubreddit(value);
    if (!sub) return { posts: [], adapter: 'reddit_public_json' };
    return fetchRedditListing(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=20&raw_json=1`, 'subreddit');
  }

  if (source.kind === 'reddit_user') {
    const { author: user, subreddits: subs } = redditUserValueParts(source);

    if (subs.length) {
      const listings: RedditPost[] = [];
      let adapter: SourceFetchAdapter | undefined;
      for (const sub of subs) {
        try {
          const result = await fetchRedditListing(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=50&raw_json=1`, 'subreddit');
          adapter = result.adapter;
          listings.push(...result.posts);
          if (userId && jobId) {
            await writeWorkerLog(userId, 'info', 'reddit_subreddit_fetched', {
              jobId,
              sourceId: source.id,
              subreddit: sub,
              adapter: result.adapter,
              endpoint_kind: result.endpointKind,
              posts: result.posts.length,
              runtime: result.runtime,
              status: result.status,
              transport: result.transport,
            });
          }
        } catch (error) {
          if (userId && jobId) {
            await writeWorkerLog(userId, 'warn', 'reddit_subreddit_fetch_failed', {
              jobId,
              sourceId: source.id,
              subreddit: sub,
              adapter: sourceFetchAdapterFromError(error) || 'reddit_public_json',
              error: publicError(error),
              ...sourceFetchContextFromError(error),
            });
          }
        }
      }
      const seen = new Set<string>();
      return {
        adapter: adapter || 'reddit_public_json',
        posts: listings
        .sort((a, b) => b.created - a.created)
        .filter(post => {
          if (seen.has(post.id)) return false;
          seen.add(post.id);
          return true;
        }),
      };
    }

    if (!user) {
      await writeWorkerLog(userId || source.user_id, 'warn', 'reddit_author_source_missing_target', {
        jobId,
        sourceId: source.id,
      });
      return { posts: [], adapter: 'reddit_public_json' };
    }

    const result = await fetchRedditListing(`https://www.reddit.com/user/${encodeURIComponent(user)}/submitted/new.json?limit=50&raw_json=1`, 'reddit_user');
    await writeWorkerLog(userId || source.user_id, 'info', 'reddit_author_listing_fetched', {
      jobId,
      sourceId: source.id,
      author: user,
      adapter: result.adapter,
      endpoint_kind: result.endpointKind,
      posts: result.posts.length,
      runtime: result.runtime,
      status: result.status,
      transport: result.transport,
    });
    return result;
  }

  const adapter: SourceFetchAdapter = sourceScopeFor(source) === 'generic_rss' ? 'generic_rss' : 'reddit_rss';
  const response = await fetch(value, {
    headers: {
      'User-Agent': 'oneclickpostfactory-supabase-worker/1.0',
      Accept: 'application/rss+xml, application/atom+xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    const code = adapter === 'reddit_rss' ? `reddit_rss_http_${response.status}` : `generic_rss_http_${response.status}`;
    throw new SourceFetchError(adapter, code, code);
  }
  return { posts: parseRss(await response.text(), value), adapter };
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

function tenantAutomationTimeZone(tenant: TenantContext): string {
  return tenantTimeZone(tenant.settings.automation_timezone, tenant.settings.posting_timezone);
}

async function loadActiveSlotOccupancy(userId: string, timeZone: string): Promise<PlatformSlotOccupancy> {
  const rows = await supabaseSelect<QueueItemRow>('queue_items', {
    select: 'slot_index,status,platform,scheduled_for,scheduled_local_date',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'status', operator: 'in', value: ACTIVE_QUEUE_STATUSES },
    ],
    limit: 100,
  });
  return buildPlatformSlotOccupancy(rows, timeZone);
}

async function loadSourceUrlsWithAngles(userId: string): Promise<Set<string>> {
  const rows = await supabaseSelect<{ source_url?: string | null }>('angle_records', {
    select: 'source_url',
    filters: [{ column: 'user_id', operator: 'eq', value: userId }],
    limit: 5000,
  });
  return new Set(rows.map(row => row.source_url || '').filter(Boolean));
}

async function loadExistingSourceRecordsByUrl(
  userId: string,
  urls: string[]
): Promise<Map<string, { id: string; status?: string | null; url: string }>> {
  const uniqueUrls = uniqueStrings(urls);
  if (!uniqueUrls.length) return new Map();
  const rows = await supabaseSelect<{ id: string; status?: string | null; url: string }>('source_records', {
    select: 'id,status,url',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'url', operator: 'in', value: uniqueUrls },
    ],
    limit: uniqueUrls.length,
  });
  return new Map(rows.map(row => [row.url, row]));
}

async function saveAcceptedSourceRecords(
  job: AgentJobRow,
  source: UserSourceRow,
  posts: Array<{ post: RedditPost; sourceUrl: string }>,
  summary: PipelineSummary
): Promise<Map<string, string>> {
  if (!posts.length) return new Map();
  const existing = await loadExistingSourceRecordsByUrl(job.user_id, posts.map(entry => entry.sourceUrl));
  const sourcePayloads = posts.map(({ post, sourceUrl }) => ({
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
  }));

  const rows = await supabaseUpsert<{ id: string; url: string }>(
    'source_records',
    sourcePayloads,
    'user_id,url',
    true
  );
  summary.sources.recordsUpdated += existing.size;
  summary.sources.recordsCreated += Math.max(0, sourcePayloads.length - existing.size);
  await writeWorkerLog(job.user_id, 'info', 'source_records_saved', {
    jobId: job.id,
    sourceId: source.id,
    records_created: Math.max(0, sourcePayloads.length - existing.size),
    records_updated: existing.size,
    records_touched: sourcePayloads.length,
  });
  return new Map(rows.map(row => [row.url, row.id]));
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

async function refreshPipelineInventory(job: AgentJobRow, summary: PipelineSummary): Promise<void> {
  const [angles, queue] = await Promise.all([
    supabaseSelect<{ status?: string | null }>('angle_records', {
      select: 'status',
      filters: [{ column: 'user_id', operator: 'eq', value: job.user_id }],
      limit: 1000,
    }),
    supabaseSelect<{ status?: string | null }>('queue_items', {
      select: 'status',
      filters: [
        { column: 'user_id', operator: 'eq', value: job.user_id },
        { column: 'status', operator: 'in', value: ACTIVE_QUEUE_STATUSES },
      ],
      limit: 100,
    }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const angle of angles) {
    incrementCounter(statusCounts, angle.status || 'unknown');
  }
  summary.angles.statusCounts = statusCounts;
  summary.angles.unusedAvailable = statusCounts.unused || 0;
  summary.angles.inProgressAvailable = statusCounts.in_progress || 0;
  summary.queue.ready = queue.filter(row => row.status === 'ready' || row.status === 'pending').length;
}

function primaryFailureReason(reasons: Record<string, number>): string {
  const [first] = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  return first?.[0] || 'unknown';
}

function markContentExhausted(summary: PipelineSummary): void {
  summary.outcome = 'content_exhausted';
  summary.message = CONTENT_EXHAUSTED_MESSAGE;
  summary.nextAction = CONTENT_EXHAUSTED_NEXT_ACTION;
}

function finalizePipelineSummary(summary: PipelineSummary): void {
  if (!summary.access.canWrite) {
    summary.outcome = 'blocked';
    summary.message = 'Trial or subscription access blocked drafting.';
    summary.nextAction = 'Open Billing and restore write access.';
    return;
  }

  if (!summary.platforms.enabled.length) {
    summary.outcome = 'blocked';
    summary.message = 'No publishing platforms are enabled.';
    summary.nextAction = 'Enable at least one platform in Settings before drafting.';
    return;
  }

  if (summary.queue.openSlotsAtStart === 0) {
    summary.outcome = 'deferred';
    summary.message = 'The queue already had active items, so the worker did not create another draft.';
    summary.nextAction = 'Publish, skip, or release an existing queue item to open a slot.';
    return;
  }

  if (summary.mode === 'fill_existing_angles' && summary.queue.created === 0) {
    if (summary.drafts.failures > 0) {
      summary.outcome = 'blocked';
      summary.message = 'Automation found unused angles, but OpenAI drafting failed. Fix OpenAI billing/quota, then retry.';
      summary.nextAction = 'Fix OpenAI billing/quota or wait for rate limits to reset, then let automation run again.';
      return;
    }
    if (summary.angles.activeAtStart === 0 || summary.angles.draftableAtStart === 0) {
      markContentExhausted(summary);
      return;
    }
  }

  if (summary.failedStage === ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE) {
    const partialProgress = summary.queue.created > 0 || summary.angles.created > 0;
    summary.outcome = partialProgress ? 'completed_with_errors' : 'blocked';
    summary.message = partialProgress
      ? 'Some queue items were created, but OpenAI angle extraction failed for additional accepted Reddit posts.'
      : ai.OPENAI_TEXT_ANGLE_EXTRACTION_MESSAGE;
    summary.nextAction = ai.OPENAI_TEXT_ANGLE_EXTRACTION_NEXT_ACTION;
    return;
  }

  if (summary.queue.created > 0 && summary.drafts.failures > 0) {
    const reason = primaryFailureReason(summary.drafts.failureReasons);
    summary.outcome = 'completed_with_errors';
    summary.message = reason.startsWith('openai_image_') || summary.drafts.failuresByPlatform.instagram
      ? PARTIAL_INSTAGRAM_IMAGE_MESSAGE
      : `${summary.queue.created} queue item${summary.queue.created === 1 ? '' : 's'} were created, but another platform draft failed.`;
    summary.nextAction = reason.startsWith('openai_image_') || summary.drafts.failuresByPlatform.instagram
      ? PARTIAL_INSTAGRAM_IMAGE_NEXT_ACTION
      : 'Review the queued drafts, then inspect Logs for the failed platform draft.';
    if (reason.startsWith('openai_image_') || summary.drafts.failuresByPlatform.instagram) {
      summary.failedStage ||= ai.OPENAI_IMAGE_GENERATION_STAGE;
      summary.failureCode ||= reason.startsWith('openai_image_') ? reason : ai.OPENAI_IMAGE_GENERATION_FAILED_CODE;
    } else {
      summary.failureCode ||= reason;
    }
    return;
  }

  if (summary.queue.created > 0) {
    summary.outcome = 'queued';
    summary.message = `${summary.queue.created} queue item${summary.queue.created === 1 ? '' : 's'} created.`;
    summary.nextAction = 'Review the ready queue items, then publish or edit them.';
    return;
  }

  if (summary.drafts.failures > 0) {
    const reason = primaryFailureReason(summary.drafts.failureReasons);
    summary.outcome = 'blocked';
    if (reason === ai.OPENAI_IMAGE_BILLING_BLOCKED_CODE) {
      summary.message = ai.OPENAI_IMAGE_BILLING_BLOCKED_MESSAGE;
      summary.nextAction = ai.OPENAI_IMAGE_BILLING_BLOCKED_NEXT_ACTION;
      summary.failedStage ||= ai.OPENAI_IMAGE_GENERATION_STAGE;
      summary.failureCode ||= ai.OPENAI_IMAGE_BILLING_BLOCKED_CODE;
      return;
    }
    summary.message = `Drafting was attempted but failed: ${reason}.`;
    summary.nextAction = reason === 'instagram_image_not_persisted'
      ? 'Check Cloudinary and Instagram image generation configuration.'
      : 'Open Logs for the failed draft reason, then retry Fetch sources.';
    return;
  }

  if (summary.sources.fetchFailures > 0 && summary.sources.postsAccepted === 0) {
    const reason = primaryFailureReason(summary.sources.fetchFailureReasons);
    summary.outcome = 'blocked';
    if (reason === 'reddit_public_json_rate_limited_429') {
      summary.message = 'Reddit rate-limited public JSON from this runtime. Try again later, use OAuth, use RSS/manual import, or run fetch from a Node runtime/proxy that Reddit allows.';
      summary.nextAction = 'Wait for the public JSON rate limit to reset, configure Reddit OAuth, use RSS/manual import, or run fetch from an allowed Node runtime/proxy.';
      return;
    }
    summary.message = `Source fetching failed closed: ${reason}.`;
    summary.nextAction = reason === 'reddit_public_json_blocked_403'
      ? 'Reddit blocked public JSON from this runtime. Configure Reddit OAuth, use an author RSS feed, Devvit, or manual import.'
      : reason.toLowerCase().includes('reddit')
      ? 'Check Reddit API credentials and retry Fetch sources.'
      : 'Open Logs, fix the source connection, and retry Fetch sources.';
    return;
  }

  if (summary.sources.configured === 0 || summary.sources.enabled === 0) {
    summary.outcome = 'blocked';
    summary.message = 'No enabled sources are configured.';
    summary.nextAction = 'Add a Reddit author filter plus allowed subreddits, or add an RSS source.';
    return;
  }

  if (summary.sources.postsFetched > 0 && summary.sources.postsAccepted === 0) {
    if (summary.sources.rejectedByAuthor > 0) {
      summary.outcome = 'empty';
      summary.message = 'RSS source fetched posts, but none matched your selected Reddit user.';
      summary.nextAction = 'Check the source author filter or use Discovery Feed mode for broad RSS.';
      return;
    }
    if (summary.sources.rejectedBySubreddit > 0) {
      summary.outcome = 'empty';
      summary.message = 'RSS source fetched posts, but none matched your allowed subreddit list.';
      summary.nextAction = 'Review allowed subreddits or update the source scope.';
      return;
    }
    summary.outcome = 'empty';
    summary.message = 'Fetch completed, but no Reddit posts matched the configured Reddit username.';
    summary.nextAction = 'Check the Reddit author filter and allowed subreddits.';
    return;
  }

  if (summary.sources.checked > 0 && summary.sources.postsFetched === 0 && summary.sources.fetchFailures === 0) {
    markContentExhausted(summary);
    return;
  }

  if (summary.sources.rejectedUnfilteredRss > 0 && summary.sources.postsAccepted === 0) {
    summary.outcome = 'blocked';
    summary.message = 'This RSS feed is unfiltered. Enable Discovery Feed mode if you want posts from any author.';
    summary.nextAction = 'Open Memory and explicitly enable Discovery Feed mode for that RSS source.';
    return;
  }

  if (
    summary.sources.postsAccepted > 0
    && summary.sources.duplicatesSkipped >= summary.sources.postsAccepted
    && summary.sources.recordsCreated === 0
    && summary.angles.created === 0
  ) {
    markContentExhausted(summary);
    return;
  }

  if (summary.sources.postsAccepted > 0 && summary.angles.created === 0) {
    summary.outcome = 'empty';
    summary.message = 'Sources were accepted, but no usable angles were created.';
    summary.nextAction = 'Open Logs to inspect source extraction results, then retry with a stronger source.';
    return;
  }

  if (summary.angles.created > 0) {
    summary.outcome = 'deferred';
    summary.message = `${summary.angles.created} angle${summary.angles.created === 1 ? '' : 's'} were banked, but no draft was queued yet.`;
    summary.nextAction = 'Run Fetch sources again or wait for the next worker tick to draft unused angles.';
    return;
  }

  if (summary.angles.legacyRejected > 0) {
    summary.outcome = 'empty';
    summary.message = 'Legacy Angle Bank rows were quarantined because they were missing required source or platform metadata.';
    summary.nextAction = 'Run Fetch sources again so the worker can fetch fresh tenant-scoped source material.';
    return;
  }

  summary.outcome = 'empty';
  summary.message = 'Fetch completed, but no queue item was created.';
  summary.nextAction = 'Open Logs for the worker summary, then verify sources, credentials, and enabled platforms.';
}

async function finishRefreshResult(
  job: AgentJobRow,
  summary: PipelineSummary,
  result: JsonMap
): Promise<JsonMap> {
  await refreshPipelineInventory(job, summary);
  finalizePipelineSummary(summary);
  return {
    ...result,
    summary,
  };
}

function tenantRedditConfig(sources: UserSourceRow[]): {
  author: string;
  allowedSubreddits: string[];
  processingSources: UserSourceRow[];
} {
  const author = sources
    .map(source => sourceScopeFor(source) === 'generic_rss' ? '' : explicitSourceAuthor(source))
    .find(Boolean) || '';
  const allowedSubreddits = uniqueStrings(
    sources
      .filter(source => sourceScopeFor(source) !== 'generic_rss')
      .flatMap(source => explicitSourceSubreddits(source))
  );
  return {
    author,
    allowedSubreddits,
    processingSources: sources.filter(source => source.enabled),
  };
}

function toQueueRows(
  userId: string,
  slot: ScheduledPlatformSlot,
  post: RedditPost,
  sourceUrl: string,
  angle: AngleCandidate,
  draft: Awaited<ReturnType<typeof ai.draftPlatforms>>,
  platforms: PlatformKey[],
  timeZone: string,
  angleRecordId?: string
): Array<Record<string, unknown>> {
  return platforms
    .map(platform => ({
      user_id: userId,
      slot_index: slot.slotIndex,
      scheduled_for: slot.scheduledFor,
      ...scheduledSlotWriteFields(slot, timeZone),
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
  occupiedSlots: PlatformSlotOccupancy,
  timeZone: string,
  summary?: PipelineSummary
): Promise<QueueFromAnglesResult> {
  const result: QueueFromAnglesResult = {
    queued: 0,
    draftableSeen: 0,
    failures: 0,
    rejected: 0,
  };
  let instagramImageGenerationBlocked = false;

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
      const reason = !platform ? 'disabled_or_missing_platform' : 'missing_source_metadata';
      await supabaseUpdate('angle_records', {
        status: 'rejected',
      }, {
        filters: [
          { column: 'id', operator: 'eq', value: angleRow.id },
          { column: 'user_id', operator: 'eq', value: job.user_id },
        ],
      });
      result.rejected++;
      if (summary) {
        summary.angles.legacyRejected++;
        if (!platform) summary.angles.disabledPlatformRejected++;
        else summary.angles.missingMetadataRejected++;
        incrementCounter(summary.angles.rejectionReasons, reason);
      }
      await writeWorkerLog(job.user_id, 'warn', 'legacy_angle_quarantined', {
        jobId: job.id,
        angleId: angleRow.id,
        reason,
      });
      continue;
    }

    result.draftableSeen++;
    if (platform === 'instagram' && instagramImageGenerationBlocked) {
      if (summary) {
        summary.drafts.skipped++;
        incrementCounter(summary.drafts.skipReasons, 'instagram_image_generation_unavailable');
      }
      await writeWorkerLog(job.user_id, 'warn', 'banked_angle_draft_skipped', {
        jobId: job.id,
        angleId: angleRow.id,
        platform,
        reason: 'instagram_image_generation_unavailable',
        next_action: ai.OPENAI_IMAGE_GENERATION_ABORTED_NEXT_ACTION,
      });
      continue;
    }

    if (platform === 'instagram' && !hasOpenActiveSlotForPlatform(platform, occupiedSlots)) {
      if (summary) {
        summary.drafts.skipped++;
        incrementCounter(summary.drafts.skipReasons, 'instagram_no_open_slot');
      }
      await writeWorkerLog(job.user_id, 'info', 'banked_angle_draft_skipped', {
        jobId: job.id,
        angleId: angleRow.id,
        platform,
        reason: 'instagram_no_open_slot',
        message: 'Instagram image generation was skipped because no Instagram slot is open.',
      });
      continue;
    }

    if (summary) summary.drafts.attempted++;
    const slot = nextOpenPlatformSlot(platform, occupiedSlots, timeZone);

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
    if (!currentAngle) {
      if (summary) {
        summary.drafts.skipped++;
        incrementCounter(summary.drafts.skipReasons, 'angle_lock_not_acquired');
      }
      continue;
    }

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
    const sourceSummary: SourceSummary = {
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
        sourceSummary,
        selectedAngle,
        [platform],
        { disableLearningMemory: true, disableImageGeneration: platform !== 'instagram' }
      );
      if (platform === 'instagram' && !cloudinary.isCloudinaryUrl(draft.imageUrl)) {
        throw new WorkerJobError('instagram_image_not_persisted', 'instagram_image_not_persisted');
      }
      const rows = toQueueRows(
        job.user_id,
        slot,
        post,
        currentAngle.source_url || `banked-angle:${currentAngle.id}`,
        selectedAngle,
        draft,
        [platform],
        timeZone,
        currentAngle.id
      );
      if (!rows.length) {
        await supabaseUpdate('angle_records', { status: 'exhausted' }, {
          filters: [
            { column: 'id', operator: 'eq', value: currentAngle.id },
            { column: 'user_id', operator: 'eq', value: job.user_id },
          ],
        });
        if (summary) {
          summary.drafts.skipped++;
          incrementCounter(summary.drafts.skipReasons, 'no_draft_text_created');
        }
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
      occupiedSlots.add(platformSlotOccupancyKey(platform, slot.localDate, slot.slotIndex));
      result.queued += rows.length;
      if (summary) {
        summary.queue.created += rows.length;
        summary.drafts.created += rows.length;
        for (const row of rows) {
          incrementCounter(summary.queue.createdByPlatform, String(row.platform || platform));
        }
      }
      await writeWorkerLog(job.user_id, 'info', 'queued_banked_angle', {
        jobId: job.id,
        slotIndex: slot.slotIndex,
        localDate: slot.localDate,
        localHour: slot.localHour,
        scheduledFor: slot.scheduledFor,
        timeZone,
        angleId: currentAngle.id,
        platforms: rows.map(row => row.platform),
      });
    } catch (error) {
      result.failures++;
      const imageError = ai.openAIImageErrorDetails(error);
      const textError = imageError ? undefined : ai.openAITextErrorDetails(error, ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE);
      if (summary) {
        summary.drafts.failures++;
        incrementCounter(summary.drafts.failuresByPlatform, platform);
        incrementCounter(summary.drafts.failureReasons, imageError?.code || textError?.code || errorFailureReason(error));
        if (imageError) {
          instagramImageGenerationBlocked = platform === 'instagram';
          if (!summary.errors.includes(imageError.userMessage)) {
            summary.errors.push(imageError.userMessage);
          }
          summary.failedStage ||= imageError.stage;
          summary.failureCode ||= imageError.code;
        } else if (textError) {
          if (!summary.errors.includes(textError.userMessage)) {
            summary.errors.push(textError.userMessage);
          }
          summary.failedStage ||= textError.stage;
          summary.failureCode ||= textError.code;
        } else {
          addSummaryError(summary, error);
        }
      }
      await supabaseUpdate('angle_records', {
        status: 'unused',
      }, {
        filters: [
          { column: 'id', operator: 'eq', value: currentAngle.id },
          { column: 'user_id', operator: 'eq', value: job.user_id },
        ],
      });
      const draftErrorContext = safeErrorContext(error);
      await writeWorkerLog(job.user_id, 'warn', 'banked_angle_draft_failed', {
        jobId: job.id,
        angleId: currentAngle.id,
        platform,
        error: publicError(error),
        ...(draftErrorContext || {}),
      });
      if (textError?.systemic) {
        await writeWorkerLog(job.user_id, 'warn', 'banked_angle_draft_stopped', {
          jobId: job.id,
          angleId: currentAngle.id,
          normalized_error_code: textError.code,
          stage: textError.stage,
          next_action: textError.nextAction,
        });
        return result;
      }
    }
  }

  return result;
}

async function handleRefreshQueue(job: AgentJobRow, tenant: TenantContext): Promise<JsonMap> {
  const sources = await supabaseSelect<UserSourceRow>('user_sources', {
    select: '*',
    filters: [{ column: 'user_id', operator: 'eq', value: job.user_id }],
    order: 'created_at.asc',
    limit: 100,
  });
  const timeZone = tenantAutomationTimeZone(tenant);
  const occupiedSlots = await loadActiveSlotOccupancy(job.user_id, timeZone);
  const summary = await createPipelineSummary(job, tenant, sources, occupiedSlots);
  const fillExistingAnglesOnly = job.payload?.fill_existing_angles_only === true;
  if (fillExistingAnglesOnly) {
    summary.mode = 'fill_existing_angles';
  }

  if (!config.OPENAI_API_KEY) {
    summary.drafts.skipped++;
    incrementCounter(summary.drafts.skipReasons, 'openai_api_key_missing');
    return finishRefreshResult(job, summary, { fetched: 0, banked: 0, queued: 0 });
  }
  if (!tenant.activePlatforms.length) {
    summary.drafts.skipped++;
    incrementCounter(summary.drafts.skipReasons, 'no_enabled_platforms');
    return finishRefreshResult(job, summary, { fetched: 0, banked: 0, queued: 0 });
  }

  let queued = 0;

  if (summary.angles.activeAtStart > 0) {
    const bankedResult = await queueFromBankedAngles(job, tenant, occupiedSlots, timeZone, summary);
    queued += bankedResult.queued;
    if (queued > 0) {
      return finishRefreshResult(job, summary, { fetched: 0, banked: 0, queued, deferredFetch: true });
    }

    if (bankedResult.draftableSeen > 0 && await hasActiveBankedAngles(job.user_id)) {
      return finishRefreshResult(job, summary, { fetched: 0, banked: 0, queued, deferredFetch: true });
    }
  }

  if (fillExistingAnglesOnly) {
    return finishRefreshResult(job, summary, {
      fetched: 0,
      banked: 0,
      queued,
      fillExistingAnglesOnly: true,
      deferredFetch: true,
    });
  }

  const enabledSources = sources.filter(source => source.enabled);
  if (!enabledSources.length) {
    return finishRefreshResult(job, summary, { fetched: 0, banked: 0, queued: 0 });
  }

  const sourceUrlsWithAngles = await loadSourceUrlsWithAngles(job.user_id);
  const { author: tenantAuthor, allowedSubreddits: tenantAllowedSubreddits, processingSources } = tenantRedditConfig(enabledSources);
  if (!processingSources.length) {
    summary.drafts.skipped++;
    incrementCounter(summary.drafts.skipReasons, 'no_processable_sources');
    return finishRefreshResult(job, summary, { fetched: 0, banked: 0, queued: 0 });
  }

  let fetched = 0;
  let banked = 0;
  let stopSourceProcessing = false;

  for (const source of processingSources) {
    if (stopSourceProcessing) break;
    summary.sources.checked++;
    const intent = sourceIntentFor(source, tenantAuthor, tenantAllowedSubreddits);
    const preflightRejectReason = preflightSourceIntentRejectReason(intent);
    if (preflightRejectReason) {
      summarizeRejectedSource(summary, preflightRejectReason);
      await writeWorkerLog(job.user_id, 'warn', 'source_intent_rejected', {
        jobId: job.id,
        sourceId: source.id,
        kind: source.kind,
        provider: intent.provider,
        acquisition_mode: intent.acquisitionMode,
        source_scope: intent.sourceScope,
        accepted_count: 0,
        rejected_count: 1,
        rejection_reasons: { [preflightRejectReason]: 1 },
      });
      continue;
    }

    let posts: RedditPost[];
    let adapter: SourceFetchAdapter | undefined;
    let fetchResult: SourceFetchResult;
    try {
      fetchResult = await fetchTenantSourcePosts(source, job.user_id, job.id);
      posts = fetchResult.posts;
      adapter = fetchResult.adapter;
    } catch (error) {
      const reason = publicError(error);
      summary.sources.fetchFailures++;
      incrementCounter(summary.sources.fetchFailureReasons, reason);
      addSummaryError(summary, error);
      await writeWorkerLog(job.user_id, 'warn', 'source_fetch_failed', {
        jobId: job.id,
        sourceId: source.id,
        kind: source.kind,
        adapter: sourceFetchAdapterFromError(error)
          || (source.kind === 'rss' && sourceScopeFor(source) === 'generic_rss' ? 'generic_rss' : undefined)
          || (source.kind === 'rss' ? 'reddit_rss' : 'reddit_public_json'),
        error: reason,
        ...sourceFetchContextFromError(error),
      });
      continue;
    }

    summary.sources.postsFetched += posts.length;
    const sourcePosts: RedditPost[] = [];
    const rejectionReasons: Record<string, number> = {};
    for (const post of posts) {
      const postRejectReasons = sourceIntentRejectReasons(post, intent);
      if (!postRejectReasons.length) {
        sourcePosts.push(post);
        continue;
      }
      summary.sources.rejected++;
      for (const reason of postRejectReasons) {
        incrementCounter(rejectionReasons, reason);
        incrementCounter(summary.sources.rejectionReasons, reason);
        if (reason === 'rejected_author_mismatch') summary.sources.rejectedByAuthor++;
        if (reason === 'rejected_subreddit_mismatch') summary.sources.rejectedBySubreddit++;
        if (reason === 'rejected_unfiltered_rss_not_allowed') summary.sources.rejectedUnfilteredRss++;
      }
    }
    summary.sources.postsAccepted += sourcePosts.length;
    summary.sources.accepted += sourcePosts.length;
    fetched += sourcePosts.length;
    await writeWorkerLog(job.user_id, sourcePosts.length ? 'info' : 'warn', 'source_intent_filter_applied', {
      jobId: job.id,
      sourceId: source.id,
      kind: source.kind,
      adapter,
      endpoint_kind: fetchResult.endpointKind,
      provider: intent.provider,
      acquisition_mode: intent.acquisitionMode,
      source_scope: intent.sourceScope,
      runtime: fetchResult.runtime,
      status: fetchResult.status,
      transport: fetchResult.transport,
      target_author_configured: Boolean(intent.targetAuthor),
      allowed_subreddits_count: intent.allowedSubreddits.length,
      allow_unfiltered_rss: intent.allowUnfilteredRss,
      fetched_count: posts.length,
      accepted_count: sourcePosts.length,
      rejected_count: Math.max(0, posts.length - sourcePosts.length),
      rejection_reasons: rejectionReasons,
    });

    const acceptedSourceRecords: Array<{
      post: RedditPost;
      sourceRecordId: string | null;
      sourceUrl: string;
    }> = sourcePosts.map(post => ({
      post,
      sourceRecordId: null,
      sourceUrl: canonicalSourceUrl(post),
    }));
    const sourceRecordIds = await saveAcceptedSourceRecords(job, source, acceptedSourceRecords, summary);
    for (const record of acceptedSourceRecords) {
      record.sourceRecordId = sourceRecordIds.get(record.sourceUrl) || null;
    }

    for (const { post, sourceRecordId, sourceUrl } of acceptedSourceRecords) {
      if (sourceUrlsWithAngles.has(sourceUrl)) {
        summary.sources.duplicatesSkipped++;
        summary.angles.alreadyExisting++;
        continue;
      }

      let extraction: Awaited<ReturnType<typeof ai.extractSourceBank>>;
      try {
        extraction = await extractSourceBankWithJobTimeout(post);
      } catch (error) {
        const textError = ai.openAITextErrorDetails(error, ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE);
        const failureCode = textError?.code || 'angle_extraction_failed';
        summary.sources.withoutAngles++;
        summary.angles.extractionFailures++;
        incrementCounter(summary.angles.failureReasons, failureCode);
        if (textError) {
          if (!summary.errors.includes(textError.userMessage)) {
            summary.errors.push(textError.userMessage);
          }
          summary.failedStage ||= textError.stage;
          summary.failureCode ||= textError.code;
        } else {
          addSummaryError(summary, error);
          summary.failedStage ||= ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE;
          summary.failureCode ||= failureCode;
        }
        await writeWorkerLog(job.user_id, 'warn', 'source_angle_extraction_failed', {
          jobId: job.id,
          sourceId: source.id,
          sourceUrl,
          error: textError?.userMessage || publicError(error),
          normalized_error_code: failureCode,
          stage: ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE,
          next_action: textError?.nextAction || 'Open Logs for the failed angle extraction reason, then retry Fetch sources.',
          systemic: textError?.systemic === true,
        });
        if (textError?.systemic) {
          stopSourceProcessing = true;
          await writeWorkerLog(job.user_id, 'warn', 'source_angle_extraction_stopped', {
            jobId: job.id,
            sourceId: source.id,
            sourceUrl,
            normalized_error_code: textError.code,
            stage: textError.stage,
            next_action: textError.nextAction,
          });
          break;
        }
        continue;
      }

      const angles = extraction.angles.slice(0, 5);
      if (!angles.length) {
        summary.sources.withoutAngles++;
        continue;
      }

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

      try {
        await supabaseInsert('angle_records', angleRows);
      } catch (error) {
        addSummaryError(summary, error);
        await writeWorkerLog(job.user_id, 'warn', 'angle_insert_failed', {
          jobId: job.id,
          sourceId: source.id,
          sourceUrl,
          error: publicError(error),
        });
        continue;
      }
      banked += angleRows.length;
      summary.angles.created += angleRows.length;
      sourceUrlsWithAngles.add(sourceUrl);

      const queuedFromAngles = await queueFromBankedAngles(job, tenant, occupiedSlots, timeZone, summary);
      queued += queuedFromAngles.queued;
      await writeWorkerLog(job.user_id, 'info', 'source_banked_angles', {
        jobId: job.id,
        sourceId: source.id,
        sourceUrl,
        angleCount: angleRows.length,
      });

      if (queued > 0 || await hasActiveBankedAngles(job.user_id)) break;
    }

    if (queued > 0 || await hasActiveBankedAngles(job.user_id)) break;
  }

  if (queued === 0) {
    const queuedFromAngles = await queueFromBankedAngles(job, tenant, occupiedSlots, timeZone, summary);
    queued += queuedFromAngles.queued;
  }

  return finishRefreshResult(job, summary, { fetched, banked, queued });
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
      if (!cloudinary.isCloudinaryUrl(row.instagram_image_url)) {
        throw new WorkerJobError('instagram_image_url_not_persisted', 'instagram_image_url_not_persisted');
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
    if (current.platform === 'instagram' && !cloudinary.isCloudinaryUrl(current.instagram_image_url || undefined)) {
      const image = await ai.ensurePersistentInstagramImage({
        imageUrl: current.instagram_image_url,
        imagePrompt: current.instagram_image_prompt,
        title: current.source_title || current.angle || 'Instagram post',
        text: current.draft_text || '',
      });
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

    const authMode = current.platform === 'x'
      ? await verifyXCredentialForPublish(job.user_id)
      : undefined;
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
    const publishedAt = nowIso();
    const publishHistoryRows = await supabaseInsert<PublishHistoryRow>('publish_history', {
      user_id: job.user_id,
      platform: current.platform,
      post_text: current.draft_text || null,
      external_post_id: externalPostId,
      source_url: current.source_url || null,
      published_at: publishedAt,
    }, true);
    const publishHistory = publishHistoryRows[0];
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
      ...(authMode ? { auth_mode: authMode } : {}),
      externalPostId,
      publishHistoryId: publishHistory?.id || null,
    });
    return publishSuccessResult(job, current, publishHistory, externalPostId, nowIso(), authMode);
  } catch (error) {
    const message = publicError(error);
    const imageErrorContext = safeErrorContext(error);
    if (current.platform === 'instagram' && imageErrorContext?.stage === ai.OPENAI_IMAGE_GENERATION_STAGE) {
      await writeWorkerLog(job.user_id, 'warn', 'instagram_image_generation_failed', {
        jobId: job.id,
        queueItemId: current.id,
        platform: current.platform,
        ...imageErrorContext,
      });
    }
    if (isPlatformPublishError(error)) {
      await writeWorkerLog(job.user_id, 'warn', 'platform_publish_failed', {
        jobId: job.id,
        queueItemId: current.id,
        ...platformErrorContext(error),
      });
    }
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

async function hasEnabledSource(userId: string): Promise<boolean> {
  const rows = await supabaseSelect<UserSourceRow>('user_sources', {
    select: 'id',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'enabled', operator: 'eq', value: true },
    ],
    limit: 1,
  });
  return rows.length > 0;
}

async function hasPendingOrRunningFetch(userId: string): Promise<boolean> {
  const rows = await supabaseSelect<AgentJobRow>('agent_jobs', {
    select: 'id,status,payload',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'kind', operator: 'in', value: ['fetch_sources', 'refresh_queue'] },
      { column: 'status', operator: 'in', value: ['pending', 'running'] },
    ],
    limit: 10,
  });
  return rows.length > 0;
}

async function hasDraftableActiveAngle(userId: string, platforms: PlatformKey[]): Promise<boolean> {
  if (!platforms.length) return false;
  const rows = await supabaseSelect<AngleRecordRow>('angle_records', {
    select: 'id,intended_platform,source_reddit_post_id,source_url,subreddit,reddit_author',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'status', operator: 'in', value: ACTIVE_ANGLE_STATUSES },
      { column: 'intended_platform', operator: 'in', value: platforms },
    ],
    limit: 50,
  });
  return rows.some(isDraftableAngle);
}

async function hasPendingOrRunningPublish(userId: string, queueItemId: string): Promise<boolean> {
  const rows = await supabaseSelect<AgentJobRow>('agent_jobs', {
    select: 'id,status,payload',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'kind', operator: 'eq', value: 'publish_now' },
      { column: 'status', operator: 'in', value: ['pending', 'running'] },
    ],
    limit: 50,
  });
  return rows.some(row => queueItemIdFromPayload(row.payload) === queueItemId);
}

function cadenceMinutes(settings: AutomationSettingsRow): number {
  const value = Number(settings.automation_cadence_minutes || 1440);
  if (!Number.isFinite(value)) return 1440;
  return Math.max(15, Math.min(Math.round(value), 10080));
}

function fetchIsDue(settings: AutomationSettingsRow, now: Date): boolean {
  if (!settings.next_fetch_at) return true;
  const dueAt = Date.parse(settings.next_fetch_at);
  return !Number.isFinite(dueAt) || dueAt <= now.getTime();
}

function hasRecentOpenAIAutomationFailure(settings: AutomationSettingsRow, now: Date): boolean {
  const result = settings.last_automation_result;
  if (!result || result.status !== 'failed') return false;
  const failureCode = String(result.failureCode || '');
  if (!failureCode.startsWith('openai_')) return false;
  const completedAt = Date.parse(String(result.completedAt || ''));
  if (!Number.isFinite(completedAt)) return false;
  return now.getTime() - completedAt < 15 * 60_000;
}

async function updateAutomationResult(
  userId: string,
  result: JsonMap,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    await supabaseUpdate('user_settings', {
      ...extra,
      last_automation_result: result,
    }, {
      filters: [{ column: 'user_id', operator: 'eq', value: userId }],
    });
  } catch (error) {
    logger.warn(`Automation result update failed: ${publicError(error)}`);
  }
}

async function recordAutomationSkip(
  userId: string,
  kind: string,
  reason: string,
  message: string,
  nextAction: string
): Promise<void> {
  await updateAutomationResult(userId, {
    kind,
    status: 'skipped',
    origin: 'scheduled',
    reason,
    message,
    nextAction,
    checkedAt: nowIso(),
  });
}

async function enqueueDueFetchJobs(stats: SchedulerStats, now: Date): Promise<void> {
  const settingsRows = await supabaseSelect<AutomationSettingsRow>('user_settings', {
    select: '*',
    filters: [
      { column: 'automation_enabled', operator: 'eq', value: true },
      { column: 'automation_fetch_enabled', operator: 'eq', value: true },
    ],
    limit: 200,
  });

  for (const settings of settingsRows) {
    stats.tenantsChecked++;
    if (!fetchIsDue(settings, now)) {
      incrementSchedulerSkip(stats, 'fetch_not_due');
      continue;
    }

    const entitlement = await loadEntitlement(settings.user_id);
    if (!entitlement.canWrite) {
      incrementSchedulerSkip(stats, `fetch_access_${entitlement.reason}`);
      await recordAutomationSkip(
        settings.user_id,
        'fetch_sources',
        entitlement.reason,
        'Scheduled fetch is blocked by billing or access state.',
        'Restore billing access or dev/test access, then wait for the next scheduled run.'
      );
      continue;
    }

    if (!(await hasEnabledSource(settings.user_id))) {
      incrementSchedulerSkip(stats, 'fetch_no_enabled_sources');
      await recordAutomationSkip(
        settings.user_id,
        'fetch_sources',
        'no_enabled_sources',
        'Automation is enabled, but no enabled sources are configured.',
        'Add an enabled Reddit user, subreddit, or approved discovery feed.'
      );
      continue;
    }

    if (await hasPendingOrRunningFetch(settings.user_id)) {
      incrementSchedulerSkip(stats, 'fetch_already_pending_or_running');
      continue;
    }

    const dueAt = settings.next_fetch_at || now.toISOString();
    const inserted = await supabaseInsert<AgentJobRow>('agent_jobs', {
      user_id: settings.user_id,
      kind: 'fetch_sources',
      payload: {
        source: SCHEDULED_SOURCE,
        scheduler: SCHEDULER_NAME,
        due_at: dueAt,
      },
    }, true);
    const job = inserted[0];
    const nextFetchAt = addMinutesIso(now, cadenceMinutes(settings));
    await supabaseUpdate('user_settings', {
      last_scheduled_fetch_at: now.toISOString(),
      last_scheduled_job_id: job?.id || null,
      next_fetch_at: nextFetchAt,
      last_automation_result: {
        jobId: job?.id || null,
        kind: 'fetch_sources',
        status: 'pending',
        origin: 'scheduled',
        message: 'Scheduled fetch was queued by Cloudflare cron.',
        nextAction: 'Wait for the worker to process this scheduled fetch.',
        dueAt,
        nextFetchAt,
      },
    }, {
      filters: [{ column: 'user_id', operator: 'eq', value: settings.user_id }],
    });
    stats.fetchJobsEnqueued++;
    await writeWorkerLog(settings.user_id, 'info', 'scheduled_fetch_enqueued', {
      jobId: job?.id || null,
      dueAt,
      nextFetchAt,
      scheduler: SCHEDULER_NAME,
    });
  }
}

async function enqueueDueSlotFillJobs(stats: SchedulerStats, now: Date): Promise<void> {
  const settingsRows = await supabaseSelect<AutomationSettingsRow>('user_settings', {
    select: '*',
    filters: [
      { column: 'automation_enabled', operator: 'eq', value: true },
      { column: 'automation_publish_enabled', operator: 'eq', value: true },
    ],
    limit: 200,
  });

  for (const settings of settingsRows) {
    stats.tenantsChecked++;

    if (hasRecentOpenAIAutomationFailure(settings, now)) {
      incrementSchedulerSkip(stats, 'fill_recent_openai_failure');
      continue;
    }

    const entitlement = await loadEntitlement(settings.user_id);
    if (!entitlement.canWrite) {
      incrementSchedulerSkip(stats, `fill_access_${entitlement.reason}`);
      await recordAutomationSkip(
        settings.user_id,
        'refresh_queue',
        entitlement.reason,
        'Scheduled slot fill is blocked by billing or access state.',
        'Restore billing access or dev/test access before automation can fill open slots.'
      );
      continue;
    }

    const tenant = await loadTenantContext(settings.user_id);
    if (!tenant.activePlatforms.length) {
      incrementSchedulerSkip(stats, 'fill_no_enabled_platforms');
      continue;
    }

    if (await hasPendingOrRunningFetch(settings.user_id)) {
      incrementSchedulerSkip(stats, 'fill_already_pending_or_running');
      continue;
    }

    if (!(await hasDraftableActiveAngle(settings.user_id, tenant.activePlatforms))) {
      incrementSchedulerSkip(stats, 'fill_no_unused_angles');
      continue;
    }

    const inserted = await supabaseInsert<AgentJobRow>('agent_jobs', {
      user_id: settings.user_id,
      kind: 'refresh_queue',
      payload: {
        source: SCHEDULED_SOURCE,
        scheduler: SCHEDULER_NAME,
        mode: 'fill_existing_angles',
        fill_existing_angles_only: true,
        due_at: now.toISOString(),
      },
    }, true);
    const job = inserted[0];
    await updateAutomationResult(settings.user_id, {
      jobId: job?.id || null,
      kind: 'refresh_queue',
      status: 'pending',
      origin: 'scheduled',
      mode: 'fill_existing_angles',
      message: 'Scheduled slot fill was queued from existing unused angles.',
      nextAction: 'Wait for the worker to draft an unused angle into the next open slot.',
      dueAt: now.toISOString(),
    }, {
      last_scheduled_job_id: job?.id || null,
    });
    stats.slotFillJobsEnqueued++;
    await writeWorkerLog(settings.user_id, 'info', 'scheduled_slot_fill_enqueued', {
      jobId: job?.id || null,
      dueAt: now.toISOString(),
      scheduler: SCHEDULER_NAME,
    });
  }
}

async function loadAutomationSettingsByUser(): Promise<Map<string, AutomationSettingsRow>> {
  const rows = await supabaseSelect<AutomationSettingsRow>('user_settings', {
    select: '*',
    filters: [{ column: 'automation_enabled', operator: 'eq', value: true }],
    limit: 500,
  });
  return new Map(rows.map(row => [row.user_id, row]));
}

async function enqueueDuePublishJobs(stats: SchedulerStats, now: Date): Promise<void> {
  const settingsByUser = await loadAutomationSettingsByUser();
  const dueRows = await supabaseSelect<QueueItemRow>('queue_items', {
    select: 'id,user_id,platform,status,slot_index,scheduled_for,scheduled_local_date,scheduled_timezone',
    filters: [
      { column: 'status', operator: 'in', value: ['pending', 'ready'] },
      { column: 'scheduled_for', operator: 'lte', value: now.toISOString() },
    ],
    order: 'scheduled_for.asc',
    limit: 100,
  });

  for (const row of dueRows) {
    const settings = settingsByUser.get(row.user_id);
    if (!settings || !settings.automation_publish_enabled) {
      incrementSchedulerSkip(stats, 'publish_automation_disabled');
      continue;
    }

    const entitlement = await loadEntitlement(row.user_id);
    if (!entitlement.canWrite) {
      incrementSchedulerSkip(stats, `publish_access_${entitlement.reason}`);
      await recordAutomationSkip(
        row.user_id,
        'publish_now',
        entitlement.reason,
        'Scheduled publish is blocked by billing or access state.',
        'Restore billing access or dev/test access before scheduled publishing can continue.'
      );
      continue;
    }

    if (await hasPendingOrRunningPublish(row.user_id, row.id)) {
      incrementSchedulerSkip(stats, 'publish_already_pending_or_running');
      continue;
    }

    const inserted = await supabaseInsert<AgentJobRow>('agent_jobs', {
      user_id: row.user_id,
      kind: 'publish_now',
      payload: {
        source: SCHEDULED_SOURCE,
        scheduler: SCHEDULER_NAME,
        queue_item_id: row.id,
        due_at: row.scheduled_for,
      },
    }, true);
    const job = inserted[0];
    await updateAutomationResult(row.user_id, {
      jobId: job?.id || null,
      kind: 'publish_now',
      status: 'pending',
      origin: 'scheduled',
      message: `Scheduled ${row.platform} publish was queued.`,
      nextAction: 'Wait for the worker to publish this due queue item.',
      queueItemId: row.id,
      dueAt: row.scheduled_for,
    }, {
      last_scheduled_job_id: job?.id || null,
    });
    stats.publishJobsEnqueued++;
    await writeWorkerLog(row.user_id, 'info', 'scheduled_publish_enqueued', {
      jobId: job?.id || null,
      queueItemId: row.id,
      platform: row.platform,
      dueAt: row.scheduled_for,
      scheduler: SCHEDULER_NAME,
    });
  }
}

function textFromWorkerLog(row: WorkerLogRow): string {
  return `${row.message} ${row.context ? JSON.stringify(row.context) : ''}`;
}

interface StaleFailureDetails {
  code: string;
  nextAction: string;
  platform?: string;
  stage: string;
  userMessage: string;
}

function logContext(row: WorkerLogRow): JsonMap {
  return row.context && typeof row.context === 'object' && !Array.isArray(row.context)
    ? row.context
    : {};
}

function logString(context: JsonMap, key: string): string {
  const value = context[key];
  return typeof value === 'string' ? value : '';
}

function logNumber(context: JsonMap, key: string): number {
  const value = context[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function logStringArray(context: JsonMap, key: string): string[] {
  const value = context[key];
  return Array.isArray(value) ? value.map(item => String(item || '')).filter(Boolean) : [];
}

function logCounter(context: JsonMap, key: string): Record<string, number> {
  const value = context[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const counter: Record<string, number> = {};
  for (const [name, count] of Object.entries(value)) {
    const numeric = typeof count === 'number' && Number.isFinite(count) ? count : Number(count || 0);
    if (numeric > 0) counter[name] = numeric;
  }
  return counter;
}

function imageFailureFromContext(context: JsonMap): StaleFailureDetails | undefined {
  const stage = logString(context, 'stage');
  const code = logString(context, 'normalized_error_code') || logString(context, 'failureCode');
  if (stage !== ai.OPENAI_IMAGE_GENERATION_STAGE && !code.startsWith('openai_image_')) {
    return undefined;
  }

  const userMessage = logString(context, 'user_message') || (
    code === ai.OPENAI_IMAGE_BILLING_BLOCKED_CODE
      ? ai.OPENAI_IMAGE_BILLING_BLOCKED_MESSAGE
      : code === ai.OPENAI_IMAGE_GENERATION_ABORTED_CODE
      ? ai.OPENAI_IMAGE_GENERATION_ABORTED_MESSAGE
      : ai.OPENAI_IMAGE_GENERATION_FAILED_MESSAGE
  );
  const nextAction = logString(context, 'next_action') || (
    code === ai.OPENAI_IMAGE_BILLING_BLOCKED_CODE
      ? ai.OPENAI_IMAGE_BILLING_BLOCKED_NEXT_ACTION
      : code === ai.OPENAI_IMAGE_GENERATION_ABORTED_CODE
      ? ai.OPENAI_IMAGE_GENERATION_ABORTED_NEXT_ACTION
      : ai.OPENAI_IMAGE_GENERATION_FAILED_NEXT_ACTION
  );

  return {
    code: code || ai.OPENAI_IMAGE_GENERATION_FAILED_CODE,
    nextAction,
    platform: logString(context, 'platform') || 'instagram',
    stage: ai.OPENAI_IMAGE_GENERATION_STAGE,
    userMessage,
  };
}

function textFailureFromLog(row: WorkerLogRow): StaleFailureDetails | undefined {
  const context = logContext(row);
  const stage = logString(context, 'stage');
  const code = logString(context, 'normalized_error_code') || logString(context, 'failureCode');
  if (stage && stage !== ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE) {
    return undefined;
  }
  if (code && !code.startsWith('openai_text_')) {
    return undefined;
  }
  const details = ai.openAITextErrorDetails(
    new Error(logString(context, 'user_message') || logString(context, 'error') || textFromWorkerLog(row)),
    ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE
  );
  if (!details?.systemic) return undefined;
  return {
    code: details.code,
    nextAction: details.nextAction,
    stage: details.stage,
    userMessage: details.userMessage,
  };
}

function staleFailureFromLogs(logs: WorkerLogRow[]): StaleFailureDetails | undefined {
  for (const row of logs) {
    const imageFailure = imageFailureFromContext(logContext(row));
    if (imageFailure) return imageFailure;
  }
  for (const row of logs) {
    const textFailure = textFailureFromLog(row);
    if (textFailure) return textFailure;
  }
  return undefined;
}

async function staleJobLogs(job: AgentJobRow): Promise<WorkerLogRow[]> {
  if (!job.started_at) return [];
  const logs = await supabaseSelect<WorkerLogRow>('worker_logs', {
    select: 'level,message,context,created_at',
    filters: [
      { column: 'user_id', operator: 'eq', value: job.user_id },
      { column: 'created_at', operator: 'gte', value: job.started_at },
    ],
    order: 'created_at.desc',
    limit: 50,
  });
  return logs.filter(row => logString(logContext(row), 'jobId') === job.id);
}

function reconstructStaleSummary(logs: WorkerLogRow[], failure?: StaleFailureDetails): JsonMap {
  const sources: JsonMap = {
    postsFetched: 0,
    postsAccepted: 0,
    rejected: 0,
    fetchFailures: 0,
    recordsCreated: 0,
    recordsUpdated: 0,
    rejectionReasons: {},
    fetchFailureReasons: {},
  };
  const angles: JsonMap = {
    created: 0,
    extractionFailures: 0,
    failureReasons: {},
  };
  const drafts: JsonMap = {
    attempted: 0,
    created: 0,
    failures: 0,
    failureReasons: {},
    failuresByPlatform: {},
  };
  const queue: JsonMap = {
    created: 0,
    ready: 0,
    createdByPlatform: {},
  };

  for (const row of logs) {
    const context = logContext(row);
    if (row.message === 'source_intent_filter_applied') {
      sources.checked = Number(sources.checked || 0) + 1;
      sources.postsFetched = Number(sources.postsFetched || 0) + logNumber(context, 'fetched_count');
      sources.postsAccepted = Number(sources.postsAccepted || 0) + logNumber(context, 'accepted_count');
      sources.rejected = Number(sources.rejected || 0) + logNumber(context, 'rejected_count');
      for (const [reason, count] of Object.entries(logCounter(context, 'rejection_reasons'))) {
        const target = sources.rejectionReasons as Record<string, number>;
        target[reason] = (target[reason] || 0) + count;
        if (reason === 'rejected_author_mismatch') {
          sources.rejectedByAuthor = Number(sources.rejectedByAuthor || 0) + count;
        }
        if (reason === 'rejected_subreddit_mismatch') {
          sources.rejectedBySubreddit = Number(sources.rejectedBySubreddit || 0) + count;
        }
        if (reason === 'rejected_unfiltered_rss_not_allowed') {
          sources.rejectedUnfilteredRss = Number(sources.rejectedUnfilteredRss || 0) + count;
        }
      }
    }
    if (row.message === 'source_records_saved') {
      sources.recordsCreated = Number(sources.recordsCreated || 0) + logNumber(context, 'records_created');
      sources.recordsUpdated = Number(sources.recordsUpdated || 0) + logNumber(context, 'records_updated');
    }
    if (row.message === 'source_banked_angles') {
      angles.created = Number(angles.created || 0) + logNumber(context, 'angleCount');
    }
    if (row.message === 'source_angle_extraction_failed') {
      angles.extractionFailures = Number(angles.extractionFailures || 0) + 1;
      const code = logString(context, 'normalized_error_code') || 'angle_extraction_failed';
      const reasons = angles.failureReasons as Record<string, number>;
      reasons[code] = (reasons[code] || 0) + 1;
    }
    if (row.message === 'queued_banked_angle') {
      const platforms = logStringArray(context, 'platforms');
      const created = Math.max(1, platforms.length);
      queue.created = Number(queue.created || 0) + created;
      queue.ready = Number(queue.ready || 0) + created;
      drafts.created = Number(drafts.created || 0) + created;
      for (const platform of platforms) {
        const target = queue.createdByPlatform as Record<string, number>;
        target[platform] = (target[platform] || 0) + 1;
      }
    }
    if (row.message === 'banked_angle_draft_failed') {
      drafts.failures = Number(drafts.failures || 0) + 1;
      const code = logString(context, 'normalized_error_code') || errorFailureReason(new Error(logString(context, 'error')));
      const reasons = drafts.failureReasons as Record<string, number>;
      reasons[code] = (reasons[code] || 0) + 1;
      const platform = logString(context, 'platform') || (code.startsWith('openai_image_') ? 'instagram' : '');
      if (platform) {
        const target = drafts.failuresByPlatform as Record<string, number>;
        target[platform] = (target[platform] || 0) + 1;
      }
    }
  }

  if (failure) {
    if (failure.stage === ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE) {
      angles.extractionFailures = Math.max(1, Number(angles.extractionFailures || 0));
      const reasons = angles.failureReasons as Record<string, number>;
      reasons[failure.code] = Math.max(1, reasons[failure.code] || 0);
    } else {
      drafts.failures = Math.max(1, Number(drafts.failures || 0));
      const reasons = drafts.failureReasons as Record<string, number>;
      reasons[failure.code] = Math.max(1, reasons[failure.code] || 0);
      const platform = failure.platform || 'instagram';
      const platforms = drafts.failuresByPlatform as Record<string, number>;
      platforms[platform] = Math.max(1, platforms[platform] || 0);
    }
  }

  const queueCreated = Number(queue.created || 0);
  const anglesCreated = Number(angles.created || 0);
  const partial = queueCreated > 0 || anglesCreated > 0;
  const imageFailure = failure?.stage === ai.OPENAI_IMAGE_GENERATION_STAGE;
  const textFailure = failure?.stage === ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE;
  const outcome = partial ? 'completed_with_errors' : 'blocked';
  const message = imageFailure && partial
    ? PARTIAL_INSTAGRAM_IMAGE_MESSAGE
    : imageFailure
    ? failure.userMessage
    : textFailure
    ? failure.userMessage
    : partial
    ? 'Automation created drafts for some platforms, but the worker timed out before finalizing the remaining work.'
    : 'The worker job exceeded its safe runtime and was marked failed.';
  const nextAction = imageFailure && partial
    ? PARTIAL_INSTAGRAM_IMAGE_NEXT_ACTION
    : imageFailure
    ? failure.nextAction
    : partial
    ? 'Review the available queue rows, then retry automation for any remaining platforms.'
    : failure?.nextAction || 'Check Logs for the last recorded stage, then retry the action.';

  return {
    outcome,
    message,
    nextAction,
    failedStage: failure?.stage || 'worker_runtime',
    failedPlatform: failure?.platform || (imageFailure ? 'instagram' : null),
    failureCode: failure?.code || 'worker_job_timed_out',
    errors: failure ? [failure.userMessage] : ['worker_job_timed_out'],
    sources,
    angles,
    drafts,
    queue,
  };
}

function staleJobResult(job: AgentJobRow, logs: WorkerLogRow[], failure?: StaleFailureDetails): JsonMap {
  const summary = reconstructStaleSummary(logs, failure);
  return {
    outcome: summary.outcome,
    message: summary.message,
    nextAction: summary.nextAction,
    error: summary.failureCode,
    jobStatus: summary.outcome === 'completed_with_errors' ? 'completed_with_errors' : 'failed',
    summary,
  };
}

function staleMinutesForJob(job: AgentJobRow): number {
  return job.kind === 'refresh_queue'
    ? REFRESH_QUEUE_STALE_RUNNING_JOB_MINUTES
    : STALE_RUNNING_JOB_MINUTES;
}

function hasRecentJobActivity(logs: WorkerLogRow[], cutoffIso: string): boolean {
  const cutoff = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoff)) return false;
  return logs.some(row => {
    const createdAt = Date.parse(row.created_at);
    return Number.isFinite(createdAt) && createdAt > cutoff;
  });
}

function publishStageStarted(logs: WorkerLogRow[], queueItemId: string): boolean {
  return logs.some(row => {
    const context = logContext(row);
    const loggedQueueItemId = logString(context, 'queueItemId');
    if (loggedQueueItemId && loggedQueueItemId !== queueItemId) return false;
    return row.message === 'published_queue_item'
      || row.message === 'platform_publish_failed'
      || row.message === 'instagram_image_generation_failed';
  });
}

async function loadQueueItemForStalePublish(job: AgentJobRow, queueItemId: string): Promise<QueueItemRow | undefined> {
  return (await supabaseSelect<QueueItemRow>('queue_items', {
    select: 'id,user_id,platform,status,slot_index,scheduled_for,source_url,source_title,angle,error_message',
    filters: [
      { column: 'id', operator: 'eq', value: queueItemId },
      { column: 'user_id', operator: 'eq', value: job.user_id },
    ],
    limit: 1,
  }))[0];
}

async function findPublishHistoryForQueueItem(
  job: AgentJobRow,
  row: QueueItemRow
): Promise<PublishHistoryRow | undefined> {
  if (!row.source_url) return undefined;
  return (await supabaseSelect<PublishHistoryRow>('publish_history', {
    select: 'id,user_id,platform,external_post_id,source_url,published_at',
    filters: [
      { column: 'user_id', operator: 'eq', value: job.user_id },
      { column: 'platform', operator: 'eq', value: row.platform },
      { column: 'source_url', operator: 'eq', value: row.source_url },
      { column: 'published_at', operator: 'gte', value: job.started_at || job.created_at },
    ],
    order: 'published_at.desc',
    limit: 1,
  }))[0];
}

function stalePublishResult(
  job: AgentJobRow,
  row: QueueItemRow | undefined,
  history: PublishHistoryRow | undefined,
  logs: WorkerLogRow[]
): JsonMap {
  const queueItemId = queueItemIdFromPayload(job.payload);
  if (!row) {
    const message = 'Scheduled publish timed out, but the queue item no longer exists.';
    const nextAction = 'Review Logs and publish history before retrying scheduled publishing.';
    return {
      outcome: 'blocked',
      message,
      nextAction,
      error: 'queue_item_missing',
      jobStatus: 'failed',
      summary: {
        outcome: 'blocked',
        message,
        nextAction,
        failedStage: 'scheduled_publish',
        failureCode: 'queue_item_missing',
        queueItemId,
        queueItemStatus: 'missing',
        errors: ['queue_item_missing'],
      },
    };
  }
  const platform = row?.platform || 'unknown';
  const reconciled = row?.status === 'published' || Boolean(history);
  const stageStarted = row?.status === 'publishing' || (queueItemId ? publishStageStarted(logs, queueItemId) : false);
  const code = reconciled
    ? PUBLISH_RECONCILED_CODE
    : stageStarted
    ? PUBLISH_UNKNOWN_STATE_CODE
    : PUBLISH_INTERRUPTED_CODE;
  const message = reconciled
    ? PUBLISH_RECONCILED_MESSAGE
    : stageStarted
    ? PUBLISH_UNKNOWN_STATE_MESSAGE
    : PUBLISH_INTERRUPTED_MESSAGE;
  const nextAction = reconciled
    ? PUBLISH_RECONCILED_NEXT_ACTION
    : stageStarted
    ? PUBLISH_UNKNOWN_STATE_NEXT_ACTION
    : PUBLISH_INTERRUPTED_NEXT_ACTION;
  const outcome = reconciled ? 'completed_with_errors' : 'blocked';

  const summary: JsonMap = {
    outcome,
    message,
    nextAction,
    failedStage: reconciled ? 'publish_state_reconciliation' : stageStarted ? 'scheduled_publish' : 'publish_claim',
    failureCode: code,
    platform,
    queueItemId,
    queueItemStatus: row?.status || 'missing',
    scheduledFor: row?.scheduled_for || null,
    publishHistoryId: history?.id || null,
    externalPostId: history?.external_post_id || null,
    errors: [message],
  };

  return {
    outcome,
    message,
    nextAction,
    error: code,
    jobStatus: reconciled ? 'completed_with_errors' : 'failed',
    summary,
  };
}

async function stalePublishJobResult(job: AgentJobRow, logs: WorkerLogRow[]): Promise<JsonMap> {
  const queueItemId = queueItemIdFromPayload(job.payload);
  if (!queueItemId) {
    return {
      outcome: 'blocked',
      message: 'Scheduled publish timed out and did not include a queue item id.',
      nextAction: 'Review the job payload before retrying scheduled publishing.',
      error: 'missing_queue_item_id',
      jobStatus: 'failed',
      summary: {
        outcome: 'blocked',
        message: 'Scheduled publish timed out and did not include a queue item id.',
        nextAction: 'Review the job payload before retrying scheduled publishing.',
        failedStage: 'scheduled_publish',
        failureCode: 'missing_queue_item_id',
        errors: ['missing_queue_item_id'],
      },
    };
  }

  const row = await loadQueueItemForStalePublish(job, queueItemId);
  const history = row ? await findPublishHistoryForQueueItem(job, row) : undefined;
  const result = stalePublishResult(job, row, history, logs);
  const summary = resultSummary(result);
  if (row && summary.failureCode === PUBLISH_UNKNOWN_STATE_CODE) {
    await supabaseUpdate('queue_items', {
      status: 'failed',
      error_message: PUBLISH_UNKNOWN_STATE_MESSAGE,
    }, {
      filters: [
        { column: 'id', operator: 'eq', value: row.id },
        { column: 'user_id', operator: 'eq', value: job.user_id },
        { column: 'status', operator: 'eq', value: 'publishing' },
      ],
    });
  }
  return result;
}

async function cleanupStaleRunningJobs(stats: SchedulerStats, now: Date): Promise<void> {
  const cutoff = addMinutesIso(now, -STALE_RUNNING_JOB_MINUTES);
  const jobs = await supabaseSelect<AgentJobRow>('agent_jobs', {
    select: '*',
    filters: [
      { column: 'status', operator: 'eq', value: 'running' },
      { column: 'started_at', operator: 'lte', value: cutoff },
    ],
    order: 'started_at.asc',
    limit: 50,
  });

  for (const job of jobs) {
    const staleCutoff = addMinutesIso(now, -staleMinutesForJob(job));
    const startedAt = Date.parse(job.started_at || '');
    const staleCutoffMs = Date.parse(staleCutoff);
    if (
      Number.isFinite(startedAt)
      && Number.isFinite(staleCutoffMs)
      && startedAt > staleCutoffMs
    ) {
      incrementSchedulerSkip(stats, 'stale_job_within_kind_runtime');
      continue;
    }

    const logs = await staleJobLogs(job);
    if (job.kind === 'refresh_queue' && hasRecentJobActivity(logs, cutoff)) {
      incrementSchedulerSkip(stats, 'stale_refresh_recent_activity');
      continue;
    }

    const details = staleFailureFromLogs(logs);
    const result = job.kind === 'publish_now'
      ? await stalePublishJobResult(job, logs)
      : staleJobResult(job, logs, details);
    const summary = resultSummary(result);
    const error = String(summary.failureCode || result.error || 'worker_job_timed_out');
    const status = terminalStatusForResult(result);
    await supabaseUpdate('agent_jobs', {
      status,
      completed_at: now.toISOString(),
      error,
      result,
    }, {
      filters: [
        { column: 'id', operator: 'eq', value: job.id },
        { column: 'status', operator: 'eq', value: 'running' },
      ],
    });
    await recordScheduledAutomationResult(job, status, result);
    stats.staleJobsFailed++;
    await writeWorkerLog(job.user_id, 'warn', 'stale_running_job_failed', {
      jobId: job.id,
      kind: job.kind,
      reason: error,
      status,
      failedStage: typeof summary.failedStage === 'string' ? summary.failedStage : null,
      startedAt: job.started_at || null,
    });
  }
}

export async function runSupabaseAutomationScheduler(): Promise<SchedulerStats> {
  const stats: SchedulerStats = {
    tenantsChecked: 0,
    staleJobsFailed: 0,
    fetchJobsEnqueued: 0,
    slotFillJobsEnqueued: 0,
    publishJobsEnqueued: 0,
    skipped: {},
  };
  const now = new Date();
  await cleanupStaleRunningJobs(stats, now);
  await enqueueDueFetchJobs(stats, now);
  await enqueueDueSlotFillJobs(stats, now);
  await enqueueDuePublishJobs(stats, now);
  return stats;
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
      origin: jobOrigin(job),
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
      const terminalStatus = await completeJob(job, result);
      if (terminalStatus === 'failed') stats.failed++;
      else stats.completed++;
      await writeWorkerLog(job.user_id, 'info', 'job_completed', {
        jobId: job.id,
        kind: job.kind,
        status: terminalStatus,
        origin: jobOrigin(job),
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

export const __test__ = {
  hasOpenActiveSlotForPlatform,
  hasRecentJobActivity,
  publishSuccessResult,
  reconstructStaleSummary,
};

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  startSupabaseWorkerLoop();
}

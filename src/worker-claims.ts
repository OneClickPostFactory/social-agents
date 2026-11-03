import { randomUUID } from 'node:crypto';

import { SupabaseRestError, supabaseRpc } from './supabase-client';
import type { PlatformKey } from './types';

export const WORKER_SCHEMA_CONTRACT = 'worker-claims-v1';
export const REQUIRED_WORKER_CLAIM_CAPABILITIES = [
  'source-targeted-claim-v1',
  'source-revisions-v1',
  'angle-targeted-claim-v1',
  'angle-exhaust-fenced-v1',
  'source-angle-atomic-commit-v1',
  'angle-queue-atomic-commit-v1',
  'queue-angle-identity-v1',
  'legacy-queue-revision-hold-v1',
] as const;

export interface WorkerSchemaContract {
  contract: string;
  migration: string;
  capabilities: string[];
}

export interface SourceRecordClaim {
  id: string;
  user_id: string;
  url: string;
  title?: string | null;
  origin?: string | null;
  score?: number | null;
  used: boolean;
  fetched_at: string;
  created_at: string;
  updated_at: string;
  reddit_post_id?: string | null;
  subreddit?: string | null;
  reddit_author?: string | null;
  content_hash?: string | null;
  status?: string | null;
  source_text?: string | null;
  current_revision_id: string;
  claim_token: string;
  claim_version: number;
  claim_expires_at: string;
}

export interface AngleRecordClaim {
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
  status?: string | null;
  priority?: number | null;
  claim_token: string;
  claim_version: number;
  claim_expires_at: string;
}

export interface SourceAngleCommitInput {
  angle: string;
  angle_title: string;
  angle_summary: string;
  intended_platform: PlatformKey;
  priority?: number | null;
  topic?: string | null;
}

export interface SourceAngleCommitResult {
  inserted_count: number;
  total_count: number;
}

export interface QueueItemCommitResult {
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
}

export interface CommitClaimedAngleDraftInput {
  userId: string;
  angleRecordId: string;
  claimToken: string;
  claimVersion: number;
  platform: PlatformKey;
  slotIndex: number;
  scheduledFor: string;
  scheduledLocalDate: string;
  scheduledTimezone: string;
  draftText: string;
  instagramImageUrl?: string | null;
  instagramImagePrompt?: string | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  angle?: string | null;
}

export class WorkerClaimsContractError extends Error {
  readonly code = 'worker_claims_schema_unavailable';

  constructor(message: string, public readonly causeDetails?: string) {
    super(message);
  }
}

export function createClaimToken(): string {
  return randomUUID();
}

export async function getWorkerSchemaContract(): Promise<WorkerSchemaContract> {
  return supabaseRpc<WorkerSchemaContract>('get_worker_schema_contract', {}, { retrySafe: true });
}

export async function assertWorkerClaimsContract(): Promise<WorkerSchemaContract> {
  try {
    const contract = await getWorkerSchemaContract();
    if (contract?.contract !== WORKER_SCHEMA_CONTRACT) {
      throw new WorkerClaimsContractError(
        `Expected ${WORKER_SCHEMA_CONTRACT}, received ${String(contract?.contract || 'missing')}`
      );
    }
    const capabilities = new Set(contract.capabilities || []);
    const missing = REQUIRED_WORKER_CLAIM_CAPABILITIES.filter(capability => !capabilities.has(capability));
    if (missing.length) {
      throw new WorkerClaimsContractError(
        `${WORKER_SCHEMA_CONTRACT} is missing required capabilities: ${missing.join(', ')}`
      );
    }
    return contract;
  } catch (error) {
    if (error instanceof WorkerClaimsContractError) throw error;
    const detail = error instanceof SupabaseRestError
      ? `HTTP ${error.status}`
      : error instanceof Error
        ? error.name
        : 'unknown';
    throw new WorkerClaimsContractError(
      `${WORKER_SCHEMA_CONTRACT} is not available on the configured Supabase project`,
      detail
    );
  }
}

function assertSourceRevisionClaim(
  record: SourceRecordClaim | undefined, userId: string, claimToken: string, sourceRecordId?: string
): void {
  if (!record) return;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (record.user_id !== userId || record.claim_token !== claimToken
      || (sourceRecordId !== undefined && record.id !== sourceRecordId)
      || typeof record.current_revision_id !== 'string' || !uuid.test(record.current_revision_id)) {
    throw new WorkerClaimsContractError('Claimed source is missing its exact immutable revision or scope');
  }
}

export async function claimSourceRecordForExtraction(
  userId: string,
  claimToken = createClaimToken(),
  leaseSeconds = 90
): Promise<{ claimToken: string; record?: SourceRecordClaim }> {
  const rows = await supabaseRpc<SourceRecordClaim[]>('claim_source_record_for_extraction', {
    p_user_id: userId,
    p_claim_token: claimToken,
    p_lease_seconds: leaseSeconds,
  }, { retrySafe: true });
  assertSourceRevisionClaim(rows[0], userId, claimToken);
  return { claimToken, record: rows[0] };
}

export async function claimSourceRecordById(
  userId: string,
  sourceRecordId: string,
  claimToken = createClaimToken(),
  leaseSeconds = 90
): Promise<{ claimToken: string; record?: SourceRecordClaim }> {
  const rows = await supabaseRpc<SourceRecordClaim[]>('claim_source_record_by_id', {
    p_user_id: userId,
    p_source_record_id: sourceRecordId,
    p_claim_token: claimToken,
    p_lease_seconds: leaseSeconds,
  }, { retrySafe: true });
  assertSourceRevisionClaim(rows[0], userId, claimToken, sourceRecordId);
  return { claimToken, record: rows[0] };
}

export async function renewSourceRecordClaim(
  userId: string,
  record: Pick<SourceRecordClaim, 'id' | 'claim_token' | 'claim_version'>,
  leaseSeconds = 90
): Promise<boolean> {
  return supabaseRpc<boolean>('renew_source_record_claim', {
    p_user_id: userId,
    p_source_record_id: record.id,
    p_claim_token: record.claim_token,
    p_claim_version: record.claim_version,
    p_lease_seconds: leaseSeconds,
  }, { retrySafe: true });
}

export async function releaseSourceRecordClaim(
  userId: string,
  record: Pick<SourceRecordClaim, 'id' | 'claim_token' | 'claim_version'>
): Promise<boolean> {
  return supabaseRpc<boolean>('release_source_record_claim', {
    p_user_id: userId,
    p_source_record_id: record.id,
    p_claim_token: record.claim_token,
    p_claim_version: record.claim_version,
  });
}

export async function commitSourceAngleExtraction(
  userId: string,
  record: Pick<SourceRecordClaim, 'id' | 'claim_token' | 'claim_version' | 'current_revision_id'>,
  angles: SourceAngleCommitInput[]
): Promise<SourceAngleCommitResult> {
  if (typeof record.current_revision_id !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.current_revision_id)) {
    throw new WorkerClaimsContractError('Source extraction commit requires the claimed immutable revision');
  }
  const rows = await supabaseRpc<SourceAngleCommitResult[]>('commit_source_angle_extraction', {
    p_user_id: userId,
    p_source_record_id: record.id,
    p_claim_token: record.claim_token,
    p_claim_version: record.claim_version,
    p_angles: angles,
  }, { retrySafe: true });
  return rows[0] || { inserted_count: 0, total_count: 0 };
}

export async function claimAngleRecordForDraft(
  userId: string,
  platforms: PlatformKey[],
  claimToken = createClaimToken(),
  leaseSeconds = 300
): Promise<{ claimToken: string; record?: AngleRecordClaim }> {
  const rows = await supabaseRpc<AngleRecordClaim[]>('claim_angle_record_for_draft', {
    p_user_id: userId,
    p_platforms: platforms,
    p_claim_token: claimToken,
    p_lease_seconds: leaseSeconds,
  }, { retrySafe: true });
  return { claimToken, record: rows[0] };
}

export async function claimAngleRecordById(
  userId: string,
  angleRecordId: string,
  platforms: PlatformKey[],
  claimToken = createClaimToken(),
  leaseSeconds = 300
): Promise<{ claimToken: string; record?: AngleRecordClaim }> {
  const rows = await supabaseRpc<AngleRecordClaim[]>('claim_angle_record_by_id', {
    p_user_id: userId,
    p_angle_record_id: angleRecordId,
    p_platforms: platforms,
    p_claim_token: claimToken,
    p_lease_seconds: leaseSeconds,
  }, { retrySafe: true });
  return { claimToken, record: rows[0] };
}

export async function renewAngleRecordClaim(
  userId: string,
  record: Pick<AngleRecordClaim, 'id' | 'claim_token' | 'claim_version'>,
  leaseSeconds = 300
): Promise<boolean> {
  return supabaseRpc<boolean>('renew_angle_record_claim', {
    p_user_id: userId,
    p_angle_record_id: record.id,
    p_claim_token: record.claim_token,
    p_claim_version: record.claim_version,
    p_lease_seconds: leaseSeconds,
  }, { retrySafe: true });
}

export async function releaseAngleRecordClaim(
  userId: string,
  record: Pick<AngleRecordClaim, 'id' | 'claim_token' | 'claim_version'>
): Promise<boolean> {
  return supabaseRpc<boolean>('release_angle_record_claim', {
    p_user_id: userId,
    p_angle_record_id: record.id,
    p_claim_token: record.claim_token,
    p_claim_version: record.claim_version,
  });
}

export async function exhaustAngleRecordClaim(
  userId: string,
  record: Pick<AngleRecordClaim, 'id' | 'claim_token' | 'claim_version'>
): Promise<boolean> {
  return supabaseRpc<boolean>('exhaust_angle_record_claim', {
    p_user_id: userId,
    p_angle_record_id: record.id,
    p_claim_token: record.claim_token,
    p_claim_version: record.claim_version,
  }, { retrySafe: true });
}

export async function commitClaimedAngleDraft(
  input: CommitClaimedAngleDraftInput
): Promise<QueueItemCommitResult> {
  const rows = await supabaseRpc<QueueItemCommitResult[]>('commit_claimed_angle_draft', {
    p_user_id: input.userId,
    p_angle_record_id: input.angleRecordId,
    p_claim_token: input.claimToken,
    p_claim_version: input.claimVersion,
    p_platform: input.platform,
    p_slot_index: input.slotIndex,
    p_scheduled_for: input.scheduledFor,
    p_scheduled_local_date: input.scheduledLocalDate,
    p_scheduled_timezone: input.scheduledTimezone,
    p_draft_text: input.draftText,
    p_instagram_image_url: input.instagramImageUrl ?? null,
    p_instagram_image_prompt: input.instagramImagePrompt ?? null,
    p_source_url: input.sourceUrl ?? null,
    p_source_title: input.sourceTitle ?? null,
    p_angle: input.angle ?? null,
  }, { retrySafe: true });

  const row = rows[0];
  if (!row) {
    throw new Error('commit_claimed_angle_draft returned no queue row');
  }
  return row;
}

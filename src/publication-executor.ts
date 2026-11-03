import * as ledger from './publication-ledger';
import { classifyPostDispatchError } from './publication-outcome';
import { recordObservedAcceptance } from './publication-receipts';
import { supabaseSelect } from './supabase-client';
import type { PlatformKey } from './types';

export interface PublicationTarget {
  userId: string;
  queueItemId: string;
  platform: PlatformKey;
}

export interface ProviderAcceptance {
  externalPostId: string;
}

export interface PreparedPublication {
  providerAccountRef: string;
  // Exactly one provider write. Refresh/identity checks belong in prepare(), not send().
  send(attempt: Readonly<ledger.PublicationAttempt>): Promise<ProviderAcceptance>;
}

export interface PublicationHooks {
  controlledThreadsRelay?: boolean;
  prepare(payload: Readonly<ledger.PublicationPayload>): Promise<PreparedPublication>;
  afterAccepted?(attempt: ledger.PublicationAttempt, payload: Readonly<ledger.PublicationPayload>): Promise<void>;
}

export type PublicationExecutionResult = Record<string, unknown> & {
  outcome: 'accepted' | 'verified' | 'unknown' | 'rejected' | 'blocked' | 'retry_wait';
  jobStatus: 'completed' | 'completed_with_errors' | 'failed';
  failureCode: string | null;
  summary: Record<string, unknown>;
};

export class PublicationPreflightError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PublicationPreflightError';
  }
}

const UNKNOWN_ACTION = 'Do not retry or recreate this post. Reconcile the exact publication attempt before another dispatch.';
const SAFE_RETRY_ACTION = 'This execution did not dispatch. Reconcile any existing attempt or resolve the blocker before retrying this same queue item.';

type Ledger = Pick<typeof ledger,
  | 'assertPublicationLedgerContract'
  | 'claimPublicationIntent'
  | 'releasePublicationClaim'
  | 'beginPublicationDispatch'
  | 'recordPublicationAccepted'
  | 'recordPublicationRejected'
  | 'recordPublicationUnknown'
  | 'loadPublicationStateForQueueItem'
>;

const productionLedger: Ledger = {
  ...ledger,
  recordPublicationAccepted: recordObservedAcceptance,
};

function result(
  target: PublicationTarget,
  outcome: PublicationExecutionResult['outcome'],
  code: string | null,
  state: ledger.PublicationStateSnapshot = {},
  extra: Record<string, unknown> = {}
): PublicationExecutionResult {
  const accepted = outcome === 'accepted' || outcome === 'verified';
  const message = outcome === 'verified'
    ? 'Provider acceptance and later visibility verification are recorded.'
    : outcome === 'accepted'
      ? 'Provider acceptance is recorded. Visibility has not been verified.'
      : outcome === 'unknown'
        ? 'Publication outcome requires reconciliation. No automatic resend is allowed.'
        : outcome === 'rejected'
          ? 'The provider rejected this attempt. No acceptance receipt was created.'
          : 'Publication is blocked before a new dispatch.';
  const nextAction = accepted ? 'No resend is needed.'
    : outcome === 'unknown' ? UNKNOWN_ACTION
      : outcome === 'rejected' ? 'Resolve the provider rejection, then use the authorised recovery flow.'
        : SAFE_RETRY_ACTION;
  const details = {
    outcome,
    message,
    nextAction,
    failureCode: code,
    platform: target.platform,
    queueItemId: target.queueItemId,
    publicationIntentId: state.intent?.id || null,
    publicationAttemptId: state.attempt?.id || null,
    dispatchOperationId: state.attempt?.dispatch_operation_id || null,
    externalPostId: state.attempt?.external_post_id || null,
    publishHistoryId: state.history?.id || null,
    visibilityVerified: outcome === 'verified',
    automaticRetryAllowed: false,
    ...extra,
  };
  return {
    ...details,
    outcome,
    failureCode: code,
    jobStatus: accepted ? 'completed' : 'failed',
    summary: { ...details, failedStage: code ? 'publication' : null, errors: code ? [code] : [] },
  };
}

function validIntent(target: PublicationTarget, intent: ledger.PublicationIntent): boolean {
  return intent.user_id === target.userId
    && intent.queue_item_id === target.queueItemId
    && intent.platform === target.platform
    && intent.payload?.platform === target.platform;
}

function validAttempt(target: PublicationTarget, state: ledger.PublicationStateSnapshot): boolean {
  const { intent, attempt, history } = state;
  if (!intent || !validIntent(target, intent)) return false;
  if (attempt && (attempt.user_id !== target.userId
    || attempt.queue_item_id !== target.queueItemId
    || attempt.intent_id !== intent.id
    || attempt.platform !== target.platform)) return false;
  if (history && (!attempt || history.user_id !== target.userId
    || history.queue_item_id !== target.queueItemId
    || history.publication_intent_id !== intent.id
    || history.publication_attempt_id !== attempt.id
    || history.platform !== target.platform
    || history.external_post_id !== attempt.external_post_id)) return false;
  return true;
}

function terminalResult(target: PublicationTarget, state: ledger.PublicationStateSnapshot): PublicationExecutionResult | undefined {
  if (!state.intent) return undefined;
  if (!validAttempt(target, state)) return result(target, 'unknown', 'publication_identity_mismatch');
  // The latest attempt is authoritative if separate read queries straddled an outcome commit.
  const status = state.attempt?.state || state.intent.state;
  if (status === 'accepted' || status === 'verified') {
    if (!state.attempt?.external_post_id) return result(target, 'unknown', 'publication_receipt_incomplete', state);
    return result(target, status, null, state);
  }
  if (status === 'unknown' || status === 'dispatching') {
    return result(target, 'unknown', 'publication_outcome_unknown', state);
  }
  if (status === 'rejected') return result(target, 'rejected', 'publication_rejected', state);
  return undefined;
}

async function readBestEffort(target: PublicationTarget, db: Ledger): Promise<ledger.PublicationStateSnapshot> {
  try {
    return await db.loadPublicationStateForQueueItem(target.userId, target.queueItemId);
  } catch {
    return {};
  }
}

async function recordUnknownBestEffort(
  target: PublicationTarget,
  intent: ledger.PublicationIntent,
  attempt: ledger.PublicationAttempt,
  code: string,
  db: Ledger,
  observedExternalPostId?: string
): Promise<PublicationExecutionResult> {
  try {
    const recorded = await db.recordPublicationUnknown({
      userId: target.userId,
      attempt,
      errorCode: code,
      errorMessage: UNKNOWN_ACTION,
      providerReceipt: observedExternalPostId ? { observed_external_post_id: observedExternalPostId } : null,
    });
    return result(target, 'unknown', code, { intent, attempt: recorded }, {
      bookkeepingPending: Boolean(observedExternalPostId),
      ...(observedExternalPostId ? { externalPostId: observedExternalPostId, providerAccepted: true } : {}),
    });
  } catch {
    // Acceptance may have committed despite a lost response, or won a recovery race.
    const current = await readBestEffort(target, db);
    const terminal = terminalResult(target, current);
    if (terminal && (terminal.outcome === 'accepted' || terminal.outcome === 'verified')) return terminal;
    return result(target, 'unknown', code, { intent, attempt }, {
      bookkeepingPending: true,
      ...(observedExternalPostId ? { externalPostId: observedExternalPostId, providerAccepted: true } : {}),
    });
  }
}

/** No external write is possible without a confirmed durable dispatch attempt. */
export async function executePublication(
  target: PublicationTarget,
  hooks: PublicationHooks,
  db: Ledger = productionLedger
): Promise<PublicationExecutionResult> {
  let state: ledger.PublicationStateSnapshot;
  try {
    await db.assertPublicationLedgerContract();
    state = await db.loadPublicationStateForQueueItem(target.userId, target.queueItemId);
  } catch {
    return result(target, 'blocked', 'publication_ledger_schema_unavailable');
  }
  const existing = terminalResult(target, state);
  if (existing) return existing;
  // This executor is hosted-only. Do not claim/freeze unavailable provider media,
  // refresh credentials, or spend on generation merely to rediscover retirement.
  if ((target.platform === 'threads' && !hooks.controlledThreadsRelay) || target.platform === 'instagram') {
    return result(target, 'blocked', 'legacy_meta_publication_disabled', state);
  }
  if (target.platform === 'facebook') return result(target, 'blocked', 'facebook_paused', state);

  const claimToken = ledger.createPublicationClaimToken();
  let intent: ledger.PublicationIntent;
  try {
    intent = await db.claimPublicationIntent(target.userId, target.queueItemId, claimToken, 120);
  } catch {
    const current = await readBestEffort(target, db);
    return terminalResult(target, current) || result(target, 'blocked', 'publication_claim_not_acquired', current);
  }
  // Do not release a row with a mismatched identity, even when the Data API returned it.
  if (!validIntent(target, intent) || intent.claim_token !== claimToken
    || intent.state !== 'claimed' || !Number.isSafeInteger(intent.claim_version)) {
    return result(target, 'unknown', 'publication_identity_mismatch');
  }
  const payload = Object.freeze({ ...intent.payload });
  let prepared: PreparedPublication;
  try {
    if (typeof payload.text !== 'string' || !payload.text.trim()) throw new PublicationPreflightError('draft_text_missing');
    if (!Number.isFinite(Date.parse(intent.claim_expires_at || ''))
      || Date.parse(intent.claim_expires_at || '') <= Date.now()) throw new PublicationPreflightError('publication_claim_expired');
    prepared = await hooks.prepare(payload);
    if (!prepared.providerAccountRef?.trim()) throw new PublicationPreflightError('provider_account_identity_required');
  } catch (error) {
    const code = error instanceof PublicationPreflightError ? error.code : 'publication_preflight_failed';
    try {
      await db.releasePublicationClaim(target.userId, intent, code);
    } catch {
      // The lease may have expired or another owner may have taken it. Never force status.
    }
    return result(target, 'blocked', code, { intent });
  }

  const operationId = ledger.createDispatchOperationId();
  let attempt: ledger.PublicationAttempt;
  try {
    attempt = await db.beginPublicationDispatch({
      userId: target.userId,
      intent,
      dispatchOperationId: operationId,
      providerAccountRef: prepared.providerAccountRef,
      providerIdempotencySupported: false,
    });
  } catch {
    // The begin RPC may have committed. Never release the claim or send blindly.
    const current = await readBestEffort(target, db);
    if (validAttempt(target, current) && current.attempt?.dispatch_operation_id === operationId) {
      return recordUnknownBestEffort(target, intent, current.attempt, 'publication_dispatch_receipt_lost', db);
    }
    return result(target, 'unknown', 'publication_dispatch_receipt_lost', { intent });
  }
  if (!validAttempt(target, { intent, attempt }) || attempt.dispatch_operation_id !== operationId) {
    return result(target, 'unknown', 'publication_identity_mismatch');
  }
  if (attempt.state !== 'dispatching') {
    return terminalResult(target, { intent, attempt }) || result(target, 'unknown', 'publication_dispatch_not_authorised', { intent, attempt });
  }

  let acceptance: ProviderAcceptance;
  try {
    acceptance = await prepared.send(Object.freeze({ ...attempt }));
    if (typeof acceptance.externalPostId !== 'string' || !acceptance.externalPostId.trim()
      || acceptance.externalPostId === 'posted') throw new Error('provider receipt missing');
  } catch (error) {
    const classification = classifyPostDispatchError(error);
    if (classification.outcome === 'rejected') {
      try {
        const rejected = await db.recordPublicationRejected({
          userId: target.userId,
          attempt,
          errorCode: classification.code,
          errorMessage: classification.message,
          providerReceipt: classification.providerReceipt,
        });
        return result(target, 'rejected', classification.code, { intent, attempt: rejected });
      } catch {
        // A known external rejection with failed local persistence is still non-retryable.
      }
    }
    return recordUnknownBestEffort(target, intent, attempt, classification.code, db);
  }

  // This is deliberately outside the provider catch. Database errors are not provider rejections.
  let accepted: ledger.PublicationAttempt;
  try {
    accepted = await db.recordPublicationAccepted({
      userId: target.userId,
      attempt,
      externalPostId: acceptance.externalPostId,
      providerReceipt: { external_post_id: acceptance.externalPostId },
    });
    if (!validAttempt(target, { intent, attempt: accepted })
      || !['accepted', 'verified'].includes(accepted.state)
      || accepted.external_post_id !== acceptance.externalPostId) throw new Error('acceptance receipt mismatch');
  } catch {
    return recordUnknownBestEffort(target, intent, attempt, 'publication_acceptance_record_pending', db, acceptance.externalPostId);
  }
  let bookkeepingPending = false;
  try {
    await hooks.afterAccepted?.(accepted, payload);
  } catch {
    bookkeepingPending = true;
  }
  // Enrich the response with exact history identity without making this read a
  // condition of provider acceptance or reopening the send path on read failure.
  const finalState = await readBestEffort(target, db);
  const receiptState = validAttempt(target, finalState)
    && finalState.attempt?.id === accepted.id
    && finalState.attempt.external_post_id === accepted.external_post_id
      ? finalState : { intent, attempt: accepted };
  const finished = result(target, accepted.state === 'verified' ? 'verified' : 'accepted', null, receiptState, { bookkeepingPending });
  if (bookkeepingPending) finished.jobStatus = 'completed_with_errors';
  return finished;
}

/** Recovery never dispatches. Database identity, not logs or source URLs, determines the outcome. */
export async function reconcilePublication(
  target: PublicationTarget,
  now = Date.now(),
  db: Ledger = productionLedger
): Promise<PublicationExecutionResult> {
  let state: ledger.PublicationStateSnapshot;
  try {
    await db.assertPublicationLedgerContract();
    state = await db.loadPublicationStateForQueueItem(target.userId, target.queueItemId);
  } catch {
    return result(target, 'unknown', 'publication_reconciliation_unavailable');
  }
  if (!state.intent) return result(target, 'unknown', 'legacy_publication_requires_reconciliation');
  if (!validAttempt(target, state)) return result(target, 'unknown', 'publication_identity_mismatch');
  const { intent, attempt } = state;
  if (attempt?.state === 'dispatching' && Date.parse(attempt.dispatch_started_at) <= now - 180_000) {
    return recordUnknownBestEffort(target, intent, attempt, 'publication_dispatch_interrupted', db);
  }
  const terminal = terminalResult(target, state);
  if (terminal) return terminal;
  if (intent.state === 'claimed') {
    if (!(Date.parse(intent.claim_expires_at || '') <= now)) return result(target, 'blocked', 'publication_claim_active', state);
    try {
      await db.releasePublicationClaim(target.userId, intent, 'publication_predispatch_lease_expired');
    } catch {
      const current = await readBestEffort(target, db);
      return terminalResult(target, current) || result(target, 'blocked', 'publication_recovery_raced');
    }
  }
  return result(target, 'retry_wait', 'publication_not_dispatched', state);
}

/** Also recovers orphaned publish_all attempts after their parent job has already ended. */
export async function recoverStalePublications(
  now = Date.now(),
  allowedUserIds?: readonly string[]
): Promise<number> {
  if (allowedUserIds?.length === 0) return 0;
  try {
    await ledger.assertPublicationLedgerContract();
    const intents = await supabaseSelect<ledger.PublicationIntent>('publication_intents', {
      filters: [
        { column: 'state', operator: 'in', value: ['claimed', 'dispatching'] },
        { column: 'updated_at', operator: 'lte', value: new Date(now - 180_000).toISOString() },
        ...(allowedUserIds
          ? [{ column: 'user_id', operator: 'in' as const, value: [...allowedUserIds] }]
          : []),
      ],
      order: 'updated_at.asc',
      limit: 50,
    });
    let checked = 0;
    for (const intent of intents) {
      try {
        await reconcilePublication({ userId: intent.user_id, queueItemId: intent.queue_item_id, platform: intent.platform }, now);
        checked++;
      } catch {
        // One malformed/blocked tenant cannot stop other recovery or ready-post draining.
      }
    }
    return checked;
  } catch {
    return 0;
  }
}

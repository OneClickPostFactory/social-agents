import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executePublication, reconcilePublication, PublicationPreflightError } from '../src/publication-executor';
import { PlatformPublishError } from '../src/platform-errors';
import type { PublicationIntent, PublicationAttempt, PublicationStateSnapshot } from '../src/publication-ledger';

type DB = NonNullable<Parameters<typeof executePublication>[2]>;
type Hooks = Parameters<typeof executePublication>[1];
const copy = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();

function fixture(id = 'one') {
  const target = { userId: `user-${id}`, queueItemId: `queue-${id}`, platform: 'x' as const };
  let state: PublicationStateSnapshot = {};
  let calls = 0;
  let releases = 0;
  let begins = 0;
  const db: DB = {
    assertPublicationLedgerContract: async () => ({ contract: 'publication-ledger-v1', migration: '20260907054000', capabilities: [] }),
    loadPublicationStateForQueueItem: async () => copy(state),
    claimPublicationIntent: async (_user, _queue, token) => {
      const old = state.intent;
      if (old && old.state !== 'scheduled' && !(old.state === 'claimed' && Date.parse(old.claim_expires_at || '') <= Date.now())) throw new Error('owned');
      const intent: PublicationIntent = {
        id: `intent-${id}`, user_id: target.userId, queue_item_id: target.queueItemId,
        platform: 'x', queue_status_before_claim: 'ready', queue_revision_updated_at: now(),
        payload: { platform: 'x', text: `authorised-${id}`, source_url: 'https://example.com/reusable-source' },
        state: 'claimed', claim_token: token, claim_version: (old?.claim_version || 0) + 1,
        claim_expires_at: new Date(Date.now() + 120_000).toISOString(), created_at: now(), updated_at: now(),
      };
      state.intent = intent;
      return copy(intent);
    },
    releasePublicationClaim: async (_user, claim) => {
      assert.equal(state.intent?.state, 'claimed');
      assert.equal(state.intent.claim_token, claim.claim_token);
      assert.equal(state.intent.claim_version, claim.claim_version);
      releases++;
      state.intent.state = 'scheduled'; state.intent.claim_token = null; state.intent.claim_expires_at = null;
      return copy(state.intent);
    },
    beginPublicationDispatch: async input => {
      assert.equal(state.intent?.state, 'claimed');
      assert.equal(state.intent.claim_token, input.intent.claim_token);
      assert.equal(state.intent.claim_version, input.intent.claim_version);
      assert.ok(Date.parse(state.intent.claim_expires_at || '') > Date.now());
      begins++;
      const attempt: PublicationAttempt = {
        id: `attempt-${id}`, intent_id: state.intent.id, user_id: target.userId, queue_item_id: target.queueItemId,
        platform: 'x', attempt_no: 1, dispatch_operation_id: input.dispatchOperationId!, state: 'dispatching',
        provider_account_ref: input.providerAccountRef, provider_idempotency_supported: false,
        dispatch_started_at: now(), created_at: now(), updated_at: now(),
      };
      state.intent.state = 'dispatching'; state.intent.claim_token = null; state.intent.claim_expires_at = null;
      state.attempt = attempt;
      return copy(attempt);
    },
    recordPublicationAccepted: async input => {
      assert.ok(state.attempt && state.intent);
      assert.equal(input.attempt.id, state.attempt.id);
      assert.equal(input.attempt.dispatch_operation_id, state.attempt.dispatch_operation_id);
      if (state.attempt.state === 'unknown') throw new Error('reconciliation required');
      state.attempt.state = 'accepted'; state.intent.state = 'accepted';
      state.attempt.external_post_id = input.externalPostId;
      state.attempt.outcome_recorded_at = now();
      state.history = {
        id: `history-${id}`, user_id: target.userId, platform: 'x', published_at: now(),
        queue_item_id: target.queueItemId, publication_intent_id: state.intent.id,
        publication_attempt_id: state.attempt.id, external_post_id: input.externalPostId,
      };
      return copy(state.attempt);
    },
    recordPublicationRejected: async () => {
      assert.ok(state.attempt && state.intent);
      assert.equal(state.attempt.state, 'dispatching');
      state.intent.state = 'rejected'; state.attempt.state = 'rejected';
      return copy(state.attempt);
    },
    recordPublicationUnknown: async input => {
      assert.ok(state.attempt && state.intent);
      if (state.attempt.state === 'accepted' || state.attempt.state === 'verified') throw new Error('terminal');
      state.intent.state = 'unknown'; state.attempt.state = 'unknown';
      state.attempt.provider_receipt = input.providerReceipt;
      return copy(state.attempt);
    },
  };
  const hooks: Hooks = {
    prepare: async payload => {
      assert.ok(Object.isFrozen(payload));
      assert.equal(payload.text, `authorised-${id}`);
      return { providerAccountRef: `account-${id}`, send: async attempt => {
        assert.ok(Object.isFrozen(attempt));
        assert.deepEqual(attempt, state.attempt);
        assert.equal(state.attempt?.state, 'dispatching');
        calls++;
        return { externalPostId: `post-${id}` };
      } };
    },
  };
  return { target, db, hooks, state: () => state, calls: () => calls, releases: () => releases, begins: () => begins };
}

async function check(name: string, run: () => Promise<void> | void) {
  await run(); console.log(`ok - ${name}`);
}

async function main() {
  await check('acceptance is durable before bookkeeping and repeat delivery cannot resend', async () => {
    const f = fixture();
    const result = await executePublication(f.target, f.hooks, f.db);
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.visibilityVerified, false);
    assert.equal(f.state().history?.publication_attempt_id, 'attempt-one');
    assert.equal((await executePublication(f.target, f.hooks, f.db)).outcome, 'accepted');
    assert.equal(f.calls(), 1);
  });
  await check('interleaved duplicate jobs have one provider writer', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => executePublication(f.target, f.hooks, f.db)));
    assert.equal(results.filter(item => item.outcome === 'accepted').length >= 1, true);
    assert.equal(f.calls(), 1); assert.equal(f.begins(), 1);
  });
  await check('independent tenants preserve distinct payload and account identity', async () => {
    const a = fixture('a'), b = fixture('b');
    await Promise.all([executePublication(a.target, a.hooks, a.db), executePublication(b.target, b.hooks, b.db)]);
    assert.equal(a.state().attempt?.provider_account_ref, 'account-a');
    assert.equal(b.state().attempt?.provider_account_ref, 'account-b');
    assert.equal(a.state().attempt?.external_post_id, 'post-a');
    assert.equal(b.state().attempt?.external_post_id, 'post-b');
  });
  await check('post-acceptance ancillary failure preserves accepted truth', async () => {
    const f = fixture(); f.hooks.afterAccepted = async () => { throw new Error('bookkeeping'); };
    const r = await executePublication(f.target, f.hooks, f.db);
    assert.equal(r.outcome, 'accepted'); assert.equal(r.jobStatus, 'completed_with_errors');
    assert.equal(r.bookkeepingPending, true);
    await executePublication(f.target, f.hooks, f.db); assert.equal(f.calls(), 1);
  });
  await check('lost acceptance response is reconciled from exact receipt without resend', async () => {
    const f = fixture(); const record = f.db.recordPublicationAccepted;
    f.db.recordPublicationAccepted = async input => { await record(input); throw new Error('response lost'); };
    assert.equal((await executePublication(f.target, f.hooks, f.db)).outcome, 'accepted');
    assert.equal(f.calls(), 1);
  });
  await check('failed acceptance transaction retains observed provider ID and blocks retry', async () => {
    const f = fixture(); f.db.recordPublicationAccepted = async () => { throw new Error('database unavailable'); };
    const r = await executePublication(f.target, f.hooks, f.db);
    assert.equal(r.outcome, 'unknown'); assert.equal(r.providerAccepted, true);
    assert.equal(r.externalPostId, 'post-one');
    assert.equal(f.state().attempt?.provider_receipt?.observed_external_post_id, 'post-one');
    assert.equal((await executePublication(f.target, f.hooks, f.db)).outcome, 'unknown');
    assert.equal(f.calls(), 1);
  });
  await check('provider timeout stays unknown and cannot become retryable failure', async () => {
    const f = fixture(); const prepare = f.hooks.prepare;
    f.hooks.prepare = async payload => {
      const ready = await prepare(payload);
      return { ...ready, send: async attempt => { await ready.send(attempt); throw new Error('lost provider response'); } };
    };
    assert.equal((await executePublication(f.target, f.hooks, f.db)).outcome, 'unknown');
    assert.equal((await reconcilePublication(f.target, Date.now() + 300_000, f.db)).outcome, 'unknown');
    await executePublication(f.target, f.hooks, f.db); assert.equal(f.calls(), 1);
  });
  await check('missing provider identifier is not a successful receipt', async () => {
    const f = fixture(); f.hooks.prepare = async () => ({ providerAccountRef: 'a', send: async () => ({ externalPostId: 'posted' }) });
    assert.equal((await executePublication(f.target, f.hooks, f.db)).outcome, 'unknown');
    assert.equal(f.state().history, undefined);
  });
  await check('known provider rejection creates no acceptance receipt', async () => {
    const f = fixture(); f.hooks.prepare = async () => ({ providerAccountRef: 'a', send: async () => {
      throw new PlatformPublishError({ platform: 'x', stage: 'post', status: 422, code: 'payload_rejected', userMessage: 'rejected', nextAction: 'fix' });
    } });
    assert.equal((await executePublication(f.target, f.hooks, f.db)).outcome, 'rejected');
    assert.equal(f.state().history, undefined);
    assert.equal((await executePublication(f.target, f.hooks, f.db)).outcome, 'rejected');
  });
  await check('lost begin-dispatch response makes zero provider calls and never releases the attempt', async () => {
    const f = fixture(); const begin = f.db.beginPublicationDispatch;
    f.db.beginPublicationDispatch = async input => { await begin(input); throw new Error('lost response'); };
    assert.equal((await executePublication(f.target, f.hooks, f.db)).outcome, 'unknown');
    assert.equal(f.calls(), 0); assert.equal(f.releases(), 0);
    assert.equal(f.state().attempt?.state, 'unknown');
  });
  await check('preflight rejection releases only its own fenced pre-dispatch claim', async () => {
    const f = fixture(); f.hooks.prepare = async () => { throw new PublicationPreflightError('platform_disabled'); };
    const r = await executePublication(f.target, f.hooks, f.db);
    assert.equal(r.failureCode, 'platform_disabled'); assert.equal(f.releases(), 1);
    assert.equal(f.begins(), 0); assert.equal(f.calls(), 0);
  });
  await check('a lease lost during preflight cannot dispatch', async () => {
    const f = fixture(); const prepare = f.hooks.prepare;
    f.hooks.prepare = async payload => { const p = await prepare(payload); f.state().intent!.claim_version++; return p; };
    await executePublication(f.target, f.hooks, f.db); assert.equal(f.calls(), 0);
  });
  await check('late provider completion after recovery never becomes an automatic retry', async () => {
    const f = fixture(); const prepare = f.hooks.prepare;
    f.hooks.prepare = async payload => {
      const ready = await prepare(payload);
      return { ...ready, send: async attempt => {
        const accepted = await ready.send(attempt);
        await reconcilePublication(f.target, Date.now() + 300_000, f.db);
        return accepted;
      } };
    };
    const r = await executePublication(f.target, f.hooks, f.db);
    assert.equal(r.outcome, 'unknown'); assert.equal(r.providerAccepted, true);
    await executePublication(f.target, f.hooks, f.db); assert.equal(f.calls(), 1);
  });
  await check('recovery releases expired pre-dispatch claims but never sends', async () => {
    const f = fixture(); await f.db.claimPublicationIntent(f.target.userId, f.target.queueItemId, 'token');
    assert.equal((await reconcilePublication(f.target, Date.now() + 300_000, f.db)).outcome, 'retry_wait');
    assert.equal(f.releases(), 1); assert.equal(f.calls(), 0);
  });
  await check('schema or identity failure cannot reach provider code', async () => {
    const f = fixture(); f.db.assertPublicationLedgerContract = async () => { throw new Error('missing'); };
    assert.equal((await executePublication(f.target, f.hooks, f.db)).failureCode, 'publication_ledger_schema_unavailable');
    assert.equal(f.calls(), 0);
    const g = fixture(); const claim = g.db.claimPublicationIntent;
    g.db.claimPublicationIntent = async (...args) => ({ ...await claim(...args), user_id: 'other-tenant' });
    assert.equal((await executePublication(g.target, g.hooks, g.db)).failureCode, 'publication_identity_mismatch');
    assert.equal(g.calls(), 0); assert.equal(g.releases(), 0);
  });
  await check('legacy rows are quarantined rather than matched by reusable source URL', async () => {
    const f = fixture(); const r = await reconcilePublication(f.target, Date.now(), f.db);
    assert.equal(r.failureCode, 'legacy_publication_requires_reconciliation'); assert.equal(f.calls(), 0);
  });
  await check('production orchestration calls the executor and exact recovery, not the legacy heuristic', () => {
    const worker = readFileSync('src/supabase-worker.ts', 'utf8');
    const publish = worker.slice(worker.indexOf('async function publishQueueRow('), worker.indexOf('async function handlePublishNow('));
    assert.ok(publish.includes('executePublication('));
    assert.ok(!publish.includes("supabaseInsert<PublishHistoryRow>"));
    assert.ok(!publish.includes("status: 'failed'"));
    assert.ok(!worker.includes('findPublishHistoryForQueueItem'));
    assert.ok(worker.includes('recoverStalePublications(now.getTime(), rolloutAllowedUserIds())'));
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });

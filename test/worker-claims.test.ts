import assert from 'node:assert/strict';

import config from '../config';
import {
  REQUIRED_WORKER_CLAIM_CAPABILITIES,
  WORKER_SCHEMA_CONTRACT,
  WorkerClaimsContractError,
  assertWorkerClaimsContract,
  claimAngleRecordById,
  claimSourceRecordById,
  commitClaimedAngleDraft,
  commitSourceAngleExtraction,
  createClaimToken,
  exhaustAngleRecordClaim,
} from '../src/worker-claims';

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalConfig = {
    url: config.SUPABASE_URL,
    role: config.SUPABASE_SERVICE_ROLE_KEY,
    encryption: config.CREDENTIAL_ENCRYPTION_KEY,
  };

  config.SUPABASE_URL = 'https://example.supabase.co';
  config.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  config.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key';

  try {
    await test('claim tokens are caller-owned UUID identities', async () => {
      const token = createClaimToken();
      assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    await test('schema capability probe requires the complete worker-claims-v1 cutover', async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        contract: WORKER_SCHEMA_CONTRACT,
        migration: '20260906162000',
        capabilities: [...REQUIRED_WORKER_CLAIM_CAPABILITIES],
      }), { status: 200 })) as typeof fetch;

      const contract = await assertWorkerClaimsContract();
      assert.equal(contract.contract, WORKER_SCHEMA_CONTRACT);

      globalThis.fetch = (async () => new Response(JSON.stringify({
        contract: WORKER_SCHEMA_CONTRACT,
        migration: '20260906154500',
        capabilities: ['source-angle-atomic-commit-v1'],
      }), { status: 200 })) as typeof fetch;

      await assert.rejects(
        () => assertWorkerClaimsContract(),
        (error: unknown) => error instanceof WorkerClaimsContractError
          && error.code === 'worker_claims_schema_unavailable'
          && error.message.includes('source-targeted-claim-v1')
      );
    });

    await test('targeted source claim and commit preserve the exact fencing identity', async () => {
      const bodies: Array<Record<string, unknown>> = [];
      const token = '22222222-2222-4222-8222-222222222222';
      const claimVersion = 7;
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        bodies.push(body);
        if (url.endsWith('/rpc/claim_source_record_by_id')) {
          return new Response(JSON.stringify([{
            id: 'source-1',
            current_revision_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            user_id: 'user-1',
            url: 'https://example.com/source',
            used: false,
            fetched_at: '2026-09-06T00:00:00Z',
            created_at: '2026-09-06T00:00:00Z',
            updated_at: '2026-09-06T00:00:00Z',
            status: 'banked',
            claim_token: token,
            claim_version: claimVersion,
            claim_expires_at: '2026-09-06T00:05:00Z',
          }]), { status: 200 });
        }
        return new Response(JSON.stringify([{ inserted_count: 1, total_count: 1 }]), { status: 200 });
      }) as typeof fetch;

      const claimed = await claimSourceRecordById('user-1', 'source-1', token, 300);
      assert.equal(claimed.record?.claim_token, token);
      assert.equal(claimed.record?.claim_version, claimVersion);
      assert.ok(claimed.record);

      await commitSourceAngleExtraction('user-1', claimed.record, [{
        angle: 'Label: thesis',
        angle_title: 'Label',
        angle_summary: 'thesis',
        intended_platform: 'x',
      }]);

      assert.equal(bodies[0].p_source_record_id, 'source-1');
      assert.equal(bodies[0].p_claim_token, token);
      assert.equal(bodies[1].p_claim_token, token);
      assert.equal(bodies[1].p_claim_version, claimVersion);
      assert.equal(bodies[1].p_source_record_id, 'source-1');
    });

    await test('targeted angle claim and queue commit preserve fencing and schedule identity', async () => {
      const bodies: Array<Record<string, unknown>> = [];
      const token = '33333333-3333-4333-8333-333333333333';
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        bodies.push(body);
        if (url.endsWith('/rpc/claim_angle_record_by_id')) {
          return new Response(JSON.stringify([{
            id: 'angle-1',
            user_id: 'user-1',
            angle: 'Label: thesis',
            source_record_id: 'source-1',
            source_reddit_post_id: 'source-1',
            subreddit: 'manual',
            reddit_author: 'manual',
            source_url: 'https://example.com/source',
            angle_title: 'Label',
            angle_summary: 'thesis',
            intended_platform: 'x',
            status: 'in_progress',
            claim_token: token,
            claim_version: 9,
            claim_expires_at: '2026-09-06T00:05:00Z',
          }]), { status: 200 });
        }
        return new Response(JSON.stringify([{
          id: 'queue-1',
          user_id: 'user-1',
          slot_index: 2,
          scheduled_for: '2026-09-07T12:00:00Z',
          scheduled_local_date: '2026-09-07',
          scheduled_timezone: 'Europe/London',
          platform: 'x',
          status: 'ready',
          draft_text: 'draft',
          angle_record_id: 'angle-1',
        }]), { status: 200 });
      }) as typeof fetch;

      const claimed = await claimAngleRecordById('user-1', 'angle-1', ['x'], token, 900);
      assert.ok(claimed.record);
      const row = await commitClaimedAngleDraft({
        userId: 'user-1',
        angleRecordId: claimed.record.id,
        claimToken: claimed.record.claim_token,
        claimVersion: claimed.record.claim_version,
        platform: 'x',
        slotIndex: 2,
        scheduledFor: '2026-09-07T12:00:00Z',
        scheduledLocalDate: '2026-09-07',
        scheduledTimezone: 'Europe/London',
        draftText: 'draft',
      });

      assert.equal(row.id, 'queue-1');
      assert.equal(bodies[0].p_angle_record_id, 'angle-1');
      assert.deepEqual(bodies[0].p_platforms, ['x']);
      assert.equal(bodies[1].p_claim_token, token);
      assert.equal(bodies[1].p_claim_version, 9);
      assert.equal(bodies[1].p_scheduled_local_date, '2026-09-07');
      assert.equal(bodies[1].p_scheduled_timezone, 'Europe/London');
    });

    await test('no-draft terminal operation keeps the original fencing generation', async () => {
      let body: Record<string, unknown> = {};
      globalThis.fetch = (async (_input, init) => {
        body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        return new Response('true', { status: 200 });
      }) as typeof fetch;

      const completed = await exhaustAngleRecordClaim('user-1', {
        id: 'angle-1',
        claim_token: '44444444-4444-4444-8444-444444444444',
        claim_version: 11,
      });

      assert.equal(completed, true);
      assert.equal(body.p_angle_record_id, 'angle-1');
      assert.equal(body.p_claim_version, 11);
    });
  } finally {
    globalThis.fetch = originalFetch;
    config.SUPABASE_URL = originalConfig.url;
    config.SUPABASE_SERVICE_ROLE_KEY = originalConfig.role;
    config.CREDENTIAL_ENCRYPTION_KEY = originalConfig.encryption;
  }
}

void main();

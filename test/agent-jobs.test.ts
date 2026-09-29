import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import config from '../config';
import { claimAgentJob, finishAgentJob, renewAgentJob, enqueueScheduledAgentJob, scheduledOperationKey, assertAgentJobsContract, type AgentJobRow } from '../src/agent-jobs';
const user = '10000000-0000-4000-8000-000000000001';
const id = '20000000-0000-4000-8000-000000000001';
const token = '30000000-0000-4000-8000-000000000001';
const job: AgentJobRow = { id, user_id: user, kind: 'skip_slot', payload: {}, status: 'running', created_at: '2026-09-01T00:00:00Z', claim_token: token, claim_version: 1, claim_mode: 'execute' };
test('job RPCs pin identity, validate ownership and preserve replay identity', async () => {
  const original = globalThis.fetch;
  const saved = { SUPABASE_URL: config.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: config.SUPABASE_SERVICE_ROLE_KEY, CREDENTIAL_ENCRYPTION_KEY: config.CREDENTIAL_ENCRYPTION_KEY };
  Object.assign(config, { SUPABASE_URL:'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY:'fixture', CREDENTIAL_ENCRYPTION_KEY:'fixture' });
  const calls: any[] = [];
  let reply: unknown = [job];
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return Response.json(reply); };
  try {
    assert.equal((await claimAgentJob(job, false, token))?.claim_version, 1);
    assert.equal(calls[calls.length - 1].p_claim_token, token);
    assert.equal(calls[calls.length - 1].p_expected_version, null);
    reply = [{ ...job, claim_mode: 'reconcile', claim_version: 2 }];
    assert.equal((await claimAgentJob(job, true, token))?.claim_mode, 'reconcile');
    assert.equal(calls[calls.length - 1].p_expected_version, 1);
    reply = [{ ...job, user_id: 'another' }];
    await assert.rejects(claimAgentJob(job, false, token), /ownership_lost/);
    reply = false;
    await assert.rejects(renewAgentJob(job), /ownership_lost/);
    await assert.rejects(finishAgentJob(job, 'failed', {}, null, null), /ownership_lost/);
    reply = true;
    await finishAgentJob(job, 'completed', { ok: true }, null, null);
    assert.equal(calls[calls.length - 1].p_claim_version, 1);
    reply = { created: false, job };
    assert.equal(await enqueueScheduledAgentJob(user, 'skip_slot', {}, 'key'), null);
    reply = { contract: 'agent-jobs-v1', capabilities: [] };
    await assert.rejects(assertAgentJobsContract(), /schema_unavailable/);
    assert.equal(scheduledOperationKey('publish', [id, 'due']), scheduledOperationKey('publish', [id, 'due']));
    assert.notEqual(scheduledOperationKey('publish', [id, 'due']), scheduledOperationKey('publish', [id, 'other']));
  } finally { globalThis.fetch = original; Object.assign(config, saved); }
});
test('all real worker job mutations use RPCs and recovery never executes a lost handler', () => {
  const source = readFileSync('src/supabase-worker.ts', 'utf8');
  assert.doesNotMatch(source, /supabase(?:Update|Insert)(?:<[^>]+>)?\('agent_jobs'/);
  const recovery = source.slice(source.indexOf('async function cleanupStaleRunningJobs'), source.indexOf('export async function runSupabaseAutomationScheduler'));
  assert.match(recovery, /claimAgentJob\(expired, true\)/);
  assert.doesNotMatch(recovery, /handleClaimedJob\(|releaseStaleRefreshAngleLocks\(|enqueueScheduledAgentJob\(/);
  assert.match(source, /send: async \(\) => \{ await assertActiveAgentJob\(\)/);
});

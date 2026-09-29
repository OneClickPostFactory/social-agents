import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { supabaseRpc } from './supabase-client';

export interface AgentJobRow {
  id: string;
  user_id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  status: string;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
  result?: Record<string, unknown> | null;
  operation_key?: string | null;
  claim_token?: string | null;
  claim_version?: number;
  claim_expires_at?: string | null;
  claim_mode?: 'execute' | 'reconcile' | null;
}
export class AgentJobOwnershipLostError extends Error {
  constructor() { super('agent_job_ownership_lost'); }
}
const LEASE_SECONDS = 120;
const scope = new AsyncLocalStorage<{ job: AgentJobRow; lost: boolean }>();

export async function assertAgentJobsContract(): Promise<void> {
  const contract = await supabaseRpc<{ contract: string; capabilities: string[] }>('get_agent_jobs_contract', {}, { retrySafe: true });
  if (contract?.contract !== 'agent-jobs-v1' || !Array.isArray(contract.capabilities)
    || ['durable-enqueue-v1', 'fenced-terminal-v1', 'reconciliation-only-recovery-v1', 'rpc-only-job-writes-v1']
      .some(value => !contract.capabilities.includes(value))) throw new Error('agent_jobs_schema_unavailable');
}

function identity(job: AgentJobRow) {
  if (!job.claim_token || !Number.isSafeInteger(job.claim_version) || Number(job.claim_version) < 1) {
    throw new AgentJobOwnershipLostError();
  }
  return { p_user_id: job.user_id, p_job_id: job.id, p_claim_token: job.claim_token, p_claim_version: job.claim_version };
}

export async function claimAgentJob(job: AgentJobRow, recovery = false, token = randomUUID()): Promise<AgentJobRow | null> {
  const rows = await supabaseRpc<AgentJobRow[]>('claim_agent_job', {
    p_user_id: job.user_id, p_job_id: job.id, p_claim_token: token,
    p_lease_seconds: LEASE_SECONDS, p_recovery: recovery,
    p_expected_version: recovery ? job.claim_version : null,
  }, { retrySafe: true });
  const row = rows[0];
  if (!row) return null;
  if (row.id !== job.id || row.user_id !== job.user_id || row.claim_token !== token
    || row.status !== 'running' || row.claim_mode !== (recovery ? 'reconcile' : 'execute')) {
    throw new AgentJobOwnershipLostError();
  }
  identity(row);
  return row;
}

export async function renewAgentJob(job: AgentJobRow): Promise<void> {
  const owned = await supabaseRpc<boolean>('renew_agent_job', { ...identity(job), p_lease_seconds: LEASE_SECONDS }, { retrySafe: true });
  if (owned !== true) throw new AgentJobOwnershipLostError();
}

export async function finishAgentJob(job: AgentJobRow, status: string, result: Record<string, unknown>, error: string | null,
  automation: Record<string, unknown> | null): Promise<void> {
  const saved = await supabaseRpc<boolean>('finish_agent_job', {
    ...identity(job), p_status: status, p_result: result, p_error: error, p_automation_result: automation,
  }, { retrySafe: true });
  if (saved !== true) throw new AgentJobOwnershipLostError();
}

export async function assertActiveAgentJob(): Promise<void> {
  const current = scope.getStore();
  // Standalone publication-contract tests and other existing callers retain
  // their own source/angle/publication fences. SaaS job execution has this scope.
  if (!current) return;
  if (current.lost || current.job.claim_mode !== 'execute') throw new AgentJobOwnershipLostError();
  try { await renewAgentJob(current.job); }
  catch { current.lost = true; throw new AgentJobOwnershipLostError(); }
}

export async function withAgentJobLease<T>(job: AgentJobRow, run: () => Promise<T>): Promise<T> {
  return scope.run({ job, lost: false }, async () => {
    const current = scope.getStore()!;
    await renewAgentJob(job);
    let pending: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (pending || current.lost) return;
      pending = renewAgentJob(job).catch(() => { current.lost = true; }).finally(() => { pending = undefined; });
    }, 30_000);
    try {
      const result = await run();
      if (current.lost) throw new AgentJobOwnershipLostError();
      return result;
    } finally {
      clearInterval(timer);
      await pending;
      // Never race the handler: already-dispatched effects cannot be recalled.
    }
  });
}

export function scheduledOperationKey(kind: string, identityParts: unknown): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(identityParts)).digest('hex')}`;
}

export async function enqueueScheduledAgentJob(userId: string, kind: string, payload: Record<string, unknown>, operationKey: string): Promise<AgentJobRow | null> {
  const response = await supabaseRpc<{ created: boolean; job: AgentJobRow }>('enqueue_worker_agent_job', {
    p_user_id: userId, p_kind: kind, p_payload: payload, p_operation_key: operationKey,
  }, { retrySafe: true });
  if (typeof response?.created !== 'boolean' || response.job?.user_id !== userId || response.job?.kind !== kind) {
    throw new Error('agent_job_enqueue_receipt_invalid');
  }
  // Replay acknowledges the old operation but must not overwrite its terminal UI
  // projection, advance its cursor again, or count another enqueue.
  return response.created ? response.job : null;
}

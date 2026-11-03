import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import config from '../config';
import { parseControlledPublish } from '../src/controlled-publish';
import { runWithRuntimeScope, installScopedConfig } from '../src/runtime-scope';
import { processPendingSupabaseJobs } from '../src/supabase-worker';

const exec = promisify(execFile);

async function invoke(tool: string, args: Record<string, unknown>, key: string) {
  const params = { name: 'relay_live_business_engagement_' + tool, args, agentId: 'social-publication-worker',
    sessionKey: 'agent:social-publication-worker:main', idempotencyKey: key };
  let output;
  try {
    output = await exec('openclaw', ['gateway','call','tools.invoke','--json','--timeout','120000',
      '--params', JSON.stringify(params)], { timeout: 130000, maxBuffer: 1024 * 1024 });
  } catch { throw Error('relay_transport_unconfirmed'); }
  const response = JSON.parse(output.stdout);
  if (response.ok !== true || !response.output?.details) throw Error('relay_response_unconfirmed');
  return response.output.details;
}

async function main() {
  const target = parseControlledPublish(process.env.CONTROLLED_PUBLISH || '');
  if (target.platform !== 'threads' || !config.SUPABASE_WORKER_CANARY_REQUIRED ||
      config.CONNECTION_LIFECYCLE_CANARY_USER_IDS.size !== 1 ||
      !config.CONNECTION_LIFECYCLE_CANARY_USER_IDS.has(target.userId) ||
      config.SUPABASE_WORKER_GENERATION_ENABLED || config.SUPABASE_PROVIDER_DISPATCH_ENABLED) {
    throw Error('controlled_publish_rollout_mismatch');
  }
  const sessionId = 'rlbe_ocpf_' + target.jobId + '_' + target.approvalHash;
  const accounts = await invoke('accounts', { relayAvailable: false, verifyAuth: true }, sessionId + ':account');
  const account = accounts.accounts?.find((a: {key: string}) => a.key === 'threads:owner');
  if (account?.authentication !== 'authenticated' || account.representedAccount?.id !== target.accountId) {
    throw Error('relay_destination_mismatch');
  }
  installScopedConfig(config);
  return runWithRuntimeScope(async () => {
    config.SUPABASE_WORKER_CANARY_USER_IDS = new Set([target.userId]);
    config.SUPABASE_PROVIDER_DISPATCH_ENABLED = true;
    return processPendingSupabaseJobs({ ...target, sendThreads: async text => {
      if (Date.now() >= target.expiresAt) throw Error('controlled_publish_expired');
      const receipt = await invoke('execute', { platform: 'threads', accountKey: 'threads:owner',
        action: 'publish', campaignLaneId: 'oneclickpostfactory', opportunityId: target.jobId,
        runtimeOwner: 'oneclickpostfactory', sessionId: sessionId + '_live', text, dryRun: false, explicitWriteApproval: true },
        sessionId + ':publish');
      const id = receipt.activity?.providerResultId;
      if (receipt.outcome !== 'success' || receipt.externalWritePerformed !== true ||
          receipt.evidence?.verified !== true || typeof id !== 'string' || !/^\d{1,32}$/.test(id)) {
        throw Error('relay_publication_unconfirmed');
      }
      return id;
    }});
  });
}

main().then(stats => console.log(stats)).catch(() => { console.error('Controlled Threads execution did not confirm completion'); process.exitCode = 1; });

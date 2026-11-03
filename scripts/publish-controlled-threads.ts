import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseControlledPublish } from '../src/controlled-publish';

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
  const token = process.env.THREADS_RELAY_TOKEN || '';
  const textHash = process.env.THREADS_APPROVED_TEXT_SHA256 || '';
  if (target.platform !== 'threads' || token.length < 32 || !/^[0-9a-f]{64}$/.test(textHash)) throw Error('invalid_relay_scope');
  const sessionId = 'rlbe_ocpf_' + target.jobId + '_' + target.approvalHash;
  const accounts = await invoke('accounts', { relayAvailable: false, verifyAuth: true }, sessionId + ':account');
  const account = accounts.accounts?.find((a: {key: string}) => a.key === 'threads:owner');
  if (account?.authentication !== 'authenticated' || account.representedAccount?.id !== target.accountId) {
    throw Error('relay_destination_mismatch');
  }
  const hash = (s: string) => createHash('sha256').update(s).digest();
  let dispatched = false;
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    try {
      if (req.method !== 'POST' || req.url !== '/threads' || Date.now() >= target.expiresAt ||
          !timingSafeEqual(hash(req.headers.authorization || ''), hash('Bearer ' + token))) throw Error();
      let body = '';
      req.setEncoding('utf8');
      for await (const chunk of req) { body += chunk; if (body.length > 8192) throw Error(); }
      const { action, target: requested, text } = JSON.parse(body);
      if (!isDeepStrictEqual(requested, target) || Date.now() >= target.expiresAt || dispatched) throw Error();
      const scope = { jobId: target.jobId, accountId: target.accountId };
      if (action === 'ready') { res.end(JSON.stringify(scope)); return; }
      if (action !== 'publish' || typeof text !== 'string' || hash(text).toString('hex') !== textHash) throw Error();
      dispatched = true;
      const receipt = await invoke('execute', { platform: 'threads', accountKey: 'threads:owner',
        action: 'publish', campaignLaneId: 'oneclickpostfactory', opportunityId: target.jobId,
        runtimeOwner: 'oneclickpostfactory', sessionId: sessionId + '_live', text, dryRun: false, explicitWriteApproval: true },
        sessionId + ':publish');
      const id = receipt.activity?.providerResultId;
      if (receipt.outcome !== 'success' || receipt.externalWritePerformed !== true ||
          receipt.evidence?.verified !== true || typeof id !== 'string' || !/^\d{1,32}$/.test(id)) {
        throw Error('relay_publication_unconfirmed');
      }
      res.end(JSON.stringify({ ...scope, externalPostId: id }));
    } catch { res.writeHead(409); res.end(); }
  });
  server.listen(Number(process.env.THREADS_RELAY_PORT || 8789), '127.0.0.1');
  setTimeout(() => server.close(), Math.max(1, target.expiresAt - Date.now())).unref();
}

main().catch(() => { console.error('Controlled Threads relay unavailable'); process.exitCode = 1; });

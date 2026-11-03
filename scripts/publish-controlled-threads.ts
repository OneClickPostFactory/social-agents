import { createControlledThreadsRelay, parseThreadsRelayTarget } from '../src/controlled-threads-relay';

async function invoke(tool: string, args: Record<string, unknown>) {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw Error('gateway_auth_missing');
  const response = await fetch('http://127.0.0.1:18789/tools/invoke', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'relay_live_business_engagement_' + tool, args,
      sessionKey: 'agent:social-publication-worker:main' }),
  });
  if (!response.ok) throw Error('relay_response_unconfirmed');
  const body = await response.json() as { ok?: boolean; result?: { details?: unknown } };
  if (!body.ok || !body.result?.details) throw Error('relay_response_unconfirmed');
  return body.result.details;
}

function main() {
  const receiptsOnly = process.env.THREADS_RELAY_RECEIPTS_ONLY === 'true';
  const target = parseThreadsRelayTarget(process.env.CONTROLLED_PUBLISH || '', receiptsOnly);
  const port = Number(process.env.THREADS_RELAY_PORT || 8789);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('invalid_relay_port');
  const relay = createControlledThreadsRelay({
    target, receiptsOnly, token: process.env.THREADS_RELAY_TOKEN || '',
    textHash: process.env.THREADS_APPROVED_TEXT_SHA256 || '',
    journalDir: process.env.THREADS_RELAY_JOURNAL_DIR || '', invoke,
  });
  // The expiry gates writes in the handler. Keep authenticated receipt readback
  // available after expiry; a restart can explicitly select receipts-only mode.
  relay.server().listen(port, '127.0.0.1');
}

try { main(); }
catch { console.error('Controlled Threads relay unavailable'); process.exitCode = 1; }

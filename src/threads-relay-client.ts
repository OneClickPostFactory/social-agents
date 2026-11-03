import type { ControlledPublish } from './controlled-publish';

export async function connectThreadsRelay(target: ControlledPublish, endpoint: string, bearer: string) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/threads' || bearer.length < 32 || target.platform !== 'threads') throw Error('invalid_threads_relay');
  async function call(action: 'ready' | 'publish', text?: string) {
    if (Date.now() >= target.expiresAt) throw Error('controlled_publish_expired');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), action === 'ready' ? 15000 : 135000);
    try {
      const response = await fetch(url.toString(), { method: 'POST', redirect: 'manual',
        headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, target, text }), signal: controller.signal });
      if (!response.ok) throw Error('threads_relay_http_' + response.status);
      const result = await response.json() as { accountId?: string; jobId?: string; externalPostId?: string };
      if (result.accountId !== target.accountId || result.jobId !== target.jobId) throw Error('threads_relay_scope_mismatch');
      return result;
    } finally { clearTimeout(timer); }
  }
  await call('ready');
  return async (text: string) => {
    const result = await call('publish', text);
    if (typeof result.externalPostId !== 'string' || !/^[0-9]{1,32}$/.test(result.externalPostId)) throw Error('threads_relay_receipt_missing');
    return result.externalPostId;
  };
}

import type { ControlledPublish } from './controlled-publish';

export interface ThreadsRelayAttempt {
  attemptId: string;
  dispatchOperationId: string;
}

type RelayResult = ControlledPublish & Partial<ThreadsRelayAttempt> & { externalPostId?: string };

function relayTransport(target: ControlledPublish, endpoint: string, bearer: string) {
  const frozen = Object.freeze({ ...target });
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/threads' || bearer.length < 32 || frozen.platform !== 'threads') {
    throw Error('invalid_threads_relay');
  }
  const scopeKeys = ['jobId', 'userId', 'queueId', 'accountId', 'generation', 'platform', 'approvalHash'] as const;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  function validateAttempt(attempt: ThreadsRelayAttempt): void {
    if (!attempt || !uuid.test(attempt.attemptId) || !uuid.test(attempt.dispatchOperationId)) {
      throw Error('threads_relay_attempt_invalid');
    }
  }
  async function call(action: 'ready' | 'publish' | 'receipt', text?: string, attempt?: ThreadsRelayAttempt) {
    // Receipt recovery never grants another write, even after the send window closes.
    if (action !== 'receipt' && Date.now() >= frozen.expiresAt) throw Error('controlled_publish_expired');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), action === 'publish' ? 135000 : 15000);
    try {
      const response = await fetch(url.toString(), { method: 'POST', redirect: 'manual',
        headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, target: frozen, text, attempt }), signal: controller.signal });
      if (!response.ok) throw Error('threads_relay_http_' + response.status);
      const result = await response.json() as RelayResult;
      if (!result || scopeKeys.some(key => result[key] !== frozen[key]) ||
          (attempt && (result.attemptId !== attempt.attemptId ||
            result.dispatchOperationId !== attempt.dispatchOperationId))) {
        throw Error('threads_relay_scope_mismatch');
      }
      return result;
    } finally { clearTimeout(timer); }
  }
  function receiptId(result: RelayResult): string {
    if (typeof result.externalPostId !== 'string' || !/^[0-9]{1,32}$/.test(result.externalPostId)) {
      throw Error('threads_relay_receipt_missing');
    }
    return result.externalPostId;
  }
  return { frozen, call, receiptId, validateAttempt };
}

/** Recover a cached exact receipt without readiness or publication authority. */
export async function recoverThreadsRelayReceipt(
  target: ControlledPublish, endpoint: string, bearer: string, attempt: ThreadsRelayAttempt,
): Promise<string> {
  const transport = relayTransport(target, endpoint, bearer);
  transport.validateAttempt(attempt);
  return transport.receiptId(await transport.call('receipt', undefined, attempt));
}

export async function connectThreadsRelay(target: ControlledPublish, endpoint: string, bearer: string) {
  const { frozen, call, receiptId, validateAttempt } = relayTransport(target, endpoint, bearer);
  await call('ready');
  let first: { text: string; attempt: ThreadsRelayAttempt; outcome: Promise<string> } | undefined;
  return (text: string, attempt: ThreadsRelayAttempt): Promise<string> => {
    validateAttempt(attempt);
    if (first) {
      if (first.text !== text || first.attempt.attemptId !== attempt.attemptId ||
          first.attempt.dispatchOperationId !== attempt.dispatchOperationId) {
        return Promise.reject(Error('threads_relay_operation_mismatch'));
      }
      return first.outcome;
    }
    const immutableAttempt = Object.freeze({ ...attempt });
    const outcome = (async () => {
      // Check outside the recovery catch: an expired grant has not authorised a send.
      if (Date.now() >= frozen.expiresAt) throw Error('controlled_publish_expired');
      try {
        return receiptId(await call('publish', text, immutableAttempt));
      } catch {
        // A failed response is not evidence that publication failed. Only recover
        // an existing exact receipt; never repeat the write or re-open the job.
        try { return receiptId(await call('receipt', undefined, immutableAttempt)); }
        catch { throw Error('threads_relay_publication_unconfirmed'); }
      }
    })();
    first = { text, attempt: immutableAttempt, outcome };
    return outcome;
  };
}

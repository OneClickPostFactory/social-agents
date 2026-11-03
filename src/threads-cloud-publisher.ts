/** Direct Threads transport. Caller must hold the durable publication claim. */
export type ThreadsCloudTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface ThreadsCloudRequest { accountId: string; accessToken: string; text: string; }
const idPattern = /^[0-9]{1,32}$/;
export async function publishThreadsCloud(request: ThreadsCloudRequest, transport: ThreadsCloudTransport = fetch): Promise<string> {
  if (!idPattern.test(request.accountId) || !request.accessToken.trim() || !request.text.trim()) throw Error('threads_cloud_input_invalid');
  const me = await transport('https://graph.threads.net/v1.0/me?fields=id', { headers: { Authorization: `Bearer ${request.accessToken}` }, redirect: 'error' });
  if (!me.ok) throw Error('threads_cloud_account_unverified');
  const identity = await me.json() as { id?: string };
  if (identity.id !== request.accountId) throw Error('threads_cloud_account_mismatch');
  const create = await transport(`https://graph.threads.net/v1.0/${request.accountId}/threads`, {
    method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${request.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ media_type: 'TEXT', text: request.text }),
  });
  if (!create.ok) throw Error('threads_cloud_container_unconfirmed');
  const container = await create.json() as { id?: string };
  if (!container.id || !idPattern.test(container.id)) throw Error('threads_cloud_container_unconfirmed');
  // An uncertain publish response must remain fenced by the durable attempt ledger.
  const published = await transport(`https://graph.threads.net/v1.0/${request.accountId}/threads_publish`, {
    method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${request.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: container.id }),
  });
  if (!published.ok) throw Error('threads_cloud_publication_unconfirmed');
  const result = await published.json() as { id?: string };
  if (!result.id || !idPattern.test(result.id)) throw Error('threads_cloud_publication_unconfirmed');
  const readback = await transport(`https://graph.threads.net/v1.0/${result.id}?fields=id`, {
    headers: { Authorization: `Bearer ${request.accessToken}` }, redirect: 'error',
  });
  if (!readback.ok || (await readback.json() as { id?: string }).id !== result.id) throw Error('threads_cloud_readback_unconfirmed');
  return result.id;
}

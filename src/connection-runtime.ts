import { AsyncLocalStorage } from 'node:async_hooks';
import config from '../config';
import { supabaseUpdate, type SupabaseMutationOptions } from './supabase-client';
import { captureConnections, ConnectionSession, type ConnectionSnapshot, type ConnectionRpc, type ConnectionProvider } from './connection-lifecycle';

const scope = new AsyncLocalStorage<ConnectionSession>();
export const CONNECTION_CAPABILITIES = [
  'connection-atomic-snapshot-v1', 'connection-owner-generation-v1', 'connection-refresh-cas-v1',
  'connection-legacy-write-denial-v1', 'connection-callback-generation-v1', 'connection-publication-binding-v1',
] as const;
// This narrow adapter intentionally does not inherit the old client's redirect,
// unbounded body or exception formatting. No automatic external-token retry.
export const connectionRpc: ConnectionRpc = async (name, params, retrySafe) => {
  if (!['capture_connection_snapshot','mutate_connection','get_connection_generation_contract','check_queue_connection_binding'].includes(name))
    throw Error('connection_rpc_not_allowed');
  const origin = new URL(config.SUPABASE_URL);
  const local = process.env.PUBLICATION_DATABASE_TEST === 'local-only' && ['127.0.0.1','localhost'].includes(origin.hostname);
  if ((!local && origin.protocol !== 'https:') || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/')
    throw Error('connection_database_origin_invalid');
  const body = JSON.stringify(params);
  if (body.length > 65536) throw Error('connection_rpc_input_invalid');
  const once = async (): Promise<unknown> => {
    const controller = new AbortController();
    let stop: (error: Error) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => { stop = reject; });
    const timer = setTimeout(() => { controller.abort(); stop(Error('connection_transport_uncertain')); }, 5000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      let response: Response;
      try {
        response = await Promise.race([fetch(`${origin.origin}/rest/v1/rpc/${name}`, {
          method:'POST', redirect:'manual', signal:controller.signal,
          headers:{Authorization:`Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`, apikey:config.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type':'application/json'}, body,
        }), cancelled]);
      } catch { throw Error('connection_transport_uncertain'); }
      if (response.status !== 200 || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw Error('connection_rpc_rejected');
      }
      reader = response.body.getReader();
      let bytes = 0, text = ''; const decoder = new TextDecoder('utf-8',{fatal:true});
      for (;;) {
        const next = await Promise.race([reader.read(),cancelled]); if (next.done) break;
        bytes += next.value.byteLength; if (bytes > 262144) throw Error('connection_response_unverified');
        text += decoder.decode(next.value,{stream:true});
      }
      if (controller.signal.aborted) throw Error('connection_transport_uncertain');
      return JSON.parse(text + decoder.decode()) as unknown;
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  };
  try { return await once(); } catch (error) {
    // Exact stable body is replayed at most once and only for a contract declared
    // retry-safe and an unclassified/lost transport. 4xx or invalid JSON is not retried.
    if (retrySafe && error instanceof Error && error.message === 'connection_transport_uncertain') {
      try { return await once(); } catch { throw Error('connection_changed_or_unverified'); }
    }
    throw Error('connection_changed_or_unverified');
  }
};
export async function loadConnectionSnapshot(userId: string): Promise<ConnectionSnapshot> {
  if (!config.CONNECTION_LIFECYCLE_ENABLED) throw Error('connection_lifecycle_disabled');
  const c = await connectionRpc('get_connection_generation_contract', {}, false) as Record<string,unknown>;
  if (!c || c.contract !== 'connection-generations-v1' || c.migration !== '20261001154000'
    || !Array.isArray(c.capabilities) || !CONNECTION_CAPABILITIES.every(x => (c.capabilities as unknown[]).includes(x)))
    throw Error('connection_schema_unverified');
  return captureConnections(connectionRpc,userId);
}
export function withConnectionSnapshot<T>(snapshot: ConnectionSnapshot, fn: () => Promise<T>): Promise<T> {
  return scope.run(new ConnectionSession(connectionRpc,snapshot), fn);
}
export function currentConnectionSession(userId?: string): ConnectionSession {
  const session = scope.getStore();
  if (!session || (userId !== undefined && session.snapshot.user_id !== userId)) throw Error('connection_scope_missing_or_wrong_owner');
  return session;
}
export function assertProviderAvailable(provider: ConnectionProvider): void {
  if (config.CONNECTION_LIFECYCLE_ENABLED) currentConnectionSession().assertAvailable(provider);
}
export async function connectionCredentialUpdate<T>(table: string, patch: Record<string, unknown>, options: SupabaseMutationOptions): Promise<T[]> {
  if (table !== 'user_credentials') throw Error('connection_table_invalid');
  if (!config.CONNECTION_LIFECYCLE_ENABLED) return supabaseUpdate<T>(table,patch,options);
  const f=options.filters;
  if (!f || f.length!==1 || f[0].column!=='user_id' || f[0].operator!=='eq' || typeof f[0].value!=='string') throw Error('connection_owner_required');
  const session=currentConnectionSession(f[0].value);
  const prefixes=new Set(Object.keys(patch).map(k=>k.split('_')[0]));
  if (prefixes.size!==1) throw Error('connection_mixed_provider_patch');
  const provider=Array.from(prefixes)[0] as ConnectionProvider;
  if (!['x','threads','linkedin'].includes(provider)) throw Error('connection_provider_unsupported');
  session.assertAvailable(provider);
  const encrypted=Object.keys(patch).some(k=>k.endsWith('_enc'));
  const status=patch[`${provider}_verification_status`];
  const kind=encrypted?'refresh':status==='verified'?'verify':'failure';
  const accountId=kind==='verify' ? (provider==='linkedin'?config.LINKEDIN_PERSON_URN:patch[`${provider}_account_id`]) : null;
  if (accountId!==null && typeof accountId!=='string') throw Error('connection_account_required');
  await session.apply(provider,kind,patch,accountId as string|null);
  // All callers consume this only as confirmation; never fabricate a credential row.
  return [];
}

export async function assertQueueConnectionReady(userId:string,queueId:string):Promise<void> {
  if(!config.CONNECTION_LIFECYCLE_ENABLED)return;
  const r=await connectionRpc('check_queue_connection_binding',{p_user_id:userId,p_queue_id:queueId},true) as Record<string,unknown>;
  if(!r || r.schema!=='ocpf.queue-connection-binding.v1'||r.user_id!==userId||r.queue_id!==queueId
    || !['bound','existing_intent'].includes(String(r.state))) throw Error('connection_changed_review_destination_before_publish');
}

import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import config from '../config';
import { CONNECTION_PROVIDERS, type ConnectionGuard, type ConnectionSnapshot } from '../src/connection-lifecycle';
import { connectionRpc, CONNECTION_CAPABILITIES, loadConnectionSnapshot, withConnectionSnapshot, currentConnectionSession, connectionCredentialUpdate, assertQueueConnectionReady } from '../src/connection-runtime';
import { __test__ as worker } from '../src/supabase-worker';
import { installScopedConfig, runWithRuntimeScope } from '../src/runtime-scope';
import { handleWorkerReadiness, READINESS_CONTRACTS, CONNECTION_READINESS_CONTRACT } from '../src/worker-readiness';
const user='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const guard=(provider:ConnectionGuard['provider']):ConnectionGuard=>({provider,generation:2,revision:1,state:'verified',account_id:'12345',verified_at:'2026-01-01T00:00:00Z'});
const snapshot=(id=user):ConnectionSnapshot=>({schema:'ocpf.connection-snapshot.v1',user_id:id,credentials:{user_id:id},connections:CONNECTION_PROVIDERS.map(guard)});
const original=globalThis.fetch;
Object.assign(config,{SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'private-test-key',CREDENTIAL_ENCRYPTION_KEY:'fixture',CONNECTION_LIFECYCLE_ENABLED:true});
installScopedConfig(config);
afterEach(()=>{globalThis.fetch=original;config.CONNECTION_LIFECYCLE_ENABLED=true;});
function mock(handler:(name:string,body:any,init:RequestInit)=>Response|Promise<Response>) {
 const calls:Array<{name:string;body:any;init:RequestInit}>=[];
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.origin,'https://database.invalid');
  const body=JSON.parse(String(init?.body||'{}'));const name=url.pathname.split('/').pop()!;
  calls.push({name,body,init:init!});return handler(name,body,init!);
 };
 return calls;
}
function response(p:any) {
 return Response.json({schema:'ocpf.connection-mutation.v1',operation_id:p.p_operation_id,user_id:p.p_user_id,
  connection:{...guard(p.p_provider),revision:p.p_revision+1,generation:p.p_generation,state:p.p_kind==='verify'?'verified':p.p_kind==='failure'?'needs_reconnect':'stored_not_verified',account_id:p.p_account_id||'12345'}});
}
test('native capture requires the exact full additive schema first',async()=>{
 const calls=mock(n=>n==='get_connection_generation_contract'?Response.json({contract:'connection-generations-v1',migration:'20261001154000',capabilities:CONNECTION_CAPABILITIES}):Response.json(snapshot()));
 assert.equal((await loadConnectionSnapshot(user)).user_id,user);assert.deepEqual(calls.map(c=>c.name),['get_connection_generation_contract','capture_connection_snapshot']);
 calls.forEach(c=>{assert.equal(c.init.redirect,'manual');assert.ok(c.init.signal);});
});
test('missing schema capability blocks before adopting a tenant',async()=>{
 const calls=mock(()=>Response.json({contract:'connection-generations-v1',migration:'20261001154000',capabilities:CONNECTION_CAPABILITIES.slice(1)}));
 await assert.rejects(loadConnectionSnapshot(user),/schema_unverified/);assert.equal(calls.length,1);
});
test('missing or different tenant scope cannot persist any credential',async()=>{
 const calls=mock(()=>{throw Error('must not read');});
 await assert.rejects(connectionCredentialUpdate('user_credentials',{x_oauth2_access_token_enc:'opaque'},{filters:[{column:'user_id',operator:'eq',value:user}]}),/scope_missing/);
 await withConnectionSnapshot(snapshot(),async()=>await assert.rejects(connectionCredentialUpdate('user_credentials',{x_oauth2_access_token_enc:'opaque'},{filters:[{column:'user_id',operator:'eq',value:other}]}),/scope_missing/));
 assert.equal(calls.length,0);
});
test('refresh updates use the captured generation/revision and never raw table mutation',async()=>{
 const calls=mock((_n,p)=>response(p));
 await withConnectionSnapshot(snapshot(),async()=>{
  await connectionCredentialUpdate('user_credentials',{x_oauth2_access_token_enc:'enc:v1:opaque'},{filters:[{column:'user_id',operator:'eq',value:user}]});
  assert.equal(currentConnectionSession().guard('x').revision,2);
 });
 assert.equal(calls[0].name,'mutate_connection');assert.equal(calls[0].body.p_generation,2);assert.equal(calls[0].body.p_revision,1);
 assert.equal(calls[0].body.p_kind,'refresh');assert.equal(calls.length,1);
});
test('lost mutation transport reuses the identical operation and ciphertext exactly once',async()=>{
 let first=true;const calls=mock((_n,p)=>{if(first){first=false;throw new TypeError('lost');}return response(p);});
 await withConnectionSnapshot(snapshot(),()=>connectionCredentialUpdate('user_credentials',{x_oauth2_access_token_enc:'enc:v1:opaque'},{filters:[{column:'user_id',operator:'eq',value:user}]}));
 assert.equal(calls.length,2);assert.deepEqual(calls[0].body,calls[1].body);
});
for(const code of [301,400,401,403,500]) test(`HTTP ${code} rejection neither leaks private error nor retries`,async()=>{
 const calls=mock(()=>new Response('private-token-in-error',{status:code}));
 await assert.rejects(connectionRpc('mutate_connection',{},true),e=>e instanceof Error&&!e.message.includes('private-token'));assert.equal(calls.length,1);
});
test('interleaved real runtime scopes retain independent guards and global-key removal',async()=>{
 mock((_n,p)=>response(p));config.OPENAI_API_KEY='old-global-key';
 await Promise.all([user,other].map(id=>runWithRuntimeScope(async()=>{
   const s=snapshot(id);
   await worker.withTenantRuntime({userId:id,settings:{},credentials:{},activePlatforms:[],connectionSnapshot:s},async()=>{
    assert.equal(config.OPENAI_API_KEY,'');await new Promise(r=>setImmediate(r));
    assert.equal(currentConnectionSession().snapshot.user_id,id);
    await connectionCredentialUpdate('user_credentials',{x_oauth2_access_token_enc:'encrypted-'+id},{filters:[{column:'user_id',operator:'eq',value:id}]});
   });
 })));
 assert.equal(config.OPENAI_API_KEY,'old-global-key');assert.throws(()=>currentConnectionSession(),/scope_missing/);
});
test('new queue without current account binding is rejected before an intent is created',async()=>{
 const calls=mock((_n,p)=>Response.json({schema:'ocpf.queue-connection-binding.v1',user_id:p.p_user_id,queue_id:p.p_queue_id,state:'review_required'}));
 await assert.rejects(assertQueueConnectionReady(user,other),/review_destination/);assert.equal(calls.length,1);
});
test('receipt recovery remains available without authorising a new mismatched destination',async()=>{
 mock((_n,p)=>Response.json({schema:'ocpf.queue-connection-binding.v1',user_id:p.p_user_id,queue_id:p.p_queue_id,state:'existing_intent'}));
 await assertQueueConnectionReady(user,other);
});
test('flag off does not call adoption or queue guard endpoints',async()=>{
 const calls=mock(()=>Response.json({}));config.CONNECTION_LIFECYCLE_ENABLED=false;
 await assertQueueConnectionReady(user,other);await assert.rejects(loadConnectionSnapshot(user),/disabled/);assert.equal(calls.length,0);
});
test('authenticated readiness conditionally proves the complete connection schema without adoption',async()=>{
 const id='33333333-3333-4333-8333-333333333333',sha='a'.repeat(40),names:string[]=[];
 const req=new Request('https://worker.invalid/readyz',{headers:{Authorization:'Bearer operator','X-OCPF-Readiness-Nonce':other,'X-OCPF-Expected-Version':id,'X-OCPF-Expected-Sha':sha}});
 const env={WORKER_TICK_TOKEN:'operator',SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture',CREDENTIAL_ENCRYPTION_KEY:'fixture',CONNECTION_LIFECYCLE_ENABLED:'true',CF_VERSION_METADATA:{id,tag:sha,timestamp:'2026-01-01T00:00:00Z'}};
 const f:typeof fetch=async(input)=>{
  const name=new URL(String(input)).pathname.split('/').pop()!;names.push(name);
  const c=[...READINESS_CONTRACTS,CONNECTION_READINESS_CONTRACT].find(c=>c.rpc===name)!;assert.ok(c);
  return Response.json({contract:c.contract,capabilities:c.capabilities,...(c.name==='publication'?{migration:'20260907054000',lock_order_migration:'20260913061000'}:c.name==='connections'?{migration:'20261001154000'}:{})});
 };
 assert.equal((await handleWorkerReadiness(req,env,f)).status,200);assert.equal(names.length,4);assert.ok(!names.includes('capture_connection_snapshot'));
});

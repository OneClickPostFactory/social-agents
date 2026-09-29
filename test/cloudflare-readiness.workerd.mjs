import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// Resolve the runtime/bundler from locked Wrangler dependencies. Never download
// a different runtime, contact a real database, or inject a fake Worker fetch.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const sourcePath = resolve('src/worker-readiness.ts');
const result = await build({stdin:{contents:`import {handleWorkerReadiness} from ${JSON.stringify(sourcePath)}; export default {fetch(request, env) {return handleWorkerReadiness(request,env)}};`, resolveDir:process.cwd()}, bundle:true, write:false, format:'esm',platform:'neutral',external:['node:crypto']});
const script = result.outputFiles[0].text;
const version = '11111111-1111-4111-8111-111111111111';
const nonce = '22222222-2222-4222-8222-222222222222';
const sha = 'a'.repeat(40);
const env = {WORKER_TICK_TOKEN:'synthetic-tick-key',SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-db-key',CREDENTIAL_ENCRYPTION_KEY:'synthetic-encryption-key',SUPABASE_WORKER_GENERATION_ENABLED:'false',SUPABASE_PROVIDER_DISPATCH_ENABLED:'false',CF_VERSION_METADATA:{id:version,tag:sha,timestamp:'2026-09-29T00:00:00Z'}};
const headers = {Authorization:'Bearer '+env.WORKER_TICK_TOKEN,'X-OCPF-Readiness-Nonce':nonce,'X-OCPF-Expected-Version':version,'X-OCPF-Expected-Sha':sha};
const source = readFileSync(sourcePath,'utf8');
const specs = {
 get_worker_schema_contract:{contract:'worker-claims-v1',capabilities:['source-targeted-claim-v1','angle-targeted-claim-v1','angle-exhaust-fenced-v1','source-angle-atomic-commit-v1','angle-queue-atomic-commit-v1','queue-angle-identity-v1','legacy-queue-revision-hold-v1']},
 get_publication_schema_contract:{contract:'publication-ledger-v1',migration:'20260907054000',lock_order_migration:'20260913061000',capabilities:['publication-intent-claim-v1','publication-dispatch-boundary-v1','publication-attempt-outcome-v1','publication-unknown-reconciliation-v1','publication-exact-history-receipt-v1','publication-queue-compatibility-fence-v1','publication-provenance-snapshot-v1','publication-legacy-queue-hold-v1','publication-queue-lock-order-v1']},
 get_agent_jobs_contract:{contract:'agent-jobs-v1',capabilities:['durable-enqueue-v1','fenced-terminal-v1','reconciliation-only-recovery-v1','rpc-only-job-writes-v1']},
};
async function runtime({code=script,status=200,auth=headers,invalidBody=false}={}) {
 const calls=[];
 const mf = new Miniflare({modules:true,script:code,compatibilityDate:'2026-05-07',compatibilityFlags:['nodejs_compat'],bindings:env,outboundService:async request=>{
  const u=new URL(request.url); calls.push({origin:u.origin,path:u.pathname,method:request.method,authorisation:request.headers.get('authorization'),body:await request.text()});
  assert.equal(u.origin,'https://database.invalid','credentials must not reach redirects');
  assert.equal(request.method,'POST');
  const spec=specs[u.pathname.split('/').at(-1)]; assert.ok(spec,'only schema RPCs allowed');
  if(status!==200)return new Response('not accepted',{status,headers:status>=300&&status<400?{Location:'https://forbidden.invalid/steal'}:{}});
  return Response.json(invalidBody?{}:spec);
 }});
 try{const r=await mf.dispatchFetch('https://probe.invalid/readyz',{headers:auth});return {status:r.status,body:await r.text(),calls};}
 finally{await mf.dispose();}
}

test('workerd reproduces the previous redirect:error defect before transport',async()=>{
 assert.match(source,/redirect: 'manual'/);
 const old=script.replace('redirect: "manual"','redirect: "error"'); assert.notEqual(old,script);
 const r=await runtime({code:old});assert.equal(r.status,503);assert.equal(r.calls.length,0);
 assert.ok(JSON.parse(r.body).dependencies.every(d=>d.state==='transport_error'));
});
test('the repaired native handler reaches all three schema RPCs in workerd',async()=>{
 const r=await runtime();assert.equal(r.status,200);assert.equal(r.calls.length,3);
 const b=JSON.parse(r.body);assert.equal(b.nonce,nonce);assert.equal(b.readOnly,true);assert.equal(b.executionAuthorised,false);
 assert.equal(b.release.workerVersionId,version);assert.equal(b.release.gitSha,sha);assert.ok(b.dependencies.every(d=>d.state==='verified'));
 assert.ok(r.calls.every(c=>c.authorisation==='Bearer '+env.SUPABASE_SERVICE_ROLE_KEY && c.body==='{}'));
});
for(const status of [301,302,303,307,308]) test(`workerd rejects ${status} without following Location or resending credentials`,async()=>{
 const r=await runtime({status});assert.equal(r.status,503);assert.equal(r.calls.length,3);
 assert.ok(JSON.parse(r.body).dependencies.every(d=>d.state==='http_error'&&d.status===status));
 assert.ok(!r.body.includes('forbidden.invalid'));
});
test('workerd invalid auth sends no database request',async()=>{
 const r=await runtime({auth:{...headers,Authorization:'Bearer wrong'}});assert.equal(r.status,404);assert.equal(r.calls.length,0);
});
test('workerd exact-version mismatch sends no database request',async()=>{
 const r=await runtime({auth:{...headers,'X-OCPF-Expected-Version':nonce}});assert.equal(r.status,503);assert.equal(r.calls.length,0);
});
test('workerd rejects a 200 response with an incompatible schema',async()=>{
 const r=await runtime({invalidBody:true});assert.equal(r.status,503);assert.equal(r.calls.length,3);
 assert.ok(JSON.parse(r.body).dependencies.every(d=>d.state==='contract_mismatch'));
});

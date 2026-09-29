import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import config from '../config';
import { supabaseRpc } from '../src/supabase-client';
import { assertAgentJobsContract, claimAgentJob, finishAgentJob, renewAgentJob, enqueueScheduledAgentJob, type AgentJobRow } from '../src/agent-jobs';
import { processPendingSupabaseJobs } from '../src/supabase-worker';

if (process.env.AGENT_JOBS_DATABASE_TEST !== 'local-only') throw new Error('Local test opt-in required');
const local = JSON.parse(execFileSync('supabase', ['status','--output','json'], { cwd: '.schema-contract', encoding:'utf8', stdio:['ignore','pipe','pipe'] }));
const api = new URL(local.API_URL);
if (!['localhost','127.0.0.1'].includes(api.hostname) || api.protocol !== 'http:') throw new Error('Remote databases forbidden');
const dbs = execFileSync('docker',['ps','--format','{{.Names}}'],{encoding:'utf8'}).trim().split('\n').filter(n=>/^supabase_db_[a-zA-Z0-9_-]+$/.test(n));
assert.equal(dbs.length,1);
const sql = (input:string) => execFileSync('docker',['exec','-i',dbs[0],'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-qAt'],{input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const lit = (s:string) => `'${s.replace(/'/g,"''")}'`;
Object.assign(config,{ SUPABASE_URL:api.origin, SUPABASE_SERVICE_ROLE_KEY:local.SERVICE_ROLE_KEY, CREDENTIAL_ENCRYPTION_KEY:'isolated-job-test', HTTP_TIMEOUT_MS:5000,
 SUPABASE_WORKER_CANARY_REQUIRED:false, SUPABASE_WORKER_CANARY_USER_IDS:'', SUPABASE_WORKER_GENERATION_ENABLED:true, SUPABASE_PROVIDER_DISPATCH_ENABLED:true });
const realFetch = globalThis.fetch;
let lost = '', losses = 0, requests = 0;
globalThis.fetch = async (input,init) => {
 const url = new URL(String(input)); assert.equal(url.origin,api.origin,'no provider or paid model transport is permitted'); requests++;
 const response = await realFetch(input,init);
 if (url.pathname.endsWith(lost) && lost && losses > 0 && response.ok) { losses--; await response.text(); throw new TypeError('injected committed reply loss'); }
 return response;
};
function seed() {
 const user=randomUUID(), row=randomUUID();
 sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(${lit(user)}::uuid,${lit(user+'@example.invalid')},'{}');
 UPDATE public.profiles SET subscription_status='active' WHERE user_id=${lit(user)}::uuid;
 INSERT INTO public.user_settings(user_id,automation_enabled,automation_publish_enabled,automation_fetch_enabled,x_enabled)
 VALUES(${lit(user)}::uuid,true,true,true,true) ON CONFLICT(user_id) DO UPDATE SET automation_enabled=true,automation_publish_enabled=true,automation_fetch_enabled=true;
 INSERT INTO public.queue_items(id,user_id,platform,slot_index,scheduled_for,status,draft_text)
 VALUES(${lit(row)}::uuid,${lit(user)}::uuid,'x',0,'2026-01-01T00:00:00Z','ready','fixture only');`);
 return {user,row};
}
function payload(row:string) { return { source:'scheduled',scheduler:'cloudflare_cron',queue_item_id:row,due_at:'2026-01-01T00:00:00.000Z' }; }
async function enqueue(f:ReturnType<typeof seed>,key=randomUUID()) {
 const result=await supabaseRpc<{job:AgentJobRow;created:boolean}>('enqueue_worker_agent_job',{p_user_id:f.user,p_kind:'publish_now',p_payload:payload(f.row),p_operation_key:key},{retrySafe:true});
 return result;
}
function expire(job:AgentJobRow) { sql(`UPDATE public.agent_jobs SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE id=${lit(job.id)}::uuid;`); }
let scenarios=0;
async function check(name:string,fn:()=>Promise<void>|void) { await fn(); console.log(`PASS JOB ${++scenarios}: ${name}`); }
async function main() {
 await assertAgentJobsContract();
 await check('simultaneous enqueue returns one permanent operation and one created receipt', async()=>{
   for(let round=0;round<10;round++) {
     const f=seed(),key=randomUUID(); const rs=await Promise.all(Array.from({length:8},()=>enqueue(f,key)));
     assert.equal(new Set(rs.map(r=>r.job.id)).size,1);assert.equal(rs.filter(r=>r.created).length,1);
     const job=(await claimAgentJob(rs[0].job))!; await finishAgentJob(job,'completed',{done:true},null,null);
     const replay=await enqueue(f,key);assert.equal(replay.created,false);assert.equal(replay.job.status,'completed');
   }
 });
 await check('same key and different payload is rejected, not a new intent',async()=>{
   const f=seed(),key=randomUUID();await enqueue(f,key);
   await assert.rejects(supabaseRpc('enqueue_worker_agent_job',{p_user_id:f.user,p_kind:'publish_now',p_payload:{...payload(f.row),due_at:'2026-01-02'},p_operation_key:key}),/identity_conflict/);
 });
 await check('different keys cannot race a second active operation for the same row',async()=>{
   const f=seed();const rs=await Promise.allSettled(Array.from({length:8},()=>enqueue(f)));
   assert.equal(rs.filter(r=>r.status==='fulfilled').length,1);
 });
 await check('lost enqueue reply reuses the identity and does not advance bookkeeping twice',async()=>{
   const f=seed(),key=randomUUID();lost='/enqueue_worker_agent_job';losses=1;
   const r=await enqueue(f,key);assert.equal(r.created,false);
   assert.equal(sql(`SELECT count(*) FROM public.agent_jobs WHERE user_id=${lit(f.user)}::uuid;`),'1');
   lost='';
 });
 await check('competing execution claimers have exactly one owner',async()=>{
   const f=seed(),j=(await enqueue(f)).job;const rs=await Promise.all(Array.from({length:8},()=>claimAgentJob(j)));
   assert.equal(rs.filter(Boolean).length,1);assert.equal(rs.find(Boolean)!.claim_version,1);
 });
 await check('lost claim reply preserves token and fencing version',async()=>{
   const f=seed(),j=(await enqueue(f)).job,token=randomUUID();lost='/claim_agent_job';losses=1;
   const owner=(await claimAgentJob(j,false,token))!;assert.equal(owner.claim_token,token);assert.equal(owner.claim_version,1);lost='';
 });
 await check('expired execute claims cannot be replayed; recovery fences the previous owner',async()=>{
   const f=seed(),j=(await enqueue(f)).job,old=(await claimAgentJob(j))!;expire(old);
   assert.equal(await claimAgentJob(old),null);await assert.rejects(renewAgentJob(old),/ownership_lost/);
   const replacement=(await claimAgentJob(old,true))!;assert.equal(replacement.claim_mode,'reconcile');assert.equal(replacement.claim_version,2);
   await assert.rejects(finishAgentJob(old,'completed',{stale:true},null,{stale:true}),/ownership_lost/);
   await finishAgentJob(replacement,'failed',{outcome:'unknown'},'reconciliation_required',{outcome:'unknown'});
   assert.equal(sql(`SELECT result->>'outcome' FROM public.agent_jobs WHERE id=${lit(j.id)}::uuid;`),'unknown');
   assert.equal(sql(`SELECT last_automation_result->>'outcome' FROM public.user_settings WHERE user_id=${lit(f.user)}::uuid;`),'unknown');
   await assert.rejects(finishAgentJob(old,'failed',{stale:true},'stale',{stale:true}),/ownership_lost/);
 });
 await check('stale recovery snapshots cannot take a newer owner and live owners renew',async()=>{
   const f=seed(),old=(await claimAgentJob((await enqueue(f)).job))!;await renewAgentJob(old);expire(old);
   const replacement=(await claimAgentJob(old,true))!;assert.equal(await claimAgentJob(old,true),null);
   expire(replacement);assert.equal(await claimAgentJob(old,true),null);
   const third=(await claimAgentJob(replacement,true))!;assert.equal(third.claim_version,3);
 });
 await check('lost finish reply is idempotent; contradictory terminal writes are rejected',async()=>{
   const f=seed(),j=(await claimAgentJob((await enqueue(f)).job))!;lost='/finish_agent_job';losses=1;
   await finishAgentJob(j,'completed',{ok:true},null,null);lost='';
   const first=sql(`SELECT completed_at::text FROM public.agent_jobs WHERE id=${lit(j.id)}::uuid;`);
   await finishAgentJob(j,'completed',{ok:true},null,null);
   assert.equal(sql(`SELECT completed_at::text FROM public.agent_jobs WHERE id=${lit(j.id)}::uuid;`),first);
   await assert.rejects(finishAgentJob(j,'failed',{ok:false},'late error',null),/ownership_lost/);
 });
 await check('wrong tenant, absent token and raw service-role mutations cannot bypass fences',async()=>{
   const f=seed(),j=(await claimAgentJob((await enqueue(f)).job))!;
   await assert.rejects(finishAgentJob({...j,user_id:randomUUID()},'failed',{},null,null),/ownership_lost/);
   await assert.rejects(finishAgentJob({...j,claim_token:null},'failed',{},null,null),/ownership_lost/);
   assert.throws(()=>sql(`SET ROLE service_role; UPDATE public.agent_jobs SET status='completed' WHERE id=${lit(j.id)}::uuid;`));
   assert.equal(sql("SELECT has_table_privilege('service_role','public.agent_jobs','INSERT,UPDATE,DELETE');"),'f');
   assert.equal(sql("SELECT has_function_privilege('authenticated','public.claim_agent_job(uuid,uuid,uuid,integer,boolean,bigint)','EXECUTE');"),'f');
 });
 await check('browser envelope identity is stable and tenant-derived, with retained terminal result',async()=>{
   const f=seed(),request=randomUUID();
   const call=()=>JSON.parse(sql(`BEGIN; SET LOCAL ROLE authenticated; DO $$ BEGIN PERFORM set_config('request.jwt.claim.sub',${lit(f.user)},true); END $$;
     SELECT row_to_json(j) FROM public.enqueue_agent_job('skip_slot',jsonb_build_object('queue_item_id',${lit(f.row)},'request_id',${lit(request)})) j; COMMIT;`));
   const first=call(),again=call();assert.equal(first.id,again.id);
   const raw=JSON.parse(sql(`SELECT row_to_json(j) FROM public.agent_jobs j WHERE id=${lit(first.id)}::uuid;`)) as AgentJobRow;
   const owner=(await claimAgentJob(raw))!;await finishAgentJob(owner,'completed',{ok:true},null,null);
   assert.equal(call().status,'completed');
   assert.equal(sql(`SELECT payload ? 'request_id' FROM public.agent_jobs WHERE id=${lit(first.id)}::uuid;`),'f');
 });
 await check('scheduled finalisation cannot overwrite a newer job projection',async()=>{
   const f=seed(),j=(await claimAgentJob((await enqueue(f)).job))!;
   sql(`UPDATE public.user_settings SET last_scheduled_job_id=NULL,last_automation_result='{"newer":true}'::jsonb WHERE user_id=${lit(f.user)}::uuid;`);
   await finishAgentJob(j,'completed',{done:true},null,{older:true});
   assert.equal(sql(`SELECT last_automation_result->>'newer' FROM public.user_settings WHERE user_id=${lit(f.user)}::uuid;`),'true');
 });
 await check('real worker completes a non-provider job through the fenced RPC path',async()=>{
   // Scope the real worker to one fixture; other interrupted scenarios stay intact.
   const f=seed(),request=randomUUID();
   sql(`BEGIN;SET LOCAL ROLE authenticated;DO $$ BEGIN PERFORM set_config('request.jwt.claim.sub',${lit(f.user)},true); END $$;
     SELECT * FROM public.enqueue_agent_job('skip_slot',jsonb_build_object('queue_item_id',${lit(f.row)},'request_id',${lit(request)})); COMMIT;`);
   config.SUPABASE_WORKER_CANARY_REQUIRED=true;config.SUPABASE_WORKER_CANARY_USER_IDS=new Set([f.user]);
   const rs=await Promise.all([processPendingSupabaseJobs(),processPendingSupabaseJobs()]);
   assert.equal(rs.reduce((n,r)=>n+r.claimed,0),1);assert.equal(rs.reduce((n,r)=>n+r.completed,0),1);
   assert.equal(sql(`SELECT status::text FROM public.queue_items WHERE id=${lit(f.row)}::uuid;`),'skipped');
   assert.equal(sql(`SELECT status FROM public.agent_jobs WHERE user_id=${lit(f.user)}::uuid;`),'completed');
 });
 console.log(`AGENT_JOBS_DATABASE_INTEGRATION_PASS scenarios=${scenarios}; real Supabase/Postgres; external transport forbidden; live_posts=0; database_requests=${requests}`);
}
main().finally(()=>{globalThis.fetch=realFetch;}).catch(error=>{console.error(error);process.exitCode=1;});

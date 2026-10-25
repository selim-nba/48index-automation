#!/usr/bin/env node
/** GitHub-hosted Weekly runner. Provider client is shared with Substack Publisher.
 * Durable reservations, consent, auth blocks and cooldowns remain on the site. */
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createSubscriberClient} from './vendor/subscribers.mjs';
const counts={checked:0,added:0,synced:0,blocked:0,deferred:0};
const inspect=process.argv.includes('--inspect'),peekOnly=process.argv.includes('--peek'),execute=process.argv.includes('--execute');
const key=process.env.WEEKLY_QUEUE_KEY;
async function api(body){
 if(!key)throw Error('GITHUB_QUEUE_CONFIGURATION');
 const r=await fetch('https://48index.com/api/internal/newsletter-enrollments',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-48-Newsletter-Key':key},body:JSON.stringify(body)});
 if(!r.ok)throw Error('QUEUE_HTTP_'+r.status);return r.json();
}
async function main(){
 const queue=await api({action:'peek'});if(!Number.isSafeInteger(queue.queued)||queue.queued<0)throw Error('GITHUB_QUEUE_INVALID');
 if(peekOnly){if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,`queued=${queue.queued}\n`);return {queued:queue.queued};}
 if(!inspect&&!execute)throw Error('GITHUB_MODE_REQUIRED');
 if(!inspect&&queue.queued===0)return {...counts,empty:true};
 const cookie=process.env.SUBSTACK_SESSION,probe=process.env.SUBSTACK_PROBE_EMAIL;
 if(!cookie||!cookie.startsWith('substack.sid=')||/[\r\n]/.test(cookie)||!probe)throw Error('GITHUB_SUBSTACK_CONFIGURATION');
 const sessionHash=createHash('sha256').update(cookie).digest('hex');
 const state=await api({action:'runner-state',sessionHash});
 if(state.authRequired)throw Error('LOCAL_AUTH_REQUIRED');
 if(Number(state.retryAt)>Date.now())return {...counts,rateLimited:true};
 const remember=(result,retryAfterMs)=>api({action:'runner-result',sessionHash,result,...(retryAfterMs?{retryAfterMs}:{})});
 const client=createSubscriberClient({origin:'https://48index.substack.com',cookie});
 const access=await client.inspectReadAccess(probe);
 if(access.status!==200){
  if(access.status===429){await remember('rate',access.retryAfterMs);throw Error('LOCAL_RATE_LIMITED');}
  if([401,403].includes(access.status)){await remember('auth');throw Error('LOCAL_AUTH_REQUIRED');}
  throw Error('GITHUB_SUBSTACK_UNAVAILABLE');
 }
 if(!await client.defaultsMatch([{id:481649,enabled:true},{id:481648,enabled:false}]))throw Error('LOCAL_DEFAULTS_MISMATCH');
 await remember('ready');
 if(inspect){const subscriber=await client.lookup(probe);return {connected:true,weeklyDefault:true,dailyDefault:false,probeState:subscriber,queued:queue.queued};}
 const {jobs}=await api({action:'claim'});if(!Array.isArray(jobs)||jobs.length>5)throw Error('GITHUB_QUEUE_INVALID');
 let stopped=false;
 for(const job of jobs){
  const finish=(result,extra={})=>api({action:'finish',jobId:job.email_hash,lease:job.lease_until,result,...extra});
  if(stopped){await finish('retry',{error:'LOCAL_READ_FAILED'});continue;}
  counts.checked++;let started=false;
  try{
   const status=await client.lookup(job.email);
   if(status==='present'){await finish('present');counts.synced++;continue;}
   if(status==='blocked'){await finish('blocked');counts.blocked++;continue;}
   if(job.attempted_at!==null){await finish('missing');counts.deferred++;continue;}
   await api({action:'start',jobId:job.email_hash,lease:job.lease_until});started=true;
   await client.add(job.email,{consentConfirmed:true,sendWelcome:true});
   await finish('accepted');counts.added++;
  }catch(error){
   const status=error?.providerResponse?.status;
   await finish('retry',{error:started?'LOCAL_WRITE_UNCONFIRMED':status===429?'LOCAL_RATE_LIMITED':'LOCAL_READ_FAILED',retryAfterMs:error?.retryAfterMs??0});counts.deferred++;stopped=true;
   if(status===429)await remember('rate',error?.retryAfterMs);
   else if([401,403].includes(status))await remember('auth');
  }
 }
 return counts;
}
try{console.log(JSON.stringify(await main()));}catch(error){console.error(JSON.stringify({error:/^(LOCAL_[A-Z_]+|GITHUB_[A-Z_]+|QUEUE_HTTP_\d{3})$/.test(error?.message??'')?error.message:'GITHUB_SYNC_UNCONFIRMED',...counts}));process.exitCode=1;}

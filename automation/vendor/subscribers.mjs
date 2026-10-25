/** Substack Publisher 0.3.0. Shared Node/Workers client; callers own durable deduplication. */
export const SUBSCRIBER_CLIENT_VERSION = '0.3.0';
export function publicationOrigin(value) {
 const u = new URL(value);
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||!/^([a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9])\.substack\.com$/.test(u.hostname))throw Error('SUBSTACK_PUBLICATION_INVALID');
 return u.origin;
}
export function subscriberState(status,data,email){
 if(status===404)return 'missing';
 if(status!==200||!data||typeof data!=='object')throw Error('SUBSTACK_LOOKUP_UNCONFIRMED');
 if(typeof data.email!=='string'||data.email.trim().toLowerCase()!==email.trim().toLowerCase())throw Error('SUBSTACK_IDENTITY_MISMATCH');
 if(data.email_disabled===true)return 'blocked';
 if(data.id==null&&data.membership_state==null)return 'missing';
 if(!Number.isSafeInteger(data.id)||data.id<=0)throw Error('SUBSTACK_LOOKUP_UNCONFIRMED');
 return data.email_disabled===false&&['free_signup','subscribed'].includes(String(data.membership_state))?'present':'blocked';
}
export function createSubscriberClient({origin,cookie,transport=fetch}){
 origin=publicationOrigin(origin);
 if(typeof cookie!=='string'||!cookie||cookie.length>20000||/[\r\n]/.test(cookie))throw Error('SUBSTACK_SESSION_INVALID');
 async function request(path,body,publicSource){
  const r=await transport(`${origin}/api/v1/${path}`,{method:body===undefined?'GET':'POST',redirect:'manual',signal:AbortSignal.timeout(5000),headers:{...(publicSource?{}:{Cookie:cookie}),Accept:'application/json','User-Agent':'SubstackPublisher/0.3.0',Origin:publicSource?new URL(publicSource).origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(r.status===404)return {status:404,data:null};
  if(r.status!==200){
   const error=Error('SUBSTACK_HTTP_'+r.status);
   const retry=r.headers.get('Retry-After');
   const ms=retry?(Number.isFinite(Number(retry))?Number(retry)*1000:Date.parse(retry)-Date.now()):0;
   error.retryAfterMs=Number.isFinite(ms)?Math.max(0,ms):0;
   const body=await r.text();
   let errorType='other';try{const parsed=JSON.parse(body);if(parsed?.type==='reauthentication_required')errorType='reauthentication_required';}catch{}
   error.providerResponse={errorType,status:r.status,contentType:r.headers.get('content-type')?.includes('json')?'json':r.headers.get('content-type')?.includes('html')?'html':'other',challenge:r.headers.get('cf-mitigated')==='challenge',cloudflareRateLimit:/error[ \n]*1015|you are being rate limited/i.test(body),retryAfterMs:error.retryAfterMs,reasonTags:['csrf','origin','session','permission','captcha','forbidden','cloudflare','user-agent'].filter(tag=>body.toLowerCase().includes(tag))};
   throw error;
  }
  const raw=await r.text();if(raw.length>65536)throw Error('SUBSTACK_RESPONSE_INVALID');
  try{return {status:r.status,data:JSON.parse(raw)};}catch{throw Error('SUBSTACK_RESPONSE_INVALID');}
 }
 function validEmail(email){if(typeof email!=='string'||email.length>254||!/^\S+@\S+\.\S+$/.test(email))throw Error('SUBSTACK_EMAIL_INVALID');return email.trim().toLowerCase();}
 return {
  async lookup(email){email=validEmail(email);const r=await request(`subscriber/${encodeURIComponent(email)}`);return subscriberState(r.status,r.data,email);},
  async subscribe(email,{consentConfirmed=false,sourceUrl}={}){
   if(consentConfirmed!==true)throw Error('SUBSTACK_CONSENT_REQUIRED');
   const source=new URL(sourceUrl);if(source.protocol!=='https:'||source.username||source.password)throw Error('SUBSTACK_SOURCE_INVALID');
   email=validEmail(email);
   const {data}=await request('free',{email,source:'embed',first_url:source.href,current_url:source.href},source.href);
   if(!data||typeof data.email!=='string'||data.email.toLowerCase()!==email||typeof data.requires_confirmation!=='boolean')throw Error('SUBSTACK_SIGNUP_UNCONFIRMED');
   return {state:data.requires_confirmation?'confirmation_required':'accepted'};
  },
  async inspectReadAccess(email){
   email=validEmail(email);
   try{await request('subscriber-stats',{filters:{user_email_address_string_is:email},limit:1,offset:0});return {status:200};}
   catch(error){return error.providerResponse??{status:0};}
  },
  async defaultsMatch(expected){
   if(!Array.isArray(expected)||!expected.length||expected.some(s=>!Number.isSafeInteger(s.id)||typeof s.enabled!=='boolean')||new Set(expected.map(s=>s.id)).size!==expected.length)throw Error('SUBSTACK_DEFAULTS_REQUIRED');
   const {data}=await request('publication/sections');
   return Array.isArray(data)&&expected.every(e=>data.some(s=>s.id===e.id&&s.is_default_on===e.enabled))&&!data.some(s=>s.is_default_on===true&&!expected.some(e=>e.id===s.id&&e.enabled));
  },
  async add(email,{consentConfirmed=false,sendWelcome=false}={}){
   if(consentConfirmed!==true||typeof sendWelcome!=='boolean')throw Error('SUBSTACK_CONSENT_REQUIRED');
   email=validEmail(email);
   // Call only after lookup, default checks, and a durable attempted-write reservation.
   await request('subscriber/add',{email,subscription:false,sendEmail:sendWelcome});
   return {state:'accepted'};
  }
 };
}

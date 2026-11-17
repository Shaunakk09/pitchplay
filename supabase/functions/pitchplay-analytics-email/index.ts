/**
 * Transactional login alerts and daily founder digests.
 * Deploy with Supabase JWT verification enabled.
 * Required secrets: RESEND_API_KEY, PITCHPLAY_EMAIL_FROM (verified sender).
 * The Supabase runtime supplies SUPABASE_URL, SUPABASE_ANON_KEY and SERVICE_ROLE_KEY.
 */
const recipients = ['shaunakahluwalia@gmail.com','adimasbagusdp@gmail.com'];
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json = (data:unknown,status=200) => new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json'}});
const safe = (value:unknown) => typeof value==='string'?value.replace(/[\r\n<>]/g,'').slice(0,200):'';
const uuid = (s:unknown) => typeof s==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const sbUrl = Deno.env.get('SUPABASE_URL') || '';
const publicKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const apiHeaders = {'apikey':serviceKey,'Authorization':`Bearer ${serviceKey}`,'Content-Type':'application/json'};
const rest = (path:string,init:RequestInit={})=>fetch(`${sbUrl}/rest/v1/${path}`,{...init,headers:{...apiHeaders,...(init.headers || {})}});

async function deliver(subject:string,text:string) {
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('PITCHPLAY_EMAIL_FROM');
  if (!key || !from) throw Error('Email provider is not configured (verified sender and API key required).');
  const r=await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify({from,to:recipients,subject,text}),
  });
  if(!r.ok) throw Error(`Email provider rejected request (${r.status}): ${(await r.text()).slice(0,240)}`);
}

async function recordLogin(token:string,notificationId:string) {
  const auth=await fetch(`${sbUrl}/auth/v1/user`,{headers:{'apikey':publicKey,'Authorization':`Bearer ${token}`}});
  if(!auth.ok) return json({error:'Invalid session'},401);
  const user=await auth.json() as {id?:string;email?:string};
  if(!uuid(user.id)) return json({error:'Invalid identity'},401);

  // Every sign-in request receives its own id. A replay of one request is idempotent.
  const reserved=await rest('pitchplay_login_email_receipts',{
    method:'POST',headers:{'Prefer':'return=representation'},
    body:JSON.stringify({session_id:notificationId,user_id:user.id}),
  });
  if(reserved.status===409) return json({status:'already_recorded'});
  if(!reserved.ok) return json({error:'Could not reserve login alert'},500);
  try {
    const time=new Date().toLocaleString('en-SG',{timeZone:'Asia/Singapore',dateStyle:'full',timeStyle:'long'});
    await deliver('PitchPlay — successful account sign-in',`PitchPlay account signed in.\n\nAccount: ${safe(user.email)||'Email unavailable'}\nTime (Singapore): ${time}\n\nThis is an automated security/operations notification. No playbook content is included.`);
    await rest(`pitchplay_login_email_receipts?session_id=eq.${notificationId}`,{method:'PATCH',body:JSON.stringify({sent_at:new Date().toISOString()})});
    return json({status:'sent'});
  }catch(e){
    await rest(`pitchplay_login_email_receipts?session_id=eq.${notificationId}`,{method:'DELETE'});
    return json({error:e instanceof Error?e.message:'Unable to send email'},503);
  }
}

type Metrics={events:number;visitors:number;sessions:number;page_views:number;logins:number;signups:number;boards_created:number;boards_edited:number;exports:number;discover_views:number};
type Daily={day:string;events:number;visitors:number;sessions:number;page_views:number;logins:number;signups:number;boards_created:number;boards_edited:number;exports:number;discover_views:number};
async function sendDailyDigest() {
  // Only the service role may invoke this action. Configure a scheduled call with
  // its bearer token in Supabase Vault (never ship it to the browser).
  const reportResponse=await rest('rpc/pitchplay_admin_analytics',{method:'POST',body:'{}'});
  if(!reportResponse.ok) return json({error:'Could not generate report'},500);
  const report=await reportResponse.json() as {totals:{week:Metrics;month:Metrics;all:Metrics};daily:Daily[]};
  const dateParts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const pick=(part:string)=>dateParts.find(x=>x.type===part)?.value||'';
  const sgToday=`${pick('year')}-${pick('month')}-${pick('day')}`;
  const yesterday=new Date(Date.parse(`${sgToday}T00:00:00Z`)-86400000).toISOString().slice(0,10);
  const day=report.daily.find(x=>x.day===yesterday);
  if(!day) return json({error:'No daily metrics available'},500);
  const reserved=await rest('pitchplay_analytics_digest_receipts',{
    method:'POST',headers:{'Prefer':'return=representation'},body:JSON.stringify({day_sgt:yesterday}),
  });
  if(reserved.status===409) return json({status:'already_sent',day:yesterday});
  if(!reserved.ok) return json({error:'Could not reserve digest'},500);
  const line=(name:string,m:Metrics|Daily)=>`${name.padEnd(15)} ${String(m.visitors).padStart(7)}  ${String(m.sessions).padStart(8)}  ${String(m.logins).padStart(6)}  ${String(m.boards_created).padStart(6)}  ${String(m.exports).padStart(7)}`;
  try{
    await deliver(`PitchPlay daily growth report — ${yesterday} SGT`,[
      `PitchPlay product analytics · ${yesterday} (Singapore time)`,
      '',
      'Period          Visitors  Sessions  Logins  Boards  Exports',
      line('Yesterday',day),line('Last 7 days',report.totals.week),line('Last 30 days',report.totals.month),line('All time',report.totals.all),
      '',`Yesterday: ${day.events} events, ${day.page_views} page views, ${day.boards_edited} edits, ${day.signups} registrations, ${day.discover_views} Discover visits.`,
      '',`Dashboard: https://pitchplay-xi.vercel.app/#analytics`,
      'Visitors are unique per period. Only visits since tracking was enabled are counted; opted-out visits are excluded.',
    ].join('\n'));
    await rest(`pitchplay_analytics_digest_receipts?day_sgt=eq.${yesterday}`,{method:'PATCH',body:JSON.stringify({sent_at:new Date().toISOString()})});
    return json({status:'sent',day:yesterday});
  }catch(e){
    await rest(`pitchplay_analytics_digest_receipts?day_sgt=eq.${yesterday}`,{method:'DELETE'});
    return json({error:e instanceof Error?e.message:'Unable to send digest'},503);
  }
}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  if(req.method!=='POST') return json({error:'Method not allowed'},405);
  const bearer=req.headers.get('Authorization')?.replace(/^Bearer\s+/i,'')||'';
  if(!bearer) return json({error:'Authentication required'},401);
  let body:{action?:string;notification_id?:string};
  try{body=await req.json();}catch{return json({error:'Invalid JSON'},400);}
  if(body.action==='daily_digest') {
    if(bearer!==serviceKey || !serviceKey) return json({error:'Service access required'},403);
    return sendDailyDigest();
  }
  if(body.action==='login' && uuid(body.notification_id)) return recordLogin(bearer,body.notification_id!);
  return json({error:'Unknown action'},400);
});

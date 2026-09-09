export const LOG_V42_REVISION='talksys-log-v42-r2-private';

function clean(v,max=12000){return String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').slice(0,max);}
function safeId(v){return clean(v,120).replace(/[^A-Za-z0-9._-]/g,'-').replace(/-+/g,'-')||'unknown-session';}
function compactHistory(history){return Array.isArray(history)?history.slice(-20).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:clean(x?.content,2500)})).filter(x=>x.content):[];}
function compactPlan(plan){if(!plan||typeof plan!=='object')return null;return {search:Boolean(plan.search),topic:clean(plan.topic,220),resolvedQuestion:clean(plan.resolvedQuestion,1800),searchInstruction:clean(plan.searchInstruction,2600),ack:clean(plan.ack,300),planner:clean(plan.planner,160),plannerMs:Number(plan.plannerMs)||0};}
function compactSources(sources){return Array.isArray(sources)?sources.slice(0,20).map(x=>({title:clean(x?.title,300),url:clean(x?.url,1000)})):[];}
function compactResult(result){
  if(!result||typeof result!=='object')return result;
  return {
    ok:Boolean(result.ok),answer:clean(result.answer,8000),text:clean(result.text,4000),error:clean(result.error,1800),route:clean(result.route,180),planner:clean(result.planner,180),search:Boolean(result.search),searchUseful:Boolean(result.searchUseful),resolvedQuestion:clean(result.resolvedQuestion,1800),queries:Array.isArray(result.queries)?result.queries.slice(0,30).map(x=>clean(x,900)):[],sources:compactSources(result.sources),searchPasses:Number(result.searchPasses)||0,concreteShoppingEvidence:Boolean(result.concreteShoppingEvidence),androidFreshnessRequired:Boolean(result.androidFreshnessRequired),androidRequirementEvidence:Boolean(result.androidRequirementEvidence),verifiedCandidates:Array.isArray(result.verifiedCandidates)?result.verifiedCandidates.slice(0,8).map(x=>({model:clean(x?.model,160),priceSource:{title:clean(x?.priceSource?.title,260),url:clean(x?.priceSource?.url,900)},osSource:{title:clean(x?.osSource?.title,260),url:clean(x?.osSource?.url,900)}})):[],timings:result.timings&&typeof result.timings==='object'?result.timings:null,model:clean(result.model,180),languageMode:clean(result.languageMode,80),safetyClass:clean(result.safetyClass,100)
  };
}
function jstIso(date){const p=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date).replace(' ','T');return p+'+09:00';}
function keyFor(sessionId,event,date,id){const y=String(date.getUTCFullYear()),m=String(date.getUTCMonth()+1).padStart(2,'0'),d=String(date.getUTCDate()).padStart(2,'0');return `${y}/${m}/${d}/${safeId(sessionId)}/${date.toISOString().replace(/[:.]/g,'-')}-${safeId(event)}-${safeId(id)}.json`;}

export function sessionIdFrom(request,body={}){return safeId(body?.sessionId||request?.headers?.get?.('x-talksys-session')||request?.headers?.get?.('x-request-id')||'unknown-session');}

export function buildLogRecord({request,body,result,event,status,revision,extra={}}={}){
  const now=new Date(),sessionId=sessionIdFrom(request,body),id=globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2);
  return {
    key:keyFor(sessionId,event||'event',now,id),
    value:{schema:'talksys-conversation-log-v42',logRevision:LOG_V42_REVISION,revision:clean(revision,160),id,sessionId,event:clean(event,120),timestamp:now.toISOString(),jst:jstIso(now),method:clean(request?.method,20),path:(()=>{try{return new URL(request?.url||'https://local/').pathname;}catch{return '';}})(),status:Number(status)||0,userText:clean(body?.text,5000),audioBytes:Number(extra?.audioBytes)||0,history:compactHistory(body?.history),searchPlan:compactPlan(body?.searchPlan),result:compactResult(result),...extra}
  };
}

export async function persistTalkLog(env,input){
  const record=buildLogRecord(input);
  try{
    if(env?.TALKSYS_LOGS?.put){await env.TALKSYS_LOGS.put(record.key,JSON.stringify(record.value),{httpMetadata:{contentType:'application/json'}});}
    console.log(JSON.stringify({type:'talksys_log',sessionId:record.value.sessionId,event:record.value.event,status:record.value.status,route:record.value.result?.route||'',search:record.value.result?.search||false,error:record.value.result?.error||''}));
    return true;
  }catch(error){console.error(JSON.stringify({type:'talksys_log_error',event:record.value.event,message:clean(error?.message||error,600)}));return false;}
}

export const __test={safeId,compactHistory,compactPlan,compactResult,keyFor,buildLogRecord};

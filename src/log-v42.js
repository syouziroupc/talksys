export const LOG_V42_REVISION='talksys-log-v97-archive-rollover';
let conversationLogSchemaPromise;

function clean(v,max=12000){return String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').slice(0,max);}
function safeId(v){return clean(v,120).replace(/[^A-Za-z0-9._-]/g,'-').replace(/-+/g,'-')||'unknown-session';}
function compactHistory(history){return Array.isArray(history)?history.slice(-20).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:clean(x?.content,2500)})).filter(x=>x.content):[];}
function compactPlan(plan){if(!plan||typeof plan!=='object')return null;return {search:Boolean(plan.search),topic:clean(plan.topic,220),resolvedQuestion:clean(plan.resolvedQuestion,1800),searchInstruction:clean(plan.searchInstruction,2600),ack:clean(plan.ack,300),planner:clean(plan.planner,160),plannerMs:Number(plan.plannerMs)||0};}
function compactSources(sources){return Array.isArray(sources)?sources.slice(0,20).map(x=>({title:clean(x?.title,300),url:clean(x?.url,1000)})):[];}
function compactResult(result){
  if(!result||typeof result!=='object')return result;
  return {
    ok:Boolean(result.ok),answer:clean(result.answer,8000),text:clean(result.text,4000),error:clean(result.error,1800),route:clean(result.route,180),planner:clean(result.planner,180),search:Boolean(result.search),searchUseful:Boolean(result.searchUseful),resolvedQuestion:clean(result.resolvedQuestion,1800),queries:Array.isArray(result.queries)?result.queries.slice(0,30).map(x=>clean(x,900)):[],sources:compactSources(result.sources),searchPasses:Number(result.searchPasses)||0,concreteShoppingEvidence:Boolean(result.concreteShoppingEvidence),androidFreshnessRequired:Boolean(result.androidFreshnessRequired),androidRequirementEvidence:Boolean(result.androidRequirementEvidence),verifiedCandidates:Array.isArray(result.verifiedCandidates)?result.verifiedCandidates.slice(0,8).map(x=>({model:clean(x?.model,160),priceSource:{title:clean(x?.priceSource?.title,260),url:clean(x?.priceSource?.url,900)},osSource:{title:clean(x?.osSource?.title,260),url:clean(x?.osSource?.url,900)}})):[],timings:result.timings&&typeof result.timings==='object'?result.timings:null,timeline:result.timeline&&typeof result.timeline==='object'?result.timeline:null,realtimeTranscript:clean(result.realtimeTranscript,4000),confirmedTranscript:clean(result.confirmedTranscript,4000),rawTranscript:clean(result.rawTranscript,4000),correctedTranscript:clean(result.correctedTranscript,4000),correctionReason:clean(result.correctionReason,1200),bargeInTriggerMs:Number(result.bargeInTriggerMs)||0,geminiInputText:clean(result.geminiInputText,4000),transcriptMatch:typeof result.transcriptMatch==='boolean'?result.transcriptMatch:null,model:clean(result.model,180),languageMode:clean(result.languageMode,80),safetyClass:clean(result.safetyClass,100)
  };
}
function jstIso(date){const p=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date).replace(' ','T');return p+'+09:00';}
function keyFor(sessionId,event,date,id){const y=String(date.getUTCFullYear()),m=String(date.getUTCMonth()+1).padStart(2,'0'),d=String(date.getUTCDate()).padStart(2,'0');return `${y}/${m}/${d}/${safeId(sessionId)}/${date.toISOString().replace(/[:.]/g,'-')}-${safeId(event)}-${safeId(id)}.json`;}

async function ensureConversationLogSchema(env){
  if(!env?.TALKSYS_LOG_DB?.prepare)return false;
  if(!conversationLogSchemaPromise){
    conversationLogSchemaPromise=(async()=>{
      await env.TALKSYS_LOG_DB.prepare(`CREATE TABLE IF NOT EXISTS conversation_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        jst TEXT NOT NULL,
        revision TEXT,
        path TEXT,
        status INTEGER,
        user_text TEXT,
        history_json TEXT,
        search_plan_json TEXT,
        result_json TEXT,
        audio_bytes INTEGER NOT NULL DEFAULT 0
      )`).run();
      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_conversation_logs_time ON conversation_logs(timestamp DESC)').run();
      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_conversation_logs_session ON conversation_logs(session_id, timestamp)').run();
      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_conversation_logs_event_time ON conversation_logs(event, timestamp DESC)').run();
      await env.TALKSYS_LOG_DB.prepare(`CREATE TABLE IF NOT EXISTS conversation_logs_archive (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        jst TEXT NOT NULL,
        revision TEXT,
        path TEXT,
        status INTEGER,
        user_text TEXT,
        history_json TEXT,
        search_plan_json TEXT,
        result_json TEXT,
        audio_bytes INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT NOT NULL,
        archive_reason TEXT NOT NULL
      )`).run();
      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_conversation_logs_archive_time ON conversation_logs_archive(timestamp DESC)').run();
      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_conversation_logs_archive_session ON conversation_logs_archive(session_id, timestamp)').run();
      return true;
    })().catch((error)=>{
      conversationLogSchemaPromise=undefined;
      console.error(JSON.stringify({type:'talksys_log_schema_error',message:clean(error?.message||error,600)}));
      return false;
    });
  }
  return conversationLogSchemaPromise;
}

export function sessionIdFrom(request,body={}){return safeId(body?.sessionId||request?.headers?.get?.('x-talksys-session')||request?.headers?.get?.('x-request-id')||'unknown-session');}

export function buildLogRecord({request,body,result,event,status,revision,extra={}}={}){
  const now=new Date(),sessionId=sessionIdFrom(request,body),id=globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2);
  return {
    key:keyFor(sessionId,event||'event',now,id),
    value:{schema:'talksys-conversation-log-v42',logRevision:LOG_V42_REVISION,revision:clean(revision,160),id,sessionId,event:clean(event,120),timestamp:now.toISOString(),jst:jstIso(now),method:clean(request?.method,20),path:(()=>{try{return new URL(request?.url||'https://local/').pathname;}catch{return '';}})(),status:Number(status)||0,userText:clean(body?.text,5000),channel:clean(body?.channel||extra?.channel,80),audioBytes:Number(extra?.audioBytes)||0,history:compactHistory(body?.history),searchPlan:compactPlan(body?.searchPlan),result:compactResult(result),...extra}
  };
}

export async function persistTalkLog(env,input){
  const record=buildLogRecord(input),v=record.value;
  try{
    if(!(await ensureConversationLogSchema(env)))throw new Error('TALKSYS_LOG_DB binding missing');
    const storedResult=v.result&&typeof v.result==='object'?{...v.result,channel:v.channel||'',utteranceId:clean(input?.body?.utteranceId,180)}:v.result;
    await env.TALKSYS_LOG_DB.prepare(`INSERT INTO conversation_logs (id,session_id,event,timestamp,jst,revision,path,status,user_text,history_json,search_plan_json,result_json,audio_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(v.id,v.sessionId,v.event,v.timestamp,v.jst,v.revision,v.path,v.status,v.userText,JSON.stringify(v.history||[]),JSON.stringify(v.searchPlan??null),JSON.stringify(storedResult??null),Number(v.audioBytes)||0)
      .run();
    console.log(JSON.stringify({type:'talksys_log',storage:'d1',sessionId:v.sessionId,event:v.event,channel:v.channel||'',status:v.status,route:v.result?.route||'',search:v.result?.search||false,error:v.result?.error||''}));
    return true;
  }catch(error){console.error(JSON.stringify({type:'talksys_log_error',storage:'d1',event:v.event,message:clean(error?.message||error,600)}));return false;}
}

export async function listTalkLogs(env,limit=100,filters={}){
  if(!(await ensureConversationLogSchema(env)))throw new Error('TALKSYS_LOG_DB binding missing');
  const count=Math.max(1,Math.min(500,Number(limit)||100));
  const where=[],binds=[];
  const exactSession=clean(filters?.sessionId,180).trim();
  const sessionPrefix=clean(filters?.sessionPrefix,120).replace(/[^A-Za-z0-9._-]/g,'').trim();
  const event=clean(filters?.event,120).trim();
  const utteranceId=clean(filters?.utteranceId,180).trim();
  const q=clean(filters?.q,500).trim();
  if(exactSession){where.push('session_id = ?');binds.push(exactSession);}
  else if(filters?.latestSessionOnly){
    const headWhere=[],headBinds=[];
    if(sessionPrefix){headWhere.push('session_id LIKE ?');headBinds.push(sessionPrefix+'%');}
    if(event){headWhere.push('event = ?');headBinds.push(event);}
    if(utteranceId){headWhere.push("json_extract(result_json, '$.utteranceId') = ?");headBinds.push(utteranceId);}
    if(q){headWhere.push('user_text LIKE ?');headBinds.push('%'+q+'%');}
    const headSql='SELECT session_id FROM conversation_logs'
      +(headWhere.length?' WHERE '+headWhere.join(' AND '):'')
      +' ORDER BY timestamp DESC LIMIT 1';
    const head=await env.TALKSYS_LOG_DB.prepare(headSql).bind(...headBinds).all();
    const latestSession=clean(head?.results?.[0]?.session_id,180).trim();
    if(!latestSession)return [];
    where.push('session_id = ?');binds.push(latestSession);
  }else if(sessionPrefix){where.push('session_id LIKE ?');binds.push(sessionPrefix+'%');}
  if(event){where.push('event = ?');binds.push(event);}
  if(utteranceId){where.push("json_extract(result_json, '$.utteranceId') = ?");binds.push(utteranceId);}
  if(q){where.push('user_text LIKE ?');binds.push('%'+q+'%');}
  const sql='SELECT id,session_id,event,timestamp,jst,revision,path,status,user_text,result_json FROM conversation_logs'
    +(where.length?' WHERE '+where.join(' AND '):'')
    +' ORDER BY timestamp DESC LIMIT ?';
  const data=await env.TALKSYS_LOG_DB.prepare(sql).bind(...binds,count).all();
  return (data?.results||[]).map((row)=>{
    let result={};try{result=JSON.parse(row.result_json||'{}')||{};}catch{}
    return {
      id:row.id,sessionId:row.session_id,event:row.event,timestamp:row.timestamp,jst:row.jst,revision:row.revision,path:row.path,status:row.status,
      channel:clean(result?.channel,80),utteranceId:clean(result?.utteranceId,180),userText:clean(row.user_text,5000),assistantText:clean(result?.answer||result?.text,9000),error:clean(result?.error,1800),
      route:clean(result?.route,180),search:Boolean(result?.search),timings:result?.timings&&typeof result.timings==='object'?result.timings:null,realtimeTranscript:clean(result?.realtimeTranscript,4000),confirmedTranscript:clean(result?.confirmedTranscript,4000),rawTranscript:clean(result?.rawTranscript,4000),correctedTranscript:clean(result?.correctedTranscript,4000),correctionReason:clean(result?.correctionReason,1200),bargeInTriggerMs:Number(result?.bargeInTriggerMs)||0,geminiInputText:clean(result?.geminiInputText,4000),transcriptMatch:typeof result?.transcriptMatch==='boolean'?result.transcriptMatch:null
    };
  });
}

function mapTalkLogRow(row){
  let result={};try{result=JSON.parse(row.result_json||'{}')||{};}catch{}
  return {
    id:row.id,sessionId:row.session_id,event:row.event,timestamp:row.timestamp,jst:row.jst,revision:row.revision,path:row.path,status:row.status,
    channel:clean(result?.channel,80),utteranceId:clean(result?.utteranceId,180),userText:clean(row.user_text,5000),assistantText:clean(result?.answer||result?.text,9000),error:clean(result?.error,1800),
    route:clean(result?.route,180),search:Boolean(result?.search),timings:result?.timings&&typeof result.timings==='object'?result.timings:null,realtimeTranscript:clean(result?.realtimeTranscript,4000),confirmedTranscript:clean(result?.confirmedTranscript,4000),rawTranscript:clean(result?.rawTranscript,4000),correctedTranscript:clean(result?.correctedTranscript,4000),correctionReason:clean(result?.correctionReason,1200),bargeInTriggerMs:Number(result?.bargeInTriggerMs)||0,geminiInputText:clean(result?.geminiInputText,4000),transcriptMatch:typeof result?.transcriptMatch==='boolean'?result.transcriptMatch:null,
    archivedAt:clean(row.archived_at,80),archiveReason:clean(row.archive_reason,160)
  };
}

export async function listArchivedTalkLogs(env,limit=100,filters={}){
  if(!(await ensureConversationLogSchema(env)))throw new Error('TALKSYS_LOG_DB binding missing');
  const count=Math.max(1,Math.min(500,Number(limit)||100));
  const where=[],binds=[];
  const exactSession=clean(filters?.sessionId,180).trim();
  const sessionPrefix=clean(filters?.sessionPrefix,120).replace(/[^A-Za-z0-9._-]/g,'').trim();
  const event=clean(filters?.event,120).trim();
  const utteranceId=clean(filters?.utteranceId,180).trim();
  const q=clean(filters?.q,500).trim();
  if(exactSession){where.push('session_id = ?');binds.push(exactSession);}
  else if(sessionPrefix){where.push('session_id LIKE ?');binds.push(sessionPrefix+'%');}
  if(event){where.push('event = ?');binds.push(event);}
  if(utteranceId){where.push("json_extract(result_json, '$.utteranceId') = ?");binds.push(utteranceId);}
  if(q){where.push('user_text LIKE ?');binds.push('%'+q+'%');}
  const sql='SELECT id,session_id,event,timestamp,jst,revision,path,status,user_text,result_json,archived_at,archive_reason FROM conversation_logs_archive'
    +(where.length?' WHERE '+where.join(' AND '):'')
    +' ORDER BY timestamp DESC LIMIT ?';
  const data=await env.TALKSYS_LOG_DB.prepare(sql).bind(...binds,count).all();
  return (data?.results||[]).map(mapTalkLogRow);
}

export async function archiveTalkLogs(env,{keepRevision='',reason='revision-rollover'}={}){
  if(!(await ensureConversationLogSchema(env)))throw new Error('TALKSYS_LOG_DB binding missing');
  const revision=clean(keepRevision,160).trim();
  if(!revision)throw new Error('keepRevision required');
  const archiveReason=clean(reason,160)||'revision-rollover';
  const archivedAt=new Date().toISOString();
  const countRow=await env.TALKSYS_LOG_DB.prepare("SELECT COUNT(*) AS count FROM conversation_logs WHERE COALESCE(revision,'') <> ?").bind(revision).first();
  const count=Math.max(0,Number(countRow?.count)||0);
  if(!count)return {ok:true,archived:0,keepRevision:revision};
  await env.TALKSYS_LOG_DB.batch([
    env.TALKSYS_LOG_DB.prepare(`INSERT OR IGNORE INTO conversation_logs_archive
      (id,session_id,event,timestamp,jst,revision,path,status,user_text,history_json,search_plan_json,result_json,audio_bytes,archived_at,archive_reason)
      SELECT id,session_id,event,timestamp,jst,revision,path,status,user_text,history_json,search_plan_json,result_json,audio_bytes,?,?
      FROM conversation_logs WHERE COALESCE(revision,'') <> ?`).bind(archivedAt,archiveReason,revision),
    env.TALKSYS_LOG_DB.prepare("DELETE FROM conversation_logs WHERE COALESCE(revision,'') <> ?").bind(revision),
  ]);
  return {ok:true,archived:count,keepRevision:revision,archivedAt,reason:archiveReason};
}

export function collapseTalkLogs(logs=[]){
  const groups=new Map();
  for(const row of Array.isArray(logs)?logs:[]){
    const utteranceId=clean(row?.utteranceId,180);
    const key=utteranceId?clean(row?.sessionId,180)+':'+utteranceId:'row:'+clean(row?.id,180);
    let merged=groups.get(key);
    if(!merged){
      merged={...row,events:[],sourceIds:[]};
      groups.set(key,merged);
    }
    if(row?.event&&!merged.events.includes(row.event))merged.events.push(row.event);
    if(row?.id)merged.sourceIds.push(row.id);
    if(!merged.userText&&row?.userText)merged.userText=row.userText;
    if(!merged.assistantText&&row?.assistantText)merged.assistantText=row.assistantText;
    if(!merged.error&&row?.error)merged.error=row.error;
    if(!merged.route&&row?.route)merged.route=row.route;
    if(!merged.timings&&row?.timings)merged.timings=row.timings;
    for(const field of ['realtimeTranscript','confirmedTranscript','rawTranscript','correctedTranscript','correctionReason','geminiInputText']){
      if(!merged[field]&&row?.[field])merged[field]=row[field];
    }
    if(!merged.bargeInTriggerMs&&row?.bargeInTriggerMs)merged.bargeInTriggerMs=row.bargeInTriggerMs;
    if(merged.transcriptMatch===null&&typeof row?.transcriptMatch==='boolean')merged.transcriptMatch=row.transcriptMatch;
  }
  return [...groups.values()];
}

export const __test={safeId,compactHistory,compactPlan,compactResult,keyFor,buildLogRecord,collapseTalkLogs,mapTalkLogRow};

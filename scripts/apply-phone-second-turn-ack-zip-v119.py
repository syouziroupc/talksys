from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


path = Path('src/telephony/index.js')
s = path.read_text(encoding='utf-8')

s = replace_once(
    s,
    "export const PHONE_FAST_ACK_REVISION = 'talksys-phone-fast-ack-v2-r1';\n",
    "export const PHONE_FAST_ACK_REVISION = 'talksys-phone-fast-ack-v2-r1';\nexport const PHONE_ACK_LATENCY_REVISION = 'talksys-phone-ack-latency-v119-r1';\nconst PHONE_ACK_STT_GRACE_MS = 250;\n",
    'v119 ack revision',
)

anchor = "const PHONE_ACK_PRIMARY_TEXTS = Object.freeze(Object.values(PHONE_ACK_VARIANTS).map((variants) => variants[0]));\n"
insert = anchor + "const PHONE_SLOW_STT_ACK_TEXTS = Object.freeze([\n  FAST_ACK_TEXT,\n  PHONE_ACK_VARIANTS.request[0],\n  PHONE_ACK_VARIANTS.question[0],\n  PHONE_ACK_VARIANTS.listening[0],\n]);\n"
s = replace_once(s, anchor, insert, 'slow STT ack pool')

select_end = """  return {
    kind: String(reaction?.kind || 'none'),
    text: selected,
    warmText,
    fallbackUsed: Boolean(selected === FAST_ACK_TEXT && variants[0] !== FAST_ACK_TEXT),
  };
}

"""
select_insert = select_end + """function selectPreparedSlowSttAck(cachedTexts = [], recentTexts = []) {
  const cached = new Set(Array.from(cachedTexts || []).map((value) => String(value || '')).filter(Boolean));
  const recent = new Set(Array.from(recentTexts || []).slice(-2).map((value) => String(value || '')).filter(Boolean));
  return PHONE_SLOW_STT_ACK_TEXTS.find((text) => cached.has(text) && !recent.has(text))
    || PHONE_SLOW_STT_ACK_TEXTS.find((text) => cached.has(text))
    || '';
}

"""
s = replace_once(s, select_end, select_insert, 'slow STT ack selector')

old_stt = """    pendingSttCount+=1;
    const task=(async()=>{
      const sttStartedAt=Date.now();queueLatency(turnId,'stt_start',sttStartedAt-speechEndAt,{samples:samples.length,audioMs:Math.round(samples.length/8)});let stt;
      try{stt=await transcribeSamples(env,samples);}catch(error){queueLatency(turnId,'stt_rejected',Date.now()-speechEndAt,{stageMs:Date.now()-sttStartedAt,error:clean(error?.message||error,240)});console.error(JSON.stringify({type:'phone_stt_error',turnId,error:clean(error?.message||error,240)}));return;}finally{pendingSttCount=Math.max(0,pendingSttCount-1);}
"""
new_stt = """    pendingSttCount+=1;
    const sttStartedAt=Date.now();queueLatency(turnId,'stt_start',sttStartedAt-speechEndAt,{samples:samples.length,audioMs:Math.round(samples.length/8)});
    let sttSettled=false,slowAckStarted=false,slowAckText='',slowAckAudio=null,slowAckPromise=Promise.resolve(false);
    const sttPromise=transcribeSamples(env,samples);
    const slowAckTimer=setTimeout(()=>{
      if(sttSettled||closed)return;
      const selected=selectPreparedSlowSttAck(phoneAckAudioCache.keys(),recentAckTexts);
      const prepared=selected?(selected===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(selected)):null;
      if(!selected||!prepared?.bytes?.byteLength){queueLatency(turnId,'ack_slow_stt_unprepared',Date.now()-speechEndAt,{revision:PHONE_ACK_LATENCY_REVISION,graceMs:PHONE_ACK_STT_GRACE_MS});return;}
      slowAckStarted=true;slowAckText=selected;slowAckAudio=prepared;
      queueLatency(turnId,'ack_slow_stt_fallback',Date.now()-speechEndAt,{revision:PHONE_ACK_LATENCY_REVISION,graceMs:PHONE_ACK_STT_GRACE_MS,text:selected,bytes:prepared.bytes.byteLength});
      slowAckPromise=speak(selected,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:prepared}).then((reacted)=>{if(reacted){recentAckTexts=[...recentAckTexts,selected].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'slow-stt-receipt',text:selected,cached:true,revision:PHONE_ACK_LATENCY_REVISION}));}return reacted;});
      trackTask(slowAckPromise.catch((error)=>{console.warn(JSON.stringify({type:'phone_slow_stt_ack_error',turnId,error:clean(error?.message||error,240)}));return false;}));
    },PHONE_ACK_STT_GRACE_MS);
    const task=(async()=>{
      let stt;
      try{stt=await sttPromise;}catch(error){queueLatency(turnId,'stt_rejected',Date.now()-speechEndAt,{stageMs:Date.now()-sttStartedAt,error:clean(error?.message||error,240)});console.error(JSON.stringify({type:'phone_stt_error',turnId,error:clean(error?.message||error,240)}));return;}finally{sttSettled=true;clearTimeout(slowAckTimer);pendingSttCount=Math.max(0,pendingSttCount-1);}
"""
s = replace_once(s, old_stt, new_stt, 'parallel STT and bounded acknowledgement')

s = replace_once(
    s,
    "latestAcceptedCapture=myCapture;lastAcceptedUserText=stt.text;lastAcceptedUserAt=now;const myVersion=++turnVersion;abortActiveTurn();interruptPlayback();",
    "latestAcceptedCapture=myCapture;lastAcceptedUserText=stt.text;lastAcceptedUserAt=now;const myVersion=++turnVersion;abortActiveTurn();if(!slowAckStarted)interruptPlayback();",
    'preserve current slow-STT acknowledgement',
)

old_ack = """        const reaction=fastReaction(stt.text);
        const ackSelection=selectPhoneAckText(reaction,phoneAckAudioCache.keys(),recentAckTexts);
        const ackText=ackSelection.text||'';
        const ackAudio=ackText?(ackText===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(ackText)):null;
        const ackPrepared=Boolean(ackAudio?.bytes?.byteLength);
        const spokenBackchannel=ackPrepared?ackText:'';
"""
new_ack = """        const reaction=fastReaction(stt.text);
        const ackSelection=selectPhoneAckText(reaction,phoneAckAudioCache.keys(),recentAckTexts);
        const categoryAckText=ackSelection.text||'';
        const categoryAckAudio=categoryAckText?(categoryAckText===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(categoryAckText)):null;
        const ackText=slowAckStarted?slowAckText:categoryAckText;
        const ackAudio=slowAckStarted?slowAckAudio:categoryAckAudio;
        const ackPrepared=Boolean(ackAudio?.bytes?.byteLength);
        const spokenBackchannel=ackPrepared?ackText:'';
"""
s = replace_once(s, old_ack, new_ack, 'ack state after STT')

old_play = """        if(ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:ackText,bytes:ackAudio.bytes.byteLength,reactionKind:reaction.kind||'none',fallback:ackSelection.fallbackUsed});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:reaction.kind,text:ackText,cached:true,fallback:ackSelection.fallbackUsed}));}}
        else queueLatency(turnId,'ack_cache_miss',Date.now()-speechEndAt,{text:ackText||FAST_ACK_TEXT,reactionKind:reaction.kind||'none'});
"""
new_play = """        if(slowAckStarted){queueLatency(turnId,'ack_already_started',Date.now()-speechEndAt,{text:ackText,revision:PHONE_ACK_LATENCY_REVISION,reactionKind:reaction.kind||'none'});}
        else if(ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:ackText,bytes:ackAudio.bytes.byteLength,reactionKind:reaction.kind||'none',fallback:ackSelection.fallbackUsed});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:reaction.kind,text:ackText,cached:true,fallback:ackSelection.fallbackUsed}));}}
        else queueLatency(turnId,'ack_cache_miss',Date.now()-speechEndAt,{text:ackText||FAST_ACK_TEXT,reactionKind:reaction.kind||'none'});
"""
s = replace_once(s, old_play, new_play, 'avoid duplicate acknowledgement')

old_api = "async function api(path){const r=await fetch(path,{headers:auth(),cache:'no-store'});if(r.status===401)throw new Error('認証に失敗しました');return r.json()}"
new_api = "async function api(path,options={}){const r=await fetch(path,{...options,headers:{...auth(),...(options.headers||{})},cache:'no-store'});const d=await r.json().catch(()=>({}));if(r.status===401){const e=new Error('認証に失敗しました');e.status=401;throw e}if(!r.ok||d.ok===false){const e=new Error(d.error||('HTTP '+r.status));e.status=r.status;throw e}return d}"
s = replace_once(s, old_api, new_api, 'admin API options and errors')

old_zip = """async function recentCallsZip(request, env) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('limit') || 20);
  const limit = Math.max(1, Math.min(50, Number.isFinite(requested) ? Math.round(requested) : 20));
  const result = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_calls ORDER BY updated_at DESC LIMIT ?').bind(limit).all();
  const calls = result.results || [];
  if (!calls.length) return json({ ok: false, error: 'no_calls' }, 404);
  const files = [];
  for (const call of calls) {
    const safeId = String(call.call_id || 'call').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'call';
    files.push({ name: `talksys-call-${safeId}.jsonl`, content: await callJsonlContent(env, call) });
  }
  const archive = zipStoreFiles(files);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return new Response(archive, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename=\"talksys-calls-latest-${calls.length}-${stamp}.zip\"`,
      'cache-control': 'no-store',
      'x-talksys-export-count': String(calls.length),
    },
  });
}
"""
new_zip = """async function recentCallsZip(request, env) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('limit') || 20);
  const limit = Math.max(1, Math.min(50, Number.isFinite(requested) ? Math.round(requested) : 20));
  const result = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_calls ORDER BY updated_at DESC LIMIT ?').bind(limit).all();
  const calls = result.results || [];
  if (!calls.length) return json({ ok: false, error: 'no_calls' }, 404);
  const callIds = calls.map((call) => String(call.call_id || '')).filter(Boolean);
  const placeholders = callIds.map(() => '?').join(',');
  const [messageRows, latencyRows] = await env.TALKSYS_LOG_DB.batch([
    env.TALKSYS_LOG_DB.prepare(`SELECT call_id, role, content, created_at FROM phone_messages WHERE call_id IN (${placeholders}) ORDER BY call_id, id ASC`).bind(...callIds),
    env.TALKSYS_LOG_DB.prepare(`SELECT call_id, turn_id, stage, elapsed_ms, detail, created_at FROM phone_latency_events WHERE call_id IN (${placeholders}) ORDER BY call_id, id ASC`).bind(...callIds),
  ]);
  const messagesByCall = new Map(), latencyByCall = new Map();
  for (const row of messageRows.results || []) { const list = messagesByCall.get(row.call_id) || []; list.push(row); messagesByCall.set(row.call_id, list); }
  for (const row of latencyRows.results || []) { const list = latencyByCall.get(row.call_id) || []; list.push(row); latencyByCall.set(row.call_id, list); }
  const files = calls.map((call) => {
    const callId = String(call.call_id || '');
    const safeId = String(callId || 'call').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'call';
    const lines = [JSON.stringify({ type: 'call', call })];
    for (const message of messagesByCall.get(callId) || []) lines.push(JSON.stringify({ type: 'message', role: message.role, content: message.content, created_at: message.created_at }));
    for (const event of latencyByCall.get(callId) || []) lines.push(JSON.stringify({ type: 'latency', turn_id: event.turn_id, stage: event.stage, elapsed_ms: Number(event.elapsed_ms || 0), detail: parsedLatencyDetail(event.detail), created_at: event.created_at }));
    return { name: `talksys-call-${safeId}.jsonl`, content: `${lines.join('\\n')}\\n` };
  });
  const archive = zipStoreFiles(files);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return new Response(archive, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename=\"talksys-calls-latest-${calls.length}-${stamp}.zip\"`,
      'cache-control': 'no-store',
      'x-talksys-export-count': String(calls.length),
      'x-talksys-export-bytes': String(archive.byteLength),
    },
  });
}
"""
s = replace_once(s, old_zip, new_zip, 'batch ZIP N+1 removal')

old_download = "async function downloadBatchExport(){const n=Math.max(1,Math.min(50,Number(document.getElementById('batchCount')?.value||20)||20));const r=await fetch('/phone/api/calls/export.zip?limit='+encodeURIComponent(n),{headers:auth(),cache:'no-store'});if(r.status===401)throw new Error('認証に失敗しました');if(!r.ok)throw new Error('ZIPの取得に失敗しました');const blob=await r.blob();const href=URL.createObjectURL(blob);const a=document.createElement('a');a.href=href;a.download='talksys-calls-latest-'+n+'.zip';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),1000)}"
new_download = "async function downloadBatchExport(){const button=document.getElementById('batchExportBtn');const original=button.textContent;button.disabled=true;button.textContent='ZIP作成中...';try{const n=Math.max(1,Math.min(50,Number(document.getElementById('batchCount')?.value||20)||20));const r=await fetch('/phone/api/calls/export.zip?limit='+encodeURIComponent(n),{headers:auth(),cache:'no-store'});if(r.status===401)throw new Error('認証に失敗しました');if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error('ZIP取得失敗: '+(e.error||('HTTP '+r.status)))}const buffer=await r.arrayBuffer();const bytes=new Uint8Array(buffer);if(bytes.byteLength<22||bytes[0]!==0x50||bytes[1]!==0x4b)throw new Error('ZIP応答が破損しています');const disposition=r.headers.get('content-disposition')||'';const match=disposition.match(/filename=\\\"?([^\\\";]+)\\\"?/i);const filename=match?.[1]||('talksys-calls-latest-'+n+'.zip');const blob=new Blob([bytes],{type:'application/zip'});const href=URL.createObjectURL(blob);const a=document.createElement('a');a.href=href;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),5000)}finally{button.disabled=false;button.textContent=original}}"
s = replace_once(s, old_download, new_download, 'robust ZIP browser download')

path.write_text(s, encoding='utf-8')

Path('tests/phone-second-turn-ack-zip-v119.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('v119 caps slow-STT acknowledgement latency without changing the normal categorized ack path', () => {
  assert.match(source, /PHONE_ACK_LATENCY_REVISION = 'talksys-phone-ack-latency-v119-r1'/);
  assert.match(source, /const PHONE_ACK_STT_GRACE_MS = 250/);
  assert.match(source, /PHONE_SLOW_STT_ACK_TEXTS/);
  assert.match(source, /const sttPromise=transcribeSamples\(env,samples\)/);
  assert.match(source, /ack_slow_stt_fallback/);
  assert.match(source, /if\(!slowAckStarted\)interruptPlayback\(\)/);
  assert.match(source, /if\(slowAckStarted\)\{queueLatency\(turnId,'ack_already_started'/);
  assert.match(source, /selectPhoneAckText\(reaction,phoneAckAudioCache\.keys\(\),recentAckTexts\)/);
});

test('v119 does not reopen the frozen v118 audio quality settings', () => {
  assert.match(wrangler, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.008"/);
  assert.match(wrangler, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"plain"/);
  assert.match(wrangler, /"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"0\.0"/);
  assert.doesNotMatch(source, /const FAST_ACK_TEXT = 'はい。'/);
});

test('batch ZIP avoids per-call D1 N+1 queries and dashboard supports real PUT options', () => {
  assert.match(source, /TALKSYS_LOG_DB\.batch\(\[/);
  assert.match(source, /WHERE call_id IN \(\$\{placeholders\}\)/);
  const zipStart = source.indexOf('async function recentCallsZip');
  const zipEnd = source.indexOf('async function texmlResponse', zipStart);
  const zipBlock = source.slice(zipStart, zipEnd);
  assert.doesNotMatch(zipBlock, /await callJsonlContent\(env, call\)/);
  assert.match(source, /async function api\(path,options=\{\}\)/);
  assert.match(source, /\.\.\.options,headers:\{\.\.\.auth\(\),\.\.\.\(options\.headers\|\|\{\}\)\}/);
  assert.match(source, /ZIP応答が破損しています/);
});
''', encoding='utf-8')

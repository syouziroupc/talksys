from pathlib import Path

p = Path('src/telephony/index.js')
s = p.read_text()

def rep(old, new, label):
    global s
    if old not in s:
        raise SystemExit(f'missing pattern: {label}')
    s = s.replace(old, new, 1)

rep("export const PHONE_FAST_ACK_REVISION = 'talksys-phone-fast-ack-v2-r1';",
    "export const PHONE_FAST_ACK_REVISION = 'talksys-phone-fast-ack-v117-r1';",
    'revision')

rep("""    pendingSttCount+=1;
    const task=(async()=>{
""", """    pendingSttCount+=1;
    const earlyAckAudio=fastAckAudioCache;
    const earlyAckPromise=(async()=>{
      if(!earlyAckAudio?.bytes?.byteLength){queueLatency(turnId,'ack_cache_miss',Date.now()-speechEndAt,{text:FAST_ACK_TEXT,early:true});return false;}
      queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:FAST_ACK_TEXT,bytes:earlyAckAudio.bytes.byteLength,early:true});
      try{
        const reacted=await speak(FAST_ACK_TEXT,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:earlyAckAudio});
        if(reacted){recentAckTexts=[...recentAckTexts,FAST_ACK_TEXT].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:'pre-stt',text:FAST_ACK_TEXT,cached:true,early:true}));}
        return reacted;
      }catch(error){queueLatency(turnId,'ack_error',Date.now()-speechEndAt,{early:true,error:clean(error?.message||error,240)});return false;}
    })();
    trackTask(earlyAckPromise);
    const task=(async()=>{
""", 'early ack insertion')

rep("latestAcceptedCapture=myCapture;lastAcceptedUserText=stt.text;lastAcceptedUserAt=now;const myVersion=++turnVersion;abortActiveTurn();interruptPlayback();",
    "latestAcceptedCapture=myCapture;lastAcceptedUserText=stt.text;lastAcceptedUserAt=now;const myVersion=++turnVersion;abortActiveTurn();const earlyAckSpoken=await earlyAckPromise;if(!earlyAckSpoken)interruptPlayback();",
    'accepted stt handoff')

rep("""        const reaction=fastReaction(stt.text);
        const ackSelection=selectPhoneAckText(reaction,phoneAckAudioCache.keys(),recentAckTexts);
        const ackText=ackSelection.text||'';
        const ackAudio=ackText?(ackText===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(ackText)):null;
        const ackPrepared=Boolean(ackAudio?.bytes?.byteLength);
        const spokenBackchannel=ackPrepared?ackText:'';
""", """        const reaction=fastReaction(stt.text);
        const ackSelection=selectPhoneAckText(reaction,phoneAckAudioCache.keys(),recentAckTexts);
        const ackText=earlyAckSpoken?FAST_ACK_TEXT:'';
        const ackPrepared=Boolean(earlyAckSpoken);
        const spokenBackchannel=ackText;
""", 'post-stt ack selection')

rep("""        if(ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:ackText,bytes:ackAudio.bytes.byteLength,reactionKind:reaction.kind||'none',fallback:ackSelection.fallbackUsed});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:reaction.kind,text:ackText,cached:true,fallback:ackSelection.fallbackUsed}));}}
        else queueLatency(turnId,'ack_cache_miss',Date.now()-speechEndAt,{text:ackText||FAST_ACK_TEXT,reactionKind:reaction.kind||'none'});
""", "", 'remove post-stt duplicate ack')

# ZIP export reaches the telephony handler.
rep("""  return pathname === '/phone' || pathname === '/telephony-health' || pathname === '/phone/api/calls'
    || /^\\/phone\\/api\\/calls\\/[^/]+\\/messages$/.test(pathname) || /^\\/phone\\/api\\/calls\\/[^/]+\\/latency$/.test(pathname)
""", """  return pathname === '/phone' || pathname === '/telephony-health' || pathname === '/phone/api/calls' || pathname === '/phone/api/calls/export.zip'
    || /^\\/phone\\/api\\/calls\\/[^/]+\\/messages$/.test(pathname) || /^\\/phone\\/api\\/calls\\/[^/]+\\/latency$/.test(pathname)
""", 'ZIP route guard')

# Dedicated profile listing API.
marker = """async function listCalls(request, env) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const result = await env.TALKSYS_LOG_DB.prepare(`SELECT c.*, p.display_name AS profile_display_name, p.enabled AS profile_enabled, p.version AS profile_version FROM phone_calls c LEFT JOIN phone_profiles p ON p.phone_number=c.from_number ORDER BY c.updated_at DESC LIMIT 100`).all();
  return json({ ok: true, calls: result.results || [] });
}
"""
addition = marker + """

async function listPhoneProfiles(request, env) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const result = await env.TALKSYS_LOG_DB.prepare(`WITH callers AS (
      SELECT from_number AS phone_number, MAX(updated_at) AS last_call_at, COUNT(*) AS call_count
      FROM phone_calls WHERE COALESCE(from_number, '') <> '' GROUP BY from_number
    ), numbers AS (
      SELECT phone_number FROM phone_profiles
      UNION
      SELECT phone_number FROM callers
    )
    SELECT n.phone_number,
      COALESCE(p.display_name, '') AS display_name,
      COALESCE(p.personalization_text, '') AS personalization_text,
      COALESCE(p.memory_text, '') AS memory_text,
      COALESCE(p.enabled, 1) AS enabled,
      COALESCE(p.version, 0) AS version,
      p.updated_at AS profile_updated_at,
      c.last_call_at,
      COALESCE(c.call_count, 0) AS call_count
    FROM numbers n
    LEFT JOIN phone_profiles p ON p.phone_number=n.phone_number
    LEFT JOIN callers c ON c.phone_number=n.phone_number
    ORDER BY COALESCE(c.last_call_at, p.updated_at, '') DESC, n.phone_number ASC
    LIMIT 500`).all();
  return json({ ok: true, profiles: result.results || [] });
}
"""
if marker not in s:
    raise SystemExit('missing listCalls marker')
s = s.replace(marker, addition, 1)

# Dedicated management UI outside /phone.
dash = 'function dashboardHtml(request) {'
if dash not in s:
    raise SystemExit('missing dashboard marker')
page = r'''function profilesDashboardHtml(request) {
  const base = publicBaseUrl(request);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TalkSys 電話番号プロフィール</title><style>
  :root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:dark;background:#0b0e14;color:#f3f6fb}body{margin:0}.wrap{max-width:1180px;margin:auto;padding:28px 18px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.sub,.muted{color:#98a5b7}.panel{border:1px solid #293243;background:#121722;border-radius:14px;padding:16px;margin-top:16px}.grid{display:grid;grid-template-columns:minmax(300px,.8fr) minmax(420px,1.35fr);gap:14px}@media(max-width:820px){.grid{grid-template-columns:1fr}}button,input,textarea,select{font:inherit}button{background:#202a3a;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:9px 12px;cursor:pointer}input,textarea,select{box-sizing:border-box;width:100%;background:#0b0e14;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:9px}textarea{min-height:110px;resize:vertical}.row{padding:11px;border-bottom:1px solid #283245;cursor:pointer}.row:hover{background:#171e2b}.num{font-weight:750}.meta{font-size:12px;color:#91a0b5;margin-top:4px}.form{display:grid;gap:11px}.form label{font-size:12px;color:#bec8d7}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.warn{color:#ffca72}.ok{color:#7dd69a}.hidden{display:none}a{color:#a8c7ff}.newrow{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:10px}
  </style></head><body><main class="wrap"><div class="top"><div><h1>電話番号プロフィール</h1><div class="sub">通話履歴とは分離して、発信者番号ごとのプロフィールを直接管理します。</div></div><div><a href="${xmlEscape(base)}/phone">通話管理</a></div></div>
  <section id="login" class="panel"><b>管理トークン</b><p class="muted">/phone と同じ管理トークンを使用します。</p><input id="token" type="password" autocomplete="current-password"><button id="loginBtn">表示</button><div id="loginErr" class="warn"></div></section>
  <section id="app" class="hidden"><div class="grid"><div class="panel"><input id="filter" placeholder="電話番号・表示名で絞り込み"><div class="newrow"><input id="newPhone" placeholder="新しい電話番号"><button id="newBtn">開く</button></div><div id="list" style="margin-top:12px"></div></div><div class="panel"><h2 id="editorTitle">電話番号を選択</h2><div id="editor" class="hidden"><div class="form"><label>電話番号<input id="profilePhone" readonly></label><label>表示名<input id="profileName" maxlength="80"></label><label>パーソナライズ<textarea id="profilePersonalization" maxlength="4000"></textarea></label><label>メモリ<textarea id="profileMemory" maxlength="8000"></textarea></label><label>有効<select id="profileEnabled"><option value="1">有効</option><option value="0">無効</option></select></label></div><div class="actions" style="margin-top:12px"><button id="saveBtn">保存</button><span id="status" class="muted"></span></div><p class="muted">電話番号は本人確認には使用しません。秘密情報は保存しないでください。</p></div></div></div></section>
  </main><script>
  let adminToken=sessionStorage.getItem('talksysPhoneToken')||'',rows=[],selectedPhone='',selectedVersion=0;
  const auth=()=>adminToken?{'authorization':'Bearer '+adminToken}:{};
  const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  async function api(path,options={}){const r=await fetch(path,{...options,headers:{...auth(),...(options.headers||{})},cache:'no-store'});const d=await r.json().catch(()=>({}));if(r.status===401){const e=new Error('認証に失敗しました');e.status=401;throw e}if(!r.ok||d.ok===false){const e=new Error(d.error||('HTTP '+r.status));e.status=r.status;throw e}return d}
  function render(){const q=String(document.getElementById('filter').value||'').toLowerCase();const shown=rows.filter(x=>(String(x.phone_number||'')+' '+String(x.display_name||'')).toLowerCase().includes(q));document.getElementById('list').innerHTML=shown.length?shown.map(x=>'<div class="row" data-phone="'+esc(x.phone_number)+'"><div class="num">'+esc(x.display_name||x.phone_number)+'</div><div class="meta">'+esc(x.display_name?x.phone_number:'')+' / '+Number(x.call_count||0)+'通話 / '+(Number(x.enabled)===0?'無効':'有効')+'</div><div class="meta">最終通話 '+esc(x.last_call_at||'なし')+'</div></div>').join(''):'<div class="muted">該当なし</div>';document.querySelectorAll('.row').forEach(el=>el.onclick=()=>loadProfile(el.dataset.phone))}
  async function refresh(){const d=await api('/phone/api/profiles');rows=d.profiles||[];render()}
  async function loadProfile(phone){selectedPhone=String(phone||'').trim();if(!selectedPhone)return;const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone));const p=d.profile||{};selectedVersion=Number(p.version||0);document.getElementById('editor').classList.remove('hidden');document.getElementById('editorTitle').textContent=p.display_name?String(p.display_name)+' のプロフィール':selectedPhone+' のプロフィール';document.getElementById('profilePhone').value=selectedPhone;document.getElementById('profileName').value=p.display_name||'';document.getElementById('profilePersonalization').value=p.personalization_text||'';document.getElementById('profileMemory').value=p.memory_text||'';document.getElementById('profileEnabled').value=String(Number(p.enabled)===0?0:1);document.getElementById('status').textContent=d.exists?'保存済み':'未登録';history.replaceState(null,'','/phone-profiles?phone='+encodeURIComponent(selectedPhone))}
  async function save(){if(!selectedPhone)return;const status=document.getElementById('status');status.textContent='保存中...';try{const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({display_name:document.getElementById('profileName').value,personalization_text:document.getElementById('profilePersonalization').value,memory_text:document.getElementById('profileMemory').value,enabled:Number(document.getElementById('profileEnabled').value),version:selectedVersion})});selectedVersion=Number(d.profile?.version||selectedVersion);status.textContent='保存しました';status.className='ok';await refresh();await loadProfile(selectedPhone)}catch(e){status.className='warn';if(e.status===409){status.textContent='更新競合。再読込しました。';await loadProfile(selectedPhone);return}status.textContent='保存失敗: '+e.message}}
  async function start(){try{await refresh();document.getElementById('login').classList.add('hidden');document.getElementById('app').classList.remove('hidden');const q=new URL(location.href).searchParams.get('phone');if(q)await loadProfile(q)}catch(e){document.getElementById('loginErr').textContent=e.message}}
  document.getElementById('loginBtn').onclick=()=>{adminToken=document.getElementById('token').value;sessionStorage.setItem('talksysPhoneToken',adminToken);start()};document.getElementById('filter').oninput=render;document.getElementById('newBtn').onclick=()=>loadProfile(document.getElementById('newPhone').value).catch(e=>alert(e.message));document.getElementById('saveBtn').onclick=()=>save();if(adminToken)start();
  </script></body></html>`;
}

'''
s = s.replace(dash, page + dash, 1)

# Expand routing for page + profile list API.
rep("""  return pathname === '/phone' || pathname === '/telephony-health' || pathname === '/phone/api/calls' || pathname === '/phone/api/calls/export.zip'
    || /^\\/phone\\/api\\/calls\\/[^/]+\\/messages$/.test(pathname) || /^\\/phone\\/api\\/calls\\/[^/]+\\/latency$/.test(pathname)
    || /^\\/phone\\/api\\/calls\\/[^/]+\\/export\\.jsonl$/.test(pathname) || /^\\/phone\\/api\\/profiles\\/[^/]+$/.test(pathname)
""", """  return pathname === '/phone' || pathname === '/phone-profiles' || pathname === '/telephony-health' || pathname === '/phone/api/calls' || pathname === '/phone/api/calls/export.zip' || pathname === '/phone/api/profiles'
    || /^\\/phone\\/api\\/calls\\/[^/]+\\/messages$/.test(pathname) || /^\\/phone\\/api\\/calls\\/[^/]+\\/latency$/.test(pathname)
    || /^\\/phone\\/api\\/calls\\/[^/]+\\/export\\.jsonl$/.test(pathname) || /^\\/phone\\/api\\/profiles\\/[^/]+$/.test(pathname)
""", 'profile routes')

rep("""  if(request.method==='GET'&&url.pathname==='/phone')return new Response(dashboardHtml(request),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(request.method==='GET'&&url.pathname==='/telephony-health')return health(request,env,deps);
  if(request.method==='GET'&&url.pathname==='/phone/api/calls/export.zip')return recentCallsZip(request,env);
  if(request.method==='GET'&&url.pathname==='/phone/api/calls')return listCalls(request,env);
""", """  if(request.method==='GET'&&url.pathname==='/phone')return new Response(dashboardHtml(request),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(request.method==='GET'&&url.pathname==='/phone-profiles')return new Response(profilesDashboardHtml(request),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(request.method==='GET'&&url.pathname==='/telephony-health')return health(request,env,deps);
  if(request.method==='GET'&&url.pathname==='/phone/api/calls/export.zip')return recentCallsZip(request,env);
  if(request.method==='GET'&&url.pathname==='/phone/api/calls')return listCalls(request,env);
  if(request.method==='GET'&&url.pathname==='/phone/api/profiles')return listPhoneProfiles(request,env);
""", 'handler routes')

rep('<div><a href="${xmlEscape(base)}/telephony-health" style="color:#a8c7ff">状態JSON</a></div>',
    '<div><a href="${xmlEscape(base)}/phone-profiles" style="color:#a8c7ff">電話番号プロフィール</a> · <a href="${xmlEscape(base)}/telephony-health" style="color:#a8c7ff">状態JSON</a></div>',
    'dashboard profile link')

p.write_text(s)

# Update the old contract that intentionally forced post-STT acknowledgement.
t = Path('tests/phone-latency-fast-ack-v90.test.mjs')
q = t.read_text()
old = """test('phone latency v90 uses a prewarmed PCMU receipt acknowledgement only after confirmed STT', () => {
  assert.match(source, /const\\s+FAST_ACK_TEXT\\s*=\\s*'はい。'/);
  assert.match(source, /warmFastAckAudio/);
  assert.match(source, /fastAckAudioCache/);
  assert.match(source, /ack_cache_hit/);
  assert.match(source, /ack_cache_miss/);
  const sttEnd = source.search(/queueLatency\\(turnId,\\s*'stt_end'/);
  const ackHit = source.search(/queueLatency\\(turnId,\\s*'ack_cache_hit'/);
  assert.ok(sttEnd >= 0 && ackHit > sttEnd, 'receipt ack must only occur after successful STT');
});
"""
new = """test('phone latency v117 starts the prewarmed PCMU receipt acknowledgement before waiting for STT', () => {
  assert.match(source, /const\\s+FAST_ACK_TEXT\\s*=\\s*'はい。'/);
  assert.match(source, /PHONE_FAST_ACK_REVISION\\s*=\\s*'talksys-phone-fast-ack-v117-r1'/);
  assert.match(source, /warmFastAckAudio/);
  assert.match(source, /fastAckAudioCache/);
  assert.match(source, /const earlyAckPromise=/);
  const earlyAck = source.indexOf('const earlyAckPromise=');
  const sttAwait = source.indexOf('stt=await transcribeSamples');
  assert.ok(earlyAck >= 0 && sttAwait > earlyAck, 'receipt ack must be scheduled before the STT await');
  assert.match(source, /const earlyAckSpoken=await earlyAckPromise/);
  assert.doesNotMatch(source, /await speak\\(ackText,\\{purpose:'ack'/);
});
"""
if old not in q:
    raise SystemExit('missing old v90 ack contract')
t.write_text(q.replace(old, new, 1))

Path('tests/phone-repair-v117.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('v117 schedules cached acknowledgement before STT completion and never plays a second transcript acknowledgement', () => {
  const early = source.indexOf('const earlyAckPromise=');
  const sttAwait = source.indexOf('stt=await transcribeSamples');
  const sttEnd = source.indexOf("queueLatency(turnId,'stt_end'");
  assert.ok(early >= 0 && sttAwait > early && sttEnd > sttAwait);
  assert.match(source, /sourceKind:'pre-stt'/);
  assert.match(source, /const earlyAckSpoken=await earlyAckPromise/);
  assert.doesNotMatch(source, /await speak\(ackText,\{purpose:'ack'/);
});

test('ZIP batch export path reaches telephony handler', () => {
  assert.match(source, /pathname === '\/phone\/api\/calls\/export\.zip'/);
  assert.match(source, /url\.pathname==='\/phone\/api\/calls\/export\.zip'\)return recentCallsZip/);
});

test('dedicated phone profile management surface exists outside /phone', () => {
  assert.match(source, /pathname === '\/phone-profiles'/);
  assert.match(source, /function profilesDashboardHtml\(request\)/);
  assert.match(source, /url\.pathname==='\/phone-profiles'\)return new Response\(profilesDashboardHtml/);
  assert.match(source, /url\.pathname==='\/phone\/api\/profiles'\)return listPhoneProfiles/);
  assert.match(source, /WITH callers AS/);
  assert.match(source, /発信者番号ごとのプロフィールを直接管理/);
});
''')

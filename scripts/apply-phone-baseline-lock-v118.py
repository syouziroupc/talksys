from pathlib import Path
import subprocess

BASELINE = '20561b2319de9e6210f3dffc46216b499984cd45'
REACTION_BASELINE = 'f4ad582de205b0e8ed78b3a63a1c791072e5b2e2'


def git_show(ref, path):
    return subprocess.check_output(['git', 'show', f'{ref}:{path}'], text=True)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


# 1) Restore the pre-accessibility STT behavior that existed before the
# sensitivity/weak-speech gain experiment. This removes the Telnyx-only 2.5x
# normalization and returns the proven generic phonetic-first transcription.
Path('src/stt-v45.js').write_text(git_show(BASELINE, 'src/stt-v45.js'), encoding='utf-8')

# 2) Freeze production capture/output tuning at the conservative baseline.
wrangler_path = Path('wrangler.jsonc')
wrangler = wrangler_path.read_text(encoding='utf-8')
wrangler = replace_once(wrangler, '"TELEPHONY_VAD_RMS": "0.0045"', '"TELEPHONY_VAD_RMS": "0.008"', 'VAD threshold')
wrangler = replace_once(wrangler, '"TELEPHONY_TTS_DELIVERY": "loud-bright"', '"TELEPHONY_TTS_DELIVERY": "plain"', 'TTS delivery')
wrangler = replace_once(wrangler, '"TELEPHONY_TTS_OUTPUT_GAIN_DB": "3.0"', '"TELEPHONY_TTS_OUTPUT_GAIN_DB": "0.0"', 'TTS gain')
wrangler_path.write_text(wrangler, encoding='utf-8')

# 3) Restore the known-good Fast Reaction v2 semantics from 10/10:
# varied cached acknowledgements, conservative fallback, no pre-STT ack rewrite.
telephony_path = Path('src/telephony/index.js')
s = telephony_path.read_text(encoding='utf-8')
s = replace_once(
    s,
    "export const PHONE_PROFILE_PRELOAD_REVISION = 'talksys-phone-profile-preload-v116a-r1';\n",
    "export const PHONE_PROFILE_PRELOAD_REVISION = 'talksys-phone-profile-preload-v116a-r1';\nexport const PHONE_CONVERSATION_BASELINE_REVISION = 'talksys-phone-conversation-baseline-v118-r1';\n",
    'baseline revision',
)
s = replace_once(s, "const FAST_ACK_TEXT = 'はい。';", "const FAST_ACK_TEXT = 'はい、少々お待ちください。';", 'fast ack fallback')

old_greeting_tail = """      if(greetingText&&await speak(greetingText,{purpose:'greeting',turnId:greetingTurnId,originAt:greetingStartedAt,preparedAudio:preparedGreeting||undefined})){history.push({role:'assistant',content:greetingText});queueMessageLog('assistant',greetingText);}
      return;
"""
new_greeting_tail = """      if(greetingText&&await speak(greetingText,{purpose:'greeting',turnId:greetingTurnId,originAt:greetingStartedAt,preparedAudio:preparedGreeting||undefined})){history.push({role:'assistant',content:greetingText});queueMessageLog('assistant',greetingText);}
      trackTask(warmPhoneAckPrimaries(env,deps).then((count)=>console.log(JSON.stringify({type:'phone_fast_ack_primary_warm',revision:PHONE_FAST_ACK_REVISION,count}))).catch((error)=>console.warn(JSON.stringify({type:'phone_fast_ack_primary_warm_error',error:clean(error?.message||error,240)}))));return;
"""
s = replace_once(s, old_greeting_tail, new_greeting_tail, 'startup ack warm')

# 4) Pass the already-preloaded caller profile into the answer request without
# waiting on D1 and without changing VAD/STT/TTS/interrupt timing.
old_sig = "async function answerWithTalkSys(deps, text, history, signal, spokenBackchannel = '', sessionId = '', utteranceId = '') {"
new_sig = "async function answerWithTalkSys(deps, text, history, signal, spokenBackchannel = '', sessionId = '', utteranceId = '', callerProfile = null) {"
s = replace_once(s, old_sig, new_sig, 'answer signature')
old_payload = """    const priorHistory = (lastIsCurrent ? history.slice(0, -1) : history).slice(-16);
    const payload = await deps.turn({ text: current, history: priorHistory, channel: 'phone', sessionId: clean(sessionId, 200), utteranceId: clean(utteranceId, 200), spokenBackchannel }, signal);
"""
new_payload = """    const priorHistory = (lastIsCurrent ? history.slice(0, -1) : history).slice(-16);
    const phoneProfile = callerProfile?.enabled ? {
      displayName: clean(callerProfile?.displayName || '', 80),
      personalizationText: clean(callerProfile?.personalizationText || '', 4000),
      memoryText: clean(callerProfile?.memoryText || '', 8000),
      enabled: true,
      version: Number(callerProfile?.version || 0),
    } : null;
    const payload = await deps.turn({ text: current, history: priorHistory, channel: 'phone', sessionId: clean(sessionId, 200), utteranceId: clean(utteranceId, 200), spokenBackchannel, ...(phoneProfile ? { phoneProfile } : {}) }, signal);
"""
s = replace_once(s, old_payload, new_payload, 'phone profile payload')
old_turn = "const turnPromise=answerWithTalkSys(deps,stt.text,history,controller.signal,spokenBackchannel,callId,turnId);"
new_turn = "const turnPromise=answerWithTalkSys(deps,stt.text,history,controller.signal,spokenBackchannel,callId,turnId,callerProfileSession.status==='ready'?callerProfileSession.profile:null);"
s = replace_once(s, old_turn, new_turn, 'phone profile call')

# 5) Fix the batch ZIP route guard. The handler already exists.
old_guard = """  return pathname === '/phone' || pathname === '/telephony-health' || pathname === '/phone/api/calls'
    || /^\\/phone\\/api\\/calls\\/[^/]+\\/messages$/.test(pathname) || /^\\/phone\\/api\\/calls\\/[^/]+\\/latency$/.test(pathname)
    || /^\\/phone\\/api\\/calls\\/[^/]+\\/export\\.jsonl$/.test(pathname) || /^\\/phone\\/api\\/profiles\\/[^/]+$/.test(pathname)
"""
new_guard = """  return pathname === '/phone' || pathname === '/phone-profiles' || pathname === '/telephony-health' || pathname === '/phone/api/calls' || pathname === '/phone/api/calls/export.zip' || pathname === '/phone/api/profiles'
    || /^\\/phone\\/api\\/calls\\/[^/]+\\/messages$/.test(pathname) || /^\\/phone\\/api\\/calls\\/[^/]+\\/latency$/.test(pathname)
    || /^\\/phone\\/api\\/calls\\/[^/]+\\/export\\.jsonl$/.test(pathname) || /^\\/phone\\/api\\/profiles\\/[^/]+$/.test(pathname)
"""
s = replace_once(s, old_guard, new_guard, 'telephony path guard')

# 6) Add phone-number profile listing API, separate from /phone history.
list_calls = """async function listCalls(request, env) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const result = await env.TALKSYS_LOG_DB.prepare(`SELECT c.*, p.display_name AS profile_display_name, p.enabled AS profile_enabled, p.version AS profile_version FROM phone_calls c LEFT JOIN phone_profiles p ON p.phone_number=c.from_number ORDER BY c.updated_at DESC LIMIT 100`).all();
  return json({ ok: true, calls: result.results || [] });
}
"""
list_profiles = list_calls + """

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
s = replace_once(s, list_calls, list_profiles, 'profile list API')

# 7) Dedicated profile management UI.
dash_marker = 'function dashboardHtml(request) {'
if s.count(dash_marker) != 1:
    raise SystemExit(f'dashboard marker: expected 1, found {s.count(dash_marker)}')
profile_page = r'''function profilesDashboardHtml(request) {
  const base = publicBaseUrl(request);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TalkSys 電話番号プロフィール</title><style>
  :root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:dark;background:#0b0e14;color:#f3f6fb}body{margin:0}.wrap{max-width:1180px;margin:auto;padding:28px 18px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.sub,.muted{color:#98a5b7}.panel{border:1px solid #293243;background:#121722;border-radius:14px;padding:16px;margin-top:16px}.grid{display:grid;grid-template-columns:minmax(300px,.8fr) minmax(420px,1.35fr);gap:14px}@media(max-width:820px){.grid{grid-template-columns:1fr}}button,input,textarea,select{font:inherit}button{background:#202a3a;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:9px 12px;cursor:pointer}input,textarea,select{box-sizing:border-box;width:100%;background:#0b0e14;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:9px}textarea{min-height:110px;resize:vertical}.row{padding:11px;border-bottom:1px solid #283245;cursor:pointer}.row:hover{background:#171e2b}.num{font-weight:750}.meta{font-size:12px;color:#91a0b5;margin-top:4px}.form{display:grid;gap:11px}.form label{font-size:12px;color:#bec8d7}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.warn{color:#ffca72}.ok{color:#7dd69a}.hidden{display:none}a{color:#a8c7ff}.newrow{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:10px}
  </style></head><body><main class="wrap"><div class="top"><div><h1>電話番号プロフィール</h1><div class="sub">通話履歴とは分離して、発信者番号ごとの呼び名・応答方針・継続メモを管理します。</div></div><div><a href="${xmlEscape(base)}/phone">通話管理へ</a></div></div>
  <section id="login" class="panel"><b>管理トークン</b><p class="muted">/phone と同じ管理トークンを使用します。</p><input id="token" type="password" autocomplete="current-password"><button id="loginBtn">表示</button><div id="loginErr" class="warn"></div></section>
  <section id="app" class="hidden"><div class="grid"><div class="panel"><input id="filter" placeholder="電話番号・表示名で絞り込み"><div class="newrow"><input id="newPhone" placeholder="新しい電話番号"><button id="newBtn">開く</button></div><div id="list" style="margin-top:12px"></div></div><div class="panel"><h2 id="editorTitle">電話番号を選択</h2><div id="editor" class="hidden"><div class="form"><label>電話番号<input id="profilePhone" readonly></label><label>表示名<input id="profileName" maxlength="80"></label><label>応答方針<textarea id="profilePersonalization" maxlength="4000"></textarea></label><label>継続メモ<textarea id="profileMemory" maxlength="8000"></textarea></label><label>有効<select id="profileEnabled"><option value="1">有効</option><option value="0">無効</option></select></label></div><div class="actions" style="margin-top:12px"><button id="saveBtn">保存</button><span id="status" class="muted"></span></div><p class="muted">電話番号は本人確認には使用しません。秘密情報は保存しないでください。</p></div></div></div></section>
  </main><script>
  let adminToken=sessionStorage.getItem('talksysPhoneToken')||'',rows=[],selectedPhone='',selectedVersion=0;
  const auth=()=>adminToken?{'authorization':'Bearer '+adminToken}:{};
  const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  async function api(path,options={}){const r=await fetch(path,{...options,headers:{...auth(),...(options.headers||{})},cache:'no-store'});const d=await r.json().catch(()=>({}));if(r.status===401){const e=new Error('認証に失敗しました');e.status=401;throw e}if(!r.ok||d.ok===false){const e=new Error(d.error||('HTTP '+r.status));e.status=r.status;throw e}return d}
  function render(){const q=String(document.getElementById('filter').value||'').toLowerCase();const shown=rows.filter(x=>(String(x.phone_number||'')+' '+String(x.display_name||'')).toLowerCase().includes(q));document.getElementById('list').innerHTML=shown.length?shown.map(x=>'<div class="row" data-phone="'+esc(x.phone_number)+'"><div class="num">'+esc(x.display_name||x.phone_number)+'</div><div class="meta">'+esc(x.display_name?x.phone_number:'')+' / '+Number(x.call_count||0)+'通話 / '+(Number(x.enabled)===0?'無効':'有効')+'</div><div class="meta">最終通話 '+esc(x.last_call_at||'なし')+'</div></div>').join(''):'<div class="muted">該当なし</div>';document.querySelectorAll('.row').forEach(el=>el.onclick=()=>loadProfile(el.dataset.phone))}
  async function refresh(){const d=await api('/phone/api/profiles');rows=d.profiles||[];render()}
  async function loadProfile(phone){selectedPhone=String(phone||'').trim();if(!selectedPhone)return;const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone));const p=d.profile||{};selectedVersion=Number(p.version||0);document.getElementById('editor').classList.remove('hidden');document.getElementById('editorTitle').textContent=p.display_name?String(p.display_name)+' のプロフィール':selectedPhone+' のプロフィール';document.getElementById('profilePhone').value=selectedPhone;document.getElementById('profileName').value=p.display_name||'';document.getElementById('profilePersonalization').value=p.personalization_text||'';document.getElementById('profileMemory').value=p.memory_text||'';document.getElementById('profileEnabled').value=String(Number(p.enabled)===0?0:1);document.getElementById('status').textContent=d.exists?'保存済み':'未登録';history.replaceState(null,'','/phone-profiles?phone='+encodeURIComponent(selectedPhone))}
  async function save(){if(!selectedPhone)return;const status=document.getElementById('status');status.textContent='保存中...';status.className='muted';try{const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({display_name:document.getElementById('profileName').value,personalization_text:document.getElementById('profilePersonalization').value,memory_text:document.getElementById('profileMemory').value,enabled:Number(document.getElementById('profileEnabled').value),version:selectedVersion})});selectedVersion=Number(d.profile?.version||selectedVersion);status.textContent='保存しました';status.className='ok';await refresh();await loadProfile(selectedPhone)}catch(e){status.className='warn';if(e.status===409){status.textContent='更新競合。再読込しました。';await loadProfile(selectedPhone);return}status.textContent='保存失敗: '+e.message}}
  async function start(){try{await refresh();document.getElementById('login').classList.add('hidden');document.getElementById('app').classList.remove('hidden');const q=new URL(location.href).searchParams.get('phone');if(q)await loadProfile(q)}catch(e){document.getElementById('loginErr').textContent=e.message}}
  document.getElementById('loginBtn').onclick=()=>{adminToken=document.getElementById('token').value;sessionStorage.setItem('talksysPhoneToken',adminToken);start()};document.getElementById('filter').oninput=render;document.getElementById('newBtn').onclick=()=>loadProfile(document.getElementById('newPhone').value).catch(e=>alert(e.message));document.getElementById('saveBtn').onclick=()=>save();if(adminToken)start();
  </script></body></html>`;
}

'''
s = s.replace(dash_marker, profile_page + dash_marker, 1)

# Add routes for page/list API.
old_routes = """  if(request.method==='GET'&&url.pathname==='/phone')return new Response(dashboardHtml(request),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(request.method==='GET'&&url.pathname==='/telephony-health')return health(request,env,deps);
  if(request.method==='GET'&&url.pathname==='/phone/api/calls/export.zip')return recentCallsZip(request,env);
  if(request.method==='GET'&&url.pathname==='/phone/api/calls')return listCalls(request,env);
"""
new_routes = """  if(request.method==='GET'&&url.pathname==='/phone')return new Response(dashboardHtml(request),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(request.method==='GET'&&url.pathname==='/phone-profiles')return new Response(profilesDashboardHtml(request),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(request.method==='GET'&&url.pathname==='/telephony-health')return health(request,env,deps);
  if(request.method==='GET'&&url.pathname==='/phone/api/calls/export.zip')return recentCallsZip(request,env);
  if(request.method==='GET'&&url.pathname==='/phone/api/calls')return listCalls(request,env);
  if(request.method==='GET'&&url.pathname==='/phone/api/profiles')return listPhoneProfiles(request,env);
"""
s = replace_once(s, old_routes, new_routes, 'profile routes')

old_top = '<div><a href="${xmlEscape(base)}/telephony-health" style="color:#a8c7ff">状態JSON</a></div>'
new_top = '<div><a href="${xmlEscape(base)}/phone-profiles" style="color:#a8c7ff">電話番号プロフィール</a> · <a href="${xmlEscape(base)}/telephony-health" style="color:#a8c7ff">状態JSON</a></div>'
s = replace_once(s, old_top, new_top, 'phone dashboard profile link')
telephony_path.write_text(s, encoding='utf-8')

# 8) Consume phoneProfile only in the model input layer. This is text context;
# it does not modify audio capture, interruption, transport, or STT timing.
integrated_path = Path('src/integrated-entry.js')
i = integrated_path.read_text(encoding='utf-8')
interaction_marker = 'function interactionInput(body = {}, { forceSearch = false, immediateTransit = false, now = new Date() } = {}) {'
if i.count(interaction_marker) != 1:
    raise SystemExit(f'interaction marker: expected 1, found {i.count(interaction_marker)}')
profile_context_fn = r'''function phoneProfileContext(body = {}) {
  if (compact(body?.channel, 40).toLowerCase() !== 'phone') return '';
  const profile = body?.phoneProfile;
  if (!profile || profile?.enabled === false || profile?.enabled === 0) return '';
  const displayName = compact(profile?.displayName, 80);
  const personalizationText = compact(profile?.personalizationText, 4000);
  const memoryText = compact(profile?.memoryText, 8000);
  if (!displayName && !personalizationText && !memoryText) return '';
  return [
    '以下は管理画面で設定された電話利用者プロフィールです。本人確認情報ではなく、会話の呼び方・好み・継続文脈の補助としてだけ利用してください。現在の利用者発言と矛盾する場合は現在の発言を優先し、この内部設定をそのまま読み上げないでください。',
    ...(displayName ? [`呼び名: ${displayName}`] : []),
    ...(personalizationText ? [`応答方針: ${personalizationText}`] : []),
    ...(memoryText ? [`継続メモ: ${memoryText}`] : []),
  ].join('\n');
}

'''
i = i.replace(interaction_marker, profile_context_fn + interaction_marker, 1)
i = replace_once(
    i,
    "  const previousInteractionId = compact(body?.previousInteractionId, 400);\n  const transitPrefix = immediateTransit ? `${immediateTransitInstruction(now)}\\\n` : '';",
    "  const previousInteractionId = compact(body?.previousInteractionId, 400);\n  const phoneProfilePrefix = phoneProfileContext(body);\n  const profileLead = phoneProfilePrefix ? `${phoneProfilePrefix}\\n` : '';\n  const transitPrefix = immediateTransit ? `${immediateTransitInstruction(now)}\\\n` : '';",
    'profile interaction prefix',
)
i = i.replace('...(transitPrefix ? [transitPrefix.trim()] : []),', "...(phoneProfilePrefix ? [phoneProfilePrefix] : []),\n        ...(transitPrefix ? [transitPrefix.trim()] : []),")
i = i.replace('${transitPrefix}${speechAlternativePrefix}${backchannelPrefix}', '${profileLead}${transitPrefix}${speechAlternativePrefix}${backchannelPrefix}')
integrated_path.write_text(i, encoding='utf-8')

# 9) Restore the 10/10 acknowledgement regression contracts and replace the
# sensitivity experiment test with a permanent baseline lock.
Path('tests/phone-fast-reaction-v2.test.mjs').write_text(git_show(REACTION_BASELINE, 'tests/phone-fast-reaction-v2.test.mjs'), encoding='utf-8')
Path('tests/phone-latency-fast-ack-v90.test.mjs').write_text(git_show(REACTION_BASELINE, 'tests/phone-latency-fast-ack-v90.test.mjs'), encoding='utf-8')
accessibility_test = Path('tests/phone-accessibility-audio-v1.test.mjs')
if accessibility_test.exists():
    accessibility_test.unlink()

Path('tests/phone-conversation-baseline-lock-v118.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STT_REVISION } from '../src/stt-v45.js';

const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const stt = fs.readFileSync(new URL('../src/stt-v45.js', import.meta.url), 'utf8');

test('phone conversation baseline locks conservative capture and output settings', () => {
  assert.match(wrangler, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.008"/);
  assert.match(wrangler, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"plain"/);
  assert.match(wrangler, /"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"0\.0"/);
  assert.equal(STT_REVISION, 'talksys-v104-phonetic-first-ja');
  assert.doesNotMatch(stt, /normalizeQuietPhoneWav/);
  assert.doesNotMatch(stt, /PHONE_STT_CONTEXT_PROMPT/);
});

test('phone acknowledgement behavior is the 10/10 Fast Reaction v2 contract', () => {
  assert.match(telephony, /const FAST_ACK_TEXT = 'はい、少々お待ちください。'/);
  assert.match(telephony, /trackTask\(warmPhoneAckPrimaries\(env,deps\)/);
  assert.doesNotMatch(telephony, /earlyAckPromise/);
  const sttEnd = telephony.search(/queueLatency\(turnId,\s*'stt_end'/);
  const ackHit = telephony.search(/queueLatency\(turnId,\s*'ack_cache_hit'/);
  assert.ok(sttEnd >= 0 && ackHit > sttEnd, 'ack selection/playback must remain transcript-confirmed');
});

test('assistant playback keeps the existing guarded barge-in contract', () => {
  assert.match(telephony, /bargeThreshold=Math\.max\(threshold\*1\.25,noiseFloor\*3\.2,0\.010\)/);
  assert.match(telephony, /assistantPlaying/);
});

test('phone ZIP and dedicated profile administration routes are reachable', () => {
  assert.match(telephony, /pathname === '\/phone\/api\/calls\/export\.zip'/);
  assert.match(telephony, /pathname === '\/phone-profiles'/);
  assert.match(telephony, /pathname === '\/phone\/api\/profiles'/);
  assert.match(telephony, /function profilesDashboardHtml\(request\)/);
  assert.match(telephony, /async function listPhoneProfiles\(request, env\)/);
});

test('caller personalization is text-only context and does not block the audio pipeline', () => {
  assert.match(telephony, /callerProfileSession\.status==='ready'\?callerProfileSession\.profile:null/);
  assert.match(telephony, /\.\.\.\(phoneProfile \? \{ phoneProfile \} : \{\}\)/);
  assert.match(integrated, /function phoneProfileContext\(body = \{\}\)/);
  assert.match(integrated, /const phoneProfilePrefix = phoneProfileContext\(body\)/);
  assert.match(integrated, /現在の利用者発言と矛盾する場合は現在の発言を優先/);
});
''', encoding='utf-8')

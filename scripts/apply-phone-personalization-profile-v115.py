from pathlib import Path

p = Path('src/telephony/index.js')
s = p.read_text(encoding='utf-8')


def once(old, new, label):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, got {count}')
    s = s.replace(old, new, 1)


# Revision marker only; no call-runtime behavior in this phase.
old = "export const PHONE_GREETING_LATENCY_REVISION = 'talksys-phone-greeting-latency-v114-r1';\n"
new = old + "export const PHONE_PROFILE_REVISION = 'talksys-phone-profile-v115-r1';\n"
if 'PHONE_PROFILE_REVISION' not in s:
    once(old, new, 'profile revision')

# D1 schema: caller-number keyed profile, deliberately separate from call/message rows.
old = """      await env.TALKSYS_LOG_DB.prepare(`CREATE TABLE IF NOT EXISTS phone_latency_events (\n        id INTEGER PRIMARY KEY AUTOINCREMENT,\n        call_id TEXT NOT NULL,\n        turn_id TEXT NOT NULL,\n        stage TEXT NOT NULL,\n        elapsed_ms INTEGER NOT NULL DEFAULT 0,\n        detail TEXT NOT NULL DEFAULT '{}',\n        created_at TEXT NOT NULL\n      )`).run();\n      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_phone_messages_call ON phone_messages(call_id, id)').run();\n"""
new = """      await env.TALKSYS_LOG_DB.prepare(`CREATE TABLE IF NOT EXISTS phone_latency_events (\n        id INTEGER PRIMARY KEY AUTOINCREMENT,\n        call_id TEXT NOT NULL,\n        turn_id TEXT NOT NULL,\n        stage TEXT NOT NULL,\n        elapsed_ms INTEGER NOT NULL DEFAULT 0,\n        detail TEXT NOT NULL DEFAULT '{}',\n        created_at TEXT NOT NULL\n      )`).run();\n      await env.TALKSYS_LOG_DB.prepare(`CREATE TABLE IF NOT EXISTS phone_profiles (\n        phone_number TEXT PRIMARY KEY,\n        display_name TEXT NOT NULL DEFAULT '',\n        personalization_text TEXT NOT NULL DEFAULT '',\n        memory_text TEXT NOT NULL DEFAULT '',\n        enabled INTEGER NOT NULL DEFAULT 1,\n        version INTEGER NOT NULL DEFAULT 1,\n        created_at TEXT NOT NULL,\n        updated_at TEXT NOT NULL\n      )`).run();\n      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_phone_messages_call ON phone_messages(call_id, id)').run();\n"""
if 'CREATE TABLE IF NOT EXISTS phone_profiles' not in s:
    once(old, new, 'profile table')

old = "      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_phone_latency_turn ON phone_latency_events(call_id, turn_id, id)').run();\n"
new = old + "      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_phone_profiles_updated ON phone_profiles(updated_at DESC)').run();\n"
if 'idx_phone_profiles_updated' not in s:
    once(old, new, 'profile index')

# Admin-only profile API helpers. Phone number is a lookup key, never authentication.
marker = "async function listCalls(request, env) {\n"
if 'async function phoneProfileGet' not in s:
    addition = r'''function profilePhone(value = '') {
  return clean(value, 80).trim();
}
function profileDefaults(phoneNumber = '') {
  return { phone_number: profilePhone(phoneNumber), display_name: '', personalization_text: '', memory_text: '', enabled: 1, version: 0, created_at: '', updated_at: '' };
}
function profileInput(body = {}) {
  const displayName = String(body?.display_name ?? body?.displayName ?? '');
  const personalizationText = String(body?.personalization_text ?? body?.personalizationText ?? '');
  const memoryText = String(body?.memory_text ?? body?.memoryText ?? '');
  if (displayName.length > 80) return { error: 'display_name_too_long' };
  if (personalizationText.length > 4000) return { error: 'personalization_text_too_long' };
  if (memoryText.length > 8000) return { error: 'memory_text_too_long' };
  const enabledValue = body?.enabled;
  const enabled = enabledValue === false || enabledValue === 0 || enabledValue === '0' ? 0 : 1;
  const versionRaw = Number(body?.version);
  const version = Number.isInteger(versionRaw) && versionRaw >= 0 ? versionRaw : null;
  return { displayName, personalizationText, memoryText, enabled, version };
}
async function phoneProfileGet(request, env, phoneNumber) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const phone = profilePhone(phoneNumber);
  if (!phone) return json({ ok: false, error: 'phone_number_required' }, 400);
  const row = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_profiles WHERE phone_number=?').bind(phone).first();
  return json({ ok: true, exists: Boolean(row), profile: row || profileDefaults(phone), warning: '電話番号は本人確認・認証には使用しません。秘密情報は保存しないでください。' });
}
async function phoneProfilePut(request, env, phoneNumber) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const phone = profilePhone(phoneNumber);
  if (!phone) return json({ ok: false, error: 'phone_number_required' }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const input = profileInput(body);
  if (input.error) return json({ ok: false, error: input.error }, 400);
  const current = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_profiles WHERE phone_number=?').bind(phone).first();
  if (current && input.version !== null && input.version !== Number(current.version || 0)) {
    return json({ ok: false, error: 'version_conflict', profile: current }, 409);
  }
  const now = new Date().toISOString();
  if (current) {
    await env.TALKSYS_LOG_DB.prepare(`UPDATE phone_profiles SET display_name=?, personalization_text=?, memory_text=?, enabled=?, version=version+1, updated_at=? WHERE phone_number=?`)
      .bind(input.displayName, input.personalizationText, input.memoryText, input.enabled, now, phone).run();
  } else {
    await env.TALKSYS_LOG_DB.prepare(`INSERT INTO phone_profiles (phone_number, display_name, personalization_text, memory_text, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(phone, input.displayName, input.personalizationText, input.memoryText, input.enabled, now, now).run();
  }
  const saved = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_profiles WHERE phone_number=?').bind(phone).first();
  return json({ ok: true, profile: saved });
}

'''
    if marker not in s:
        raise SystemExit('profile API marker not found')
    s = s.replace(marker, addition + marker, 1)

# Call list gets only non-sensitive profile metadata for display; conversation storage remains untouched.
old = "  const result = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_calls ORDER BY updated_at DESC LIMIT 100').all();\n"
new = "  const result = await env.TALKSYS_LOG_DB.prepare(`SELECT c.*, p.display_name AS profile_display_name, p.enabled AS profile_enabled, p.version AS profile_version FROM phone_calls c LEFT JOIN phone_profiles p ON p.phone_number=c.from_number ORDER BY c.updated_at DESC LIMIT 100`).all();\n"
if 'profile_display_name' not in s:
    once(old, new, 'call list profile metadata')

# UI CSS: scoped profile editor styles only.
old = "@media(max-width:640px){.event{grid-template-columns:72px 1fr}.detail{grid-column:1/-1}}\n"
new = "@media(max-width:640px){.event{grid-template-columns:72px 1fr}.detail{grid-column:1/-1}}.profileBox{border:1px solid #2a3344;border-radius:10px;padding:12px;margin:10px 0 16px}.profileGrid{display:grid;gap:9px}.profileGrid label{font-size:12px;color:#b8c3d2}.profileGrid input[type=text],.profileGrid textarea,.profileGrid select{box-sizing:border-box;width:100%;margin-top:4px;background:#0b0e14;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:9px;font:inherit}.profileGrid textarea{min-height:82px;resize:vertical}.profileActions{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}\n"
if '.profileBox{' not in s:
    once(old, new, 'profile css')

# Add profile editor above conversation content.
old = '<section id="app" class="hidden"><div class="panel"><div id="health">状態確認中...</div></div><div class="grid"><div class="panel"><div class="top"><h2>着信一覧</h2><div><select id="batchCount"><option value="10">直近10件</option><option value="20" selected>直近20件</option><option value="50">直近50件</option></select> <button id="batchExportBtn">ログZIP保存</button></div></div><div id="calls"></div></div><div class="panel"><div class="top"><h2 id="conversationTitle">会話内容</h2><button id="exportBtn" class="hidden">JSONL保存</button></div><div id="messages" class="muted">左の着信を選択してください。</div><div class="latency"><h3>遅延タイムライン</h3>'
new = '<section id="app" class="hidden"><div class="panel"><div id="health">状態確認中...</div></div><div class="grid"><div class="panel"><div class="top"><h2>着信一覧</h2><div><select id="batchCount"><option value="10">直近10件</option><option value="20" selected>直近20件</option><option value="50">直近50件</option></select> <button id="batchExportBtn">ログZIP保存</button></div></div><div id="calls"></div></div><div class="panel"><div class="top"><h2 id="conversationTitle">会話内容</h2><button id="exportBtn" class="hidden">JSONL保存</button></div><div id="profileBox" class="profileBox hidden"><div class="top"><h3>発信者プロフィール</h3><span id="profilePhone" class="muted"></span></div><div class="muted">電話番号は本人確認ではありません。パスワード・カード番号などの秘密情報は保存しないでください。</div><div class="profileGrid"><label>表示名<input id="profileName" type="text" maxlength="80"></label><label>パーソナライズ<textarea id="profilePersonalization" maxlength="4000" placeholder="例: 丁寧で簡潔な説明を好む。呼び方は○○さん。"></textarea></label><label>メモリ<textarea id="profileMemory" maxlength="8000" placeholder="次回以降の通話で参照したい安定した情報"></textarea></label><label>利用<select id="profileEnabled"><option value="1">有効</option><option value="0">無効</option></select></label></div><div class="profileActions"><button id="profileSaveBtn">プロフィール保存</button><span id="profileStatus" class="muted"></span></div></div><div id="messages" class="muted">左の着信を選択してください。</div><div class="latency"><h3>遅延タイムライン</h3>'
if 'id="profileBox"' not in s:
    once(old, new, 'profile UI markup')

# UI state + API method support.
old = "  let adminToken=sessionStorage.getItem('talksysPhoneToken')||'';let selected='';const auth=()=>({'authorization':'Bearer '+adminToken});\n"
new = "  let adminToken=sessionStorage.getItem('talksysPhoneToken')||'';let selected='',selectedPhone='',selectedProfileVersion=0;const auth=()=>({'authorization':'Bearer '+adminToken});\n"
if 'selectedProfileVersion' not in s:
    once(old, new, 'profile UI state')

old = "  async function api(path){const r=await fetch(path,{headers:auth(),cache:'no-store'});if(r.status===401)throw new Error('認証に失敗しました');return r.json()}\n"
new = "  async function api(path,options={}){const headers={...auth(),...(options.headers||{})};const r=await fetch(path,{...options,headers,cache:'no-store'});if(r.status===401)throw new Error('認証に失敗しました');const d=await r.json();if(!r.ok){const e=new Error(d?.error||'APIエラー');e.status=r.status;e.data=d;throw e}return d}\n"
if 'options={}' not in s:
    once(old, new, 'api method support')

# Call list shows saved display name without changing the underlying from_number.
old = "async function refreshCalls(){const d=await api('/phone/api/calls');const root=document.getElementById('calls');root.innerHTML=d.calls.length?d.calls.map(c=>'<div class=\"call\" data-id=\"'+esc(c.call_id)+'\"><div class=\"num\">'+esc(c.from_number||'番号不明')+' → '+esc(c.to_number||'着信番号不明')+'</div>"
new = "async function refreshCalls(){const d=await api('/phone/api/calls');const root=document.getElementById('calls');root.innerHTML=d.calls.length?d.calls.map(c=>'<div class=\"call\" data-id=\"'+esc(c.call_id)+'\"><div class=\"num\">'+esc(c.profile_display_name?c.profile_display_name+' ('+(c.from_number||'番号不明')+')':(c.from_number||'番号不明'))+' → '+esc(c.to_number||'着信番号不明')+'</div>"
if 'c.profile_display_name?' not in s:
    once(old, new, 'call list display name')

# Profile load/save functions are admin UI only and use textContent/value to avoid HTML injection.
marker = "  async function loadMessages(id){"
if 'async function loadProfile(phone)' not in s:
    addition = r'''  async function loadProfile(phone){selectedPhone=String(phone||'');const box=document.getElementById('profileBox');if(!selectedPhone){box.classList.add('hidden');selectedProfileVersion=0;return}const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone));const p=d.profile||{};selectedProfileVersion=Number(p.version||0);box.classList.remove('hidden');document.getElementById('profilePhone').textContent=selectedPhone;document.getElementById('profileName').value=p.display_name||'';document.getElementById('profilePersonalization').value=p.personalization_text||'';document.getElementById('profileMemory').value=p.memory_text||'';document.getElementById('profileEnabled').value=String(p.enabled===0?0:1);document.getElementById('profileStatus').textContent=d.exists?'保存済み':'未登録'}
  async function saveProfile(){if(!selectedPhone)return;const status=document.getElementById('profileStatus');status.textContent='保存中...';try{const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({display_name:document.getElementById('profileName').value,personalization_text:document.getElementById('profilePersonalization').value,memory_text:document.getElementById('profileMemory').value,enabled:Number(document.getElementById('profileEnabled').value),version:selectedProfileVersion})});selectedProfileVersion=Number(d.profile?.version||selectedProfileVersion);status.textContent='保存しました';await refreshCalls()}catch(e){if(e.status===409){status.textContent='他の更新と競合しました。再読込します。';await loadProfile(selectedPhone);return}status.textContent='保存失敗: '+e.message}}
'''
    if marker not in s:
        raise SystemExit('loadMessages marker not found')
    s = s.replace(marker, addition + marker, 1)

old = "async function loadMessages(id){selected=id;const base='/phone/api/calls/'+encodeURIComponent(id);const [d,l]=await Promise.all([api(base+'/messages'),api(base+'/latency')]);document.getElementById('conversationTitle').textContent=(d.call?.from_number||'番号不明')+' の会話';document.getElementById('exportBtn').classList.remove('hidden');document.getElementById('messages').innerHTML=d.messages.length?d.messages.map(m=>'<div class=\"msg '+m.role+'\"><div class=\"role\">'+(m.role==='user'?'発信者':'TalkSys')+' / '+esc(m.created_at)+'</div>'+esc(m.content)+'</div>').join(''):'<div class=\"muted\">会話はまだありません。</div>';renderLatency(l.events||[])}\n"
new = "async function loadMessages(id){selected=id;const base='/phone/api/calls/'+encodeURIComponent(id);const [d,l]=await Promise.all([api(base+'/messages'),api(base+'/latency')]);document.getElementById('conversationTitle').textContent=(d.call?.from_number||'番号不明')+' の会話';document.getElementById('exportBtn').classList.remove('hidden');await loadProfile(d.call?.from_number||'');document.getElementById('messages').innerHTML=d.messages.length?d.messages.map(m=>'<div class=\"msg '+m.role+'\"><div class=\"role\">'+(m.role==='user'?'発信者':'TalkSys')+' / '+esc(m.created_at)+'</div>'+esc(m.content)+'</div>').join(''):'<div class=\"muted\">会話はまだありません。</div>';renderLatency(l.events||[])}\n"
if 'await loadProfile(d.call?.from_number' not in s:
    once(old, new, 'profile load on call selection')

old = "document.getElementById('batchExportBtn').onclick=()=>downloadBatchExport().catch(e=>alert(e.message));if(adminToken)start();\n"
new = "document.getElementById('batchExportBtn').onclick=()=>downloadBatchExport().catch(e=>alert(e.message));document.getElementById('profileSaveBtn').onclick=()=>saveProfile();if(adminToken)start();\n"
if "profileSaveBtn').onclick" not in s:
    once(old, new, 'profile save binding')

# Route profile API through the existing admin auth boundary.
old = "    || /^\\/phone\\/api\\/calls\\/[^/]+\\/export\\.jsonl$/.test(pathname)\n    || pathname === '/telnyx/voice'"
new = "    || /^\\/phone\\/api\\/calls\\/[^/]+\\/export\\.jsonl$/.test(pathname) || /^\\/phone\\/api\\/profiles\\/[^/]+$/.test(pathname)\n    || pathname === '/telnyx/voice'"
if '/phone\\/api\\/profiles' not in s:
    once(old, new, 'profile route matcher')

old = "  const exportMatch=url.pathname.match(/^\\/phone\\/api\\/calls\\/([^/]+)\\/export\\.jsonl$/);if(request.method==='GET'&&exportMatch)return callExportJsonl(request,env,decodeURIComponent(exportMatch[1]));\n  if((request.method==='GET'||request.method==='POST')&&url.pathname==='/telnyx/voice')"
new = "  const exportMatch=url.pathname.match(/^\\/phone\\/api\\/calls\\/([^/]+)\\/export\\.jsonl$/);if(request.method==='GET'&&exportMatch)return callExportJsonl(request,env,decodeURIComponent(exportMatch[1]));\n  const profileMatch=url.pathname.match(/^\\/phone\\/api\\/profiles\\/([^/]+)$/);if(profileMatch&&(request.method==='GET'||request.method==='PUT')){let phone;try{phone=decodeURIComponent(profileMatch[1]);}catch{return json({ok:false,error:'invalid_phone_number'},400)}return request.method==='GET'?phoneProfileGet(request,env,phone):phoneProfilePut(request,env,phone);}\n  if((request.method==='GET'||request.method==='POST')&&url.pathname==='/telnyx/voice')"
if 'const profileMatch=url.pathname.match' not in s:
    once(old, new, 'profile route handler')

p.write_text(s, encoding='utf-8')

t = Path('tests/phone-personalization-profile-v115.test.mjs')
t.write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PHONE_PROFILE_REVISION, isTelephonyPath } from '../src/telephony/index.js';

test('v115 exposes profile revision and route without changing media routes', () => {
  assert.match(PHONE_PROFILE_REVISION, /v115/);
  assert.equal(isTelephonyPath('/phone/api/profiles/%2B819012345678'), true);
  assert.equal(isTelephonyPath('/telnyx/media'), true);
  assert.equal(isTelephonyPath('/telnyx/voice'), true);
});

test('profile storage is separate from call and message tables', async () => {
  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /CREATE TABLE IF NOT EXISTS phone_profiles/);
  assert.match(source, /phone_number TEXT PRIMARY KEY/);
  assert.match(source, /personalization_text TEXT NOT NULL DEFAULT ''/);
  assert.match(source, /memory_text TEXT NOT NULL DEFAULT ''/);
  assert.match(source, /version INTEGER NOT NULL DEFAULT 1/);
});

test('profile API remains behind admin authorization and supports conflict detection', async () => {
  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  const getStart = source.indexOf('async function phoneProfileGet');
  const putStart = source.indexOf('async function phoneProfilePut');
  assert.ok(getStart > 0 && putStart > getStart);
  assert.match(source.slice(getStart, putStart), /adminAuthorized\(request, env\)/);
  assert.match(source.slice(putStart, source.indexOf('async function listCalls')), /adminAuthorized\(request, env\)/);
  assert.match(source, /version_conflict/);
  assert.match(source, /display_name_too_long/);
  assert.match(source, /personalization_text_too_long/);
  assert.match(source, /memory_text_too_long/);
});

test('phase one does not inject profile data into the live TalkSys turn', async () => {
  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  const finishStart = source.indexOf('const finishUtterance=()=>');
  const deadline = source.indexOf('const deadline=', finishStart);
  const runtime = source.slice(finishStart, deadline);
  assert.doesNotMatch(runtime, /personalization_text|memory_text|phoneProfileGet|phone_profiles/);
});

test('admin UI edits profile using safe value/textContent paths', async () => {
  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /id="profilePersonalization"/);
  assert.match(source, /id="profileMemory"/);
  assert.match(source, /profilePhone'\)\.textContent/);
  assert.match(source, /profileName'\)\.value/);
  assert.match(source, /method:'PUT'/);
});
''', encoding='utf-8')

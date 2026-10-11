from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}: {old[:160]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


telephony = Path('src/telephony/index.js')
s = telephony.read_text(encoding='utf-8')

# Revision marker.
old = "export const TELEPHONY_OBSERVABILITY_REVISION = 'talksys-phone-latency-v90-fast-ack-r1';\n"
new = old + "export const PHONE_CONTACT_MEMORY_REVISION = 'talksys-phone-contacts-memory-v113-r1';\n"
if 'PHONE_CONTACT_MEMORY_REVISION' not in s:
    if old not in s:
        raise SystemExit('telephony revision marker not found')
    s = s.replace(old, new, 1)

# Persistent contact/profile table, keyed by caller number.
marker = "      await env.TALKSYS_LOG_DB.prepare(`CREATE TABLE IF NOT EXISTS phone_messages (\n"
if 'CREATE TABLE IF NOT EXISTS phone_contacts' not in s:
    addition = """      await env.TALKSYS_LOG_DB.prepare(`CREATE TABLE IF NOT EXISTS phone_contacts (\n        phone_number TEXT PRIMARY KEY,\n        display_name TEXT NOT NULL DEFAULT '',\n        memory TEXT NOT NULL DEFAULT '',\n        created_at TEXT NOT NULL,\n        updated_at TEXT NOT NULL\n      )`).run();\n"""
    if marker not in s:
        raise SystemExit('phone_messages schema marker not found')
    s = s.replace(marker, addition + marker, 1)

# Ensure every observed caller number has a contact record without double-counting calls.
old = """      updated_at=excluded.updated_at`).bind(callId, from, to, status, now, now).run();\n}\nasync function setCallStatus"""
new = """      updated_at=excluded.updated_at`).bind(callId, from, to, status, now, now).run();\n  if (from) {\n    await env.TALKSYS_LOG_DB.prepare(`INSERT INTO phone_contacts\n      (phone_number, display_name, memory, created_at, updated_at) VALUES (?, '', '', ?, ?)\n      ON CONFLICT(phone_number) DO NOTHING`).bind(from, now, now).run();\n  }\n}\nasync function setCallStatus"""
if old in s:
    s = s.replace(old, new, 1)
elif 'INSERT INTO phone_contacts' not in s:
    raise SystemExit('upsertCall marker not found')

# Caller memory helper. Manual memory is intentionally separate from assistant replies.
marker = "function customParameters(start = {}) {\n"
if 'async function callerMemoryForNumber' not in s:
    addition = """async function callerMemoryForNumber(env, phoneNumber = '') {\n  const number = clean(phoneNumber, 80);\n  if (!number || !(await ensureSchema(env))) return '';\n  const row = await env.TALKSYS_LOG_DB.prepare('SELECT display_name, memory FROM phone_contacts WHERE phone_number=?').bind(number).first();\n  if (!row) return '';\n  const parts = [];\n  const displayName = clean(row.display_name, 120);\n  const memory = clean(row.memory, 2400);\n  if (displayName) parts.push(`利用者名: ${displayName}`);\n  if (memory) parts.push(`保存メモ: ${memory}`);\n  return clean(parts.join('\\n'), 2600);\n}\n\n"""
    if marker not in s:
        raise SystemExit('customParameters marker not found')
    s = s.replace(marker, addition + marker, 1)

# Pass caller memory into the shared TalkSys turn without changing the phone media path.
old = "async function answerWithTalkSys(deps, text, history, signal, spokenBackchannel = '', sessionId = '', utteranceId = '') {"
new = "async function answerWithTalkSys(deps, text, history, signal, spokenBackchannel = '', sessionId = '', utteranceId = '', callerMemory = '') {"
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('answerWithTalkSys signature marker not found')

old = "const payload = await deps.turn({ text: current, history: priorHistory, channel: 'phone', sessionId: clean(sessionId, 200), utteranceId: clean(utteranceId, 200), spokenBackchannel }, signal);"
new = "const payload = await deps.turn({ text: current, history: priorHistory, channel: 'phone', sessionId: clean(sessionId, 200), utteranceId: clean(utteranceId, 200), spokenBackchannel, callerMemory: clean(callerMemory, 2600) }, signal);"
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('TalkSys turn payload marker not found')

old = "  const pendingTasks=new Set(), hpState={prevX:0,prevY:0};\n"
new = old + "  let callerMemoryPromise=Promise.resolve('');\n"
if 'callerMemoryPromise' not in s:
    if old not in s:
        raise SystemExit('pendingTasks marker not found')
    s = s.replace(old, new, 1)

old = "await upsertCall(env,{callId,from,to,status:'active'});const greeting="
new = "await upsertCall(env,{callId,from,to,status:'active'});callerMemoryPromise=callerMemoryForNumber(env,from).catch(()=> '');const greeting="
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('media start upsert marker not found')

old = "const turnPromise=answerWithTalkSys(deps,stt.text,history,controller.signal,spokenBackchannel,callId,turnId);"
new = "const callerMemory=await callerMemoryPromise;const turnPromise=answerWithTalkSys(deps,stt.text,history,controller.signal,spokenBackchannel,callId,turnId,callerMemory);"
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('turnPromise marker not found')

# Admin API returns contact name/memory alongside the call while keeping calls grouped by caller number in the UI.
old = "const result = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_calls ORDER BY updated_at DESC LIMIT 100').all();"
new = "const result = await env.TALKSYS_LOG_DB.prepare(`SELECT c.*, COALESCE(p.display_name, '') AS display_name FROM phone_calls c LEFT JOIN phone_contacts p ON p.phone_number=c.from_number ORDER BY c.updated_at DESC LIMIT 100`).all();"
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('listCalls query marker not found')

old = "const call = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_calls WHERE call_id=?').bind(callId).first();"
new = "const call = await env.TALKSYS_LOG_DB.prepare(`SELECT c.*, COALESCE(p.display_name, '') AS display_name, COALESCE(p.memory, '') AS memory FROM phone_calls c LEFT JOIN phone_contacts p ON p.phone_number=c.from_number WHERE c.call_id=?`).bind(callId).first();"
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('callMessages query marker not found')

# Contact editor endpoint.
marker = "async function callLatency(request, env, callId) {\n"
if 'async function updatePhoneContact' not in s:
    addition = """async function updatePhoneContact(request, env, phoneNumber) {\n  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);\n  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);\n  const number = clean(phoneNumber, 80);\n  if (!number) return json({ ok: false, error: 'phone_number_required' }, 400);\n  let body = {};\n  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }\n  const displayName = clean(body?.displayName ?? body?.display_name ?? '', 120);\n  const memory = clean(body?.memory ?? '', 2400);\n  const now = new Date().toISOString();\n  await env.TALKSYS_LOG_DB.prepare(`INSERT INTO phone_contacts\n    (phone_number, display_name, memory, created_at, updated_at) VALUES (?, ?, ?, ?, ?)\n    ON CONFLICT(phone_number) DO UPDATE SET display_name=excluded.display_name, memory=excluded.memory, updated_at=excluded.updated_at`)\n    .bind(number, displayName, memory, now, now).run();\n  return json({ ok: true, phoneNumber: number, displayName, memory, revision: PHONE_CONTACT_MEMORY_REVISION });\n}\n\n"""
    if marker not in s:
        raise SystemExit('callLatency marker not found')
    s = s.replace(marker, addition + marker, 1)

# Management UI: group calls by caller number and edit persistent name/memory.
s = s.replace('button,input{font:inherit}', 'button,input,textarea{font:inherit}', 1)
s = s.replace('input{background:#0b0e14;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:9px;width:min(380px,75vw)}', 'input,textarea{background:#0b0e14;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:9px;width:min(520px,90%)}textarea{min-height:92px;resize:vertical}.contactGroup{border:1px solid #283245;border-radius:10px;margin:10px 0;overflow:hidden}.contactHead{padding:10px 12px;background:#171e2b}', 1)

old = '<div class="panel"><div class="top"><h2 id="conversationTitle">会話内容</h2><button id="exportBtn" class="hidden">JSONL保存</button></div><div id="messages" class="muted">左の着信を選択してください。</div>'
new = '<div class="panel"><div class="top"><h2 id="conversationTitle">会話内容</h2><button id="exportBtn" class="hidden">JSONL保存</button></div><div id="contactEditor" class="hidden"><div class="meta">電話番号は本人確認ではありません。秘密情報は保存しないでください。</div><p><input id="contactName" placeholder="表示名"></p><p><textarea id="contactMemory" placeholder="この番号の利用者について覚えておくこと"></textarea></p><button id="saveContactBtn">名前・メモを保存</button><span id="contactSaveState" class="meta"></span></div><div id="messages" class="muted">左の着信を選択してください。</div>'
if old in s:
    s = s.replace(old, new, 1)
elif 'id="contactEditor"' not in s:
    raise SystemExit('dashboard conversation panel marker not found')

old = "let adminToken=sessionStorage.getItem('talksysPhoneToken')||'';let selected='';const auth=()=>({'authorization':'Bearer '+adminToken});"
new = "let adminToken=sessionStorage.getItem('talksysPhoneToken')||'';let selected='',selectedNumber='';const auth=()=>({'authorization':'Bearer '+adminToken});"
if old in s:
    s = s.replace(old, new, 1)
elif "selectedNumber=''" not in s:
    raise SystemExit('dashboard selected marker not found')

old = "async function refreshCalls(){const d=await api('/phone/api/calls');const root=document.getElementById('calls');root.innerHTML=d.calls.length?d.calls.map(c=>'<div class=\"call\" data-id=\"'+esc(c.call_id)+'\"><div class=\"num\">'+esc(c.from_number||'番号不明')+' → '+esc(c.to_number||'着信番号不明')+'</div><div class=\"meta\">'+esc(c.status)+' / '+esc(c.started_at)+' / '+c.message_count+'件</div><div class=\"meta\">'+esc(c.last_user_text||c.last_assistant_text||'会話待ち')+'</div></div>').join(''):'<div class=\"muted\">まだ着信はありません。</div>';root.querySelectorAll('.call').forEach(x=>x.onclick=()=>loadMessages(x.dataset.id));}"
new = "async function refreshCalls(){const d=await api('/phone/api/calls');const root=document.getElementById('calls');const groups=new Map();for(const c of d.calls||[]){const key=c.from_number||'番号不明';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c)}root.innerHTML=groups.size?[...groups.entries()].map(([num,calls])=>{const name=calls.find(c=>c.display_name)?.display_name||'';return '<div class=\"contactGroup\"><div class=\"contactHead\"><div class=\"num\">'+esc(name?name+' / '+num:num)+'</div><div class=\"meta\">'+calls.length+' 通話</div></div>'+calls.map(c=>'<div class=\"call\" data-id=\"'+esc(c.call_id)+'\"><div class=\"meta\">'+esc(c.status)+' / '+esc(c.started_at)+' / '+c.message_count+'件</div><div class=\"meta\">'+esc(c.last_user_text||c.last_assistant_text||'会話待ち')+'</div></div>').join('')+'</div>'}).join(''):'<div class=\"muted\">まだ着信はありません。</div>';root.querySelectorAll('.call').forEach(x=>x.onclick=()=>loadMessages(x.dataset.id));}"
if old in s:
    s = s.replace(old, new, 1)
elif 'const groups=new Map()' not in s:
    raise SystemExit('refreshCalls marker not found')

old = "async function loadMessages(id){selected=id;const base='/phone/api/calls/'+encodeURIComponent(id);const [d,l]=await Promise.all([api(base+'/messages'),api(base+'/latency')]);document.getElementById('conversationTitle').textContent=(d.call?.from_number||'番号不明')+' の会話';document.getElementById('exportBtn').classList.remove('hidden');document.getElementById('messages').innerHTML=d.messages.length?d.messages.map(m=>'<div class=\"msg '+m.role+'\"><div class=\"role\">'+(m.role==='user'?'発信者':'TalkSys')+' / '+esc(m.created_at)+'</div>'+esc(m.content)+'</div>').join(''):'<div class=\"muted\">会話はまだありません。</div>';renderLatency(l.events||[])}"
new = "async function loadMessages(id){selected=id;const base='/phone/api/calls/'+encodeURIComponent(id);const [d,l]=await Promise.all([api(base+'/messages'),api(base+'/latency')]);selectedNumber=d.call?.from_number||'';document.getElementById('conversationTitle').textContent=(d.call?.display_name?d.call.display_name+' / ':'')+(selectedNumber||'番号不明')+' の会話';document.getElementById('exportBtn').classList.remove('hidden');const editor=document.getElementById('contactEditor');editor.classList.toggle('hidden',!selectedNumber);document.getElementById('contactName').value=d.call?.display_name||'';document.getElementById('contactMemory').value=d.call?.memory||'';document.getElementById('contactSaveState').textContent='';document.getElementById('messages').innerHTML=d.messages.length?d.messages.map(m=>'<div class=\"msg '+m.role+'\"><div class=\"role\">'+(m.role==='user'?'発信者':'TalkSys')+' / '+esc(m.created_at)+'</div>'+esc(m.content)+'</div>').join(''):'<div class=\"muted\">会話はまだありません。</div>';renderLatency(l.events||[])}"
if old in s:
    s = s.replace(old, new, 1)
elif 'selectedNumber=d.call?.from_number' not in s:
    raise SystemExit('loadMessages marker not found')

marker = "  async function downloadExport(){if(!selected)return;"
if 'async function saveContact()' not in s:
    addition = "  async function saveContact(){if(!selectedNumber)return;const body={displayName:document.getElementById('contactName').value,memory:document.getElementById('contactMemory').value};const r=await fetch('/phone/api/contacts/'+encodeURIComponent(selectedNumber),{method:'PUT',headers:{...auth(),'content-type':'application/json'},body:JSON.stringify(body)});if(r.status===401)throw new Error('認証に失敗しました');const d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw new Error(d.error||'メモの保存に失敗しました');document.getElementById('contactSaveState').textContent=' 保存しました';await refreshCalls()}\n"
    if marker not in s:
        raise SystemExit('downloadExport marker not found')
    s = s.replace(marker, addition + marker, 1)

old = "document.getElementById('loginBtn').onclick=()=>{adminToken=document.getElementById('token').value;sessionStorage.setItem('talksysPhoneToken',adminToken);start()};document.getElementById('exportBtn').onclick=()=>downloadExport().catch(e=>alert(e.message));document.getElementById('batchExportBtn').onclick=()=>downloadBatchExport().catch(e=>alert(e.message));if(adminToken)start();"
new = "document.getElementById('loginBtn').onclick=()=>{adminToken=document.getElementById('token').value;sessionStorage.setItem('talksysPhoneToken',adminToken);start()};document.getElementById('saveContactBtn').onclick=()=>saveContact().catch(e=>alert(e.message));document.getElementById('exportBtn').onclick=()=>downloadExport().catch(e=>alert(e.message));document.getElementById('batchExportBtn').onclick=()=>downloadBatchExport().catch(e=>alert(e.message));if(adminToken)start();"
if old in s:
    s = s.replace(old, new, 1)
elif "saveContactBtn').onclick" not in s:
    raise SystemExit('dashboard onclick marker not found')

# ZIP route bug: the handler existed but the path gate rejected it before dispatch.
old = "  return pathname === '/phone' || pathname === '/telephony-health' || pathname === '/phone/api/calls'\n"
new = "  return pathname === '/phone' || pathname === '/telephony-health' || pathname === '/phone/api/calls' || pathname === '/phone/api/calls/export.zip'\n"
if old in s:
    s = s.replace(old, new, 1)
elif "pathname === '/phone/api/calls/export.zip'" not in s:
    raise SystemExit('isTelephonyPath ZIP marker not found')

old = "    || /^\\/phone\\/api\\/calls\\/[^/]+\\/export\\.jsonl$/.test(pathname)\n    || pathname === '/telnyx/voice'"
new = "    || /^\\/phone\\/api\\/calls\\/[^/]+\\/export\\.jsonl$/.test(pathname) || /^\\/phone\\/api\\/contacts\\/[^/]+$/.test(pathname)\n    || pathname === '/telnyx/voice'"
if old in s:
    s = s.replace(old, new, 1)
elif '/phone\\/api\\/contacts' not in s:
    raise SystemExit('isTelephonyPath contact marker not found')

old = "  if(request.method==='GET'&&url.pathname==='/phone/api/calls')return listCalls(request,env);\n"
new = old + "  const contactMatch=url.pathname.match(/^\\/phone\\/api\\/contacts\\/([^/]+)$/);if(request.method==='PUT'&&contactMatch)return updatePhoneContact(request,env,decodeURIComponent(contactMatch[1]));\n"
if 'const contactMatch=' not in s:
    if old not in s:
        raise SystemExit('contact route insertion marker not found')
    s = s.replace(old, new, 1)

telephony.write_text(s, encoding='utf-8')

# --- Shared TalkSys: treat caller memory as personalization only, never as external-fact evidence. ---
integrated = Path('src/integrated-entry.js')
s = integrated.read_text(encoding='utf-8')

old = "export function buildTalkSysSystemInstruction(now = new Date(), { forceSearch = false, immediateTransit = false, verificationContinuation = false } = {}) {\n"
new = "export function buildTalkSysSystemInstruction(now = new Date(), { forceSearch = false, immediateTransit = false, verificationContinuation = false, callerMemory = '' } = {}) {\n  const callerMemoryText = compact(callerMemory, 2400);\n"
if old in s:
    s = s.replace(old, new, 1)
elif 'callerMemoryText = compact(callerMemory' not in s:
    raise SystemExit('buildTalkSysSystemInstruction signature marker not found')

old = "    'あなたはTalkSysの日本語音声アシスタント、フォーンズです。回答はそのまま電話で読み上げます。',\n"
new = old + "    ...(callerMemoryText ? [`この電話番号に保存された利用者メモがあります。会話を自然に個人向けにするためだけに使ってください。現在の利用者発言と矛盾する場合は現在の発言を優先し、このメモを外部事実の根拠・本人確認・認証には使わないでください。必要がない限りメモの存在自体を読み上げないでください。\\n${callerMemoryText}`] : []),\n"
if 'この電話番号に保存された利用者メモがあります' not in s:
    if old not in s:
        raise SystemExit('system instruction insertion marker not found')
    s = s.replace(old, new, 1)

old = "parts: [{ text: buildTalkSysSystemInstruction(now, { forceSearch, immediateTransit, verificationContinuation }) }],"
new = "parts: [{ text: buildTalkSysSystemInstruction(now, { forceSearch, immediateTransit, verificationContinuation, callerMemory: compact(statelessBody?.callerMemory, 2400) }) }],"
if old in s:
    s = s.replace(old, new, 1)
elif 'callerMemory: compact(statelessBody?.callerMemory' not in s:
    raise SystemExit('generateContent systemInstruction marker not found')

old = "system_instruction: buildTalkSysSystemInstruction(now, { forceSearch, immediateTransit, verificationContinuation }),"
new = "system_instruction: buildTalkSysSystemInstruction(now, { forceSearch, immediateTransit, verificationContinuation, callerMemory: compact(inputBody?.callerMemory, 2400) }),"
if old in s:
    s = s.replace(old, new, 1)
elif 'callerMemory: compact(inputBody?.callerMemory' not in s:
    raise SystemExit('Interactions system instruction marker not found')

integrated.write_text(s, encoding='utf-8')

# Focused regression tests.
test = Path('tests/phone-contact-memory-v113.test.mjs')
test.write_text("""import test from 'node:test';\nimport assert from 'node:assert/strict';\n\nimport { isTelephonyPath, PHONE_CONTACT_MEMORY_REVISION } from '../src/telephony/index.js';\nimport { buildTalkSysSystemInstruction } from '../src/integrated-entry.js';\n\ntest('phone ZIP export route passes the telephony path gate', () => {\n  assert.equal(isTelephonyPath('/phone/api/calls/export.zip'), true);\n});\n\ntest('phone contact update route passes the telephony path gate', () => {\n  assert.equal(isTelephonyPath('/phone/api/contacts/%2B818012345678'), true);\n  assert.match(PHONE_CONTACT_MEMORY_REVISION, /v113/);\n});\n\ntest('caller memory is included as personalization but explicitly not authentication or external evidence', () => {\n  const instruction = buildTalkSysSystemInstruction(new Date('2026-10-11T05:00:00Z'), {\n    callerMemory: '利用者名: 田中\\n保存メモ: ラジオが好き。',\n  });\n  assert.match(instruction, /田中/);\n  assert.match(instruction, /ラジオが好き/);\n  assert.match(instruction, /外部事実の根拠/);\n  assert.match(instruction, /本人確認/);\n});\n""", encoding='utf-8')

print('phone contacts/memory v113 patch applied')

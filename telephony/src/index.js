import { pcmuBase64ToSamples, rmsOfSamples, samplesToWav } from './codec.js';
import { buildTexml, clampInt, clean, flag, xmlEscape } from './protocol.js';

export const TELEPHONY_REVISION = 'talksys-telephony-v0.3-talksys-gateway';
const FRAME_MS = 20;
let schemaPromise;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function enabled(env) {
  return flag(env?.TELEPHONY_ENABLED, false);
}

function sharedToken(env) {
  return typeof env?.TELEPHONY_SHARED_TOKEN === 'string' ? env.TELEPHONY_SHARED_TOKEN.trim() : '';
}

function adminToken(env) {
  const dedicated = typeof env?.TELEPHONY_ADMIN_TOKEN === 'string' ? env.TELEPHONY_ADMIN_TOKEN.trim() : '';
  return dedicated || sharedToken(env);
}

function tokenAuthorized(request, env) {
  const expected = sharedToken(env);
  if (!expected) return false;
  const supplied = new URL(request.url).searchParams.get('token') || '';
  return supplied.length === expected.length && supplied === expected;
}

function adminAuthorized(request, env) {
  const expected = adminToken(env);
  if (!expected) return false;
  const header = request.headers.get('authorization') || '';
  const supplied = header.replace(/^Bearer\s+/i, '');
  return supplied.length === expected.length && supplied === expected;
}

function talksysBase(env) {
  return String(env?.TALKSYS_BASE_URL || 'https://talksys.syouziroupc.workers.dev').replace(/\/+$/, '');
}

function publicBaseUrl(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

async function requestParams(request) {
  const url = new URL(request.url);
  const out = new URLSearchParams(url.searchParams);
  if (request.method === 'POST') {
    const type = request.headers.get('content-type') || '';
    if (type.includes('application/x-www-form-urlencoded')) {
      const body = new URLSearchParams(await request.text());
      for (const [key, value] of body.entries()) out.set(key, value);
    }
  }
  return out;
}

async function messageText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data.text === 'function') return data.text();
  return String(data ?? '');
}

function closeSocket(socket, code = 1000, reason = 'closed') {
  try {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close(code, reason.slice(0, 120));
  } catch {}
}

async function ensureSchema(env) {
  if (!env?.TALKSYS_LOG_DB) return false;
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await env.TALKSYS_LOG_DB.prepare(`CREATE TABLE IF NOT EXISTS phone_calls (
        call_id TEXT PRIMARY KEY,
        from_number TEXT,
        to_number TEXT,
        status TEXT NOT NULL DEFAULT 'starting',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        last_user_text TEXT,
        last_assistant_text TEXT,
        message_count INTEGER NOT NULL DEFAULT 0
      )`).run();
      await env.TALKSYS_LOG_DB.prepare(`CREATE TABLE IF NOT EXISTS phone_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`).run();
      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_phone_messages_call ON phone_messages(call_id, id)').run();
      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_phone_calls_updated ON phone_calls(updated_at DESC)').run();
      return true;
    })().catch((error) => {
      schemaPromise = undefined;
      console.error('telephony_schema_error', error);
      return false;
    });
  }
  return schemaPromise;
}

async function upsertCall(env, { callId, from = '', to = '', status = 'starting' }) {
  if (!callId || !(await ensureSchema(env))) return;
  const now = new Date().toISOString();
  await env.TALKSYS_LOG_DB.prepare(`INSERT INTO phone_calls
    (call_id, from_number, to_number, status, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_id) DO UPDATE SET
      from_number=CASE WHEN excluded.from_number<>'' THEN excluded.from_number ELSE phone_calls.from_number END,
      to_number=CASE WHEN excluded.to_number<>'' THEN excluded.to_number ELSE phone_calls.to_number END,
      status=excluded.status,
      updated_at=excluded.updated_at`).bind(callId, from, to, status, now, now).run();
}

async function setCallStatus(env, callId, status) {
  if (!callId || !(await ensureSchema(env))) return;
  const now = new Date().toISOString();
  const ended = status === 'ended' || status === 'error' ? now : null;
  await env.TALKSYS_LOG_DB.prepare('UPDATE phone_calls SET status=?, updated_at=?, ended_at=COALESCE(?, ended_at) WHERE call_id=?')
    .bind(status, now, ended, callId).run();
}

async function appendMessage(env, callId, role, content) {
  const text = clean(content, 12000);
  if (!callId || !text || !(await ensureSchema(env))) return;
  const now = new Date().toISOString();
  await env.TALKSYS_LOG_DB.batch([
    env.TALKSYS_LOG_DB.prepare('INSERT INTO phone_messages (call_id, role, content, created_at) VALUES (?, ?, ?, ?)').bind(callId, role, text, now),
    env.TALKSYS_LOG_DB.prepare(`UPDATE phone_calls SET
      updated_at=?, message_count=message_count+1,
      last_user_text=CASE WHEN ?='user' THEN ? ELSE last_user_text END,
      last_assistant_text=CASE WHEN ?='assistant' THEN ? ELSE last_assistant_text END
      WHERE call_id=?`).bind(now, role, text, role, text, callId),
  ]);
}

function customParameters(start = {}) {
  const raw = start.custom_parameters || start.customParameters || start.parameters || {};
  if (Array.isArray(raw)) {
    const out = {};
    for (const item of raw) if (item?.name) out[item.name] = item.value || '';
    return out;
  }
  return raw && typeof raw === 'object' ? raw : {};
}

async function callTalkSys(env, path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('talksys_timeout'), clampInt(env?.TALKSYS_REQUEST_TIMEOUT_MS, 45000, 5000, 90000));
  try {
    return await fetch(`${talksysBase(env)}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function transcribeWithTalkSys(env, samples) {
  const wav = samplesToWav(samples, 8000);
  const response = await callTalkSys(env, '/api/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'audio/wav', 'x-talksys-source': 'telnyx' },
    body: wav,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true || !payload?.text) return { ok: false, error: payload?.error || `stt_${response.status}` };
  return { ok: true, text: clean(payload.text, 1800), meta: payload };
}

async function answerWithTalkSys(env, text, history) {
  const response = await callTalkSys(env, '/api/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-talksys-source': 'telnyx' },
    body: JSON.stringify({ text, history: history.slice(-16), channel: 'phone' }),
  });
  const payload = await response.json().catch(() => ({}));
  const answer = clean(payload?.answer || payload?.response || payload?.text || '', 9000);
  if (!response.ok || !answer) return { ok: false, error: payload?.error || `turn_${response.status}` };
  return { ok: true, answer, payload };
}

function dashboardHtml(request) {
  const base = publicBaseUrl(request);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TalkSys 電話管理</title><style>
  :root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:dark;background:#0b0e14;color:#f3f6fb}body{margin:0}.wrap{max-width:1100px;margin:auto;padding:28px 18px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.sub,.muted{color:#98a5b7}.panel{border:1px solid #293243;background:#121722;border-radius:14px;padding:16px;margin-top:16px}.grid{display:grid;grid-template-columns:minmax(310px,.9fr) minmax(360px,1.4fr);gap:14px}@media(max-width:800px){.grid{grid-template-columns:1fr}}button,input{font:inherit}button{background:#202a3a;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:8px 12px;cursor:pointer}input{background:#0b0e14;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:9px;width:min(380px,75vw)}.call{padding:12px;border-bottom:1px solid #283245;cursor:pointer}.call:hover{background:#171e2b}.num{font-weight:700}.meta{font-size:12px;color:#91a0b5;margin-top:4px}.msg{margin:10px 0;padding:10px 12px;border-radius:10px;white-space:pre-wrap}.user{background:#1b2b3a}.assistant{background:#25213a}.role{font-size:11px;color:#9ca8ba;margin-bottom:5px}.status{font-size:13px}.warn{color:#ffca72}.ok{color:#7dd69a}code{font-size:12px}.hidden{display:none}
  </style></head><body><main class="wrap"><div class="top"><div><h1>TalkSys 電話管理</h1><div class="sub">Telnyxの着信を既存TalkSysへ接続する一時ゲートウェイ</div></div><div><a href="${xmlEscape(base)}/telephony-health" style="color:#a8c7ff">状態JSON</a></div></div>
  <section id="login" class="panel"><b>管理トークン</b><p class="muted">通話番号と会話内容を表示するため認証が必要です。</p><input id="token" type="password" autocomplete="current-password"><button id="loginBtn">表示</button><div id="loginErr" class="warn"></div></section>
  <section id="app" class="hidden"><div class="panel"><div id="health">状態確認中...</div></div><div class="grid"><div class="panel"><h2>着信一覧</h2><div id="calls"></div></div><div class="panel"><h2 id="conversationTitle">会話内容</h2><div id="messages" class="muted">左の着信を選択してください。</div></div></div></section>
  </main><script>
  let adminToken=sessionStorage.getItem('talksysPhoneToken')||'';let selected='';
  const auth=()=>({'authorization':'Bearer '+adminToken});
  async function api(path){const r=await fetch(path,{headers:auth(),cache:'no-store'});if(r.status===401)throw new Error('認証に失敗しました');return r.json()}
  async function refreshHealth(){const h=await fetch('/telephony-health',{cache:'no-store'}).then(r=>r.json());document.getElementById('health').innerHTML='電話受付: <b class="'+(h.enabled?'ok':'warn')+'">'+(h.enabled?'有効':'無効')+'</b> / TalkSys接続先: <code>'+h.talksysBase+'</code> / 回答モデル: <b>'+h.answerEngine+'</b> / 保存: <b>'+h.storageMode+'</b>'}
  async function refreshCalls(){const d=await api('/api/calls');const root=document.getElementById('calls');root.innerHTML=d.calls.length?d.calls.map(c=>'<div class="call" data-id="'+esc(c.call_id)+'"><div class="num">'+esc(c.from_number||'番号不明')+' → '+esc(c.to_number||'着信番号不明')+'</div><div class="meta">'+esc(c.status)+' / '+esc(c.started_at)+' / '+c.message_count+'件</div><div class="meta">'+esc(c.last_user_text||c.last_assistant_text||'会話待ち')+'</div></div>').join(''):'<div class="muted">まだ着信はありません。</div>';root.querySelectorAll('.call').forEach(x=>x.onclick=()=>loadMessages(x.dataset.id));}
  async function loadMessages(id){selected=id;const d=await api('/api/calls/'+encodeURIComponent(id)+'/messages');document.getElementById('conversationTitle').textContent=(d.call?.from_number||'番号不明')+' の会話';document.getElementById('messages').innerHTML=d.messages.length?d.messages.map(m=>'<div class="msg '+m.role+'"><div class="role">'+(m.role==='user'?'発信者':'TalkSys')+' / '+esc(m.created_at)+'</div>'+esc(m.content)+'</div>').join(''):'<div class="muted">会話はまだありません。</div>'}
  function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
  async function start(){try{await api('/api/calls');document.getElementById('login').classList.add('hidden');document.getElementById('app').classList.remove('hidden');await refreshHealth();await refreshCalls();setInterval(async()=>{try{await refreshCalls();if(selected)await loadMessages(selected)}catch{}},3000)}catch(e){document.getElementById('loginErr').textContent=e.message}}
  document.getElementById('loginBtn').onclick=()=>{adminToken=document.getElementById('token').value;sessionStorage.setItem('talksysPhoneToken',adminToken);start()};if(adminToken)start();
  </script></body></html>`;
}

function health(request, env) {
  return json({
    ok: true,
    revision: TELEPHONY_REVISION,
    role: 'temporary-telnyx-to-talksys-gateway',
    future: 'merge-into-main-talksys-and-remove-this-worker',
    enabled: enabled(env),
    tokenConfigured: Boolean(sharedToken(env)),
    adminTokenConfigured: Boolean(adminToken(env)),
    talksysBase: talksysBase(env),
    answerEngine: '既存TalkSys / Gemini 3.5 Flash-Lite',
    directGeminiLive: false,
    directAnswerModel: false,
    storageMode: env?.TALKSYS_LOG_DB ? '既存TalkSys D1（通話一覧・会話表示のみ）' : 'disabled',
    recording: false,
    concurrency: '1通話=1独立WebSocket。回答処理は既存TalkSysへ委譲。',
    outputAudioStatus: 'pending-tts-transport-adapter',
    routes: { management: '/phone', health: '/telephony-health', voice: '/telnyx/voice', media: '/telnyx/media' },
    origin: publicBaseUrl(request),
  });
}

async function listCalls(request, env) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const result = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_calls ORDER BY updated_at DESC LIMIT 100').all();
  return json({ ok: true, calls: result.results || [] });
}

async function callMessages(request, env, callId) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const call = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_calls WHERE call_id=?').bind(callId).first();
  const messages = await env.TALKSYS_LOG_DB.prepare('SELECT role, content, created_at FROM phone_messages WHERE call_id=? ORDER BY id ASC LIMIT 500').bind(callId).all();
  return json({ ok: true, call, messages: messages.results || [] });
}

async function texmlResponse(request, env) {
  if (!enabled(env)) return new Response('telephony_disabled', { status: 503 });
  if (!sharedToken(env)) return new Response('telephony_shared_token_missing', { status: 503 });
  if (!tokenAuthorized(request, env)) return new Response('unauthorized', { status: 401 });
  const params = await requestParams(request);
  const callId = clean(params.get('CallSid') || params.get('call_sid') || crypto.randomUUID(), 200);
  const from = clean(params.get('From') || params.get('from') || '', 80);
  const to = clean(params.get('To') || params.get('to') || '', 80);
  await upsertCall(env, { callId, from, to, status: 'connecting' });
  const url = new URL(request.url);
  const xml = buildTexml({ host: url.host, protocol: url.protocol, token: sharedToken(env), callSid: callId, from, to });
  return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' } });
}

async function streamStatus(request, env) {
  if (!tokenAuthorized(request, env)) return new Response('unauthorized', { status: 401 });
  const params = await requestParams(request).catch(() => new URLSearchParams());
  const event = clean(params.get('StreamEvent') || params.get('Event') || params.get('event') || 'unknown', 80);
  const callId = clean(params.get('CallSid') || params.get('call_sid') || '', 200);
  if (callId && /stop|disconnect|end|fail|error/i.test(event)) await setCallStatus(env, callId, /fail|error/i.test(event) ? 'error' : 'ended');
  console.log(JSON.stringify({ type: 'telnyx_stream_status', event, callId: callId ? 'present' : 'missing', revision: TELEPHONY_REVISION }));
  return new Response(null, { status: 204 });
}

function mediaBridge(request, env) {
  if (!enabled(env)) return new Response('telephony_disabled', { status: 503 });
  if (!tokenAuthorized(request, env)) return new Response('unauthorized', { status: 401 });
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return new Response('Expected Upgrade: websocket', { status: 426 });

  const pair = new WebSocketPair();
  const [client, telnyx] = Object.values(pair);
  telnyx.accept();

  const speechThreshold = Number(env?.TELEPHONY_VAD_RMS || 0.008);
  const silenceMs = clampInt(env?.TELEPHONY_END_SILENCE_MS, 700, 300, 2000);
  const minSpeechMs = clampInt(env?.TELEPHONY_MIN_SPEECH_MS, 320, 200, 2000);
  const maxUtteranceMs = clampInt(env?.TELEPHONY_MAX_UTTERANCE_MS, 15000, 3000, 30000);
  const sessionMaxMs = clampInt(env?.TELEPHONY_SESSION_MAX_MINUTES, 30, 5, 180) * 60000;
  const history = [];
  let callId = '';
  let from = '';
  let to = '';
  let speechActive = false;
  let silentFor = 0;
  let speechFrames = [];
  let preRoll = [];
  let processing = Promise.resolve();
  let closed = false;

  const finishUtterance = () => {
    if (!speechActive || !speechFrames.length) return;
    const frames = speechFrames;
    speechActive = false;
    silentFor = 0;
    speechFrames = [];
    preRoll = [];
    const samples = Int16Array.from(frames.flatMap(frame => Array.from(frame)));
    const durationMs = samples.length / 8;
    if (durationMs < minSpeechMs) return;
    processing = processing.then(async () => {
      try {
        const stt = await transcribeWithTalkSys(env, samples);
        if (!stt.ok || !stt.text) return;
        await appendMessage(env, callId, 'user', stt.text);
        const prior = history.slice(-16);
        const turn = await answerWithTalkSys(env, stt.text, prior);
        history.push({ role: 'user', content: stt.text });
        if (!turn.ok) {
          await appendMessage(env, callId, 'assistant', `［TalkSys応答エラー: ${clean(turn.error, 200)}］`);
          return;
        }
        history.push({ role: 'assistant', content: turn.answer });
        await appendMessage(env, callId, 'assistant', turn.answer);
        console.log(JSON.stringify({ type: 'talksys_phone_turn', callId: callId ? 'present' : 'missing', userChars: stt.text.length, answerChars: turn.answer.length }));
        // 応答音声の電話回線への返送は別アダプタ。回答生成そのものは既存TalkSysに完全委譲する。
      } catch (error) {
        console.error(JSON.stringify({ type: 'talksys_phone_turn_error', error: clean(error?.message || error, 240) }));
      }
    });
  };

  const deadline = setTimeout(() => {
    if (!closed) closeSocket(telnyx, 1000, 'session_limit');
  }, sessionMaxMs);

  telnyx.addEventListener('message', async (event) => {
    let message;
    try { message = JSON.parse(await messageText(event.data)); } catch { return; }
    if (message?.event === 'start') {
      const start = message.start || {};
      const params = customParameters(start);
      callId = clean(params.call_sid || start.call_sid || start.callSid || crypto.randomUUID(), 200);
      from = clean(params.from || start.from || '', 80);
      to = clean(params.to || start.to || '', 80);
      await upsertCall(env, { callId, from, to, status: 'active' });
      return;
    }
    if (message?.event === 'media' && message?.media?.payload) {
      const samples = pcmuBase64ToSamples(message.media.payload);
      const rms = rmsOfSamples(samples);
      if (rms >= speechThreshold) {
        if (!speechActive) {
          speechActive = true;
          speechFrames = [...preRoll];
          preRoll = [];
        }
        speechFrames.push(samples);
        silentFor = 0;
      } else if (speechActive) {
        speechFrames.push(samples);
        silentFor += FRAME_MS;
        const durationMs = speechFrames.length * FRAME_MS;
        if (silentFor >= silenceMs || durationMs >= maxUtteranceMs) finishUtterance();
      } else {
        preRoll.push(samples);
        if (preRoll.length > 10) preRoll.shift();
      }
      return;
    }
    if (message?.event === 'stop') {
      finishUtterance();
      await processing.catch(() => {});
      await setCallStatus(env, callId, 'ended');
      closeSocket(telnyx, 1000, 'telnyx_stopped');
    }
  });

  telnyx.addEventListener('error', async () => {
    await setCallStatus(env, callId, 'error');
    closeSocket(telnyx, 1011, 'telnyx_error');
  });
  telnyx.addEventListener('close', async () => {
    closed = true;
    clearTimeout(deadline);
    finishUtterance();
    await processing.catch(() => {});
    await setCallStatus(env, callId, 'ended');
  });

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return Response.redirect(`${url.origin}/phone`, 302);
    if (request.method === 'GET' && url.pathname === '/phone') return new Response(dashboardHtml(request), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    if (request.method === 'GET' && url.pathname === '/telephony-health') return health(request, env);
    if (request.method === 'GET' && url.pathname === '/api/calls') return listCalls(request, env);
    const messageMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/messages$/);
    if (request.method === 'GET' && messageMatch) return callMessages(request, env, decodeURIComponent(messageMatch[1]));
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/telnyx/voice') return texmlResponse(request, env);
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/telnyx/stream-status') return streamStatus(request, env);
    if (request.method === 'GET' && url.pathname === '/telnyx/media') return mediaBridge(request, env);
    return new Response('Not Found', { status: 404 });
  },
};

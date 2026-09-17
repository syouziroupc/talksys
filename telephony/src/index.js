import { bytesToBase64, pcm16Base64ToPcmu8k, pcmuBase64ToPcm16kBase64 } from './codec.js';
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_LIVE_ENDPOINT,
  buildGeminiSetup,
  buildTexml,
  clampInt,
  clean,
  flag,
  xmlEscape,
} from './protocol.js';

export const TELEPHONY_REVISION = 'talksys-telephony-v0.2-concurrent-cost-guard';
const PCM_U_SILENCE = 0xff;
const TELNYX_MIN_AUDIO_BYTES = 160;

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

function geminiKey(env) {
  return typeof env?.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
}

function tokenAuthorized(request, env) {
  const expected = sharedToken(env);
  if (!expected) return false;
  const supplied = new URL(request.url).searchParams.get('token') || '';
  return supplied.length === expected.length && supplied === expected;
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

function safeSend(socket, payload) {
  if (socket && socket.readyState === 1) socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function closeSocket(socket, code = 1000, reason = 'closed') {
  try {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close(code, reason.slice(0, 120));
  } catch {}
}

async function messageText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data.text === 'function') return data.text();
  return String(data ?? '');
}

function dashboardHtml(request, env) {
  const base = publicBaseUrl(request);
  const model = clean(env?.GEMINI_LIVE_MODEL || DEFAULT_GEMINI_MODEL, 100);
  const browserUrl = clean(env?.BROWSER_TALKSYS_URL || 'https://talksys.syouziroupc.workers.dev', 500);
  const maxMinutes = clampInt(env?.TELEPHONY_SESSION_MAX_MINUTES, 30, 5, 180);
  const transcription = flag(env?.TELEPHONY_TRANSCRIPTION, false);
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TalkSys Phone</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:dark;background:#0b0e14;color:#f3f6fb}body{margin:0;background:#0b0e14}.wrap{max-width:980px;margin:auto;padding:32px 20px 56px}h1{font-size:28px;margin:0 0 6px}.sub{color:#9ca9ba;margin:0 0 24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.card{border:1px solid #293243;background:#121722;border-radius:14px;padding:18px}.label{font-size:12px;color:#8f9bad;text-transform:uppercase;letter-spacing:.08em}.value{font-size:18px;font-weight:650;margin-top:8px;word-break:break-word}.ok{color:#80d59b}.warn{color:#ffcc74}.muted{color:#a8b2c1}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.wide{grid-column:1/-1}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}a.btn{color:#f3f6fb;text-decoration:none;border:1px solid #3a465c;border-radius:9px;padding:9px 13px}.small{font-size:12px;color:#8490a2;margin-top:12px}
</style></head><body><main class="wrap">
<h1>TalkSys Phone</h1><p class="sub">電話経路は既存TalkSysから分離。1通話=1独立WebSocket/Gemini Liveセッション。</p>
<section class="grid">
<div class="card"><div class="label">Telephony</div><div id="enabled" class="value">確認中</div></div>
<div class="card"><div class="label">Gemini Live</div><div id="gemini" class="value">確認中</div></div>
<div class="card"><div class="label">Concurrent calls</div><div class="value ok">supported</div></div>
<div class="card"><div class="label">Max session</div><div class="value">${maxMinutes} min</div></div>
<div class="card"><div class="label">Transcription</div><div class="value ${transcription ? 'warn' : 'ok'}">${transcription ? 'ON' : 'OFF'}</div></div>
<div class="card"><div class="label">Storage</div><div id="storage" class="value muted">disabled</div></div>
<div class="card"><div class="label">Model</div><div class="value">${xmlEscape(model)}</div></div>
<div class="card wide"><div class="label">TeXML webhook</div><div class="value"><code>${xmlEscape(base)}/telnyx/voice?token=&lt;secret&gt;</code></div></div>
<div class="card wide"><div class="label">Cost policy</div><div class="value muted">録音・文字起こし・D1/R2保存は初期OFF。Telnyxは従量課金を維持し、固定Channel課金は必要になるまで使わない。</div></div>
</section>
<div class="row"><a class="btn" href="${xmlEscape(browserUrl)}">既存TalkSys</a><a class="btn" href="${xmlEscape(base)}/telephony-health">Health JSON</a></div>
<p class="small">revision: ${TELEPHONY_REVISION}</p></main>
<script>async function refresh(){try{const r=await fetch('/telephony-health',{cache:'no-store'});const h=await r.json();const e=document.getElementById('enabled');const g=document.getElementById('gemini');e.textContent=h.enabled?'enabled':'disabled';e.className='value '+(h.enabled?'ok':'warn');g.textContent=h.geminiConfigured?'configured':'not configured';g.className='value '+(h.geminiConfigured?'ok':'warn');document.getElementById('storage').textContent=h.storageMode||'disabled'}catch{}}refresh();setInterval(refresh,10000);</script>
</body></html>`;
}

function health(request, env) {
  const sessionMaxMinutes = clampInt(env?.TELEPHONY_SESSION_MAX_MINUTES, 30, 5, 180);
  return json({
    ok: true,
    revision: TELEPHONY_REVISION,
    isolatedFromBrowserRuntime: true,
    enabled: enabled(env),
    tokenConfigured: Boolean(sharedToken(env)),
    geminiConfigured: Boolean(geminiKey(env)),
    geminiModel: env?.GEMINI_LIVE_MODEL || DEFAULT_GEMINI_MODEL,
    transcription: flag(env?.TELEPHONY_TRANSCRIPTION, false),
    contextCompression: true,
    sessionResumption: true,
    sessionMaxMinutes,
    concurrency: {
      mode: 'independent-session-per-call',
      applicationLimit: null,
      note: 'No shared in-memory state is required; each Telnyx WebSocket gets its own Gemini Live session.',
    },
    storageMode: env?.TELEPHONY_STORAGE_MODE || 'disabled',
    readyForMedia: enabled(env) && Boolean(sharedToken(env)) && Boolean(geminiKey(env)),
    routes: { management: '/phone', health: '/telephony-health', voice: '/telnyx/voice', media: '/telnyx/media', streamStatus: '/telnyx/stream-status' },
    origin: publicBaseUrl(request),
  });
}

async function texmlResponse(request, env) {
  if (!enabled(env)) return new Response('telephony_disabled', { status: 503 });
  if (!sharedToken(env)) return new Response('telephony_shared_token_missing', { status: 503 });
  if (!geminiKey(env)) return new Response('gemini_api_key_missing', { status: 503 });
  if (!tokenAuthorized(request, env)) return new Response('unauthorized', { status: 401 });

  const params = await requestParams(request);
  const callSid = clean(params.get('CallSid') || params.get('call_sid') || '', 200);
  const from = clean(params.get('From') || params.get('from') || '', 80);
  const to = clean(params.get('To') || params.get('to') || '', 80);
  const url = new URL(request.url);
  const xml = buildTexml({ host: url.host, protocol: url.protocol, token: sharedToken(env), callSid, from, to });
  return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' } });
}

async function streamStatus(request, env) {
  if (!tokenAuthorized(request, env)) return new Response('unauthorized', { status: 401 });
  let event = 'unknown';
  let callSid = '';
  try {
    const params = await requestParams(request);
    event = clean(params.get('StreamEvent') || params.get('Event') || params.get('event') || 'unknown', 80);
    callSid = clean(params.get('CallSid') || '', 100);
  } catch {}
  console.log(JSON.stringify({ type: 'telnyx_stream_status', event, callSid: callSid ? 'present' : 'missing', revision: TELEPHONY_REVISION }));
  return new Response(null, { status: 204 });
}

function mediaBridge(request, env) {
  if (!enabled(env)) return new Response('telephony_disabled', { status: 503 });
  if (!tokenAuthorized(request, env)) return new Response('unauthorized', { status: 401 });
  const key = geminiKey(env);
  if (!key) return new Response('gemini_api_key_missing', { status: 503 });
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return new Response('Expected Upgrade: websocket', { status: 426 });

  const pair = new WebSocketPair();
  const [client, telnyx] = Object.values(pair);
  telnyx.accept();

  const liveUrl = `${GEMINI_LIVE_ENDPOINT}?key=${encodeURIComponent(key)}`;
  const maxSessionMs = clampInt(env?.TELEPHONY_SESSION_MAX_MINUTES, 30, 5, 180) * 60_000;
  let gemini = null;
  let geminiReady = false;
  let closing = false;
  let reconnecting = false;
  let resumeHandle = '';
  let inputQueue = [];
  let outputQueue = [];
  let downsampleCarry = [];
  let streamId = '';
  const startedAt = Date.now();
  let deadline;

  const closeBoth = (reason = 'bridge_closed') => {
    if (closing) return;
    closing = true;
    if (deadline) clearTimeout(deadline);
    closeSocket(gemini, 1000, reason);
    closeSocket(telnyx, 1000, reason);
    console.log(JSON.stringify({ type: 'phone_session_closed', reason, durationMs: Date.now() - startedAt, revision: TELEPHONY_REVISION }));
  };

  deadline = setTimeout(() => closeBoth('session_cost_guard'), maxSessionMs);

  const sendCallerAudio = (payload) => {
    if (!geminiReady || !gemini || gemini.readyState !== 1) {
      if (inputQueue.length < 75) inputQueue.push(payload);
      return;
    }
    safeSend(gemini, { realtimeInput: { audio: { data: pcmuBase64ToPcm16kBase64(payload), mimeType: 'audio/pcm;rate=16000' } } });
  };

  const flushInput = () => {
    const queued = inputQueue;
    inputQueue = [];
    for (const payload of queued) sendCallerAudio(payload);
  };

  const sendTelnyxChunk = (bytes) => safeSend(telnyx, { event: 'media', media: { payload: bytesToBase64(bytes) } });

  const flushOutput = (force = false) => {
    while (outputQueue.length >= TELNYX_MIN_AUDIO_BYTES) sendTelnyxChunk(Uint8Array.from(outputQueue.splice(0, TELNYX_MIN_AUDIO_BYTES)));
    if (force && outputQueue.length) {
      const padded = new Uint8Array(TELNYX_MIN_AUDIO_BYTES);
      padded.fill(PCM_U_SILENCE);
      padded.set(outputQueue.splice(0, outputQueue.length), 0);
      sendTelnyxChunk(padded);
    }
  };

  const connectGemini = (handle = '') => {
    if (closing) return;
    geminiReady = false;
    reconnecting = Boolean(handle);
    const socket = new WebSocket(liveUrl);
    gemini = socket;

    socket.addEventListener('open', () => safeSend(socket, buildGeminiSetup(env, handle)));
    socket.addEventListener('message', async (event) => {
      let message;
      try { message = JSON.parse(await messageText(event.data)); } catch { return; }
      if (message?.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) resumeHandle = message.sessionResumptionUpdate.newHandle;
      if (message?.goAway) {
        console.log(JSON.stringify({ type: 'gemini_goaway', resumable: Boolean(resumeHandle), revision: TELEPHONY_REVISION }));
        if (resumeHandle && !closing) {
          reconnecting = true;
          closeSocket(socket, 1000, 'resume');
        }
        return;
      }
      if (message?.setupComplete) {
        geminiReady = true;
        reconnecting = false;
        flushInput();
        if (!handle && flag(env?.TELEPHONY_AUTO_GREETING, true)) safeSend(socket, { realtimeInput: { text: '電話がつながりました。日本語で短く挨拶してください。' } });
        return;
      }
      const content = message?.serverContent;
      if (!content) return;
      if (content.interrupted) {
        outputQueue = [];
        downsampleCarry = [];
        safeSend(telnyx, { event: 'clear' });
      }
      for (const part of content?.modelTurn?.parts || []) {
        const inline = part?.inlineData || part?.inline_data;
        if (!inline?.data) continue;
        const mime = String(inline?.mimeType || inline?.mime_type || 'audio/pcm;rate=24000');
        if (!mime.startsWith('audio/pcm')) continue;
        const converted = pcm16Base64ToPcmu8k(inline.data, downsampleCarry);
        downsampleCarry = converted.carry;
        outputQueue.push(...converted.pcmu);
        flushOutput(false);
      }
      if (content.turnComplete) flushOutput(true);
      if (flag(env?.TELEPHONY_TRANSCRIPTION, false)) {
        if (content.inputTranscription?.text) console.log(JSON.stringify({ type: 'phone_input_transcript', chars: content.inputTranscription.text.length }));
        if (content.outputTranscription?.text) console.log(JSON.stringify({ type: 'phone_output_transcript', chars: content.outputTranscription.text.length }));
      }
    });
    socket.addEventListener('error', () => {
      console.error(JSON.stringify({ type: 'gemini_live_error', revision: TELEPHONY_REVISION }));
    });
    socket.addEventListener('close', () => {
      if (closing) return;
      if (reconnecting && resumeHandle) {
        setTimeout(() => connectGemini(resumeHandle), 100);
        return;
      }
      closeBoth('gemini_closed');
    });
  };

  connectGemini();

  telnyx.addEventListener('message', async (event) => {
    let message;
    try { message = JSON.parse(await messageText(event.data)); } catch { return; }
    if (message?.stream_id) streamId = clean(message.stream_id, 100);
    if (message?.event === 'connected') return;
    if (message?.event === 'start') {
      const format = message?.start?.media_format || {};
      if (format.encoding && String(format.encoding).toUpperCase() !== 'PCMU') {
        console.error(JSON.stringify({ type: 'unsupported_telnyx_codec', encoding: clean(format.encoding, 30) }));
        closeBoth('unsupported_codec');
      }
      console.log(JSON.stringify({ type: 'phone_session_started', streamId: streamId ? 'present' : 'missing', revision: TELEPHONY_REVISION }));
      return;
    }
    if (message?.event === 'media' && message?.media?.payload) {
      sendCallerAudio(message.media.payload);
      return;
    }
    if (message?.event === 'stop') {
      safeSend(gemini, { realtimeInput: { audioStreamEnd: true } });
      closeBoth('telnyx_stopped');
      return;
    }
    if (message?.event === 'error') {
      console.error(JSON.stringify({ type: 'telnyx_media_error', streamId: streamId ? 'present' : 'missing', detail: clean(message?.payload?.detail || '', 200) }));
      closeBoth('telnyx_error');
    }
  });
  telnyx.addEventListener('error', () => closeBoth('telnyx_socket_error'));
  telnyx.addEventListener('close', () => closeBoth('telnyx_closed'));

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return Response.redirect(`${url.origin}/phone`, 302);
    if (request.method === 'GET' && url.pathname === '/phone') return new Response(dashboardHtml(request, env), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    if (request.method === 'GET' && url.pathname === '/telephony-health') return health(request, env);
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/telnyx/voice') return texmlResponse(request, env);
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/telnyx/stream-status') return streamStatus(request, env);
    if (request.method === 'GET' && url.pathname === '/telnyx/media') return mediaBridge(request, env);
    return new Response('Not Found', { status: 404 });
  },
};

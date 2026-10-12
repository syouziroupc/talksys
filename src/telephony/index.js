import { transcribeV45 } from '../stt-v45.js';
import { pcmuBase64ToSamples, rmsOfSamples, samplesToWav } from './codec.js';
import { buildTexml, clampInt, clean, flag, xmlEscape } from './protocol.js';
import { PHONE_TTS_MODEL, PHONE_TTS_SAMPLE_RATE, phoneTtsVoice, streamPcmu20ms, synthesizePhonePcmu } from './phone-tts.js';
import { fastReaction, sameUtterance, FAST_REACTION_REVISION } from '../voice-fast-reaction.js';
import { WEB_VOICE_CAPTURE_POLICY } from '../voice-capture-policy.js';

export const TELEPHONY_REVISION = 'talksys-telephony-v87-grok-pcmu-paced';
export const TELEPHONY_OBSERVABILITY_REVISION = 'talksys-phone-latency-v90-fast-ack-r1';
export const PHONE_GREETING_LATENCY_REVISION = 'talksys-phone-greeting-latency-v114-r1';
export const PHONE_PROFILE_REVISION = 'talksys-phone-profile-v115-r1';
export const PHONE_PROFILE_PRELOAD_REVISION = 'talksys-phone-profile-preload-v116a-r1';
export const PHONE_CONVERSATION_BASELINE_REVISION = 'talksys-phone-conversation-baseline-v118-r1';
const FRAME_MS = 20;
const FAST_ACK_TEXT = 'はい、確認しますね。';
export const PHONE_FAST_ACK_REVISION = 'talksys-phone-fast-ack-v2-r1';
export const PHONE_ACK_LATENCY_REVISION = 'talksys-phone-ack-latency-v120-r1';
export const PHONE_PERSONALIZATION_ACTIVE_REVISION = 'talksys-phone-personalization-v121-r1';
export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v122-r1';
export const PHONE_RELEASE_VERSION = 'v122';
const PHONE_ACK_STT_GRACE_MS = 250;
const PHONE_ACK_VARIANTS = Object.freeze({
  lookup: Object.freeze([
    'はい、少し調べますね。',
    '関連情報を確認しますね。',
    '最新の情報を確認してみますね。',
    '少し検索して確かめますね。',
  ]),
  request: Object.freeze([
    'はい、内容を確認しますね。',
    'わかりました。少し確認しますね。',
    '承知しました。内容を見てみますね。',
  ]),
  question: Object.freeze([
    'はい、確認してお答えしますね。',
    'そうですね。少し確認しますね。',
    'わかりました。確認してみますね。',
  ]),
  listening: Object.freeze([
    'はい、お話はわかりました。少し確認しますね。',
    'はい、内容を確認しています。',
    'わかりました。少し整理してみますね。',
  ]),
});
const PHONE_ACK_PRIMARY_TEXTS = Object.freeze(Object.values(PHONE_ACK_VARIANTS).map((variants) => variants[0]));
const PHONE_SLOW_STT_ACK_TEXTS = Object.freeze([
  PHONE_ACK_VARIANTS.request[0],
  PHONE_ACK_VARIANTS.question[0],
  PHONE_ACK_VARIANTS.listening[0],
  FAST_ACK_TEXT,
]);
let schemaPromise;
let fastAckAudioCache = null;
let fastAckAudioPromise = null;
const phoneAckAudioCache = new Map();
const phoneAckAudioPromises = new Map();
const phoneGreetingAudioCache = new Map();
const phoneGreetingAudioPromises = new Map();

function phoneAckVariantsFor(reaction = {}) {
  if (!reaction?.shouldSpeak || reaction?.terminal) return [FAST_ACK_TEXT];
  const variants = PHONE_ACK_VARIANTS[reaction?.kind];
  return Array.isArray(variants) && variants.length ? [...variants] : [FAST_ACK_TEXT];
}

export function selectPhoneAckText(reaction = {}, cachedTexts = [], recentTexts = []) {
  const cached = new Set(Array.from(cachedTexts || []).map((value) => String(value || '')).filter(Boolean));
  const recent = new Set(Array.from(recentTexts || []).slice(-2).map((value) => String(value || '')).filter(Boolean));
  const variants = phoneAckVariantsFor(reaction);
  const selected = variants.find((text) => cached.has(text) && !recent.has(text))
    || variants.find((text) => cached.has(text))
    || (cached.has(FAST_ACK_TEXT) ? FAST_ACK_TEXT : '');
  const warmText = variants.find((text) => text !== selected && !cached.has(text)) || '';
  return {
    kind: String(reaction?.kind || 'none'),
    text: selected,
    warmText,
    fallbackUsed: Boolean(selected === FAST_ACK_TEXT && variants[0] !== FAST_ACK_TEXT),
  };
}

function selectPreparedSlowSttAck(cachedTexts = [], recentTexts = []) {
  const cached = new Set(Array.from(cachedTexts || []).map((value) => String(value || '')).filter(Boolean));
  const recent = new Set(Array.from(recentTexts || []).slice(-2).map((value) => String(value || '')).filter(Boolean));
  return PHONE_SLOW_STT_ACK_TEXTS.find((text) => cached.has(text) && !recent.has(text))
    || PHONE_SLOW_STT_ACK_TEXTS.find((text) => cached.has(text))
    || '';
}


export const PHONE_SEARCH_PROGRESS_REVISION = 'talksys-phone-search-progress-v1-r1';
const PHONE_PROGRESS_WAIT_MS = 2400;
const PHONE_PROGRESS_CACHE_MAX = 12;
const phoneProgressAudioCache = new Map();
const phoneProgressAudioPromises = new Map();

export function phoneSearchTopic(text = '') {
  let value = clean(text, 180)
    .replace(/[「」『』"']/g, '')
    .replace(/^(?:えーと|えっと|あの|その|じゃあ|では|ちょっと|お願い(?:ですが)?)[、,\s]*/i, '')
    .replace(/[。！!？?…\s]+$/g, '');
  value = value
    .replace(/(?:を)?(?:検索(?:して)?|調べて?|探して|探す|確認して|確認|見つけて|見つける|教えて|知りたい)(?:ください|下さい|ほしい|欲しい|みて|みる|くれる|くれますか|もらえますか|お願い(?:します)?)?$/i, '')
    .replace(/(?:は)?(?:どう|どこ|誰|いつ|何時|いくら|ありますか|あるの|ある|ですか|なの|なのか)$/i, '')
    .replace(/(?:について)$/i, '')
    .replace(/[はをが]\s*$/u, '')
    .replace(/[、,。！!？?…\s]+$/g, '')
    .trim();
  if (!value || value.length < 2) return 'ご指定の内容';
  return value.length > 36 ? `${value.slice(0, 36)}…` : value;
}

export function phoneSearchProgressText(text = '') {
  const topic = phoneSearchTopic(text);
  return `いま、${topic}について調べています。少々お待ちください。`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function enabled(env) { return flag(env?.TELEPHONY_ENABLED, false); }
function sharedToken(env) { return typeof env?.TELEPHONY_SHARED_TOKEN === 'string' ? env.TELEPHONY_SHARED_TOKEN.trim() : ''; }
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

function safeSend(socket, payload) {
  try { if (socket?.readyState === 1) socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload)); } catch {}
}
function closeSocket(socket, code = 1000, reason = 'closed') {
  try { if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close(code, reason.slice(0, 120)); } catch {}
}
function boundedMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(600000, Math.round(n)));
}
function detailJson(detail = {}) {
  try { return clean(JSON.stringify(detail || {}), 4000); } catch { return '{}'; }
}
function phoneRuntimeVersionDetail(env = {}) {
  const meta = env?.CF_VERSION_METADATA || {};
  return {
    revision: PHONE_RUNTIME_LOG_REVISION,
    talksysVersion: PHONE_RELEASE_VERSION,
    workerVersionId: clean(meta?.id || '', 200),
    workerVersionTag: clean(meta?.tag || '', 200),
    workerVersionTimestamp: clean(meta?.timestamp || '', 120),
    telephonyRevision: TELEPHONY_REVISION,
    observabilityRevision: TELEPHONY_OBSERVABILITY_REVISION,
    conversationBaselineRevision: PHONE_CONVERSATION_BASELINE_REVISION,
    ackRevision: PHONE_ACK_LATENCY_REVISION,
    personalizationRevision: PHONE_PERSONALIZATION_ACTIVE_REVISION,
  };
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
      await env.TALKSYS_LOG_DB.prepare(`CREATE TABLE IF NOT EXISTS phone_latency_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`).run();
      await env.TALKSYS_LOG_DB.prepare(`CREATE TABLE IF NOT EXISTS phone_profiles (
        phone_number TEXT PRIMARY KEY,
        display_name TEXT NOT NULL DEFAULT '',
        personalization_text TEXT NOT NULL DEFAULT '',
        memory_text TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`).run();
      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_phone_messages_call ON phone_messages(call_id, id)').run();
      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_phone_calls_updated ON phone_calls(updated_at DESC)').run();
      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_phone_latency_call ON phone_latency_events(call_id, id)').run();
      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_phone_latency_turn ON phone_latency_events(call_id, turn_id, id)').run();
      await env.TALKSYS_LOG_DB.prepare('CREATE INDEX IF NOT EXISTS idx_phone_profiles_updated ON phone_profiles(updated_at DESC)').run();
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

async function appendLatencyEvent(env, { callId, turnId, stage, elapsedMs = 0, detail = {} }) {
  const safeCallId = clean(callId, 200), safeTurnId = clean(turnId, 200), safeStage = clean(stage, 100);
  if (!safeCallId || !safeTurnId || !safeStage || !(await ensureSchema(env))) return;
  await env.TALKSYS_LOG_DB.prepare(`INSERT INTO phone_latency_events
    (call_id, turn_id, stage, elapsed_ms, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(safeCallId, safeTurnId, safeStage, boundedMs(elapsedMs), detailJson(detail), new Date().toISOString()).run();
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

async function transcribeSamples(env, samples) {
  const wav = samplesToWav(samples, 8000);
  const request = new Request('https://talksys.internal/api/transcribe', {
    method: 'POST', headers: { 'content-type': 'audio/wav', 'x-talksys-source': 'telnyx' }, body: wav,
  });
  const response = await transcribeV45(request, env);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true || !payload?.text) return { ok: false, error: payload?.error || `stt_${response.status}`, payload };
  return { ok: true, text: clean(payload.text, 1800), payload };
}

async function answerWithTalkSys(deps, text, history, signal, spokenBackchannel = '', sessionId = '', utteranceId = '', callerProfile = null) {
  if (typeof deps?.turn !== 'function') return { ok: false, error: 'talksys_turn_not_connected' };
  try {
    const current = clean(text, 1800);
    const last = history.at(-1);
    const lastIsCurrent = last?.role === 'user' && clean(last?.content, 1800) === current;
    const priorHistory = (lastIsCurrent ? history.slice(0, -1) : history).slice(-16);
    const phoneProfile = callerProfile?.enabled ? {
      displayName: clean(callerProfile?.displayName || '', 80),
      personalizationText: clean(callerProfile?.personalizationText || '', 4000),
      memoryText: clean(callerProfile?.memoryText || '', 8000),
      enabled: true,
      version: Number(callerProfile?.version || 0),
    } : null;
    const payload = await deps.turn({ text: current, history: priorHistory, channel: 'phone', sessionId: clean(sessionId, 200), utteranceId: clean(utteranceId, 200), spokenBackchannel, ...(phoneProfile ? { phoneProfile } : {}) }, signal);
    const answer = clean(payload?.answer || payload?.response || payload?.text || '', 9000);
    if (!answer) return { ok: false, error: payload?.error || 'empty_answer' };
    return { ok: true, answer, payload };
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, aborted: true, error: 'turn_aborted' };
    return { ok: false, error: clean(error?.message || error, 240) };
  }
}

export function highPassPcmFrame(samples, state = {}, sampleRate = 8000, cutoffHz = 90) {
  const input = samples instanceof Int16Array ? samples : Int16Array.from(samples || []);
  const out = new Int16Array(input.length);
  const dt = 1 / Math.max(1, sampleRate), rc = 1 / (2 * Math.PI * Math.max(1, cutoffHz)), alpha = rc / (rc + dt);
  let prevX = Number(state.prevX || 0), prevY = Number(state.prevY || 0);
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i], y = alpha * (prevY + x - prevX);
    const clipped = Math.max(-32768, Math.min(32767, Math.round(y)));
    out[i] = clipped; prevX = x; prevY = y;
  }
  state.prevX = prevX; state.prevY = prevY;
  return out;
}

async function synthesizePcmu(env, text, deps = {}) {
  const spoken = clean(text, clampInt(env?.TELEPHONY_MAX_SPOKEN_CHARS, 1200, 200, 3000));
  if (!spoken) return null;
  return synthesizePhonePcmu(env, spoken, deps);
}

async function warmFastAckAudio(env, deps = {}) {
  if (fastAckAudioCache?.bytes?.byteLength) return fastAckAudioCache;
  if (!fastAckAudioPromise) {
    fastAckAudioPromise = synthesizePcmu(env, FAST_ACK_TEXT, deps)
      .then((audio) => {
        if (audio?.bytes?.byteLength) {
          fastAckAudioCache = audio;
          phoneAckAudioCache.set(FAST_ACK_TEXT, audio);
        }
        return fastAckAudioCache;
      })
      .finally(() => { fastAckAudioPromise = null; });
  }
  return fastAckAudioPromise;
}

async function warmPhoneGreetingAudio(env, text, deps = {}) {
  const greetingText = clean(text, 240);
  if (!greetingText) return null;
  const cached = phoneGreetingAudioCache.get(greetingText);
  if (cached?.bytes?.byteLength) return cached;
  if (!phoneGreetingAudioPromises.has(greetingText)) {
    const promise = synthesizePcmu(env, greetingText, deps)
      .then((audio) => {
        if (audio?.bytes?.byteLength) {
          phoneGreetingAudioCache.set(greetingText, audio);
          while (phoneGreetingAudioCache.size > 4) {
            const oldest = phoneGreetingAudioCache.keys().next().value;
            phoneGreetingAudioCache.delete(oldest);
          }
        }
        return phoneGreetingAudioCache.get(greetingText) || null;
      })
      .finally(() => { phoneGreetingAudioPromises.delete(greetingText); });
    phoneGreetingAudioPromises.set(greetingText, promise);
  }
  return phoneGreetingAudioPromises.get(greetingText);
}

async function warmPhoneAckAudio(env, text, deps = {}) {
  const ackText = clean(text, 240);
  if (!ackText) return null;
  if (ackText === FAST_ACK_TEXT) return warmFastAckAudio(env, deps);
  const cached = phoneAckAudioCache.get(ackText);
  if (cached?.bytes?.byteLength) return cached;
  if (!phoneAckAudioPromises.has(ackText)) {
    const promise = synthesizePcmu(env, ackText, deps)
      .then((audio) => {
        if (audio?.bytes?.byteLength) phoneAckAudioCache.set(ackText, audio);
        return phoneAckAudioCache.get(ackText) || null;
      })
      .finally(() => { phoneAckAudioPromises.delete(ackText); });
    phoneAckAudioPromises.set(ackText, promise);
  }
  return phoneAckAudioPromises.get(ackText);
}

async function warmPhoneAckPrimaries(env, deps = {}) {
  await warmFastAckAudio(env, deps);
  const settled = await Promise.allSettled(PHONE_ACK_PRIMARY_TEXTS.map((text) => warmPhoneAckAudio(env, text, deps)));
  return settled.filter((result) => result.status === 'fulfilled' && result.value?.bytes?.byteLength).length;
}


async function warmPhoneProgressAudio(env, text, deps = {}) {
  const progressText = clean(text, 240);
  if (!progressText) return null;
  const cached = phoneProgressAudioCache.get(progressText);
  if (cached?.bytes?.byteLength) return cached;
  if (!phoneProgressAudioPromises.has(progressText)) {
    const promise = synthesizePcmu(env, progressText, deps)
      .then((audio) => {
        if (audio?.bytes?.byteLength) {
          phoneProgressAudioCache.set(progressText, audio);
          while (phoneProgressAudioCache.size > PHONE_PROGRESS_CACHE_MAX) {
            const oldest = phoneProgressAudioCache.keys().next().value;
            phoneProgressAudioCache.delete(oldest);
          }
        }
        return phoneProgressAudioCache.get(progressText) || null;
      })
      .finally(() => { phoneProgressAudioPromises.delete(progressText); });
    phoneProgressAudioPromises.set(progressText, promise);
  }
  return phoneProgressAudioPromises.get(progressText);
}

async function waitForPhoneProgressAudio(promise) {
  if (!promise) return null;
  return Promise.race([
    promise.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), PHONE_PROGRESS_WAIT_MS)),
  ]);
}

function profilesDashboardHtml(request) {
  const base = publicBaseUrl(request);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TalkSys 電話番号プロフィール</title><style>
  :root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:dark;background:#0b0e14;color:#f3f6fb}body{margin:0}.wrap{max-width:1180px;margin:auto;padding:28px 18px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.sub,.muted{color:#98a5b7}.panel{border:1px solid #293243;background:#121722;border-radius:14px;padding:16px;margin-top:16px}.grid{display:grid;grid-template-columns:minmax(300px,.8fr) minmax(420px,1.35fr);gap:14px}@media(max-width:820px){.grid{grid-template-columns:1fr}}button,input,textarea,select{font:inherit}button{background:#202a3a;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:9px 12px;cursor:pointer}input,textarea,select{box-sizing:border-box;width:100%;background:#0b0e14;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:9px}textarea{min-height:110px;resize:vertical}.row{padding:11px;border-bottom:1px solid #283245;cursor:pointer}.row:hover{background:#171e2b}.num{font-weight:750}.meta{font-size:12px;color:#91a0b5;margin-top:4px}.form{display:grid;gap:11px}.form label{font-size:12px;color:#bec8d7}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.warn{color:#ffca72}.ok{color:#7dd69a}.hidden{display:none}a{color:#a8c7ff}.newrow{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:10px}.profileHistory{margin-top:20px;border-top:1px solid #2a3344;padding-top:14px}.historyCall{padding:10px;border:1px solid #293243;border-radius:9px;margin:8px 0;cursor:pointer}.historyCall:hover{background:#171e2b}.historyMessages{margin-top:12px}.historyMsg{padding:9px 10px;border-radius:8px;margin:7px 0;white-space:pre-wrap}.historyUser{background:#1b2b3a}.historyAssistant{background:#25213a}
  </style></head><body><main class="wrap"><div class="top"><div><h1>電話番号プロフィール</h1><div class="sub">通話履歴とは分離して、発信者番号ごとの呼び名・応答方針・継続メモを管理します。</div></div><div><a href="${xmlEscape(base)}/phone">通話管理へ</a></div></div>
  <section id="login" class="panel"><b>管理トークン</b><p class="muted">/phone と同じ管理トークンを使用します。</p><input id="token" type="password" autocomplete="current-password"><button id="loginBtn">表示</button><div id="loginErr" class="warn"></div></section>
  <section id="app" class="hidden"><div class="grid"><div class="panel"><input id="filter" placeholder="電話番号・表示名で絞り込み"><div class="newrow"><input id="newPhone" placeholder="新しい電話番号"><button id="newBtn">開く</button></div><div id="list" style="margin-top:12px"></div></div><div class="panel"><h2 id="editorTitle">電話番号を選択</h2><div id="editor" class="hidden"><div class="form"><label>電話番号<input id="profilePhone" readonly></label><label>表示名<input id="profileName" maxlength="80"></label><label>応答方針<textarea id="profilePersonalization" maxlength="4000"></textarea></label><label>継続メモ<textarea id="profileMemory" maxlength="8000"></textarea></label><label>有効<select id="profileEnabled"><option value="1">有効</option><option value="0">無効</option></select></label></div><div class="actions" style="margin-top:12px"><button id="saveBtn">保存</button><span id="status" class="muted"></span></div><p class="muted">電話番号は本人確認には使用しません。秘密情報は保存しないでください。</p></div><div class="profileHistory"><div class="top"><h3>電話履歴</h3><span class="muted">直近20件</span></div><div id="profileCallHistory" class="muted">電話番号を選択してください。</div><div id="profileCallMessages" class="historyMessages muted"></div></div></div></div></section>
  </main><script>
  let adminToken=sessionStorage.getItem('talksysPhoneToken')||'',rows=[],selectedPhone='',selectedVersion=0;
  const auth=()=>adminToken?{'authorization':'Bearer '+adminToken}:{};
  const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  async function api(path,options={}){const r=await fetch(path,{...options,headers:{...auth(),...(options.headers||{})},cache:'no-store'});const d=await r.json().catch(()=>({}));if(r.status===401){const e=new Error('認証に失敗しました');e.status=401;throw e}if(!r.ok||d.ok===false){const e=new Error(d.error||('HTTP '+r.status));e.status=r.status;throw e}return d}
  function render(){const q=String(document.getElementById('filter').value||'').toLowerCase();const shown=rows.filter(x=>(String(x.phone_number||'')+' '+String(x.display_name||'')).toLowerCase().includes(q));document.getElementById('list').innerHTML=shown.length?shown.map(x=>'<div class="row" data-phone="'+esc(x.phone_number)+'"><div class="num">'+esc(x.display_name||x.phone_number)+'</div><div class="meta">'+esc(x.display_name?x.phone_number:'')+' / '+Number(x.call_count||0)+'通話 / '+(Number(x.enabled)===0?'無効':'有効')+'</div><div class="meta">最終通話 '+esc(x.last_call_at||'なし')+'</div></div>').join(''):'<div class="muted">該当なし</div>';document.querySelectorAll('.row').forEach(el=>el.onclick=()=>loadProfile(el.dataset.phone))}
  async function refresh(){const d=await api('/phone/api/profiles');rows=d.profiles||[];render()}
  async function loadProfile(phone){selectedPhone=String(phone||'').trim();if(!selectedPhone)return;const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone));const p=d.profile||{};selectedVersion=Number(p.version||0);document.getElementById('editor').classList.remove('hidden');document.getElementById('editorTitle').textContent=p.display_name?String(p.display_name)+' のプロフィール':selectedPhone+' のプロフィール';document.getElementById('profilePhone').value=selectedPhone;document.getElementById('profileName').value=p.display_name||'';document.getElementById('profilePersonalization').value=p.personalization_text||'';document.getElementById('profileMemory').value=p.memory_text||'';document.getElementById('profileEnabled').value=String(Number(p.enabled)===0?0:1);document.getElementById('status').textContent=d.exists?'保存済み':'未登録';history.replaceState(null,'','/phone-profiles?phone='+encodeURIComponent(selectedPhone));await loadProfileCalls(selectedPhone)}
  async function loadProfileCalls(phone){const root=document.getElementById('profileCallHistory'),detail=document.getElementById('profileCallMessages');root.innerHTML='<div class="muted">読込中...</div>';detail.innerHTML='';const d=await api('/phone/api/profiles/'+encodeURIComponent(phone)+'/calls?limit=20');const calls=d.calls||[];root.innerHTML=calls.length?calls.map(c=>'<div class="historyCall" data-history-call="'+esc(c.call_id)+'"><div class="num">'+esc(c.started_at||'日時不明')+' / '+esc(c.status||'')+'</div><div class="meta">'+Number(c.message_count||0)+'件 / '+esc(c.last_user_text||c.last_assistant_text||'会話なし')+'</div></div>').join(''):'<div class="muted">この番号の電話履歴はありません。</div>';root.querySelectorAll('[data-history-call]').forEach(el=>el.onclick=()=>loadProfileCallMessages(el.dataset.historyCall).catch(e=>{detail.textContent='会話取得失敗: '+e.message}))}
  async function loadProfileCallMessages(id){const root=document.getElementById('profileCallMessages');root.innerHTML='<div class="muted">会話読込中...</div>';const d=await api('/phone/api/calls/'+encodeURIComponent(id)+'/messages');root.innerHTML=(d.messages||[]).length?(d.messages||[]).map(m=>'<div class="historyMsg '+(m.role==='user'?'historyUser':'historyAssistant')+'"><div class="meta">'+(m.role==='user'?'発信者':'TalkSys')+' / '+esc(m.created_at||'')+'</div>'+esc(m.content||'')+'</div>').join(''):'<div class="muted">会話本文はありません。</div>'}
  async function save(){if(!selectedPhone)return;const status=document.getElementById('status');status.textContent='保存中...';status.className='muted';try{const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({display_name:document.getElementById('profileName').value,personalization_text:document.getElementById('profilePersonalization').value,memory_text:document.getElementById('profileMemory').value,enabled:Number(document.getElementById('profileEnabled').value),version:selectedVersion})});selectedVersion=Number(d.profile?.version||selectedVersion);status.textContent='保存しました';status.className='ok';await refresh();await loadProfile(selectedPhone)}catch(e){status.className='warn';if(e.status===409){status.textContent='更新競合。再読込しました。';await loadProfile(selectedPhone);return}status.textContent='保存失敗: '+e.message}}
  async function start(){try{await refresh();document.getElementById('login').classList.add('hidden');document.getElementById('app').classList.remove('hidden');const q=new URL(location.href).searchParams.get('phone');if(q)await loadProfile(q)}catch(e){document.getElementById('loginErr').textContent=e.message}}
  document.getElementById('loginBtn').onclick=()=>{adminToken=document.getElementById('token').value;sessionStorage.setItem('talksysPhoneToken',adminToken);start()};document.getElementById('filter').oninput=render;document.getElementById('newBtn').onclick=()=>loadProfile(document.getElementById('newPhone').value).catch(e=>alert(e.message));document.getElementById('saveBtn').onclick=()=>save();if(adminToken)start();
  </script></body></html>`;
}

function dashboardHtml(request) {
  const base = publicBaseUrl(request);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TalkSys 電話管理</title><style>
  :root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:dark;background:#0b0e14;color:#f3f6fb}body{margin:0}.wrap{max-width:1240px;margin:auto;padding:28px 18px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.sub,.muted{color:#98a5b7}.panel{border:1px solid #293243;background:#121722;border-radius:14px;padding:16px;margin-top:16px}.grid{display:grid;grid-template-columns:minmax(310px,.8fr) minmax(420px,1.5fr);gap:14px}@media(max-width:800px){.grid{grid-template-columns:1fr}}button,input{font:inherit}button{background:#202a3a;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:8px 12px;cursor:pointer}input{background:#0b0e14;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:9px;width:min(380px,75vw)}.call{padding:12px;border-bottom:1px solid #283245;cursor:pointer}.call:hover{background:#171e2b}.num{font-weight:700}.meta{font-size:12px;color:#91a0b5;margin-top:4px}.msg{margin:10px 0;padding:10px 12px;border-radius:10px;white-space:pre-wrap}.user{background:#1b2b3a}.assistant{background:#25213a}.role{font-size:11px;color:#9ca8ba;margin-bottom:5px}.warn{color:#ffca72}.ok{color:#7dd69a}code{font-size:12px}.hidden{display:none}.latency{margin-top:18px;border-top:1px solid #2a3344;padding-top:12px}.turn{margin:12px 0;border:1px solid #2a3344;border-radius:10px;overflow:hidden}.turnHead{background:#171e2b;padding:8px 10px;font-size:12px;color:#bec9d8}.event{display:grid;grid-template-columns:82px minmax(130px,.7fr) 1fr;gap:8px;padding:7px 10px;border-top:1px solid #222b3a;font-size:12px;align-items:start}.event:first-child{border-top:0}.ms{font-variant-numeric:tabular-nums;color:#9bd1ff}.stage{font-weight:650}.detail{color:#9ca8ba;overflow-wrap:anywhere}@media(max-width:640px){.event{grid-template-columns:72px 1fr}.detail{grid-column:1/-1}}.profileBox{border:1px solid #2a3344;border-radius:10px;padding:12px;margin:10px 0 16px}.profileGrid{display:grid;gap:9px}.profileGrid label{font-size:12px;color:#b8c3d2}.profileGrid input[type=text],.profileGrid textarea,.profileGrid select{box-sizing:border-box;width:100%;margin-top:4px;background:#0b0e14;color:#fff;border:1px solid #3b4860;border-radius:8px;padding:9px;font:inherit}.profileGrid textarea{min-height:82px;resize:vertical}.profileActions{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
  </style></head><body><main class="wrap"><div class="top"><div><h1>TalkSys 電話管理</h1><div class="sub">Telnyx着信をTalkSys本体で処理。電話専用AIは使用しません。</div></div><div><a href="${xmlEscape(base)}/phone-profiles" style="color:#a8c7ff">電話番号プロフィール</a> · <a href="${xmlEscape(base)}/telephony-health" style="color:#a8c7ff">状態JSON</a></div></div>
  <section id="login" class="panel"><b>管理トークン</b><p class="muted">着信番号と会話内容の表示には認証が必要です。</p><input id="token" type="password" autocomplete="current-password"><button id="loginBtn">表示</button><div id="loginErr" class="warn"></div></section>
  <section id="app" class="hidden"><div class="panel"><div id="health">状態確認中...</div></div><div class="grid"><div class="panel"><div class="top"><h2>着信一覧</h2><div><select id="batchCount"><option value="10">直近10件</option><option value="20" selected>直近20件</option><option value="50">直近50件</option></select> <button id="batchExportBtn">ログZIP保存</button></div></div><div id="calls"></div></div><div class="panel"><div class="top"><h2 id="conversationTitle">会話内容</h2><button id="exportBtn" class="hidden">JSONL保存</button></div><div id="profileBox" class="profileBox hidden"><div class="top"><h3>発信者プロフィール</h3><span id="profilePhone" class="muted"></span></div><div class="muted">電話番号は本人確認ではありません。パスワード・カード番号などの秘密情報は保存しないでください。</div><div class="profileGrid"><label>表示名<input id="profileName" type="text" maxlength="80"></label><label>パーソナライズ<textarea id="profilePersonalization" maxlength="4000" placeholder="例: 丁寧で簡潔な説明を好む。呼び方は○○さん。"></textarea></label><label>メモリ<textarea id="profileMemory" maxlength="8000" placeholder="次回以降の通話で参照したい安定した情報"></textarea></label><label>利用<select id="profileEnabled"><option value="1">有効</option><option value="0">無効</option></select></label></div><div class="profileActions"><button id="profileSaveBtn">プロフィール保存</button><span id="profileStatus" class="muted"></span></div></div><div id="messages" class="muted">左の着信を選択してください。</div><div class="latency"><h3>遅延タイムライン</h3><div class="muted">発話終了推定を0msとして、STT・AI・TTS・最初のPCMU送信までを表示します。</div><div id="latency" class="muted">通話を選択してください。</div></div></div></div></section>
  </main><script>
  let adminToken=sessionStorage.getItem('talksysPhoneToken')||'';let selected='',selectedPhone='',selectedProfileVersion=0,profileDirty=false;const auth=()=>({'authorization':'Bearer '+adminToken});
  function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[m]))}
  function stageName(s){return ({speech_end_estimate:'発話終了推定',vad_finalize:'VAD確定',stt_start:'STT開始',stt_end:'STT完了',stt_rejected:'STT不成立',turn_start:'AI開始',ack_cache_hit:'受理相槌キャッシュ',ack_cache_miss:'受理相槌未準備',ack_audio_ready:'相槌音声準備',ack_first_pcmu:'相槌 first audio',ack_complete:'相槌送信完了',answer_ready:'AI回答確定',pending_stt_wait_start:'追加入力待機開始',pending_stt_wait_end:'追加入力待機終了',answer_tts_start:'本回答TTS開始',answer_audio_ready:'本回答音声準備',answer_first_pcmu:'本回答 first audio',answer_complete:'本回答送信完了',duplicate_suppressed:'重複発話抑制',progress_wait_start:'検索進捗準備',progress_first_pcmu:'検索進捗 first audio',progress_complete:'検索進捗送信完了',progress_spoken:'検索進捗発話',progress_skipped:'検索進捗省略',api_usage:'API使用量',tts_usage:'TTS使用量',turn_error:'AIエラー',tts_error:'TTSエラー'}[s]||s)}
  function detailText(v){if(!v)return'';try{const o=JSON.parse(v);return Object.entries(o).filter(([,x])=>x!==''&&x!==null&&x!==undefined).map(([k,x])=>k+'='+String(typeof x==='object'?JSON.stringify(x):x)).join(' / ')}catch{return String(v)}}
  function renderLatency(events){const root=document.getElementById('latency');if(!events?.length){root.innerHTML='<div class="muted">この通話には詳細遅延ログがありません。新しい計測版の通話から記録されます。</div>';return}const groups=[];for(const e of events){let g=groups.at(-1);if(!g||g.id!==e.turn_id){g={id:e.turn_id,events:[]};groups.push(g)}g.events.push(e)}root.innerHTML=groups.map((g,i)=>'<div class="turn"><div class="turnHead">ターン '+(i+1)+' / '+esc(g.id)+'</div>'+g.events.map(e=>'<div class="event"><div class="ms">+'+Number(e.elapsed_ms||0)+' ms</div><div class="stage">'+esc(stageName(e.stage))+'</div><div class="detail">'+esc(detailText(e.detail))+'</div></div>').join('')+'</div>').join('')}
  async function api(path,options={}){const r=await fetch(path,{...options,headers:{...auth(),...(options.headers||{})},cache:'no-store'});const d=await r.json().catch(()=>({}));if(r.status===401){const e=new Error('認証に失敗しました');e.status=401;throw e}if(!r.ok||d.ok===false){const e=new Error(d.error||('HTTP '+r.status));e.status=r.status;throw e}return d}
  async function refreshHealth(){const h=await fetch('/telephony-health',{cache:'no-store'}).then(r=>r.json());document.getElementById('health').innerHTML='電話受付: <b class="'+(h.enabled?'ok':'warn')+'">'+(h.enabled?'有効':'無効')+'</b> / TalkSys本体接続: <b class="'+(h.integrated?'ok':'warn')+'">'+(h.integrated?'統合済み':'未統合')+'</b> / 音声返送: <b>'+esc(h.outputAudio)+'</b> / 計測: <b>'+esc(h.observabilityRevision||'なし')+'</b>'}
  async function refreshCalls(){const d=await api('/phone/api/calls');const root=document.getElementById('calls');root.innerHTML=d.calls.length?d.calls.map(c=>'<div class="call" data-id="'+esc(c.call_id)+'"><div class="num">'+esc(c.profile_display_name?c.profile_display_name+' ('+(c.from_number||'番号不明')+')':(c.from_number||'番号不明'))+' → '+esc(c.to_number||'着信番号不明')+'</div><div class="meta">'+esc(c.status)+' / '+esc(c.started_at)+' / '+c.message_count+'件</div><div class="meta">'+esc(c.last_user_text||c.last_assistant_text||'会話待ち')+'</div></div>').join(''):'<div class="muted">まだ着信はありません。</div>';root.querySelectorAll('.call').forEach(x=>x.onclick=()=>loadMessages(x.dataset.id));}
  async function loadProfile(phone,{force=false}={}){const nextPhone=String(phone||'');const box=document.getElementById('profileBox');if(!nextPhone){selectedPhone='';box.classList.add('hidden');selectedProfileVersion=0;profileDirty=false;return}if(profileDirty&&selectedPhone===nextPhone&&!force)return;selectedPhone=nextPhone;const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone));if(profileDirty&&selectedPhone===nextPhone&&!force)return;const p=d.profile||{};selectedProfileVersion=Number(p.version||0);box.classList.remove('hidden');document.getElementById('profilePhone').textContent=selectedPhone;document.getElementById('profileName').value=p.display_name||'';document.getElementById('profilePersonalization').value=p.personalization_text||'';document.getElementById('profileMemory').value=p.memory_text||'';document.getElementById('profileEnabled').value=String(p.enabled===0?0:1);document.getElementById('profileStatus').textContent=d.exists?'保存済み':'未登録';profileDirty=false}
  async function saveProfile(){if(!selectedPhone)return;const status=document.getElementById('profileStatus');status.textContent='保存中...';try{const d=await api('/phone/api/profiles/'+encodeURIComponent(selectedPhone),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({display_name:document.getElementById('profileName').value,personalization_text:document.getElementById('profilePersonalization').value,memory_text:document.getElementById('profileMemory').value,enabled:Number(document.getElementById('profileEnabled').value),version:selectedProfileVersion})});selectedProfileVersion=Number(d.profile?.version||selectedProfileVersion);profileDirty=false;status.textContent='保存しました';await refreshCalls()}catch(e){if(e.status===409){status.textContent='他の更新と競合しました。再読込します。';profileDirty=false;await loadProfile(selectedPhone,{force:true});return}status.textContent='保存失敗: '+e.message}}
  async function loadMessages(id,{refreshProfile=true}={}){selected=id;const base='/phone/api/calls/'+encodeURIComponent(id);const [d,l]=await Promise.all([api(base+'/messages'),api(base+'/latency')]);document.getElementById('conversationTitle').textContent=(d.call?.from_number||'番号不明')+' の会話';document.getElementById('exportBtn').classList.remove('hidden');const nextPhone=d.call?.from_number||'';if(refreshProfile||selectedPhone!==nextPhone)await loadProfile(nextPhone);document.getElementById('messages').innerHTML=d.messages.length?d.messages.map(m=>'<div class="msg '+m.role+'"><div class="role">'+(m.role==='user'?'発信者':'TalkSys')+' / '+esc(m.created_at)+'</div>'+esc(m.content)+'</div>').join(''):'<div class="muted">会話はまだありません。</div>';renderLatency(l.events||[])}
  async function downloadExport(){if(!selected)return;const path='/phone/api/calls/'+encodeURIComponent(selected)+'/export.jsonl';const r=await fetch(path,{headers:auth(),cache:'no-store'});if(r.status===401)throw new Error('認証に失敗しました');if(!r.ok)throw new Error('JSONLの取得に失敗しました');const blob=await r.blob();const href=URL.createObjectURL(blob);const a=document.createElement('a');a.href=href;a.download='talksys-call-'+selected.replace(/[^A-Za-z0-9._-]+/g,'_')+'.jsonl';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),1000)}
  async function downloadBatchExport(){const button=document.getElementById('batchExportBtn');const original=button.textContent;button.disabled=true;button.textContent='ZIP作成中...';try{const n=Math.max(1,Math.min(50,Number(document.getElementById('batchCount')?.value||20)||20));const r=await fetch('/phone/api/calls/export.zip?limit='+encodeURIComponent(n),{headers:auth(),cache:'no-store'});if(r.status===401)throw new Error('認証に失敗しました');if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error('ZIP取得失敗: '+(e.error||('HTTP '+r.status)))}const buffer=await r.arrayBuffer();const bytes=new Uint8Array(buffer);if(bytes.byteLength<22||bytes[0]!==0x50||bytes[1]!==0x4b)throw new Error('ZIP応答が破損しています');const disposition=r.headers.get('content-disposition')||'';const match=disposition.match(/filename=\"?([^\";]+)\"?/i);const filename=match?.[1]||('talksys-calls-latest-'+n+'.zip');const blob=new Blob([bytes],{type:'application/zip'});const href=URL.createObjectURL(blob);const a=document.createElement('a');a.href=href;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),5000)}finally{button.disabled=false;button.textContent=original}}
  async function start(){try{await api('/phone/api/calls');document.getElementById('login').classList.add('hidden');document.getElementById('app').classList.remove('hidden');await refreshHealth();await refreshCalls();setInterval(async()=>{try{await refreshCalls();if(selected)await loadMessages(selected,{refreshProfile:false})}catch{}},3000)}catch(e){document.getElementById('loginErr').textContent=e.message}}
  document.getElementById('loginBtn').onclick=()=>{adminToken=document.getElementById('token').value;sessionStorage.setItem('talksysPhoneToken',adminToken);start()};document.getElementById('exportBtn').onclick=()=>downloadExport().catch(e=>alert(e.message));document.getElementById('batchExportBtn').onclick=()=>downloadBatchExport().catch(e=>alert(e.message));document.getElementById('profileSaveBtn').onclick=()=>saveProfile();for(const id of ['profileName','profilePersonalization','profileMemory','profileEnabled']){const el=document.getElementById(id);el.addEventListener(id==='profileEnabled'?'change':'input',()=>{profileDirty=true;document.getElementById('profileStatus').textContent='未保存の変更あり'})}if(adminToken)start();
  </script></body></html>`;
}

function health(request, env, deps) {
  return json({
    ok: true, revision: TELEPHONY_REVISION, observabilityRevision: TELEPHONY_OBSERVABILITY_REVISION, releaseVersion: PHONE_RELEASE_VERSION, runtimeLogRevision: PHONE_RUNTIME_LOG_REVISION, workerVersionId: clean(env?.CF_VERSION_METADATA?.id || '', 200), personalizationRevision: PHONE_PERSONALIZATION_ACTIVE_REVISION, integrated: true,
    role: 'telnyx-entry-for-talksys-main', enabled: enabled(env), webhookTokenConfigured: Boolean(sharedToken(env)),
    adminTokenConfigured: Boolean(adminToken(env)), talksysTurnConnected: typeof deps?.turn === 'function', pluggableTts: true,
    externalTtsConnected: typeof deps?.synthesize === 'function', storageMode: env?.TALKSYS_LOG_DB ? '既存TalkSys D1 + phone latency events' : 'disabled',
    recording: false, concurrency: '通話ごとに独立WebSocket。確定した追加入力は進行中AIターンを中断。',
    inputAudio: 'Telnyx PCMU 8kHz → 90Hz HPF → 適応VAD → TalkSys STT',
    voiceInterruption: 'STT確定後に旧GeminiターンをAbort。ノイズだけでは中断しない。',
    fastReaction: `Whisper確定直後の分類別PCMU受理相槌 + lookup検索進捗 + Gemini本回答 / ${PHONE_FAST_ACK_REVISION} / ${PHONE_SEARCH_PROGRESS_REVISION} / ${FAST_REACTION_REVISION}`,
    latencyTelemetry: 'speech end estimate → VAD → STT → TalkSys turn → ack → answer ready → TTS → first PCMU → complete',
    outputAudio: 'Cloudflare Grok TTS G.711 μ-law 8kHz → Telnyx PCMU RTP', phoneTtsModel: PHONE_TTS_MODEL,
    phoneTtsVoice: phoneTtsVoice(env), phoneTtsSampleRate: PHONE_TTS_SAMPLE_RATE,
    answerEngine: 'TalkSys本体（既存回答経路）', routes: { management: '/phone', health: '/telephony-health', voice: '/telnyx/voice', media: '/telnyx/media' },
    origin: publicBaseUrl(request),
  });
}

function profilePhone(value = '') {
  return clean(value, 80).trim();
}
function profileDefaults(phoneNumber = '') {
  return { phone_number: profilePhone(phoneNumber), display_name: '', personalization_text: '', memory_text: '', enabled: 1, version: 0, created_at: '', updated_at: '' };
}
async function loadCallerProfileForSession(env, phoneNumber) {
  const phone = profilePhone(phoneNumber);
  if (!phone || !(await ensureSchema(env))) return null;
  const row = await env.TALKSYS_LOG_DB.prepare(`SELECT display_name, personalization_text, memory_text, enabled, version FROM phone_profiles WHERE phone_number=?`).bind(phone).first();
  if (!row) return null;
  const enabledValue = row?.enabled;
  const versionRaw = Number(row?.version || 0);
  return Object.freeze({
    displayName: clean(row?.display_name || '', 80).trim(),
    personalizationText: clean(row?.personalization_text || '', 4000).trim(),
    memoryText: clean(row?.memory_text || '', 8000).trim(),
    enabled: !(enabledValue === false || enabledValue === 0 || enabledValue === '0'),
    version: Number.isFinite(versionRaw) ? Math.max(0, Math.round(versionRaw)) : 0,
  });
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

async function profileCalls(request, env, phoneNumber) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const phone = profilePhone(phoneNumber);
  if (!phone) return json({ ok: false, error: 'phone_number_required' }, 400);
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('limit') || 20);
  const limit = Math.max(1, Math.min(50, Number.isFinite(requested) ? Math.round(requested) : 20));
  const result = await env.TALKSYS_LOG_DB.prepare(`SELECT call_id, from_number, to_number, status, started_at, updated_at, ended_at, last_user_text, last_assistant_text, message_count
    FROM phone_calls WHERE from_number=? ORDER BY updated_at DESC LIMIT ?`).bind(phone, limit).all();
  return json({ ok: true, phone_number: phone, calls: result.results || [] });
}

async function listCalls(request, env) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const result = await env.TALKSYS_LOG_DB.prepare(`SELECT c.*, p.display_name AS profile_display_name, p.enabled AS profile_enabled, p.version AS profile_version FROM phone_calls c LEFT JOIN phone_profiles p ON p.phone_number=c.from_number ORDER BY c.updated_at DESC LIMIT 100`).all();
  return json({ ok: true, calls: result.results || [] });
}


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
async function callMessages(request, env, callId) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const call = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_calls WHERE call_id=?').bind(callId).first();
  const messages = await env.TALKSYS_LOG_DB.prepare('SELECT role, content, created_at FROM phone_messages WHERE call_id=? ORDER BY id ASC LIMIT 500').bind(callId).all();
  return json({ ok: true, call, messages: messages.results || [] });
}
async function callLatency(request, env, callId) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const result = await env.TALKSYS_LOG_DB.prepare(`SELECT turn_id, stage, elapsed_ms, detail, created_at FROM phone_latency_events WHERE call_id=? ORDER BY id ASC LIMIT 1200`).bind(callId).all();
  return json({ ok: true, events: result.results || [] });
}

function parsedLatencyDetail(value = '') {
  const raw = String(value || '');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { raw }; }
}

function zipU16(value) {
  const n = Number(value) >>> 0;
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff);
}

function zipU32(value) {
  const n = Number(value) >>> 0;
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

function zipConcat(parts) {
  const list = (parts || []).map((part) => part instanceof Uint8Array ? part : new Uint8Array(part || []));
  const total = list.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of list) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

function zipCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipStoreFiles(files = []) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files || []) {
    const nameBytes = encoder.encode(String(file?.name || 'log.jsonl'));
    const dataBytes = file?.content instanceof Uint8Array ? file.content : encoder.encode(String(file?.content ?? ''));
    const crc = zipCrc32(dataBytes);
    const local = zipConcat([
      zipU32(0x04034b50), zipU16(20), zipU16(0), zipU16(0), zipU16(0), zipU16(0),
      zipU32(crc), zipU32(dataBytes.byteLength), zipU32(dataBytes.byteLength),
      zipU16(nameBytes.byteLength), zipU16(0), nameBytes, dataBytes,
    ]);
    const central = zipConcat([
      zipU32(0x02014b50), zipU16(20), zipU16(20), zipU16(0), zipU16(0), zipU16(0), zipU16(0),
      zipU32(crc), zipU32(dataBytes.byteLength), zipU32(dataBytes.byteLength),
      zipU16(nameBytes.byteLength), zipU16(0), zipU16(0), zipU16(0), zipU16(0), zipU32(0), zipU32(offset), nameBytes,
    ]);
    localParts.push(local);
    centralParts.push(central);
    offset += local.byteLength;
  }
  const centralDirectory = zipConcat(centralParts);
  const end = zipConcat([
    zipU32(0x06054b50), zipU16(0), zipU16(0), zipU16(files.length), zipU16(files.length),
    zipU32(centralDirectory.byteLength), zipU32(offset), zipU16(0),
  ]);
  return zipConcat([...localParts, centralDirectory, end]);
}

async function callJsonlContent(env, call) {
  const callId = String(call?.call_id || '');
  const messages = await env.TALKSYS_LOG_DB.prepare('SELECT role, content, created_at FROM phone_messages WHERE call_id=? ORDER BY id ASC LIMIT 500').bind(callId).all();
  const latency = await env.TALKSYS_LOG_DB.prepare('SELECT turn_id, stage, elapsed_ms, detail, created_at FROM phone_latency_events WHERE call_id=? ORDER BY id ASC LIMIT 1200').bind(callId).all();
  const lines = [JSON.stringify({ type: 'call', call })];
  for (const message of messages.results || []) lines.push(JSON.stringify({ type: 'message', ...message }));
  for (const event of latency.results || []) lines.push(JSON.stringify({
    type: 'latency', turn_id: event.turn_id, stage: event.stage,
    elapsed_ms: Number(event.elapsed_ms || 0), detail: parsedLatencyDetail(event.detail), created_at: event.created_at,
  }));
  return `${lines.join('\n')}\n`;
}

async function callExportJsonl(request, env, callId) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const call = await env.TALKSYS_LOG_DB.prepare('SELECT * FROM phone_calls WHERE call_id=?').bind(callId).first();
  if (!call) return json({ ok: false, error: 'call_not_found' }, 404);
  const messages = await env.TALKSYS_LOG_DB.prepare('SELECT role, content, created_at FROM phone_messages WHERE call_id=? ORDER BY id ASC LIMIT 500').bind(callId).all();
  const latency = await env.TALKSYS_LOG_DB.prepare('SELECT turn_id, stage, elapsed_ms, detail, created_at FROM phone_latency_events WHERE call_id=? ORDER BY id ASC LIMIT 1200').bind(callId).all();
  const lines = [JSON.stringify({ type: 'call', call })];
  for (const message of messages.results || []) lines.push(JSON.stringify({ type: 'message', ...message }));
  for (const event of latency.results || []) lines.push(JSON.stringify({
    type: 'latency', turn_id: event.turn_id, stage: event.stage,
    elapsed_ms: Number(event.elapsed_ms || 0), detail: parsedLatencyDetail(event.detail), created_at: event.created_at,
  }));
  const safeId = String(callId || 'call').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'call';
  return new Response(`${lines.join('\n')}\n`, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="talksys-call-${safeId}.jsonl"`,
      'cache-control': 'no-store',
    },
  });
}

async function recentCallsZip(request, env) {
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
    return { name: `talksys-call-${safeId}.jsonl`, content: `${lines.join('\n')}\n` };
  });
  const archive = zipStoreFiles(files);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return new Response(archive, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="talksys-calls-latest-${calls.length}-${stamp}.zip"`,
      'cache-control': 'no-store',
      'x-talksys-export-count': String(calls.length),
      'x-talksys-export-bytes': String(archive.byteLength),
    },
  });
}

async function texmlResponse(request, env, ctx) {
  if (!enabled(env)) return new Response('telephony_disabled', { status: 503 });
  if (!sharedToken(env)) return new Response('telephony_shared_token_missing', { status: 503 });
  if (!tokenAuthorized(request, env)) return new Response('unauthorized', { status: 401 });
  const params = await requestParams(request);
  const callId = clean(params.get('CallSid') || params.get('call_sid') || crypto.randomUUID(), 200);
  const from = clean(params.get('From') || params.get('from') || '', 80), to = clean(params.get('To') || params.get('to') || '', 80);
  const persistCall = upsertCall(env, { callId, from, to, status: 'connecting' }).catch((error) => {
    console.error(JSON.stringify({ type: 'phone_call_upsert_error', stage: 'voice-webhook', error: clean(error?.message || error, 240) }));
  });
  if (ctx?.waitUntil) ctx.waitUntil(persistCall);
  else persistCall.catch(() => {});
  const url = new URL(request.url);
  const xml = buildTexml({ host: url.host, protocol: url.protocol, token: sharedToken(env), callId, from, to });
  return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' } });
}
async function streamStatus(request, env) {
  if (!tokenAuthorized(request, env)) return new Response('unauthorized', { status: 401 });
  const params = await requestParams(request).catch(() => new URLSearchParams());
  const event = clean(params.get('StreamEvent') || params.get('Event') || params.get('event') || 'unknown', 80);
  const callId = clean(params.get('CallSid') || params.get('call_sid') || '', 200);
  if (callId && /stop|disconnect|end|fail|error/i.test(event)) await setCallStatus(env, callId, /fail|error/i.test(event) ? 'error' : 'ended');
  return new Response(null, { status: 204 });
}

function mediaBridge(request, env, deps) {
  if (!enabled(env)) return new Response('telephony_disabled', { status: 503 });
  if (!tokenAuthorized(request, env)) return new Response('unauthorized', { status: 401 });
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return new Response('Expected Upgrade: websocket', { status: 426 });
  const pair = new WebSocketPair(), [client, telnyx] = Object.values(pair); telnyx.accept();
  const speechThreshold = Number(env?.TELEPHONY_VAD_RMS || 0.008);
  const silenceMs = clampInt(env?.TELEPHONY_END_SILENCE_MS, WEB_VOICE_CAPTURE_POLICY.silenceMs, 300, 2000);
  const minSpeechMs = clampInt(env?.TELEPHONY_MIN_SPEECH_MS, 320, 200, 2000);
  const maxUtteranceMs = clampInt(env?.TELEPHONY_MAX_UTTERANCE_MS, 15000, 3000, 30000);
  const sessionMaxMs = clampInt(env?.TELEPHONY_SESSION_MAX_MINUTES, 30, 5, 180) * 60000;
  const history = [];
  let callId='', from='', to='', speechActive=false, silentFor=0, speechFrames=[], preRoll=[], closed=false, assistantPlaying=false, currentMark='', playbackGeneration=0;
  let noiseFloor=Math.max(0.0015,Math.min(0.02,speechThreshold*0.45)), speechHits=0, bargeHits=0, captureSeq=0, latestAcceptedCapture=0, turnVersion=0, activeTurnAbort=null, pendingSttCount=0, lastAcceptedUserText='', lastAcceptedUserAt=0, recentAckTexts=[];
  const pendingTasks=new Set(), hpState={prevX:0,prevY:0};
  const callerProfileSession={status:'idle',phoneNumber:'',profile:null};
  const adaptNoise=(rms,fast=false)=>{const value=Math.max(0.0005,Math.min(0.04,Number(rms)||0));const alpha=fast?0.08:(value>noiseFloor?0.01:0.035);noiseFloor=Math.max(0.001,Math.min(0.03,noiseFloor*(1-alpha)+value*alpha));};
  const startThreshold=()=>Math.max(speechThreshold,Math.min(0.055,noiseFloor*2.7));
  const trackTask=(promise)=>{pendingTasks.add(promise);promise.finally(()=>pendingTasks.delete(promise));return promise;};
  const queueMessageLog = (role, content) => trackTask(
    appendMessage(env, callId, role, content).catch((error) => {
      console.error(JSON.stringify({ type: 'phone_message_log_error', role, error: clean(error?.message || error, 240) }));
    }),
  );
  const queueLatency=(turnId,stage,elapsedMs=0,detail={})=>{const record={type:'phone_latency',callId,turnId,stage,elapsedMs:boundedMs(elapsedMs),...detail};console.log(JSON.stringify(record));return trackTask(appendLatencyEvent(env,{callId,turnId,stage,elapsedMs,detail}).catch((error)=>console.error(JSON.stringify({type:'phone_latency_log_error',stage,error:clean(error?.message||error,240)}))));};
  const abortActiveTurn=()=>{const controller=activeTurnAbort;activeTurnAbort=null;if(controller){try{controller.abort('confirmed-voice-interrupt');}catch{}}};
  const waitForPendingSpeechDecision=async(version)=>{const until=Date.now()+2800;while(pendingSttCount>0&&version===turnVersion&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,35));return version===turnVersion;};
  const interruptPlayback=()=>{playbackGeneration+=1;if(assistantPlaying||currentMark)safeSend(telnyx,{event:'clear'});assistantPlaying=false;currentMark='';};

  const speak=async(text,options={})=>{
    if(assistantPlaying||currentMark)interruptPlayback();
    const myGeneration=++playbackGeneration,startedAt=Date.now(),purpose=clean(options?.purpose||'answer',40)||'answer',turnId=clean(options?.turnId||'',200),originAt=Number(options?.originAt)||startedAt;
    let audio=options?.preparedAudio||null;
    if(!audio){
      if(turnId)queueLatency(turnId,`${purpose}_tts_start`,startedAt-originAt,{textChars:String(text||'').length});
      try{audio=await synthesizePcmu(env,text,deps);}catch(error){if(turnId)queueLatency(turnId,'tts_error',Date.now()-originAt,{purpose,error:clean(error?.message||error,240)});console.error(JSON.stringify({type:'phone_tts_error',purpose,turnId,error:clean(error?.message||error,240)}));return false;}
    }
    if(!audio?.bytes?.byteLength||closed||myGeneration!==playbackGeneration)return false;
    const audioReadyAt=Date.now();
    if(turnId)queueLatency(turnId,`${purpose}_audio_ready`,audioReadyAt-originAt,{ttsStageMs:options?.preparedAudio?0:audioReadyAt-startedAt,prepared:Boolean(options?.preparedAudio),container:audio.metadata?.container||'',fallbackCodec:audio.metadata?.fallbackCodec||'',audioDurationMs:audio.metadata?.durationMs||0});
    currentMark=`talksys-${crypto.randomUUID()}`;assistantPlaying=true;let firstFrameSent=false;
    const streamed=await streamPcmu20ms(audio.bytes,{sendPayload:(payload)=>{safeSend(telnyx,{event:'media',media:{payload}});if(!firstFrameSent){firstFrameSent=true;if(turnId)queueLatency(turnId,`${purpose}_first_pcmu`,Date.now()-originAt,{prepared:Boolean(options?.preparedAudio),codec:audio.metadata?.codec||'PCMU',sampleRate:audio.metadata?.sampleRate||PHONE_TTS_SAMPLE_RATE});}},isCancelled:()=>closed||myGeneration!==playbackGeneration});
    if(!streamed.completed||closed||myGeneration!==playbackGeneration)return false;
    safeSend(telnyx,{event:'mark',mark:{name:currentMark}});
    if(turnId)queueLatency(turnId,`${purpose}_complete`,Date.now()-originAt,{streamMs:Date.now()-audioReadyAt,frames:streamed.frames,bytes:streamed.sentBytes});
    if(turnId)queueLatency(turnId,'tts_usage',Date.now()-originAt,{purpose,provider:audio.metadata?.provider||'',model:audio.metadata?.model||'',durationMs:audio.metadata?.durationMs||0,frames:streamed.frames,bytes:streamed.sentBytes,cached:Boolean(options?.preparedAudio)});
    console.log(JSON.stringify({type:'phone_tts_sent',purpose,turnId,ms:Date.now()-startedAt,frames:streamed.frames,bytes:streamed.sentBytes,provider:audio.metadata?.provider||'',model:audio.metadata?.model||'',voice:audio.metadata?.voice||'',codec:audio.metadata?.codec||'PCMU',sampleRate:audio.metadata?.sampleRate||PHONE_TTS_SAMPLE_RATE,durationMs:audio.metadata?.durationMs||0,rms:audio.metadata?.rms??null,peak:audio.metadata?.peak??null,silenceRatio:audio.metadata?.silenceRatio??null,gatewayKeySource:audio.metadata?.gatewayKeySource||''}));
    return true;
  };

  const greetingText=clean(env?.TELEPHONY_GREETING||'お電話ありがとうございます。フォーンズです。ご用件をどうぞ。',240);
  const greetingAudioPromise=warmPhoneGreetingAudio(env,greetingText,deps).catch((error)=>{console.warn(JSON.stringify({type:'phone_greeting_prewarm_error',error:clean(error?.message||error,240)}));return null;});
  trackTask(greetingAudioPromise);
  trackTask(warmFastAckAudio(env,deps).then(audio=>console.log(JSON.stringify({type:'phone_fast_ack_warm',ok:Boolean(audio?.bytes?.byteLength),bytes:audio?.bytes?.byteLength||0}))).catch(error=>console.warn(JSON.stringify({type:'phone_fast_ack_warm_error',error:clean(error?.message||error,240)}))));

  const finishUtterance=()=>{
    if(!speechActive||!speechFrames.length)return;
    const frames=speechFrames,myCapture=++captureSeq,finalizedAt=Date.now(),trailingSilenceMs=Math.max(0,silentFor);
    speechActive=false;speechHits=0;bargeHits=0;silentFor=0;speechFrames=[];preRoll=[];
    const samples=Int16Array.from(frames.flatMap(frame=>Array.from(frame))),durationMs=samples.length/8;
    if(durationMs<minSpeechMs)return;
    const speechEndAt=finalizedAt-Math.min(trailingSilenceMs,durationMs),turnId=`${clean(callId||'call',120)}-${myCapture}-${crypto.randomUUID().slice(0,8)}`;
    queueLatency(turnId,'speech_end_estimate',0,{captureDurationMs:Math.round(durationMs),trailingSilenceMs});
    queueLatency(turnId,'vad_finalize',finalizedAt-speechEndAt,{silenceTargetMs:silenceMs,trailingSilenceMs});
    pendingSttCount+=1;
    const sttStartedAt=Date.now();queueLatency(turnId,'stt_start',sttStartedAt-speechEndAt,{samples:samples.length,audioMs:Math.round(samples.length/8)});
    let sttSettled=false,slowAckArmed=false,slowAckText='',slowAckAudio=null;
    const sttPromise=transcribeSamples(env,samples);
    const slowAckTimer=setTimeout(()=>{
      if(sttSettled||closed||latestAcceptedCapture===0)return;
      const selected=selectPreparedSlowSttAck(phoneAckAudioCache.keys(),recentAckTexts);
      const prepared=selected?(selected===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(selected)):null;
      if(!selected||!prepared?.bytes?.byteLength){queueLatency(turnId,'ack_slow_stt_unprepared',Date.now()-speechEndAt,{revision:PHONE_ACK_LATENCY_REVISION,graceMs:PHONE_ACK_STT_GRACE_MS});return;}
      slowAckArmed=true;slowAckText=selected;slowAckAudio=prepared;
      queueLatency(turnId,'ack_slow_stt_armed',Date.now()-speechEndAt,{revision:PHONE_ACK_LATENCY_REVISION,graceMs:PHONE_ACK_STT_GRACE_MS,text:selected,bytes:prepared.bytes.byteLength});
    },PHONE_ACK_STT_GRACE_MS);
    const task=(async()=>{
      let stt;
      try{stt=await sttPromise;}catch(error){queueLatency(turnId,'stt_rejected',Date.now()-speechEndAt,{stageMs:Date.now()-sttStartedAt,error:clean(error?.message||error,240)});console.error(JSON.stringify({type:'phone_stt_error',turnId,error:clean(error?.message||error,240)}));return;}finally{sttSettled=true;clearTimeout(slowAckTimer);pendingSttCount=Math.max(0,pendingSttCount-1);}
      const sttEndedAt=Date.now();
      if(!stt?.ok||!stt.text||myCapture<latestAcceptedCapture){queueLatency(turnId,'stt_rejected',sttEndedAt-speechEndAt,{stageMs:sttEndedAt-sttStartedAt,error:clean(stt?.error||'stale-or-empty',240),retryUsed:Boolean(stt?.payload?.retryUsed)});return;}
      queueLatency(turnId,'stt_end',sttEndedAt-speechEndAt,{stageMs:sttEndedAt-sttStartedAt,textChars:stt.text.length,retryUsed:Boolean(stt?.payload?.retryUsed),model:clean(stt?.payload?.model||'',120)});
      const now=Date.now(),duplicateRecent=lastAcceptedUserText&&sameUtterance(stt.text,lastAcceptedUserText)&&now-lastAcceptedUserAt<12000&&(assistantPlaying||Boolean(activeTurnAbort));
      if(duplicateRecent){queueLatency(turnId,'duplicate_suppressed',now-speechEndAt,{text:clean(stt.text,160)});console.log(JSON.stringify({type:'phone_duplicate_suppressed',text:clean(stt.text,160)}));return;}
      latestAcceptedCapture=myCapture;lastAcceptedUserText=stt.text;lastAcceptedUserAt=now;const myVersion=++turnVersion;abortActiveTurn();interruptPlayback();
      queueMessageLog('user', stt.text);
      history.push({ role: 'user', content: stt.text });
      const controller=new AbortController();activeTurnAbort=controller;
      try{
        const reaction=fastReaction(stt.text);
        const ackSelection=selectPhoneAckText(reaction,phoneAckAudioCache.keys(),recentAckTexts);
        const categoryAckText=ackSelection.text||'';
        const categoryAckAudio=categoryAckText?(categoryAckText===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(categoryAckText)):null;
        const ackText=slowAckArmed?slowAckText:categoryAckText;
        const ackAudio=slowAckArmed?slowAckAudio:categoryAckAudio;
        const ackPrepared=Boolean(ackAudio?.bytes?.byteLength);
        const spokenBackchannel=ackPrepared?ackText:'';
        const progressEnabled=flag(env?.TELEPHONY_SEARCH_PROGRESS_ENABLED,true);
        const progressText=progressEnabled&&reaction.kind==='lookup'?phoneSearchProgressText(stt.text):'';
        const progressAudioPromise=progressText?warmPhoneProgressAudio(env,progressText,deps):null;
        if(progressAudioPromise)trackTask(progressAudioPromise.catch((error)=>{console.warn(JSON.stringify({type:'phone_search_progress_tts_error',turnId,error:clean(error?.message||error,240)}));return null;}));
        const turnStartedAt=Date.now();queueLatency(turnId,'turn_start',turnStartedAt-speechEndAt,{reactionKind:reaction.kind||'none',ackPrepared,ackText,ackFallback:ackSelection.fallbackUsed,progressPlanned:Boolean(progressText)});
        const turnPromise=answerWithTalkSys(deps,stt.text,history,controller.signal,spokenBackchannel,callId,turnId,callerProfileSession.status==='ready'?callerProfileSession.profile:null);
        if(ackSelection.warmText){const warmText=ackSelection.warmText;trackTask(warmPhoneAckAudio(env,warmText,deps).then((audio)=>console.log(JSON.stringify({type:'phone_fast_ack_lazy_warm',kind:reaction.kind||'none',text:warmText,ok:Boolean(audio?.bytes?.byteLength)}))).catch((error)=>console.warn(JSON.stringify({type:'phone_fast_ack_lazy_warm_error',kind:reaction.kind||'none',error:clean(error?.message||error,240)}))));}
        if(slowAckArmed&&ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_slow_stt_committed',Date.now()-speechEndAt,{text:ackText,revision:PHONE_ACK_LATENCY_REVISION,reactionKind:reaction.kind||'none'});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'slow-stt-receipt',text:ackText,cached:true,revision:PHONE_ACK_LATENCY_REVISION}));}}
        else if(ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:ackText,bytes:ackAudio.bytes.byteLength,reactionKind:reaction.kind||'none',fallback:ackSelection.fallbackUsed});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:reaction.kind,text:ackText,cached:true,fallback:ackSelection.fallbackUsed}));}}
        else queueLatency(turnId,'ack_cache_miss',Date.now()-speechEndAt,{text:ackText||FAST_ACK_TEXT,reactionKind:reaction.kind||'none'});
        if(progressText&&myVersion===turnVersion){
          queueLatency(turnId,'progress_wait_start',Date.now()-speechEndAt,{text:progressText,revision:PHONE_SEARCH_PROGRESS_REVISION});
          const progressAudio=await waitForPhoneProgressAudio(progressAudioPromise);
          if(progressAudio?.bytes?.byteLength&&myVersion===turnVersion){
            const progressed=await speak(progressText,{purpose:'progress',turnId,originAt:speechEndAt,preparedAudio:progressAudio});
            queueLatency(turnId,progressed?'progress_spoken':'progress_skipped',Date.now()-speechEndAt,{text:progressText,reason:progressed?'played':'playback_cancelled'});
          }else{
            queueLatency(turnId,'progress_skipped',Date.now()-speechEndAt,{text:progressText,reason:'not_ready_within_budget'});
          }
        }
        const turn=await turnPromise,answerReadyAt=Date.now();if(myVersion!==turnVersion||turn?.aborted)return;
        queueLatency(turnId,'answer_ready',answerReadyAt-speechEndAt,{stageMs:answerReadyAt-turnStartedAt,route:clean(turn?.payload?.route||'',160),search:Boolean(turn?.payload?.search),searchRetried:Boolean(turn?.payload?.searchRetried),primaryMs:boundedMs(turn?.payload?.timings?.primaryMs),searchRetryMs:boundedMs(turn?.payload?.timings?.searchRetryMs),totalMs:boundedMs(turn?.payload?.timings?.totalMs),groundingRequired:Boolean(turn?.payload?.groundingRequired),groundingEvidencePassed:Boolean(turn?.payload?.groundingEvidencePassed),groundingEvidenceReasons:Array.isArray(turn?.payload?.groundingEvidenceReasons)?turn.payload.groundingEvidenceReasons.slice(0,8):[],groundingSourceCount:Number(turn?.payload?.groundingSourceCount||0),groundingCitationCount:Number(turn?.payload?.groundingCitationCount||0),groundingCitationSpanCount:Number(turn?.payload?.groundingCitationSpanCount||0),groundingFailClosed:Boolean(turn?.payload?.groundingFailClosed),groundingRecoveryUsed:Boolean(turn?.payload?.groundingRecoveryUsed)});
        if(turn?.payload?.apiUsage)queueLatency(turnId,'api_usage',answerReadyAt-speechEndAt,turn.payload.apiUsage);
        if(pendingSttCount>0){const pendingStartedAt=Date.now();queueLatency(turnId,'pending_stt_wait_start',pendingStartedAt-speechEndAt,{pendingSttCount});if(!await waitForPendingSpeechDecision(myVersion))return;queueLatency(turnId,'pending_stt_wait_end',Date.now()-speechEndAt,{waitMs:Date.now()-pendingStartedAt,pendingSttCount});}
        if(myVersion!==turnVersion)return;
        if(!turn.ok){queueLatency(turnId,'turn_error',Date.now()-speechEndAt,{error:clean(turn.error,200)});await setCallStatus(env,callId,'answer-error');console.error(JSON.stringify({type:'phone_turn_error',error:clean(turn.error,200)}));return;}
        history.push({ role: 'assistant', content: turn.answer });
        queueMessageLog('assistant', turn.answer);
        if (myVersion !== turnVersion) return;
        const spoken = await speak(turn.answer, { purpose: 'answer', turnId, originAt: speechEndAt });
        if(!spoken)await setCallStatus(env,callId,'tts-error');
      }catch(error){if(error?.name==='AbortError'||myVersion!==turnVersion)return;queueLatency(turnId,'turn_error',Date.now()-speechEndAt,{error:clean(error?.message||error,240)});await setCallStatus(env,callId,'error');console.error(JSON.stringify({type:'phone_pipeline_error',error:clean(error?.message||error,240)}));}finally{if(activeTurnAbort===controller)activeTurnAbort=null;}
    })();trackTask(task);
  };

  const deadline=setTimeout(()=>{if(!closed)closeSocket(telnyx,1000,'session_limit');},sessionMaxMs);
  telnyx.addEventListener('message',async(event)=>{
    let message;try{message=JSON.parse(await messageText(event.data));}catch{return;}
    if(message?.event==='start'){
      const start=message.start||{},params=customParameters(start);callId=clean(params.call_id||start.call_sid||start.callSid||start.call_control_id||crypto.randomUUID(),200);from=clean(params.from||start.from||'',80);to=clean(params.to||start.to||'',80);
      const runtimeTurnId=`${clean(callId||'call',120)}-runtime`;
      queueLatency(runtimeTurnId,'runtime_revision',0,phoneRuntimeVersionDetail(env));
      const profilePhoneAtStart=from,profileLoadStartedAt=Date.now(),profileTurnId=`${clean(callId||'call',120)}-profile`;
      callerProfileSession.status='loading';callerProfileSession.phoneNumber=profilePhoneAtStart;callerProfileSession.profile=null;
      queueLatency(profileTurnId,'profile_load_start',0,{revision:PHONE_PROFILE_PRELOAD_REVISION});
      trackTask(loadCallerProfileForSession(env,profilePhoneAtStart).then((profile)=>{
        if(from!==profilePhoneAtStart)return;
        callerProfileSession.status='ready';callerProfileSession.profile=profile;
        const elapsedMs=Date.now()-profileLoadStartedAt;
        queueLatency(profileTurnId,'profile_load_end',elapsedMs,{revision:PHONE_PROFILE_PRELOAD_REVISION,found:Boolean(profile),enabled:Boolean(profile?.enabled),profileVersion:Number(profile?.version||0)});
        console.log(JSON.stringify({type:'phone_profile_preload',revision:PHONE_PROFILE_PRELOAD_REVISION,status:'ready',elapsedMs:boundedMs(elapsedMs),found:Boolean(profile),enabled:Boolean(profile?.enabled),profileVersion:Number(profile?.version||0)}));
      }).catch((error)=>{
        if(from===profilePhoneAtStart){callerProfileSession.status='error';callerProfileSession.profile=null;}
        const elapsedMs=Date.now()-profileLoadStartedAt;
        queueLatency(profileTurnId,'profile_load_error',elapsedMs,{revision:PHONE_PROFILE_PRELOAD_REVISION});
        console.warn(JSON.stringify({type:'phone_profile_preload',revision:PHONE_PROFILE_PRELOAD_REVISION,status:'error',elapsedMs:boundedMs(elapsedMs),error:clean(error?.message||error,240)}));
      }));
      const greetingStartedAt=Date.now(),greetingTurnId=`${clean(callId||'call',120)}-greeting`;
      trackTask(upsertCall(env,{callId,from,to,status:'active'}).catch((error)=>console.error(JSON.stringify({type:'phone_call_upsert_error',stage:'start',error:clean(error?.message||error,240)}))));
      queueLatency(greetingTurnId,'greeting_start',0,{revision:PHONE_GREETING_LATENCY_REVISION,prewarm:true});
      const preparedGreeting=await greetingAudioPromise;
      queueLatency(greetingTurnId,'greeting_prepared',Date.now()-greetingStartedAt,{cached:Boolean(preparedGreeting?.bytes?.byteLength),bytes:preparedGreeting?.bytes?.byteLength||0});
      if(greetingText&&await speak(greetingText,{purpose:'greeting',turnId:greetingTurnId,originAt:greetingStartedAt,preparedAudio:preparedGreeting||undefined})){history.push({role:'assistant',content:greetingText});queueMessageLog('assistant',greetingText);}
      trackTask(warmPhoneAckPrimaries(env,deps).then((count)=>console.log(JSON.stringify({type:'phone_fast_ack_primary_warm',revision:PHONE_FAST_ACK_REVISION,count}))).catch((error)=>console.warn(JSON.stringify({type:'phone_fast_ack_primary_warm_error',error:clean(error?.message||error,240)}))));return;
    }
    if(message?.event==='mark'){if(currentMark&&message?.mark?.name===currentMark){assistantPlaying=false;currentMark='';}return;}
    if(message?.event==='media'&&message?.media?.payload){
      const decoded=pcmuBase64ToSamples(message.media.payload),samples=highPassPcmFrame(decoded,hpState,8000,90),rms=rmsOfSamples(samples),threshold=startThreshold(),snr=rms/Math.max(0.001,noiseFloor);
      if(!speechActive){
        preRoll.push(samples);if(preRoll.length>12)preRoll.shift();
        if(assistantPlaying){const bargeThreshold=Math.max(threshold*1.25,noiseFloor*3.2,0.010);if(rms>=bargeThreshold&&snr>=1.8)bargeHits+=1;else bargeHits=Math.max(0,bargeHits-1);if(bargeHits>=5){interruptPlayback();speechActive=true;speechFrames=[...preRoll];preRoll=[];silentFor=0;speechHits=0;bargeHits=0;}else adaptNoise(rms,false);return;}
        if(rms>=threshold&&snr>=1.6)speechHits+=1;else{speechHits=0;adaptNoise(rms,false);}if(speechHits>=3){speechActive=true;speechFrames=[...preRoll];preRoll=[];silentFor=0;speechHits=0;}return;
      }
      speechFrames.push(samples);if(rms>=Math.max(noiseFloor*1.8,speechThreshold*0.75))silentFor=0;else silentFor+=FRAME_MS;const durationMs=speechFrames.length*FRAME_MS;if(silentFor>=silenceMs||durationMs>=maxUtteranceMs)finishUtterance();return;
    }
    if(message?.event==='stop'){finishUtterance();interruptPlayback();abortActiveTurn();await Promise.allSettled([...pendingTasks]);await setCallStatus(env,callId,'ended');closeSocket(telnyx,1000,'telnyx_stopped');}
  });
  telnyx.addEventListener('error',async()=>{interruptPlayback();await setCallStatus(env,callId,'error');closeSocket(telnyx,1011,'telnyx_error');});
  telnyx.addEventListener('close',async()=>{closed=true;clearTimeout(deadline);finishUtterance();interruptPlayback();abortActiveTurn();await Promise.allSettled([...pendingTasks]);await setCallStatus(env,callId,'ended');});
  return new Response(null,{status:101,webSocket:client});
}

export function isTelephonyPath(pathname = '') {
  return pathname === '/phone' || pathname === '/phone-profiles' || pathname === '/telephony-health' || pathname === '/phone/api/calls' || pathname === '/phone/api/calls/export.zip' || pathname === '/phone/api/profiles'
    || /^\/phone\/api\/calls\/[^/]+\/messages$/.test(pathname) || /^\/phone\/api\/calls\/[^/]+\/latency$/.test(pathname)
    || /^\/phone\/api\/calls\/[^/]+\/export\.jsonl$/.test(pathname) || /^\/phone\/api\/profiles\/[^/]+$/.test(pathname) || /^\/phone\/api\/profiles\/[^/]+\/calls$/.test(pathname)
    || pathname === '/telnyx/voice' || pathname === '/telnyx/media' || pathname === '/telnyx/stream-status';
}

export async function handleTelephonyRequest(request, env, ctx, deps = {}) {
  const url=new URL(request.url);if(!isTelephonyPath(url.pathname))return null;
  if(request.method==='GET'&&url.pathname==='/phone')return new Response(dashboardHtml(request),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(request.method==='GET'&&url.pathname==='/phone-profiles')return new Response(profilesDashboardHtml(request),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(request.method==='GET'&&url.pathname==='/telephony-health')return health(request,env,deps);
  if(request.method==='GET'&&url.pathname==='/phone/api/calls/export.zip')return recentCallsZip(request,env);
  if(request.method==='GET'&&url.pathname==='/phone/api/calls')return listCalls(request,env);
  if(request.method==='GET'&&url.pathname==='/phone/api/profiles')return listPhoneProfiles(request,env);
  const messageMatch=url.pathname.match(/^\/phone\/api\/calls\/([^/]+)\/messages$/);if(request.method==='GET'&&messageMatch)return callMessages(request,env,decodeURIComponent(messageMatch[1]));
  const latencyMatch=url.pathname.match(/^\/phone\/api\/calls\/([^/]+)\/latency$/);if(request.method==='GET'&&latencyMatch)return callLatency(request,env,decodeURIComponent(latencyMatch[1]));
  const exportMatch=url.pathname.match(/^\/phone\/api\/calls\/([^/]+)\/export\.jsonl$/);if(request.method==='GET'&&exportMatch)return callExportJsonl(request,env,decodeURIComponent(exportMatch[1]));
  const profileCallsMatch=url.pathname.match(/^\/phone\/api\/profiles\/([^/]+)\/calls$/);if(request.method==='GET'&&profileCallsMatch){let phone;try{phone=decodeURIComponent(profileCallsMatch[1]);}catch{return json({ok:false,error:'invalid_phone_number'},400)}return profileCalls(request,env,phone);}
  const profileMatch=url.pathname.match(/^\/phone\/api\/profiles\/([^/]+)$/);if(profileMatch&&(request.method==='GET'||request.method==='PUT')){let phone;try{phone=decodeURIComponent(profileMatch[1]);}catch{return json({ok:false,error:'invalid_phone_number'},400)}return request.method==='GET'?phoneProfileGet(request,env,phone):phoneProfilePut(request,env,phone);}
  if((request.method==='GET'||request.method==='POST')&&url.pathname==='/telnyx/voice')return texmlResponse(request,env,ctx);
  if((request.method==='GET'||request.method==='POST')&&url.pathname==='/telnyx/stream-status')return streamStatus(request,env);
  if(request.method==='GET'&&url.pathname==='/telnyx/media')return mediaBridge(request,env,deps);
  return new Response('Method Not Allowed',{status:405});
}

from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}: {old[:140]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# --- Fast acknowledgement + progress grammar + JSONL export ---
path = 'src/telephony/index.js'
replace_once(path, "const FAST_ACK_TEXT = 'はい。';", "const FAST_ACK_TEXT = 'はい、少々お待ちください。';")
replace_once(
    path,
    "    .replace(/(?:について)$/i, '')\n    .replace(/[、,。！!？?…\\s]+$/g, '')",
    "    .replace(/(?:について)$/i, '')\n    .replace(/[はをが]\\s*$/u, '')\n    .replace(/[、,。！!？?…\\s]+$/g, '')",
)

latency_block = """async function callLatency(request, env, callId) {
  if (!adminAuthorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await ensureSchema(env))) return json({ ok: false, error: 'storage unavailable' }, 503);
  const result = await env.TALKSYS_LOG_DB.prepare(`SELECT turn_id, stage, elapsed_ms, detail, created_at FROM phone_latency_events WHERE call_id=? ORDER BY id ASC LIMIT 1200`).bind(callId).all();
  return json({ ok: true, events: result.results || [] });
}
"""
export_block = latency_block + """
function parsedLatencyDetail(value = '') {
  const raw = String(value || '');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { raw }; }
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
  return new Response(`${lines.join('\\n')}\\n`, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename=\"talksys-call-${safeId}.jsonl\"`,
      'cache-control': 'no-store',
    },
  });
}
"""
replace_once(path, latency_block, export_block)

replace_once(
    path,
    "    || /^\\/phone\\/api\\/calls\\/[^/]+\\/messages$/.test(pathname) || /^\\/phone\\/api\\/calls\\/[^/]+\\/latency$/.test(pathname)\n",
    "    || /^\\/phone\\/api\\/calls\\/[^/]+\\/messages$/.test(pathname) || /^\\/phone\\/api\\/calls\\/[^/]+\\/latency$/.test(pathname)\n    || /^\\/phone\\/api\\/calls\\/[^/]+\\/export\\.jsonl$/.test(pathname)\n",
)
replace_once(
    path,
    "  const latencyMatch=url.pathname.match(/^\\/phone\\/api\\/calls\\/([^/]+)\\/latency$/);if(request.method==='GET'&&latencyMatch)return callLatency(request,env,decodeURIComponent(latencyMatch[1]));\n",
    "  const latencyMatch=url.pathname.match(/^\\/phone\\/api\\/calls\\/([^/]+)\\/latency$/);if(request.method==='GET'&&latencyMatch)return callLatency(request,env,decodeURIComponent(latencyMatch[1]));\n  const exportMatch=url.pathname.match(/^\\/phone\\/api\\/calls\\/([^/]+)\\/export\\.jsonl$/);if(request.method==='GET'&&exportMatch)return callExportJsonl(request,env,decodeURIComponent(exportMatch[1]));\n",
)
replace_once(
    path,
    '<div class="panel"><h2 id="conversationTitle">会話内容</h2><div id="messages" class="muted">左の着信を選択してください。</div>',
    '<div class="panel"><div class="top"><h2 id="conversationTitle">会話内容</h2><button id="exportBtn" class="hidden">JSONL保存</button></div><div id="messages" class="muted">左の着信を選択してください。</div>',
)
replace_once(
    path,
    "document.getElementById('conversationTitle').textContent=(d.call?.from_number||'番号不明')+' の会話';document.getElementById('messages').innerHTML=",
    "document.getElementById('conversationTitle').textContent=(d.call?.from_number||'番号不明')+' の会話';document.getElementById('exportBtn').classList.remove('hidden');document.getElementById('messages').innerHTML=",
)
replace_once(
    path,
    "  async function start(){try{await api('/phone/api/calls');",
    "  async function downloadExport(){if(!selected)return;const path='/phone/api/calls/'+encodeURIComponent(selected)+'/export.jsonl';const r=await fetch(path,{headers:auth(),cache:'no-store'});if(r.status===401)throw new Error('認証に失敗しました');if(!r.ok)throw new Error('JSONLの取得に失敗しました');const blob=await r.blob();const href=URL.createObjectURL(blob);const a=document.createElement('a');a.href=href;a.download='talksys-call-'+selected.replace(/[^A-Za-z0-9._-]+/g,'_')+'.jsonl';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),1000)}\n  async function start(){try{await api('/phone/api/calls');",
)
replace_once(
    path,
    "  document.getElementById('loginBtn').onclick=()=>{adminToken=document.getElementById('token').value;sessionStorage.setItem('talksysPhoneToken',adminToken);start()};if(adminToken)start();",
    "  document.getElementById('loginBtn').onclick=()=>{adminToken=document.getElementById('token').value;sessionStorage.setItem('talksysPhoneToken',adminToken);start()};document.getElementById('exportBtn').onclick=()=>downloadExport().catch(e=>alert(e.message));if(adminToken)start();",
)

# --- Bounded +3 dB output gain for production PCMU ---
path = 'src/telephony/phone-tts.js'
replace_once(
    path,
    "export const PHONE_TTS_DELIVERY_DEFAULT = 'loud-bright';\n",
    "export const PHONE_TTS_DELIVERY_DEFAULT = 'loud-bright';\nexport const PHONE_TTS_OUTPUT_GAIN_DB_DEFAULT = 3;\nexport const PHONE_TTS_OUTPUT_PEAK_CEILING = 0.94;\n",
)

inspect_end = """  return {
    byteLength: bytes.byteLength,
    durationMs,
    rms: Number(rms.toFixed(6)),
    peak: Number(peak.toFixed(6)),
    silenceRatio: Number((silent / bytes.byteLength).toFixed(6)),
  };
}
"""
gain_block = inspect_end + """

export function phoneTtsOutputGainDb(env = {}) {
  const value = Number(env?.TELEPHONY_TTS_OUTPUT_GAIN_DB ?? PHONE_TTS_OUTPUT_GAIN_DB_DEFAULT);
  if (!Number.isFinite(value)) return PHONE_TTS_OUTPUT_GAIN_DB_DEFAULT;
  return Math.max(0, Math.min(6, value));
}

export function applyPcmuOutputGain(input, env = {}) {
  const bytes = asBytes(input);
  if (!bytes.byteLength) throw new Error('phone_tts_empty_audio');
  const requestedDb = phoneTtsOutputGainDb(env);
  const requestedLinear = 10 ** (requestedDb / 20);
  const ceilingSample = Math.floor(32767 * PHONE_TTS_OUTPUT_PEAK_CEILING);
  let sourcePeak = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) sourcePeak = Math.max(sourcePeak, Math.abs(decodeMuLawByte(bytes[i])));
  const ceilingLinear = sourcePeak > 0 ? ceilingSample / sourcePeak : requestedLinear;
  const appliedLinear = Math.max(0, Math.min(requestedLinear, ceilingLinear));
  const out = new Uint8Array(bytes.byteLength);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const amplified = Math.round(decodeMuLawByte(bytes[i]) * appliedLinear);
    const bounded = Math.max(-ceilingSample, Math.min(ceilingSample, amplified));
    out[i] = encodeMuLawSample(bounded);
  }
  const metrics = inspectPcmu(out);
  const appliedDb = appliedLinear > 0 ? 20 * Math.log10(appliedLinear) : -120;
  return {
    bytes: out,
    metadata: {
      ...metrics,
      outputGainRequestedDb: Number(requestedDb.toFixed(3)),
      outputGainAppliedDb: Number(appliedDb.toFixed(3)),
      outputPeakCeiling: PHONE_TTS_OUTPUT_PEAK_CEILING,
    },
  };
}
"""
replace_once(path, inspect_end, gain_block)

replace_once(
    path,
    "    const validated = validatePcmuResponse(primary.bytes, primary.contentType);\n    return {\n      ...validated,\n      metadata: {\n        ...validated.metadata, provider: 'cloudflare-ai-gateway', model: PHONE_TTS_MODEL,",
    "    const validated = validatePcmuResponse(primary.bytes, primary.contentType);\n    const gained = applyPcmuOutputGain(validated.bytes, env);\n    return {\n      ...validated, bytes: gained.bytes,\n      metadata: {\n        ...validated.metadata, ...gained.metadata, provider: 'cloudflare-ai-gateway', model: PHONE_TTS_MODEL,",
)
replace_once(
    path,
    "  const mulaw = pcm16LeToMulaw(pcm.bytes);\n  const metrics = inspectPcmu(mulaw);\n  return {\n    bytes: mulaw,\n    metadata: {\n      codec: 'PCMU', sampleRate: PHONE_TTS_SAMPLE_RATE, channels: 1, container: pcm.container,\n      contentType: normalizedContentType(fallback.contentType), ...metrics,",
    "  const mulaw = pcm16LeToMulaw(pcm.bytes);\n  const gained = applyPcmuOutputGain(mulaw, env);\n  return {\n    bytes: gained.bytes,\n    metadata: {\n      codec: 'PCMU', sampleRate: PHONE_TTS_SAMPLE_RATE, channels: 1, container: pcm.container,\n      contentType: normalizedContentType(fallback.contentType), ...gained.metadata,",
)

# Explicit production configuration (function also has safe default).
path = 'wrangler.jsonc'
replace_once(
    path,
    '    "TELEPHONY_TTS_DELIVERY": "loud-bright",\n',
    '    "TELEPHONY_TTS_DELIVERY": "loud-bright",\n    "TELEPHONY_TTS_OUTPUT_GAIN_DB": "3.0",\n',
)

# --- Regression tests ---
path = 'tests/phone-fast-reaction-v2.test.mjs'
p = Path(path); text = p.read_text(encoding='utf-8')
text = text.replace("'はい。'", "'はい、少々お待ちください。'")
p.write_text(text, encoding='utf-8')

path = 'tests/phone-energetic-progress-v1.test.mjs'
replace_once(
    path,
    "  assert.equal(phoneSearchTopic('iPhone 17の価格を調べてください'), 'iPhone 17の価格');\n",
    "  assert.equal(phoneSearchTopic('iPhone 17の価格を調べてください'), 'iPhone 17の価格');\n  assert.equal(phoneSearchTopic('次の別府駅の電車は'), '次の別府駅の電車');\n  assert.equal(phoneSearchProgressText('次の別府駅の電車は'), 'いま、次の別府駅の電車について調べています。少々お待ちください。');\n",
)

path = 'tests/phone-pcmu-v87.test.mjs'
replace_once(
    path,
    "  PHONE_TTS_FRAME_BYTES,\n  PHONE_TTS_MODEL,\n  PHONE_TTS_SAMPLE_RATE,\n",
    "  PHONE_TTS_FRAME_BYTES,\n  PHONE_TTS_MODEL,\n  PHONE_TTS_SAMPLE_RATE,\n  PHONE_TTS_OUTPUT_GAIN_DB_DEFAULT,\n  PHONE_TTS_OUTPUT_PEAK_CEILING,\n  applyPcmuOutputGain,\n",
)
p = Path(path); text = p.read_text(encoding='utf-8')
text += """

test('bounded phone output gain raises quiet PCMU without exceeding the peak ceiling', () => {
  const quiet = pcm16LeToMulaw(pcm16(Array.from({ length: 320 }, (_, i) => (i % 2 ? 1800 : -1800))));
  const before = inspectPcmu(quiet);
  const gained = applyPcmuOutputGain(quiet, { TELEPHONY_TTS_OUTPUT_GAIN_DB: '3.0' });
  const after = inspectPcmu(gained.bytes);
  assert.equal(PHONE_TTS_OUTPUT_GAIN_DB_DEFAULT, 3);
  assert.equal(PHONE_TTS_OUTPUT_PEAK_CEILING, 0.94);
  assert.ok(after.rms > before.rms);
  assert.ok(after.peak <= 0.94, `peak=${after.peak}`);
  assert.equal(gained.metadata.outputGainRequestedDb, 3);
});

test('bounded phone output gain limits hot PCMU rather than clipping it', () => {
  const hot = pcm16LeToMulaw(pcm16(Array.from({ length: 320 }, (_, i) => (i % 2 ? 30000 : -30000))));
  const gained = applyPcmuOutputGain(hot, { TELEPHONY_TTS_OUTPUT_GAIN_DB: '3.0' });
  const after = inspectPcmu(gained.bytes);
  assert.ok(after.peak <= 0.94, `peak=${after.peak}`);
  assert.ok(gained.metadata.outputGainAppliedDb < 3);
});
"""
p.write_text(text, encoding='utf-8')

Path('tests/phone-jsonl-export-v111.test.mjs').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('phone call export is authenticated NDJSON with parsed latency detail', () => {
  assert.match(source, /callExportJsonl/);
  assert.match(source, /adminAuthorized\(request, env\)/);
  assert.match(source, /application\/x-ndjson; charset=utf-8/);
  assert.match(source, /talksys-call-\$\{safeId\}\.jsonl/);
  assert.match(source, /parsedLatencyDetail/);
  assert.match(source, /export\\\.jsonl/);
});

test('phone dashboard exposes JSONL download without changing answer/ack ordering', () => {
  assert.match(source, /id=\\"exportBtn\\"/);
  assert.match(source, /downloadExport/);
  const turnStart = source.indexOf('const turnPromise=answerWithTalkSys');
  const ackSpeak = source.indexOf('await speak(ackText');
  assert.ok(turnStart >= 0 && ackSpeak > turnStart);
});
""", encoding='utf-8')

print('phone quality v111 patch applied')
